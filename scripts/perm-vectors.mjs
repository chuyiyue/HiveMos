#!/usr/bin/env node
// 权限模型的测试向量：跑 src/permissions.ts 与 src/tool-permissions.ts。
//
//   /data/workspace/node24/bin/node scripts/perm-vectors.mjs
//   （普通 node ≥ 23 也行：类型剥离默认开启，这两个模块不依赖 Worker 全局）
//
// 覆盖：旧数组映射（registry 展开 / soul_write_any / 未知域 / 垃圾输入全关）、
// 旧布尔高级开关迁移（soul_write_any → soul_other.write、vault_totp_code →
// totp.read、machines_secret 丢弃）、新高级形状（agents_other / soul_other /
// totp 各 read/write）直通与严格布尔、parse/serialize 往返、
// hasGrant/hasAdvanced，以及工具校验矩阵的关键格
// （machines_get_access 无高级门、2FA 工具只认 totp.read 的纯高级域分类、
// agents_* 工具只认 agents_other 的纯高级域分类（含自我门）、Soul 归属门：
// soul 域只覆盖自己名下那一份、读/写他人分别要 soul_other 读/写、
// proxy 第 10 域的读写格与存量 JSON 缺 proxy 键默认双关）。
//
// 盒子上的源码用无扩展名的相对 import（`./permissions`），这是 Worker 打包器
// 的习惯，直接 import 到 Node 会 ERR_MODULE_NOT_FOUND。这里和 totp-vectors
// 一样注册一个解析钩子，只给解析失败的相对说明符补 `.ts` / `/index.ts`。
//
// 全过时以 0 退出并打印计数；任一条不符以 1 退出。

import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      for (const suffix of [".ts", "/index.ts"]) {
        try { return await next(specifier + suffix, context); } catch {}
      }
    }
    throw error;
  }
}
`),
);

const {
  ADVANCED_PERMISSIONS,
  PERMISSION_DOMAINS,
  denyAllPermissions,
  hasAdvanced,
  hasGrant,
  parsePermissions,
  permissionsFromInput,
  serializePermissions,
} = await import("../src/permissions.ts");

const {
  TOOL_PERMISSIONS,
  toolAccessError,
  toolPermissionOf,
  toolVisibleToAgent,
} = await import("../src/tool-permissions.ts");

let checks = 0;
let failures = 0;

function expect(label, actual, expected) {
  checks += 1;
  const shown = JSON.stringify(actual);
  if (shown === JSON.stringify(expected)) {
    console.log(`ok   ${label} = ${shown}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}: got ${shown}, want ${JSON.stringify(expected)}`);
  }
}

// 把规范对象压成 [域:r/w ...] 的紧凑字符串，断言更可读。
function compact(perms) {
  return PERMISSION_DOMAINS.filter((domain) => perms[domain].read || perms[domain].write).map(
    (domain) => `${domain}:${perms[domain].read ? "r" : ""}${perms[domain].write ? "w" : ""}`,
  );
}

function advancedOn(perms) {
  return ADVANCED_PERMISSIONS.filter((key) => perms.advanced[key].read || perms.advanced[key].write).map(
    (key) => `${key}:${perms.advanced[key].read ? "r" : ""}${perms.advanced[key].write ? "w" : ""}`,
  );
}

// ---- 旧数组：从严、只读 ------------------------------------------------------

expect("旧数组 [mcp] 只读", compact(parsePermissions('["mcp"]')), ["mcp:r"]);
expect("旧数组 registry 展开为 mcp/skills/api 且只读", compact(parsePermissions('["registry"]')), ["mcp:r", "skills:r", "api:r"]);
expect("旧数组 registry + memory 合并", compact(parsePermissions('["registry","memory"]')), ["mcp:r", "skills:r", "api:r", "memory:r"]);
expect("旧数组 soul 只读、不自动获得 soul_other", compact(parsePermissions('["soul"]')), ["soul:r"]);
expect("旧数组 soul_write_any 迁移到 soul_other.write", advancedOn(parsePermissions('["soul","soul_write_any"]')), ["soul_other:w"]);
expect("旧数组 soul_write_any 单独出现不动任何域", compact(parsePermissions('["soul_write_any"]')), []);
expect("旧数组未知域忽略", compact(parsePermissions('["vault","bogus_domain"]')), ["vault:r"]);
expect("旧数组非字符串项忽略", compact(parsePermissions('["tasks",1,null,true]')), ["tasks:r"]);
expect("旧数组不会给出任何 write", compact(parsePermissions('["mcp","skills","api","memory","soul","tasks","calendar","vault","machines","registry"]')).every((entry) => !entry.endsWith("w")), true);

// ---- 解析失败 / 缺失 / 类型不对：全部 false ---------------------------------

expect("缺失（null）全关", compact(parsePermissions(null)), []);
expect("缺失（undefined）全关", compact(parsePermissions(undefined)), []);
expect("空字符串全关", compact(parsePermissions("")), []);
expect("解析失败（非 JSON）全关", compact(parsePermissions("not json")), []);
expect("解析失败（半截 JSON）全关", compact(parsePermissions('["mcp"')), []);
expect("空对象全关", compact(parsePermissions("{}")), []);
expect("标量（数字 JSON）全关", compact(parsePermissions("123")), []);
expect("标量（字符串 JSON）全关", compact(parsePermissions('"mcp"')), []);
expect("域值类型不对（字符串）全关", compact(parsePermissions('{"mcp":"yes"}')), []);
expect("域值类型不对（数组）全关", compact(parsePermissions('{"mcp":["read"]}')), []);
expect("advanced 类型不对全关", advancedOn(parsePermissions('{"advanced":{"soul_write_any":1}}')), []);
expect("垃圾输入 advanced 也全关", advancedOn(parsePermissions("not json")), []);
expect("denyAllPermissions 全关", compact(denyAllPermissions()), []);
expect("denyAllPermissions advanced 全关", advancedOn(denyAllPermissions()), []);

// ---- 新对象：严格布尔直通 ---------------------------------------------------

const sample = {
  mcp: { read: true, write: false },
  skills: { read: false, write: false },
  api: { read: false, write: false },
  memory: { read: false, write: false },
  soul: { read: false, write: false },
  tasks: { read: false, write: false },
  calendar: { read: false, write: false },
  vault: { read: false, write: false },
  machines: { read: false, write: false },
  advanced: {
    agents_other: { read: false, write: false },
    soul_other: { read: false, write: false },
    totp: { read: false, write: false },
  },
};
expect("管理员定死的示例对象直通", compact(parsePermissions(JSON.stringify(sample))), ["mcp:r"]);
expect("对象：read/write 各自独立（write 不隐含 read）", compact(parsePermissions('{"memory":{"read":false,"write":true}}')), ["memory:w"]);
expect("对象：write 不影响 read", compact(parsePermissions('{"memory":{"read":true,"write":false}}')), ["memory:r"]);
expect("对象：未知键忽略", compact(parsePermissions('{"memory":{"read":true,"write":false},"nope":{"read":true},"registry":true}')), ["memory:r"]);
expect("对象：非 true 的布尔值不算授予", compact(parsePermissions('{"memory":{"read":1,"write":"true"}}')), []);
expect(
  "对象：新高级形状直通（每域 read/write 独立）",
  advancedOn(parsePermissions('{"advanced":{"agents_other":{"read":true,"write":true},"soul_other":{"read":false,"write":true},"totp":{"read":true,"write":false}}}')),
  ["agents_other:rw", "soul_other:w", "totp:r"],
);
expect("迁移：旧 soul_write_any=true → soul_other.write", advancedOn(parsePermissions('{"advanced":{"soul_write_any":true}}')), ["soul_other:w"]);
expect("迁移：旧 vault_totp_code=true → totp.read", advancedOn(parsePermissions('{"advanced":{"vault_totp_code":true}}')), ["totp:r"]);
expect("迁移：旧 machines_secret=true 直接丢弃、不授予任何新权限", advancedOn(parsePermissions('{"advanced":{"machines_secret":true}}')), []);
expect(
  "迁移：旧布尔与新形状并存时合并",
  advancedOn(parsePermissions('{"advanced":{"soul_write_any":true,"totp":{"read":false,"write":true}}}')),
  ["soul_other:w", "totp:w"],
);
expect("对象：新高级形状非 true 不算授予", advancedOn(parsePermissions('{"advanced":{"totp":{"read":1,"write":"true"}}}')), []);
expect("对象：新高级键给布尔不算授予（只认 {read,write} 形状）", advancedOn(parsePermissions('{"advanced":{"totp":true}}')), []);


// ---- proxy 第 10 域：存量 JSON 缺 proxy 键默认双关（从严，不自动给权） --------

expect("普通域共 10 个", PERMISSION_DOMAINS.length, 10);
expect("proxy 排在 machines 之后（矩阵末尾）", PERMISSION_DOMAINS[PERMISSION_DOMAINS.indexOf("machines") + 1], "proxy");
expect(
  "存量对象无 proxy 键：proxy 默认双关",
  parsePermissions('{"mcp":{"read":true,"write":true},"machines":{"read":true,"write":true}}').proxy,
  { read: false, write: false },
);
expect("存量对象无 proxy 键：hasGrant(proxy, read) 为 false", hasGrant(parsePermissions('{"mcp":{"read":true,"write":true}}'), "proxy", "read"), false);
expect("存量对象无 proxy 键：hasGrant(proxy, write) 为 false", hasGrant(parsePermissions('{"mcp":{"read":true,"write":true}}'), "proxy", "write"), false);
expect(
  "旧数组列满九个旧域也不给 proxy",
  parsePermissions('["mcp","skills","api","memory","soul","tasks","calendar","vault","machines"]').proxy,
  { read: false, write: false },
);
expect("serialize 补齐 proxy 键且默认双关", JSON.parse(serializePermissions("{}")).proxy, { read: false, write: false });
expect("proxy 对象直通（read/write 独立）", parsePermissions('{"proxy":{"read":true,"write":false}}').proxy, { read: true, write: false });
expect("proxy 非 true 不算授予", parsePermissions('{"proxy":{"read":1,"write":"true"}}').proxy, { read: false, write: false });

// ---- serialize / 往返 --------------------------------------------------------

expect("serialize 固定顺序且补齐全部键", JSON.parse(serializePermissions("[]")), {
  ...Object.fromEntries(PERMISSION_DOMAINS.map((domain) => [domain, { read: false, write: false }])),
  advanced: {
    agents_other: { read: false, write: false },
    soul_other: { read: false, write: false },
    totp: { read: false, write: false },
  },
});
expect(
  "serialize 只写新形状：旧布尔迁移后落盘",
  JSON.parse(serializePermissions('{"advanced":{"soul_write_any":true,"vault_totp_code":true,"machines_secret":true}}')).advanced,
  {
    agents_other: { read: false, write: false },
    soul_other: { read: false, write: true },
    totp: { read: true, write: false },
  },
);
expect("serialize(parse(x)) 往返幂等", serializePermissions(serializePermissions(sample)), serializePermissions(sample));
expect("旧数组保存为新格式（只读）", JSON.parse(serializePermissions('["registry"]')).memory, { read: false, write: false });
expect("旧数组保存为新格式（registry 三域只读）", JSON.parse(serializePermissions('["registry"]')).mcp, { read: true, write: false });

// ---- hasGrant / hasAdvanced -------------------------------------------------

const mcpReader = parsePermissions('["mcp"]');
const memoryWriter = parsePermissions('{"memory":{"read":false,"write":true}}');
expect("hasGrant(mcpReader, mcp, read)", hasGrant(mcpReader, "mcp", "read"), true);
expect("hasGrant(mcpReader, mcp, write)", hasGrant(mcpReader, "mcp", "write"), false);
expect("hasGrant(memoryWriter, memory, write)", hasGrant(memoryWriter, "memory", "write"), true);
expect("hasGrant(memoryWriter, memory, read)", hasGrant(memoryWriter, "memory", "read"), false);
expect("hasGrant(null) 一律 false", hasGrant(null, "mcp", "read"), false);
expect("hasAdvanced 旧数组迁移 soul_other.write", hasAdvanced(parsePermissions('["soul_write_any"]'), "soul_other", "write"), true);
expect("hasAdvanced 迁移不给 soul_other.read", hasAdvanced(parsePermissions('["soul_write_any"]'), "soul_other", "read"), false);
expect("hasAdvanced 旧 vault_totp_code 迁移 totp.read", hasAdvanced(parsePermissions('{"advanced":{"vault_totp_code":true}}'), "totp", "read"), true);
expect("hasAdvanced 未授予", hasAdvanced(mcpReader, "soul_other", "write"), false);
expect("hasAdvanced(totp, read) 默认 false", hasAdvanced(denyAllPermissions(), "totp", "read"), false);
expect("hasAdvanced(null) 一律 false", hasAdvanced(null, "totp", "read"), false);

// ---- PATCH 输入：对象严格布尔 / 旧数组过渡全开 ------------------------------

expect("PATCH 旧数组 = 列出的域 read+write 全开", compact(permissionsFromInput(["memory"]).permissions), ["memory:rw"]);
expect("PATCH 旧数组 registry 三域全开", compact(permissionsFromInput(["registry"]).permissions), ["mcp:rw", "skills:rw", "api:rw"]);
expect("PATCH 旧数组 soul_write_any 迁移到 soul_other.write", advancedOn(permissionsFromInput(["soul", "soul_write_any"]).permissions), ["soul_other:w"]);
expect("PATCH 旧数组未知项忽略", compact(permissionsFromInput(["mcp", "bogus"]).permissions), ["mcp:rw"]);
expect("PATCH 对象严格按布尔收", compact(permissionsFromInput({ mcp: { read: true, write: false } }).permissions), ["mcp:r"]);
expect("PATCH 对象未知键忽略", compact(permissionsFromInput({ mcp: { read: true, write: false, owner: true } }).permissions), ["mcp:r"]);
expect("PATCH 非对象非数组拒绝", permissionsFromInput("mcp"), { ok: false, status: 400, error: "权限格式不正确" });
expect("PATCH null 拒绝", permissionsFromInput(null), { ok: false, status: 400, error: "权限格式不正确" });

// ---- 权限交集已删除（2026-11-10 OAuth 改应用模型） ---------------------------
// intersectPermissions 随连接模型一并删除：OAuth 应用的权限就是授权页
// 勾选的完整矩阵，不再与任何基础权限取交集。旧布尔快照的迁移行为由
// 上面的 parsePermissions / permissionsFromInput 用例继续覆盖。

// ---- 工具分类表自检 ---------------------------------------------------------

const TOOL_NAMES = Object.keys(TOOL_PERMISSIONS);
expect("工具分类共 76 个", TOOL_NAMES.length, 76);
expect(
  "所有带普通域的工具，其域都在 PERMISSION_DOMAINS 内",
  TOOL_NAMES.filter((name) => TOOL_PERMISSIONS[name].domain !== undefined && !PERMISSION_DOMAINS.includes(TOOL_PERMISSIONS[name].domain)),
  [],
);
expect(
  "纯高级域工具恰好是 agents_* 与 vault_2fa_* 六个",
  TOOL_NAMES.filter((name) => TOOL_PERMISSIONS[name].domain === undefined).sort(),
  ["agents_get", "agents_list", "agents_rotate_token", "agents_set_enabled", "vault_2fa_get_code", "vault_2fa_list"].sort(),
);
expect(
  "op 只出现在带普通域的工具上（纯高级域工具的操作在 advanced 里）",
  TOOL_NAMES.filter((name) => (TOOL_PERMISSIONS[name].domain === undefined) !== (TOOL_PERMISSIONS[name].op === undefined)),
  [],
);
expect(
  "带普通域的工具操作只有 read/write",
  TOOL_NAMES.filter((name) => TOOL_PERMISSIONS[name].op !== undefined && TOOL_PERMISSIONS[name].op !== "read" && TOOL_PERMISSIONS[name].op !== "write"),
  [],
);
expect(
  "advanced 只引用 ADVANCED_PERMISSIONS 且操作合法",
  TOOL_NAMES.filter(
    (name) =>
      TOOL_PERMISSIONS[name].advanced &&
      (!ADVANCED_PERMISSIONS.includes(TOOL_PERMISSIONS[name].advanced.key) ||
        (TOOL_PERMISSIONS[name].advanced.op !== "read" && TOOL_PERMISSIONS[name].advanced.op !== "write")),
  ),
  [],
);
expect(
  "带 advanced 的工具清单（四个 agents 工具 + 两个取码工具，全是纯高级域）",
  TOOL_NAMES.filter((name) => TOOL_PERMISSIONS[name].advanced).sort(),
  ["agents_get", "agents_list", "agents_rotate_token", "agents_set_enabled", "vault_2fa_get_code", "vault_2fa_list"].sort(),
);
expect("machines_get_access 无 advanced（凭据并入 machines 域）", TOOL_PERMISSIONS.machines_get_access.advanced, undefined);
expect(
  "totp.read 挂两个验证码工具",
  TOOL_NAMES.filter((name) => TOOL_PERMISSIONS[name].advanced && TOOL_PERMISSIONS[name].advanced.key === "totp" && TOOL_PERMISSIONS[name].advanced.op === "read").sort(),
  ["vault_2fa_get_code", "vault_2fa_list"],
);
expect(
  "agents_other 读挂 agents_list / agents_get",
  TOOL_NAMES.filter((name) => TOOL_PERMISSIONS[name].advanced && TOOL_PERMISSIONS[name].advanced.key === "agents_other" && TOOL_PERMISSIONS[name].advanced.op === "read").sort(),
  ["agents_get", "agents_list"],
);
expect(
  "agents_other 写挂 agents_rotate_token / agents_set_enabled",
  TOOL_NAMES.filter((name) => TOOL_PERMISSIONS[name].advanced && TOOL_PERMISSIONS[name].advanced.key === "agents_other" && TOOL_PERMISSIONS[name].advanced.op === "write").sort(),
  ["agents_rotate_token", "agents_set_enabled"],
);
expect(
  "写工具清单与管理员裁定一致（op=write 的普通域写工具；纯高级域写工具 op 缺席、看 advanced）",
  TOOL_NAMES.filter((name) => TOOL_PERMISSIONS[name].op === "write").sort(),
  ["apis_create", "apis_delete", "apis_update", "calendar_create_event", "calendar_delete_event", "calendar_update_event", "machines_create", "machines_delete", "machines_report", "machines_update", "mcp_create", "mcp_delete", "mcp_update", "memory_delete", "memory_remember", "memory_upsert", "skills_create", "skills_delete", "skills_update", "soul_patch", "soul_update", "tasks_complete", "tasks_create", "tasks_update", "vault_create_email", "vault_create_entry", "vault_create_gateway", "vault_delete_email", "vault_delete_entry", "vault_delete_gateway", "vault_update_email", "vault_update_entry", "vault_update_gateway", "proxy_create_subscription", "proxy_delete_node", "proxy_delete_subscription", "proxy_import_nodes", "proxy_update_node_note", "proxy_update_subscription"].sort(),
);
expect(
  "纯高级域写工具清单（agents_other.write）",
  TOOL_NAMES.filter((name) => TOOL_PERMISSIONS[name].advanced && TOOL_PERMISSIONS[name].advanced.op === "write").sort(),
  ["agents_rotate_token", "agents_set_enabled"].sort(),
);
expect("未知工具没有分类", toolPermissionOf("no_such_tool"), null);

// ---- 工具校验矩阵的关键格 ----------------------------------------------------

const denied = parsePermissions(null);
expect("全关：mcp_search 被拒", toolAccessError("mcp_search", denied, "agent-a", {}), "该 Agent 没有 mcp 的读取权限，无法调用这个工具");
expect("全关：memory_upsert 被拒", toolAccessError("memory_upsert", denied, "agent-a", {}), "该 Agent 没有 memory 的写入权限，无法调用这个工具");
expect("全关：tools/list 里一个工具都不出现", TOOL_NAMES.filter((name) => toolVisibleToAgent(name, denied)), []);

const readOnly = parsePermissions('["mcp","memory"]');
expect("只读 Agent：memory_list 放行", toolAccessError("memory_list", readOnly, "agent-a", {}), null);
expect("只读 Agent：memory_upsert 被拒", toolAccessError("memory_upsert", readOnly, "agent-a", {}), "该 Agent 没有 memory 的写入权限，无法调用这个工具");
expect("只读 Agent：tools/list 无 memory_upsert", toolVisibleToAgent("memory_upsert", readOnly), false);
expect("只读 Agent：memory_remember 被拒", toolAccessError("memory_remember", readOnly, "agent-a", {}), "该 Agent 没有 memory 的写入权限，无法调用这个工具");
expect("只读 Agent：tools/list 有 memory_list", toolVisibleToAgent("memory_list", readOnly), true);

const readWrite = parsePermissions('{"memory":{"read":true,"write":true}}');
expect("读写俱全：memory_upsert 放行", toolAccessError("memory_upsert", readWrite, "agent-a", {}), null);
expect("读写俱全：memory_delete 放行", toolAccessError("memory_delete", readWrite, "agent-a", {}), null);
expect("读写俱全：memory_get 放行", toolAccessError("memory_get", readWrite, "agent-a", {}), null);

const writeOnly = parsePermissions('{"memory":{"read":false,"write":true}}');
expect("只给 write：memory_upsert 放行", toolAccessError("memory_upsert", writeOnly, "agent-a", {}), null);
expect("只给 write：memory_list 仍需 read", toolAccessError("memory_list", writeOnly, "agent-a", {}), "该 Agent 没有 memory 的读取权限，无法调用这个工具");

// mcp / skills 写工具：与读工具同域，写要本域 write（2026-11-10 新增六个写工具）
const mcpReadOnly = parsePermissions('{"mcp":{"read":true,"write":false}}');
expect("mcp 只读：mcp_get 放行", toolAccessError("mcp_get", mcpReadOnly, "agent-a", {}), null);
expect("mcp 只读：mcp_create 被拒", toolAccessError("mcp_create", mcpReadOnly, "agent-a", {}), "该 Agent 没有 mcp 的写入权限，无法调用这个工具");
expect("mcp 只读：mcp_update 被拒", toolAccessError("mcp_update", mcpReadOnly, "agent-a", {}), "该 Agent 没有 mcp 的写入权限，无法调用这个工具");
expect("mcp 只读：mcp_delete 被拒", toolAccessError("mcp_delete", mcpReadOnly, "agent-a", {}), "该 Agent 没有 mcp 的写入权限，无法调用这个工具");
expect("mcp 只读：tools/list 无 mcp_create", toolVisibleToAgent("mcp_create", mcpReadOnly), false);
const mcpWriteOnly = parsePermissions('{"mcp":{"read":false,"write":true}}');
expect("mcp 只写：mcp_create 放行", toolAccessError("mcp_create", mcpWriteOnly, "agent-a", {}), null);
expect("mcp 只写：mcp_list 仍需 read", toolAccessError("mcp_list", mcpWriteOnly, "agent-a", {}), "该 Agent 没有 mcp 的读取权限，无法调用这个工具");
const skillsWriteOnly = parsePermissions('{"skills":{"read":false,"write":true}}');
expect("skills 只写：skills_create 放行", toolAccessError("skills_create", skillsWriteOnly, "agent-a", {}), null);
expect("skills 只写：skills_update 放行", toolAccessError("skills_update", skillsWriteOnly, "agent-a", {}), null);
expect("skills 只写：skills_delete 放行", toolAccessError("skills_delete", skillsWriteOnly, "agent-a", {}), null);
expect("skills 只写：skills_get 仍需 read", toolAccessError("skills_get", skillsWriteOnly, "agent-a", {}), "该 Agent 没有 skills 的读取权限，无法调用这个工具");
expect("全关：skills_delete 被拒", toolAccessError("skills_delete", denied, "agent-a", {}), "该 Agent 没有 skills 的写入权限，无法调用这个工具");
expect("mcp_create 无 advanced", TOOL_PERMISSIONS.mcp_create.advanced, undefined);
expect("skills_create 无 advanced", TOOL_PERMISSIONS.skills_create.advanced, undefined);

// machines_get_access：凭据并入 machines 域，只需 machines read（审计在 handler 内）
const machinesRead = parsePermissions('{"machines":{"read":true,"write":false}}');
expect("machines read：machines_get 放行", toolAccessError("machines_get", machinesRead, "agent-a", {}), null);
expect("machines read 无任何高级：machines_get_access 放行", toolAccessError("machines_get_access", machinesRead, "agent-a", {}), null);
expect("machines read：tools/list 有 machines_get_access", toolVisibleToAgent("machines_get_access", machinesRead), true);
expect("无 machines read：machines_get_access 被拒", toolAccessError("machines_get_access", denied, "agent-a", {}), "该 Agent 没有 machines 的读取权限，无法调用这个工具");
expect("全关时 machines_get_access 也不出现", toolVisibleToAgent("machines_get_access", denied), false);
expect("旧 machines_secret 迁移后不给 machines 域（丢弃）", toolAccessError("machines_get_access", parsePermissions('{"advanced":{"machines_secret":true}}'), "agent-a", {}), "该 Agent 没有 machines 的读取权限，无法调用这个工具");

// vault_2fa_*：纯高级域工具，只认 totp.read，不再叠 vault 域（2026-11-10
// Roye 定：2FA 与保险库其余功能彻底分开、互不附带）。只有 vault 权限取
// 不了码，只有 totp 也碰不了 vault 域的条目/邮箱/网关工具。
const vaultRead = parsePermissions('{"vault":{"read":true,"write":false}}');
expect("vault read 无 totp：vault_2fa_list 被拒", toolAccessError("vault_2fa_list", vaultRead, "agent-a", {}), "该 Agent 没有「操作2FA」的读取权限，无法调用这个工具");
expect("vault read 无 totp：vault_2fa_get_code 被拒", toolAccessError("vault_2fa_get_code", vaultRead, "agent-a", {}), "该 Agent 没有「操作2FA」的读取权限，无法调用这个工具");
expect("vault read 无 totp：tools/list 无两个验证码工具", ["vault_2fa_list", "vault_2fa_get_code"].filter((name) => toolVisibleToAgent(name, vaultRead)), []);
expect("vault 读写俱全无 totp：vault_2fa_list 仍被拒", toolAccessError("vault_2fa_list", parsePermissions('{"vault":{"read":true,"write":true}}'), "agent-a", {}), "该 Agent 没有「操作2FA」的读取权限，无法调用这个工具");
const vaultCode = parsePermissions('{"vault":{"read":true,"write":false},"advanced":{"totp":{"read":true,"write":false}}}');
expect("vault read + totp.read：vault_2fa_list 放行", toolAccessError("vault_2fa_list", vaultCode, "agent-a", {}), null);
expect("vault read + totp.read：vault_2fa_get_code 放行", toolAccessError("vault_2fa_get_code", vaultCode, "agent-a", { id: "totp_x" }), null);
expect("vault read + totp.read：tools/list 有两个验证码工具", ["vault_2fa_list", "vault_2fa_get_code"].filter((name) => toolVisibleToAgent(name, vaultCode)), ["vault_2fa_list", "vault_2fa_get_code"]);
expect("旧 vault_totp_code 迁移后：vault_2fa_get_code 放行", toolAccessError("vault_2fa_get_code", parsePermissions('{"advanced":{"vault_totp_code":true}}'), "agent-a", { id: "totp_x" }), null);
const totpOnly = parsePermissions('{"advanced":{"totp":{"read":true,"write":false}}}');
expect("只有 totp.read（无 vault 域）：vault_2fa_list 放行", toolAccessError("vault_2fa_list", totpOnly, "agent-a", {}), null);
expect("只有 totp.read（无 vault 域）：vault_2fa_get_code 放行", toolAccessError("vault_2fa_get_code", totpOnly, "agent-a", { id: "totp_x" }), null);
expect("只有 totp.read：tools/list 有两个验证码工具", ["vault_2fa_list", "vault_2fa_get_code"].filter((name) => toolVisibleToAgent(name, totpOnly)), ["vault_2fa_list", "vault_2fa_get_code"]);
expect("只有 totp.read：条目工具仍按 vault 域拒", toolAccessError("vault_get_entry", totpOnly, "agent-a", {}), "该 Agent 没有 vault 的读取权限，无法调用这个工具");
expect("只有 totp.read：tools/list 无 vault 条目工具", toolVisibleToAgent("vault_list_entries", totpOnly), false);
expect("只有 totp.write：取码仍被拒（要 read）", toolAccessError("vault_2fa_get_code", parsePermissions('{"advanced":{"totp":{"read":false,"write":true}}}'), "agent-a", {}), "该 Agent 没有「操作2FA」的读取权限，无法调用这个工具");

// vault 域工具（条目 / 邮箱 / 网关）：list/get 要 vault read，
// create/update/delete 要 vault write；与 totp 互不附带（见上）。
expect("vault read：vault_list_entries 放行", toolAccessError("vault_list_entries", vaultRead, "agent-a", {}), null);
expect("vault read：vault_get_gateway 放行", toolAccessError("vault_get_gateway", vaultRead, "agent-a", {}), null);
expect("vault read：vault_create_entry 被拒", toolAccessError("vault_create_entry", vaultRead, "agent-a", {}), "该 Agent 没有 vault 的写入权限，无法调用这个工具");
expect("vault read：tools/list 无 vault_create_email", toolVisibleToAgent("vault_create_email", vaultRead), false);
const vaultWrite = parsePermissions('{"vault":{"read":false,"write":true}}');
expect("vault 只写：vault_create_gateway 放行", toolAccessError("vault_create_gateway", vaultWrite, "agent-a", {}), null);
expect("vault 只写：vault_update_email 放行", toolAccessError("vault_update_email", vaultWrite, "agent-a", {}), null);
expect("vault 只写：vault_delete_entry 放行", toolAccessError("vault_delete_entry", vaultWrite, "agent-a", {}), null);
expect("vault 只写：vault_list_gateways 仍需 read", toolAccessError("vault_list_gateways", vaultWrite, "agent-a", {}), "该 Agent 没有 vault 的读取权限，无法调用这个工具");
expect("全关：vault_get_email 被拒", toolAccessError("vault_get_email", denied, "agent-a", {}), "该 Agent 没有 vault 的读取权限，无法调用这个工具");

// api 写工具：与读工具同域，写要 api write
const apiReadOnly = parsePermissions('{"api":{"read":true,"write":false}}');
expect("api 只读：apis_get 放行", toolAccessError("apis_get", apiReadOnly, "agent-a", {}), null);
expect("api 只读：apis_create 被拒", toolAccessError("apis_create", apiReadOnly, "agent-a", {}), "该 Agent 没有 api 的写入权限，无法调用这个工具");
expect("api 只读：apis_update 被拒", toolAccessError("apis_update", apiReadOnly, "agent-a", {}), "该 Agent 没有 api 的写入权限，无法调用这个工具");
expect("api 只读：apis_delete 被拒", toolAccessError("apis_delete", apiReadOnly, "agent-a", {}), "该 Agent 没有 api 的写入权限，无法调用这个工具");
expect("api 只读：tools/list 无 apis_create", toolVisibleToAgent("apis_create", apiReadOnly), false);
const apiWriteOnly = parsePermissions('{"api":{"read":false,"write":true}}');
expect("api 只写：apis_create 放行", toolAccessError("apis_create", apiWriteOnly, "agent-a", {}), null);
expect("api 只写：apis_list 仍需 read", toolAccessError("apis_list", apiWriteOnly, "agent-a", {}), "该 Agent 没有 api 的读取权限，无法调用这个工具");

// tasks_get：tasks 域 read
const tasksRead = parsePermissions('{"tasks":{"read":true,"write":false}}');
expect("tasks read：tasks_get 放行", toolAccessError("tasks_get", tasksRead, "agent-a", {}), null);
expect("全关：tasks_get 被拒", toolAccessError("tasks_get", denied, "agent-a", {}), "该 Agent 没有 tasks 的读取权限，无法调用这个工具");

// machines 写工具：条目 CRUD 要 machines write
expect("machines 只读：machines_create 被拒", toolAccessError("machines_create", machinesRead, "agent-a", {}), "该 Agent 没有 machines 的写入权限，无法调用这个工具");
expect("machines 只读：machines_delete 被拒", toolAccessError("machines_delete", machinesRead, "agent-a", {}), "该 Agent 没有 machines 的写入权限，无法调用这个工具");
expect("machines 只读：tools/list 无 machines_update", toolVisibleToAgent("machines_update", machinesRead), false);
const machinesWrite = parsePermissions('{"machines":{"read":false,"write":true}}');
expect("machines 只写：machines_create 放行", toolAccessError("machines_create", machinesWrite, "agent-a", {}), null);
expect("machines 只写：machines_update 放行", toolAccessError("machines_update", machinesWrite, "agent-a", {}), null);
expect("machines 只写：machines_delete 放行", toolAccessError("machines_delete", machinesWrite, "agent-a", {}), null);
expect("machines 只写：machines_list 仍需 read", toolAccessError("machines_list", machinesWrite, "agent-a", {}), "该 Agent 没有 machines 的读取权限，无法调用这个工具");


// proxy 域工具（第 10 个普通域）：list/reveal/copy 要 proxy read，订阅与
// 节点的增删改、导入、改备注要 proxy write；machines 域不替代 proxy，
// proxy 也不带任何 advanced（明文审计在 handler 内）。
const proxyRead = parsePermissions('{"proxy":{"read":true,"write":false}}');
expect("proxy read：proxy_list 放行", toolAccessError("proxy_list", proxyRead, "agent-a", {}), null);
expect("proxy read：proxy_reveal_subscription 放行", toolAccessError("proxy_reveal_subscription", proxyRead, "agent-a", {}), null);
expect("proxy read：proxy_copy_node 放行", toolAccessError("proxy_copy_node", proxyRead, "agent-a", {}), null);
expect("proxy read：proxy_create_subscription 被拒", toolAccessError("proxy_create_subscription", proxyRead, "agent-a", {}), "该 Agent 没有 proxy 的写入权限，无法调用这个工具");
expect("proxy read：proxy_update_subscription 被拒", toolAccessError("proxy_update_subscription", proxyRead, "agent-a", {}), "该 Agent 没有 proxy 的写入权限，无法调用这个工具");
expect("proxy read：proxy_delete_subscription 被拒", toolAccessError("proxy_delete_subscription", proxyRead, "agent-a", {}), "该 Agent 没有 proxy 的写入权限，无法调用这个工具");
expect("proxy read：proxy_import_nodes 被拒", toolAccessError("proxy_import_nodes", proxyRead, "agent-a", {}), "该 Agent 没有 proxy 的写入权限，无法调用这个工具");
expect("proxy read：proxy_update_node_note 被拒", toolAccessError("proxy_update_node_note", proxyRead, "agent-a", {}), "该 Agent 没有 proxy 的写入权限，无法调用这个工具");
expect("proxy read：proxy_delete_node 被拒", toolAccessError("proxy_delete_node", proxyRead, "agent-a", {}), "该 Agent 没有 proxy 的写入权限，无法调用这个工具");
expect("proxy read：tools/list 无 proxy_create_subscription", toolVisibleToAgent("proxy_create_subscription", proxyRead), false);
expect("proxy read：tools/list 有 proxy_list", toolVisibleToAgent("proxy_list", proxyRead), true);
const proxyWrite = parsePermissions('{"proxy":{"read":false,"write":true}}');
expect("proxy 只写：proxy_create_subscription 放行", toolAccessError("proxy_create_subscription", proxyWrite, "agent-a", {}), null);
expect("proxy 只写：proxy_update_subscription 放行", toolAccessError("proxy_update_subscription", proxyWrite, "agent-a", {}), null);
expect("proxy 只写：proxy_delete_subscription 放行", toolAccessError("proxy_delete_subscription", proxyWrite, "agent-a", {}), null);
expect("proxy 只写：proxy_import_nodes 放行", toolAccessError("proxy_import_nodes", proxyWrite, "agent-a", {}), null);
expect("proxy 只写：proxy_update_node_note 放行", toolAccessError("proxy_update_node_note", proxyWrite, "agent-a", {}), null);
expect("proxy 只写：proxy_delete_node 放行", toolAccessError("proxy_delete_node", proxyWrite, "agent-a", {}), null);
expect("proxy 只写：proxy_list 仍需 read", toolAccessError("proxy_list", proxyWrite, "agent-a", {}), "该 Agent 没有 proxy 的读取权限，无法调用这个工具");
expect("proxy 只写：proxy_reveal_subscription 仍需 read", toolAccessError("proxy_reveal_subscription", proxyWrite, "agent-a", {}), "该 Agent 没有 proxy 的读取权限，无法调用这个工具");
expect("proxy 只写：proxy_copy_node 仍需 read", toolAccessError("proxy_copy_node", proxyWrite, "agent-a", {}), "该 Agent 没有 proxy 的读取权限，无法调用这个工具");
expect("全关：proxy_list 被拒", toolAccessError("proxy_list", denied, "agent-a", {}), "该 Agent 没有 proxy 的读取权限，无法调用这个工具");
expect("全关：proxy_create_subscription 被拒", toolAccessError("proxy_create_subscription", denied, "agent-a", {}), "该 Agent 没有 proxy 的写入权限，无法调用这个工具");
expect("machines 读写不替代 proxy：proxy_list 被拒", toolAccessError("proxy_list", parsePermissions('{"machines":{"read":true,"write":true}}'), "agent-a", {}), "该 Agent 没有 proxy 的读取权限，无法调用这个工具");
expect("proxy_list 无 advanced", TOOL_PERMISSIONS.proxy_list.advanced, undefined);
expect("proxy_reveal_subscription 无 advanced（审计在 handler 内）", TOOL_PERMISSIONS.proxy_reveal_subscription.advanced, undefined);
expect("proxy_copy_node 无 advanced（审计在 handler 内）", TOOL_PERMISSIONS.proxy_copy_node.advanced, undefined);

// agents_* 工具：纯高级域 agents_other；读要其 read、写要其 write，普通
// 域全开也替代不了。自我门按 agent_id / name 判（写侧的 name 定位在
// handler 里按同一文案复判，纯函数这里只覆盖 id 预判与 agents_get）。
const agentsOtherRead = parsePermissions('{"advanced":{"agents_other":{"read":true,"write":false}}}');
expect("agents_other 只读：agents_list 放行", toolAccessError("agents_list", agentsOtherRead, "agent-a", {}, "agt_a"), null);
expect("agents_other 只读：agents_get 查别人放行", toolAccessError("agents_get", agentsOtherRead, "agent-a", { agent_id: "agt_b" }, "agt_a"), null);
expect("agents_other 只读：agents_rotate_token 被拒", toolAccessError("agents_rotate_token", agentsOtherRead, "agent-a", { agent_id: "agt_b" }, "agt_a"), "该 Agent 没有「操作其他 Agent」的写入权限，无法调用这个工具");
expect("agents_other 只读：agents_set_enabled 被拒", toolAccessError("agents_set_enabled", agentsOtherRead, "agent-a", { agent_id: "agt_b", enabled: false }, "agt_a"), "该 Agent 没有「操作其他 Agent」的写入权限，无法调用这个工具");
expect("agents_other 只读：tools/list 无 agents_rotate_token", toolVisibleToAgent("agents_rotate_token", agentsOtherRead), false);
const agentsOtherWrite = parsePermissions('{"advanced":{"agents_other":{"read":false,"write":true}}}');
expect("agents_other 只写：agents_rotate_token 放行", toolAccessError("agents_rotate_token", agentsOtherWrite, "agent-a", { agent_id: "agt_b" }, "agt_a"), null);
expect("agents_other 只写：agents_set_enabled 放行", toolAccessError("agents_set_enabled", agentsOtherWrite, "agent-a", { agent_id: "agt_b", enabled: true }, "agt_a"), null);
expect("agents_other 只写：agents_list 仍需 read", toolAccessError("agents_list", agentsOtherWrite, "agent-a", {}, "agt_a"), "该 Agent 没有「操作其他 Agent」的读取权限，无法调用这个工具");
expect("全关：agents_list 被拒", toolAccessError("agents_list", denied, "agent-a", {}, "agt_a"), "该 Agent 没有「操作其他 Agent」的读取权限，无法调用这个工具");
expect("全关：tools/list 无 agents_get", toolVisibleToAgent("agents_get", denied), false);
const allDomainsNoAdvanced = parsePermissions(JSON.stringify(Object.fromEntries(PERMISSION_DOMAINS.map((domain) => [domain, { read: true, write: true }]))));
expect("普通域全开无 agents_other：agents_get 仍被拒", toolAccessError("agents_get", allDomainsNoAdvanced, "agent-a", { agent_id: "agt_b" }, "agt_a"), "该 Agent 没有「操作其他 Agent」的读取权限，无法调用这个工具");
expect("普通域全开无 agents_other：tools/list 无 agents_list", toolVisibleToAgent("agents_list", allDomainsNoAdvanced), false);
const SELF_ERR = "只能操作其他 Agent，不能用这个工具操作自己";
expect("agents_get 按 id 查自己：自我门拒", toolAccessError("agents_get", agentsOtherRead, "agent-a", { agent_id: "agt_a" }, "agt_a"), SELF_ERR);
expect("agents_get 按 name 查自己：自我门拒", toolAccessError("agents_get", agentsOtherRead, "agent-a", { name: "agent-a" }, "agt_a"), SELF_ERR);
expect("agents_get 按 name 查别人：放行", toolAccessError("agents_get", agentsOtherRead, "agent-a", { name: "agent-b" }, "agt_a"), null);
expect("agents_rotate_token 按 id 轮换自己：自我门拒", toolAccessError("agents_rotate_token", agentsOtherWrite, "agent-a", { agent_id: "agt_a" }, "agt_a"), SELF_ERR);
expect("agents_set_enabled 按 id 停用自己：自我门拒", toolAccessError("agents_set_enabled", agentsOtherWrite, "agent-a", { agent_id: "agt_a", enabled: false }, "agt_a"), SELF_ERR);

// Soul 归属门：soul 域严格只覆盖自己名下（agent_name === 调用者名）的那一份。
// 读他人要 soul_other.read，写他人（含以他人名义新建）要 soul_other.write。
const soulReader = parsePermissions('{"soul":{"read":true,"write":false}}');
expect("soul 读自己：放行", toolAccessError("soul_get", soulReader, "agent-a", { agent_name: "agent-a" }), null);
expect(
  "soul 读他人：无 soul_other.read 被拒",
  toolAccessError("soul_get", soulReader, "agent-a", { agent_name: "agent-b" }),
  "只能读自己的 Soul；要读其他 Agent 的 Soul，需要「操作其他 Soul」的读取权限",
);
expect(
  "soul_diff 读他人：无 soul_other.read 被拒",
  toolAccessError("soul_diff", soulReader, "agent-a", { agent_name: "agent-b" }),
  "只能读自己的 Soul；要读其他 Agent 的 Soul，需要「操作其他 Soul」的读取权限",
);
expect("soul_diff 读自己：放行", toolAccessError("soul_diff", soulReader, "agent-a", { agent_name: "agent-a" }), null);
expect("soul_get 对持 soul 读的 Agent 可见（归属门在调用时判）", toolVisibleToAgent("soul_get", soulReader), true);
const soulOtherReader = parsePermissions('{"soul":{"read":true,"write":false},"advanced":{"soul_other":{"read":true,"write":false}}}');
expect("soul 读他人 + soul_other.read：放行", toolAccessError("soul_get", soulOtherReader, "agent-a", { agent_name: "agent-b" }), null);
expect("无 soul.read：读自己也被拒", toolAccessError("soul_get", parsePermissions(null), "agent-a", { agent_name: "agent-a" }), "该 Agent 没有 soul 的读取权限，无法调用这个工具");

const soulWriter = parsePermissions('{"soul":{"read":false,"write":true}}');
expect("soul 写自己：放行", toolAccessError("soul_update", soulWriter, "agent-a", { agent_name: "agent-a" }), null);
expect("soul 写自己：agent_name 首尾空白不影响归属", toolAccessError("soul_update", soulWriter, "agent-a", { agent_name: " agent-a " }), null);
expect(
  "soul 写他人：无 soul_other.write 被拒",
  toolAccessError("soul_update", soulWriter, "agent-a", { agent_name: "agent-b" }),
  "只能写自己的 Soul；要写其他 Agent 的 Soul，需要「操作其他 Soul」的写入权限",
);
expect(
  "soul_patch 写他人：无 soul_other.write 被拒",
  toolAccessError("soul_patch", soulWriter, "agent-a", { agent_name: "agent-b" }),
  "只能写自己的 Soul；要写其他 Agent 的 Soul，需要「操作其他 Soul」的写入权限",
);
expect("soul 写他人：缺 agent_name 交回工具自身参数校验", toolAccessError("soul_update", soulWriter, "agent-a", {}), null);
expect("soul_patch 缺 agent_name 即写自己：放行", toolAccessError("soul_patch", soulWriter, "agent-a", {}), null);
const soulAny = parsePermissions('{"soul":{"read":false,"write":true},"advanced":{"soul_other":{"read":false,"write":true}}}');
expect("soul 写他人 + soul_other.write：放行", toolAccessError("soul_update", soulAny, "agent-a", { agent_name: "agent-b" }), null);
expect("soul_patch 写他人 + soul_other.write：放行", toolAccessError("soul_patch", soulAny, "agent-a", { agent_name: "agent-b" }), null);
expect(
  "旧 soul_write_any 迁移后写他人放行",
  toolAccessError("soul_update", parsePermissions('{"soul":{"read":false,"write":true},"advanced":{"soul_write_any":true}}'), "agent-a", { agent_name: "agent-b" }),
  null,
);
expect(
  "只有 soul_other.read：写他人仍被拒（读写独立）",
  toolAccessError("soul_update", parsePermissions('{"soul":{"read":true,"write":true},"advanced":{"soul_other":{"read":true,"write":false}}}'), "agent-a", { agent_name: "agent-b" }),
  "只能写自己的 Soul；要写其他 Agent 的 Soul，需要「操作其他 Soul」的写入权限",
);
expect("无 soul.write：写自己也被拒", toolAccessError("soul_update", parsePermissions(null), "agent-a", { agent_name: "agent-a" }), "该 Agent 没有 soul 的写入权限，无法调用这个工具");

// 只给 advanced 不给域：仍然被拒（advanced 是加法，不是替代）
expect(
  "只有迁移后的 soul_other.write 没有 soul.write：写他人被拒",
  toolAccessError("soul_update", parsePermissions('["soul_write_any"]'), "agent-a", { agent_name: "agent-b" }),
  "该 Agent 没有 soul 的写入权限，无法调用这个工具",
);

// 全域 read+write + 三个高级域全开：全部放行
const full = parsePermissions(
  JSON.stringify({
    ...Object.fromEntries(PERMISSION_DOMAINS.map((domain) => [domain, { read: true, write: true }])),
    advanced: {
      agents_other: { read: true, write: true },
      soul_other: { read: true, write: true },
      totp: { read: true, write: true },
    },
  }),
);
expect(
  "全域授予：所有工具都放行（soul 系写自己）",
  TOOL_NAMES.filter((name) => toolAccessError(name, full, "agent-a", { agent_name: "agent-a" }) !== null),
  [],
);
expect("全域授予：soul_update 写他人也放行", toolAccessError("soul_update", full, "agent-a", { agent_name: "agent-b" }), null);
expect("全域授予：soul_get 读他人也放行", toolAccessError("soul_get", full, "agent-a", { agent_name: "agent-b" }), null);
expect("全域授予：tools/list 覆盖全部 76 个工具", TOOL_NAMES.filter((name) => toolVisibleToAgent(name, full)).length, 76);

// 分类表与裁定一致：mcp_get 无高级门；soul 归属门不在分类表、在 toolAccessError
expect("mcp_get 无 advanced", TOOL_PERMISSIONS.mcp_get.advanced, undefined);
expect("soul_get 表内无 advanced（归属门按参数判）", TOOL_PERMISSIONS.soul_get.advanced, undefined);

if (failures > 0) {
  console.error(`\n${failures}/${checks} 条不符`);
  process.exit(1);
}
console.log(`\n全部通过：${checks} 条检查（旧数组映射 / 旧布尔高级迁移 / 垃圾输入全关 / 新对象直通 / parse-serialize 往返 / hasGrant-hasAdvanced / PATCH 过渡兼容 / 76 个工具的分类与校验矩阵）`);
