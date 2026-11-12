#!/usr/bin/env node
// 凭据明文展示整改 · 第二波的后端向量：备份目标凭据 reveal。
//
//   node scripts/cred-reveal2-vectors.mjs
//
// 驱动 src/index.ts 的真实 fetch 处理器 + 全量迁移建的内存 D1，覆盖：
//   · POST /api/backup/targets/:kind/reveal
//       未登录 401 / 登录后回 GitHub 令牌明文 / 目标不存在回空串 /
//       WebDAV 密码明文 / kind 非法 404
//   · GET /api/backup 的公开视图仍只带 tail，不带明文。
//
// loader 桩与 cred-reveal-vectors.mjs 相同（cloudflare:sockets、ssh-probe）。

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

// 管理员 + 会话（直接落库，口径同 cred-reveal-vectors）。
const ADMIN_ID = "u_cred2_admin";
db.raw
  .prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)")
  .run(ADMIN_ID, "cred2admin", "unused-in-vectors", "admin", 1);
const TOKEN = "cred2-vectors-session-token";
await createSession(db, {
  id: await sha256Hex(TOKEN),
  userId: ADMIN_ID,
  userAgent: null,
  ip: null,
  expiresAt: Date.now() + 60 * 60 * 1000,
  createdAt: Date.now(),
});
const COOKIE = SESSION_COOKIE + "=" + TOKEN;

const GH_TOKEN = "ghp_cred2_vectors_abcdef123456";
const WD_PASS = "wd-pass-cred2-xyz-789";
const ghEnc = await sealString(contentKey, GH_TOKEN);
const wdEnc = await sealString(contentKey, WD_PASS);

const TARGET_SQL =
  "INSERT INTO backup_targets (id, enabled, owner, repo, branch, path_prefix, token_enc, token_tail, base_url, username, password_enc, password_tail, remote_dir, last_test_at, last_test_ok, last_test_detail, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
db.raw.prepare(TARGET_SQL).run(
  "github", 1, "octo", "backup-repo", "main", "", ghEnc, GH_TOKEN.slice(-4),
  "", "", "", "", "", 0, 1, "", "", 1, 1,
);

function call(path, authed, method) {
  const headers = authed ? { cookie: COOKIE } : {};
  return worker.fetch(new Request("https://panel.test" + path, { method: method || "POST", headers }), env, ctx);
}

// ---- 备份目标凭据 reveal ----
{
  const anon = await call("/api/backup/targets/github/reveal", false);
  eq("backup reveal 未登录状态", anon.status, 401);

  const res = await call("/api/backup/targets/github/reveal", true);
  eq("backup reveal github 状态", res.status, 200);
  const body = await res.json();
  eq("backup reveal github 令牌明文", body.secret, GH_TOKEN);

  // webdav 目标还不存在：回空串，不报错。
  const empty = await call("/api/backup/targets/webdav/reveal", true);
  eq("backup reveal 无目标状态", empty.status, 200);
  const emptyBody = await empty.json();
  eq("backup reveal 无目标回空", emptyBody.secret, "");

  // 补上 webdav 目标后能读出密码明文。
  db.raw.prepare(TARGET_SQL).run(
    "webdav", 1, "", "", "", "", "", "",
    "https://dav.example.test/", "davuser", wdEnc, WD_PASS.slice(-4), "hivemos", 0, 1, "", "", 1, 1,
  );
  const wd = await call("/api/backup/targets/webdav/reveal", true);
  eq("backup reveal webdav 状态", wd.status, 200);
  const wdBody = await wd.json();
  eq("backup reveal webdav 密码明文", wdBody.secret, WD_PASS);

  const bad = await call("/api/backup/targets/ftp/reveal", true);
  eq("backup reveal kind 非法状态", bad.status, 404);

  // 公开视图仍脱敏：只带 tail，不带明文。
  const state = await worker.fetch(
    new Request("https://panel.test/api/backup", { headers: { cookie: COOKIE } }),
    env,
    ctx,
  );
  const stateBody = await state.json();
  const gh = stateBody.backup && stateBody.backup.targets && stateBody.backup.targets.github;
  eq("backup 公开视图只带 tail", gh && gh.token_tail, GH_TOKEN.slice(-4));
  eq("backup 公开视图不带明文", gh ? JSON.stringify(gh).includes(GH_TOKEN) : "row-missing", false);
}

console.log(`\ncred-reveal2 vectors: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
