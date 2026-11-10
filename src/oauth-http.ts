// OAuth 协议端点与授权页、管理端连接接口。
//
// handleOAuthPublic 挂在管理员会话门之前（协议端点与授权页必须能被未
// 登录的外部流程到达）：授权页自身按「有没有管理员会话」分两条身份路——
// 有会话可选已有 Agent 或新建；无会话只能粘贴接入链接密钥绑定设备。
// handleOAuthAdmin 挂在门后，复用面板会话与 logOp 口径。

import { SESSION_COOKIE, sha256Hex } from "./auth";
import { findSessionUser } from "./accounts";
import type { Env } from "./env";
import { isCrossSite, json, readCookie, readJsonLimited } from "./http";
import { logOp, panelActor } from "./oplog";
import { parsePermissions, permissionsFromInput, intersectPermissions, PERMISSION_DOMAINS, ADVANCED_PERMISSIONS } from "./permissions";
import type { AgentPermissions } from "./permissions";
import {
  bindAgentByLinkSecret,
  createAgentForConsent,
  createConnection,
  exchangeAuthorizationCode,
  getOAuthClient,
  clientRedirectUris,
  issueAuthorizationCode,
  listAgentConnections,
  listConsentAgents,
  registerOAuthClient,
  revealConnectionTokens,
  revokeConnection,
  revokeTokenValue,
  rotateRefreshToken,
  writeOAuthAudit,
} from "./oauth";
import { extractLinkSecret, isAllowedRedirectUri, isValidCodeChallenge } from "./oauth-util";
import type { OAuthClientRow } from "./oauth";

const REGISTER_BODY_BYTES = 16 * 1024;
const AUTHORIZE_BODY_BYTES = 32 * 1024;
const TOKEN_BODY_BYTES = 16 * 1024;

// ---- 小工具 ---------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function noStore(response: Response): Response {
  response.headers.set("cache-control", "no-store");
  return response;
}

function oauthError(error: string, description: string, status = 400): Response {
  return noStore(json({ error, error_description: description }, status));
}

async function optionalAdmin(request: Request, env: Env): Promise<{ username: string } | null> {
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!token) return null;
  try {
    const user = await findSessionUser(env.DB, await sha256Hex(token));
    if (!user || user.expires_at <= Date.now() || user.disabled_at != null || user.role !== "admin") return null;
    return { username: user.username };
  } catch {
    return null;
  }
}

async function readParams(request: Request): Promise<Record<string, string> | null> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await readJsonLimited(request, TOKEN_BODY_BYTES);
    if (!body.ok) return null;
    if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) return null;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(body.value as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  }
  const text = await request.text();
  if (text.length > TOKEN_BODY_BYTES) return null;
  const params = new URLSearchParams(text);
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

function redirectWith(url: string, params: Record<string, string>): Response {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value) target.searchParams.set(key, value);
  }
  return new Response(null, { status: 302, headers: { location: target.toString(), "cache-control": "no-store" } });
}

// ---- 发现元数据 -------------------------------------------------------------

function serverMetadata(request: Request): Response {
  const issuer = new URL(request.url).origin;
  return noStore(
    json({
      issuer,
      authorization_endpoint: issuer + "/oauth/authorize",
      token_endpoint: issuer + "/oauth/token",
      revocation_endpoint: issuer + "/oauth/revoke",
      registration_endpoint: issuer + "/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    }),
  );
}

function resourceMetadata(request: Request): Response {
  const issuer = new URL(request.url).origin;
  return noStore(
    json({
      resource: issuer + "/mcp",
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
    }),
  );
}

// ---- 客户端注册（RFC 7591，公共客户端） --------------------------------------

async function register(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return oauthError("invalid_request", "只接受 POST", 405);
  const body = await readJsonLimited(request, REGISTER_BODY_BYTES);
  if (!body.ok) return oauthError("invalid_client_metadata", body.error);
  const result = await registerOAuthClient(env.DB, body.value, isAllowedRedirectUri);
  if (!result.ok) return oauthError("invalid_client_metadata", result.error, result.status);
  const client = result.client;
  return noStore(
    json(
      {
        client_id: client.client_id,
        client_id_issued_at: Math.floor(client.created_at / 1000),
        client_name: client.client_name,
        client_uri: client.client_uri,
        redirect_uris: JSON.parse(client.redirect_uris_json) as string[],
        grant_types: JSON.parse(client.grant_types_json) as string[],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
    ),
  );
}

// ---- 授权请求校验（GET 页面与 POST 提交共用） --------------------------------

interface AuthorizeRequest {
  client: OAuthClientRow;
  redirectUri: string;
  state: string;
  challenge: string;
}

async function validateAuthorizeRequest(
  env: Env,
  params: { clientId: string; redirectUri: string; responseType: string; challenge: string; challengeMethod: string; state: string },
): Promise<{ ok: true; value: AuthorizeRequest } | { ok: false; description: string; redirectUri: string | null }> {
  const client = params.clientId ? await getOAuthClient(env.DB, params.clientId) : null;
  if (!client || client.status !== "active") {
    return { ok: false, description: "客户端未注册或已停用", redirectUri: null };
  }
  const registered = clientRedirectUris(client);
  if (!params.redirectUri || !registered.includes(params.redirectUri)) {
    return { ok: false, description: "回调地址与注册信息不一致", redirectUri: null };
  }
  if (params.responseType !== "code") {
    return { ok: false, description: "只支持 response_type=code", redirectUri: params.redirectUri };
  }
  if (params.challengeMethod !== "S256" || !isValidCodeChallenge(params.challenge)) {
    return { ok: false, description: "缺少合法的 PKCE 参数（code_challenge_method 必须为 S256）", redirectUri: params.redirectUri };
  }
  return {
    ok: true,
    value: { client, redirectUri: params.redirectUri, state: params.state, challenge: params.challenge },
  };
}

// ---- 授权页（服务端渲染） -----------------------------------------------------

function pageShell(title: string, bodyHtml: string, scriptJson?: string): Response {
  const html =
    "<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n" +
    "<title>" + escapeHtml(title) + " · HiveMos</title>\n" +
    "<link rel=\"icon\" href=\"/logo.png\">\n" +
    "<link rel=\"stylesheet\" href=\"/style.css\">\n" +
    "<script src=\"/theme-boot.js\"></script>\n" +
    "<style>\n" +
    ".oauth-wrap{max-width:520px;margin:0 auto;padding:28px 16px 72px}\n" +
    ".oauth-head{display:flex;align-items:center;gap:12px;margin-bottom:6px}\n" +
    ".oauth-head img{width:40px;height:40px;border-radius:10px}\n" +
    ".oauth-head h1{font-size:22px;margin:0}\n" +
    ".oauth-sub{margin:6px 0 18px;line-height:1.6}\n" +
    ".oauth-card{border:1px solid rgba(128,128,128,.35);border-radius:12px;padding:14px;margin:0 0 12px}\n" +
    ".oauth-card label{display:block;font-weight:600;margin-bottom:6px}\n" +
    ".oauth-card .hint{font-weight:400}\n" +
    ".oauth-wrap input[type=text],.oauth-wrap textarea,.oauth-wrap select{width:100%;box-sizing:border-box;padding:9px 10px;border-radius:8px;border:1px solid rgba(128,128,128,.45);background:transparent;color:inherit;font:inherit}\n" +
    ".oauth-matrix{display:grid;grid-template-columns:1fr 52px 52px;gap:6px 8px;align-items:center}\n" +
    ".oauth-matrix .mhead{font-weight:600;text-align:center}\n" +
    ".oauth-matrix .mname{text-align:left}\n" +
    ".oauth-matrix label{text-align:center;margin:0}\n" +
    ".oauth-matrix input[type=checkbox]{width:20px;height:20px}\n" +
    ".oauth-adv{margin-top:10px;display:grid;gap:6px}\n" +
    ".oauth-foot{display:flex;gap:10px;margin-top:20px}\n" +
    ".oauth-foot button{flex:1;padding:12px;border-radius:10px;font:inherit;cursor:pointer}\n" +
    ".oauth-msg{min-height:1.4em;margin-top:12px}\n" +
    ".oauth-sec-title{font-weight:700;margin:20px 0 8px}\n" +
    "</style>\n</head>\n<body>\n<main class=\"oauth-wrap\">\n" +
    bodyHtml +
    (scriptJson ? "\n<script>window.__OAUTH_PAGE__=" + scriptJson + ";</script>\n<script src=\"/oauth-authorize.js\" defer></script>\n" : "") +
    "</main>\n</body>\n</html>\n";
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function authorizeErrorPage(description: string): Response {
  return pageShell(
    "连接授权",
    "<div class=\"oauth-head\"><img src=\"/logo.png\" alt=\"\"><h1>连接授权</h1></div>" +
      "<p class=\"oauth-sub\">这个授权请求无法继续：" + escapeHtml(description) + "</p>" +
      "<p class=\"oauth-sub\">请回到发起连接的应用里重新发起授权</p>",
  );
}

async function authorizePage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const validated = await validateAuthorizeRequest(env, {
    clientId: url.searchParams.get("client_id") || "",
    redirectUri: url.searchParams.get("redirect_uri") || "",
    responseType: url.searchParams.get("response_type") || "",
    challenge: url.searchParams.get("code_challenge") || "",
    challengeMethod: url.searchParams.get("code_challenge_method") || "",
    state: url.searchParams.get("state") || "",
  });
  if (!validated.ok) {
    if (validated.redirectUri) {
      return redirectWith(validated.redirectUri, {
        error: "invalid_request",
        error_description: validated.description,
        state: url.searchParams.get("state") || "",
      });
    }
    return authorizeErrorPage(validated.description);
  }
  const { client, redirectUri, state, challenge } = validated.value;
  const admin = await optionalAdmin(request, env);
  const agents = admin ? await listConsentAgents(env) : [];
  const clientHost = (() => {
    if (!client.client_uri) return "";
    try {
      return new URL(client.client_uri).host;
    } catch {
      return "";
    }
  })();
  const payload = {
    client: { id: client.client_id, name: client.client_name, host: clientHost },
    params: {
      client_id: client.client_id,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    },
    admin: !!admin,
    agents: agents.map((agent) => ({ id: agent.id, name: agent.name, permissions: agent.permissions })),
    domains: PERMISSION_DOMAINS.map((domain) => ({ key: domain })),
    advanced: ADVANCED_PERMISSIONS.map((key) => ({ key })),
  };
  const scriptJson = JSON.stringify(payload).replaceAll("<", "\\u003c");
  const identityHtml = admin
    ? "<div class=\"oauth-card\"><label><input type=\"radio\" name=\"mode\" value=\"existing\" checked> 使用已有 Agent</label>" +
      "<select id=\"agentSel\"></select></div>" +
      "<div class=\"oauth-card\"><label><input type=\"radio\" name=\"mode\" value=\"new\"> 创建新 Agent</label>" +
      "<input type=\"text\" id=\"newName\" placeholder=\"新 Agent 的名字\" maxlength=\"64\">" +
      "<p class=\"hint\">新 Agent 的基础权限（上限）在下面先设，本次连接权限不能超过它</p>" +
      "<div id=\"baseMatrix\"></div></div>"
    : "<div class=\"oauth-card\"><label for=\"linkSecret\">输入链接密钥绑定设备</label>" +
      "<p class=\"hint\">粘贴这个 Agent 的接入地址（…/mcp?token=…）或其中的密钥，绑定它作为本次连接的身份</p>" +
      "<textarea id=\"linkSecret\" rows=\"3\" autocomplete=\"off\"></textarea>" +
      "<p><button type=\"button\" id=\"bindBtn\">验证绑定</button></p>" +
      "<p class=\"hint\" id=\"bindState\">尚未验证</p></div>";
  const body =
    "<div class=\"oauth-head\"><img src=\"/logo.png\" alt=\"\"><h1>连接授权</h1></div>" +
    "<p class=\"oauth-sub\"><strong>" + escapeHtml(client.client_name) + "</strong>" +
    (clientHost ? "（" + escapeHtml(clientHost) + "）" : "") +
    " 正在请求访问你的 HiveMos</p>" +
    "<div class=\"oauth-sec-title\">选择身份</div>" +
    identityHtml +
    "<div class=\"oauth-sec-title\">本次连接的权限</div>" +
    "<div class=\"oauth-card\"><div id=\"connMatrix\"></div>" +
    "<p class=\"hint\">灰掉的格子是这个身份的基础权限没有开放，本次连接不能选</p></div>" +
    "<div class=\"oauth-foot\"><button type=\"button\" id=\"denyBtn\">拒绝</button>" +
    "<button type=\"button\" id=\"allowBtn\">允许访问</button></div>" +
    "<p class=\"oauth-msg\" id=\"msg\" role=\"status\"></p>";
  return pageShell("连接授权", body, scriptJson);
}

// ---- 授权提交 ---------------------------------------------------------------

async function authorizeSubmit(request: Request, env: Env): Promise<Response> {
  if (isCrossSite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const body = await readJsonLimited(request, AUTHORIZE_BODY_BYTES);
  if (!body.ok) return json({ ok: false, error: body.error }, body.status);
  const value = (body.value && typeof body.value === "object" && !Array.isArray(body.value) ? body.value : {}) as Record<string, unknown>;
  const validated = await validateAuthorizeRequest(env, {
    clientId: typeof value.client_id === "string" ? value.client_id : "",
    redirectUri: typeof value.redirect_uri === "string" ? value.redirect_uri : "",
    responseType: "code",
    challenge: typeof value.code_challenge === "string" ? value.code_challenge : "",
    challengeMethod: "S256",
    state: typeof value.state === "string" ? value.state : "",
  });
  if (!validated.ok) return json({ ok: false, error: validated.description }, 400);
  const { client, redirectUri, state, challenge } = validated.value;

  const requested = permissionsFromInput(value.grants === undefined ? {} : value.grants);
  if (!requested.ok) return json({ ok: false, error: requested.error }, requested.status);

  const mode = typeof value.mode === "string" ? value.mode : "";
  const admin = await optionalAdmin(request, env);
  let agentId = "";
  let agentName = "";
  let base: AgentPermissions;
  let bindUsed = false;

  if (mode === "existing") {
    if (!admin) return json({ ok: false, error: "选择已有 Agent 需要先登录管理员" }, 401);
    const agents = await listConsentAgents(env);
    const picked = agents.find((agent) => agent.id === value.agent_id);
    if (!picked) return json({ ok: false, error: "请选择一个已启用的 Agent" }, 400);
    agentId = picked.id;
    agentName = picked.name;
    base = picked.permissions;
  } else if (mode === "new") {
    if (!admin) return json({ ok: false, error: "创建新 Agent 需要先登录管理员" }, 401);
    const created = await createAgentForConsent(env, typeof value.agent_name === "string" ? value.agent_name : "", value.base_permissions);
    if (!created.ok) return json({ ok: false, error: created.error }, created.status);
    agentId = created.agentId;
    agentName = created.agentName;
    base = created.base;
  } else if (mode === "bind") {
    const secret = extractLinkSecret(typeof value.link_secret === "string" ? value.link_secret : "");
    const bound = await bindAgentByLinkSecret(env, secret, Date.now());
    if (!bound.ok) return json({ ok: false, error: bound.error }, bound.status);
    agentId = bound.agentId;
    agentName = bound.agentName;
    base = bound.permissions;
    bindUsed = true;
  } else {
    return json({ ok: false, error: "请选择身份方式" }, 400);
  }

  // 服务端再做一次交集，不信任前端的置灰。
  const grants = intersectPermissions(requested.permissions, base);
  const connection = await createConnection(env.DB, { clientId: client.client_id, agentId, grants });
  const code = await issueAuthorizationCode(env.DB, {
    clientId: client.client_id,
    connectionId: connection.id,
    redirectUri,
    challenge,
  });
  const actor = admin?.username || agentName;
  if (bindUsed) {
    await writeOAuthAudit(env.DB, {
      actor,
      event: "bind",
      clientId: client.client_id,
      connectionId: connection.id,
      agentId,
      agentName,
      detail: "链接密钥绑定设备",
    });
  }
  await writeOAuthAudit(env.DB, {
    actor,
    event: "authorize",
    clientId: client.client_id,
    connectionId: connection.id,
    agentId,
    agentName,
    detail: "grants " + JSON.stringify(grantsSummaryKeys(grants)),
  });
  await logOp(env.DB, {
    actor,
    module: "Agent",
    action: bindUsed ? "OAuth 绑定" : "OAuth 授权",
    targetId: agentId,
    targetName: agentName,
    text: `通过 OAuth 把 Agent「${agentName}」授权给客户端「${client.client_name}」` + (bindUsed ? "（链接密钥绑定）" : ""),
  });
  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  if (state) target.searchParams.set("state", state);
  return json({ ok: true, redirect: target.toString() });
}

function grantsSummaryKeys(grants: AgentPermissions): string[] {
  const keys: string[] = [];
  for (const domain of PERMISSION_DOMAINS) {
    if (grants[domain].read) keys.push(domain + ":r");
    if (grants[domain].write) keys.push(domain + ":w");
  }
  for (const key of ADVANCED_PERMISSIONS) {
    if (grants.advanced[key].read) keys.push("adv:" + key + ":r");
    if (grants.advanced[key].write) keys.push("adv:" + key + ":w");
  }
  return keys;
}

// 绑定校验：只验证密钥并回身份与基础权限，不建连接（建连接在提交时）。
async function bindCheck(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return json({ ok: false, error: "方法不允许" }, 405);
  if (isCrossSite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const body = await readJsonLimited(request, TOKEN_BODY_BYTES);
  if (!body.ok) return json({ ok: false, error: body.error }, body.status);
  const value = (body.value && typeof body.value === "object" && !Array.isArray(body.value) ? body.value : {}) as Record<string, unknown>;
  const secret = extractLinkSecret(typeof value.link_secret === "string" ? value.link_secret : "");
  const bound = await bindAgentByLinkSecret(env, secret, Date.now());
  if (!bound.ok) return json({ ok: false, error: bound.error }, bound.status);
  return json({ ok: true, agent_name: bound.agentName, permissions: parsePermissions(bound.permissions) });
}

// ---- 令牌与撤销端点 -----------------------------------------------------------

async function tokenEndpoint(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return oauthError("invalid_request", "只接受 POST", 405);
  const params = await readParams(request);
  if (!params) return oauthError("invalid_request", "请求格式不正确");
  const grantType = params.grant_type || "";
  if (grantType === "authorization_code") {
    if (!params.code || !params.client_id || !params.redirect_uri || !params.code_verifier) {
      return oauthError("invalid_request", "缺少 code、client_id、redirect_uri 或 code_verifier");
    }
    const grant = await exchangeAuthorizationCode(env, {
      code: params.code,
      clientId: params.client_id,
      redirectUri: params.redirect_uri,
      verifier: params.code_verifier,
    });
    if (!grant.ok) return oauthError(grant.error, grant.errorDescription);
    return noStore(
      json({ access_token: grant.accessToken, token_type: "Bearer", expires_in: grant.expiresIn, refresh_token: grant.refreshToken }),
    );
  }
  if (grantType === "refresh_token") {
    if (!params.refresh_token || !params.client_id) {
      return oauthError("invalid_request", "缺少 refresh_token 或 client_id");
    }
    const grant = await rotateRefreshToken(env, { refreshToken: params.refresh_token, clientId: params.client_id });
    if (!grant.ok) return oauthError(grant.error, grant.errorDescription);
    return noStore(
      json({ access_token: grant.accessToken, token_type: "Bearer", expires_in: grant.expiresIn, refresh_token: grant.refreshToken }),
    );
  }
  return oauthError("unsupported_grant_type", "不支持的 grant_type");
}

async function revokeEndpoint(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return oauthError("invalid_request", "只接受 POST", 405);
  const params = await readParams(request);
  if (params?.token) {
    await revokeTokenValue(env, { token: params.token, clientId: params.client_id || undefined });
  }
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}

// ---- 公开分发 -----------------------------------------------------------------

export async function handleOAuthPublic(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path === "/.well-known/oauth-authorization-server") {
    if (request.method.toUpperCase() !== "GET") return oauthError("invalid_request", "只接受 GET", 405);
    return serverMetadata(request);
  }
  if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
    if (request.method.toUpperCase() !== "GET") return oauthError("invalid_request", "只接受 GET", 405);
    return resourceMetadata(request);
  }
  if (path === "/oauth/register") return register(request, env);
  if (path === "/oauth/authorize") {
    const method = request.method.toUpperCase();
    if (method === "GET") return authorizePage(request, env);
    if (method === "POST") return authorizeSubmit(request, env);
    return oauthError("invalid_request", "方法不允许", 405);
  }
  if (path === "/oauth/bind-check") return bindCheck(request, env);
  if (path === "/oauth/token") return tokenEndpoint(request, env);
  if (path === "/oauth/revoke") return revokeEndpoint(request, env);
  return null;
}

// ---- 管理端（会话门后） ---------------------------------------------------------

export async function handleOAuthAdmin(request: Request, env: Env, path: string): Promise<Response | null> {
  const list = /^\/api\/agents\/([A-Za-z0-9_-]+)\/oauth-connections$/.exec(path);
  if (list && list[1]) {
    if (request.method.toUpperCase() !== "GET") return json({ ok: false, error: "方法不允许" }, 405);
    const connections = await listAgentConnections(env, list[1]);
    return json({ ok: true, connections });
  }
  const revoke = /^\/api\/oauth\/connections\/([A-Za-z0-9_-]+)\/revoke$/.exec(path);
  if (revoke && revoke[1]) {
    if (request.method.toUpperCase() !== "POST") return json({ ok: false, error: "方法不允许" }, 405);
    if (isCrossSite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
    const actor = await panelActor(request, env);
    const result = await revokeConnection(env, revoke[1], actor);
    if (!result.ok) return json({ ok: false, error: result.error }, result.status);
    return json({ ok: true });
  }
  const reveal = /^\/api\/oauth\/connections\/([A-Za-z0-9_-]+)\/reveal-tokens$/.exec(path);
  if (reveal && reveal[1]) {
    if (request.method.toUpperCase() !== "POST") return json({ ok: false, error: "方法不允许" }, 405);
    if (isCrossSite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
    const actor = await panelActor(request, env);
    const result = await revealConnectionTokens(env, reveal[1], actor);
    if (!result.ok) return json({ ok: false, error: result.error }, result.status);
    return json({ ok: true, access_token: result.accessToken, refresh_token: result.refreshToken });
  }
  return null;
}
