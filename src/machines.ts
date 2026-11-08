// Machines board core: one table backs the three panel tabs (服务器 /
// 云主机 / Workers). Panel REST lives in machines-http.ts; the MCP tools in
// mcp.ts call the same functions so validation and audit cannot drift.
// status and last_heartbeat_at are runtime fields: the panel forms never
// write them; only machines_report (an agent reporting itself) does.
//
// Phase 2 access (Roye 2026-11-08): the three kinds connect differently.
// Servers store their SSH info directly — the password or key is sealed with
// AES-GCM under VAULT_KEY (same enc1: envelope as the vault) and only leaves
// through the panel reveal or the MCP machines_get_access tool, both of
// which write a machines_audit row first. Cloud hosts differ per vendor, so
// for now they only record vendor + access note; vendor APIs land later.
// Worker entries hold a Cloudflare account id + API token (sealed) so the
// panel can list that account's Workers live. ssh_user is stored but never
// shown on cards and never part of the public projection — it only appears
// in the edit form and in machines_get_access results.

import { prepare } from "./registry";
import type { D1Database } from "./env";
import { decryptString, resolveContentKey, sealString, type ContentKey } from "./crypto";

export class MachineError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const MACHINE_KINDS = ["server", "cloud", "worker"];

export interface MachineRow {
  id: string;
  kind: string;
  name: string;
  region: string;
  spec: string;
  description: string;
  version: string;
  status: string;
  binding: string;
  last_heartbeat_at: number | null;
  note: string;
  hostname: string;
  os: string;
  ip: string;
  ssh_host: string;
  ssh_port: number;
  ssh_user: string;
  ssh_secret_enc: string;
  ssh_tail: string;
  vendor: string;
  access_note: string;
  cf_account_id: string;
  api_token_enc: string;
  api_token_tail: string;
  ai_summary: string | null;
  ai_tags: string | null;
  created_at: number;
  updated_at: number;
}

export interface PublicMachine {
  id: string;
  kind: string;
  name: string;
  region: string;
  spec: string;
  description: string;
  version: string;
  status: string;
  binding: string;
  last_heartbeat_at: number | null;
  note: string;
  hostname: string;
  os: string;
  ip: string;
  ssh_host: string;
  ssh_port: number;
  ssh_tail: string;
  vendor: string;
  access_note: string;
  cf_account_id: string;
  api_token_tail: string;
  created_at: number;
  updated_at: number;
}

const COLUMNS =
  "id, kind, name, region, spec, description, version, status, binding, last_heartbeat_at, note, hostname, os, ip, ssh_host, ssh_port, ssh_user, ssh_secret_enc, ssh_tail, vendor, access_note, cf_account_id, api_token_enc, api_token_tail, ai_summary, ai_tags, created_at, updated_at";

const ID_PREFIX: Record<string, string> = { server: "sv_", cloud: "pc_", worker: "wk_" };

function rowsOf<T>(value: { results?: T[] } | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.results)) return value.results;
  return [];
}

export function machinePublic(row: MachineRow): PublicMachine {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    region: row.region,
    spec: row.spec,
    description: row.description,
    version: row.version,
    status: row.status,
    binding: row.binding,
    last_heartbeat_at: row.last_heartbeat_at,
    note: row.note,
    hostname: row.hostname,
    os: row.os,
    ip: row.ip,
    ssh_host: row.ssh_host,
    ssh_port: row.ssh_port,
    ssh_tail: row.ssh_tail,
    vendor: row.vendor,
    access_note: row.access_note,
    cf_account_id: row.cf_account_id,
    api_token_tail: row.api_token_tail,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listMachines(db: D1Database, kind: string | null): Promise<MachineRow[]> {
  const result = kind
    ? await prepare(db, "SELECT " + COLUMNS + " FROM machines WHERE kind = ? ORDER BY created_at ASC, rowid ASC", [kind]).all<MachineRow>()
    : await prepare(db, "SELECT " + COLUMNS + " FROM machines ORDER BY created_at ASC, rowid ASC").all<MachineRow>();
  return rowsOf<MachineRow>(result as { results?: MachineRow[] } | MachineRow[]);
}

export async function getMachine(db: D1Database, id: string): Promise<MachineRow | null> {
  return prepare(db, "SELECT " + COLUMNS + " FROM machines WHERE id = ?", [id]).first<MachineRow>();
}

export async function getMachineByName(db: D1Database, name: string): Promise<MachineRow | null> {
  return prepare(db, "SELECT " + COLUMNS + " FROM machines WHERE name = ? ORDER BY created_at ASC, rowid ASC LIMIT 1", [name]).first<MachineRow>();
}

async function writeAudit(
  db: D1Database,
  fields: { machineId: string | null; actor: string; source: string; action: string; detail?: unknown },
  now: number,
): Promise<void> {
  await prepare(db, "INSERT INTO machines_audit (id, machine_id, actor, source, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    crypto.randomUUID(),
    fields.machineId,
    fields.actor,
    fields.source,
    fields.action,
    fields.detail == null ? null : JSON.stringify(fields.detail),
    now,
  ]).run();
}

// ---------------------------------------------------------------------------
// Secret sealing. Same shape as the vault: the key comes from the VAULT_KEY
// worker secret; writing a secret without a usable key is a clear 503, and
// everything else keeps working.

export function vaultKeyOf(env: unknown): ContentKey {
  const raw = (env as Record<string, unknown> | null | undefined)?.["VAULT_KEY"];
  return resolveContentKey(typeof raw === "string" ? raw : undefined);
}

async function sealMachineSecret(key: ContentKey, plaintext: string): Promise<string> {
  if (key.state === "invalid") throw new MachineError(503, "保险库密钥配置不正确，暂时不能保存机密");
  if (key.state !== "on") throw new MachineError(503, "保险库密钥未配置，暂时不能保存机密");
  const sealed = await sealString(key, plaintext);
  if (sealed === null) throw new MachineError(503, "保险库密钥未配置，暂时不能保存机密");
  return sealed;
}

async function openMachineSecret(key: ContentKey, stored: string): Promise<string> {
  if (!stored) return "";
  if (key.state === "invalid") throw new MachineError(503, "保险库密钥配置不正确，无法查看");
  if (key.state !== "on") throw new MachineError(503, "保险库密钥未配置，无法查看");
  const plain = await decryptString(key.raw, stored);
  if (plain === null) throw new MachineError(500, "解密失败，保险库密钥可能不正确");
  return plain;
}

function tailOf(secret: string): string {
  return secret.slice(-4);
}

// ---------------------------------------------------------------------------
// Input reading. Panel and MCP share these so the same payload is judged the
// same way on both surfaces.

function readKind(value: unknown): string {
  if (typeof value !== "string" || !MACHINE_KINDS.includes(value)) {
    throw new MachineError(400, "类型不正确");
  }
  return value;
}

function readName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new MachineError(400, "请填写名称");
  const name = value.trim();
  if (name.length > 60) throw new MachineError(400, "名称太长");
  return name;
}

// Present-but-wrong-typed optional text is a 400; absent returns undefined so
// update can tell "leave it alone" apart from "set it empty".
function readOptionalText(input: Record<string, unknown>, key: string, max: number, label: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(input, key)) return undefined;
  const value = input[key];
  if (value == null) return "";
  if (typeof value !== "string") throw new MachineError(400, label + "格式不正确");
  const text = value.trim();
  if (text.length > max) throw new MachineError(400, label + "太长");
  return text;
}

function readOptionalId(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (value == null) return "";
  if (typeof value !== "string") throw new MachineError(400, "参数不正确");
  return value.trim();
}

// SSH port: numbers and digit strings are fine; absent stays undefined so
// update can leave the stored value alone.
function readOptionalPort(input: Record<string, unknown>): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(input, "ssh_port")) return undefined;
  const value = input["ssh_port"];
  if (value == null) return 22;
  let port: number;
  if (typeof value === "number") port = value;
  else if (typeof value === "string" && /^\d+$/.test(value.trim())) port = Number(value.trim());
  else throw new MachineError(400, "SSH 端口格式不正确");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MachineError(400, "SSH 端口格式不正确");
  return port;
}

// Secrets are never trimmed (a key file is what it is) and never echoed back.
// Absent returns undefined; present-but-empty returns "" and means "no secret
// given" — create stores nothing, update keeps the stored one.
function readSecretInput(input: Record<string, unknown>, key: string, label: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(input, key)) return undefined;
  const value = input[key];
  if (value == null) return "";
  if (typeof value !== "string") throw new MachineError(400, label + "格式不正确");
  if (value.length > 16384) throw new MachineError(400, label + "太长");
  return value;
}

// ---------------------------------------------------------------------------

export async function createMachine(
  db: D1Database,
  input: Record<string, unknown>,
  actor: string,
  source: string,
  now: number,
  key: ContentKey,
): Promise<MachineRow> {
  const kind = readKind(input.kind);
  const name = readName(input.name);
  const region = readOptionalText(input, "region", 30, "地域") ?? "";
  const spec = readOptionalText(input, "spec", 60, "配置") ?? "";
  const description = readOptionalText(input, "description", 120, "说明") ?? "";
  const bindingInput = readOptionalText(input, "binding", 60, "绑定");
  const binding = bindingInput !== undefined && bindingInput !== "" ? bindingInput : kind === "worker" ? "" : "未绑定";
  const note = kind === "worker" ? "" : readOptionalText(input, "note", 200, "备注") ?? "";
  let hostname = "";
  let os = "";
  let ip = "";
  let sshHost = "";
  let sshPort = 22;
  let sshUser = "";
  let sshSecretEnc = "";
  let sshTail = "";
  let vendor = "";
  let accessNote = "";
  let cfAccountId = "";
  let apiTokenEnc = "";
  let apiTokenTail = "";
  if (kind === "server") {
    hostname = readOptionalText(input, "hostname", 60, "主机名") ?? "";
    os = readOptionalText(input, "os", 60, "系统") ?? "";
    ip = readOptionalText(input, "ip", 64, "主机 IP") ?? "";
    sshHost = readOptionalText(input, "ssh_host", 120, "SSH 地址") ?? "";
    sshPort = readOptionalPort(input) ?? 22;
    sshUser = readOptionalText(input, "ssh_user", 60, "SSH 用户名") ?? "";
    const secret = readSecretInput(input, "ssh_secret", "SSH 密码或私钥");
    if (secret) {
      sshSecretEnc = await sealMachineSecret(key, secret);
      sshTail = tailOf(secret);
    }
  } else if (kind === "cloud") {
    vendor = readOptionalText(input, "vendor", 60, "厂商") ?? "";
    accessNote = readOptionalText(input, "access_note", 200, "接入方式备注") ?? "";
  } else {
    cfAccountId = readOptionalText(input, "cf_account_id", 64, "Cloudflare 账号 ID") ?? "";
    const token = readSecretInput(input, "api_token", "API 令牌");
    if (token) {
      apiTokenEnc = await sealMachineSecret(key, token);
      apiTokenTail = tailOf(token);
    }
  }
  const id = (ID_PREFIX[kind] ?? "mc_") + crypto.randomUUID().replace(/-/g, "");
  const status = kind === "worker" ? "active" : "running";
  await prepare(
    db,
    "INSERT INTO machines (id, kind, name, region, spec, description, version, status, binding, last_heartbeat_at, note, hostname, os, ip, ssh_host, ssh_port, ssh_user, ssh_secret_enc, ssh_tail, vendor, access_note, cf_account_id, api_token_enc, api_token_tail, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, kind, name, region, spec, description, status, binding, note, hostname, os, ip, sshHost, sshPort, sshUser, sshSecretEnc, sshTail, vendor, accessNote, cfAccountId, apiTokenEnc, apiTokenTail, now, now],
  ).run();
  await writeAudit(db, { machineId: id, actor, source, action: "create", detail: { kind, name } }, now);
  const row = await getMachine(db, id);
  if (!row) throw new MachineError(500, "创建后读取失败");
  return row;
}

export async function updateMachine(
  db: D1Database,
  id: string,
  input: Record<string, unknown>,
  actor: string,
  source: string,
  now: number,
  key: ContentKey,
): Promise<MachineRow> {
  const row = await getMachine(db, id);
  if (!row) throw new MachineError(404, "机器不存在");
  const next: MachineRow = { ...row };
  const changed: string[] = [];
  if (Object.prototype.hasOwnProperty.call(input, "name")) {
    next.name = readName(input.name);
    changed.push("name");
  }
  const region = readOptionalText(input, "region", 30, "地域");
  if (region !== undefined) {
    next.region = region;
    changed.push("region");
  }
  const spec = readOptionalText(input, "spec", 60, "配置");
  if (spec !== undefined) {
    next.spec = spec;
    changed.push("spec");
  }
  const description = readOptionalText(input, "description", 120, "说明");
  if (description !== undefined) {
    next.description = description;
    changed.push("description");
  }
  const binding = readOptionalText(input, "binding", 60, "绑定");
  if (binding !== undefined) {
    next.binding = binding;
    changed.push("binding");
  }
  if (row.kind === "server" || row.kind === "cloud") {
    const note = readOptionalText(input, "note", 200, "备注");
    if (note !== undefined) {
      next.note = note;
      changed.push("note");
    }
  }
  if (row.kind === "server") {
    const hostname = readOptionalText(input, "hostname", 60, "主机名");
    if (hostname !== undefined) {
      next.hostname = hostname;
      changed.push("hostname");
    }
    const os = readOptionalText(input, "os", 60, "系统");
    if (os !== undefined) {
      next.os = os;
      changed.push("os");
    }
    const ip = readOptionalText(input, "ip", 64, "主机 IP");
    if (ip !== undefined) {
      next.ip = ip;
      changed.push("ip");
    }
    const sshHost = readOptionalText(input, "ssh_host", 120, "SSH 地址");
    if (sshHost !== undefined) {
      next.ssh_host = sshHost;
      changed.push("ssh_host");
    }
    const sshPort = readOptionalPort(input);
    if (sshPort !== undefined) {
      next.ssh_port = sshPort;
      changed.push("ssh_port");
    }
    // ssh_user is credential-adjacent like the secret: on update an absent
    // or empty value means "keep the stored one" (it can be replaced, not
    // cleared), because the panel never receives it back to prefill.
    const sshUser = readOptionalText(input, "ssh_user", 60, "SSH 用户名");
    if (sshUser) {
      next.ssh_user = sshUser;
      changed.push("ssh_user");
    }
    const secret = readSecretInput(input, "ssh_secret", "SSH 密码或私钥");
    if (secret) {
      next.ssh_secret_enc = await sealMachineSecret(key, secret);
      next.ssh_tail = tailOf(secret);
      changed.push("ssh_secret");
    }
  } else if (row.kind === "cloud") {
    const vendor = readOptionalText(input, "vendor", 60, "厂商");
    if (vendor !== undefined) {
      next.vendor = vendor;
      changed.push("vendor");
    }
    const accessNote = readOptionalText(input, "access_note", 200, "接入方式备注");
    if (accessNote !== undefined) {
      next.access_note = accessNote;
      changed.push("access_note");
    }
  } else {
    const cfAccountId = readOptionalText(input, "cf_account_id", 64, "Cloudflare 账号 ID");
    if (cfAccountId !== undefined) {
      next.cf_account_id = cfAccountId;
      changed.push("cf_account_id");
    }
    const token = readSecretInput(input, "api_token", "API 令牌");
    if (token) {
      next.api_token_enc = await sealMachineSecret(key, token);
      next.api_token_tail = tailOf(token);
      changed.push("api_token");
    }
  }
  // status / last_heartbeat_at in the payload are ignored on purpose: they
  // are runtime fields owned by machines_report.
  await prepare(
    db,
    "UPDATE machines SET name = ?, region = ?, spec = ?, description = ?, binding = ?, note = ?, hostname = ?, os = ?, ip = ?, ssh_host = ?, ssh_port = ?, ssh_user = ?, ssh_secret_enc = ?, ssh_tail = ?, vendor = ?, access_note = ?, cf_account_id = ?, api_token_enc = ?, api_token_tail = ?, updated_at = ? WHERE id = ?",
    [
      next.name,
      next.region,
      next.spec,
      next.description,
      next.binding,
      next.note,
      next.hostname,
      next.os,
      next.ip,
      next.ssh_host,
      next.ssh_port,
      next.ssh_user,
      next.ssh_secret_enc,
      next.ssh_tail,
      next.vendor,
      next.access_note,
      next.cf_account_id,
      next.api_token_enc,
      next.api_token_tail,
      now,
      id,
    ],
  ).run();
  await writeAudit(db, { machineId: id, actor, source, action: "update", detail: { fields: changed } }, now);
  const fresh = await getMachine(db, id);
  if (!fresh) throw new MachineError(500, "保存后读取失败");
  return fresh;
}

export async function deleteMachine(
  db: D1Database,
  id: string,
  actor: string,
  source: string,
  now: number,
): Promise<void> {
  const row = await getMachine(db, id);
  if (!row) throw new MachineError(404, "机器不存在");
  await prepare(db, "DELETE FROM machines WHERE id = ?", [id]).run();
  await writeAudit(db, { machineId: id, actor, source, action: "delete", detail: { kind: row.kind, name: row.name } }, now);
}

// Panel reveal: the stored secret comes back in plaintext, and the access is
// audited like the vault's. Cloud hosts hold no secret.
export async function revealMachineSecret(
  db: D1Database,
  id: string,
  key: ContentKey,
  actor: string,
  now: number,
): Promise<{ kind: string; secret: string; ssh_user: string }> {
  const row = await getMachine(db, id);
  if (!row) throw new MachineError(404, "机器不存在");
  if (row.kind === "cloud") throw new MachineError(400, "云主机没有保存机密");
  const stored = row.kind === "server" ? row.ssh_secret_enc : row.api_token_enc;
  const secret = await openMachineSecret(key, stored);
  await writeAudit(db, { machineId: id, actor, source: "panel", action: "reveal", detail: { kind: row.kind } }, now);
  // ssh_user rides along here (and only here / the edit form / get_access):
  // it stays out of cards and out of the public projection on purpose.
  return { kind: row.kind, secret, ssh_user: row.kind === "server" ? row.ssh_user : "" };
}

// Panel action on a Worker entry: use the stored token to list the Workers
// under that Cloudflare account, live. The token itself never leaves.
export interface WorkerScript {
  name: string;
  modified_on: string | null;
}

export async function fetchWorkersForMachine(
  db: D1Database,
  id: string,
  key: ContentKey,
  actor: string,
  now: number,
): Promise<{ workers: WorkerScript[]; fetched_at: number }> {
  const row = await getMachine(db, id);
  if (!row) throw new MachineError(404, "机器不存在");
  if (row.kind !== "worker") throw new MachineError(400, "只有 Workers 条目可以查看名下 Workers");
  if (!row.cf_account_id) throw new MachineError(400, "先填写 Cloudflare 账号 ID");
  if (!row.api_token_enc) throw new MachineError(400, "先补上 API 令牌");
  const token = await openMachineSecret(key, row.api_token_enc);
  let response: Response;
  try {
    response = await fetch("https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(row.cf_account_id) + "/workers/scripts", {
      headers: { authorization: "Bearer " + token, accept: "application/json" },
    });
  } catch {
    throw new MachineError(502, "连接 Cloudflare 失败，请稍后重试");
  }
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    errors?: Array<{ code?: number; message?: string }>;
    result?: Array<{ id?: string; modified_on?: string }>;
  } | null;
  if (!response.ok || !body || body.success !== true || !Array.isArray(body.result)) {
    const first = body?.errors?.[0];
    throw new MachineError(502, first?.message ? "Cloudflare：" + first.message : "Cloudflare 返回了无法识别的响应");
  }
  const workers: WorkerScript[] = body.result
    .map((script) => ({ name: String(script.id ?? ""), modified_on: script.modified_on ?? null }))
    .filter((script) => script.name !== "");
  await writeAudit(db, { machineId: id, actor, source: "panel", action: "workers_list", detail: { count: workers.length } }, now);
  return { workers, fetched_at: now };
}

// MCP read path: mirrors fetchConfigForAgent — the audit row lands before
// the payload is handed back.
export async function getMachineForAgent(
  db: D1Database,
  machineId: string,
  name: string,
  agentId: string,
  now: number,
): Promise<MachineRow | null> {
  let row: MachineRow | null = null;
  if (machineId) row = await getMachine(db, machineId);
  if (!row && name) row = await getMachineByName(db, name);
  if (!row) return null;
  await writeAudit(db, { machineId: row.id, actor: agentId, source: "mcp", action: "get" }, now);
  return row;
}

// MCP access path (machines_get_access): the credentials themselves, for an
// agent that will actually use them. The access_fetch audit row lands before
// anything is decrypted, same discipline as mcp_get; list/get stay free of
// secrets so "seeing" and "using" remain separate, audited very differently.
export async function getMachineAccessForAgent(
  db: D1Database,
  machineId: string,
  name: string,
  agentId: string,
  key: ContentKey,
  now: number,
): Promise<Record<string, unknown> | null> {
  let row: MachineRow | null = null;
  if (machineId) row = await getMachine(db, machineId);
  if (!row && name) row = await getMachineByName(db, name);
  if (!row) return null;
  await writeAudit(db, { machineId: row.id, actor: agentId, source: "mcp", action: "access_fetch", detail: { kind: row.kind } }, now);
  const base = { machine_id: row.id, kind: row.kind, name: row.name };
  if (row.kind === "server") {
    if (!row.ssh_secret_enc) throw new MachineError(400, "这台服务器还没有保存 SSH 密码或私钥");
    const secret = await openMachineSecret(key, row.ssh_secret_enc);
    return { ...base, ssh: { host: row.ssh_host || row.ip, port: row.ssh_port, user: row.ssh_user, secret } };
  }
  if (row.kind === "worker") {
    if (!row.api_token_enc) throw new MachineError(400, "这个 Workers 接入还没有保存 API 令牌");
    const token = await openMachineSecret(key, row.api_token_enc);
    return { ...base, cloudflare: { account_id: row.cf_account_id, api_token: token } };
  }
  return { ...base, vendor: row.vendor, access_note: row.access_note };
}

// An agent reports itself: heartbeat always lands at now; status only moves
// when the caller sends one.
export async function reportMachine(
  db: D1Database,
  input: Record<string, unknown>,
  agentId: string,
  now: number,
): Promise<MachineRow> {
  const machineId = readOptionalId(input, "machine_id");
  const name = readOptionalId(input, "name");
  if (!machineId && !name) throw new MachineError(400, "请提供 machine_id 或 name");
  let row: MachineRow | null = null;
  if (machineId) row = await getMachine(db, machineId);
  if (!row && name) row = await getMachineByName(db, name);
  if (!row) throw new MachineError(404, "机器不存在");
  let status = row.status;
  if (Object.prototype.hasOwnProperty.call(input, "status")) {
    const value = input.status;
    if (typeof value !== "string" || !value.trim() || value.trim().length > 30) {
      throw new MachineError(400, "状态格式不正确");
    }
    status = value.trim();
  }
  await prepare(db, "UPDATE machines SET status = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ?", [
    status,
    now,
    now,
    row.id,
  ]).run();
  await writeAudit(db, { machineId: row.id, actor: agentId, source: "mcp", action: "report", detail: { status } }, now);
  const fresh = await getMachine(db, row.id);
  if (!fresh) throw new MachineError(500, "上报后读取失败");
  return fresh;
}
