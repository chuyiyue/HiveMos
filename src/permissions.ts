// Agent 权限模型的单一事实来源：域 × (read | write) 加一组 advanced 开关。
//
// 存储格式（agents.permissions）是一个 JSON 对象：
//
//   {"mcp":{"read":true,"write":false}, …, "advanced":{"machines_secret":false,…}}
//
// 旧格式是一个 JSON 数组（["mcp","memory",…]），只表达「这个域开着」。
// 解析旧数组时从严、只读：每个列出的域映射为 {read:true, write:false}，
// 旧 registry 按现行展开规则拆成 mcp/skills/api，旧 soul_write_any 落到
// advanced.soul_write_any。未知域忽略；解析失败 / 缺失 / 类型不对一律全关
// （默认拒绝）。新格式里 soul_write_any 不再是独立「域」。
//
// PATCH 输入的过渡兼容见 permissionsFromInput：对象按布尔严格收，旧数组
// 按「列出的域 = read+write 全开」映射，保证新旧面板同批部署不互相打死。

export const PERMISSION_DOMAINS = [
  "mcp",
  "skills",
  "api",
  "memory",
  "soul",
  "tasks",
  "calendar",
  "vault",
  "machines",
] as const;

export type PermissionDomain = (typeof PERMISSION_DOMAINS)[number];
export type PermissionOp = "read" | "write";

// vault_totp_code 是保险库取码工具（vault_2fa_list / vault_2fa_get_code）的高级开关。
export const ADVANCED_PERMISSIONS = ["machines_secret", "soul_write_any", "vault_totp_code"] as const;

export type AdvancedPermission = (typeof ADVANCED_PERMISSIONS)[number];

export interface DomainGrant {
  read: boolean;
  write: boolean;
}

export type PermissionGrants = { [D in PermissionDomain]: DomainGrant };
export type AdvancedGrants = { [K in AdvancedPermission]: boolean };
export type AgentPermissions = PermissionGrants & { advanced: AdvancedGrants };

// 旧单域 registry 覆盖整个「MCP 与 Skills」板块，现在按页签拆开。
const LEGACY_REGISTRY_EXPANSION: PermissionDomain[] = ["mcp", "skills", "api"];

function emptyAdvanced(): AdvancedGrants {
  return { machines_secret: false, soul_write_any: false, vault_totp_code: false };
}

// 全部关闭：新建 Agent 的默认，也是任何无法识别输入的唯一出口。
export function denyAllPermissions(): AgentPermissions {
  const grants = {} as PermissionGrants;
  for (const domain of PERMISSION_DOMAINS) grants[domain] = { read: false, write: false };
  return { ...grants, advanced: emptyAdvanced() } as AgentPermissions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function applyLegacyArray(items: unknown[], grants: AgentPermissions): void {
  for (const item of items) {
    if (typeof item !== "string") continue;
    if (item === "registry") {
      for (const domain of LEGACY_REGISTRY_EXPANSION) grants[domain] = { read: true, write: false };
      continue;
    }
    if (item === "soul_write_any") {
      grants.advanced.soul_write_any = true;
      continue;
    }
    if ((PERMISSION_DOMAINS as readonly string[]).includes(item)) {
      grants[item as PermissionDomain] = { read: true, write: false };
    }
  }
}

function applyObject(value: Record<string, unknown>, grants: AgentPermissions): void {
  for (const domain of PERMISSION_DOMAINS) {
    const entry = value[domain];
    if (!isRecord(entry)) continue;
    grants[domain] = { read: entry.read === true, write: entry.write === true };
  }
  const advanced = value.advanced;
  if (isRecord(advanced)) {
    for (const key of ADVANCED_PERMISSIONS) grants.advanced[key] = advanced[key] === true;
  }
}

// 接受库里的原始字符串、已经解析过的对象或任何垃圾输入；永远返回规范对象。
export function parsePermissions(raw: unknown): AgentPermissions {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return denyAllPermissions();
    try {
      value = JSON.parse(raw);
    } catch {
      return denyAllPermissions();
    }
  }
  const grants = denyAllPermissions();
  if (Array.isArray(value)) {
    applyLegacyArray(value, grants);
    return grants;
  }
  if (isRecord(value)) {
    applyObject(value, grants);
    return grants;
  }
  return grants;
}

// 固定顺序的规范序列化，方便面板与快照逐字节比较。
export function serializePermissions(value: unknown): string {
  const perms = parsePermissions(value);
  const out: Record<string, unknown> = {};
  for (const domain of PERMISSION_DOMAINS) {
    out[domain] = { read: perms[domain].read, write: perms[domain].write };
  }
  const advanced: Record<string, boolean> = {};
  for (const key of ADVANCED_PERMISSIONS) advanced[key] = perms.advanced[key];
  out.advanced = advanced;
  return JSON.stringify(out);
}

export function hasGrant(perms: AgentPermissions | null | undefined, domain: PermissionDomain, op: PermissionOp): boolean {
  const grant = perms?.[domain];
  return !!grant && grant[op] === true;
}

export function hasAdvanced(perms: AgentPermissions | null | undefined, key: AdvancedPermission): boolean {
  return perms?.advanced?.[key] === true;
}

// 旧面板仍会把旧数组发回来（列出的域原本就是「这个域全开」的意思）。
// 过渡期沿用这个原意：列出的域 read+write 全开，registry 按三域展开，
// soul_write_any 落到 advanced。未知项忽略。
// 新对象则严格按布尔收、未知键忽略。
// transitional: 面板权限矩阵上线后，数组分支可以删除。
function legacyArrayToFullGrants(items: unknown[]): AgentPermissions {
  const grants = denyAllPermissions();
  for (const item of items) {
    if (typeof item !== "string") continue;
    if (item === "registry") {
      for (const domain of LEGACY_REGISTRY_EXPANSION) grants[domain] = { read: true, write: true };
      continue;
    }
    if (item === "soul_write_any") {
      grants.advanced.soul_write_any = true;
      continue;
    }
    if ((PERMISSION_DOMAINS as readonly string[]).includes(item)) {
      grants[item as PermissionDomain] = { read: true, write: true };
    }
  }
  return grants;
}

export type PermissionsInputResult =
  | { ok: true; permissions: AgentPermissions }
  | { ok: false; status: 400; error: string };

// PATCH 的 permissions 字段：整体替换，不接受 null / 标量 / 垃圾类型。
export function permissionsFromInput(value: unknown): PermissionsInputResult {
  if (Array.isArray(value)) return { ok: true, permissions: legacyArrayToFullGrants(value) };
  if (isRecord(value)) return { ok: true, permissions: parsePermissions(value) };
  return { ok: false, status: 400, error: "权限格式不正确" };
}
