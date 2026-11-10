// MCP 工具的权限分类：单一事实来源。
//
// 口径：改变系统内容 = write，读取 = read；审计写入不算 write。
// 普通工具恰好一个 (域, 操作)，个别工具另需一个高级域的 (key, 操作)；
// 另有两类「纯高级域」工具只认一个高级域、不挂任何普通域：
//   - agents_*（agents_list / agents_get / agents_rotate_token /
//     agents_set_enabled）只认 agents_other（操作其他 Agent），域里没有
//     agents 这个普通域，权限矩阵上只能在高级行里勾；
//   - vault_2fa_*（保险库验证码）只认 totp.read。2FA 与保险库其余功能
//     （vault 域的条目/邮箱/网关读写工具）彻底分开、互不附带——有 vault
//     读写取不了码，只有 totp 也看不见碰不了条目（2026-11-10 Roye 定）。
// tools/list 与 tools/call 都只读这一份表，别再在别处重复分类。
// Soul 的归属门（读/写他人 Soul 要 soul_other 对应操作）与 agents_* 的
// 「只能操作其他 Agent」门都依赖调用参数/调用者身份，不在表里：
// toolAccessError 按参数预判（agents_get 的 id/name、写工具的 id），
// handler 解析出目标后按 id 复判（写工具的 name 定位、id 与 name 不一致
// 的情形），两层同一文案。

import { hasAdvanced, hasGrant } from "./permissions";
import type { AdvancedPermission, AgentPermissions, PermissionDomain, PermissionOp } from "./permissions";

export interface ToolPermission {
  // 普通域 + 操作；纯高级域工具没有这一项（domain/op 同时缺席）。
  domain?: PermissionDomain;
  op?: PermissionOp;
  // 高级域要求（key + 操作）：普通工具是「域之上再加一道」，纯高级域
  // 工具有且只有这一项。
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
  // 代理（proxy 域）：list 返回的订阅与节点是 Public 形状、不带密封原文；
  // reveal/copy 是敏感读，明文在 handler 里先写审计（machines_audit，复用
  // nodes 的 revealSubscriptionUrl / copyNodeRaw，审计失败不放明文）。
  proxy_list: { domain: "proxy", op: "read" },
  proxy_reveal_subscription: { domain: "proxy", op: "read" },
  proxy_copy_node: { domain: "proxy", op: "read" },
  // 保险库（vault 域）：条目/邮箱/网关的列表与明文读取。list 只回元信息，
  // get_* 的明文在 handler 里先写 vault_access_log 审计（fail-closed，
  // 复用 vault.ts 的 revealSecret），审计失败不放明文。
  vault_list_entries: { domain: "vault", op: "read" },
  vault_get_entry: { domain: "vault", op: "read" },
  vault_list_emails: { domain: "vault", op: "read" },
  vault_get_email: { domain: "vault", op: "read" },
  vault_list_gateways: { domain: "vault", op: "read" },
  vault_get_gateway: { domain: "vault", op: "read" },
  // 验证码是纯高级域工具：只认 totp.read，不挂 vault 域（见文件头）。
  vault_2fa_list: { advanced: { key: "totp", op: "read" } },
  vault_2fa_get_code: { advanced: { key: "totp", op: "read" } },
  tasks_get: { domain: "tasks", op: "read" },
  // 操作其他 Agent 是纯高级域工具：只认 agents_other，不挂任何普通域。
  // 「只能操作其他 Agent」的自我门分两层判，见文件头。
  agents_list: { advanced: { key: "agents_other", op: "read" } },
  agents_get: { advanced: { key: "agents_other", op: "read" } },

  // ---- write ----
  mcp_create: { domain: "mcp", op: "write" },
  mcp_update: { domain: "mcp", op: "write" },
  mcp_delete: { domain: "mcp", op: "write" },
  skills_create: { domain: "skills", op: "write" },
  skills_update: { domain: "skills", op: "write" },
  skills_delete: { domain: "skills", op: "write" },
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
  machines_create: { domain: "machines", op: "write" },
  machines_update: { domain: "machines", op: "write" },
  machines_delete: { domain: "machines", op: "write" },
  proxy_create_subscription: { domain: "proxy", op: "write" },
  proxy_update_subscription: { domain: "proxy", op: "write" },
  proxy_delete_subscription: { domain: "proxy", op: "write" },
  proxy_import_nodes: { domain: "proxy", op: "write" },
  proxy_update_node_note: { domain: "proxy", op: "write" },
  proxy_delete_node: { domain: "proxy", op: "write" },
  apis_create: { domain: "api", op: "write" },
  apis_update: { domain: "api", op: "write" },
  apis_delete: { domain: "api", op: "write" },
  vault_create_entry: { domain: "vault", op: "write" },
  vault_update_entry: { domain: "vault", op: "write" },
  vault_delete_entry: { domain: "vault", op: "write" },
  vault_create_email: { domain: "vault", op: "write" },
  vault_update_email: { domain: "vault", op: "write" },
  vault_delete_email: { domain: "vault", op: "write" },
  vault_create_gateway: { domain: "vault", op: "write" },
  vault_update_gateway: { domain: "vault", op: "write" },
  vault_delete_gateway: { domain: "vault", op: "write" },
  agents_rotate_token: { advanced: { key: "agents_other", op: "write" } },
  agents_set_enabled: { advanced: { key: "agents_other", op: "write" } },
};

export function toolPermissionOf(name: string): ToolPermission | null {
  return Object.prototype.hasOwnProperty.call(TOOL_PERMISSIONS, name) ? TOOL_PERMISSIONS[name] : null;
}

const OP_LABEL: Record<PermissionOp, string> = { read: "读取", write: "写入" };

// 高级域的面板名字，拒绝文案与面板矩阵保持一致。
const ADVANCED_LABEL: Record<AdvancedPermission, string> = {
  agents_other: "操作其他 Agent",
  soul_other: "操作其他 Soul",
  totp: "操作2FA",
};

// tools/list 的可见性：域权限与高级域要求都要过。Soul 归属门与 agents
// 的自我门依赖参数/身份，不影响可见性（持权就出现，调用时再按目标判断）。
export function toolVisibleToAgent(name: string, perms: AgentPermissions): boolean {
  const permission = toolPermissionOf(name);
  if (!permission) return false;
  if (permission.domain && !hasGrant(perms, permission.domain, permission.op ?? "read")) return false;
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
  agentId = "",
): string | null {
  const permission = toolPermissionOf(name);
  if (!permission) return null;
  if (permission.domain && !hasGrant(perms, permission.domain, permission.op ?? "read")) {
    return "该 Agent 没有 " + permission.domain + " 的" + OP_LABEL[permission.op ?? "read"] + "权限，无法调用这个工具";
  }
  if (permission.advanced && !hasAdvanced(perms, permission.advanced.key, permission.advanced.op)) {
    return (
      "该 Agent 没有「" +
      ADVANCED_LABEL[permission.advanced.key] +
      "」的" +
      OP_LABEL[permission.advanced.op] +
      "权限，无法调用这个工具"
    );
  }
  // agents_* 的「只能操作其他 Agent」门（读侧）：agents_get 按名字定位到
  // 调用者自己时直接按权限拒（形态与 Soul 归属门一致）。写侧（轮换/启停）
  // 也在这里预判 id 定位的自我目标；name 定位的自我目标在 handler 里按
  // 同一文案拒（工具错误形态）——解析名字需要查库，纯函数做不了。
  if (name === "agents_get") {
    const targetId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
    const targetName = typeof args.name === "string" ? args.name.trim() : "";
    if ((targetId && targetId === agentId) || (targetName && targetName === agentName)) {
      return "只能操作其他 Agent，不能用这个工具操作自己";
    }
  }
  if (name === "agents_rotate_token" || name === "agents_set_enabled") {
    const targetId = typeof args.agent_id === "string" ? args.agent_id.trim() : "";
    if (targetId && targetId === agentId) {
      return "只能操作其他 Agent，不能用这个工具操作自己";
    }
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
