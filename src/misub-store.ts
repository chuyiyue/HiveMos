// MiSub 数据的 D1 存储与拉取频率控制（表结构见 migrations/0078_misub_store.sql）。
//
//   · 页面只读 D1：打开页面不出站。
//   · 出站有三条路：
//       1. hourly cron（runMisubSweep）：按连接的自动拉取间隔（默认 6 小时，0 关闭）
//          与订阅自己的覆盖值挑到期的拉，每次调用最多 SWEEP_SUBREQUEST_BUDGET 个
//          子请求，最久没拉的先拉，剩下的留给下一小时。
//       2. 手动「同步全部」：列表 + 最久没拉的若干订阅，连接级 5 分钟冷却，
//          每次最多 MANUAL_SUBREQUEST_BUDGET 个子请求。
//       3. 手动拉单个订阅：订阅级 5 分钟冷却。
//   · 拉取失败只记 last_error / last_attempt_at，上一次成功的节点与快照原样保留。
//   · 订阅地址、手工节点与机场节点的原始链接都用 VAULT_KEY 密封；明文只走 reveal。

import type { D1Database, Env } from "./env";
import { decryptString, resolveContentKey, sealString, type ContentKey } from "./crypto";
import {
  MisubError,
  fetchMisubLists,
  listMisubConnectionIds,
  maskServer,
  nodeServerOf,
  openMisubConnection,
  type MisubConnectionHandle,
  type MisubManualNode,
  type MisubSnapshot,
  type MisubSubscription,
  type MisubSubscriptionSource,
} from "./misub";
import { detectRegion, parseSubscriptionContent, parseUserInfoHeader, type ParsedNode } from "./misub-nodes-parse";

export const MANUAL_COOLDOWN_MS = 5 * 60 * 1000;
// 免费计划每次调用 50 个子请求；cron 与其它定时任务同一次调用，这里只占一部分。
export const SWEEP_SUBREQUEST_BUDGET = 16;
export const MANUAL_SUBREQUEST_BUDGET = 30;
const LIST_SUBREQUESTS = 3; // 三路列表各一页（每页 200 条，超出时会多翻几页）
const FETCH_CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
// D1 单行上限约 2 MB；节点 JSON + 密封链接超过这个量就截断，避免写入失败。
const MAX_ROW_BYTES = 1_800_000;
const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_NODE_UA = "v2rayN/7.23";
const CLASH_UA = "clash-verge/v2.4.3";

// ---------------------------------------------------------------------------
// 类型

export interface SubscriptionUserInfo {
  upload: number;
  download: number;
  total: number;
  expire: number | null;
}

// 落库与下发面板的节点形状：没有原始链接，服务器已脱敏。
export interface PublicNode {
  key: string;
  source_type: "manual" | "subscription";
  source_id: string;
  source_name: string;
  name: string;
  protocol: string;
  server_masked: string;
  has_server: boolean;
  region: string;
  can_copy: boolean;
  enabled: boolean;
  group: string;
  remarks: string;
}

interface StoredNode {
  name: string;
  protocol: string;
  server_masked: string;
  has_server: boolean;
  region: string;
  can_copy: boolean;
}

interface SnapshotRow {
  connection_id: string;
  data_json: string;
  secrets_enc: string;
  synced_at: number | null;
  last_attempt_at: number | null;
  last_ok: number;
  last_error: string;
  manual_at: number | null;
}

interface SubRow {
  connection_id: string;
  subscription_id: string;
  interval_hours: number | null;
  nodes_json: string;
  links_enc: string;
  node_count: number;
  format: string;
  truncated: number;
  user_info_json: string;
  last_attempt_at: number | null;
  last_ok: number;
  last_error: string;
  last_success_at: number | null;
  manual_at: number | null;
}

interface SnapshotSecrets {
  sources: Record<string, MisubSubscriptionSource>;
  manual_links: Record<string, string>;
}

export interface SubscriptionFetchState {
  interval_hours: number | null; // 订阅自己的覆盖值；null 表示跟随连接
  effective_interval_hours: number;
  fetched_node_count: number;
  fetch_format: string;
  fetch_truncated: boolean;
  live_user_info: SubscriptionUserInfo | null;
  last_fetch_at: number | null;
  last_fetch_ok: boolean;
  last_fetch_error: string;
  last_fetch_success_at: number | null;
  next_auto_at: number | null;
  next_manual_at: number;
}

export type StoredSubscription = MisubSubscription & SubscriptionFetchState;

export interface SyncStatus {
  never_synced: boolean;
  synced_at: number | null;
  last_attempt_at: number | null;
  last_ok: boolean;
  last_error: string;
  auto_interval_hours: number;
  next_auto_at: number | null;
  next_manual_at: number;
  cooldown_ms: number;
}

// ---------------------------------------------------------------------------
// 工具

function vaultKey(env: Env): ContentKey {
  const raw = (env as unknown as Record<string, unknown>)["VAULT_KEY"];
  return resolveContentKey(typeof raw === "string" ? raw : undefined);
}

async function seal(env: Env, value: unknown): Promise<string> {
  const key = vaultKey(env);
  if (key.state === "invalid") throw new MisubError(503, "保险库密钥配置不正确，无法保存 MiSub 数据");
  if (key.state !== "on") throw new MisubError(503, "保险库未配置，无法保存 MiSub 数据");
  const sealed = await sealString(key, JSON.stringify(value));
  if (sealed === null) throw new MisubError(503, "保险库未配置，无法保存 MiSub 数据");
  return sealed;
}

async function open<T>(env: Env, stored: string): Promise<T | null> {
  if (!stored) return null;
  const key = vaultKey(env);
  if (key.state === "invalid") throw new MisubError(503, "保险库密钥配置不正确，无法读取 MiSub 数据");
  if (key.state !== "on") throw new MisubError(503, "保险库未配置，无法读取 MiSub 数据");
  const plain = await decryptString(key.raw, stored);
  if (plain === null) throw new MisubError(500, "MiSub 数据解密失败，保险库密钥可能不正确");
  try {
    return JSON.parse(plain) as T;
  } catch {
    return null;
  }
}

function rowsOf<T>(value: { results?: T[] } | T[] | null | undefined): T[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return value.results ?? [];
}

function parseJson<T>(text: string, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function due(lastAttempt: number | null, intervalHours: number, now: number): boolean {
  if (intervalHours <= 0) return false;
  if (lastAttempt === null) return true;
  return now - lastAttempt >= intervalHours * HOUR_MS;
}

function nextAuto(lastAttempt: number | null, intervalHours: number, now: number): number | null {
  if (intervalHours <= 0) return null;
  if (lastAttempt === null) return now;
  return lastAttempt + intervalHours * HOUR_MS;
}

function nextManual(manualAt: number | null): number {
  return manualAt ? manualAt + MANUAL_COOLDOWN_MS : 0;
}

function cooldownMessage(nextAt: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((nextAt - now) / 60000));
  return `刚刚拉取过，${minutes} 分钟后才能再次手动刷新`;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof MisubError ? error.message : fallback;
}

// ---------------------------------------------------------------------------
// 读

async function readSnapshotRow(db: D1Database, connId: string): Promise<SnapshotRow | null> {
  return (
    (await db.prepare("SELECT * FROM misub_snapshots WHERE connection_id = ?").bind(connId).first<SnapshotRow>()) ?? null
  );
}

async function readSubRows(db: D1Database, connId: string): Promise<SubRow[]> {
  const res = await db
    .prepare(
      "SELECT connection_id, subscription_id, interval_hours, nodes_json, '' AS links_enc, node_count, format, truncated, user_info_json, last_attempt_at, last_ok, last_error, last_success_at, manual_at FROM misub_subscription_nodes WHERE connection_id = ?",
    )
    .bind(connId)
    .all<SubRow>();
  return rowsOf(res);
}

async function readSubRow(db: D1Database, connId: string, subId: string, withLinks: boolean): Promise<SubRow | null> {
  return (
    (await db
      .prepare(
        "SELECT connection_id, subscription_id, interval_hours, nodes_json, " +
          (withLinks ? "links_enc" : "'' AS links_enc") +
          ", node_count, format, truncated, user_info_json, last_attempt_at, last_ok, last_error, last_success_at, manual_at FROM misub_subscription_nodes WHERE connection_id = ? AND subscription_id = ?",
      )
      .bind(connId, subId)
      .first<SubRow>()) ?? null
  );
}

function fetchState(row: SubRow | undefined, connInterval: number, now: number): SubscriptionFetchState {
  const own = row && row.interval_hours !== null && row.interval_hours !== undefined ? row.interval_hours : null;
  const effective = own ?? connInterval;
  const lastAttempt = row?.last_attempt_at ?? null;
  return {
    interval_hours: own,
    effective_interval_hours: effective,
    fetched_node_count: row?.node_count ?? 0,
    fetch_format: row?.format ?? "",
    fetch_truncated: row?.truncated === 1,
    live_user_info: row ? parseJson<SubscriptionUserInfo | null>(row.user_info_json, null) : null,
    last_fetch_at: lastAttempt,
    last_fetch_ok: row?.last_ok === 1,
    last_fetch_error: row?.last_error ?? "",
    last_fetch_success_at: row?.last_success_at ?? null,
    next_auto_at: nextAuto(lastAttempt, effective, now),
    next_manual_at: nextManual(row?.manual_at ?? null),
  };
}

export interface StoredView {
  snapshot: (Omit<MisubSnapshot, "subscriptions"> & { subscriptions: StoredSubscription[] }) | null;
  sync: SyncStatus;
}

function emptySnapshot(conn: MisubConnectionHandle): MisubSnapshot {
  return {
    config: { base_url: conn.base_url, token_tail: "", refresh_enabled: conn.refresh_enabled },
    fetched_at: 0,
    overview: { subscriptions: 0, manual_nodes: 0, profiles: 0, total_nodes: 0, traffic_used: 0, traffic_total: 0, nearest_expire: null },
    subscriptions: [],
    manual_nodes: [],
    profiles: [],
  };
}

// 面板快照：只读 D1，订阅源合并各自的拉取状态。
export async function readMisubView(env: Env, connId?: string): Promise<StoredView & { connection: MisubConnectionHandle }> {
  const conn = await openMisubConnection(env, connId);
  const now = Date.now();
  const [snap, subRows] = await Promise.all([readSnapshotRow(env.DB, conn.id), readSubRows(env.DB, conn.id)]);
  const sync: SyncStatus = {
    never_synced: !snap || !snap.synced_at,
    synced_at: snap?.synced_at ?? null,
    last_attempt_at: snap?.last_attempt_at ?? null,
    last_ok: snap?.last_ok === 1,
    last_error: snap?.last_error ?? "",
    auto_interval_hours: conn.auto_interval_hours,
    next_auto_at: nextAuto(snap?.last_attempt_at ?? null, conn.auto_interval_hours, now),
    next_manual_at: nextManual(snap?.manual_at ?? null),
    cooldown_ms: MANUAL_COOLDOWN_MS,
  };
  const base = snap && snap.data_json ? parseJson<MisubSnapshot | null>(snap.data_json, null) : null;
  const data = base ?? emptySnapshot(conn);
  data.config = { ...data.config, base_url: conn.base_url, refresh_enabled: conn.refresh_enabled };
  const byId = new Map(subRows.map((r) => [r.subscription_id, r]));
  const subscriptions = data.subscriptions.map((sub) => ({ ...sub, ...fetchState(byId.get(sub.id), conn.auto_interval_hours, now) }));
  return { connection: conn, snapshot: base ? { ...data, subscriptions } : null, sync };
}

function manualPublic(node: MisubManualNode): PublicNode {
  return {
    key: node.id,
    source_type: "manual",
    source_id: node.id,
    source_name: "手工节点",
    name: node.name,
    protocol: node.protocol,
    server_masked: node.server_masked,
    has_server: node.has_server,
    region: node.region,
    can_copy: true,
    enabled: node.enabled,
    group: node.group,
    remarks: node.remarks,
  };
}

function subPublic(sub: MisubSubscription, nodes: StoredNode[]): PublicNode[] {
  return nodes.map((n, i) => ({
    key: String(i),
    source_type: "subscription" as const,
    source_id: sub.id,
    source_name: sub.name,
    name: n.name,
    protocol: n.protocol,
    server_masked: n.server_masked,
    has_server: n.has_server,
    region: n.region,
    can_copy: n.can_copy,
    enabled: sub.enabled,
    group: "",
    remarks: "",
  }));
}

export interface AllNodesSource {
  id: string;
  name: string;
  type: "manual" | "subscription";
  enabled: boolean;
  count: number;
  last_fetch_at: number | null;
  last_fetch_ok: boolean;
  last_fetch_error: string;
  last_fetch_success_at: number | null;
  next_auto_at: number | null;
  next_manual_at: number;
}

// 全部节点：手工节点 + 每个机场订阅最近一次成功拉到的节点，全部来自 D1。
export async function readAllMisubNodes(env: Env): Promise<{ nodes: PublicNode[]; sources: AllNodesSource[]; sync: SyncStatus }> {
  const view = await readMisubView(env);
  const data = view.snapshot;
  if (!data) return { nodes: [], sources: [], sync: view.sync };
  const nodes: PublicNode[] = data.manual_nodes.map(manualPublic);
  const sources: AllNodesSource[] = [
    {
      id: "manual",
      name: "手工节点",
      type: "manual",
      enabled: true,
      count: nodes.length,
      last_fetch_at: view.sync.last_attempt_at,
      last_fetch_ok: view.sync.last_ok,
      last_fetch_error: view.sync.last_error,
      last_fetch_success_at: view.sync.synced_at,
      next_auto_at: view.sync.next_auto_at,
      next_manual_at: view.sync.next_manual_at,
    },
  ];
  const rows = await env.DB.prepare(
    "SELECT subscription_id, nodes_json FROM misub_subscription_nodes WHERE connection_id = ?",
  )
    .bind(view.connection.id)
    .all<{ subscription_id: string; nodes_json: string }>();
  const nodesById = new Map(rowsOf(rows).map((r) => [r.subscription_id, parseJson<StoredNode[]>(r.nodes_json, [])]));
  for (const sub of data.subscriptions) {
    const list = subPublic(sub, nodesById.get(sub.id) ?? []);
    nodes.push(...list);
    sources.push({
      id: sub.id,
      name: sub.name,
      type: "subscription",
      enabled: sub.enabled,
      count: list.length,
      last_fetch_at: sub.last_fetch_at,
      last_fetch_ok: sub.last_fetch_ok,
      last_fetch_error: sub.last_fetch_error,
      last_fetch_success_at: sub.last_fetch_success_at,
      next_auto_at: sub.enabled ? sub.next_auto_at : null,
      next_manual_at: sub.next_manual_at,
    });
  }
  return { nodes, sources, sync: view.sync };
}

export async function readMisubSubscriptionNodes(env: Env, subId: string) {
  const view = await readMisubView(env);
  const sub = view.snapshot?.subscriptions.find((s) => s.id === subId);
  if (!sub) throw new MisubError(404, "订阅源不存在，请先同步");
  const row = await readSubRow(env.DB, view.connection.id, subId, false);
  return {
    subscription_id: subId,
    name: sub.name,
    state: fetchState(row ?? undefined, view.connection.auto_interval_hours, Date.now()),
    nodes: subPublic(sub, row ? parseJson<StoredNode[]>(row.nodes_json, []) : []),
  };
}

// ---------------------------------------------------------------------------
// 拉取：MiSub 列表

async function syncSnapshot(env: Env, conn: MisubConnectionHandle, now: number, manual: boolean): Promise<{ ok: boolean; error: string }> {
  try {
    const lists = await fetchMisubLists(conn);
    const secrets: SnapshotSecrets = { sources: lists.sources, manual_links: lists.manual_links };
    const secretsEnc = await seal(env, secrets);
    const ids = lists.snapshot.subscriptions.map((s) => s.id);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO misub_snapshots (connection_id, data_json, secrets_enc, synced_at, last_attempt_at, last_ok, last_error, manual_at) VALUES (?, ?, ?, ?, ?, 1, '', ?) " +
          "ON CONFLICT(connection_id) DO UPDATE SET data_json = excluded.data_json, secrets_enc = excluded.secrets_enc, synced_at = excluded.synced_at, last_attempt_at = excluded.last_attempt_at, last_ok = 1, last_error = '', manual_at = COALESCE(excluded.manual_at, misub_snapshots.manual_at)",
      ).bind(conn.id, JSON.stringify(lists.snapshot), secretsEnc, now, now, manual ? now : null),
      // MiSub 里已经删掉的订阅，节点行一起删
      env.DB.prepare(
        "DELETE FROM misub_subscription_nodes WHERE connection_id = ? AND subscription_id NOT IN (SELECT value FROM json_each(?))",
      ).bind(conn.id, JSON.stringify(ids)),
    ]);
    return { ok: true, error: "" };
  } catch (error) {
    const message = errorText(error, "读取 MiSub 列表失败");
    await env.DB.prepare(
      "INSERT INTO misub_snapshots (connection_id, last_attempt_at, last_ok, last_error, manual_at) VALUES (?, ?, 0, ?, ?) " +
        "ON CONFLICT(connection_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_ok = 0, last_error = excluded.last_error, manual_at = COALESCE(excluded.manual_at, misub_snapshots.manual_at)",
    )
      .bind(conn.id, now, message, manual ? now : null)
      .run();
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// 拉取：机场订阅原文

function pickUserAgent(sourceUa: string, connectionUa: string, url: string): string {
  if (sourceUa) return sourceUa;
  if (connectionUa) return connectionUa;
  if (/[?&](?:clash(?:=|&|$)|target=clash(?:&|$))/i.test(url)) return CLASH_UA;
  return DEFAULT_NODE_UA;
}

async function readLimitedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") || "0");
  if (declared > MAX_BODY_BYTES) throw new MisubError(502, "机场订阅内容过大（超过 8 MB）");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        throw new MisubError(502, "机场订阅内容过大（超过 8 MB）");
      }
      chunks.push(value);
    }
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

async function fetchAirport(url: string, userAgent: string) {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { "user-agent": userAgent, accept: "*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new MisubError(504, "拉取机场订阅超时");
    }
    throw new MisubError(502, "连不上机场订阅地址");
  }
  if (!response.ok) throw new MisubError(502, "机场订阅返回 HTTP " + response.status);
  const text = await readLimitedText(response);
  const parsed = parseSubscriptionContent(text);
  if (parsed.format === "unknown") {
    throw new MisubError(502, "机场订阅内容无法识别（不是节点链接、base64 或 Clash 配置）");
  }
  return { parsed, userInfo: parseUserInfoHeader(response.headers.get("subscription-userinfo")) };
}

function storedNode(node: ParsedNode): StoredNode {
  return {
    name: node.name,
    protocol: node.protocol,
    server_masked: maskServer(node.host, node.port),
    has_server: node.host !== "",
    region: detectRegion(node.name),
    can_copy: node.link !== null,
  };
}

async function fetchOneSubscription(
  env: Env,
  conn: MisubConnectionHandle,
  subId: string,
  source: MisubSubscriptionSource,
  now: number,
  manual: boolean,
): Promise<{ ok: boolean; error: string; count: number }> {
  try {
    const { parsed, userInfo } = await fetchAirport(source.url, pickUserAgent(source.user_agent, conn.node_ua, source.url));
    let nodes = parsed.nodes;
    let truncated = parsed.truncated;
    let publicNodes = nodes.map(storedNode);
    let nodesJson = JSON.stringify(publicNodes);
    let linksEnc = await seal(env, nodes.map((n) => n.link));
    while (nodesJson.length + linksEnc.length > MAX_ROW_BYTES && nodes.length > 1) {
      const keep = Math.floor(nodes.length * 0.8);
      nodes = nodes.slice(0, keep);
      truncated = true;
      publicNodes = publicNodes.slice(0, keep);
      nodesJson = JSON.stringify(publicNodes);
      linksEnc = await seal(env, nodes.map((n) => n.link));
    }
    await env.DB.prepare(
      "INSERT INTO misub_subscription_nodes (connection_id, subscription_id, nodes_json, links_enc, node_count, format, truncated, user_info_json, last_attempt_at, last_ok, last_error, last_success_at, manual_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '', ?, ?) ON CONFLICT(connection_id, subscription_id) DO UPDATE SET " +
        "nodes_json = excluded.nodes_json, links_enc = excluded.links_enc, node_count = excluded.node_count, format = excluded.format, truncated = excluded.truncated, " +
        "user_info_json = excluded.user_info_json, last_attempt_at = excluded.last_attempt_at, last_ok = 1, last_error = '', last_success_at = excluded.last_success_at, " +
        "manual_at = COALESCE(excluded.manual_at, misub_subscription_nodes.manual_at)",
    )
      .bind(conn.id, subId, nodesJson, linksEnc, publicNodes.length, parsed.format, truncated ? 1 : 0, userInfo ? JSON.stringify(userInfo) : "", now, now, manual ? now : null)
      .run();
    return { ok: true, error: "", count: publicNodes.length };
  } catch (error) {
    const message = errorText(error, "拉取机场订阅失败");
    // 失败只记状态，上一次成功的节点不动。
    await env.DB.prepare(
      "INSERT INTO misub_subscription_nodes (connection_id, subscription_id, last_attempt_at, last_ok, last_error, manual_at) VALUES (?, ?, ?, 0, ?, ?) " +
        "ON CONFLICT(connection_id, subscription_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_ok = 0, last_error = excluded.last_error, " +
        "manual_at = COALESCE(excluded.manual_at, misub_subscription_nodes.manual_at)",
    )
      .bind(conn.id, subId, now, message, manual ? now : null)
      .run();
    return { ok: false, error: message, count: 0 };
  }
}

async function runPool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, items.length) }, async () => {
      while (cursor < items.length) await worker(items[cursor++]!);
    }),
  );
}

async function readSources(env: Env, connId: string): Promise<SnapshotSecrets | null> {
  const snap = await readSnapshotRow(env.DB, connId);
  if (!snap || !snap.secrets_enc) return null;
  return open<SnapshotSecrets>(env, snap.secrets_enc);
}

interface Candidate {
  sub: MisubSubscription;
  source: MisubSubscriptionSource;
  lastAttempt: number | null;
}

async function candidates(env: Env, conn: MisubConnectionHandle): Promise<{ list: Candidate[]; rows: Map<string, SubRow> }> {
  const [snap, rows] = await Promise.all([readSnapshotRow(env.DB, conn.id), readSubRows(env.DB, conn.id)]);
  const rowMap = new Map(rows.map((r) => [r.subscription_id, r]));
  if (!snap || !snap.data_json || !snap.secrets_enc) return { list: [], rows: rowMap };
  const data = parseJson<MisubSnapshot | null>(snap.data_json, null);
  const secrets = await open<SnapshotSecrets>(env, snap.secrets_enc);
  if (!data || !secrets) return { list: [], rows: rowMap };
  const list: Candidate[] = [];
  for (const sub of data.subscriptions) {
    const source = secrets.sources[sub.id];
    if (!sub.enabled || !source) continue;
    list.push({ sub, source, lastAttempt: rowMap.get(sub.id)?.last_attempt_at ?? null });
  }
  list.sort((a, b) => (a.lastAttempt ?? 0) - (b.lastAttempt ?? 0));
  return { list, rows: rowMap };
}

// ---------------------------------------------------------------------------
// 手动刷新

export interface SyncResult {
  snapshot_ok: boolean;
  snapshot_error: string;
  fetched: number;
  failed: Array<{ id: string; name: string; error: string }>;
  remaining: number;
  next_manual_at: number;
}

// 同步全部：先拉列表，再按「最久没拉」的顺序拉订阅，直到用完本次预算。
export async function manualSyncAll(env: Env, now: number): Promise<SyncResult> {
  const conn = await openMisubConnection(env);
  const snap = await readSnapshotRow(env.DB, conn.id);
  const nextAt = nextManual(snap?.manual_at ?? null);
  if (nextAt > now) throw new MisubError(429, cooldownMessage(nextAt, now));
  const listResult = await syncSnapshot(env, conn, now, true);
  const result: SyncResult = {
    snapshot_ok: listResult.ok,
    snapshot_error: listResult.error,
    fetched: 0,
    failed: [],
    remaining: 0,
    next_manual_at: now + MANUAL_COOLDOWN_MS,
  };
  const { list, rows } = await candidates(env, conn);
  // 手动冷却中的订阅跳过（刚单独拉过的不重复拉）
  const eligible = list.filter((c) => nextManual(rows.get(c.sub.id)?.manual_at ?? null) <= now);
  const budget = Math.max(0, MANUAL_SUBREQUEST_BUDGET - LIST_SUBREQUESTS);
  const picked = eligible.slice(0, budget);
  result.remaining = eligible.length - picked.length;
  await runPool(picked, async (c) => {
    const r = await fetchOneSubscription(env, conn, c.sub.id, c.source, now, true);
    if (r.ok) result.fetched++;
    else result.failed.push({ id: c.sub.id, name: c.sub.name, error: r.error });
  });
  return result;
}

export async function manualFetchSubscription(env: Env, subId: string, now: number) {
  const conn = await openMisubConnection(env);
  const row = await readSubRow(env.DB, conn.id, subId, false);
  const nextAt = nextManual(row?.manual_at ?? null);
  if (nextAt > now) throw new MisubError(429, cooldownMessage(nextAt, now));
  const secrets = await readSources(env, conn.id);
  const source = secrets?.sources[subId];
  if (!source) throw new MisubError(404, "订阅源不存在，请先同步 MiSub 列表");
  const r = await fetchOneSubscription(env, conn, subId, source, now, true);
  return { ...r, next_manual_at: now + MANUAL_COOLDOWN_MS };
}

// 列表同步（不拉机场订阅）：保存连接后、触发 MiSub 刷新后用，不占手动冷却。
export async function syncMisubListsNow(env: Env, connId?: string): Promise<{ ok: boolean; error: string }> {
  const conn = await openMisubConnection(env, connId);
  return syncSnapshot(env, conn, Date.now(), false);
}

// ---------------------------------------------------------------------------
// 频率设置

export async function setSubscriptionInterval(env: Env, subId: string, hours: number | null): Promise<void> {
  const conn = await openMisubConnection(env);
  await env.DB.prepare(
    "INSERT INTO misub_subscription_nodes (connection_id, subscription_id, interval_hours) VALUES (?, ?, ?) " +
      "ON CONFLICT(connection_id, subscription_id) DO UPDATE SET interval_hours = excluded.interval_hours",
  )
    .bind(conn.id, subId, hours)
    .run();
}

export async function deleteMisubStore(db: D1Database, connId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM misub_snapshots WHERE connection_id = ?").bind(connId),
    db.prepare("DELETE FROM misub_subscription_nodes WHERE connection_id = ?").bind(connId),
  ]);
}

// ---------------------------------------------------------------------------
// reveal：明文只从 D1 的密封列解开，不出站。调用方先写审计。

export async function revealStoredManualNode(env: Env, id: string): Promise<{ server: string; url: string }> {
  const conn = await openMisubConnection(env);
  const secrets = await readSources(env, conn.id);
  const url = secrets?.manual_links[id];
  if (!url) throw new MisubError(404, "节点不存在，请先同步");
  return { server: nodeServerOf(url).server, url };
}

export async function revealStoredSubscriptionNode(
  env: Env,
  subId: string,
  index: number,
  expectedName: string,
): Promise<{ server: string; url: string }> {
  const conn = await openMisubConnection(env);
  const row = await readSubRow(env.DB, conn.id, subId, true);
  if (!row) throw new MisubError(404, "这个订阅还没有拉取过节点");
  const nodes = parseJson<StoredNode[]>(row.nodes_json, []);
  const node = nodes[index];
  if (!node) throw new MisubError(404, "节点不存在，请刷新列表后重试");
  if (expectedName && node.name !== expectedName) throw new MisubError(409, "节点列表已更新，请刷新页面后重试");
  if (!node.can_copy) throw new MisubError(400, "这个订阅是 Clash 配置格式，没有可复制的原始链接");
  const links = (await open<Array<string | null>>(env, row.links_enc)) ?? [];
  const url = links[index];
  if (!url) throw new MisubError(404, "节点链接不存在，请重新拉取订阅");
  const parsed = parseSubscriptionContent(url).nodes[0];
  const server = parsed && parsed.host
    ? (parsed.host.includes(":") ? `[${parsed.host}]` : parsed.host) + (parsed.port ? ":" + parsed.port : "")
    : "";
  return { server, url };
}

// ---------------------------------------------------------------------------
// cron：每小时触发一次，自己按间隔门控，不受「功能设置」的全局 sweep 间隔约束。

export async function runMisubSweep(env: Env, now: number): Promise<{ lists: number; fetched: number; failed: number }> {
  const stats = { lists: 0, fetched: 0, failed: 0 };
  let budget = SWEEP_SUBREQUEST_BUDGET;
  const { ids } = await listMisubConnectionIds(env.DB);
  for (const id of ids) {
    if (budget <= 0) break;
    let conn: MisubConnectionHandle;
    try {
      conn = await openMisubConnection(env, id);
    } catch {
      continue; // 令牌解不开等情况：跳过这个连接
    }
    const snap = await readSnapshotRow(env.DB, conn.id);
    if (due(snap?.last_attempt_at ?? null, conn.auto_interval_hours, now) && budget >= LIST_SUBREQUESTS) {
      budget -= LIST_SUBREQUESTS;
      stats.lists++;
      await syncSnapshot(env, conn, now, false);
    }
    const { list, rows } = await candidates(env, conn);
    const dueList = list.filter((c) => {
      const row = rows.get(c.sub.id);
      const interval = row && row.interval_hours !== null && row.interval_hours !== undefined ? row.interval_hours : conn.auto_interval_hours;
      return due(c.lastAttempt, interval, now);
    });
    const picked = dueList.slice(0, budget);
    budget -= picked.length;
    await runPool(picked, async (c) => {
      const r = await fetchOneSubscription(env, conn, c.sub.id, c.source, now, false);
      if (r.ok) stats.fetched++;
      else stats.failed++;
    });
  }
  return stats;
}
