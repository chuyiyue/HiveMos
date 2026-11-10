// GitHub OAuth sign-in and binding, following the admin-init design §3.
//
// The bound numeric GitHub id is the only authorization value. The login
// callback verifies it and never writes a binding; binding changes only happen
// from the signed-in settings page (first bind, or rebind after re-entering the
// current password). A successful GitHub callback skips TOTP: the OAuth round
// trip itself is the second factor.

import {
  bytesToBase64Url,
  requestIsSecure,
  secretsEqual,
  sha256Hex,
  SESSION_COOKIE,
  verifyPassword,
} from "./auth";
import {
  accountPasswordLimited,
  clearAccountPasswordFailures,
  clearGithubBinding,
  consumeGithubRebind,
  findTotpUser,
  findUserRecordById,
  getAdminGithubBinding,
  getGithubBinding,
  listUserRecords,
  loginRetryAfterSeconds,
  recordAccountPasswordFailure,
  setGithubBinding,
  setGithubRebindUntil,
  updateGithubDisplay,
} from "./accounts";
import type { Env } from "./env";
import { isCrossSite, json, readCookie, readJsonLimited, rejectsSensitiveWrite } from "./http";
import { logOp } from "./oplog";
import { issueSession, requireAdminUser } from "./session";

export const GITHUB_STATE_COOKIE = "hivemos_gh_state";
export const GITHUB_INTENT_COOKIE = "hivemos_gh_intent";
const GITHUB_COOKIE_PATH = "/api/v1/auth/github";
const GITHUB_COOKIE_TTL_SECONDS = 600;

// Ten minutes covers the OAuth round trip after the password is re-entered.
const GITHUB_REBIND_TTL_MS = 10 * 60 * 1000;

const LOGIN_STATE = "/login?error=github_state";
const LOGIN_EXCHANGE = "/login?error=github_exchange";
const LOGIN_FORBIDDEN = "/login?error=github_forbidden";
const SETTINGS_BOUND = "/settings.html?github=bound";
const SETTINGS_ERROR = "/settings.html?github=error";

const JSON_BODY_BYTES = 8 * 1024;

export type GithubIntent = "login" | "bind";

export interface GithubSettings {
  clientId: string;
  clientSecret: string;
}

export interface GithubIdentity {
  id: string;
  login: string;
  avatarUrl: string;
  name: string | null;
}

export function githubSettings(env: Env): GithubSettings | null {
  const clientId = env.GITHUB_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim() ?? "";
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

// Authentication allow-list. The GitHub login name is display-only and never
// grants access: usernames can be renamed or claimed, numeric ids cannot.
export function decideGithubAccess(
  github: { id: string },
  policy: { boundId: string | null },
): { ok: boolean } {
  const bound = policy.boundId?.trim() ?? "";
  const id = github.id.trim();
  return { ok: bound.length > 0 && id === bound };
}

// Login page marker: OAuth configured AND a binding exists. A button that
// cannot succeed is not shown. The settings page uses the plain configured
// flag so the first binding can still be created (see githubAccountStatus).
export async function githubLoginEnabled(env: Env): Promise<boolean> {
  if (!githubSettings(env)) return false;
  const binding = await getAdminGithubBinding(env.DB);
  return (binding?.github_id?.trim() ?? "").length > 0;
}

// Public endpoints. These must run before the session gate: the login page
// reads the config anonymously, and GitHub's redirect is a cross-site GET.
export async function handleGithubPublicRequest(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (path === "/api/v1/auth/config") {
    if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
    return json({ ok: true, github_enabled: await githubLoginEnabled(env) });
  }
  if (path === "/api/v1/auth/github/start") {
    if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
    return githubStart(request, env);
  }
  if (path === "/api/v1/auth/github/callback") {
    if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
    return githubCallback(request, env);
  }
  return null;
}

// Authenticated endpoints, dispatched behind the admin gate.
export async function handleGithubAuthedRequest(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (path === "/api/account/github") {
    if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
    return githubAccountStatus(request, env);
  }
  if (path === "/api/v1/auth/github/unbind") {
    if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
    return githubUnbind(request, env);
  }
  if (path === "/api/v1/auth/github/rebind") {
    if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
    return githubRebind(request, env);
  }
  return null;
}

// Settings page status: configured means the two secrets exist; bound means a
// numeric id is stored. The login name and avatar are display-only.
async function githubAccountStatus(request: Request, env: Env): Promise<Response> {
  const user = await requireAdminUser(request, env);
  if (user instanceof Response) return user;
  const binding = await getGithubBinding(env.DB, user.id);
  return json({
    ok: true,
    configured: githubSettings(env) !== null,
    bound: (binding?.github_id?.trim() ?? "").length > 0,
    login: binding?.github_login ?? "",
    avatar_url: binding?.github_avatar_url ?? "",
  });
}

async function githubStart(request: Request, env: Env): Promise<Response> {
  const settings = githubSettings(env);
  if (!settings) return json({ ok: false, error: "GitHub 登录未启用" }, 404);
  const intent = readIntent(new URL(request.url).searchParams.get("intent"));
  if (!intent) return json({ ok: false, error: "intent 无效" }, 400);
  if (intent === "bind") {
    const user = await requireAdminUser(request, env);
    if (user instanceof Response) return user;
  }
  const state = newOauthState();
  const secure = requestIsSecure(request);
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", settings.clientId);
  authorize.searchParams.set("redirect_uri", callbackUrl(request));
  authorize.searchParams.set("scope", "read:user");
  authorize.searchParams.set("state", state);
  return redirect(authorize.toString(), [
    githubOAuthCookie(GITHUB_STATE_COOKIE, state, secure),
    githubOAuthCookie(GITHUB_INTENT_COOKIE, intent, secure),
  ]);
}

async function githubCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const secure = requestIsSecure(request);
  const clears = clearGithubOAuthCookies(secure);
  const provided = url.searchParams.get("state") ?? "";
  const saved = readCookie(request.headers.get("cookie"), GITHUB_STATE_COOKIE) ?? "";
  if (!provided || !saved || provided.length > 256 || !(await secretsEqual(provided, saved))) {
    return redirect(LOGIN_STATE, clears);
  }
  const settings = githubSettings(env);
  if (!settings) return redirect(LOGIN_EXCHANGE, clears);
  const intent = readIntent(readCookie(request.headers.get("cookie"), GITHUB_INTENT_COOKIE));
  if (!intent) return redirect(LOGIN_STATE, clears);
  const code = url.searchParams.get("code") ?? "";
  if (!code || code.length > 512) return redirect(LOGIN_EXCHANGE, clears);

  const identity = await fetchGithubIdentity({
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    code,
    redirectUri: callbackUrl(request),
  });
  if (!identity) return redirect(LOGIN_EXCHANGE, clears);
  if (intent === "bind") return finishBind(request, env, identity, clears);
  return finishLogin(request, env, identity, clears);
}

// Binding is only reachable from the signed-in settings page. The callback is
// a cross-site navigation, so the session is read without the cross-site
// refusal that guards ordinary API calls.
async function finishBind(
  request: Request,
  env: Env,
  identity: GithubIdentity,
  clears: string[],
): Promise<Response> {
  const user = await requireAdminUser(request, env, { crossSite: false });
  if (user instanceof Response) return redirect(SETTINGS_ERROR, clears);
  const binding = await getGithubBinding(env.DB, user.id);
  const existingId = binding?.github_id?.trim() ?? "";
  if (existingId && existingId !== identity.id.trim()) {
    // Replacing an existing id needs the unexpired password-verified window.
    const until = binding?.github_rebind_until ?? null;
    if (until === null || until < Date.now()) return redirect(SETTINGS_ERROR, clears);
    if (!(await consumeGithubRebind(env.DB, user.id, Date.now()))) {
      return redirect(SETTINGS_ERROR, clears);
    }
  }
  await setGithubBinding(env.DB, user.id, identity);
  await logOp(env.DB, {
    actor: user.username,
    module: "账号",
    action: "绑定",
    targetId: user.id,
    targetName: user.username,
    text: `绑定了 GitHub 账号 ${identity.login}`,
  });
  return redirect(SETTINGS_BOUND, clears);
}

// A successful OAuth callback already proves the second factor, so this path
// issues the session directly and never opens a TOTP ticket. It refreshes the
// display fields only — github_id is never written by a sign-in.
async function finishLogin(
  request: Request,
  env: Env,
  identity: GithubIdentity,
  clears: string[],
): Promise<Response> {
  const users = await listUserRecords(env.DB);
  if (users.length !== 1) return redirect(LOGIN_FORBIDDEN, clears);
  const user = users[0]!;
  const binding = await getGithubBinding(env.DB, user.id);
  if (!decideGithubAccess(identity, { boundId: binding?.github_id ?? null }).ok) {
    await logOp(env.DB, {
      actor: identity.login,
      module: "账号",
      action: "登录",
      targetId: null,
      targetName: identity.login,
      text: "GitHub 登录被拒绝：未绑定",
    });
    return redirect(LOGIN_FORBIDDEN, clears);
  }
  if (user.role !== "admin" || user.disabled_at != null) {
    return redirect(LOGIN_FORBIDDEN, clears);
  }

  await updateGithubDisplay(env.DB, user.id, identity.login, identity.avatarUrl);
  const totp = await findTotpUser(env.DB, user.id);
  const issued = await issueSession(request, env, {
    id: user.id,
    username: user.username,
    role: user.role,
    totp_enabled_at: totp?.totp_enabled_at ?? null,
  });
  const cookie = issued.headers.get("set-cookie");
  return redirect("/", cookie ? [...clears, cookie] : clears);
}

async function githubUnbind(request: Request, env: Env): Promise<Response> {
  const user = await requireAdminUser(request, env);
  if (user instanceof Response) return user;
  if (rejectsSensitiveWrite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  await clearGithubBinding(env.DB, user.id);
  await logOp(env.DB, {
    actor: user.username,
    module: "账号",
    action: "解绑",
    targetId: user.id,
    targetName: user.username,
    text: "解绑了 GitHub 账号",
  });
  return json({ ok: true });
}

// Replacing a bound id requires the current password. The OAuth callback is a
// cross-site GET and cannot carry a password, so this endpoint writes a
// short-lived one-time window that finishBind consumes.
async function githubRebind(request: Request, env: Env): Promise<Response> {
  const user = await requireAdminUser(request, env);
  if (user instanceof Response) return user;
  if (rejectsSensitiveWrite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  const password = readCurrentPassword(body.value);
  if (typeof password !== "string") return json({ ok: false, error: password.error }, 400);

  const now = Date.now();
  if (await accountPasswordLimited(env.DB, user.id, now)) {
    return json({ ok: false, error: "尝试过多，请稍后再试" }, 429, {
      "retry-after": String(loginRetryAfterSeconds(now)),
    });
  }
  const record = await findUserRecordById(env.DB, user.id);
  if (!record) return json({ ok: false, error: "未登录" }, 401);
  if (!(await verifyPassword(password, record.password_hash))) {
    await recordAccountPasswordFailure(env.DB, user.id, now);
    return json({ ok: false, error: "当前密码不正确" }, 401);
  }
  await clearAccountPasswordFailures(env.DB, user.id, now);
  await setGithubRebindUntil(env.DB, user.id, now + GITHUB_REBIND_TTL_MS);
  return json({ ok: true });
}

export async function fetchGithubIdentity(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<GithubIdentity | null> {
  try {
    const tokenResponse = await globalThis.fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "HiveMos",
      },
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
    });
    if (!isHttpOk(tokenResponse)) return null;
    const accessToken = readAccessToken(await readJson(tokenResponse));
    if (!accessToken) return null;

    const userResponse = await globalThis.fetch("https://api.github.com/user", {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "HiveMos",
      },
    });
    if (!isHttpOk(userResponse)) return null;
    return readIdentity(await readJson(userResponse));
  } catch {
    return null;
  }
}

function newOauthState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function githubOAuthCookie(
  name: string,
  value: string,
  secure: boolean,
  maxAge = GITHUB_COOKIE_TTL_SECONDS,
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    `Path=${GITHUB_COOKIE_PATH}`,
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function clearGithubOAuthCookies(secure: boolean): string[] {
  return [
    githubOAuthCookie(GITHUB_STATE_COOKIE, "", secure, 0),
    githubOAuthCookie(GITHUB_INTENT_COOKIE, "", secure, 0),
  ];
}

function readIntent(value: string | null): GithubIntent | null {
  if (value === "login" || value === "bind") return value;
  return null;
}

function callbackUrl(request: Request): string {
  return `${new URL(request.url).origin}/api/v1/auth/github/callback`;
}

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers();
  headers.set("location", location);
  headers.set("cache-control", "no-store");
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function methodNotAllowed(allow: string): Response {
  return json({ ok: false, error: "方法不允许" }, 405, { allow });
}

function readCurrentPassword(value: Record<string, unknown>): string | { error: string } {
  const raw = value.current_password;
  if (typeof raw !== "string" || raw.length === 0) return { error: "请填写当前密码" };
  if (raw.length > 256) return { error: "当前密码需要 1 到 256 个字符" };
  return raw;
}

async function readJsonObject(
  request: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const body = await readJsonLimited(request, JSON_BODY_BYTES);
  if (!body.ok) return { ok: false, response: json({ ok: false, error: body.error }, body.status) };
  const value = body.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, response: json({ ok: false, error: "请求体无效" }, 400) };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

function isHttpOk(response: Response): boolean {
  return response.status >= 200 && response.status < 300;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function readAccessToken(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const token = value.access_token;
  if (typeof token !== "string" || token.length < 8 || token.length > 2048 || /\s/.test(token)) return null;
  return token;
}

function readIdentity(value: unknown): GithubIdentity | null {
  if (!isRecord(value)) return null;
  const id = readGithubId(value.id);
  if (!id || typeof value.login !== "string") return null;
  const login = value.login.trim();
  if (login.length < 1 || login.length > 39 || /[\u0000-\u001f\s]/.test(login)) return null;
  let avatarUrl = "";
  if (
    typeof value.avatar_url === "string" &&
    value.avatar_url.length <= 2048 &&
    /^https:\/\/\S+$/.test(value.avatar_url)
  ) {
    avatarUrl = value.avatar_url;
  }
  const name = typeof value.name === "string" && value.name.length <= 128 ? value.name : null;
  return { id, login, avatarUrl, name };
}

function readGithubId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)) return value;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
