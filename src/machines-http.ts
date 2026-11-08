// Panel REST for the machines board. The caller in index.ts has already
// checked the admin session; writes pass the same cross-site mutation gate
// as the registry routes.

import { isCrossSite, json, readJsonLimited } from "./http";
import type { Env, WaitCtx } from "./env";
import {
  createConnectionWithDevices,
  deleteConnection,
  getKeepalive,
  importConnectionDevices,
  listConnectionDevices,
  listConnections,
  providerPortAdd,
  providerPortRemove,
  providerPortsList,
  providerPower,
  putKeepalive,
  renameConnection,
  replaceConnectionCredentials,
  revealConnectionCredential,
  syncConnection,
  syncOneMachine,
  testAdHocConnection,
  testStoredConnection,
} from "./providers";
import {
  createMachine,
  deleteMachine,
  deleteWorkerScriptForMachine,
  fetchWorkersForMachine,
  getMachine,
  listMachines,
  MACHINE_KINDS,
  MachineError,
  machinePublic,
  probeMachineById,
  probeStaleServers,
  revealMachineSecret,
  updateMachine,
  vaultKeyOf,
  getWorkerAccountStats,
  listWorkerAssets,
} from "./machines";
import { logOp, panelActor } from "./oplog";

const MACHINE_KIND_LABELS: Record<string, string> = { server: "服务器", cloud: "云主机", worker: "Worker" };

const MAX_BODY_BYTES = 64 * 1024;
const ACTOR = "user";

export async function handleMachinesRequest(request: Request, env: Env, ctx: WaitCtx, path: string): Promise<Response | null> {
  if (path === "/api/machines/providers/test") return providerTest(request);
  if (path === "/api/machines/providers") return providerCollection(request, env);
  const providerAction = /^\/api\/machines\/providers\/([A-Za-z0-9_-]+)\/(test|sync|devices|import|credentials|credential)$/.exec(path);
  if (providerAction && providerAction[1] && providerAction[2]) return providerActionRun(request, env, providerAction[1], providerAction[2]);
  const providerOne = /^\/api\/machines\/providers\/([A-Za-z0-9_-]+)$/.exec(path);
  if (providerOne && providerOne[1]) return providerOneRun(request, env, providerOne[1]);
  if (path === "/api/machines") return collection(request, env, ctx);
  const workerStats = /^\/api\/machines\/([A-Za-z0-9_-]+)\/worker-stats$/.exec(path);
  if (workerStats && workerStats[1]) return workerStatsRun(request, env, workerStats[1]);
  const workerAssets = /^\/api\/machines\/([A-Za-z0-9_-]+)\/worker-assets$/.exec(path);
  if (workerAssets && workerAssets[1]) return workerAssetsRun(request, env, workerAssets[1]);
  const action = /^\/api\/machines\/([A-Za-z0-9_-]+)\/(reveal|workers|probe)$/.exec(path);
  if (action && action[1] && action[2]) return machineAction(request, env, action[1], action[2]);
  const power = /^\/api\/machines\/([A-Za-z0-9_-]+)\/power$/.exec(path);
  if (power && power[1]) return machinePower(request, env, power[1]);
  const syncOne = /^\/api\/machines\/([A-Za-z0-9_-]+)\/sync$/.exec(path);
  if (syncOne && syncOne[1]) return machineSyncOne(request, env, syncOne[1]);
  const ports = /^\/api\/machines\/([A-Za-z0-9_-]+)\/ports$/.exec(path);
  if (ports && ports[1]) return machinePorts(request, env, ports[1]);
  const portOne = /^\/api\/machines\/([A-Za-z0-9_-]+)\/ports\/(\d+)$/.exec(path);
  if (portOne && portOne[1] && portOne[2]) return machinePortOne(request, env, portOne[1], Number(portOne[2]));
  const workerScript = /^\/api\/machines\/([A-Za-z0-9_-]+)\/workers\/([A-Za-z0-9._~-]+)$/.exec(path);
  if (workerScript && workerScript[1] && workerScript[2]) return machineWorkerDelete(request, env, workerScript[1], decodeURIComponent(workerScript[2]));
  const keepaliveRoute = /^\/api\/machines\/([A-Za-z0-9_-]+)\/keepalive$/.exec(path);
  if (keepaliveRoute && keepaliveRoute[1]) return machineKeepalive(request, env, keepaliveRoute[1]);
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
      // Adding a server probes it once, synchronously: when the save
      // returns, the card already shows the real hostname/OS/status.
      let fresh = created;
      if (created.kind === "server") {
        await probeMachineById(env.DB, created.id, vaultKeyOf(env), ACTOR, Date.now()).catch(() => undefined);
        fresh = (await getMachine(env.DB, created.id)) ?? created;
      }
      const kindLabel = MACHINE_KIND_LABELS[created.kind] ?? created.kind;
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "云主机",
        action: "添加",
        targetId: created.id,
        targetName: created.name,
        text: `添加了${kindLabel}「${created.name}」`,
      });
      return json({ ok: true, machine: machinePublic(fresh) }, 201);
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
    return json({ ok: true, workers: result.workers, fetched_at: result.fetched_at, platform: result.platform, account_id: result.account_id, subdomain: result.subdomain });
  });
}


// GET /api/machines/:id/worker-stats - account usage for the card and the
// account tab; every metric is nullable when the token lacks its scope.
async function workerStatsRun(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  return wrap(async () => {
    const stats = await getWorkerAccountStats(env.DB, vaultKeyOf(env), id, Date.now());
    return json({ ok: true, stats });
  });
}

// GET /api/machines/:id/worker-assets?kind=zones|d1|r2|kv
async function workerAssetsRun(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const kind = new URL(request.url).searchParams.get("kind") || "";
  if (kind !== "zones" && kind !== "d1" && kind !== "r2" && kind !== "kv") {
    return json({ ok: false, error: "未知的资产类型" });
  }
  return wrap(async () => {
    const result = await listWorkerAssets(env.DB, vaultKeyOf(env), id, kind as "zones" | "d1" | "r2" | "kv", ACTOR, Date.now());
    return json({ ok: true, kind: result.kind, items: result.items, fetched_at: result.fetched_at });
  });
}

// DELETE /api/machines/:id/workers/:name — delete one Cloudflare Worker
// script under the entry's account, with the entry's stored token.
async function machineWorkerDelete(request: Request, env: Env, id: string, scriptName: string): Promise<Response> {
  if (request.method.toUpperCase() !== "DELETE") return methodNotAllowed("DELETE");
  const gate = await mutationGate(request);
  if (gate) return gate;
  return wrap(async () => {
    const machine = (await listMachines(env.DB, null)).find((row) => row.id === id);
    await deleteWorkerScriptForMachine(env.DB, id, vaultKeyOf(env), ACTOR, scriptName, Date.now());
    const name = machine?.name ?? id;
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "云主机",
      action: "删除",
      targetId: id,
      targetName: name,
      text: `删除了「${name}」名下的 Worker「${scriptName}」`,
    });
    return json({ ok: true });
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
  const method = request.method.toUpperCase();
  if (action === "devices") {
    if (method !== "GET") return methodNotAllowed("GET");
    return wrap(async () => {
      const devices = await listConnectionDevices(env.DB, vaultKeyOf(env), id);
      return json({ ok: true, devices });
    });
  }
  if (action === "credential") {
    if (method !== "GET") return methodNotAllowed("GET");
    return wrap(async () => {
      const revealed = await revealConnectionCredential(env.DB, vaultKeyOf(env), id, "panel", Date.now());
      const conn = (await listConnections(env.DB)).find((row) => row.id === id);
      const name = conn?.name ?? id;
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "云主机",
        action: "查看",
        targetId: id,
        targetName: name,
        text: `查看了服务商连接「${name}」的凭据`,
      });
      return json({ ok: true, credential: revealed.credential });
    });
  }
  if (method !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  if (action === "import") {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => {
      const result = await importConnectionDevices(env.DB, vaultKeyOf(env), id, body.value["deviceIds"], body.value["groupId"], ACTOR, Date.now());
      const conn = (await listConnections(env.DB)).find((row) => row.id === id);
      const name = conn?.name ?? id;
      const text = result.machines.length
        ? `从服务商连接「${name}」接入了 ${result.machines.length} 台设备`
        : `服务商连接「${name}」的所选设备都已接入，未新增`;
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "云主机",
        action: "添加",
        targetId: id,
        targetName: name,
        text,
      });
      return json({ ok: true, imported: result.machines.length, skipped: result.skipped, machines: result.machines }, result.machines.length ? 201 : 200);
    });
  }
  if (action === "credentials") {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    const config = (body.value["config"] ?? {}) as Record<string, unknown>;
    return wrap(async () => {
      const connection = await replaceConnectionCredentials(env.DB, vaultKeyOf(env), id, config, Date.now());
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "云主机",
        action: "修改",
        targetId: id,
        targetName: connection.name,
        text: `更新了服务商连接「${connection.name}」的凭据`,
      });
      return json({ ok: true, connection });
    });
  }
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
  const method = request.method.toUpperCase();
  if (method === "PATCH") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => {
      const before = (await listConnections(env.DB)).find((row) => row.id === id);
      const connection = await renameConnection(env.DB, id, body.value["name"], Date.now());
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "云主机",
        action: "修改",
        targetId: id,
        targetName: connection.name,
        text: `把服务商连接「${before?.name ?? id}」改名为「${connection.name}」`,
      });
      return json({ ok: true, connection });
    });
  }
  if (method !== "DELETE") return methodNotAllowed("PATCH, DELETE");
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


// ---------------------------------------------------------------------------
async function machineSyncOne(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  return wrap(async () => {
    const machine = await getMachine(env.DB, id);
    if (!machine) return json({ ok: false, error: "云主机不存在" }, 404);
    const result = await syncOneMachine(env.DB, vaultKeyOf(env), id, Date.now());
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "云主机",
      action: "同步",
      targetId: machine.id,
      targetName: machine.name,
      text: `同步了云主机「${machine.name}」的状态`,
    });
    const fresh = await getMachine(env.DB, id);
    return json({ ok: true, missing: result.missing, machine: fresh ? machinePublic(fresh) : null });
  });
}

// Per-machine operations: power, public ports, keepalive (imported devices)

const POWER_LABELS: Record<string, string> = { start: "启动", stop: "停止", suspend: "暂停", resume: "恢复" };

async function machinePower(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  const body = await readBody(request);
  if (!body.ok) return body.response;
  const action = typeof body.value.action === "string" ? body.value.action : "";
  return wrap(async () => {
    const machine = await getMachine(env.DB, id);
    if (!machine) return json({ ok: false, error: "云主机不存在" }, 404);
    await providerPower(env.DB, vaultKeyOf(env), id, action);
    if (machine.connection_id) {
      await syncConnection(env.DB, vaultKeyOf(env), machine.connection_id, Date.now()).catch(() => undefined);
    }
    const label = POWER_LABELS[action] ?? "电源操作";
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "云主机",
      action: label,
      targetId: id,
      targetName: machine.name,
      text: `${label}了云主机「${machine.name}」`,
    });
    const fresh = await getMachine(env.DB, id);
    return json({ ok: true, machine: fresh ? machinePublic(fresh) : null });
  });
}

async function machinePorts(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return wrap(async () => {
      const result = await providerPortsList(env.DB, vaultKeyOf(env), id);
      return json({ ok: true, enabled: result.enabled, ports: result.ports });
    });
  }
  if (method === "POST") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readBody(request);
    if (!body.ok) return body.response;
    const port = Number(body.value.port);
    const name = typeof body.value.name === "string" ? body.value.name.trim() : "";
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return json({ ok: false, error: "端口号需要是 1024 到 65535 的整数" }, 400);
    }
    if (port === 5901 || port === 6768) {
      return json({ ok: false, error: "5901 和 6768 是平台保留端口，不能公开" }, 400);
    }
    if (Array.from(name).length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
      return json({ ok: false, error: "端口名称最多 100 个字符，不能包含控制字符" }, 400);
    }
    return wrap(async () => {
      const machine = await getMachine(env.DB, id);
      if (!machine) return json({ ok: false, error: "云主机不存在" }, 404);
      const existing = await providerPortsList(env.DB, vaultKeyOf(env), id);
      if (existing.ports.length >= 16) return json({ ok: false, error: "每台机器最多公开 16 个端口" }, 400);
      if (existing.ports.some((entry) => entry.port === port)) return json({ ok: false, error: "这个端口已经公开了" }, 400);
      const created = await providerPortAdd(env.DB, vaultKeyOf(env), id, port, name);
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "云主机",
        action: "端口转发",
        targetId: id,
        targetName: machine.name,
        text: `给云主机「${machine.name}」公开了端口 ${port}`,
      });
      return json({ ok: true, port: created }, 201);
    });
  }
  return methodNotAllowed("GET, POST");
}

async function machinePortOne(request: Request, env: Env, id: string, port: number): Promise<Response> {
  if (request.method.toUpperCase() !== "DELETE") return methodNotAllowed("DELETE");
  const gate = await mutationGate(request);
  if (gate) return gate;
  return wrap(async () => {
    const machine = await getMachine(env.DB, id);
    if (!machine) return json({ ok: false, error: "云主机不存在" }, 404);
    await providerPortRemove(env.DB, vaultKeyOf(env), id, port);
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "云主机",
      action: "取消端口转发",
      targetId: id,
      targetName: machine.name,
      text: `取消了云主机「${machine.name}」的端口 ${port} 公开`,
    });
    return json({ ok: true });
  });
}

function readKeepaliveBody(value: Record<string, unknown>): { mode: "off" | "always" | "windows"; timezone: string; windows: Array<{ start: string; end: string }> } {
  const mode = typeof value.mode === "string" ? value.mode : "";
  if (mode !== "off" && mode !== "always" && mode !== "windows") throw new MachineError(400, "请选择有效的保活模式");
  const timezone = typeof value.timezone === "string" && value.timezone ? value.timezone : "Asia/Shanghai";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw new MachineError(400, "请选择有效的 IANA 时区，例如 Asia/Shanghai");
  }
  if (mode !== "windows") return { mode, timezone, windows: [] };
  if (!Array.isArray(value.windows) || value.windows.length < 1 || value.windows.length > 5) {
    throw new MachineError(400, "请设置 1 到 5 个时间段");
  }
  const occupied = new Set<number>();
  const windows = value.windows.map((entry) => {
    const window = (entry ?? {}) as { start?: unknown; end?: unknown };
    if (typeof window.start !== "string" || typeof window.end !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(window.start) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(window.end)) {
      throw new MachineError(400, "时间格式需要为 HH:mm");
    }
    const toMinutes = (text: string): number => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));
    const start = toMinutes(window.start);
    const end = toMinutes(window.end);
    if (start === end) throw new MachineError(400, "开始和结束时间不能相同；全天保活请用「全天」模式");
    for (let minute = start; minute !== end; minute = (minute + 1) % 1440) {
      if (occupied.has(minute)) throw new MachineError(400, "时间段不能重叠");
      occupied.add(minute);
    }
    return { start: window.start, end: window.end };
  });
  return { mode, timezone, windows };
}

async function machineKeepalive(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return wrap(async () => json({ ok: true, keepalive: await getKeepalive(env.DB, id) }));
  }
  if (method === "PUT") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => {
      const machine = await getMachine(env.DB, id);
      if (!machine) return json({ ok: false, error: "云主机不存在" }, 404);
      const policy = readKeepaliveBody(body.value);
      const saved = await putKeepalive(env.DB, id, policy, Date.now());
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "云主机",
        action: "保活设置",
        targetId: id,
        targetName: machine.name,
        text: `把云主机「${machine.name}」的保活设为${policy.mode === "off" ? "关闭" : policy.mode === "always" ? "全天" : "时段"}`,
      });
      return json({ ok: true, keepalive: saved });
    });
  }
  return methodNotAllowed("GET, PUT");
}
