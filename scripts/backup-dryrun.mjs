#!/usr/bin/env node
// 本地 dry-run：用假 D1 跑同一个导出核心（src/backup-export.ts），生成完整包
// 并自查，不发网络请求。
//
//   node scripts/backup-dryrun.mjs
//
// 产物落在 /tmp/hivemos-backup-dryrun/（目录树 + 同名 zip），终端打印包内
// 文件清单、manifest 计数与自查结果。任何明文机密、非 enc1: 的机密字段、
// 解析不了的 JSON 都会让自查失败并以非零码退出。

import { mkdirSync, rmSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildBackupPackage } from "../src/backup-export.ts";
import { zipStore } from "../src/backup-zip.ts";

const OUT = "/tmp/hivemos-backup-dryrun";
const NOW = 1794096000000; // 2026-11-08T00:00:00Z，固定值让输出可复现

const SEALED = "enc1:ZmFrZS1pdi0xMjM0.NGFiY2RlZmdoaWprbG1ub3A"; // 演示用密文
const WRONG_PLAINTEXT = ["AGENT-TOKEN-PLAINTEXT", "hunter2", "ssh-plaintext-pass", "JBSWY3DPEHPK3PXP"];

const fixtures = {
  agents: [
    {
      id: "agt_1",
      name: "ledger",
      status: "active",
      group_id: "grp_agent",
      permissions: '["registry","memory","calendar"]',
      pinned_at: 1794000000000,
      last_seen_at: 1794090000000,
      avatar_icon: "bot-2",
      avatar_url: "",
      call_count: 42,
      token_enc: SEALED,
      created_at: 1793000000000,
    },
    {
      id: "agt_2",
      name: "watch",
      status: "disabled",
      group_id: null,
      permissions: '["registry"]',
      pinned_at: null,
      last_seen_at: null,
      avatar_icon: null,
      avatar_url: null,
      call_count: 0,
      token_enc: null,
      created_at: 1793100000000,
    },
  ],
  apps: [
    { id: "app_1", name: "Cursor", type: "桌面客户端", note: "", last_used_at: 1794090000000, group_id: null, created_at: 1793000000000, updated_at: 1793000000000 },
  ],
  mcp_servers: [
    {
      id: "mcp_cloud_mail",
      name: "cloud-mail",
      title: "Cloud Mail 邮件",
      description: "邮件能力",
      endpoint_url: "https://mail.outtw.com/mcp",
      transport: "http",
      launch_config_json: null,
      auth_type: "bearer",
      config_json: '{"headers":{"Authorization":"Bearer {{vault://cloud-mail/token}}"}}',
      tags_json: "[]",
      category: "邮件",
      summary: null,
      summary_source: null,
      status: "active",
      version: 1,
      ttl_seconds: 86400,
      snapshot_status: "manual",
      snapshot_at: 1794080000000,
      ai_status: "skipped",
      group_id: "grp_mcp",
      created_at: 1762473600000,
      updated_at: 1794080000000,
    },
  ],
  skills: [
    { id: "skill_1", name: "web-search", description: "", source: "官方注册表", content: "", status: "enabled", version: "1.4.0", used_by: "研究", group_id: null, created_at: 1793000000000, updated_at: 1793000000000 },
  ],
  apis: [
    { id: "api_1", name: "mails.dev", base_url: "https://api.mails.dev", auth_note: "Bearer <redacted> Key", note: "", status: "active", group_id: null, created_at: 1793000000000, updated_at: 1793000000000 },
  ],
  memories: [
    { id: "mem_1", title: "发布口径", scope: "全局", content: "发布前先跑 check.mjs", source: "panel", tags_json: '[{"text":"流程","source":"human"}]', version: 2, ai_summary: null, group_id: "mg_1", pinned_at: 1794000000000, weight: 80, ai_state: "tagged", created_at: 1793000000000, updated_at: 1794090000000, deleted_at: null },
    { id: "mem_2", title: "旧笔记", scope: "Agent", content: "已删除的墓碑", source: "panel", tags_json: null, version: 1, ai_summary: null, group_id: null, pinned_at: null, weight: 0, ai_state: "none", created_at: 1793000000000, updated_at: 1793000000000, deleted_at: 1793050000000 },
  ],
  memory_groups: [{ id: "mg_1", name: "流程", created_at: 1793000000000, updated_at: 1793000000000 }],
  souls: [
    { id: "soul_ledger", agent_name: "ledger", version: 2, ai_status: null, ai_summary: null, created_at: 1793000000000, updated_at: 1794090000000, content: "# 值守人格\n\n先核对再动手\n" },
  ],
  soul_versions: [
    { id: "sv_1", soul_id: "soul_ledger", version: 1, source: "panel", actor: "roye", created_at: 1793000000000, label: null, sort_order: 1, content: "# 初版\n" },
    { id: "sv_2", soul_id: "soul_ledger", version: 2, source: "panel", actor: "roye", created_at: 1794090000000, label: "值守口径", sort_order: 0, content: "# 值守人格\n\n先核对再动手\n" },
  ],
  tasks: [
    { id: "task_1", title: "核对备份包", note: "读 manifest", status: "active", assignee: "ledger", from_label: "roye", source: "panel", ai_status: null, ai_summary: null, created_at: 1794000000000, updated_at: 1794090000000, completed_at: null },
  ],
  calendars: [
    { id: "cal_default", name: "默认日历", color: "#D97757", kind: "native", source_url: null, source_etag: null, source_last_modified: null, last_sync_at: null, sync_status: null, sync_error: null, timezone: "Asia/Shanghai", ctag: 3, is_default: 1, created_by: "system", created_at: 0, updated_at: 0 },
  ],
  events: [
    { id: "ev_1", calendar_id: "cal_default", uid: "uid-1", title: "周会", description: "", location: "", starts_at: 1794200000000, ends_at: 1794203600000, tzid: "Asia/Shanghai", all_day: 0, rrule: null, exdates: null, rdates: null, recurrence_of: null, recurrence_id: null, status: "confirmed", etag: 1, source: "panel", created_by: "roye", external_id: null, content_hash: null, tags_json: null, ai_status: null, related_json: null, created_at: 1794000000000, updated_at: 1794000000000, deleted_at: null },
    { id: "ev_2", calendar_id: "cal_default", uid: "uid-2", title: "已删除", description: "", location: "", starts_at: 1794300000000, ends_at: 1794303600000, tzid: "Asia/Shanghai", all_day: 0, rrule: null, exdates: null, rdates: null, recurrence_of: null, recurrence_id: null, status: "cancelled", etag: 1, source: "panel", created_by: "roye", external_id: null, content_hash: null, tags_json: null, ai_status: null, related_json: null, created_at: 1794000000000, updated_at: 1794000000000, deleted_at: 1794050000000 },
  ],
  machines: [
    { id: "sv_sh", kind: "server", name: "上海-01", region: "华东", spec: "8 核 / 16 GB", description: "", version: "", status: "running", binding: "编排、值守", last_heartbeat_at: 1794090000000, ai_summary: null, ai_tags: null, note: "", hostname: "sh-01", os: "Debian 12", ip: "10.0.0.2", ssh_host: "10.0.0.2", ssh_port: 22, ssh_user: "root", auth_type: "password", ssh_secret_enc: SEALED, ssh_tail: "pass", vendor: "", access_note: "", cf_account_id: "", api_token_enc: "", api_token_tail: "", connection_id: "", remote_id: "", remote_name: "", remote_state: null, last_sync_at: null, probe_status: "ok", probe_at: 1794090000000, probe_error: "", kernel: "6.1", arch: "x86_64", host_fingerprint: "SHA256:abc", platform: "cloudflare", team_id: "", icon: null, icon_manual: 0, group_id: "grp_machines", created_at: 1793000000000, updated_at: 1794090000000 },
  ],
  provider_connections: [
    { id: "cn_1", provider: "huawei", name: "华为云", config_enc: SEALED, config_tail: "fake", last_test_at: 1794090000000, last_test_ok: 1, last_error: "", created_at: 1793000000000, updated_at: 1794090000000 },
  ],
  machine_keepalive: [
    { machine_id: "sv_sh", mode: "always", timezone: "Asia/Shanghai", windows_json: "[]", last_checked_at: 1794090000000, last_result: "ok", updated_at: 1794090000000 },
  ],
  groups: [
    { id: "grp_agent", scope: "agent", name: "值守", created_at: 1793000000000 },
    { id: "grp_mcp", scope: "mcp", name: "邮件", created_at: 1793000000000 },
    { id: "grp_machines", scope: "machines", name: "生产", created_at: 1793000000000 },
  ],
  vault_entries: [
    { id: "sec_1", name: "模型网关密钥", url: "", username: "", password_enc: SEALED, tail: "91f2", note: "API Key", group_id: "vg_1", created_at: 1793000000000, updated_at: 1793000000000 },
  ],
  gateways: [
    { id: "gw_1", name: "Workers AI 网关", proto: "OpenAI 兼容", base_url: "gateway.ai.cloudflare.com", models: "12 个模型", key_enc: SEALED, tail: "91f2", status: "active", group_id: "vg_1", created_at: 1793000000000, updated_at: 1793000000000 },
  ],
  emails: [
    { id: "em_1", address: "royecc@outlook.com", purpose: "主邮箱", portal: "Outlook", note: "", created_at: 1793000000000, updated_at: 1793000000000 },
  ],
  vault_groups: [{ id: "vg_1", name: "模型", created_at: 1793000000000 }],
  // 验证码条目：只看密文与参数，secret_hash 不在导出白名单里。
  vault_totp: [
    { id: "totp_1", issuer: "GitHub", account: "royecc", secret_enc: SEALED, secret_hash: "a".repeat(64), algorithm: "SHA1", digits: 6, period: 30, icon: "github", note: "主账号", group_id: "vg_1", ai_read: 1, created_at: 1793000000000, updated_at: 1793000000000 },
    { id: "totp_2", issuer: "Microsoft", account: "me@outlook.com", secret_enc: SEALED, secret_hash: "b".repeat(64), algorithm: "SHA256", digits: 8, period: 60, icon: null, note: "", group_id: null, ai_read: 0, created_at: 1793100000000, updated_at: 1793100000000 },
  ],
  schema_meta: [
    { key: "sidebar_pin_limit", value: "5" },
    { key: "cron_interval_hours", value: "6" },
    { key: "backup_auto_enabled", value: "0" },
    { key: "backup_target", value: "" },
  ],
  backup_targets: [
    {
      id: "github",
      enabled: 1,
      owner: "roye",
      repo: "hivemos-config",
      branch: "main",
      path_prefix: "backups/hivemos",
      token_enc: SEALED,
      token_tail: "ghp1",
      base_url: "",
      username: "",
      password_enc: "",
      password_tail: "",
      remote_dir: "",
      last_test_at: 1794090000000,
      last_test_ok: 1,
      last_test_detail: '{"visibility":"private"}',
      last_error: "",
      created_at: 1793000000000,
      updated_at: 1794090000000,
    },
  ],
};

function fakeDb(base) {
  return {
    prepare(sql) {
      const table = /FROM\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(sql);
      let rows = table ? base[table[1]] ?? [] : [];
      if (/WHERE\s+deleted_at\s+IS\s+NULL/i.test(sql)) {
        rows = rows.filter((row) => row.deleted_at == null);
      }
      if (table && table[1] === "schema_meta") {
        const keys = ["sidebar_pin_limit", "cron_interval_hours", "backup_auto_enabled", "backup_target"];
        rows = rows.filter((row) => keys.includes(row.key));
      }
      return {
        bind() {
          return this;
        },
        async all() {
          return { results: rows.map((row) => ({ ...row })) };
        },
        async first() {
          return rows.length ? { ...rows[0] } : null;
        },
        async run() {
          return { ok: true };
        },
      };
    },
    async batch(statements) {
      return statements;
    },
  };
}

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, base));
    else out.push(path.slice(base.length + 1));
  }
  return out;
}

const SECRET_KEYS = new Set([
  "password_enc",
  "key_enc",
  "token_enc",
  "ssh_secret_enc",
  "api_token_enc",
  "config_enc",
  "password_hash",
  "token_hash",
  "totp_secret",
  "totp_pending_secret",
  "secret_enc",
  "secret_hash",
]);

function scanSecrets(value, path, problems) {
  if (Array.isArray(value)) {
    value.forEach((item) => scanSecrets(item, path, problems));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    const here = `${path}.${key}`;
    if (SECRET_KEYS.has(key)) {
      if (typeof item === "string" && item !== "" && !item.startsWith("enc1:")) {
        problems.push(`${here} 不是密封形态`);
      }
      continue;
    }
    scanSecrets(item, here, problems);
  }
}

const db = fakeDb(fixtures);
const pkg = await buildBackupPackage(db, NOW);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const problems = [];
for (const file of pkg.files) {
  const target = join(OUT, file.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, file.text);
  if (file.path.endsWith(".json")) {
    try {
      const parsed = JSON.parse(file.text);
      if (file.path !== "manifest.json" && file.path !== "settings/system.json") {
        scanSecrets(parsed, file.path, problems);
      }
    } catch {
      problems.push(`${file.path} 不是合法 JSON`);
    }
  }
  for (const plain of WRONG_PLAINTEXT) {
    if (file.text.includes(plain)) problems.push(`${file.path} 泄漏了明文机密`);
  }
}
for (const plain of WRONG_PLAINTEXT) {
  if (JSON.stringify(fixtures).includes(plain)) problems.push("fixtures 里出现了不该有的明文机密");
}

const zip = zipStore(pkg.files.map((file) => ({ path: file.path, text: file.text })), new Date(NOW));
const zipName = "hivemos-backup-20261108-000000.zip";
writeFileSync(join(OUT, zipName), zip);

const listing = walk(OUT).filter((path) => path !== zipName);

// 验证码条目的自查：文件存在、密钥只有密文、摘要不外带。
const totpFile = pkg.files.find((file) => file.path === "vault/totp/totp_1.json");
if (!totpFile) problems.push("缺少 vault/totp/totp_1.json");
else {
  try {
    const parsed = JSON.parse(totpFile.text);
    if ("secret_hash" in parsed) problems.push("vault/totp 不应导出 secret_hash");
    if (parsed.secret_enc !== SEALED) problems.push("vault/totp 的 secret_enc 不是密文原样");
  } catch {
    problems.push("vault/totp/totp_1.json 不是合法 JSON");
  }
}
if ((pkg.manifest.counts.vault_totp ?? 0) !== 2) {
  problems.push(`manifest 的 vault_totp 计数应为 2，实际 ${pkg.manifest.counts.vault_totp}`);
}
console.log(`导出包：${pkg.files.length} 个文件，源大小 ${pkg.source_bytes} 字节，zip ${zip.byteLength} 字节（store 无压缩）`);
console.log(`manifest 计数：${JSON.stringify(pkg.manifest.counts)}`);
console.log("\n包内文件清单：");
for (const path of listing) console.log("  " + path);
console.log(`\n产物目录：${OUT}`);
console.log(`zip：${join(OUT, zipName)}`);

if (problems.length) {
  console.error("\n自查失败：");
  for (const problem of problems) console.error("  - " + problem);
  process.exit(1);
}
console.log("\n自查通过：机密字段全部为 enc1: 密文，无明文泄漏，JSON 全部可解析");
