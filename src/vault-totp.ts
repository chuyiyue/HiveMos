// 保险库「验证码」（TOTP 两步验证）条目：存储、判重、取码，以及 otpauth://
// 链接的解析与生成。导入解析（阶段 3）与导出生成（阶段 4）也收在本文件，
// 路由层只负责会话/跨站检查、请求体上限与操作日志。
//
// 机密口径与条目密码一致：secret_enc 是 VAULT_KEY 信封的 AES-GCM 密文
// （sealSecret / openSecret 复用 vault.ts），列表只回公开字段与当前码，
// 明文只能经 /api/vault/reveal（kind=totp）取出并先写一条访问日志。
//
// 判重只看 secret_hash：归一化密钥（base32 大写、无空格/横线/填充）的
// SHA-256 十六进制。它不可逆推明文，也不进备份包，只用于「同一条密钥
// 重复添加/导入」时返回 409。
//
// 分组复用 vault_groups 这张自有分组池，删除语义与 entries/gateways 一致。

import { base64UrlToBytes, copyBytes, sha256Hex } from "./auth";
import type { D1Database, Env } from "./env";
import { prepare } from "./registry";
import { base32Decode, base32Encode, hotp, isTotpAlgorithm, type TotpAlgorithm } from "./totp";
import {
  VaultError,
  newId,
  openSecret,
  optGroupId,
  optText,
  rowsOf,
  sealSecret,
  vaultKey,
} from "./vault";

// 单库上限：500 条。与条目的 60 字符名称上限分开，服务名/账号在真实站点里
// 更长（"Microsoft 365"、"name@company.example"）。
export const TOTP_MAX_ENTRIES = 500;
const ISSUER_MAX = 80;
const ACCOUNT_MAX = 120;
const NOTE_MAX = 300;
const ICON_MAX = 40;
// 16 个 base32 字符解出 10 字节。低于这个长度的密钥熵不足，real-world 的
// 验证码密钥最少也是 80 位。
const SECRET_MIN_BYTES = 10;
const DIGITS_MIN = 6;
const DIGITS_MAX = 8;
const PERIOD_MIN = 5;
const PERIOD_MAX = 300;
const DEFAULT_ALGORITHM: TotpAlgorithm = "SHA1";
const DEFAULT_DIGITS = 6;
const DEFAULT_PERIOD = 30;

export interface VaultTotpRow {
  id: string;
  issuer: string;
  account: string;
  secret_enc: string;
  secret_hash: string;
  algorithm: string;
  digits: number;
  period: number;
  icon: string | null;
  note: string;
  group_id: string | null;
  ai_read: number;
  created_at: number;
  updated_at: number;
}

// 公开字段：不带密钥、不带验证码。icon 为空表示「自动匹配」。
export function totpPublic(row: VaultTotpRow): Record<string, unknown> {
  return {
    id: row.id,
    issuer: row.issuer,
    account: row.account,
    algorithm: row.algorithm,
    digits: row.digits,
    period: row.period,
    icon: row.icon,
    note: row.note,
    group_id: row.group_id ?? null,
    ai_read: row.ai_read !== 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---- 密钥与参数校验 ---------------------------------------------------------

// 归一化：容忍大小写、空格、横线与缺失填充，输出规范 base32（大写无填充）。
// 解不出或明文熵不足时返回 null，调用方按「无效密钥」报错。
export function canonicalSecret(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const decoded = base32Decode(value);
  if (!decoded || decoded.byteLength < SECRET_MIN_BYTES) return null;
  return base32Encode(decoded);
}

export function secretFingerprint(canonical: string): Promise<string> {
  return sha256Hex(canonical);
}

function algorithmOf(value: unknown, fallback: TotpAlgorithm): TotpAlgorithm {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") throw new VaultError("验证码算法格式不正确");
  const algorithm = value.trim().toUpperCase();
  if (!isTotpAlgorithm(algorithm)) throw new VaultError("验证码算法只支持 SHA1、SHA256、SHA512");
  return algorithm;
}

function integerIn(value: unknown, min: number, max: number, label: string, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  let parsed: number;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "string" && /^\d+$/.test(value.trim())) parsed = Number(value.trim());
  else throw new VaultError(label + "需为整数");
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new VaultError(`${label}需为 ${min} 到 ${max}`);
  return parsed;
}

function digitsOf(value: unknown, fallback: number): number {
  return integerIn(value, DIGITS_MIN, DIGITS_MAX, "验证码位数", fallback);
}

function periodOf(value: unknown, fallback: number): number {
  return integerIn(value, PERIOD_MIN, PERIOD_MAX, "验证码周期", fallback);
}

function aiReadOf(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "true" || text === "1") return true;
    if (text === "false" || text === "0") return false;
  }
  throw new VaultError("ai_read 只能是 true 或 false");
}

function iconOf(body: Record<string, unknown>, existing: VaultTotpRow | null): string | null {
  const value = body["icon"];
  if (value === undefined) return existing ? existing.icon : null;
  if (value === null) return null;
  if (typeof value !== "string") throw new VaultError("图标标识格式不正确");
  const trimmed = value.trim();
  if (trimmed.length > ICON_MAX) throw new VaultError("图标标识太长了");
  return trimmed === "" ? null : trimmed;
}

// ---- otpauth:// -------------------------------------------------------------

export interface ParsedOtpauth {
  issuer: string;
  account: string;
  secret: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
}

// 解析 otpauth://totp/Label?secret=...&issuer=... 的链接。只支持 TOTP：
// HOTP / Steam 令牌 / MD5 一律抛 VaultError，导入预览会把这条记为
// supported:false 并把这个 message 当作 reason。
export function parseOtpauthUri(uri: string): ParsedOtpauth {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    throw new VaultError("otpauth 链接无法解析");
  }
  if (url.protocol !== "otpauth:") throw new VaultError("不是 otpauth 链接");
  const type = url.host.toLowerCase();
  if (type === "hotp") throw new VaultError("目前只支持 TOTP（该链接是 HOTP）");
  if (type === "steam") throw new VaultError("目前只支持 TOTP（该链接是 Steam 令牌）");
  if (type !== "totp") throw new VaultError(`不支持的 otpauth 类型：${type || "未知"}`);

  const rawSecret = url.searchParams.get("secret") ?? "";
  const secret = canonicalSecret(rawSecret);
  if (!secret) throw new VaultError("链接里的密钥不是有效的 base32（解码后至少 10 字节）");

  // Label 是 URL 编码的 "Issuer:Account"，issuer 参数优先；两者都缺才报错。
  let label = "";
  try {
    label = decodeURIComponent(url.pathname.replace(/^\//, ""));
  } catch {
    throw new VaultError("otpauth 链接标题无法解析");
  }
  const issuerParam = (url.searchParams.get("issuer") ?? "").trim();
  let issuer = issuerParam;
  let account = label.trim();
  const colon = account.indexOf(":");
  if (colon >= 0) {
    if (!issuer) issuer = account.slice(0, colon).trim();
    account = account.slice(colon + 1).trim();
  }
  if (!issuer) throw new VaultError("链接缺少服务名（issuer）");
  if (issuer.length > ISSUER_MAX) throw new VaultError("服务名太长了");
  if (account.length > ACCOUNT_MAX) throw new VaultError("账号太长了");

  const algorithmText = url.searchParams.get("algorithm");
  const algorithm = algorithmText
    ? algorithmOf(algorithmText, DEFAULT_ALGORITHM)
    : DEFAULT_ALGORITHM;
  const digits = digitsOf(url.searchParams.get("digits"), DEFAULT_DIGITS);
  const period = periodOf(url.searchParams.get("period"), DEFAULT_PERIOD);
  return { issuer, account, secret, algorithm, digits, period };
}

// ---- 字段合并（新增/修改） --------------------------------------------------

interface TotpFields {
  issuer: string;
  account: string;
  secret: string | null; // 规范 base32；null 表示修改时不动原密钥
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
  icon: string | null;
  note: string;
  groupId: string | null | undefined; // undefined = 不修改
  aiRead: boolean;
}

function storedAlgorithm(row: VaultTotpRow): TotpAlgorithm {
  return isTotpAlgorithm(row.algorithm) ? row.algorithm : DEFAULT_ALGORITHM;
}

async function resolveFields(
  db: D1Database,
  body: Record<string, unknown>,
  existing: VaultTotpRow | null,
): Promise<TotpFields> {
  const otpauthText = typeof body["otpauth"] === "string" ? body["otpauth"].trim() : "";
  if (otpauthText) {
    // 链接为准：服务名/账号/密钥/算法/位数/周期全部取自链接，
    // 只有备注、图标、分组、ai_read 允许请求体覆盖。
    const parsed = parseOtpauthUri(otpauthText);
    const note = optText(body, "note", NOTE_MAX, "备注");
    return {
      issuer: parsed.issuer,
      account: parsed.account,
      secret: parsed.secret,
      algorithm: parsed.algorithm,
      digits: parsed.digits,
      period: parsed.period,
      icon: iconOf(body, existing),
      note: note ?? existing?.note ?? "",
      groupId: await optGroupId(db, body),
      aiRead: aiReadOf(body["ai_read"], existing ? existing.ai_read !== 0 : true),
    };
  }

  let issuer = existing ? existing.issuer : "";
  const issuerText = optText(body, "issuer", ISSUER_MAX, "服务名");
  if (issuerText !== undefined) issuer = issuerText;
  if (!issuer) throw new VaultError("请填写服务名");

  let account = existing ? existing.account : "";
  const accountText = optText(body, "account", ACCOUNT_MAX, "账号");
  if (accountText !== undefined) account = accountText;

  let secret: string | null = null;
  const rawSecret = body["secret"];
  if (rawSecret !== undefined && rawSecret !== null && rawSecret !== "") {
    if (typeof rawSecret !== "string") throw new VaultError("密钥格式不正确");
    secret = canonicalSecret(rawSecret);
    if (!secret) throw new VaultError("密钥需为有效的 base32（解码后至少 10 字节）");
  }

  const note = optText(body, "note", NOTE_MAX, "备注");
  return {
    issuer,
    account,
    secret,
    algorithm:
      body["algorithm"] === undefined
        ? existing
          ? storedAlgorithm(existing)
          : DEFAULT_ALGORITHM
        : algorithmOf(body["algorithm"], DEFAULT_ALGORITHM),
    digits: digitsOf(body["digits"], existing ? existing.digits : DEFAULT_DIGITS),
    period: periodOf(body["period"], existing ? existing.period : DEFAULT_PERIOD),
    icon: iconOf(body, existing),
    note: note ?? existing?.note ?? "",
    groupId: await optGroupId(db, body),
    aiRead: aiReadOf(body["ai_read"], existing ? existing.ai_read !== 0 : true),
  };
}

// ---- CRUD -------------------------------------------------------------------

async function getTotpEntry(db: D1Database, id: string): Promise<VaultTotpRow | null> {
  return prepare(db, "SELECT * FROM vault_totp WHERE id = ?", [id]).first<VaultTotpRow>();
}

export async function listTotpEntries(db: D1Database): Promise<VaultTotpRow[]> {
  return rowsOf(await prepare(db, "SELECT * FROM vault_totp ORDER BY created_at ASC, id ASC").all<VaultTotpRow>());
}

export async function countTotpEntries(db: D1Database): Promise<number> {
  const row = await prepare(db, "SELECT COUNT(*) AS total FROM vault_totp").first<{ total: number }>();
  return Number(row?.total ?? 0);
}

// 判重：secret_hash 已存在就 409，并把已有条目的 id/issuer 带回去，
// 面板据此高亮「已有这条」而不是再插一条。
async function assertUniqueSecret(db: D1Database, hash: string, selfId: string | null): Promise<void> {
  const duplicate = await prepare(
    db,
    "SELECT id, issuer, account FROM vault_totp WHERE secret_hash = ? AND id <> ? LIMIT 1",
    [hash, selfId ?? ""],
  ).first<{ id: string; issuer: string; account: string }>();
  if (!duplicate) return;
  throw new VaultError("这条密钥已经在保险库里了", 409, {
    existing: { id: duplicate.id, issuer: duplicate.issuer, account: duplicate.account },
  });
}

export async function createTotpEntry(
  db: D1Database,
  env: Env,
  body: Record<string, unknown>,
  now: number,
): Promise<VaultTotpRow> {
  if ((await countTotpEntries(db)) >= TOTP_MAX_ENTRIES) {
    throw new VaultError(`验证码条目已达上限 ${TOTP_MAX_ENTRIES} 条`, 400);
  }
  const fields = await resolveFields(db, body, null);
  if (!fields.secret) throw new VaultError("请填写密钥");
  const hash = await secretFingerprint(fields.secret);
  await assertUniqueSecret(db, hash, null);
  const row: VaultTotpRow = {
    id: newId("totp"),
    issuer: fields.issuer,
    account: fields.account,
    secret_enc: await sealSecret(env, fields.secret),
    secret_hash: hash,
    algorithm: fields.algorithm,
    digits: fields.digits,
    period: fields.period,
    icon: fields.icon,
    note: fields.note,
    group_id: fields.groupId ?? null,
    ai_read: fields.aiRead ? 1 : 0,
    created_at: now,
    updated_at: now,
  };
  await prepare(
    db,
    "INSERT INTO vault_totp (id, issuer, account, secret_enc, secret_hash, algorithm, digits, period, icon, note, group_id, ai_read, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      row.id,
      row.issuer,
      row.account,
      row.secret_enc,
      row.secret_hash,
      row.algorithm,
      row.digits,
      row.period,
      row.icon,
      row.note,
      row.group_id,
      row.ai_read,
      row.created_at,
      row.updated_at,
    ],
  ).run();
  return row;
}

export async function updateTotpEntry(
  db: D1Database,
  env: Env,
  id: string,
  body: Record<string, unknown>,
  now: number,
): Promise<VaultTotpRow> {
  const row = await getTotpEntry(db, id);
  if (!row) throw new VaultError("验证码条目不存在", 404);
  const fields = await resolveFields(db, body, row);
  let secretEnc = row.secret_enc;
  let hash = row.secret_hash;
  if (fields.secret) {
    hash = await secretFingerprint(fields.secret);
    await assertUniqueSecret(db, hash, id);
    secretEnc = await sealSecret(env, fields.secret);
  }
  row.issuer = fields.issuer;
  row.account = fields.account;
  row.secret_enc = secretEnc;
  row.secret_hash = hash;
  row.algorithm = fields.algorithm;
  row.digits = fields.digits;
  row.period = fields.period;
  row.icon = fields.icon;
  row.note = fields.note;
  if (fields.groupId !== undefined) row.group_id = fields.groupId;
  row.ai_read = fields.aiRead ? 1 : 0;
  row.updated_at = now;
  await prepare(
    db,
    "UPDATE vault_totp SET issuer = ?, account = ?, secret_enc = ?, secret_hash = ?, algorithm = ?, digits = ?, period = ?, icon = ?, note = ?, group_id = ?, ai_read = ?, updated_at = ? WHERE id = ?",
    [
      row.issuer,
      row.account,
      row.secret_enc,
      row.secret_hash,
      row.algorithm,
      row.digits,
      row.period,
      row.icon,
      row.note,
      row.group_id,
      row.ai_read,
      row.updated_at,
      row.id,
    ],
  ).run();
  return row;
}

export async function deleteTotpEntry(db: D1Database, id: string): Promise<VaultTotpRow> {
  const row = await getTotpEntry(db, id);
  if (!row) throw new VaultError("验证码条目不存在", 404);
  await prepare(db, "DELETE FROM vault_totp WHERE id = ?", [id]).run();
  return row;
}

// ---- 取码 -------------------------------------------------------------------

// VAULT_KEY 未配置时整组取码不可用：面板据此整页提示，而不是每条报错。
// detail.code 是给前端的稳定标识（off = 未配置，invalid = 配置有误）。
export function assertVaultKey(env: Env): void {
  const key = vaultKey(env);
  if (key.state === "invalid") {
    throw new VaultError("保险库密钥配置不正确，无法生成验证码", 503, { code: "vault_key_invalid" });
  }
  if (key.state !== "on") {
    throw new VaultError("保险库密钥未配置，无法生成验证码", 503, { code: "vault_key_unset" });
  }
}

export interface TotpCodeEntry {
  id: string;
  code: string;
  nextCode: string;
  remaining: number;
  period: number;
}

// 当前码 + 下一个码 + 剩余秒数。remaining 按服务端时间算，前端只做倒计时
// 递减即可（每 30 秒一轮的页面不必自己猜时钟）。
export async function listTotpCodes(db: D1Database, env: Env, now: number): Promise<TotpCodeEntry[]> {
  assertVaultKey(env);
  const rows = await listTotpEntries(db);
  const nowSeconds = Math.floor(now / 1000);
  const entries: TotpCodeEntry[] = [];
  for (const row of rows) {
    const secret = base32Decode(await openSecret(env, row.secret_enc));
    if (!secret) continue; // 写入时已校验，这里只防御历史坏数据
    const period = Number(row.period) || DEFAULT_PERIOD;
    const counter = Math.floor(nowSeconds / period);
    const algorithm = storedAlgorithm(row);
    entries.push({
      id: row.id,
      code: await hotp(secret, counter, row.digits, algorithm),
      nextCode: await hotp(secret, counter + 1, row.digits, algorithm),
      remaining: period - (nowSeconds % period),
      period,
    });
  }
  return entries;
}

// ---- 导入解析（阶段 3） -----------------------------------------------------
//
// 五种格式共用一条流水线：先解码成「原始条目」（issuer/account/secret/参数
// + 可选的 problem），再逐条走与新增相同的校验（resolveFields），最后按
// secret_hash 标判重。只有通过校验的条目进 entries（含密钥，供确认回传）；
// items 是给面板看的逐条口径（含 supported/reason/duplicate）。
//
// 只收 TOTP：HOTP / Steam / MD5 在解析阶段就写 problem，预览里显示为
// supported:false 并给出原因，确认导入时不会被写进库。

export const TOTP_MAX_IMPORT_BYTES = 512 * 1024;

export interface ImportItem {
  index: number;
  issuer: string;
  account: string;
  algorithm: string;
  digits: number;
  period: number;
  duplicate: boolean;
  supported: boolean;
  reason?: string;
}

export interface ImportEntry {
  index: number;
  issuer: string;
  account: string;
  secret: string;
  algorithm: string;
  digits: number;
  period: number;
  icon: string | null;
  note: string;
  group: string | null;
  ai_read: boolean;
}

export interface ImportPreview {
  format: string;
  items: ImportItem[];
  entries: ImportEntry[];
}

// 原始条目：解析阶段拿到的一切。problem 表示「已确定不支持」，但 issuer/
// account 仍然带出来，预览里能看见是哪一条被跳过。
interface RawEntry {
  issuer: string;
  account: string;
  secret: string;
  algorithm: string;
  digits: number;
  period: number;
  icon: string | null;
  note: string;
  group: string | null;
  aiRead: boolean;
  problem?: string;
}

function rawEntry(partial: Partial<RawEntry> = {}): RawEntry {
  return {
    issuer: partial.issuer ?? "",
    account: partial.account ?? "",
    secret: partial.secret ?? "",
    algorithm: partial.algorithm ?? DEFAULT_ALGORITHM,
    digits: partial.digits ?? DEFAULT_DIGITS,
    period: partial.period ?? DEFAULT_PERIOD,
    icon: partial.icon ?? null,
    note: partial.note ?? "",
    group: partial.group ?? null,
    aiRead: partial.aiRead ?? true,
    problem: partial.problem,
  };
}

function decodeBase64(value: string): Uint8Array | null {
  const cleaned = value.replace(/\s/g, "").replace(/=+$/g, "");
  if (!cleaned) return null;
  return base64UrlToBytes(cleaned.replaceAll("+", "-").replaceAll("/", "_"));
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// ---- 最小 protobuf 解码（Google Authenticator 迁移链接） -------------------
//
// otpauth-migration://offline?data=… 的 data 是 MigrationPayload 的 protobuf。
// 只需要 varint 与 length-delimited 两种 wire type，手写解析避免引入依赖。

interface ProtoField {
  field: number;
  wire: number;
  varint: number;
  bytes: Uint8Array | null;
}

function readVarint(bytes: Uint8Array, offset: number): { value: number; offset: number } | null {
  let value = 0;
  let shift = 0;
  let index = offset;
  while (index < bytes.length) {
    const byte = bytes[index++] ?? 0;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset: index };
    shift += 7;
    if (shift > 49) return null;
  }
  return null;
}

function parseProto(bytes: Uint8Array): ProtoField[] | null {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const head = readVarint(bytes, offset);
    if (!head) return null;
    offset = head.offset;
    const field = Math.floor(head.value / 8);
    const wire = head.value & 7;
    if (field <= 0) return null;
    if (wire === 0) {
      const value = readVarint(bytes, offset);
      if (!value) return null;
      fields.push({ field, wire, varint: value.value, bytes: null });
      offset = value.offset;
    } else if (wire === 2) {
      const length = readVarint(bytes, offset);
      if (!length) return null;
      const end = length.offset + length.value;
      if (end > bytes.length) return null;
      fields.push({ field, wire, varint: 0, bytes: bytes.subarray(length.offset, end) });
      offset = end;
    } else if (wire === 5) {
      offset += 4;
      if (offset > bytes.length) return null;
    } else if (wire === 1) {
      offset += 8;
      if (offset > bytes.length) return null;
    } else {
      return null;
    }
  }
  return fields;
}

function firstBytes(fields: ProtoField[], field: number): Uint8Array | null {
  for (const item of fields) if (item.field === field && item.wire === 2) return item.bytes;
  return null;
}

function firstVarint(fields: ProtoField[], field: number): number | null {
  for (const item of fields) if (item.field === field && item.wire === 0) return item.varint;
  return null;
}

function migrationAlgorithm(value: number | null): string {
  // Google 迁移负载的 Algorithm 枚举：1=SHA1 2=SHA256 3=SHA512 4=MD5
  if (value === 2) return "SHA256";
  if (value === 3) return "SHA512";
  if (value === 4) return "MD5";
  return "SHA1";
}

function migrationDigits(value: number | null): number {
  // DigitCount 枚举：1=6 位 2=8 位；缺省按 6 位。
  return value === 2 ? 8 : 6;
}

function parseMigration(uri: string): { format: string; entries: RawEntry[] } {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    throw new VaultError("迁移链接无法解析");
  }
  if (url.protocol !== "otpauth-migration:") throw new VaultError("不是 Google Authenticator 迁移链接");
  // 查询串里的 '+' 未编码时会被解成空格，这里还原（base64 标准字母表）。
  const rawData = (url.searchParams.get("data") ?? "").replace(/ /g, "+");
  const payload = decodeBase64(rawData);
  if (!payload) throw new VaultError("迁移链接里的数据无法解码（base64 不完整）");
  const fields = parseProto(payload);
  if (!fields) throw new VaultError("迁移负载不是有效的 protobuf");
  const entries: RawEntry[] = [];
  for (const item of fields) {
    if (item.field !== 1 || item.wire !== 2 || !item.bytes) continue;
    const params = parseProto(item.bytes);
    if (!params) throw new VaultError("迁移负载里的条目无法解析");
    const secretBytes = firstBytes(params, 1);
    const name = textOf(firstBytes(params, 2) ?? new Uint8Array()).trim();
    const issuer = textOf(firstBytes(params, 3) ?? new Uint8Array()).trim();
    const algorithm = migrationAlgorithm(firstVarint(params, 4));
    const type = firstVarint(params, 6);
    const entry = rawEntry({
      issuer: issuer || name,
      account: issuer ? name : "",
      secret: secretBytes ? base32Encode(secretBytes) : "",
      algorithm,
      digits: migrationDigits(firstVarint(params, 5)),
      period: DEFAULT_PERIOD,
      icon: null,
      note: "",
    });
    if (type === 1) entry.problem = "目前只支持 TOTP（该条为 HOTP）";
    else if (algorithm === "MD5") entry.problem = "不支持 MD5 算法的验证码";
    entries.push(entry);
  }
  if (entries.length === 0) throw new VaultError("迁移链接里没有验证码条目");
  return { format: "otpauth-migration", entries };
}

// ---- otpauth 链接文本 ------------------------------------------------------

function parseOtpauthLines(content: string): { format: string; entries: RawEntry[] } {
  const entries: RawEntry[] = [];
  for (const line of content.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    if (!/^otpauth:\/\//i.test(text)) {
      entries.push(rawEntry({ problem: "这一行不是 otpauth 链接" }));
      continue;
    }
    try {
      const parsed = parseOtpauthUri(text);
      entries.push(rawEntry({ ...parsed, note: "" }));
    } catch (error) {
      // 解析失败的链接也留一条，reason 用解析器给出的原因（HOTP/Steam/
      // 位数越界等都在这里体现）。
      const reason = error instanceof VaultError ? error.message : "链接无法解析";
      entries.push(rawEntry({ problem: reason }));
    }
  }
  if (entries.length === 0) throw new VaultError("文件里没有 otpauth 链接");
  return { format: "otpauth", entries };
}

// ---- Aegis 明文 JSON -------------------------------------------------------

interface JsonRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOf(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return fallback;
}

function parseAegis(root: JsonRecord): { format: string; entries: RawEntry[] } {
  const db = root["db"];
  if (!isRecord(db) || !Array.isArray(db["entries"])) throw new VaultError("不是 Aegis 明文备份");
  const groupNames = new Map<string, string>();
  if (Array.isArray(db["groups"])) {
    for (const group of db["groups"]) {
      if (isRecord(group) && typeof group["uuid"] === "string") groupNames.set(group["uuid"], stringOf(group["name"]));
    }
  }
  const entries: RawEntry[] = [];
  for (const item of db["entries"]) {
    if (!isRecord(item)) continue;
    const type = stringOf(item["type"]).toLowerCase();
    const info = isRecord(item["info"]) ? item["info"] : {};
    const groups = Array.isArray(item["groups"]) ? item["groups"].filter((v) => typeof v === "string") : [];
    const groupName = groups.length > 0 ? groupNames.get(groups[0] as string) ?? null : null;
    const algorithm = stringOf(info["algo"]) || stringOf(item["algo"]) || "SHA1";
    const entry = rawEntry({
      issuer: stringOf(item["issuer"]).trim() || stringOf(item["name"]).trim(),
      account: stringOf(item["issuer"]).trim() ? stringOf(item["name"]).trim() : "",
      secret: stringOf(info["secret"]) || stringOf(item["secret"]),
      algorithm: algorithm.toUpperCase(),
      digits: numberOf(info["digits"], 6),
      period: numberOf(info["period"], 30),
      icon: stringOf(item["icon"]) || null,
      note: stringOf(item["note"]),
      group: groupName,
    });
    if (type && type !== "totp") entry.problem = `目前只支持 TOTP（该条为 ${type.toUpperCase() === "STEAM" ? "Steam 令牌" : type.toUpperCase()}）`;
    else if (entry.algorithm === "MD5") entry.problem = "不支持 MD5 算法的验证码";
    entries.push(entry);
  }
  if (entries.length === 0) throw new VaultError("Aegis 备份里没有验证码条目");
  return { format: "aegis", entries };
}

// ---- 2FAS 明文 JSON --------------------------------------------------------
//
// 2FAS v4 明文导出：{schemaVersion, services:[{name, otp:{link|label, account,
// issuer, secret, algorithm, digits, period, tokenType}}], groups:[…]}。
// 加密导出把 services 换成一个 base64 字符串，这里直接报「已加密」。

function parse2Fas(root: JsonRecord): { format: string; entries: RawEntry[] } {
  const services = root["services"];
  if (!Array.isArray(services)) throw new VaultError("2FAS 备份已加密或格式不支持（services 不是明文列表）");
  const entries: RawEntry[] = [];
  for (const service of services) {
    if (!isRecord(service)) continue;
    const otp = isRecord(service["otp"]) ? service["otp"] : {};
    const tokenType = stringOf(otp["tokenType"]).toUpperCase();
    const link = stringOf(otp["link"]);
    if (link) {
      try {
        const parsed = parseOtpauthUri(link);
        const entry = rawEntry({
          ...parsed,
          note: stringOf(service["note"]),
          icon: stringOf(service["icon"]) || null,
        });
        if (tokenType && tokenType !== "TOTP") entry.problem = `目前只支持 TOTP（该条为 ${tokenType}）`;
        entries.push(entry);
        continue;
      } catch (error) {
        const reason = error instanceof VaultError ? error.message : "链接无法解析";
        const entry = rawEntry({
          issuer: stringOf(otp["issuer"]) || stringOf(otp["label"]) || stringOf(service["name"]),
          account: stringOf(otp["accountName"]),
          secret: stringOf(otp["secret"]),
          algorithm: stringOf(otp["algorithm"]) || "SHA1",
          digits: numberOf(otp["digits"], 6),
          period: numberOf(otp["period"], 30),
          note: stringOf(service["note"]),
          problem: reason,
        });
        entries.push(entry);
        continue;
      }
    }
    const entry = rawEntry({
      issuer: stringOf(otp["issuer"]) || stringOf(otp["label"]) || stringOf(service["name"]),
      account: stringOf(otp["accountName"]),
      secret: stringOf(otp["secret"]),
      algorithm: (stringOf(otp["algorithm"]) || "SHA1").toUpperCase(),
      digits: numberOf(otp["digits"], 6),
      period: numberOf(otp["period"], 30),
      note: stringOf(service["note"]),
      icon: stringOf(service["icon"]) || null,
    });
    if (tokenType && tokenType !== "TOTP") entry.problem = `目前只支持 TOTP（该条为 ${tokenType}）`;
    else if (entry.algorithm === "MD5") entry.problem = "不支持 MD5 算法的验证码";
    entries.push(entry);
  }
  if (entries.length === 0) throw new VaultError("2FAS 备份里没有验证码条目");
  return { format: "2fas", entries };
}

// ---- HiveMos JSON（明文或口令加密信封） ------------------------------------

function parseHivemos(root: JsonRecord): { format: string; entries: RawEntry[] } {
  const list = root["entries"];
  if (!Array.isArray(list)) throw new VaultError("不是 HiveMos 验证码导出文件");
  const entries: RawEntry[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    entries.push(
      rawEntry({
        issuer: stringOf(item["issuer"]),
        account: stringOf(item["account"]),
        secret: stringOf(item["secret"]),
        algorithm: (stringOf(item["algorithm"]) || "SHA1").toUpperCase(),
        digits: numberOf(item["digits"], 6),
        period: numberOf(item["period"], 30),
        icon: stringOf(item["icon"]) || null,
        note: stringOf(item["note"]),
        // 导出里 group 是组名；导入时按同名分组回挂，找不到就回未分组。
        group: stringOf(item["group"]) || null,
        aiRead: item["ai_read"] === undefined ? true : item["ai_read"] === true || item["ai_read"] === 1,
      }),
    );
  }
  if (entries.length === 0) throw new VaultError("HiveMos 导出文件里没有验证码条目");
  return { format: "hivemos", entries };
}

// 口令加密信封：{encrypted:true, kdf:"PBKDF2-SHA256", iter, salt, iv, data}
// salt/iv/data 用 base64url（与 auth.ts 的编码一致），AES-GCM 整体加密。
async function decryptHivemosEnvelope(root: JsonRecord, password: string): Promise<JsonRecord> {
  const kdf = stringOf(root["kdf"]);
  if (kdf && kdf !== "PBKDF2-SHA256") throw new VaultError(`不支持的加密方式：${kdf}`);
  const iterations = numberOf(root["iter"], 100000);
  if (iterations < 10000 || iterations > 1000000) throw new VaultError("导出文件的加密参数不合法");
  const salt = base64UrlToBytes(stringOf(root["salt"]));
  const iv = base64UrlToBytes(stringOf(root["iv"]));
  const data = base64UrlToBytes(stringOf(root["data"]));
  if (!salt || salt.byteLength < 8 || !iv || iv.byteLength !== 12 || !data) {
    throw new VaultError("导出文件的加密信封不完整");
  }
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: copyBytes(salt), iterations },
    keyMaterial,
    256,
  );
  const key = await crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["decrypt"]);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: copyBytes(iv) }, key, copyBytes(data));
  } catch {
    throw new VaultError("口令不正确，或导出文件已损坏");
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(plain));
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new VaultError("加密信封里的内容不是有效的导出 JSON");
  }
}

// ---- 预览 / 确认 ------------------------------------------------------------

async function existingFingerprints(db: D1Database): Promise<Set<string>> {
  const rows = rowsOf(await prepare(db, "SELECT secret_hash FROM vault_totp").all<{ secret_hash: string }>());
  return new Set(rows.map((row) => row.secret_hash));
}

// preview：自动识别格式 → 逐条校验 → 标判重/不支持，返回 items（口径）与
// entries（含密钥的完整结果，确认时原样回传）。
export async function previewTotpImport(
  db: D1Database,
  content: string,
  password?: string,
): Promise<ImportPreview> {
  const text = content.trim();
  if (!text) throw new VaultError("导入内容为空");
  if (text.length > TOTP_MAX_IMPORT_BYTES) throw new VaultError("导入内容超过 512 KB", 413);

  let parsed: { format: string; entries: RawEntry[] };
  if (/^otpauth-migration:\/\//i.test(text)) {
    parsed = parseMigration(text);
  } else {
    let json: unknown = null;
    let jsonOk = false;
    if (text.startsWith("{")) {
      try {
        json = JSON.parse(text);
        jsonOk = true;
      } catch {
        throw new VaultError("JSON 无法解析");
      }
    }
    if (jsonOk && isRecord(json)) {
      if (rootLooksHivemos(json)) {
        if (json["encrypted"] === true) {
          if (!password) throw new VaultError("该导出文件已加密，请填写导出时设置的口令");
          parsed = parseHivemos(await decryptHivemosEnvelope(json, password));
        } else {
          parsed = parseHivemos(json);
        }
      } else if (isRecord(json["db"]) && Array.isArray((json["db"] as JsonRecord)["entries"])) {
        parsed = parseAegis(json);
      } else if (Array.isArray(json["services"])) {
        parsed = parse2Fas(json);
      } else {
        throw new VaultError("无法识别的备份格式（既不是 HiveMos、Aegis 也不是 2FAS）");
      }
    } else if (text.includes("otpauth://")) {
      parsed = parseOtpauthLines(text);
    } else {
      throw new VaultError("无法识别的导入格式");
    }
  }

  if (parsed.entries.length > TOTP_MAX_ENTRIES) {
    throw new VaultError(`备份里有 ${parsed.entries.length} 条验证码，超过上限 ${TOTP_MAX_ENTRIES}`, 400);
  }

  const existing = await existingFingerprints(db);
  const items: ImportItem[] = [];
  const entries: ImportEntry[] = [];
  for (let index = 0; index < parsed.entries.length; index += 1) {
    const raw = parsed.entries[index]!;
    const base = {
      index,
      issuer: raw.issuer,
      account: raw.account,
      algorithm: raw.problem ? raw.algorithm : "SHA1",
      digits: raw.digits,
      period: raw.period,
    };
    if (raw.problem) {
      items.push({ ...base, algorithm: raw.algorithm, duplicate: false, supported: false, reason: raw.problem });
      continue;
    }
    try {
      const fields = await resolveFields(
        db,
        {
          issuer: raw.issuer,
          account: raw.account,
          secret: raw.secret,
          algorithm: raw.algorithm,
          digits: raw.digits,
          period: raw.period,
          icon: raw.icon,
          note: raw.note,
          ai_read: raw.aiRead,
        },
        null,
      );
      if (!fields.secret) throw new VaultError("缺少密钥");
      const duplicate = existing.has(await secretFingerprint(fields.secret));
      items.push({ ...base, algorithm: fields.algorithm, digits: fields.digits, period: fields.period, duplicate, supported: true });
      entries.push({
        index,
        issuer: fields.issuer,
        account: fields.account,
        secret: fields.secret,
        algorithm: fields.algorithm,
        digits: fields.digits,
        period: fields.period,
        icon: fields.icon,
        note: fields.note,
        group: raw.group,
        ai_read: fields.aiRead,
      });
    } catch (error) {
      const reason = error instanceof VaultError ? error.message : "条目无法解析";
      items.push({ ...base, duplicate: false, supported: false, reason });
    }
  }
  return { format: parsed.format, items, entries };
}

async function groupIdByName(db: D1Database, name: string | null): Promise<string | null> {
  if (!name) return null;
  const row = await prepare(db, "SELECT id FROM vault_groups WHERE name = ? LIMIT 1", [name]).first<{ id: string }>();
  return row?.id ?? null;
}

// confirm：逐条判重跳过（已有 secret_hash、校验不过、超出 500 条都记 skipped），
// 返回导入/跳过条数。失败原因不再逐条返回，面板用预览里的口径解释。
export async function confirmTotpImport(
  db: D1Database,
  env: Env,
  entries: unknown,
  now: number,
): Promise<{ imported: number; skipped: number }> {
  if (!Array.isArray(entries)) throw new VaultError("导入条目格式不正确");
  const existing = await existingFingerprints(db);
  let count = await countTotpEntries(db);
  let imported = 0;
  let skipped = 0;
  for (const item of entries) {
    if (!isRecord(item)) {
      skipped += 1;
      continue;
    }
    let fields: TotpFields;
    try {
      const groupName = stringOf(item["group"]);
      fields = await resolveFields(
        db,
        {
          issuer: item["issuer"],
          account: item["account"],
          secret: item["secret"],
          algorithm: item["algorithm"],
          digits: item["digits"],
          period: item["period"],
          icon: item["icon"],
          note: item["note"],
          group_id: await groupIdByName(db, groupName || null),
          ai_read: item["ai_read"],
        },
        null,
      );
      if (!fields.secret) throw new VaultError("缺少密钥");
    } catch {
      skipped += 1;
      continue;
    }
    const hash = await secretFingerprint(fields.secret);
    if (existing.has(hash) || count >= TOTP_MAX_ENTRIES) {
      skipped += 1;
      continue;
    }
    const row: VaultTotpRow = {
      id: newId("totp"),
      issuer: fields.issuer,
      account: fields.account,
      secret_enc: await sealSecret(env, fields.secret),
      secret_hash: hash,
      algorithm: fields.algorithm,
      digits: fields.digits,
      period: fields.period,
      icon: fields.icon,
      note: fields.note,
      group_id: fields.groupId ?? null,
      ai_read: fields.aiRead ? 1 : 0,
      created_at: now,
      updated_at: now,
    };
    await prepare(
      db,
      "INSERT INTO vault_totp (id, issuer, account, secret_enc, secret_hash, algorithm, digits, period, icon, note, group_id, ai_read, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        row.id,
        row.issuer,
        row.account,
        row.secret_enc,
        row.secret_hash,
        row.algorithm,
        row.digits,
        row.period,
        row.icon,
        row.note,
        row.group_id,
        row.ai_read,
        row.created_at,
        row.updated_at,
      ],
    ).run();
    existing.add(hash);
    count += 1;
    imported += 1;
  }
  return { imported, skipped };
}

// 判定的公共入口：`app:"hivemos"` / `kind:"totp-export"` 二选一即可，都对
// never 认成别的格式。
function rootLooksHivemos(root: JsonRecord): boolean {
  return root["app"] === "hivemos" || root["kind"] === "totp-export" || (root["encrypted"] === true && !!root["data"]);
}
