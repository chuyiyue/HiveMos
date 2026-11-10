// 后台整理提案：只落提案、不自动改库。批准端点按 payload 执行动作并写审计；
// 拒绝只改状态。cron 扫描在 memory-jobs.ts，这里只放数据与执行。

import { prepare } from "./registry";
import type { D1Database, Env } from "./env";
import {
  MemError,
  applyMemorySummary,
  invalidateMemoryWithAudit,
  mergeMemories,
} from "./memory";
import { applyTagPlan } from "./memory-ai";

export const PROPOSAL_TYPES = ["merge", "expire", "supersede", "summarize"] as const;
export type ProposalType = (typeof PROPOSAL_TYPES)[number];

export interface ProposalRow {
  id: string;
  type: ProposalType;
  payload_json: string;
  reason: string;
  status: string;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

export type ProposalPayload = Record<string, unknown>;

export interface ProposalMemoryRef {
  id: string;
  title: string;
}

export interface ProposalView {
  id: string;
  type: ProposalType;
  payload: ProposalPayload;
  reason: string;
  status: string;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
  memories: ProposalMemoryRef[];
}

function rowsOf<T>(value: { results?: T[] } | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.results)) return value.results;
  return [];
}

function newId(): string {
  return "mprop_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

export function parseProposalPayload(row: ProposalRow): ProposalPayload {
  try {
    const value = JSON.parse(row.payload_json) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as ProposalPayload) : {};
  } catch {
    return {};
  }
}

// 一条提案可能涉及一条或多条记忆；UI 用它取标题。
export function proposalMemoryIds(payload: ProposalPayload): string[] {
  const ids: string[] = [];
  function add(value: unknown): void {
    if (typeof value === "string" && value.trim() && !ids.includes(value.trim())) ids.push(value.trim());
  }
  add(payload.memory_id);
  add(payload.keep_id);
  add(payload.old_id);
  add(payload.new_id);
  if (Array.isArray(payload.ids)) for (const id of payload.ids) add(id);
  return ids;
}

function sortedEntries(value: Record<string, unknown>): string {
  return Object.keys(value)
    .sort()
    .map((key) => key + "=" + String(value[key]))
    .join("|");
}

// 同一组目标已有 pending 提案时不再生成。key 不含 reason/时间，只认动作对象。
export function proposalDedupeKey(type: ProposalType, payload: ProposalPayload): string {
  if (type === "merge" && payload.kind === "tags" && payload.mapping && typeof payload.mapping === "object") {
    return "merge:tags:" + sortedEntries(payload.mapping as Record<string, unknown>);
  }
  if (type === "merge" && Array.isArray(payload.ids)) {
    const ids = payload.ids.filter((id): id is string => typeof id === "string").sort();
    return "merge:memory:" + ids.join(",");
  }
  const ids = proposalMemoryIds(payload).sort();
  return type + ":" + ids.join(",");
}

export async function getProposalRow(db: D1Database, id: string): Promise<ProposalRow | null> {
  return (
    (await prepare(db, "SELECT * FROM memory_proposals WHERE id = ?", [id]).first<ProposalRow>()) ?? null
  );
}

export async function listProposalRows(db: D1Database, status = "pending"): Promise<ProposalRow[]> {
  return rowsOf(
    await prepare(
      db,
      "SELECT * FROM memory_proposals WHERE status = ? ORDER BY created_at ASC",
      [status],
    ).all<ProposalRow>(),
  );
}

// 幂等插入：同一 type + 动作对象已有 pending 提案就跳过，返回 null。
export async function createProposalIfNew(
  db: D1Database,
  input: { type: ProposalType; payload: ProposalPayload; reason: string },
  now: number,
): Promise<ProposalRow | null> {
  const key = proposalDedupeKey(input.type, input.payload);
  const existing = await listProposalRows(db, "pending");
  if (existing.some((row) => proposalDedupeKey(row.type, parseProposalPayload(row)) === key)) return null;
  const id = newId();
  const payloadJson = JSON.stringify(input.payload);
  await prepare(
    db,
    "INSERT INTO memory_proposals (id, type, payload_json, reason, status, created_at, decided_at, decided_by) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL)",
    [id, input.type, payloadJson, input.reason, now],
  ).run();
  const row = await getProposalRow(db, id);
  return row ?? null;
}

export async function listProposalViews(db: D1Database, status = "pending"): Promise<ProposalView[]> {
  const rows = await listProposalRows(db, status);
  const allIds = new Set<string>();
  for (const row of rows) for (const id of proposalMemoryIds(parseProposalPayload(row))) allIds.add(id);
  const titles = new Map<string, string>();
  if (allIds.size) {
    const ids = Array.from(allIds);
    const placeholders = ids.map(() => "?").join(", ");
    const found = rowsOf(
      await prepare(db, "SELECT id, title FROM memories WHERE id IN (" + placeholders + ")", ids).all<{ id: string; title: string }>(),
    );
    for (const row of found) titles.set(row.id, row.title);
  }
  return rows.map((row) => {
    const payload = parseProposalPayload(row);
    return {
      id: row.id,
      type: row.type,
      payload,
      reason: row.reason,
      status: row.status,
      created_at: row.created_at,
      decided_at: row.decided_at ?? null,
      decided_by: row.decided_by ?? null,
      memories: proposalMemoryIds(payload).map((id) => ({ id, title: titles.get(id) ?? "（记忆已不存在）" })),
    };
  });
}

export async function rejectProposal(
  db: D1Database,
  id: string,
  actor: string,
  now: number,
): Promise<ProposalRow> {
  const row = await getProposalRow(db, id);
  if (!row) throw new MemError("提案不存在", 404);
  if (row.status !== "pending") throw new MemError("只有待确认的提案可以拒绝", 409);
  await prepare(
    db,
    "UPDATE memory_proposals SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'",
    [now, actor, id],
  ).run();
  const updated = await getProposalRow(db, id);
  if (!updated) throw new MemError("写入后读取失败", 500);
  return updated;
}

export interface ApproveResult {
  proposal: ProposalRow;
  action: string;
  updated: number;
}

// 批准是唯一会执行后台整理动作的入口。payload 已包含执行所需数据（摘要等），
// 这里不再调用 AI。动作与审计全部成功后才把提案标成 approved。
export async function approveProposal(
  env: Env,
  id: string,
  actor: string,
  now: number,
): Promise<ApproveResult> {
  const row = await getProposalRow(env.DB, id);
  if (!row) throw new MemError("提案不存在", 404);
  if (row.status !== "pending") throw new MemError("只有待确认的提案可以批准", 409);
  const payload = parseProposalPayload(row);
  const channel = { actor, source: "panel", auditReads: false };
  let action = "";
  let updated = 0;
  if (row.type === "expire") {
    const memoryId = typeof payload.memory_id === "string" ? payload.memory_id : "";
    if (!memoryId) throw new MemError("提案缺少 memory_id", 400);
    await invalidateMemoryWithAudit(env.DB, memoryId, channel, now, "expire", {
      trigger: payload.trigger ?? null,
    });
    action = "expire";
    updated = 1;
  } else if (row.type === "summarize") {
    const memoryId = typeof payload.memory_id === "string" ? payload.memory_id : "";
    const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
    if (!memoryId || !summary) throw new MemError("提案缺少摘要内容", 400);
    await applyMemorySummary(env.DB, memoryId, summary, channel, now);
    action = "summarize";
    updated = 1;
  } else if (row.type === "supersede") {
    const oldId = typeof payload.old_id === "string" ? payload.old_id : "";
    const newId = typeof payload.new_id === "string" ? payload.new_id : "";
    if (!oldId) throw new MemError("提案缺少 old_id", 400);
    await invalidateMemoryWithAudit(env.DB, oldId, channel, now, "supersede", { new_id: newId || null });
    action = "supersede";
    updated = 1;
  } else if (row.type === "merge") {
    if (payload.kind === "tags") {
      const mapping = payload.mapping;
      if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) throw new MemError("提案缺少标签映射", 400);
      const plan: Record<string, string> = {};
      for (const [from, to] of Object.entries(mapping as Record<string, unknown>)) {
        if (typeof to === "string" && from.trim() && to.trim()) plan[from.trim()] = to.trim();
      }
      if (!Object.keys(plan).length) throw new MemError("提案缺少标签映射", 400);
      updated = await applyTagPlan(env, plan, now);
      action = "merge_tags";
    } else {
      const keepId = typeof payload.keep_id === "string" ? payload.keep_id : "";
      const ids = Array.isArray(payload.ids) ? payload.ids.filter((value): value is string => typeof value === "string") : [];
      if (!keepId || !ids.length) throw new MemError("提案缺少要合并的记忆", 400);
      await mergeMemories(env.DB, keepId, ids, channel, now);
      action = "merge_memories";
      updated = 1;
    }
  } else {
    throw new MemError("未知的提案类型", 400);
  }
  await prepare(
    env.DB,
    "UPDATE memory_proposals SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'",
    [now, actor, id],
  ).run();
  const decided = await getProposalRow(env.DB, id);
  if (!decided) throw new MemError("写入后读取失败", 500);
  return { proposal: decided, action, updated };
}
