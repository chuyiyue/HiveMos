// MiSub 的 REST 路由（「代理」页）。index.ts 已校验管理员会话，写操作在这里补跨站检查。
//
//   GET    /api/misub[?meta=1]                 D1 里的快照与同步状态（不出站）
//   POST   /api/misub/sync                     手动同步（5 分钟冷却）
//   POST   /api/misub/test                     测提交的地址+令牌（不保存）
//   GET    /api/misub/connections              连接列表
//   POST   /api/misub/connections              新增
//   PATCH  /api/misub/connections/:id          更新
//   DELETE /api/misub/connections/:id          删除
//   POST   /api/misub/connections/:id/activate 设为当前
//   POST   /api/misub/connections/:id/test     测已存连接
//   GET    /api/misub/connections/:id/token    令牌明文（记操作日志）
//   PUT|PATCH|DELETE /api/misub/config         旧接口兼容
//   POST   /api/misub/profiles/:id/refresh     让 MiSub 刷新订阅组
//   POST   /api/misub/subscriptions/:id/refresh 让 MiSub 刷新订阅源

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
  listMisubConnections,
  misubVaultKeyState,
  normalizeMisubBaseUrl,
  readMisubConfig,
  refreshMisubProfile,
  resolveMisubTestToken,
  saveMisubConfig,
  setMisubRefreshEnabled,
  testMisubConnection,
  testMisubConnectionById,
  testMisubConnectionTemp,
  updateMisubConnection,
  refreshMisubSubscription,
  revealMisubToken,
} from "./misub";
import { deleteMisubStore, manualSyncMisub, readMisubView, syncMisubNow } from "./misub-store";

const MAX_BODY_BYTES = 16 * 1024;

export async function handleMisubRequest(request: Request, env: Env, path: string): Promise<Response | null> {
  // 精确匹配优先
  if (path === "/api/misub") return snapshot(request, env);
  if (path === "/api/misub/sync") return syncAll(request, env);
  if (path === "/api/misub/test") return testConnection(request, env);
  if (path === "/api/misub/config") return configRoute(request, env);
  if (path === "/api/misub/connections") return connectionsRoute(request, env);
  if (path === "/api/misub/connections/") return connectionsRoute(request, env);

  // 带参数的路由
  const connIdMatch = /^\/api\/misub\/connections\/([A-Za-z0-9_-]+)$/.exec(path);
  if (connIdMatch && connIdMatch[1]) return connectionByIdRoute(request, env, connIdMatch[1]);

  const activateMatch = /^\/api\/misub\/connections\/([A-Za-z0-9_-]+)\/activate$/.exec(path);
  if (activateMatch && activateMatch[1]) return activateConnection(request, env, activateMatch[1]);

  const tokenMatch = /^\/api\/misub\/connections\/([A-Za-z0-9_-]+)\/token$/.exec(path);
  if (tokenMatch && tokenMatch[1]) return connectionToken(request, env, tokenMatch[1]);

  const testMatch = /^\/api\/misub\/connections\/([A-Za-z0-9_-]+)\/test$/.exec(path);
  if (testMatch && testMatch[1]) return testConnectionById(request, env, testMatch[1]);


  const refresh = /^\/api\/misub\/profiles\/([A-Za-z0-9_-]+)\/refresh$/.exec(path);
  if (refresh && refresh[1]) return refreshProfile(request, env, refresh[1]);


  const subRefresh = /^\/api\/misub\/subscriptions\/([A-Za-z0-9_-]+)\/refresh$/.exec(path);
  if (subRefresh && subRefresh[1]) return refreshSubscription(request, env, subRefresh[1]);





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

  const config = await readMisubConfig(env.DB).catch(() => null);
  const vaultState = misubVaultKeyState(env);

  if (!config) {
    if (metaOnly) {
      const { connections, active_id } = await listMisubConnections(env.DB).catch(() => ({ connections: [], active_id: "" }));
      return json({ ok: true, configured: false, config: null, connections, active_id, vault_key_state: vaultState });
    }
    return json({ ok: true, configured: false, vault_key_state: vaultState });
  }

  return wrap(async () => {
    const view = await readMisubView(env);
    const { connections, active_id } = await listMisubConnections(env.DB);
    const cfg = { base_url: view.connection.base_url, refresh_enabled: view.connection.refresh_enabled };
    if (metaOnly) {
      return json({ ok: true, configured: true, config: cfg, connections, active_id, vault_key_state: vaultState, sync: view.sync });
    }
    const data = view.snapshot;
    return json({
      ok: true,
      configured: true,
      ...(data ?? { overview: null, subscriptions: [], manual_nodes: [], profiles: [] }),
      fetched_at: view.sync.synced_at,
      config: cfg,
      sync: view.sync,
      connections,
      active_id,
    });
  });
}

// POST /api/misub/sync  手动同步
async function syncAll(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  return wrap(async () => {
    const result = await manualSyncMisub(env, Date.now());
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "网络节点",
      action: "刷新",
      targetId: "misub",
      targetName: "MiSub",
      text: result.ok ? "手动同步了 MiSub" : `手动同步 MiSub 失败：${result.error}`,
    });
    return json({ ok: true, sync_ok: result.ok, error: result.error, next_manual_at: result.next_manual_at });
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
        auto_interval_hours: body.value["auto_interval_hours"],
      });
      if (result.active_id === result.connection.id) await syncMisubNow(env, result.connection.id).catch(() => null);
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "网络节点",
        action: "新增",
        targetId: result.connection.id,
        targetName: result.connection.name,
        text: `新增了 MiSub 服务商连接「${result.connection.name}」（${result.connection.base_url}）`,
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
        auto_interval_hours: body.value["auto_interval_hours"],
      });
      if (result.connection.base_url !== before.base_url || (typeof body.value["token"] === "string" && body.value["token"].trim())) {
        await deleteMisubStore(env.DB, id);
      }
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "网络节点",
        action: "修改",
        targetId: id,
        targetName: result.connection.name,
        text: `修改了 MiSub 服务商连接「${result.connection.name}」（${result.connection.base_url}）`,
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
      await deleteMisubStore(env.DB, id);
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "网络节点",
        action: "删除",
        targetId: id,
        targetName: before.name,
        text: `删除了 MiSub 服务商连接「${before.name}」（${before.base_url}）`,
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

// GET /api/misub/connections/:id/token  令牌明文，与云主机服务商凭据一样记一条「查看」
async function connectionToken(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
  return wrap(async () => {
    const conn = await getMisubConnection(env.DB, id);
    if (!conn) throw new MisubError(404, "MiSub 连接不存在");
    const token = await revealMisubToken(env, id);
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "网络节点",
      action: "查看",
      targetId: id,
      targetName: conn.name,
      text: `查看了 MiSub 连接「${conn.name}」的令牌`,
    });
    return json({ ok: true, token });
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
      if (before && (before.base_url !== saved.base_url || saved.token_tail !== before.token_tail)) {
        const { active_id } = await listMisubConnections(env.DB);
        if (active_id) await deleteMisubStore(env.DB, active_id);
      }
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
      const { active_id } = await listMisubConnections(env.DB);
      await clearMisubConfig(env.DB);
      if (active_id) await deleteMisubStore(env.DB, active_id);
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
    const synced = await syncMisubNow(env).catch(() => ({ ok: false, error: "" }));
    return json({ ok: true, total_nodes: result.total_nodes, synced: synced.ok });
  });
}
// GET /api/misub/nodes  全部节点
// GET /api/misub/subscriptions/:id/nodes  单个机场订阅的节点
// POST /api/misub/subscriptions/:id/nodes/:index/reveal  { name }
// POST /api/misub/subscriptions/:id/refresh  触发 MiSub 刷新单个订阅源
async function refreshSubscription(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  return wrap(async () => {
    const result = await refreshMisubSubscription(env, id);
    await syncMisubNow(env).catch(() => null);
    const name = result.name || id;
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "网络节点",
      action: "刷新",
      targetId: id,
      targetName: name,
      text: result.last_error
        ? `触发刷新了 MiSub 机场订阅「${name}」，失败：${result.last_error}`
        : `触发刷新了 MiSub 机场订阅「${name}」，共 ${result.node_count} 个节点`,
    });
    return json({ ok: true, node_count: result.node_count, last_error: result.last_error });
  });
}
