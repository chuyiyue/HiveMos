// Panel REST for the unified records feed: GET /api/records.
// The gate in index.ts has already authenticated the admin session.
//
// Query parameters:
//   module   one of RECORD_MODULES keys; omitted = all boards.
//            An unknown key is a 400, not an empty page
//   agent_id restrict to one agent's records (actor-bearing sources only)
//   limit    page size, default 30, clamped 1..100
//   offset   rows to skip, default 0
// Response: { ok, records, limit, offset, has_more, modules, degraded }

import { json } from "./http";
import type { Env, WaitCtx } from "./env";
import { RECORD_MODULES, isRecordModule, listRecords } from "./records";

export async function handleRecordsRequest(
  request: Request,
  env: Env,
  ctx: WaitCtx,
  path: string,
): Promise<Response | null> {
  void ctx;
  if (path !== "/api/records") return null;
  if (request.method.toUpperCase() !== "GET") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET" });
  }
  const url = new URL(request.url);
  const moduleParam = url.searchParams.get("module");
  if (moduleParam && !isRecordModule(moduleParam)) {
    return json({ ok: false, error: "板块不正确" }, 400);
  }
  const agentId = url.searchParams.get("agent_id") || null;
  const limitRaw = Number(url.searchParams.get("limit"));
  const offsetRaw = Number(url.searchParams.get("offset"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(100, Math.floor(limitRaw)) : 30;
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
  try {
    const data = await listRecords(env.DB, { module: moduleParam, agentId, limit, offset });
    return json({
      ok: true,
      records: data.records,
      limit,
      offset,
      has_more: data.has_more,
      total: data.total,
      degraded: data.degraded,
      modules: RECORD_MODULES,
      generated_at: Date.now(),
    });
  } catch {
    return json({ ok: false, error: "暂时无法读取记录" }, 503);
  }
}
