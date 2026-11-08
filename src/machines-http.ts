// Panel REST for the machines board. The caller in index.ts has already
// checked the admin session; writes pass the same cross-site mutation gate
// as the registry routes.

import { isCrossSite, json, readJsonLimited } from "./http";
import type { Env, WaitCtx } from "./env";
import {
  createMachine,
  deleteMachine,
  fetchWorkersForMachine,
  listMachines,
  MACHINE_KINDS,
  MachineError,
  machinePublic,
  revealMachineSecret,
  updateMachine,
  vaultKeyOf,
} from "./machines";

const MAX_BODY_BYTES = 64 * 1024;
const ACTOR = "user";

export async function handleMachinesRequest(request: Request, env: Env, ctx: WaitCtx, path: string): Promise<Response | null> {
  void ctx;
  if (path === "/api/machines") return collection(request, env);
  const action = /^\/api\/machines\/([A-Za-z0-9_-]+)\/(reveal|workers)$/.exec(path);
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

async function collection(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    const kind = new URL(request.url).searchParams.get("kind");
    if (kind !== null && !MACHINE_KINDS.includes(kind)) {
      return json({ ok: false, error: "类型不正确" }, 400);
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
    return wrap(async () => json({ ok: true, machine: machinePublic(await updateMachine(env.DB, id, body.value, ACTOR, "panel", Date.now(), vaultKeyOf(env))) }));
  }
  if (method === "DELETE") {
    const gate = await mutationGate(request);
    if (gate) return gate;
    return wrap(async () => {
      await deleteMachine(env.DB, id, ACTOR, "panel", Date.now());
      return json({ ok: true });
    });
  }
  return methodNotAllowed("PATCH, DELETE");
}

// POST-only sub actions: reveal hands back the stored secret (audited in the
// core), workers lists the Cloudflare account's scripts with the stored
// token. Neither accepts a body.
async function machineAction(request: Request, env: Env, id: string, action: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const gate = await mutationGate(request);
  if (gate) return gate;
  if (action === "reveal") {
    return wrap(async () => {
      const result = await revealMachineSecret(env.DB, id, vaultKeyOf(env), ACTOR, Date.now());
      return json({ ok: true, reveal: result });
    });
  }
  return wrap(async () => {
    const result = await fetchWorkersForMachine(env.DB, id, vaultKeyOf(env), ACTOR, Date.now());
    return json({ ok: true, workers: result.workers, fetched_at: result.fetched_at });
  });
}
