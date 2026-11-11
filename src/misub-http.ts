// MiSub 瘦客户端的 REST 路由（云计算资源「代理」页）。
// index.ts 已做过管理员会话校验；写操作在这里补跨站检查，口径与其它模块一致。
//
// Routes:
//   GET    /api/misub                          D1 里的快照（不出站；未配置时 configured:false；追加 connections、active_id、sync）
//   GET    /api/misub?meta=1                   元信息：configured、config、connections、active_id、vault_key_state
//   POST   /api/misub/sync                     手动同步全部：列表 + 最久没拉的订阅（5 分钟冷却，429 带 next_manual_at）
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
//   POST   /api/misub/manual-nodes/:id/reveal  显示节点的服务器与链接（先写审计，从 D1 密封列解开）
//   POST   /api/misub/profiles/:id/refresh     触发订阅组刷新（开关打开时）
//   POST   /api/misub/subscriptions/:id/refresh            触发 MiSub 端刷新单个机场订阅（开关打开时），随后同步列表
//   POST   /api/misub/subscriptions/:id/fetch              手动拉取机场订阅节点写入 D1（订阅级 5 分钟冷却）
//   PATCH  /api/misub/subscriptions/:id/interval           { interval_hours: null|0..168 } 订阅自己的自动拉取间隔
//   GET    /api/misub/subscriptions/:id/nodes              D1 里这个订阅的节点（脱敏）与拉取状态
//   POST   /api/misub/subscriptions/:id/nodes/:index/reveal 显示/复制一条机场节点（先写审计）
//   GET    /api/misub/nodes                                全部节点：手工节点 + 各机场订阅节点（D1）

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
  validateIntervalHours,
} from "./misub";
import {
  deleteMisubStore,
  manualFetchSubscription,
  manualSyncAll,
  readAllMisubNodes,
  readMisubSubscriptionNodes,
  readMisubView,
  revealStoredManualNode,
  revealStoredSubscriptionNode,
  setSubscriptionInterval,
  syncMisubListsNow,
} from "./misub-store";

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

  const testMatch = /^\/api\/misub\/connections\/([A-Za-z0-9_-]+)\/test$/.exec(path);
  if (testMatch && testMatch[1]) return testConnectionById(request, env, testMatch[1]);

  const reveal = /^\/api\/misub\/manual-nodes\/([A-Za-z0-9_-]+)\/reveal$/.exec(path);
  if (reveal && reveal[1]) return revealNode(request, env, reveal[1]);

  const refresh = /^\/api\/misub\/profiles\/([A-Za-z0-9_-]+)\/refresh$/.exec(path);
  if (refresh && refresh[1]) return refreshProfile(request, env, refresh[1]);

  if (path === "/api/misub/nodes") return allNodes(request, env);

  const subRefresh = /^\/api\/misub\/subscriptions\/([A-Za-z0-9_-]+)\/refresh$/.exec(path);
  if (subRefresh && subRefresh[1]) return refreshSubscription(request, env, subRefresh[1]);

  const subFetch = /^\/api\/misub\/subscriptions\/([A-Za-z0-9_-]+)\/fetch$/.exec(path);
  if (subFetch && subFetch[1]) return fetchSubscriptionNodes(request, env, subFetch[1]);

  const subInterval = /^\/api\/misub\/subscriptions\/([A-Za-z0-9_-]+)\/interval$/.exec(path);
  if (subInterval && subInterval[1]) return subscriptionInterval(request, env, subInterval[1]);

  const subNodes = /^\/api\/misub\/subscriptions\/([A-Za-z0-9_-]+)\/nodes$/.exec(path);
  if (subNodes && subNodes[1]) return subscriptionNodes(request, env, subNodes[1]);

  const subReveal = /^\/api\/misub\/subscriptions\/([A-Za-z0-9_-]+)\/nodes\/(\d{1,5})\/reveal$/.exec(path);
  if (subReveal && subReveal[1] && subReveal[2]) return revealSubscriptionNode(request, env, subReveal[1], Number(subReveal[2]));

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
    // 只读 D1，打开页面不出站；从没同步过时 snapshot 为 null，由面板提示「立即同步」。
    const view = await readMisubView(env);
    const { connections, active_id } = await listMisubConnections(env.DB);
    const cfg = { base_url: view.connection.base_url, token_tail: config.token_tail, refresh_enabled: view.connection.refresh_enabled };
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

// POST /api/misub/sync  手动同步全部
async function syncAll(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  return wrap(async () => {
    const result = await manualSyncAll(env, Date.now());
    const parts = [result.snapshot_ok ? "列表已更新" : `列表失败：${result.snapshot_error}`, `拉取 ${result.fetched + result.failed.length} 个订阅`];
    if (result.failed.length) parts.push(`${result.failed.length} 个失败`);
    if (result.remaining) parts.push(`${result.remaining} 个留待下次`);
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "网络节点",
      action: "刷新",
      targetId: "misub",
      targetName: "MiSub",
      text: `手动同步了 MiSub 节点：${parts.join("，")}`,
    });
    return json({ ok: true, ...result });
  });
}

// POST /api/misub/subscriptions/:id/fetch  手动拉取单个机场订阅
async function fetchSubscriptionNodes(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  return wrap(async () => {
    const result = await manualFetchSubscription(env, id, Date.now());
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "网络节点",
      action: "刷新",
      targetId: id,
      targetName: id,
      text: result.ok ? `拉取了 MiSub 机场订阅 ${id}，共 ${result.count} 个节点` : `拉取 MiSub 机场订阅 ${id} 失败：${result.error}`,
    });
    return json({ ok: true, fetch_ok: result.ok, error: result.error, node_count: result.count, next_manual_at: result.next_manual_at });
  });
}

// PATCH /api/misub/subscriptions/:id/interval  { interval_hours: null | 0..168 }
async function subscriptionInterval(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "PATCH") return methodNotAllowed("PATCH");
  const gate = await mutationGate(request);
  if (gate) return gate;
  const body = await readBody(request);
  if (!body.ok) return body.response;
  return wrap(async () => {
    const raw = body.value["interval_hours"];
    const hours = raw === null || raw === "" || raw === undefined ? null : validateIntervalHours(raw, "订阅自动拉取间隔");
    await setSubscriptionInterval(env, id, hours);
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "网络节点",
      action: "修改",
      targetId: id,
      targetName: id,
      text: hours === null ? `MiSub 机场订阅 ${id} 的自动拉取间隔改为跟随连接` : hours === 0 ? `关闭了 MiSub 机场订阅 ${id} 的自动拉取` : `MiSub 机场订阅 ${id} 的自动拉取间隔改为 ${hours} 小时`,
    });
    return json({ ok: true, interval_hours: hours });
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
        node_ua: body.value["node_ua"],
        auto_interval_hours: body.value["auto_interval_hours"],
      });
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
        node_ua: body.value["node_ua"],
        auto_interval_hours: body.value["auto_interval_hours"],
      });
      // 地址或令牌变了，旧数据就不再可信：清掉，下一次同步重建。
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
      text: `显示 MiSub 手工节点 ${id} 的服务器与链接`,
    });
    const revealed = await revealStoredManualNode(env, id);
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
    // MiSub 端刷新后订阅源的流量/节点数会变：顺手同步一次列表（3 个子请求，不占手动冷却）
    const synced = await syncMisubListsNow(env).catch(() => ({ ok: false, error: "" }));
    return json({ ok: true, total_nodes: result.total_nodes, synced: synced.ok });
  });
}
// GET /api/misub/nodes  全部节点
async function allNodes(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
  return wrap(async () => {
    const result = await readAllMisubNodes(env);
    return json({ ok: true, ...result });
  });
}

// GET /api/misub/subscriptions/:id/nodes  单个机场订阅的节点
async function subscriptionNodes(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
  return wrap(async () => {
    const result = await readMisubSubscriptionNodes(env, id);
    return json({ ok: true, ...result });
  });
}

// POST /api/misub/subscriptions/:id/nodes/:index/reveal  { name }
async function revealSubscriptionNode(request: Request, env: Env, id: string, index: number): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  const body = await readBody(request);
  if (!body.ok) return body.response;
  const expected = typeof body.value["name"] === "string" ? body.value["name"].slice(0, 300) : "";
  return wrap(async () => {
    // 先写审计再取明文，与手工节点 reveal 同口径。
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "网络节点",
      action: "显示",
      targetId: id + "#" + index,
      targetName: expected || id,
      text: `显示 MiSub 机场订阅 ${id} 第 ${index + 1} 个节点「${expected || "未命名"}」的服务器与链接`,
    });
    const revealed = await revealStoredSubscriptionNode(env, id, index, expected);
    return json({ ok: true, server: revealed.server, url: revealed.url });
  });
}

// POST /api/misub/subscriptions/:id/refresh  触发 MiSub 刷新单个订阅源
async function refreshSubscription(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  return wrap(async () => {
    const result = await refreshMisubSubscription(env, id);
    await syncMisubListsNow(env).catch(() => null);
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
