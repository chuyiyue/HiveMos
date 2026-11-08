// Soul module: one persona/behaviour document per agent, synced across
// devices. souls holds the current version; every write appends a full
// soul_versions row, so history is complete and a rollback is itself a new
// version (never an overwrite). Reads and writes from both the panel and
// MCP land in soul_audit, mirroring the calendar audit pattern.

import type { D1Database } from "./env";
import { prepare } from "./registry";

export class SoulError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface SoulRow {
  id: string;
  agent_name: string;
  content: string;
  version: number;
  ai_status: string | null;
  ai_summary: string | null;
  created_at: number;
  updated_at: number;
}

export interface SoulVersionRow {
  id: string;
  soul_id: string;
  version: number;
  content: string;
  source: string;
  actor: string | null;
  created_at: number;
  // Empty label means the panel shows the default name (version + time).
  label: string | null;
  // Lower comes first. Ties break by version descending, so untouched rows
  // (all 0) stay newest-first. Display order only — not the live version.
  sort_order: number;
}

const MAX_NAME_CHARS = 80;
const MAX_LABEL_CHARS = 80;
const MAX_CONTENT_CHARS = 256 * 1024;

function rowsOf<T>(value: { results?: T[] } | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.results)) return value.results;
  return [];
}

function newId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return prefix + hex;
}

export function soulSummary(row: SoulRow): Record<string, unknown> {
  return {
    id: row.id,
    agent_name: row.agent_name,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function soulDetail(row: SoulRow): Record<string, unknown> {
  return { ...soulSummary(row), content: row.content };
}

function sortOrderOf(row: SoulVersionRow): number {
  const value = Number(row.sort_order);
  return Number.isFinite(value) ? value : 0;
}

export function soulVersionPublic(row: SoulVersionRow): Record<string, unknown> {
  const label = typeof row.label === "string" ? row.label.trim() : "";
  return {
    version: row.version,
    content: row.content,
    source: row.source,
    actor: row.actor,
    created_at: row.created_at,
    label: label || null,
    sort_order: sortOrderOf(row),
  };
}

// ---------------------------------------------------------------------------
// Storage helpers.

async function audit(
  db: D1Database,
  fields: { soulId: string | null; agentName: string | null; actor: string; action: string; version: number | null },
  now: number,
): Promise<void> {
  await prepare(
    db,
    "INSERT INTO soul_audit (id, soul_id, agent_name, actor, action, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [newId("saud_"), fields.soulId, fields.agentName, fields.actor, fields.action, fields.version, now],
  ).run();
}

// One less than the current minimum, so a newly written version sorts to
// the front without renumbering the rows already on the list. The label
// stays null: the panel shows the default name until someone renames it.
async function frontSortOrder(db: D1Database, soulId: string): Promise<number> {
  const row = await prepare(
    db,
    "SELECT MIN(sort_order) AS min_sort FROM soul_versions WHERE soul_id = ?",
    [soulId],
  ).first<{ min_sort: number | null }>();
  if (!row || row.min_sort == null) return 0;
  const min = Number(row.min_sort);
  if (!Number.isFinite(min)) return 0;
  return min - 1;
}

async function insertVersion(
  db: D1Database,
  soulId: string,
  version: number,
  content: string,
  source: string,
  actor: string,
  now: number,
): Promise<void> {
  const sortOrder = await frontSortOrder(db, soulId);
  await prepare(
    db,
    "INSERT INTO soul_versions (id, soul_id, version, content, source, actor, created_at, label, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
    [newId("sver_"), soulId, version, content, source, actor, now, sortOrder],
  ).run();
}

function readAgentName(value: unknown): string {
  if (typeof value !== "string") throw new SoulError(400, "请填写 Agent 名");
  const name = value.trim();
  if (!name || name.length > MAX_NAME_CHARS) throw new SoulError(400, "Agent 名需要 1 到 80 个字符");
  return name;
}

function readContent(value: unknown): string {
  if (value == null) return "";
  if (typeof value !== "string") throw new SoulError(400, "内容格式不正确");
  if (value.length > MAX_CONTENT_CHARS) throw new SoulError(400, "内容过长");
  return value;
}

// null clears the custom name and the panel falls back to the default.
function readLabel(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new SoulError(400, "名称格式不正确");
  const label = value.trim();
  if (!label) return null;
  if (label.length > MAX_LABEL_CHARS) throw new SoulError(400, "名称需要 1 到 80 个字符");
  return label;
}

function readDirection(value: unknown): "up" | "down" {
  if (value === "up" || value === "down") return value;
  throw new SoulError(400, "请指定上移或下移");
}

export async function listSouls(db: D1Database): Promise<SoulRow[]> {
  const listed = await prepare(db, "SELECT * FROM souls ORDER BY updated_at DESC, id ASC").all<SoulRow>();
  return rowsOf(listed);
}

export async function getSoulById(db: D1Database, id: string): Promise<SoulRow | null> {
  return prepare(db, "SELECT * FROM souls WHERE id = ?", [id]).first<SoulRow>();
}

export async function getSoulByName(db: D1Database, agentName: string): Promise<SoulRow | null> {
  return prepare(db, "SELECT * FROM souls WHERE agent_name = ?", [agentName]).first<SoulRow>();
}

export async function listVersions(db: D1Database, soulId: string): Promise<SoulVersionRow[]> {
  const listed = await prepare(
    db,
    "SELECT * FROM soul_versions WHERE soul_id = ? ORDER BY sort_order ASC, version DESC",
    [soulId],
  ).all<SoulVersionRow>();
  return rowsOf(listed);
}

export async function getVersion(db: D1Database, soulId: string, version: number): Promise<SoulVersionRow | null> {
  return prepare(db, "SELECT * FROM soul_versions WHERE soul_id = ? AND version = ?", [soulId, version]).first<SoulVersionRow>();
}

// ---------------------------------------------------------------------------
// Writes. Every content write bumps souls.version and appends a history row.

export async function createSoul(
  db: D1Database,
  input: { agent_name?: unknown; content?: unknown },
  actor: string,
  source: string,
  now: number,
): Promise<SoulRow> {
  const agentName = readAgentName(input.agent_name);
  const content = readContent(input.content);
  const existing = await getSoulByName(db, agentName);
  if (existing) throw new SoulError(409, "这个 Agent 已经有 Soul，不能重复新建");
  const id = newId("soul_");
  await prepare(
    db,
    "INSERT INTO souls (id, agent_name, content, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    [id, agentName, content, now, now],
  ).run();
  await insertVersion(db, id, 1, content, source, actor, now);
  await audit(db, { soulId: id, agentName, actor, action: "create", version: 1 }, now);
  const created = await getSoulById(db, id);
  if (!created) throw new SoulError(500, "创建后读取失败");
  return created;
}

// Shared by the panel PATCH and the MCP soul_update tool. Renaming alone
// does not bump the version; a content change always does.
export async function updateSoul(
  db: D1Database,
  id: string,
  input: { agent_name?: unknown; content?: unknown },
  actor: string,
  source: string,
  now: number,
): Promise<SoulRow> {
  const row = await getSoulById(db, id);
  if (!row) throw new SoulError(404, "Soul 不存在");
  let agentName = row.agent_name;
  if (input.agent_name !== undefined) {
    agentName = readAgentName(input.agent_name);
    if (agentName !== row.agent_name) {
      const clash = await getSoulByName(db, agentName);
      if (clash && clash.id !== id) throw new SoulError(409, "这个 Agent 名已经被占用");
    }
  }
  const hasContent = input.content !== undefined;
  const content = hasContent ? readContent(input.content) : row.content;
  if (hasContent && content !== row.content) {
    const version = row.version + 1;
    await prepare(db, "UPDATE souls SET agent_name = ?, content = ?, version = ?, updated_at = ? WHERE id = ?", [
      agentName,
      content,
      version,
      now,
      id,
    ]).run();
    await insertVersion(db, id, version, content, source, actor, now);
    await audit(db, { soulId: id, agentName, actor, action: "update", version }, now);
  } else if (agentName !== row.agent_name) {
    await prepare(db, "UPDATE souls SET agent_name = ?, updated_at = ? WHERE id = ?", [agentName, now, id]).run();
  }
  const updated = await getSoulById(db, id);
  if (!updated) throw new SoulError(500, "保存后读取失败");
  return updated;
}

// MCP soul_update addresses a soul by agent name and creates it on first
// write, so an agent can push its persona without a panel round-trip.
export async function upsertSoulByName(
  db: D1Database,
  agentNameRaw: unknown,
  contentRaw: unknown,
  actor: string,
  source: string,
  now: number,
): Promise<SoulRow> {
  const agentName = readAgentName(agentNameRaw);
  const existing = await getSoulByName(db, agentName);
  if (!existing) return createSoul(db, { agent_name: agentName, content: contentRaw }, actor, source, now);
  return updateSoul(db, existing.id, { content: contentRaw }, actor, source, now);
}

export async function rollbackSoul(
  db: D1Database,
  id: string,
  targetVersion: unknown,
  actor: string,
  now: number,
): Promise<SoulRow> {
  const row = await getSoulById(db, id);
  if (!row) throw new SoulError(404, "Soul 不存在");
  if (typeof targetVersion !== "number" || !Number.isInteger(targetVersion) || targetVersion < 1) {
    throw new SoulError(400, "请提供要回滚到的版本号");
  }
  const target = await getVersion(db, id, targetVersion);
  if (!target) throw new SoulError(404, "这个版本不存在");
  const version = row.version + 1;
  await prepare(db, "UPDATE souls SET content = ?, version = ?, updated_at = ? WHERE id = ?", [
    target.content,
    version,
    now,
    id,
  ]).run();
  await insertVersion(db, id, version, target.content, "rollback", actor, now);
  await audit(db, { soulId: id, agentName: row.agent_name, actor, action: "rollback", version }, now);
  const updated = await getSoulById(db, id);
  if (!updated) throw new SoulError(500, "回滚后读取失败");
  return updated;
}

// Rename and in-place content edit. Neither bumps souls.version nor inserts
// a history row. Editing the live version also writes souls.content, so the
// entry and its current history row stay one copy of the same text.
export async function updateSoulVersion(
  db: D1Database,
  soulId: string,
  version: number,
  input: { label?: unknown; content?: unknown },
  now: number,
): Promise<{ soul: SoulRow; version: SoulVersionRow; contentChanged: boolean }> {
  const soul = await getSoulById(db, soulId);
  if (!soul) throw new SoulError(404, "Soul 不存在");
  const row = await getVersion(db, soulId, version);
  if (!row) throw new SoulError(404, "这个版本不存在");
  const hasLabel = input.label !== undefined;
  const hasContent = input.content !== undefined;
  if (!hasLabel && !hasContent) throw new SoulError(400, "没有要保存的内容");

  const label = hasLabel ? readLabel(input.label) : row.label ?? null;
  const content = hasContent ? readContent(input.content) : row.content;
  const labelChanged = hasLabel && label !== (row.label ?? null);
  const contentChanged = hasContent && content !== row.content;
  if (labelChanged || contentChanged) {
    const statements = [
      prepare(db, "UPDATE soul_versions SET label = ?, content = ? WHERE soul_id = ? AND version = ?", [
        label,
        content,
        soulId,
        version,
      ]),
    ];
    if (contentChanged && version === soul.version) {
      statements.push(
        prepare(db, "UPDATE souls SET content = ?, updated_at = ? WHERE id = ? AND version = ?", [
          content,
          now,
          soulId,
          version,
        ]),
      );
    }
    await db.batch(statements);
  }
  const updatedSoul = await getSoulById(db, soulId);
  const updatedVersion = await getVersion(db, soulId, version);
  if (!updatedSoul || !updatedVersion) throw new SoulError(500, "保存后读取失败");
  return { soul: updatedSoul, version: updatedVersion, contentChanged };
}

export async function deleteSoulVersion(
  db: D1Database,
  soulId: string,
  version: number,
): Promise<{ agentName: string; version: number }> {
  const soul = await getSoulById(db, soulId);
  if (!soul) throw new SoulError(404, "Soul 不存在");
  const row = await getVersion(db, soulId, version);
  if (!row) throw new SoulError(404, "这个版本不存在");
  const versions = await listVersions(db, soulId);
  if (versions.length <= 1) throw new SoulError(400, "至少保留一个版本");
  if (version === soul.version) {
    throw new SoulError(400, "当前生效版本不能删除，请先回滚到其他版本再删");
  }
  await prepare(db, "DELETE FROM soul_versions WHERE soul_id = ? AND version = ?", [soulId, version]).run();
  return { agentName: soul.agent_name, version };
}

// Swaps with the neighbour in display order, then rewrites sort_order as
// 0..n-1. The live version number and souls.version are left alone.
export async function moveSoulVersion(
  db: D1Database,
  soulId: string,
  version: number,
  directionRaw: unknown,
): Promise<{ versions: SoulVersionRow[]; currentVersion: number }> {
  const soul = await getSoulById(db, soulId);
  if (!soul) throw new SoulError(404, "Soul 不存在");
  const direction = readDirection(directionRaw);
  const versions = await listVersions(db, soulId);
  const index = versions.findIndex((entry) => entry.version === version);
  if (index < 0) throw new SoulError(404, "这个版本不存在");
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= versions.length) {
    return { versions, currentVersion: soul.version };
  }
  const next = versions.slice();
  const current = next[index];
  const neighbor = next[target];
  if (!current || !neighbor) return { versions, currentVersion: soul.version };
  next[index] = neighbor;
  next[target] = current;
  await db.batch(
    next.map((entry, order) =>
      prepare(db, "UPDATE soul_versions SET sort_order = ? WHERE soul_id = ? AND version = ?", [
        order,
        soulId,
        entry.version,
      ]),
    ),
  );
  const listed = await listVersions(db, soulId);
  return { versions: listed, currentVersion: soul.version };
}

export async function deleteSoul(db: D1Database, id: string, actor: string, now: number): Promise<void> {
  const row = await getSoulById(db, id);
  if (!row) throw new SoulError(404, "Soul 不存在");
  await prepare(db, "DELETE FROM soul_versions WHERE soul_id = ?", [id]).run();
  await prepare(db, "DELETE FROM souls WHERE id = ?", [id]).run();
  await audit(db, { soulId: id, agentName: row.agent_name, actor, action: "delete", version: row.version }, now);
}

// MCP reads are audited like registry config fetches: knowing which agent
// pulled which persona, and when, is the point of the audit trail.
export async function recordSoulRead(db: D1Database, row: SoulRow, actor: string, version: number, now: number): Promise<void> {
  await audit(db, { soulId: row.id, agentName: row.agent_name, actor, action: "read", version }, now);
}
