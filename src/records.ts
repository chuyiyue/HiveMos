// Unified read-only aggregation over the modules' audit tables, powering
// the overview page's 调用记录 tab and the per-agent record section inside
// the agent manage dialog (agent_id filter).
//
// This feed is strictly the Agent/MCP side: only rows an agent caused
// through the MCP tools appear here. Everything the admin does in the
// panel lives in user_ops instead （系统日志 tab, src/oplog.ts). Sources
// tell the two apart as follows:
//   mcp_fetch_audit  MCP 与 Skills — written by the agent read paths
//                    (fetchConfigForAgent / getSkillForAgent) and by the
//                    permission-denied path (server_id prefixed "denied:");
//                    no panel writer exists, so rows are kept as-is
//   calendar_audit   日历          — the actor column discriminates:
//   task_audit       任务            panel writes actor 'user', MCP writes
//   memory_audit     记忆            the agent id, calendar mirror sync
//   soul_audit       Soul            writes 'mirror-sync'; only rows whose
//                    actor is an agent id are kept
//   machines_audit   云计算资源    — has an explicit source column
//                    ('panel' | 'mcp'); only 'mcp' rows are kept
//
// Panel-only sources are not read here at all: agents_audit (its actor is
// always the admin managing agents), vault_access_log (it has no actor
// column and every reveal is the admin in the panel) and sessions (admin
// logins).
//
// Tolerance rule (same as overview-http): a source table that is missing
// or fails to read degrades to "skipped" and is reported in `degraded`;
// it never fails the whole response.

import type { D1Database } from "./env";
import { deniedToolName } from "./registry";

export interface RecordItem {
  id: string;
  at: number;
  module: string;
  module_label: string;
  actor: string;
  actor_id: string | null;
  action: string;
  action_label: string;
  target: string | null;
  target_id: string | null;
  text: string;
}

export interface RecordModule {
  key: string;
  label: string;
}

export const RECORD_MODULES: RecordModule[] = [
  { key: "mcp", label: "MCP 与 Skills" },
  { key: "calendar", label: "日历" },
  { key: "tasks", label: "任务" },
  { key: "memory", label: "记忆" },
  { key: "soul", label: "Soul" },
  { key: "machines", label: "云计算资源" },
];

const MODULE_LABEL = new Map(RECORD_MODULES.map((m) => [m.key, m.label]));

export interface ListRecordsOptions {
  module?: string | null;
  agentId?: string | null;
  limit: number;
  offset: number;
}

export interface ListRecordsResult {
  records: RecordItem[];
  has_more: boolean;
  degraded: string[];
  total: number | null;
}

// ---- tolerant query helpers -------------------------------------------------

interface QueryOutcome<T> {
  rows: T[];
  ok: boolean;
}

async function allRows<T>(db: D1Database, sql: string, binds: Array<string | number> = []): Promise<QueryOutcome<T>> {
  try {
    const result = await db.prepare(sql).bind(...binds).all<T>();
    const rows = Array.isArray(result) ? result : result.results ?? [];
    return { rows, ok: true };
  } catch {
    return { rows: [], ok: false };
  }
}

async function loadAgentNames(db: D1Database): Promise<Map<string, string>> {
  const { rows } = await allRows<{ id: string; name: string }>(db, "SELECT id, name FROM agents");
  return new Map(rows.map((row) => [row.id, row.name]));
}

function actorInfo(actor: string, agentNames: Map<string, string>): { label: string; actorId: string | null } {
  if (actor === "user") return { label: "管理员", actorId: null };
  if (actor === "mirror-sync") return { label: "镜像同步", actorId: null };
  const name = agentNames.get(actor);
  if (name) return { label: name, actorId: actor };
  if (actor.startsWith("agt_")) return { label: "已删除的 Agent", actorId: actor };
  return { label: actor, actorId: null };
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

function base(module: string): { module: string; module_label: string } {
  return { module, module_label: MODULE_LABEL.get(module) ?? module };
}

// ---- per-source fetchers ------------------------------------------------------
// Each fetcher returns up to `need` rows, newest first. When an agentId
// filter is set, sources filter to that agent in SQL; otherwise they
// filter to agent-caused rows only (see the source notes above).

type Fetcher = (
  db: D1Database,
  agentNames: Map<string, string>,
  agentId: string | null,
  need: number,
) => Promise<QueryOutcome<RecordItem>>;

const mcpRecords: Fetcher = async (db, _agentNames, agentId, need) => {
  const where = agentId ? "WHERE f.agent_id = ?" : "";
  const binds: Array<string | number> = agentId ? [agentId, need] : [need];
  const { rows, ok } = await allRows<{
    id: string; at: number; agent_id: string; server_id: string;
    agent_name: string | null; server_title: string | null; server_name: string | null; skill_name: string | null;
  }>(
    db,
    `SELECT f.id, f.created_at AS at, f.agent_id, f.server_id,
            a.name AS agent_name, s.title AS server_title, s.name AS server_name, k.name AS skill_name
     FROM mcp_fetch_audit f
     LEFT JOIN agents a ON a.id = f.agent_id
     LEFT JOIN mcp_servers s ON s.id = f.server_id
     LEFT JOIN skills k ON k.id = f.server_id
     ${where}
     ORDER BY f.created_at DESC LIMIT ?`,
    binds,
  );
  return {
    ok,
    rows: rows.map((row) => {
      // 权限不足被拒的调用也落在 mcp_fetch_audit，server_id 带保留前缀
      // "denied:<工具名>"（见 registry.ts 的 recordToolDenied），这里单独
      // 渲染成「调用被拒」，不当作一次取用。
      const deniedTool = deniedToolName(row.server_id);
      if (deniedTool) {
        return {
          ...base("mcp"),
          id: `mcp:${row.id}`,
          at: row.at,
          actor: row.agent_name ?? "未知 Agent",
          actor_id: row.agent_id,
          action: "denied",
          action_label: "调用被拒",
          target: deniedTool,
          target_id: null,
          text: `调用「${deniedTool}」时权限不足，被拒绝`,
        };
      }
      const isSkill = !row.server_name && !row.server_title && !!row.skill_name;
      const target = row.server_title || row.server_name || row.skill_name || "未知服务";
      return {
        ...base("mcp"),
        id: `mcp:${row.id}`,
        at: row.at,
        actor: row.agent_name ?? "未知 Agent",
        actor_id: row.agent_id,
        action: "fetch",
        action_label: isSkill ? "取用 Skill" : "取用配置",
        target,
        target_id: row.server_id,
        text: isSkill ? `取用了 Skill「${target}」的内容` : `取用了「${target}」的配置`,
      };
    }),
  };
};

const calendarRecords: Fetcher = async (db, agentNames, agentId, need) => {
  const where = agentId ? "WHERE au.actor = ?" : "WHERE substr(au.actor, 1, 4) = 'agt_'";
  const binds: Array<string | number> = agentId ? [agentId, need] : [need];
  const { rows, ok } = await allRows<{
    id: string; at: number; actor: string; action: string; event_id: string | null; calendar_id: string | null;
    diff_json: string | null; event_title: string | null; calendar_name: string | null;
  }>(
    db,
    `SELECT au.id, au.created_at AS at, au.actor, au.action, au.event_id, au.calendar_id, au.diff_json,
            e.title AS event_title, c.name AS calendar_name
     FROM calendar_audit au
     LEFT JOIN events e ON e.id = au.event_id
     LEFT JOIN calendars c ON c.id = au.calendar_id
     ${where}
     ORDER BY au.created_at DESC LIMIT ?`,
    binds,
  );
  const verbs: Record<string, string> = { create: "新建了日程", update: "修改了日程", delete: "删除了日程" };
  const labels: Record<string, string> = { create: "新建日程", update: "修改日程", delete: "删除日程" };
  return {
    ok,
    rows: rows.map((row) => {
      const info = actorInfo(row.actor, agentNames);
      const target = row.event_title ?? diffTitle(row.diff_json) ?? row.calendar_name;
      return {
        ...base("calendar"),
        id: `calendar:${row.id}`,
        at: row.at,
        actor: info.label,
        actor_id: info.actorId,
        action: row.action,
        action_label: labels[row.action] ?? "操作日程",
        target,
        target_id: row.event_id ?? row.calendar_id,
        text: `${verbs[row.action] ?? "操作了日程"}${quoted(target)}`,
      };
    }),
  };
};

const taskRecords: Fetcher = async (db, agentNames, agentId, need) => {
  const where = agentId ? "WHERE au.actor = ?" : "WHERE substr(au.actor, 1, 4) = 'agt_'";
  const binds: Array<string | number> = agentId ? [agentId, need] : [need];
  const { rows, ok } = await allRows<{
    id: string; at: number; actor: string; action: string; task_id: string | null;
    task_title: string | null; diff_json: string | null;
  }>(
    db,
    `SELECT au.id, au.created_at AS at, au.actor, au.action, au.task_id,
            t.title AS task_title, au.diff_json
     FROM task_audit au
     LEFT JOIN tasks t ON t.id = au.task_id
     ${where}
     ORDER BY au.created_at DESC LIMIT ?`,
    binds,
  );
  const verbs: Record<string, string> = {
    create: "新建了任务", update: "更新了任务", delete: "删除了任务", complete: "完成了任务", list: "查看了任务列表",
  };
  const labels: Record<string, string> = {
    create: "新建任务", update: "更新任务", delete: "删除任务", complete: "完成任务", list: "查看列表",
  };
  return {
    ok,
    rows: rows.map((row) => {
      const info = actorInfo(row.actor, agentNames);
      const target = row.action === "list" ? null : row.task_title ?? diffTitle(row.diff_json);
      return {
        ...base("tasks"),
        id: `tasks:${row.id}`,
        at: row.at,
        actor: info.label,
        actor_id: info.actorId,
        action: row.action,
        action_label: labels[row.action] ?? "操作任务",
        target,
        target_id: row.task_id,
        text: `${verbs[row.action] ?? "操作了任务"}${quoted(target)}`,
      };
    }),
  };
};

const memoryRecords: Fetcher = async (db, agentNames, agentId, need) => {
  const where = agentId ? "WHERE actor = ?" : "WHERE substr(actor, 1, 4) = 'agt_'";
  const binds: Array<string | number> = agentId ? [agentId, need] : [need];
  const { rows, ok } = await allRows<{
    id: string; at: number; actor: string; action: string; memory_id: string | null; diff_json: string | null;
  }>(
    db,
    `SELECT id, created_at AS at, actor, action, memory_id, diff_json FROM memory_audit
     ${where}
     ORDER BY created_at DESC LIMIT ?`,
    binds,
  );
  const verbs: Record<string, string> = {
    create: "新建了记忆", update: "更新了记忆", delete: "删除了记忆",
    get: "读取了记忆", list: "查看了记忆列表", search: "搜索了记忆",
  };
  const labels: Record<string, string> = {
    create: "新建记忆", update: "更新记忆", delete: "删除记忆",
    get: "读取记忆", list: "查看列表", search: "搜索记忆",
  };
  return {
    ok,
    rows: rows.map((row) => {
      const info = actorInfo(row.actor, agentNames);
      const target = row.action === "list" || row.action === "search" ? null : diffTitle(row.diff_json);
      return {
        ...base("memory"),
        id: `memory:${row.id}`,
        at: row.at,
        actor: info.label,
        actor_id: info.actorId,
        action: row.action,
        action_label: labels[row.action] ?? "操作记忆",
        target,
        target_id: row.memory_id,
        text: `${verbs[row.action] ?? "操作了记忆"}${quoted(target)}`,
      };
    }),
  };
};

const soulRecords: Fetcher = async (db, agentNames, agentId, need) => {
  const where = agentId ? "WHERE au.actor = ?" : "WHERE substr(au.actor, 1, 4) = 'agt_'";
  const binds: Array<string | number> = agentId ? [agentId, need] : [need];
  const { rows, ok } = await allRows<{
    id: string; at: number; actor: string; action: string; soul_id: string | null;
    agent_name: string | null; soul_agent: string | null; version: number | null;
  }>(
    db,
    `SELECT au.id, au.created_at AS at, au.actor, au.action, au.soul_id, au.agent_name,
            s.agent_name AS soul_agent, au.version
     FROM soul_audit au
     LEFT JOIN souls s ON s.id = au.soul_id
     ${where}
     ORDER BY au.created_at DESC LIMIT ?`,
    binds,
  );
  const verbs: Record<string, string> = {
    create: "新建了 Soul", update: "更新了 Soul", rollback: "回滚了 Soul", delete: "删除了 Soul", read: "读取了 Soul",
  };
  const labels: Record<string, string> = {
    create: "新建 Soul", update: "更新 Soul", rollback: "回滚 Soul", delete: "删除 Soul", read: "读取 Soul",
  };
  return {
    ok,
    rows: rows.map((row) => {
      const info = actorInfo(row.actor, agentNames);
      const target = row.soul_agent ?? row.agent_name;
      return {
        ...base("soul"),
        id: `soul:${row.id}`,
        at: row.at,
        actor: info.label,
        actor_id: info.actorId,
        action: row.action,
        action_label: labels[row.action] ?? "操作 Soul",
        target,
        target_id: row.soul_id,
        text: target ? `${verbs[row.action] ?? "操作了 Soul"}（${target}）` : (verbs[row.action] ?? "操作了 Soul"),
      };
    }),
  };
};

const machineRecords: Fetcher = async (db, agentNames, agentId, need) => {
  // machines_audit rows carry an explicit source: panel operations write
  // 'panel', MCP tool calls write 'mcp'. Only the MCP side belongs here.
  const where = agentId ? "WHERE au.actor = ?" : "WHERE au.source = 'mcp'";
  const binds: Array<string | number> = agentId ? [agentId, need] : [need];
  const { rows, ok } = await allRows<{
    id: string; at: number; actor: string; action: string; machine_id: string | null; machine_name: string | null;
  }>(
    db,
    `SELECT au.id, au.created_at AS at, au.actor, au.action, au.machine_id, m.name AS machine_name
     FROM machines_audit au
     LEFT JOIN machines m ON m.id = au.machine_id
     ${where}
     ORDER BY au.created_at DESC LIMIT ?`,
    binds,
  );
  const verbs: Record<string, string> = {
    create: "新建了机器", update: "更新了机器", delete: "删除了机器", report: "上报了机器状态",
    get: "查看了机器", reveal: "查看了机器密码", workers_list: "查看了 Workers 列表", access_fetch: "取用了接入凭据",
  };
  const labels: Record<string, string> = {
    create: "新建机器", update: "更新机器", delete: "删除机器", report: "上报状态",
    get: "查看机器", reveal: "查看密码", workers_list: "查看 Workers", access_fetch: "取用凭据",
  };
  return {
    ok,
    rows: rows.map((row) => {
      const info = actorInfo(row.actor, agentNames);
      return {
        ...base("machines"),
        id: `machines:${row.id}`,
        at: row.at,
        actor: info.label,
        actor_id: info.actorId,
        action: row.action,
        action_label: labels[row.action] ?? "操作机器",
        target: row.machine_name,
        target_id: row.machine_id,
        text: `${verbs[row.action] ?? "操作了机器"}${quoted(row.machine_name)}`,
      };
    }),
  };
};

const FETCHERS: Record<string, Fetcher> = {
  mcp: mcpRecords,
  calendar: calendarRecords,
  tasks: taskRecords,
  memory: memoryRecords,
  soul: soulRecords,
  machines: machineRecords,
};

export function isRecordModule(key: string): boolean {
  return key in FETCHERS;
}

// ---- merged listing -----------------------------------------------------------

async function countRows(db: D1Database, sql: string, binds: Array<string | number>): Promise<number> {
  const row = await db.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

// Per-source totals mirroring each fetcher's WHERE clause, so the panel
// can paginate with an exact 共 N 条.
const COUNTERS: Record<string, (db: D1Database, agentId: string | null) => Promise<number>> = {
  mcp: (db, agentId) =>
    countRows(db, `SELECT COUNT(*) AS n FROM mcp_fetch_audit f${agentId ? " WHERE f.agent_id = ?" : ""}`, agentId ? [agentId] : []),
  calendar: (db, agentId) =>
    countRows(db, `SELECT COUNT(*) AS n FROM calendar_audit au WHERE ${agentId ? "au.actor = ?" : "substr(au.actor, 1, 4) = 'agt_'"}`, agentId ? [agentId] : []),
  tasks: (db, agentId) =>
    countRows(db, `SELECT COUNT(*) AS n FROM task_audit au WHERE ${agentId ? "au.actor = ?" : "substr(au.actor, 1, 4) = 'agt_'"}`, agentId ? [agentId] : []),
  memory: (db, agentId) =>
    countRows(db, `SELECT COUNT(*) AS n FROM memory_audit WHERE ${agentId ? "actor = ?" : "substr(actor, 1, 4) = 'agt_'"}`, agentId ? [agentId] : []),
  soul: (db, agentId) =>
    countRows(db, `SELECT COUNT(*) AS n FROM soul_audit au WHERE ${agentId ? "au.actor = ?" : "substr(au.actor, 1, 4) = 'agt_'"}`, agentId ? [agentId] : []),
  machines: (db, agentId) =>
    countRows(db, `SELECT COUNT(*) AS n FROM machines_audit au WHERE ${agentId ? "au.actor = ?" : "au.source = 'mcp'"}`, agentId ? [agentId] : []),
};

export async function listRecords(db: D1Database, options: ListRecordsOptions): Promise<ListRecordsResult> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit) || 30));
  const offset = Math.max(0, Math.floor(options.offset) || 0);
  const need = offset + limit;
  const agentId = options.agentId || null;
  const keys = options.module && isRecordModule(options.module)
    ? [options.module]
    : RECORD_MODULES.map((m) => m.key);
  const agentNames = await loadAgentNames(db);
  const outcomes = await Promise.all(keys.map((key) => FETCHERS[key](db, agentNames, agentId, need)));
  const degraded: string[] = [];
  const merged: RecordItem[] = [];
  outcomes.forEach((outcome, index) => {
    if (!outcome.ok) degraded.push(keys[index]);
    merged.push(...outcome.rows);
  });
  merged.sort((a, b) => (b.at - a.at) || (a.module < b.module ? -1 : a.module > b.module ? 1 : 0) || (a.id < b.id ? 1 : -1));
  let total: number | null = null;
  try {
    const counts = await Promise.all(keys.map((key) => COUNTERS[key](db, agentId)));
    total = counts.reduce((sum, n) => sum + n, 0);
  } catch {
    total = null;
  }
  return {
    records: merged.slice(offset, offset + limit),
    has_more: merged.length > offset + limit,
    degraded,
    total,
  };
}
