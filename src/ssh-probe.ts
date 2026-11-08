// Minimal one-shot SSH client used only to probe managed servers: version
// exchange, key exchange, host-key TOFU, password / keyboard-interactive /
// publickey auth, and a single exec channel whose stdout is collected.
// It runs on Workers via cloudflare:sockets + WebCrypto — no external deps.
//
// Supported negotiation (client preference order):
//   kex:        curve25519-sha256 (when WebCrypto X25519 exists),
//               ecdh-sha2-nistp256, diffie-hellman-group14-sha256
//   host key:   ssh-ed25519, ecdsa-sha2-nistp256, rsa-sha2-512, rsa-sha2-256
//   cipher:     aes256-ctr, aes128-ctr (encrypt-then... no: CTR + HMAC,
//               classic encrypt-and-MAC packet framing)
//   mac:        hmac-sha2-256
//   compression: none
// Private keys: unencrypted OpenSSH / PKCS#8 / PKCS#1 (RSA, Ed25519,
// ECDSA P-256). Keys with a passphrase are reported, not cracked.

import { connect } from "cloudflare:sockets";

export type SshAuthType = "password" | "key";

export interface SshProbeTarget {
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  secret: string;
  knownFingerprint?: string;
  timeoutMs?: number;
}

export interface SshProbeResult {
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  fingerprint: string;
  hostKeyAlgo: string;
}

export class SshProbeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const CLIENT_VERSION = "SSH-2.0-HiveMosProbe_1.0";
const PROBE_COMMAND =
  'hostname; . /etc/os-release 2>/dev/null; echo "OS=${PRETTY_NAME:-}"; echo "K=$(uname -r)"; echo "A=$(uname -m)"';
const MAX_PACKET = 1024 * 1024;
const MAX_OUTPUT = 128 * 1024;

// ---------------------------------------------------------------------------
// Byte helpers

const te = new TextEncoder();
const td = new TextDecoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u32be(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, false);
  return out;
}

function readU32(buf: Uint8Array, off: number): number {
  return new DataView(buf.buffer, buf.byteOffset + off, 4).getUint32(0, false);
}

class Writer {
  private parts: Uint8Array[] = [];
  u8(v: number): this {
    this.parts.push(new Uint8Array([v & 0xff]));
    return this;
  }
  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }
  u32(v: number): this {
    this.parts.push(u32be(v));
    return this;
  }
  bytes(data: Uint8Array): this {
    this.parts.push(data);
    return this;
  }
  raw(data: Uint8Array): this {
    this.parts.push(data);
    return this;
  }
  str(data: Uint8Array | string): this {
    const bytes = typeof data === "string" ? te.encode(data) : data;
    this.parts.push(u32be(bytes.length), bytes);
    return this;
  }
  mpintFromBytes(magnitude: Uint8Array): this {
    return this.str(mpintBytes(magnitude));
  }
  mpintFromBigInt(v: bigint): this {
    return this.str(bigIntToMpintBytes(v));
  }
  nameList(names: string[]): this {
    return this.str(names.join(","));
  }
  build(): Uint8Array {
    return concat(...this.parts);
  }
}

function mpintBytes(magnitude: Uint8Array): Uint8Array {
  let start = 0;
  while (start < magnitude.length && magnitude[start] === 0) start++;
  const body = magnitude.slice(start);
  if (body.length === 0) return new Uint8Array(0);
  if (body[0] & 0x80) return concat(new Uint8Array([0]), body);
  return body;
}

function bigIntToMpintBytes(v: bigint): Uint8Array {
  if (v === 0n) return new Uint8Array(0);
  let hex = v.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return mpintBytes(bytes);
}

function bigIntToFixedBytes(v: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let rest = v;
  for (let i = length - 1; i >= 0 && rest > 0n; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

class Reader {
  private off = 0;
  constructor(private buf: Uint8Array) {}
  remaining(): number {
    return this.buf.length - this.off;
  }
  u8(): number {
    if (this.remaining() < 1) throw new SshProbeError("protocol", "数据包不完整");
    return this.buf[this.off++];
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u32(): number {
    if (this.remaining() < 4) throw new SshProbeError("protocol", "数据包不完整");
    const v = readU32(this.buf, this.off);
    this.off += 4;
    return v;
  }
  bytes(n: number): Uint8Array {
    if (n < 0 || this.remaining() < n) throw new SshProbeError("protocol", "数据包不完整");
    const out = this.buf.slice(this.off, this.off + n);
    this.off += n;
    return out;
  }
  str(): Uint8Array {
    const len = this.u32();
    return this.bytes(len);
  }
  strText(): string {
    return td.decode(this.str());
  }
  mpint(): Uint8Array {
    return this.str();
  }
  rest(): Uint8Array {
    return this.bytes(this.remaining());
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(text: string): Uint8Array {
  const bin = atob(text.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64url(bytes: Uint8Array): string {
  return b64encode(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data as BufferSource));
}

// ---------------------------------------------------------------------------
// AES-CTR as a continuous byte stream. WebCrypto calls are stateless, so the
// keystream is generated one block at a time and buffered — SSH treats CTR
// as a stream (the packet length field consumes keystream too).

class AesCtrStream {
  private ks: Uint8Array = new Uint8Array(0);
  private ksOff = 0;
  private constructor(
    private key: CryptoKey,
    private counter: Uint8Array,
  ) {}

  static async create(keyBytes: Uint8Array, iv: Uint8Array): Promise<AesCtrStream> {
    const key = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "AES-CTR" }, false, [
      "encrypt",
      "decrypt",
    ]);
    return new AesCtrStream(key, iv.slice(0, 16));
  }

  private async nextKeystreamBlock(): Promise<void> {
    const zero = new Uint8Array(16);
    const block = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-CTR", counter: this.counter as BufferSource, length: 128 }, this.key, zero as BufferSource),
    );
    // Increment the 128-bit big-endian counter by one block.
    for (let i = 15; i >= 0; i--) {
      this.counter[i] = (this.counter[i] + 1) & 0xff;
      if (this.counter[i] !== 0) break;
    }
    this.ks = block;
    this.ksOff = 0;
  }

  async process(data: Uint8Array): Promise<Uint8Array> {
    const out = new Uint8Array(data.length);
    let i = 0;
    while (i < data.length) {
      if (this.ksOff >= this.ks.length) await this.nextKeystreamBlock();
      const take = Math.min(this.ks.length - this.ksOff, data.length - i);
      for (let j = 0; j < take; j++) out[i + j] = data[i + j] ^ this.ks[this.ksOff + j];
      this.ksOff += take;
      i += take;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Socket plumbing

class SocketIo {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private done = false;
  private waiter: (() => void) | null = null;
  private pumpPromise: Promise<void>;

  constructor(private socket: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; close(): Promise<void> }) {
    this.pumpPromise = this.pump();
  }

  private async pump(): Promise<void> {
    const reader = this.socket.readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          this.chunks.push(value);
          this.buffered += value.length;
          this.notify();
        }
      }
    } catch {
      // Treated as end-of-stream; the read side reports unreachable.
    }
    this.done = true;
    this.notify();
  }

  private notify(): void {
    const w = this.waiter;
    this.waiter = null;
    if (w) w();
  }

  async read(n: number): Promise<Uint8Array> {
    while (this.buffered < n) {
      if (this.done) throw new SshProbeError("unreachable", "连接被对端关闭");
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const head = this.chunks[0];
      const take = Math.min(head.length, n - off);
      out.set(head.subarray(0, take), off);
      off += take;
      this.buffered -= take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    return out;
  }

  async write(data: Uint8Array): Promise<void> {
    const writer = this.socket.writable.getWriter();
    try {
      await writer.write(data as unknown as Uint8Array);
    } finally {
      writer.releaseLock();
    }
  }

  async close(): Promise<void> {
    try {
      await this.socket.close();
    } catch {
      // Already closed.
    }
    void this.pumpPromise;
  }
}

// ---------------------------------------------------------------------------
// Packet layer (plain until NEWKEYS, then CTR + HMAC)

class PacketLayer {
  private enc: AesCtrStream | null = null;
  private dec: AesCtrStream | null = null;
  private macKeyC2S: Uint8Array | null = null;
  private macKeyS2C: Uint8Array | null = null;
  private seqOut = 0;
  private seqIn = 0;

  constructor(private io: SocketIo) {}

  async enableEncryption(keys: {
    ivC2S: Uint8Array;
    keyC2S: Uint8Array;
    macC2S: Uint8Array;
    ivS2C: Uint8Array;
    keyS2C: Uint8Array;
    macS2C: Uint8Array;
  }): Promise<void> {
    this.enc = await AesCtrStream.create(keys.keyC2S, keys.ivC2S);
    this.dec = await AesCtrStream.create(keys.keyS2C, keys.ivS2C);
    this.macKeyC2S = keys.macC2S;
    this.macKeyS2C = keys.macS2C;
  }

  private buildPacket(payload: Uint8Array): Uint8Array {
    const blockSize = 16;
    let padLen = blockSize - ((4 + 1 + payload.length) % blockSize);
    if (padLen < 4) padLen += blockSize;
    const packet = new Uint8Array(4 + 1 + payload.length + padLen);
    new DataView(packet.buffer).setUint32(0, packet.length - 4, false);
    packet[4] = padLen;
    packet.set(payload, 5);
    crypto.getRandomValues(packet.subarray(5 + payload.length));
    return packet;
  }

  async send(payload: Uint8Array): Promise<void> {
    const packet = this.buildPacket(payload);
    if (this.enc && this.macKeyC2S) {
      const mac = await hmacSha256(this.macKeyC2S, concat(u32be(this.seqOut), packet));
      const cipher = await this.enc.process(packet);
      this.seqOut++;
      await this.io.write(concat(cipher, mac));
      return;
    }
    this.seqOut++;
    await this.io.write(packet);
  }

  async recv(): Promise<Uint8Array> {
    if (this.dec && this.macKeyS2C) {
      const headCipher = await this.io.read(4);
      const head = await this.dec.process(headCipher);
      const packetLen = readU32(head, 0);
      if (packetLen < 1 || packetLen > MAX_PACKET) throw new SshProbeError("protocol", "数据包长度异常");
      const restCipher = await this.io.read(packetLen);
      const rest = await this.dec.process(restCipher);
      const packet = concat(head, rest);
      const mac = await this.io.read(32);
      const expected = await hmacSha256(this.macKeyS2C, concat(u32be(this.seqIn), packet));
      if (!timingSafeEqual(mac, expected)) throw new SshProbeError("protocol", "数据包校验失败");
      this.seqIn++;
      return parsePacket(packet);
    }
    const head = await this.io.read(4);
    const packetLen = readU32(head, 0);
    if (packetLen < 1 || packetLen > MAX_PACKET) throw new SshProbeError("protocol", "数据包长度异常");
    const rest = await this.io.read(packetLen);
    this.seqIn++;
    return parsePacket(concat(head, rest));
  }
}

function parsePacket(packet: Uint8Array): Uint8Array {
  const padLen = packet[4];
  const payloadLen = packet.length - 4 - 1 - padLen;
  if (payloadLen < 0) throw new SshProbeError("protocol", "数据包不完整");
  return packet.slice(5, 5 + payloadLen);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Minimal DER reader for private-key files

class DerReader {
  private off = 0;
  constructor(private buf: Uint8Array) {}
  private readLen(): number {
    let len = this.buf[this.off++];
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | this.buf[this.off++];
    }
    return len;
  }
  readTlv(tag: number): Uint8Array {
    if (this.buf[this.off++] !== tag) throw new SshProbeError("key_unsupported", "私钥格式无法识别");
    const len = this.readLen();
    const out = this.buf.slice(this.off, this.off + len);
    this.off += len;
    return out;
  }
  seq(): DerReader {
    return new DerReader(this.readTlv(0x30));
  }
  int(): Uint8Array {
    return this.readTlv(0x02);
  }
  octetString(): Uint8Array {
    return this.readTlv(0x04);
  }
  oid(): string {
    const bytes = this.readTlv(0x06);
    const parts: number[] = [Math.floor(bytes[0] / 40), bytes[0] % 40];
    let value = 0;
    for (let i = 1; i < bytes.length; i++) {
      value = (value << 7) | (bytes[i] & 0x7f);
      if (!(bytes[i] & 0x80)) {
        parts.push(value);
        value = 0;
      }
    }
    return parts.join(".");
  }
  skipAny(): void {
    const tag = this.buf[this.off++];
    void tag;
    const len = this.readLen();
    this.off += len;
  }
  done(): boolean {
    return this.off >= this.buf.length;
  }
}

// ---------------------------------------------------------------------------
// Private key loading (password auth never touches this)

interface LoadedKey {
  algo: string; // ssh name used in the auth request: ssh-rsa / ssh-ed25519 / ecdsa-sha2-nistp256
  sigAlgo: string; // algorithm name placed in the signature blob
  keyBlob: Uint8Array; // SSH wire public key blob
  sign(data: Uint8Array): Promise<Uint8Array>; // returns the signature blob *content*
}

function sshBlobString(algo: string, parts: Uint8Array[]): Uint8Array {
  const w = new Writer().str(algo);
  for (const p of parts) w.str(p);
  return w.build();
}

async function rsaLoadedKey(nBytes: Uint8Array, eBytes: Uint8Array, jwk: Record<string, string>): Promise<LoadedKey> {
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: b64url(mpintBytes(nBytes)), e: b64url(mpintBytes(eBytes)), ...jwk },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return {
    algo: "ssh-rsa",
    sigAlgo: "rsa-sha2-256",
    keyBlob: sshBlobString("ssh-rsa", [mpintBytes(eBytes), mpintBytes(nBytes)]),
    sign: async (data) => new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data as BufferSource)),
  };
}

async function ed25519LoadedKey(publicKey: Uint8Array, pkcs8: Uint8Array): Promise<LoadedKey> {
  const key = await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, { name: "Ed25519" }, false, ["sign"]);
  return {
    algo: "ssh-ed25519",
    sigAlgo: "ssh-ed25519",
    keyBlob: sshBlobString("ssh-ed25519", [publicKey]),
    sign: async (data) => new Uint8Array(await crypto.subtle.sign("Ed25519", key, data as BufferSource)),
  };
}

function ed25519Pkcs8(seed: Uint8Array): Uint8Array {
  // Fixed PKCS#8 prefix for Ed25519: SEQ { int 0, SEQ { OID 1.3.101.112 },
  // octetstring { octetstring seed } }.
  const prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  return concat(prefix, seed.slice(0, 32));
}

async function ecdsaLoadedKey(point: Uint8Array, dBytes: Uint8Array): Promise<LoadedKey> {
  if (point.length !== 65 || point[0] !== 4) throw new SshProbeError("key_unsupported", "ECDSA 私钥格式无法识别");
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64url(point.slice(1, 33)),
    y: b64url(point.slice(33, 65)),
    d: b64url(concat(new Uint8Array(Math.max(0, 32 - dBytes.length)), dBytes).slice(-32)),
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return {
    algo: "ecdsa-sha2-nistp256",
    sigAlgo: "ecdsa-sha2-nistp256",
    keyBlob: sshBlobString("ecdsa-sha2-nistp256", [te.encode("nistp256"), point]),
    sign: async (data) => {
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data as BufferSource));
      const r = mpintBytes(raw.slice(0, 32));
      const s = mpintBytes(raw.slice(32, 64));
      return new Writer().str(r).str(s).build();
    },
  };
}

function derIntToJwkFields(names: string[], ints: Uint8Array[]): Record<string, string> {
  const out: Record<string, string> = {};
  names.forEach((name, i) => {
    out[name] = b64url(mpintBytes(ints[i]));
  });
  return out;
}

async function loadPkcs1Rsa(der: Uint8Array): Promise<LoadedKey> {
  const seq = new DerReader(der).seq();
  const ints: Uint8Array[] = [];
  while (!seq.done()) ints.push(seq.int());
  // version, n, e, d, p, q, dp, dq, qi
  if (ints.length < 9) throw new SshProbeError("key_unsupported", "RSA 私钥不完整");
  const jwk = derIntToJwkFields(["d", "p", "q", "dp", "dq", "qi"], [ints[3], ints[4], ints[5], ints[6], ints[7], ints[8]]);
  return rsaLoadedKey(ints[1], ints[2], jwk);
}

async function loadPkcs8(der: Uint8Array): Promise<LoadedKey> {
  const top = new DerReader(der);
  const seq = top.seq();
  seq.int();
  const algSeq = seq.seq();
  const oid = algSeq.oid();
  const inner = seq.octetString();
  if (oid === "1.3.101.112") {
    // Ed25519: inner is an octet string wrapping the 32-byte seed; the public
    // key comes from a JWK export of the imported key.
    const key = await crypto.subtle.importKey("pkcs8", der as BufferSource, { name: "Ed25519" }, true, ["sign"]);
    const jwk = (await crypto.subtle.exportKey("jwk", key)) as { x?: string };
    if (!jwk.x) throw new SshProbeError("key_unsupported", "Ed25519 私钥无法读取公钥");
    const pub = b64decode(jwk.x.replaceAll("-", "+").replaceAll("_", "/"));
    return ed25519LoadedKey(pub, der);
  }
  if (oid === "1.2.840.113549.1.1.1") return loadPkcs1Rsa(inner);
  if (oid === "1.2.840.10045.2.1") {
    // EC key: inner is SEC1 — version, private int, [0] oid skipped, [1] pub.
    const ecSeq = new DerReader(inner).seq();
    ecSeq.int();
    const d = ecSeq.octetString();
    // Remaining tagged fields: parse leniently to find the public point.
    const rest = ecSeq.rest();
    const marker = rest.indexOf(0x04);
    let point: Uint8Array | null = null;
    for (let i = 0; i + 66 <= rest.length; i++) {
      if (rest[i] === 0x03 && rest[i + 2] === 0x00 && rest[i + 3] === 0x04) {
        point = rest.slice(i + 3, i + 3 + 65);
        break;
      }
    }
    void marker;
    if (!point) throw new SshProbeError("key_unsupported", "ECDSA 私钥缺少公钥部分");
    return ecdsaLoadedKey(point, d);
  }
  throw new SshProbeError("key_unsupported", "不支持的私钥类型");
}

async function loadOpenSshKey(bytes: Uint8Array): Promise<LoadedKey> {
  const magic = "openssh-key-v1";
  const head = td.decode(bytes.slice(0, magic.length));
  if (head !== magic) throw new SshProbeError("key_unsupported", "私钥格式无法识别");
  const r = new Reader(bytes);
  r.bytes(magic.length + 1); // magic + NUL
  const cipher = r.strText();
  if (cipher !== "none") throw new SshProbeError("key_encrypted", "私钥设置了口令，暂不支持");
  r.str(); // kdf name
  r.str(); // kdf options
  const count = r.u32();
  if (count < 1) throw new SshProbeError("key_unsupported", "私钥里没有密钥");
  const pubBlobs: Uint8Array[] = [];
  for (let i = 0; i < count; i++) pubBlobs.push(r.str());
  const privBlock = new Reader(r.str());
  const check1 = privBlock.u32();
  const check2 = privBlock.u32();
  if (check1 !== check2) throw new SshProbeError("key_unsupported", "私钥校验失败");
  const type = privBlock.strText();
  if (type === "ssh-ed25519") {
    const pub = privBlock.str();
    const priv = privBlock.str();
    return ed25519LoadedKey(pub, ed25519Pkcs8(priv.slice(0, 32)));
  }
  if (type === "ssh-rsa") {
    const n = privBlock.mpint();
    const e = privBlock.mpint();
    const d = privBlock.mpint();
    const iqmp = privBlock.mpint();
    const p = privBlock.mpint();
    const q = privBlock.mpint();
    const jwk = derIntToJwkFields(["d", "p", "q", "qi"], [d, p, q, iqmp]);
    // dp/dq are not stored in OpenSSH format; WebCrypto JWK RSA import
    // requires them, so compute dp = d mod (p-1), dq = d mod (q-1).
    const dB = bytesToBigInt(mpintBytes(d));
    const pB = bytesToBigInt(mpintBytes(p));
    const qB = bytesToBigInt(mpintBytes(q));
    jwk.dp = b64url(bigIntToMpintBytes(dB % (pB - 1n)));
    jwk.dq = b64url(bigIntToMpintBytes(dB % (qB - 1n)));
    return rsaLoadedKey(n, e, jwk);
  }
  if (type === "ecdsa-sha2-nistp256") {
    privBlock.strText(); // curve name
    const pub = privBlock.str();
    const d = privBlock.mpint();
    return ecdsaLoadedKey(pub, mpintBytes(d));
  }
  throw new SshProbeError("key_unsupported", "不支持的私钥类型：" + type);
}

async function loadPrivateKey(secret: string): Promise<LoadedKey> {
  const text = secret.trim();
  const begin = /-----BEGIN ([A-Z ]+)-----/.exec(text);
  if (!begin) throw new SshProbeError("key_unsupported", "私钥格式无法识别");
  const label = begin[1];
  const body = text.replace(/-----BEGIN [A-Z ]+-----/, "").replace(/-----END [A-Z ]+-----/, "");
  const der = b64decode(body.replace(/[^A-Za-z0-9+/=]/g, ""));
  if (label === "OPENSSH PRIVATE KEY") return loadOpenSshKey(der);
  if (label === "ENCRYPTED PRIVATE KEY") throw new SshProbeError("key_encrypted", "私钥设置了口令，暂不支持");
  if (label === "PRIVATE KEY") return loadPkcs8(der);
  if (label === "RSA PRIVATE KEY") return loadPkcs1Rsa(der);
  if (label === "EC PRIVATE KEY") {
    const ecSeq = new DerReader(der).seq();
    ecSeq.int();
    const d = ecSeq.octetString();
    const rest = ecSeq.rest();
    for (let i = 0; i + 66 <= rest.length; i++) {
      if (rest[i] === 0x03 && rest[i + 2] === 0x00 && rest[i + 3] === 0x04) {
        return ecdsaLoadedKey(rest.slice(i + 3, i + 3 + 65), d);
      }
    }
    throw new SshProbeError("key_unsupported", "ECDSA 私钥缺少公钥部分");
  }
  throw new SshProbeError("key_unsupported", "不支持的私钥格式：" + label);
}

// ---------------------------------------------------------------------------
// Host key signature verification + fingerprint

async function verifyHostKey(hostKeyBlob: Uint8Array, signatureBlob: Uint8Array, hash: Uint8Array): Promise<string> {
  const kr = new Reader(hostKeyBlob);
  const algo = kr.strText();
  const sr = new Reader(signatureBlob);
  sr.strText(); // signature algorithm name
  const signature = sr.str();
  if (algo === "ssh-ed25519") {
    const pub = kr.str();
    const key = await crypto.subtle.importKey("raw", pub as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    if (!(await crypto.subtle.verify("Ed25519", key, signature as BufferSource, hash as BufferSource))) {
      throw new SshProbeError("protocol", "主机密钥签名验证失败");
    }
    return algo;
  }
  if (algo === "ecdsa-sha2-nistp256") {
    kr.strText(); // curve name
    const point = kr.str();
    const sigReader = new Reader(signature);
    const r = sigReader.str();
    const s = sigReader.str();
    const raw = concat(
      concat(new Uint8Array(Math.max(0, 32 - r.length)), r).slice(-32),
      concat(new Uint8Array(Math.max(0, 32 - s.length)), s).slice(-32),
    );
    const key = await crypto.subtle.importKey("raw", point as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw as BufferSource, hash as BufferSource))) {
      throw new SshProbeError("protocol", "主机密钥签名验证失败");
    }
    return algo;
  }
  if (algo === "ssh-rsa") {
    const e = kr.mpint();
    const n = kr.mpint();
    const hashName = signatureBlobStartsWith(signatureBlob, "rsa-sha2-512") ? "SHA-512" : "SHA-256";
    const jwk = { kty: "RSA", n: b64url(mpintBytes(n)), e: b64url(mpintBytes(e)) };
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: hashName }, false, ["verify"]);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature as BufferSource, hash as BufferSource))) {
      throw new SshProbeError("protocol", "主机密钥签名验证失败");
    }
    return algo;
  }
  throw new SshProbeError("negotiation", "不支持的主机密钥类型：" + algo);
}

function signatureBlobStartsWith(blob: Uint8Array, name: string): boolean {
  const r = new Reader(blob);
  try {
    return r.strText() === name;
  } catch {
    return false;
  }
}

async function hostKeyFingerprint(hostKeyBlob: Uint8Array): Promise<string> {
  const digest = await sha256(hostKeyBlob);
  return "SHA256:" + b64encode(digest).replace(/=+$/g, "");
}

// ---------------------------------------------------------------------------
// diffie-hellman-group14-sha256 prime (RFC 4253 §8.2)

const DH14_PRIME = BigInt(
  "0x" +
    "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74" +
    "020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437" +
    "4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7E" +
    "DEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF" +
    "0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F35620855" +
    "2BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36" +
    "CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955" +
    "817183995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFFFFF" +
    "FFFFFFFF",
);

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main probe flow

const KEX_PREFERENCE_BASE = ["ecdh-sha2-nistp256", "diffie-hellman-group14-sha256"];
const HOSTKEY_PREFERENCE = ["ssh-ed25519", "ecdsa-sha2-nistp256", "rsa-sha2-512", "rsa-sha2-256"];
const CIPHER_PREFERENCE = ["aes256-ctr", "aes128-ctr"];
const MAC_PREFERENCE = ["hmac-sha2-256"];

function pick(serverList: string, preference: string[]): string | null {
  const offered = new Set(serverList.split(",").map((s) => s.trim()).filter(Boolean));
  for (const want of preference) if (offered.has(want)) return want;
  return null;
}

function deriveKeyMaterial(sharedMpint: Uint8Array, hashH: Uint8Array, sessionId: Uint8Array, letter: string, length: number): Promise<Uint8Array> {
  return (async () => {
    let out = new Uint8Array(0);
    let block = await sha256(concat(sharedMpint, hashH, te.encode(letter), sessionId));
    out = concat(out, block);
    while (out.length < length) {
      block = await sha256(concat(sharedMpint, hashH, out));
      out = concat(out, block);
    }
    return out.slice(0, length);
  })();
}

export async function sshProbe(target: SshProbeTarget): Promise<SshProbeResult> {
  const timeoutMs = target.timeoutMs ?? 15000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SshProbeError("timeout", "连接超时")), timeoutMs);
  });
  try {
    return await Promise.race([runProbe(target), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runProbe(target: SshProbeTarget): Promise<SshProbeResult> {
  let socket: ReturnType<typeof connect>;
  try {
    socket = connect({ hostname: target.host, port: target.port });
  } catch {
    throw new SshProbeError("unreachable", "无法连接到服务器");
  }
  const io = new SocketIo(socket as never);
  const layer = new PacketLayer(io);
  try {
    return await probeOver(io, layer, target);
  } finally {
    await io.close();
  }
}

async function probeOver(io: SocketIo, layer: PacketLayer, target: SshProbeTarget): Promise<SshProbeResult> {
  // --- version exchange
  await io.write(te.encode(CLIENT_VERSION + "\r\n"));
  let serverVersion = "";
  {
    let acc = new Uint8Array(0);
    for (let lines = 0; lines < 20; lines++) {
      // Read byte by byte until LF — banner traffic is tiny.
      for (;;) {
        const idx = acc.indexOf(0x0a);
        if (idx >= 0) {
          const line = td.decode(acc.slice(0, idx)).replace(/\r$/, "");
          acc = acc.slice(idx + 1);
          if (line.startsWith("SSH-")) {
            serverVersion = line;
            break;
          }
          break;
        }
        const one = await io.read(1);
        acc = concat(acc, one);
        if (acc.length > 4096) throw new SshProbeError("protocol", "服务器版本串异常");
      }
      if (serverVersion) break;
    }
    if (!serverVersion) throw new SshProbeError("protocol", "没有收到 SSH 版本串");
    if (acc.length) throw new SshProbeError("protocol", "版本串之后有额外数据");
  }

  // --- KEXINIT
  let x25519Available = false;
  try {
    await crypto.subtle.generateKey({ name: "X25519" } as never, false, ["deriveBits"]);
    x25519Available = true;
  } catch {
    x25519Available = false;
  }
  const kexPreference = x25519Available ? ["curve25519-sha256", ...KEX_PREFERENCE_BASE] : KEX_PREFERENCE_BASE;
  const cookie = crypto.getRandomValues(new Uint8Array(16));
  const clientKexInit = new Writer()
    .u8(20)
    .raw(cookie)
    .nameList(kexPreference)
    .nameList(HOSTKEY_PREFERENCE)
    .nameList(CIPHER_PREFERENCE)
    .nameList(CIPHER_PREFERENCE)
    .nameList(MAC_PREFERENCE)
    .nameList(MAC_PREFERENCE)
    .nameList(["none"])
    .nameList(["none"])
    .nameList([])
    .nameList([])
    .bool(false)
    .u32(0)
    .build();
  await layer.send(clientKexInit);

  let serverKexInit: Uint8Array | null = null;
  for (let i = 0; i < 10 && !serverKexInit; i++) {
    const payload = await layer.recv();
    if (payload[0] === 20) serverKexInit = payload;
  }
  if (!serverKexInit) throw new SshProbeError("negotiation", "服务器没有返回算法协商");
  const kr = new Reader(serverKexInit);
  kr.u8();
  kr.bytes(16);
  const serverKexList = kr.strText();
  const serverHostKeyList = kr.strText();
  const serverCipherC2S = kr.strText();
  const serverCipherS2C = kr.strText();
  const serverMacC2S = kr.strText();
  const serverMacS2C = kr.strText();

  const kexAlgo = pick(serverKexList, kexPreference);
  const hostKeyAlgoWanted = pick(serverHostKeyList, HOSTKEY_PREFERENCE);
  const cipherC2S = pick(serverCipherC2S, CIPHER_PREFERENCE);
  const cipherS2C = pick(serverCipherS2C, CIPHER_PREFERENCE);
  const macC2S = pick(serverMacC2S, MAC_PREFERENCE);
  const macS2C = pick(serverMacS2C, MAC_PREFERENCE);
  if (!kexAlgo || !hostKeyAlgoWanted || !cipherC2S || !cipherS2C || !macC2S || !macS2C) {
    throw new SshProbeError("negotiation", "与服务器没有共同支持的 SSH 算法");
  }
  const cipherKeyLen = (name: string) => (name === "aes256-ctr" ? 32 : 16);

  // --- key exchange per algorithm. Produces Q_C / Q_S field bytes, the
  // shared secret as an SSH string-encoded mpint, host key blob + signature.
  let qCField: Uint8Array;
  let qSField: Uint8Array;
  let sharedMpintString: Uint8Array;
  let hostKeyBlob: Uint8Array;
  let signatureBlob: Uint8Array;

  if (kexAlgo === "curve25519-sha256") {
    const pair = (await crypto.subtle.generateKey({ name: "X25519" } as never, false, ["deriveBits"])) as CryptoKeyPair;
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    await layer.send(new Writer().u8(30).str(pub).build());
    const reply = await expectKexReply(layer);
    const rr = new Reader(reply);
    hostKeyBlob = rr.str();
    qSField = rr.str();
    signatureBlob = rr.str();
    const peer = await crypto.subtle.importKey("raw", qSField as BufferSource, { name: "X25519" } as never, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: peer } as never, pair.privateKey, 256));
    qCField = pub;
    sharedMpintString = new Writer().mpintFromBytes(shared).build();
  } else if (kexAlgo === "ecdh-sha2-nistp256") {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])) as CryptoKeyPair;
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    await layer.send(new Writer().u8(30).str(pub).build());
    const reply = await expectKexReply(layer);
    const rr = new Reader(reply);
    hostKeyBlob = rr.str();
    qSField = rr.str();
    signatureBlob = rr.str();
    const peer = await crypto.subtle.importKey("raw", qSField as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, pair.privateKey, 256));
    qCField = pub;
    sharedMpintString = new Writer().mpintFromBytes(shared).build();
  } else {
    // diffie-hellman-group14-sha256
    const privBytes = crypto.getRandomValues(new Uint8Array(32));
    const x = bytesToBigInt(privBytes) % (DH14_PRIME - 1n);
    const gx = modPow(2n, x, DH14_PRIME);
    const gxMpint = bigIntToMpintBytes(gx);
    await layer.send(new Writer().u8(30).raw(u32Wrapped(gxMpint)).build());
    const reply = await expectKexReply(layer);
    const rr = new Reader(reply);
    hostKeyBlob = rr.str();
    qSField = rr.str(); // mpint bytes of f
    signatureBlob = rr.str();
    const gy = bytesToBigInt(mpintBytes(qSField));
    if (gy <= 1n || gy >= DH14_PRIME - 1n) throw new SshProbeError("negotiation", "DH 参数异常");
    const shared = modPow(gy, x, DH14_PRIME);
    qCField = gxMpint;
    sharedMpintString = new Writer().mpintFromBigInt(shared).build();
  }

  // --- exchange hash + host key checks
  const hashInput = new Writer()
    .str(CLIENT_VERSION)
    .str(serverVersion)
    .str(clientKexInit)
    .str(serverKexInit)
    .str(hostKeyBlob)
    .str(qCField)
    .str(qSField)
    .raw(sharedMpintString)
    .build();
  const exchangeHash = await sha256(hashInput);
  const sessionId = exchangeHash;

  const fingerprint = await hostKeyFingerprint(hostKeyBlob);
  if (target.knownFingerprint && target.knownFingerprint !== fingerprint) {
    throw new SshProbeError("hostkey_mismatch", "主机密钥与上次记录不一致");
  }
  const hostKeyAlgo = await verifyHostKey(hostKeyBlob, signatureBlob, exchangeHash);

  // --- NEWKEYS + key derivation
  await layer.send(new Writer().u8(21).build());
  const newKeys = await layer.recv();
  if (newKeys[0] !== 21) throw new SshProbeError("protocol", "服务器没有确认新密钥");
  const keys = {
    ivC2S: await deriveKeyMaterial(sharedMpintString, exchangeHash, sessionId, "A", 16),
    ivS2C: await deriveKeyMaterial(sharedMpintString, exchangeHash, sessionId, "B", 16),
    keyC2S: await deriveKeyMaterial(sharedMpintString, exchangeHash, sessionId, "C", cipherKeyLen(cipherC2S)),
    keyS2C: await deriveKeyMaterial(sharedMpintString, exchangeHash, sessionId, "D", cipherKeyLen(cipherS2C)),
    macC2S: await deriveKeyMaterial(sharedMpintString, exchangeHash, sessionId, "E", 32),
    macS2C: await deriveKeyMaterial(sharedMpintString, exchangeHash, sessionId, "F", 32),
  };
  await layer.enableEncryption(keys);

  // --- service request + auth
  await layer.send(new Writer().u8(5).str("ssh-userauth").build());
  const serviceReply = await layer.recv();
  if (serviceReply[0] !== 6) throw new SshProbeError("protocol", "服务器拒绝认证服务");

  const methods = await authMethods(layer, target.username);
  const secretLooksLikeKey = target.secret.includes("PRIVATE KEY-----");
  const useKey = target.authType === "key" || secretLooksLikeKey;
  if (useKey) {
    await publicKeyAuth(layer, target, sessionId);
  } else if (methods.includes("password")) {
    await passwordAuth(layer, target, "password");
  } else if (methods.includes("keyboard-interactive")) {
    await keyboardInteractiveAuth(layer, target);
  } else {
    await passwordAuth(layer, target, "password");
  }

  // --- session channel + exec
  const output = await execCommand(layer, PROBE_COMMAND);
  return parseProbeOutput(output, fingerprint, hostKeyAlgo);
}

function u32Wrapped(mpint: Uint8Array): Uint8Array {
  return new Writer().str(mpint).build();
}

async function expectKexReply(layer: PacketLayer): Promise<Uint8Array> {
  for (let i = 0; i < 10; i++) {
    const payload = await layer.recv();
    if (payload[0] === 31) return payload.slice(1);
    if (payload[0] === 20) continue; // a resent KEXINIT; our stored one stands
    throw new SshProbeError("protocol", "密钥交换回复异常");
  }
  throw new SshProbeError("protocol", "密钥交换回复异常");
}

async function authMethods(layer: PacketLayer, username: string): Promise<string[]> {
  await layer.send(new Writer().u8(50).str(username).str("session").str("none").build());
  const reply = await layer.recv();
  if (reply[0] === 51) return []; // already authenticated (should not happen)
  if (reply[0] !== 52) return [];
  const r = new Reader(reply.slice(1));
  return r.strText().split(",").map((s) => s.trim());
}

function authFailed(): SshProbeError {
  return new SshProbeError("auth", "认证失败");
}

async function passwordAuth(layer: PacketLayer, target: SshProbeTarget, method: string): Promise<void> {
  await layer.send(
    new Writer().u8(50).str(target.username).str("session").str(method).bool(true).str(target.secret).build(),
  );
  const reply = await layer.recv();
  if (reply[0] === 51) return;
  throw authFailed();
}

async function keyboardInteractiveAuth(layer: PacketLayer, target: SshProbeTarget): Promise<void> {
  await layer.send(
    new Writer().u8(50).str(target.username).str("session").str("keyboard-interactive").str("").str("").build(),
  );
  let reply = await layer.recv();
  if (reply[0] === 51) return;
  if (reply[0] !== 60) throw authFailed();
  const r = new Reader(reply.slice(1));
  r.strText(); // name
  r.strText(); // instruction
  r.strText(); // language
  const prompts = r.u32();
  const w = new Writer().u8(61).u32(prompts);
  for (let i = 0; i < prompts; i++) {
    r.strText(); // prompt
    r.u8(); // echo
    w.str(target.secret);
  }
  await layer.send(w.build());
  reply = await layer.recv();
  if (reply[0] === 51) return;
  throw authFailed();
}

async function publicKeyAuth(layer: PacketLayer, target: SshProbeTarget, sessionId: Uint8Array): Promise<void> {
  const loaded = await loadPrivateKey(target.secret);
  const requestBody = new Writer()
    .u8(50)
    .str(target.username)
    .str("session")
    .str("publickey")
    .bool(true)
    .str(loaded.sigAlgo === "rsa-sha2-256" ? "rsa-sha2-256" : loaded.algo)
    .str(loaded.keyBlob)
    .build();
  const signedData = concat(new Writer().str(sessionId).build(), requestBody);
  const signature = await loaded.sign(signedData);
  const signatureBlob = new Writer().str(loaded.sigAlgo).str(signature).build();
  await layer.send(concat(requestBody, new Writer().str(signatureBlob).build()));
  const reply = await layer.recv();
  if (reply[0] === 51) return;
  throw authFailed();
}

async function execCommand(layer: PacketLayer, command: string): Promise<string> {
  await layer.send(
    new Writer().u8(90).str("session").u32(0).u32(1024 * 1024).u32(32768).build(),
  );
  let recipient = -1;
  for (let i = 0; i < 10 && recipient < 0; i++) {
    const payload = await layer.recv();
    if (payload[0] === 91) {
      const r = new Reader(payload.slice(1));
      recipient = r.u32();
    } else if (payload[0] === 92) {
      throw new SshProbeError("protocol", "服务器拒绝打开会话通道");
    }
  }
  if (recipient < 0) throw new SshProbeError("protocol", "服务器没有确认会话通道");
  await layer.send(
    new Writer().u8(98).u32(recipient).str("exec").bool(true).str(command).build(),
  );
  const stdout: Uint8Array[] = [];
  let stdoutLen = 0;
  let sawSuccess = false;
  for (let guard = 0; guard < 1000; guard++) {
    const payload = await layer.recv();
    const code = payload[0];
    if (code === 99) {
      sawSuccess = true;
      continue;
    }
    if (code === 100) throw new SshProbeError("protocol", "服务器拒绝执行命令");
    if (code === 94) {
      const r = new Reader(payload.slice(1));
      r.u32();
      const data = r.str();
      if (stdoutLen < MAX_OUTPUT) {
        stdout.push(data);
        stdoutLen += data.length;
      }
      continue;
    }
    if (code === 97) {
      await layer.send(new Writer().u8(97).u32(recipient).build()).catch(() => undefined);
      break;
    }
    // 93 window adjust, 95 extended data, 96 eof, 98 channel requests
    // (exit-status etc.) need no handling for the probe.
  }
  if (!sawSuccess && stdoutLen === 0) throw new SshProbeError("protocol", "命令没有执行成功");
  return td.decode(concat(...stdout));
}

function parseProbeOutput(output: string, fingerprint: string, hostKeyAlgo: string): SshProbeResult {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  let hostname = "";
  let os = "";
  let kernel = "";
  let arch = "";
  for (const line of lines) {
    if (line.startsWith("OS=")) os = line.slice(3).replace(/^"|"$/g, "");
    else if (line.startsWith("K=")) kernel = line.slice(2);
    else if (line.startsWith("A=")) arch = line.slice(2);
    else if (!hostname) hostname = line;
  }
  return { hostname, os, kernel, arch, fingerprint, hostKeyAlgo };
}
