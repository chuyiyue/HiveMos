// MCP 工具的权限分类：单一事实来源。
//
// 口径：改变系统内容 = write，读取 = read；审计写入不算 write。
// 每个工具恰好一个 (域, 操作)，个别工具另需一个高级域的 (key, 操作)。
// tools/list 与 tools/call 都只读这一份表，别再在别处重复分类。
// Soul 的归属门（读/写他人 Soul 要 soul_other 对应操作）依赖调用参数，
// 不在表里，统一在 toolAccessError 里按 agent_name 判断。

import { hasAdvanced, hasGrant } from "./permissions";
import type { AdvancedPermission, AgentPermissions, PermissionDomain, PermissionOp } from "./permissions";

export interface ToolPermission {
  domain: PermissionDomain;
  op: PermissionOp;
  // 高级域要求（key + 操作），个别工具另需一个，如取码工具要 totp.read。
  advanced?: { key: AdvancedPermission; op: PermissionOp };
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
  soul_diff: { domain: "soul", op: "read" },
  tasks_list: { domain: "tasks", op: "read" },
  calendar_list_calendars: { domain: "calendar", op: "read" },
  calendar_list_events: { domain: "calendar", op: "read" },
  calendar_get_event: { domain: "calendar", op: "read" },
  calendar_search: { domain: "calendar", op: "read" },
  machines_list: { domain: "machines", op: "read" },
  machines_get: { domain: "machines", op: "read" },
  // 机器明文凭据并入 machines 域：只需读权限 + handler 内的审计，无高级门。
  machines_get_access: { domain: "machines", op: "read" },
  vault_2fa_list: { domain: "vault", op: "read", advanced: { key: "totp", op: "read" } },
  vault_2fa_get_code: { domain: "vault", op: "read", advanced: { key: "totp", op: "read" } },

  // ---- write ----
  memory_upsert: { domain: "memory", op: "write" },
  memory_remember: { domain: "memory", op: "write" },
  memory_delete: { domain: "memory", op: "write" },
  soul_update: { domain: "soul", op: "write" },
  soul_patch: { domain: "soul", op: "write" },
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

// tools/list 的可见性：域权限与高级域要求都要过。Soul 归属门依赖参数，
// 不影响可见性（soul_get 等对所有持 soul 读的 Agent 可见，调用时再按目标判断）。
export function toolVisibleToAgent(name: string, perms: AgentPermissions): boolean {
  const permission = toolPermissionOf(name);
  if (!permission) return false;
  if (!hasGrant(perms, permission.domain, permission.op)) return false;
  if (permission.advanced && !hasAdvanced(perms, permission.advanced.key, permission.advanced.op)) return false;
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
  if (permission.advanced && !hasAdvanced(perms, permission.advanced.key, permission.advanced.op)) {
    return "该 Agent 没有 2FA 的读取权限，无法调用这个工具";
  }
  // Soul 归属门：soul 域严格只覆盖 agent_name 等于调用者本名的那一份 Soul。
  // 读/写他人的 Soul（含以他人名义新建）分别要 soul_other 的读/写；对 soul 域
  // 来说别人的 Soul 等于不存在。缺 agent_name 的写请求放行到工具自身的参数
  // 校验（soul_patch 缺省即写自己，soul_update 仍是原来的「请提供 agent_name」）。
  const requested = args.agent_name;
  const targetsOther =
    typeof requested === "string" && requested.trim() !== "" && requested.trim() !== agentName;
  if ((name === "soul_get" || name === "soul_diff") && targetsOther) {
    if (!hasAdvanced(perms, "soul_other", "read")) {
      return "只能读自己的 Soul；要读其他 Agent 的 Soul，需要「操作其他 Soul」的读取权限";
    }
  }
  if ((name === "soul_update" || name === "soul_patch") && targetsOther) {
    if (!hasAdvanced(perms, "soul_other", "write")) {
      return "只能写自己的 Soul；要写其他 Agent 的 Soul，需要「操作其他 Soul」的写入权限";
    }
  }
  return null;
}
