import { sha256Hex } from "./auth";
import type { D1Database } from "./env";

type SessionRow = { expires_at: number | string | null };

// id is sha256Hex(rawToken). The raw token never lands in D1.
export async function createSession(db: D1Database, id: string, createdAt: number, expiresAt: number): Promise<void> {
  await db
    .prepare("INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)")
    .bind(id, createdAt, expiresAt)
    .run();
}

export async function deleteSession(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
}

// Missing, malformed, or expired tokens are not a session. Expired rows are removed.
export async function readSession(db: D1Database, token: string | null, now: number): Promise<boolean> {
  if (!token) return false;
  const id = await sha256Hex(token);
  const row = await db.prepare("SELECT expires_at FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if (!row) return false;
  const expiresAt = Number(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    await deleteSession(db, id);
    return false;
  }
  return true;
}
