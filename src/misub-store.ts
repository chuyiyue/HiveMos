// MiSub API 快照的 D1 存储与同步频率（表见 migrations/0078_misub_store.sql）。
// 每个连接一行，快照整体用 VAULT_KEY 密封在 secrets_enc；页面只读 D1。
// 同步：hourly cron 只认每个连接自己的间隔，未设置即 0（关闭、零出站）；手动同步 5 分钟冷却。
// 失败只记错误，保留上次成功的快照。

import type { D1Database, Env } from "./env";
import { decryptString, resolveContentKey, sealString, type ContentKey } from "./crypto";
import {
  MisubError,
  fetchMisubLists,
  listMisubConnectionIds,
  openMisubConnection,
  type MisubConnectionHandle,
  type MisubSnapshot,
} from "./misub";

export const MANUAL_COOLDOWN_MS = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SNAPSHOT_VERSION = 2;

interface SnapshotRow {
  secrets_enc: string;
  synced_at: number | null;
  last_attempt_at: number | null;
  last_ok: number;
  last_error: string;
  manual_at: number | null;
}

export interface SyncStatus {
  synced_at: number | null;
  last_attempt_at: number | null;
  last_ok: boolean;
  last_error: string;
  auto_interval_hours: number;
  next_auto_at: number | null;
  next_manual_at: number;
}

function vaultKey(env: Env): ContentKey {
  const raw = (env as unknown as Record<string, unknown>)["VAULT_KEY"];
  return resolveContentKey(typeof raw === "string" ? raw : undefined);
}

function requireKey(env: Env): ContentKey & { state: "on" } {
  const key = vaultKey(env);
  if (key.state === "invalid") throw new MisubError(503, "保险库密钥配置不正确");
  if (key.state !== "on") throw new MisubError(503, "保险库未配置");
  return key as ContentKey & { state: "on" };
}

async function openSnapshot(env: Env, sealed: string): Promise<MisubSnapshot | null> {
  if (!sealed) return null;
  const key = requireKey(env);
  const plain = await decryptString(key.raw, sealed);
  if (plain === null) throw new MisubError(500, "MiSub 快照解密失败");
  try {
    const parsed = JSON.parse(plain) as { v?: number; snapshot?: MisubSnapshot };
    // 旧版本（拉机场订阅时期）的行没有 v，等下一次同步覆盖。
    return parsed.v === SNAPSHOT_VERSION && parsed.snapshot ? parsed.snapshot : null;
  } catch {
    return null;
  }
}

async function readRow(db: D1Database, connId: string): Promise<SnapshotRow | null> {
  return (
    (await db
      .prepare("SELECT secrets_enc, synced_at, last_attempt_at, last_ok, last_error, manual_at FROM misub_snapshots WHERE connection_id = ?")
      .bind(connId)
      .first<SnapshotRow>()) ?? null
  );
}

function due(lastAttempt: number | null, hours: number, now: number): boolean {
  return hours > 0 && (lastAttempt === null || now - lastAttempt >= hours * HOUR_MS);
}

function syncStatus(row: SnapshotRow | null, conn: MisubConnectionHandle): SyncStatus {
  const last = row?.last_attempt_at ?? null;
  const hours = conn.auto_interval_hours;
  return {
    synced_at: row?.synced_at ?? null,
    last_attempt_at: last,
    last_ok: row?.last_ok === 1,
    last_error: row?.last_error ?? "",
    auto_interval_hours: hours,
    next_auto_at: hours > 0 ? (last === null ? Date.now() : last + hours * HOUR_MS) : null,
    next_manual_at: row?.manual_at ? row.manual_at + MANUAL_COOLDOWN_MS : 0,
  };
}

export async function readMisubView(
  env: Env,
  connId?: string,
): Promise<{ connection: MisubConnectionHandle; snapshot: MisubSnapshot | null; sync: SyncStatus }> {
  const conn = await openMisubConnection(env, connId);
  const row = await readRow(env.DB, conn.id);
  const snapshot = row ? await openSnapshot(env, row.secrets_enc) : null;
  const sync = syncStatus(row, conn);
  if (!snapshot) sync.synced_at = null;
  return { connection: conn, snapshot, sync };
}

async function syncSnapshot(env: Env, conn: MisubConnectionHandle, now: number, manual: boolean): Promise<{ ok: boolean; error: string }> {
  try {
    const snapshot = await fetchMisubLists(conn);
    const sealed = await sealString(requireKey(env), JSON.stringify({ v: SNAPSHOT_VERSION, snapshot }));
    if (sealed === null) throw new MisubError(503, "保险库未配置");
    await env.DB.prepare(
      "INSERT INTO misub_snapshots (connection_id, data_json, secrets_enc, synced_at, last_attempt_at, last_ok, last_error, manual_at) VALUES (?, '', ?, ?, ?, 1, '', ?) " +
        "ON CONFLICT(connection_id) DO UPDATE SET data_json = '', secrets_enc = excluded.secrets_enc, synced_at = excluded.synced_at, last_attempt_at = excluded.last_attempt_at, last_ok = 1, last_error = '', manual_at = COALESCE(excluded.manual_at, misub_snapshots.manual_at)",
    )
      .bind(conn.id, sealed, now, now, manual ? now : null)
      .run();
    return { ok: true, error: "" };
  } catch (error) {
    const message = error instanceof MisubError ? error.message : "同步 MiSub 失败";
    await env.DB.prepare(
      "INSERT INTO misub_snapshots (connection_id, last_attempt_at, last_ok, last_error, manual_at) VALUES (?, ?, 0, ?, ?) " +
        "ON CONFLICT(connection_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_ok = 0, last_error = excluded.last_error, manual_at = COALESCE(excluded.manual_at, misub_snapshots.manual_at)",
    )
      .bind(conn.id, now, message, manual ? now : null)
      .run();
    return { ok: false, error: message };
  }
}

// 手动同步当前连接：5 分钟冷却。
export async function manualSyncMisub(env: Env, now: number): Promise<{ ok: boolean; error: string; next_manual_at: number }> {
  const conn = await openMisubConnection(env);
  const row = await readRow(env.DB, conn.id);
  const nextAt = row?.manual_at ? row.manual_at + MANUAL_COOLDOWN_MS : 0;
  if (nextAt > now) {
    throw new MisubError(429, `${Math.max(1, Math.ceil((nextAt - now) / 60000))} 分钟后才能再次同步`);
  }
  const result = await syncSnapshot(env, conn, now, true);
  return { ...result, next_manual_at: now + MANUAL_COOLDOWN_MS };
}

// 保存连接、触发 MiSub 刷新之后用，不占冷却。
export async function syncMisubNow(env: Env, connId?: string): Promise<{ ok: boolean; error: string }> {
  const conn = await openMisubConnection(env, connId);
  return syncSnapshot(env, conn, Date.now(), false);
}

export async function deleteMisubStore(db: D1Database, connId: string): Promise<void> {
  await db.prepare("DELETE FROM misub_snapshots WHERE connection_id = ?").bind(connId).run();
}

// hourly cron：每个连接各自按间隔门控，一个连接 3 个子请求。
export async function runMisubSweep(env: Env, now: number): Promise<number> {
  let synced = 0;
  const { ids } = await listMisubConnectionIds(env.DB);
  for (const id of ids.slice(0, 10)) {
    let conn: MisubConnectionHandle;
    try {
      conn = await openMisubConnection(env, id);
    } catch {
      continue;
    }
    const row = await readRow(env.DB, conn.id);
    if (!due(row?.last_attempt_at ?? null, conn.auto_interval_hours, now)) continue;
    await syncSnapshot(env, conn, now, false);
    synced++;
  }
  return synced;
}
