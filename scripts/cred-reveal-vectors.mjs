#!/usr/bin/env node
// 凭据明文展示整改的后端向量：管理员会话的 reveal 通道。
//
//   node scripts/cred-reveal-vectors.mjs
//
// 驱动 src/index.ts 的真实 fetch 处理器 + 全量迁移建的内存 D1，覆盖：
//   · 服务商连接凭据 GET /api/machines/providers/:id/credential
//       未登录 401 / 登录后回主密钥明文 + 完整 config / 篡改 id 404 /
//       reveal 后 machines_audit 恰好多一条 credential_reveal
//   · MiSub 令牌 GET /api/misub/connections/:id/token
//       未登录 401 / 登录后回明文令牌 / 篡改 id 404
//   · 列表仍脱敏：GET /api/machines/providers 与 GET /api/misub/connections
//     的公开视图只带 tail，不带明文。
//
// cloudflare:sockets 在 node 里不存在，loader 里给一个会抛错的桩；
// ssh-probe.ts 用了 node strip 模式不支持的参数属性语法，整模块打桩
// （本脚本不走 SSH 探活路径，桩函数只会在真被调用时抛错）。

import { register } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:sockets") {
    return {
      url: "data:text/javascript,export function connect(){ throw new Error('sockets unavailable in vectors'); }",
      shortCircuit: true,
    };
  }
  if (specifier.endsWith("ssh-probe") || specifier.endsWith("ssh-probe.ts")) {
    return {
      url: "data:text/javascript,export class SshProbeError extends Error {} export async function sshProbe(){ throw new Error('ssh probe unavailable in vectors'); }",
      shortCircuit: true,
    };
  }
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

const worker = (await import("../src/index.ts")).default;
const { resolveContentKey, sealString } = await import("../src/crypto.ts");
const { sealMachineSecret } = await import("../src/machines.ts");
const { createSession } = await import("../src/accounts.ts");
const { sha256Hex, SESSION_COOKIE } = await import("../src/auth.ts");

const VAULT_KEY = Buffer.alloc(32, 9).toString("base64url");
const contentKey = resolveContentKey(VAULT_KEY);
if (contentKey.state !== "on") throw new Error("测试密钥无效");

let pass = 0;
let fail = 0;
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log("ok   " + label + " = " + a);
  } else {
    fail++;
    console.error("FAIL " + label + "\n  got      " + a + "\n  expected " + e);
  }
}

function makeD1() {
  const raw = new DatabaseSync(":memory:");
  const files = readdirSync(new URL("../migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of files) {
    raw.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  }
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
    raw,
    prepare: (sql) => wrap(sql),
    batch: async (statements) => {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

const db = makeD1();
const env = {
  DB: db,
  VAULT_KEY,
  ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
};
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };

// 管理员 + 会话（直接落库，口径同 issueSession 的存储形状）。
const ADMIN_ID = "u_cred_admin";
db.raw
  .prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)")
  .run(ADMIN_ID, "credadmin", "unused-in-vectors", "admin", 1);
const TOKEN = "cred-vectors-session-token";
await createSession(db, {
  id: await sha256Hex(TOKEN),
  userId: ADMIN_ID,
  userAgent: null,
  ip: null,
  expiresAt: Date.now() + 60 * 60 * 1000,
  createdAt: Date.now(),
});
const COOKIE = SESSION_COOKIE + "=" + TOKEN;

// 服务商连接（instabox）：config_enc 密封 { apiKey, endpoint }。
const API_KEY = "ibk_cred_vectors_1234567890";
const connConfig = { apiKey: API_KEY, endpoint: "https://api.example.test" };
const configEnc = await sealMachineSecret(contentKey, JSON.stringify(connConfig));
db.raw
  .prepare(
    "INSERT INTO provider_connections (id, provider, name, config_enc, config_tail, last_test_at, last_test_ok, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
  .run("pc_cred1", "instabox", "向量连接", configEnc, API_KEY.slice(-4), 0, 1, "", 1, 1);

// MiSub 连接：schema_meta 里密封 token_enc。
const MISUB_TOKEN = "misub-token-cred-5678";
const tokenEnc = await sealString(contentKey, MISUB_TOKEN);
const misubStored = {
  connections: [
    {
      id: "msub_cred1",
      name: "向量 MiSub",
      base_url: "https://misub.example.test",
      token_enc: tokenEnc,
      token_tail: MISUB_TOKEN.slice(-4),
      refresh_enabled: false,
      auto_interval_hours: 0,
      last_test_at: 0,
      last_test_ok: true,
      last_error: "",
      created_at: 1,
      updated_at: 1,
    },
  ],
  active_id: "msub_cred1",
};
db.raw
  .prepare("INSERT INTO schema_meta (key, value) VALUES ('misub_connections', ?)")
  .run(JSON.stringify(misubStored));

function call(path, authed) {
  const headers = authed ? { cookie: COOKIE } : {};
  return worker.fetch(new Request("https://panel.test" + path, { headers }), env, ctx);
}

// ---- 服务商连接凭据 reveal ----
{
  const anon = await call("/api/machines/providers/pc_cred1/credential", false);
  eq("providers reveal 未登录状态", anon.status, 401);

  const before = db.raw
    .prepare("SELECT COUNT(*) AS n FROM machines_audit WHERE action = 'credential_reveal'")
    .get().n;

  const res = await call("/api/machines/providers/pc_cred1/credential", true);
  eq("providers reveal 登录状态", res.status, 200);
  const body = await res.json();
  eq("providers reveal 主密钥明文", body.credential, API_KEY);
  eq("providers reveal 完整 config.apiKey", body.config && body.config.apiKey, API_KEY);
  eq("providers reveal 完整 config.endpoint", body.config && body.config.endpoint, "https://api.example.test");

  const after = db.raw
    .prepare("SELECT COUNT(*) AS n FROM machines_audit WHERE action = 'credential_reveal'")
    .get().n;
  eq("providers reveal 审计增量", after - before, 1);

  const missing = await call("/api/machines/providers/pc_nope/credential", true);
  eq("providers reveal 篡改 id 状态", missing.status, 404);

  const list = await call("/api/machines/providers", true);
  const listBody = await list.json();
  const row = (listBody.connections || []).find((entry) => entry.id === "pc_cred1");
  eq("providers 列表只带 tail", row && row.config_tail, API_KEY.slice(-4));
  eq("providers 列表不带明文", row ? JSON.stringify(row).includes(API_KEY) : "row-missing", false);
}

// ---- MiSub 令牌 reveal ----
{
  const anon = await call("/api/misub/connections/msub_cred1/token", false);
  eq("misub token 未登录状态", anon.status, 401);

  const res = await call("/api/misub/connections/msub_cred1/token", true);
  eq("misub token 登录状态", res.status, 200);
  const body = await res.json();
  eq("misub token 明文", body.token, MISUB_TOKEN);

  const missing = await call("/api/misub/connections/msub_nope/token", true);
  eq("misub token 篡改 id 状态", missing.status, 404);

  const list = await call("/api/misub/connections", true);
  const listBody = await list.json();
  const row = (listBody.connections || []).find((entry) => entry.id === "msub_cred1");
  eq("misub 列表只带 tail", row && row.token_tail, MISUB_TOKEN.slice(-4));
  eq("misub 列表不带明文", row ? JSON.stringify(row).includes(MISUB_TOKEN) : "row-missing", false);
}

console.log(`\ncred-reveal vectors: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
