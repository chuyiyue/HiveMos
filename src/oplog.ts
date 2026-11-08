// 用户操作日志：管理员在面板里的写操作统一落 user_ops，供总览页的
// 「系统日志」页签展示。它与各模块审计表是两个视角——审计表记「谁取用
// 了什么」（含 Agent 经 MCP 的调用），user_ops 只记「管理员做了什么」。
//
// logOp 是旁路写入：try/catch 吞掉一切失败（包括迁移还没应用、表不存
// 在），绝不让日志连累真正的业务请求。

import { findSessionUser } from "./accounts";
import { SESSION_COOKIE, sha256Hex } from "./auth";
import type { D1Database, Env } from "./env";
import { readCookie } from "./http";

// 系统日志的模块值域（前端筛选 chips 与 GET /api/oplog 的 module 参数
// 都以此为准）。
export const OPLOG_MODULES = [
  "Agent",
  "MCP",
  "Skills",
  "API",
  "应用",
  "记忆",
  "Soul",
  "任务",
  "日历",
  "云主机",
  "保险库",
  "分组",
  "设置",
  "账号",
] as const;

export function isOplogModule(value: string): boolean {
  return (OPLOG_MODULES as readonly string[]).includes(value);
}

export interface OpLogEntry {
  actor: string;
  module: string;
  action: string;
  targetId?: string | null;
  targetName?: string | null;
  text: string;
}

export async function logOp(db: D1Database, entry: OpLogEntry): Promise<void> {
  try {
    await db
      .prepare(
        "INSERT INTO user_ops (at, actor, module, action, target_id, target_name, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        Date.now(),
        entry.actor || "管理员",
        entry.module,
        entry.action,
        entry.targetId ?? null,
        entry.targetName ?? null,
        entry.text,
      )
      .run();
  } catch {
    // 日志写不进去就丢掉，不能连累业务。
  }
}

// 面板请求的操作者名字：从会话 cookie 反查当前管理员。查不到（会话刚
// 失效等）时回退到「管理员」，日志照样落。
export async function panelActor(request: Request, env: Env): Promise<string> {
  try {
    const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
    if (!token) return "管理员";
    const user = await findSessionUser(env.DB, await sha256Hex(token));
    if (user && user.disabled_at == null && user.expires_at > Date.now()) return user.username;
  } catch {
    // 取不到就用默认称呼。
  }
  return "管理员";
}

export interface OpLogItem {
  id: number;
  at: number;
  module: string;
  action: string;
  target: string | null;
  text: string;
}

interface OpRow {
  id: number;
  at: number;
  module: string;
  action: string;
  target_name: string | null;
  text: string;
}

export async function listOps(
  db: D1Database,
  options: { module?: string | null; limit: number; offset: number },
): Promise<{ entries: OpLogItem[]; has_more: boolean }> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit) || 30));
  const offset = Math.max(0, Math.floor(options.offset) || 0);
  const binds: Array<string | number> = [];
  let sql = "SELECT id, at, module, action, target_name, text FROM user_ops";
  if (options.module) {
    sql += " WHERE module = ?";
    binds.push(options.module);
  }
  sql += " ORDER BY at DESC, id DESC LIMIT ? OFFSET ?";
  binds.push(limit + 1, offset);
  const result = await db.prepare(sql).bind(...binds).all<OpRow>();
  const rows = Array.isArray(result) ? result : result.results ?? [];
  const hasMore = rows.length > limit;
  return {
    entries: rows.slice(0, limit).map((row) => ({
      id: row.id,
      at: row.at,
      module: row.module,
      action: row.action,
      target: row.target_name,
      text: row.text,
    })),
    has_more: hasMore,
  };
}
