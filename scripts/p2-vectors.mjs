#!/usr/bin/env node
// P2（记忆生命周期 + Soul 分段 + Memory/Soul 打通）的断言：
//   /data/workspace/node24/bin/node scripts/p2-vectors.mjs
//
// 用 node:sqlite 在内存里搭一个假 D1（实现 prepare/bind/run/first/all/batch
// 的形状，batch 带事务），按顺序应用与本功能相关的迁移（0007/0010/0017/
// 0031/0032/0060/0061），直接跑 src/memory.ts、src/soul.ts、
// src/tool-permissions.ts 的真实代码。
//
// 覆盖：content_hash 精确去重（含 agent_name 隔离）、supersede 取代链、
// 过期排除、memory_get 访问统计节流、kind 校验、core_memories 归属过滤与
// 4000 字预算、soul_patch 超限 400、写他人 Soul 的权限口径、patch 落
// pending、批准后分段与全文一致、面板整篇覆盖清分段、soul_diff 默认对比。

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

// ---------------------------------------------------------------------------
// 假 D1
const sqlite = new DatabaseSync(":memory:");

class FakeStatement {
  constructor(sql, values = []) {
    this.sql = sql;
    this.values = values;
  }
  bind(...values) {
    return new FakeStatement(this.sql, values);
  }
  async run() {
    const info = sqlite.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(info.changes) } };
  }
  async first() {
    const row = sqlite.prepare(this.sql).get(...this.values);
    return row === undefined ? null : row;
  }
  async all() {
    return { results: sqlite.prepare(this.sql).all(...this.values) };
  }
}

const db = {
  prepare(sql) {
    return new FakeStatement(sql);
  },
  async batch(statements) {
    sqlite.exec("BEGIN");
    try {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      sqlite.exec("COMMIT");
      return out;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  },
};

for (const name of [
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
]) {
  sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
}

// ---------------------------------------------------------------------------
const memory = await import("../src/memory.ts");
const soul = await import("../src/soul.ts");
const { parsePermissions } = await import("../src/permissions.ts");
const { toolAccessError, toolPermissionOf } = await import("../src/tool-permissions.ts");

let checks = 0;
let failures = 0;

function expect(label, actual, expected) {
  checks += 1;
  const shown = JSON.stringify(actual);
  const wanted = JSON.stringify(expected);
  if (shown === wanted) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}: got ${shown}, want ${wanted}`);
  }
}

async function expectThrow(label, fn, predicate) {
  checks += 1;
  try {
    await fn();
    failures += 1;
    console.error(`FAIL ${label}: expected a throw, got success`);
  } catch (error) {
    if (predicate(error)) console.log(`ok   ${label}`);
    else {
      failures += 1;
      console.error(`FAIL ${label}: wrong error: ${error && error.message}`);
    }
  }
}

const T0 = 1_700_000_000_000;
const panel = { actor: "user", source: "panel", auditReads: false };
const mcpA = { actor: "agt_a", source: "mcp", auditReads: true, agentName: "AgentA" };
const mcpB = { actor: "agt_b", source: "mcp", auditReads: true, agentName: "AgentB" };

function memoryCount() {
  return sqlite.prepare("SELECT COUNT(*) AS n FROM memories").get().n;
}

// ---------------------------------------------------------------------------
// 记忆：content_hash 精确去重
const first = await memory.upsertMemory(db, { title: "事实一", content: "hello world" }, mcpA, T0);
const again = await memory.upsertMemory(db, { title: "事实一", content: "hello world" }, mcpA, T0);
expect("去重：同 Agent 同内容回同一条", again.id, first.id);
expect("去重：不重复插入", memoryCount(), 1);
expect("去重：命中不升版本", again.version, 1);
expect("归属：MCP 写入默认归属调用 Agent", first.agent_name, "AgentA");

const otherAgent = await memory.upsertMemory(db, { title: "事实一", content: "hello world" }, mcpB, T0);
expect("同 title+scope 跨 Agent 仍是同一条（既有 upsert 口径）", otherAgent.id, first.id);

const panelOne = await memory.createMemory(db, { title: "面板甲", content: "panel shared" }, panel, T0);
const panelDup = await memory.createMemory(db, { title: "面板甲", content: "panel shared" }, panel, T0);
expect("面板新建完全重复也去重（返回既有行不报错）", panelDup.id, panelOne.id);
expect("面板记忆归属为全局", panelOne.agent_name, null);

// kind 校验
await expectThrow("kind 非法值被拒", () => memory.upsertMemory(db, { title: "坏 kind", content: "c", kind: "bogus" }, panel, T0), (e) => e.status === 400);
const kinded = await memory.upsertMemory(db, { title: "偏好一", content: "likes tea", kind: "preference", agent_name: "AgentA" }, panel, T0);
expect("kind 合法写入", kinded.kind, "preference");
expect("入参显式 agent_name 优先", kinded.agent_name, "AgentA");

// ---------------------------------------------------------------------------
// 记忆：supersede 取代链
const oldRow = await memory.createMemory(db, { title: "旧地址", content: "alpha-unique-token" }, panel, T0);
const newRow = await memory.upsertMemory(db, { title: "新地址", content: "beta-token", supersedes_id: oldRow.id }, panel, T0);
expect("新条目记 supersedes_id", newRow.supersedes_id, oldRow.id);
const oldAfter = await memory.getMemoryRow(db, oldRow.id);
expect("旧条目被标记失效但保留行", oldAfter.invalidated, 1);
const listedIds = (await memory.listMemories(db, {})).map((row) => row.id);
expect("list 不含被取代的旧条目", listedIds.includes(oldRow.id), false);
expect("list 含新条目", listedIds.includes(newRow.id), true);
const searchOld = await memory.searchMemories(db, "alpha-unique-token");
expect("search 不含被取代的旧条目", searchOld.length, 0);
const gotOld = await memory.readMemory(db, oldRow.id, panel, T0);
expect("get 仍能取到被取代的旧条目", gotOld && gotOld.id, oldRow.id);
expect("get 返回 invalidated 标记", memory.memoryPublic(gotOld).invalidated, true);

// ---------------------------------------------------------------------------
// 记忆：过期排除
const expired = await memory.createMemory(db, { title: "已过期", content: "gone-token", expires_at: T0 - 1000 }, panel, T0);
const listedAfterExpiry = (await memory.listMemories(db, {})).map((row) => row.id);
expect("list 排除已过期", listedAfterExpiry.includes(expired.id), false);
expect("search 排除已过期", (await memory.searchMemories(db, "gone-token")).length, 0);
const gotExpired = await memory.readMemory(db, expired.id, panel, T0);
expect("get 返回 expired 标记", memory.memoryPublic(gotExpired).expired, true);

// ---------------------------------------------------------------------------
// 记忆：访问统计节流
const hot = await memory.createMemory(db, { title: "热记忆", content: "hot" }, panel, T0);
const read1 = await memory.readMemory(db, hot.id, panel, T0);
expect("首次读 access_count=1", read1.access_count, 1);
const read2 = await memory.readMemory(db, hot.id, panel, T0 + 30 * 60 * 1000);
expect("1 小时内再读不重复计数", read2.access_count, 1);
const read3 = await memory.readMemory(db, hot.id, panel, T0 + 61 * 60 * 1000);
expect("超过 1 小时再读才计数", read3.access_count, 2);
expect("last_accessed_at 已更新", read3.last_accessed_at, T0 + 61 * 60 * 1000);

// ---------------------------------------------------------------------------
// core_memories：归属过滤 + 预算
await memory.createMemory(db, { title: "核心A", content: "core-a", pinned: true, weight: 90, agent_name: "AgentA" }, panel, T0);
await memory.createMemory(db, { title: "核心G", content: "core-g", pinned: true }, panel, T0);
await memory.createMemory(db, { title: "核心B", content: "core-b", pinned: true, agent_name: "AgentB" }, panel, T0);
await memory.createMemory(db, { title: "普通A", content: "plain-a", agent_name: "AgentA" }, panel, T0);
const coreA = await memory.listCoreMemories(db, "AgentA", T0);
const coreTitles = coreA.map((entry) => entry.title);
expect("core 含本人置顶", coreTitles.includes("核心A"), true);
expect("core 含全局置顶", coreTitles.includes("核心G"), true);
expect("core 不含他人置顶", coreTitles.includes("核心B"), false);
expect("core 不含未置顶", coreTitles.includes("普通A"), false);

for (let i = 0; i < 30; i++) {
  await memory.createMemory(db, { title: `填充${i}`, content: "x".repeat(200) + i, pinned: true }, panel, T0);
}
const coreBudget = await memory.listCoreMemories(db, "AgentA", T0);
const budgetUsed = coreBudget.reduce((sum, entry) => sum + entry.id.length + entry.title.length + entry.snippet.length, 0);
expect("core 总字符不超 4000", budgetUsed <= 4000, true);
expect("core 预算截断了条数", coreBudget.length < 33, true);

// ---------------------------------------------------------------------------
// Soul：分段与 patch
const soulA = await soul.createSoul(db, { agent_name: "AgentA", content: "line1\nline2\nline3" }, "user", "panel", T0);
expect("新建 Soul 无分段", await soul.getSoulSections(db, soulA.id), null);

await expectThrow(
  "soul_patch 超上限 400 带段名与超出字数",
  () => soul.patchSoulByName(db, "AgentA", "persona", "x".repeat(2001), null, "agt_a", "mcp", T0),
  (e) => e.status === 400 && e.message.includes("persona") && e.message.includes("超出上限 1 字"),
);
await expectThrow(
  "soul_patch 段名非法 400",
  () => soul.patchSoulByName(db, "AgentA", "bogus", "c", null, "agt_a", "mcp", T0),
  (e) => e.status === 400,
);

// 权限口径：soul_patch 与 soul_update 一致
expect("soul_patch 登记为 soul write", toolPermissionOf("soul_patch"), { domain: "soul", op: "write" });
expect("soul_diff 登记为 soul read", toolPermissionOf("soul_diff"), { domain: "soul", op: "read" });
const soulWriter = parsePermissions('{"soul":{"read":false,"write":true}}');
const soulAny = parsePermissions('{"soul":{"read":false,"write":true},"advanced":{"soul_write_any":true}}');
expect("patch 写自己放行", toolAccessError("soul_patch", soulWriter, "AgentA", { agent_name: "AgentA" }), null);
expect(
  "patch 写他人被拒",
  toolAccessError("soul_patch", soulWriter, "AgentA", { agent_name: "AgentB" }),
  "只能写自己的 Soul；要代写其他 Agent 的 Soul，需要 soul_write_any 权限",
);
expect("patch 写他人 + soul_write_any 放行", toolAccessError("soul_patch", soulAny, "AgentA", { agent_name: "AgentB" }), null);

// patch 落 pending：全文与分段都不动
const patched = await soul.patchSoulByName(db, "AgentA", "persona", "I am A.", null, "agt_a", "mcp", T0);
expect("patch 产生 pending 版本", patched.pending_version, 2);
const beforeApprove = await soul.getSoulById(db, soulA.id);
expect("批准前全文不变", beforeApprove.content, "line1\nline2\nline3");
expect("批准前分段不变（仍无分段）", await soul.getSoulSections(db, soulA.id), null);

// 批准：全文 = 各段拼接，分段表与之一致
const approved = await soul.approveSoulVersion(db, soulA.id, 2, "user", T0 + 1000);
expect("批准后全文为分段拼接", approved.content, "I am A.\n\nline1\nline2\nline3");
const sectionsAfter = await soul.getSoulSections(db, soulA.id);
expect("批准后分段 persona", sectionsAfter && sectionsAfter.persona, "I am A.");
expect("批准后未分段的旧全文进 learned_context", sectionsAfter && sectionsAfter.learned_context, "line1\nline2\nline3");

// soul_get 完整视图：分段 + core_memories
const view = await soul.soulFullView(db, approved, T0 + 2000);
expect("完整视图带分段", view.sections && view.sections.persona, "I am A.");
expect("完整视图带 core_memories", Array.isArray(view.core_memories) && view.core_memories.some((entry) => entry.title === "核心A"), true);

// 面板整篇覆盖：分段立即失效
const overwritten = await soul.updateSoul(db, soulA.id, { content: "brand new" }, "user", "panel", T0 + 3000);
expect("面板覆盖后全文", overwritten.content, "brand new");
expect("面板覆盖后分段清空", await soul.getSoulSections(db, soulA.id), null);

// soul_diff：缺省对比当前与上一个已生效版本
const diff = await soul.diffSoulVersions(db, "AgentA", null, null);
expect("diff from_version", diff.from_version, 2);
expect("diff to_version", diff.to_version, 3);
expect("diff 新增行", diff.added_lines, ["brand new"]);
expect("diff 删除行", diff.removed_lines, ["I am A.", "", "line1", "line2", "line3"]);
expect("diff 未变行数", diff.unchanged_lines, 0);

// patch 给不存在的 Agent：先落 pending 草稿（v1），批准后才生效并带分段
const createdByPatch = await soul.patchSoulByName(db, "NewAgent", "rules", "be kind", null, "agt_n", "mcp", T0);
expect("新 Agent patch 落 pending v1", createdByPatch.pending_version, 1);
const approvedNew = await soul.approveSoulVersion(db, createdByPatch.id, 1, "user", T0 + 1000);
expect("新 Agent 批准后全文", approvedNew.content, "be kind");
const newSections = await soul.getSoulSections(db, createdByPatch.id);
expect("新 Agent 批准后分段", newSections && newSections.rules, "be kind");

// ---------------------------------------------------------------------------
console.log(`\n${checks} checks, ${failures} failure(s)`);
if (failures > 0) process.exit(1);
console.log("p2 vectors passed");
