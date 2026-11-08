// Extras core: the apps / skills / apis tables behind three panel tabs
// （应用、Skills、API). Panel REST lives in extras-http.ts; the skills MCP
// tools in mcp.ts call the same functions so validation cannot drift.
// skills / apis rows hang off the scope=mcp group pool shared with the MCP
// tab; apps never persist a group (the groups table has no app scope), so
// the panel keeps app grouping in page state and group_id stays NULL.

import { prepare } from "./registry";
import type { D1Database } from "./env";

export class ExtraError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Rows and public shapes

export interface AppRow {
  id: string;
  name: string;
  type: string;
  note: string;
  last_used_at: number | null;
  group_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  source: string;
  content: string;
  status: string;
  version: string;
  used_by: string;
  group_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ApiRow {
  id: string;
  name: string;
  base_url: string;
  auth_note: string;
  note: string;
  status: string;
  group_id: string | null;
  created_at: number;
  updated_at: number;
}

export type PublicApp = AppRow;
export type PublicApi = ApiRow;

// The panel list carries the full skill row (content included) so the edit
// dialog can prefill without a second fetch; the MCP summary drops content.
export type PublicSkill = SkillRow;

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  source: string;
  status: string;
  version: string;
  used_by: string;
  group_id: string | null;
  updated_at: number;
}

export function skillSummary(row: SkillRow): SkillSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    source: row.source,
    status: row.status,
    version: row.version,
    used_by: row.used_by,
    group_id: row.group_id,
    updated_at: row.updated_at,
  };
}

const APP_COLUMNS = "id, name, type, note, last_used_at, group_id, created_at, updated_at";
// A group deleted through the registry only ungroups its own scope table,
// so a skill / api can be left pointing at a group that no longer exists;
// the join folds that back to NULL instead of leaking a phantom group id.
const SKILL_COLUMNS =
  "s.id, s.name, s.description, s.source, s.content, s.status, s.version, s.used_by, " +
  "CASE WHEN s.group_id IS NOT NULL AND g.id IS NULL THEN NULL ELSE s.group_id END AS group_id, " +
  "s.created_at, s.updated_at";
const SKILL_FROM = "FROM skills AS s LEFT JOIN groups AS g ON g.id = s.group_id AND g.scope = 'mcp'";
const API_COLUMNS =
  "a.id, a.name, a.base_url, a.auth_note, a.note, a.status, " +
  "CASE WHEN a.group_id IS NOT NULL AND g.id IS NULL THEN NULL ELSE a.group_id END AS group_id, " +
  "a.created_at, a.updated_at";
const API_FROM = "FROM apis AS a LEFT JOIN groups AS g ON g.id = a.group_id AND g.scope = 'mcp'";

function rowsOf<T>(value: { results?: T[] } | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.results)) return value.results;
  return [];
}

// ---------------------------------------------------------------------------
// Input reading. Panel and MCP share these so the same payload is judged the
// same way on both surfaces.

function readName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ExtraError(400, "请填写名称");
  const name = value.trim();
  if (name.length > 64) throw new ExtraError(400, "名称太长");
  return name;
}

// Present-but-wrong-typed optional text is a 400; absent returns undefined so
// update can tell "leave it alone" apart from "set it empty".
function readOptionalText(input: Record<string, unknown>, key: string, max: number, label: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(input, key)) return undefined;
  const value = input[key];
  if (value == null) return "";
  if (typeof value !== "string") throw new ExtraError(400, label + "格式不正确");
  const text = value.trim();
  if (text.length > max) throw new ExtraError(400, label + "太长");
  return text;
}

function readStatus(input: Record<string, unknown>, allowed: string[]): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(input, "status")) return undefined;
  const value = input.status;
  if (typeof value !== "string" || !allowed.includes(value)) throw new ExtraError(400, "状态不正确");
  return value;
}

// Absent -> undefined (leave alone); null / "" -> null; otherwise the id
// must name an existing scope=mcp group, the same rule the registry applies
// to mcp_servers.
async function readGroupId(db: D1Database, input: Record<string, unknown>): Promise<string | null | undefined> {
  if (!Object.prototype.hasOwnProperty.call(input, "group_id")) return undefined;
  const value = input.group_id;
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new ExtraError(400, "分组不正确");
  const group = await prepare(db, "SELECT id FROM groups WHERE id = ? AND scope = 'mcp'", [value]).first<{ id: string }>();
  if (!group) throw new ExtraError(400, "分组不存在");
  return value;
}

function newId(prefix: string): string {
  return prefix + crypto.randomUUID().replace(/-/g, "");
}

// ---------------------------------------------------------------------------
// Apps

export async function listApps(db: D1Database): Promise<AppRow[]> {
  const result = await prepare(db, "SELECT " + APP_COLUMNS + " FROM apps ORDER BY created_at ASC, rowid ASC").all<AppRow>();
  return rowsOf<AppRow>(result as { results?: AppRow[] } | AppRow[]);
}

export async function getApp(db: D1Database, id: string): Promise<AppRow | null> {
  return prepare(db, "SELECT " + APP_COLUMNS + " FROM apps WHERE id = ?", [id]).first<AppRow>();
}

export async function createApp(db: D1Database, input: Record<string, unknown>, now: number): Promise<AppRow> {
  const name = readName(input.name);
  const type = readOptionalText(input, "type", 40, "类型") ?? "";
  const note = readOptionalText(input, "note", 200, "说明") ?? "";
  const id = newId("app_");
  await prepare(db, "INSERT INTO apps (id, name, type, note, last_used_at, group_id, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)", [
    id,
    name,
    type,
    note,
    now,
    now,
  ]).run();
  const row = await getApp(db, id);
  if (!row) throw new ExtraError(500, "创建后读取失败");
  return row;
}

export async function updateApp(db: D1Database, id: string, input: Record<string, unknown>, now: number): Promise<AppRow> {
  const row = await getApp(db, id);
  if (!row) throw new ExtraError(404, "应用不存在");
  const next: AppRow = { ...row };
  if (Object.prototype.hasOwnProperty.call(input, "name")) next.name = readName(input.name);
  const type = readOptionalText(input, "type", 40, "类型");
  if (type !== undefined) next.type = type;
  const note = readOptionalText(input, "note", 200, "说明");
  if (note !== undefined) next.note = note;
  // last_used_at is a runtime field and group_id is not persisted for apps;
  // both are ignored in the payload on purpose.
  await prepare(db, "UPDATE apps SET name = ?, type = ?, note = ?, updated_at = ? WHERE id = ?", [next.name, next.type, next.note, now, id]).run();
  const fresh = await getApp(db, id);
  if (!fresh) throw new ExtraError(500, "保存后读取失败");
  return fresh;
}

export async function deleteApp(db: D1Database, id: string): Promise<void> {
  const row = await getApp(db, id);
  if (!row) throw new ExtraError(404, "应用不存在");
  await prepare(db, "DELETE FROM apps WHERE id = ?", [id]).run();
}

// ---------------------------------------------------------------------------
// Skills

export async function listSkills(db: D1Database, groupId: string | null): Promise<SkillRow[]> {
  const result = groupId
    ? await prepare(db, "SELECT " + SKILL_COLUMNS + " " + SKILL_FROM + " WHERE s.group_id = ? ORDER BY s.created_at ASC, s.rowid ASC", [groupId]).all<SkillRow>()
    : await prepare(db, "SELECT " + SKILL_COLUMNS + " " + SKILL_FROM + " ORDER BY s.created_at ASC, s.rowid ASC").all<SkillRow>();
  return rowsOf<SkillRow>(result as { results?: SkillRow[] } | SkillRow[]);
}

export async function getSkill(db: D1Database, id: string): Promise<SkillRow | null> {
  return prepare(db, "SELECT " + SKILL_COLUMNS + " " + SKILL_FROM + " WHERE s.id = ?", [id]).first<SkillRow>();
}

export async function getSkillByName(db: D1Database, name: string): Promise<SkillRow | null> {
  return prepare(db, "SELECT " + SKILL_COLUMNS + " " + SKILL_FROM + " WHERE s.name = ? ORDER BY s.created_at ASC, s.rowid ASC LIMIT 1", [name]).first<SkillRow>();
}

export async function createSkill(db: D1Database, input: Record<string, unknown>, now: number): Promise<SkillRow> {
  const name = readName(input.name);
  const description = readOptionalText(input, "description", 300, "说明") ?? "";
  const source = readOptionalText(input, "source", 64, "来源") ?? "";
  const content = readOptionalText(input, "content", 20000, "正文") ?? "";
  const version = readOptionalText(input, "version", 32, "版本") ?? "";
  const usedBy = readOptionalText(input, "used_by", 120, "引用") ?? "";
  const status = readStatus(input, ["enabled", "disabled"]) ?? "enabled";
  const groupId = (await readGroupId(db, input)) ?? null;
  const id = newId("skill_");
  await prepare(
    db,
    "INSERT INTO skills (id, name, description, source, content, status, version, used_by, group_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, name, description, source, content, status, version, usedBy, groupId, now, now],
  ).run();
  const row = await getSkill(db, id);
  if (!row) throw new ExtraError(500, "创建后读取失败");
  return row;
}

export async function updateSkill(db: D1Database, id: string, input: Record<string, unknown>, now: number): Promise<SkillRow> {
  const row = await getSkill(db, id);
  if (!row) throw new ExtraError(404, "技能不存在");
  const next: SkillRow = { ...row };
  if (Object.prototype.hasOwnProperty.call(input, "name")) next.name = readName(input.name);
  const description = readOptionalText(input, "description", 300, "说明");
  if (description !== undefined) next.description = description;
  const source = readOptionalText(input, "source", 64, "来源");
  if (source !== undefined) next.source = source;
  const content = readOptionalText(input, "content", 20000, "正文");
  if (content !== undefined) next.content = content;
  const version = readOptionalText(input, "version", 32, "版本");
  if (version !== undefined) next.version = version;
  const usedBy = readOptionalText(input, "used_by", 120, "引用");
  if (usedBy !== undefined) next.used_by = usedBy;
  const status = readStatus(input, ["enabled", "disabled"]);
  if (status !== undefined) next.status = status;
  const groupId = await readGroupId(db, input);
  if (groupId !== undefined) next.group_id = groupId;
  await prepare(
    db,
    "UPDATE skills SET name = ?, description = ?, source = ?, content = ?, status = ?, version = ?, used_by = ?, group_id = ?, updated_at = ? WHERE id = ?",
    [next.name, next.description, next.source, next.content, next.status, next.version, next.used_by, next.group_id, now, id],
  ).run();
  const fresh = await getSkill(db, id);
  if (!fresh) throw new ExtraError(500, "保存后读取失败");
  return fresh;
}

export async function deleteSkill(db: D1Database, id: string): Promise<void> {
  const row = await getSkill(db, id);
  if (!row) throw new ExtraError(404, "技能不存在");
  await prepare(db, "DELETE FROM skills WHERE id = ?", [id]).run();
}

// MCP read path: mirrors fetchConfigForAgent — the fetch audit row lands in
// mcp_fetch_audit (server_id carries the skill id; a skill is one more kind
// of fetchable config) before the content is handed back.
export async function getSkillForAgent(
  db: D1Database,
  skillId: string,
  name: string,
  agentId: string,
  now: number,
): Promise<SkillRow | null> {
  let row: SkillRow | null = null;
  if (skillId) row = await getSkill(db, skillId);
  if (!row && name) row = await getSkillByName(db, name);
  if (!row) return null;
  await prepare(db, "INSERT INTO mcp_fetch_audit (id, agent_id, server_id, created_at) VALUES (?, ?, ?, ?)", [
    crypto.randomUUID(),
    agentId,
    row.id,
    now,
  ]).run();
  return row;
}

// ---------------------------------------------------------------------------
// APIs

export async function listApis(db: D1Database, groupId: string | null): Promise<ApiRow[]> {
  const result = groupId
    ? await prepare(db, "SELECT " + API_COLUMNS + " " + API_FROM + " WHERE a.group_id = ? ORDER BY a.created_at ASC, a.rowid ASC", [groupId]).all<ApiRow>()
    : await prepare(db, "SELECT " + API_COLUMNS + " " + API_FROM + " ORDER BY a.created_at ASC, a.rowid ASC").all<ApiRow>();
  return rowsOf<ApiRow>(result as { results?: ApiRow[] } | ApiRow[]);
}

export async function getApi(db: D1Database, id: string): Promise<ApiRow | null> {
  return prepare(db, "SELECT " + API_COLUMNS + " " + API_FROM + " WHERE a.id = ?", [id]).first<ApiRow>();
}

export interface ApiSummary {
  id: string;
  name: string;
  base_url: string;
  auth_note: string;
  note: string;
  status: string;
  group_id: string | null;
  updated_at: number;
}

export function apiSummary(row: ApiRow): ApiSummary {
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    auth_note: row.auth_note,
    note: row.note,
    status: row.status,
    group_id: row.group_id,
    updated_at: row.updated_at,
  };
}

export async function getApiByName(db: D1Database, name: string): Promise<ApiRow | null> {
  return prepare(db, "SELECT " + API_COLUMNS + " " + API_FROM + " WHERE a.name = ?", [name]).first<ApiRow>();
}

export async function getApiForAgent(
  db: D1Database,
  apiId: string,
  name: string,
  agentId: string,
  now: number,
): Promise<ApiRow | null> {
  let row: ApiRow | null = null;
  if (apiId) row = await getApi(db, apiId);
  if (!row && name) row = await getApiByName(db, name);
  if (!row) return null;
  await prepare(db, "INSERT INTO mcp_fetch_audit (id, agent_id, server_id, created_at) VALUES (?, ?, ?, ?)", [
    crypto.randomUUID(),
    agentId,
    row.id,
    now,
  ]).run();
  return row;
}

export async function createApi(db: D1Database, input: Record<string, unknown>, now: number): Promise<ApiRow> {
  const name = readName(input.name);
  const baseUrl = readOptionalText(input, "base_url", 300, "端点");
  if (!baseUrl) throw new ExtraError(400, "请填写端点");
  const authNote = readOptionalText(input, "auth_note", 64, "鉴权说明") ?? "";
  const note = readOptionalText(input, "note", 300, "说明") ?? "";
  const status = readStatus(input, ["active", "disabled"]) ?? "active";
  const groupId = (await readGroupId(db, input)) ?? null;
  const id = newId("api_");
  await prepare(db, "INSERT INTO apis (id, name, base_url, auth_note, note, status, group_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    id,
    name,
    baseUrl,
    authNote,
    note,
    status,
    groupId,
    now,
    now,
  ]).run();
  const row = await getApi(db, id);
  if (!row) throw new ExtraError(500, "创建后读取失败");
  return row;
}

export async function updateApi(db: D1Database, id: string, input: Record<string, unknown>, now: number): Promise<ApiRow> {
  const row = await getApi(db, id);
  if (!row) throw new ExtraError(404, "API 不存在");
  const next: ApiRow = { ...row };
  if (Object.prototype.hasOwnProperty.call(input, "name")) next.name = readName(input.name);
  const baseUrl = readOptionalText(input, "base_url", 300, "端点");
  if (baseUrl !== undefined) {
    if (!baseUrl) throw new ExtraError(400, "请填写端点");
    next.base_url = baseUrl;
  }
  const authNote = readOptionalText(input, "auth_note", 64, "鉴权说明");
  if (authNote !== undefined) next.auth_note = authNote;
  const note = readOptionalText(input, "note", 300, "说明");
  if (note !== undefined) next.note = note;
  const status = readStatus(input, ["active", "disabled"]);
  if (status !== undefined) next.status = status;
  const groupId = await readGroupId(db, input);
  if (groupId !== undefined) next.group_id = groupId;
  await prepare(db, "UPDATE apis SET name = ?, base_url = ?, auth_note = ?, note = ?, status = ?, group_id = ?, updated_at = ? WHERE id = ?", [
    next.name,
    next.base_url,
    next.auth_note,
    next.note,
    next.status,
    next.group_id,
    now,
    id,
  ]).run();
  const fresh = await getApi(db, id);
  if (!fresh) throw new ExtraError(500, "保存后读取失败");
  return fresh;
}

export async function deleteApi(db: D1Database, id: string): Promise<void> {
  const row = await getApi(db, id);
  if (!row) throw new ExtraError(404, "API 不存在");
  await prepare(db, "DELETE FROM apis WHERE id = ?", [id]).run();
}
