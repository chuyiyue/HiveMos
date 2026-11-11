// 机场订阅节点：MiSub 的 External Management API 只给订阅源的元信息（地址、
// 节点数、流量），不给订阅里的具体节点。要在「全部节点 / 机场订阅」里列出
// 节点，只能由 Worker 拿着 MiSub 给的订阅地址直接去拉一次原文，在内存里做
// 最小解析（misub-nodes-parse.ts）。
//
// 口径与 misub.ts 保持一致：
//   · 不落库、无定时任务、不测活。原文与原始链接只在当前隔离环境的内存里
//     留 5 分钟，Workers 随时可能丢弃它，丢了就在下一次手动请求时重拉。
//   · 出站只发生在管理员手动打开列表、点刷新或点复制时。
//   · 列表只回脱敏后的服务器文本；完整链接只走 reveal（先写审计）。

import type { Env } from "./env";
import {
  MisubError,
  getMisubSnapshot,
  getMisubSubscriptionSource,
  maskServer,
  type MisubManualNode,
} from "./misub";
import { detectRegion, parseSubscriptionContent, parseUserInfoHeader, type ParsedNode } from "./misub-nodes-parse";

const FETCH_TIMEOUT_MS = 10000;
const NODES_CACHE_TTL_MS = 5 * 60 * 1000;
const NODES_CACHE_MAX = 40;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const ALL_NODES_MAX_SUBSCRIPTIONS = 30;
const ALL_NODES_CONCURRENCY = 4;
export const DEFAULT_NODE_UA = "v2rayN/7.23";
const CLASH_UA = "clash-verge/v2.4.3";

export interface SubscriptionUserInfo {
  upload: number;
  download: number;
  total: number;
  expire: number | null;
}

interface NodesCacheEntry {
  at: number;
  format: string;
  truncated: boolean;
  user_info: SubscriptionUserInfo | null;
  nodes: ParsedNode[];
}

const nodesCache = new Map<string, NodesCacheEntry>();
const inflight = new Map<string, Promise<NodesCacheEntry>>();

export function clearMisubNodesCache(): void {
  nodesCache.clear();
  inflight.clear();
}

// 面板拿到的节点形状：没有原始链接，服务器已脱敏。
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

async function fetchSubscriptionNodes(url: string, userAgent: string): Promise<NodesCacheEntry> {
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
  if (!response.ok) {
    throw new MisubError(502, "机场订阅返回 HTTP " + response.status);
  }
  const text = await readLimitedText(response);
  const parsed = parseSubscriptionContent(text);
  if (parsed.format === "unknown") {
    throw new MisubError(502, "机场订阅内容无法识别（不是节点链接、base64 或 Clash 配置）");
  }
  return {
    at: Date.now(),
    format: parsed.format,
    truncated: parsed.truncated,
    user_info: parseUserInfoHeader(response.headers.get("subscription-userinfo")),
    nodes: parsed.nodes,
  };
}

function trimCache(): void {
  while (nodesCache.size > NODES_CACHE_MAX) {
    const first = nodesCache.keys().next();
    if (first.done) break;
    nodesCache.delete(first.value);
  }
}

async function loadSubscriptionNodes(
  env: Env,
  subscriptionId: string,
  fresh: boolean,
): Promise<{ name: string; enabled: boolean; entry: NodesCacheEntry }> {
  const info = await getMisubSubscriptionSource(env, subscriptionId);
  const key = info.connection_id + ":" + subscriptionId;
  const hit = nodesCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < NODES_CACHE_TTL_MS) {
    return { name: info.name, enabled: info.enabled, entry: hit };
  }
  let promise = inflight.get(key);
  if (!promise) {
    const ua = pickUserAgent(info.source.user_agent, info.node_ua, info.source.url);
    promise = fetchSubscriptionNodes(info.source.url, ua);
    inflight.set(key, promise);
  }
  try {
    const entry = await promise;
    nodesCache.delete(key);
    nodesCache.set(key, entry);
    trimCache();
    return { name: info.name, enabled: info.enabled, entry };
  } finally {
    inflight.delete(key);
  }
}

function publicSubscriptionNode(
  subscriptionId: string,
  subscriptionName: string,
  enabled: boolean,
  node: ParsedNode,
  index: number,
): PublicNode {
  return {
    key: String(index),
    source_type: "subscription",
    source_id: subscriptionId,
    source_name: subscriptionName,
    name: node.name,
    protocol: node.protocol,
    server_masked: maskServer(node.host, node.port),
    has_server: node.host !== "",
    region: detectRegion(node.name),
    can_copy: node.link !== null,
    enabled,
    group: "",
    remarks: "",
  };
}

function publicManualNode(node: MisubManualNode): PublicNode {
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

export interface SubscriptionNodesResult {
  subscription_id: string;
  name: string;
  fetched_at: number;
  format: string;
  truncated: boolean;
  user_info: SubscriptionUserInfo | null;
  nodes: PublicNode[];
}

export async function listMisubSubscriptionNodes(
  env: Env,
  subscriptionId: string,
  fresh: boolean,
): Promise<SubscriptionNodesResult> {
  const { name, enabled, entry } = await loadSubscriptionNodes(env, subscriptionId, fresh);
  return {
    subscription_id: subscriptionId,
    name,
    fetched_at: entry.at,
    format: entry.format,
    truncated: entry.truncated,
    user_info: entry.user_info,
    nodes: entry.nodes.map((node, index) => publicSubscriptionNode(subscriptionId, name, enabled, node, index)),
  };
}

// 取一条机场节点的明文。index 是列表里的位置，name 用来核对订阅内容在两次
// 拉取之间没有变化（机场重排节点时位置会错位，宁可报错也不复制错的链接）。
export async function revealMisubSubscriptionNode(
  env: Env,
  subscriptionId: string,
  index: number,
  expectedName: string,
): Promise<{ name: string; server: string; url: string }> {
  const { entry } = await loadSubscriptionNodes(env, subscriptionId, false);
  const node = entry.nodes[index];
  if (!node) throw new MisubError(404, "节点不存在，请刷新列表后重试");
  if (expectedName && node.name !== expectedName) {
    throw new MisubError(409, "机场订阅内容已变化，请刷新列表后重试");
  }
  if (!node.link) throw new MisubError(400, "这个订阅是 Clash 配置格式，没有可复制的原始链接");
  const server = node.host ? (node.host.includes(":") ? `[${node.host}]` : node.host) + (node.port ? ":" + node.port : "") : "";
  return { name: node.name, server, url: node.link };
}

export interface AllNodesSource {
  id: string;
  name: string;
  type: "manual" | "subscription";
  ok: boolean;
  error: string;
  count: number;
  skipped: boolean;
}

export interface AllNodesResult {
  fetched_at: number;
  nodes: PublicNode[];
  sources: AllNodesSource[];
}

// 全部节点 = 手工节点 + 每个启用的机场订阅拉回来的节点。单个订阅失败不影响
// 其它来源，失败原因放在 sources 里给面板展示。
export async function listAllMisubNodes(env: Env, fresh: boolean): Promise<AllNodesResult> {
  const snapshot = await getMisubSnapshot(env, false);
  const nodes: PublicNode[] = snapshot.manual_nodes.map(publicManualNode);
  const sources: AllNodesSource[] = [
    { id: "manual", name: "手工节点", type: "manual", ok: true, error: "", count: nodes.length, skipped: false },
  ];
  const subs = snapshot.subscriptions;
  const enabledSubs = subs.filter((s) => s.enabled);
  const targets = enabledSubs.slice(0, ALL_NODES_MAX_SUBSCRIPTIONS);
  const results: Array<{ sub: (typeof subs)[number]; nodes: PublicNode[]; error: string }> = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const sub = targets[cursor++]!;
      try {
        const result = await listMisubSubscriptionNodes(env, sub.id, fresh);
        results.push({ sub, nodes: result.nodes, error: "" });
      } catch (error) {
        results.push({ sub, nodes: [], error: error instanceof MisubError ? error.message : "拉取失败" });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(ALL_NODES_CONCURRENCY, targets.length) }, () => worker()));
  const order = new Map(subs.map((s, i) => [s.id, i]));
  results.sort((a, b) => (order.get(a.sub.id) ?? 0) - (order.get(b.sub.id) ?? 0));
  for (const r of results) {
    nodes.push(...r.nodes);
    sources.push({ id: r.sub.id, name: r.sub.name, type: "subscription", ok: !r.error, error: r.error, count: r.nodes.length, skipped: false });
  }
  for (const sub of subs) {
    if (targets.includes(sub)) continue;
    sources.push({
      id: sub.id,
      name: sub.name,
      type: "subscription",
      ok: false,
      error: sub.enabled ? "订阅源超过 " + ALL_NODES_MAX_SUBSCRIPTIONS + " 个，未拉取" : "订阅源已停用，未拉取",
      count: 0,
      skipped: true,
    });
  }
  return { fetched_at: Date.now(), nodes, sources };
}
