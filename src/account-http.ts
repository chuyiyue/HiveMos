// Account profile, password, and session routes. The gate already requires an admin.

import { hashPassword, requestIsSecure, sessionCookieHeader, verifyPassword } from "./auth";
import {
  accountPasswordLimited,
  clearAccountPasswordFailures,
  deleteOtherUserSessions,
  deleteUserSessionById,
  deleteUserSessions,
  deleteUserTotpTickets,
  findUserRecordById,
  getProfileUsername,
  getSidebarPinLimit,
  listUserSessions,
  loginRetryAfterSeconds,
  recordAccountPasswordFailure,
  setProfileUsername,
  setSidebarPinLimit,
  updatePasswordHash,
} from "./accounts";
import type { UserRecord } from "./accounts";
import type { Env } from "./env";
import { json, readJsonLimited, readLimitedBytes, rejectsSensitiveWrite } from "./http";
import { requireAdminUser } from "./session";

const JSON_BODY_BYTES = 8 * 1024;
const SESSION_ID_RE = /^[0-9a-f]{64}$/;

// The profile username doubles as the GitHub handle behind the sidebar
// avatar, so it must follow GitHub's username syntax. It is a display
// nickname only; it never takes part in login.
const GITHUB_USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

type PasswordCheck = "ok" | "bad" | "limited" | "missing";

export async function handleAccountRequest(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path === "/api/account/profile") return profile(request, env);
  if (path === "/api/account/preferences") return preferences(request, env);
  if (path === "/api/account/password") return password(request, env);
  if (path === "/api/account/sessions") return sessions(request, env);
  if (path === "/api/account/sessions/revoke-others") return revokeOtherSessions(request, env);
  const one = /^\/api\/account\/sessions\/([^/]+)$/.exec(path);
  if (one?.[1]) return revokeSession(request, env, one[1]);
  return null;
}

async function profile(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") return readProfile(request, env);
  if (method === "POST") return updateProfile(request, env);
  return methodNotAllowed("GET, POST");
}

async function preferences(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") return readPreferences(request, env);
  if (method === "PATCH") return updatePreferences(request, env);
  return methodNotAllowed("GET, PATCH");
}

async function readPreferences(request: Request, env: Env): Promise<Response> {
  const user = await requireAdminUser(request, env);
  if (user instanceof Response) return user;
  return json({ ok: true, preferences: { sidebar_pin_limit: await getSidebarPinLimit(env.DB) } });
}

async function updatePreferences(request: Request, env: Env): Promise<Response> {
  const user = await requireSensitiveUser(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  if (!body.value || typeof body.value !== "object") return json({ ok: false, error: "请求格式不正确" }, 400);
  const limit = await setSidebarPinLimit(env.DB, (body.value as { sidebar_pin_limit?: unknown }).sidebar_pin_limit);
  return json({ ok: true, preferences: { sidebar_pin_limit: limit } });
}

async function password(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  return changePassword(request, env);
}

async function sessions(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
  return listSessions(request, env);
}

async function readProfile(request: Request, env: Env): Promise<Response> {
  const user = await requireAdminUser(request, env);
  if (user instanceof Response) return user;
  const profileUsername = await getProfileUsername(env.DB);
  const record = await findUserRecordById(env.DB, user.id);
  return json({
    ok: true,
    username: user.username,
    profile_username: profileUsername,
    role: user.role === "admin" ? "admin" : "member",
    disabled: (record?.disabled_at ?? user.disabled_at) != null,
    created_at: record?.created_at ?? null,
  });
}

async function updateProfile(request: Request, env: Env): Promise<Response> {
  const user = await requireSensitiveUser(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = readProfileUsername(body.value);
  if ("error" in parsed) return json({ ok: false, error: parsed.error }, 400);
  await setProfileUsername(env.DB, parsed.username);
  return json({ ok: true, profile_username: parsed.username });
}

async function changePassword(request: Request, env: Env): Promise<Response> {
  const user = await requireSensitiveUser(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = readPasswordChange(body.value);
  if ("error" in parsed) return json({ ok: false, error: parsed.error }, 400);
  const check = await checkCurrentPassword(env, user.id, parsed.currentPassword);
  if (check.status !== "ok") return passwordCheckResponse(check.status);
  if (parsed.password === parsed.currentPassword) {
    return json({ ok: false, error: "新密码不能与当前密码相同" }, 400);
  }
  await updatePasswordHash(env.DB, user.id, await hashPassword(parsed.password));
  await deleteUserSessions(env.DB, user.id);
  await deleteUserTotpTickets(env.DB, user.id);
  const headers = new Headers();
  headers.set("set-cookie", sessionCookieHeader("", requestIsSecure(request), 0));
  return json({ ok: true }, 200, headers);
}

async function listSessions(request: Request, env: Env): Promise<Response> {
  const user = await requireAdminUser(request, env);
  if (user instanceof Response) return user;
  const rows = await listUserSessions(env.DB, user.id, Date.now());
  return json({
    ok: true,
    sessions: rows.map((row) => ({
      id: row.id,
      created_at: row.created_at,
      expires_at: row.expires_at,
      user_agent: row.user_agent,
      current: row.id === user.session_id,
    })),
  });
}

async function revokeOtherSessions(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const user = await requireSensitiveUser(request, env);
  if (user instanceof Response) return user;
  const bytes = await readLimitedBytes(request, JSON_BODY_BYTES);
  if (bytes === null) return json({ ok: false, error: "请求体过大" }, 413);
  await deleteOtherUserSessions(env.DB, user.id, user.session_id);
  return json({ ok: true });
}

async function revokeSession(request: Request, env: Env, rawId: string): Promise<Response> {
  if (request.method.toUpperCase() !== "DELETE") return methodNotAllowed("DELETE");
  const user = await requireSensitiveUser(request, env);
  if (user instanceof Response) return user;
  const id = decodePart(rawId)?.toLowerCase() ?? "";
  if (!SESSION_ID_RE.test(id)) return json({ ok: false, error: "会话编号无效" }, 400);
  const removed = await deleteUserSessionById(env.DB, user.id, id);
  if (!removed) return json({ ok: false, error: "会话不存在" }, 404);
  if (id !== user.session_id) return json({ ok: true });
  const headers = new Headers();
  headers.set("set-cookie", sessionCookieHeader("", requestIsSecure(request), 0));
  return json({ ok: true }, 200, headers);
}

async function requireSensitiveUser(request: Request, env: Env) {
  const user = await requireAdminUser(request, env);
  if (user instanceof Response) return user;
  if (rejectsSensitiveWrite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  return user;
}

async function checkCurrentPassword(
  env: Env,
  userId: string,
  password: string,
): Promise<{ status: "ok"; user: UserRecord } | { status: Exclude<PasswordCheck, "ok"> }> {
  const now = Date.now();
  if (await accountPasswordLimited(env.DB, userId, now)) return { status: "limited" };
  const record = await findUserRecordById(env.DB, userId);
  if (!record) return { status: "missing" };
  if (!(await verifyPassword(password, record.password_hash))) {
    await recordAccountPasswordFailure(env.DB, userId, now);
    return { status: "bad" };
  }
  await clearAccountPasswordFailures(env.DB, userId, now);
  return { status: "ok", user: record };
}

function passwordCheckResponse(status: Exclude<PasswordCheck, "ok">): Response {
  if (status === "limited") {
    return json({ ok: false, error: "尝试过多，请稍后再试" }, 429, {
      "retry-after": String(loginRetryAfterSeconds(Date.now())),
    });
  }
  if (status === "missing") return json({ ok: false, error: "未登录" }, 401);
  return json({ ok: false, error: "当前密码不正确" }, 401);
}

async function readJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const body = await readJsonLimited(request, JSON_BODY_BYTES);
  if (!body.ok) return { ok: false, response: json({ ok: false, error: body.error }, body.status) };
  return body;
}

function readCurrentPassword(record: Record<string, unknown>): string | { error: string } {
  const raw = typeof record.currentPassword === "string" ? record.currentPassword : record.current_password;
  if (typeof raw !== "string" || raw.length === 0) return { error: "请填写当前密码" };
  if (raw.length > 256) return { error: "当前密码需要 1 到 256 个字符" };
  return raw;
}

function readPasswordChange(value: unknown): { currentPassword: string; password: string } | { error: string } {
  if (!value || typeof value !== "object") return { error: "请求体无效" };
  const record = value as Record<string, unknown>;
  const currentPassword = readCurrentPassword(record);
  if (typeof currentPassword !== "string") return currentPassword;
  // The settings page sends newPassword. password stays accepted.
  const next = readNewPassword(record);
  if (typeof next !== "string") return next;
  return { currentPassword, password: next };
}

function readNewPassword(record: Record<string, unknown>): string | { error: string } {
  const raw = "newPassword" in record ? record.newPassword : record.password;
  if (typeof raw !== "string" || raw.length === 0) return { error: "请填写新密码" };
  if (raw.length < 8 || raw.length > 256) return { error: "新密码需要 8 到 256 个字符" };
  return raw;
}

function readProfileUsername(value: unknown): { username: string } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "请求体无效" };
  const raw = (value as Record<string, unknown>).username;
  if (typeof raw !== "string") return { error: "请填写用户名" };
  const username = raw.trim();
  if (username === "") return { username: "" };
  if (!GITHUB_USERNAME_RE.test(username)) {
    return { error: "用户名需为 1 到 39 位字母、数字或连字符，且不能以连字符开头或结尾" };
  }
  return { username };
}

function decodePart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function methodNotAllowed(allow: string): Response {
  return json({ ok: false, error: "方法不允许" }, 405, { allow });
}
