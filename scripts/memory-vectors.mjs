#!/usr/bin/env node
// 记忆系统 P1-2 / P3 的断言：真实模块 + node:sqlite 的内存 D1 + 假的 AI / Vectorize。
//
//   node scripts/memory-vectors.mjs
//
// 覆盖：
//   - RRF 融合排序纯函数（词法 + 向量并列、仅向量命中、空向量退化）
//   - 提案巡检幂等（同组记忆连跑两次只产 1 条 pending）
//   - 批准 expire 提案后记忆失效且有审计（memory_audit + 提案 decided）
//   - memory_remember 同步落 ai_state=pending；拆分失败保持 pending，
//     成功拆成子条目并软删原文（审计 ai_split）
//   - 向量元数据：新建待生成、回填后恢复、更新后变脏、再回填恢复
//
// 盒子源码用无扩展名相对 import，这里复用 perm-vectors 的解析钩子补 .ts。
// 全过退出 0；任一条不符退出 1。

import { register } from "node:module";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      for (const suffix of [".ts", "/index.ts"]) {
        try { return await next(specifier + suffix, context); } catch {}
      }
    }
    throw error;
  }
}
`),
);

const memory = await import("../src/memory.ts");
const { rrfFuse, memoryContentHash, backfillMemoryVectors, VECTOR_MODEL } =
  await import("../src/memory-vector.ts");
const { scanMemoryProposals, EXPIRE_INACTIVE_DAYS, EXPIRE_LOW_WEIGHT } =
  await import("../src/memory-jobs.ts");
const { listProposalViews, approveProposal } = await import("../src/memory-proposals.ts");
const { processPendingMemories } = await import("../src/memory-ai.ts");
const { TOOL_PERMISSIONS } = await import("../src/tool-permissions.ts");

let checks = 0;
let failures = 0;

function expect(label, actual, expected) {
  checks += 1;
  const shown = JSON.stringify(actual);
  if (shown === JSON.stringify(expected)) {
    console.log(`ok   ${label} = ${shown}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}: got ${shown}, want ${JSON.stringify(expected)}`);
  }
}

function assert(label, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`ok   ${label}${detail ? " " + detail : ""}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}${detail ? " " + detail : ""}`);
  }
}

function rowsOf(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.results)) return value.results;
  return [];
}

// ---- node:sqlite → D1 适配 ----
function makeD1(raw) {
  const wrap = (sql, params = []) => ({
    bind: (...next) => wrap(sql, next),
    first: async () => {
      const row = raw.prepare(sql).get(...params);
      return row === undefined ? null : row;
    },
    all: async () => ({ results: raw.prepare(sql).all(...params) }),
    run: async () => {
      const result = raw.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  });
  return {
    prepare: (sql) => wrap(sql),
    batch: async (statements) => {
      for (const statement of statements) await statement.run();
      return [];
    },
    exec: (sql) => raw.exec(sql),
  };
}

const MIGRATIONS = [
  "0007_memory.sql",
  "0010_soul.sql",
  "0017_memory_tiers.sql",
  "0031_soul_version_manage.sql",
  "0032_soul_pending.sql",
  "0040_memory_fts.sql",
  "0060_memory_lifecycle.sql",
  "0061_soul_sections.sql",
  "0070_memory_vectors.sql",
  "0071_memory_proposals.sql",
  "0072_memory_ai_pending.sql",
];

function freshDb() {
  const raw = new DatabaseSync(":memory:");
  for (const file of MIGRATIONS) {
    raw.exec(readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
  return { raw, db: makeD1(raw) };
}

const channel = { actor: "tester", source: "panel", auditReads: false };
const NOW = 1_760_000_000_000;

function makeVector(text) {
  const values = new Array(1024).fill(0);
  const seed = String(text).length + 1;
  values[seed % 1024] = 1;
  values[(seed * 7) % 1024] = 0.5;
  return values;
}

function fakeAiAndVectors() {
  const vectors = new Map();
  return {
    vectors,
    AI: {
      run: async (_model, input) => ({ data: (input.text || []).map((text) => makeVector(text)) }),
    },
    MEMORY_VECTORS: {
      upsert: async (items) => {
        for (const item of items) vectors.set(item.id, item.values);
      },
      deleteByIds: async (ids) => {
        for (const id of ids) vectors.delete(id);
      },
      query: async () => ({ matches: [] }),
    },
  };
}

function baseEnv(db, extra = {}) {
  return { DB: db, ...extra };
}

// ---- 1. RRF 纯函数 ----
{
  const lexical = ["a", "b", "c"];
  const vector = ["c", "d", "a"];
  const fused = rrfFuse(lexical, vector, 60).map((row) => row.id);
  // a 与 c 两路都在列且名次对称，分数并列；按“首次出现”稳定取 a 前。
  expect("RRF 词法+向量融合顺序", fused, ["a", "c", "b", "d"]);
  const vectorOnly = rrfFuse(lexical, ["z"], 60).map((row) => row.id);
  expect("RRF 仅向量命中追加到尾部", vectorOnly, ["a", "z", "b", "c"]);
  const noVector = rrfFuse(lexical, [], 60).map((row) => row.id);
  expect("RRF 空向量退化为词法顺序", noVector, ["a", "b", "c"]);
}

// ---- 2. 提案巡检幂等 + 批准 merge ----
{
  const { db } = freshDb();
  const env = baseEnv(db);
  await memory.createMemory(
    db,
    { title: "Alpha note!", content: "第一条", tags: [], weight: 10 },
    channel,
    NOW,
  );
  await memory.createMemory(
    db,
    { title: "alpha note", content: "第二条", tags: [], weight: 20 },
    channel,
    NOW,
  );
  const deps = { summarize: async () => null, askMerge: async () => null };
  const first = await scanMemoryProposals(env, NOW, deps);
  const second = await scanMemoryProposals(env, NOW + 1000, deps);
  expect("提案巡检首次产出数量", first.created, 1);
  expect("提案巡检第二次不重复", second.created, 0);
  const pending = await listProposalViews(db, "pending");
  expect("待确认提案数量", pending.length, 1);
  expect("合并提案类型/涉及条数", [pending[0].type, pending[0].memories.length], ["merge", 2]);
  const approved = await approveProposal(env, pending[0].id, "tester", NOW + 2000);
  expect("批准 merge 动作", approved.action, "merge_memories");
  const active = rowsOf(
    await db.prepare("SELECT id FROM memories WHERE deleted_at IS NULL").all(),
  );
  expect("合并后只剩一条有效记忆", active.length, 1);
  const audits = rowsOf(
    await db
      .prepare("SELECT action FROM memory_audit WHERE action = 'merge'")
      .all(),
  );
  assert("合并写审计", audits.length >= 1, `(merge 审计 ${audits.length} 条)`);
}

// ---- 2b. 跨作用域同名不算重复 ----
{
  const { db } = freshDb();
  const env = baseEnv(db);
  await memory.createMemory(
    db,
    { title: "Same title", content: "A", tags: [], weight: 0, scope: "scope-a" },
    channel,
    NOW,
  );
  await memory.createMemory(
    db,
    { title: "Same title", content: "B", tags: [], weight: 0, scope: "scope-b" },
    channel,
    NOW,
  );
  const scan = await scanMemoryProposals(env, NOW, { summarize: async () => null, askMerge: async () => null });
  expect("跨作用域同名不产合并提案", scan.created, 0);
}

// ---- 3. 批准 expire 后失效且有审计 ----
{
  const { db } = freshDb();
  const env = baseEnv(db);
  const row = await memory.createMemory(
    db,
    { title: "Old low weight", content: "很久没用了", tags: [], weight: 5 },
    channel,
    NOW,
  );
  await db
    .prepare("UPDATE memories SET updated_at = ? WHERE id = ?")
    .bind(NOW - (EXPIRE_INACTIVE_DAYS + 5) * 24 * 60 * 60 * 1000, row.id)
    .run();
  const deps = { summarize: async () => null, askMerge: async () => null };
  const scan = await scanMemoryProposals(env, NOW, deps);
  assert("过期巡检产出 expire 提案", scan.byType.expire === 1, `(byType=${JSON.stringify(scan.byType)})`);
  const proposals = await listProposalViews(db, "pending");
  const expire = proposals.find((item) => item.type === "expire" && item.payload.memory_id === row.id);
  assert("expire 提案存在", !!expire, `(阈值 ${EXPIRE_INACTIVE_DAYS} 天 / 权重 < ${EXPIRE_LOW_WEIGHT})`);
  const result = await approveProposal(env, expire.id, "tester", NOW + 1000);
  const after = await db.prepare("SELECT deleted_at FROM memories WHERE id = ?").bind(row.id).first();
  assert("批准后记忆失效", after && after.deleted_at != null, `(deleted_at=${after && after.deleted_at})`);
  const audits = rowsOf(
    await db.prepare("SELECT action, actor FROM memory_audit WHERE memory_id = ?").bind(row.id).all(),
  );
  assert(
    "过期动作有审计",
    audits.some((item) => item.action === "expire" && item.actor === "tester"),
    `(${JSON.stringify(audits)})`,
  );
  expect("批准者与动作", [result.proposal.status, result.proposal.decided_by], ["approved", "tester"]);
  const remaining = await listProposalViews(db, "pending");
  expect("批准后 pending 清空", remaining.length, 0);
}

// ---- 3b. expires_at 列存在时才启用过期分支（PRAGMA 探测）----
{
  const { raw, db } = freshDb();
  const env = baseEnv(db);
  // 合并后 0060 已带 expires_at 列；保留这句 ALTER 的探测意图，列已存在时忽略。
  try { raw.exec("ALTER TABLE memories ADD COLUMN expires_at INTEGER"); } catch { /* 列已存在 */ }
  const row = await memory.createMemory(
    db,
    { title: "Expired by column", content: "带显式过期时间", tags: [], weight: 80 },
    channel,
    NOW,
  );
  await db
    .prepare("UPDATE memories SET expires_at = ? WHERE id = ?")
    .bind(NOW - 1000, row.id)
    .run();
  const deps = { summarize: async () => null, askMerge: async () => null };
  await scanMemoryProposals(env, NOW, deps);
  const proposals = await listProposalViews(db, "pending");
  const expire = proposals.find((item) => item.type === "expire" && item.payload.memory_id === row.id);
  assert("expires_at 探测后产出提案", !!expire);
  expect("过期触发来源", expire && expire.payload.trigger, "expires_at");
}

// ---- 4. memory_remember 落 pending，AI 拆分后台补全 ----
{
  const { db } = freshDb();
  const fake = fakeAiAndVectors();
  const env = baseEnv(db, { AI: fake.AI });
  expect(
    "memory_remember 权限为 memory 域写",
    TOOL_PERMISSIONS.memory_remember,
    { domain: "memory", op: "write" },
  );
  const row = await memory.rememberMemory(db, { text: "随手记：明天买牛奶", tags: ["生活"] }, channel, NOW);
  expect("memory_remember 落 pending", [row.ai_state, row.ai_pending_at], ["pending", NOW]);
  assert("memory_remember 生成标题", row.title.startsWith("随手记"), `(title=${row.title})`);

  // 第一轮 AI 失败：保持 pending，下一轮再试。
  const failed = await processPendingMemories(env, NOW + 1000, 10, async () => null);
  expect("拆分失败计数", failed.failed, 1);
  const still = await db.prepare("SELECT ai_state FROM memories WHERE id = ?").bind(row.id).first();
  expect("失败保留 pending", still.ai_state, "pending");

  // 第二轮成功拆成两条：子条目落库，原文软删并写 ai_split 审计。
  const split = await processPendingMemories(env, NOW + 2000, 10, async () => [
    { content: "明天买牛奶", tags: ["生活"] },
    { content: "顺便买鸡蛋", tags: ["生活"] },
  ]);
  expect("拆分计数", [split.split, split.failed], [1, 0]);
  const active = rowsOf(await db.prepare("SELECT id FROM memories WHERE deleted_at IS NULL").all());
  expect("拆分后有效记忆条数", active.length, 2);
  const original = await db.prepare("SELECT deleted_at FROM memories WHERE id = ?").bind(row.id).first();
  assert("原文被软删", original.deleted_at != null);
  const audits = rowsOf(
    await db.prepare("SELECT action, diff_json FROM memory_audit WHERE memory_id = ?").bind(row.id).all(),
  );
  assert(
    "拆分写 ai_split 审计",
    audits.some((item) => item.action === "ai_split"),
    `(${JSON.stringify(audits)})`,
  );
}

// ---- 5. 向量元数据：新建待生成 → 回填恢复 → 更新变脏 → 再回填 ----
{
  const { db } = freshDb();
  const fake = fakeAiAndVectors();
  const env = baseEnv(db, { AI: fake.AI, MEMORY_VECTORS: fake.MEMORY_VECTORS });
  const row = await memory.createMemory(
    db,
    { title: "Vector seed", content: "原始内容", tags: [], weight: 0 },
    channel,
    NOW,
  );
  const metaCount = async () =>
    rowsOf(await db.prepare("SELECT memory_id FROM memory_vectors").all()).length;
  expect("新建后向量待生成", await metaCount(), 0);
  const first = await backfillMemoryVectors(env, NOW);
  expect("回填嵌入计数", first.embedded, 1);
  expect("回填后元数据恢复", await metaCount(), 1);
  const meta = await db
    .prepare("SELECT content_hash, model FROM memory_vectors WHERE memory_id = ?")
    .bind(row.id)
    .first();
  const expectedHash = await memoryContentHash({ title: row.title, content: row.content });
  expect("元数据 hash/model", [meta.content_hash, meta.model], [expectedHash, VECTOR_MODEL]);
  assert("Vectorize 收到向量", fake.vectors.has(row.id), `(${JSON.stringify(fake.vectors.get(row.id)?.length)})`);

  await memory.updateMemory(db, row.id, { content: "更新后的内容" }, channel, NOW + 1000);
  expect("更新后向量变脏", await metaCount(), 0);
  const second = await backfillMemoryVectors(env, NOW + 2000);
  expect("再次回填", second.embedded, 1);
  const refreshed = await db
    .prepare("SELECT content_hash FROM memory_vectors WHERE memory_id = ?")
    .bind(row.id)
    .first();
  expect("回填恢复新 hash", refreshed.content_hash, await memoryContentHash({
    title: "Vector seed",
    content: "更新后的内容",
  }));

  await memory.deleteMemory(db, row.id, channel, NOW + 3000);
  const third = await backfillMemoryVectors(env, NOW + 4000);
  expect("删除记忆清向量", [third.removed, await metaCount()], [1, 0]);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
