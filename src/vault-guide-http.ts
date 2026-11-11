// 保险库「纯指引」的管理 REST（保险库页签内部子层的数据面）。
// 路由在管理员会话门之后（index.ts 已校验），与 /api/vault/* 隔离走
// /api/vault-broker/ 前缀。权限映射：读对应 vault.read、写对应
// vault.write 的管理面——管理员会话即全权，与 vault-http 同口径，不新增
// 权限域；agent 侧的 vault.read 在 MCP 工具层（tool-permissions）强制。
// 写操作补跨站检查。本模块没有任何出站请求：服务商连接说明只是文本，
// 引用只在领域层做本地格式校验。
//
// Routes:
//   GET    /api/vault-broker/providers          服务商列表
//   POST   /api/vault-broker/providers          新建服务商
//   PATCH  /api/vault-broker/providers/:id      局部更新（含停用）
//   DELETE /api/vault-broker/providers/:id      删除（下有条目时拒绝）
//   GET    /api/vault-broker/entries            条目列表
//   POST   /api/vault-broker/entries            新建条目（ref 本地校验）
//   PATCH  /api/vault-broker/entries/:id        局部更新（含停用）
//   DELETE /api/vault-broker/entries/:id        删除（授权随删，审计保留）
//   GET    /api/vault-broker/grants             授权列表（可按 entry_id / agent_id 过滤）
//   POST   /api/vault-broker/grants             新建授权（同条目同 agent 只许一行）
//   PATCH  /api/vault-broker/grants/:id         改过期时间 / 停用
//   DELETE /api/vault-broker/grants/:id         删除授权
//   GET    /api/vault-broker/audit              查看审计只读列表
//   GET    /api/vault-broker/audit/export       审计 JSON 导出

import { isCrossSite, json, readJsonLimited } from "./http";
import type { Env } from "./env";
import { logOp, panelActor } from "./oplog";
import {
  GuideError,
  auditPublic,
  createGuideEntry,
  createGuideGrant,
  createGuideProvider,
  deleteGuideEntry,
  deleteGuideGrant,
  deleteGuideProvider,
  entryPublic,
  findAgentName,
  getGuideProvider,
  grantPublic,
  listGuideAudit,
  listGuideEntries,
  listGuideGrants,
  listGuideProviders,
  providerPublic,
  updateGuideEntry,
  updateGuideGrant,
  updateGuideProvider,
} from "./vault-guide";

const MAX_BODY_BYTES = 64 * 1024;
const PREFIX = "/api/vault-broker";

export async function handleVaultGuideRequest(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== PREFIX && !path.startsWith(PREFIX + "/")) return null;
  if (request.method.toUpperCase() !== "GET" && isCrossSite(request)) {
    return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  }
  try {
    if (path === PREFIX + "/providers") return await providers(request, env);
    const providerOne = /^\/api\/vault-broker\/providers\/([A-Za-z0-9_-]+)$/.exec(path);
    if (providerOne && providerOne[1]) return await providerOneHandler(request, env, providerOne[1]);
    if (path === PREFIX + "/entries") return await entries(request, env);
    const entryOne = /^\/api\/vault-broker\/entries\/([A-Za-z0-9_-]+)$/.exec(path);
    if (entryOne && entryOne[1]) return await entryOneHandler(request, env, entryOne[1]);
    if (path === PREFIX + "/grants") return await grants(request, env);
    const grantOne = /^\/api\/vault-broker\/grants\/([A-Za-z0-9_-]+)$/.exec(path);
    if (grantOne && grantOne[1]) return await grantOneHandler(request, env, grantOne[1]);
    if (path === PREFIX + "/audit") return await audit(request, env);
    if (path === PREFIX + "/audit/export") return await auditExport(request, env);
    return json({ ok: false, error: "未找到" }, 404);
  } catch (error) {
    if (error instanceof GuideError) return json({ ok: false, error: error.message }, error.status);
    return json({ ok: false, error: "暂时无法读取指引数据" }, 503);
  }
}

function methodNotAllowed(allow: string): Response {
  return json({ ok: false, error: "方法不允许" }, 405, { allow });
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

async function log(request: Request, env: Env, action: string, targetId: string, targetName: string, text: string): Promise<void> {
  await logOp(env.DB, { actor: await panelActor(request, env), module: "保险库", action, targetId, targetName, text });
}

// ---- 服务商 -----------------------------------------------------------------

async function providers(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    const rows = await listGuideProviders(env.DB);
    return json({ ok: true, providers: rows.map(providerPublic) });
  }
  if (method === "POST") {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    const created = await createGuideProvider(env.DB, body.value);
    await log(request, env, "添加", created.id, created.name, `添加了指引服务商「${created.name}」`);
    return json({ ok: true, provider: providerPublic(created) }, 201);
  }
  return methodNotAllowed("GET, POST");
}

async function providerOneHandler(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH" || method === "PUT") {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    const updated = await updateGuideProvider(env.DB, id, body.value);
    await log(request, env, "修改", updated.id, updated.name, `修改了指引服务商「${updated.name}」`);
    return json({ ok: true, provider: providerPublic(updated) });
  }
  if (method === "DELETE") {
    const deleted = await deleteGuideProvider(env.DB, id);
    await log(request, env, "删除", deleted.id, deleted.name, `删除了指引服务商「${deleted.name}」`);
    return json({ ok: true });
  }
  return methodNotAllowed("PATCH, DELETE");
}

// ---- 条目 -------------------------------------------------------------------

async function entries(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    const [entryRows, providerRows] = await Promise.all([listGuideEntries(env.DB), listGuideProviders(env.DB)]);
    const byId = new Map(providerRows.map((row) => [row.id, row]));
    return json({ ok: true, entries: entryRows.map((row) => entryPublic(row, byId.get(row.provider_id) ?? null)) });
  }
  if (method === "POST") {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    const created = await createGuideEntry(env.DB, body.value);
    await log(request, env, "添加", created.id, created.name, `添加了指引条目「${created.name}」`);
    return json({ ok: true, entry: entryPublic(created, await getGuideProvider(env.DB, created.provider_id)) }, 201);
  }
  return methodNotAllowed("GET, POST");
}

async function entryOneHandler(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH" || method === "PUT") {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    const updated = await updateGuideEntry(env.DB, id, body.value);
    await log(request, env, "修改", updated.id, updated.name, `修改了指引条目「${updated.name}」`);
    return json({ ok: true, entry: entryPublic(updated, await getGuideProvider(env.DB, updated.provider_id)) });
  }
  if (method === "DELETE") {
    const deleted = await deleteGuideEntry(env.DB, id);
    await log(request, env, "删除", deleted.id, deleted.name, `删除了指引条目「${deleted.name}」`);
    return json({ ok: true });
  }
  return methodNotAllowed("PATCH, DELETE");
}

// ---- 授权 -------------------------------------------------------------------

async function grants(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    const url = new URL(request.url);
    const entryFilter = url.searchParams.get("entry_id") ?? "";
    const agentFilter = url.searchParams.get("agent_id") ?? "";
    const now = Date.now();
    const rows = (await listGuideGrants(env.DB)).filter(
      (row) => (entryFilter ? row.entry_id === entryFilter : true) && (agentFilter ? row.agent_id === agentFilter : true),
    );
    const names = new Map<string, string | null>();
    const out = [];
    for (const row of rows) {
      if (!names.has(row.agent_id)) names.set(row.agent_id, await findAgentName(env.DB, row.agent_id));
      out.push(grantPublic(row, names.get(row.agent_id) ?? null, now));
    }
    return json({ ok: true, grants: out });
  }
  if (method === "POST") {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    const created = await createGuideGrant(env.DB, body.value);
    const agentName = (await findAgentName(env.DB, created.agent_id)) ?? created.agent_id;
    await log(request, env, "添加", created.id, agentName, `给 Agent「${agentName}」添加了指引授权`);
    return json({ ok: true, grant: grantPublic(created, await findAgentName(env.DB, created.agent_id), Date.now()) }, 201);
  }
  return methodNotAllowed("GET, POST");
}

async function grantOneHandler(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH" || method === "PUT") {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    const updated = await updateGuideGrant(env.DB, id, body.value);
    return json({ ok: true, grant: grantPublic(updated, await findAgentName(env.DB, updated.agent_id), Date.now()) });
  }
  if (method === "DELETE") {
    const deleted = await deleteGuideGrant(env.DB, id);
    await log(request, env, "删除", deleted.id, deleted.agent_id, `删除了一条指引授权`);
    return json({ ok: true });
  }
  return methodNotAllowed("PATCH, DELETE");
}

// ---- 审计 -------------------------------------------------------------------

function auditFilter(request: Request): { entryId?: string; agentId?: string; limit?: number } {
  const url = new URL(request.url);
  const entryId = url.searchParams.get("entry_id") ?? undefined;
  const agentId = url.searchParams.get("agent_id") ?? undefined;
  const rawLimit = Number(url.searchParams.get("limit") ?? "");
  return { entryId, agentId, limit: Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined };
}

async function audit(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
  const rows = await listGuideAudit(env.DB, auditFilter(request));
  return json({ ok: true, audit: rows.map(auditPublic) });
}

async function auditExport(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
  const filter = auditFilter(request);
  const rows = await listGuideAudit(env.DB, { ...filter, limit: 500 });
  return json(
    { ok: true, exported_at: Date.now(), audit: rows.map(auditPublic) },
    200,
    { "content-disposition": 'attachment; filename="vault-guide-audit.json"' },
  );
}
