// Panel REST for the overview page. Read-only aggregation over the module
// tables: headline counts, one merged recent-activity stream built from
// every module's audit table, and alerts derived from live state.
// The gate in index.ts has already authenticated the admin session.
//
// Tolerance rule: a table that does not exist yet (the vault module is
// landing separately; a fresh dev database may lag a migration) must never
// fail the whole page — that section degrades to zero/empty, and the vault
// count degrades to null so the frontend hides the card.

import { json } from "./http";
import type { D1Database, Env, WaitCtx } from "./env";
import { isTargetId, readBackupSchedule, readPublicTargets, targetLabel } from "./backup";
import { deniedToolName } from "./registry";

const ACTIVITY_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const BACKUP_ALERT_LIMIT = 2;
const BACKUP_ERROR_MAX = 80;

interface ActivityItem {
  at: number;
  module: string;
  module_label: string;
  actor: string;
  text: string;
}

interface AlertItem {
  kind: string;
  text: string;
  at: number | null;
}

export async function handleOverviewRequest(
  request: Request,
  env: Env,
  ctx: WaitCtx,
  path: string,
): Promise<Response | null> {
  void ctx;
  if (path !== "/api/overview") return null;
  if (request.method.toUpperCase() !== "GET") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET" });
  }
  try {
    const data = await buildOverview(env.DB, Date.now());
    return json({ ok: true, ...data });
  } catch {
    return json({ ok: false, error: "暂时无法读取总览数据" }, 503);
  }
}

async function buildOverview(db: D1Database, now: number) {
  const agentNames = await loadAgentNames(db);
  const [stats, activity, alerts] = await Promise.all([
    buildOverviewStats(db, now),
    buildActivity(db, agentNames),
    buildAlerts(db, now),
  ]);
  return { stats, activity, alerts, generated_at: now };
}

// ---- small tolerant query helpers ----------------------------------------

async function firstRow<T>(db: D1Database, sql: string, binds: Array<string | number> = []): Promise<T | null> {
  try {
    return await db.prepare(sql).bind(...binds).first<T>();
  } catch {
    return null;
  }
}

async function allRows<T>(db: D1Database, sql: string, binds: Array<string | number> = []): Promise<T[]> {
  try {
    const result = await db.prepare(sql).bind(...binds).all<T>();
    return Array.isArray(result) ? result : result.results ?? [];
  } catch {
    return [];
  }
}

async function countWhere(db: D1Database, sql: string, binds: Array<string | number> = []): Promise<number> {
  const row = await firstRow<{ n: number }>(db, sql, binds);
  return row && typeof row.n === "number" ? row.n : 0;
}

async function groupCounts(db: D1Database, table: string, column: string): Promise<Map<string, number>> {
  const rows = await allRows<{ k: string; n: number }>(
    db,
    `SELECT ${column} AS k, COUNT(*) AS n FROM ${table} GROUP BY ${column}`,
  );
  const map = new Map<string, number>();
  for (const row of rows) map.set(String(row.k), row.n);
  return map;
}

async function loadAgentNames(db: D1Database): Promise<Map<string, string>> {
  const rows = await allRows<{ id: string; name: string }>(db, "SELECT id, name FROM agents");
  return new Map(rows.map((row) => [row.id, row.name]));
}

function actorLabel(actor: string, agentNames: Map<string, string>): string {
  if (actor === "user") return "管理员";
  return agentNames.get(actor) ?? actor;
}

function diffTitle(diffJson: string | null): string | null {
  if (!diffJson) return null;
  try {
    const parsed = JSON.parse(diffJson) as { title?: unknown };
    return typeof parsed.title === "string" && parsed.title ? parsed.title : null;
  } catch {
    return null;
  }
}

function quoted(title: string | null): string {
  return title ? `「${title}」` : "";
}

// ---- stats -----------------------------------------------------------------

export async function buildOverviewStats(db: D1Database, now: number) {
  const agentGroups = await groupCounts(db, "agents", "status");
  const serverGroups = await groupCounts(db, "mcp_servers", "status");
  const taskGroups = await groupCounts(db, "tasks", "status");
  const machineKinds = await groupCounts(db, "machines", "kind");
  const machineStatuses = await groupCounts(db, "machines", "status");
  const sum = (map: Map<string, number>) => [...map.values()].reduce((a, b) => a + b, 0);
  const byStatus = (map: Map<string, number>) => Object.fromEntries(map);

  return {
    agents: {
      total: sum(agentGroups),
      active: agentGroups.get("active") ?? 0,
      disabled: agentGroups.get("disabled") ?? 0,
    },
    mcp_servers: {
      total: sum(serverGroups),
      active: serverGroups.get("active") ?? 0,
      disabled: serverGroups.get("disabled") ?? 0,
    },
    memories: await countWhere(db, "SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL"),
    souls: await countWhere(db, "SELECT COUNT(*) AS n FROM souls"),
    tasks: {
      total: sum(taskGroups),
      queued: taskGroups.get("queued") ?? 0,
      active: taskGroups.get("active") ?? 0,
      done: taskGroups.get("done") ?? 0,
    },
    calendars: {
      total: await countWhere(db, "SELECT COUNT(*) AS n FROM calendars"),
      events_next_7d: await countWhere(
        db,
        "SELECT COUNT(*) AS n FROM events WHERE deleted_at IS NULL AND status <> 'cancelled' AND starts_at >= ? AND starts_at < ?",
        [now, now + 7 * DAY_MS],
      ),
    },
    machines: {
      total: sum(machineKinds),
      by_kind: {
        server: machineKinds.get("server") ?? 0,
        cloud: machineKinds.get("cloud") ?? 0,
        worker: machineKinds.get("worker") ?? 0,
      },
      by_status: byStatus(machineStatuses),
    },
    vault_entries: await vaultEntryCount(db),
  };
}

// The vault module is landing separately; until its entries table exists the
// count stays null and the frontend hides the card instead of erroring.
async function vaultEntryCount(db: D1Database): Promise<number | null> {
  const tables = await allRows<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'vault%'",
  );
  const existing = new Set(tables.map((row) => row.name));
  for (const candidate of ["vault_entries", "vault_items", "vault_secrets", "vault_records"]) {
    if (!existing.has(candidate)) continue;
    const row = await firstRow<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${candidate}`);
    return row && typeof row.n === "number" ? row.n : null;
  }
  return null;
}

// ---- recent activity ---------------------------------------------------------

async function buildActivity(db: D1Database, agentNames: Map<string, string>): Promise<ActivityItem[]> {
  const parts = await Promise.all([
    mcpActivity(db),
    calendarActivity(db, agentNames),
    taskActivity(db, agentNames),
    memoryActivity(db, agentNames),
    soulActivity(db, agentNames),
    machineActivity(db, agentNames),
  ]);
  return parts
    .flat()
    .sort((a, b) => b.at - a.at)
    .slice(0, ACTIVITY_LIMIT);
}

async function mcpActivity(db: D1Database): Promise<ActivityItem[]> {
  const rows = await allRows<{ at: number; agent_name: string | null; server_id: string; server_title: string | null; server_name: string | null }>(
    db,
    `SELECT f.created_at AS at, COALESCE(a.name, f.agent_name) AS agent_name, f.server_id, s.title AS server_title, s.name AS server_name
     FROM mcp_fetch_audit f
     LEFT JOIN agents a ON a.id = f.agent_id
     LEFT JOIN mcp_servers s ON s.id = f.server_id
     ORDER BY f.created_at DESC LIMIT ${ACTIVITY_LIMIT}`,
  );
  return rows.map((row) => {
    const actor = row.agent_name ?? "未知 Agent";
    // 权限不足被拒的调用（server_id = "denied:<工具名>"）单独文案。
    const deniedTool = deniedToolName(row.server_id);
    if (deniedTool) {
      return { at: row.at, module: "mcp", module_label: "MCP", actor, text: `调用「${deniedTool}」时权限不足，被拒绝` };
    }
    const server = row.server_title || row.server_name || "未知服务";
    return { at: row.at, module: "mcp", module_label: "MCP", actor, text: `取用了「${server}」的配置` };
  });
}

async function calendarActivity(db: D1Database, agentNames: Map<string, string>): Promise<ActivityItem[]> {
  const rows = await allRows<{ at: number; actor: string; action: string; event_title: string | null }>(
    db,
    `SELECT au.created_at AS at, au.actor, au.action, e.title AS event_title
     FROM calendar_audit au
     LEFT JOIN events e ON e.id = au.event_id
     ORDER BY au.created_at DESC LIMIT ${ACTIVITY_LIMIT}`,
  );
  const verbs: Record<string, string> = { create: "新建了日程", update: "修改了日程", delete: "删除了日程" };
  return rows.map((row) => ({
    at: row.at,
    module: "calendar",
    module_label: "日历",
    actor: actorLabel(row.actor, agentNames),
    text: `${verbs[row.action] ?? "操作了日程"}${quoted(row.event_title)}`,
  }));
}

async function taskActivity(db: D1Database, agentNames: Map<string, string>): Promise<ActivityItem[]> {
  const rows = await allRows<{ at: number; actor: string; action: string; task_title: string | null; diff_json: string | null }>(
    db,
    `SELECT au.created_at AS at, au.actor, au.action, t.title AS task_title, au.diff_json
     FROM task_audit au
     LEFT JOIN tasks t ON t.id = au.task_id
     ORDER BY au.created_at DESC LIMIT ${ACTIVITY_LIMIT}`,
  );
  const verbs: Record<string, string> = {
    create: "新建了任务",
    update: "更新了任务",
    delete: "删除了任务",
    complete: "完成了任务",
    list: "查看了任务列表",
  };
  return rows.map((row) => {
    const title = row.action === "list" ? null : row.task_title ?? diffTitle(row.diff_json);
    return {
      at: row.at,
      module: "tasks",
      module_label: "任务",
      actor: actorLabel(row.actor, agentNames),
      text: `${verbs[row.action] ?? "操作了任务"}${quoted(title)}`,
    };
  });
}

async function memoryActivity(db: D1Database, agentNames: Map<string, string>): Promise<ActivityItem[]> {
  const rows = await allRows<{ at: number; actor: string; action: string; diff_json: string | null }>(
    db,
    `SELECT created_at AS at, actor, action, diff_json FROM memory_audit ORDER BY created_at DESC LIMIT ${ACTIVITY_LIMIT}`,
  );
  const verbs: Record<string, string> = {
    create: "新建了记忆",
    update: "更新了记忆",
    delete: "删除了记忆",
    get: "读取了记忆",
    list: "查看了记忆列表",
    search: "搜索了记忆",
  };
  return rows.map((row) => {
    const title = row.action === "list" || row.action === "search" ? null : diffTitle(row.diff_json);
    return {
      at: row.at,
      module: "memory",
      module_label: "记忆",
      actor: actorLabel(row.actor, agentNames),
      text: `${verbs[row.action] ?? "操作了记忆"}${quoted(title)}`,
    };
  });
}

async function soulActivity(db: D1Database, agentNames: Map<string, string>): Promise<ActivityItem[]> {
  const rows = await allRows<{ at: number; actor: string; action: string; agent_name: string | null }>(
    db,
    `SELECT created_at AS at, actor, action, agent_name FROM soul_audit ORDER BY created_at DESC LIMIT ${ACTIVITY_LIMIT}`,
  );
  const verbs: Record<string, string> = {
    create: "新建了 Soul",
    update: "更新了 Soul",
    rollback: "回滚了 Soul",
    delete: "删除了 Soul",
    read: "读取了 Soul",
  };
  return rows.map((row) => ({
    at: row.at,
    module: "soul",
    module_label: "Soul",
    actor: actorLabel(row.actor, agentNames),
    text: row.agent_name ? `${verbs[row.action] ?? "操作了 Soul"}（${row.agent_name}）` : (verbs[row.action] ?? "操作了 Soul"),
  }));
}

async function machineActivity(db: D1Database, agentNames: Map<string, string>): Promise<ActivityItem[]> {
  const rows = await allRows<{ at: number; actor: string; action: string; machine_name: string | null }>(
    db,
    `SELECT au.created_at AS at, au.actor, au.action, m.name AS machine_name
     FROM machines_audit au
     LEFT JOIN machines m ON m.id = au.machine_id
     ORDER BY au.created_at DESC LIMIT ${ACTIVITY_LIMIT}`,
  );
  const verbs: Record<string, string> = {
    create: "新建了机器",
    update: "更新了机器",
    delete: "删除了机器",
    report: "上报了机器状态",
    get: "查看了机器",
  };
  return rows.map((row) => ({
    at: row.at,
    module: "machines",
    module_label: "云主机",
    actor: actorLabel(row.actor, agentNames),
    text: `${verbs[row.action] ?? "操作了机器"}${quoted(row.machine_name)}`,
  }));
}

// ---- alerts ------------------------------------------------------------------

async function buildAlerts(db: D1Database, now: number): Promise<AlertItem[]> {
  const alerts: AlertItem[] = [];

  const brokenMirrors = await allRows<{ name: string; sync_error: string | null; last_sync_at: number | null }>(
    db,
    "SELECT name, sync_error, last_sync_at FROM calendars WHERE kind = 'mirror' AND sync_status = 'error' ORDER BY last_sync_at ASC",
  );
  for (const cal of brokenMirrors) {
    const reason = cal.sync_error ? `：${cal.sync_error.slice(0, 80)}` : "";
    alerts.push({ kind: "calendar_sync", text: `镜像日历「${cal.name}」同步失败${reason}`, at: cal.last_sync_at });
  }

  const disabledAgents = await allRows<{ name: string }>(
    db,
    "SELECT name FROM agents WHERE status = 'disabled' ORDER BY name ASC",
  );
  for (const agent of disabledAgents) {
    alerts.push({ kind: "agent_disabled", text: `Agent「${agent.name}」已停用`, at: null });
  }

  const staleTasks = await allRows<{ title: string; updated_at: number }>(
    db,
    "SELECT title, updated_at FROM tasks WHERE status = 'active' AND updated_at < ? ORDER BY updated_at ASC",
    [now - 7 * DAY_MS],
  );
  for (const task of staleTasks) {
    alerts.push({ kind: "task_stale", text: `任务「${task.title}」进行中超过 7 天没有进展`, at: task.updated_at });
  }

  alerts.push(...(await buildBackupAlerts(db)));

  return alerts;
}

// 备份类条目只取摘要，最多两条，按失败/从未/配置异常/成功的优先级截断。
async function buildBackupAlerts(db: D1Database): Promise<AlertItem[]> {
  const [schedule, targets] = await Promise.all([readBackupSchedule(db), readPublicTargets(db)]);
  const summary = schedule.last_summary;
  const configuredCount = Object.values(targets).filter((target) => target?.configured).length;
  const alerts: AlertItem[] = [];

  if (summary && summary["ok"] === false) {
    const reason = backupError(summary, schedule.last_error);
    alerts.push({
      kind: "backup_failed",
      text: `上次备份失败 · ${backupTargetName(summary)}${reason ? `：${reason}` : ""}`,
      at: backupAt(summary),
    });
  }

  if (!summary && configuredCount > 0) {
    alerts.push({ kind: "backup_never", text: "尚未进行过备份", at: null });
  }

  const autoTarget = schedule.target;
  if (schedule.auto_enabled && (!autoTarget || !targets[autoTarget]?.enabled)) {
    alerts.push({ kind: "backup_auto_invalid", text: "自动备份已开启，但目标不可用", at: null });
  }

  if (summary && summary["ok"] === true) {
    const files = summary["files"];
    const suffix = typeof files === "number" && files >= 0 ? ` · ${files} 个文件` : "";
    alerts.push({
      kind: "backup_ok",
      text: `最近一次备份成功 · ${backupTargetName(summary)}${suffix}`,
      at: backupAt(summary),
    });
  }

  return alerts.slice(0, BACKUP_ALERT_LIMIT);
}

function backupTargetName(summary: Record<string, unknown>): string {
  const target = summary["target"];
  return isTargetId(target) ? targetLabel(target) : "备份目标";
}

function backupAt(summary: Record<string, unknown>): number | null {
  const at = summary["at"];
  return typeof at === "number" && Number.isFinite(at) && at > 0 ? at : null;
}

function backupError(summary: Record<string, unknown>, lastError: string): string {
  const raw = typeof summary["error"] === "string" ? summary["error"] : "";
  const error = (raw || lastError).trim();
  return error.length > BACKUP_ERROR_MAX ? `${error.slice(0, BACKUP_ERROR_MAX)}…` : error;
}
