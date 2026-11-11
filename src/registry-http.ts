// Admin REST for the registry. The caller has already checked the session.

import { isCrossSite, json } from "./http";
import { getSidebarPinLimit } from "./settings";
import type { Env, WaitCtx } from "./env";
import {
  clearAgentAvatar,
  createAgent,
  createGroup,
  createServer,
  deleteGroup,
  deleteServer,
  deleteAgent,
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
  reorderGroups,
  setAgentAvatar,
  rotateAgentToken,
  saveManualSnapshot,
  updateAgent,
  updateServer,
} from "./registry";
import { logOp, panelActor } from "./oplog";

const MAX_BODY_BYTES = 256 * 1024;

const GROUP_SCOPE_LABELS: Record<string, string> = { agent: "Agent", mcp: "MCP", machines: "云主机" };

async function findGroup(env: Env, id: string): Promise<{ scope: string; name: string } | null> {
  for (const scope of ["agent", "mcp", "machines"]) {
    try {
      const groups = await listGroups(env.DB, scope);
      const found = groups.find((group) => group.id === id);
      if (found) return { scope: found.scope, name: found.name };
    } catch {
      // A scope that fails to read just is not where this group lives.
    }
  }
  return null;
}

export async function handleRegistryRequest(request: Request, env: Env, ctx: WaitCtx, path: string): Promise<Response | null> {
  if (path === "/api/mcp-servers") return mcpCollection(request, env, ctx);
  const refresh = /^\/api\/mcp-servers\/([A-Za-z0-9_-]+)\/refresh-snapshot$/.exec(path);
  if (refresh && refresh[1]) return refreshOne(request, env, ctx, refresh[1]);
  const server = /^\/api\/mcp-servers\/([A-Za-z0-9_-]+)$/.exec(path);
  if (server && server[1]) return mcpOne(request, env, ctx, server[1]);
  if (path === "/api/mcp-audit") return audit(request, env);
  if (path === "/api/groups") return groupCollection(request, env);
  if (path === "/api/groups/reorder") return groupReorder(request, env);
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
    if (created.ok) {
      const name = created.server.title || created.server.name;
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "MCP",
        action: "添加",
        targetId: created.server.id,
        targetName: name,
        text: `添加了 MCP「${name}」`,
      });
    }
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
      const saved = await saveManualSnapshot(env, ctx, id, raw);
      if (saved.ok) {
        const name = saved.server.title || saved.server.name;
        await logOp(env.DB, {
          actor: await panelActor(request, env),
          module: "MCP",
          action: "修改",
          targetId: id,
          targetName: name,
          text: `保存了 MCP「${name}」的快照`,
        });
      }
      return serverResponse(saved, false);
    }
    const updated = await updateServer(env, ctx, id, body.value);
    if (updated.ok) {
      const name = updated.server.title || updated.server.name;
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "MCP",
        action: "修改",
        targetId: id,
        targetName: name,
        text: `修改了 MCP「${name}」`,
      });
    }
    return serverResponse(updated, false);
  }
  if (method === "DELETE") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const before = await readPublicServer(env.DB, id).catch(() => null);
    const removed = await deleteServer(env.DB, id);
    if (!removed.ok) return json({ ok: false, error: removed.error }, removed.status);
    const name = before ? before.title || before.name : id;
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "MCP",
      action: "删除",
      targetId: id,
      targetName: name,
      text: `删除了 MCP「${name}」`,
    });
    return json({ ok: true });
  }
  return methodNotAllowed("GET, PUT, DELETE");
}

async function refreshOne(request: Request, env: Env, ctx: WaitCtx, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  const refreshed = await refreshServerSnapshot(env, ctx, id, null);
  if (refreshed.ok) {
    const name = refreshed.server.title || refreshed.server.name;
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "MCP",
      action: "同步",
      targetId: id,
      targetName: name,
      text: `刷新了 MCP「${name}」的快照`,
    });
  }
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
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "Agent",
      action: "添加",
      targetId: created.agent.id,
      targetName: created.agent.name,
      text: `添加了 Agent「${created.agent.name}」`,
    });
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
    const value = (body.value ?? {}) as Record<string, unknown>;
    const name = updated.agent.name;
    let action = "修改";
    let text = `修改了 Agent「${name}」`;
    if ("pinned" in value) {
      action = value.pinned ? "固定" : "取消固定";
      text = value.pinned ? `把 Agent「${name}」固定到侧边栏` : `取消了 Agent「${name}」的固定`;
    } else if ("status" in value) {
      action = value.status === "active" ? "启用" : "停用";
      text = `${action}了 Agent「${name}」`;
    } else if ("permissions" in value) {
      text = `修改了 Agent「${name}」的权限`;
    } else if ("vault_guide_enabled" in value) {
      text = value.vault_guide_enabled ? `开启了 Agent「${name}」的指引技能` : `关闭了 Agent「${name}」的指引技能`;
    } else if ("avatar_icon" in value || "avatar_url" in value) {
      text = `更换了 Agent「${name}」的头像`;
    } else if ("name" in value) {
      text = `把 Agent 改名为「${name}」`;
    }
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "Agent",
      action,
      targetId: id,
      targetName: name,
      text,
    });
    return json({ ok: true, agent: updated.agent });
  }
  if (method === "DELETE") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const listed = await listAgents(env.DB).catch(() => null);
    const before = listed?.find((agent) => agent.id === id);
    if (!before) return json({ ok: false, error: "未找到" }, 404);
    const name = before.name;
    // The system log is written BEFORE the row disappears, so the deleted
    // agent's name stays on record (target_name + text both carry it).
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "Agent",
      action: "删除",
      targetId: id,
      targetName: name,
      text: `删除了 Agent「${name}」`,
    });
    const deleted = await deleteAgent(env.DB, id);
    if (!deleted.ok) return json({ ok: false, error: deleted.error }, deleted.status);
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
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "Agent",
      action: "修改",
      targetId: id,
      targetName: saved.agent.name,
      text: `更换了 Agent「${saved.agent.name}」的头像`,
    });
    return json({ ok: true, agent: saved.agent });
  }
  if (method === "DELETE") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const cleared = await clearAgentAvatar(env.DB, id);
    if (!cleared.ok) return json({ ok: false, error: cleared.error }, cleared.status);
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "Agent",
      action: "修改",
      targetId: id,
      targetName: cleared.agent.name,
      text: `把 Agent「${cleared.agent.name}」的头像恢复默认`,
    });
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
  const listed = await listAgents(env.DB).catch(() => null);
  const name = listed?.find((agent) => agent.id === id)?.name ?? id;
  await logOp(env.DB, {
    actor: await panelActor(request, env),
    module: "Agent",
    action: "查看",
    targetId: id,
    targetName: name,
    text: `复制了 Agent「${name}」的密钥`,
  });
  return json({ ok: true, token: revealed.token });
}

async function agentRotate(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  const rotated = await rotateAgentToken(env, id);
  if (!rotated.ok) return json({ ok: false, error: rotated.error }, rotated.status);
  await logOp(env.DB, {
    actor: await panelActor(request, env),
    module: "Agent",
    action: "轮换密钥",
    targetId: id,
    targetName: rotated.agent.name,
    text: `轮换了 Agent「${rotated.agent.name}」的密钥`,
  });
  return json({ ok: true, agent: rotated.agent, token: rotated.token });
}

function readScope(request: Request, value: unknown): string | null {
  const fromQuery = new URL(request.url).searchParams.get("scope");
  if (fromQuery === "agent" || fromQuery === "mcp" || fromQuery === "machines") return fromQuery;
  if (value && typeof value === "object") {
    const scope = (value as { scope?: unknown }).scope;
    if (scope === "agent" || scope === "mcp" || scope === "machines") return scope;
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
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "分组",
      action: "添加",
      targetId: created.group.id,
      targetName: created.group.name,
      text: `添加了${GROUP_SCOPE_LABELS[created.group.scope] ?? created.group.scope}分组「${created.group.name}」`,
    });
    return json({ ok: true, group: created.group }, 201);
  }
  return methodNotAllowed("GET, POST");
}

async function groupReorder(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const scope = readScope(request, body.value);
  if (!scope) return json({ ok: false, error: "scope 不正确" }, 400);
  const reordered = await reorderGroups(env.DB, scope, body.value);
  if (!reordered.ok) return json({ ok: false, error: reordered.error }, reordered.status);
  await logOp(env.DB, {
    actor: await panelActor(request, env),
    module: "分组",
    action: "修改",
    text: `调整了${GROUP_SCOPE_LABELS[scope] ?? scope}分组顺序`,
  });
  return json({ ok: true });
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
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "分组",
      action: "修改",
      targetId: id,
      targetName: renamed.group.name,
      text: `把${GROUP_SCOPE_LABELS[renamed.group.scope] ?? renamed.group.scope}分组改名为「${renamed.group.name}」`,
    });
    return json({ ok: true, group: renamed.group });
  }
  if (method === "DELETE") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const before = await findGroup(env, id);
    const removed = await deleteGroup(env.DB, id);
    if (!removed.ok) return json({ ok: false, error: removed.error }, removed.status);
    const name = before?.name ?? id;
    const scopeLabel = before ? GROUP_SCOPE_LABELS[before.scope] ?? before.scope : "";
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "分组",
      action: "删除",
      targetId: id,
      targetName: name,
      text: `删除了${scopeLabel}分组「${name}」`,
    });
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
