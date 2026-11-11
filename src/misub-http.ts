// MiSub 瘦客户端的 REST 路由（云计算资源「代理」页）。
// index.ts 已做过管理员会话校验；写操作在这里补跨站检查，口径与其它模块一致。
//
// Routes:
//   GET    /api/misub                          只读快照（未配置时 configured:false，追加 connections 与 active_id）
//   GET    /api/misub?meta=1                   不出站元信息：configured、config、connections、active_id、vault_key_state
//   POST   /api/misub/test                     用提交的地址+令牌测一次连接（不保存）
//   GET    /api/misub/connections              列表：{ connections, active_id, vault_key_state }
//   POST   /api/misub/connections              新增，201 返回 { connection, connections, active_id }
//   PATCH  /api/misub/connections/:id          更新，返回同上形状
//   DELETE /api/misub/connections/:id          删除，返回 { connections, active_id }
//   POST   /api/misub/connections/:id/activate 设为当前，返回 { connections, active_id }
//   POST   /api/misub/connections/:id/test     测已存连接并回写状态，返回 { connection }
//   PUT    /api/misub/config                   保存配置（兼容旧 API：有当前连接时更新、无连接时新建并设为当前）
//   PATCH  /api/misub/config                   只改「触发刷新」开关（兼容旧 API：改当前连接）
//   DELETE /api/misub/config                   清空配置（兼容旧 API：只删当前连接）
//   POST   /api/misub/manual-nodes/:id/reveal  显示节点的服务器与链接（先写审计）
//   POST   /api/misub/profiles/:id/refresh     触发订阅组刷新（开关打开时）

import { isCrossSite, json, readJsonLimited } from "./http";
import type { Env } from "./env";
import { logOp, panelActor } from "./oplog";
import {
  MisubError,
  activateMisubConnection,
  addMisubConnection,
  clearMisubConfig,
  deleteMisubConnection,
  getMisubConnection,
  getMisubSnapshot,
  listMisubConnections,
  misubVaultKeyState,
  normalizeMisubBaseUrl,
  readMisubConfig,
  refreshMisubProfile,
  resolveMisubTestToken,
  revealMisubManualNode,
  saveMisubConfig,
  setMisubRefreshEnabled,
  testMisubConnection,
  testMisubConnectionById,
  testMisubConnectionTemp,
  updateMisubConnection,
} from "./misub";

const MAX_BODY_BYTES = 16 * 1024;

export async function handleMisubRequest(request: Request, env: Env, path: string): Promise<Response | null> {
  // 精确匹配优先
  if (path === "/api/misub") return snapshot(request, env);
  if (path === "/api/misub/test") return testConnection(request, env);
  if (path === "/api/misub/config") return configRoute(request, env);
  if (path === "/api/misub/connections") return connectionsRoute(request, env);
  if (path === "/api/misub/connections/") return connectionsRoute(request, env);

  // 带参数的路由
  const connIdMatch = /^\/api\/misub\/connections\/([A-Za-z0-9_-]+)$/.exec(path);
  if (connIdMatch && connIdMatch[1]) return connectionByIdRoute(request, env, connIdMatch[1]);

  const activateMatch = /^\/api\/misub\/connections\/([A-Za-z0-9_-]+)\/activate$/.exec(path);
  if (activateMatch && activateMatch[1]) return activateConnection(request, env, activateMatch[1]);

  const testMatch = /^\/api\/misub\/connections\/([A-Za-z0-9_-]+)\/test$/.exec(path);
  if (testMatch && testMatch[1]) return testConnectionById(request, env, testMatch[1]);

  const reveal = /^\/api\/misub\/manual-nodes\/([A-Za-z0-9_-]+)\/reveal$/.exec(path);
  if (reveal && reveal[1]) return revealNode(request, env, reveal[1]);

  const refresh = /^\/api\/misub\/profiles\/([A-Za-z0-9_-]+)\/refresh$/.exec(path);
  if (refresh && refresh[1]) return refreshProfile(request, env, refresh[1]);

  if (path === "/api/misub" || path.startsWith("/api/misub/")) {
    return json({ ok: false, error: "未找到" }, 404);
  }
  return null;
}

function methodNotAllowed(allow: string): Response {
  return json({ ok: false, error: "方法不允许" }, 405, { allow });
}

// 统一把 MisubError 归一成面板条幅用的 { ok:false, error }，其余异常按
// 数据库/环境不可用兜底。
function wrap(handler: () => Promise<Response>): Promise<Response> {
  return Promise.resolve()
    .then(handler)
    .catch((error: unknown) => {
      if (error instanceof MisubError) return json({ ok: false, error: error.message }, error.status);
      return json({ ok: false, error: "暂时无法读取 MiSub 状态" }, 503);
    });
}

async function mutationGate(request: Request): Promise<Response | null> {
  if (isCrossSite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  return null;
}

async function readBody(
  request: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const body = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!body.ok) return { ok: false, response: json({ ok: false, error: body.error }, body.status) };
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
    return { ok: false, response: json({ ok: false, error: "请求格式不正确" }, 400) };
  }
  return { ok: true, value: body.value as Record<string, unknown> };
}

// GET /api/misub            快照（追加 connections 与 active_id）
// GET /api/misub?meta=1     不出站元信息
async function snapshot(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
  const url = new URL(request.url);
  const metaOnly = url.searchParams.get("meta") === "1";
  const fresh = url.searchParams.get("fresh") === "1";

  const config = await readMisubConfig(env.DB).catch(() => null);
  const vaultState = misubVaultKeyState(env);

  if (!config) {
    if (metaOnly) {
      const { connections, active_id } = await listMisubConnections(env.DB).catch(() => ({ connections: [], active_id: "" }));
      return json({ ok: true, configured: false, config: null, connections, active_id, vault_key_state: vaultState });
    }
    return json({ ok: true, configured: false, vault_key_state: vaultState });
  }

  if (metaOnly) {
    return wrap(async () => {
      const data = await getMisubSnapshot(env, fresh);
      const { connections, active_id } = await listMisubConnections(env.DB);
      return json({ ok: true, configured: true, config: data.config, connections, active_id, vault_key_state: vaultState });
    });
  }

  return wrap(async () => {
    const data = await getMisubSnapshot(env, fresh);
    const { connections, active_id } = await listMisubConnections(env.DB);
    return json({ ok: true, configured: true, ...data, connections, active_id });
  });
}

// POST /api/misub/test  测试连接（不保存）
async function testConnection(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  const body = await readBody(request);
  if (!body.ok) return body.response;
  return wrap(async () => {
    const baseUrl = normalizeMisubBaseUrl(body.value["base_url"]);
    const submitted = typeof body.value["token"] === "string" ? body.value["token"].trim() : "";
    const token = await resolveMisubTestToken(env, submitted);
    await testMisubConnection(baseUrl, token);
    return json({ ok: true });
  });
}

// GET /api/misub/connections          列表
// POST /api/misub/connections         新增
async function connectionsRoute(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return wrap(async () => {
      const { connections, active_id } = await listMisubConnections(env.DB);
      return json({ ok: true, connections, active_id, vault_key_state: misubVaultKeyState(env) });
    });
  }
  if (method === "POST") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => {
      const result = await addMisubConnection(env, {
        name: body.value["name"],
        base_url: body.value["base_url"],
        token: body.value["token"],
        refresh_enabled: body.value["refresh_enabled"],
        active: body.value["active"],
      });
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "网络节点",
        action: "新增",
        targetId: result.connection.id,
        targetName: result.connection.name,
        text: `新增了 MiSub 连接「${result.connection.name}」（${result.connection.base_url}）`,
      });
      return json(
        { ok: true, connection: result.connection, connections: result.connections, active_id: result.active_id },
        201,
      );
    });
  }
  return methodNotAllowed("GET, POST");
}

// PATCH /api/misub/connections/:id    更新
// DELETE /api/misub/connections/:id   删除
async function connectionByIdRoute(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => {
      const before = await getMisubConnection(env.DB, id);
      if (!before) throw new MisubError(404, "MiSub 连接不存在");
      const result = await updateMisubConnection(env, id, {
        name: body.value["name"],
        base_url: body.value["base_url"],
        token: body.value["token"],
        refresh_enabled: body.value["refresh_enabled"],
      });
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "网络节点",
        action: "修改",
        targetId: id,
        targetName: result.connection.name,
        text: `修改了 MiSub 连接「${result.connection.name}」（${result.connection.base_url}）`,
      });
      return json({ ok: true, connection: result.connection, connections: result.connections, active_id: result.active_id });
    });
  }
  if (method === "DELETE") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    return wrap(async () => {
      const before = await getMisubConnection(env.DB, id);
      if (!before) throw new MisubError(404, "MiSub 连接不存在");
      const result = await deleteMisubConnection(env, id);
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "网络节点",
        action: "删除",
        targetId: id,
        targetName: before.name,
        text: `删除了 MiSub 连接「${before.name}」（${before.base_url}）`,
      });
      return json({ ok: true, connections: result.connections, active_id: result.active_id });
    });
  }
  return methodNotAllowed("PATCH, DELETE");
}

// POST /api/misub/connections/:id/activate  设为当前
async function activateConnection(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  return wrap(async () => {
    const before = await getMisubConnection(env.DB, id);
    if (!before) throw new MisubError(404, "MiSub 连接不存在");
    const result = await activateMisubConnection(env, id);
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "网络节点",
      action: "切换",
      targetId: id,
      targetName: before.name,
      text: `切换当前 MiSub 连接为「${before.name}」`,
    });
    return json({ ok: true, connections: result.connections, active_id: result.active_id });
  });
}

// POST /api/misub/connections/:id/test  测已存连接
async function testConnectionById(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  return wrap(async () => {
    const connection = await testMisubConnectionById(env, id);
    return json({ ok: true, connection });
  });
}

// 兼容旧 API：PUT /api/misub/config  保存配置
//                  PATCH /api/misub/config  只改刷新开关
//                  DELETE /api/misub/config  清空配置
async function configRoute(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PUT") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => {
      const before = await readMisubConfig(env.DB).catch(() => null);
      const saved = await saveMisubConfig(env, {
        base_url: body.value["base_url"],
        token: body.value["token"],
        refresh_enabled: body.value["refresh_enabled"],
      });
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "网络节点",
        action: before ? "修改" : "保存",
        targetId: "misub",
        targetName: "MiSub",
        text: before ? `更新了 MiSub 连接（${saved.base_url}）` : `保存了 MiSub 连接（${saved.base_url}）`,
      });
      // 响应里只有末 4 位，完整令牌绝不出现。
      return json({ ok: true, config: saved });
    });
  }
  if (method === "PATCH") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readBody(request);
    if (!body.ok) return body.response;
    if (typeof body.value["refresh_enabled"] !== "boolean") {
      return json({ ok: false, error: "刷新开关格式不正确" }, 400);
    }
    return wrap(async () => {
      const saved = await setMisubRefreshEnabled(env, body.value["refresh_enabled"] as boolean);
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "网络节点",
        action: "修改",
        targetId: "misub",
        targetName: "MiSub",
        text: saved.refresh_enabled ? "打开了 MiSub 订阅组触发刷新" : "关闭了 MiSub 订阅组触发刷新",
      });
      return json({ ok: true, config: saved });
    });
  }
  if (method === "DELETE") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    return wrap(async () => {
      await clearMisubConfig(env.DB);
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "网络节点",
        action: "清空",
        targetId: "misub",
        targetName: "MiSub",
        text: "清空了 MiSub 连接配置",
      });
      return json({ ok: true });
    });
  }
  return methodNotAllowed("PUT, PATCH, DELETE");
}

async function revealNode(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  return wrap(async () => {
    // 先写审计再取明文：取用失败也留痕，与保险库/云主机的 reveal 口径一致。
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "网络节点",
      action: "显示",
      targetId: id,
      targetName: id,
      text: `显示 MiSub 手动节点 ${id} 的服务器与链接`,
    });
    const revealed = await revealMisubManualNode(env, id);
    return json({ ok: true, server: revealed.server, url: revealed.url });
  });
}

async function refreshProfile(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  return wrap(async () => {
    const result = await refreshMisubProfile(env, id);
    const name = result.name || id;
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "网络节点",
      action: "刷新",
      targetId: id,
      targetName: name,
      text: `触发刷新了 MiSub 订阅组「${name}」，共 ${result.total_nodes} 个节点`,
    });
    return json({ ok: true, total_nodes: result.total_nodes });
  });
}