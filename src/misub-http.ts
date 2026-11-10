// Panel REST for the MiSub thin client（云计算资源「代理」页）。
// The caller in index.ts has already checked the admin session; writes
// pass the same cross-site mutation gate as the other module handlers.
//
// Routes:
//   GET    /api/misub                 概览快照（未配置时 configured:false）
//   POST   /api/misub/test            用提交的地址+令牌测一次连接（不保存）
//   PUT    /api/misub/config          保存配置（保存时测一次，通了才落库）
//   PATCH  /api/misub/config          只改触发刷新开关
//   DELETE /api/misub/config          断开连接（清配置）
//   POST   /api/misub/manual-nodes/:id/reveal   显示节点明文（先审计）
//   POST   /api/misub/profiles/:id/refresh      触发订阅组刷新（开关开时）

import { isCrossSite, json, readJsonLimited } from "./http";
import type { Env } from "./env";
import { logOp, panelActor } from "./oplog";
import {
  MisubError,
  clearMisubConfig,
  getMisubSnapshot,
  misubVaultKeyState,
  normalizeMisubBaseUrl,
  readMisubConfig,
  refreshMisubProfile,
  revealMisubManualNode,
  saveMisubConfig,
  setMisubRefreshEnabled,
  testMisubConnection,
} from "./misub";

const MAX_BODY_BYTES = 16 * 1024;

export async function handleMisubRequest(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path === "/api/misub") return snapshot(request, env);
  if (path === "/api/misub/test") return testConnection(request, env);
  if (path === "/api/misub/config") return configRoute(request, env);
  const reveal = /^\/api\/misub\/manual-nodes\/([A-Za-z0-9_-]+)\/reveal$/.exec(path);
  if (reveal && reveal[1]) return revealNode(request, env, reveal[1]);
  const refresh = /^\/api\/misub\/profiles\/([A-Za-z0-9_-]+)\/refresh$/.exec(path);
  if (refresh && refresh[1]) return refreshProfile(request, env, refresh[1]);
  if (path === "/api/misub" || path.startsWith("/api/misub/")) {
    return json({ ok: false, error: "未找到" }, 404);
  }
  return null;
}

function wrap(handler: () => Promise<Response>): Promise<Response> {
  return handler().catch((error: unknown) => {
    if (error instanceof MisubError) return json({ ok: false, error: error.message }, error.status);
    return json({ ok: false, error: "暂时无法读取 MiSub 配置" }, 503);
  });
}

function methodNotAllowed(allow: string): Response {
  return json({ ok: false, error: "方法不允许" }, 405, { allow });
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

async function snapshot(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
  const config = await readMisubConfig(env.DB).catch(() => null);
  if (!config) {
    return json({ ok: true, configured: false, vault_key_state: misubVaultKeyState(env) });
  }
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  return wrap(async () => {
    const data = await getMisubSnapshot(env, fresh);
    return json({ ok: true, configured: true, ...data });
  });
}

// 测试连接（不保存）：令牌留空且已有配置时，用已存配置测——
// 地址以提交的为准，令牌沿用密封保存的那把。
async function testConnection(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  const body = await readBody(request);
  if (!body.ok) return body.response;
  return wrap(async () => {
    const baseUrl = normalizeMisubBaseUrl(body.value["base_url"]);
    const submitted = typeof body.value["token"] === "string" ? body.value["token"].trim() : "";
    if (submitted) {
      const result = await testMisubConnection(baseUrl, submitted);
      return json({ ok: true, subscriptions: result.subscriptions });
    }
    const existing = await readMisubConfig(env.DB);
    if (!existing) return json({ ok: false, error: "请填写 MiSub 令牌" }, 400);
    if (existing.base_url !== baseUrl) {
      return json({ ok: false, error: "地址已更改，请填写令牌后再测试" }, 400);
    }
    const snap = await getMisubSnapshot(env, true);
    return json({ ok: true, subscriptions: snap.overview.subscriptions });
  });
}

async function configRoute(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PUT") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => {
      const before = await readMisubConfig(env.DB);
      const saved = await saveMisubConfig(env, {
        base_url: body.value["base_url"],
        token: body.value["token"],
        refresh_enabled: body.value["refresh_enabled"],
      });
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "网络节点",
        action: before ? "修改" : "连接",
        targetId: "misub",
        targetName: "MiSub",
        text: before ? `更新了 MiSub 连接（${saved.base_url}）` : `连接了 MiSub（${saved.base_url}）`,
      });
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
        action: "断开",
        targetId: "misub",
        targetName: "MiSub",
        text: "断开了 MiSub 连接",
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
      action: "查看",
      targetId: id,
      targetName: id,
      text: `查看了 MiSub 手动节点 ${id} 的明文`,
    });
    const revealed = await revealMisubManualNode(env, id);
    return json({ ok: true, reveal: revealed });
  });
}

async function refreshProfile(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  return wrap(async () => {
    const result = await refreshMisubProfile(env, id);
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "网络节点",
      action: "刷新",
      targetId: id,
      targetName: result.name,
      text: `触发刷新了 MiSub 订阅组「${result.name}」，共 ${result.total_nodes} 个节点`,
    });
    return json({ ok: true, total_nodes: result.total_nodes });
  });
}
