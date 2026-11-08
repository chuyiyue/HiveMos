// Panel REST for the machines board. The caller in index.ts has already
// checked the admin session; writes pass the same cross-site mutation gate
// as the registry routes.

import { isCrossSite, json, readJsonLimited } from "./http";
import type { Env, WaitCtx } from "./env";
import {
  createConnectionWithDevices,
  deleteConnection,
  listConnections,
  syncConnection,
  testAdHocConnection,
  testStoredConnection,
} from "./providers";
import {
  createMachine,
  deleteMachine,
  fetchWorkersForMachine,
  listMachines,
  MACHINE_KINDS,
  MachineError,
  machinePublic,
  probeMachineById,
  probeStaleServers,
  revealMachineSecret,
  updateMachine,
  vaultKeyOf,
} from "./machines";
import { logOp, panelActor } from "./oplog";

const MACHINE_KIND_LABELS: Record<string, string> = { server: "服务器", cloud: "云主机", worker: "Worker" };

const MAX_BODY_BYTES = 64 * 1024;
const ACTOR = "user";

export async function handleMachinesRequest(request: Request, env: Env, ctx: WaitCtx, path: string): Promise<Response | null> {
  if (path === "/api/machines/providers/test") return providerTest(request);
  if (path === "/api/machines/providers") return providerCollection(request, env);
  const providerAction = /^\/api\/machines\/providers\/([A-Za-z0-9_-]+)\/(test|sync)$/.exec(path);
  if (providerAction && providerAction[1] && providerAction[2]) return providerActionRun(request, env, providerAction[1], providerAction[2]);
  const providerOne = /^\/api\/machines\/providers\/([A-Za-z0-9_-]+)$/.exec(path);
  if (providerOne && providerOne[1]) return providerOneRun(request, env, providerOne[1]);
  if (path === "/api/machines") return collection(request, env, ctx);
  const action = /^\/api\/machines\/([A-Za-z0-9_-]+)\/(reveal|workers|probe)$/.exec(path);
  if (action && action[1] && action[2]) return machineAction(request, env, action[1], action[2]);
  const one = /^\/api\/machines\/([A-Za-z0-9_-]+)$/.exec(path);
  if (one && one[1]) return machineOne(request, env, one[1]);
  return null;
}

function wrap(handler: () => Promise<Response>): Promise<Response> {
  return handler().catch((error: unknown) => {
    if (error instanceof MachineError) return json({ ok: false, error: error.message }, error.status);
    return json({ ok: false, error: "暂时无法读写云主机。请确认已经创建 D1 并应用迁移" }, 503);
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

async function collection(request: Request, env: Env, ctx: WaitCtx): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    const kind = new URL(request.url).searchParams.get("kind");
    if (kind !== null && !MACHINE_KINDS.includes(kind)) {
      return json({ ok: false, error: "类型不正确" }, 400);
    }
    // Auto-probe: opening the list quietly re-probes stale servers in the
    // background (waitUntil keeps the response fast). There is no cron —
    // the account quota is full — so this list-driven refresh plus the
    // probe right after creating a server is the whole "auto" story.
    if (kind === null || kind === "server") {
      ctx.waitUntil(probeStaleServers(env.DB, vaultKeyOf(env), ACTOR, Date.now()).catch(() => undefined));
    }
    return wrap(async () => json({ ok: true, machines: (await listMachines(env.DB, kind)).map(machinePublic) }));
  }
  if (method === "POST") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => {
      const created = await createMachine(env.DB, body.value, ACTOR, "panel", Date.now(), vaultKeyOf(env));
      const kindLabel = MACHINE_KIND_LABELS[created.kind] ?? created.kind;
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "云主机",
        action: "添加",
        targetId: created.id,
        targetName: created.name,
        text: `添加了${kindLabel}「${created.name}」`,
      });
      return json({ ok: true, machine: machinePublic(created) }, 201);
    });
  }
  return methodNotAllowed("GET, POST");
}

async function machineOne(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => {
      const updated = await updateMachine(env.DB, id, body.value, ACTOR, "panel", Date.now(), vaultKeyOf(env));
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "云主机",
        action: "修改",
        targetId: id,
        targetName: updated.name,
        text: `修改了「${updated.name}」`,
      });
      return json({ ok: true, machine: machinePublic(updated) });
    });
  }
  if (method === "DELETE") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    return wrap(async () => {
      const before = (await listMachines(env.DB, null)).find((row) => row.id === id);
      await deleteMachine(env.DB, id, ACTOR, "panel", Date.now());
      const name = before?.name ?? id;
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "云主机",
        action: "删除",
        targetId: id,
        targetName: name,
        text: `删除了「${name}」`,
      });
      return json({ ok: true });
    });
  }
  return methodNotAllowed("PATCH, DELETE");
}

// POST-only sub actions: reveal hands back the stored secret (audited in the
// core), workers lists the Cloudflare account's scripts with the stored
// token, probe runs a real SSH liveness check with the stored config.
// None of them accepts a body.
async function machineAction(request: Request, env: Env, id: string, action: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  if (action === "probe") {
    return wrap(async () => {
      const result = await probeMachineById(env.DB, id, vaultKeyOf(env), ACTOR, Date.now());
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "云主机",
        action: "探活",
        targetId: id,
        targetName: result.machine.name,
        text: result.probe.ok ? `测试了「${result.machine.name}」的连接，在线` : `测试了「${result.machine.name}」的连接，未连通`,
      });
      return json({ ok: true, machine: machinePublic(result.machine), probe: result.probe });
    });
  }
  if (action === "reveal") {
    return wrap(async () => {
      const result = await revealMachineSecret(env.DB, id, vaultKeyOf(env), ACTOR, Date.now());
      const machine = (await listMachines(env.DB, null)).find((row) => row.id === id);
      const name = machine?.name ?? id;
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "云主机",
        action: "查看",
        targetId: id,
        targetName: name,
        text: `查看了「${name}」的接入信息`,
      });
      return json({ ok: true, reveal: result });
    });
  }
  return wrap(async () => {
    const result = await fetchWorkersForMachine(env.DB, id, vaultKeyOf(env), ACTOR, Date.now());
    const machine = (await listMachines(env.DB, null)).find((row) => row.id === id);
    const name = machine?.name ?? id;
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "云主机",
      action: "查看",
      targetId: id,
      targetName: name,
      text: `查看了「${name}」的 Workers 列表`,
    });
    return json({ ok: true, workers: result.workers, fetched_at: result.fetched_at });
  });
}


// ---------------------------------------------------------------------------
// Provider connections (cloud tab phase 2). The routes live under
// /api/machines/providers so the board router in index.ts needs no change.
// Test endpoints answer 200 with { ok: false, error } for provider-side
// failures so the wizard can show the reason inline; creating a connection
// re-lists devices server-side and refuses (400) when the test fails.

async function providerTest(request: Request): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  const body = await readBody(request);
  if (!body.ok) return body.response;
  return wrap(async () => {
    const provider = typeof body.value["provider"] === "string" ? body.value["provider"] : "";
    const config = (body.value["config"] ?? {}) as Record<string, unknown>;
    const outcome = await testAdHocConnection(provider, config);
    if (!outcome.ok) return json({ ok: false, error: outcome.error ?? "连接测试失败" });
    return json({ ok: true, devices: outcome.devices ?? [] });
  });
}

async function providerCollection(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return wrap(async () => json({ ok: true, connections: await listConnections(env.DB) }));
  }
  if (method === "POST") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => {
      const provider = typeof body.value["provider"] === "string" ? body.value["provider"] : "";
      const name = typeof body.value["name"] === "string" ? body.value["name"] : "";
      const config = (body.value["config"] ?? {}) as Record<string, unknown>;
      const deviceIds = Array.isArray(body.value["device_ids"]) ? body.value["device_ids"].filter((value): value is string => typeof value === "string") : [];
      const result = await createConnectionWithDevices(env.DB, vaultKeyOf(env), { provider, name, config, deviceIds, groupId: body.value["group_id"] }, ACTOR, Date.now());
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "云主机",
        action: "添加",
        targetId: result.connection.id,
        targetName: result.connection.name,
        text: `添加了服务商连接「${result.connection.name}」，导入 ${result.machines.length} 台设备`,
      });
      return json({ ok: true, connection: result.connection, machines: result.machines }, 201);
    });
  }
  return methodNotAllowed("GET, POST");
}

async function providerActionRun(request: Request, env: Env, id: string, action: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  if (action === "test") {
    return wrap(async () => {
      const outcome = await testStoredConnection(env.DB, vaultKeyOf(env), id, Date.now());
      if (!outcome.ok) return json({ ok: false, error: outcome.error ?? "连接测试失败" });
      const conn = (await listConnections(env.DB)).find((row) => row.id === id);
      const name = conn?.name ?? id;
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "云主机",
        action: "探活",
        targetId: id,
        targetName: name,
        text: `测试了服务商连接「${name}」`,
      });
      return json({ ok: true, devices: outcome.devices ?? [] });
    });
  }
  return wrap(async () => {
    const result = await syncConnection(env.DB, vaultKeyOf(env), id, Date.now());
    const conn = (await listConnections(env.DB)).find((row) => row.id === id);
    const name = conn?.name ?? id;
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "云主机",
      action: "同步",
      targetId: id,
      targetName: name,
      text: `同步了服务商连接「${name}」，更新 ${result.updated} 台设备`,
    });
    return json({ ok: true, updated: result.updated, missing: result.missing, devices: result.devices });
  });
}

async function providerOneRun(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "DELETE") return methodNotAllowed("DELETE");
  const gate = await mutationGate(request);
  if (gate) return gate;
  return wrap(async () => {
    const before = (await listConnections(env.DB)).find((row) => row.id === id);
    await deleteConnection(env.DB, id, Date.now());
    const name = before?.name ?? id;
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "云主机",
      action: "删除",
      targetId: id,
      targetName: name,
      text: `删除了服务商连接「${name}」，已导入的设备保留为独立设备`,
    });
    return json({ ok: true });
  });
}
