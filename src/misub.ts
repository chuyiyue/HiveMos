// MiSub 瘦客户端：云计算资源「代理」页的数据全部来自管理员自己的 MiSub
// 实例（External Management API，/api/ext/v1，Bearer Token）。
//
// 红线（用户已拍板）：
//   · 抓到的数据一律不落库、不同步、无定时任务、不做节点测活、不解析协议
//     （唯一例外是从节点链接里提取 vmess 的服务器地址）。
//   · schema_meta 只存一行 misub_config：地址明文、Token 用 VAULT_KEY
//     信封密封（与保险库同一套 enc1: AES-GCM）、末 4 位、刷新开关。
//   · 出站只发生在管理员手动请求时：保存/测试一次、打开页面读一次、
//     点「显示」取一次、开关打开时手动触发订阅组 refresh。
//
// 内存缓存只是 45 秒防抖缓冲，Workers 的隔离环境随时可能丢弃它。

import type { D1Database, Env } from "./env";
import { decryptString, resolveContentKey, sealString, type ContentKey } from "./crypto";

export class MisubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const CONFIG_KEY = "misub_config";
const FETCH_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 45 * 1000;
const PAGE_SIZE = 200;
const MAX_PAGES = 5;
const BASE_URL_MAX = 300;
const TOKEN_MAX = 4096;

// ---------------------------------------------------------------------------
// 配置读写与密封

export interface MisubConfig {
  base_url: string;
  token_tail: string;
  refresh_enabled: boolean;
}

interface StoredConfig extends MisubConfig {
  token_enc: string;
}

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

async function readStoredConfig(db: D1Database): Promise<StoredConfig | null> {
  try {
    const row = await db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .bind(CONFIG_KEY)
      .first<{ value: string }>();
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as Partial<StoredConfig>;
    if (typeof parsed.base_url !== "string" || !parsed.base_url) return null;
    if (typeof parsed.token_enc !== "string" || !parsed.token_enc) return null;
    return {
      base_url: parsed.base_url,
      token_enc: parsed.token_enc,
      token_tail: typeof parsed.token_tail === "string" ? parsed.token_tail : "",
      refresh_enabled: parsed.refresh_enabled === true,
    };
  } catch {
    // schema_meta 还没建（迁移未应用）或 JSON 坏了，都按未配置处理。
    return null;
  }
}

async function writeStoredConfig(db: D1Database, config: StoredConfig): Promise<void> {
  await db
    .prepare(
      "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(CONFIG_KEY, JSON.stringify(config))
    .run();
}

export async function readMisubConfig(db: D1Database): Promise<MisubConfig | null> {
  const stored = await readStoredConfig(db);
  if (!stored) return null;
  return {
    base_url: stored.base_url,
    token_tail: stored.token_tail,
    refresh_enabled: stored.refresh_enabled,
  };
}

async function openToken(env: Env, stored: StoredConfig): Promise<string> {
  const key = vaultKeyOf(env);
  if (key.state === "invalid") throw new MisubError(503, VAULT_INVALID_OPEN_MESSAGE);
  if (key.state !== "on") throw new MisubError(503, VAULT_OFF_OPEN_MESSAGE);
  const plain = await decryptString(key.raw, stored.token_enc);
  if (plain === null) throw new MisubError(500, "MiSub 令牌解密失败，保险库密钥可能不正确");
  return plain;
}

export async function clearMisubConfig(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM schema_meta WHERE key = ?").bind(CONFIG_KEY).run();
  cache = null;
}

// 地址规范化：只接受 http/https，去掉结尾斜杠，并剥掉用户误粘的
// /api/ext/v1 后缀。非法输入一律给明确中文错误，不做静默兜底。
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
    throw new MisubError(401, "MiSub 令牌无效，请在设置里更新令牌");
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
async function misubList(baseUrl: string, token: string, path: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
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
    rows.push(...batch);
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
  const existing = await readStoredConfig(env.DB);
  if (!existing) throw new MisubError(400, "请填写 MiSub 令牌");
  return openToken(env, existing);
}

// ---------------------------------------------------------------------------
// 保存与开关

// 保存配置：先测连接，通了才密封落库（用户口径：保存时测一次，之后不做
// 任何后台轮询）。token 留空且已有配置时沿用旧令牌，测通后原样保留密文。
export async function saveMisubConfig(
  env: Env,
  input: { base_url: unknown; token?: unknown; refresh_enabled?: unknown },
): Promise<MisubConfig> {
  const baseUrl = normalizeMisubBaseUrl(input.base_url);
  if (input.refresh_enabled !== undefined && typeof input.refresh_enabled !== "boolean") {
    throw new MisubError(400, "刷新开关格式不正确");
  }
  const key = vaultKeyOf(env);
  if (key.state === "invalid") throw new MisubError(503, VAULT_INVALID_SAVE_MESSAGE);
  if (key.state !== "on") throw new MisubError(503, VAULT_OFF_SAVE_MESSAGE);
  const submittedToken = typeof input.token === "string" ? input.token.trim() : "";
  if (submittedToken.length > TOKEN_MAX) throw new MisubError(400, "MiSub 令牌过长");

  const existing = await readStoredConfig(env.DB);
  let tokenEnc: string;
  let tokenPlain: string;
  let tokenTail: string;
  if (submittedToken) {
    const sealed = await sealString(key, submittedToken);
    if (sealed === null) throw new MisubError(503, VAULT_OFF_SAVE_MESSAGE);
    tokenEnc = sealed;
    tokenPlain = submittedToken;
    tokenTail = submittedToken.slice(-4);
  } else if (existing) {
    tokenEnc = existing.token_enc;
    tokenPlain = await openToken(env, existing);
    tokenTail = existing.token_tail || tokenPlain.slice(-4);
  } else {
    throw new MisubError(400, "请填写 MiSub 令牌");
  }

  // 先测一次再落库：连不通就什么都不写，库里不会出现坏配置。
  await testMisubConnection(baseUrl, tokenPlain);

  const stored: StoredConfig = {
    base_url: baseUrl,
    token_enc: tokenEnc,
    token_tail: tokenTail,
    refresh_enabled:
      input.refresh_enabled !== undefined ? input.refresh_enabled : (existing?.refresh_enabled ?? false),
  };
  await writeStoredConfig(env.DB, stored);
  cache = null;
  return { base_url: stored.base_url, token_tail: stored.token_tail, refresh_enabled: stored.refresh_enabled };
}

// 已配置后只改刷新开关：不重测连接、不碰令牌。
export async function setMisubRefreshEnabled(env: Env, enabled: boolean): Promise<MisubConfig> {
  const existing = await readStoredConfig(env.DB);
  if (!existing) throw new MisubError(400, "尚未连接 MiSub");
  const stored: StoredConfig = { ...existing, refresh_enabled: enabled };
  await writeStoredConfig(env.DB, stored);
  if (cache && cache.base_url === stored.base_url) cache.snapshot.config.refresh_enabled = enabled;
  return { base_url: stored.base_url, token_tail: stored.token_tail, refresh_enabled: stored.refresh_enabled };
}

async function requireConnection(env: Env): Promise<{ config: StoredConfig; token: string }> {
  const config = await readStoredConfig(env.DB);
  if (!config) throw new MisubError(400, "尚未连接 MiSub");
  return { config, token: await openToken(env, config) };
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

// MiSub 的 lastUpdate 是毫秒 epoch；只做数值校验，不做时区/单位猜测。
function asEpochMs(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

// 域名：首段前 2 个字符 + *** + 其余段（hk-node1.example.com → hk***.example.com）；
// IPv4：只保留第一段；单段短名：前 2 个字符 + ***。
export function maskHost(host: string): string {
  const text = (typeof host === "string" ? host : "").trim();
  if (!text) return "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    return text.split(".")[0] + ".***.***.***";
  }
  const dot = text.indexOf(".");
  if (dot > 0) {
    return text.slice(0, dot).slice(0, 2) + "***" + text.slice(dot);
  }
  return text.slice(0, 2) + "***";
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
      if (host) return { host, port: portValue, server: host + (portValue ? ":" + portValue : "") };
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
    return { host, port: portValue, server: host + (portValue ? ":" + portValue : "") };
  } catch {
    return { host: "", port: null, server: "" };
  }
}

export function maskServer(host: string, port: number | null): string {
  const masked = maskHost(host);
  if (!masked) return "";
  return masked + (port ? ":" + port : "");
}

// ---------------------------------------------------------------------------
// 快照组装：三路列表各取一次，字段严格按用户裁定的口径，不向面板下发
// url（订阅源地址与节点链接）。

export interface MisubSubscription {
  id: string;
  name: string;
  enabled: boolean;
  group: string;
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
  remarks: string;
  server_masked: string;
  has_server: boolean;
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

function normalizeSubscription(row: Record<string, unknown>): MisubSubscription {
  const info = row["userInfo"];
  const userInfo = info && typeof info === "object" && !Array.isArray(info) ? (info as Record<string, unknown>) : null;
  return {
    id: asText(row["id"]),
    name: asText(row["name"]),
    enabled: row["enabled"] !== false,
    group: asText(row["group"]),
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
    remarks: asText(row["remarks"]),
    server_masked: maskServer(server.host, server.port),
    has_server: server.host !== "",
  };
}

interface CacheEntry {
  at: number;
  base_url: string;
  snapshot: MisubSnapshot;
}

let cache: CacheEntry | null = null;

export function clearMisubCache(): void {
  cache = null;
}

// 订阅组的节点数在本地算：所引订阅源 nodeCount 之和 + manualNodeIds 个数，
// 与 MiSub 的存储计数口径一致，不逐组再调 preview。
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

export async function getMisubSnapshot(env: Env, fresh: boolean): Promise<MisubSnapshot> {
  const { config, token } = await requireConnection(env);
  if (!fresh && cache && cache.base_url === config.base_url && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.snapshot;
  }
  const [subRows, nodeRows, profileRows] = await Promise.all([
    misubList(config.base_url, token, "/subscriptions"),
    misubList(config.base_url, token, "/manual-nodes"),
    misubList(config.base_url, token, "/profiles"),
  ]);
  const subscriptions = subRows.map(normalizeSubscription);
  const manualNodes = nodeRows.map(normalizeManualNode);
  const subCounts = new Map(subscriptions.map((sub) => [sub.id, sub.node_count]));
  const profiles = profileRows.map((row) => profileNodes(row, subCounts));

  let totalNodes = manualNodes.length;
  let trafficUsed = 0;
  let trafficTotal = 0;
  let nearestExpire: number | null = null;
  for (const sub of subscriptions) {
    totalNodes += sub.node_count;
    trafficUsed += sub.upload + sub.download;
    trafficTotal += sub.total;
    if (sub.expire !== null && (nearestExpire === null || sub.expire < nearestExpire)) {
      nearestExpire = sub.expire;
    }
  }

  const snapshot: MisubSnapshot = {
    config: {
      base_url: config.base_url,
      token_tail: config.token_tail,
      refresh_enabled: config.refresh_enabled,
    },
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
  cache = { at: snapshot.fetched_at, base_url: config.base_url, snapshot };
  return snapshot;
}

// 显示明文：只取管理员点开的这一个节点，回服务器 host:port 与完整链接。
// 调用方（misub-http）负责先写 oplog 再调用，与其它 reveal 的口径一致。
export async function revealMisubManualNode(
  env: Env,
  id: string,
): Promise<{ server: string; url: string }> {
  const { config, token } = await requireConnection(env);
  const { data } = await misubFetch(config.base_url, token, "/manual-nodes/" + encodeURIComponent(id), "GET");
  const row = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const rawUrl = asText(row["url"]);
  if (!rawUrl) throw new MisubError(404, "节点不存在");
  return { server: nodeServerOf(rawUrl).server, url: rawUrl };
}

// 触发订阅组 refresh：MiSub 会真去拉上游并回写计数，有副作用，只在设置
// 开关打开时放行（HTTP 层也会先查开关，这里再兜一层）。成功后清缓存；
// total_nodes 取 preview.totalNodes，取不到就回退本地聚合。
export async function refreshMisubProfile(
  env: Env,
  id: string,
): Promise<{ name: string; total_nodes: number }> {
  const { config, token } = await requireConnection(env);
  if (!config.refresh_enabled) throw new MisubError(403, "触发刷新未开启，请先在设置里打开");
  const { data } = await misubFetch(
    config.base_url,
    token,
    "/profiles/" + encodeURIComponent(id) + "/refresh",
    "POST",
  );
  cache = null;
  const preview = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const previewName = asText(preview["name"]);
  const previewTotal =
    typeof preview["totalNodes"] === "number" && Number.isFinite(preview["totalNodes"]) && preview["totalNodes"] >= 0
      ? Math.floor(preview["totalNodes"] as number)
      : null;
  if (previewTotal !== null) return { name: previewName, total_nodes: previewTotal };
  const snapshot = await getMisubSnapshot(env, false);
  const profile = snapshot.profiles.find((entry) => entry.id === id);
  return { name: previewName || (profile?.name ?? ""), total_nodes: profile?.total_nodes ?? 0 };
}
