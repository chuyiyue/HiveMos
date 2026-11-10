#!/usr/bin/env node
// OAuth 阶段 2–4 的断言：纯逻辑向量 + 可选的本地端到端。
//
//   /data/workspace/node24/bin/node scripts/oauth-vectors.mjs          纯逻辑
//   /data/workspace/node24/bin/node scripts/oauth-vectors.mjs --e2e    再加本地 wrangler dev 全流程
//
// 纯逻辑覆盖：PKCE S256、redirect URI 准入、链接密钥提取、权限交集与工
// 具可见性（基础只读 + 连接给写 → 写工具不可见/被拒；收紧基础后交集立
// 即变小）。这部分用的正是 resolveOAuthAccessToken 计算生效权限时调用
// 的同一组函数（parsePermissions / intersectPermissions /
// toolVisibleToAgent / toolAccessError），不是复制品。
//
// --e2e 覆盖（本地 D1 + wrangler dev --local，端口 8797）：注册与坏回调
// 拒绝、链接密钥绑定授权、PKCE 错验拒绝、授权码单次使用、tools/list 与
// tools/call 的交集校验、管理员查看连接与审计后 reveal、面板撤销后令牌
// 立即失效、refresh 轮换、旧 refresh 复用整族撤销、收紧基础权限后存量
// 连接即刻受限、管理员会话的 existing / new 两条身份路。

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

const { parsePermissions, intersectPermissions, serializePermissions } = await import("../src/permissions.ts");
const { toolVisibleToAgent, toolAccessError } = await import("../src/tool-permissions.ts");
const { pkceChallengeFor, pkceMatches, isValidCodeVerifier, isAllowedRedirectUri, extractLinkSecret } =
  await import("../src/oauth-util.ts");

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

// ---- 链接密钥提取 --------------------------------------------------------------
expect("link: 裸令牌", extractLinkSecret("hvm_agt_abc"), "hvm_agt_abc");
expect("link: 整段接入地址", extractLinkSecret("https://mos.example/mcp?token=hvm_agt_abc"), "hvm_agt_abc");
expect("link: 地址带其它参数", extractLinkSecret("https://mos.example/mcp?x=1&token=hvm_agt_abc&y=2"), "hvm_agt_abc");

// ---- 权限交集与工具可见性 -------------------------------------------------------
const baseReadOnly = parsePermissions({ memory: { read: true, write: false } });
const connWrite = parsePermissions({ memory: { read: true, write: true }, tasks: { read: true, write: true } });
const effective = intersectPermissions(baseReadOnly, connWrite);
expect("交集: memory 只读", [effective.memory.read, effective.memory.write], [true, false]);
expect("交集: 基础没有的域全关", [effective.tasks.read, effective.tasks.write], [false, false]);
expectTrue("交集: memory_search 可见", toolVisibleToAgent("memory_search", effective));
expect("交集: memory_upsert 不可见", toolVisibleToAgent("memory_upsert", effective), false);
expectTrue("交集: memory_upsert 调用被拒", toolAccessError("memory_upsert", effective, "Agent", {}) !== null);
expect("交集: memory_search 调用放行", toolAccessError("memory_search", effective, "Agent", {}), null);
// 收紧基础：连接不变，交集立即变小（resolve 每次现算，不缓存）。
const tightened = intersectPermissions(parsePermissions({}), connWrite);
expect("收紧: 交集全关", toolVisibleToAgent("memory_search", tightened), false);
// 垃圾权限 JSON 解析失败 = 全关，交集仍全关。
const garbage = intersectPermissions(parsePermissions("{not json"), connWrite);
expect("垃圾输入: 交集全关", serializePermissions(garbage), serializePermissions(parsePermissions(null)));

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

  const badPage = await req(
    `/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent("https://nope.example/cb")}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256`,
  );
  expectTrue("e2e: 坏回调只给错误页不跳转", badPage.status === 200 && String(badPage.data).includes("无法继续"));

  // -- 连接 1：绑定路径 --
  const authorize = (payload) => req("/oauth/authorize", asJson(payload));
  const base = {
    client_id: clientId,
    redirect_uri: "https://client.example/cb",
    state: "st1",
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  const grant1 = await authorize({
    ...base,
    mode: "bind",
    link_secret: `https://mos.example/mcp?token=${agentToken}`,
    grants: { memory: { read: true, write: true } },
  });
  expect("e2e: 绑定授权 200", grant1.status, 200);
  const redirect1 = new URL(grant1.data.redirect);
  const code1 = redirect1.searchParams.get("code");
  expect("e2e: 回跳带 state", redirect1.searchParams.get("state"), "st1");
  expectTrue("e2e: 回跳带 code", typeof code1 === "string" && code1.startsWith("hvm_oac_"));

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

  const mcpCall = (token, method, params) =>
    req("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  const list1 = await mcpCall(access1, "tools/list", {});
  const toolNames = (list1.data.result?.tools || []).map((tool) => tool.name);
  expectTrue("e2e: 交集后 memory_search 可见", toolNames.includes("memory_search"));
  expect("e2e: 交集后 memory_upsert 不可见", toolNames.includes("memory_upsert"), false);
  const denied = await mcpCall(access1, "tools/call", { name: "memory_upsert", arguments: { title: "x" } });
  expect("e2e: 写调用被拒 -32003", denied.data.error?.code, -32003);

  // -- 管理端：列表 / reveal / 撤销 --
  const conns = await req(`/api/agents/${agentId}/oauth-connections`, { headers: adminCookie });
  expect("e2e: 连接列表 200", conns.status, 200);
  expect("e2e: 连接列表 1 条", conns.data.connections?.length, 1);
  const conn1 = conns.data.connections[0];
  const reveal = await req(`/api/oauth/connections/${conn1.id}/reveal-tokens`, { method: "POST", headers: adminCookie });
  expect("e2e: reveal 200", reveal.status, 200);
  expect("e2e: reveal 回当前 access", reveal.data.access_token, access1);
  const revoke = await req(`/api/oauth/connections/${conn1.id}/revoke`, { method: "POST", headers: adminCookie });
  expect("e2e: 面板撤销 200", revoke.status, 200);
  const afterRevoke = await mcpCall(access1, "tools/list", {});
  expect("e2e: 撤销后令牌立即失效", afterRevoke.status, 401);

  // -- 连接 2：refresh 轮换与复用整族撤销 --
  const grant2 = await authorize({ ...base, mode: "bind", link_secret: agentToken, grants: { memory: { read: true } } });
  const code2 = new URL(grant2.data.redirect).searchParams.get("code");
  const tokens2 = await req(
    "/oauth/token",
    form({ grant_type: "authorization_code", code: code2, client_id: clientId, redirect_uri: base.redirect_uri, code_verifier: verifier }),
  );
  const rotated = await req("/oauth/token", form({ grant_type: "refresh_token", refresh_token: tokens2.data.refresh_token, client_id: clientId }));
  expect("e2e: refresh 轮换成功", rotated.status, 200);
  const rotatedList = await mcpCall(rotated.data.access_token, "tools/list", {});
  expect("e2e: 轮换后新 access 可用", rotatedList.status, 200);
  const reuseOld = await req(
    "/oauth/token",
    form({ grant_type: "refresh_token", refresh_token: tokens2.data.refresh_token, client_id: clientId }),
  );
  expect("e2e: 旧 refresh 复用拒绝", reuseOld.status, 400);
  const familyDead = await mcpCall(rotated.data.access_token, "tools/list", {});
  expect("e2e: 复用后整族撤销", familyDead.status, 401);

  // -- 连接 3：管理员身份路 + 收紧基础立即生效 --
  // 先把基础放宽到读写再授权（连接存的是授权当时的交集），兑换后写工具
  // 可见；随后收紧基础，同一令牌的可见集立即变小。
  await req(`/api/agents/${agentId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...adminCookie },
    body: JSON.stringify({ permissions: { memory: { read: true, write: true } } }),
  });
  const grant3 = await req("/oauth/authorize", {
    ...asJson({ ...base, mode: "existing", agent_id: agentId, grants: { memory: { read: true, write: true } } }),
    headers: { "content-type": "application/json", ...adminCookie },
  });
  expect("e2e: 管理员选择已有 Agent 200", grant3.status, 200);
  const code3 = new URL(grant3.data.redirect).searchParams.get("code");
  const tokens3 = await req(
    "/oauth/token",
    form({ grant_type: "authorization_code", code: code3, client_id: clientId, redirect_uri: base.redirect_uri, code_verifier: verifier }),
  );
  const listWide = await mcpCall(tokens3.data.access_token, "tools/list", {});
  expectTrue(
    "e2e: 基础放宽后写工具可见",
    (listWide.data.result?.tools || []).some((tool) => tool.name === "memory_upsert"),
  );
  await req(`/api/agents/${agentId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...adminCookie },
    body: JSON.stringify({ permissions: { memory: { read: true, write: false } } }),
  });
  const listTight = await mcpCall(tokens3.data.access_token, "tools/list", {});
  expect(
    "e2e: 基础收紧后存量连接即刻受限",
    (listTight.data.result?.tools || []).some((tool) => tool.name === "memory_upsert"),
    false,
  );

  // -- 管理员新建 Agent 路 --
  const grant4 = await req("/oauth/authorize", {
    ...asJson({
      ...base,
      mode: "new",
      agent_name: "E2E New Agent",
      base_permissions: { memory: { read: true, write: false } },
      grants: { memory: { read: true, write: true } },
    }),
    headers: { "content-type": "application/json", ...adminCookie },
  });
  expect("e2e: 管理员新建 Agent 授权 200", grant4.status, 200);
  const code4 = new URL(grant4.data.redirect).searchParams.get("code");
  const tokens4 = await req(
    "/oauth/token",
    form({ grant_type: "authorization_code", code: code4, client_id: clientId, redirect_uri: base.redirect_uri, code_verifier: verifier }),
  );
  const list4 = await mcpCall(tokens4.data.access_token, "tools/list", {});
  const names4 = (list4.data.result?.tools || []).map((tool) => tool.name);
  expectTrue("e2e: 新 Agent 连接可读记忆", names4.includes("memory_search"));
  expect("e2e: 新 Agent 连接不可写（基础只读封顶）", names4.includes("memory_upsert"), false);
} finally {
  dev.kill("SIGTERM");
}
console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
