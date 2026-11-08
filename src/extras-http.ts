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
import { logOp, panelActor } from "./oplog";

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
    return wrap(async () => {
      const created = await createApp(env.DB, body.value, Date.now());
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "应用",
        action: "添加",
        targetId: created.id,
        targetName: created.name,
        text: `添加了应用「${created.name}」`,
      });
      return json({ ok: true, app: created }, 201);
    });
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
    return wrap(async () => {
      const updated = await updateApp(env.DB, id, body.value, Date.now());
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "应用",
        action: "修改",
        targetId: id,
        targetName: updated.name,
        text: `修改了应用「${updated.name}」`,
      });
      return json({ ok: true, app: updated });
    });
  }
  if (method === "DELETE") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    return wrap(async () => {
      const before = (await listApps(env.DB)).find((row) => row.id === id);
      await deleteApp(env.DB, id);
      const name = before?.name ?? id;
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "应用",
        action: "删除",
        targetId: id,
        targetName: name,
        text: `删除了应用「${name}」`,
      });
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
    return wrap(async () => {
      const created = await createSkill(env.DB, body.value, Date.now());
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "Skills",
        action: "添加",
        targetId: created.id,
        targetName: created.name,
        text: `添加了Skills「${created.name}」`,
      });
      return json({ ok: true, skill: created }, 201);
    });
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
    return wrap(async () => {
      const updated = await updateSkill(env.DB, id, body.value, Date.now());
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "Skills",
        action: "修改",
        targetId: id,
        targetName: updated.name,
        text: `修改了Skills「${updated.name}」`,
      });
      return json({ ok: true, skill: updated });
    });
  }
  if (method === "DELETE") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    return wrap(async () => {
      const before = (await listSkills(env.DB, null)).find((row) => row.id === id);
      await deleteSkill(env.DB, id);
      const name = before?.name ?? id;
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "Skills",
        action: "删除",
        targetId: id,
        targetName: name,
        text: `删除了Skills「${name}」`,
      });
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
    return wrap(async () => {
      const created = await createApi(env.DB, body.value, Date.now());
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "API",
        action: "添加",
        targetId: created.id,
        targetName: created.name,
        text: `添加了API「${created.name}」`,
      });
      return json({ ok: true, api: created }, 201);
    });
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
    return wrap(async () => {
      const updated = await updateApi(env.DB, id, body.value, Date.now());
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "API",
        action: "修改",
        targetId: id,
        targetName: updated.name,
        text: `修改了API「${updated.name}」`,
      });
      return json({ ok: true, api: updated });
    });
  }
  if (method === "DELETE") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    return wrap(async () => {
      const before = (await listApis(env.DB, null)).find((row) => row.id === id);
      await deleteApi(env.DB, id);
      const name = before?.name ?? id;
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "API",
        action: "删除",
        targetId: id,
        targetName: name,
        text: `删除了API「${name}」`,
      });
      return json({ ok: true });
    });
  }
  return methodNotAllowed("PATCH, DELETE");
}
