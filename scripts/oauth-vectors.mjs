#!/usr/bin/env node
// OAuth「应用」模型的断言：纯逻辑向量 + 可选的本地端到端。
//
//   /data/workspace/node24/bin/node scripts/oauth-vectors.mjs          纯逻辑
//   /data/workspace/node24/bin/node scripts/oauth-vectors.mjs --e2e    再加本地 wrangler dev 全流程
//
// 模型（2026-11-10 改定）：OAuth 只建独立「应用」，权限就是授权页勾选
// 的完整矩阵，没有基础 ∩ 连接交集、没有链接密钥绑定。纯逻辑覆盖：
// PKCE S256、redirect URI 准入、应用权限原样解析/序列化（含高级域）、
// 垃圾输入全关、工具可见性直接按应用权限判定、高级权限（操作2FA）
// 门、以及旧符号（intersectPermissions / extractLinkSecret）确已删除。
//
// --e2e 覆盖（本地 D1 + wrangler dev --local，端口 8797）：注册与坏回调
// 拒绝、未登录授权页跳登录（next 回跳）、未登录提交 401、管理员单路
// 授权页（应用名 + 一张矩阵）、授权码快照建应用、PKCE 错验拒绝、授权
// 码单次使用、应用权限原样生效（写工具可见）、面板改权限对同一令牌
// 立即生效、审计后 reveal、refresh 轮换、旧 refresh 复用整族撤销、
// 第二个应用独立存在、删应用令牌立即失效、Agent 令牌路径回归。

import { register } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

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

let checks = 0;
let failures = 0;
function expect(label, actual, expected) {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`ok   ${label}`);
  else {
    failures += 1;
    console.error(`FAIL ${label}: got ${a}, want ${e}`);
  }
}
function expectTrue(label, value) {
  expect(label, !!value, true);
}

const permissionsModule = await import("../src/permissions.ts");
const { parsePermissions, serializePermissions, denyAllPermissions } = permissionsModule;
const oauthUtilModule = await import("../src/oauth-util.ts");
const { pkceChallengeFor, pkceMatches, isValidCodeVerifier, isAllowedRedirectUri } = oauthUtilModule;
const { toolVisibleToAgent, toolAccessError } = await import("../src/tool-permissions.ts");

// ---- 已删除的旧符号（交集与绑定路径不许复活） -----------------------------------
expect("删除: intersectPermissions 不存在", typeof permissionsModule.intersectPermissions, "undefined");
expect("删除: extractLinkSecret 不存在", typeof oauthUtilModule.extractLinkSecret, "undefined");

// ---- PKCE ------------------------------------------------------------------
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const challenge = await pkceChallengeFor(verifier);
expect("pkce: RFC 7636 向量", challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
expectTrue("pkce: 正确 verifier 通过", await pkceMatches(verifier, challenge));
expect("pkce: 错误 verifier 拒绝", await pkceMatches("A".repeat(43), challenge), false);
expect("pkce: 过短 verifier 拒绝", await pkceMatches("short", challenge), false);
expect("pkce: verifier 格式", isValidCodeVerifier(verifier), true);
expect("pkce: verifier 含非法字符", isValidCodeVerifier("bad verifier with spaces padded to be long enough.."), false);

// ---- redirect URI 准入 -------------------------------------------------------
expect("redirect: https 放行", isAllowedRedirectUri("https://client.example/cb"), true);
expect("redirect: http 本机放行", isAllowedRedirectUri("http://localhost:3000/cb"), true);
expect("redirect: http 127.0.0.1 放行", isAllowedRedirectUri("http://127.0.0.1:8080/cb"), true);
expect("redirect: http 公网拒绝", isAllowedRedirectUri("http://client.example/cb"), false);
expect("redirect: fragment 拒绝", isAllowedRedirectUri("https://client.example/cb#frag"), false);
expect("redirect: 通配拒绝", isAllowedRedirectUri("https://*.example/cb"), false);
expect("redirect: 内嵌凭据拒绝", isAllowedRedirectUri("https://user:pass@client.example/cb"), false);
expect("redirect: 非 http(s) 拒绝", isAllowedRedirectUri("ftp://client.example/cb"), false);

// ---- 应用权限：授权页勾什么，应用就是什么 ---------------------------------------
const appGrants = parsePermissions({
  memory: { read: true, write: true },
  soul: { read: true, write: false },
  advanced: { totp: { read: true, write: false }, soul_other: { read: false, write: true } },
});
expect("应用权限: memory 读写原样", [appGrants.memory.read, appGrants.memory.write], [true, true]);
expect("应用权限: soul 只读原样", [appGrants.soul.read, appGrants.soul.write], [true, false]);
expect("应用权限: 未勾的域全关", [appGrants.tasks.read, appGrants.tasks.write], [false, false]);
expect("应用权限: 高级 totp 读原样", appGrants.advanced.totp.read, true);
expect("应用权限: 高级 soul_other 写原样", appGrants.advanced.soul_other.write, true);
expect(
  "应用权限: 序列化往返不变",
  serializePermissions(parsePermissions(serializePermissions(appGrants))),
  serializePermissions(appGrants),
);
// 写工具直接按应用权限可见——没有任何基础权限在上面封顶。
expectTrue("应用权限: memory_upsert 可见", toolVisibleToAgent("memory_upsert", appGrants));
expect("应用权限: memory_upsert 调用放行", toolAccessError("memory_upsert", appGrants, "E2E App", {}), null);
expectTrue("应用权限: memory_search 可见", toolVisibleToAgent("memory_search", appGrants));
expect("应用权限: 未授权域工具不可见", toolVisibleToAgent("tasks_list", appGrants), false);
expectTrue("应用权限: 未授权域调用被拒", toolAccessError("tasks_list", appGrants, "E2E App", {}) !== null);
// 高级权限门：vault_2fa_list 需要 vault 读 + 操作2FA 读，缺一不可。
const vaultOnly = parsePermissions({ vault: { read: true, write: false } });
expectTrue("应用权限: 只有 vault 读时取码工具被拒", toolAccessError("vault_2fa_list", vaultOnly, "E2E App", {}) !== null);
const vaultAndTotp = parsePermissions({ vault: { read: true, write: false }, advanced: { totp: { read: true, write: false } } });
expect("应用权限: vault 读 + 2FA 读时取码放行", toolAccessError("vault_2fa_list", vaultAndTotp, "E2E App", {}), null);
// 垃圾权限 = 全关。
expect("垃圾输入: 全关", serializePermissions(parsePermissions("{not json")), serializePermissions(denyAllPermissions()));
expect("垃圾输入: 工具全不可见", toolVisibleToAgent("memory_search", parsePermissions("junk")), false);

if (!process.argv.includes("--e2e")) {
  console.log(`\n${checks} checks, ${failures} failures（纯逻辑；加 --e2e 跑本地全流程）`);
  process.exit(failures ? 1 : 0);
}

// ---- E2E ---------------------------------------------------------------------
const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 8797;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const vaultKey = Buffer.alloc(32, 7).toString("base64");
const agentToken = "hvm_agt_e2e_agent_secret_0123456789";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function d1(command) {
  execFileSync("npx", ["wrangler", "d1", "execute", "hivemos", "--local", "--command", command], {
    cwd: ROOT,
    stdio: "pipe",
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
  });
}

async function req(path, options = {}) {
  const response = await fetch(ORIGIN + path, options);
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, data, headers: response.headers };
}
async function reqManual(path, options = {}) {
  const response = await fetch(ORIGIN + path, { redirect: "manual", ...options });
  const text = await response.text();
  return { status: response.status, location: response.headers.get("location") || "", text };
}
const form = (obj) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(obj).toString(),
});
const asJson = (obj, extra = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(extra.headers || {}) },
  body: JSON.stringify(obj),
});
const mcpCall = (token, method, params) =>
  req("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

console.log("\n-- e2e: 准备本地 D1 与种子 --");
execFileSync("bash", ["-c", "yes | npx wrangler d1 migrations apply hivemos --local"], {
  cwd: ROOT,
  stdio: "pipe",
  env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
});
const agentId = "agt_e2e00000001";
const basePerms = JSON.stringify({ memory: { read: true, write: false } });
d1(
  `INSERT INTO agents (id, name, token_hash, token_enc, status, group_id, permissions, last_seen_at, created_at, call_count) VALUES ('${agentId}', 'E2E Agent', '${sha256(agentToken)}', NULL, 'active', NULL, '${basePerms}', NULL, 1, 0)`,
);
const adminId = "usr_e2e_admin";
const sessionToken = "e2e-session-token-0123456789";
d1(
  `INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('${adminId}', 'e2e-admin', 'unused', 'admin', 1)`,
);
d1(
  `INSERT INTO sessions (id, user_id, created_at, expires_at, ip) VALUES ('${sha256(sessionToken)}', '${adminId}', 1, 9999999999999, '127.0.0.1')`,
);
const adminCookie = { cookie: `hivemos_session=${sessionToken}` };

console.log("-- e2e: 启动 wrangler dev --");
const dev = spawn(
  "npx",
  ["wrangler", "dev", "--local", "--port", String(PORT), "--var", `VAULT_KEY:${vaultKey}`],
  { cwd: ROOT, env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" }, stdio: "pipe" },
);
let devLog = "";
dev.stdout.on("data", (chunk) => (devLog += chunk));
dev.stderr.on("data", (chunk) => (devLog += chunk));
try {
  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    try {
      const health = await req("/api/health");
      up = health.status === 200;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (!up) throw new Error("wrangler dev 未能启动:\n" + devLog.slice(-2000));

  const meta = await req("/.well-known/oauth-authorization-server");
  expect("e2e: 元数据 200", meta.status, 200);
  expectTrue("e2e: 元数据含 token 端点", String(meta.data.token_endpoint || "").endsWith("/oauth/token"));

  const badReg = await req("/oauth/register", asJson({ client_name: "Bad", redirect_uris: ["http://evil.example/cb"] }));
  expect("e2e: 坏回调注册被拒", badReg.status, 400);

  const reg = await req(
    "/oauth/register",
    asJson({ client_name: "E2E Client", client_uri: "https://client.example", redirect_uris: ["https://client.example/cb"] }),
  );
  expect("e2e: 注册 201", reg.status, 201);
  const clientId = reg.data.client_id;
  expectTrue("e2e: client_id 已发", typeof clientId === "string" && clientId.length > 0);

  const authorizeQuery =
    `client_id=${clientId}&redirect_uri=${encodeURIComponent("https://client.example/cb")}` +
    `&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&state=st1`;
  const badPage = await req(
    `/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent("https://nope.example/cb")}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`,
  );
  expectTrue("e2e: 坏回调只给错误页不跳转", badPage.status === 200 && String(badPage.data).includes("无法继续"));

  // -- 只有一条路：先登录管理员 --
  const anonPage = await reqManual(`/oauth/authorize?${authorizeQuery}`);
  expect("e2e: 未登录授权页 302", anonPage.status, 302);
  expectTrue("e2e: 跳登录带 next", anonPage.location.startsWith("/login?next="));
  const nextTarget = decodeURIComponent(anonPage.location.slice("/login?next=".length));
  expectTrue("e2e: next 指回授权页", nextTarget.startsWith("/oauth/authorize?") && nextTarget.includes("client_id="));

  const base = {
    client_id: clientId,
    redirect_uri: "https://client.example/cb",
    state: "st1",
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  const anonSubmit = await req("/oauth/authorize", asJson({ ...base, app_name: "Anon App", grants: {} }));
  expect("e2e: 未登录提交 401", anonSubmit.status, 401);

  const adminPage = await req(`/oauth/authorize?${authorizeQuery}`, { headers: adminCookie });
  expect("e2e: 管理员授权页 200", adminPage.status, 200);
  const pageHtml = String(adminPage.data);
  expectTrue("e2e: 页面有应用名输入", pageHtml.includes('id="appName"'));
  expectTrue("e2e: 页面有一张权限矩阵", pageHtml.includes('id="permMatrix"'));
  expect("e2e: 页面无绑定路径", pageHtml.includes("linkSecret"), false);
  expect("e2e: 页面无身份选择", pageHtml.includes("agentSel"), false);
  expect("e2e: 页面无双层矩阵", pageHtml.includes("baseMatrix") || pageHtml.includes("connMatrix"), false);

  const junkGrants = await req(
    "/oauth/authorize",
    asJson({ ...base, app_name: "Junk", grants: "junk" }, { headers: adminCookie }),
  );
  expect("e2e: 垃圾 grants 400", junkGrants.status, 400);

  // -- 应用 1：授权页勾选原样生效 --
  const authorize = (payload) => req("/oauth/authorize", asJson(payload, { headers: adminCookie }));
  const grant1 = await authorize({
    ...base,
    app_name: "E2E App",
    grants: { memory: { read: true, write: true }, soul: { read: true, write: false } },
  });
  expect("e2e: 管理员授权 200", grant1.status, 200);
  const redirect1 = new URL(grant1.data.redirect);
  const code1 = redirect1.searchParams.get("code");
  expect("e2e: 回跳带 state", redirect1.searchParams.get("state"), "st1");
  expectTrue("e2e: 回跳带 code", typeof code1 === "string" && code1.startsWith("hvm_oac_"));

  // 兑换前应用还不存在：授权码只带快照，兑换才建应用。
  const appsBefore = await req("/api/oauth/apps", { headers: adminCookie });
  expect("e2e: 兑换前应用列表为空", appsBefore.data.apps?.length, 0);

  const wrongPkce = await req(
    "/oauth/token",
    form({ grant_type: "authorization_code", code: code1, client_id: clientId, redirect_uri: base.redirect_uri, code_verifier: "B".repeat(43) }),
  );
  expect("e2e: PKCE 错验拒绝", wrongPkce.status, 400);
  expect("e2e: PKCE 错验错误码", wrongPkce.data.error, "invalid_grant");

  const tokens1 = await req(
    "/oauth/token",
    form({ grant_type: "authorization_code", code: code1, client_id: clientId, redirect_uri: base.redirect_uri, code_verifier: verifier }),
  );
  expect("e2e: 兑换成功", tokens1.status, 200);
  const access1 = tokens1.data.access_token;
  const refresh1 = tokens1.data.refresh_token;
  expectTrue("e2e: access 前缀", typeof access1 === "string" && access1.startsWith("hvm_oat_"));
  expectTrue("e2e: refresh 前缀", typeof refresh1 === "string" && refresh1.startsWith("hvm_ort_"));

  const reuse = await req(
    "/oauth/token",
    form({ grant_type: "authorization_code", code: code1, client_id: clientId, redirect_uri: base.redirect_uri, code_verifier: verifier }),
  );
  expect("e2e: 授权码二次使用拒绝", reuse.status, 400);

  const list1 = await mcpCall(access1, "tools/list", {});
  const toolNames = (list1.data.result?.tools || []).map((tool) => tool.name);
  expectTrue("e2e: 应用权限原样: memory_upsert 可见", toolNames.includes("memory_upsert"));
  expectTrue("e2e: 应用权限原样: memory_search 可见", toolNames.includes("memory_search"));
  expectTrue("e2e: 应用权限原样: soul_get 可见", toolNames.includes("soul_get"));
  expect("e2e: 未授权域不可见", toolNames.includes("tasks_list"), false);
  const writeCall = await mcpCall(access1, "tools/call", { name: "memory_upsert", arguments: { title: "e2e app note" } });
  expectTrue("e2e: 写调用不被权限拒绝", writeCall.data.error?.code !== -32003);

  // -- 管理端：应用列表 / 改权限实时生效 / reveal --
  const apps1 = await req("/api/oauth/apps", { headers: adminCookie });
  expect("e2e: 应用列表 200", apps1.status, 200);
  expect("e2e: 应用列表 1 个", apps1.data.apps?.length, 1);
  const app1 = apps1.data.apps[0];
  expect("e2e: 应用名来自授权页", app1.name, "E2E App");
  expectTrue("e2e: 应用 id 前缀", typeof app1.id === "string" && app1.id.startsWith("oapp_"));
  expect("e2e: 应用权限 memory 写", app1.permissions?.memory?.write, true);
  expect("e2e: 应用权限 soul 读", app1.permissions?.soul?.read, true);

  const patch = await req(`/api/oauth/apps/${app1.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...adminCookie },
    body: JSON.stringify({ permissions: { memory: { read: true, write: false } } }),
  });
  expect("e2e: 改权限 200", patch.status, 200);
  const listAfterPatch = await mcpCall(access1, "tools/list", {});
  const namesAfterPatch = (listAfterPatch.data.result?.tools || []).map((tool) => tool.name);
  expectTrue("e2e: 改权限后读工具仍在", namesAfterPatch.includes("memory_search"));
  expect("e2e: 改权限后同一令牌写工具立即消失", namesAfterPatch.includes("memory_upsert"), false);
  const deniedAfterPatch = await mcpCall(access1, "tools/call", { name: "memory_upsert", arguments: { title: "x" } });
  expect("e2e: 改权限后写调用被拒 -32003", deniedAfterPatch.data.error?.code, -32003);

  const reveal = await req(`/api/oauth/apps/${app1.id}/reveal-tokens`, { method: "POST", headers: adminCookie });
  expect("e2e: reveal 200", reveal.status, 200);
  expect("e2e: reveal 回当前 access", reveal.data.access_token, access1);

  // -- refresh 轮换与复用整族撤销 --
  const rotated = await req("/oauth/token", form({ grant_type: "refresh_token", refresh_token: refresh1, client_id: clientId }));
  expect("e2e: refresh 轮换成功", rotated.status, 200);
  const rotatedList = await mcpCall(rotated.data.access_token, "tools/list", {});
  expect("e2e: 轮换后新 access 可用", rotatedList.status, 200);
  const reuseOld = await req("/oauth/token", form({ grant_type: "refresh_token", refresh_token: refresh1, client_id: clientId }));
  expect("e2e: 旧 refresh 复用拒绝", reuseOld.status, 400);
  const familyDead = await mcpCall(rotated.data.access_token, "tools/list", {});
  expect("e2e: 复用后整族撤销", familyDead.status, 401);

  // -- 应用 2：独立存在；删除即令牌全灭 --
  const grant2 = await authorize({ ...base, app_name: "E2E App 2", grants: { tasks: { read: true, write: false } } });
  const code2 = new URL(grant2.data.redirect).searchParams.get("code");
  const tokens2 = await req(
    "/oauth/token",
    form({ grant_type: "authorization_code", code: code2, client_id: clientId, redirect_uri: base.redirect_uri, code_verifier: verifier }),
  );
  expect("e2e: 第二个应用兑换成功", tokens2.status, 200);
  const apps2 = await req("/api/oauth/apps", { headers: adminCookie });
  expect("e2e: 应用列表 2 个", apps2.data.apps?.length, 2);
  const app2 = (apps2.data.apps || []).find((app) => app.name === "E2E App 2");
  expectTrue("e2e: 第二个应用在列表里", !!app2);
  const listApp2 = await mcpCall(tokens2.data.access_token, "tools/list", {});
  expect("e2e: 第二个应用令牌可用", listApp2.status, 200);
  const del = await req(`/api/oauth/apps/${app2.id}`, { method: "DELETE", headers: adminCookie });
  expect("e2e: 删除应用 200", del.status, 200);
  const afterDelete = await mcpCall(tokens2.data.access_token, "tools/list", {});
  expect("e2e: 删应用后令牌立即失效", afterDelete.status, 401);
  const appsAfterDelete = await req("/api/oauth/apps", { headers: adminCookie });
  expect("e2e: 删除后列表回到 1 个", appsAfterDelete.data.apps?.length, 1);

  // -- 回归：Agent 长期令牌路径不受影响 --
  const agentList = await mcpCall(agentToken, "tools/list", {});
  expect("e2e: Agent 令牌仍可用", agentList.status, 200);
  const agentTools = (agentList.data.result?.tools || []).map((tool) => tool.name);
  expectTrue("e2e: Agent 令牌按自身权限（可读）", agentTools.includes("memory_search"));
  expect("e2e: Agent 令牌按自身权限（不可写）", agentTools.includes("memory_upsert"), false);
} finally {
  dev.kill("SIGTERM");
}
console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
