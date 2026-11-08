// System settings stored as key-value rows in schema_meta. This is the same
// store the sidebar pin limit has always used, so the settings panel, the
// sidebar assembly, and the cron gate all read one source of truth.
//
// Two settings live here for now:
//   sidebar_pin_limit    how many agents the rail shows in total
//   cron_interval_hours  how often the scheduled sweep actually runs
//
// Cron is physically triggered every hour (wrangler.jsonc). The interval is
// logical: the scheduled handler compares it with cron_last_run_at and skips
// the sweep when it is not due yet.

import type { D1Database } from "./env";

export const HOUR_MS = 60 * 60 * 1000;

export const SIDEBAR_PIN_LIMIT_DEFAULT = 5;
export const SIDEBAR_PIN_LIMIT_MIN = 1;
export const SIDEBAR_PIN_LIMIT_MAX = 20;

export const CRON_INTERVAL_HOURS_DEFAULT = 6;
export const CRON_INTERVAL_OPTIONS = [1, 3, 6, 12, 24] as const;

const SIDEBAR_PIN_LIMIT_KEY = "sidebar_pin_limit";
const CRON_INTERVAL_HOURS_KEY = "cron_interval_hours";
export const CRON_LAST_RUN_KEY = "cron_last_run_at";

function isMissingSchemaMeta(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:?\s*schema_meta/i.test(message);
}

function toInteger(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

// Anything outside 1-20 or unparsable falls back to the default on read.
// Pinned agents are never dropped; the limit caps the auto-filled remainder.
export function normalizeSidebarPinLimit(value: unknown): number {
  const parsed = toInteger(value);
  if (parsed === null || parsed < SIDEBAR_PIN_LIMIT_MIN || parsed > SIDEBAR_PIN_LIMIT_MAX) {
    return SIDEBAR_PIN_LIMIT_DEFAULT;
  }
  return parsed;
}

export function normalizeCronIntervalHours(value: unknown): number {
  const parsed = toInteger(value);
  if (parsed === null || !(CRON_INTERVAL_OPTIONS as readonly number[]).includes(parsed)) {
    return CRON_INTERVAL_HOURS_DEFAULT;
  }
  return parsed;
}

// Writes validate strictly at the HTTP layer; these predicates are the
// single definition of "valid" shared by the endpoint and the normalizers.
export function isSidebarPinLimit(value: unknown): boolean {
  const parsed = toInteger(value);
  return parsed !== null && parsed >= SIDEBAR_PIN_LIMIT_MIN && parsed <= SIDEBAR_PIN_LIMIT_MAX;
}

export function isCronIntervalOption(value: unknown): boolean {
  const parsed = toInteger(value);
  return parsed !== null && (CRON_INTERVAL_OPTIONS as readonly number[]).includes(parsed);
}

export function cronIntervalLabel(hours: number): string {
  if (hours === 1) return "每小时";
  if (hours === 24) return "每天";
  return `每 ${hours} 小时`;
}

export function cronIntervalMs(hours: number): number {
  return hours * HOUR_MS;
}

async function readMetaValue(db: D1Database, key: string): Promise<string | null> {
  try {
    const row = await db.prepare("SELECT value FROM schema_meta WHERE key = ?").bind(key).first<{ value: string }>();
    return row ? row.value : null;
  } catch (error) {
    if (isMissingSchemaMeta(error)) return null;
    throw error;
  }
}

async function writeMetaValue(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key, value)
    .run();
}

export async function getSidebarPinLimit(db: D1Database): Promise<number> {
  return normalizeSidebarPinLimit(await readMetaValue(db, SIDEBAR_PIN_LIMIT_KEY));
}

export async function setSidebarPinLimit(db: D1Database, value: unknown): Promise<number> {
  const limit = normalizeSidebarPinLimit(value);
  await writeMetaValue(db, SIDEBAR_PIN_LIMIT_KEY, String(limit));
  return limit;
}

export async function getCronIntervalHours(db: D1Database): Promise<number> {
  return normalizeCronIntervalHours(await readMetaValue(db, CRON_INTERVAL_HOURS_KEY));
}

export async function setCronIntervalHours(db: D1Database, value: unknown): Promise<number> {
  const hours = normalizeCronIntervalHours(value);
  await writeMetaValue(db, CRON_INTERVAL_HOURS_KEY, String(hours));
  return hours;
}

export interface SystemSettings {
  sidebar_pin_limit: number;
  cron_interval_hours: number;
}

export async function readSystemSettings(db: D1Database): Promise<SystemSettings> {
  return {
    sidebar_pin_limit: await getSidebarPinLimit(db),
    cron_interval_hours: await getCronIntervalHours(db),
  };
}

async function readCronLastRun(db: D1Database): Promise<number | null> {
  const raw = await readMetaValue(db, CRON_LAST_RUN_KEY);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export interface CronState {
  interval_hours: number;
  last_run_at: number | null;
}

export async function readCronState(db: D1Database): Promise<CronState> {
  return {
    interval_hours: await getCronIntervalHours(db),
    last_run_at: await readCronLastRun(db),
  };
}

// First run (no stamp) counts as due, so a fresh deployment sweeps right away.
export async function cronSweepDue(db: D1Database, now: number): Promise<boolean> {
  const state = await readCronState(db);
  if (state.last_run_at === null) return true;
  return now - state.last_run_at >= cronIntervalMs(state.interval_hours);
}
