#!/usr/bin/env node
// 保险库邮箱按类型（smtp / resend）的断言脚本：跑 src/vault.ts 的邮箱
// 领域层（createEmail / updateEmail / listEmails / emailPublic /
// revealSecret），与 scripts/vault-guide-vectors.mjs 同一套驱动方式。
//
//   node scripts/vault-email-vectors.mjs
//   （普通 node ≥ 22 也行：类型剥离默认开启，这些模块不依赖 Worker 全局）
//
// 覆盖定版验收口径：
//   ① 只填地址建 smtp 成功，SMTP 组整组空白（未配置）；
//   ② smtp 只填 host 也能建，security / port / user 自动补齐；
//   ③ 建 resend 带 Key：列表不回明文、resend_api_key_set=true，
//      reveal 经审计取回 Key（审计恰好多一条）；
//   ④ resend 不填 Key 可建，set=false；
//   ⑤ 编辑切换 type：smtp → resend 清配置列、保留密封槽位；resend → smtp
//      槽位同样保留；不重填 Key 沿用原值；
//   ⑥ 老行（库里没有 type 值）读出 type=smtp 且原 SMTP 数据不丢。
//
// 数据库用内存假 D1：只实现本模块真正会发的 SQL 形状（emails 的
// INSERT / UPDATE / 单行与列表 SELECT，vault_access_log 与 user_ops 的
// INSERT），遇到别的语句直接报错，避免测试悄悄放过没覆盖的查询。
// 密封用真的 AES-GCM（VAULT_KEY 给固定 32 字节）。
//
// 全过时以 0 退出并打印计数；任一条不符以 1 退出。

import { readFileSync } from "node:fs";
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
  VaultError,
  createEmail,
  emailPublic,
  listEmails,
  revealSecret,
  sealSecret,
  updateEmail,
} = await import("../src/vault.ts");

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

async function expectVaultError(label, promise, status, message) {
  checks += 1;
  try {
    await promise;
    failures += 1;
    console.error(`FAIL ${label}: expected VaultError ${status}, call succeeded`);
  } catch (error) {
    if (error instanceof VaultError && error.status === status && (!message || error.message === message)) {
      console.log(`ok   ${label} -> VaultError ${status} ${error.message}`);
    } else {
      failures += 1;
      console.error(`FAIL ${label}: expected VaultError ${status} ${message || ""}, got ${String(error)}`);
    }
  }
}

// ---- 假 D1 ------------------------------------------------------------------

const tables = {
  emails: [],
  vault_access_log: [],
  user_ops: [],
};

function clone(row) {
  return { ...row };
}

function compareValues(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return a < b ? -1 : 1;
}

function runSql(rawSql, vals) {
  const sql = rawSql.replace(/\s+/g, " ").trim();
  let m = /^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)$/.exec(sql);
  if (m) {
    const cols = m[2].split(",").map((col) => col.trim());
    if (cols.length !== vals.length) throw new Error(`假 D1：列数与值数不一致 ${cols.length}/${vals.length}`);
    const row = {};
    cols.forEach((col, i) => (row[col] = vals[i]));
    tables[m[1]].push(row);
    return [];
  }
  m = /^UPDATE (\w+) SET (.+) WHERE id = \?$/.exec(sql);
  if (m) {
    const sets = m[2].split(",").map((part) => part.trim().split(" = ")[0]);
    if (sets.length !== vals.length - 1) throw new Error(`假 D1：SET 列数与值数不一致 ${sets.length}/${vals.length - 1}`);
    const row = tables[m[1]].find((item) => item.id === vals[vals.length - 1]);
    if (row) sets.forEach((col, i) => (row[col] = vals[i]));
    return [];
  }
  if (sql === "SELECT * FROM emails WHERE id = ?") {
    const row = tables.emails.find((item) => item.id === vals[0]);
    return row ? [clone(row)] : [];
  }
  if (sql === "SELECT * FROM emails ORDER BY created_at ASC, id ASC") {
    return [...tables.emails]
      .sort((a, b) => compareValues(a.created_at, b.created_at) || compareValues(a.id, b.id))
      .map(clone);
  }
  throw new Error("假 D1 不认的 SQL: " + sql);
}

const fakeDb = {
  prepare(sql) {
    const stmt = {
      vals: [],
      bind(...vals) {
        this.vals = vals;
        return this;
      },
      async all() {
        return { results: runSql(sql, this.vals) };
      },
      async first() {
        const rows = runSql(sql, this.vals);
        return rows.length > 0 ? rows[0] : null;
      },
      async run() {
        runSql(sql, this.vals);
        return { success: true };
      },
    };
    return stmt;
  },
};

const ENV = { VAULT_KEY: Buffer.from(new Uint8Array(32).fill(7)).toString("base64url") };
const NOW = 1_800_000_000_000;

function stored(id) {
  return tables.emails.find((row) => row.id === id) || null;
}

function publicOf(id) {
  return emailPublic(stored(id));
}

function auditOf(id) {
  return tables.vault_access_log.filter((row) => row.target_id === id && row.action === "reveal");
}

async function revealValue(id) {
  const result = await revealSecret(fakeDb, ENV, { kind: "email", id }, NOW);
  return result.value;
}

// ---- ⑥ 老行（无 type）读出 smtp 且数据不丢 ------------------------------------

const legacySecret = await sealSecret(ENV, "legacy-pass");
tables.emails.push({
  id: "em_legacy",
  address: "legacy@example.com",
  purpose: "旧邮箱",
  portal: "mail.example.com",
  note: "迁移前的老行，库里没有 type 值",
  smtp_host: "smtp.legacy.example.com",
  smtp_port: 587,
  smtp_security: "starttls",
  smtp_user: "legacy@example.com",
  smtp_secret: legacySecret,
  created_at: 1,
  updated_at: 1,
});
const legacyPub = publicOf("em_legacy");
expect("老行读出 type", legacyPub.type, "smtp");
expect(
  "老行原 SMTP 数据不丢",
  [legacyPub.smtp_host, legacyPub.smtp_port, legacyPub.smtp_security, legacyPub.smtp_user, legacyPub.smtp_secret_set],
  ["smtp.legacy.example.com", 587, "starttls", "legacy@example.com", true],
);
expect("老行没有 resend 专属字段", Object.prototype.hasOwnProperty.call(legacyPub, "resend_api_key_set"), false);
expect("老行列表也按 smtp 读", (await listEmails(fakeDb)).map((row) => emailPublic(row).type), ["smtp"]);
expect("老行 reveal 取回原密码", await revealValue("em_legacy"), "legacy-pass");
expect("老行 reveal 写了 1 条审计", auditOf("em_legacy").length, 1);

// ---- ① 只填地址建 smtp：SMTP 组空白 -------------------------------------------

const e1 = await createEmail(fakeDb, ENV, { address: "addr-only@example.com" }, NOW);
const pub1 = publicOf(e1.id);
expect("只填地址建 smtp 成功", pub1.type, "smtp");
expect(
  "只填地址时 SMTP 组整组空白",
  [pub1.smtp_host, pub1.smtp_port, pub1.smtp_security, pub1.smtp_user, pub1.smtp_secret_set],
  ["", null, "", "", false],
);

// ---- ② smtp 只填 host：security / port / user 自动补齐 -------------------------

const e2 = await createEmail(fakeDb, ENV, { address: "host-only@example.com", smtp_host: "smtp.example.com" }, NOW);
const pub2 = publicOf(e2.id);
expect(
  "只填 host 时自动补齐",
  [pub2.smtp_host, pub2.smtp_security, pub2.smtp_port, pub2.smtp_user],
  ["smtp.example.com", "ssl", 465, "host-only@example.com"],
);

const e2b = await createEmail(fakeDb, ENV, { address: "host-starttls@example.com", smtp_host: "smtp.example.com", smtp_security: "starttls" }, NOW);
const pub2b = publicOf(e2b.id);
expect("starttls 缺省端口 587", [pub2b.smtp_security, pub2b.smtp_port], ["starttls", 587]);

const e2c = await createEmail(fakeDb, ENV, { address: "host-custom@example.com", smtp_host: "smtp.example.com", smtp_port: 2525 }, NOW);
const pub2c = publicOf(e2c.id);
expect("端口可单填，加密方式仍默认 ssl", [pub2c.smtp_security, pub2c.smtp_port], ["ssl", 2525]);

await expectVaultError("非法邮箱类型被拒", createEmail(fakeDb, ENV, { address: "bad@example.com", type: "gmail" }, NOW), 400, "邮箱类型不正确");
await expectVaultError(
  "非法加密方式被拒",
  createEmail(fakeDb, ENV, { address: "bad@example.com", smtp_host: "smtp.example.com", smtp_security: "tls" }, NOW),
  400,
  "加密方式不正确",
);
await expectVaultError(
  "端口范围校验保留",
  createEmail(fakeDb, ENV, { address: "bad@example.com", smtp_host: "smtp.example.com", smtp_port: 70000 }, NOW),
  400,
  "端口需为 1 到 65535 的整数",
);

// ---- ③ 建 resend 带 Key：列表不回明文、reveal 经审计取回 -----------------------

const RESEND_KEY = "re_9f8e7d6c5b4a";
const e3 = await createEmail(
  fakeDb,
  ENV,
  { address: "resend@example.com", type: "resend", resend_api_key: RESEND_KEY },
  NOW,
);
const pub3 = publicOf(e3.id);
expect("resend 类型", pub3.type, "resend");
expect(
  "resend 的 smtp_* 恒为空白",
  [pub3.smtp_host, pub3.smtp_port, pub3.smtp_security, pub3.smtp_user],
  ["", null, "", ""],
);
expect("resend_api_key_set=true", pub3.resend_api_key_set, true);
expect("resend 不回 smtp_secret_set", Object.prototype.hasOwnProperty.call(pub3, "smtp_secret_set"), false);
const listed = (await listEmails(fakeDb)).map(emailPublic);
expect("列表不回明文", JSON.stringify(listed).includes(RESEND_KEY), false);
expect("列表里只有密封值", /^enc1:[A-Za-z0-9_.-]+$/.test(String(stored(e3.id).smtp_secret)), true);
const beforeReveal = auditOf(e3.id).length;
expect("reveal 取回 Key", await revealValue(e3.id), RESEND_KEY);
expect("reveal 恰好多一条审计", auditOf(e3.id).length - beforeReveal, 1);
expect(
  "审计行记 target/action",
  tables.vault_access_log.filter((row) => row.target_id === e3.id).map((row) => row.action),
  ["reveal"],
);

// ---- ④ resend 不填 Key 可建，set=false ----------------------------------------

const e4 = await createEmail(fakeDb, ENV, { address: "resend-nokey@example.com", type: "resend" }, NOW);
const pub4 = publicOf(e4.id);
expect("resend 不填 Key 可建", pub4.type, "resend");
expect("resend 无 Key 时 set=false", pub4.resend_api_key_set, false);
expect("resend 无 Key 时密封列空", stored(e4.id).smtp_secret, null);
expect("resend 无 Key 时 reveal 返回空串", await revealValue(e4.id), "");

// ---- ⑤ 编辑切换 type -----------------------------------------------------------

const e5 = await createEmail(
  fakeDb,
  ENV,
  { address: "switch@example.com", smtp_host: "smtp.switch.example.com", smtp_security: "ssl", smtp_secret: "smtp-pass" },
  NOW,
);
const pub5 = publicOf(e5.id);
expect("切换前是 smtp 且有密码", [pub5.type, pub5.smtp_secret_set], ["smtp", true]);

// smtp → resend：配置列清空，密封槽位保留当 API Key（未重填沿用原密码）
const switched1 = await updateEmail(fakeDb, ENV, e5.id, { type: "resend" }, NOW + 1);
const sp1 = emailPublic(switched1);
expect("切到 resend 后类型", sp1.type, "resend");
expect(
  "切到 resend 清掉 SMTP 配置列",
  [sp1.smtp_host, sp1.smtp_port, sp1.smtp_security, sp1.smtp_user],
  ["", null, "", ""],
);
expect("切到 resend 保留密封槽位（set=true）", sp1.resend_api_key_set, true);
expect("未重填时沿用原密文", await revealValue(e5.id), "smtp-pass");

// resend 重填 Key
await updateEmail(fakeDb, ENV, e5.id, { type: "resend", resend_api_key: "re_switch_new" }, NOW + 2);
expect("resend 重填 Key 生效", await revealValue(e5.id), "re_switch_new");
await updateEmail(fakeDb, ENV, e5.id, { type: "resend", resend_api_key: "" }, NOW + 3);
expect("resend 空 Key = 不改", await revealValue(e5.id), "re_switch_new");

// resend → smtp：不填 SMTP 字段时配置列保持空白、密封槽位保留当密码槽位
const switched2 = await updateEmail(fakeDb, ENV, e5.id, { type: "smtp" }, NOW + 4);
const sp2 = emailPublic(switched2);
expect("切回 smtp 后类型", sp2.type, "smtp");
expect(
  "切回 smtp 配置列仍空白",
  [sp2.smtp_host, sp2.smtp_port, sp2.smtp_security, sp2.smtp_user],
  ["", null, "", ""],
);
expect("切回 smtp 槽位保留当密码（set=true）", sp2.smtp_secret_set, true);
expect("切回 smtp 后 reveal 仍是原 Key", await revealValue(e5.id), "re_switch_new");

// 接着填 SMTP 字段：按逐字段规则补齐，密码没重填就沿用
await updateEmail(fakeDb, ENV, e5.id, { smtp_host: "smtp.next.example.com", smtp_security: "starttls" }, NOW + 5);
const sp3 = emailPublic(stored(e5.id));
expect(
  "切回后补 host 自动补齐",
  [sp3.smtp_host, sp3.smtp_security, sp3.smtp_port, sp3.smtp_user],
  ["smtp.next.example.com", "starttls", 587, "switch@example.com"],
);
expect("补 host 时密码沿用", await revealValue(e5.id), "re_switch_new");
await updateEmail(fakeDb, ENV, e5.id, { smtp_secret: "new-smtp-pass" }, NOW + 6);
expect("重填密码生效", await revealValue(e5.id), "new-smtp-pass");

// 只给空密码 = 不改：配置列与已存密文都保留
await updateEmail(fakeDb, ENV, e5.id, { smtp_secret: "" }, NOW + 6);
const spNoop = emailPublic(stored(e5.id));
expect(
  "只给空密码不清配置",
  [spNoop.smtp_host, spNoop.smtp_security, spNoop.smtp_port, spNoop.smtp_user, spNoop.smtp_secret_set],
  ["smtp.next.example.com", "starttls", 587, "switch@example.com", true],
);
expect("只给空密码保留原密文", await revealValue(e5.id), "new-smtp-pass");

// 整组全空 = 未配置：清配置列与密封值（与 0030 的现状一致）
await updateEmail(
  fakeDb,
  ENV,
  e5.id,
  { smtp_host: "", smtp_port: "", smtp_security: "", smtp_user: "", smtp_secret: "" },
  NOW + 7,
);
const sp4 = emailPublic(stored(e5.id));
expect(
  "整组全空回到未配置",
  [sp4.smtp_host, sp4.smtp_port, sp4.smtp_security, sp4.smtp_user, sp4.smtp_secret_set],
  ["", null, "", "", false],
);

// resend 行即使同时给了 smtp_* 也恒为空白
await updateEmail(fakeDb, ENV, e5.id, { type: "resend", smtp_host: "ignored.example.com" }, NOW + 8);
const sp5 = emailPublic(stored(e5.id));
expect("resend 行不吃 smtp_host", [sp5.type, sp5.smtp_host], ["resend", ""]);

await expectVaultError("编辑时非法类型被拒", updateEmail(fakeDb, ENV, e5.id, { type: "other" }, NOW + 9), 400, "邮箱类型不正确");
await expectVaultError("改不存在的邮箱", updateEmail(fakeDb, ENV, "em_missing", { type: "smtp" }, NOW + 10), 404, "邮箱不存在");

// ---- 迁移 0078 ---------------------------------------------------------------

const migration = readFileSync(new URL("../migrations/0078_email_types.sql", import.meta.url), "utf8");
expect("0078 加 type 列且默认 smtp", /ALTER TABLE emails ADD COLUMN type TEXT NOT NULL DEFAULT 'smtp'/.test(migration), true);

// ---- 汇总 ---------------------------------------------------------------------

console.log(`\n${checks} checks, ${failures} failure(s)`);
if (failures > 0) process.exit(1);
console.log("vault-email vectors passed");
