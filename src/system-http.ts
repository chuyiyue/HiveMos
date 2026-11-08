// Panel REST for the settings page's system panel. Read-only; the gate in
// index.ts has already authenticated the admin session, same as the other
// module handlers. Counts reuse the overview aggregation (buildOverviewStats)
// so this panel and the overview page can never disagree.
//
// Cron status is evidence-based, not config-based: wrangler.jsonc declares
// the schedule, but a declaration is not a registration (the account's cron
// quota can silently refuse it). The scheduled handler stamps
// schema_meta[cron_last_run_at] after every sweep via recordCronRun, and
// this endpoint reports "active" only when a stamp exists and is fresh.

import { json } from "./http";
import type { D1Database, Env, WaitCtx } from "./env";
import { buildOverviewStats } from "./overview-http";
import { MCP_TOOL_COUNT } from "./mcp";
import { APP_VERSION, BUILD_COMMIT } from "./version";

// Constants that mirror wrangler.jsonc; the Worker cannot read its own
// config at runtime, so they are restated here next to their source.
const DATABASE_NAME = "hivemos"; // d1_databases[0].database_name
const CUSTOM_DOMAIN = "mos.loko.pp.ua"; // routes[0].pattern
const WORKERS_DEV_URL = "https://hivemos.lokfu.workers.dev"; // workers_dev subdomain
const CRON_SCHEDULE = "0 */6 * * *"; // triggers.crons[0]

const CRON_LAST_RUN_KEY = "cron_last_run_at";
// The sweep is declared every 6 hours. Allow one fully missed run plus
// grace before the panel stops calling the schedule active.
const CRON_FRESH_MS = 13 * 60 * 60 * 1000;

export async function handleSystemRequest(
  request: Request,
  env: Env,
  ctx: WaitCtx,
  path: string,
): Promise<Response | null> {
  void ctx;
  if (path !== "/api/system/info") return null;
  if (request.method.toUpperCase() !== "GET") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET" });
  }
  try {
    const data = await buildSystemInfo(env.DB, Date.now());
    return json({ ok: true, ...data });
  } catch {
    return json({ ok: false, error: "暂时无法读取系统信息" }, 503);
  }
}

async function buildSystemInfo(db: D1Database, now: number) {
  const stats = await buildOverviewStats(db, now);
  const cronLastRun = await readCronLastRun(db);
  return {
    version: APP_VERSION,
    build_commit: BUILD_COMMIT,
    runtime: "Cloudflare Workers + D1",
    database_name: DATABASE_NAME,
    domain: CUSTOM_DOMAIN,
    workers_dev_url: WORKERS_DEV_URL,
    mcp_endpoint: "/mcp",
    mcp_tools: MCP_TOOL_COUNT,
    counts: {
      agents: stats.agents.total,
      mcp_servers: stats.mcp_servers.total,
      memories: stats.memories,
      souls: stats.souls,
      tasks: stats.tasks.total,
      calendars: stats.calendars.total,
      events: await countEvents(db),
      machines: stats.machines.total,
      vault_entries: stats.vault_entries,
    },
    cron: {
      schedule: CRON_SCHEDULE,
      last_run_at: cronLastRun,
      active: cronLastRun != null && now - cronLastRun <= CRON_FRESH_MS,
    },
    generated_at: now,
  };
}

// buildOverviewStats counts only the next 7 days of events; the settings
// panel wants the all-time total, so it gets its own tolerant count.
async function countEvents(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE deleted_at IS NULL")
      .first<{ n: number }>();
    return row && typeof row.n === "number" ? row.n : 0;
  } catch {
    return 0;
  }
}

async function readCronLastRun(db: D1Database): Promise<number | null> {
  try {
    const row = await db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .bind(CRON_LAST_RUN_KEY)
      .first<{ value: string }>();
    if (!row) return null;
    const parsed = Number(row.value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

// Called by the scheduled handler in index.ts after each sweep. Writing
// the stamp is best-effort: a failed stamp must never fail the sweep.
export async function recordCronRun(db: D1Database, at: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(CRON_LAST_RUN_KEY, String(at))
    .run();
}
