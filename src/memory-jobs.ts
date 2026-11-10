// 记忆后台任务：挂在现有 hourly cron 的 scheduled() 门控里（跟随功能设置
// 里的频率，不新增触发器）。三件事：
//   1. 补全 ai_state=pending 的记忆（拆分/打标），以及向量回填（每批 ≤50）。
//   2. 扫提案（merge / expire / summarize / 标签整理），只落提案，绝不自动改库。
//   3. 任何一步失败都吞掉，下一轮继续；已完成的部分保留。

import { prepare } from "./registry";
import type { D1Database, Env } from "./env";
import {
  askMergeMapping,
  planSimilarTags,
  processPendingMemories,
  summarizeMemory,
} from "./memory-ai";
import type { MergeMappingFn, PendingProcessResult, PendingSplitFn } from "./memory-ai";
import { backfillMemoryVectors, cosineSimilarity } from "./memory-vector";
import type { BackfillResult } from "./memory-vector";
import {
  createProposalIfNew,
  listProposalRows,
  parseProposalPayload,
  proposalDedupeKey,
} from "./memory-proposals";
import type { ProposalPayload } from "./memory-proposals";

// 过期阈值（写成常量并注释）：
export const EXPIRE_INACTIVE_DAYS = 90; // 超过 90 天没有访问
export const EXPIRE_LOW_WEIGHT = 20; // 权重低于 20
export const MERGE_VECTOR_SIMILARITY = 0.92; // 向量余弦相似度高于 0.92 才算重复
export const MEMORY_MERGE_VECTOR_LIMIT = 100; // 相似度去重只看最近 100 条有向量的记忆
export const PENDING_AI_BATCH = 5; // 每轮最多补 5 条 pending（拆分/打标各约 30 秒）
export const SUMMARIZE_BATCH = 5; // 每轮最多生成 5 条摘要提案（AI 也走推理模型）
const DAY_MS = 24 * 60 * 60 * 1000;

function rowsOf<T>(value: { results?: T[] } | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.results)) return value.results;
  return [];
}

export interface ProposalMemoryRow {
  id: string;
  title: string;
  scope: string;
  content: string;
  tags_json: string | null;
  ai_summary: string | null;
  ai_state: string;
  group_id: string | null;
  pinned_at: number | null;
  weight: number;
  updated_at: number;
  deleted_at: number | null;
}

// 标题规范化：全角/半角统一、小写、折叠空白、去掉常见标点。只用于“标题
// 相同即重复”的判定，不改库里的标题原文。
export function normalizeMemoryTitle(title: string): string {
  const normalized = (title || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, " ")
    .replace(/[\u3000·•:：,，.。!！?？\-—_()（）\[\]【】<>《》"'“”‘’/\\|]+/g, "")
    .trim();
  return normalized || (title || "").trim().toLowerCase();
}

export async function memoryColumns(db: D1Database): Promise<Set<string>> {
  try {
    const rows = rowsOf(await prepare(db, "PRAGMA table_info(memories)").all<{ name?: unknown }>());
    return new Set(rows.map((row) => (typeof row.name === "string" ? row.name : "")));
  } catch {
    return new Set();
  }
}

function keepCandidate(a: ProposalMemoryRow, b: ProposalMemoryRow): ProposalMemoryRow {
  // 置顶优先，其次权重高，再更新时间新；仍并列时取 id 小者，保证确定性。
  const pinnedA = a.pinned_at != null ? 1 : 0;
  const pinnedB = b.pinned_at != null ? 1 : 0;
  if (pinnedA !== pinnedB) return pinnedA > pinnedB ? a : b;
  const weightA = Number(a.weight) || 0;
  const weightB = Number(b.weight) || 0;
  if (weightA !== weightB) return weightA > weightB ? a : b;
  if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at ? a : b;
  return a.id < b.id ? a : b;
}

function memoryMergeReason(a: ProposalMemoryRow, b: ProposalMemoryRow, byVector: boolean): string {
  if (byVector) {
    return `「${a.title}」与「${b.title}」内容向量相似度超过 ${MERGE_VECTOR_SIMILARITY}，疑似同一条记忆`;
  }
  return `「${a.title}」与「${b.title}」标题规范化后相同，疑似重复`;
}

async function scanMemoryMergeProposals(
  db: D1Database,
  memories: ProposalMemoryRow[],
  now: number,
): Promise<number> {
  let created = 0;
  const proposals: Array<{ a: ProposalMemoryRow; b: ProposalMemoryRow; byVector: boolean }> = [];
  const seenPairs = new Set<string>();
  function pairKey(a: ProposalMemoryRow, b: ProposalMemoryRow): string {
    return [a.id, b.id].sort().join("|");
  }
  function enqueue(a: ProposalMemoryRow, b: ProposalMemoryRow, byVector: boolean): void {
    if (a.id === b.id) return;
    const key = pairKey(a, b);
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    proposals.push({ a, b, byVector });
  }

  // 1) 标题规范化相同
  const byTitle = new Map<string, ProposalMemoryRow[]>();
  for (const row of memories) {
    const normalized = normalizeMemoryTitle(row.title);
    if (!normalized) continue;
    // 同名唯一性按 (title, scope) 成立；跨作用域同名是合法的，不能误判重复。
    const key = (row.scope || "") + "\u0000" + normalized;
    const group = byTitle.get(key) ?? [];
    group.push(row);
    byTitle.set(key, group);
  }
  for (const group of byTitle.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) enqueue(group[i] as ProposalMemoryRow, group[j] as ProposalMemoryRow, false);
    }
  }

  // 2) 向量相似度（用 memory_vectors.vector_json 本地余弦，不再调 AI）。
  const recentIds = new Set(
    [...memories]
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, MEMORY_MERGE_VECTOR_LIMIT)
      .map((row) => row.id),
  );
  const vectorRows = rowsOf(
    await prepare(db, "SELECT memory_id, vector_json FROM memory_vectors WHERE vector_json IS NOT NULL").all<{
      memory_id: string;
      vector_json: string;
    }>(),
  );
  const memoryById = new Map(memories.map((row) => [row.id, row]));
  const vectors: Array<{ row: ProposalMemoryRow; values: number[] }> = [];
  for (const entry of vectorRows) {
    if (!recentIds.has(entry.memory_id)) continue;
    const row = memoryById.get(entry.memory_id);
    if (!row) continue;
    try {
      const parsed = JSON.parse(entry.vector_json) as unknown;
      if (!Array.isArray(parsed) || !parsed.length) continue;
      const values: number[] = [];
      for (const value of parsed) {
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("bad");
        values.push(value);
      }
      vectors.push({ row, values });
    } catch {
      continue;
    }
  }
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const left = vectors[i] as { row: ProposalMemoryRow; values: number[] };
      const right = vectors[j] as { row: ProposalMemoryRow; values: number[] };
      if (left.row.scope !== right.row.scope) continue;
      if (cosineSimilarity(left.values, right.values) <= MERGE_VECTOR_SIMILARITY) continue;
      enqueue(left.row, right.row, true);
    }
  }

  for (const proposal of proposals) {
    const keep = keepCandidate(proposal.a, proposal.b);
    const drop = keep.id === proposal.a.id ? proposal.b : proposal.a;
    const payload: ProposalPayload = { kind: "memory", ids: [keep.id, drop.id], keep_id: keep.id };
    const row = await createProposalIfNew(
      db,
      { type: "merge", payload, reason: memoryMergeReason(proposal.a, proposal.b, proposal.byVector) },
      now,
    );
    if (row) created++;
  }
  return created;
}

async function scanExpireProposals(
  db: D1Database,
  memories: ProposalMemoryRow[],
  columns: Set<string>,
  now: number,
): Promise<number> {
  let created = 0;
  for (const row of memories) {
    if (columns.has("expires_at")) {
      const expiresAt = Number((row as ProposalMemoryRow & { expires_at?: unknown }).expires_at);
      if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) {
        const proposal = await createProposalIfNew(
          db,
          {
            type: "expire",
            payload: { kind: "expire", memory_id: row.id, trigger: "expires_at" },
            reason: `「${row.title}」已过 expires_at，建议归档`,
          },
          now,
        );
        if (proposal) created++;
        continue;
      }
    }
    // 长期未访问 + 低权重 + 非置顶。P2 的 last_accessed_at 尚未合并到本分支时，
    // 用 updated_at 近似“最近一次活动”；合并后自动改用真实访问时间。
    const accessAt = columns.has("last_accessed_at")
      ? Number((row as ProposalMemoryRow & { last_accessed_at?: unknown }).last_accessed_at ?? row.updated_at)
      : row.updated_at;
    if (!Number.isFinite(accessAt) || accessAt <= 0) continue;
    if (row.pinned_at != null) continue;
    if ((Number(row.weight) || 0) >= EXPIRE_LOW_WEIGHT) continue;
    if (now - accessAt <= EXPIRE_INACTIVE_DAYS * DAY_MS) continue;
    const proposal = await createProposalIfNew(
      db,
      {
        type: "expire",
        payload: { kind: "expire", memory_id: row.id, trigger: "inactive" },
        reason: `「${row.title}」已 ${EXPIRE_INACTIVE_DAYS} 天未访问、权重低于 ${EXPIRE_LOW_WEIGHT} 且未置顶，建议过期`,
      },
      now,
    );
    if (proposal) created++;
  }
  return created;
}

async function scanSummarizeProposals(
  env: Env,
  memories: ProposalMemoryRow[],
  pendingKeys: Set<string>,
  now: number,
  summarize: (env: Env, title: string, content: string) => Promise<string | null>,
): Promise<number> {
  let created = 0;
  let attempted = 0;
  for (const row of memories) {
    if (attempted >= SUMMARIZE_BATCH) break;
    if (row.ai_state === "pending") continue;
    if (typeof row.ai_summary === "string" && row.ai_summary.trim()) continue;
    if (pendingKeys.has("summarize:" + row.id)) continue;
    attempted++;
    const summary = await summarize(env, row.title, row.content);
    if (!summary) continue;
    const proposal = await createProposalIfNew(
      env.DB,
      {
        type: "summarize",
        payload: { kind: "summarize", memory_id: row.id, summary },
        reason: `「${row.title}」还没有摘要，已生成候选摘要，批准后写入`,
      },
      now,
    );
    if (proposal) created++;
  }
  return created;
}

async function scanTagMergeProposals(
  env: Env,
  pendingKeys: Set<string>,
  now: number,
  ask: MergeMappingFn,
): Promise<number> {
  // 已有待确认的标签整理提案时不重复调 AI。
  for (const key of pendingKeys) if (key.startsWith("merge:tags:")) return 0;
  let plan;
  try {
    plan = await planSimilarTags(env, ask);
  } catch {
    return 0; // AI 不可用/标签超限/映射不合法：这一轮不提案
  }
  if (Object.keys(plan.mapping).length === 0) return 0;
  const proposal = await createProposalIfNew(
    env.DB,
    {
      type: "merge",
      payload: { kind: "tags", mapping: plan.mapping },
      reason: `标签整理：${Object.keys(plan.mapping).length} 个标签可合并到更常用的写法`,
    },
    now,
  );
  return proposal ? 1 : 0;
}

export interface ScanResult {
  created: number;
  byType: Record<string, number>;
}

// 扫描并产出提案。只读记忆、只写 memory_proposals，绝不改 memories。
export async function scanMemoryProposals(
  env: Env,
  now: number,
  deps: {
    askMerge?: MergeMappingFn;
    summarize?: (env: Env, title: string, content: string) => Promise<string | null>;
  } = {},
): Promise<ScanResult> {
  const result: ScanResult = { created: 0, byType: {} };
  const pending = await listProposalRows(env.DB, "pending");
  const pendingKeys = new Set(pending.map((row) => proposalDedupeKey(row.type, parseProposalPayload(row))));
  const memories = rowsOf(
    await prepare(env.DB, "SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY updated_at DESC").all<ProposalMemoryRow>(),
  );
  const columns = await memoryColumns(env.DB);
  const steps: Array<{ key: string; run: () => Promise<number> }> = [
    { key: "merge", run: () => scanMemoryMergeProposals(env.DB, memories, now) },
    { key: "expire", run: () => scanExpireProposals(env.DB, memories, columns, now) },
    {
      key: "summarize",
      run: () => scanSummarizeProposals(env, memories, pendingKeys, now, deps.summarize ?? summarizeMemory),
    },
    { key: "tags", run: () => scanTagMergeProposals(env, pendingKeys, now, deps.askMerge ?? askMergeMapping) },
  ];
  for (const step of steps) {
    try {
      const created = await step.run();
      if (created) {
        result.created += created;
        result.byType[step.key] = (result.byType[step.key] ?? 0) + created;
      }
    } catch {
      // 单类扫描失败不影响其它类；下一轮重试。
    }
  }
  return result;
}

export interface MaintenanceResult {
  pending: PendingProcessResult;
  backfill: BackfillResult;
  proposals: ScanResult;
}

// cron 入口。传入 ctx 只用于可选的 waitUntil 扩展，本身不依赖它。
export async function runMemoryMaintenance(
  env: Env,
  now: number,
  deps: {
    split?: PendingSplitFn;
    askMerge?: MergeMappingFn;
    summarize?: (env: Env, title: string, content: string) => Promise<string | null>;
  } = {},
): Promise<MaintenanceResult> {
  let pending: PendingProcessResult = { scanned: 0, split: 0, tagged: 0, failed: 0 };
  let backfill: BackfillResult = { removed: 0, embedded: 0, pending: 0 };
  let proposals: ScanResult = { created: 0, byType: {} };
  try {
    pending = await processPendingMemories(env, now, PENDING_AI_BATCH, deps.split);
  } catch {
    // 下轮重试
  }
  try {
    backfill = await backfillMemoryVectors(env, now);
  } catch {
    // 下轮重试
  }
  try {
    proposals = await scanMemoryProposals(env, now, { askMerge: deps.askMerge, summarize: deps.summarize });
  } catch {
    // 下轮重试
  }
  return { pending, backfill, proposals };
}
