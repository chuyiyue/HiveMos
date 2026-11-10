// Memory module: memories on D1 with soft-delete tombstones, per-module
// audit (same shape as calendar_audit), and idempotent upsert keyed by id
// or by (title, scope). Panel and MCP share these functions; the channel
// decides whether reads are audited (MCP reads are, panel reads are not —
// the same split as mcp_get fetch audit vs panel browsing).

import { prepare } from "./registry";
import type { D1Database, Env, WaitCtx } from "./env";
import { readChatResponse, resolveAiModel } from "./ai-model";
import type { D1Database, Env } from "./env";
import { markMemoryVectorDirty, rrfFuse, vectorSearchIds } from "./memory-vector";

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
  group_id: string | null;
  pinned_at: number | null;
  weight: number;
  ai_state: string;
  kind: string | null;
  agent_name: string | null;
  expires_at: number | null;
  last_accessed_at: number | null;
  access_count: number;
  content_hash: string | null;
  supersedes_id: string | null;
  invalidated: number;
  ai_pending_at: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface MemoryFields {
  title?: string;
  scope?: string;
  content?: string;
  tags?: string[];
  group_id?: string | null;
  pinned?: boolean;
  weight?: number;
  kind?: string | null;
  agent_name?: string | null;
  expires_at?: number | null;
  supersedes_id?: string | null;
}

const TITLE_MAX = 200;
const DERIVED_TITLE_MAX = 60;
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

// 标签等价的判定口径：trim + 折叠空白 + 大小写不敏感。打标复用、
// 存量近义合并、normalize 都走这一个 key。
export function normalizeTagKey(tag: string): string {
  return tag.trim().replace(/\s+/g, " ").toLowerCase();
}

// 全站标签总量上限（按归一 key 去重）。AI 打标、手动保存、合并收敛都以此为
// 唯一口径；前端 public/memory-soul.js 里有一份同值常量，改动时一起改。
export const MAX_MEMORY_TAGS = 30;

export interface MemoryTagStat {
  name: string;
  count: number;
}

// 未删除记忆的标签汇总：按归一 key 去重、累计条数；写法取最近更新过的
// 那条记忆里的样子，排序按使用次数降序（同频按名称），方便提示词优先
// 复用高频标签。读取不加 LIMIT，标签库与合并都看全量。
export async function listMemoryTagStats(db: D1Database): Promise<MemoryTagStat[]> {
  const result = await prepare(
    db,
    "SELECT tags_json FROM memories WHERE deleted_at IS NULL ORDER BY updated_at DESC",
  ).all<{ tags_json: string | null }>();
  const rows = rowsOf(result);
  const byKey = new Map<string, MemoryTagStat>();
  for (const row of rows) {
    const seenInRow = new Set<string>();
    for (const tag of parseTags(row.tags_json)) {
      const key = normalizeTagKey(tag);
      if (!key || seenInRow.has(key)) continue;
      seenInRow.add(key);
      const found = byKey.get(key);
      if (found) found.count++;
      else byKey.set(key, { name: tag.trim().replace(/\s+/g, " "), count: 1 });
    }
  }
  return Array.from(byKey.values()).sort((a, b) =>
    b.count !== a.count ? b.count - a.count : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

export async function listMemoryTags(db: D1Database): Promise<string[]> {
  return (await listMemoryTagStats(db)).map((stat) => stat.name);
}

// 手动保存（创建/更新/upsert）前的标签总量校验：只有「本次新引入的库外
// 标签」会占额度，库内已有标签永远放行；编辑时记忆自带的标签不算新引入。
// 允许用「本条记忆不再使用、且全库只此一条使用」的标签腾出额度。
export async function assertTagCapacity(
  db: D1Database,
  proposed: string[],
  previous: string[] = [],
): Promise<void> {
  const stats = await listMemoryTagStats(db);
  const library = new Map<string, number>();
  for (const stat of stats) library.set(normalizeTagKey(stat.name), stat.count);
  const previousKeys = new Set(previous.map(normalizeTagKey).filter(Boolean));
  const proposedKeys = new Set(proposed.map(normalizeTagKey).filter(Boolean));
  let additions = 0;
  for (const key of proposedKeys) {
    if (library.has(key) || previousKeys.has(key)) continue;
    additions++;
  }
  if (additions === 0) return;
  let freed = 0;
  for (const key of previousKeys) {
    if (proposedKeys.has(key)) continue;
    if (library.has(key) && (library.get(key) ?? 0) <= 1) freed++;
  }
  if (stats.length - freed + additions > MAX_MEMORY_TAGS) {
    throw new MemError("标签总数已达上限 " + MAX_MEMORY_TAGS + "，请选用已有标签或先合并标签", 400);
  }
}

// 合并写入前的全量读取：不能走 listMemories 的 500 条上限。
export async function listAllActiveMemories(db: D1Database): Promise<MemoryRow[]> {
  const result = await prepare(
    db,
    "SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY updated_at DESC",
  ).all<MemoryRow>();
  return rowsOf(result);
}

// 合并映射算完后的统一落库：只改 tags_json / version / updated_at，
// 不裁标签数量，也不动 ai_state 与内容。分批 batch，避免单次语句过多。
export async function rewriteMemoryTags(
  db: D1Database,
  updates: Array<{ id: string; tags: string[] }>,
  now: number,
): Promise<number> {
  let written = 0;
  for (let offset = 0; offset < updates.length; offset += 50) {
    const chunk = updates.slice(offset, offset + 50);
    await db.batch(
      chunk.map((entry) =>
        prepare(db, "UPDATE memories SET tags_json = ?, version = version + 1, updated_at = ? WHERE id = ?", [
          JSON.stringify(entry.tags),
          now,
          entry.id,
        ]),
      ),
    );
    written += chunk.length;
  }
  return written;
}

export function memoryPublic(row: MemoryRow): Record<string, unknown> {
  const view: Record<string, unknown> = {
    id: row.id,
    title: row.title,
    scope: row.scope,
    content: row.content,
    source: row.source,
    tags: parseTags(row.tags_json),
    group_id: row.group_id ?? null,
    pinned: row.pinned_at != null,
    pinned_at: row.pinned_at ?? null,
    weight: typeof row.weight === "number" ? row.weight : 0,
    ai_state: row.ai_state || "none",
    ai_summary: row.ai_summary ?? null,
    kind: row.kind ?? null,
    agent_name: row.agent_name ?? null,
    expires_at: row.expires_at ?? null,
    expired: row.expires_at != null && row.expires_at <= Date.now(),
    invalidated: row.invalidated === 1,
    supersedes_id: row.supersedes_id ?? null,
    last_accessed_at: row.last_accessed_at ?? null,
    access_count: typeof row.access_count === "number" ? row.access_count : 0,
    ai_pending_at: row.ai_pending_at ?? null,
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

// 没有标题时取正文开头。ingest 拆分与 memory_remember 共用同一口径。
export function deriveMemoryTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return (flat.slice(0, DERIVED_TITLE_MAX) || "未命名记忆").trim();
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

// 权重与置顶分开校验。置顶不是「权重最高一档」，校验结果也不会改写另一个字段。
function cleanWeight(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new MemError("权重格式不正确");
  const weight = Math.floor(value);
  if (weight < 0 || weight > 100) throw new MemError("权重需在 0 到 100 之间");
  return weight;
}

function cleanPinned(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new MemError("置顶格式不正确");
  return value;
}

// undefined = 不改动，null 或空串 = 清除分组，字符串 = 目标分组 id（存在性另行校验）
function cleanGroupId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new MemError("分组格式不正确");
  const groupId = value.trim();
  return groupId ? groupId : null;
}

// ---------------------------------------------------------------------------
// 生命周期（P2）：kind / agent_name / expires_at / supersedes_id 的入参清洗、
// content_hash 精确去重。hash 规范化口径：标题 trim、正文统一换行并 trim，
// 以 "\n" 连接后取 SHA-256 hex；标题或正文任一变化都会得到不同 hash。

export const MEMORY_KINDS = ["fact", "preference", "procedure", "episode"];

function cleanKind(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new MemError("kind 格式不正确");
  const kind = value.trim();
  if (!kind) return null;
  if (!MEMORY_KINDS.includes(kind)) throw new MemError("kind 只能是 fact、preference、procedure、episode");
  return kind;
}

function cleanAgentNameField(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new MemError("agent_name 格式不正确");
  const name = value.trim();
  if (!name) return null;
  if (name.length > 80) throw new MemError("agent_name 过长");
  return name;
}

function cleanExpiresAt(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new MemError("expires_at 格式不正确");
}

function cleanSupersedesId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new MemError("supersedes_id 格式不正确");
  const id = value.trim();
  return id ? id : null;
}

export async function computeContentHash(title: string, content: string): Promise<string> {
  const normalized = title.trim() + "\n" + content.replace(/\r\n?/g, "\n").trim();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// 精确去重键：同 scope + 同 agent_name（NULL 用 IS 做空值安全比较）、
// 未删除未失效的同 hash 记忆。命中即视为同一条，不再重复插入。
async function findActiveByContentHash(
  db: D1Database,
  scope: string,
  agentName: string | null,
  hash: string,
): Promise<MemoryRow | null> {
  const row = await prepare(
    db,
    "SELECT * FROM memories WHERE content_hash = ? AND scope = ? AND agent_name IS ? AND deleted_at IS NULL AND invalidated = 0",
    [hash, scope, agentName],
  ).first<MemoryRow>();
  return row ?? null;
}

const GROUP_NAME_MAX = 40;

function cleanGroupName(value: unknown): string {
  if (typeof value !== "string") throw new MemError("请填写分组名");
  const name = value.trim();
  if (!name) throw new MemError("请填写分组名");
  if (name.length > GROUP_NAME_MAX) throw new MemError("分组名过长");
  return name;
}

export interface MemoryGroupRow {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  count?: number;
}

export function memoryGroupPublic(row: MemoryGroupRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    count: typeof row.count === "number" ? row.count : 0,
  };
}

export async function listMemoryGroups(db: D1Database): Promise<MemoryGroupRow[]> {
  const result = await prepare(
    db,
    "SELECT g.*, (SELECT COUNT(*) FROM memories m WHERE m.group_id = g.id AND m.deleted_at IS NULL) AS count FROM memory_groups g ORDER BY g.created_at ASC",
    [],
  ).all<MemoryGroupRow>();
  return rowsOf(result);
}

export async function getMemoryGroup(db: D1Database, id: string): Promise<MemoryGroupRow | null> {
  const row = await prepare(db, "SELECT * FROM memory_groups WHERE id = ?", [id]).first<MemoryGroupRow>();
  return row ?? null;
}

async function findGroupByName(db: D1Database, name: string): Promise<MemoryGroupRow | null> {
  const row = await prepare(db, "SELECT * FROM memory_groups WHERE name = ?", [name]).first<MemoryGroupRow>();
  return row ?? null;
}

async function requireGroup(db: D1Database, groupId: string | null): Promise<void> {
  if (groupId == null) return;
  const group = await getMemoryGroup(db, groupId);
  if (!group) throw new MemError("分组不存在");
}

export async function createMemoryGroup(db: D1Database, input: Record<string, unknown>, now: number): Promise<MemoryGroupRow> {
  const name = cleanGroupName(input.name);
  if (await findGroupByName(db, name)) throw new MemError("已存在同名分组", 409);
  const id = newId("mgrp");
  await prepare(db, "INSERT INTO memory_groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", [id, name, now, now]).run();
  const row = await getMemoryGroup(db, id);
  if (!row) throw new MemError("写入后读取失败", 500);
  return { ...row, count: 0 };
}

export async function renameMemoryGroup(db: D1Database, id: string, input: Record<string, unknown>, now: number): Promise<MemoryGroupRow> {
  const group = await getMemoryGroup(db, id);
  if (!group) throw new MemError("分组不存在", 404);
  const name = cleanGroupName(input.name);
  const clash = await findGroupByName(db, name);
  if (clash && clash.id !== id) throw new MemError("已存在同名分组", 409);
  await prepare(db, "UPDATE memory_groups SET name = ?, updated_at = ? WHERE id = ?", [name, now, id]).run();
  const row = await getMemoryGroup(db, id);
  if (!row) throw new MemError("写入后读取失败", 500);
  return row;
}

// 删组只解绑不删记忆：组内记忆 group_id 置空回未分组，updated_at 一并刷新，
// 让 MCP 增量同步能感知到归属变化。
export async function deleteMemoryGroup(db: D1Database, id: string, now: number): Promise<void> {
  const group = await getMemoryGroup(db, id);
  if (!group) throw new MemError("分组不存在", 404);
  await prepare(db, "UPDATE memories SET group_id = NULL, updated_at = ? WHERE group_id = ?", [now, id]).run();
  await prepare(db, "DELETE FROM memory_groups WHERE id = ?", [id]).run();
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

export interface PageOptions {
  limit?: number | null;
  offset?: number | null;
}

export interface ListOptions extends PageOptions {
  scope?: string | null;
  since?: number | null;
  now?: number | null;
}

// 面板列表与 MCP 全量读取、搜索共用：先置顶组、后普通组；组内权重降序，再更新时间降序。
// 置顶是独立标记，不是权重的一档；权重只在组内比较。
const MEMORY_READ_ORDER = "(pinned_at IS NULL) ASC, weight DESC, updated_at DESC";

// 分页参数缺省时保持旧上限与从头读取；调用方多取一行探测下一页时允许再放宽一条。
function pageLimit(value: number | null | undefined, fallback: number, cap: number = fallback): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), cap);
}

function pageOffset(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
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
    // 默认视图只看活记忆：被取代（invalidated）与已过期的不进列表。
    // 增量（since）路径不走这里：失效行 updated_at 会变，同步方能感知。
    where.push("deleted_at IS NULL");
    where.push("invalidated = 0");
    where.push("(expires_at IS NULL OR expires_at > ?)");
    values.push(options.now ?? Date.now());
  }
  if (options.scope) {
    where.push("scope = ?");
    values.push(options.scope);
  }
  // 全量读取走 MEMORY_READ_ORDER。增量（since）保持更新时间序：游标只认 updated_at，不按展示序重排。
  const order = options.since != null ? "updated_at DESC" : MEMORY_READ_ORDER;
  const sql = "SELECT * FROM memories WHERE " + where.join(" AND ") + " ORDER BY " + order + " LIMIT ? OFFSET ?";
  values.push(pageLimit(options.limit, 500, 501), pageOffset(options.offset));
  const result = await prepare(db, sql, values).all<MemoryRow>();
  return rowsOf(result);
}

// 搜索排序公式（P1）：
//   score = 相关度 x (1 + weight/100) x 时间衰减
//   相关度 rel = 1 / (1 + e^bm25)：FTS5 的 bm25 越负越相关，sigmoid 把它
//     压进 (0, 1)——bm25 = 0 时 rel = 0.5，强命中时 rel 趋近 1。
//     bm25 按列加权：标题 10、正文 1、标签 5（列序同 memories_fts 定义）。
//   时间衰减 = 2^(-(now - updated_at) / 30 天)：每过 30 天减半。
// 置顶恒在最前（与列表读序一致的人工控制）；同分时权重降序、更新时间降序。
const SEARCH_DECAY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

interface FtsHit extends MemoryRow {
  fts_rank: number;
}

function searchScore(hit: FtsHit, now: number): number {
  const rel = 1 / (1 + Math.exp(hit.fts_rank));
  const age = Math.max(0, now - hit.updated_at);
  const decay = Math.pow(2, -age / SEARCH_DECAY_HALF_LIFE_MS);
  const weight = typeof hit.weight === "number" ? hit.weight : 0;
  return rel * (1 + weight / 100) * decay;
}

async function searchMemoriesFts(
  db: D1Database,
  query: string,
  scope: string | null | undefined,
  options: PageOptions,
): Promise<MemoryRow[] | null> {
  // 整串引号短语：trigram 下即子串匹配（如「验证码」命中「输入验证码后」）。
  const phrase = '"' + query.replace(/"/g, '""') + '"';
  const limit = pageLimit(options.limit, 200, 501);
  const offset = pageOffset(options.offset);
  const values: Array<string | number> = [phrase];
  let sql =
    "SELECT m.*, bm25(memories_fts, 10.0, 1.0, 5.0) AS fts_rank FROM memories_fts " +
    "JOIN memories m ON m.rowid = memories_fts.rowid " +
    "WHERE memories_fts MATCH ? AND m.deleted_at IS NULL ";
  if (scope) {
    sql += "AND m.scope = ? ";
    values.push(scope);
  }
  // 与 list/LIKE 同口径：被取代与已过期的记忆不进搜索结果。
  sql += "AND m.invalidated = 0 AND (m.expires_at IS NULL OR m.expires_at > ?) ";
  values.push(Date.now());
  // 候选窗口先按 bm25 取前 offset+limit 条，再按完整公式重排切页：
  // 公式里的衰减与权重不在 SQL 里算，窗口外的极弱命中本就进不了前列。
  sql += "ORDER BY fts_rank ASC LIMIT ?";
  values.push(offset + limit);
  const result = await prepare(db, sql, values).all<FtsHit>();
  const hits = rowsOf(result);
  if (hits.length === 0) return null;
  const now = Date.now();
  hits.sort((a, b) => {
    const pinnedA = a.pinned_at != null ? 0 : 1;
    const pinnedB = b.pinned_at != null ? 0 : 1;
    if (pinnedA !== pinnedB) return pinnedA - pinnedB;
    const byScore = searchScore(b, now) - searchScore(a, now);
    if (byScore !== 0) return byScore;
    if (b.weight !== a.weight) return b.weight - a.weight;
    return b.updated_at - a.updated_at;
  });
  return hits.slice(offset, offset + limit);
}

async function searchMemoriesLike(
  db: D1Database,
  query: string,
  scope?: string | null,
  options: PageOptions = {},
): Promise<MemoryRow[]> {
  const like = "%" + query.replace(/[%_]/g, " ") + "%";
  const values: Array<string | number> = [like, like, like];
  let sql =
    "SELECT * FROM memories WHERE deleted_at IS NULL AND (title LIKE ? OR content LIKE ? OR tags_json LIKE ?) AND invalidated = 0 AND (expires_at IS NULL OR expires_at > ?) ";
  values.push(Date.now());
  if (scope) {
    sql += "AND scope = ? ";
    values.push(scope);
  }
  sql += "ORDER BY " + MEMORY_READ_ORDER + " LIMIT ? OFFSET ?";
  values.push(pageLimit(options.limit, 200, 201), pageOffset(options.offset));
  const result = await prepare(db, sql, values).all<MemoryRow>();
  return rowsOf(result);
}

export async function searchMemories(
  db: D1Database,
  query: string,
  scope?: string | null,
  options: PageOptions = {},
): Promise<MemoryRow[]> {
  const trimmed = query.trim();
  // trigram 至少需要 3 个字符才有完整的三元组可匹配；更短的查询、
  // FTS 表未建（迁移未跑）或 FTS 零命中时一律回退 LIKE，行为不差于旧版。
  if (trimmed.length >= 3) {
    try {
      const hits = await searchMemoriesFts(db, trimmed, scope, options);
      if (hits) return hits;
    } catch {
      // 回退 LIKE，不让搜索因索引问题整体失败。
    }
  }
  return searchMemoriesLike(db, query, scope, options);
}
// memory_get 的访问统计节流窗口：同一条记忆 1 小时内反复读只记一次。
const ACCESS_TRACK_THROTTLE_MS = 60 * 60 * 1000;

interface Channel {
  actor: string;
  source: string; // 'panel' | 'mcp'
  auditReads: boolean;
  // MCP 通道带调用 Agent 名：写入记忆时作为 agent_name 缺省归属；
  // 面板通道不带，缺省为全局（NULL）。入参显式给 agent_name 时优先。
  agentName?: string | null;
}

export async function readMemory(db: D1Database, id: string, channel: Channel, now: number): Promise<MemoryRow | null> {
  const row = await getMemoryRow(db, id);
  if (!row) return null;
  // 访问统计节流：距上次记录超过 1 小时才写库，避免每次读都触发一次写。
  let current = row;
  if (row.last_accessed_at == null || now - row.last_accessed_at > ACCESS_TRACK_THROTTLE_MS) {
    await prepare(db, "UPDATE memories SET last_accessed_at = ?, access_count = access_count + 1 WHERE id = ?", [now, id]).run();
    current = { ...row, last_accessed_at: now, access_count: (typeof row.access_count === "number" ? row.access_count : 0) + 1 };
  }
  if (channel.auditReads) {
    await audit(db, { memoryId: current.id, actor: channel.actor, action: "get", diff: { title: current.title, scope: current.scope, version: current.version } }, now);
  }
  return current;
}

export async function listMemoriesAudited(db: D1Database, options: ListOptions, channel: Channel, now: number): Promise<MemoryRow[]> {
  const rows = await listMemories(db, options);
  if (channel.auditReads) {
    await audit(db, { memoryId: null, actor: channel.actor, action: "list", diff: { scope: options.scope ?? null, since: options.since ?? null, count: rows.length } }, now);
  }
  return rows;
}

export async function searchMemoriesAudited(
  db: D1Database,
  query: string,
  scope: string | null,
  options: PageOptions,
  channel: Channel,
  now: number,
): Promise<MemoryRow[]> {
  const rows = await searchMemories(db, query, scope, options);
  if (channel.auditReads) {
    await audit(db, { memoryId: null, actor: channel.actor, action: "search", diff: { query, scope, count: rows.length } }, now);
  }
  return rows;
}

// 手工排序参数：置顶恒在最前；组内按 相关度 × (1 + α·weight/100) × 时间衰减。
// 时间衰减用半衰期，口径集中在这里，避免检索、面板两处各自算。
export const HYBRID_WEIGHT_ALPHA = 0.5;
export const HYBRID_DECAY_HALF_LIFE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function hybridRelevance(row: MemoryRow, fusedScore: number, now: number): number {
  const weight = typeof row.weight === "number" ? row.weight : 0;
  const weightFactor = 1 + HYBRID_WEIGHT_ALPHA * weight / 100;
  const ageDays = Math.max(0, now - (row.updated_at || now)) / DAY_MS;
  const decay = Math.pow(0.5, ageDays / HYBRID_DECAY_HALF_LIFE_DAYS);
  return fusedScore * weightFactor * decay;
}

function sortHybridRows(rows: MemoryRow[], scoreById: Map<string, number>, now: number): MemoryRow[] {
  const compare = (a: MemoryRow, b: MemoryRow): number => {
    const scoreA = hybridRelevance(a, scoreById.get(a.id) ?? 0, now);
    const scoreB = hybridRelevance(b, scoreById.get(b.id) ?? 0, now);
    if (scoreB !== scoreA) return scoreB - scoreA;
    const weightA = typeof a.weight === "number" ? a.weight : 0;
    const weightB = typeof b.weight === "number" ? b.weight : 0;
    if (weightB !== weightA) return weightB - weightA;
    return (b.updated_at || 0) - (a.updated_at || 0);
  };
  const pinned = rows.filter((row) => row.pinned_at != null).sort(compare);
  const rest = rows.filter((row) => row.pinned_at == null).sort(compare);
  return [...pinned, ...rest];
}

async function rowsByIds(db: D1Database, ids: string[], scope?: string | null): Promise<MemoryRow[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  let sql = "SELECT * FROM memories WHERE id IN (" + placeholders + ") AND deleted_at IS NULL";
  const values: Array<string | number | null> = [...ids];
  if (scope) {
    sql += " AND scope = ?";
    values.push(scope);
  }
  sql += " AND invalidated = 0 AND (expires_at IS NULL OR expires_at > ?)";
  values.push(Date.now());
  return rowsOf(await prepare(db, sql, values).all<MemoryRow>());
}

// 混合检索：词法（当前 searchMemories，日后换 FTS 也只改这一处）与向量结果
// 用 RRF（k=60）融合，再按工排序。向量不可用/为空时直接走词法，行为不变。
export async function searchMemoriesHybrid(
  db: D1Database,
  env: Env,
  query: string,
  scope?: string | null,
  options: PageOptions = {},
  now: number = Date.now(),
): Promise<MemoryRow[]> {
  const vectorIds = await vectorSearchIds(env, query);
  if (!vectorIds.length) return searchMemories(db, query, scope, options);
  // 词法侧取一个足够宽的尾部忠实序列表，作为 RRF 的一路输入。
  const lexical = await searchMemories(db, query, scope, { limit: 200, offset: 0 });
  const fused = rrfFuse(lexical.map((row) => row.id), vectorIds);
  const rows = await rowsByIds(db, fused.map((hit) => hit.id), scope);
  const scoreById = new Map(fused.map((hit) => [hit.id, hit.score]));
  const ranked = sortHybridRows(rows, scoreById, now);
  const offset = pageOffset(options.offset);
  const limit = pageLimit(options.limit, 200, 201);
  return ranked.slice(offset, offset + limit);
}

export async function searchMemoriesHybridAudited(
  env: Env,
  query: string,
  scope: string | null,
  options: PageOptions,
  channel: Channel,
  now: number,
): Promise<MemoryRow[]> {
  const rows = await searchMemoriesHybrid(env.DB, env, query, scope, options, now);
  if (channel.auditReads) {
    await audit(env.DB, { memoryId: null, actor: channel.actor, action: "search", diff: { query, scope, count: rows.length } }, now);
  }
  return rows;
}

interface TierFields {
  groupId?: string | null;
  pinnedAt?: number | null;
  weight?: number;
  aiState?: string;
  kind?: string | null;
  agentName?: string | null;
  expiresAt?: number | null;
  supersedesId?: string | null;
  aiPendingAt?: number | null;
}

async function insertMemory(
  db: D1Database,
  fields: { title: string; scope: string; content: string; tags: string[] } & TierFields,
  channel: Channel,
  now: number,
  ai?: MemoryWriteOptions["ai"],
): Promise<MemoryRow> {
  const id = newId("mem");
  const agentName = fields.agentName !== undefined ? fields.agentName : channel.agentName ?? null;
  const hash = await computeContentHash(fields.title, fields.content);
  const statements = [
    prepare(
      db,
      "INSERT INTO memories (id, title, scope, content, source, tags_json, version, created_at, updated_at, deleted_at, group_id, pinned_at, weight, ai_state, kind, agent_name, expires_at, content_hash, supersedes_id, ai_pending_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        fields.title,
        fields.scope,
        fields.content,
        channel.source,
        JSON.stringify(fields.tags),
        now,
        now,
        fields.groupId ?? null,
        fields.pinnedAt ?? null,
        fields.weight ?? 0,
        fields.aiState ?? "none",
        fields.kind ?? null,
        agentName,
        fields.expiresAt ?? null,
        hash,
        fields.supersedesId ?? null,
        fields.aiPendingAt ?? null,
      ],
    ),
  ];
  if (fields.supersedesId) {
    // 取代与新建同一 batch 落库：旧记忆 invalidated 置 1，行保留可追溯。
    const old = await getMemoryRow(db, fields.supersedesId);
    if (!old) throw new MemError("要取代的记忆不存在", 400);
    statements.push(
      prepare(db, "UPDATE memories SET invalidated = 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [now, fields.supersedesId]),
    );
  }
  await db.batch(statements);
  const row = await getMemoryRow(db, id);
  if (!row) throw new MemError("写入后读取失败", 500);
  await markMemoryVectorDirty(db, id);
  await audit(db, { memoryId: id, actor: channel.actor, action: "create", diff: { title: row.title, scope: row.scope } }, now);
  scheduleMemorySummary(ai, db, row);
  if (fields.supersedesId) {
    await audit(db, { memoryId: fields.supersedesId, actor: channel.actor, action: "supersede", diff: { by: id } }, now);
  }
  return row;
}

export interface MemoryWriteOptions {
  // ingest 的 AI 拆分走旁路：标签问题绝不阻断保存，由调用方显式关闭校验。
  enforceTagCap?: boolean;
  // 摘要旁路：调用方（面板 / MCP）把 env 与 waitUntil 传进来，正文新建或
  // 变化后 best-effort 生成 ai_summary。缺省不生成；AI 失败绝不影响写入。
  ai?: { env: Env; ctx?: WaitCtx } | null;
}

export async function createMemory(
  db: D1Database,
  input: Record<string, unknown>,
  channel: Channel,
  now: number,
  options: MemoryWriteOptions = {},
): Promise<MemoryRow> {
  const title = cleanTitle(input.title);
  const scope = cleanScope(input.scope);
  const content = cleanContent(input.content);
  const tags = cleanTags(input.tags) ?? [];
  if (options.enforceTagCap !== false) await assertTagCapacity(db, tags);
  const groupId = cleanGroupId(input.group_id) ?? null;
  await requireGroup(db, groupId);
  // 新建只采用各自字段：权重缺省 0，置顶缺省否，不从对方推导。
  const weight = cleanWeight(input.weight) ?? 0;
  const pinned = cleanPinned(input.pinned);
  const aiState = typeof input.ai_state === "string" && input.ai_state ? input.ai_state : "none";
  const kind = cleanKind(input.kind);
  const agentNameInput = cleanAgentNameField(input.agent_name);
  const expiresAt = cleanExpiresAt(input.expires_at);
  const supersedesId = cleanSupersedesId(input.supersedes_id);
  // 精确去重先于同名冲突：标题与正文都完全一致（同 hash）就是同一条，
  // 直接返回既有行；同名但内容不同才走下面的 409。
  const agentName = agentNameInput !== undefined ? agentNameInput : channel.agentName ?? null;
  const duplicate = await findActiveByContentHash(db, scope, agentName, await computeContentHash(title, content));
  if (duplicate) return duplicate;
  const aiPendingAt = typeof input.ai_pending_at === "number" && Number.isFinite(input.ai_pending_at)
    ? input.ai_pending_at
    : null;
  const existing = await findActiveByTitleScope(db, title, scope);
  if (existing) throw new MemError("同一作用域下已存在同名记忆，请改标题或用编辑", 409);
  return insertMemory(
    db,
    {
      title,
      scope,
      content,
      tags,
      groupId,
      weight,
      pinnedAt: pinned === true ? now : null,
      aiState,
      kind: kind ?? null,
      agentName,
      expiresAt: expiresAt ?? null,
      supersedesId: supersedesId ?? null,
    },
    { title, scope, content, tags, groupId, weight, pinnedAt: pinned === true ? now : null, aiState, aiPendingAt },
    channel,
    now,
    options.ai,
  );
}

// memory_remember 的落库口径：同步创建一条 ai_state=pending 的记忆，拆分/打标/
// 摘要交给 cron。标题撞车时加后缀，避免 Agent 随手记被同名冲突挡住。
export async function rememberMemory(
  db: D1Database,
  input: Record<string, unknown>,
  channel: Channel,
  now: number,
): Promise<MemoryRow> {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw new MemError("请填写要记住的内容");
  if (text.length > CONTENT_MAX) throw new MemError("内容过长");
  const providedTitle = typeof input.title === "string" ? input.title.trim() : "";
  const baseTitle = providedTitle || deriveMemoryTitle(text);
  const tags = cleanTags(input.tags) ?? [];
  const scope = cleanScope(input.scope);
  for (let attempt = 0; attempt < 20; attempt++) {
    const title = attempt === 0 ? baseTitle : baseTitle.slice(0, TITLE_MAX - 4) + "（" + (attempt + 1) + "）";
    try {
      return await createMemory(
        db,
        { title, scope, content: text, tags, weight: 0, pinned: false, ai_state: "pending", ai_pending_at: now },
        channel,
        now,
        { enforceTagCap: false },
      );
    } catch (error) {
      if (error instanceof MemError && error.status === 409 && attempt < 19) continue;
      throw error;
    }
  }
  throw new MemError("同名记忆过多，请指定标题", 409);
}

async function applyUpdate(
  db: D1Database,
  row: MemoryRow,
  fields: { title: string; scope: string; content: string; tags: string[] } & TierFields,
  channel: Channel,
  action: string,
  now: number,
  ai?: MemoryWriteOptions["ai"],
): Promise<MemoryRow> {
  // 置顶与权重分列写入：请求没带的那个字段不出现在 SET 里，改一个不会连带改另一个。
  const assignments = ["title = ?", "scope = ?", "content = ?", "tags_json = ?", "group_id = ?"];
  const params: Array<string | number | null> = [
    fields.title,
    fields.scope,
    fields.content,
    JSON.stringify(fields.tags),
    fields.groupId !== undefined ? fields.groupId : row.group_id,
  ];
  if (fields.pinnedAt !== undefined) {
    assignments.push("pinned_at = ?");
    params.push(fields.pinnedAt);
  }
  if (fields.weight !== undefined) {
    assignments.push("weight = ?");
    params.push(fields.weight);
  }
  // 正文变了，旧摘要立即作废（snippet 先退回正文截断），新摘要由旁路补。
  if (fields.content !== row.content) assignments.push("ai_summary = NULL");
  if (fields.kind !== undefined) {
    assignments.push("kind = ?");
    params.push(fields.kind);
  }
  if (fields.agentName !== undefined) {
    assignments.push("agent_name = ?");
    params.push(fields.agentName);
  }
  if (fields.expiresAt !== undefined) {
    assignments.push("expires_at = ?");
    params.push(fields.expiresAt);
  }
  if (fields.supersedesId !== undefined) {
    assignments.push("supersedes_id = ?");
    params.push(fields.supersedesId);
  }
  assignments.push("content_hash = ?");
  params.push(await computeContentHash(fields.title, fields.content));
  assignments.push("version = version + 1", "updated_at = ?", "deleted_at = NULL");
  params.push(now, row.id);
  if (fields.supersedesId) {
    const old = await getMemoryRow(db, fields.supersedesId);
    if (!old) throw new MemError("要取代的记忆不存在", 400);
  }
  await prepare(db, "UPDATE memories SET " + assignments.join(", ") + " WHERE id = ?", params).run();
  if (fields.supersedesId && fields.supersedesId !== row.id) {
    await prepare(db, "UPDATE memories SET invalidated = 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL", [now, fields.supersedesId]).run();
    await audit(db, { memoryId: fields.supersedesId, actor: channel.actor, action: "supersede", diff: { by: row.id } }, now);
  }
  await markMemoryVectorDirty(db, row.id);
  const updated = await getMemoryRow(db, row.id);
  if (!updated) throw new MemError("写入后读取失败", 500);
  await audit(db, { memoryId: row.id, actor: channel.actor, action, diff: { title: updated.title, scope: updated.scope, version: updated.version } }, now);
  if (fields.content !== row.content) scheduleMemorySummary(ai, db, updated);
  return updated;
}

// Idempotent write: by id when one is given (a soft-deleted row is revived),
// otherwise by (title, scope). Creates when nothing matches.
export async function upsertMemory(db: D1Database, input: Record<string, unknown>, channel: Channel, now: number, options: MemoryWriteOptions = {}): Promise<MemoryRow> {
  const title = cleanTitle(input.title);
  const scope = cleanScope(input.scope);
  const content = cleanContent(input.content);
  const tags = cleanTags(input.tags);
  const groupId = cleanGroupId(input.group_id);
  if (groupId !== undefined) await requireGroup(db, groupId);
  const weight = cleanWeight(input.weight);
  const pinned = cleanPinned(input.pinned);
  const kind = cleanKind(input.kind);
  const agentNameInput = cleanAgentNameField(input.agent_name);
  const expiresAt = cleanExpiresAt(input.expires_at);
  const supersedesId = cleanSupersedesId(input.supersedes_id);
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : null;
  let target: MemoryRow | null = null;
  if (id) target = await getMemoryRow(db, id, true);
  if (!target) {
    // 精确去重优先于标题匹配：内容完全一致就是同一条，直接返回，不再写入。
    const agentName = agentNameInput !== undefined ? agentNameInput : channel.agentName ?? null;
    target = await findActiveByContentHash(db, scope, agentName, await computeContentHash(title, content));
    if (target) return target;
    target = await findActiveByTitleScope(db, title, scope);
  }
  if (!target) {
    await assertTagCapacity(db, tags ?? []);
    return insertMemory(
      db,
      {
        title,
        scope,
        content,
        tags: tags ?? [],
        groupId: groupId ?? null,
        weight: weight ?? 0,
        pinnedAt: pinned === true ? now : null,
        kind: kind ?? null,
        agentName: agentNameInput !== undefined ? agentNameInput : channel.agentName ?? null,
        expiresAt: expiresAt ?? null,
        supersedesId: supersedesId ?? null,
      },
      channel,
      now,
      options.ai,
    );
  }
  // Changing title/scope onto another active row's key would break the
  // unique index; surface it instead of failing the write opaquely.
  if (target.title !== title || target.scope !== scope) {
    const clash = await findActiveByTitleScope(db, title, scope);
    if (clash && clash.id !== target.id) throw new MemError("同一作用域下已存在同名记忆", 409);
  }
  const previousTags = parseTags(target.tags_json);
  await assertTagCapacity(db, tags ?? previousTags, previousTags);
  return applyUpdate(
    db,
    target,
    {
      title,
      scope,
      content,
      tags: tags ?? previousTags,
      groupId: groupId !== undefined ? groupId : target.group_id,
      weight,
      pinnedAt: pinned === undefined ? undefined : pinned ? now : null,
      kind,
      agentName: agentNameInput,
      expiresAt,
      supersedesId,
    },
    channel,
    target.deleted_at != null ? "upsert_revive" : "upsert",
    now,
    options.ai,
  );
}

export async function updateMemory(db: D1Database, id: string, input: Record<string, unknown>, channel: Channel, now: number, options: MemoryWriteOptions = {}): Promise<MemoryRow> {
  const row = await getMemoryRow(db, id);
  if (!row) throw new MemError("记忆不存在或已删除", 404);
  const title = input.title === undefined ? row.title : cleanTitle(input.title);
  const scope = input.scope === undefined ? row.scope : cleanScope(input.scope);
  const content = input.content === undefined ? row.content : cleanContent(input.content);
  const previousTags = parseTags(row.tags_json);
  const tags = cleanTags(input.tags) ?? previousTags;
  const groupId = cleanGroupId(input.group_id);
  if (groupId !== undefined) await requireGroup(db, groupId);
  const weight = cleanWeight(input.weight);
  const pinned = cleanPinned(input.pinned);
  const kind = cleanKind(input.kind);
  const agentNameInput = cleanAgentNameField(input.agent_name);
  const expiresAt = cleanExpiresAt(input.expires_at);
  const supersedesId = cleanSupersedesId(input.supersedes_id);
  if (title !== row.title || scope !== row.scope) {
    const clash = await findActiveByTitleScope(db, title, scope);
    if (clash && clash.id !== row.id) throw new MemError("同一作用域下已存在同名记忆", 409);
  }
  await assertTagCapacity(db, tags, previousTags);
  return applyUpdate(
    db,
    row,
    {
      title,
      scope,
      content,
      tags,
      groupId: groupId !== undefined ? groupId : row.group_id,
      weight,
      pinnedAt: pinned === undefined ? undefined : pinned ? now : null,
      kind,
      agentName: agentNameInput,
      expiresAt,
      supersedesId,
    },
    channel,
    "update",
    now,
    options.ai,
  );
}

export async function deleteMemory(db: D1Database, id: string, channel: Channel, now: number): Promise<MemoryRow> {
  return invalidateMemoryWithAudit(db, id, channel, now, "delete");
}

// 软删除 + 指定审计动作。后台拆分取代原文、合并提案落地都复用这里，
// 保证“失效”永远留墓碑与审计，不会物理消失。
export async function invalidateMemoryWithAudit(
  db: D1Database,
  id: string,
  channel: Channel,
  now: number,
  action: string,
  diff: Record<string, unknown> = {},
): Promise<MemoryRow> {
  const row = await getMemoryRow(db, id);
  if (!row) throw new MemError("记忆不存在或已删除", 404);
  await prepare(db, "UPDATE memories SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?", [now, now, id]).run();
  const deleted = await getMemoryRow(db, id, true);
  if (!deleted) throw new MemError("写入后读取失败", 500);
  await audit(db, { memoryId: id, actor: channel.actor, action, diff: { title: row.title, scope: row.scope, ...diff } }, now);
  return deleted;
}

// 合并提案的执行点：保留方吸收被并方的正文与标签，被并方软删除留墓碑。
// 只合并不自动产生提案；调用方（提案批准）负责权限与日志。
export async function mergeMemories(
  db: D1Database,
  keepId: string,
  dropIds: string[],
  channel: Channel,
  now: number,
): Promise<MemoryRow> {
  const keep = await getMemoryRow(db, keepId);
  if (!keep) throw new MemError("保留的记忆不存在或已删除", 404);
  const drops: MemoryRow[] = [];
  for (const id of dropIds) {
    if (id === keepId) continue;
    const row = await getMemoryRow(db, id);
    if (row) drops.push(row);
  }
  if (!drops.length) throw new MemError("要合并的记忆不存在或已删除", 404);
  const contents: string[] = [];
  if (keep.content.trim()) contents.push(keep.content.trim());
  for (const row of drops) if (row.content.trim()) contents.push(row.content.trim());
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const tag of [...parseTags(keep.tags_json), ...drops.flatMap((row) => parseTags(row.tags_json))]) {
    const key = normalizeTagKey(tag);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag.trim().replace(/\s+/g, " "));
  }
  await prepare(
    db,
    "UPDATE memories SET content = ?, tags_json = ?, version = version + 1, updated_at = ? WHERE id = ?",
    [contents.join("\n\n"), JSON.stringify(tags), now, keepId],
  ).run();
  await markMemoryVectorDirty(db, keepId);
  for (const row of drops) {
    await invalidateMemoryWithAudit(db, row.id, channel, now, "merge", { keep_id: keepId });
  }
  const updated = await getMemoryRow(db, keepId);
  if (!updated) throw new MemError("写入后读取失败", 500);
  await audit(db, { memoryId: keepId, actor: channel.actor, action: "merge", diff: { dropped: drops.map((row) => row.id) } }, now);
  return updated;
}

// summarize 提案的执行点：payload 已经带摘要，批准时不再调用 AI。
export async function applyMemorySummary(
  db: D1Database,
  id: string,
  summary: string,
  channel: Channel,
  now: number,
): Promise<MemoryRow> {
  const row = await getMemoryRow(db, id);
  if (!row) throw new MemError("记忆不存在或已删除", 404);
  await prepare(db, "UPDATE memories SET ai_summary = ?, version = version + 1, updated_at = ? WHERE id = ?", [summary, now, id]).run();
  const updated = await getMemoryRow(db, id);
  if (!updated) throw new MemError("写入后读取失败", 500);
  await audit(db, { memoryId: id, actor: channel.actor, action: "ai_summary", diff: { summary } }, now);
  return updated;
}


// ---- ai_summary 旁路（P1）----
// 正文新建或变化后异步生成一句话摘要，供列表与搜索的 snippet 优先展示。
// 与打标同一口径：AI 是地基不是门槛——未配 AI、调用失败、返回不可用都
// 静默放弃，写入本身早已成功。落库只改 ai_summary 一列，不 bump
// version/updated_at（不扰动读序与增量同步游标），并以生成时的 version
// 做乐观 guard：期间正文又被改过就丢弃这次结果，等下一次变化再生成。
const SUMMARY_MAX_CHARS = 200;
const SUMMARY_INPUT_MAX = 4000;

async function generateMemorySummary(env: Env, db: D1Database, row: MemoryRow): Promise<void> {
  try {
    if (!env.AI || typeof env.AI.run !== "function") return;
    const content = row.content.trim();
    if (!content) return;
    const input = ("标题：" + row.title + "\n正文：" + content).slice(0, SUMMARY_INPUT_MAX);
    const output = await env.AI.run(resolveAiModel(env), {
      messages: [
        { role: "system", content: "你负责给记忆条目写一句话摘要。只输出摘要本身，不要引号、不要前缀、不要解释。" },
        { role: "user", content: "用一句不超过 60 个汉字的中文概括下面这条记忆的核心内容：\n" + input },
      ],
      temperature: 0,
      max_tokens: 200,
    });
    const text = readChatResponse(output);
    if (!text) return;
    const summary = text.replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX_CHARS);
    if (!summary) return;
    await prepare(db, "UPDATE memories SET ai_summary = ? WHERE id = ? AND version = ?", [summary, row.id, row.version]).run();
  } catch {
    // best-effort：摘要失败保持 ai_summary 为空，snippet 退回正文截断。
  }
}

function scheduleMemorySummary(ai: MemoryWriteOptions["ai"], db: D1Database, row: MemoryRow): void {
  if (!ai || !ai.env) return;
  if (!row.content.trim()) return;
  const task = generateMemorySummary(ai.env, db, row);
  if (ai.ctx && typeof ai.ctx.waitUntil === "function") {
    try {
      ai.ctx.waitUntil(task);
      return;
    } catch {
      // ctx 不完整（本地 dev）时退回裸 promise，一样是旁路。
    }
  }
  void task.catch(() => undefined);
}

// AI 补打标的落库点：只改 tags 与 ai_state，内容不动。拆分来的记忆保持
// split 状态，其余成功后记 tagged；失败不调用本函数，状态原样保留。
// 同时清空 ai_pending_at：补全完成即离开待补全队列。
export async function applyAiTags(
  db: D1Database,
  id: string,
  tags: string[],
  channel: Channel,
  now: number,
): Promise<MemoryRow> {
  const row = await getMemoryRow(db, id);
  if (!row) throw new MemError("记忆不存在或已删除", 404);
  const nextState = row.ai_state === "split" ? "split" : "tagged";
  await prepare(db, "UPDATE memories SET tags_json = ?, ai_state = ?, ai_pending_at = NULL, version = version + 1, updated_at = ? WHERE id = ?", [
    JSON.stringify(tags),
    nextState,
    now,
    id,
  ]).run();
  const updated = await getMemoryRow(db, id);
  if (!updated) throw new MemError("写入后读取失败", 500);
  await audit(db, { memoryId: id, actor: channel.actor, action: "ai_tag", diff: { tags, ai_state: nextState } }, now);
  return updated;
}

// ---------------------------------------------------------------------------
// Memory 与 Soul 打通（P2）：Soul 的常驻核心记忆。取该 Agent 的置顶记忆
// （agent_name 为本人或全局），排除删除、失效与过期，按统一读序返回；
// 总字符预算 CORE_MEMORIES_CHAR_BUDGET，按 id+标题+摘要累计，超了就少回
// 几条；只有第一条本身就超预算时才截短它的摘要，保证至少回一条。

export const CORE_MEMORIES_CHAR_BUDGET = 4000;

export interface CoreMemory {
  id: string;
  title: string;
  snippet: string;
}

export async function listCoreMemories(db: D1Database, agentName: string, now: number): Promise<CoreMemory[]> {
  const result = await prepare(
    db,
    "SELECT * FROM memories WHERE pinned_at IS NOT NULL AND deleted_at IS NULL AND invalidated = 0 AND (expires_at IS NULL OR expires_at > ?) AND (agent_name IS NULL OR agent_name = '' OR agent_name = ?) ORDER BY " +
      MEMORY_READ_ORDER,
    [now, agentName],
  ).all<MemoryRow>();
  const picked: CoreMemory[] = [];
  let used = 0;
  for (const row of rowsOf(result)) {
    const full = row.ai_summary && row.ai_summary.trim() ? row.ai_summary : row.content.slice(0, 200);
    let snippet = full;
    let cost = row.id.length + row.title.length + snippet.length;
    if (used + cost > CORE_MEMORIES_CHAR_BUDGET) {
      const room = CORE_MEMORIES_CHAR_BUDGET - used - row.id.length - row.title.length;
      if (picked.length > 0 || room <= 0) break;
      snippet = full.slice(0, room);
      cost = row.id.length + row.title.length + snippet.length;
    }
    picked.push({ id: row.id, title: row.title, snippet });
    used += cost;
  }
  return picked;
}

// 后台拆分完成后拉取待补全记忆；只跑少量，失败保留 pending 由下一轮重试。
export async function listPendingAiMemories(db: D1Database, limit = 10): Promise<MemoryRow[]> {
  const rows = rowsOf(
    await prepare(
      db,
      "SELECT * FROM memories WHERE deleted_at IS NULL AND ai_state = 'pending' ORDER BY ai_pending_at ASC, updated_at ASC LIMIT ?",
      [Math.max(1, limit)],
    ).all<MemoryRow>(),
  );
  return rows;
}
