// Panel REST for the user operation log: GET /api/oplog.
// The gate in index.ts has already authenticated the admin session.
//
// Query parameters:
//   module   one of OPLOG_MODULES （中文标签）; omitted = all modules.
//            An unknown value is a 400, not an empty page
//   limit    page size, default 30, clamped 1..100
//   offset   rows to skip, default 0
// Response: { ok, entries: [{id, at, module, action, target, text}],
//             limit, offset, has_more, modules }

import { json } from "./http";
import type { Env, WaitCtx } from "./env";
import { OPLOG_BOARDS, OPLOG_MODULES, isOplogModule, listOps, oplogBoardModules } from "./oplog";

export async function handleOplogRequest(
  request: Request,
  env: Env,
  ctx: WaitCtx,
  path: string,
): Promise<Response | null> {
  void ctx;
  if (path !== "/api/oplog") return null;
  if (request.method.toUpperCase() !== "GET") {
    return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET" });
  }
  const url = new URL(request.url);
  const moduleParam = url.searchParams.get("module");
  if (moduleParam && !isOplogModule(moduleParam)) {
    return json({ ok: false, error: "板块不正确" }, 400);
  }
  const boardParam = url.searchParams.get("board");
  if (boardParam && !oplogBoardModules(boardParam)) {
    return json({ ok: false, error: "板块不正确" }, 400);
  }
  const limitRaw = Number(url.searchParams.get("limit"));
  const offsetRaw = Number(url.searchParams.get("offset"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(100, Math.floor(limitRaw)) : 30;
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
  try {
    const data = await listOps(env.DB, { module: moduleParam, board: boardParam, limit, offset });
    return json({
      ok: true,
      entries: data.entries,
      limit,
      offset,
      has_more: data.has_more,
      total: data.total,
      boards: OPLOG_BOARDS.map((board) => board.label),
      modules: OPLOG_MODULES,
    });
  } catch {
    return json({ ok: false, error: "暂时无法读取日志" }, 503);
  }
}
