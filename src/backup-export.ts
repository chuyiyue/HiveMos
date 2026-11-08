// 备份导出：把全系统配置读成一份目录树 + 每实体一个 JSON 文件，GitHub 上
// diff 可读。本模块只做「读数据库 → 生成文件」，不碰网络，也不依赖 Worker
// 运行时之外的东西；scripts/backup-dryrun.mjs 用假 D1 直接跑同一段代码。
//
// 机密口径（硬线）：库里以 enc1: 密文保存的列（password_enc / key_enc /
// token_enc / ssh_secret_enc / api_token_enc / config_enc）只导出密文本身，
// 任何明文机密都不进包；不可逆的凭据摘要（token_hash、calendar_feed_tokens
// 的 token_hash、totp_*、users.password_hash）一律不导出。
//
// 派生缓存（MCP 的 snapshot_json / embedding / content_hash）也是特意不导的，
// 恢复时重新探活即可生成；导出包里只留可读的配置与元数据。

import type { D1Database } from "./env.ts";

export const BACKUP_FORMAT = "hivemos.backup";
export const BACKUP_FORMAT_VERSION = 1;

export interface BackupFile {
  path: string;
  text: string;
}

export interface BackupManifest {
  format: string;
  format_version: number;
  exported_at: number;
  exported_at_iso: string;
  generated_by: string;
  secrets: string;
  counts: Record<string, number>;
  file_count: number;
  source_bytes: number;
}

export interface BackupPackage {
  files: BackupFile[];
  counts: Record<string, number>;
  manifest: BackupManifest;
  source_bytes: number;
}

type Row = Record<string, unknown>;

const PACKAGE_README = `# HiveMos 系统配置备份

本目录由 HiveMos 的「同步与备份」导出，供人工查看与将来的恢复使用。

- \`manifest.json\`：导出时间、格式版本与各板块条数（\`source_bytes\` 不含 manifest 自身）
- \`settings/\`：系统设置与两个备份目标自身的配置
- 其余目录按板块存放，一个实体一个文件（Soul 正文用 .md，元数据用 .json）

机密字段只保存 \`enc1:\` 密封密文（AES-GCM，密钥是服务端的 VAULT_KEY），
这个包本身不含任何明文机密。即使如此，包里仍有全部配置元数据与可解密的
凭据密文，仓库请使用私有仓库。
`;

function rowsOf<T>(value: { results?: T[] } | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.results)) return value.results;
  return [];
}

async function rows<T extends Row = Row>(
  db: D1Database,
  sql: string,
  values: Array<string | number | null> = [],
): Promise<T[]> {
  try {
    const statement = db.prepare(sql);
    const bound = values.length > 0 ? statement.bind(...values) : statement;
    return rowsOf(await bound.all<T>());
  } catch {
    // 迁移还没应用的表按空板块处理，导出不整体失败。
    return [];
  }
}

function pick(row: Row, keys: string[]): Row {
  const out: Row = {};
  for (const key of keys) out[key] = row[key] ?? null;
  return out;
}

function segment(value: unknown, fallback: string): string {
  const text = String(value ?? "").trim();
  const clean = text.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "_");
  return clean || fallback;
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

// 一行一个 JSON 文件，2 空格缩进：GitHub 上的 diff 才读得懂。
function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

export async function buildBackupPackage(db: D1Database, now: number): Promise<BackupPackage> {
  const files: BackupFile[] = [];
  const counts: Record<string, number> = {};
  const seen = new Set<string>();

  function add(path: string, text: string): void {
    if (seen.has(path)) return;
    seen.add(path);
    files.push({ path, text });
  }

  function entity(board: string, path: string, row: Row, keys: string[]): void {
    counts[board] = (counts[board] ?? 0) + 1;
    add(path, json(pick(row, keys)));
  }

  add("README.md", PACKAGE_README);

  // ---- Agents 与应用 -------------------------------------------------------
  const agents = await rows(
    db,
    "SELECT id, name, status, group_id, permissions, pinned_at, last_seen_at, avatar_icon, avatar_url, call_count, token_enc, created_at FROM agents ORDER BY id ASC",
  );
  for (const row of agents) {
    entity("agents", `agents/${segment(row["id"], "agent")}.json`, row, [
      "id",
      "name",
      "status",
      "group_id",
      "permissions",
      "pinned_at",
      "last_seen_at",
      "avatar_icon",
      "avatar_url",
      "call_count",
      "token_enc",
      "created_at",
    ]);
  }

  const apps = await rows(
    db,
    "SELECT id, name, type, note, last_used_at, group_id, created_at, updated_at FROM apps ORDER BY id ASC",
  );
  for (const row of apps) {
    entity("apps", `apps/${segment(row["id"], "app")}.json`, row, [
      "id",
      "name",
      "type",
      "note",
      "last_used_at",
      "group_id",
      "created_at",
      "updated_at",
    ]);
  }

  // ---- MCP / Skills / API 注册表 -------------------------------------------
  const servers = await rows(
    db,
    "SELECT id, name, title, description, endpoint_url, transport, launch_config_json, auth_type, config_json, tags_json, category, summary, summary_source, status, version, ttl_seconds, snapshot_status, snapshot_at, ai_status, group_id, created_at, updated_at FROM mcp_servers ORDER BY id ASC",
  );
  for (const row of servers) {
    entity("mcp_servers", `mcp/servers/${segment(row["id"], "server")}.json`, row, [
      "id",
      "name",
      "title",
      "description",
      "endpoint_url",
      "transport",
      "launch_config_json",
      "auth_type",
      "config_json",
      "tags_json",
      "category",
      "summary",
      "summary_source",
      "status",
      "version",
      "ttl_seconds",
      "snapshot_status",
      "snapshot_at",
      "ai_status",
      "group_id",
      "created_at",
      "updated_at",
    ]);
  }

  const skills = await rows(
    db,
    "SELECT id, name, description, source, content, status, version, used_by, group_id, created_at, updated_at FROM skills ORDER BY id ASC",
  );
  for (const row of skills) {
    entity("skills", `mcp/skills/${segment(row["id"], "skill")}.json`, row, [
      "id",
      "name",
      "description",
      "source",
      "content",
      "status",
      "version",
      "used_by",
      "group_id",
      "created_at",
      "updated_at",
    ]);
  }

  const apis = await rows(
    db,
    "SELECT id, name, base_url, auth_note, note, status, group_id, created_at, updated_at FROM apis ORDER BY id ASC",
  );
  for (const row of apis) {
    entity("apis", `mcp/apis/${segment(row["id"], "api")}.json`, row, [
      "id",
      "name",
      "base_url",
      "auth_note",
      "note",
      "status",
      "group_id",
      "created_at",
      "updated_at",
    ]);
  }

  // ---- 记忆 ---------------------------------------------------------------
  const memories = await rows(
    db,
    "SELECT id, title, scope, content, source, tags_json, version, ai_summary, group_id, pinned_at, weight, ai_state, created_at, updated_at FROM memories WHERE deleted_at IS NULL ORDER BY id ASC",
  );
  for (const row of memories) {
    entity("memories", `memories/${segment(row["id"], "memory")}.json`, row, [
      "id",
      "title",
      "scope",
      "content",
      "source",
      "tags_json",
      "version",
      "ai_summary",
      "group_id",
      "pinned_at",
      "weight",
      "ai_state",
      "created_at",
      "updated_at",
    ]);
  }

  const memoryGroups = await rows(db, "SELECT id, name, created_at, updated_at FROM memory_groups ORDER BY id ASC");
  for (const row of memoryGroups) {
    entity("memory_groups", `memories/groups/${segment(row["id"], "group")}.json`, row, [
      "id",
      "name",
      "created_at",
      "updated_at",
    ]);
  }

  // ---- Soul（正文 .md，元数据 .json，含全部历史版本） ---------------------
  const souls = await rows(
    db,
    "SELECT id, agent_name, version, ai_status, ai_summary, created_at, updated_at, content FROM souls ORDER BY id ASC",
  );
  for (const row of souls) {
    const dir = `soul/${segment(row["id"], "soul")}`;
    entity("souls", `${dir}/meta.json`, row, [
      "id",
      "agent_name",
      "version",
      "ai_status",
      "ai_summary",
      "created_at",
      "updated_at",
    ]);
    add(`${dir}/current.md`, String(row["content"] ?? ""));
  }

  const versions = await rows(
    db,
    "SELECT id, soul_id, version, source, actor, created_at, label, sort_order, content FROM soul_versions ORDER BY soul_id ASC, version ASC",
  );
  for (const row of versions) {
    const dir = `soul/${segment(row["soul_id"], "soul")}/versions`;
    const n = segment(row["version"], "0");
    entity("soul_versions", `${dir}/${n}.json`, row, ["id", "soul_id", "version", "source", "actor", "created_at", "label", "sort_order"]);
    add(`${dir}/${n}.md`, String(row["content"] ?? ""));
  }

  // ---- 任务 ---------------------------------------------------------------
  const tasks = await rows(
    db,
    "SELECT id, title, note, status, assignee, from_label, source, ai_status, ai_summary, created_at, updated_at, completed_at FROM tasks ORDER BY id ASC",
  );
  for (const row of tasks) {
    entity("tasks", `tasks/${segment(row["id"], "task")}.json`, row, [
      "id",
      "title",
      "note",
      "status",
      "assignee",
      "from_label",
      "source",
      "ai_status",
      "ai_summary",
      "created_at",
      "updated_at",
      "completed_at",
    ]);
  }

  // ---- 日历（含事件；订阅令牌只存哈希，不导出） ---------------------------
  const calendars = await rows(
    db,
    "SELECT id, name, color, kind, source_url, source_etag, source_last_modified, last_sync_at, sync_status, sync_error, timezone, ctag, is_default, created_by, created_at, updated_at FROM calendars ORDER BY id ASC",
  );
  for (const row of calendars) {
    entity("calendars", `calendar/calendars/${segment(row["id"], "calendar")}.json`, row, [
      "id",
      "name",
      "color",
      "kind",
      "source_url",
      "source_etag",
      "source_last_modified",
      "last_sync_at",
      "sync_status",
      "sync_error",
      "timezone",
      "ctag",
      "is_default",
      "created_by",
      "created_at",
      "updated_at",
    ]);
  }

  const events = await rows(
    db,
    "SELECT id, calendar_id, uid, title, description, location, starts_at, ends_at, tzid, all_day, rrule, exdates, rdates, recurrence_of, recurrence_id, status, etag, source, created_by, external_id, content_hash, tags_json, ai_status, related_json, created_at, updated_at FROM events WHERE deleted_at IS NULL ORDER BY id ASC",
  );
  for (const row of events) {
    entity("events", `calendar/events/${segment(row["id"], "event")}.json`, row, [
      "id",
      "calendar_id",
      "uid",
      "title",
      "description",
      "location",
      "starts_at",
      "ends_at",
      "tzid",
      "all_day",
      "rrule",
      "exdates",
      "rdates",
      "recurrence_of",
      "recurrence_id",
      "status",
      "etag",
      "source",
      "created_by",
      "external_id",
      "content_hash",
      "tags_json",
      "ai_status",
      "related_json",
      "created_at",
      "updated_at",
    ]);
  }

  // ---- 云计算资源（服务器 / 连接 / Workers 元数据） -----------------------
  const machines = await rows(
    db,
    "SELECT id, kind, name, region, spec, description, version, status, binding, last_heartbeat_at, ai_summary, ai_tags, note, hostname, os, ip, ssh_host, ssh_port, ssh_user, auth_type, ssh_secret_enc, ssh_tail, vendor, access_note, cf_account_id, api_token_enc, api_token_tail, connection_id, remote_id, remote_name, remote_state, last_sync_at, probe_status, probe_at, probe_error, kernel, arch, host_fingerprint, platform, team_id, icon, icon_manual, group_id, created_at, updated_at FROM machines ORDER BY id ASC",
  );
  for (const row of machines) {
    entity("machines", `machines/${segment(row["id"], "machine")}.json`, row, [
      "id",
      "kind",
      "name",
      "region",
      "spec",
      "description",
      "version",
      "status",
      "binding",
      "last_heartbeat_at",
      "ai_summary",
      "ai_tags",
      "note",
      "hostname",
      "os",
      "ip",
      "ssh_host",
      "ssh_port",
      "ssh_user",
      "auth_type",
      "ssh_secret_enc",
      "ssh_tail",
      "vendor",
      "access_note",
      "cf_account_id",
      "api_token_enc",
      "api_token_tail",
      "connection_id",
      "remote_id",
      "remote_name",
      "remote_state",
      "last_sync_at",
      "probe_status",
      "probe_at",
      "probe_error",
      "kernel",
      "arch",
      "host_fingerprint",
      "platform",
      "team_id",
      "icon",
      "icon_manual",
      "group_id",
      "created_at",
      "updated_at",
    ]);
  }

  const connections = await rows(
    db,
    "SELECT id, provider, name, config_enc, config_tail, last_test_at, last_test_ok, last_error, created_at, updated_at FROM provider_connections ORDER BY id ASC",
  );
  for (const row of connections) {
    entity("connections", `machines/connections/${segment(row["id"], "connection")}.json`, row, [
      "id",
      "provider",
      "name",
      "config_enc",
      "config_tail",
      "last_test_at",
      "last_test_ok",
      "last_error",
      "created_at",
      "updated_at",
    ]);
  }

  const keepalive = await rows(
    db,
    "SELECT machine_id, mode, timezone, windows_json, last_checked_at, last_result, updated_at FROM machine_keepalive ORDER BY machine_id ASC",
  );
  for (const row of keepalive) {
    entity("machine_keepalive", `machines/keepalive/${segment(row["machine_id"], "machine")}.json`, row, [
      "machine_id",
      "mode",
      "timezone",
      "windows_json",
      "last_checked_at",
      "last_result",
      "updated_at",
    ]);
  }

  // ---- 分组（Agent / MCP / 云主机共用一套 scope） --------------------------
  const groups = await rows(db, "SELECT id, scope, name, created_at FROM groups ORDER BY scope ASC, id ASC");
  for (const row of groups) {
    entity("groups", `groups/${segment(row["id"], "group")}.json`, row, ["id", "scope", "name", "created_at"]);
  }

  // ---- 保险库（条目 / 网关 / 邮箱 / 保险库分组；机密只导 sealed 密文） -----
  const entries = await rows(
    db,
    "SELECT id, name, url, username, password_enc, tail, note, group_id, created_at, updated_at FROM vault_entries ORDER BY id ASC",
  );
  for (const row of entries) {
    entity("vault_entries", `vault/entries/${segment(row["id"], "entry")}.json`, row, [
      "id",
      "name",
      "url",
      "username",
      "password_enc",
      "tail",
      "note",
      "group_id",
      "created_at",
      "updated_at",
    ]);
  }

  const gateways = await rows(
    db,
    "SELECT id, name, proto, base_url, models, key_enc, tail, status, group_id, created_at, updated_at FROM gateways ORDER BY id ASC",
  );
  for (const row of gateways) {
    entity("vault_gateways", `vault/gateways/${segment(row["id"], "gateway")}.json`, row, [
      "id",
      "name",
      "proto",
      "base_url",
      "models",
      "key_enc",
      "tail",
      "status",
      "group_id",
      "created_at",
      "updated_at",
    ]);
  }

  const emails = await rows(
    db,
    "SELECT id, address, purpose, portal, note, created_at, updated_at FROM emails ORDER BY id ASC",
  );
  for (const row of emails) {
    entity("emails", `vault/emails/${segment(row["id"], "email")}.json`, row, [
      "id",
      "address",
      "purpose",
      "portal",
      "note",
      "created_at",
      "updated_at",
    ]);
  }

  const vaultGroups = await rows(db, "SELECT id, name, created_at FROM vault_groups ORDER BY id ASC");
  for (const row of vaultGroups) {
    entity("vault_groups", `vault/groups/${segment(row["id"], "group")}.json`, row, ["id", "name", "created_at"]);
  }

  // ---- 系统设置（只导确定的配置项，不导运行时状态与账号哈希） -------------
  const metaKeys = ["sidebar_pin_limit", "cron_interval_hours", "backup_auto_enabled", "backup_target"];
  const metaRows = await rows(
    db,
    `SELECT key, value FROM schema_meta WHERE key IN (${metaKeys.map(() => "?").join(", ")}) ORDER BY key ASC`,
    metaKeys,
  );
  const settings: Row = {};
  for (const row of metaRows) settings[String(row["key"])] = String(row["value"] ?? "");
  counts.settings = metaRows.length;
  add("settings/system.json", json(settings));

  const targets = await rows(
    db,
    "SELECT id, enabled, owner, repo, branch, path_prefix, token_enc, token_tail, base_url, username, password_enc, password_tail, remote_dir, last_test_at, last_test_ok, last_test_detail, last_error, created_at, updated_at FROM backup_targets ORDER BY id ASC",
  );
  for (const row of targets) {
    entity("backup_targets", `settings/backup-targets/${segment(row["id"], "target")}.json`, row, [
      "id",
      "enabled",
      "owner",
      "repo",
      "branch",
      "path_prefix",
      "token_enc",
      "token_tail",
      "base_url",
      "username",
      "password_enc",
      "password_tail",
      "remote_dir",
      "last_test_at",
      "last_test_ok",
      "last_test_detail",
      "last_error",
      "created_at",
      "updated_at",
    ]);
  }

  const encoder = new TextEncoder();
  let sourceBytes = 0;
  for (const file of files) sourceBytes += encoder.encode(file.text).byteLength;

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    format_version: BACKUP_FORMAT_VERSION,
    exported_at: now,
    exported_at_iso: iso(now),
    generated_by: "HiveMos",
    secrets: "sealed_only",
    counts,
    file_count: files.length + 1, // manifest 自己也算一个文件
    source_bytes: sourceBytes,
  };
  // manifest 自己也入包，并计入文件数（但不计入 source_bytes，避免自指）。
  files.unshift({ path: "manifest.json", text: json(manifest) });

  return { files, counts, manifest, source_bytes: sourceBytes };
}

// GitHub 提交信息与 WebDAV 文件名共用：时间 + 条数。
export function backupSummary(counts: Record<string, number>): string {
  const order = [
    ["agents", "Agent"],
    ["mcp_servers", "MCP"],
    ["skills", "Skills"],
    ["apis", "API"],
    ["memories", "记忆"],
    ["souls", "Soul"],
    ["tasks", "任务"],
    ["calendars", "日历"],
    ["events", "日程"],
    ["machines", "云主机"],
    ["groups", "分组"],
    ["vault_entries", "保险库条目"],
  ];
  const parts: string[] = [];
  for (const [key, label] of order) {
    const n = counts[key] ?? 0;
    if (n > 0) parts.push(`${label} ${n}`);
  }
  return parts.join("、");
}
