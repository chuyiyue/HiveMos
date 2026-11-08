// Panel REST for the Soul tab. The caller in index.ts has already checked
// the admin session; mutations additionally pass the cross-site gate, same
// as the registry and calendar boards.

import { isCrossSite, json, readJsonLimited } from "./http";
import type { Env, WaitCtx } from "./env";
import {
  SoulError,
  createSoul,
  deleteSoul,
  getSoulById,
  listSouls,
  listVersions,
  rollbackSoul,
  soulDetail,
  soulSummary,
  soulVersionPublic,
  updateSoul,
} from "./soul";
import { logOp, panelActor } from "./oplog";

const MAX_BODY_BYTES = 512 * 1024; // Persona documents can be long.
const ACTOR = "user";

export async function handleSoulRequest(request: Request, env: Env, ctx: WaitCtx, path: string): Promise<Response | null> {
  void ctx;
  if (request.method.toUpperCase() !== "GET" && isCrossSite(request)) {
    return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  }
  if (path === "/api/soul") return collection(request, env);
  const versions = /^\/api\/soul\/([A-Za-z0-9_-]+)\/versions$/.exec(path);
  if (versions && versions[1]) return versionsRoute(request, env, versions[1]);
  const rollback = /^\/api\/soul\/([A-Za-z0-9_-]+)\/rollback$/.exec(path);
  if (rollback && rollback[1]) return rollbackRoute(request, env, rollback[1]);
  const one = /^\/api\/soul\/([A-Za-z0-9_-]+)$/.exec(path);
  if (one && one[1]) return oneRoute(request, env, one[1]);
  return null;
}

function wrap(handler: () => Promise<Response>): Promise<Response> {
  return handler().catch((error: unknown) => {
    if (error instanceof SoulError) return json({ ok: false, error: error.message }, error.status);
    return json({ ok: false, error: "暂时无法读写 Soul。请确认已经创建 D1 并应用迁移" }, 503);
  });
}

async function readBody(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const body = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!body.ok) return { ok: false, response: json({ ok: false, error: body.error }, body.status) };
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
    return { ok: false, response: json({ ok: false, error: "请求格式不正确" }, 400) };
  }
  return { ok: true, value: body.value as Record<string, unknown> };
}

function methodNotAllowed(allow: string): Response {
  return json({ ok: false, error: "方法不允许" }, 405, { allow });
}

async function collection(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return wrap(async () => json({ ok: true, souls: (await listSouls(env.DB)).map(soulSummary) }));
  }
  if (method === "POST") {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => {
      const created = await createSoul(env.DB, body.value, ACTOR, "panel", Date.now());
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "Soul",
        action: "添加",
        targetId: created.id,
        targetName: created.agent_name,
        text: `添加了 Soul（${created.agent_name}）`,
      });
      return json({ ok: true, soul: soulDetail(created) }, 201);
    });
  }
  return methodNotAllowed("GET, POST");
}

async function oneRoute(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return wrap(async () => {
      const row = await getSoulById(env.DB, id);
      if (!row) return json({ ok: false, error: "Soul 不存在" }, 404);
      return json({ ok: true, soul: soulDetail(row) });
    });
  }
  if (method === "PATCH") {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => {
      const updated = await updateSoul(env.DB, id, body.value, ACTOR, "panel", Date.now());
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "Soul",
        action: "修改",
        targetId: id,
        targetName: updated.agent_name,
        text: `修改了 Soul（${updated.agent_name}）`,
      });
      return json({ ok: true, soul: soulDetail(updated) });
    });
  }
  if (method === "DELETE") {
    return wrap(async () => {
      const before = await getSoulById(env.DB, id);
      await deleteSoul(env.DB, id, ACTOR, Date.now());
      const name = before?.agent_name ?? id;
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "Soul",
        action: "删除",
        targetId: id,
        targetName: name,
        text: `删除了 Soul（${name}）`,
      });
      return json({ ok: true });
    });
  }
  return methodNotAllowed("GET, PATCH, DELETE");
}

async function versionsRoute(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
  return wrap(async () => {
    const row = await getSoulById(env.DB, id);
    if (!row) return json({ ok: false, error: "Soul 不存在" }, 404);
    const versions = await listVersions(env.DB, id);
    return json({ ok: true, versions: versions.map(soulVersionPublic) });
  });
}

async function rollbackRoute(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const body = await readBody(request);
  if (!body.ok) return body.response;
  return wrap(async () => {
    const updated = await rollbackSoul(env.DB, id, body.value.version, ACTOR, Date.now());
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "Soul",
      action: "回滚",
      targetId: id,
      targetName: updated.agent_name,
      text: `把 Soul（${updated.agent_name}）回滚到旧版本`,
    });
    return json({ ok: true, soul: soulDetail(updated) });
  });
}
