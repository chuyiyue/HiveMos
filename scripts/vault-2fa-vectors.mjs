#!/usr/bin/env node
// 阶段 6（MCP 验证码工具）的断言脚本：跑 src/tool-permissions.ts 与
// src/vault-totp.ts 的 Agent 面（vault_2fa_list / vault_2fa_get_code）。
//
//   node scripts/vault-2fa-vectors.mjs
//   （普通 node ≥ 22 也行：类型剥离默认开启，这些模块不依赖 Worker 全局）
//
// 覆盖四组验收口径：
//   1. 无 vault read：两工具在 tools/list 不可见，直接调用被拒。
//   2. 有 vault read、无 advanced.vault_totp_code：取码被拒（列表也一并被拒，
//      与 machines_get_access 对 machines_secret 的口径一致）。
//   3. 有 vault_totp_code 但条目 ai_read=0：取不到码，且不写访问记录。
//   4. 正常路径：取到与 src/totp.ts 一致的当前码，返回剩余秒数，
//      vault_access_log 恰好多一行且 actor 是调用 Agent 的名字。
//
// 数据库用内存里的假 D1：只认本阶段真正会发的三条 SQL（取条目、列表联表、
// 写访问记录），遇到别的语句直接报错，避免测试悄悄放过没覆盖的查询。
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

const { denyAllPermissions, parsePermissions } = await import("../src/permissions.ts");
const { TOOL_PERMISSIONS, toolAccessError, toolVisibleToAgent } = await import("../src/tool-permissions.ts");
const { getTotpCodeForAgent, listTotpForAgent } = await import("../src/vault-totp.ts");
const { VaultError, sealSecret } = await import("../src/vault.ts");
const { base32Decode, hotp } = await import("../src/totp.ts");

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

// ---- 假 D1 ------------------------------------------------------------------

function unknown(op, sql) {
  return new Error(`假 D1 未覆盖的 ${op}: ${sql}`);
}

class FakeStatement {
  constructor(db, sql, values) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new FakeStatement(this.db, this.sql, values);
  }

  async first() {
    if (this.sql.includes("FROM vault_totp WHERE id = ?")) {
      return this.db.totp.find((row) => row.id === this.values[0]) ?? null;
    }
    throw unknown("first", this.sql);
  }

  async all() {
    // listTotpForAgent：联表取公开字段，WHERE t.ai_read = 1。
    if (this.sql.includes("FROM vault_totp t LEFT JOIN vault_groups g")) {
      const names = new Map(this.db.groups.map((group) => [group.id, group.name]));
      const results = this.db.totp
        .filter((row) => row.ai_read === 1)
        .map((row) => ({
          id: row.id,
          issuer: row.issuer,
          account: row.account,
          digits: row.digits,
          period: row.period,
          group_name: row.group_id ? names.get(row.group_id) ?? null : null,
        }));
      return { results };
    }
    throw unknown("all", this.sql);
  }

  async run() {
    // 访问记录：解密/取码之前的审计门。
    if (this.sql.includes("INSERT INTO vault_access_log")) {
      if (this.db.failLogInsert) throw new Error("假 D1：写入失败");
      const [id, target_kind, target_id, action, actor, created_at] = this.values;
      this.db.log.push({ id, target_kind, target_id, action, actor, created_at });
      return { success: true };
    }
    throw unknown("run", this.sql);
  }
}

class FakeDb {
  constructor({ totp = [], groups = [], log = [], failLogInsert = false } = {}) {
    this.totp = totp;
    this.groups = groups;
    this.log = log;
    this.failLogInsert = failLogInsert;
  }

  prepare(sql) {
    return new FakeStatement(this, sql, []);
  }
}

// ---- 权限矩阵 ---------------------------------------------------------------

const denied = denyAllPermissions();
const vaultRead = parsePermissions('{"vault":{"read":true,"write":false}}');
const vaultCode = parsePermissions('{"vault":{"read":true,"write":false},"advanced":{"vault_totp_code":true}}');
const codeOnly = parsePermissions('{"advanced":{"vault_totp_code":true}}');
const PAIR = ["vault_2fa_list", "vault_2fa_get_code"];

expect(
  "两个工具都登记为 vault read + advanced.vault_totp_code",
  PAIR.map((name) => TOOL_PERMISSIONS[name]),
  [
    { domain: "vault", op: "read", advanced: "vault_totp_code" },
    { domain: "vault", op: "read", advanced: "vault_totp_code" },
  ],
);

// 1) 无 vault read：列表不出现，调用被拒（先撞域，再谈 advanced）。
expect("无 vault read：tools/list 无两工具", PAIR.filter((name) => toolVisibleToAgent(name, denied)), []);
expect(
  "无 vault read：vault_2fa_list 被拒",
  toolAccessError("vault_2fa_list", denied, "agent-a", {}),
  "该 Agent 没有 vault 的读取权限，无法调用这个工具",
);
expect(
  "无 vault read：vault_2fa_get_code 被拒",
  toolAccessError("vault_2fa_get_code", denied, "agent-a", { id: "totp_x" }),
  "该 Agent 没有 vault 的读取权限，无法调用这个工具",
);

// 2) 有 vault read、无 totp_code：两个工具都不可见、都拒（照 machines_get_access）。
expect("vault read 无 totp_code：tools/list 无两工具", PAIR.filter((name) => toolVisibleToAgent(name, vaultRead)), []);
expect(
  "vault read 无 totp_code：vault_2fa_list 被拒",
  toolAccessError("vault_2fa_list", vaultRead, "agent-a", {}),
  "该 Agent 没有读取保险库验证码的高级权限，无法调用这个工具",
);
expect(
  "vault read 无 totp_code：vault_2fa_get_code 被拒",
  toolAccessError("vault_2fa_get_code", vaultRead, "agent-a", { id: "totp_x" }),
  "该 Agent 没有读取保险库验证码的高级权限，无法调用这个工具",
);
expect("只有 totp_code 没有 vault read：仍按域拒", toolAccessError("vault_2fa_get_code", codeOnly, "agent-a", {}), "该 Agent 没有 vault 的读取权限，无法调用这个工具");

// 3) 两项都授予：可见、放行（真正的取值在下半段验）。
expect("vault read + totp_code：tools/list 有两工具", PAIR.filter((name) => toolVisibleToAgent(name, vaultCode)), ["vault_2fa_list", "vault_2fa_get_code"]);
expect("vault read + totp_code：vault_2fa_list 放行", toolAccessError("vault_2fa_list", vaultCode, "agent-a", {}), null);
expect("vault read + totp_code：vault_2fa_get_code 放行", toolAccessError("vault_2fa_get_code", vaultCode, "agent-a", { id: "totp_x" }), null);

// ---- 工具面取值（假 D1 + 真加密） ------------------------------------------

const ENV = { VAULT_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString("base64url") };
const SHA1_SECRET = "JBSWY3DPEHPK3PXP"; // 10 字节，RFC 4226 的经典样例
const SHA256_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // 20 字节
const NOW = 1794096017000; // 秒数 1794096017：对 30/60 秒周期都有余数

function baseRow(overrides) {
  return {
    account: "",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    icon: null,
    note: "",
    group_id: null,
    ai_read: 1,
    created_at: NOW,
    updated_at: NOW,
    secret_hash: "",
    ...overrides,
  };
}

async function seedDb(extra = {}) {
  const totp = [
    baseRow({
      id: "totp_github",
      issuer: "GitHub",
      account: "bot@example.com",
      secret_enc: await sealSecret(ENV, SHA1_SECRET),
      group_id: "grp_work",
    }),
    baseRow({
      id: "totp_google",
      issuer: "Google",
      account: "ops@example.com",
      secret_enc: await sealSecret(ENV, SHA256_SECRET),
      algorithm: "SHA256",
      digits: 8,
      period: 60,
    }),
    baseRow({
      id: "totp_hidden",
      issuer: "Hidden",
      account: "secret@example.com",
      secret_enc: await sealSecret(ENV, SHA1_SECRET),
      ai_read: 0,
    }),
  ];
  return new FakeDb({ totp, groups: [{ id: "grp_work", name: "工作" }], ...extra });
}

function logOf(db) {
  return db.log.map((row) => ({ ...row, id: "<id>" }));
}

function codeOf(secretText, now, digits, period, algorithm) {
  return hotp(base32Decode(secretText), Math.floor(Math.floor(now / 1000) / period), digits, algorithm);
}

const db = await seedDb();

// 列表：只回 ai_read=1 的公开字段
const list = await listTotpForAgent(db);
expect("列表只含 ai_read=1 的两条", list.map((entry) => entry.id), ["totp_github", "totp_google"]);
expect("列表字段恰好是 id/issuer/account/digits/period/group", Object.keys(list[0]).sort(), ["account", "digits", "group", "id", "issuer", "period"]);
expect("列表带分组名", list.find((entry) => entry.id === "totp_github").group, "工作");
expect("列表无分组时为 null", list.find((entry) => entry.id === "totp_google").group, null);
expect("列表不含隐藏条目", list.some((entry) => entry.id === "totp_hidden"), false);
expect("列表不含密钥", JSON.stringify(list).includes(SHA1_SECRET), false);
expect("列表不含验证码", /"code"|"expires_in"/.test(JSON.stringify(list)), false);
expect("列表不写访问记录", db.log.length, 0);

// ai_read=0：按「不存在」处理，不写访问记录
expect("ai_read=0 取不到码", await getTotpCodeForAgent(db, ENV, "totp_hidden", "agent-a", NOW), null);
expect("ai_read=0 不写访问记录", db.log.length, 0);
// 不存在同样返回 null
expect("不存在的 id 取不到码", await getTotpCodeForAgent(db, ENV, "totp_missing", "agent-a", NOW), null);
expect("不存在的 id 不写访问记录", db.log.length, 0);

// 正常路径：SHA1 / 6 位 / 30 秒
const code1 = await getTotpCodeForAgent(db, ENV, "totp_github", "agent-a", NOW);
expect("正常取码返回当前码", code1.code, await codeOf(SHA1_SECRET, NOW, 6, 30, "SHA1"));
expect("正常取码返回周期剩余秒数", code1.expires_in, 30 - (Math.floor(NOW / 1000) % 30));
expect("取码返回值只有 code/expires_in", Object.keys(code1).sort(), ["code", "expires_in"]);
expect("取码返回不含密钥", JSON.stringify(code1).includes(SHA1_SECRET), false);
expect("取码写一行访问记录", db.log.length, 1);
expect("访问记录口径（totp/reveal/Agent 名）", logOf(db), [
  { id: "<id>", target_kind: "totp", target_id: "totp_github", action: "reveal", actor: "agent-a", created_at: NOW },
]);

// 非默认参数：SHA256 / 8 位 / 60 秒，走条目自己的参数
const code2 = await getTotpCodeForAgent(db, ENV, "totp_google", "agent-b", NOW);
expect("SHA256/8 位/60 秒取码", code2.code, await codeOf(SHA256_SECRET, NOW, 8, 60, "SHA256"));
expect("60 秒周期剩余秒数", code2.expires_in, 60 - (Math.floor(NOW / 1000) % 60));
expect("第二次取码再加一行，actor 跟着变", logOf(db).map((row) => [row.target_id, row.actor]), [
  ["totp_github", "agent-a"],
  ["totp_google", "agent-b"],
]);

// 审计门：写不进访问记录就抛错，绝不给码
const brokenDb = await seedDb({ failLogInsert: true });
let auditError = null;
try {
  await getTotpCodeForAgent(brokenDb, ENV, "totp_github", "agent-a", NOW);
} catch (error) {
  auditError = error;
}
expect("写不进访问记录时抛 VaultError", auditError instanceof VaultError, true);
expect("写不进访问记录时的错误文案", auditError ? auditError.message : null, "访问记录写入失败，未返回验证码");
expect("写不进访问记录时不留断头日志", brokenDb.log.length, 0);

// ---- 源码登记：两个工具真的在 TOOLS 里并接上分发 -------------------------

const mcpSource = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
expect("mcp.ts 注册 vault_2fa_list", mcpSource.includes('name: "vault_2fa_list"'), true);
expect("mcp.ts 注册 vault_2fa_get_code", mcpSource.includes('name: "vault_2fa_get_code"'), true);
expect("mcp.ts 接上 vault_2fa_ 分发", mcpSource.includes('name.startsWith("vault_2fa_")'), true);

if (failures > 0) {
  console.error(`\n${failures}/${checks} 条不符`);
  process.exit(1);
}
console.log(
  `\n全部通过：${checks} 条检查（权限可见性/拒绝口径 + ai_read 隐藏 + 正常取码/剩余秒数 + 访问记录 actor + 审计门失败 + 源码登记）`,
);
