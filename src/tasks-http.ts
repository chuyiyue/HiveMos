// Panel REST for the tasks board. Routes sit behind the admin session gate
// (the caller in index.ts has already authenticated); non-GET requests also
// pass the cross-site check, same as the registry and calendar panels.

import { isCrossSite, json, readJsonLimited } from "./http";
import type { Env, WaitCtx } from "./env";
import {
  TaskError,
  completeTask,
  createTask,
  deleteTask,
  listTasks,
  taskPublic,
  updateTask,
} from "./tasks";

const MAX_BODY_BYTES = 64 * 1024;
const ACTOR = "user";

export async function handleTasksRequest(request: Request, env: Env, ctx: WaitCtx, path: string): Promise<Response | null> {
  void ctx;
  if (request.method.toUpperCase() !== "GET" && isCrossSite(request)) {
    return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  }
  if (path === "/api/tasks") return collection(request, env);
  const complete = /^\/api\/tasks\/([A-Za-z0-9_-]+)\/complete$/.exec(path);
  if (complete && complete[1]) return completeOne(request, env, complete[1]);
  const one = /^\/api\/tasks\/([A-Za-z0-9_-]+)$/.exec(path);
  if (one && one[1]) return taskOne(request, env, one[1]);
  return null;
}

function wrap(handler: () => Promise<Response>): Promise<Response> {
  return handler().catch((error: unknown) => {
    if (error instanceof TaskError) return json({ ok: false, error: error.message }, error.status);
    return json({ ok: false, error: "暂时无法读写任务。请确认已经创建 D1 并应用迁移" }, 503);
  });
}

async function readBody(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const body = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!body.ok) return { ok: false, response: json({ ok: false, error: body.error }, body.status) };
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
    return { ok: false, response: json({ ok: false, error: "请求格式不正确" }, 400) };
  }
  return { ok: true, value: body.value as Record<string, unknown> };
}

function methodNotAllowed(allow: string): Response {
  return json({ ok: false, error: "方法不允许" }, 405, { allow });
}

async function collection(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const assignee = url.searchParams.get("assignee");
    return wrap(async () => {
      const tasks = await listTasks(env.DB, { status, assignee });
      return json({ ok: true, tasks: tasks.map(taskPublic) });
    });
  }
  if (method === "POST") {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => {
      const created = await createTask(env.DB, body.value, ACTOR, "panel", Date.now());
      return json({ ok: true, task: taskPublic(created) }, 201);
    });
  }
  return methodNotAllowed("GET, POST");
}

async function taskOne(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH") {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => {
      const updated = await updateTask(env.DB, id, body.value, ACTOR, Date.now());
      return json({ ok: true, task: taskPublic(updated) });
    });
  }
  if (method === "DELETE") {
    return wrap(async () => {
      await deleteTask(env.DB, id, ACTOR, Date.now());
      return json({ ok: true });
    });
  }
  return methodNotAllowed("PATCH, DELETE");
}

async function completeOne(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  return wrap(async () => {
    const completed = await completeTask(env.DB, id, ACTOR, Date.now());
    return json({ ok: true, task: taskPublic(completed) });
  });
}
