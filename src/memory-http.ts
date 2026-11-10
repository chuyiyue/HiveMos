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
  searchMemories,
  updateMemory,
} from "./memory";
import { ingestMemories, mergeSimilarTags, tagOneMemory, tagUntaggedMemories } from "./memory-ai";
import { embedMemoryNow } from "./memory-vector";
import {
  approveProposal,
  listProposalViews,
  rejectProposal,
} from "./memory-proposals";
import { logOp, panelActor } from "./oplog";

const MAX_BODY_BYTES = 256 * 1024;
const CHANNEL = { actor: "user", source: "panel", auditReads: false };

export async function handleMemoryRequest(request: Request, env: Env, ctx: WaitCtx, path: string): Promise<Response | null> {
  if (request.method.toUpperCase() !== "GET" && isCrossSite(request)) {
    return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  }
  try {
    if (path === "/api/memory") return await memories(request, env, ctx);
    // 具体路径必须排在 /api/memory/:id 通配之前，否则 ingest、groups、
    // tag-untagged、proposals 会被当成记忆 id 吃掉。
    if (path === "/api/memory/ingest") return await ingest(request, env, ctx);
    if (path === "/api/memory/tag-untagged") return await tagUntagged(request, env);
    if (path === "/api/memory/proposals") return await proposalsList(request, env);
    const proposalAct = /^\/api\/memory\/proposals\/([A-Za-z0-9_-]+)\/(approve|reject)$/.exec(path);
    if (proposalAct && proposalAct[1] && proposalAct[2]) return await proposalActOne(request, env, proposalAct[1], proposalAct[2]);
    // 存量近义合并。单数写法是本模块的路由约定，双数别名对角兼容旧写法。
    if (path === "/api/memory/tags/merge" || path === "/api/memories/tags/merge") return await mergeTags(request, env);
    if (path === "/api/memory/groups") return await groups(request, env);
    const groupOne = /^\/api\/memory\/groups\/([A-Za-z0-9_-]+)$/.exec(path);
    if (groupOne && groupOne[1]) return await groupOneHandler(request, env, groupOne[1]);
    const tag = /^\/api\/memory\/([A-Za-z0-9_-]+)\/tag$/.exec(path);
    if (tag && tag[1]) return await tagOne(request, env, tag[1]);
    const one = /^\/api\/memory\/([A-Za-z0-9_-]+)$/.exec(path);
    if (one && one[1]) return await memoryOne(request, env, ctx, one[1]);
    return null;
  } catch (error) {
    if (error instanceof MemError) return json({ ok: false, error: error.message }, error.status);
    throw error;
  }
}

async function memories(request: Request, env: Env, ctx: WaitCtx): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope");
    const query = (url.searchParams.get("q") || "").trim();
    // 面板搜索与 MCP memory_search 共用 searchMemories（FTS 相关度排序，
    // 不可用或零命中时自动回退 LIKE）；无关键词时仍走全量列表读序。
    const rows = query
      ? await searchMemories(env.DB, query, scope || null, { limit: 500 })
      : await listMemories(env.DB, { scope: scope || null });
    return json({ ok: true, memories: rows.map(memoryPublic) });
  }
  if (method === "POST") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const created = await createMemory(env.DB, body, CHANNEL, Date.now(), { ai: { env, ctx } });
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "记忆",
      action: "添加",
      targetId: created.id,
      targetName: created.title,
      text: `添加了记忆「${created.title}」`,
    });
    return json({ ok: true, memory: memoryPublic(created) }, 201);
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET, POST" });
}

async function ingest(request: Request, env: Env, ctx: WaitCtx): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "POST" });
  }
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const result = await ingestMemories(env, body, CHANNEL, Date.now(), ctx);
  await logOp(env.DB, {
    actor: await panelActor(request, env),
    module: "记忆",
    action: "添加",
    targetId: null,
    targetName: null,
    text: result.pending
      ? "通过智能录入添加了 1 条记忆（AI 拆分与打标待后台补全）"
      : result.split
        ? `通过智能录入添加了记忆，AI 拆成 ${result.memories.length} 条`
        : "通过智能录入添加了 1 条记忆（AI 不可用，整段保存）",
  });
  // 写入路径顺手补当前一条向量，失败不影响返回（回填由 cron 兜底）。
  for (const memory of result.memories) {
    ctx.waitUntil(embedMemoryNow(env, memory.id).catch(() => undefined));
  }
  return json(
    {
      ok: true,
      split: result.split,
      pending: result.pending,
      count: result.memories.length,
      memories: result.memories.map(memoryPublic),
    },
    201,
  );
}

async function proposalsList(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET" });
  }
  const url = new URL(request.url);
  const status = (url.searchParams.get("status") || "pending").trim() || "pending";
  const proposals = await listProposalViews(env.DB, status);
  return json({ ok: true, proposals });
}

async function proposalActOne(request: Request, env: Env, id: string, action: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "POST" });
  }
  const actor = await panelActor(request, env);
  const now = Date.now();
  if (action === "approve") {
    const result = await approveProposal(env, id, actor, now);
    await logOp(env.DB, {
      actor,
      module: "记忆",
      action: "批准提案",
      targetId: id,
      targetName: null,
      text: `批准了记忆整理提案（${result.proposal.type}），动作：${result.action}`,
    });
    return json({ ok: true, proposal: result.proposal, action: result.action, updated: result.updated });
  }
  const rejected = await rejectProposal(env.DB, id, actor, now);
  await logOp(env.DB, {
    actor,
    module: "记忆",
    action: "拒绝提案",
    targetId: id,
    targetName: null,
    text: `拒绝了记忆整理提案（${rejected.type}）`,
  });
  return json({ ok: true, proposal: rejected });
}

async function tagUntagged(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "POST" });
  }
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const result = await tagUntaggedMemories(env, body.limit, CHANNEL, Date.now());
  if (result.tagged > 0) {
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "记忆",
      action: "打标",
      targetId: null,
      targetName: null,
      text: `AI 补全标签：给 ${result.tagged} 条记忆打上了标签`,
    });
  }
  return json({ ok: true, ...result });
}

async function mergeTags(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "POST" });
  }
  const result = await mergeSimilarTags(env, CHANNEL, Date.now());
  const merged = Object.keys(result.mapping).length;
  if (merged > 0) {
    // 完整映射进系统日志，方便事后核对哪几个标签被并到了哪里。
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "记忆",
      action: "合并标签",
      targetId: null,
      targetName: null,
      text: `合并近义标签：并掉 ${merged} 个标签，更新 ${result.updated} 条记忆。映射：${JSON.stringify(result.mapping)}`,
    });
  }
  return json({ ok: true, mapping: result.mapping, updated: result.updated });
}

async function tagOne(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "POST" });
  }
  const result = await tagOneMemory(env, id, CHANNEL, Date.now());
  if (!result.skipped) {
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "记忆",
      action: "打标",
      targetId: id,
      targetName: result.memory.title,
      text: `给记忆「${result.memory.title}」打上了标签`,
    });
  }
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
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "分组",
      action: "添加",
      targetId: created.id,
      targetName: created.name,
      text: `添加了记忆分组「${created.name}」`,
    });
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
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "分组",
      action: "修改",
      targetId: id,
      targetName: updated.name,
      text: `把记忆分组改名为「${updated.name}」`,
    });
    return json({ ok: true, group: memoryGroupPublic(updated) });
  }
  if (method === "DELETE") {
    const before = (await listMemoryGroups(env.DB)).find((group) => group.id === id);
    await deleteMemoryGroup(env.DB, id, Date.now());
    const name = before?.name ?? id;
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "分组",
      action: "删除",
      targetId: id,
      targetName: name,
      text: `删除了记忆分组「${name}」`,
    });
    return json({ ok: true });
  }
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "PATCH, DELETE" });
}

async function memoryOne(request: Request, env: Env, ctx: WaitCtx, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH" || method === "PUT") {
    const body = await readBody(request);
    if (body instanceof Response) return body;
    const updated = await updateMemory(env.DB, id, body, CHANNEL, Date.now(), { ai: { env, ctx } });
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "记忆",
      action: "修改",
      targetId: id,
      targetName: updated.title,
      text: `修改了记忆「${updated.title}」`,
    });
    return json({ ok: true, memory: memoryPublic(updated) });
  }
  if (method === "DELETE") {
    const deleted = await deleteMemory(env.DB, id, CHANNEL, Date.now());
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "记忆",
      action: "删除",
      targetId: id,
      targetName: deleted.title,
      text: `删除了记忆「${deleted.title}」`,
    });
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
