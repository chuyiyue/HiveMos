// Unified read-only aggregation over every module's audit / access-log
// table. One merged, time-descending stream powers the overview page's
// 调用记录 tab (all boards) and the per-agent record section inside the
// agent manage dialog (agent_id filter).
//
// Tolerance rule (same as overview-http): a source table that is missing
// or fails to read degrades to "skipped" and is reported in `degraded`;
// it never fails the whole response.
//
// Sources and their boards:
//   mcp_fetch_audit  MCP 与 Skills — agent took an MCP config / Skill body
//   calendar_audit   日历          — event create/update/delete (incl. mirror sync)
//   task_audit       任务          — task lifecycle
//   memory_audit     记忆          — memory reads and writes
//   soul_audit       Soul          — soul reads and writes
//   machines_audit   云计算资源    — machine ops, credential reveals/fetches
//   agents_audit     Agents 与应用 — panel-side agent management (create /
//                                    update / delete / rotate / permissions /
//                                    token_reveal; actor is always the admin,
//                                    the agent is the target)
//   vault_access_log 保险库        — secret reveals (actor is always the admin)
//   sessions         登录          — live admin sessions (one row per login;
//                                    rows vanish on revoke/expiry, so this is
//                                    a live view, not a durable audit trail)
//
// Boards with no audit table at all (app management operations,
// panel-side MCP/Skills/API edits, vault entry edits, settings changes)
// simply never appear here; nothing is fabricated for them.

import type { D1Database } from "./env";

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
  { key: "agents", label: "Agents 与应用" },
  { key: "mcp", label: "MCP 与 Skills" },
  { key: "calendar", label: "日历" },
  { key: "tasks", label: "任务" },
  { key: "memory", label: "记忆" },
  { key: "soul", label: "Soul" },
  { key: "machines", label: "云计算资源" },
  { key: "vault", label: "保险库" },
  { key: "login", label: "登录" },
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
// filter is set, sources whose rows carry an actor/agent column filter in
// SQL; sources without an actor (vault, login) are skipped entirely.

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
  const where = agentId ? "WHERE au.actor = ?" : "";
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
  const where = agentId ? "WHERE au.actor = ?" : "";
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
  const where = agentId ? "WHERE actor = ?" : "";
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
  const where = agentId ? "WHERE au.actor = ?" : "";
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
  const where = agentId ? "WHERE au.actor = ?" : "";
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

const vaultRecords: Fetcher = async (db, _agentNames, agentId, need) => {
  // vault_access_log has no actor column: every reveal is the admin in the
  // panel, so an agent filter excludes this source completely.
  if (agentId) return { rows: [], ok: true };
  const { rows, ok } = await allRows<{
    id: string; at: number; target_kind: string; target_id: string; action: string; target_name: string | null;
  }>(
    db,
    `SELECT l.id, l.created_at AS at, l.target_kind, l.target_id, l.action,
            CASE l.target_kind
              WHEN 'entry' THEN (SELECT name FROM vault_entries WHERE id = l.target_id)
              WHEN 'gateway' THEN (SELECT name FROM gateways WHERE id = l.target_id)
            END AS target_name
     FROM vault_access_log l
     ORDER BY l.created_at DESC, l.id DESC LIMIT ?`,
    [need],
  );
  return {
    ok,
    rows: rows.map((row) => {
      const target = row.target_name || "未知条目";
      const isGateway = row.target_kind === "gateway";
      return {
        ...base("vault"),
        id: `vault:${row.id}`,
        at: row.at,
        actor: "管理员",
        actor_id: null,
        action: row.action,
        action_label: "查看明文",
        target,
        target_id: row.target_id,
        text: isGateway ? `查看了网关「${target}」的密钥明文` : `查看了「${target}」的密码明文`,
      };
    }),
  };
};

const loginRecords: Fetcher = async (db, _agentNames, agentId, need) => {
  // Sessions carry no agent actor; excluded from per-agent views.
  if (agentId) return { rows: [], ok: true };
  const { rows, ok } = await allRows<{ id: string; at: number; user_agent: string | null }>(
    db,
    "SELECT id, created_at AS at, user_agent FROM sessions ORDER BY created_at DESC LIMIT ?",
    [need],
  );
  return {
    ok,
    rows: rows.map((row) => {
      const ua = row.user_agent ? row.user_agent.slice(0, 80) : null;
      return {
        ...base("login"),
        id: `login:${row.id}`,
        at: row.at,
        actor: "管理员",
        actor_id: null,
        action: "login",
        action_label: "登录",
        target: ua,
        target_id: null,
        text: ua ? `登录了面板（${ua}）` : "登录了面板",
      };
    }),
  };
};


const agentMgmtRecords: Fetcher = async (db, _agentNames, agentId, need) => {
  // agents_audit rows are ABOUT an agent (the admin is the actor), so the
  // agentId filter matches the subject agent: a per-agent view shows the
  // management trail for that agent.
  const where = agentId ? "WHERE au.agent_id = ?" : "";
  const binds: Array<string | number> = agentId ? [agentId, need] : [need];
  const { rows, ok } = await allRows<{
    id: string; at: number; agent_id: string; action: string; agent_name: string | null;
  }>(
    db,
    `SELECT au.id, au.created_at AS at, au.agent_id, au.action,
            a.name AS agent_name
     FROM agents_audit au
     LEFT JOIN agents a ON a.id = au.agent_id
     ${where}
     ORDER BY au.created_at DESC, au.id DESC LIMIT ?`,
    binds,
  );
  const labels: Record<string, string> = {
    create: "创建 Agent",
    update: "修改 Agent",
    delete: "删除 Agent",
    rotate: "轮换密钥",
    permissions: "修改权限",
    token_reveal: "复制密钥",
  };
  const verbs: Record<string, string> = {
    create: "创建了 Agent",
    update: "修改了 Agent",
    delete: "删除了 Agent",
    rotate: "轮换了密钥",
    permissions: "修改了权限",
    token_reveal: "复制了密钥（查看令牌明文）",
  };
  return {
    ok,
    rows: rows.map((row) => {
      const target = row.agent_name || "已删除的 Agent";
      return {
        ...base("agents"),
        id: `agents:${row.id}`,
        at: row.at,
        actor: "管理员",
        actor_id: null,
        action: row.action,
        action_label: labels[row.action] ?? row.action,
        target,
        target_id: row.agent_id,
        text: `${verbs[row.action] ?? row.action}「${target}」`,
      };
    }),
  };
};

const FETCHERS: Record<string, Fetcher> = {
  agents: agentMgmtRecords,
  mcp: mcpRecords,
  calendar: calendarRecords,
  tasks: taskRecords,
  memory: memoryRecords,
  soul: soulRecords,
  machines: machineRecords,
  vault: vaultRecords,
  login: loginRecords,
};

export function isRecordModule(key: string): boolean {
  return key in FETCHERS;
}

// ---- merged listing -----------------------------------------------------------

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
  return {
    records: merged.slice(offset, offset + limit),
    has_more: merged.length > offset + limit,
    degraded,
  };
}
