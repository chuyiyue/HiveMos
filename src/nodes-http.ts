// 网络节点的面板接口。调用方在 index.ts 已校验管理员会话。
// 写操作走与云主机相同的跨站拦截。订阅地址和节点原文只在审计落库之后回明文。

import type { Env, WaitCtx } from "./env";
import { isCrossSite, json, readJsonLimited } from "./http";
import {
  copyNodeRaw,
  createSubscription,
  deleteNode,
  deleteSubscription,
  importManualNodes,
  listNodeBoard,
  NodeError,
  revealSubscriptionUrl,
  syncSubscription,
  testAllNodes,
  testNode,
  updateSubscription,
} from "./nodes";
import { logOp, panelActor } from "./oplog";

const MODULE = "网络节点";
const ACTOR = "user";
const MAX_JSON_BYTES = 64 * 1024;
const MAX_IMPORT_BYTES = 1024 * 1024 + 64 * 1024;

export async function handleNodesRequest(request: Request, env: Env, ctx: WaitCtx, path: string): Promise<Response | null> {
  void ctx;
  if (path !== "/api/nodes" && !path.startsWith("/api/nodes/")) return null;
  if (path === "/api/nodes") return collection(request, env);
  if (path === "/api/nodes/import") return importNodes(request, env);
  if (path === "/api/nodes/test-all") return testAll(request, env);
  if (path === "/api/nodes/subscriptions") return subscriptionCollection(request, env);
  const subAction = /^\/api\/nodes\/subscriptions\/([A-Za-z0-9_-]+)\/(sync|reveal)$/.exec(path);
  if (subAction && subAction[1] && subAction[2]) return subscriptionAction(request, env, subAction[1], subAction[2]);
  const subOne = /^\/api\/nodes\/subscriptions\/([A-Za-z0-9_-]+)$/.exec(path);
  if (subOne && subOne[1]) return subscriptionOne(request, env, subOne[1]);
  const nodeAction = /^\/api\/nodes\/([A-Za-z0-9_-]+)\/(test|copy)$/.exec(path);
  if (nodeAction && nodeAction[1] && nodeAction[2]) return nodeActionRun(request, env, nodeAction[1], nodeAction[2]);
  const nodeOne = /^\/api\/nodes\/([A-Za-z0-9_-]+)$/.exec(path);
  if (nodeOne && nodeOne[1]) return nodeOne(request, env, nodeOne[1]);
  return null;
}

function wrap(handler: () => Promise<Response>): Promise<Response> {
  return handler().catch((error: unknown) => {
    if (error instanceof NodeError) return json({ ok: false, error: error.message }, error.status);
    return json({ ok: false, error: "暂时无法读写网络节点。请确认已经创建 D1 并应用迁移" }, 503);
  });
}

async function mutationGate(request: Request): Promise<Response | null> {
  if (isCrossSite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  return null;
}

function methodNotAllowed(allow: string): Response {
  return json({ ok: false, error: "方法不允许" }, 405, { allow });
}

async function readBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const body = await readJsonLimited(request, maxBytes);
  if (!body.ok) return { ok: false, response: json({ ok: false, error: body.error }, body.status) };
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
    return { ok: false, response: json({ ok: false, error: "请求格式不正确" }, 400) };
  }
  return { ok: true, value: body.value as Record<string, unknown> };
}

async function collection(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
  return wrap(async () => {
    const board = await listNodeBoard(env.DB);
    return json({ ok: true, subscriptions: board.subscriptions, nodes: board.nodes });
  });
}

async function subscriptionCollection(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  const body = await readBody(request, MAX_JSON_BYTES);
  if (!body.ok) return body.response;
  return wrap(async () => {
    const created = await createSubscription(env.DB, env, { name: body.value.name, url: body.value.url }, Date.now());
    const sync = created.sync;
    const name = created.subscription.name;
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: MODULE,
      action: "添加",
      targetId: created.subscription.id,
      targetName: name,
      text: sync.ok
        ? `添加了订阅「${name}」，新增 ${sync.added} 条，更新 ${sync.updated} 条，移除 ${sync.removed} 条`
        : `添加了订阅「${name}」，同步失败：${sync.error}`,
    });
    return json({ ok: true, subscription: created.subscription, sync }, 201);
  });
}

async function subscriptionOne(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readBody(request, MAX_JSON_BYTES);
    if (!body.ok) return body.response;
    return wrap(async () => {
      const updated = await updateSubscription(env.DB, env, id, { name: body.value.name, url: body.value.url }, Date.now());
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: MODULE,
        action: "修改",
        targetId: id,
        targetName: updated.name,
        text: `修改了订阅「${updated.name}」`,
      });
      return json({ ok: true, subscription: updated });
    });
  }
  if (method === "DELETE") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    return wrap(async () => {
      const removed = await deleteSubscription(env.DB, id);
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: MODULE,
        action: "删除",
        targetId: id,
        targetName: removed.name,
        text: `删除了订阅「${removed.name}」及其节点`,
      });
      return json({ ok: true });
    });
  }
  return methodNotAllowed("PATCH, DELETE");
}

async function subscriptionAction(request: Request, env: Env, id: string, action: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  if (action === "sync") {
    return wrap(async () => {
      const result = await syncSubscription(env.DB, env, id, Date.now());
      const sync = result.sync;
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: MODULE,
        action: "同步",
        targetId: id,
        targetName: result.subscription.name,
        text: sync.ok
          ? `同步了订阅「${result.subscription.name}」，新增 ${sync.added} 条，更新 ${sync.updated} 条，移除 ${sync.removed} 条`
          : `同步订阅「${result.subscription.name}」失败：${sync.error}`,
      });
      return json({ ok: true, subscription: result.subscription, sync });
    });
  }
  return wrap(async () => {
    const revealed = await revealSubscriptionUrl(env.DB, env, id, ACTOR, Date.now());
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: MODULE,
      action: "查看",
      targetId: id,
      targetName: revealed.name,
      text: `查看了订阅「${revealed.name}」的地址`,
    });
    return json({ ok: true, url: revealed.url });
  });
}

async function importNodes(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  const body = await readBody(request, MAX_IMPORT_BYTES);
  if (!body.ok) return body.response;
  return wrap(async () => {
    const report = await importManualNodes(env.DB, env, body.value.text, Date.now());
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: MODULE,
      action: "导入",
      targetName: "手动导入",
      text: `导入了节点，新增 ${report.added} 条，更新 ${report.updated} 条，跳过 ${report.skipped} 条`,
    });
    return json({ ok: true, added: report.added, updated: report.updated, skipped: report.skipped });
  });
}

async function testAll(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  return wrap(async () => {
    const result = await testAllNodes(env.DB);
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: MODULE,
      action: "测活",
      targetName: "全部节点",
      text: `测活了全部节点，可达 ${result.reachable}，不可达 ${result.unreachable}`,
    });
    return json({ ok: true, reachable: result.reachable, unreachable: result.unreachable });
  });
}

async function nodeActionRun(request: Request, env: Env, id: string, action: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  if (action === "test") {
    return wrap(async () => {
      const result = await testNode(env.DB, id);
      return json({ ok: true, node: result.node, reachable: result.reachable, latency_ms: result.latency_ms });
    });
  }
  return wrap(async () => {
    const copied = await copyNodeRaw(env.DB, env, id, ACTOR, Date.now());
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: MODULE,
      action: "复制",
      targetId: id,
      targetName: copied.name,
      text: `复制了节点「${copied.name}」的链接`,
    });
    return json({ ok: true, raw: copied.raw });
  });
}

async function nodeOne(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "DELETE") return methodNotAllowed("DELETE");
  const gate = await mutationGate(request);
  if (gate) return gate;
  return wrap(async () => {
    const removed = await deleteNode(env.DB, id);
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: MODULE,
      action: "删除",
      targetId: id,
      targetName: removed.name,
      text: `删除了节点「${removed.name}」`,
    });
    return json({ ok: true });
  });
}
