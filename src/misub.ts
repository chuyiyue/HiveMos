// MiSub 客户端：云计算资源「代理」页的数据来自管理员自己的 MiSub 实例
// （External Management API，/api/ext/v1，Bearer Token）。
//
// 连接存 schema_meta.misub_connections（JSON），令牌用 VAULT_KEY 密封；
// 抓到的快照密封后存 D1（misub-store.ts）。Worker 只调 MiSub API，不拉机场订阅。
// 同步频率：每个连接自己的自动同步间隔，未设置就是 0（关闭），没在该连接上
// 明确开启就不自动出站；hourly cron 只同步已开启且到期的，手动刷新与保存时
// 同步不受这个间隔影响。拉取失败保留上一次成功的数据，只记录错误。

import type { D1Database, Env } from "./env";
import { decryptString, resolveContentKey, sealString, type ContentKey } from "./crypto";
import { detectRegion } from "./misub-region";

export class MisubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const LEGACY_CONFIG_KEY = "misub_config";
const CONNECTIONS_KEY = "misub_connections";
const FETCH_TIMEOUT_MS = 8000;
const PAGE_SIZE = 200;
const MAX_PAGES = 5;
const BASE_URL_MAX = 300;
const TOKEN_MAX = 4096;
const ID_PREFIX = "msub_";

function newId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return prefix + hex;
}

// ---------------------------------------------------------------------------
// 连接数据结构

export interface MisubConnection {
  id: string;
  provider: "misub";
  name: string;
  base_url: string;
  token_tail: string;
  refresh_enabled: boolean;
  auto_interval_hours: number; // 0 = 不自动同步
  active: boolean;
  last_test_at: number;
  last_test_ok: boolean;
  last_error: string;
  created_at: number;
  updated_at: number;
}

interface StoredConnection {
  id: string;
  name: string;
  base_url: string;
  token_enc: string;
  token_tail: string;
  refresh_enabled: boolean;
  auto_interval_hours: number;
  last_test_at: number;
  last_test_ok: boolean;
  last_error: string;
  created_at: number;
  updated_at: number;
}

interface StoredConnections {
  connections: StoredConnection[];
  active_id: string;
}

function projectConnection(c: StoredConnection, active: boolean): MisubConnection {
  return {
    id: c.id,
    provider: "misub",
    name: c.name,
    base_url: c.base_url,
    token_tail: c.token_tail,
    refresh_enabled: c.refresh_enabled,
    auto_interval_hours: c.auto_interval_hours,
    active,
    last_test_at: c.last_test_at,
    last_test_ok: c.last_test_ok,
    last_error: c.last_error,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

// 新连接、以及库里缺这个字段的旧连接，有效间隔都是 0。不再回退 6 小时。
export const DEFAULT_AUTO_INTERVAL_HOURS = 0;
export const MAX_INTERVAL_HOURS = 168;

// 未设置（null / undefined / 缺失）和非法值一律 0（关闭）。0..168 的整数原样保留，
// 包括已经存成 6 的连接——那是当时明确写下的值，不在读取时改掉。
export function effectiveAutoIntervalHours(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_INTERVAL_HOURS
    ? value
    : 0;
}

function normalizeStoredInterval(value: unknown): number {
  return effectiveAutoIntervalHours(value);
}

// 写入：字段省略时用 whenOmitted（新建为 0，更新为原值）。null 或空串是「留空」，按关闭处理。
function resolveAutoIntervalWrite(value: unknown, whenOmitted: number): number {
  if (value === undefined) return whenOmitted;
  if (value === null || (typeof value === "string" && value.trim() === "")) return 0;
  return validateIntervalHours(value, "自动拉取间隔");
}

export function validateIntervalHours(value: unknown, label: string): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_INTERVAL_HOURS) {
    throw new MisubError(400, label + "需要是 0 到 168 的整数");
  }
  return n;
}

interface LegacyStoredConfig {
  base_url: string;
  token_enc: string;
  token_tail: string;
  refresh_enabled: boolean;
}

// ---------------------------------------------------------------------------
// VAULT_KEY 信封

function vaultKeyOf(env: Env): ContentKey {
  const raw = (env as unknown as Record<string, unknown>)["VAULT_KEY"];
  return resolveContentKey(typeof raw === "string" ? raw : undefined);
}

// 与保险库页的判定同口径：on 表示可用，off 表示未配置，invalid 表示密钥
// 长度/编码不对。面板据此整页提示，而不是每次保存都报同一个错。
export function misubVaultKeyState(env: Env): ContentKey["state"] {
  return vaultKeyOf(env).state;
}

const VAULT_OFF_SAVE_MESSAGE = "保险库未配置，无法保存 MiSub 令牌";
const VAULT_INVALID_SAVE_MESSAGE = "保险库密钥配置不正确，无法保存 MiSub 令牌";
const VAULT_OFF_OPEN_MESSAGE = "保险库未配置，无法读取 MiSub 令牌";
const VAULT_INVALID_OPEN_MESSAGE = "保险库密钥配置不正确，无法读取 MiSub 令牌";

// ---------------------------------------------------------------------------
// 存储读写

async function readStoredConnections(db: D1Database): Promise<StoredConnections | null> {
  try {
    const row = await db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .bind(CONNECTIONS_KEY)
      .first<{ value: string }>();
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as Partial<StoredConnections>;
    if (!Array.isArray(parsed.connections)) return null;
    const connections: StoredConnection[] = [];
    for (const c of parsed.connections) {
      if (
        typeof c.id === "string" &&
        c.id &&
        typeof c.name === "string" &&
        typeof c.base_url === "string" &&
        c.base_url &&
        typeof c.token_enc === "string" &&
        c.token_enc &&
        typeof c.refresh_enabled === "boolean" &&
        typeof c.created_at === "number" &&
        typeof c.updated_at === "number"
      ) {
        connections.push({
          id: c.id,
          name: c.name,
          base_url: c.base_url,
          token_enc: c.token_enc,
          token_tail: typeof c.token_tail === "string" ? c.token_tail : "",
          refresh_enabled: c.refresh_enabled,
          auto_interval_hours: normalizeStoredInterval(c.auto_interval_hours),
          last_test_at: typeof c.last_test_at === "number" ? c.last_test_at : 0,
          last_test_ok: c.last_test_ok === true,
          last_error: typeof c.last_error === "string" ? c.last_error : "",
          created_at: c.created_at,
          updated_at: c.updated_at,
        });
      }
    }
    return {
      connections,
      active_id: typeof parsed.active_id === "string" ? parsed.active_id : "",
    };
  } catch {
    return null;
  }
}

async function writeStoredConnections(db: D1Database, data: StoredConnections): Promise<void> {
  await db
    .prepare(
      "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(CONNECTIONS_KEY, JSON.stringify(data))
    .run();
}

async function readLegacyConfig(db: D1Database): Promise<LegacyStoredConfig | null> {
  try {
    const row = await db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .bind(LEGACY_CONFIG_KEY)
      .first<{ value: string }>();
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as Partial<LegacyStoredConfig>;
    if (typeof parsed.base_url !== "string" || !parsed.base_url) return null;
    if (typeof parsed.token_enc !== "string" || !parsed.token_enc) return null;
    return {
      base_url: parsed.base_url,
      token_enc: parsed.token_enc,
      token_tail: typeof parsed.token_tail === "string" ? parsed.token_tail : "",
      refresh_enabled: parsed.refresh_enabled === true,
    };
  } catch {
    return null;
  }
}

async function deleteLegacyConfig(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM schema_meta WHERE key = ?").bind(LEGACY_CONFIG_KEY).run();
}

// 将 legacy 配置迁移为单连接结构
async function migrateLegacyIfNeeded(db: D1Database): Promise<void> {
  const existing = await readStoredConnections(db);
  if (existing) return; // 已有新结构，无需迁移
  const legacy = await readLegacyConfig(db);
  if (!legacy) return; // 也没有 legacy，全新安装

  const now = Date.now();
  let name = "";
  try {
    const u = new URL(legacy.base_url);
    name = u.hostname || "";
  } catch {
    name = "";
  }
  if (!name) name = "MiSub";

  // legacy 的 token_tail 若长度 < 4 视为短令牌，对外一律按空串
  const tokenTail = legacy.token_tail && legacy.token_tail.length >= 4 ? legacy.token_tail : "";

  const conn: StoredConnection = {
    id: newId(ID_PREFIX),
    name,
    base_url: legacy.base_url,
    token_enc: legacy.token_enc,
    token_tail: tokenTail,
    refresh_enabled: legacy.refresh_enabled,
    auto_interval_hours: DEFAULT_AUTO_INTERVAL_HOURS,
    last_test_at: 0,
    last_test_ok: false,
    last_error: "",
    created_at: now,
    updated_at: now,
  };
  await writeStoredConnections(db, { connections: [conn], active_id: conn.id });
  await deleteLegacyConfig(db);
}

// ---------------------------------------------------------------------------
// 配置读写（旧兼容 API）

export interface MisubConfig {
  base_url: string;
  token_tail: string;
  refresh_enabled: boolean;
}

export async function readMisubConfig(db: D1Database): Promise<MisubConfig | null> {
  await migrateLegacyIfNeeded(db);
  const stored = await readStoredConnections(db);
  if (!stored || stored.connections.length === 0) return null;
  const active = stored.connections.find((c) => c.id === stored.active_id) ?? stored.connections[0];
  return {
    base_url: active.base_url,
    token_tail: active.token_tail,
    refresh_enabled: active.refresh_enabled,
  };
}

// 旧 saveMisubConfig：有当前连接时更新当前连接、无连接时新建并设为当前
export async function saveMisubConfig(
  env: Env,
  input: { base_url: unknown; token?: unknown; refresh_enabled?: unknown },
): Promise<MisubConfig> {
  await migrateLegacyIfNeeded(env.DB);
  const baseUrl = normalizeMisubBaseUrl(input.base_url);
  if (input.refresh_enabled !== undefined && typeof input.refresh_enabled !== "boolean") {
    throw new MisubError(400, "刷新开关格式不正确");
  }
  const key = vaultKeyOf(env);
  if (key.state === "invalid") throw new MisubError(503, VAULT_INVALID_SAVE_MESSAGE);
  if (key.state !== "on") throw new MisubError(503, VAULT_OFF_SAVE_MESSAGE);
  const submittedToken = typeof input.token === "string" ? input.token.trim() : "";
  if (submittedToken.length > TOKEN_MAX) throw new MisubError(400, "MiSub 令牌过长");

  const stored = await readStoredConnections(env.DB);
  let tokenEnc: string;
  let tokenPlain: string;
  let tokenTail: string;

  if (submittedToken) {
    const sealed = await sealString(key, submittedToken);
    if (sealed === null) throw new MisubError(503, VAULT_OFF_SAVE_MESSAGE);
    tokenEnc = sealed;
    tokenPlain = submittedToken;
    tokenTail = submittedToken.length > 4 ? submittedToken.slice(-4) : "";
  } else if (stored && stored.connections.length > 0) {
    const active = stored.connections.find((c) => c.id === stored.active_id) ?? stored.connections[0];
    tokenEnc = active.token_enc;
    tokenPlain = await openToken(env, { ...active, token_enc: active.token_enc } as StoredConnection);
    tokenTail = active.token_tail || (tokenPlain.length > 4 ? tokenPlain.slice(-4) : "");
  } else {
    throw new MisubError(400, "请填写 MiSub 令牌");
  }

  // 先测一次再落库
  await testMisubConnection(baseUrl, tokenPlain);

  const now = Date.now();
  if (stored && stored.connections.length > 0) {
    // 更新当前连接
    const activeIndex = stored.connections.findIndex((c) => c.id === stored.active_id);
    const targetIndex = activeIndex >= 0 ? activeIndex : 0;
    stored.connections[targetIndex] = {
      ...stored.connections[targetIndex],
      base_url: baseUrl,
      token_enc: tokenEnc,
      token_tail: tokenTail,
      refresh_enabled: input.refresh_enabled !== undefined ? input.refresh_enabled : stored.connections[targetIndex].refresh_enabled,
      last_test_at: now,
      last_test_ok: true,
      last_error: "",
      updated_at: now,
    };
    await writeStoredConnections(env.DB, stored);
    const updated = stored.connections[targetIndex];
    return { base_url: updated.base_url, token_tail: updated.token_tail, refresh_enabled: updated.refresh_enabled };
  } else {
    // 新建并设为当前
    const conn: StoredConnection = {
      id: newId(ID_PREFIX),
      name: defaultNameFromBaseUrl(baseUrl),
      base_url: baseUrl,
      token_enc: tokenEnc,
      token_tail: tokenTail,
      refresh_enabled: input.refresh_enabled === true,
      auto_interval_hours: DEFAULT_AUTO_INTERVAL_HOURS,
      last_test_at: now,
      last_test_ok: true,
      last_error: "",
      created_at: now,
      updated_at: now,
    };
    await writeStoredConnections(env.DB, { connections: [conn], active_id: conn.id });
    return { base_url: conn.base_url, token_tail: conn.token_tail, refresh_enabled: conn.refresh_enabled };
  }
}

// 已配置后只改刷新开关：不重测连接、不碰令牌。
export async function setMisubRefreshEnabled(env: Env, enabled: boolean): Promise<MisubConfig> {
  await migrateLegacyIfNeeded(env.DB);
  const stored = await readStoredConnections(env.DB);
  if (!stored || stored.connections.length === 0) throw new MisubError(400, "尚未连接 MiSub");
  const activeIndex = stored.connections.findIndex((c) => c.id === stored.active_id);
  const targetIndex = activeIndex >= 0 ? activeIndex : 0;
  const now = Date.now();
  stored.connections[targetIndex] = {
    ...stored.connections[targetIndex],
    refresh_enabled: enabled,
    updated_at: now,
  };
  await writeStoredConnections(env.DB, stored);
  return {
    base_url: stored.connections[targetIndex].base_url,
    token_tail: stored.connections[targetIndex].token_tail,
    refresh_enabled: enabled,
  };
}

// 旧 clearMisubConfig：只删当前连接（旧「断开」语义）
export async function clearMisubConfig(db: D1Database): Promise<void> {
  await migrateLegacyIfNeeded(db);
  const stored = await readStoredConnections(db);
  if (!stored || stored.connections.length === 0) return;
  const activeIndex = stored.connections.findIndex((c) => c.id === stored.active_id);
  const targetIndex = activeIndex >= 0 ? activeIndex : 0;
  stored.connections.splice(targetIndex, 1);
  if (stored.connections.length > 0) {
    // 选 updated_at 最新的作为当前
    let latest = stored.connections[0];
    for (const c of stored.connections) {
      if (c.updated_at > latest.updated_at) latest = c;
    }
    stored.active_id = latest.id;
  } else {
    stored.active_id = "";
  }
  await writeStoredConnections(db, stored);
}

// ---------------------------------------------------------------------------
// 连接管理业务函数

// 列出所有连接（不含 token_enc）
export async function listMisubConnections(db: D1Database): Promise<{ connections: MisubConnection[]; active_id: string }> {
  await migrateLegacyIfNeeded(db);
  const stored = await readStoredConnections(db);
  if (!stored) return { connections: [], active_id: "" };
  const connections: MisubConnection[] = stored.connections.map((c) => (projectConnection(c, c.id === stored.active_id)));
  return { connections, active_id: stored.active_id };
}

// 按 id（省略取当前）取连接并解开令牌。
export interface MisubConnectionHandle {
  id: string;
  base_url: string;
  auto_interval_hours: number;
  refresh_enabled: boolean;
  token: string;
}

export async function openMisubConnection(env: Env, id?: string): Promise<MisubConnectionHandle> {
  let conn: StoredConnection;
  if (id) {
    const found = await getConnectionById(env, id);
    if (!found) throw new MisubError(404, "MiSub 连接不存在");
    conn = found;
  } else {
    conn = (await requireConnection(env)).connection;
  }
  const token = await openToken(env, conn);
  return {
    id: conn.id,
    base_url: conn.base_url,
    auto_interval_hours: conn.auto_interval_hours,
    refresh_enabled: conn.refresh_enabled,
    token,
  };
}

// 面板明文显示令牌用。
export async function revealMisubToken(env: Env, id: string): Promise<string> {
  const conn = await getConnectionById(env, id);
  if (!conn) throw new MisubError(404, "MiSub 连接不存在");
  return openToken(env, conn);
}

export async function listMisubConnectionIds(db: D1Database): Promise<{ ids: string[]; active_id: string }> {
  await migrateLegacyIfNeeded(db);
  const stored = await readStoredConnections(db);
  return { ids: (stored?.connections ?? []).map((c) => c.id), active_id: stored?.active_id ?? "" };
}

async function requireConnection(env: Env): Promise<{ connection: StoredConnection; token: string }> {
  await migrateLegacyIfNeeded(env.DB);
  const stored = await readStoredConnections(env.DB);
  if (!stored || stored.connections.length === 0) throw new MisubError(400, "尚未连接 MiSub");
  const active = stored.connections.find((c) => c.id === stored.active_id) ?? stored.connections[0];
  return { connection: active, token: await openToken(env, active) };
}

// 按 id 读连接（含 token_enc，供内部用）
async function getConnectionById(env: Env, id: string): Promise<StoredConnection | null> {
  await migrateLegacyIfNeeded(env.DB);
  const stored = await readStoredConnections(env.DB);
  if (!stored) return null;
  return stored.connections.find((c) => c.id === id) ?? null;
}

// 按 id 读连接（公开投影，不含 token_enc）
export async function getMisubConnection(db: D1Database, id: string): Promise<MisubConnection | null> {
  await migrateLegacyIfNeeded(db);
  const stored = await readStoredConnections(db);
  if (!stored) return null;
  const c = stored.connections.find((c) => c.id === id);
  if (!c) return null;
  return projectConnection(c, c.id === stored.active_id);
}

// 名称校验
function validateName(name: unknown): string {
  if (typeof name !== "string") throw new MisubError(400, "连接名称格式不正确");
  const trimmed = name.trim();
  if (!trimmed) throw new MisubError(400, "请填写连接名称");
  // 按 Unicode 字符计数（code points）
  if ([...trimmed].length > 60) throw new MisubError(400, "连接名称过长（最多 60 字符）");
  return trimmed;
}

// 从 base_url 推导默认名称
function defaultNameFromBaseUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    const host = u.hostname;
    if (host) return host;
  } catch {
    // ignore
  }
  return "MiSub";
}

// 新增连接
export async function addMisubConnection(
  env: Env,
  input: { name: unknown; base_url: unknown; token: unknown; refresh_enabled?: unknown; active?: unknown; auto_interval_hours?: unknown },
): Promise<{ connection: MisubConnection; connections: MisubConnection[]; active_id: string }> {
  await migrateLegacyIfNeeded(env.DB);
  const baseUrl = normalizeMisubBaseUrl(input.base_url);
  const nameInput = typeof input.name === "string" ? input.name.trim() : "";
  const name = nameInput || defaultNameFromBaseUrl(baseUrl);
  validateName(name);
  const submittedToken = typeof input.token === "string" ? input.token.trim() : "";
  if (!submittedToken) throw new MisubError(400, "请填写 MiSub 令牌");
  if (submittedToken.length > TOKEN_MAX) throw new MisubError(400, "MiSub 令牌过长");
  if (input.refresh_enabled !== undefined && typeof input.refresh_enabled !== "boolean") {
    throw new MisubError(400, "刷新开关格式不正确");
  }
  const autoInterval = resolveAutoIntervalWrite(input.auto_interval_hours, DEFAULT_AUTO_INTERVAL_HOURS);

  const key = vaultKeyOf(env);
  if (key.state === "invalid") throw new MisubError(503, VAULT_INVALID_SAVE_MESSAGE);
  if (key.state !== "on") throw new MisubError(503, VAULT_OFF_SAVE_MESSAGE);

  const sealed = await sealString(key, submittedToken);
  if (sealed === null) throw new MisubError(503, VAULT_OFF_SAVE_MESSAGE);
  const tokenPlain = submittedToken;
  const tokenTail = tokenPlain.length > 4 ? tokenPlain.slice(-4) : "";

  // 先测连接
  await testMisubConnection(baseUrl, tokenPlain);

  const now = Date.now();
  const stored = await readStoredConnections(env.DB);
  const connections = stored?.connections ?? [];
  const activeIdBefore = stored?.active_id ?? "";
  const shouldBeActive = connections.length === 0 || input.active === true;

  const conn: StoredConnection = {
    id: newId(ID_PREFIX),
    name,
    base_url: baseUrl,
    token_enc: sealed,
    token_tail: tokenTail,
    refresh_enabled: input.refresh_enabled === true,
    auto_interval_hours: autoInterval,
    last_test_at: now,
    last_test_ok: true,
    last_error: "",
    created_at: now,
    updated_at: now,
  };
  connections.push(conn);
  const newActiveId = shouldBeActive ? conn.id : activeIdBefore;
  await writeStoredConnections(env.DB, { connections, active_id: newActiveId });

  const resultConnections: MisubConnection[] = connections.map((c) => (projectConnection(c, c.id === newActiveId)));
  return { connection: resultConnections.find((c) => c.id === conn.id)!, connections: resultConnections, active_id: newActiveId };
}

// 更新连接（PATCH 语义）
export async function updateMisubConnection(
  env: Env,
  id: string,
  input: { name?: unknown; base_url?: unknown; token?: unknown; refresh_enabled?: unknown; auto_interval_hours?: unknown },
): Promise<{ connection: MisubConnection; connections: MisubConnection[]; active_id: string }> {
  await migrateLegacyIfNeeded(env.DB);
  const stored = await readStoredConnections(env.DB);
  if (!stored) throw new MisubError(404, "MiSub 连接不存在");
  const index = stored.connections.findIndex((c) => c.id === id);
  if (index < 0) throw new MisubError(404, "MiSub 连接不存在");
  const current = stored.connections[index];

  // 验证 name
  let newName = current.name;
  if (input.name !== undefined) {
    newName = validateName(input.name);
  }

  // 验证 base_url
  let newBaseUrl = current.base_url;
  let baseUrlChanged = false;
  if (input.base_url !== undefined) {
    const normalized = normalizeMisubBaseUrl(input.base_url);
    if (normalized !== current.base_url) {
      newBaseUrl = normalized;
      baseUrlChanged = true;
    }
  }

  // 验证 refresh_enabled
  let newRefreshEnabled = current.refresh_enabled;
  if (input.refresh_enabled !== undefined) {
    if (typeof input.refresh_enabled !== "boolean") throw new MisubError(400, "刷新开关格式不正确");
    newRefreshEnabled = input.refresh_enabled;
  }

  const newAutoInterval = resolveAutoIntervalWrite(input.auto_interval_hours, current.auto_interval_hours);

  // 验证 token
  let newTokenEnc = current.token_enc;
  let newTokenTail = current.token_tail;
  let tokenChanged = false;
  let tokenPlain: string | null = null;
  if (input.token !== undefined) {
    const submitted = typeof input.token === "string" ? input.token.trim() : "";
    if (submitted !== "") {
      if (submitted.length > TOKEN_MAX) throw new MisubError(400, "MiSub 令牌过长");
      const key = vaultKeyOf(env);
      if (key.state === "invalid") throw new MisubError(503, VAULT_INVALID_SAVE_MESSAGE);
      if (key.state !== "on") throw new MisubError(503, VAULT_OFF_SAVE_MESSAGE);
      const sealed = await sealString(key, submitted);
      if (sealed === null) throw new MisubError(503, VAULT_OFF_SAVE_MESSAGE);
      newTokenEnc = sealed;
      newTokenTail = submitted.length > 4 ? submitted.slice(-4) : "";
      tokenPlain = submitted;
      tokenChanged = true;
    }
    // token 留空 = 不改
  }

  const needTest = baseUrlChanged || tokenChanged;
  if (needTest) {
    const testToken = tokenPlain ?? (await openToken(env, current));
    await testMisubConnection(newBaseUrl, testToken);
  }

  const now = Date.now();
  stored.connections[index] = {
    ...current,
    name: newName,
    base_url: newBaseUrl,
    token_enc: newTokenEnc,
    token_tail: newTokenTail,
    refresh_enabled: newRefreshEnabled,
    auto_interval_hours: newAutoInterval,
    last_test_at: needTest ? now : current.last_test_at,
    last_test_ok: needTest ? true : current.last_test_ok,
    last_error: needTest ? "" : current.last_error,
    updated_at: now,
  };
  await writeStoredConnections(env.DB, stored);

  const resultConnections: MisubConnection[] = stored.connections.map((c) => (projectConnection(c, c.id === stored.active_id)));
  return { connection: resultConnections.find((c) => c.id === id)!, connections: resultConnections, active_id: stored.active_id };
}

// 测试连接（支持已存连接或临时参数）
export async function testMisubConnectionById(env: Env, id: string): Promise<MisubConnection> {
  await migrateLegacyIfNeeded(env.DB);
  const stored = await readStoredConnections(env.DB);
  if (!stored) throw new MisubError(404, "MiSub 连接不存在");
  const index = stored.connections.findIndex((c) => c.id === id);
  if (index < 0) throw new MisubError(404, "MiSub 连接不存在");
  const conn = stored.connections[index];

  const token = await openToken(env, conn);
  try {
    await testMisubConnection(conn.base_url, token);
    const now = Date.now();
    stored.connections[index] = {
      ...conn,
      last_test_at: now,
      last_test_ok: true,
      last_error: "",
      updated_at: now,
    };
    await writeStoredConnections(env.DB, stored);
    return projectConnection(stored.connections[index], stored.connections[index].id === stored.active_id);
  } catch (error) {
    const now = Date.now();
    const message = error instanceof MisubError ? error.message : "连接测试失败";
    stored.connections[index] = {
      ...conn,
      last_test_at: now,
      last_test_ok: false,
      last_error: message,
      updated_at: now,
    };
    await writeStoredConnections(env.DB, stored);
    throw error;
  }
}

// 测试临时参数（复用现有 resolveMisubTestToken 口径）
export async function testMisubConnectionTemp(env: Env, baseUrl: string, submittedToken: string): Promise<void> {
  const token = await resolveMisubTestToken(env, submittedToken);
  await testMisubConnection(baseUrl, token);
}

// 设为当前连接
export async function activateMisubConnection(
  env: Env,
  id: string,
): Promise<{ connections: MisubConnection[]; active_id: string }> {
  await migrateLegacyIfNeeded(env.DB);
  const stored = await readStoredConnections(env.DB);
  if (!stored) throw new MisubError(404, "MiSub 连接不存在");
  if (!stored.connections.some((c) => c.id === id)) throw new MisubError(404, "MiSub 连接不存在");
  stored.active_id = id;
  await writeStoredConnections(env.DB, stored);

  const connections: MisubConnection[] = stored.connections.map((c) => (projectConnection(c, c.id === id)));
  return { connections, active_id: id };
}

// 删除连接
export async function deleteMisubConnection(
  env: Env,
  id: string,
): Promise<{ connections: MisubConnection[]; active_id: string }> {
  await migrateLegacyIfNeeded(env.DB);
  const stored = await readStoredConnections(env.DB);
  if (!stored) throw new MisubError(404, "MiSub 连接不存在");
  const index = stored.connections.findIndex((c) => c.id === id);
  if (index < 0) throw new MisubError(404, "MiSub 连接不存在");
  const wasActive = stored.active_id === id;
  stored.connections.splice(index, 1);
  if (wasActive) {
    if (stored.connections.length > 0) {
      // 选 updated_at 最新的作为当前
      let latest = stored.connections[0];
      for (const c of stored.connections) {
        if (c.updated_at > latest.updated_at) latest = c;
      }
      stored.active_id = latest.id;
    } else {
      stored.active_id = "";
    }
  }
  await writeStoredConnections(env.DB, stored);

  const connections: MisubConnection[] = stored.connections.map((c) => (projectConnection(c, c.id === stored.active_id)));
  return { connections, active_id: stored.active_id };
}

// ---------------------------------------------------------------------------
// 令牌解密

async function openToken(env: Env, stored: StoredConnection): Promise<string> {
  const key = vaultKeyOf(env);
  if (key.state === "invalid") throw new MisubError(503, VAULT_INVALID_OPEN_MESSAGE);
  if (key.state !== "on") throw new MisubError(503, VAULT_OFF_OPEN_MESSAGE);
  const plain = await decryptString(key.raw, stored.token_enc);
  if (plain === null) throw new MisubError(500, "MiSub 令牌解密失败，保险库密钥可能不正确");
  return plain;
}

// ---------------------------------------------------------------------------
// 地址规范化

export function normalizeMisubBaseUrl(value: unknown): string {
  if (typeof value !== "string") throw new MisubError(400, "请填写 MiSub 地址");
  const text = value.trim();
  if (!text) throw new MisubError(400, "请填写 MiSub 地址");
  if (text.length > BASE_URL_MAX) throw new MisubError(400, "MiSub 地址过长");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new MisubError(400, "MiSub 地址格式不正确");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MisubError(400, "MiSub 地址需要以 http:// 或 https:// 开头");
  }
  if (url.username || url.password) throw new MisubError(400, "MiSub 地址不能带账号密码");
  if (url.search || url.hash) throw new MisubError(400, "MiSub 地址不能带参数或锚点");
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(/\/api\/ext\/v1$/i, "");
  path = path.replace(/\/+$/, "");
  return url.origin + (path === "" || path === "/" ? "" : path);
}

// ---------------------------------------------------------------------------
// MiSub 调用：8 秒超时与错误归一。文案直接给面板条幅用。

interface MisubMeta {
  total?: unknown;
  page?: unknown;
  pageSize?: unknown;
}

interface MisubEnvelope {
  success?: unknown;
  data?: unknown;
  meta?: MisubMeta | null;
  error?: { code?: unknown; message?: unknown } | null;
}

const TIMEOUT_MESSAGE = "连接 MiSub 超时，请检查地址与网络";
const UNREACHABLE_MESSAGE = "连不上 MiSub，请检查地址是否正确";

async function misubFetch(
  baseUrl: string,
  token: string,
  path: string,
  method: "GET" | "POST",
): Promise<{ data: unknown; meta: MisubMeta | null }> {
  let response: Response;
  try {
    response = await fetch(baseUrl + "/api/ext/v1" + path, {
      method,
      headers: { authorization: "Bearer " + token, accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new MisubError(504, TIMEOUT_MESSAGE);
    }
    throw new MisubError(502, UNREACHABLE_MESSAGE);
  }
  if (response.status === 401) {
    throw new MisubError(401, "MiSub 令牌无效，请在服务商设置里更新令牌");
  }
  if (response.status === 403) {
    throw new MisubError(403, "MiSub 未启用 External Management API 或令牌无权限，请在 MiSub 系统设置里开启");
  }
  if (response.status === 404) {
    throw new MisubError(404, "MiSub 版本太旧或地址不对：这个地址没有 External Management API");
  }
  let envelope: MisubEnvelope | null = null;
  try {
    envelope = (await response.json()) as MisubEnvelope;
  } catch {
    envelope = null;
  }
  if (!response.ok || !envelope || envelope.success === false) {
    throw new MisubError(502, UNREACHABLE_MESSAGE);
  }
  return { data: envelope.data, meta: envelope.meta ?? null };
}

// 三个列表接口都分页（pageSize 上限 200）：按 meta.total 翻完，最多 5 页，
// 超出就只展示已取到的部分，不无限翻。
// 分页按 id 去重（MiSub 若重复返回同一页不能把条目翻倍）；无 id 的行不强行去重。
async function misubList(baseUrl: string, token: string, path: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const seenIds = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const { data, meta } = await misubFetch(
      baseUrl,
      token,
      `${path}${separator}page=${page}&pageSize=${PAGE_SIZE}`,
      "GET",
    );
    const batch = Array.isArray(data)
      ? (data.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as Record<string, unknown>[])
      : [];
    for (const item of batch) {
      const id = typeof item["id"] === "string" ? item["id"] : "";
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      rows.push(item);
    }
    const total = typeof meta?.total === "number" && Number.isFinite(meta.total) ? meta.total : null;
    if (batch.length < PAGE_SIZE) break;
    if (total !== null && rows.length >= total) break;
  }
  return rows;
}

// 测试连接：只读一次订阅源列表的第一页第一行，通了就算连接可用。
export async function testMisubConnection(baseUrl: string, token: string): Promise<void> {
  await misubFetch(baseUrl, token, "/subscriptions?page=1&pageSize=1", "GET");
}

// 测试接口的令牌来源：提交了就用手填的；留空且已有配置时沿用已存令牌。
// 按用户裁定，VAULT_KEY 不可用时保存与测试都直接报同一句文案。
export async function resolveMisubTestToken(env: Env, submittedToken: string): Promise<string> {
  const key = vaultKeyOf(env);
  if (key.state === "invalid") throw new MisubError(503, VAULT_INVALID_SAVE_MESSAGE);
  if (key.state !== "on") throw new MisubError(503, VAULT_OFF_SAVE_MESSAGE);
  if (submittedToken.length > TOKEN_MAX) throw new MisubError(400, "MiSub 令牌过长");
  if (submittedToken) return submittedToken;
  const existing = await readStoredConnections(env.DB);
  if (!existing || existing.connections.length === 0) throw new MisubError(400, "请填写 MiSub 令牌");
  const active = existing.connections.find((c) => c.id === existing.active_id) ?? existing.connections[0];
  return openToken(env, active);
}

// ---------------------------------------------------------------------------
// 脱敏与服务器提取（纯函数，便于单测）。原始节点链接、订阅源地址都不出
// 这个模块：列表只回脱敏后的服务器文本，明文只走 reveal 一条路。

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

// 只接受正数（秒级 epoch）；0、null、负数都表示「没有到期时间」。
function asPositiveSeconds(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

// MiSub 的 lastUpdate 实测有两种形态：毫秒 epoch 数字与 ISO 时间字符串
// （真实实例返回 "2026-11-10T17:45:12.909Z"）。数字按 epoch 用，字符串走
// Date.parse，都归一成毫秒 epoch。
function asEpochMs(value: unknown): number | null {
  if (typeof value === "string" && value.trim() !== "" && Number.isNaN(Number(value))) {
    const parsedDate = Date.parse(value);
    return Number.isFinite(parsedDate) && parsedDate > 0 ? parsedDate : null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

// 从节点链接取 host:port。vmess 的链接是 vmess:// 后跟整段 base64 JSON，
// URL 解析会把载荷本身当主机名，所以先按 vmess 处理：base64（兼容
// url-safe 与填充）解码 JSON，取 add 与 port；解不出返回空。其余协议
// 直接 URL 解析取 hostname+port，无 port 时 server 只给 host。
export function nodeServerOf(rawUrl: string): { host: string; port: number | null; server: string } {
  const text = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!text) return { host: "", port: null, server: "" };
  if (/^vmess:\/\//i.test(text)) {
    try {
      const payload = text.slice(text.indexOf("://") + 3).split(/[?#]/)[0] ?? "";
      const normalized = payload.trim().replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/g, "");
      const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
      const parsed = JSON.parse(atob(padded)) as Record<string, unknown>;
      const host = asText(parsed["add"]).trim();
      const port = Number(parsed["port"]);
      const portValue = Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
      if (host) {
        const server = host.includes(":") ? `[${host}]${portValue ? ":" + portValue : ""}` : host + (portValue ? ":" + portValue : "");
        return { host, port: portValue, server };
      }
    } catch {
      // 载荷坏了就当没有服务器信息，页面显示「—」。
    }
    return { host: "", port: null, server: "" };
  }
  try {
    const url = new URL(text);
    const host = url.hostname;
    if (!host) return { host: "", port: null, server: "" };
    const port = url.port ? Number(url.port) : null;
    const portValue = port !== null && Number.isInteger(port) && port > 0 ? port : null;
    const server = host.includes(":") ? `[${host}]${portValue ? ":" + portValue : ""}` : host + (portValue ? ":" + portValue : "");
    return { host, port: portValue, server };
  } catch {
    return { host: "", port: null, server: "" };
  }
}

// ---------------------------------------------------------------------------
// 快照：三路列表各取一次，原样带明文地址与链接（落库时整体密封）。

export interface MisubSubscription {
  id: string;
  name: string;
  enabled: boolean;
  group: string;
  tags: string[];
  url: string;
  node_count: number;
  upload: number;
  download: number;
  total: number;
  expire: number | null;
  last_update: number | null;
  last_error: string;
}

export interface MisubManualNode {
  id: string;
  name: string;
  protocol: string;
  enabled: boolean;
  group: string;
  tags: string[];
  remarks: string;
  region: string;
  server: string;
  url: string;
}

export interface MisubProfile {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  total_nodes: number;
  subscription_count: number;
  manual_count: number;
}

export interface MisubOverview {
  subscriptions: number;
  manual_nodes: number;
  profiles: number;
  total_nodes: number;
  traffic_used: number;
  traffic_total: number;
  nearest_expire: number | null;
}

export interface MisubSnapshot {
  config: MisubConfig;
  fetched_at: number;
  overview: MisubOverview;
  subscriptions: MisubSubscription[];
  manual_nodes: MisubManualNode[];
  profiles: MisubProfile[];
}

function asTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((t): t is string => typeof t === "string" && t.trim() !== "").map((t) => t.trim()).slice(0, 20);
}

function normalizeSubscription(row: Record<string, unknown>): MisubSubscription {
  const info = row["userInfo"];
  const userInfo = info && typeof info === "object" && !Array.isArray(info) ? (info as Record<string, unknown>) : null;
  return {
    id: asText(row["id"]),
    name: asText(row["name"]),
    enabled: row["enabled"] !== false,
    group: asText(row["group"]),
    tags: asTags(row["tags"]),
    url: asText(row["url"]).trim(),
    node_count: asCount(row["nodeCount"]),
    upload: userInfo ? asCount(userInfo["upload"]) : 0,
    download: userInfo ? asCount(userInfo["download"]) : 0,
    total: userInfo ? asCount(userInfo["total"]) : 0,
    expire: userInfo ? asPositiveSeconds(userInfo["expire"]) : null,
    last_update: asEpochMs(row["lastUpdate"]),
    last_error: asText(row["lastError"]),
  };
}

function normalizeManualNode(row: Record<string, unknown>): MisubManualNode {
  const rawUrl = asText(row["url"]);
  const server = nodeServerOf(rawUrl);
  const derived = rawUrl.includes("://") ? rawUrl.slice(0, rawUrl.indexOf("://")).toLowerCase() : "";
  return {
    id: asText(row["id"]),
    name: asText(row["name"]),
    protocol: asText(row["protocol"]) || derived,
    enabled: row["enabled"] !== false,
    group: asText(row["group"]),
    tags: asTags(row["tags"]),
    remarks: asText(row["remarks"]),
    region: detectRegion(asText(row["name"]) + " " + asText(row["group"])),
    server: server.server,
    url: rawUrl.trim(),
  };
}

export async function fetchMisubLists(conn: MisubConnectionHandle): Promise<MisubSnapshot> {
  const [subRows, nodeRows, profileRows] = await Promise.all([
    misubList(conn.base_url, conn.token, "/subscriptions"),
    misubList(conn.base_url, conn.token, "/manual-nodes"),
    misubList(conn.base_url, conn.token, "/profiles"),
  ]);
  const subscriptions = subRows.map(normalizeSubscription);
  const manualNodes = nodeRows.map(normalizeManualNode);
  const subCounts = new Map(subscriptions.map((sub) => [sub.id, sub.node_count]));
  const profiles = profileRows.map((row) => profileNodes(row, subCounts));

  let totalNodes = manualNodes.length;
  let trafficUsed = 0;
  let trafficTotal = 0;
  let nearestExpire: number | null = null;
  const nowSec = Math.floor(Date.now() / 1000);
  for (const sub of subscriptions) {
    totalNodes += sub.node_count;
    trafficUsed += sub.upload + sub.download;
    trafficTotal += sub.total;
    if (sub.expire !== null && sub.expire > nowSec && (nearestExpire === null || sub.expire < nearestExpire)) {
      nearestExpire = sub.expire;
    }
  }
  return {
      config: { base_url: conn.base_url, token_tail: "", refresh_enabled: conn.refresh_enabled },
      fetched_at: Date.now(),
      overview: {
        subscriptions: subscriptions.length,
        manual_nodes: manualNodes.length,
        profiles: profiles.length,
        total_nodes: totalNodes,
        traffic_used: trafficUsed,
        traffic_total: trafficTotal,
        nearest_expire: nearestExpire,
      },
      subscriptions,
      manual_nodes: manualNodes,
      profiles,
  };
}

// 订阅组节点数 = 所引订阅源 nodeCount 之和 + 手工节点数。
function profileNodes(row: Record<string, unknown>, subCounts: Map<string, number>): MisubProfile {
  const subIds = Array.isArray(row["subscriptionIds"]) ? (row["subscriptionIds"] as unknown[]) : [];
  const manualIds = Array.isArray(row["manualNodeIds"]) ? (row["manualNodeIds"] as unknown[]) : [];
  let total = manualIds.length;
  for (const id of subIds) {
    if (typeof id !== "string") continue;
    total += subCounts.get(id) ?? 0;
  }
  return {
    id: asText(row["id"]),
    name: asText(row["name"]),
    description: asText(row["description"]),
    enabled: row["enabled"] !== false,
    total_nodes: total,
    subscription_count: subIds.length,
    manual_count: manualIds.length,
  };
}

// 让 MiSub 刷新订阅组（有副作用，需打开「允许触发刷新」）。
export async function refreshMisubProfile(
  env: Env,
  id: string,
): Promise<{ name: string; total_nodes: number }> {
  const { connection, token } = await requireConnection(env);
  if (!connection.refresh_enabled) throw new MisubError(403, "触发刷新未开启，请先在服务商设置里打开");
  const { data } = await misubFetch(
    connection.base_url,
    token,
    "/profiles/" + encodeURIComponent(id) + "/refresh",
    "POST",
  );
  const preview = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const previewName = asText(preview["name"]);
  const previewTotal =
    typeof preview["totalNodes"] === "number" && Number.isFinite(preview["totalNodes"]) && preview["totalNodes"] >= 0
      ? Math.floor(preview["totalNodes"] as number)
      : null;
  const summary = preview["summary"] && typeof preview["summary"] === "object" ? (preview["summary"] as Record<string, unknown>) : {};
  const profileObj = preview["profile"] && typeof preview["profile"] === "object" ? (preview["profile"] as Record<string, unknown>) : {};
  const summaryTotal = asCount(summary["totalNodes"]);
  return { name: previewName || asText(profileObj["name"]), total_nodes: previewTotal ?? summaryTotal };
}
// 让 MiSub 刷新单个订阅源，开关同上。
export async function refreshMisubSubscription(
  env: Env,
  id: string,
): Promise<{ name: string; node_count: number; last_error: string }> {
  const { connection, token } = await requireConnection(env);
  if (!connection.refresh_enabled) throw new MisubError(403, "触发刷新未开启，请先在服务商设置里打开");
  const { data } = await misubFetch(
    connection.base_url,
    token,
    "/subscriptions/" + encodeURIComponent(id) + "/refresh",
    "POST",
  );
  const row = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const inner = row["subscription"] && typeof row["subscription"] === "object" ? (row["subscription"] as Record<string, unknown>) : row;
  return {
    name: asText(inner["name"]),
    node_count: asCount(inner["nodeCount"]),
    last_error: asText(inner["lastError"]),
  };
}
