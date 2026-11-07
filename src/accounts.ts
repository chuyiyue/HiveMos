// Account, session, and login-budget queries. Ported from the SMSinBox db.ts subset.

import { sha256Hex } from "./auth";
import type { D1Database } from "./env";

export interface UserRecord {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  disabled_at: number | null;
  created_at: number;
}

export interface SessionUser {
  id: string;
  username: string;
  role: string;
  disabled_at: number | null;
  expires_at: number;
  totp_enabled_at?: number | null;
}

export interface TotpUserRecord {
  id: string;
  username: string;
  role: string;
  disabled_at: number | null;
  password_hash: string;
  totp_secret: string | null;
  totp_pending_secret: string | null;
  totp_pending_created_at: number | null;
  totp_enabled_at: number | null;
  totp_last_counter: number | null;
}

export interface TotpTicketRecord {
  id: string;
  user_id: string;
  expires_at: number;
  attempts: number;
  created_at: number;
  username: string;
  role: string;
  disabled_at: number | null;
  totp_secret: string | null;
  totp_enabled_at: number | null;
  totp_last_counter: number | null;
}

export interface ListedSession {
  id: string;
  created_at: number;
  expires_at: number;
  user_agent: string | null;
}

export const PROFILE_USERNAME_KEY = "profile_username";

// Login and current-password failures share rate_limits.
// Keys are `login:user|ip|account:` plus a SHA-256, so they cannot collide
// with any other token hash. The window is 15 minutes, not one minute.
export const LOGIN_FAILURE_LIMIT = 8;
export const LOGIN_IP_FAILURE_LIMIT = 30;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes("UNIQUE constraint failed");
}

function isMissingSchemaMeta(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:?\s*schema_meta/i.test(message);
}

function rowsOf<T>(value: { results?: T[] } | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.results)) return value.results;
  return [];
}

function changesOf(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const meta = (result as { meta?: { changes?: unknown } }).meta;
  const changes = meta?.changes;
  return typeof changes === "number" && Number.isFinite(changes) ? changes : 0;
}

export async function findUserByUsername(db: D1Database, username: string): Promise<UserRecord | null> {
  return db
    .prepare(
      "SELECT id, username, password_hash, role, disabled_at, created_at FROM users WHERE username = ?",
    )
    .bind(username)
    .first<UserRecord>();
}

export async function findUserById(
  db: D1Database,
  userId: string,
): Promise<Omit<UserRecord, "password_hash"> | null> {
  return db
    .prepare("SELECT id, username, role, disabled_at, created_at FROM users WHERE id = ?")
    .bind(userId)
    .first<Omit<UserRecord, "password_hash">>();
}

export async function findUserRecordById(db: D1Database, userId: string): Promise<UserRecord | null> {
  return db
    .prepare(
      "SELECT id, username, password_hash, role, disabled_at, created_at FROM users WHERE id = ?",
    )
    .bind(userId)
    .first<UserRecord>();
}

// Login resolves the single administrator from this list. The password hash is
// needed because a request may not name a row.
export async function listUserRecords(db: D1Database): Promise<UserRecord[]> {
  const result = await db
    .prepare(
      "SELECT id, username, password_hash, role, disabled_at, created_at FROM users ORDER BY created_at ASC",
    )
    .all<UserRecord>();
  return rowsOf(result);
}

export async function insertUser(
  db: D1Database,
  user: { id: string; username: string; passwordHash: string; role: "admin" | "member"; createdAt: number },
): Promise<void> {
  await db
    .prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(user.id, user.username, user.passwordHash, user.role, user.createdAt)
    .run();
}

export async function updatePasswordHash(db: D1Database, userId: string, passwordHash: string): Promise<void> {
  await db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(passwordHash, userId).run();
}

export async function updateUsername(db: D1Database, userId: string, username: string): Promise<void> {
  await db.prepare("UPDATE users SET username = ? WHERE id = ?").bind(username, userId).run();
}

export async function ensureAdmin(db: D1Database, userId: string): Promise<void> {
  await db.prepare("UPDATE users SET role = 'admin', disabled_at = NULL WHERE id = ?").bind(userId).run();
}

// The one admin may set a display-only username (a nickname). It lives in
// schema_meta, never on the users row: login stays on the stored username.
export async function getProfileUsername(db: D1Database): Promise<string> {
  try {
    const row = await db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .bind(PROFILE_USERNAME_KEY)
      .first<{ value: string }>();
    return row?.value ?? "";
  } catch (error) {
    if (isMissingSchemaMeta(error)) return "";
    throw error;
  }
}

export async function setProfileUsername(db: D1Database, username: string): Promise<void> {
  if (username.length === 0) {
    await db.prepare("DELETE FROM schema_meta WHERE key = ?").bind(PROFILE_USERNAME_KEY).run();
    return;
  }
  await db
    .prepare(
      "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(PROFILE_USERNAME_KEY, username)
    .run();
}

// Sidebar pin limit: how many agents the rail shows in total (pinned ones
// are never dropped; the limit caps the auto-filled remainder). Anything
// outside 1-20 or unparsable falls back to the default, on read and write.
export const SIDEBAR_PIN_LIMIT_DEFAULT = 5;
const SIDEBAR_PIN_LIMIT_KEY = "sidebar_pin_limit";

export function normalizeSidebarPinLimit(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 1 && parsed <= 20) return parsed;
  return SIDEBAR_PIN_LIMIT_DEFAULT;
}

export async function getSidebarPinLimit(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .bind(SIDEBAR_PIN_LIMIT_KEY)
      .first<{ value: string }>();
    if (!row) return SIDEBAR_PIN_LIMIT_DEFAULT;
    return normalizeSidebarPinLimit(row.value);
  } catch (error) {
    if (isMissingSchemaMeta(error)) return SIDEBAR_PIN_LIMIT_DEFAULT;
    throw error;
  }
}

export async function setSidebarPinLimit(db: D1Database, value: unknown): Promise<number> {
  const limit = normalizeSidebarPinLimit(value);
  await db
    .prepare(
      "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(SIDEBAR_PIN_LIMIT_KEY, String(limit))
    .run();
  return limit;
}

export async function setUserRole(db: D1Database, userId: string, role: "admin" | "member"): Promise<void> {
  await db.prepare("UPDATE users SET role = ? WHERE id = ?").bind(role, userId).run();
}

export async function setUserDisabledAt(db: D1Database, userId: string, disabledAt: number | null): Promise<void> {
  await db.prepare("UPDATE users SET disabled_at = ? WHERE id = ?").bind(disabledAt, userId).run();
}

export async function deleteUserSessions(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

export async function createSession(
  db: D1Database,
  session: { id: string; userId: string; userAgent: string | null; expiresAt: number; createdAt: number },
): Promise<void> {
  await db
    .prepare("INSERT INTO sessions (id, user_id, user_agent, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(session.id, session.userId, session.userAgent, session.expiresAt, session.createdAt)
    .run();
}

export async function findSessionUser(db: D1Database, sessionHash: string): Promise<SessionUser | null> {
  return db
    .prepare(
      `SELECT u.id AS id, u.username AS username, u.role AS role, u.disabled_at AS disabled_at,
              u.totp_enabled_at AS totp_enabled_at, s.expires_at AS expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`,
    )
    .bind(sessionHash)
    .first<SessionUser>();
}

export async function deleteSession(db: D1Database, sessionHash: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionHash).run();
}

export async function listUserSessions(db: D1Database, userId: string, now: number): Promise<ListedSession[]> {
  const result = await db
    .prepare(
      `SELECT id, created_at, expires_at, user_agent
       FROM sessions
       WHERE user_id = ? AND expires_at > ?
       ORDER BY created_at DESC, id ASC`,
    )
    .bind(userId, now)
    .all<ListedSession>();
  return rowsOf(result);
}

export async function deleteUserSessionById(db: D1Database, userId: string, sessionId: string): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM sessions WHERE user_id = ? AND id = ?")
    .bind(userId, sessionId)
    .run();
  return changesOf(result) > 0;
}

export async function deleteOtherUserSessions(db: D1Database, userId: string, keepSessionId: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE user_id = ? AND id <> ?").bind(userId, keepSessionId).run();
}

// Same statement as deleteOtherUserSessions. TOTP disable keeps the session
// that just proved the second factor and drops every other one.
export async function deleteUserSessionsExcept(db: D1Database, userId: string, keepHash: string): Promise<void> {
  await deleteOtherUserSessions(db, userId, keepHash);
}

export async function deleteUserTotpTickets(db: D1Database, userId: string): Promise<void> {
  await db.prepare("DELETE FROM totp_tickets WHERE user_id = ?").bind(userId).run();
}

export async function findTotpUser(db: D1Database, userId: string): Promise<TotpUserRecord | null> {
  return db
    .prepare(
      `SELECT id, username, role, disabled_at, password_hash,
              totp_secret, totp_pending_secret, totp_pending_created_at, totp_enabled_at, totp_last_counter
       FROM users WHERE id = ?`,
    )
    .bind(userId)
    .first<TotpUserRecord>();
}

export async function setTotpPending(
  db: D1Database,
  userId: string,
  sealedSecret: string,
  createdAt: number,
): Promise<void> {
  await db
    .prepare("UPDATE users SET totp_pending_secret = ?, totp_pending_created_at = ? WHERE id = ?")
    .bind(sealedSecret, createdAt, userId)
    .run();
}

// Promotes the pending secret. The enrollment code is deliberately not stored
// as totp_last_counter: the operator may log in again inside the same 30s step.
export async function enableTotp(db: D1Database, userId: string, enabledAt: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users
       SET totp_secret = totp_pending_secret,
           totp_enabled_at = ?,
           totp_last_counter = NULL,
           totp_pending_secret = NULL,
           totp_pending_created_at = NULL
       WHERE id = ? AND totp_pending_secret IS NOT NULL`,
    )
    .bind(enabledAt, userId)
    .run();
  return changesOf(result) > 0;
}

export async function clearTotp(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE users
         SET totp_secret = NULL, totp_pending_secret = NULL, totp_pending_created_at = NULL,
             totp_enabled_at = NULL, totp_last_counter = NULL
         WHERE id = ?`,
      )
      .bind(userId),
    db.prepare("DELETE FROM totp_recovery_codes WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM totp_tickets WHERE user_id = ?").bind(userId),
  ]);
}

// Rejects a code that maps to an already accepted (or older) step.
export async function advanceTotpCounter(db: D1Database, userId: string, counter: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users SET totp_last_counter = ?
       WHERE id = ? AND (totp_last_counter IS NULL OR totp_last_counter < ?)`,
    )
    .bind(counter, userId, counter)
    .run();
  return changesOf(result) > 0;
}

export async function replaceRecoveryCodes(
  db: D1Database,
  userId: string,
  hashes: string[],
  createdAt: number,
): Promise<void> {
  const statements = [db.prepare("DELETE FROM totp_recovery_codes WHERE user_id = ?").bind(userId)];
  for (const hash of hashes) {
    statements.push(
      db
        .prepare(
          `INSERT INTO totp_recovery_codes (id, user_id, code_hash, created_at, used_at)
           VALUES (?, ?, ?, ?, NULL)`,
        )
        .bind(crypto.randomUUID(), userId, hash, createdAt),
    );
  }
  await db.batch(statements);
}

export async function consumeRecoveryCode(
  db: D1Database,
  userId: string,
  codeHash: string,
  usedAt: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE totp_recovery_codes SET used_at = ?
       WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`,
    )
    .bind(usedAt, userId, codeHash)
    .run();
  return changesOf(result) > 0;
}

export async function countRecoveryCodes(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS total FROM totp_recovery_codes WHERE user_id = ? AND used_at IS NULL")
    .bind(userId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function createTotpTicket(
  db: D1Database,
  ticket: { id: string; userId: string; expiresAt: number; createdAt: number },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO totp_tickets (id, user_id, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)",
    )
    .bind(ticket.id, ticket.userId, ticket.expiresAt, ticket.createdAt)
    .run();
}

export async function findTotpTicket(db: D1Database, ticketHash: string): Promise<TotpTicketRecord | null> {
  return db
    .prepare(
      `SELECT t.id AS id, t.user_id AS user_id, t.expires_at AS expires_at, t.attempts AS attempts,
              t.created_at AS created_at, u.username AS username, u.role AS role,
              u.disabled_at AS disabled_at, u.totp_secret AS totp_secret,
              u.totp_enabled_at AS totp_enabled_at, u.totp_last_counter AS totp_last_counter
       FROM totp_tickets t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = ?`,
    )
    .bind(ticketHash)
    .first<TotpTicketRecord>();
}

export async function recordTotpAttempt(db: D1Database, ticketHash: string): Promise<number> {
  const row = await db
    .prepare("UPDATE totp_tickets SET attempts = attempts + 1 WHERE id = ? RETURNING attempts")
    .bind(ticketHash)
    .first<{ attempts: number }>();
  return row?.attempts ?? 1;
}

export async function deleteTotpTicket(db: D1Database, ticketHash: string): Promise<void> {
  await db.prepare("DELETE FROM totp_tickets WHERE id = ?").bind(ticketHash).run();
}

export function rateLimitWindowStart(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

export function rateLimitRetryAfterSeconds(now: number, windowMs: number): number {
  const end = rateLimitWindowStart(now, windowMs) + windowMs;
  return Math.max(1, Math.ceil((end - now) / 1000));
}

export async function consumeRateLimit(db: D1Database, tokenHash: string, now: number): Promise<number> {
  return consumeRateLimitWindow(db, tokenHash, now, 60_000);
}

// Same table, but callers that need a long window (login failures, second
// factor guesses) pass it explicitly instead of resetting every minute.
export async function consumeRateLimitWindow(
  db: D1Database,
  tokenHash: string,
  now: number,
  windowMs: number,
): Promise<number> {
  const windowStart = rateLimitWindowStart(now, windowMs);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (token_hash, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT(token_hash, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(tokenHash, windowStart)
    .first<{ count: number }>();
  return row?.count ?? 1;
}

export function loginWindowStart(now: number): number {
  return rateLimitWindowStart(now, LOGIN_WINDOW_MS);
}

export function loginRetryAfterSeconds(now: number): number {
  return rateLimitRetryAfterSeconds(now, LOGIN_WINDOW_MS);
}

export async function loginRateKey(kind: "user" | "ip" | "account", value: string): Promise<string> {
  return `login:${kind}:${await sha256Hex(value)}`;
}

export async function loginAttemptCount(db: D1Database, key: string, now: number): Promise<number> {
  const row = await db
    .prepare("SELECT count FROM rate_limits WHERE token_hash = ? AND window_start = ?")
    .bind(key, loginWindowStart(now))
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function recordLoginFailure(db: D1Database, key: string, now: number): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (token_hash, window_start, count)
       VALUES (?, ?, 1)
       ON CONFLICT(token_hash, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(key, loginWindowStart(now))
    .first<{ count: number }>();
  return row?.count ?? 1;
}

export async function clearRateLimitWindow(
  db: D1Database,
  key: string,
  now: number,
  windowMs: number,
): Promise<void> {
  await db
    .prepare("DELETE FROM rate_limits WHERE token_hash = ? AND window_start = ?")
    .bind(key, rateLimitWindowStart(now, windowMs))
    .run();
}

// Reads the counter without incrementing it, so a caller can refuse the
// attempt before it checks a password or TOTP code.
export async function readRateLimitWindow(
  db: D1Database,
  tokenHash: string,
  now: number,
  windowMs: number,
): Promise<number> {
  const windowStart = rateLimitWindowStart(now, windowMs);
  const row = await db
    .prepare(`SELECT "count" AS total FROM rate_limits WHERE token_hash = ? AND window_start = ?`)
    .bind(tokenHash, windowStart)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function clearLoginFailures(db: D1Database, key: string, now: number): Promise<void> {
  await clearRateLimitWindow(db, key, now, LOGIN_WINDOW_MS);
}

export async function loginIsLimited(
  db: D1Database,
  userKey: string,
  ipKey: string | null,
  now: number,
): Promise<boolean> {
  if ((await loginAttemptCount(db, userKey, now)) >= LOGIN_FAILURE_LIMIT) return true;
  if (!ipKey) return false;
  return (await loginAttemptCount(db, ipKey, now)) >= LOGIN_IP_FAILURE_LIMIT;
}

// Every endpoint that re-checks the current password shares one `login:account:`
// budget. The key is separate from `login:user:`/`login:ip:`, so a stolen
// session cannot lock the owner out of the login form.
export async function accountPasswordLimited(db: D1Database, userId: string, now: number): Promise<boolean> {
  return (await loginAttemptCount(db, await loginRateKey("account", userId), now)) >= LOGIN_FAILURE_LIMIT;
}

export async function recordAccountPasswordFailure(db: D1Database, userId: string, now: number): Promise<number> {
  return recordLoginFailure(db, await loginRateKey("account", userId), now);
}

export async function clearAccountPasswordFailures(db: D1Database, userId: string, now: number): Promise<void> {
  await clearLoginFailures(db, await loginRateKey("account", userId), now);
}
