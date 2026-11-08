// Panel REST for the vault board. Routes sit behind the admin session gate
// (the caller in index.ts has already authenticated); mutations additionally
// pass the cross-site check here, same as memory-http. List responses only
// ever carry the tail of a secret; plaintext leaves through POST
// /api/vault/reveal, which writes an access-log row.

import { isCrossSite, json, readJsonLimited } from "./http";
import type { Env, WaitCtx } from "./env";
import {
  VaultError,
  createEmail,
  createEntry,
  createGateway,
  deleteEmail,
  deleteEntry,
  deleteGateway,
  emailPublic,
  entryPublic,
  gatewayPublic,
  listAccessLog,
  listEmails,
  listEntries,
  listGateways,
  revealSecret,
  updateEmail,
  updateEntry,
  updateGateway,
} from "./vault";

const MAX_BODY_BYTES = 64 * 1024;

export async function handleVaultRequest(request: Request, env: Env, ctx: WaitCtx, path: string): Promise<Response | null> {
  void ctx;
  if (request.method.toUpperCase() !== "GET" && isCrossSite(request)) {
    return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  }
  try {
    if (path === "/api/vault/entries") return await entries(request, env);
    const entryOne = /^\/api\/vault\/entries\/([A-Za-z0-9_-]+)$/.exec(path);
    if (entryOne && entryOne[1]) return await entryOneHandler(request, env, entryOne[1]);
    if (path === "/api/vault/gateways") return await gateways(request, env);
    const gatewayOne = /^\/api\/vault\/gateways\/([A-Za-z0-9_-]+)$/.exec(path);
    if (gatewayOne && gatewayOne[1]) return await gatewayOneHandler(request, env, gatewayOne[1]);
    if (path === "/api/vault/emails") return await emails(request, env);
    const emailOne = /^\/api\/vault\/emails\/([A-Za-z0-9_-]+)$/.exec(path);
    if (emailOne && emailOne[1]) return await emailOneHandler(request, env, emailOne[1]);
    if (path === "/api/vault/reveal") return await reveal(request, env);
    if (path === "/api/vault/access-log") return await accessLog(request, env);
    return null;
  } catch (error) {
    if (error instanceof VaultError) return json({ ok: false, error: error.message }, error.status);
    throw error;
  }
}

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  const parsed = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status);
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return json({ ok: false, error: "请求体格式不正确" }, 400);
  }
  return parsed.value as Record<string, unknown>;
}

async function entries(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return json({ ok: true, entries: (await listEntries(env.DB)).map(entryPublic) });
  }
  if (method === "POST") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const created = await createEntry(env.DB, env, body, Date.now());
    return json({ ok: true, entry: entryPublic(created) }, 201);
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET, POST" });
}

async function entryOneHandler(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH" || method === "PUT") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const updated = await updateEntry(env.DB, env, id, body, Date.now());
    return json({ ok: true, entry: entryPublic(updated) });
  }
  if (method === "DELETE") {
    const deleted = await deleteEntry(env.DB, id);
    return json({ ok: true, entry: entryPublic(deleted) });
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "PATCH, DELETE" });
}

async function gateways(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return json({ ok: true, gateways: (await listGateways(env.DB)).map(gatewayPublic) });
  }
  if (method === "POST") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const created = await createGateway(env.DB, env, body, Date.now());
    return json({ ok: true, gateway: gatewayPublic(created) }, 201);
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET, POST" });
}

async function gatewayOneHandler(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH" || method === "PUT") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const updated = await updateGateway(env.DB, env, id, body, Date.now());
    return json({ ok: true, gateway: gatewayPublic(updated) });
  }
  if (method === "DELETE") {
    const deleted = await deleteGateway(env.DB, id);
    return json({ ok: true, gateway: gatewayPublic(deleted) });
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "PATCH, DELETE" });
}

async function emails(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return json({ ok: true, emails: (await listEmails(env.DB)).map(emailPublic) });
  }
  if (method === "POST") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const created = await createEmail(env.DB, body, Date.now());
    return json({ ok: true, email: emailPublic(created) }, 201);
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET, POST" });
}

async function emailOneHandler(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH" || method === "PUT") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const updated = await updateEmail(env.DB, id, body, Date.now());
    return json({ ok: true, email: emailPublic(updated) });
  }
  if (method === "DELETE") {
    const deleted = await deleteEmail(env.DB, id);
    return json({ ok: true, email: emailPublic(deleted) });
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "PATCH, DELETE" });
}

async function reveal(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "POST" });
  }
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const result = await revealSecret(env.DB, env, body, Date.now());
  return json({ ok: true, reveal: result });
}

async function accessLog(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET" });
  }
  const rows = await listAccessLog(env.DB, 100);
  return json({
    ok: true,
    access_log: rows.map((row) => ({
      id: row.id,
      target_kind: row.target_kind,
      target_id: row.target_id,
      target_name: row.target_name,
      action: row.action,
      created_at: row.created_at,
    })),
  });
}
