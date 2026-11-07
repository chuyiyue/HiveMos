// RFC 6238 TOTP and recovery codes. Ported from SMSinBox src/totp.ts.
// The only behavior change is the issuer name.

import { copyBytes, equalBytes, sha256Hex } from "./auth";
import { decryptString, sealString, type ContentKey } from "./crypto";

// RFC 6238 defaults; authenticator apps all understand these parameters.
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_WINDOW_STEPS = 1;
export const TOTP_SECRET_BYTES = 20;
export const TOTP_ISSUER = "HiveMos";

// A pending enrollment is only useful while the operator is typing the code.
export const TOTP_PENDING_TTL_MS = 15 * 60 * 1000;
export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 12;

// The password step hands out a short-lived single-use ticket.
export const TOTP_TICKET_TTL_SECONDS = 5 * 60;
export const TOTP_TICKET_MAX_ATTEMPTS = 5;
export const TOTP_RATE_LIMIT_PER_MINUTE = 5;
// Survives ticket churn: a caller with the password cannot buy extra guesses
// by requesting a new ticket after every failure.
export const TOTP_FAILURE_LIMIT = 10;
export const TOTP_FAILURE_WINDOW_MS = 5 * 60 * 1000;

const SECRET_PLAIN_PREFIX = "plain:";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const RECOVERY_HASH_PREFIX = "totp-recovery:";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let encoded = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) encoded += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return encoded;
}

export function base32Decode(value: string): Uint8Array | null {
  const cleaned = value
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/=+$/g, "");
  if (!cleaned || cleaned.length > 128) return null;
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) return null;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return bytes.length > 0 ? new Uint8Array(bytes) : null;
}

export function generateTotpSecret(): string {
  const bytes = new Uint8Array(TOTP_SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

export function totpCounter(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

// HOTP (RFC 4226) / TOTP (RFC 6238) with HMAC-SHA1, the algorithm every
// authenticator app supports. Web Crypto means no runtime dependency.
export async function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): Promise<string> {
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey(
    "raw",
    copyBytes(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function normalizeTotpCode(value: string): string | null {
  const cleaned = value.replace(/[\s-]/g, "");
  return new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(cleaned) ? cleaned : null;
}

// Returns the time step that matched, or null. A matched step must be newer
// than lastCounter so a code cannot be replayed inside the skew window.
export async function matchTotp(input: {
  secret: string;
  code: string;
  nowMs: number;
  window?: number;
  lastCounter?: number | null;
}): Promise<number | null> {
  const normalized = normalizeTotpCode(input.code);
  if (!normalized) return null;
  const secret = base32Decode(input.secret);
  if (!secret) return null;
  const current = totpCounter(input.nowMs);
  const window = input.window ?? TOTP_WINDOW_STEPS;
  const provided = new TextEncoder().encode(normalized);
  let matched: number | null = null;
  for (let step = -window; step <= window; step += 1) {
    const counter = current + step;
    if (counter < 0) continue;
    const expected = new TextEncoder().encode(await hotp(secret, counter));
    if (equalBytes(expected, provided) && matched === null) matched = counter;
  }
  if (matched === null) return null;
  if (input.lastCounter != null && matched <= input.lastCounter) return null;
  return matched;
}

export function totpUri(secret: string, username: string): string {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${username}`);
  const params = new URLSearchParams({
    secret,
    issuer: TOTP_ISSUER,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function formatRecoveryCode(raw: string): string {
  const value = raw.toUpperCase();
  return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}`;
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    codes.add(formatRecoveryCode(base32Encode(bytes).slice(0, RECOVERY_CODE_LENGTH)));
  }
  return [...codes];
}

export function normalizeRecoveryCode(value: string): string | null {
  const cleaned = value.toUpperCase().replace(/[^A-Z2-7]/g, "");
  return cleaned.length === RECOVERY_CODE_LENGTH ? cleaned : null;
}

export async function hashRecoveryCode(value: string): Promise<string> {
  const normalized = normalizeRecoveryCode(value);
  return sha256Hex(`${RECOVERY_HASH_PREFIX}${normalized ?? value.trim().toUpperCase()}`);
}

// CONTENT_KEY seals the TOTP secret the same way as message bodies. Without a
// key we keep the base32 secret with a `plain:` prefix (documented, matching
// devices.secret) so self-hosted installs without CONTENT_KEY still work.
export async function sealTotpSecret(key: ContentKey, secret: string): Promise<string | null> {
  if (key.state === "invalid") return null;
  if (key.state === "off") return `${SECRET_PLAIN_PREFIX}${secret}`;
  return sealString(key, secret);
}

export async function openTotpSecret(key: ContentKey, stored: string): Promise<string | null> {
  if (stored.startsWith(SECRET_PLAIN_PREFIX)) {
    const secret = stored.slice(SECRET_PLAIN_PREFIX.length);
    return secret || null;
  }
  if (key.state !== "on") return null;
  return decryptString(key.raw, stored);
}

export function isSealedTotpSecret(stored: string | null): boolean {
  return stored != null && !stored.startsWith(SECRET_PLAIN_PREFIX);
}
