// HiveMos 自身的 OAuth 2.0 授权服务器（授权码 + PKCE S256）。
//
// 两层授权：连接权限（oauth_connections.grants_json）只是委派范围，实际
// 生效权限在每次 MCP 调用时按 Agent 基础 ∩ 连接 现算（authenticateMcp），
// 所以收紧基础权限、停用 Agent、撤销连接都立即生效，不需要回写令牌。
//
// 令牌存储按业主裁定（推翻总纲 §7.3）：token_hash 做鉴权索引，token_enc
// 是 VAULT_KEY 密封的可恢复副本（与 Agent 令牌同一套），面板经审计后可
// 查看/复制。授权码只存哈希、5 分钟、单次使用（原子 UPDATE 抢占）。

import { sha256Hex } from "./auth";
import { decryptString, resolveContentKey, sealString } from "./crypto";
import type { D1Database, Env } from "./env";
import { logOp } from "./oplog";
import { intersectPermissions, parsePermissions, serializePermissions } from "./permissions";
import type { AgentPermissions } from "./permissions";
import { authenticateAgent, createAgent, listAgents, prepare, updateAgent } from "./registry";
import {
  ACCESS_TOKEN_PREFIX,
  AUTH_CODE_PREFIX,
  REFRESH_TOKEN_PREFIX,
  isValidCodeChallenge,
  newOAuthId,
  pkceMatches,
  randomOAuthSecret,
} from "./oauth-util";

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 5 * 60 * 1000;

type Failure = { ok: false; status: number; error: string };
type ProtocolFailure = { ok: false; error: string; errorDescription: string };

export interface OAuthClientRow {
  id: string;
  client_id: string;
  client_name: string;
  client_uri: string | null;
  logo_uri: string | null;
  redirect_uris_json: string;
  grant_types_json: string;
  response_types_json: string;
  token_endpoint_auth_method: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface OAuthConnectionRow {
  id: string;
  client_id: string;
  agent_id: string;
  grants_json: string;
  status: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

interface TokenRow {
  id: string;
  connection_id: string;
  family_id: string;
  kind: string;
  token_enc: string | null;
  expires_at: number | string;
  revoked_at: number | string | null;
  rotated_at: number | string | null;
  created_at: number | string;
  last_used_at: number | string | null;
}

export interface TokenGrant {
  ok: true;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  connectionId: string;
  agentId: string;
}

function asNumber(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rowsOf<T>(value: { results?: T[] } | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.results)) return value.results;
  return [];
}

// 与 registry.sealAgentToken 同一套口径：VAULT_KEY 没配就存不了可恢复
// 副本，令牌本身照常签发与校验，只是面板复制不可用。
async function sealOAuthToken(env: Env, token: string): Promise<string | null> {
  const raw = (env as unknown as Record<string, unknown>)["VAULT_KEY"];
  const key = resolveContentKey(typeof raw === "string" ? raw : undefined);
  if (key.state !== "on") return null;
  return sealString(key, token);
}

function tailOf(token: string): string {
  return token.length > 4 ? "…" + token.slice(-4) : "…";
}

// ---- 审计 -----------------------------------------------------------------

export interface OAuthAuditEntry {
  actor?: string;
  event: string;
  clientId?: string | null;
  connectionId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  detail?: string | null;
}

// 旁路写：失败不连累业务。reveal 路径用 writeOAuthAuditStrict（先审计、
// 后解密，写不进去就不给明文，和 Agent 令牌 reveal 同口径）。
export async function writeOAuthAudit(db: D1Database, entry: OAuthAuditEntry): Promise<void> {
  try {
    await writeOAuthAuditStrict(db, entry);
  } catch {
    // 审计写不进去就丢掉，不能连累业务。
  }
}

export async function writeOAuthAuditStrict(db: D1Database, entry: OAuthAuditEntry): Promise<void> {
  await prepare(
    db,
    "INSERT INTO oauth_audit (id, at, actor, event, client_id, connection_id, agent_id, agent_name, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      newOAuthId("oau_"),
      Date.now(),
      entry.actor || "",
      entry.event,
      entry.clientId ?? null,
      entry.connectionId ?? null,
      entry.agentId ?? null,
      entry.agentName ?? null,
      entry.detail ?? null,
    ],
  ).run();
}

// ---- 客户端 ---------------------------------------------------------------

export async function getOAuthClient(db: D1Database, clientId: string): Promise<OAuthClientRow | null> {
  return prepare(db, "SELECT * FROM oauth_clients WHERE client_id = ?", [clientId]).first<OAuthClientRow>();
}

export function clientRedirectUris(client: OAuthClientRow): string[] {
  try {
    const parsed = JSON.parse(client.redirect_uris_json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export async function registerOAuthClient(
  db: D1Database,
  value: unknown,
  isAllowedRedirectUri: (uri: string) => boolean,
): Promise<{ ok: true; client: OAuthClientRow } | Failure> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, status: 400, error: "请求格式不正确" };
  }
  const body = value as Record<string, unknown>;
  const name = typeof body.client_name === "string" ? body.client_name.trim() : "";
  if (name.length > 128) return { ok: false, status: 400, error: "客户端名称过长" };
  const clientUri = typeof body.client_uri === "string" && body.client_uri.trim() ? body.client_uri.trim().slice(0, 512) : null;
  const logoUri = typeof body.logo_uri === "string" && body.logo_uri.trim() ? body.logo_uri.trim().slice(0, 512) : null;

  const rawUris = body.redirect_uris;
  if (!Array.isArray(rawUris) || rawUris.length === 0 || rawUris.length > 10) {
    return { ok: false, status: 400, error: "redirect_uris 需要 1 到 10 个回调地址" };
  }
  const uris: string[] = [];
  for (const item of rawUris) {
    if (typeof item !== "string" || !isAllowedRedirectUri(item)) {
      return { ok: false, status: 400, error: "回调地址不合法：只允许 https，或 http 的本机回环地址" };
    }
    if (!uris.includes(item)) uris.push(item);
  }
  const authMethod = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";
  if (authMethod !== "none") {
    return { ok: false, status: 400, error: "当前只支持公共客户端（token_endpoint_auth_method 为 none）加 PKCE" };
  }
  const grantTypes = Array.isArray(body.grant_types)
    ? body.grant_types.filter((item): item is string => typeof item === "string")
    : ["authorization_code", "refresh_token"];
  if (!grantTypes.includes("authorization_code")) {
    return { ok: false, status: 400, error: "grant_types 必须包含 authorization_code" };
  }
  for (const grant of grantTypes) {
    if (grant !== "authorization_code" && grant !== "refresh_token") {
      return { ok: false, status: 400, error: "不支持的 grant_type：" + grant };
    }
  }
  const now = Date.now();
  const client: OAuthClientRow = {
    id: newOAuthId("ocl_"),
    client_id: "hvm_client_" + newOAuthId("").slice(0, 24),
    client_name: name || "未命名客户端",
    client_uri: clientUri,
    logo_uri: logoUri,
    redirect_uris_json: JSON.stringify(uris),
    grant_types_json: JSON.stringify(grantTypes),
    response_types_json: JSON.stringify(["code"]),
    token_endpoint_auth_method: "none",
    status: "active",
    created_at: now,
    updated_at: now,
  };
  await prepare(
    db,
    "INSERT INTO oauth_clients (id, client_id, client_secret_hash, client_name, client_uri, logo_uri, redirect_uris_json, grant_types_json, response_types_json, token_endpoint_auth_method, status, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'none', 'active', ?, ?)",
    [
      client.id,
      client.client_id,
      client.client_name,
      client.client_uri,
      client.logo_uri,
      client.redirect_uris_json,
      client.grant_types_json,
      client.response_types_json,
      now,
      now,
    ],
  ).run();
  await writeOAuthAudit(db, { event: "client_register", clientId: client.client_id, detail: client.client_name });
  return { ok: true, client };
}

// ---- 连接与授权码 ----------------------------------------------------------

export async function createConnection(
  db: D1Database,
  input: { clientId: string; agentId: string; grants: AgentPermissions },
): Promise<OAuthConnectionRow> {
  const now = Date.now();
  const row: OAuthConnectionRow = {
    id: newOAuthId("ocn_"),
    client_id: input.clientId,
    agent_id: input.agentId,
    grants_json: serializePermissions(input.grants),
    status: "active",
    created_at: now,
    updated_at: now,
    last_used_at: null,
    revoked_at: null,
  };
  await prepare(
    db,
    "INSERT INTO oauth_connections (id, client_id, agent_id, grants_json, status, created_at, updated_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, NULL)",
    [row.id, row.client_id, row.agent_id, row.grants_json, now, now],
  ).run();
  return row;
}

export async function getConnection(db: D1Database, id: string): Promise<OAuthConnectionRow | null> {
  return prepare(db, "SELECT * FROM oauth_connections WHERE id = ?", [id]).first<OAuthConnectionRow>();
}

export async function issueAuthorizationCode(
  db: D1Database,
  input: { clientId: string; connectionId: string; redirectUri: string; challenge: string },
): Promise<string> {
  const code = randomOAuthSecret(AUTH_CODE_PREFIX);
  const now = Date.now();
  await prepare(
    db,
    "INSERT INTO oauth_authorization_codes (code_hash, client_id, connection_id, redirect_uri, code_challenge, code_challenge_method, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, 'S256', ?, NULL, ?)",
    [await sha256Hex(code), input.clientId, input.connectionId, input.redirectUri, input.challenge, now + CODE_TTL_MS, now],
  ).run();
  return code;
}

// ---- 令牌签发与轮换 --------------------------------------------------------

async function insertToken(
  env: Env,
  input: { connectionId: string; familyId: string; kind: "access" | "refresh"; token: string; ttlMs: number; now: number },
): Promise<string> {
  const id = newOAuthId("otk_");
  const enc = await sealOAuthToken(env, input.token);
  await prepare(
    env.DB,
    "INSERT INTO oauth_tokens (id, connection_id, family_id, kind, token_hash, token_enc, expires_at, revoked_at, rotated_at, replaced_by_id, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL)",
    [id, input.connectionId, input.familyId, input.kind, await sha256Hex(input.token), enc, input.now + input.ttlMs, input.now],
  ).run();
  return id;
}

async function issueTokenPair(env: Env, connectionId: string, familyId: string, now: number): Promise<TokenGrant> {
  const accessToken = randomOAuthSecret(ACCESS_TOKEN_PREFIX);
  const refreshToken = randomOAuthSecret(REFRESH_TOKEN_PREFIX);
  await insertToken(env, { connectionId, familyId, kind: "access", token: accessToken, ttlMs: ACCESS_TTL_MS, now });
  await insertToken(env, { connectionId, familyId, kind: "refresh", token: refreshToken, ttlMs: REFRESH_TTL_MS, now });
  const connection = await getConnection(env.DB, connectionId);
  return {
    ok: true,
    accessToken,
    refreshToken,
    expiresIn: Math.floor(ACCESS_TTL_MS / 1000),
    connectionId,
    agentId: connection?.agent_id ?? "",
  };
}

async function revokeFamily(db: D1Database, familyId: string, now: number): Promise<void> {
  await prepare(db, "UPDATE oauth_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL", [now, familyId]).run();
}

async function agentIsActive(db: D1Database, agentId: string): Promise<boolean> {
  const row = await prepare(db, "SELECT status FROM agents WHERE id = ?", [agentId]).first<{ status: string }>();
  return row?.status === "active";
}

export async function exchangeAuthorizationCode(
  env: Env,
  input: { code: string; clientId: string; redirectUri: string; verifier: string },
): Promise<TokenGrant | ProtocolFailure> {
  const fail = (errorDescription: string): ProtocolFailure => ({ ok: false, error: "invalid_grant", errorDescription });
  const db = env.DB;
  const now = Date.now();
  const codeHash = await sha256Hex(input.code);
  const row = await prepare(db, "SELECT * FROM oauth_authorization_codes WHERE code_hash = ?", [codeHash]).first<{
    client_id: string;
    connection_id: string;
    redirect_uri: string;
    code_challenge: string;
    expires_at: number | string;
    used_at: number | string | null;
  }>();
  if (!row) return fail("授权码无效");
  if (row.used_at != null) return fail("授权码已被使用");
  if ((asNumber(row.expires_at) ?? 0) <= now) return fail("授权码已过期");
  if (row.client_id !== input.clientId) return fail("授权码不属于这个客户端");
  if (row.redirect_uri !== input.redirectUri) return fail("回调地址与授权时不一致");
  if (!isValidCodeChallenge(row.code_challenge) || !(await pkceMatches(input.verifier, row.code_challenge))) {
    return fail("PKCE 校验失败");
  }
  const connection = await getConnection(db, row.connection_id);
  if (!connection || connection.status !== "active") return fail("这条连接已不可用");
  if (!(await agentIsActive(db, connection.agent_id))) return fail("授权身份已停用");
  // 原子抢占：并发下只有一个兑换能把 used_at 从 NULL 改掉。
  const claimed = await prepare(db, "UPDATE oauth_authorization_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL", [
    now,
    codeHash,
  ]).run();
  const changes = (claimed as { meta?: { changes?: number } } | null)?.meta?.changes;
  if (changes !== undefined && changes !== 1) return fail("授权码已被使用");
  const grant = await issueTokenPair(env, connection.id, newOAuthId("ofm_"), now);
  await writeOAuthAudit(db, {
    event: "token_exchange",
    clientId: input.clientId,
    connectionId: connection.id,
    agentId: connection.agent_id,
    detail: "access " + tailOf(grant.accessToken),
  });
  return grant;
}

export async function rotateRefreshToken(
  env: Env,
  input: { refreshToken: string; clientId: string },
): Promise<TokenGrant | ProtocolFailure> {
  const fail = (errorDescription: string): ProtocolFailure => ({ ok: false, error: "invalid_grant", errorDescription });
  const db = env.DB;
  const now = Date.now();
  const row = await prepare(db, "SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'", [
    await sha256Hex(input.refreshToken),
  ]).first<TokenRow>();
  if (!row) return fail("刷新令牌无效");
  const connection = await getConnection(db, row.connection_id);
  if (!connection || connection.client_id !== input.clientId) return fail("刷新令牌不属于这个客户端");
  // 重放检出：这枚 refresh 已经被轮换用过、或已被撤销，却又出现——按
  // RFC 9700 的口径整族撤销，宁可让客户端重新授权。
  if (row.rotated_at != null || row.revoked_at != null) {
    await revokeFamily(db, row.family_id, now);
    await writeOAuthAudit(db, {
      event: "refresh_reuse",
      clientId: input.clientId,
      connectionId: connection.id,
      agentId: connection.agent_id,
      detail: "检出刷新令牌复用，整族撤销",
    });
    return fail("刷新令牌已被使用");
  }
  if ((asNumber(row.expires_at) ?? 0) <= now) return fail("刷新令牌已过期");
  if (connection.status !== "active") return fail("这条连接已撤销");
  if (!(await agentIsActive(db, connection.agent_id))) return fail("授权身份已停用");
  const grant = await issueTokenPair(env, connection.id, row.family_id, now);
  const newRefresh = await prepare(db, "SELECT id FROM oauth_tokens WHERE token_hash = ?", [
    await sha256Hex(grant.refreshToken),
  ]).first<{ id: string }>();
  await prepare(db, "UPDATE oauth_tokens SET rotated_at = ?, revoked_at = ?, replaced_by_id = ? WHERE id = ?", [
    now,
    now,
    newRefresh?.id ?? null,
    row.id,
  ]).run();
  await writeOAuthAudit(db, {
    event: "token_refresh",
    clientId: input.clientId,
    connectionId: connection.id,
    agentId: connection.agent_id,
    detail: "access " + tailOf(grant.accessToken),
  });
  return grant;
}

// RFC 7009：撤销端点对不存在/不属于该客户端的令牌也静默成功，不给探测
// 口径。撤销 refresh 连整族一起撤；撤销 access 只撤它自己。
export async function revokeTokenValue(env: Env, input: { token: string; clientId?: string }): Promise<void> {
  const db = env.DB;
  const now = Date.now();
  const row = await prepare(db, "SELECT * FROM oauth_tokens WHERE token_hash = ?", [await sha256Hex(input.token)]).first<TokenRow>();
  if (!row) return;
  const connection = await getConnection(db, row.connection_id);
  if (!connection) return;
  if (input.clientId && connection.client_id !== input.clientId) return;
  if (row.kind === "refresh") await revokeFamily(db, row.family_id, now);
  else await prepare(db, "UPDATE oauth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", [now, row.id]).run();
  await writeOAuthAudit(db, {
    event: "token_revoke",
    clientId: connection.client_id,
    connectionId: connection.id,
    agentId: connection.agent_id,
    detail: row.kind + " " + tailOf(input.token),
  });
}

// ---- MCP 鉴权 --------------------------------------------------------------

export interface McpAuth {
  ok: true;
  agentId: string;
  agentName: string;
  permissions: AgentPermissions;
}

// OAuth access token 的解析：令牌（未过期/未撤销）→ 连接（active）→
// Agent（active）三层都现查现算，权限取基础 ∩ 连接。
export async function resolveOAuthAccessToken(env: Env, token: string, now: number): Promise<McpAuth | Failure> {
  const db = env.DB;
  const row = await prepare(db, "SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'", [
    await sha256Hex(token),
  ]).first<TokenRow>();
  if (!row) return { ok: false, status: 401, error: "令牌无效" };
  if (row.revoked_at != null) return { ok: false, status: 401, error: "令牌已撤销" };
  if ((asNumber(row.expires_at) ?? 0) <= now) return { ok: false, status: 401, error: "令牌已过期" };
  const connection = await getConnection(db, row.connection_id);
  if (!connection || connection.status !== "active") return { ok: false, status: 401, error: "连接已撤销" };
  const agent = await prepare(db, "SELECT id, name, status, permissions, last_seen_at FROM agents WHERE id = ?", [
    connection.agent_id,
  ]).first<{ id: string; name: string; status: string; permissions: string | null; last_seen_at: number | string | null }>();
  if (!agent) return { ok: false, status: 401, error: "令牌无效" };
  if (agent.status !== "active") return { ok: false, status: 401, error: "令牌已停用" };

  // 使用痕迹：令牌与连接的 last_used 节流到一分钟一写；Agent 的
  // last_seen / call_count 与 authenticateAgent 同口径（call_count 不节流）。
  const tokenSeen = asNumber(row.last_used_at);
  if (tokenSeen === null || now - tokenSeen >= 60_000) {
    await prepare(db, "UPDATE oauth_tokens SET last_used_at = ? WHERE id = ?", [now, row.id]).run();
    await prepare(db, "UPDATE oauth_connections SET last_used_at = ? WHERE id = ?", [now, connection.id]).run();
  }
  const seen = asNumber(agent.last_seen_at);
  if (seen === null || now - seen >= 60_000) {
    await prepare(db, "UPDATE agents SET last_seen_at = ? WHERE id = ?", [now, agent.id]).run();
  }
  await prepare(db, "UPDATE agents SET call_count = call_count + 1 WHERE id = ?", [agent.id]).run();

  return {
    ok: true,
    agentId: agent.id,
    agentName: agent.name,
    permissions: intersectPermissions(parsePermissions(agent.permissions), parsePermissions(connection.grants_json)),
  };
}

// /mcp 的统一鉴权入口：OAuth access token 走连接解析，其余（Agent 长期
// 令牌、?token= 接入密钥）走原有 authenticateAgent，返回形状一致。
export async function authenticateMcp(env: Env, token: string, now: number): Promise<McpAuth | Failure> {
  if (token.startsWith(ACCESS_TOKEN_PREFIX)) return resolveOAuthAccessToken(env, token, now);
  return authenticateAgent(env.DB, token, now);
}

// 链接密钥绑定：接入密钥本身就是凭据，校验与 MCP 调用完全同路（哈希查
// agents、必须 active）。会带上 authenticateAgent 的使用痕迹写入，绑定
// 本来就是一次真实鉴权。
export async function bindAgentByLinkSecret(env: Env, secret: string, now: number): Promise<McpAuth | Failure> {
  const token = secret.trim();
  if (!token) return { ok: false, status: 400, error: "请粘贴接入链接或密钥" };
  if (token.startsWith(ACCESS_TOKEN_PREFIX)) {
    return { ok: false, status: 400, error: "这是 OAuth 令牌，请粘贴 Agent 的接入链接密钥" };
  }
  return authenticateAgent(env.DB, token, now);
}

// 授权页「新建 Agent」：复用面板同一条 createAgent（生来全关），再按管
// 理员在授权页设的基础权限写入（仍走 updateAgent 的严格解析）。
export async function createAgentForConsent(
  env: Env,
  name: string,
  basePermissionsInput: unknown,
): Promise<{ ok: true; agentId: string; agentName: string; base: AgentPermissions } | Failure> {
  const created = await createAgent(env, { name });
  if (!created.ok) return created;
  let base = created.agent.permissions;
  if (basePermissionsInput !== undefined && basePermissionsInput !== null) {
    const updated = await updateAgent(env.DB, created.agent.id, { permissions: basePermissionsInput });
    if (!updated.ok) return updated;
    base = updated.agent.permissions;
  }
  return { ok: true, agentId: created.agent.id, agentName: created.agent.name, base };
}

export async function listConsentAgents(env: Env): Promise<Array<{ id: string; name: string; permissions: AgentPermissions }>> {
  const agents = await listAgents(env.DB);
  return agents
    .filter((agent) => agent.status === "active")
    .map((agent) => ({ id: agent.id, name: agent.name, permissions: agent.permissions }));
}

// ---- 面板连接管理 ------------------------------------------------------------

export interface ConnectionView {
  id: string;
  client_id: string;
  client_name: string;
  client_uri: string | null;
  agent_id: string;
  grants: AgentPermissions;
  status: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  access_expires_at: number | null;
  has_refresh: boolean;
  reveal_available: boolean;
}

export async function listAgentConnections(env: Env, agentId: string): Promise<ConnectionView[]> {
  const listed = await prepare(
    env.DB,
    "SELECT c.*, cl.client_name AS client_name, cl.client_uri AS client_uri FROM oauth_connections c LEFT JOIN oauth_clients cl ON cl.client_id = c.client_id WHERE c.agent_id = ? ORDER BY c.created_at DESC",
    [agentId],
  ).all<OAuthConnectionRow & { client_name: string | null; client_uri: string | null }>();
  const views: ConnectionView[] = [];
  for (const row of rowsOf(listed)) {
    const latestAccess = await prepare(
      env.DB,
      "SELECT expires_at, token_enc FROM oauth_tokens WHERE connection_id = ? AND kind = 'access' ORDER BY created_at DESC LIMIT 1",
      [row.id],
    ).first<{ expires_at: number | string; token_enc: string | null }>();
    const liveRefresh = await prepare(
      env.DB,
      "SELECT id FROM oauth_tokens WHERE connection_id = ? AND kind = 'refresh' AND revoked_at IS NULL AND expires_at > ? LIMIT 1",
      [row.id, Date.now()],
    ).first<{ id: string }>();
    views.push({
      id: row.id,
      client_id: row.client_id,
      client_name: row.client_name || "未命名客户端",
      client_uri: row.client_uri,
      agent_id: row.agent_id,
      grants: parsePermissions(row.grants_json),
      status: row.status,
      created_at: asNumber(row.created_at) ?? 0,
      last_used_at: asNumber(row.last_used_at),
      revoked_at: asNumber(row.revoked_at),
      access_expires_at: asNumber(latestAccess?.expires_at ?? null),
      has_refresh: !!liveRefresh,
      reveal_available: !!latestAccess?.token_enc,
    });
  }
  return views;
}

export async function revokeConnection(env: Env, connectionId: string, actor: string): Promise<{ ok: true } | Failure> {
  const connection = await getConnection(env.DB, connectionId);
  if (!connection) return { ok: false, status: 404, error: "未找到这条连接" };
  if (connection.status === "active") {
    const now = Date.now();
    await prepare(env.DB, "UPDATE oauth_connections SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?", [
      now,
      now,
      connectionId,
    ]).run();
    await prepare(env.DB, "UPDATE oauth_tokens SET revoked_at = ? WHERE connection_id = ? AND revoked_at IS NULL", [now, connectionId]).run();
    const agent = await prepare(env.DB, "SELECT name FROM agents WHERE id = ?", [connection.agent_id]).first<{ name: string }>();
    const client = await getOAuthClient(env.DB, connection.client_id);
    await writeOAuthAudit(env.DB, {
      actor,
      event: "connection_revoke",
      clientId: connection.client_id,
      connectionId,
      agentId: connection.agent_id,
      agentName: agent?.name ?? null,
    });
    await logOp(env.DB, {
      actor,
      module: "Agent",
      action: "OAuth 撤销",
      targetId: connection.agent_id,
      targetName: agent?.name ?? null,
      text: `撤销了 Agent「${agent?.name ?? connection.agent_id}」与客户端「${client?.client_name ?? connection.client_id}」的 OAuth 连接`,
    });
  }
  return { ok: true };
}

// 查看/复制令牌：与 Agent 令牌 reveal 同口径——审计先落、落不了就不出
// 明文；取当前最新的一对（access + refresh）。
export async function revealConnectionTokens(
  env: Env,
  connectionId: string,
  actor: string,
): Promise<{ ok: true; accessToken: string; refreshToken: string | null } | Failure> {
  const connection = await getConnection(env.DB, connectionId);
  if (!connection) return { ok: false, status: 404, error: "未找到这条连接" };
  const raw = (env as unknown as Record<string, unknown>)["VAULT_KEY"];
  const key = resolveContentKey(typeof raw === "string" ? raw : undefined);
  if (key.state !== "on") return { ok: false, status: 503, error: "保险库密钥未配置，暂时不能查看令牌" };
  const latest = async (kind: string) =>
    prepare(
      env.DB,
      "SELECT token_enc FROM oauth_tokens WHERE connection_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1",
      [connectionId, kind],
    ).first<{ token_enc: string | null }>();
  const access = await latest("access");
  if (!access) return { ok: false, status: 409, error: "这条连接还没有签发过令牌" };
  if (!access.token_enc) {
    return { ok: false, status: 409, error: "令牌只存了摘要、无法取出，重新授权后即可查看" };
  }
  const agent = await prepare(env.DB, "SELECT name FROM agents WHERE id = ?", [connection.agent_id]).first<{ name: string }>();
  try {
    await writeOAuthAuditStrict(env.DB, {
      actor,
      event: "token_reveal",
      clientId: connection.client_id,
      connectionId,
      agentId: connection.agent_id,
      agentName: agent?.name ?? null,
    });
  } catch {
    return { ok: false, status: 503, error: "审计写入失败，暂时不能查看令牌" };
  }
  const accessToken = await decryptString(key.raw, access.token_enc);
  if (accessToken === null) return { ok: false, status: 500, error: "解密失败，保险库密钥可能不正确" };
  const refresh = await latest("refresh");
  const refreshToken = refresh?.token_enc ? await decryptString(key.raw, refresh.token_enc) : null;
  return { ok: true, accessToken, refreshToken };
}
