// Memory module: memories on D1 with soft-delete tombstones, per-module
// audit (same shape as calendar_audit), and idempotent upsert keyed by id
// or by (title, scope). Panel and MCP share these functions; the channel
// decides whether reads are audited (MCP reads are, panel reads are not —
// the same split as mcp_get fetch audit vs panel browsing).

import { prepare } from "./registry";
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
    where.push("deleted_at IS NULL");
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

export async function searchMemories(
  db: D1Database,
  query: string,
  scope?: string | null,
  options: PageOptions = {},
): Promise<MemoryRow[]> {
  const like = "%" + query.replace(/[%_]/g, " ") + "%";
  const values: Array<string | number> = [like, like, like];
  let sql =
    "SELECT * FROM memories WHERE deleted_at IS NULL AND (title LIKE ? OR content LIKE ? OR tags_json LIKE ?) ";
  if (scope) {
    sql += "AND scope = ? ";
    values.push(scope);
  }
  sql += "ORDER BY " + MEMORY_READ_ORDER + " LIMIT ? OFFSET ?";
  values.push(pageLimit(options.limit, 200, 201), pageOffset(options.offset));
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
  aiPendingAt?: number | null;
}

async function insertMemory(
  db: D1Database,
  fields: { title: string; scope: string; content: string; tags: string[] } & TierFields,
  channel: Channel,
  now: number,
): Promise<MemoryRow> {
  const id = newId("mem");
  await prepare(
    db,
    "INSERT INTO memories (id, title, scope, content, source, tags_json, version, created_at, updated_at, deleted_at, group_id, pinned_at, weight, ai_state, ai_pending_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?, ?, ?, ?)",
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
      fields.aiPendingAt ?? null,
    ],
  ).run();
  const row = await getMemoryRow(db, id);
  if (!row) throw new MemError("写入后读取失败", 500);
  await markMemoryVectorDirty(db, id);
  await audit(db, { memoryId: id, actor: channel.actor, action: "create", diff: { title: row.title, scope: row.scope } }, now);
  return row;
}

export interface MemoryWriteOptions {
  // ingest 的 AI 拆分走旁路：标签问题绝不阻断保存，由调用方显式关闭校验。
  enforceTagCap?: boolean;
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
  const aiPendingAt = typeof input.ai_pending_at === "number" && Number.isFinite(input.ai_pending_at)
    ? input.ai_pending_at
    : null;
  const existing = await findActiveByTitleScope(db, title, scope);
  if (existing) throw new MemError("同一作用域下已存在同名记忆，请改标题或用编辑", 409);
  return insertMemory(
    db,
    { title, scope, content, tags, groupId, weight, pinnedAt: pinned === true ? now : null, aiState, aiPendingAt },
    channel,
    now,
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
  assignments.push("version = version + 1", "updated_at = ?", "deleted_at = NULL");
  params.push(now, row.id);
  await prepare(db, "UPDATE memories SET " + assignments.join(", ") + " WHERE id = ?", params).run();
  await markMemoryVectorDirty(db, row.id);
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
  const groupId = cleanGroupId(input.group_id);
  if (groupId !== undefined) await requireGroup(db, groupId);
  const weight = cleanWeight(input.weight);
  const pinned = cleanPinned(input.pinned);
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : null;
  let target: MemoryRow | null = null;
  if (id) target = await getMemoryRow(db, id, true);
  if (!target) target = await findActiveByTitleScope(db, title, scope);
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
      },
      channel,
      now,
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
    },
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
  const previousTags = parseTags(row.tags_json);
  const tags = cleanTags(input.tags) ?? previousTags;
  const groupId = cleanGroupId(input.group_id);
  if (groupId !== undefined) await requireGroup(db, groupId);
  const weight = cleanWeight(input.weight);
  const pinned = cleanPinned(input.pinned);
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
    },
    channel,
    "update",
    now,
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
