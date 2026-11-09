// Vault module (v1, panel-only): storage behind the vault board.
// Secrets are entry passwords, gateway keys, mailbox SMTP passwords, and
// TOTP entry secrets (the last ones live in vault-totp.ts, which reuses the
// sealing, group and id helpers exported here).
// They are stored AES-GCM sealed under the VAULT_KEY worker secret
// (envelope helpers live in crypto.ts, same format as the TOTP seal).
// Names, urls, usernames, notes and mailbox metadata (SMTP host, port,
// security and user) are plain text. List views never expose a secret:
// entries and gateways show only the last four characters (tail), emails
// show smtp_secret_set. Reading one goes through revealSecret, which
// writes a vault_access_log row first.
//
// There is still no MCP surface: agent access waits for the key-lease and
// vault-permission work, so vault_entries/gateways/emails stay panel-only.
// The TOTP table (migration 0033) already carries the shape that surface
// needs — ai_read per entry and an actor column on vault_access_log — and
// the panel paths leave actor NULL; stage 6 fills it in when agents are
// allowed to read codes.
//
// vault_access_log 只是审计事实源：读取记录的展示已归入系统日志（oplog
// 的「保险库」board，见 revealSecret 里的 logOp 与 src/oplog.ts）。本表不再
// 有自己的前端视图，也不再对外提供查询接口。

import { decryptString, resolveContentKey, sealString } from "./crypto";
import type { ContentKey } from "./crypto";
import { prepare } from "./registry";
import type { D1Database, Env } from "./env";
import { logOp } from "./oplog";

export class VaultError extends Error {
  status: number;
  // Optional machine-readable fields merged into the JSON error body
  // (e.g. the duplicate entry's id/issuer on a 409, or a key-state code
  // the vault page uses to explain a whole-page failure).
  detail: Record<string, unknown> | undefined;
  constructor(message: string, status = 400, detail?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export function rowsOf<T>(value: { results?: T[] } | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.results)) return value.results;
  return [];
}

export function newId(prefix: string): string {
  return prefix + "_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

export interface VaultEntryRow {
  id: string;
  name: string;
  url: string;
  username: string;
  password_enc: string;
  tail: string;
  note: string;
  group_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface GatewayRow {
  id: string;
  name: string;
  proto: string;
  base_url: string;
  models: string;
  key_enc: string;
  tail: string;
  status: string;
  group_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface VaultGroupRow {
  id: string;
  name: string;
  created_at: number;
  member_count: number;
}

export interface EmailRow {
  id: string;
  address: string;
  purpose: string;
  portal: string;
  note: string;
  smtp_host: string;
  smtp_port: number | null;
  smtp_security: string;
  smtp_user: string;
  smtp_secret: string | null;
  created_at: number;
  updated_at: number;
}

export const NAME_MAX = 60;
const URL_MAX = 300;
const USERNAME_MAX = 120;
const NOTE_MAX = 300;
const SECRET_MAX = 2000;
const PROTO_MAX = 128;
const MODELS_MAX = 60;
const ADDRESS_MAX = 120;
const PURPOSE_MAX = 40;
const PORTAL_MAX = 80;
const SMTP_HOST_MAX = 253;
const SMTP_USER_MAX = 120;
const SMTP_DEFAULT_PORT: Record<string, number> = { ssl: 465, starttls: 587, none: 25 };

export function optText(body: Record<string, unknown>, key: string, max: number, label: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new VaultError(label + "格式不正确");
  const trimmed = value.trim();
  if (trimmed.length > max) throw new VaultError(label + "太长了");
  return trimmed;
}

export function reqText(body: Record<string, unknown>, key: string, max: number, label: string): string {
  const value = optText(body, key, max, label);
  if (!value) throw new VaultError("请填写" + label);
  return value;
}

// ---- secret sealing -------------------------------------------------------

// JS callers (totp-http, vault-totp) check the key state before sealing or
// opening; the value of VAULT_KEY decides whether a save/reveal is possible.
export function vaultKey(env: Env): ContentKey {
  const raw = (env as unknown as Record<string, unknown>)["VAULT_KEY"];
  return resolveContentKey(typeof raw === "string" ? raw : undefined);
}

export async function sealSecret(env: Env, plaintext: string): Promise<string> {
  const key = vaultKey(env);
  if (key.state === "invalid") throw new VaultError("保险库密钥配置不正确，暂时不能保存值", 503);
  if (key.state !== "on") throw new VaultError("保险库密钥未配置，暂时不能保存值", 503);
  const sealed = await sealString(key, plaintext);
  if (sealed === null) throw new VaultError("保险库密钥未配置，暂时不能保存值", 503);
  return sealed;
}

// Exported so vault-totp.ts (codes, reveal, import) opens secrets through the
// exact same envelope and error language as entries/gateways/emails.
export async function openSecret(env: Env, stored: string): Promise<string> {
  if (!stored) return "";
  const key = vaultKey(env);
  if (key.state === "invalid") throw new VaultError("保险库密钥配置不正确，无法查看", 503);
  if (key.state !== "on") throw new VaultError("保险库密钥未配置，无法查看", 503);
  const plain = await decryptString(key.raw, stored);
  if (plain === null) throw new VaultError("解密失败，保险库密钥可能不正确", 500);
  return plain;
}

function tailOf(secret: string): string {
  return secret.slice(-4);
}

// ---- groups (one pool shared by entries, gateways and TOTP entries) --------

// TOTP rows live in the table added by migration 0033. Counting them here
// keeps the group page honest without making the whole list fail on a database
// where that migration has not been applied yet (local dev, older deploy):
// the count just stays at what entries+gateways report.
async function totpGroupCounts(db: D1Database): Promise<Map<string, number>> {
  try {
    const rows = rowsOf(
      await prepare(
        db,
        "SELECT group_id, COUNT(*) AS total FROM vault_totp WHERE group_id IS NOT NULL GROUP BY group_id",
      ).all<{ group_id: string; total: number }>(),
    );
    return new Map(rows.map((row) => [row.group_id, Number(row.total) || 0]));
  } catch {
    return new Map();
  }
}

export function groupPublic(row: VaultGroupRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    member_count: row.member_count,
  };
}

export async function getGroup(db: D1Database, id: string): Promise<VaultGroupRow | null> {
  const row = await prepare(
    db,
    "SELECT id, name, created_at, " +
      "(SELECT COUNT(*) FROM vault_entries WHERE group_id = vault_groups.id) + " +
      "(SELECT COUNT(*) FROM gateways WHERE group_id = vault_groups.id) AS member_count " +
      "FROM vault_groups WHERE id = ?",
    [id],
  ).first<VaultGroupRow>();
  if (row) row.member_count = Number(row.member_count || 0) + ((await totpGroupCounts(db)).get(row.id) ?? 0);
  return row;
}

export async function listGroups(db: D1Database): Promise<VaultGroupRow[]> {
  const rows = rowsOf(
    await prepare(
      db,
      "SELECT id, name, created_at, " +
        "(SELECT COUNT(*) FROM vault_entries WHERE group_id = vault_groups.id) + " +
        "(SELECT COUNT(*) FROM gateways WHERE group_id = vault_groups.id) AS member_count " +
        "FROM vault_groups ORDER BY created_at ASC, id ASC",
    ).all<VaultGroupRow>(),
  );
  const totpCounts = await totpGroupCounts(db);
  for (const row of rows) row.member_count = Number(row.member_count || 0) + (totpCounts.get(row.id) ?? 0);
  return rows;
}

export async function createGroup(db: D1Database, body: Record<string, unknown>, now: number): Promise<VaultGroupRow> {
  const row: VaultGroupRow = {
    id: newId("vg"),
    name: reqText(body, "name", NAME_MAX, "分组名"),
    created_at: now,
    member_count: 0,
  };
  await prepare(db, "INSERT INTO vault_groups (id, name, created_at) VALUES (?, ?, ?)", [row.id, row.name, row.created_at]).run();
  return row;
}

export async function updateGroup(db: D1Database, id: string, body: Record<string, unknown>): Promise<VaultGroupRow> {
  const row = await getGroup(db, id);
  if (!row) throw new VaultError("分组不存在", 404);
  const name = optText(body, "name", NAME_MAX, "分组名");
  if (name !== undefined) {
    if (!name) throw new VaultError("请填写分组名");
    row.name = name;
  }
  await prepare(db, "UPDATE vault_groups SET name = ? WHERE id = ?", [row.name, row.id]).run();
  return row;
}

export async function deleteGroup(db: D1Database, id: string): Promise<VaultGroupRow> {
  const row = await getGroup(db, id);
  if (!row) throw new VaultError("分组不存在", 404);
  await prepare(db, "UPDATE vault_entries SET group_id = NULL WHERE group_id = ?", [id]).run();
  await prepare(db, "UPDATE gateways SET group_id = NULL WHERE group_id = ?", [id]).run();
  // Same delete semantics as entries/gateways: TOTP rows fall back to
  // ungrouped, they are never deleted along with the group.
  try {
    await prepare(db, "UPDATE vault_totp SET group_id = NULL WHERE group_id = ?", [id]).run();
  } catch {
    // Migration 0033 not applied yet: nothing to ungroup.
  }
  await prepare(db, "DELETE FROM vault_groups WHERE id = ?", [id]).run();
  return row;
}

// Resolves an optional group reference for entries/gateways/TOTP entries.
// Absent means "leave unchanged" for updates; null or blank means ungrouped;
// a present id must exist in the vault pool.
export async function optGroupId(db: D1Database, body: Record<string, unknown>): Promise<string | null | undefined> {
  const value = body["group_id"];
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new VaultError("分组不正确");
  const group = await getGroup(db, value);
  if (!group) throw new VaultError("分组不存在");
  return value;
}

// ---- entries --------------------------------------------------------------

export function entryPublic(row: VaultEntryRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    username: row.username,
    tail: row.tail,
    note: row.note,
    group_id: row.group_id ?? null,
    has_password: row.password_enc !== "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getEntry(db: D1Database, id: string): Promise<VaultEntryRow | null> {
  return prepare(db, "SELECT * FROM vault_entries WHERE id = ?", [id]).first<VaultEntryRow>();
}

export async function listEntries(db: D1Database): Promise<VaultEntryRow[]> {
  return rowsOf(await prepare(db, "SELECT * FROM vault_entries ORDER BY updated_at DESC, id DESC").all<VaultEntryRow>());
}

export async function createEntry(db: D1Database, env: Env, body: Record<string, unknown>, now: number): Promise<VaultEntryRow> {
  const name = reqText(body, "name", NAME_MAX, "名称");
  const url = optText(body, "url", URL_MAX, "网址") ?? "";
  const username = optText(body, "username", USERNAME_MAX, "账号") ?? "";
  const note = optText(body, "note", NOTE_MAX, "备注") ?? "";
  const groupId = (await optGroupId(db, body)) ?? null;
  const password = body["password"];
  if (typeof password !== "string" || !password) throw new VaultError("请填写密码");
  if (password.length > SECRET_MAX) throw new VaultError("密码太长了");
  const row: VaultEntryRow = {
    id: newId("sec"),
    name,
    url,
    username,
    password_enc: await sealSecret(env, password),
    tail: tailOf(password),
    note,
    group_id: groupId,
    created_at: now,
    updated_at: now,
  };
  await prepare(
    db,
    "INSERT INTO vault_entries (id, name, url, username, password_enc, tail, note, group_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [row.id, row.name, row.url, row.username, row.password_enc, row.tail, row.note, row.group_id, row.created_at, row.updated_at],
  ).run();
  return row;
}

export async function updateEntry(db: D1Database, env: Env, id: string, body: Record<string, unknown>, now: number): Promise<VaultEntryRow> {
  const row = await getEntry(db, id);
  if (!row) throw new VaultError("条目不存在", 404);
  const name = optText(body, "name", NAME_MAX, "名称");
  if (name !== undefined) {
    if (!name) throw new VaultError("请填写名称");
    row.name = name;
  }
  const url = optText(body, "url", URL_MAX, "网址");
  if (url !== undefined) row.url = url;
  const username = optText(body, "username", USERNAME_MAX, "账号");
  if (username !== undefined) row.username = username;
  const note = optText(body, "note", NOTE_MAX, "备注");
  if (note !== undefined) row.note = note;
  const groupId = await optGroupId(db, body);
  if (groupId !== undefined) row.group_id = groupId;
  const password = body["password"];
  if (typeof password === "string" && password !== "") {
    if (password.length > SECRET_MAX) throw new VaultError("密码太长了");
    row.password_enc = await sealSecret(env, password);
    row.tail = tailOf(password);
  }
  row.updated_at = now;
  await prepare(
    db,
    "UPDATE vault_entries SET name = ?, url = ?, username = ?, password_enc = ?, tail = ?, note = ?, group_id = ?, updated_at = ? WHERE id = ?",
    [row.name, row.url, row.username, row.password_enc, row.tail, row.note, row.group_id, row.updated_at, row.id],
  ).run();
  return row;
}

export async function deleteEntry(db: D1Database, id: string): Promise<VaultEntryRow> {
  const row = await getEntry(db, id);
  if (!row) throw new VaultError("条目不存在", 404);
  await prepare(db, "DELETE FROM vault_entries WHERE id = ?", [id]).run();
  return row;
}

// ---- gateways -------------------------------------------------------------

export function gatewayPublic(row: GatewayRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    proto: row.proto,
    base_url: row.base_url,
    models: row.models,
    tail: row.tail,
    status: row.status,
    group_id: row.group_id ?? null,
    has_key: row.key_enc !== "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getGateway(db: D1Database, id: string): Promise<GatewayRow | null> {
  return prepare(db, "SELECT * FROM gateways WHERE id = ?", [id]).first<GatewayRow>();
}

export async function listGateways(db: D1Database): Promise<GatewayRow[]> {
  return rowsOf(await prepare(db, "SELECT * FROM gateways ORDER BY created_at ASC, id ASC").all<GatewayRow>());
}

function cleanStatus(value: unknown, fallback: string): string {
  return value === "active" || value === "paused" ? value : fallback;
}

export async function createGateway(db: D1Database, env: Env, body: Record<string, unknown>, now: number): Promise<GatewayRow> {
  const name = reqText(body, "name", NAME_MAX, "名称");
  const proto = optText(body, "proto", PROTO_MAX, "协议") ?? "";
  const baseUrl = optText(body, "base_url", URL_MAX, "地址") ?? "";
  const models = optText(body, "models", MODELS_MAX, "模型") ?? "";
  const groupId = (await optGroupId(db, body)) ?? null;
  const key = body["key"];
  if (typeof key !== "string" || !key) throw new VaultError("请填写密钥");
  if (key.length > SECRET_MAX) throw new VaultError("密钥太长了");
  const row: GatewayRow = {
    id: newId("gw"),
    name,
    proto,
    base_url: baseUrl,
    models,
    key_enc: await sealSecret(env, key),
    tail: tailOf(key),
    status: cleanStatus(body["status"], "paused"),
    group_id: groupId,
    created_at: now,
    updated_at: now,
  };
  await prepare(
    db,
    "INSERT INTO gateways (id, name, proto, base_url, models, key_enc, tail, status, group_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [row.id, row.name, row.proto, row.base_url, row.models, row.key_enc, row.tail, row.status, row.group_id, row.created_at, row.updated_at],
  ).run();
  return row;
}

export async function updateGateway(db: D1Database, env: Env, id: string, body: Record<string, unknown>, now: number): Promise<GatewayRow> {
  const row = await getGateway(db, id);
  if (!row) throw new VaultError("网关不存在", 404);
  const name = optText(body, "name", NAME_MAX, "名称");
  if (name !== undefined) {
    if (!name) throw new VaultError("请填写名称");
    row.name = name;
  }
  const proto = optText(body, "proto", PROTO_MAX, "协议");
  if (proto !== undefined) row.proto = proto;
  const baseUrl = optText(body, "base_url", URL_MAX, "地址");
  if (baseUrl !== undefined) row.base_url = baseUrl;
  const models = optText(body, "models", MODELS_MAX, "模型");
  if (models !== undefined) row.models = models;
  if (body["status"] !== undefined) row.status = cleanStatus(body["status"], row.status);
  const groupId = await optGroupId(db, body);
  if (groupId !== undefined) row.group_id = groupId;
  const key = body["key"];
  if (typeof key === "string" && key !== "") {
    if (key.length > SECRET_MAX) throw new VaultError("密钥太长了");
    row.key_enc = await sealSecret(env, key);
    row.tail = tailOf(key);
  }
  row.updated_at = now;
  await prepare(
    db,
    "UPDATE gateways SET name = ?, proto = ?, base_url = ?, models = ?, key_enc = ?, tail = ?, status = ?, group_id = ?, updated_at = ? WHERE id = ?",
    [row.name, row.proto, row.base_url, row.models, row.key_enc, row.tail, row.status, row.group_id, row.updated_at, row.id],
  ).run();
  return row;
}

export async function deleteGateway(db: D1Database, id: string): Promise<GatewayRow> {
  const row = await getGateway(db, id);
  if (!row) throw new VaultError("网关不存在", 404);
  await prepare(db, "DELETE FROM gateways WHERE id = ?", [id]).run();
  return row;
}

// ---- emails ---------------------------------------------------------------

export function emailPublic(row: EmailRow): Record<string, unknown> {
  return {
    id: row.id,
    address: row.address,
    purpose: row.purpose,
    portal: row.portal,
    note: row.note,
    smtp_host: row.smtp_host || "",
    smtp_port: row.smtp_port == null ? null : row.smtp_port,
    smtp_security: row.smtp_security || "",
    smtp_user: row.smtp_user || "",
    smtp_secret_set: !!row.smtp_secret,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getEmail(db: D1Database, id: string): Promise<EmailRow | null> {
  return prepare(db, "SELECT * FROM emails WHERE id = ?", [id]).first<EmailRow>();
}

export async function listEmails(db: D1Database): Promise<EmailRow[]> {
  return rowsOf(await prepare(db, "SELECT * FROM emails ORDER BY created_at ASC, id ASC").all<EmailRow>());
}

// SMTP is one optional group. No smtp keys on update leaves the stored group
// alone. An empty group (nothing filled) is "not configured" and is stored
// as blanks. Filling the host turns the group on: security must be one of
// ssl / starttls / none, an empty port falls back to 465 / 587 / 25, and an
// empty user falls back to the mailbox address. A non-empty smtp_secret is
// sealed; on edit an empty secret keeps the stored ciphertext.
function smtpKeysPresent(body: Record<string, unknown>): boolean {
  return (
    body["smtp_host"] !== undefined ||
    body["smtp_port"] !== undefined ||
    body["smtp_security"] !== undefined ||
    body["smtp_user"] !== undefined ||
    body["smtp_secret"] !== undefined
  );
}

function smtpValueFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

function smtpGroupFilled(body: Record<string, unknown>): boolean {
  return (
    smtpValueFilled(body["smtp_host"]) ||
    smtpValueFilled(body["smtp_port"]) ||
    smtpValueFilled(body["smtp_security"]) ||
    smtpValueFilled(body["smtp_user"]) ||
    smtpValueFilled(body["smtp_secret"])
  );
}

function smtpSecurityOf(value: unknown): string {
  if (value === undefined || value === null || value === "") throw new VaultError("请选择加密方式");
  if (typeof value !== "string") throw new VaultError("加密方式格式不正确");
  const security = value.trim().toLowerCase();
  if (!security) throw new VaultError("请选择加密方式");
  if (security !== "ssl" && security !== "starttls" && security !== "none") throw new VaultError("加密方式不正确");
  return security;
}

function smtpPortOf(value: unknown, security: string): number {
  if (value === undefined || value === null || value === "") {
    const fallback = SMTP_DEFAULT_PORT[security];
    if (!fallback) throw new VaultError("请选择加密方式");
    return fallback;
  }
  let port: number;
  if (typeof value === "number") {
    port = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      const fallback = SMTP_DEFAULT_PORT[security];
      if (!fallback) throw new VaultError("请选择加密方式");
      return fallback;
    }
    if (!/^[0-9]+$/.test(trimmed)) throw new VaultError("端口需为 1 到 65535 的整数");
    port = Number(trimmed);
  } else {
    throw new VaultError("端口格式不正确");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new VaultError("端口需为 1 到 65535 的整数");
  return port;
}

interface SmtpWrite {
  host: string;
  port: number | null;
  security: string;
  user: string;
  secretEnc: string | null;
}

async function resolveSmtp(env: Env, body: Record<string, unknown>, address: string, existing: EmailRow | null): Promise<SmtpWrite | null> {
  if (!smtpKeysPresent(body)) return existing ? null : { host: "", port: null, security: "", user: "", secretEnc: null };
  if (!smtpGroupFilled(body)) return { host: "", port: null, security: "", user: "", secretEnc: null };
  const host = optText(body, "smtp_host", SMTP_HOST_MAX, "SMTP 服务器") ?? "";
  if (!host) throw new VaultError("请填写 SMTP 服务器");
  const security = smtpSecurityOf(body["smtp_security"]);
  const port = smtpPortOf(body["smtp_port"], security);
  const userText = optText(body, "smtp_user", SMTP_USER_MAX, "SMTP 用户名");
  const user = userText ? userText : address;
  let secretEnc = existing ? existing.smtp_secret : null;
  const secret = body["smtp_secret"];
  if (secret !== undefined && secret !== null) {
    if (typeof secret !== "string") throw new VaultError("SMTP 密码格式不正确");
    if (secret !== "") {
      if (secret.length > SECRET_MAX) throw new VaultError("SMTP 密码太长了");
      secretEnc = await sealSecret(env, secret);
    }
  }
  return { host, port, security, user, secretEnc };
}

function applySmtp(row: EmailRow, smtp: SmtpWrite): void {
  row.smtp_host = smtp.host;
  row.smtp_port = smtp.port;
  row.smtp_security = smtp.security;
  row.smtp_user = smtp.user;
  row.smtp_secret = smtp.secretEnc;
}

export async function createEmail(db: D1Database, env: Env, body: Record<string, unknown>, now: number): Promise<EmailRow> {
  const address = reqText(body, "address", ADDRESS_MAX, "邮箱地址");
  const purpose = optText(body, "purpose", PURPOSE_MAX, "用途") ?? "";
  const portal = optText(body, "portal", PORTAL_MAX, "入口") ?? "";
  const note = optText(body, "note", NOTE_MAX, "备注") ?? "";
  const smtp = await resolveSmtp(env, body, address, null);
  const row: EmailRow = {
    id: newId("em"),
    address,
    purpose,
    portal,
    note,
    smtp_host: "",
    smtp_port: null,
    smtp_security: "",
    smtp_user: "",
    smtp_secret: null,
    created_at: now,
    updated_at: now,
  };
  if (smtp) applySmtp(row, smtp);
  await prepare(
    db,
    "INSERT INTO emails (id, address, purpose, portal, note, smtp_host, smtp_port, smtp_security, smtp_user, smtp_secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      row.id,
      row.address,
      row.purpose,
      row.portal,
      row.note,
      row.smtp_host,
      row.smtp_port,
      row.smtp_security,
      row.smtp_user,
      row.smtp_secret,
      row.created_at,
      row.updated_at,
    ],
  ).run();
  return row;
}

export async function updateEmail(db: D1Database, env: Env, id: string, body: Record<string, unknown>, now: number): Promise<EmailRow> {
  const row = await getEmail(db, id);
  if (!row) throw new VaultError("邮箱不存在", 404);
  const address = optText(body, "address", ADDRESS_MAX, "邮箱地址");
  if (address !== undefined) {
    if (!address) throw new VaultError("请填写邮箱地址");
    row.address = address;
  }
  const purpose = optText(body, "purpose", PURPOSE_MAX, "用途");
  if (purpose !== undefined) row.purpose = purpose;
  const portal = optText(body, "portal", PORTAL_MAX, "入口");
  if (portal !== undefined) row.portal = portal;
  const note = optText(body, "note", NOTE_MAX, "备注");
  if (note !== undefined) row.note = note;
  const smtp = await resolveSmtp(env, body, row.address, row);
  if (smtp) applySmtp(row, smtp);
  row.updated_at = now;
  await prepare(
    db,
    "UPDATE emails SET address = ?, purpose = ?, portal = ?, note = ?, smtp_host = ?, smtp_port = ?, smtp_security = ?, smtp_user = ?, smtp_secret = ?, updated_at = ? WHERE id = ?",
    [
      row.address,
      row.purpose,
      row.portal,
      row.note,
      row.smtp_host,
      row.smtp_port,
      row.smtp_security,
      row.smtp_user,
      row.smtp_secret,
      row.updated_at,
      row.id,
    ],
  ).run();
  return row;
}

export async function deleteEmail(db: D1Database, id: string): Promise<EmailRow> {
  const row = await getEmail(db, id);
  if (!row) throw new VaultError("邮箱不存在", 404);
  await prepare(db, "DELETE FROM emails WHERE id = ?", [id]).run();
  return row;
}

// ---- reveal + access log ----------------------------------------------------

// 一次读取的归属口径：审计事实源（vault_access_log）与展示面（oplog）用
// 同一份信息，两者分开写。
export interface RevealActor {
  // 面板请求的管理员名（panelActor 的口径），只用于 oplog。
  panel: string;
  // vault_access_log.actor：面板路径为 null；阶段 6 的 MCP/Agent 调用填
  // Agent 名。非空时同一个名字也进 oplog 的 actor 与文案。
  agent: string | null;
}

const REVEAL_LABELS = {
  entry: "查看条目密码",
  gateway: "查看网关密钥",
  email: "查看邮箱 SMTP 密码",
  totp: "查看验证码密钥",
} as const;

function revealLogText(kind: keyof typeof REVEAL_LABELS, name: string, agent: string | null): string {
  const base = `${REVEAL_LABELS[kind]} · ${name}`;
  return agent ? `${base}（Agent ${agent}）` : base;
}

export async function revealSecret(
  db: D1Database,
  env: Env,
  body: Record<string, unknown>,
  now: number,
  actor: RevealActor = { panel: "管理员", agent: null },
): Promise<{ kind: string; id: string; name: string; value: string }> {
  const kind = body["kind"];
  const id = body["id"];
  if (kind !== "entry" && kind !== "gateway" && kind !== "email" && kind !== "totp") throw new VaultError("类型不正确");
  if (typeof id !== "string" || !id) throw new VaultError("缺少 id");
  let name = "";
  let stored = "";
  if (kind === "entry") {
    const row = await getEntry(db, id);
    if (!row) throw new VaultError("条目不存在", 404);
    name = row.name;
    stored = row.password_enc;
  } else if (kind === "gateway") {
    const row = await getGateway(db, id);
    if (!row) throw new VaultError("网关不存在", 404);
    name = row.name;
    stored = row.key_enc;
  } else if (kind === "totp") {
    // The vault TOTP secret leaves as the canonical base32 string it was
    // saved in. Name mirrors the panel label (issuer, plus account if set).
    const row = await prepare(db, "SELECT id, issuer, account, secret_enc FROM vault_totp WHERE id = ?", [id]).first<{
      id: string;
      issuer: string;
      account: string;
      secret_enc: string;
    }>();
    if (!row) throw new VaultError("验证码条目不存在", 404);
    name = row.account ? `${row.issuer}（${row.account}）` : row.issuer;
    stored = row.secret_enc;
  } else {
    const row = await getEmail(db, id);
    if (!row) throw new VaultError("邮箱不存在", 404);
    name = row.address;
    stored = row.smtp_secret || "";
  }
  // Audit before plaintext is produced. A failed insert fails the reveal,
  // so the secret never leaves this function without a vault_access_log row.
  // actor stays NULL for panel reads; stage 6 (MCP) passes the agent name.
  // 空串/空白当作「没有 Agent」，与审计表「actor 非空才算 Agent」一致。
  const agentName = actor.agent?.trim() || null;
  await prepare(
    db,
    "INSERT INTO vault_access_log (id, target_kind, target_id, action, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [newId("va"), kind, id, "reveal", agentName, now],
  ).run();
  // 顺序与失败语义：审计门在上，写不进就不返回明文；oplog 写在门之后，
  // 只是统一展示面（系统日志的「保险库」board），logOp 自己吞掉失败，
  // 写不进也不阻断本次 reveal。审计事实源始终是 vault_access_log。
  // 目标名直接复用上面查到的行，不再为日志多查一次库。
  await logOp(db, {
    actor: agentName ?? actor.panel,
    module: "保险库",
    action: "查看",
    targetId: id,
    targetName: name,
    text: revealLogText(kind, name, agentName),
  });
  const value = await openSecret(env, stored);
  return { kind, id, name, value };
}
