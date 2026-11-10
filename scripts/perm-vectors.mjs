#!/usr/bin/env node
// 权限模型的测试向量：跑 src/permissions.ts 与 src/tool-permissions.ts。
//
//   /data/workspace/node24/bin/node scripts/perm-vectors.mjs
//   （普通 node ≥ 23 也行：类型剥离默认开启，这两个模块不依赖 Worker 全局）
//
// 覆盖：旧数组映射（registry 展开 / soul_write_any / 未知域 / 垃圾输入全关）、
// 新对象直通与严格布尔、parse/serialize 往返、hasGrant/hasAdvanced，以及
// 工具校验矩阵的关键格（machines_get_access 无 secret、soul_update 写他人、
// 只读 Agent 调写工具、读写俱全放行）。
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
  return ADVANCED_PERMISSIONS.filter((key) => perms.advanced[key]);
}

// ---- 旧数组：从严、只读 ------------------------------------------------------

expect("旧数组 [mcp] 只读", compact(parsePermissions('["mcp"]')), ["mcp:r"]);
expect("旧数组 registry 展开为 mcp/skills/api 且只读", compact(parsePermissions('["registry"]')), ["mcp:r", "skills:r", "api:r"]);
expect("旧数组 registry + memory 合并", compact(parsePermissions('["registry","memory"]')), ["mcp:r", "skills:r", "api:r", "memory:r"]);
expect("旧数组 soul 只读、不自动获得 soul_write_any", compact(parsePermissions('["soul"]')), ["soul:r"]);
expect("旧数组 soul_write_any 落到 advanced", advancedOn(parsePermissions('["soul","soul_write_any"]')), ["soul_write_any"]);
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
  advanced: { machines_secret: false, soul_write_any: false, vault_totp_code: false },
};
expect("管理员定死的示例对象直通", compact(parsePermissions(JSON.stringify(sample))), ["mcp:r"]);
expect("对象：read/write 各自独立（write 不隐含 read）", compact(parsePermissions('{"memory":{"read":false,"write":true}}')), ["memory:w"]);
expect("对象：write 不影响 read", compact(parsePermissions('{"memory":{"read":true,"write":false}}')), ["memory:r"]);
expect("对象：未知键忽略", compact(parsePermissions('{"memory":{"read":true,"write":false},"nope":{"read":true},"registry":true}')), ["memory:r"]);
expect("对象：非 true 的布尔值不算授予", compact(parsePermissions('{"memory":{"read":1,"write":"true"}}')), []);
expect("对象：advanced 三个开关", advancedOn(parsePermissions('{"advanced":{"machines_secret":true,"soul_write_any":true,"vault_totp_code":false}}')), ["machines_secret", "soul_write_any"]);
expect("对象：vault_totp_code 字段可存（阶段 6 起参与校验）", advancedOn(parsePermissions('{"advanced":{"vault_totp_code":true}}')), ["vault_totp_code"]);

// ---- serialize / 往返 --------------------------------------------------------

expect("serialize 固定顺序且补齐全部键", JSON.parse(serializePermissions("[]")), {
  ...Object.fromEntries(PERMISSION_DOMAINS.map((domain) => [domain, { read: false, write: false }])),
  advanced: { machines_secret: false, soul_write_any: false, vault_totp_code: false },
});
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
expect("hasAdvanced 旧数组 soul_write_any", hasAdvanced(parsePermissions('["soul_write_any"]'), "soul_write_any"), true);
expect("hasAdvanced 未授予", hasAdvanced(mcpReader, "soul_write_any"), false);
expect("hasAdvanced(machines_secret) 默认 false", hasAdvanced(denyAllPermissions(), "machines_secret"), false);

// ---- PATCH 输入：对象严格布尔 / 旧数组过渡全开 ------------------------------

expect("PATCH 旧数组 = 列出的域 read+write 全开", compact(permissionsFromInput(["memory"]).permissions), ["memory:rw"]);
expect("PATCH 旧数组 registry 三域全开", compact(permissionsFromInput(["registry"]).permissions), ["mcp:rw", "skills:rw", "api:rw"]);
expect("PATCH 旧数组 soul_write_any 仍落 advanced", advancedOn(permissionsFromInput(["soul", "soul_write_any"]).permissions), ["soul_write_any"]);
expect("PATCH 旧数组未知项忽略", compact(permissionsFromInput(["mcp", "bogus"]).permissions), ["mcp:rw"]);
expect("PATCH 对象严格按布尔收", compact(permissionsFromInput({ mcp: { read: true, write: false } }).permissions), ["mcp:r"]);
expect("PATCH 对象未知键忽略", compact(permissionsFromInput({ mcp: { read: true, write: false, owner: true } }).permissions), ["mcp:r"]);
expect("PATCH 非对象非数组拒绝", permissionsFromInput("mcp"), { ok: false, status: 400, error: "权限格式不正确" });
expect("PATCH null 拒绝", permissionsFromInput(null), { ok: false, status: 400, error: "权限格式不正确" });

// ---- 工具分类表自检 ---------------------------------------------------------

const TOOL_NAMES = Object.keys(TOOL_PERMISSIONS);
expect("工具分类共 32 个", TOOL_NAMES.length, 32);
expect(
  "所有工具的域都在 PERMISSION_DOMAINS 内",
  TOOL_NAMES.filter((name) => !PERMISSION_DOMAINS.includes(TOOL_PERMISSIONS[name].domain)),
  [],
);
expect(
  "所有工具的操作只有 read/write",
  TOOL_NAMES.filter((name) => TOOL_PERMISSIONS[name].op !== "read" && TOOL_PERMISSIONS[name].op !== "write"),
  [],
);
expect(
  "advanced 只引用 ADVANCED_PERMISSIONS",
  TOOL_NAMES.filter((name) => TOOL_PERMISSIONS[name].advanced && !ADVANCED_PERMISSIONS.includes(TOOL_PERMISSIONS[name].advanced)),
  [],
);
expect(
  "带 advanced 的工具清单",
  TOOL_NAMES.filter((name) => TOOL_PERMISSIONS[name].advanced).sort(),
  ["machines_get_access", "vault_2fa_get_code", "vault_2fa_list"].sort(),
);
expect(
  "machines_secret 只挂 machines_get_access",
  TOOL_NAMES.filter((name) => TOOL_PERMISSIONS[name].advanced === "machines_secret"),
  ["machines_get_access"],
);
expect(
  "vault_totp_code 挂两个验证码工具",
  TOOL_NAMES.filter((name) => TOOL_PERMISSIONS[name].advanced === "vault_totp_code").sort(),
  ["vault_2fa_get_code", "vault_2fa_list"],
);
expect(
  "写工具清单与管理员裁定一致",
  TOOL_NAMES.filter((name) => TOOL_PERMISSIONS[name].op === "write").sort(),
  ["calendar_create_event", "calendar_delete_event", "calendar_update_event", "machines_report", "memory_delete", "memory_upsert", "soul_update", "tasks_complete", "tasks_create", "tasks_update"].sort(),
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
expect("只读 Agent：tools/list 有 memory_list", toolVisibleToAgent("memory_list", readOnly), true);

const readWrite = parsePermissions('{"memory":{"read":true,"write":true}}');
expect("读写俱全：memory_upsert 放行", toolAccessError("memory_upsert", readWrite, "agent-a", {}), null);
expect("读写俱全：memory_delete 放行", toolAccessError("memory_delete", readWrite, "agent-a", {}), null);
expect("读写俱全：memory_get 放行", toolAccessError("memory_get", readWrite, "agent-a", {}), null);

const writeOnly = parsePermissions('{"memory":{"read":false,"write":true}}');
expect("只给 write：memory_upsert 放行", toolAccessError("memory_upsert", writeOnly, "agent-a", {}), null);
expect("只给 write：memory_list 仍需 read", toolAccessError("memory_list", writeOnly, "agent-a", {}), "该 Agent 没有 memory 的读取权限，无法调用这个工具");

// machines_get_access：machines read 之外还要 advanced.machines_secret
const machinesRead = parsePermissions('{"machines":{"read":true,"write":false}}');
expect("machines read 无 secret：machines_get 放行", toolAccessError("machines_get", machinesRead, "agent-a", {}), null);
expect("machines read 无 secret：machines_get_access 被拒", toolAccessError("machines_get_access", machinesRead, "agent-a", {}), "该 Agent 没有查看机器接入凭据的高级权限，无法调用这个工具");
expect("machines read 无 secret：tools/list 无 machines_get_access", toolVisibleToAgent("machines_get_access", machinesRead), false);
const machinesSecret = parsePermissions('{"machines":{"read":true,"write":false},"advanced":{"machines_secret":true}}');
expect("machines read + secret：machines_get_access 放行", toolAccessError("machines_get_access", machinesSecret, "agent-a", {}), null);
expect("machines read + secret：tools/list 有 machines_get_access", toolVisibleToAgent("machines_get_access", machinesSecret), true);
expect("全关时 machines_get_access 也不出现", toolVisibleToAgent("machines_get_access", denied), false);

// vault_2fa_*：除 vault read 外还要 advanced.vault_totp_code（照 machines_get_access）
const vaultRead = parsePermissions('{"vault":{"read":true,"write":false}}');
expect("vault read 无 totp_code：vault_2fa_list 被拒", toolAccessError("vault_2fa_list", vaultRead, "agent-a", {}), "该 Agent 没有读取保险库验证码的高级权限，无法调用这个工具");
expect("vault read 无 totp_code：vault_2fa_get_code 被拒", toolAccessError("vault_2fa_get_code", vaultRead, "agent-a", {}), "该 Agent 没有读取保险库验证码的高级权限，无法调用这个工具");
expect("vault read 无 totp_code：tools/list 无两个验证码工具", ["vault_2fa_list", "vault_2fa_get_code"].filter((name) => toolVisibleToAgent(name, vaultRead)), []);
const vaultCode = parsePermissions('{"vault":{"read":true,"write":false},"advanced":{"vault_totp_code":true}}');
expect("vault read + totp_code：vault_2fa_list 放行", toolAccessError("vault_2fa_list", vaultCode, "agent-a", {}), null);
expect("vault read + totp_code：vault_2fa_get_code 放行", toolAccessError("vault_2fa_get_code", vaultCode, "agent-a", { id: "totp_x" }), null);
expect("vault read + totp_code：tools/list 有两个验证码工具", ["vault_2fa_list", "vault_2fa_get_code"].filter((name) => toolVisibleToAgent(name, vaultCode)), ["vault_2fa_list", "vault_2fa_get_code"]);
expect("只有 totp_code 没有 vault.read：仍被拒", toolAccessError("vault_2fa_get_code", parsePermissions('{"advanced":{"vault_totp_code":true}}'), "agent-a", {}), "该 Agent 没有 vault 的读取权限，无法调用这个工具");

// soul_update：自己的 Soul 要 soul.write，写别人的还要 advanced.soul_write_any
const soulWriter = parsePermissions('{"soul":{"read":false,"write":true}}');
expect("soul 写自己：放行", toolAccessError("soul_update", soulWriter, "agent-a", { agent_name: "agent-a" }), null);
expect("soul 写自己：agent_name 首尾空白不影响归属", toolAccessError("soul_update", soulWriter, "agent-a", { agent_name: " agent-a " }), null);
expect(
  "soul 写他人：无 soul_write_any 被拒",
  toolAccessError("soul_update", soulWriter, "agent-a", { agent_name: "agent-b" }),
  "只能写自己的 Soul；要代写其他 Agent 的 Soul，需要 soul_write_any 权限",
);
expect("soul 写他人：缺 agent_name 交回工具自身参数校验", toolAccessError("soul_update", soulWriter, "agent-a", {}), null);
const soulAny = parsePermissions('{"soul":{"read":false,"write":true},"advanced":{"soul_write_any":true}}');
expect("soul 写他人 + soul_write_any：放行", toolAccessError("soul_update", soulAny, "agent-a", { agent_name: "agent-b" }), null);
expect("无 soul.write：写自己也被拒", toolAccessError("soul_update", parsePermissions(null), "agent-a", { agent_name: "agent-a" }), "该 Agent 没有 soul 的写入权限，无法调用这个工具");

// 只给 advanced 不给域：仍然被拒（advanced 是加法，不是替代）
expect(
  "只有 soul_write_any 没有 soul.write：写他人被拒",
  toolAccessError("soul_update", parsePermissions('["soul_write_any"]'), "agent-a", { agent_name: "agent-b" }),
  "该 Agent 没有 soul 的写入权限，无法调用这个工具",
);

// 全域 read+write + 两个 advanced：除 soul_update 归属外全部放行
const full = parsePermissions(
  JSON.stringify({
    ...Object.fromEntries(PERMISSION_DOMAINS.map((domain) => [domain, { read: true, write: true }])),
    advanced: { machines_secret: true, soul_write_any: true, vault_totp_code: true },
  }),
);
expect(
  "全域授予：所有工具都放行（soul_update 写自己）",
  TOOL_NAMES.filter((name) => toolAccessError(name, full, "agent-a", { agent_name: "agent-a" }) !== null),
  [],
);
expect("全域授予：tools/list 覆盖全部 32 个工具", TOOL_NAMES.filter((name) => toolVisibleToAgent(name, full)).length, 32);

// 分类表与「mcp_get / soul_get 不加高级权限」的裁定一致
expect("mcp_get 无 advanced", TOOL_PERMISSIONS.mcp_get.advanced, undefined);
expect("soul_get 无 advanced", TOOL_PERMISSIONS.soul_get.advanced, undefined);

if (failures > 0) {
  console.error(`\n${failures}/${checks} 条不符`);
  process.exit(1);
}
console.log(`\n全部通过：${checks} 条检查（旧数组映射 / 垃圾输入全关 / 新对象直通 / parse-serialize 往返 / hasGrant-hasAdvanced / PATCH 过渡兼容 / 32 个工具的分类与校验矩阵）`);
