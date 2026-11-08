import {
  hashPassword,
  PBKDF2_ITERATIONS,
  requestIsSecure,
  SESSION_COOKIE,
  sessionCookieHeader,
  sha256Hex,
  storedHashIterations,
  verifyPassword,
} from "./auth";
import {
  clearLoginFailures,
  deleteSession,
  findTotpUser,
  getProfileUsername,
  listUserRecords,
  loginIsLimited,
  loginRateKey,
  loginRetryAfterSeconds,
  recordLoginFailure,
  updatePasswordHash,
} from "./accounts";
import type { UserRecord } from "./accounts";
import { handleAccountRequest } from "./account-http";
import { handleTotpAccount, startTotpChallenge, verifyTotpLogin } from "./totp-http";
import type { Env, ScheduledEvent, WaitCtx } from "./env";
import { clientAddress, isCrossSite, json, readCookie, readJsonLimited } from "./http";
import { handleMcp } from "./mcp";
import { handleRegistryRequest } from "./registry-http";
import { handleCalendarFeed, handleCalendarRequest } from "./calendar-http";
import { handleMemoryRequest } from "./memory-http";
import { handleSoulRequest } from "./soul-http";
import { handleTasksRequest } from "./tasks-http";
import { handleMachinesRequest } from "./machines-http";
import { handleNodesRequest } from "./nodes-http";
import { runKeepaliveSweep, syncAllConnections } from "./providers";
import { vaultKeyOf } from "./machines";
import { handleOverviewRequest } from "./overview-http";
import { handleRecordsRequest } from "./records-http";
import { handleOplogRequest } from "./oplog-http";
import { handleSystemRequest, recordCronRun } from "./system-http";
import { handleSettingsRequest } from "./settings-http";
import { handleBackupRequest } from "./backup-http";
import { cronSweepDue } from "./settings";
import { handleVaultRequest } from "./vault-http";
import { handleExtrasRequest } from "./extras-http";
import { syncDueMirrors } from "./calendar";
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

const UNCONFIGURED = "管理员尚未同步，请先完成部署";

export default {
  async fetch(request: Request, env: Env, ctx?: WaitCtx): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const wait = ctx ?? { waitUntil(promise: Promise<unknown>) { promise.catch(() => undefined); } };
    try {
      if (isPublicAsset(path)) return env.ASSETS.fetch(request);
      if (path === "/api/health") return json({ ok: true, service: "hivemos" });
      if (path === "/api/auth/login") return login(request, env);
      // The ticket is the credential. This must stay ahead of the session gate,
      // same as login, or a signed-out operator can never finish the challenge.
      if (path === "/api/auth/totp/verify") {
        if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
        return verifyTotpLogin(request, env);
      }
      // Agents POST JSON-RPC here with their own bearer. GET stays on the session
      // gate so html_handling can still serve mcp.html at /mcp.
      if (path === "/mcp" && request.method.toUpperCase() === "POST") return handleMcp(request, env, wait);

      // ICS subscription feed: the token in the URL is the credential, so
      // this stays ahead of the session gate like login and the TOTP ticket.
      const feed = /^\/cal\/([A-Za-z0-9_-]+)\.ics$/.exec(path);
      if (feed && feed[1]) return handleCalendarFeed(request, env, feed[1]);

      const admin = await requireAdminUser(request, env, { crossSite: wantsCrossSiteCheck(path) });
      if (admin instanceof Response) {
        // A cross-site refusal must keep its 403 text. deny() would also drop a cookie that is still valid.
        if (admin.status === 403) return admin;
        return deny(request, url, path);
      }

      if (path === "/api/auth/logout") return logout(request, env);
      if (path === "/api/auth/me") return me(request, env);
      const totpAccount = await handleTotpAccount(request, env, path);
      if (totpAccount) return totpAccount;
      const account = await handleAccountRequest(request, env, path);
      if (account) return account;
      const registry = await handleRegistryRequest(request, env, wait, path);
      if (registry) return registry;
      const calendar = await handleCalendarRequest(request, env, wait, path);
      if (calendar) return calendar;
      const memory = await handleMemoryRequest(request, env, wait, path);
      if (memory) return memory;
      const soul = await handleSoulRequest(request, env, wait, path);
      if (soul) return soul;
      const tasks = await handleTasksRequest(request, env, wait, path);
      if (tasks) return tasks;
      const machines = await handleMachinesRequest(request, env, wait, path);
      if (machines) return machines;
      const nodes = await handleNodesRequest(request, env, wait, path);
      if (nodes) return nodes;
      const overview = await handleOverviewRequest(request, env, wait, path);
      if (overview) return overview;
      const records = await handleRecordsRequest(request, env, wait, path);
      if (records) return records;
      const oplog = await handleOplogRequest(request, env, wait, path);
      if (oplog) return oplog;
      const system = await handleSystemRequest(request, env, wait, path);
      if (system) return system;
      // Feature settings (定时任务频率 / 侧边栏自动展示上限) live behind the
      // same admin gate.
      const settings = await handleSettingsRequest(request, env, path);
      if (settings) return settings;
      // 同步与备份：目标配置、活体测试与手动备份。
      const backup = await handleBackupRequest(request, env, path);
      if (backup) return backup;
      const vault = await handleVaultRequest(request, env, wait, path);
      if (vault) return vault;
      const extras = await handleExtrasRequest(request, env, wait, path);
      if (extras) return extras;
      if (path === "/api" || path.startsWith("/api/")) return json({ ok: false, error: "未找到" }, 404);
      return env.ASSETS.fetch(request);
    } catch {
      return json({ ok: false, error: "服务器错误" }, 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: WaitCtx): Promise<void> {
    const now = event.scheduledTime || Date.now();
    // The trigger is hourly (wrangler.jsonc), the sweep runs at the interval
    // chosen in 功能设置. Between due runs this handler returns without
    // touching anything: no snapshot refresh, no mirror sync, no probe, and
    // no stamp — the stamp only moves when a sweep actually ran.
    try {
      if (!(await cronSweepDue(env.DB, now))) return;
    } catch {
      // Unreadable state means "run": a broken settings row must never stop
      // the sweep. The sweep still stamps the run below.
    }
    try {
      await refreshActiveSnapshots(env, ctx);
    } catch {
      // The next cron retries. A failed sweep must not throw out of the handler.
    }
    try {
      await syncDueMirrors(env.DB, Date.now());
    } catch {
      // Mirror sources retry on the next sweep; failures keep the old data.
    }
    try {
      await syncAllConnections(env.DB, vaultKeyOf(env), Date.now());
      await runKeepaliveSweep(env.DB, vaultKeyOf(env), Date.now());
    } catch {
      // Connection sync and keepalive retry on the next sweep.
    }
    try {
      // Evidence stamp for the settings page: cron status there is read
      // from this marker, never from the declared trigger config. It is also
      // the interval gate's clock, so it is written only after a real sweep.
      await recordCronRun(env.DB, now);
    } catch {
      // The stamp is best-effort; a failed write must not fail the sweep.
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
  // Admin-init design: the administrator row is aligned from the repo
  // secrets at deploy time by scripts/sync-admin.mjs. Login reads the
  // database only — no environment bootstrap, no env-password recovery
  // path, nothing here writes the row.
  const users = await listUserRecords(env.DB);
  if (users.length === 0) return json({ ok: false, error: UNCONFIGURED }, 503);
  const password = readLoginPassword(body.value);
  if (password === null) return json({ ok: false, error: "请填写密码" }, 400);
  if (users.length > 1) {
    return json({ ok: false, error: "存在多个管理员账号，无法确定管理员" }, 409);
  }
  const user = users[0]!;

  const now = Date.now();
  const submittedName = readSubmittedUsername(body.value);
  const ip = clientAddress(request);
  // Failures are limited per username+IP pair (8 per 15 minutes).
  const pairKey = await loginRateKey("user", `${(submittedName ?? "").toLowerCase()}|${ip ?? ""}`);
  if (await loginIsLimited(env.DB, pairKey, null, now)) return loginLimited(now);

  // Timing-constant: the password verification always runs against the
  // row hash first; username match and password correctness combine
  // afterwards, and both failures answer the same 401.
  const passwordOk = await verifyPassword(password, user.password_hash);
  const nameOk = submittedName !== null && usernamesEqual(submittedName, user.username);
  if (!passwordOk || !nameOk) {
    await recordLoginFailure(env.DB, pairKey, now);
    return json({ ok: false, error: "密码错误" }, 401);
  }
  if (user.disabled_at != null) return json({ ok: false, error: "账号已停用" }, 401);
  if (user.role !== "admin") return json({ ok: false, error: "仅管理员可以登录" }, 401);

  // Opportunistic upgrade: rehash at the current iteration count when
  // the stored hash predates it. A failed write never blocks login.
  if (storedHashIterations(user.password_hash) < PBKDF2_ITERATIONS) {
    try {
      await updatePasswordHash(env.DB, user.id, await hashPassword(password));
    } catch {
      // Retried on the next successful login.
    }
  }

  await finishLogin(env, user, { userKey: pairKey, ipKey: null, now });
  return issueSessionFor(request, env, user);
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
  if (totp?.totp_enabled_at != null && totp.totp_secret != null) {
    return startTotpChallenge(env, user);
  }
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
