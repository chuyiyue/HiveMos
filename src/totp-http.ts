// TOTP setup and login challenge. Ported from SMSinBox src/routes/totp.ts.
// Paths live under /api/account/totp and /api/auth/totp/verify. No log module.

import { bytesToBase64Url, SESSION_COOKIE, sha256Hex, verifyPassword } from "./auth";
import {
  accountPasswordLimited,
  advanceTotpCounter,
  clearAccountPasswordFailures,
  clearRateLimitWindow,
  clearTotp,
  consumeRateLimit,
  consumeRateLimitWindow,
  consumeRecoveryCode,
  countRecoveryCodes,
  createTotpTicket,
  deleteTotpTicket,
  deleteUserSessionsExcept,
  deleteUserTotpTickets,
  enableTotp,
  findTotpTicket,
  findTotpUser,
  loginRetryAfterSeconds,
  rateLimitRetryAfterSeconds,
  readRateLimitWindow,
  recordAccountPasswordFailure,
  recordTotpAttempt,
  replaceRecoveryCodes,
  setTotpPending,
} from "./accounts";
import { resolveContentKey } from "./crypto";
import type { Env } from "./env";
import { isCrossSite, json, readCookie, readJsonLimited } from "./http";
import { issueSession, requireAdminUser } from "./session";
import { logOp } from "./oplog";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  matchTotp,
  normalizeRecoveryCode,
  openTotpSecret,
  sealTotpSecret,
  totpUri,
  TOTP_DIGITS,
  TOTP_FAILURE_LIMIT,
  TOTP_FAILURE_WINDOW_MS,
  TOTP_ISSUER,
  TOTP_PENDING_TTL_MS,
  TOTP_PERIOD_SECONDS,
  TOTP_RATE_LIMIT_PER_MINUTE,
  TOTP_TICKET_MAX_ATTEMPTS,
  TOTP_TICKET_TTL_SECONDS,
} from "./totp";

// TOTP JSON bodies use the existing readJsonLimited helper, capped at 16KB.
const JSON_BODY_BYTES = 16 * 1024;

type SecondFactorUser = {
  id: string;
  totp_secret: string | null;
  totp_last_counter: number | null;
};

type SecondFactorResult =
  | { ok: true; method: "totp" | "recovery"; counter?: number }
  | { ok: false; error: string };

export async function handleTotpAccount(request: Request, env: Env, path: string): Promise<Response | null> {
  const method = request.method.toUpperCase();
  if (path === "/api/account/totp") {
    if (method !== "GET") return methodNotAllowed("GET");
    return totpStatus(request, env);
  }
  if (path === "/api/account/totp/setup") {
    if (method !== "POST") return methodNotAllowed("POST");
    return beginTotpSetup(request, env);
  }
  if (path === "/api/account/totp/enable") {
    if (method !== "POST") return methodNotAllowed("POST");
    return enableTotpHandler(request, env);
  }
  if (path === "/api/account/totp/disable") {
    if (method !== "POST") return methodNotAllowed("POST");
    return disableTotp(request, env);
  }
  if (path === "/api/account/totp/recovery") {
    if (method !== "POST") return methodNotAllowed("POST");
    return regenerateRecoveryCodes(request, env);
  }
  return null;
}

// GET /api/account/totp
export async function totpStatus(request: Request, env: Env): Promise<Response> {
  const user = await requireAdminUser(request, env);
  if (user instanceof Response) return user;
  const record = await findTotpUser(env.DB, user.id);
  if (!record) return json({ ok: false, error: "账号不存在" }, 404);
  const now = Date.now();
  const pendingExpiresAt =
    record.totp_pending_secret !== null && record.totp_pending_created_at !== null
      ? record.totp_pending_created_at + TOTP_PENDING_TTL_MS
      : null;
  const pending = pendingExpiresAt !== null && pendingExpiresAt > now;
  const enabled = record.totp_enabled_at !== null && record.totp_secret !== null;
  return json({
    ok: true,
    enabled,
    enabled_at: enabled ? record.totp_enabled_at : null,
    pending,
    pending_expires_at: pending ? pendingExpiresAt : null,
    recovery_codes_remaining: enabled ? await countRecoveryCodes(env.DB, user.id) : 0,
  });
}

// POST /api/account/totp/setup -> create (or rotate) the pending secret.
export async function beginTotpSetup(request: Request, env: Env): Promise<Response> {
  const user = await requireAdminUser(request, env);
  if (user instanceof Response) return user;
  const record = await findTotpUser(env.DB, user.id);
  if (!record) return json({ ok: false, error: "账号不存在" }, 404);
  if (record.totp_enabled_at !== null) return json({ ok: false, error: "两步验证已启用" }, 409);

  const attempts = await consumeRateLimit(env.DB, `totp-setup:${user.id}`, Date.now());
  if (attempts > TOTP_RATE_LIMIT_PER_MINUTE * 2) {
    return json({ ok: false, error: "操作过于频繁，请稍后再试" }, 429);
  }

  const secret = generateTotpSecret();
  const sealed = await sealTotpSecret(resolveContentKey(env.CONTENT_KEY), secret);
  if (!sealed) return json({ ok: false, error: "内容加密密钥无效" }, 500);
  const now = Date.now();
  await setTotpPending(env.DB, user.id, sealed, now);
  return json({
    ok: true,
    secret,
    otpauth_uri: totpUri(secret, record.username),
    issuer: TOTP_ISSUER,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    algorithm: "SHA1",
    pending_expires_at: now + TOTP_PENDING_TTL_MS,
  });
}

// POST /api/account/totp/enable { code }: verify the pending secret, then
// return one-time recovery codes.
export async function enableTotpHandler(request: Request, env: Env): Promise<Response> {
  const user = await requireAdminUser(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const code = readCode(body.value.code);
  if (!code) return json({ ok: false, error: "请输入验证器上的 6 位验证码" }, 400);

  const record = await findTotpUser(env.DB, user.id);
  if (!record) return json({ ok: false, error: "账号不存在" }, 404);
  if (record.totp_enabled_at !== null) return json({ ok: false, error: "两步验证已启用" }, 409);
  if (
    record.totp_pending_secret === null ||
    record.totp_pending_created_at === null ||
    record.totp_pending_created_at + TOTP_PENDING_TTL_MS <= Date.now()
  ) {
    return json({ ok: false, error: "绑定已过期，请重新开始绑定" }, 409);
  }

  const attempts = await consumeRateLimit(env.DB, `totp-enroll:${user.id}`, Date.now());
  if (attempts > TOTP_RATE_LIMIT_PER_MINUTE * 2) {
    return json({ ok: false, error: "验证码尝试过多，请稍后再试" }, 429);
  }

  const secret = await openTotpSecret(resolveContentKey(env.CONTENT_KEY), record.totp_pending_secret);
  if (!secret) return json({ ok: false, error: "无法读取待确认的密钥，请重新开始绑定" }, 409);
  const counter = await matchTotp({ secret, code, nowMs: Date.now() });
  if (counter === null) return json({ ok: false, error: "验证码不正确" }, 400);

  const now = Date.now();
  const enabled = await enableTotp(env.DB, user.id, now);
  if (!enabled) return json({ ok: false, error: "绑定状态已变化，请重新开始绑定" }, 409);
  const codes = generateRecoveryCodes();
  await replaceRecoveryCodes(env.DB, user.id, await Promise.all(codes.map((code) => hashRecoveryCode(code))), now);
  await logOp(env.DB, {
    actor: user.username,
    module: "账号",
    action: "修改",
    targetId: user.id,
    targetName: user.username,
    text: "开启了两步验证",
  });
  return json({
    ok: true,
    enabled: true,
    enabled_at: now,
    recovery_codes: codes,
    recovery_codes_remaining: codes.length,
  });
}

// POST /api/account/totp/disable { password, code }
export async function disableTotp(request: Request, env: Env): Promise<Response> {
  const user = await requireAdminUser(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const password = readPassword(body.value.password);
  const code = readCode(body.value.code);
  if (!password) return json({ ok: false, error: "请填写当前密码" }, 400);
  if (!code) return json({ ok: false, error: "请输入验证码或恢复码" }, 400);

  const record = await findTotpUser(env.DB, user.id);
  if (!record) return json({ ok: false, error: "账号不存在" }, 404);
  if (record.totp_enabled_at === null || record.totp_secret === null) {
    return json({ ok: false, error: "两步验证未启用" }, 409);
  }
  const now = Date.now();
  // The password step shares the current-password window with rename and
  // password change, so a stolen session cannot shop for a weaker endpoint.
  if (await accountPasswordLimited(env.DB, user.id, now)) return passwordLimited(now);
  if (!(await verifyPassword(password, record.password_hash))) {
    await recordAccountPasswordFailure(env.DB, user.id, now);
    return json({ ok: false, error: "密码不正确" }, 401);
  }
  await clearAccountPasswordFailures(env.DB, user.id, now);
  if (await secondFactorLocked(env, user.id, now)) return secondFactorLimited(now, "验证码尝试过多，请稍后再试");
  const verdict = await verifySecondFactor(env, record, code, now);
  if (!verdict.ok) {
    const failures = await recordSecondFactorFailure(env, user.id, now);
    if (failures >= TOTP_FAILURE_LIMIT) return secondFactorLimited(now, "验证码尝试过多，请稍后再试");
    return json({ ok: false, error: verdict.error }, 401);
  }
  await clearSecondFactorFailures(env, user.id, now);

  await clearTotp(env.DB, user.id);
  await logOp(env.DB, {
    actor: user.username,
    module: "账号",
    action: "修改",
    targetId: user.id,
    targetName: user.username,
    text: "关闭了两步验证",
  });
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (token) await deleteUserSessionsExcept(env.DB, user.id, await sha256Hex(token));
  return json({ ok: true, enabled: false });
}

// POST /api/account/totp/recovery { password, code }: replaces every recovery
// code. The old list stops working immediately.
export async function regenerateRecoveryCodes(request: Request, env: Env): Promise<Response> {
  const user = await requireAdminUser(request, env);
  if (user instanceof Response) return user;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const password = readPassword(body.value.password);
  const code = readCode(body.value.code);
  if (!password) return json({ ok: false, error: "请填写当前密码" }, 400);
  if (!code) return json({ ok: false, error: "请输入验证码或恢复码" }, 400);

  const record = await findTotpUser(env.DB, user.id);
  if (!record) return json({ ok: false, error: "账号不存在" }, 404);
  if (record.totp_enabled_at === null || record.totp_secret === null) {
    return json({ ok: false, error: "两步验证未启用" }, 409);
  }
  const now = Date.now();
  if (await accountPasswordLimited(env.DB, user.id, now)) return passwordLimited(now);
  if (!(await verifyPassword(password, record.password_hash))) {
    await recordAccountPasswordFailure(env.DB, user.id, now);
    return json({ ok: false, error: "密码不正确" }, 401);
  }
  await clearAccountPasswordFailures(env.DB, user.id, now);
  if (await secondFactorLocked(env, user.id, now)) return secondFactorLimited(now, "验证码尝试过多，请稍后再试");
  const verdict = await verifySecondFactor(env, record, code, now);
  if (!verdict.ok) {
    const failures = await recordSecondFactorFailure(env, user.id, now);
    if (failures >= TOTP_FAILURE_LIMIT) return secondFactorLimited(now, "验证码尝试过多，请稍后再试");
    return json({ ok: false, error: verdict.error }, 401);
  }
  await clearSecondFactorFailures(env, user.id, now);

  const codes = generateRecoveryCodes();
  await replaceRecoveryCodes(env.DB, user.id, await Promise.all(codes.map((code) => hashRecoveryCode(code))), now);
  await logOp(env.DB, {
    actor: user.username,
    module: "账号",
    action: "修改",
    targetId: user.id,
    targetName: user.username,
    text: "重新生成了两步验证恢复码",
  });
  return json({ ok: true, recovery_codes: codes, recovery_codes_remaining: codes.length });
}

// POST /api/auth/login answers with { totp_required, ticket }; the password
// is already verified at this point. Only this endpoint turns the ticket into
// a session cookie.
export async function startTotpChallenge(env: Env, user: { id: string; username: string }): Promise<Response> {
  const now = Date.now();
  // A new ticket must not reset the account failure budget. Refuse before
  // issuing one, so the password step cannot buy another guess.
  if (await secondFactorLocked(env, user.id, now)) {
    await deleteUserTotpTickets(env.DB, user.id);
    return secondFactorLimited(now, "验证码尝试过多，请稍后再试");
  }
  const ticket = `tot_${bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
  // One live challenge per account; an older tab must restart at the password step.
  await deleteUserTotpTickets(env.DB, user.id);
  await createTotpTicket(env.DB, {
    id: await sha256Hex(ticket),
    userId: user.id,
    expiresAt: now + TOTP_TICKET_TTL_SECONDS * 1000,
    createdAt: now,
  });
  return json(
    {
      ok: true,
      totp_required: true,
      ticket,
      expires_in: TOTP_TICKET_TTL_SECONDS,
    },
    200,
  );
}

// POST /api/auth/totp/verify { ticket, code }
// Dispatched before the session gate. The ticket is the credential.
export async function verifyTotpLogin(request: Request, env: Env): Promise<Response> {
  if (isCrossSite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const ticket = readTicket(body.value.ticket);
  const code = readCode(body.value.code);
  if (!ticket) return json({ ok: false, error: "登录已过期，请重新登录" }, 401);
  if (!code) return json({ ok: false, error: "请输入验证码或恢复码" }, 400);

  const now = Date.now();
  const ticketHash = await sha256Hex(ticket);
  const record = await findTotpTicket(env.DB, ticketHash);
  if (
    !record ||
    record.expires_at <= now ||
    record.disabled_at !== null ||
    record.role !== "admin" ||
    record.totp_enabled_at === null ||
    record.totp_secret === null
  ) {
    if (record) await deleteTotpTicket(env.DB, ticketHash);
    return json({ ok: false, error: "登录已过期，请重新登录" }, 401);
  }

  // Check the account window before the code. A ticket saved from an earlier
  // login must not be tested once the budget is already spent.
  if (await secondFactorLocked(env, record.user_id, now)) {
    await deleteTotpTicket(env.DB, ticketHash);
    return secondFactorLimited(now, "验证码尝试过多，请重新登录");
  }

  const attempts = await consumeRateLimit(env.DB, `totp:${ticketHash}`, now);
  if (attempts > TOTP_TICKET_MAX_ATTEMPTS) {
    await deleteTotpTicket(env.DB, ticketHash);
    return ticketLimited(now);
  }

  const verdict = await verifySecondFactor(
    env,
    { id: record.user_id, totp_secret: record.totp_secret, totp_last_counter: record.totp_last_counter },
    code,
    now,
  );
  if (!verdict.ok) {
    const used = await recordTotpAttempt(env.DB, ticketHash);
    const failures = await recordSecondFactorFailure(env, record.user_id, now);
    if (used >= TOTP_TICKET_MAX_ATTEMPTS || failures >= TOTP_FAILURE_LIMIT) {
      await deleteTotpTicket(env.DB, ticketHash);
      return ticketLimited(now);
    }
    return json(
      { ok: false, error: verdict.error, attempts_remaining: TOTP_TICKET_MAX_ATTEMPTS - used },
      401,
    );
  }

  await clearSecondFactorFailures(env, record.user_id, now);
  await deleteTotpTicket(env.DB, ticketHash);
  return issueSession(request, env, {
    id: record.user_id,
    username: record.username,
    role: record.role,
    totp_enabled_at: record.totp_enabled_at,
  });
}

// Shared by login verification, disable, and recovery regeneration. A TOTP
// code is checked first (and its time step is consumed), then a recovery code.
export async function verifySecondFactor(
  env: Env,
  user: SecondFactorUser,
  code: string,
  now: number,
): Promise<SecondFactorResult> {
  if (user.totp_secret !== null) {
    const secret = await openTotpSecret(resolveContentKey(env.CONTENT_KEY), user.totp_secret);
    if (secret) {
      const counter = await matchTotp({
        secret,
        code,
        nowMs: now,
        lastCounter: user.totp_last_counter,
      });
      if (counter !== null) {
        const advanced = await advanceTotpCounter(env.DB, user.id, counter);
        if (!advanced) return { ok: false, error: "验证码已使用，请等待下一个验证码" };
        return { ok: true, method: "totp", counter };
      }
    }
  }
  if (normalizeRecoveryCode(code)) {
    const consumed = await consumeRecoveryCode(env.DB, user.id, await hashRecoveryCode(code), now);
    if (consumed) return { ok: true, method: "recovery" };
  }
  return { ok: false, error: "验证码不正确" };
}

async function readJson(
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

function readCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim();
  if (code.length === 0 || code.length > 24) return null;
  return code;
}

function readPassword(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > 256) return null;
  return value;
}

function readTicket(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ticket = value.trim();
  return /^tot_[A-Za-z0-9_-]{20,80}$/.test(ticket) ? ticket : null;
}

async function totpLoginLocked(env: Env, userId: string, now: number): Promise<boolean> {
  const failures = await readRateLimitWindow(env.DB, `totp-login:${userId}`, now, TOTP_FAILURE_WINDOW_MS);
  return failures >= TOTP_FAILURE_LIMIT;
}

// A wrong code counts into the same account window no matter which endpoint
// (login verify, disable, recovery) asked for it, so switching endpoints does
// not hand out fresh guesses.
async function secondFactorLocked(env: Env, userId: string, now: number): Promise<boolean> {
  return totpLoginLocked(env, userId, now);
}

async function recordSecondFactorFailure(env: Env, userId: string, now: number): Promise<number> {
  return consumeRateLimitWindow(env.DB, `totp-login:${userId}`, now, TOTP_FAILURE_WINDOW_MS);
}

async function clearSecondFactorFailures(env: Env, userId: string, now: number): Promise<void> {
  await clearRateLimitWindow(env.DB, `totp-login:${userId}`, now, TOTP_FAILURE_WINDOW_MS);
}

function passwordLimited(now: number): Response {
  return json({ ok: false, error: "尝试过多，请稍后再试" }, 429, {
    "retry-after": String(loginRetryAfterSeconds(now)),
  });
}

function secondFactorLimited(now: number, error: string): Response {
  return json({ ok: false, error }, 429, {
    "retry-after": String(rateLimitRetryAfterSeconds(now, TOTP_FAILURE_WINDOW_MS)),
  });
}

function ticketLimited(now: number): Response {
  return json({ ok: false, error: "验证码尝试过多，请重新登录" }, 429, {
    "retry-after": String(rateLimitRetryAfterSeconds(now, 60_000)),
  });
}

function methodNotAllowed(allow: string): Response {
  return json({ ok: false, error: "方法不允许" }, 405, { allow });
}
