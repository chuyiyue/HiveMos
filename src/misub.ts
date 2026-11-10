// MiSub 瘦客户端：云计算资源「代理」页的数据全部来自 Roye 自己的 MiSub
// 实例（External Management API，/api/ext/v1，Bearer Token）。
//
// 为什么是瘦客户端：HiveMos 原生代理模块（订阅拉取 + 协议解析 + 探活）
// 已证实会被 Cloudflare 以 Network abuse 秒杀部署，所以这里明确不做
// 定时同步、节点测活、协议解析、数据落库。出站请求只有管理员在面板
// 手动触发的这几种：保存配置时测一次连接、打开/刷新页面时读一次、
// 点「显示」时取一次明文、开关打开时手动触发订阅组 refresh。
//
// 配置存 schema_meta 的 misub_config 一行（JSON）：地址明文、Token 用
// VAULT_KEY 信封密封（与保险库同一套 enc1: AES-GCM），界面只回末 4 位。
// 列表数据不落库：模块级内存缓存 45 秒只当防抖，隔离环境丢了就重取。

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

// ---------------------------------------------------------------------------
// 配置：读写、密封、校验

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

export function misubVaultKeyState(env: Env): "on" | "off" | "invalid" {
  return vaultKeyOf(env).state;
}

async function readStoredConfig(db: D1Database): Promise<StoredConfig | null> {
  try {
    const row = await db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .bind(CONFIG_KEY)
      .first<{ value: string }>();
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as Partial<StoredConfig>;
    if (typeof parsed.base_url !== "string" || typeof parsed.token_enc !== "string") return null;
    return {
      base_url: parsed.base_url,
      token_enc: parsed.token_enc,
      token_tail: typeof parsed.token_tail === "string" ? parsed.token_tail : "",
      refresh_enabled: parsed.refresh_enabled === true,
    };
  } catch {
    // schema_meta 还没建（迁移未应用）时按未配置处理，页面给出未配置态。
    return null;
  }
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
  if (key.state === "invalid") throw new MisubError(503, "保险库密钥配置不正确，无法读取 MiSub 令牌");
  if (key.state !== "on") throw new MisubError(503, "保险库密钥未配置，无法读取 MiSub 令牌");
  const plain = await decryptString(key.raw, stored.token_enc);
  if (plain === null) throw new MisubError(500, "MiSub 令牌解密失败，保险库密钥可能不正确");
  return plain;
}

async function writeStoredConfig(db: D1Database, config: StoredConfig): Promise<void> {
  await db
    .prepare(
      "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(CONFIG_KEY, JSON.stringify(config))
    .run();
}

export async function clearMisubConfig(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM schema_meta WHERE key = ?").bind(CONFIG_KEY).run();
  cache = null;
}

// 地址只接受 http/https，存的时候去掉末尾斜杠和用户误粘的 /api/ext/v1。
export function normalizeMisubBaseUrl(value: unknown): string {
  if (typeof value !== "string") throw new MisubError(400, "请填写 MiSub 地址");
  let text = value.trim();
  if (!text) throw new MisubError(400, "请填写 MiSub 地址");
  if (text.length > 300) throw new MisubError(400, "MiSub 地址过长");
  text = text.replace(/\/+$/, "").replace(/\/api\/ext\/v1$/i, "");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new MisubError(400, "MiSub 地址格式不正确");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new MisubError(400, "MiSub 地址需要以 https:// 或 http:// 开头");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new MisubError(400, "MiSub 地址不能带账号、参数或锚点");
  }
  return url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, ""));
}

// ---------------------------------------------------------------------------
// MiSub 调用：超时、错误归一。错误文案给面板条幅直接用：
// 401 令牌无效 / 403 未启用 External API / 404 接口不存在（版本太旧）/
// 超时 / 连不上 / 其它状态码与业务错误码原样归类。

interface MisubEnvelope {
  success?: unknown;
  data?: unknown;
  meta?: { total?: unknown };
  error?: { code?: unknown; message?: unknown };
}

async function misubFetch(
  baseUrl: string,
  token: string,
  path: string,
  method: "GET" | "POST",
): Promise<{ data: unknown; meta: { total?: unknown } | undefined }> {
  let response: Response;
  try {
    response = await fetch(baseUrl + "/api/ext/v1" + path, {
      method,
      headers: { authorization: "Bearer " + token, accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new MisubError(504, "连接 MiSub 超时，请稍后重试");
    }
    throw new MisubError(502, "连不上 MiSub，请检查地址是否正确");
  }
  let envelope: MisubEnvelope = {};
  try {
    envelope = (await response.json()) as MisubEnvelope;
  } catch {
    envelope = {};
  }
  if (response.status === 401) throw new MisubError(401, "MiSub 令牌无效，请在设置里更新令牌");
  if (response.status === 403) throw new MisubError(403, "MiSub 尚未启用 External Management API");
  if (response.status === 404) {
    throw new MisubError(404, "MiSub 没有这个接口，可能版本太旧、不支持 External Management API");
  }
  if (!response.ok || envelope.success === false) {
    const message =
      typeof envelope.error?.message === "string" && envelope.error.message ? envelope.error.message : "";
    throw new MisubError(502, message ? `MiSub 返回错误：${message}` : `MiSub 返回了 ${response.status} 状态`);
  }
  return { data: envelope.data, meta: envelope.meta };
}

// 列表接口带分页（pageSize 上限 200）：按 meta.total 翻完，上限 5 页，
// 超出就只展示已取到的部分，不无限翻。
async function misubList(baseUrl: string, token: string, path: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const { data, meta } = await misubFetch(baseUrl, token, `${path}${sep}page=${page}&pageSize=${PAGE_SIZE}`, "GET");
    const batch = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    rows.push(...batch);
    const total = typeof meta?.total === "number" ? meta.total : null;
    if (batch.length < PAGE_SIZE) break;
    if (total !== null && rows.length >= total) break;
  }
  return rows;
}

// 测试连接：只读一次订阅源列表的第一页，通了就算连接可用。
export async function testMisubConnection(baseUrl: string, token: string): Promise<{ subscriptions: number }> {
  const { data, meta } = await misubFetch(baseUrl, token, "/subscriptions?page=1&pageSize=1", "GET");
  const total = typeof meta?.total === "number" ? meta.total : Array.isArray(data) ? data.length : 0;
  return { subscriptions: total };
}

// 保存配置：先用将要保存的地址+令牌测一次，通了才密封落库（Roye 的
// 规矩：保存时测一次，不做保存后自动轮询）。token 留空且已有配置时
// 沿用旧令牌——解密出来测，测通后原样保留密文。
export async function saveMisubConfig(
  env: Env,
  input: { base_url: unknown; token?: unknown; refresh_enabled?: unknown },
): Promise<MisubConfig> {
  const baseUrl = normalizeMisubBaseUrl(input.base_url);
  if (input.refresh_enabled !== undefined && typeof input.refresh_enabled !== "boolean") {
    throw new MisubError(400, "刷新开关格式不正确");
  }
  const existing = await readStoredConfig(env.DB);
  const submittedToken = typeof input.token === "string" ? input.token.trim() : "";
  if (submittedToken.length > 4096) throw new MisubError(400, "MiSub 令牌过长");

  let tokenEnc: string;
  let tokenPlain: string;
  let tokenTail: string;
  if (submittedToken) {
    const key = vaultKeyOf(env);
    if (key.state === "invalid") throw new MisubError(503, "保险库密钥配置不正确，暂时不能保存令牌");
    if (key.state !== "on") throw new MisubError(503, "保险库密钥未配置，暂时不能保存令牌");
    const sealed = await sealString(key, submittedToken);
    if (sealed === null) throw new MisubError(503, "保险库密钥未配置，暂时不能保存令牌");
    tokenEnc = sealed;
    tokenPlain = submittedToken;
    tokenTail = submittedToken.slice(-4);
  } else if (existing) {
    tokenEnc = existing.token_enc;
    tokenPlain = await openToken(env, existing);
    tokenTail = existing.token_tail;
  } else {
    throw new MisubError(400, "请填写 MiSub 令牌");
  }

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
  const stored = { ...existing, refresh_enabled: enabled };
  await writeStoredConfig(env.DB, stored);
  if (cache && cache.snapshot.config.base_url === stored.base_url) {
    cache.snapshot.config.refresh_enabled = enabled;
  }
  return { base_url: stored.base_url, token_tail: stored.token_tail, refresh_enabled: stored.refresh_enabled };
}

async function requireConnection(env: Env): Promise<{ config: StoredConfig; token: string }> {
  const config = await readStoredConfig(env.DB);
  if (!config) throw new MisubError(400, "尚未连接 MiSub");
  return { config, token: await openToken(env, config) };
}

// ---------------------------------------------------------------------------
// 归一与脱敏。原始节点链接、订阅源地址都不出这个模块：列表只回
// 脱敏后的服务器文本，明文只走 revealMisubManualNode 一条路。

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function asTimeMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.floor(value * 1000) : Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? Math.floor(numeric * 1000) : Math.floor(numeric);
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function maskHost(host: string): string {
  const text = host.trim();
  if (!text) return "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    return text.split(".")[0] + ".***.***.***";
  }
  const dot = text.indexOf(".");
  if (dot > 0) {
    const head = text.slice(0, dot);
    const shown = head.length > 2 ? head.slice(0, 2) : head.slice(0, 1);
    return shown + "***" + text.slice(dot);
  }
  return (text.length > 2 ? text.slice(0, 2) : text.slice(0, 1)) + "***";
}

// 只取服务器 host:port，不解析协议内部结构。vmess 的载荷是整段
// base64 JSON：URL 解析会把载荷本身当主机名，所以先按 vmess 处理，
// 解出 add/port；解不出就返回空，页面显示「—」。
export function nodeServerOf(rawUrl: string): { host: string; port: number | null; server: string } {
  const text = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!text) return { host: "", port: null, server: "" };
  if (/^vmess:\/\//i.test(text)) {
    try {
      const payload = text.slice(text.indexOf("://") + 3).split(/[?#]/)[0] ?? "";
      const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
      const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
      const parsed = JSON.parse(atob(padded)) as Record<string, unknown>;
      const host = typeof parsed["add"] === "string" ? parsed["add"] : "";
      const port = parsed["port"] != null && Number(parsed["port"]) > 0 ? Number(parsed["port"]) : null;
      if (host) return { host, port, server: host + (port ? ":" + port : "") };
    } catch {
      // 解不出就当没有服务器信息。
    }
    return { host: "", port: null, server: "" };
  }
  try {
    const url = new URL(text);
    if (url.hostname) {
      const port = url.port ? Number(url.port) : null;
      return { host: url.hostname, port, server: url.hostname + (port ? ":" + port : "") };
    }
  } catch {
    // 落到下面的兜底提取。
  }
  const match = /@([^/:?#[\]]+)(?::(\d{1,5}))?/.exec(text);
  if (match && match[1]) {
    const port = match[2] ? Number(match[2]) : null;
    return { host: match[1], port, server: match[1] + (port ? ":" + port : "") };
  }
  return { host: "", port: null, server: "" };
}

export interface MisubSubscription {
  id: string;
  name: string;
  enabled: boolean;
  group: string;
  node_count: number;
  traffic_used: number | null;
  traffic_total: number | null;
  expire_at: number | null;
  last_error: string;
  last_update_at: number | null;
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
  node_count: number;
  subscriptions: number;
  manual_nodes: number;
}

export interface MisubOverview {
  subscriptions: number;
  manual_nodes: number;
  profiles: number;
  total_nodes: number;
  traffic_used: number | null;
  traffic_total: number | null;
  nearest_expire_at: number | null;
}

export interface MisubSnapshot {
  config: MisubConfig;
  overview: MisubOverview;
  subscriptions: MisubSubscription[];
  manual_nodes: MisubManualNode[];
  profiles: MisubProfile[];
  fetched_at: number;
}

function normalizeSubscription(row: Record<string, unknown>): MisubSubscription {
  const info = (row["userInfo"] ?? null) as Record<string, unknown> | null;
  const upload = info ? asCount(info["upload"]) : 0;
  const download = info ? asCount(info["download"]) : 0;
  const total = info ? asCount(info["total"]) : 0;
  return {
    id: asText(row["id"]),
    name: asText(row["name"]) || "未命名订阅源",
    enabled: row["enabled"] !== false,
    group: asText(row["group"]),
    node_count: asCount(row["nodeCount"]),
    traffic_used: info ? upload + download : null,
    traffic_total: info && total > 0 ? total : null,
    expire_at: info ? asTimeMs(info["expire"]) : null,
    last_error: asText(row["lastError"]),
    last_update_at: asTimeMs(row["lastUpdate"]),
  };
}

function normalizeManualNode(row: Record<string, unknown>): MisubManualNode {
  const rawUrl = asText(row["url"]);
  const server = nodeServerOf(rawUrl);
  const protocol =
    asText(row["protocol"]) || (rawUrl.includes("://") ? rawUrl.slice(0, rawUrl.indexOf("://")).toLowerCase() : "");
  return {
    id: asText(row["id"]),
    name: asText(row["name"]) || "未命名节点",
    protocol,
    enabled: row["enabled"] !== false,
    group: asText(row["group"]),
    remarks: asText(row["remarks"]),
    server_masked: server.host ? maskHost(server.host) + (server.port ? ":" + server.port : "") : "",
    has_server: server.host !== "",
  };
}

// ---------------------------------------------------------------------------
// 概览快照：三路列表并发取一次，内存缓存防抖。手动刷新绕过缓存。

interface CacheEntry {
  at: number;
  snapshot: MisubSnapshot;
}

let cache: CacheEntry | null = null;

export async function getMisubSnapshot(env: Env, fresh: boolean): Promise<MisubSnapshot> {
  const { config, token } = await requireConnection(env);
  if (!fresh && cache && cache.snapshot.config.base_url === config.base_url && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.snapshot;
  }
  const [subRows, nodeRows, profileRows] = await Promise.all([
    misubList(config.base_url, token, "/subscriptions"),
    misubList(config.base_url, token, "/manual-nodes"),
    misubList(config.base_url, token, "/profiles"),
  ]);
  const subscriptions = subRows.map(normalizeSubscription);
  const manualNodes = nodeRows.map(normalizeManualNode);
  const subById = new Map(subscriptions.map((sub) => [sub.id, sub]));
  // 订阅组聚合节点数：用已取到的订阅源 nodeCount 加手动节点个数在
  // 本地算，不再逐组调 preview——preview 是轻量接口，但逐组多打
  // 一轮没有必要，口径与 MiSub 的存储计数一致。
  const profiles: MisubProfile[] = profileRows.map((row) => {
    const subIds = Array.isArray(row["subscriptionIds"]) ? (row["subscriptionIds"] as unknown[]) : [];
    const nodeIds = Array.isArray(row["manualNodeIds"]) ? (row["manualNodeIds"] as unknown[]) : [];
    let nodes = nodeIds.length;
    for (const id of subIds) {
      const sub = typeof id === "string" ? subById.get(id) : undefined;
      if (sub) nodes += sub.node_count;
    }
    return {
      id: asText(row["id"]),
      name: asText(row["name"]) || "未命名订阅组",
      description: asText(row["description"]),
      enabled: row["enabled"] !== false,
      node_count: nodes,
      subscriptions: subIds.length,
      manual_nodes: nodeIds.length,
    };
  });

  let trafficUsed: number | null = null;
  let trafficTotal: number | null = null;
  let nearestExpire: number | null = null;
  for (const sub of subscriptions) {
    if (sub.traffic_used !== null && sub.traffic_total !== null) {
      trafficUsed = (trafficUsed ?? 0) + sub.traffic_used;
      trafficTotal = (trafficTotal ?? 0) + sub.traffic_total;
    }
    if (sub.expire_at !== null && (nearestExpire === null || sub.expire_at < nearestExpire)) {
      nearestExpire = sub.expire_at;
    }
  }
  const snapshot: MisubSnapshot = {
    config: { base_url: config.base_url, token_tail: config.token_tail, refresh_enabled: config.refresh_enabled },
    overview: {
      subscriptions: subscriptions.length,
      manual_nodes: manualNodes.length,
      profiles: profiles.length,
      total_nodes:
        subscriptions.reduce((sum, sub) => sum + sub.node_count, 0) + manualNodes.length,
      traffic_used: trafficUsed,
      traffic_total: trafficTotal,
      nearest_expire_at: nearestExpire,
    },
    subscriptions,
    manual_nodes: manualNodes,
    profiles,
    fetched_at: Date.now(),
  };
  cache = { at: snapshot.fetched_at, snapshot };
  return snapshot;
}

// 显示明文：单独取这一个节点，回服务器明文与完整链接。调用方
// （misub-http）负责先写审计再调用，与其它 reveal 口径一致。
export async function revealMisubManualNode(
  env: Env,
  id: string,
): Promise<{ name: string; server: string; url: string }> {
  const { config, token } = await requireConnection(env);
  const { data } = await misubFetch(config.base_url, token, "/manual-nodes/" + encodeURIComponent(id), "GET");
  const row = (data ?? {}) as Record<string, unknown>;
  const rawUrl = asText(row["url"]);
  if (!rawUrl) throw new MisubError(404, "节点不存在");
  return { name: asText(row["name"]) || "未命名节点", server: nodeServerOf(rawUrl).server, url: rawUrl };
}

// 触发订阅组 refresh：MiSub 会真去拉上游并回写计数，有副作用，
// 只在设置开关打开时放行（HTTP 层也会先查开关，这里再兜一层）。
export async function refreshMisubProfile(
  env: Env,
  id: string,
): Promise<{ name: string; total_nodes: number }> {
  const { config, token } = await requireConnection(env);
  if (!config.refresh_enabled) throw new MisubError(403, "触发刷新未开启，请先在设置里打开");
  const { data } = await misubFetch(config.base_url, token, "/profiles/" + encodeURIComponent(id) + "/refresh", "POST");
  const result = (data ?? {}) as Record<string, unknown>;
  const profile = (result["profile"] ?? {}) as Record<string, unknown>;
  const summary = (result["summary"] ?? {}) as Record<string, unknown>;
  cache = null;
  return { name: asText(profile["name"]) || "未命名订阅组", total_nodes: asCount(summary["totalNodes"]) };
}
