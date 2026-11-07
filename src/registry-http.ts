// Admin REST for the registry. The caller has already checked the session.

import { isCrossSite, json } from "./http";
import type { Env, WaitCtx } from "./env";
import {
  createAgent,
  createServer,
  deleteServer,
  disableAgent,
  listAgents,
  listAudit,
  listServers,
  readPublicServer,
  refreshServerSnapshot,
  saveManualSnapshot,
  updateServer,
} from "./registry";

const MAX_BODY_BYTES = 256 * 1024;

export async function handleRegistryRequest(request: Request, env: Env, ctx: WaitCtx, path: string): Promise<Response | null> {
  if (path === "/api/mcp-servers") return mcpCollection(request, env, ctx);
  const refresh = /^\/api\/mcp-servers\/([A-Za-z0-9_-]+)\/refresh-snapshot$/.exec(path);
  if (refresh && refresh[1]) return refreshOne(request, env, ctx, refresh[1]);
  const server = /^\/api\/mcp-servers\/([A-Za-z0-9_-]+)$/.exec(path);
  if (server && server[1]) return mcpOne(request, env, ctx, server[1]);
  if (path === "/api/mcp-audit") return audit(request, env);
  if (path === "/api/agents") return agentCollection(request, env);
  const agent = /^\/api\/agents\/([A-Za-z0-9_-]+)$/.exec(path);
  if (agent && agent[1]) return agentOne(request, env, agent[1]);
  return null;
}

async function mcpCollection(request: Request, env: Env, ctx: WaitCtx): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    try {
      return json({ ok: true, servers: await listServers(env.DB) });
    } catch {
      return dbError();
    }
  }
  if (method === "POST") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const created = await createServer(env, ctx, body.value);
    return serverResponse(created, true);
  }
  return methodNotAllowed("GET, POST");
}

async function mcpOne(request: Request, env: Env, ctx: WaitCtx, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    try {
      const server = await readPublicServer(env.DB, id);
      if (!server) return json({ ok: false, error: "未找到" }, 404);
      return json({ ok: true, server });
    } catch {
      return dbError();
    }
  }
  if (method === "PUT") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readJson(request);
    if (!body.ok) return body.response;
    if (isManualSnapshot(body.value)) {
      const raw = (body.value as { snapshot_json?: unknown }).snapshot_json;
      return serverResponse(await saveManualSnapshot(env, ctx, id, raw), false);
    }
    return serverResponse(await updateServer(env, ctx, id, body.value), false);
  }
  if (method === "DELETE") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const removed = await deleteServer(env.DB, id);
    if (!removed.ok) return json({ ok: false, error: removed.error }, removed.status);
    return json({ ok: true });
  }
  return methodNotAllowed("GET, PUT, DELETE");
}

async function refreshOne(request: Request, env: Env, ctx: WaitCtx, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  const refreshed = await refreshServerSnapshot(env, ctx, id, null);
  return serverResponse(refreshed, false);
}

async function audit(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
  try {
    return json({ ok: true, audit: await listAudit(env.DB) });
  } catch {
    return dbError();
  }
}

async function agentCollection(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    try {
      return json({ ok: true, agents: await listAgents(env.DB) });
    } catch {
      return dbError();
    }
  }
  if (method === "POST") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const created = await createAgent(env.DB, body.value);
    if (!created.ok) return json({ ok: false, error: created.error }, created.status);
    return json({ ok: true, agent: created.agent }, 201);
  }
  return methodNotAllowed("GET, POST");
}

async function agentOne(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "DELETE") return methodNotAllowed("DELETE");
  const gate = await mutationGate(request);
  if (gate) return gate;
  const disabled = await disableAgent(env.DB, id);
  if (!disabled.ok) return json({ ok: false, error: disabled.error }, disabled.status);
  return json({ ok: true });
}

function isManualSnapshot(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { name?: unknown; snapshot_json?: unknown };
  return !("name" in record) && typeof record.snapshot_json === "string";
}

function serverResponse(
  result: { ok: true; server: unknown; probe_error?: string } | { ok: false; status: number; error: string; server?: unknown },
  created: boolean,
): Response {
  if (!result.ok) return json({ ok: false, error: result.error, server: result.server }, result.status);
  return json({ ok: true, server: result.server, probe_error: result.probe_error }, created ? 201 : 200);
}

function dbError(): Response {
  return json({ ok: false, error: "暂时无法读写注册表。请确认已经创建 D1 并应用迁移" }, 503);
}

async function mutationGate(request: Request): Promise<Response | null> {
  if (isCrossSite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  return null;
}

function methodNotAllowed(allow: string): Response {
  return json({ ok: false, error: "方法不允许" }, 405, { allow });
}

async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0 || length > MAX_BODY_BYTES) {
      return { ok: false, response: json({ ok: false, error: "请求格式不正确" }, 400) };
    }
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: json({ ok: false, error: "请求格式不正确" }, 400) };
  }
  if (text.length > MAX_BODY_BYTES) return { ok: false, response: json({ ok: false, error: "请求格式不正确" }, 400) };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: json({ ok: false, error: "请求格式不正确" }, 400) };
  }
}
