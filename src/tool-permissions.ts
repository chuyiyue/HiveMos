// MCP 工具的权限分类：单一事实来源。
//
// 口径：改变系统内容 = write，读取 = read；审计写入不算 write。
// 每个工具恰好一个 (域, 操作)，个别工具另需一个 advanced 开关。
// tools/list 与 tools/call 都只读这一份表，别再在别处重复分类。

import { hasAdvanced, hasGrant } from "./permissions";
import type { AdvancedPermission, AgentPermissions, PermissionDomain, PermissionOp } from "./permissions";

export interface ToolPermission {
  domain: PermissionDomain;
  op: PermissionOp;
  // advanced 开关（machines_secret / soul_write_any）；vault_totp_code 本阶段不参与校验
  advanced?: AdvancedPermission;
}

export const TOOL_PERMISSIONS: Record<string, ToolPermission> = {
  // ---- read ----
  mcp_search: { domain: "mcp", op: "read" },
  mcp_list: { domain: "mcp", op: "read" },
  mcp_get: { domain: "mcp", op: "read" },
  skills_list: { domain: "skills", op: "read" },
  skills_get: { domain: "skills", op: "read" },
  apis_list: { domain: "api", op: "read" },
  apis_get: { domain: "api", op: "read" },
  memory_list: { domain: "memory", op: "read" },
  memory_search: { domain: "memory", op: "read" },
  memory_get: { domain: "memory", op: "read" },
  soul_list: { domain: "soul", op: "read" },
  soul_get: { domain: "soul", op: "read" },
  tasks_list: { domain: "tasks", op: "read" },
  calendar_list_calendars: { domain: "calendar", op: "read" },
  calendar_list_events: { domain: "calendar", op: "read" },
  calendar_get_event: { domain: "calendar", op: "read" },
  calendar_search: { domain: "calendar", op: "read" },
  machines_list: { domain: "machines", op: "read" },
  machines_get: { domain: "machines", op: "read" },
  machines_get_access: { domain: "machines", op: "read", advanced: "machines_secret" },

  // ---- write ----
  memory_upsert: { domain: "memory", op: "write" },
  memory_delete: { domain: "memory", op: "write" },
  soul_update: { domain: "soul", op: "write" },
  tasks_create: { domain: "tasks", op: "write" },
  tasks_update: { domain: "tasks", op: "write" },
  tasks_complete: { domain: "tasks", op: "write" },
  calendar_create_event: { domain: "calendar", op: "write" },
  calendar_update_event: { domain: "calendar", op: "write" },
  calendar_delete_event: { domain: "calendar", op: "write" },
  machines_report: { domain: "machines", op: "write" },
};

export function toolPermissionOf(name: string): ToolPermission | null {
  return Object.prototype.hasOwnProperty.call(TOOL_PERMISSIONS, name) ? TOOL_PERMISSIONS[name] : null;
}

const OP_LABEL: Record<PermissionOp, string> = { read: "读取", write: "写入" };

// tools/list 的可见性：域的开关键与 advanced 开关都要过。
export function toolVisibleToAgent(name: string, perms: AgentPermissions): boolean {
  const permission = toolPermissionOf(name);
  if (!permission) return false;
  if (!hasGrant(perms, permission.domain, permission.op)) return false;
  if (permission.advanced && !hasAdvanced(perms, permission.advanced)) return false;
  return true;
}

// tools/call 的复查：返回 null 表示放行，否则返回给调用方的错误文案。
// 纯函数（不碰库），scripts/perm-vectors.mjs 直接拿它跑校验矩阵。
export function toolAccessError(
  name: string,
  perms: AgentPermissions,
  agentName: string,
  args: Record<string, unknown>,
): string | null {
  const permission = toolPermissionOf(name);
  if (!permission) return null;
  if (!hasGrant(perms, permission.domain, permission.op)) {
    return "该 Agent 没有 " + permission.domain + " 的" + OP_LABEL[permission.op] + "权限，无法调用这个工具";
  }
  if (permission.advanced === "machines_secret" && !hasAdvanced(perms, "machines_secret")) {
    return "该 Agent 没有查看机器接入凭据的高级权限，无法调用这个工具";
  }
  // 归属判断沿用旧口径：身份取自 Bearer，写别人的 Soul 才要 soul_write_any。
  // 缺 agent_name 的请求放行到工具自身的参数校验（仍是原来的「请提供 agent_name」）。
  if (name === "soul_update") {
    const requested = args.agent_name;
    if (typeof requested === "string" && requested.trim() && requested.trim() !== agentName) {
      if (!hasAdvanced(perms, "soul_write_any")) {
        return "只能写自己的 Soul；要代写其他 Agent 的 Soul，需要 soul_write_any 权限";
      }
    }
  }
  return null;
}
