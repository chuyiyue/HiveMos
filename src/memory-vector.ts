// 记忆向量：Workers AI（@cf/baai/bge-m3）+ Vectorize（hivemos-memories）。
//
// 设计口径：
// - 写入路径只标脏（删 memory_vectors 行），绝不等待嵌入；嵌入失败也只记录
//   “还没做”，不影响记忆本身的写入与检索。
// - cron 每轮回填 ≤50 条：先清掉已删除记忆的向量，再补新/变更的向量。
// - memory_vectors.vector_json 是本地缓存（余弦相似度去重时免去再调 AI）。
// - 绑定缺失（本地 dev）或 AI 不可用时，所有函数静默降级为“没有向量”。

import { prepare } from "./registry";
import type { D1Database, Env } from "./env";

export const VECTOR_MODEL = "@cf/baai/bge-m3";
export const VECTOR_DIMENSIONS = 1024;
export const VECTOR_TOP_K = 30;
export const RRF_K = 60;
export const VECTOR_BACKFILL_BATCH = 50;

function rowsOf<T>(value: { results?: T[] } | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.results)) return value.results;
  return [];
}

export interface VectorMemorySeed {
  id: string;
  title: string;
  content: string;
  scope?: string | null;
}

export function memoryVectorText(row: { title?: string | null; content?: string | null }): string {
  const title = (row.title ?? "").trim();
  const content = (row.content ?? "").trim();
  if (title && content) return title + "\n" + content;
  return title || content;
}

// 与写入时同一口径的内容摘要：标题 + 正文。标签不参与，避免打标轮转把
// 所有向量都判成脏。
export async function memoryContentHash(row: { title?: string | null; content?: string | null }): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(memoryVectorText(row)));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export interface VectorMeta {
  memory_id: string;
  content_hash: string;
  model: string;
}

// 纯判定：没有元数据、换了模型、或内容哈希对不上，都算待生成。
export function vectorMetaStale(meta: VectorMeta | null | undefined, contentHash: string): boolean {
  if (!meta) return true;
  if (meta.model !== VECTOR_MODEL) return true;
  return meta.content_hash !== contentHash;
}

export interface FusedHit {
  id: string;
  score: number;
}

// Reciprocal Rank Fusion（k=60）：只吃两份有序 id 列表，便于以后把词法
// 列表整体换成 FTS 结果。并列时保持“先出现者优先”（词法在前、向量在后）。
export function rrfFuse(lexicalIds: string[], vectorIds: string[], k = RRF_K): FusedHit[] {
  const scores = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;
  function add(ids: string[]): void {
    ids.forEach((id, index) => {
      if (!id) return;
      if (!firstSeen.has(id)) firstSeen.set(id, order++);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  add(lexicalIds);
  add(vectorIds);
  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (firstSeen.get(a.id) ?? 0) - (firstSeen.get(b.id) ?? 0);
    });
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Workers AI 的 bge 系列返回 { shape, data: number[][] }；也兼容只给一条
// 向量或 OpenAI 风格嵌套的情况。形状不对就返回 null（调用方降级）。
export function parseEmbeddingPayload(output: unknown, expected: number): number[][] | null {
  if (!output || typeof output !== "object") return null;
  const data = (output as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  if (data.length !== expected) return null;
  const vectors: number[][] = [];
  for (const item of data) {
    if (!Array.isArray(item)) return null;
    const values: number[] = [];
    for (const value of item) {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      values.push(value);
    }
    if (!values.length) return null;
    vectors.push(values);
  }
  return vectors;
}

export async function embedTexts(env: Env, texts: string[]): Promise<number[][] | null> {
  if (!env.AI || typeof env.AI.run !== "function" || texts.length === 0) return null;
  try {
    const output = await env.AI.run(VECTOR_MODEL, { text: texts });
    if (output && typeof output === "object") {
      const data = (output as { data?: unknown }).data;
      if (Array.isArray(data) && data.length === 1 && texts.length === 1 && typeof data[0] === "number") {
        return [data as number[]];
      }
    }
    return parseEmbeddingPayload(output, texts.length);
  } catch {
    return null;
  }
}

export async function vectorSearchIds(env: Env, query: string): Promise<string[]> {
  const text = query.trim();
  if (!text || !env.MEMORY_VECTORS) return [];
  const vectors = await embedTexts(env, [text]);
  const values = vectors && vectors[0];
  if (!values || !values.length) return [];
  try {
    const result = await env.MEMORY_VECTORS.query(values, { topK: VECTOR_TOP_K });
    const matches = result && Array.isArray(result.matches) ? result.matches : [];
    return matches
      .map((match) => (match && typeof match.id === "string" ? match.id : ""))
      .filter((id) => Boolean(id));
  } catch {
    return [];
  }
}

// 写路径标脏：删掉元数据行，回填时按“没有元数据”重新嵌入。表不存在或
// 迁移尚未应用时静默失败，绝不让记忆写入依赖向量。
export async function markMemoryVectorDirty(db: D1Database, memoryId: string): Promise<void> {
  try {
    await prepare(db, "DELETE FROM memory_vectors WHERE memory_id = ?", [memoryId]).run();
  } catch {
    // ignore
  }
}

async function writeVectorMeta(
  db: D1Database,
  memoryId: string,
  contentHash: string,
  vector: number[],
  now: number,
): Promise<void> {
  await prepare(
    db,
    "INSERT OR REPLACE INTO memory_vectors (memory_id, content_hash, model, embedded_at, vector_json) VALUES (?, ?, ?, ?, ?)",
    [memoryId, contentHash, VECTOR_MODEL, now, JSON.stringify(vector)],
  ).run();
}

// 写入路径顺手补当前一条（waitUntil 调用），失败不影响请求。
export async function embedMemoryNow(env: Env, memoryId: string, now = Date.now()): Promise<boolean> {
  if (!env.MEMORY_VECTORS) return false;
  const row = await prepare(
    env.DB,
    "SELECT id, title, content, scope FROM memories WHERE id = ? AND deleted_at IS NULL",
    [memoryId],
  ).first<VectorMemorySeed>();
  if (!row) return false;
  const hash = await memoryContentHash(row);
  const vectors = await embedTexts(env, [memoryVectorText(row)]);
  const vector = vectors && vectors[0];
  if (!vector) return false;
  try {
    await env.MEMORY_VECTORS.upsert([{ id: row.id, values: vector, metadata: { scope: row.scope ?? "" } }]);
    await writeVectorMeta(env.DB, row.id, hash, vector, now);
    return true;
  } catch {
    return false;
  }
}

export interface BackfillResult {
  removed: number;
  embedded: number;
  pending: number;
}

// cron 回填：先删已删除记忆的向量，再补最多 limit 条新/变更向量。
export async function backfillMemoryVectors(
  env: Env,
  now: number,
  limit = VECTOR_BACKFILL_BATCH,
): Promise<BackfillResult> {
  const result: BackfillResult = { removed: 0, embedded: 0, pending: 0 };
  if (!env.MEMORY_VECTORS) return result;
  const metaRows = rowsOf(
    await prepare(env.DB, "SELECT memory_id, content_hash, model FROM memory_vectors").all<VectorMeta>(),
  );
  const metaById = new Map(metaRows.map((row) => [row.memory_id, row]));
  const memoryRows = rowsOf(
    await prepare(
      env.DB,
      "SELECT id, title, content, scope FROM memories WHERE deleted_at IS NULL",
    ).all<VectorMemorySeed>(),
  );
  const activeIds = new Set(memoryRows.map((row) => row.id));

  // 已删除的记忆：先清 Vectorize，再清元数据。
  const staleIds = metaRows.map((row) => row.memory_id).filter((id) => !activeIds.has(id));
  if (staleIds.length) {
    for (let offset = 0; offset < staleIds.length; offset += 100) {
      const chunk = staleIds.slice(offset, offset + 100);
      try {
        await env.MEMORY_VECTORS.deleteByIds(chunk);
      } catch {
        // 下一轮再删；元数据先留着，保证还能重试
        continue;
      }
      const placeholders = chunk.map(() => "?").join(", ");
      await prepare(env.DB, "DELETE FROM memory_vectors WHERE memory_id IN (" + placeholders + ")", chunk).run();
      result.removed += chunk.length;
    }
  }

  const candidates: Array<VectorMemorySeed & { hash: string }> = [];
  for (const row of memoryRows) {
    const hash = await memoryContentHash(row);
    if (vectorMetaStale(metaById.get(row.id), hash)) candidates.push({ ...row, hash });
  }
  result.pending = Math.max(0, candidates.length - limit);
  const batch = candidates.slice(0, limit);
  if (!batch.length || !env.AI) return result;
  const vectors = await embedTexts(env, batch.map(memoryVectorText));
  if (!vectors || vectors.length !== batch.length) return result;
  try {
    await env.MEMORY_VECTORS.upsert(
      batch.map((row, index) => ({
        id: row.id,
        values: vectors[index] as number[],
        metadata: { scope: row.scope ?? "" },
      })),
    );
  } catch {
    return result;
  }
  for (let index = 0; index < batch.length; index++) {
    const row = batch[index] as VectorMemorySeed & { hash: string };
    await writeVectorMeta(env.DB, row.id, row.hash, vectors[index] as number[], now);
    result.embedded++;
  }
  return result;
}
