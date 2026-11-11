#!/usr/bin/env node
// 保险库纯指引（vault_guide_list + 管理面领域层）的断言脚本：跑
// src/tool-permissions.ts 与 src/vault-guide.ts。
//
//   node scripts/vault-guide-vectors.mjs
//   （普通 node ≥ 22 也行：类型剥离默认开启，这些模块不依赖 Worker 全局）
//
// 覆盖定版验收口径：
//   1. 域门：vault_guide_list 登记为 vault.read；无 vault.read 时
//      tools/list 不可见、tools/call 被拒；有 vault.read 时域门放行
//      （另两重门在领域层判，不在本组）。
//   2. 引用本地格式校验：1password 型只收 op:// 形状，bitwarden /
//      other 只要求非空；全程不发任何外部请求（本模块根本没有 fetch）。
//   3. 可见性矩阵（listGuideForAgent）：有有效 grant 可见／无 grant
//      不见／技能开关关不见／服务商停用不见／条目停用不见／grant
//      停用不见／grant 过期不见／grant 无过期时间可见。不见的情形
//      一律返回空集、不区分原因。
//   4. 审计：一次调用返回 N 条就恰好写 N 条 view 审计（agent、条目、
//      meta 对得上）；返回空集时一条都不写。
//   5. 管理面领域规则：同条目同 agent 重复授权 409；服务商下有条目
//      时删除 409；条目删除连带删授权、审计保留；服务商改类型后既有
//      引用不合新口径时 409。
//   6. 无值字段：迁移 0077 四张表的列名清单里不许出现能装值的列名。
//
// 数据库用内存里的假 D1：只实现本模块真正会发的 SQL 形状（单表
// INSERT / UPDATE / DELETE / 等值 WHERE + ORDER BY + LIMIT 的 SELECT、
// COUNT、以及可见性那条三表 JOIN 的等价语义），遇到别的语句直接
// 报错，避免测试悄悄放过没覆盖的查询。
//
// 全过时以 0 退出并打印计数；任一条不符以 1 退出。

import { readFileSync } from "node:fs";
import { register } from "node:module";

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

const { parsePermissions } = await import("../src/permissions.ts");
const { TOOL_PERMISSIONS, toolAccessError, toolVisibleToAgent } = await import("../src/tool-permissions.ts");
const guide = await import("../src/vault-guide.ts");
const {
  GuideError,
  createGuideEntry,
  createGuideGrant,
  createGuideProvider,
  deleteGuideEntry,
  deleteGuideProvider,
  getVaultGuideEnabled,
  listGuideAudit,
  listGuideForAgent,
  listGuideGrants,
  setVaultGuideEnabled,
  updateGuideEntry,
  updateGuideGrant,
  updateGuideProvider,
  validateGuideRef,
} = guide;

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

async function expectGuideError(label, promise, status) {
  checks += 1;
  try {
    await promise;
    failures += 1;
    console.error(`FAIL ${label}: expected GuideError ${status}, call succeeded`);
  } catch (error) {
    if (error instanceof GuideError && error.status === status) {
      console.log(`ok   ${label} -> GuideError ${status} ${error.message}`);
    } else {
      failures += 1;
      console.error(`FAIL ${label}: expected GuideError ${status}, got ${String(error)}`);
    }
  }
}

// ---- 假 D1 ------------------------------------------------------------------

const tables = {
  agents: [],
  vault_guide_provider: [],
  vault_guide_entry: [],
  vault_guide_grant: [],
  vault_guide_audit: [],
};

function compareValues(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return a < b ? -1 : 1;
}

function runSql(rawSql, vals) {
  const sql = rawSql.replace(/\s+/g, " ").trim();
  let m = /^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)$/.exec(sql);
  if (m) {
    const cols = m[2].split(",").map((c) => c.trim());
    const row = {};
    cols.forEach((col, i) => (row[col] = vals[i]));
    tables[m[1]].push(row);
    return [];
  }
  m = /^UPDATE (\w+) SET (.+) WHERE id = \?$/.exec(sql);
  if (m) {
    const sets = m[2].split(",").map((part) => part.trim().split(" = ")[0]);
    const row = tables[m[1]].find((r) => r.id === vals[vals.length - 1]);
    if (row) sets.forEach((col, i) => (row[col] = vals[i]));
    return [];
  }
  m = /^DELETE FROM (\w+) WHERE (\w+) = \?$/.exec(sql);
  if (m) {
    tables[m[1]] = tables[m[1]].filter((r) => r[m[2]] !== vals[0]);
    return [];
  }
  m = /^SELECT COUNT\(\*\) AS n FROM (\w+) WHERE (\w+) = \?$/.exec(sql);
  if (m) return [{ n: tables[m[1]].filter((r) => r[m[2]] === vals[0]).length }];
  if (sql.startsWith("SELECT e.id, e.provider_id")) {
    // 可见性三表 JOIN 的等价语义：联表 + 五个有效性条件 + 排序。
    const [agentId, now] = vals;
    const out = [];
    for (const entry of tables.vault_guide_entry) {
      const provider = tables.vault_guide_provider.find((p) => p.id === entry.provider_id);
      if (!provider) continue;
      const grant = tables.vault_guide_grant.find((g) => g.entry_id === entry.id && g.agent_id === agentId);
      if (!grant) continue;
      if (Number(entry.enabled) !== 1 || Number(provider.enabled) !== 1 || Number(grant.enabled) !== 1) continue;
      if (grant.expires_at !== null && grant.expires_at !== undefined && Number(grant.expires_at) <= now) continue;
      out.push({ ...entry, provider_name: provider.name, provider_type: provider.type, provider_connect_guide: provider.connect_guide });
    }
    out.sort((a, b) => compareValues(a.provider_name, b.provider_name) || compareValues(a.name, b.name) || compareValues(a.id, b.id));
    return out;
  }
  m = /^SELECT (.+) FROM (\w+)( WHERE (.+?))?( ORDER BY (.+?))?( LIMIT \?)?$/.exec(sql);
  if (m) {
    const cols = m[1].split(",").map((c) => c.trim());
    let rows = [...tables[m[2]]];
    let vi = 0;
    if (m[4]) {
      for (const cond of m[4].split(" AND ")) {
        const cm = /^(\w+) = \?$/.exec(cond.trim());
        if (!cm) throw new Error("假 D1 不认的 WHERE: " + cond);
        const value = vals[vi++];
        rows = rows.filter((r) => r[cm[1]] === value);
      }
    }
    if (m[6]) {
      const keys = m[6].split(",").map((part) => {
        const [col, dir] = part.trim().split(/\s+/);
        return { col, desc: (dir || "ASC").toUpperCase() === "DESC" };
      });
      rows.sort((a, b) => {
        for (const key of keys) {
          const c = compareValues(a[key.col], b[key.col]);
          if (c !== 0) return key.desc ? -c : c;
        }
        return 0;
      });
    }
    if (m[7]) rows = rows.slice(0, vals[vi++]);
    return rows.map((row) => {
      const out = {};
      for (const col of cols) out[col] = row[col] === undefined ? null : row[col];
      return out;
    });
  }
  throw new Error("假 D1 不认的 SQL: " + sql);
}

const fakeDb = {
  prepare(sql) {
    const stmt = {
      vals: [],
      bind(...vals) {
        this.vals = vals;
        return this;
      },
      async all() {
        return { results: runSql(sql, this.vals) };
      },
      async first() {
        const rows = runSql(sql, this.vals);
        return rows.length > 0 ? rows[0] : null;
      },
      async run() {
        runSql(sql, this.vals);
        return { success: true };
      },
    };
    return stmt;
  },
};

// ---- 1. 域门 -----------------------------------------------------------------

const withVaultRead = parsePermissions({ vault: { read: true, write: false } });
const noVault = parsePermissions({});
expect("登记：vault_guide_list 域门", TOOL_PERMISSIONS.vault_guide_list, { domain: "vault", op: "read" });
expect("有 vault.read 时工具可见", toolVisibleToAgent("vault_guide_list", withVaultRead), true);
expect("无 vault.read 时工具不可见", toolVisibleToAgent("vault_guide_list", noVault), false);
expect("有 vault.read 时域门放行", toolAccessError("vault_guide_list", withVaultRead, "Tester", {}), null);
expect(
  "无 vault.read 时调用被拒",
  typeof toolAccessError("vault_guide_list", noVault, "Tester", {}),
  "string",
);

// ---- 2. 引用本地格式校验 -------------------------------------------------------

expect("op:// 完整形状通过", validateGuideRef("1password", "op://工作库/GitHub/token"), null);
expect("op:// 两段通过", validateGuideRef("1password", "op://工作库/GitHub"), null);
expect("op:// 一段被拒", typeof validateGuideRef("1password", "op://只有库"), "string");
expect("op:// 空壳被拒", typeof validateGuideRef("1password", "op://"), "string");
expect("非 op 引用被拒", typeof validateGuideRef("1password", "https://example.com/x"), "string");
expect("BW 自由文本通过", validateGuideRef("bitwarden", "project 8f3c / 机密 91ab"), null);
expect("BW 空被拒", typeof validateGuideRef("bitwarden", "  "), "string");
expect("other 自由文本通过", validateGuideRef("other", "KeePass 条目 #12"), null);

// ---- 3-5. 目录、授权与可见性矩阵 ------------------------------------------------

const NOW = 1_800_000_000_000;
for (const [id, name] of [["agt_a", "AgentA"], ["agt_b", "AgentB"], ["agt_c", "AgentC"]]) {
  tables.agents.push({ id, name, vault_guide_enabled: 0 });
}
await setVaultGuideEnabled(fakeDb, "agt_a", true);
await setVaultGuideEnabled(fakeDb, "agt_b", true);
expect("开关写入后可读回（A 开）", await getVaultGuideEnabled(fakeDb, "agt_a"), true);
expect("开关默认关（C 关）", await getVaultGuideEnabled(fakeDb, "agt_c"), false);
expect("不存在的 agent 开关为关", await getVaultGuideEnabled(fakeDb, "agt_missing"), false);

const p1 = await createGuideProvider(fakeDb, { name: "1Password 团队库", type: "1password", connect_guide: "装 op CLI，用服务账号登录后按 op:// 引用取值" });
const p2 = await createGuideProvider(fakeDb, { name: "Bitwarden 团队", type: "bitwarden", connect_guide: "bws 按 project 与机密 ID 取值" });
const e1 = await createGuideEntry(fakeDb, { provider_id: p1.id, name: "GitHub 令牌", ref: "op://工作库/GitHub/token", purpose: "推代码", inject_hint: "bearer", allowed_hosts: ["api.github.com"], tags: ["代码"] });
const e2 = await createGuideEntry(fakeDb, { provider_id: p1.id, name: "npm 令牌", ref: "op://工作库/npm/token" });
const e3 = await createGuideEntry(fakeDb, { provider_id: p2.id, name: "部署密钥", ref: "project 8f3c / 机密 91ab" });

await expectGuideError("1password 条目拒非 op 引用", createGuideEntry(fakeDb, { provider_id: p1.id, name: "坏引用", ref: "sk-123456" }), 400);
await expectGuideError("条目拒空引用", createGuideEntry(fakeDb, { provider_id: p2.id, name: "空引用", ref: " " }), 400);

const gA1 = await createGuideGrant(fakeDb, { entry_id: e1.id, agent_id: "agt_a" });
const gA2 = await createGuideGrant(fakeDb, { entry_id: e2.id, agent_id: "agt_a", expires_at: NOW + 60_000 });
const gA3 = await createGuideGrant(fakeDb, { entry_id: e3.id, agent_id: "agt_a" });
const gC1 = await createGuideGrant(fakeDb, { entry_id: e1.id, agent_id: "agt_c" });
void gA2;
void gA3;
void gC1;
await expectGuideError("同条目同 agent 重复授权", createGuideGrant(fakeDb, { entry_id: e1.id, agent_id: "agt_a" }), 409);
await expectGuideError("授权给不存在的 agent", createGuideGrant(fakeDb, { entry_id: e1.id, agent_id: "agt_nope" }), 404);

const auditCount = () => tables.vault_guide_audit.length;

let visible = await listGuideForAgent(fakeDb, "agt_a", NOW);
expect("有 grant 可见：A 看到 3 条", visible.map((v) => v.entry_id).sort(), [e1.id, e2.id, e3.id].sort());
expect("指引形状带服务商连接说明", visible.find((v) => v.entry_id === e1.id)?.provider.connect_guide, "装 op CLI，用服务账号登录后按 op:// 引用取值");
expect("指引形状带引用与允许主机", [visible.find((v) => v.entry_id === e1.id)?.ref, visible.find((v) => v.entry_id === e1.id)?.allowed_hosts], ["op://工作库/GitHub/token", ["api.github.com"]]);
expect("审计：返回 3 条写 3 条", auditCount(), 3);
expect(
  "审计行内容（agent/条目/action/meta）",
  tables.vault_guide_audit.map((r) => [r.agent_id, r.entry_id, r.action, JSON.parse(r.meta).tool]).sort(),
  [["agt_a", e1.id, "view", "vault_guide_list"], ["agt_a", e2.id, "view", "vault_guide_list"], ["agt_a", e3.id, "view", "vault_guide_list"]].sort(),
);

visible = await listGuideForAgent(fakeDb, "agt_b", NOW);
expect("无 grant 不见：B 看到 0 条", visible.length, 0);
expect("空结果不写审计", auditCount(), 3);

visible = await listGuideForAgent(fakeDb, "agt_c", NOW);
expect("技能关不见：C 有 grant 也看到 0 条", visible.length, 0);
expect("技能关不写审计", auditCount(), 3);

await updateGuideProvider(fakeDb, p2.id, { enabled: false });
visible = await listGuideForAgent(fakeDb, "agt_a", NOW);
expect("服务商停用不见：A 只剩 2 条", visible.map((v) => v.entry_id).sort(), [e1.id, e2.id].sort());
expect("审计累计 5 条", auditCount(), 5);
await updateGuideProvider(fakeDb, p2.id, { enabled: true });

await updateGuideEntry(fakeDb, e2.id, { enabled: false });
visible = await listGuideForAgent(fakeDb, "agt_a", NOW);
expect("条目停用不见：A 只剩 e1/e3", visible.map((v) => v.entry_id).sort(), [e1.id, e3.id].sort());
await updateGuideEntry(fakeDb, e2.id, { enabled: true });

await updateGuideGrant(fakeDb, gA1.id, { expires_at: NOW - 1 });
visible = await listGuideForAgent(fakeDb, "agt_a", NOW);
expect("grant 过期不见：A 只剩 e2/e3", visible.map((v) => v.entry_id).sort(), [e2.id, e3.id].sort());
await updateGuideGrant(fakeDb, gA1.id, { expires_at: null, enabled: false });
visible = await listGuideForAgent(fakeDb, "agt_a", NOW);
expect("grant 停用不见：A 只剩 e2/e3", visible.map((v) => v.entry_id).sort(), [e2.id, e3.id].sort());
await updateGuideGrant(fakeDb, gA1.id, { enabled: true });
visible = await listGuideForAgent(fakeDb, "agt_a", NOW);
expect("grant 恢复后重新可见：A 回到 3 条", visible.length, 3);

const auditRows = await listGuideAudit(fakeDb, { agentId: "agt_a", limit: 3 });
expect("审计列表按时间倒序限量", auditRows.length, 3);
const auditForE1 = await listGuideAudit(fakeDb, { entryId: e1.id });
expect("审计按条目过滤计数", auditForE1.length, tables.vault_guide_audit.filter((r) => r.entry_id === e1.id).length);

// 服务商改类型口径守卫：other 型条目的自由文本引用改判 1password 应被拒。
const p3 = await createGuideProvider(fakeDb, { name: "本地 KeePass", type: "other" });
const e4 = await createGuideEntry(fakeDb, { provider_id: p3.id, name: "内网面板", ref: "KeePass 条目 #12" });
void e4;
await expectGuideError("改类型后既有引用不合口径", updateGuideProvider(fakeDb, p3.id, { type: "1password" }), 409);

// 删除规则：服务商下有条目拒绝删；条目删除连带授权、审计保留。
await expectGuideError("服务商下有条目时删除被拒", deleteGuideProvider(fakeDb, p3.id), 409);
const auditBefore = auditCount();
await deleteGuideEntry(fakeDb, e1.id);
expect("条目删除连带删授权", (await listGuideGrants(fakeDb)).filter((g) => g.entry_id === e1.id).length, 0);
expect("条目删除不删审计", auditCount(), auditBefore);
visible = await listGuideForAgent(fakeDb, "agt_a", NOW);
expect("删条目后 A 只剩 e2/e3", visible.map((v) => v.entry_id).sort(), [e2.id, e3.id].sort());

// ---- 6. 无值字段（迁移列名清单） -------------------------------------------------

const migration = readFileSync(new URL("../migrations/0077_vault_guide.sql", import.meta.url), "utf8");
const forbidden = /(^|[\s(])(token|password|passwd|secret|value|api_key|apikey|credential|private_key)\b/i;
for (const table of ["vault_guide_provider", "vault_guide_entry", "vault_guide_grant", "vault_guide_audit"]) {
  const start = migration.indexOf(`CREATE TABLE ${table} (`);
  const body = migration.slice(start, migration.indexOf(");", start));
  const columns = body
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name) => name && !name.startsWith("--"));
  expect(`${table} 无能装值的列名`, columns.filter((name) => forbidden.test(name)), []);
  console.log(`     ${table} 列：${columns.join(", ")}`);
}
expect("agents 开关位是独立列", /ALTER TABLE agents ADD COLUMN vault_guide_enabled INTEGER NOT NULL DEFAULT 0/.test(migration), true);

// ---- 汇总 ---------------------------------------------------------------------

console.log(`\n${checks} checks, ${failures} failure(s)`);
if (failures > 0) process.exit(1);
console.log("vault-guide vectors passed");
