import {
  randomToken,
  requestIsSecure,
  secretsEqual,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sessionCookieHeader,
  sha256Hex,
} from "./auth";
import type { Env, ScheduledEvent, WaitCtx } from "./env";
import { isCrossSite, json, readCookie } from "./http";
import { handleMcp } from "./mcp";
import { handleRegistryRequest } from "./registry-http";
import { refreshActiveSnapshots } from "./registry";
import { createSession, deleteSession, readSession } from "./session";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_CREDENTIAL_CHARS = 1024;

// Paths login.html actually loads, plus the stylesheets imported by /style.css.
const PUBLIC_ASSETS = new Set([
  "/login.html",
  "/login",
  "/style.css",
  "/theme-boot.js",
  "/common.js",
  "/login.js",
  "/icons.svg",
  "/registry.js",
  "/shell.js",
]);

const UNCONFIGURED = "管理员账号尚未配置。请设置 Worker 机密 ADMIN_USERNAME 与 ADMIN_PASSWORD";
const BAD_CREDENTIALS = "用户名或密码不正确";
const MISSING_CREDENTIALS = "请填写账号和密码";

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

      const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
      const signedIn = await readSession(env.DB, token, Date.now());
      if (!signedIn) return deny(request, url, path);

      if (path === "/api/auth/logout") return logout(request, env);
      if (path === "/api/auth/me") return me(request, env);
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

function configuredAdmin(env: Env): { username: string; password: string } | null {
  const username = (env.ADMIN_USERNAME ?? "").trim();
  const password = env.ADMIN_PASSWORD ?? "";
  if (!username || password.length === 0) return null;
  return { username, password };
}

async function login(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  if (isCrossSite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const admin = configuredAdmin(env);
  if (!admin) return json({ ok: false, error: UNCONFIGURED }, 503);

  const body = await readJson(request);
  if (!body.ok) return body.response;
  const credentials = readCredentials(body.value);
  if (credentials === "invalid") return json({ ok: false, error: "请求格式不正确" }, 400);
  if (credentials === "missing") return json({ ok: false, error: MISSING_CREDENTIALS }, 400);

  const usernameOk = await secretsEqual(credentials.username.trim().toLowerCase(), admin.username.toLowerCase());
  const passwordOk = await secretsEqual(credentials.password, admin.password);
  if (!usernameOk || !passwordOk) return json({ ok: false, error: BAD_CREDENTIALS }, 401);

  try {
    const token = randomToken();
    const now = Date.now();
    await createSession(env.DB, await sha256Hex(token), now, now + SESSION_TTL_SECONDS * 1000);
    const headers = new Headers();
    headers.set("set-cookie", sessionCookieHeader(token, requestIsSecure(request), SESSION_TTL_SECONDS));
    return json({ ok: true }, 200, headers);
  } catch {
    return json({ ok: false, error: "暂时无法建立会话。请确认已经创建 D1 并应用迁移" }, 503);
  }
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

function me(request: Request, env: Env): Response {
  if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
  return json({ ok: true, username: (env.ADMIN_USERNAME ?? "").trim() });
}

function methodNotAllowed(allow: string): Response {
  return json({ ok: false, error: "方法不允许" }, 405, { allow });
}

async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0 || length > MAX_BODY_BYTES) {
      return { ok: false, response: json({ ok: false, error: "请求格式不正确" }, 400) };
    }
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: json({ ok: false, error: "请求格式不正确" }, 400) };
  }
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false, response: json({ ok: false, error: "请求格式不正确" }, 400) };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: json({ ok: false, error: "请求格式不正确" }, 400) };
  }
}

function readCredentials(
  value: unknown,
): { username: string; password: string } | "missing" | "invalid" {
  if (!value || typeof value !== "object") return "missing";
  const record = value as { username?: unknown; password?: unknown };
  if (typeof record.username !== "string" || typeof record.password !== "string") return "missing";
  if (record.username.length > MAX_CREDENTIAL_CHARS || record.password.length > MAX_CREDENTIAL_CHARS) return "invalid";
  if (record.username.trim().length === 0 || record.password.length === 0) return "missing";
  return { username: record.username, password: record.password };
}
