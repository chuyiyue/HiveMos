// Admin REST for the registry. The caller has already checked the session.

import { isCrossSite, json } from "./http";
import { getSidebarPinLimit } from "./accounts";
import type { Env, WaitCtx } from "./env";
import {
  clearAgentAvatar,
  createAgent,
  createGroup,
  createServer,
  deleteGroup,
  deleteServer,
  disableAgent,
  listAgents,
  listAudit,
  listGroups,
  listServers,
  listSidebarAgents,
  readPublicServer,
  getAgentAvatar,
  revealAgentToken,
  refreshServerSnapshot,
  renameGroup,
  setAgentAvatar,
  rotateAgentToken,
  saveManualSnapshot,
  updateAgent,
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
  if (path === "/api/groups") return groupCollection(request, env);
  const group = /^\/api\/groups\/([A-Za-z0-9_-]+)$/.exec(path);
  if (group && group[1]) return groupOne(request, env, group[1]);
  if (path === "/api/sidebar/agents") return sidebarAgents(request, env);
  if (path === "/api/agents") return agentCollection(request, env);
  const reveal = /^\/api\/agents\/([A-Za-z0-9_-]+)\/reveal-token$/.exec(path);
  if (reveal && reveal[1]) return agentRevealToken(request, env, reveal[1]);
  const rotate = /^\/api\/agents\/([A-Za-z0-9_-]+)\/rotate$/.exec(path);
  if (rotate && rotate[1]) return agentRotate(request, env, rotate[1]);
  const avatar = /^\/api\/agents\/([A-Za-z0-9_-]+)\/avatar$/.exec(path);
  if (avatar && avatar[1]) return agentAvatar(request, env, avatar[1]);
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

async function sidebarAgents(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
  try {
    const limit = await getSidebarPinLimit(env.DB);
    return json({ ok: true, limit, agents: await listSidebarAgents(env.DB, limit) });
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
    const created = await createAgent(env, body.value);
    if (!created.ok) return json({ ok: false, error: created.error }, created.status);
    return json({ ok: true, agent: created.agent }, 201);
  }
  return methodNotAllowed("GET, POST");
}

async function agentOne(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const updated = await updateAgent(env.DB, id, body.value);
    if (!updated.ok) return json({ ok: false, error: updated.error }, updated.status);
    return json({ ok: true, agent: updated.agent });
  }
  if (method === "DELETE") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const disabled = await disableAgent(env.DB, id);
    if (!disabled.ok) return json({ ok: false, error: disabled.error }, disabled.status);
    return json({ ok: true });
  }
  return methodNotAllowed("PATCH, DELETE");
}

// Uploaded avatars are capped well above what the 128x128 picker export
// produces, so a full-size photo can never land in D1 by accident.
const MAX_AVATAR_BYTES = 200 * 1024;

function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "image/webp";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  return null;
}

async function agentAvatar(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    try {
      const image = await getAgentAvatar(env.DB, id);
      if (!image) return json({ ok: false, error: "未找到" }, 404);
      return new Response(image.data, {
        status: 200,
        headers: {
          "content-type": image.content_type,
          "content-length": String(image.data.byteLength),
          "cache-control": "private, no-cache",
        },
      });
    } catch {
      return dbError();
    }
  }
  if (method === "POST") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const declared = Number(request.headers.get("content-length") || "0");
    if (Number.isFinite(declared) && declared > MAX_AVATAR_BYTES) {
      return json({ ok: false, error: "图片超过 200 KB 上限" }, 413);
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await request.arrayBuffer());
    } catch {
      return json({ ok: false, error: "请求格式不正确" }, 400);
    }
    if (bytes.length === 0) return json({ ok: false, error: "图片为空" }, 400);
    if (bytes.length > MAX_AVATAR_BYTES) return json({ ok: false, error: "图片超过 200 KB 上限" }, 413);
    const type = sniffImageType(bytes);
    if (!type) return json({ ok: false, error: "只支持 PNG、JPEG、WebP 或 GIF 图片" }, 400);
    const saved = await setAgentAvatar(env.DB, id, type, bytes);
    if (!saved.ok) return json({ ok: false, error: saved.error }, saved.status);
    return json({ ok: true, agent: saved.agent });
  }
  if (method === "DELETE") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const cleared = await clearAgentAvatar(env.DB, id);
    if (!cleared.ok) return json({ ok: false, error: cleared.error }, cleared.status);
    return json({ ok: true, agent: cleared.agent });
  }
  return methodNotAllowed("GET, POST, DELETE");
}
async function agentRevealToken(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  const revealed = await revealAgentToken(env, id);
  if (!revealed.ok) return json({ ok: false, error: revealed.error }, revealed.status);
  return json({ ok: true, token: revealed.token });
}

async function agentRotate(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  const rotated = await rotateAgentToken(env, id);
  if (!rotated.ok) return json({ ok: false, error: rotated.error }, rotated.status);
  return json({ ok: true, agent: rotated.agent, token: rotated.token });
}

function readScope(request: Request, value: unknown): string | null {
  const fromQuery = new URL(request.url).searchParams.get("scope");
  if (fromQuery === "agent" || fromQuery === "mcp") return fromQuery;
  if (value && typeof value === "object") {
    const scope = (value as { scope?: unknown }).scope;
    if (scope === "agent" || scope === "mcp") return scope;
  }
  return null;
}

async function groupCollection(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    const scope = readScope(request, null);
    if (!scope) return json({ ok: false, error: "scope 不正确" }, 400);
    try {
      return json({ ok: true, groups: await listGroups(env.DB, scope) });
    } catch {
      return dbError();
    }
  }
  if (method === "POST") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const scope = readScope(request, body.value);
    if (!scope) return json({ ok: false, error: "scope 不正确" }, 400);
    const created = await createGroup(env.DB, scope, body.value);
    if (!created.ok) return json({ ok: false, error: created.error }, created.status);
    return json({ ok: true, group: created.group }, 201);
  }
  return methodNotAllowed("GET, POST");
}

async function groupOne(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const renamed = await renameGroup(env.DB, id, body.value);
    if (!renamed.ok) return json({ ok: false, error: renamed.error }, renamed.status);
    return json({ ok: true, group: renamed.group });
  }
  if (method === "DELETE") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const removed = await deleteGroup(env.DB, id);
    if (!removed.ok) return json({ ok: false, error: removed.error }, removed.status);
    return json({ ok: true });
  }
  return methodNotAllowed("PATCH, DELETE");
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
