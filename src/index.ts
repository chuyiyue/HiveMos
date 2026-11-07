import {
  hashPassword,
  requestIsSecure,
  secretsEqual,
  SESSION_COOKIE,
  sessionCookieHeader,
  sha256Hex,
  verifyPassword,
} from "./auth";
import {
  clearLoginFailures,
  deleteSession,
  ensureAdmin,
  findTotpUser,
  getProfileUsername,
  insertUser,
  isUniqueViolation,
  listUserRecords,
  loginIsLimited,
  loginRateKey,
  loginRetryAfterSeconds,
  recordLoginFailure,
  updatePasswordHash,
} from "./accounts";
import type { UserRecord } from "./accounts";
import { handleAccountRequest } from "./account-http";
import type { Env, ScheduledEvent, WaitCtx } from "./env";
import { clientAddress, isCrossSite, json, readCookie, readJsonLimited } from "./http";
import { handleMcp } from "./mcp";
import { handleRegistryRequest } from "./registry-http";
import { refreshActiveSnapshots } from "./registry";
import { issueSession, publicUser, requireAdminUser } from "./session";

const LOGIN_BODY_BYTES = 8 * 1024;

// Paths login.html actually loads, plus the stylesheets imported by /style.css.
const PUBLIC_ASSETS = new Set([
  "/login.html",
  "/login",
  "/logo.jpg",
  "/style.css",
  "/theme-boot.js",
  "/common.js",
  "/login.js",
  "/icons.svg",
  "/registry.js",
  "/shell.js",
]);

const UNCONFIGURED = "管理员账号尚未配置。请设置 Worker 机密 ADMIN_USERNAME 与 ADMIN_PASSWORD";

export default {
  async fetch(request: Request, env: Env, ctx?: WaitCtx): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const wait = ctx ?? { waitUntil(promise: Promise<unknown>) { promise.catch(() => undefined); } };
    try {
      if (isPublicAsset(path)) return env.ASSETS.fetch(request);
      if (path === "/api/health") return json({ ok: true, service: "hivemos" });
      if (path === "/api/auth/login") return login(request, env);
      // Agents POST JSON-RPC here with their own bearer. GET stays on the session
      // gate so html_handling can still serve mcp.html at /mcp.
      if (path === "/mcp" && request.method.toUpperCase() === "POST") return handleMcp(request, env, wait);

      const admin = await requireAdminUser(request, env, { crossSite: wantsCrossSiteCheck(path) });
      if (admin instanceof Response) {
        // A cross-site refusal must keep its 403 text. deny() would also drop a cookie that is still valid.
        if (admin.status === 403) return admin;
        return deny(request, url, path);
      }

      if (path === "/api/auth/logout") return logout(request, env);
      if (path === "/api/auth/me") return me(request, env);
      const account = await handleAccountRequest(request, env, path);
      if (account) return account;
      const registry = await handleRegistryRequest(request, env, wait, path);
      if (registry) return registry;
      if (path === "/api" || path.startsWith("/api/")) return json({ ok: false, error: "未找到" }, 404);
      return env.ASSETS.fetch(request);
    } catch {
      return json({ ok: false, error: "服务器错误" }, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: WaitCtx): Promise<void> {
    try {
      await refreshActiveSnapshots(env, ctx);
    } catch {
      // The next cron retries. A failed sweep must not throw out of the handler.
    }
  },
};

function isPublicAsset(path: string): boolean {
  return PUBLIC_ASSETS.has(path) || path.startsWith("/css/");
}

function wantsCrossSiteCheck(path: string): boolean {
  return path === "/mcp" || path.startsWith("/mcp/") || path === "/api" || path.startsWith("/api/");
}

function isDocument(path: string): boolean {
  if (path === "/") return true;
  if (path.endsWith(".html")) return true;
  const leaf = path.slice(path.lastIndexOf("/") + 1);
  return leaf.length > 0 && !leaf.includes(".");
}

function loginLocation(url: URL): string {
  const next = url.pathname + url.search;
  if (next.length === 0 || next.length > 2048) return "/login";
  return "/login?next=" + encodeURIComponent(next);
}

function deny(request: Request, url: URL, path: string): Response {
  const headers = new Headers();
  if (readCookie(request.headers.get("cookie"), SESSION_COOKIE)) {
    headers.set("set-cookie", sessionCookieHeader("", requestIsSecure(request), 0));
  }
  if (path === "/mcp" || path.startsWith("/mcp/") || path === "/api" || path.startsWith("/api/")) {
    return json({ ok: false, error: "未登录" }, 401, headers);
  }
  if (isDocument(path)) {
    headers.set("location", loginLocation(url));
    headers.set("cache-control", "no-store");
    return new Response(null, { status: 302, headers });
  }
  return json({ ok: false, error: "未登录" }, 401, headers);
}

async function login(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  if (isCrossSite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const body = await readJsonLimited(request, LOGIN_BODY_BYTES);
  if (!body.ok) return json({ ok: false, error: body.error }, body.status);
  // The login page sends username and password. Password is required.
  // Username is checked only after a designated admin row exists.
  const password = readLoginPassword(body.value);
  if (password === null) return json({ ok: false, error: "请填写密码" }, 400);

  const now = Date.now();
  // The account key is stable even before the user row is resolved, so failed
  // passwords cannot reset the window by omitting or changing a username.
  const userKey = await loginRateKey("user", "admin");
  const ip = clientAddress(request);
  const ipKey = ip ? await loginRateKey("ip", ip) : null;
  if (await loginIsLimited(env.DB, userKey, ipKey, now)) return loginLimited(now);

  const users = await listUserRecords(env.DB);
  const adminPassword = env.ADMIN_PASSWORD ?? "";
  const hasEnvPassword = adminPassword.length > 0;
  if (users.length === 0) {
    if (!hasEnvPassword) return json({ ok: false, error: UNCONFIGURED }, 503);
    const envPasswordOk = await secretsEqual(password, adminPassword);
    if (!envPasswordOk) {
      await recordLoginFailure(env.DB, userKey, now);
      if (ipKey) await recordLoginFailure(env.DB, ipKey, now);
      return json({ ok: false, error: "密码错误" }, 401);
    }
    const created = await bootstrapAdmin(env, password);
    if (!created) return json({ ok: false, error: "无法创建管理员，请重试" }, 500);
    await finishLogin(env, created, { userKey, ipKey, now });
    return issueSessionFor(request, env, created);
  }

  // Only one row is the administrator. ADMIN_USERNAME selects that row while
  // more than one users row still exists.
  const designated = pickDesignatedUser(users, env.ADMIN_USERNAME?.trim() ?? "");
  if (!designated) {
    return json(
      {
        ok: false,
        error: "存在多个账号，无法确定管理员。请先只保留一个 users 行，或用 ADMIN_USERNAME 指向现有管理员。",
      },
      409,
    );
  }

  const submittedName = readSubmittedUsername(body.value);
  if (submittedName !== null && !usernamesEqual(submittedName, designated.username)) {
    await recordLoginFailure(env.DB, userKey, now);
    if (ipKey) await recordLoginFailure(env.DB, ipKey, now);
    return json({ ok: false, error: "密码错误" }, 401);
  }

  const rowPasswordOk = await verifyPassword(password, designated.password_hash);
  const envPasswordOk = hasEnvPassword && (await secretsEqual(password, adminPassword));
  if (!rowPasswordOk && !envPasswordOk) {
    await recordLoginFailure(env.DB, userKey, now);
    if (ipKey) await recordLoginFailure(env.DB, ipKey, now);
    // A password that belongs to another row gets a clear refusal
    // instead of looking like a typo. Other rows never become a login path.
    const other = await findMatchingUser(users, password, designated.id);
    if (!other) return json({ ok: false, error: "密码错误" }, 401);
    return json(
      { ok: false, error: other.disabled_at != null ? "账号已停用" : "仅管理员可以登录" },
      401,
    );
  }

  let user = designated;
  if (envPasswordOk) {
    // ADMIN_PASSWORD stays a recovery path: a successful env-password login
    // writes that password back into the row so later UI changes win, and can
    // revive the surviving row if it was disabled or demoted.
    if (!rowPasswordOk) {
      const hash = await hashPassword(password);
      await updatePasswordHash(env.DB, user.id, hash);
      user = { ...user, password_hash: hash };
    }
    if (user.role !== "admin" || user.disabled_at != null) {
      await ensureAdmin(env.DB, user.id);
      user = { ...user, role: "admin", disabled_at: null };
    }
  } else if (user.disabled_at != null) {
    return json({ ok: false, error: "账号已停用" }, 401);
  } else if (user.role !== "admin") {
    return json({ ok: false, error: "仅管理员可以登录" }, 401);
  }

  await clearLoginFailures(env.DB, userKey, now);
  if (ipKey) await clearLoginFailures(env.DB, ipKey, now);

  await finishLogin(env, user, { userKey, ipKey, now });
  return issueSessionFor(request, env, user);
}

async function findMatchingUser(
  users: UserRecord[],
  password: string,
  designatedId: string,
): Promise<UserRecord | null> {
  for (const candidate of users) {
    if (candidate.id === designatedId) continue;
    if (await verifyPassword(password, candidate.password_hash)) return candidate;
  }
  return null;
}

function pickDesignatedUser(users: UserRecord[], adminUsername: string): UserRecord | null {
  if (adminUsername) {
    const named = users.find((candidate) => candidate.username === adminUsername);
    if (named) return named;
  }
  if (users.length === 1) return users[0]!;
  const admins = users.filter((candidate) => candidate.role === "admin" && candidate.disabled_at == null);
  return admins.length === 1 ? admins[0]! : null;
}

async function bootstrapAdmin(env: Env, password: string): Promise<UserRecord | null> {
  const username = env.ADMIN_USERNAME?.trim() || "admin";
  const createdAt = Date.now();
  const user: UserRecord = {
    id: crypto.randomUUID(),
    username,
    password_hash: await hashPassword(password),
    role: "admin",
    disabled_at: null,
    created_at: createdAt,
  };
  try {
    await insertUser(env.DB, {
      id: user.id,
      username: user.username,
      passwordHash: user.password_hash,
      role: "admin",
      createdAt,
    });
    return user;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const again = await listUserRecords(env.DB);
    return pickDesignatedUser(again, username) ?? again[0] ?? null;
  }
}

async function finishLogin(
  env: Env,
  _user: UserRecord,
  budget: { userKey: string; ipKey: string | null; now: number },
): Promise<void> {
  await clearLoginFailures(env.DB, budget.userKey, budget.now);
  if (budget.ipKey) await clearLoginFailures(env.DB, budget.ipKey, budget.now);
  // 本仓没有设备表和渠道表，不合并、不删除其它 users 行。
}

// Session issuance stays in one place so the bootstrap path and the normal
// path cannot drift apart (including the TOTP challenge).
async function issueSessionFor(request: Request, env: Env, user: UserRecord): Promise<Response> {
  const totp = await findTotpUser(env.DB, user.id);
  // 下一步在 totp_enabled_at 与 totp_secret 都有值时改为 startTotpChallenge。
  return issueSession(request, env, { ...user, totp_enabled_at: totp?.totp_enabled_at ?? null });
}

async function logout(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  if (isCrossSite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (token) await deleteSession(env.DB, await sha256Hex(token));
  const headers = new Headers();
  headers.set("set-cookie", sessionCookieHeader("", requestIsSecure(request), 0));
  return json({ ok: true }, 200, headers);
}

async function me(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
  const user = await requireAdminUser(request, env);
  if (user instanceof Response) return user;
  const profileUsername = await getProfileUsername(env.DB);
  const username = profileUsername !== "" ? profileUsername : user.username;
  return json({
    ok: true,
    user: publicUser(user),
    username,
    profile_username: profileUsername,
  });
}

function methodNotAllowed(allow: string): Response {
  return json({ ok: false, error: "方法不允许" }, 405, { allow });
}

function loginLimited(now: number): Response {
  return json({ ok: false, error: "登录尝试过多，请稍后再试" }, 429, {
    "retry-after": String(loginRetryAfterSeconds(now)),
  });
}

function readLoginPassword(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const password = (value as Record<string, unknown>).password;
  if (typeof password !== "string") return null;
  if (password.length === 0 || password.length > 256) return null;
  return password;
}

function readSubmittedUsername(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!Object.prototype.hasOwnProperty.call(value, "username")) return null;
  const username = (value as Record<string, unknown>).username;
  if (typeof username !== "string") return null;
  return username;
}

function usernamesEqual(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
