import {
  randomToken,
  requestIsSecure,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sessionCookieHeader,
  sha256Hex,
} from "./auth";
import { createSession, deleteSession, findSessionUser } from "./accounts";
import type { Env } from "./env";
import { isCrossSite, json, readCookie } from "./http";
import type { SessionUser } from "./accounts";

export type ActiveUser = SessionUser & { session_id: string };

export function publicUser(user: {
  id: string;
  username: string;
  role?: string;
  totp_enabled_at?: number | null;
}) {
  const body: {
    id: string;
    username: string;
    role: "admin" | "member";
    totp_enabled?: boolean;
  } = {
    id: user.id,
    username: user.username,
    role: user.role === "admin" ? "admin" : "member",
  };
  // Callers that did not load the column leave the flag off the payload
  // instead of claiming 2FA is disabled.
  if ("totp_enabled_at" in user) body.totp_enabled = user.totp_enabled_at != null;
  return body;
}

function sessionUserAgent(request: Request): string | null {
  const value = request.headers.get("user-agent");
  if (!value) return null;
  return value.slice(0, 256);
}

export async function issueSession(
  request: Request,
  env: Env,
  user: { id: string; username: string; role?: string; totp_enabled_at?: number | null },
): Promise<Response> {
  const token = randomToken();
  const now = Date.now();
  await createSession(env.DB, {
    id: await sha256Hex(token),
    userId: user.id,
    userAgent: sessionUserAgent(request),
    expiresAt: now + SESSION_TTL_SECONDS * 1000,
    createdAt: now,
  });
  const headers = new Headers();
  headers.set("set-cookie", sessionCookieHeader(token, requestIsSecure(request), SESSION_TTL_SECONDS));
  return json({ ok: true, user: publicUser(user) }, 200, headers);
}

// crossSite defaults to true. Document navigations pass false so a top-level
// visit still reaches the page instead of a JSON refusal, and deny() is not
// asked to expire a cookie that is still valid.
export async function requireAdminUser(
  request: Request,
  env: Env,
  options?: { crossSite?: boolean },
): Promise<ActiveUser | Response> {
  if (options?.crossSite !== false && isCrossSite(request)) {
    return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  }
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!token) return json({ ok: false, error: "未登录" }, 401);
  const sessionHash = await sha256Hex(token);
  const user = await findSessionUser(env.DB, sessionHash);
  if (!user || user.expires_at <= Date.now() || user.disabled_at != null || user.role !== "admin") {
    if (user) await deleteSession(env.DB, sessionHash);
    return json({ ok: false, error: "未登录" }, 401);
  }
  return { ...user, session_id: sessionHash };
}
