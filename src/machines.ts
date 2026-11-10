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

import { getGroup, prepare } from "./registry";
import type { D1Database } from "./env";
import { decryptString, resolveContentKey, sealString, type ContentKey } from "./crypto";
import { sshProbe, SshProbeError } from "./ssh-probe";

export class MachineError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const MACHINE_KINDS = ["server", "cloud", "worker"];

// 类型的人类可读名，与 machines-http 的面板 logOp 同一份值（server 服务器 /
// cloud 云主机 / worker Worker），MCP 工具的 logOp 直接复用同一口径。
export const MACHINE_KIND_LABELS: Record<string, string> = { server: "服务器", cloud: "云主机", worker: "Worker" };

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
  auth_type: string;
  ssh_secret_enc: string;
  ssh_tail: string;
  vendor: string;
  access_note: string;
  cf_account_id: string;
  platform: string;
  team_id: string;
  api_token_enc: string;
  api_token_tail: string;
  kernel: string;
  arch: string;
  probe_status: string;
  probe_at: number | null;
  probe_error: string;
  host_fingerprint: string;
  connection_id: string;
  remote_id: string;
  remote_name: string;
  remote_state: string | null;
  last_sync_at: number | null;
  group_id: string | null;
  icon: string | null;
  icon_manual: number;
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
  auth_type: string;
  ssh_tail: string;
  kernel: string;
  arch: string;
  probe_status: string;
  probe_at: number | null;
  probe_error: string;
  host_fingerprint: string;
  vendor: string;
  access_note: string;
  cf_account_id: string;
  platform: string;
  team_id: string;
  api_token_tail: string;
  connection_id: string;
  remote_id: string;
  remote_name: string;
  remote_state: string | null;
  last_sync_at: number | null;
  group_id: string | null;
  icon: string | null;
  icon_manual: boolean;
  created_at: number;
  updated_at: number;
}

const COLUMNS =
  "id, kind, name, region, spec, description, version, status, binding, last_heartbeat_at, note, hostname, os, ip, ssh_host, ssh_port, ssh_user, auth_type, ssh_secret_enc, ssh_tail, kernel, arch, probe_status, probe_at, probe_error, host_fingerprint, vendor, access_note, cf_account_id, platform, team_id, api_token_enc, api_token_tail, connection_id, remote_id, remote_name, last_sync_at, ai_summary, ai_tags, created_at, updated_at, group_id, remote_state, icon, icon_manual";

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
    auth_type: row.auth_type,
    ssh_tail: row.ssh_tail,
    kernel: row.kernel,
    arch: row.arch,
    probe_status: row.probe_status,
    probe_at: row.probe_at,
    probe_error: row.probe_error,
    host_fingerprint: row.host_fingerprint,
    vendor: row.vendor,
    access_note: row.access_note,
    cf_account_id: row.cf_account_id,
    platform: row.platform || "cloudflare",
    team_id: row.team_id,
    api_token_tail: row.api_token_tail,
    connection_id: row.connection_id,
    remote_id: row.remote_id,
    remote_name: row.remote_name,
    remote_state: row.remote_state ?? null,
    last_sync_at: row.last_sync_at,
    group_id: row.group_id,
    icon: row.icon ?? null,
    icon_manual: !!row.icon_manual,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// OS icon ids, mirroring the icon-os-* symbols in public/icons.svg and
// OS_ICONS in public/machines.js (keep the three lists in sync).
export const OS_ICON_IDS = [
  "debian", "ubuntu", "centos", "fedora", "arch", "alpine",
  "suse", "redhat", "freebsd", "windows", "macos", "linux",
];

export function osIconForOs(os: string): string | null {
  const s = (os || "").toLowerCase();
  if (!s.trim()) return null;
  if (s.includes("debian")) return "debian";
  if (s.includes("ubuntu")) return "ubuntu";
  if (s.includes("centos")) return "centos";
  if (s.includes("fedora")) return "fedora";
  if (s.includes("arch")) return "arch";
  if (s.includes("alpine")) return "alpine";
  if (s.includes("suse")) return "suse";
  if (s.includes("red hat") || s.includes("redhat") || s.includes("rhel")) return "redhat";
  if (s.includes("freebsd")) return "freebsd";
  if (s.includes("windows")) return "windows";
  if (s.includes("darwin") || s.includes("mac")) return "macos";
  return "linux";
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

export async function sealMachineSecret(key: ContentKey, plaintext: string): Promise<string> {
  if (key.state === "invalid") throw new MachineError(503, "保险库密钥配置不正确，暂时不能保存机密");
  if (key.state !== "on") throw new MachineError(503, "保险库密钥未配置，暂时不能保存机密");
  const sealed = await sealString(key, plaintext);
  if (sealed === null) throw new MachineError(503, "保险库密钥未配置，暂时不能保存机密");
  return sealed;
}

export async function openMachineSecret(key: ContentKey, stored: string): Promise<string> {
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


// Worker entries are platform-scoped: Cloudflare Workers or Vercel.
// Anything else is a client error; an absent platform means cloudflare
// (the pre-0024 shape and all existing rows).
function readPlatform(input: Record<string, unknown>): string {
  const raw = input["platform"];
  if (raw === undefined || raw === null || raw === "" || raw === "cloudflare") return "cloudflare";
  if (raw === "vercel") return "vercel";
  throw new MachineError(400, "平台不正确");
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
  // Servers use the minimal form (IP / user / password-or-key / note): the
  // name is derived below as note -> ip when the caller does not send one.
  // Other kinds keep the required name.
  let name = "";
  if (typeof input.name === "string" && input.name.trim()) name = readName(input.name);
  else if (kind !== "server") name = readName(input.name);
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
  let authType = "password";
  let vendor = "";
  let accessNote = "";
  let cfAccountId = "";
  let platform = "cloudflare";
  let teamId = "";
  let apiTokenEnc = "";
  let apiTokenTail = "";
  if (kind === "server") {
    hostname = readOptionalText(input, "hostname", 60, "主机名") ?? "";
    os = readOptionalText(input, "os", 60, "系统") ?? "";
    ip = readOptionalText(input, "ip", 64, "主机 IP") ?? "";
    sshHost = readOptionalText(input, "ssh_host", 120, "SSH 地址") ?? "";
    sshPort = readOptionalPort(input) ?? 22;
    sshUser = readOptionalText(input, "ssh_user", 60, "SSH 用户名") ?? "";
    authType = readAuthType(input);
    if (!ip && !sshHost) throw new MachineError(400, "请填写 IP");
    if (!name) name = note || ip || sshHost;
    const secret = readSecretInput(input, "ssh_secret", "SSH 密码或私钥");
    if (secret) {
      sshSecretEnc = await sealMachineSecret(key, secret);
      sshTail = tailOf(secret);
    }
  } else if (kind === "cloud") {
    vendor = readOptionalText(input, "vendor", 60, "厂商") ?? "";
    accessNote = readOptionalText(input, "access_note", 200, "接入方式备注") ?? "";
  } else {
    platform = readPlatform(input);
    if (platform === "vercel") {
      teamId = readOptionalText(input, "team_id", 64, "Team ID") ?? "";
    } else {
      cfAccountId = readOptionalText(input, "cf_account_id", 64, "Cloudflare 账号 ID") ?? "";
    }
    const token = readSecretInput(input, "api_token", "API 令牌");
    if (token) {
      apiTokenEnc = await sealMachineSecret(key, token);
      apiTokenTail = tailOf(token);
    }
  }
  const groupId = await readGroupId(db, input["group_id"]);
  const id = (ID_PREFIX[kind] ?? "mc_") + crypto.randomUUID().replace(/-/g, "");
  const status = kind === "worker" ? "active" : "running";
  await prepare(
    db,
    "INSERT INTO machines (id, kind, name, region, spec, description, version, status, binding, last_heartbeat_at, note, hostname, os, ip, ssh_host, ssh_port, ssh_user, auth_type, ssh_secret_enc, ssh_tail, vendor, access_note, cf_account_id, platform, team_id, api_token_enc, api_token_tail, group_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, kind, name, region, spec, description, status, binding, note, hostname, os, ip, sshHost, sshPort, sshUser, authType, sshSecretEnc, sshTail, vendor, accessNote, cfAccountId, platform, teamId, apiTokenEnc, apiTokenTail, groupId, now, now],
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
  if (Object.prototype.hasOwnProperty.call(input, "group_id")) {
    next.group_id = await readGroupId(db, input["group_id"]);
    changed.push("group_id");
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
    const authType = readOptionalAuthType(input);
    if (authType !== undefined) {
      next.auth_type = authType;
      changed.push("auth_type");
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
    const teamId = readOptionalText(input, "team_id", 64, "Team ID");
    if (teamId !== undefined) {
      next.team_id = teamId;
      changed.push("team_id");
    }
    const token = readSecretInput(input, "api_token", "API 令牌");
    if (token) {
      next.api_token_enc = await sealMachineSecret(key, token);
      next.api_token_tail = tailOf(token);
      changed.push("api_token");
    }
  }
  if (row.kind === "server" && Object.prototype.hasOwnProperty.call(input, "icon")) {
    const raw = input["icon"];
    if (raw === null) {
      // Back to automatic: re-derive from the OS currently on record.
      next.icon_manual = 0;
      next.icon = osIconForOs(next.os);
      changed.push("icon");
    } else if (typeof raw === "string" && OS_ICON_IDS.includes(raw)) {
      next.icon = raw;
      next.icon_manual = 1;
      changed.push("icon");
    } else {
      throw new MachineError(400, "系统图标不正确");
    }
  }
  // status / last_heartbeat_at in the payload are ignored on purpose: they
  // are runtime fields owned by machines_report.
  await prepare(
    db,
    "UPDATE machines SET name = ?, region = ?, spec = ?, description = ?, binding = ?, note = ?, hostname = ?, os = ?, ip = ?, ssh_host = ?, ssh_port = ?, ssh_user = ?, auth_type = ?, ssh_secret_enc = ?, ssh_tail = ?, vendor = ?, access_note = ?, cf_account_id = ?, team_id = ?, api_token_enc = ?, api_token_tail = ?, group_id = ?, icon = ?, icon_manual = ?, updated_at = ? WHERE id = ?",
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
      next.auth_type,
      next.ssh_secret_enc,
      next.ssh_tail,
      next.vendor,
      next.access_note,
      next.cf_account_id,
      next.team_id,
      next.api_token_enc,
      next.api_token_tail,
      next.group_id,
      next.icon,
      next.icon_manual,
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
  // Worker tokens are shown in full on the panel. The audit row lands before
  // the sealed token is opened, same order as machines_get_access. Server
  // passwords keep the previous order.
  if (row.kind === "worker") {
    await writeAudit(db, { machineId: id, actor, source: "panel", action: "reveal", detail: { kind: row.kind } }, now);
    const secret = await openMachineSecret(key, row.api_token_enc);
    return { kind: row.kind, secret, ssh_user: "" };
  }
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
  meta?: string | null;
  // Vercel projects only: last deployment time and the production domain.
  deploy_at?: string | null;
  domain?: string | null;
}

export async function fetchWorkersForMachine(
  db: D1Database,
  id: string,
  key: ContentKey,
  actor: string,
  now: number,
): Promise<{ workers: WorkerScript[]; fetched_at: number; platform: string; account_id: string; subdomain: string }> {
  const row = await getMachine(db, id);
  if (!row) throw new MachineError(404, "机器不存在");
  if (row.kind !== "worker") throw new MachineError(400, "只有 Workers 条目可以查看名下 Workers");
  if (!row.api_token_enc) throw new MachineError(400, "先补上 API 令牌");
  const token = await openMachineSecret(key, row.api_token_enc);
  if ((row.platform || "cloudflare") === "vercel") {
    let vResponse: Response;
    try {
      vResponse = await fetch(
        "https://api.vercel.com/v9/projects?limit=100" + (row.team_id ? "&teamId=" + encodeURIComponent(row.team_id) : ""),
        { headers: { authorization: "Bearer " + token, accept: "application/json" }, signal: AbortSignal.timeout(8000) },
      );
    } catch {
      throw new MachineError(502, "连接 Vercel 失败，请稍后重试");
    }
    const vBody = (await vResponse.json().catch(() => null)) as {
      projects?: VercelProject[];
      error?: { message?: string };
    } | null;
    if (!vResponse.ok || !vBody || !Array.isArray(vBody.projects)) {
      throw new MachineError(502, vBody?.error?.message ? "Vercel：" + vBody.error.message : "Vercel 返回了无法识别的响应");
    }
    const vWorkers: WorkerScript[] = vBody.projects
      .map((project) => {
        const deployAt = vercelProjectDeployAt(project);
        return {
          name: String(project.name ?? ""),
          modified_on: project.updatedAt ? new Date(project.updatedAt).toISOString() : null,
          meta: project.framework ?? null,
          deploy_at: deployAt ? new Date(deployAt).toISOString() : null,
          domain: vercelProjectDomain(project),
        };
      })
      .filter((project) => project.name !== "");
    await writeAudit(db, { machineId: id, actor, source: "panel", action: "workers_list", detail: { count: vWorkers.length, platform: "vercel" } }, now);
    return { workers: vWorkers, fetched_at: now, platform: "vercel", account_id: "", subdomain: "" };
  }
  if (!row.cf_account_id) throw new MachineError(400, "先填写 Cloudflare 账号 ID");
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
  // Best effort: the account subdomain powers the panel's 访问 button
  // (https://<script>.<subdomain>.workers.dev). Any failure just hides it.
  let subdomain = "";
  try {
    const subResponse = await fetch("https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(row.cf_account_id) + "/workers/subdomain", {
      headers: { authorization: "Bearer " + token, accept: "application/json" },
    });
    const subBody = (await subResponse.json().catch(() => null)) as {
      success?: boolean;
      result?: { subdomain?: string };
    } | null;
    if (subResponse.ok && subBody && subBody.success === true && typeof subBody.result?.subdomain === "string") {
      subdomain = subBody.result.subdomain;
    }
  } catch {
    subdomain = "";
  }
  return { workers, fetched_at: now, platform: "cloudflare", account_id: row.cf_account_id, subdomain };
}

// Panel action on a Worker entry: delete one script under the account with
// the stored token. The deletion is audited like every other panel write.
export async function deleteWorkerScriptForMachine(
  db: D1Database,
  id: string,
  key: ContentKey,
  actor: string,
  scriptName: string,
  now: number,
): Promise<{ name: string }> {
  const row = await getMachine(db, id);
  if (!row) throw new MachineError(404, "机器不存在");
  if (row.kind !== "worker") throw new MachineError(400, "只有 Workers 条目可以删除名下 Workers");
  if ((row.platform || "cloudflare") === "vercel") throw new MachineError(400, "Vercel 项目请在 Vercel 控制台删除");
  if (!row.cf_account_id) throw new MachineError(400, "先填写 Cloudflare 账号 ID");
  if (!row.api_token_enc) throw new MachineError(400, "先补上 API 令牌");
  const token = await openMachineSecret(key, row.api_token_enc);
  let response: Response;
  try {
    response = await fetch(
      "https://api.cloudflare.com/client/v4/accounts/" + encodeURIComponent(row.cf_account_id) + "/workers/scripts/" + encodeURIComponent(scriptName),
      { method: "DELETE", headers: { authorization: "Bearer " + token, accept: "application/json" } },
    );
  } catch {
    throw new MachineError(502, "连接 Cloudflare 失败，请稍后重试");
  }
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    errors?: Array<{ code?: number; message?: string }>;
  } | null;
  if (!response.ok || (body !== null && body.success !== true)) {
    const first = body?.errors?.[0];
    throw new MachineError(502, first?.message ? "Cloudflare：" + first.message : "删除失败，请稍后重试");
  }
  await writeAudit(db, { machineId: id, actor, source: "panel", action: "workers_delete", detail: { script: scriptName } }, now);
  return { name: scriptName };
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
    if ((row.platform || "cloudflare") === "vercel") {
      return { ...base, platform: "vercel", vercel: { team_id: row.team_id, api_token: token } };
    }
    return { ...base, platform: "cloudflare", cloudflare: { account_id: row.cf_account_id, api_token: token } };
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


// ---------------------------------------------------------------------------
// Server probing (Roye 2026-11-08). The panel stores the SSH config; probing
// decrypts it server-side, opens a real SSH connection with the minimal
// client in ssh-probe.ts, and writes back hostname / os / kernel / arch plus
// the probe outcome. The secret is never logged and never leaves in a
// response — only the filled facts and the outcome do.

function readAuthType(input: Record<string, unknown>): string {
  const value = input["auth_type"];
  if (value == null) return "password";
  if (value !== "password" && value !== "key") throw new MachineError(400, "认证方式不正确");
  return value;
}

function readOptionalAuthType(input: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(input, "auth_type")) return undefined;
  return readAuthType(input);
}

export interface ProbeOutcome {
  ok: boolean;
  error?: string;
  code?: string;
}

const PROBE_ERROR_MESSAGES: Record<string, string> = {
  unreachable: "无法连接到服务器，请检查 IP、端口与网络",
  timeout: "连接超时，服务器没有及时响应",
  auth: "认证失败，请检查用户名与密码或密钥",
  hostkey_mismatch: "主机密钥与上次记录不一致，可能存在安全风险，已停止连接",
  negotiation: "SSH 算法协商失败，服务器的 SSH 配置与探活客户端不兼容",
  key_encrypted: "私钥设置了口令，暂不支持",
  key_unsupported: "私钥格式不受支持",
  protocol: "SSH 协议交互失败",
};

// Best-effort GeoIP for the probed server's region label. Public IPs only;
// a short timeout and any failure return "" so probing never depends on it.
// Exported too for the cloud (InstaBox) exec probe, which resolves the
// sandbox's egress IP through the same lookup so both card types store the
// same value shape (an English country name, e.g. "United States").
export async function lookupRegionByIp(ip: string): Promise<string> {
  const value = String(ip || "").trim();
  if (!value) return "";
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return "";
    if (a === 172 && b >= 16 && b <= 31) return "";
    if (a === 192 && b === 168) return "";
    if (a === 169 && b === 254) return "";
    if (a === 100 && b >= 64 && b <= 127) return "";
  } else if (/^(::1|fe80:|fc|fd)/i.test(value)) {
    return "";
  }
  try {
    const response = await fetch("http://ip-api.com/json/" + encodeURIComponent(value) + "?fields=status,country", {
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return "";
    const data = (await response.json()) as { status?: string; country?: string } | null;
    if (!data || data.status !== "success") return "";
    return typeof data.country === "string" ? data.country.trim() : "";
  } catch {
    return "";
  }
}

export async function probeMachineById(
  db: D1Database,
  id: string,
  key: ContentKey,
  actor: string,
  now: number,
): Promise<{ machine: MachineRow; probe: ProbeOutcome }> {
  const row = await getMachine(db, id);
  if (!row) throw new MachineError(404, "机器不存在");
  if (row.kind !== "server") throw new MachineError(400, "只有服务器可以测试连接");
  const host = row.ssh_host || row.ip;

  async function recordFailure(code: string, message: string): Promise<{ machine: MachineRow; probe: ProbeOutcome }> {
    await prepare(
      db,
      "UPDATE machines SET status = 'offline', probe_status = 'error', probe_at = ?, probe_error = ?, updated_at = ? WHERE id = ?",
      [now, message, now, id],
    ).run();
    await writeAudit(db, { machineId: id, actor, source: "panel", action: "probe", detail: { ok: false, code } }, now);
    const fresh = await getMachine(db, id);
    if (!fresh) throw new MachineError(500, "探活后读取失败");
    return { machine: fresh, probe: { ok: false, error: message, code } };
  }

  if (!host) return recordFailure("no_host", "还没有填写服务器 IP");
  if (!row.ssh_user || !row.ssh_secret_enc) return recordFailure("no_credential", "还没有保存 SSH 用户名或凭据");
  const secret = await openMachineSecret(key, row.ssh_secret_enc);
  const authType = secret.includes("PRIVATE KEY-----") ? "key" : row.auth_type === "key" ? "key" : "password";
  try {
    const result = await sshProbe({
      host,
      port: row.ssh_port,
      username: row.ssh_user,
      authType,
      secret,
      knownFingerprint: row.host_fingerprint || undefined,
      timeoutMs: 15000,
    });
    let name = row.name;
    if ((name === row.ip || name === row.hostname) && (row.note || result.hostname)) {
      name = row.note || result.hostname;
    }
    const region = (await lookupRegionByIp(host)) || row.region;
    await prepare(
      db,
      "UPDATE machines SET name = ?, hostname = ?, os = ?, spec = ?, kernel = ?, arch = ?, region = ?, host_fingerprint = ?, icon = CASE WHEN icon_manual = 0 THEN ? ELSE icon END, status = 'running', probe_status = 'ok', probe_at = ?, probe_error = '', last_heartbeat_at = ?, updated_at = ? WHERE id = ?",
      [
        name,
        result.hostname || row.hostname,
        result.os || row.os,
        result.spec || row.spec,
        result.kernel,
        result.arch,
        region,
        result.fingerprint,
        osIconForOs(result.os || row.os) ?? row.icon,
        now,
        now,
        now,
        id,
      ],
    ).run();
    await writeAudit(db, { machineId: id, actor, source: "panel", action: "probe", detail: { ok: true, host } }, now);
    const fresh = await getMachine(db, id);
    if (!fresh) throw new MachineError(500, "探活后读取失败");
    return { machine: fresh, probe: { ok: true } };
  } catch (error) {
    if (error instanceof SshProbeError) {
      const message = PROBE_ERROR_MESSAGES[error.code] ?? "探活失败，请稍后重试";
      return recordFailure(error.code, message);
    }
    throw error;
  }
}

// A server counts as stale when it has credentials but no probe result in
// the last PROBE_STALE_MS. The panel list endpoint fires this in waitUntil
// so opening the server list quietly refreshes old entries; at most a few
// probes run per list call. Cron note: the account's cron quota is full and
// HiveMos has no registered trigger, so there is deliberately no scheduled
// probing yet — once a cron slot is approved, calling probeStaleServers
// from the scheduled handler in src/index.ts turns this into timed probing.
export const PROBE_STALE_MS = 10 * 60 * 1000;

export async function probeStaleServers(db: D1Database, key: ContentKey, actor: string, now: number): Promise<void> {
  const rows = await listMachines(db, "server");
  const stale = rows
    .filter((row) => row.ssh_user && row.ssh_secret_enc && (row.probe_at == null || now - row.probe_at > PROBE_STALE_MS))
    .slice(0, 3);
  for (const row of stale) {
    try {
      await probeMachineById(db, row.id, key, actor, Date.now());
    } catch {
      // A single bad entry (or a missing vault key) must not break listing.
    }
  }
}


// Group membership (phase 3): one pool for the whole board, scope
// "machines" in the shared groups table. Empty / null clears the grouping.
export async function readGroupId(db: D1Database, value: unknown): Promise<string | null> {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new MachineError(400, "分组不正确");
  const group = await getGroup(db, value);
  if (!group || group.scope !== "machines") throw new MachineError(400, "分组不存在");
  return value;
}


// ---- Worker account stats & asset lists (card fill + tabbed panel) ----
// Every metric is best-effort: a token without one scope yields null for
// that metric instead of failing the whole view. List views are audited.

interface CfBody {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: unknown;
  result_info?: { total_count?: number };
}

async function cfGetJson(token: string, url: string): Promise<CfBody> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { authorization: "Bearer " + token, accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  } catch {
    throw new MachineError(502, "连接 Cloudflare 失败，请稍后重试");
  }
  const body = (await response.json().catch(() => null)) as CfBody | null;
  if (!response.ok || !body || body.success !== true) {
    const first = body?.errors?.[0];
    throw new MachineError(502, first?.message ? "Cloudflare：" + first.message : "Cloudflare 返回了无法识别的响应");
  }
  return body;
}

async function cloudflareWorkerRow(
  db: D1Database,
  key: ContentKey,
  id: string,
): Promise<{ accountId: string; token: string }> {
  const row = await getMachine(db, id);
  if (!row) throw new MachineError(404, "机器不存在");
  if (row.kind !== "worker") throw new MachineError(400, "只有 Workers 条目有此数据");
  if ((row.platform || "cloudflare") !== "cloudflare") throw new MachineError(400, "仅 Cloudflare 账号支持此功能");
  if (!row.cf_account_id) throw new MachineError(400, "先填写 Cloudflare 账号 ID");
  if (!row.api_token_enc) throw new MachineError(400, "先补上 API 令牌");
  const token = await openMachineSecret(key, row.api_token_enc);
  return { accountId: row.cf_account_id, token };
}

export interface WorkerAccountStats {
  workers_total: number | null;
  requests_24h: number | null;
  d1_count: number | null;
  d1_bytes: number | null;
  zones_total: number | null;
  fetched_at: number;
}

export interface VercelLatestDeploy {
  state: string | null;
  created_at: number | null;
  url: string | null;
}

// Account profile for the account tab. Every field is nullable: Vercel only
// returns what the token may read, and nothing here is ever invented.
export interface VercelAccountProfile {
  username: string | null;
  email: string | null;
  name: string | null;
  team_name: string | null;
  team_plan: string | null;
}

export interface VercelAccountStats {
  projects_total: number | null;
  domains_total: number | null;
  latest_deploy: VercelLatestDeploy | null;
  account: VercelAccountProfile;
  fetched_at: number;
}

interface VercelDeploymentRef {
  createdAt?: number;
  created?: number;
  url?: string;
  target?: string;
  alias?: string[];
}

interface VercelProject {
  name?: string;
  updatedAt?: number;
  framework?: string | null;
  latestDeployments?: VercelDeploymentRef[];
  targets?: { production?: { alias?: string[]; url?: string } };
}

interface VercelBody {
  projects?: VercelProject[];
  domains?: Array<{ name?: string; createdAt?: number }>;
  deployments?: Array<{
    name?: string;
    url?: string;
    state?: string;
    created?: number;
    meta?: Record<string, unknown>;
  }>;
  user?: { username?: string; email?: string; name?: string | null };
  team?: { name?: string; plan?: string | { slug?: string } };
  // Some Vercel endpoints return the user/team object unwrapped.
  username?: string;
  email?: string;
  name?: string | null;
  slug?: string;
  plan?: string | { slug?: string };
  error?: { message?: string };
}

// Best-effort wrapper: a metric the token cannot read stays null instead of
// failing the whole card.
async function vercelSafe<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch {
    return fallback;
  }
}

function vercelDeployTime(deploy: VercelDeploymentRef | undefined): number | null {
  if (!deploy) return null;
  if (typeof deploy.createdAt === "number" && deploy.createdAt > 0) return deploy.createdAt;
  if (typeof deploy.created === "number" && deploy.created > 0) return deploy.created;
  return null;
}

function vercelProjectDeployAt(project: VercelProject): number | null {
  const rows = Array.isArray(project.latestDeployments) ? project.latestDeployments : [];
  let latest = 0;
  rows.forEach((row) => {
    const time = vercelDeployTime(row);
    if (time !== null && time > latest) latest = time;
  });
  return latest > 0 ? latest : null;
}

function vercelProjectDomain(project: VercelProject): string | null {
  const production = project.targets?.production;
  const alias = Array.isArray(production?.alias) ? production?.alias[0] : undefined;
  if (typeof alias === "string" && alias.trim()) return alias.trim();
  if (typeof production?.url === "string" && production.url.trim()) return production.url.trim();
  const rows = Array.isArray(project.latestDeployments) ? project.latestDeployments : [];
  const deploy = rows.find((row) => row.target === "production") ?? rows[0];
  const deployAlias = Array.isArray(deploy?.alias) ? deploy?.alias[0] : undefined;
  if (typeof deployAlias === "string" && deployAlias.trim()) return deployAlias.trim();
  if (typeof deploy?.url === "string" && deploy.url.trim()) return deploy.url.trim();
  return null;
}

// Vercel's deployment urls come without a scheme (project-x.vercel.app).
function vercelHttpUrl(value: string | undefined | null): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return /^https?:\/\//i.test(text) ? text : "https://" + text;
}

function vercelDeployMeta(meta: Record<string, unknown> | undefined): { branch: string | null; commit_message: string | null } {
  const source = meta && typeof meta === "object" ? meta : {};
  const candidates = [source.githubCommitRef, source.gitBranch, source.branch];
  let branch: string | null = null;
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      branch = candidate.trim();
      break;
    }
  }
  const message = typeof source.githubCommitMessage === "string" && source.githubCommitMessage.trim() ? source.githubCommitMessage.trim() : null;
  return { branch, commit_message: message };
}

async function vercelAccountProfile(token: string, teamId: string): Promise<VercelAccountProfile> {
  const profile: VercelAccountProfile = { username: null, email: null, name: null, team_name: null, team_plan: null };
  try {
    const body = await vercelGetJson(token, "https://api.vercel.com/v2/user");
    const user = body.user ?? body;
    if (typeof user.username === "string" && user.username.trim()) profile.username = user.username.trim();
    if (typeof user.email === "string" && user.email.trim()) profile.email = user.email.trim();
    if (typeof user.name === "string" && user.name.trim()) profile.name = user.name.trim();
  } catch { /* stays null */ }
  if (teamId) {
    try {
      const body = await vercelGetJson(token, "https://api.vercel.com/v2/teams/" + encodeURIComponent(teamId));
      const team = body.team ?? body;
      if (typeof team.name === "string" && team.name.trim()) profile.team_name = team.name.trim();
      const plan = team.plan;
      const slug = typeof plan === "string" ? plan : plan && typeof plan.slug === "string" ? plan.slug : "";
      if (slug.trim()) profile.team_plan = slug.trim();
    } catch { /* stays null */ }
  }
  return profile;
}

async function vercelGetJson(token: string, url: string): Promise<VercelBody> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { authorization: "Bearer " + token, accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  } catch {
    throw new MachineError(502, "连接 Vercel 失败，请稍后重试");
  }
  const body = (await response.json().catch(() => null)) as VercelBody | null;
  if (!response.ok || !body) {
    throw new MachineError(502, body?.error?.message ? "Vercel：" + body.error.message : "Vercel 返回了无法识别的响应");
  }
  return body;
}

export async function getWorkerAccountStats(
  db: D1Database,
  key: ContentKey,
  id: string,
  now: number,
): Promise<WorkerAccountStats | VercelAccountStats> {
  const row = await getMachine(db, id);
  if (!row) throw new MachineError(404, "机器不存在");
  if (row.kind !== "worker") throw new MachineError(400, "只有 Workers 条目有此数据");
  if (!row.api_token_enc) throw new MachineError(400, "先补上 API 令牌");
  const token = await openMachineSecret(key, row.api_token_enc);
  if ((row.platform || "cloudflare") === "vercel") {
    const team = row.team_id ? "&teamId=" + encodeURIComponent(row.team_id) : "";
    const [projects_total, domains_total, latest_deploy, account] = await Promise.all([
      vercelSafe(async () => {
        const body = await vercelGetJson(token, "https://api.vercel.com/v9/projects?limit=100" + team);
        return Array.isArray(body.projects) ? body.projects.length : null;
      }, null),
      vercelSafe(async () => {
        const body = await vercelGetJson(token, "https://api.vercel.com/v5/domains?limit=100" + team);
        return Array.isArray(body.domains) ? body.domains.length : null;
      }, null),
      vercelSafe(async () => {
        const body = await vercelGetJson(token, "https://api.vercel.com/v6/deployments?limit=1" + team);
        const first = Array.isArray(body.deployments) ? body.deployments[0] : undefined;
        if (!first) return null;
        const state = typeof first.state === "string" && first.state.trim() ? first.state.trim() : null;
        const created_at = typeof first.created === "number" && first.created > 0 ? first.created : null;
        const url = vercelHttpUrl(first.url);
        if (state === null && created_at === null && url === null) return null;
        return { state, created_at, url };
      }, null),
      vercelAccountProfile(token, row.team_id ?? ""),
    ]);
    return { projects_total, domains_total, latest_deploy, account, fetched_at: now };
  }
  if (!row.cf_account_id) throw new MachineError(400, "先填写 Cloudflare 账号 ID");
  const accountId = row.cf_account_id;
  const acct = encodeURIComponent(accountId);
  let workers_total: number | null = null;
  let requests_24h: number | null = null;
  let d1_count: number | null = null;
  let d1_bytes: number | null = null;
  let zones_total: number | null = null;
  try {
    const body = await cfGetJson(token, "https://api.cloudflare.com/client/v4/accounts/" + acct + "/workers/scripts?per_page=100");
    if (Array.isArray(body.result)) workers_total = body.result.length;
  } catch { /* metric stays null */ }
  try {
    const body = await cfGetJson(token, "https://api.cloudflare.com/client/v4/zones?account.id=" + acct + "&per_page=1");
    if (typeof body.result_info?.total_count === "number") zones_total = body.result_info.total_count;
  } catch { /* metric stays null */ }
  try {
    const body = await cfGetJson(token, "https://api.cloudflare.com/client/v4/accounts/" + acct + "/d1/database?per_page=100");
    if (Array.isArray(body.result)) {
      d1_count = body.result.length;
      d1_bytes = body.result.reduce((sum: number, entry) => {
        const size = Number((entry as { file_size?: unknown }).file_size);
        return sum + (Number.isFinite(size) ? size : 0);
      }, 0);
    }
  } catch { /* metric stays null */ }
  try {
    const end = new Date(now);
    const start = new Date(now - 24 * 3600 * 1000);
    const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      signal: AbortSignal.timeout(8000),
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({
        query:
          "query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:1,filter:{datetime_geq:$s,datetime_lt:$e}){sum{requests}}}}}",
        variables: { a: accountId, s: start.toISOString(), e: end.toISOString() },
      }),
    });
    const body = (await response.json().catch(() => null)) as {
      data?: { viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: Array<{ sum?: { requests?: number } }> }> } };
    } | null;
    const requests = body?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive?.[0]?.sum?.requests;
    if (typeof requests === "number") requests_24h = requests;
  } catch { /* metric stays null */ }
  return { workers_total, requests_24h, d1_count, d1_bytes, zones_total, fetched_at: now };
}

export type WorkerAssetKind = "zones" | "d1" | "r2" | "kv" | "vdomains" | "deployments";

export async function listWorkerAssets(
  db: D1Database,
  key: ContentKey,
  id: string,
  kind: WorkerAssetKind,
  actor: string,
  now: number,
): Promise<{ kind: WorkerAssetKind; items: Array<Record<string, unknown>>; fetched_at: number }> {
  if (kind === "vdomains" || kind === "deployments") {
    const vrow = await getMachine(db, id);
    if (!vrow) throw new MachineError(404, "机器不存在");
    if (vrow.kind !== "worker") throw new MachineError(400, "只有 Workers 条目有此数据");
    if ((vrow.platform || "cloudflare") !== "vercel") throw new MachineError(400, "仅 Vercel 账号支持此列表");
    if (!vrow.api_token_enc) throw new MachineError(400, "先补上 API 令牌");
    const vtoken = await openMachineSecret(key, vrow.api_token_enc);
    const vteam = vrow.team_id ? "&teamId=" + encodeURIComponent(vrow.team_id) : "";
    let vitems: Array<Record<string, unknown>> = [];
    if (kind === "vdomains") {
      const body = await vercelGetJson(vtoken, "https://api.vercel.com/v5/domains?limit=100" + vteam);
      const rows = Array.isArray(body.domains) ? body.domains : [];
      vitems = rows.map((domain) => ({
        name: String(domain.name ?? ""),
        created_at: typeof domain.createdAt === "number" ? new Date(domain.createdAt).toISOString() : null,
      }));
    } else {
      const body = await vercelGetJson(vtoken, "https://api.vercel.com/v6/deployments?limit=20" + vteam);
      const rows = Array.isArray(body.deployments) ? body.deployments : [];
      vitems = rows.map((deployment) => {
        const meta = vercelDeployMeta(deployment.meta);
        return {
          name: String(deployment.name ?? ""),
          url: vercelHttpUrl(deployment.url) ?? "",
          state: String(deployment.state ?? ""),
          created_at: typeof deployment.created === "number" ? new Date(deployment.created).toISOString() : null,
          branch: meta.branch,
          commit_message: meta.commit_message,
        };
      });
    }
    await writeAudit(db, { machineId: id, actor, source: "panel", action: "worker_assets", detail: { kind, count: vitems.length } }, now);
    return { kind, items: vitems, fetched_at: now };
  }
  const { accountId, token } = await cloudflareWorkerRow(db, key, id);
  const acct = encodeURIComponent(accountId);
  let items: Array<Record<string, unknown>> = [];
  if (kind === "zones") {
    const body = await cfGetJson(token, "https://api.cloudflare.com/client/v4/zones?account.id=" + acct + "&per_page=100");
    const rows = Array.isArray(body.result) ? (body.result as Array<Record<string, unknown>>) : [];
    items = rows.map((zone) => ({
      name: String(zone.name ?? ""),
      status: String(zone.status ?? ""),
      plan: String((zone.plan as { name?: unknown } | undefined)?.name ?? ""),
    }));
  } else if (kind === "d1") {
    const body = await cfGetJson(token, "https://api.cloudflare.com/client/v4/accounts/" + acct + "/d1/database?per_page=100");
    const rows = Array.isArray(body.result) ? (body.result as Array<Record<string, unknown>>) : [];
    items = rows.map((entry) => ({
      name: String(entry.name ?? ""),
      uuid: String(entry.uuid ?? entry.id ?? ""),
      created_at: typeof entry.created_at === "string" ? entry.created_at : null,
      file_size: Number(entry.file_size) || 0,
      num_tables: typeof entry.num_tables === "number" ? entry.num_tables : null,
    }));
  } else if (kind === "r2") {
    const body = await cfGetJson(token, "https://api.cloudflare.com/client/v4/accounts/" + acct + "/r2/buckets");
    const result = body.result as { buckets?: Array<Record<string, unknown>> } | Array<Record<string, unknown>> | undefined;
    const rows = Array.isArray(result) ? result : Array.isArray(result?.buckets) ? result.buckets : [];
    items = rows.map((bucket) => ({
      name: String(bucket.name ?? ""),
      created_at: typeof bucket.creation_date === "string" ? bucket.creation_date : null,
      location: String(bucket.location ?? ""),
    }));
  } else {
    const body = await cfGetJson(token, "https://api.cloudflare.com/client/v4/accounts/" + acct + "/storage/kv/namespaces?per_page=100");
    const rows = Array.isArray(body.result) ? (body.result as Array<Record<string, unknown>>) : [];
    items = rows.map((ns) => ({ id: String(ns.id ?? ""), title: String(ns.title ?? "") }));
  }
  await writeAudit(db, { machineId: id, actor, source: "panel", action: "worker_assets", detail: { kind, count: items.length } }, now);
  return { kind, items, fetched_at: now };
}
