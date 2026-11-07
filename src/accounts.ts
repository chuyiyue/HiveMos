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

export function rateLimitWindowStart(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

export function rateLimitRetryAfterSeconds(now: number, windowMs: number): number {
  const end = rateLimitWindowStart(now, windowMs) + windowMs;
  return Math.max(1, Math.ceil((end - now) / 1000));
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
