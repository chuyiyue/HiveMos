// Panel REST for the extras board: apps （应用页签）, skills and apis
// (Skills / API 页签）. The caller in index.ts has already checked the
// admin session; writes pass the same cross-site mutation gate as the
// registry routes.

import { isCrossSite, json, readJsonLimited } from "./http";
import type { Env, WaitCtx } from "./env";
import {
  createApi,
  createApp,
  createSkill,
  deleteApi,
  deleteApp,
  deleteSkill,
  ExtraError,
  listApis,
  listApps,
  listSkills,
  updateApi,
  updateApp,
  updateSkill,
} from "./extras";

const MAX_BODY_BYTES = 64 * 1024;

export async function handleExtrasRequest(request: Request, env: Env, ctx: WaitCtx, path: string): Promise<Response | null> {
  void ctx;
  if (path === "/api/extras/apps") return appsCollection(request, env);
  if (path === "/api/extras/skills") return skillsCollection(request, env);
  if (path === "/api/extras/apis") return apisCollection(request, env);
  const app = /^\/api\/extras\/apps\/([A-Za-z0-9_-]+)$/.exec(path);
  if (app && app[1]) return appOne(request, env, app[1]);
  const skill = /^\/api\/extras\/skills\/([A-Za-z0-9_-]+)$/.exec(path);
  if (skill && skill[1]) return skillOne(request, env, skill[1]);
  const apiRow = /^\/api\/extras\/apis\/([A-Za-z0-9_-]+)$/.exec(path);
  if (apiRow && apiRow[1]) return apiOne(request, env, apiRow[1]);
  return null;
}

function wrap(handler: () => Promise<Response>): Promise<Response> {
  return handler().catch((error: unknown) => {
    if (error instanceof ExtraError) return json({ ok: false, error: error.message }, error.status);
    return json({ ok: false, error: "暂时无法读写这些条目。请确认已经创建 D1 并应用迁移" }, 503);
  });
}

async function mutationGate(request: Request): Promise<Response | null> {
  if (isCrossSite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  return null;
}

function methodNotAllowed(allow: string): Response {
  return json({ ok: false, error: "方法不允许" }, 405, { allow });
}

async function readBody(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const body = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!body.ok) return { ok: false, response: json({ ok: false, error: body.error }, body.status) };
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
    return { ok: false, response: json({ ok: false, error: "请求格式不正确" }, 400) };
  }
  return { ok: true, value: body.value as Record<string, unknown> };
}

function groupFilter(request: Request): string | null {
  const value = new URL(request.url).searchParams.get("group_id");
  return value ? value : null;
}

// ---------------------------------------------------------------------------
// Apps

async function appsCollection(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return wrap(async () => json({ ok: true, apps: await listApps(env.DB) }));
  }
  if (method === "POST") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => json({ ok: true, app: await createApp(env.DB, body.value, Date.now()) }, 201));
  }
  return methodNotAllowed("GET, POST");
}

async function appOne(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => json({ ok: true, app: await updateApp(env.DB, id, body.value, Date.now()) }));
  }
  if (method === "DELETE") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    return wrap(async () => {
      await deleteApp(env.DB, id);
      return json({ ok: true });
    });
  }
  return methodNotAllowed("PATCH, DELETE");
}

// ---------------------------------------------------------------------------
// Skills

async function skillsCollection(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    const groupId = groupFilter(request);
    return wrap(async () => json({ ok: true, skills: await listSkills(env.DB, groupId) }));
  }
  if (method === "POST") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => json({ ok: true, skill: await createSkill(env.DB, body.value, Date.now()) }, 201));
  }
  return methodNotAllowed("GET, POST");
}

async function skillOne(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => json({ ok: true, skill: await updateSkill(env.DB, id, body.value, Date.now()) }));
  }
  if (method === "DELETE") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    return wrap(async () => {
      await deleteSkill(env.DB, id);
      return json({ ok: true });
    });
  }
  return methodNotAllowed("PATCH, DELETE");
}

// ---------------------------------------------------------------------------
// APIs

async function apisCollection(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    const groupId = groupFilter(request);
    return wrap(async () => json({ ok: true, apis: await listApis(env.DB, groupId) }));
  }
  if (method === "POST") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => json({ ok: true, api: await createApi(env.DB, body.value, Date.now()) }, 201));
  }
  return methodNotAllowed("GET, POST");
}

async function apiOne(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => json({ ok: true, api: await updateApi(env.DB, id, body.value, Date.now()) }));
  }
  if (method === "DELETE") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    return wrap(async () => {
      await deleteApi(env.DB, id);
      return json({ ok: true });
    });
  }
  return methodNotAllowed("PATCH, DELETE");
}
