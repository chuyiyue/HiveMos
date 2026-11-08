// Machines board core: one table backs the three panel tabs (服务器 /
// 云主机 / Workers). Panel REST lives in machines-http.ts; the MCP tools in
// mcp.ts call the same functions so validation and audit cannot drift.
// status and last_heartbeat_at are runtime fields: the panel forms never
// write them; only machines_report (an agent reporting itself) does.

import { prepare } from "./registry";
import type { D1Database } from "./env";

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
  created_at: number;
  updated_at: number;
}

const COLUMNS =
  "id, kind, name, region, spec, description, version, status, binding, last_heartbeat_at, ai_summary, ai_tags, created_at, updated_at";

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

// ---------------------------------------------------------------------------

export async function createMachine(
  db: D1Database,
  input: Record<string, unknown>,
  actor: string,
  source: string,
  now: number,
): Promise<MachineRow> {
  const kind = readKind(input.kind);
  const name = readName(input.name);
  const region = readOptionalText(input, "region", 30, "地域") ?? "";
  const spec = readOptionalText(input, "spec", 60, "配置") ?? "";
  const description = readOptionalText(input, "description", 120, "说明") ?? "";
  const bindingInput = readOptionalText(input, "binding", 60, "绑定");
  const binding = bindingInput !== undefined && bindingInput !== "" ? bindingInput : kind === "worker" ? "" : "未绑定";
  const id = (ID_PREFIX[kind] ?? "mc_") + crypto.randomUUID().replace(/-/g, "");
  const status = kind === "worker" ? "active" : "running";
  await prepare(
    db,
    "INSERT INTO machines (id, kind, name, region, spec, description, version, status, binding, last_heartbeat_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, NULL, ?, ?)",
    [id, kind, name, region, spec, description, status, binding, now, now],
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
  // status / last_heartbeat_at in the payload are ignored on purpose: they
  // are runtime fields owned by machines_report.
  await prepare(db, "UPDATE machines SET name = ?, region = ?, spec = ?, description = ?, binding = ?, updated_at = ? WHERE id = ?", [
    next.name,
    next.region,
    next.spec,
    next.description,
    next.binding,
    now,
    id,
  ]).run();
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
