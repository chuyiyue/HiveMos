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

import { sha256Hex } from "./auth";
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
