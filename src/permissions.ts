// Agent 权限模型的单一事实来源：普通域 × (read | write) 加高级域 × (read | write)。
//
// 存储格式（agents.permissions）是一个 JSON 对象：
//
//   {"mcp":{"read":true,"write":false}, …,
//    "advanced":{"agents_other":{"read":false,"write":false},
//                "soul_other":{…}, "totp":{…}}}
//
// 高级域与普通域彼此独立、互不附带：agents_other = 操作其他 Agent，
// soul_other = 操作其他 Soul（自己名下的 Soul 归 soul 域），totp = 保险库
// 验证码（与 vault 域分开）。机器明文凭据（machines_get_access）不再有高级
// 门，只归 machines 域读 + 审计。
//
// 旧格式是一个 JSON 数组（["mcp","memory",…]），只表达「这个域开着」。
// 解析旧数组时从严、只读：每个列出的域映射为 {read:true, write:false}，
// 旧 registry 按现行展开规则拆成 mcp/skills/api。旧布尔高级开关在解析时
// 迁移：soul_write_any → advanced.soul_other.write，vault_totp_code →
// advanced.totp.read，machines_secret 直接丢弃（不授予任何新权限）。
// 未知域忽略；解析失败 / 缺失 / 类型不对一律全关（默认拒绝）。序列化只写
// 新形状。
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

// 高级域：与普通域同构的 (read | write) 对，语义是「操作其他 Agent 的资源」。
// agents_other 目前没有对应 MCP 工具，只建权限位；soul_other 管他人 Soul 的
// 读/写（写仍走待审草稿）；totp.read 是保险库取码工具的高级门，totp.write 预留。
export const ADVANCED_PERMISSIONS = ["agents_other", "soul_other", "totp"] as const;

export type AdvancedPermission = (typeof ADVANCED_PERMISSIONS)[number];

export interface DomainGrant {
  read: boolean;
  write: boolean;
}

export type PermissionGrants = { [D in PermissionDomain]: DomainGrant };
export type AdvancedGrants = { [K in AdvancedPermission]: DomainGrant };
export type AgentPermissions = PermissionGrants & { advanced: AdvancedGrants };

// 旧单域 registry 覆盖整个「MCP 与 Skills」板块，现在按页签拆开。
const LEGACY_REGISTRY_EXPANSION: PermissionDomain[] = ["mcp", "skills", "api"];

function emptyAdvanced(): AdvancedGrants {
  return {
    agents_other: { read: false, write: false },
    soul_other: { read: false, write: false },
    totp: { read: false, write: false },
  };
}

function grantFrom(value: unknown): DomainGrant {
  if (!isRecord(value)) return { read: false, write: false };
  return { read: value.read === true, write: value.write === true };
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
      grants.advanced.soul_other.write = true;
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
    for (const key of ADVANCED_PERMISSIONS) grants.advanced[key] = grantFrom(advanced[key]);
    // 旧布尔高级开关的迁移（见文件头）：machines_secret 不迁移、直接丢弃。
    if (advanced.soul_write_any === true) grants.advanced.soul_other.write = true;
    if (advanced.vault_totp_code === true) grants.advanced.totp.read = true;
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
  const advanced: Record<string, DomainGrant> = {};
  for (const key of ADVANCED_PERMISSIONS) {
    advanced[key] = { read: perms.advanced[key].read, write: perms.advanced[key].write };
  }
  out.advanced = advanced;
  return JSON.stringify(out);
}

export function hasGrant(perms: AgentPermissions | null | undefined, domain: PermissionDomain, op: PermissionOp): boolean {
  const grant = perms?.[domain];
  return !!grant && grant[op] === true;
}

export function hasAdvanced(
  perms: AgentPermissions | null | undefined,
  key: AdvancedPermission,
  op: PermissionOp,
): boolean {
  const grant = perms?.advanced?.[key];
  return !!grant && grant[op] === true;
}


// 旧面板仍会把旧数组发回来（列出的域原本就是「这个域全开」的意思）。
// 过渡期沿用这个原意：列出的域 read+write 全开，registry 按三域展开，
// soul_write_any 按迁移口径落到 advanced.soul_other.write。未知项忽略。
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
      grants.advanced.soul_other.write = true;
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
