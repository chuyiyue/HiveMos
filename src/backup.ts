// 同步与备份目标：配置存取（令牌/密码用与保险库同款 AES-GCM 信封密封，
// 独立存 backup_targets，不塞进保险库条目）、活体测试、手动/定时执行。
//
// 硬线：明文机密只在请求内存与上游请求头里出现，落库一律 enc1: 密文；
// 导出包里的机密同样只有密文（见 backup-export.ts）。
//
// 执行结果每次落两处：schema_meta 里的最近状态（面板读，失败原因保留）与
// user_ops 系统日志（来源、目标、文件数、大小、结果）。

import { decryptString, resolveContentKey, sealString } from "./crypto";
import type { ContentKey } from "./crypto";
import type { D1Database, Env } from "./env";
import { buildBackupPackage, backupSummary, BACKUP_FORMAT_VERSION } from "./backup-export";
import { BackupError, formatBytes, tailOf } from "./backup-net";
import { ghProbe, ghProbeDetail, ghUpload } from "./backup-github";
import {
  backupFileName,
  wdProbe,
  wdProbeDetail,
  wdUpload,
  wdUploadDetail,
} from "./backup-webdav";
import type { WebdavConfig } from "./backup-webdav";
import { zipStore } from "./backup-zip";
import { logOp } from "./oplog";
import { cronIntervalMs, getCronIntervalHours } from "./settings";

export type TargetId = "github" | "webdav";
export type BackupTrigger = "manual" | "scheduled";

export const TARGET_IDS: TargetId[] = ["github", "webdav"];

export function targetLabel(id: TargetId): string {
  return id === "github" ? "GitHub 仓库" : "WebDAV 网盘";
}

export function isTargetId(value: unknown): value is TargetId {
  return value === "github" || value === "webdav";
}

export interface TargetRow {
  id: string;
  enabled: number;
  owner: string;
  repo: string;
  branch: string;
  path_prefix: string;
  token_enc: string;
  token_tail: string;
  base_url: string;
  username: string;
  password_enc: string;
  password_tail: string;
  remote_dir: string;
  last_test_at: number | null;
  last_test_ok: number;
  last_test_detail: string;
  last_error: string;
  created_at: number;
  updated_at: number;
}

const TARGET_COLUMNS =
  "id, enabled, owner, repo, branch, path_prefix, token_enc, token_tail, base_url, username, password_enc, password_tail, remote_dir, last_test_at, last_test_ok, last_test_detail, last_error, created_at, updated_at";

export async function getTargetRow(db: D1Database, id: TargetId): Promise<TargetRow | null> {
  const result = await db.prepare(`SELECT ${TARGET_COLUMNS} FROM backup_targets WHERE id = ?`).bind(id).first<TargetRow>();
  return result ?? null;
}

export async function listTargetRows(db: D1Database): Promise<TargetRow[]> {
  const result = await db.prepare(`SELECT ${TARGET_COLUMNS} FROM backup_targets ORDER BY id ASC`).all<TargetRow>();
  return Array.isArray(result) ? result : result.results ?? [];
}

// 面板可见的目标状态：不含任何 secret，只留末四位与测试结论。
export interface PublicTarget {
  id: TargetId;
  label: string;
  configured: boolean;
  enabled: boolean;
  owner: string;
  repo: string;
  branch: string;
  path_prefix: string;
  token_tail: string;
  has_token: boolean;
  base_url: string;
  username: string;
  password_tail: string;
  has_password: boolean;
  remote_dir: string;
  last_test_at: number | null;
  last_test_ok: boolean;
  last_test_detail: string;
  visibility: string;
  last_error: string;
}

function testDetailVisibility(detail: string): string {
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    return typeof parsed["visibility"] === "string" ? parsed["visibility"] : "";
  } catch {
    return "";
  }
}

export function publicTarget(row: TargetRow | null, id: TargetId): PublicTarget | null {
  if (!row) return null;
  const configured =
    row.enabled === 1 &&
    (id === "github"
      ? Boolean(row.owner && row.repo && row.branch && row.token_enc)
      : Boolean(row.base_url));
  return {
    id,
    label: targetLabel(id),
    configured,
    enabled: row.enabled === 1,
    owner: row.owner,
    repo: row.repo,
    branch: row.branch,
    path_prefix: row.path_prefix,
    token_tail: row.token_tail,
    has_token: row.token_enc !== "",
    base_url: row.base_url,
    username: row.username,
    password_tail: row.password_tail,
    has_password: row.password_enc !== "",
    remote_dir: row.remote_dir,
    last_test_at: row.last_test_at,
    last_test_ok: row.last_test_ok === 1,
    last_test_detail: row.last_test_detail,
    visibility: id === "github" ? testDetailVisibility(row.last_test_detail) : "",
    last_error: row.last_error,
  };
}

export async function readPublicTargets(db: D1Database): Promise<Record<TargetId, PublicTarget | null>> {
  let rows: TargetRow[] = [];
  try {
    rows = await listTargetRows(db);
  } catch {
    rows = [];
  }
  return {
    github: publicTarget(rows.find((row) => row.id === "github") ?? null, "github"),
    webdav: publicTarget(rows.find((row) => row.id === "webdav") ?? null, "webdav"),
  };
}

// ---- 密封 -----------------------------------------------------------------

function sealKey(env: Env): ContentKey {
  const raw = (env as unknown as Record<string, unknown>)["VAULT_KEY"];
  return resolveContentKey(typeof raw === "string" ? raw : undefined);
}

export async function sealTargetSecret(env: Env, plaintext: string): Promise<string> {
  const key = sealKey(env);
  if (key.state === "invalid") throw new BackupError("保险库密钥配置不正确，暂时不能保存机密", 503);
  if (key.state !== "on") throw new BackupError("保险库密钥未配置，暂时不能保存机密", 503);
  const sealed = await sealString(key, plaintext);
  if (sealed === null) throw new BackupError("保险库密钥未配置，暂时不能保存机密", 503);
  return sealed;
}

async function openTargetSecret(env: Env, stored: string): Promise<string> {
  if (!stored) return "";
  const key = sealKey(env);
  if (key.state === "invalid") throw new BackupError("保险库密钥配置不正确，无法读取机密", 503);
  if (key.state !== "on") throw new BackupError("保险库密钥未配置，无法读取机密", 503);
  const plain = await decryptString(key.raw, stored);
  if (plain === null) throw new BackupError("解密失败，保险库密钥可能不正确", 500);
  return plain;
}

// ---- 输入校验 ---------------------------------------------------------------

function optText(
  body: Record<string, unknown>,
  key: string,
  max: number,
  label: string,
  required = false,
): string {
  const value = body[key];
  if (value === undefined || value === null) {
    if (required) throw new BackupError("请填写" + label, 400);
    return "";
  }
  if (typeof value !== "string") throw new BackupError(label + "格式不正确", 400);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new BackupError("请填写" + label, 400);
    return "";
  }
  if (Array.from(trimmed).length > max) throw new BackupError(label + "太长了", 400);
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new BackupError(label + "含有不可用字符", 400);
  return trimmed;
}

function checkPattern(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw new BackupError(label + "格式不正确", 400);
}

export interface GithubInput {
  owner: string;
  repo: string;
  branch: string;
  path_prefix: string;
  token?: string;
}

export function readGithubInput(body: Record<string, unknown>): GithubInput {
  const owner = optText(body, "owner", 100, "仓库 owner", true);
  const repo = optText(body, "repo", 100, "仓库名", true);
  checkPattern(owner, /^[A-Za-z0-9_.-]+$/, "仓库 owner");
  checkPattern(repo, /^[A-Za-z0-9_.-]+$/, "仓库名");
  const branch = optText(body, "branch", 200, "分支", true);
  checkPattern(branch, /^[A-Za-z0-9_.\/-]+$/, "分支");
  if (branch.startsWith("/") || branch.endsWith("/")) throw new BackupError("分支格式不正确", 400);
  const pathPrefix = optText(body, "path_prefix", 300, "路径前缀");
  for (const part of pathPrefix.split("/")) {
    const segment = part.trim();
    if (!segment) continue;
    checkPattern(segment, /^[A-Za-z0-9_.-]+$/, "路径前缀");
  }
  const token = optText(body, "token", 1000, "访问令牌");
  return { owner, repo, branch, path_prefix: pathPrefix, token: token || undefined };
}

export async function githubConfigOf(env: Env, input: GithubInput): Promise<{
  owner: string;
  repo: string;
  branch: string;
  pathPrefix: string;
  token: string;
}> {
  const row = await getTargetRow(env.DB, "github");
  const token = input.token || (row ? await openTargetSecret(env, row.token_enc) : "");
  if (!token) throw new BackupError("请填写访问令牌", 400);
  return { owner: input.owner, repo: input.repo, branch: input.branch, pathPrefix: input.path_prefix, token };
}

// ---- WebDAV 输入 -----------------------------------------------------------

// 密码与令牌不做 trim：前后空格也可能是密码的一部分，只在全空时当作“没填”。
function secretText(body: Record<string, unknown>, key: string, max: number, label: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new BackupError(label + "格式不正确", 400);
  if (Array.from(value).length > max) throw new BackupError(label + "太长了", 400);
  return value === "" ? undefined : value;
}

export interface WebdavInput {
  base_url: string;
  username: string;
  remote_dir: string;
  password?: string;
}

export function readWebdavInput(body: Record<string, unknown>): WebdavInput {
  let baseUrl = optText(body, "base_url", 400, "WebDAV 地址", true);
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new BackupError("WebDAV 地址格式不正确", 400);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new BackupError("WebDAV 地址必须以 http:// 或 https:// 开头", 400);
  }
  if (parsed.username || parsed.password) {
    throw new BackupError("账号密码请分开填写，不要写进地址", 400);
  }
  baseUrl = parsed.toString();
  const username = optText(body, "username", 200, "用户名");
  const remoteDir = optText(body, "remote_dir", 300, "远程目录");
  if (remoteDir.includes("..")) throw new BackupError("远程目录格式不正确", 400);
  const password = secretText(body, "password", 1000, "密码");
  return { base_url: baseUrl, username, remote_dir: remoteDir, password };
}

export async function webdavConfigOf(
  env: Env,
  input: WebdavInput,
  row?: TargetRow | null,
): Promise<WebdavConfig> {
  const existing = row === undefined ? await getTargetRow(env.DB, "webdav") : row;
  const password = input.password ?? (existing ? await openTargetSecret(env, existing.password_enc) : "");
  if (input.username && !password) throw new BackupError("请填写密码", 400);
  return {
    baseUrl: input.base_url,
    username: input.username,
    password,
    remoteDir: input.remote_dir,
  };
}

// ---- 测试 -----------------------------------------------------------------

export interface TargetTestResult {
  ok: boolean;
  detail: string;
  error: string;
  visibility?: string;
  default_branch?: string;
}

function detailOf(visibility: string, defaultBranch: string, branch: string): string {
  return JSON.stringify({ visibility, default_branch: defaultBranch, branch });
}

export async function testGithubTarget(env: Env, body: Record<string, unknown>, now: number): Promise<TargetTestResult> {
  const input = readGithubInput(body);
  try {
    const config = await githubConfigOf(env, input);
    const probe = await ghProbe(config);
    const detail = detailOf(probe.visibility, probe.default_branch, probe.branch);
    await recordTest(env.DB, "github", true, detail, "", now);
    return {
      ok: true,
      detail: ghProbeDetail(probe),
      error: "",
      visibility: probe.visibility,
      default_branch: probe.default_branch,
    };
  } catch (error) {
    if (error instanceof BackupError) {
      await recordTest(env.DB, "github", false, "", error.message, now).catch(() => undefined);
      return { ok: false, detail: "", error: error.message };
    }
    throw error;
  }
}

export async function testWebdavTarget(
  env: Env,
  body: Record<string, unknown>,
  now: number,
): Promise<TargetTestResult> {
  try {
    const input = readWebdavInput(body);
    const config = await webdavConfigOf(env, input);
    const probe = await wdProbe(config);
    const detail = wdProbeDetail(probe);
    await recordTest(env.DB, "webdav", true, detail, "", now);
    const where = probe.created ? `已新建目录 ${probe.path}` : `目录 ${probe.path} 可写`;
    return { ok: true, detail: `服务器可达，${where}`, error: "" };
  } catch (error) {
    if (error instanceof BackupError) {
      await recordTest(env.DB, "webdav", false, "", error.message, now).catch(() => undefined);
      return { ok: false, detail: "", error: error.message };
    }
    throw error;
  }
}

async function recordTest(
  db: D1Database,
  id: TargetId,
  ok: boolean,
  detail: string,
  error: string,
  now: number,
): Promise<void> {
  await db
    .prepare("UPDATE backup_targets SET last_test_at = ?, last_test_ok = ?, last_test_detail = ?, last_error = ?, updated_at = ? WHERE id = ?")
    .bind(now, ok ? 1 : 0, ok ? detail : "", error, now, id)
    .run();
}

// ---- 保存 -----------------------------------------------------------------

async function upsertTarget(db: D1Database, row: TargetRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO backup_targets (${TARGET_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ` +
        `ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, owner = excluded.owner, repo = excluded.repo, ` +
        `branch = excluded.branch, path_prefix = excluded.path_prefix, token_enc = excluded.token_enc, ` +
        `token_tail = excluded.token_tail, base_url = excluded.base_url, username = excluded.username, ` +
        `password_enc = excluded.password_enc, password_tail = excluded.password_tail, remote_dir = excluded.remote_dir, ` +
        `last_test_at = excluded.last_test_at, last_test_ok = excluded.last_test_ok, ` +
        `last_test_detail = excluded.last_test_detail, last_error = excluded.last_error, updated_at = excluded.updated_at`,
    )
    .bind(
      row.id,
      row.enabled,
      row.owner,
      row.repo,
      row.branch,
      row.path_prefix,
      row.token_enc,
      row.token_tail,
      row.base_url,
      row.username,
      row.password_enc,
      row.password_tail,
      row.remote_dir,
      row.last_test_at,
      row.last_test_ok,
      row.last_test_detail,
      row.last_error,
      row.created_at,
      row.updated_at,
    )
    .run();
}

function blankTarget(id: TargetId, now: number): TargetRow {
  return {
    id,
    enabled: 0,
    owner: "",
    repo: "",
    branch: "",
    path_prefix: "",
    token_enc: "",
    token_tail: "",
    base_url: "",
    username: "",
    password_enc: "",
    password_tail: "",
    remote_dir: "",
    last_test_at: null,
    last_test_ok: 0,
    last_test_detail: "",
    last_error: "",
    created_at: now,
    updated_at: now,
  };
}

// 保存前先测活：测试不过直接抛错，库里保持原样（旧配置不被半成品覆盖）。
export async function saveWebdavTarget(env: Env, body: Record<string, unknown>, now: number): Promise<TargetRow> {
  const input = readWebdavInput(body);
  const existing = await getTargetRow(env.DB, "webdav");
  const config = await webdavConfigOf(env, input, existing);
  const probe = await wdProbe(config);
  const sealed = config.password ? await sealTargetSecret(env, config.password) : "";
  const row: TargetRow = existing ? { ...existing, updated_at: now } : blankTarget("webdav", now);
  row.enabled = 1;
  row.base_url = config.baseUrl;
  row.username = config.username;
  row.remote_dir = config.remoteDir;
  if (sealed) {
    row.password_enc = sealed;
    row.password_tail = tailOf(config.password);
  }
  row.last_test_at = now;
  row.last_test_ok = 1;
  row.last_test_detail = wdProbeDetail(probe);
  row.last_error = "";
  await upsertTarget(env.DB, row);
  return row;
}

// 保存前先测活：测试不过直接抛错，库里保持原样（旧配置不被半成品覆盖）。
export async function saveGithubTarget(env: Env, body: Record<string, unknown>, now: number): Promise<TargetRow> {
  const input = readGithubInput(body);
  const config = await githubConfigOf(env, input);
  const probe = await ghProbe(config);
  const sealed = await sealTargetSecret(env, config.token);
  const existing = await getTargetRow(env.DB, "github");
  const row: TargetRow = existing
    ? { ...existing, updated_at: now }
    : blankTarget("github", now);
  row.enabled = 1;
  row.owner = config.owner;
  row.repo = config.repo;
  row.branch = config.branch;
  row.path_prefix = config.pathPrefix;
  row.token_enc = sealed;
  row.token_tail = tailOf(config.token);
  row.last_test_at = now;
  row.last_test_ok = 1;
  row.last_test_detail = detailOf(probe.visibility, probe.default_branch, probe.branch);
  row.last_error = "";
  await upsertTarget(env.DB, row);
  return row;
}

export async function clearTarget(db: D1Database, id: TargetId, now: number): Promise<void> {
  const existing = await getTargetRow(db, id);
  if (!existing) throw new BackupError("这个目标还没有配置", 404);
  const row = blankTarget(id, now);
  row.created_at = existing.created_at;
  await upsertTarget(db, row);
}

// ---- 定时设置 ---------------------------------------------------------------

const META_AUTO = "backup_auto_enabled";
const META_TARGET = "backup_target";
const META_LAST_SUCCESS = "backup_last_success_at";
const META_LAST_ERROR = "backup_last_error";
const META_LAST_SUMMARY = "backup_last_summary";

async function readMeta(db: D1Database, key: string): Promise<string | null> {
  try {
    const row = await db.prepare("SELECT value FROM schema_meta WHERE key = ?").bind(key).first<{ value: string }>();
    return row ? row.value : null;
  } catch {
    return null;
  }
}

async function writeMeta(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

export interface BackupSchedule {
  auto_enabled: boolean;
  target: TargetId | "";
  last_success_at: number | null;
  last_error: string;
  last_summary: Record<string, unknown> | null;
}

export async function readBackupSchedule(db: D1Database): Promise<BackupSchedule> {
  const rawTarget = (await readMeta(db, META_TARGET)) ?? "";
  const target: TargetId | "" = isTargetId(rawTarget) ? rawTarget : "";
  const rawSuccess = Number((await readMeta(db, META_LAST_SUCCESS)) ?? "");
  const lastSuccess = Number.isFinite(rawSuccess) && rawSuccess > 0 ? rawSuccess : null;
  const rawSummary = await readMeta(db, META_LAST_SUMMARY);
  let summary: Record<string, unknown> | null = null;
  if (rawSummary) {
    try {
      const parsed = JSON.parse(rawSummary) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) summary = parsed as Record<string, unknown>;
    } catch {
      summary = null;
    }
  }
  return {
    auto_enabled: (await readMeta(db, META_AUTO)) === "1",
    target,
    last_success_at: lastSuccess,
    last_error: (await readMeta(db, META_LAST_ERROR)) ?? "",
    last_summary: summary,
  };
}

export async function writeBackupSchedule(db: D1Database, body: Record<string, unknown>): Promise<BackupSchedule> {
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(body, key);
  if (!has("auto_enabled") && !has("target")) throw new BackupError("没有要保存的设置", 400);
  if (has("auto_enabled")) {
    if (typeof body["auto_enabled"] !== "boolean") throw new BackupError("自动备份开关格式不正确", 400);
    await writeMeta(db, META_AUTO, body["auto_enabled"] ? "1" : "0");
  }
  if (has("target")) {
    const value = body["target"];
    if (value === "" || value === null) await writeMeta(db, META_TARGET, "");
    else if (isTargetId(value)) await writeMeta(db, META_TARGET, value);
    else throw new BackupError("备份目标不正确", 400);
  }
  return readBackupSchedule(db);
}

// 门控：上次成功时间 + 功能设置里的定时任务频率（默认 6 小时）到期才跑。
export async function backupDue(
  db: D1Database,
  schedule: BackupSchedule,
  now: number,
): Promise<{ due: boolean; interval_hours: number; elapsed_ms: number | null }> {
  const hours = await getCronIntervalHours(db);
  const last = schedule.last_success_at;
  const elapsed = last === null ? null : now - last;
  const due = last === null || elapsed === null || elapsed >= cronIntervalMs(hours);
  return { due, interval_hours: hours, elapsed_ms: elapsed };
}

export async function maybeRunScheduledBackup(env: Env, now: number): Promise<BackupRunResult | null> {
  const schedule = await readBackupSchedule(env.DB);
  if (!schedule.auto_enabled || !schedule.target) return null;
  const row = await getTargetRow(env.DB, schedule.target);
  if (!row || row.enabled !== 1) return null;
  const gate = await backupDue(env.DB, schedule, now);
  if (!gate.due) return null;
  return runBackup(env, schedule.target, "scheduled", "定时任务", now);
}

// ---- 执行 -----------------------------------------------------------------

export interface BackupRunResult {
  ok: boolean;
  target: TargetId;
  trigger: BackupTrigger;
  at: number;
  files: number;
  source_bytes: number;
  bytes: number;
  duration_ms: number;
  error: string;
  detail: string;
  counts: Record<string, number>;
}

// 手动 dry-run：只产出包并返回清单，不联网、不落日志。
export async function dryRunPackage(
  db: D1Database,
  now: number,
): Promise<{ format_version: number; files: number; source_bytes: number; counts: Record<string, number>; paths: string[] }> {
  const pkg = await buildBackupPackage(db, now);
  return {
    format_version: BACKUP_FORMAT_VERSION,
    files: pkg.files.length,
    source_bytes: pkg.source_bytes,
    counts: pkg.counts,
    paths: pkg.files.map((file) => file.path),
  };
}

export async function runBackup(
  env: Env,
  target: TargetId,
  trigger: BackupTrigger,
  actor: string,
  now: number,
): Promise<BackupRunResult> {
  const started = Date.now();
  const row = await getTargetRow(env.DB, target);
  if (!row || row.enabled !== 1) throw new BackupError(`${targetLabel(target)}还没有保存为启用状态`, 400);

  let files = 0;
  let sourceBytes = 0;
  let bytes = 0;
  let counts: Record<string, number> = {};
  const base: BackupRunResult = {
    ok: false,
    target,
    trigger,
    at: now,
    files: 0,
    source_bytes: 0,
    bytes: 0,
    duration_ms: 0,
    error: "",
    detail: "",
    counts: {},
  };

  try {
    const pkg = await buildBackupPackage(env.DB, now);
    files = pkg.files.length;
    sourceBytes = pkg.source_bytes;
    counts = pkg.counts;

    if (target === "github") {
      const token = await openTargetSecret(env, row.token_enc);
      if (!token) throw new BackupError("这个目标没有可用的访问令牌，请重新保存配置", 400);
      const summary = backupSummary(counts);
      const message =
        `备份 ${pkg.manifest.exported_at_iso}（${files} 个文件` +
        (summary ? `：${summary}` : "") +
        "）";
      const uploaded = await ghUpload(
        {
          owner: row.owner,
          repo: row.repo,
          branch: row.branch,
          pathPrefix: row.path_prefix,
          token,
        },
        pkg.files,
        message,
      );
      bytes = sourceBytes;
      base.detail = `提交 ${uploaded.commit.slice(0, 7)}`;
    } else {
      const password = await openTargetSecret(env, row.password_enc);
      if (row.username && !password) {
        throw new BackupError("这个目标没有可用的密码，请重新保存配置", 400);
      }
      const config: WebdavConfig = {
        baseUrl: row.base_url,
        username: row.username,
        password,
        remoteDir: row.remote_dir,
      };
      const zip = zipStore(pkg.files, new Date(now));
      const filename = backupFileName(now);
      const uploaded = await wdUpload(config, zip, filename);
      bytes = uploaded.bytes;
      base.detail = wdUploadDetail(uploaded);
    }

    base.ok = true;
    base.files = files;
    base.source_bytes = sourceBytes;
    base.bytes = bytes;
    base.duration_ms = Date.now() - started;
  } catch (error) {
    base.ok = false;
    base.files = files;
    base.source_bytes = sourceBytes;
    base.bytes = bytes;
    base.counts = counts;
    base.duration_ms = Date.now() - started;
    base.error = error instanceof BackupError ? error.message : "备份失败：" + (error instanceof Error ? error.message : String(error));
  }

  await recordRun(env.DB, base, actor).catch(() => undefined);
  return base;
}

async function recordRun(db: D1Database, result: BackupRunResult, actor: string): Promise<void> {
  const summary = {
    target: result.target,
    trigger: result.trigger,
    at: result.at,
    ok: result.ok,
    files: result.files,
    source_bytes: result.source_bytes,
    bytes: result.bytes,
    duration_ms: result.duration_ms,
    error: result.error,
    detail: result.detail,
  };
  try {
    await writeMeta(db, META_LAST_SUMMARY, JSON.stringify(summary));
    await writeMeta(db, META_LAST_ERROR, result.ok ? "" : result.error);
    if (result.ok) await writeMeta(db, META_LAST_SUCCESS, String(result.at));
  } catch {
    // 状态写不进去不连累备份本身；系统日志还会记一条。
  }
  const source = result.trigger === "scheduled" ? "定时" : "手动";
  const outcome = result.ok
    ? `成功，${formatBytes(result.bytes)}，耗时 ${result.duration_ms} ms`
    : `失败：${result.error}`;
  const verb = result.ok ? "备份" : "备份失败";
  await logOp(db, {
    actor,
    module: "设置",
    action: verb,
    targetId: result.target,
    targetName: "同步与备份",
    text: `${source}${targetLabel(result.target)}备份 ${result.files} 个文件，${outcome}`,
  });
}

export async function openStoredTargetSecret(env: Env, row: TargetRow): Promise<string> {
  return openTargetSecret(env, row.token_enc);
}

// 面板 reveal：管理员会话里读某个目标已存凭据的明文（GitHub 令牌 /
// WebDAV 密码）。目标不存在或没存凭据时回空串，不假装有值；存了但
// 解不开时按 openTargetSecret 的错误口径抛 BackupError。
export async function revealTargetSecret(env: Env, id: TargetId): Promise<string> {
  const row = await getTargetRow(env.DB, id);
  if (!row) return "";
  return openTargetSecret(env, id === "github" ? row.token_enc : row.password_enc);
}
