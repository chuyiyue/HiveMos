// Soul module: one persona/behaviour document per agent, synced across
// devices. souls holds the current version; every write appends a full
// soul_versions row, so history is complete and a rollback is itself a new
// version (never an overwrite). Reads and writes from both the panel and
// MCP land in soul_audit, mirroring the calendar audit pattern.

import type { D1Database, D1PreparedStatement } from "./env";
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
  // active 是已生效版本；pending 由 Agent 经 MCP 写入、等管理员批准；
  // rejected 是管理员拒绝后保留的草稿。只有 active 能成为 souls.version。
  status: string | null;
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
    status: soulVersionStatus(row),
  };
}

export function soulVersionStatus(row: SoulVersionRow): string {
  return typeof row.status === "string" && row.status ? row.status : "active";
}

// ---------------------------------------------------------------------------
// Storage helpers.

interface AuditFields {
  soulId: string | null;
  agentName: string | null;
  actor: string;
  action: string;
  version: number | null;
}

async function audit(db: D1Database, fields: AuditFields, now: number): Promise<void> {
  await auditStatement(db, fields, now).run();
}

function auditStatement(db: D1Database, fields: AuditFields, now: number): D1PreparedStatement {
  return prepare(
    db,
    "INSERT INTO soul_audit (id, soul_id, agent_name, actor, action, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [newId("saud_"), fields.soulId, fields.agentName, fields.actor, fields.action, fields.version, now],
  );
}

// Same row, but only lands when the guarded version row really exists. Used
// inside the transactional writes below so a failed guard leaves no audit.
function auditGuardedStatement(db: D1Database, fields: AuditFields, now: number): D1PreparedStatement {
  return prepare(
    db,
    "INSERT INTO soul_audit (id, soul_id, agent_name, actor, action, version, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM soul_versions WHERE soul_id = ? AND version = ?)",
    [newId("saud_"), fields.soulId, fields.agentName, fields.actor, fields.action, fields.version, now, fields.soulId, fields.version],
  );
}

// D1 batch results carry per-statement row counts in meta.changes. A missing
// meta (or a different count than expected) means the version guard lost a
// race and the caller must answer 409 instead of pretending it wrote.
function batchChanges(result: unknown): number[] {
  if (!Array.isArray(result)) return [];
  return result.map((entry) => {
    const meta = entry && typeof entry === "object" ? (entry as { meta?: { changes?: unknown } }).meta : undefined;
    const changes = meta && typeof meta === "object" ? meta.changes : undefined;
    return typeof changes === "number" ? changes : -1;
  });
}

function assertBatchChanges(result: unknown, expected: number[], message: string): void {
  const changes = batchChanges(result);
  if (changes.length !== expected.length || changes.some((value, index) => value !== expected[index])) {
    throw new SoulError(409, message);
  }
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /UNIQUE constraint failed/i.test(message);
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

// New versions always take MAX(version)+1. souls.version is only the live
// pointer and may lag behind (pending drafts never advance it), so deriving
// the next number from it would collide with rows already on the list.
async function nextVersionNumber(db: D1Database, soulId: string): Promise<number> {
  const row = await prepare(
    db,
    "SELECT MAX(version) AS max_version FROM soul_versions WHERE soul_id = ?",
    [soulId],
  ).first<{ max_version: number | null }>();
  const max = row && row.max_version != null ? Number(row.max_version) : 0;
  return (Number.isFinite(max) ? max : 0) + 1;
}

function versionStatement(
  db: D1Database,
  soulId: string,
  version: number,
  content: string,
  source: string,
  actor: string,
  now: number,
  status: string,
  sortOrder: number,
): D1PreparedStatement {
  return prepare(
    db,
    "INSERT INTO soul_versions (id, soul_id, version, content, source, actor, created_at, label, sort_order, status) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
    [newId("sver_"), soulId, version, content, source, actor, now, sortOrder, status],
  );
}

// Guarded variant for active writes: the row is only inserted when the
// souls UPDATE in the same batch really advanced to this version.
function guardedVersionStatement(
  db: D1Database,
  soulId: string,
  version: number,
  content: string,
  source: string,
  actor: string,
  now: number,
  status: string,
  sortOrder: number,
): D1PreparedStatement {
  return prepare(
    db,
    "INSERT INTO soul_versions (id, soul_id, version, content, source, actor, created_at, label, sort_order, status) SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ?, ? WHERE EXISTS (SELECT 1 FROM souls WHERE id = ? AND version = ?)",
    [newId("sver_"), soulId, version, content, source, actor, now, sortOrder, status, soulId, version],
  );
}

async function insertVersion(
  db: D1Database,
  soulId: string,
  version: number,
  content: string,
  source: string,
  actor: string,
  now: number,
  status = "active",
): Promise<void> {
  const sortOrder = await frontSortOrder(db, soulId);
  await versionStatement(db, soulId, version, content, source, actor, now, status, sortOrder).run();
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

function readExpectedVersion(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new SoulError(400, "expected_version 需要是版本号");
  }
  return value;
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

export interface SoulWriteOptions {
  // MCP writes land as pending drafts; the panel keeps writing live.
  pending?: boolean;
  expectedVersion?: number | null;
}

// Shared by the panel PATCH and the MCP soul_update tool. Renaming alone
// does not bump the version; a content change always does. With pending set
// the new row waits for approval and souls.content/version stay untouched.
export async function updateSoul(
  db: D1Database,
  id: string,
  input: { agent_name?: unknown; content?: unknown },
  actor: string,
  source: string,
  now: number,
  options: SoulWriteOptions = {},
): Promise<SoulRow & { pending_version?: number; pending_status?: string }> {
  const row = await getSoulById(db, id);
  if (!row) throw new SoulError(404, "Soul 不存在");
  if (options.expectedVersion != null && options.expectedVersion !== row.version) {
    throw new SoulError(409, `Soul 版本已变化（当前版本 v${row.version}），请先读取最新版本再重试`);
  }
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
    const version = await nextVersionNumber(db, id);
    const sortOrder = await frontSortOrder(db, id);
    if (options.pending) {
      let result: unknown;
      try {
        result = await db.batch([
          versionStatement(db, id, version, content, source, actor, now, "pending", sortOrder),
          auditStatement(db, { soulId: id, agentName, actor, action: "update", version }, now),
        ]);
      } catch (error) {
        if (isUniqueViolation(error)) throw new SoulError(409, "这个版本号刚被其他写入占用，请重试");
        throw error;
      }
      assertBatchChanges(result, [1, 1], "草稿写入冲突，请重新读取后再写");
      const pendingSoul = await getSoulById(db, id);
      if (!pendingSoul) throw new SoulError(500, "保存后读取失败");
      return Object.assign(pendingSoul, { pending_version: version, pending_status: "pending" });
    }
    let result: unknown;
    try {
      result = await db.batch([
        prepare(db, "UPDATE souls SET agent_name = ?, content = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?", [
          agentName,
          content,
          version,
          now,
          id,
          row.version,
        ]),
        guardedVersionStatement(db, id, version, content, source, actor, now, "active", sortOrder),
        auditGuardedStatement(db, { soulId: id, agentName, actor, action: "update", version }, now),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new SoulError(409, "这个版本号刚被其他写入占用，请重试");
      throw error;
    }
    assertBatchChanges(result, [1, 1, 1], "Soul 当前版本已被其他写入更新，请刷新后重试");
  } else if (agentName !== row.agent_name) {
    await prepare(db, "UPDATE souls SET agent_name = ?, updated_at = ? WHERE id = ?", [agentName, now, id]).run();
  }
  const updated = await getSoulById(db, id);
  if (!updated) throw new SoulError(500, "保存后读取失败");
  return updated;
}

// A soul created by an agent is born empty (version 0, no active version):
// its first draft waits for approval like any other MCP write, so unreviewed
// content never reaches souls.content before a human says yes.
async function createPendingSoul(
  db: D1Database,
  agentName: string,
  contentRaw: unknown,
  actor: string,
  source: string,
  now: number,
): Promise<SoulRow & { pending_version: number; pending_status: string }> {
  const content = readContent(contentRaw);
  const id = newId("soul_");
  let result: unknown;
  try {
    result = await db.batch([
      prepare(
        db,
        "INSERT INTO souls (id, agent_name, content, version, created_at, updated_at) VALUES (?, ?, '', 0, ?, ?)",
        [id, agentName, now, now],
      ),
      versionStatement(db, id, 1, content, source, actor, now, "pending", 0),
      auditStatement(db, { soulId: id, agentName, actor, action: "create", version: 1 }, now),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new SoulError(409, "这个 Agent 名刚被其他写入占用，请重新读取后再写");
    throw error;
  }
  assertBatchChanges(result, [1, 1, 1], "草稿写入冲突，请重新读取后再写");
  const created = await getSoulById(db, id);
  if (!created) throw new SoulError(500, "创建后读取失败");
  return Object.assign(created, { pending_version: 1, pending_status: "pending" });
}

// MCP soul_update addresses a soul by agent name and creates it on first
// write, so an agent can push its persona without a panel round-trip. Every
// write lands as a pending draft; expected_version turns a stale write into
// a 409 instead of silently overwriting whatever the agent has not seen.
export async function upsertSoulByName(
  db: D1Database,
  agentNameRaw: unknown,
  contentRaw: unknown,
  expectedVersionRaw: unknown,
  actor: string,
  source: string,
  now: number,
): Promise<SoulRow & { pending_version?: number; pending_status?: string }> {
  const agentName = readAgentName(agentNameRaw);
  const expectedVersion = readExpectedVersion(expectedVersionRaw);
  const existing = await getSoulByName(db, agentName);
  if (!existing) {
    const current = 0;
    if (expectedVersion !== null && expectedVersion !== current) {
      throw new SoulError(409, `Soul 版本已变化（当前版本 v${current}），请先读取最新版本再重试`);
    }
    return createPendingSoul(db, agentName, contentRaw, actor, source, now);
  }
  return updateSoul(
    db,
    existing.id,
    { content: contentRaw },
    actor,
    source,
    now,
    { pending: true, expectedVersion },
  );
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
  // Pending drafts and rejected rows were never live, so rolling back to
  // them would launder an unapproved document into the current version.
  if (soulVersionStatus(target) !== "active") {
    throw new SoulError(409, "只能回滚到已生效的版本，待批准或已拒绝的版本不能回滚");
  }
  const version = await nextVersionNumber(db, id);
  const sortOrder = await frontSortOrder(db, id);
  let result: unknown;
  try {
    result = await db.batch([
      prepare(db, "UPDATE souls SET content = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?", [
        target.content,
        version,
        now,
        id,
        row.version,
      ]),
      guardedVersionStatement(db, id, version, target.content, "rollback", actor, now, "active", sortOrder),
      auditGuardedStatement(db, { soulId: id, agentName: row.agent_name, actor, action: "rollback", version }, now),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new SoulError(409, "这个版本号刚被其他写入占用，请重试");
    throw error;
  }
  assertBatchChanges(result, [1, 1, 1], "Soul 当前版本已被其他写入更新，请刷新后重试");
  const updated = await getSoulById(db, id);
  if (!updated) throw new SoulError(500, "回滚后读取失败");
  return updated;
}

// Approval is the only path that turns a pending draft into the live
// version. The souls UPDATE is guarded by the version the caller saw, and
// the status flip only lands when that guard advanced, so a lost race
// leaves no half-approved state behind.
export async function approveSoulVersion(
  db: D1Database,
  soulId: string,
  version: number,
  actor: string,
  now: number,
): Promise<SoulRow> {
  const soul = await getSoulById(db, soulId);
  if (!soul) throw new SoulError(404, "Soul 不存在");
  const row = await getVersion(db, soulId, version);
  if (!row) throw new SoulError(404, "这个版本不存在");
  if (soulVersionStatus(row) !== "pending") throw new SoulError(409, "只有待批准的版本可以批准");
  const result = await db.batch([
    prepare(
      db,
      "UPDATE souls SET content = ?, version = ?, updated_at = ? WHERE id = ? AND version = ? AND EXISTS (SELECT 1 FROM soul_versions WHERE soul_id = ? AND version = ? AND status = 'pending')",
      [row.content, version, now, soulId, soul.version, soulId, version],
    ),
    prepare(
      db,
      "UPDATE soul_versions SET status = 'active' WHERE soul_id = ? AND version = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM souls WHERE id = ? AND version = ?)",
      [soulId, version, soulId, version],
    ),
    prepare(
      db,
      "INSERT INTO soul_audit (id, soul_id, agent_name, actor, action, version, created_at) SELECT ?, ?, ?, ?, 'update', ?, ? WHERE EXISTS (SELECT 1 FROM souls WHERE id = ? AND version = ?) AND EXISTS (SELECT 1 FROM soul_versions WHERE soul_id = ? AND version = ? AND status = 'active')",
      [newId("saud_"), soulId, soul.agent_name, actor, version, now, soulId, version, soulId, version],
    ),
  ]);
  assertBatchChanges(result, [1, 1, 1], "Soul 当前版本已被其他写入更新，请刷新后重试");
  const updated = await getSoulById(db, soulId);
  if (!updated) throw new SoulError(500, "批准后读取失败");
  return updated;
}

// Rejection keeps the row for the audit trail; it just never becomes live.
export async function rejectSoulVersion(
  db: D1Database,
  soulId: string,
  version: number,
  actor: string,
  now: number,
): Promise<{ agentName: string; version: number }> {
  const soul = await getSoulById(db, soulId);
  if (!soul) throw new SoulError(404, "Soul 不存在");
  const row = await getVersion(db, soulId, version);
  if (!row) throw new SoulError(404, "这个版本不存在");
  if (soulVersionStatus(row) !== "pending") throw new SoulError(409, "只有待批准的版本可以拒绝");
  const result = await db.batch([
    prepare(db, "UPDATE soul_versions SET status = 'rejected' WHERE soul_id = ? AND version = ? AND status = 'pending'", [
      soulId,
      version,
    ]),
    prepare(
      db,
      "INSERT INTO soul_audit (id, soul_id, agent_name, actor, action, version, created_at) SELECT ?, ?, ?, ?, 'update', ?, ? WHERE EXISTS (SELECT 1 FROM soul_versions WHERE soul_id = ? AND version = ? AND status = 'rejected')",
      [newId("saud_"), soulId, soul.agent_name, actor, version, now, soulId, version],
    ),
  ]);
  assertBatchChanges(result, [1, 1], "这个版本刚被其他操作处理过，请刷新后重试");
  return { agentName: soul.agent_name, version };
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
