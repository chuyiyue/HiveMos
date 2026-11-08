// Panel REST for the memory board. Routes sit behind the admin session gate
// (the caller in index.ts has already authenticated); mutations additionally
// pass the cross-site check here, same as calendar-http.

import { isCrossSite, json, readJsonLimited } from "./http";
import type { Env, WaitCtx } from "./env";
import {
  MemError,
  createMemory,
  createMemoryGroup,
  deleteMemory,
  deleteMemoryGroup,
  listMemories,
  listMemoryGroups,
  memoryGroupPublic,
  memoryPublic,
  renameMemoryGroup,
  updateMemory,
} from "./memory";
import { ingestMemories, tagOneMemory, tagUntaggedMemories } from "./memory-ai";

const MAX_BODY_BYTES = 256 * 1024;
const CHANNEL = { actor: "user", source: "panel", auditReads: false };

export async function handleMemoryRequest(request: Request, env: Env, ctx: WaitCtx, path: string): Promise<Response | null> {
  void ctx;
  if (request.method.toUpperCase() !== "GET" && isCrossSite(request)) {
    return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  }
  try {
    if (path === "/api/memory") return await memories(request, env);
    // 具体路径必须排在 /api/memory/:id 通配之前，否则 ingest、groups、
    // tag-untagged 会被当成记忆 id 吃掉。
    if (path === "/api/memory/ingest") return await ingest(request, env);
    if (path === "/api/memory/tag-untagged") return await tagUntagged(request, env);
    if (path === "/api/memory/groups") return await groups(request, env);
    const groupOne = /^\/api\/memory\/groups\/([A-Za-z0-9_-]+)$/.exec(path);
    if (groupOne && groupOne[1]) return await groupOneHandler(request, env, groupOne[1]);
    const tag = /^\/api\/memory\/([A-Za-z0-9_-]+)\/tag$/.exec(path);
    if (tag && tag[1]) return await tagOne(request, env, tag[1]);
    const one = /^\/api\/memory\/([A-Za-z0-9_-]+)$/.exec(path);
    if (one && one[1]) return await memoryOne(request, env, one[1]);
    return null;
  } catch (error) {
    if (error instanceof MemError) return json({ ok: false, error: error.message }, error.status);
    throw error;
  }
}

async function memories(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope");
    const query = (url.searchParams.get("q") || "").trim();
    const rows = await listMemories(env.DB, { scope: scope || null });
    const filtered = query
      ? rows.filter((row) => (row.title + "\n" + row.content + "\n" + (row.tags_json || "")).toLowerCase().includes(query.toLowerCase()))
      : rows;
    return json({ ok: true, memories: filtered.map(memoryPublic) });
  }
  if (method === "POST") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const created = await createMemory(env.DB, body, CHANNEL, Date.now());
    return json({ ok: true, memory: memoryPublic(created) }, 201);
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET, POST" });
}

async function ingest(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "POST" });
  }
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const result = await ingestMemories(env, body, CHANNEL, Date.now());
  return json(
    { ok: true, split: result.split, count: result.memories.length, memories: result.memories.map(memoryPublic) },
    201,
  );
}

async function tagUntagged(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "POST" });
  }
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const result = await tagUntaggedMemories(env, body.limit, CHANNEL, Date.now());
  return json({ ok: true, ...result });
}

async function tagOne(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "POST" });
  }
  const result = await tagOneMemory(env, id, CHANNEL, Date.now());
  return json({ ok: true, memory: memoryPublic(result.memory), skipped: result.skipped });
}

async function groups(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    const rows = await listMemoryGroups(env.DB);
    return json({ ok: true, groups: rows.map(memoryGroupPublic) });
  }
  if (method === "POST") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const created = await createMemoryGroup(env.DB, body, Date.now());
    return json({ ok: true, group: memoryGroupPublic(created) }, 201);
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET, POST" });
}

async function groupOneHandler(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH" || method === "PUT") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const updated = await renameMemoryGroup(env.DB, id, body, Date.now());
    return json({ ok: true, group: memoryGroupPublic(updated) });
  }
  if (method === "DELETE") {
    await deleteMemoryGroup(env.DB, id, Date.now());
    return json({ ok: true });
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "PATCH, DELETE" });
}

async function memoryOne(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH" || method === "PUT") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const updated = await updateMemory(env.DB, id, body, CHANNEL, Date.now());
    return json({ ok: true, memory: memoryPublic(updated) });
  }
  if (method === "DELETE") {
    const deleted = await deleteMemory(env.DB, id, CHANNEL, Date.now());
    return json({ ok: true, memory: memoryPublic(deleted) });
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "PATCH, DELETE" });
}

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  const parsed = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status);
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return json({ ok: false, error: "请求体格式不正确" }, 400);
  }
  return parsed.value as Record<string, unknown>;
}
