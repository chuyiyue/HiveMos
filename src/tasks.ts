// Tasks module: work items passed between the panel and agents. Panel REST
// (tasks-http.ts) and the tasks_* MCP tools share this core so validation,
// status transitions and audit can never drift apart. Every mutation writes
// a task_audit row; MCP list reads are audited too, mirroring the registry
// rule that an agent fetching data leaves a trace.

import type { D1Database } from "./env";
import { prepare } from "./registry";

export class TaskError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const TASK_STATUSES = ["queued", "active", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskRow {
  id: string;
  title: string;
  note: string | null;
  status: string;
  assignee: string | null;
  from_label: string | null;
  source: string;
  ai_status: string | null;
  ai_summary: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface PublicTask {
  id: string;
  title: string;
  note: string | null;
  status: string;
  assignee: string | null;
  from: string | null;
  source: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const TITLE_MAX = 200;
const NOTE_MAX = 2000;
const LABEL_MAX = 64;
const LIST_LIMIT = 200;

function rowsOf<T>(value: { results?: T[] } | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.results)) return value.results;
  return [];
}

function newId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return prefix + hex;
}

export function toIso(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

export function taskPublic(row: TaskRow): PublicTask {
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    status: row.status,
    assignee: row.assignee,
    from: row.from_label,
    source: row.source,
    created_at: toIso(row.created_at) as string,
    updated_at: toIso(row.updated_at) as string,
    completed_at: toIso(row.completed_at),
  };
}

async function audit(
  db: D1Database,
  fields: { taskId: string | null; actor: string; action: string; diff: unknown },
  now: number,
): Promise<void> {
  await prepare(db, "INSERT INTO task_audit (id, task_id, actor, action, diff_json, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    newId("aud_"),
    fields.taskId,
    fields.actor,
    fields.action,
    fields.diff == null ? null : JSON.stringify(fields.diff),
    now,
  ]).run();
}

function readTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TaskError(400, "请填写标题");
  const title = value.trim();
  if (title.length > TITLE_MAX) throw new TaskError(400, "标题过长");
  return title;
}

function readOptionalText(value: unknown, max: number, label: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new TaskError(400, "请求格式不正确");
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) throw new TaskError(400, label + "过长");
  return text;
}

function readStatus(value: unknown): TaskStatus {
  if (typeof value !== "string" || !(TASK_STATUSES as readonly string[]).includes(value)) {
    throw new TaskError(400, "状态不正确，只能是 queued、active 或 done");
  }
  return value as TaskStatus;
}

export async function getTask(db: D1Database, id: string): Promise<TaskRow | null> {
  return prepare(db, "SELECT * FROM tasks WHERE id = ?", [id]).first<TaskRow>();
}

export async function listTasks(
  db: D1Database,
  filter: { status?: string | null; assignee?: string | null },
): Promise<TaskRow[]> {
  const status = filter.status ? readStatus(filter.status) : null;
  const clauses: string[] = [];
  const values: Array<string | number | null> = [];
  if (status) {
    clauses.push("status = ?");
    values.push(status);
  }
  if (filter.assignee) {
    clauses.push("assignee = ?");
    values.push(filter.assignee);
  }
  const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
  const listed = await prepare(
    db,
    "SELECT * FROM tasks" + where + " ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT " + LIST_LIMIT,
    values,
  ).all<TaskRow>();
  return rowsOf(listed);
}

export async function listTasksForAgent(
  db: D1Database,
  filter: { status?: string | null; assignee?: string | null },
  actor: string,
  now: number,
): Promise<TaskRow[]> {
  const tasks = await listTasks(db, filter);
  await audit(db, { taskId: null, actor, action: "list", diff: { status: filter.status ?? null, assignee: filter.assignee ?? null, count: tasks.length } }, now);
  return tasks;
}

export async function agentName(db: D1Database, agentId: string): Promise<string | null> {
  const row = await prepare(db, "SELECT name FROM agents WHERE id = ?", [agentId]).first<{ name: string }>();
  return row?.name ?? null;
}

export async function createTask(
  db: D1Database,
  input: Record<string, unknown>,
  actor: string,
  source: "panel" | "agent",
  now: number,
): Promise<TaskRow> {
  const title = readTitle(input.title);
  const note = readOptionalText(input.note, NOTE_MAX, "备注");
  const assignee = readOptionalText(input.assignee, LABEL_MAX, "分配对象");
  const fromLabel = readOptionalText(input.from, LABEL_MAX, "来源") ?? (source === "panel" ? "管理员" : null);
  const status = input.status == null ? "queued" : readStatus(input.status);
  const id = newId("task_");
  await prepare(
    db,
    "INSERT INTO tasks (id, title, note, status, assignee, from_label, source, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, title, note, status, assignee, fromLabel, source, now, now, status === "done" ? now : null],
  ).run();
  const row = await getTask(db, id);
  if (!row) throw new TaskError(500, "任务创建失败");
  await audit(db, { taskId: id, actor, action: "create", diff: { title, status, assignee } }, now);
  return row;
}

export async function updateTask(
  db: D1Database,
  id: string,
  input: Record<string, unknown>,
  actor: string,
  now: number,
): Promise<TaskRow> {
  const existing = await getTask(db, id);
  if (!existing) throw new TaskError(404, "任务不存在");
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  const changed: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(input, "title")) {
    const title = readTitle(input.title);
    sets.push("title = ?");
    values.push(title);
    changed.title = title;
  }
  if (Object.prototype.hasOwnProperty.call(input, "note")) {
    const note = readOptionalText(input.note, NOTE_MAX, "备注");
    sets.push("note = ?");
    values.push(note);
    changed.note = note;
  }
  if (Object.prototype.hasOwnProperty.call(input, "assignee")) {
    const assignee = readOptionalText(input.assignee, LABEL_MAX, "分配对象");
    sets.push("assignee = ?");
    values.push(assignee);
    changed.assignee = assignee;
  }
  if (Object.prototype.hasOwnProperty.call(input, "from")) {
    const fromLabel = readOptionalText(input.from, LABEL_MAX, "来源");
    sets.push("from_label = ?");
    values.push(fromLabel);
    changed.from = fromLabel;
  }
  let completedAt = existing.completed_at;
  if (Object.prototype.hasOwnProperty.call(input, "status")) {
    const status = readStatus(input.status);
    sets.push("status = ?");
    values.push(status);
    changed.status = status;
    completedAt = status === "done" ? (existing.completed_at ?? now) : null;
    sets.push("completed_at = ?");
    values.push(completedAt);
  }
  sets.push("updated_at = ?");
  values.push(now);
  values.push(id);
  await prepare(db, "UPDATE tasks SET " + sets.join(", ") + " WHERE id = ?", values).run();
  const row = await getTask(db, id);
  if (!row) throw new TaskError(500, "任务更新失败");
  const action = changed.status === "done" && existing.status !== "done" ? "complete" : "update";
  await audit(db, { taskId: id, actor, action, diff: changed }, now);
  return row;
}

export async function completeTask(
  db: D1Database,
  id: string,
  actor: string,
  now: number,
): Promise<TaskRow> {
  const existing = await getTask(db, id);
  if (!existing) throw new TaskError(404, "任务不存在");
  if (existing.status === "done") return existing;
  await prepare(db, "UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?", [now, now, id]).run();
  const row = await getTask(db, id);
  if (!row) throw new TaskError(500, "任务更新失败");
  await audit(db, { taskId: id, actor, action: "complete", diff: { status: "done" } }, now);
  return row;
}

export async function deleteTask(
  db: D1Database,
  id: string,
  actor: string,
  now: number,
): Promise<void> {
  const existing = await getTask(db, id);
  if (!existing) throw new TaskError(404, "任务不存在");
  await prepare(db, "DELETE FROM tasks WHERE id = ?", [id]).run();
  await audit(db, { taskId: id, actor, action: "delete", diff: { title: existing.title, status: existing.status } }, now);
}
