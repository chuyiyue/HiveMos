// Memory module: memories on D1 with soft-delete tombstones, per-module
// audit (same shape as calendar_audit), and idempotent upsert keyed by id
// or by (title, scope). Panel and MCP share these functions; the channel
// decides whether reads are audited (MCP reads are, panel reads are not —
// the same split as mcp_get fetch audit vs panel browsing).

import { prepare } from "./registry";
import type { D1Database } from "./env";

function rowsOf<T>(value: { results?: T[] } | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.results)) return value.results;
  return [];
}

export class MemError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface MemoryRow {
  id: string;
  title: string;
  scope: string;
  content: string;
  source: string;
  tags_json: string | null;
  version: number;
  ai_summary: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface MemoryFields {
  title?: string;
  scope?: string;
  content?: string;
  tags?: string[];
}

const TITLE_MAX = 200;
const SCOPE_MAX = 40;
const CONTENT_MAX = 200 * 1024;
export const DEFAULT_SCOPE = "全局";

function newId(prefix: string): string {
  return prefix + "_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

export function parseTags(tagsJson: string | null): string[] {
  if (!tagsJson) return [];
  try {
    const value = JSON.parse(tagsJson) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

export function memoryPublic(row: MemoryRow): Record<string, unknown> {
  const view: Record<string, unknown> = {
    id: row.id,
    title: row.title,
    scope: row.scope,
    content: row.content,
    source: row.source,
    tags: parseTags(row.tags_json),
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (row.deleted_at != null) view.deleted_at = row.deleted_at;
  return view;
}

async function audit(
  db: D1Database,
  entry: { memoryId: string | null; actor: string; action: string; diff?: unknown },
  now: number,
): Promise<void> {
  await prepare(db, "INSERT INTO memory_audit (id, memory_id, actor, action, diff_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    newId("maud"),
    entry.memoryId,
    entry.actor,
    entry.action,
    entry.diff === undefined ? null : JSON.stringify(entry.diff),
    now,
  ]).run();
}

function cleanTitle(value: unknown): string {
  if (typeof value !== "string") throw new MemError("请填写标题");
  const title = value.trim();
  if (!title) throw new MemError("请填写标题");
  if (title.length > TITLE_MAX) throw new MemError("标题过长");
  return title;
}

function cleanScope(value: unknown): string {
  if (value == null) return DEFAULT_SCOPE;
  if (typeof value !== "string") throw new MemError("作用域格式不正确");
  const scope = value.trim();
  if (!scope) return DEFAULT_SCOPE;
  if (scope.length > SCOPE_MAX) throw new MemError("作用域过长");
  return scope;
}

function cleanContent(value: unknown): string {
  if (value == null) return "";
  if (typeof value !== "string") throw new MemError("内容格式不正确");
  if (value.length > CONTENT_MAX) throw new MemError("内容过长");
  return value;
}

function cleanTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new MemError("标签格式不正确");
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new MemError("标签格式不正确");
    const tag = item.trim();
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= 32) break;
  }
  return tags;
}

export async function getMemoryRow(db: D1Database, id: string, includeDeleted = false): Promise<MemoryRow | null> {
  const sql = includeDeleted
    ? "SELECT * FROM memories WHERE id = ?"
    : "SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL";
  const row = await prepare(db, sql, [id]).first<MemoryRow>();
  return row ?? null;
}

async function findActiveByTitleScope(db: D1Database, title: string, scope: string): Promise<MemoryRow | null> {
  const row = await prepare(db, "SELECT * FROM memories WHERE title = ? AND scope = ? AND deleted_at IS NULL", [title, scope]).first<MemoryRow>();
  return row ?? null;
}

export interface ListOptions {
  scope?: string | null;
  since?: number | null;
}

export async function listMemories(db: D1Database, options: ListOptions = {}): Promise<MemoryRow[]> {
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (options.since != null) {
    // Incremental pull: changed rows plus tombstones deleted after `since`,
    // so a syncing agent can drop what disappeared.
    where.push("(updated_at > ? OR (deleted_at IS NOT NULL AND deleted_at > ?))");
    values.push(options.since, options.since);
  } else {
    where.push("deleted_at IS NULL");
  }
  if (options.scope) {
    where.push("scope = ?");
    values.push(options.scope);
  }
  const sql = "SELECT * FROM memories WHERE " + where.join(" AND ") + " ORDER BY updated_at DESC LIMIT 500";
  const result = await prepare(db, sql, values).all<MemoryRow>();
  return rowsOf(result);
}

export async function searchMemories(db: D1Database, query: string, scope?: string | null): Promise<MemoryRow[]> {
  const like = "%" + query.replace(/[%_]/g, " ") + "%";
  const values: Array<string | number> = [like, like, like];
  let sql =
    "SELECT * FROM memories WHERE deleted_at IS NULL AND (title LIKE ? OR content LIKE ? OR tags_json LIKE ?) ";
  if (scope) {
    sql += "AND scope = ? ";
    values.push(scope);
  }
  sql += "ORDER BY updated_at DESC LIMIT 200";
  const result = await prepare(db, sql, values).all<MemoryRow>();
  return rowsOf(result);
}

interface Channel {
  actor: string;
  source: string; // 'panel' | 'mcp'
  auditReads: boolean;
}

export async function readMemory(db: D1Database, id: string, channel: Channel, now: number): Promise<MemoryRow | null> {
  const row = await getMemoryRow(db, id);
  if (row && channel.auditReads) {
    await audit(db, { memoryId: row.id, actor: channel.actor, action: "get", diff: { title: row.title, scope: row.scope, version: row.version } }, now);
  }
  return row;
}

export async function listMemoriesAudited(db: D1Database, options: ListOptions, channel: Channel, now: number): Promise<MemoryRow[]> {
  const rows = await listMemories(db, options);
  if (channel.auditReads) {
    await audit(db, { memoryId: null, actor: channel.actor, action: "list", diff: { scope: options.scope ?? null, since: options.since ?? null, count: rows.length } }, now);
  }
  return rows;
}

export async function searchMemoriesAudited(db: D1Database, query: string, scope: string | null, channel: Channel, now: number): Promise<MemoryRow[]> {
  const rows = await searchMemories(db, query, scope);
  if (channel.auditReads) {
    await audit(db, { memoryId: null, actor: channel.actor, action: "search", diff: { query, scope, count: rows.length } }, now);
  }
  return rows;
}

async function insertMemory(
  db: D1Database,
  fields: { title: string; scope: string; content: string; tags: string[] },
  channel: Channel,
  now: number,
): Promise<MemoryRow> {
  const id = newId("mem");
  await prepare(
    db,
    "INSERT INTO memories (id, title, scope, content, source, tags_json, version, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)",
    [id, fields.title, fields.scope, fields.content, channel.source, JSON.stringify(fields.tags), now, now],
  ).run();
  const row = await getMemoryRow(db, id);
  if (!row) throw new MemError("写入后读取失败", 500);
  await audit(db, { memoryId: id, actor: channel.actor, action: "create", diff: { title: row.title, scope: row.scope } }, now);
  return row;
}

export async function createMemory(db: D1Database, input: Record<string, unknown>, channel: Channel, now: number): Promise<MemoryRow> {
  const title = cleanTitle(input.title);
  const scope = cleanScope(input.scope);
  const content = cleanContent(input.content);
  const tags = cleanTags(input.tags) ?? [];
  const existing = await findActiveByTitleScope(db, title, scope);
  if (existing) throw new MemError("同一作用域下已存在同名记忆，请改标题或用编辑", 409);
  return insertMemory(db, { title, scope, content, tags }, channel, now);
}

async function applyUpdate(
  db: D1Database,
  row: MemoryRow,
  fields: { title: string; scope: string; content: string; tags: string[] },
  channel: Channel,
  action: string,
  now: number,
): Promise<MemoryRow> {
  await prepare(
    db,
    "UPDATE memories SET title = ?, scope = ?, content = ?, tags_json = ?, version = version + 1, updated_at = ?, deleted_at = NULL WHERE id = ?",
    [fields.title, fields.scope, fields.content, JSON.stringify(fields.tags), now, row.id],
  ).run();
  const updated = await getMemoryRow(db, row.id);
  if (!updated) throw new MemError("写入后读取失败", 500);
  await audit(db, { memoryId: row.id, actor: channel.actor, action, diff: { title: updated.title, scope: updated.scope, version: updated.version } }, now);
  return updated;
}

// Idempotent write: by id when one is given (a soft-deleted row is revived),
// otherwise by (title, scope). Creates when nothing matches.
export async function upsertMemory(db: D1Database, input: Record<string, unknown>, channel: Channel, now: number): Promise<MemoryRow> {
  const title = cleanTitle(input.title);
  const scope = cleanScope(input.scope);
  const content = cleanContent(input.content);
  const tags = cleanTags(input.tags);
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : null;
  let target: MemoryRow | null = null;
  if (id) target = await getMemoryRow(db, id, true);
  if (!target) target = await findActiveByTitleScope(db, title, scope);
  if (!target) {
    return insertMemory(db, { title, scope, content, tags: tags ?? [] }, channel, now);
  }
  // Changing title/scope onto another active row's key would break the
  // unique index; surface it instead of failing the write opaquely.
  if (target.title !== title || target.scope !== scope) {
    const clash = await findActiveByTitleScope(db, title, scope);
    if (clash && clash.id !== target.id) throw new MemError("同一作用域下已存在同名记忆", 409);
  }
  return applyUpdate(
    db,
    target,
    { title, scope, content, tags: tags ?? parseTags(target.tags_json) },
    channel,
    target.deleted_at != null ? "upsert_revive" : "upsert",
    now,
  );
}

export async function updateMemory(db: D1Database, id: string, input: Record<string, unknown>, channel: Channel, now: number): Promise<MemoryRow> {
  const row = await getMemoryRow(db, id);
  if (!row) throw new MemError("记忆不存在或已删除", 404);
  const title = input.title === undefined ? row.title : cleanTitle(input.title);
  const scope = input.scope === undefined ? row.scope : cleanScope(input.scope);
  const content = input.content === undefined ? row.content : cleanContent(input.content);
  const tags = cleanTags(input.tags) ?? parseTags(row.tags_json);
  if (title !== row.title || scope !== row.scope) {
    const clash = await findActiveByTitleScope(db, title, scope);
    if (clash && clash.id !== row.id) throw new MemError("同一作用域下已存在同名记忆", 409);
  }
  return applyUpdate(db, row, { title, scope, content, tags }, channel, "update", now);
}

export async function deleteMemory(db: D1Database, id: string, channel: Channel, now: number): Promise<MemoryRow> {
  const row = await getMemoryRow(db, id);
  if (!row) throw new MemError("记忆不存在或已删除", 404);
  await prepare(db, "UPDATE memories SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?", [now, now, id]).run();
  const deleted = await getMemoryRow(db, id, true);
  if (!deleted) throw new MemError("写入后读取失败", 500);
  await audit(db, { memoryId: id, actor: channel.actor, action: "delete", diff: { title: row.title, scope: row.scope } }, now);
  return deleted;
}
