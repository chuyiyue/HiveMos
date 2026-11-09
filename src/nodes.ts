// 网络节点：订阅密封存储、拉取解析、手动导入，以及 TCP 测活。
// 测活只用 cloudflare:sockets 的 connect() 看端口能不能连上，记下耗时。
// 超时 5 秒记 fail。不做协议握手，界面文案也不要说成握手成功。
// 订阅地址和节点原始链接含令牌或密码，落库一律 enc1:，列表不回明文。

import { connect } from "cloudflare:sockets";
import { sha256Hex } from "./auth";
import { decryptString, resolveContentKey, sealString, type ContentKey } from "./crypto";
import type { D1Database, D1PreparedStatement, Env } from "./env";
import { parseNodeText, type ParsedNode } from "./nodes-parse";
import { prepare } from "./registry";

export const TEST_TIMEOUT_MS = 5000;
export const TEST_CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 20000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RAW_CHARS = 256 * 1024;
const CLASH_UA = "clash-meta/1.18.3";
const BATCH_SIZE = 40;

export class NodeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface PublicSubscription {
  id: string;
  name: string;
  last_sync_at: number | null;
  last_error: string;
  created_at: number;
  updated_at: number;
}

export interface PublicNode {
  id: string;
  subscription_id: string | null;
  name: string;
  protocol: string;
  server: string;
  port: number;
  note: string;
  last_status: "" | "ok" | "fail";
  last_latency_ms: number | null;
  last_test_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface SyncReport {
  ok: boolean;
  error: string;
  added: number;
  updated: number;
  removed: number;
  skipped: number;
}

export interface ImportReport {
  added: number;
  updated: number;
  skipped: number;
}

interface SubRow {
  id: string;
  name: string;
  url_enc: string;
  last_sync_at: number | null;
  last_error: string;
  created_at: number;
  updated_at: number;
}

interface NodeRow {
  id: string;
  subscription_id: string | null;
  name: string;
  protocol: string;
  server: string;
  port: number;
  note: string;
  raw_enc: string;
  dedupe_key: string;
  last_status: string;
  last_latency_ms: number | null;
  last_test_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowsOf<T>(value: { results?: T[] } | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.results)) return value.results;
  return [];
}

function asNumber(value: number | string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function newId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return prefix + hex;
}

function contentKey(env: Env): ContentKey {
  const raw = (env as unknown as Record<string, unknown>)["VAULT_KEY"];
  return resolveContentKey(typeof raw === "string" ? raw : undefined);
}

async function sealSecret(env: Env, plaintext: string): Promise<string> {
  const key = contentKey(env);
  if (key.state === "invalid") throw new NodeError(503, "保险库密钥配置不正确，暂时不能保存机密");
  if (key.state !== "on") throw new NodeError(503, "保险库密钥未配置，暂时不能保存机密");
  const sealed = await sealString(key, plaintext);
  if (sealed === null) throw new NodeError(503, "保险库密钥未配置，暂时不能保存机密");
  return sealed;
}

async function openSecret(env: Env, stored: string): Promise<string> {
  if (!stored) return "";
  const key = contentKey(env);
  if (key.state === "invalid") throw new NodeError(503, "保险库密钥配置不正确，无法查看");
  if (key.state !== "on") throw new NodeError(503, "保险库密钥未配置，无法查看");
  const plain = await decryptString(key.raw, stored);
  if (plain === null) throw new NodeError(500, "解密失败，保险库密钥可能不正确");
  return plain;
}

async function writeAudit(
  db: D1Database,
  fields: { targetId: string; actor: string; action: string; detail?: unknown },
  now: number,
): Promise<void> {
  await prepare(
    db,
    "INSERT INTO machines_audit (id, machine_id, actor, source, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      crypto.randomUUID(),
      fields.targetId,
      fields.actor,
      "panel",
      fields.action,
      fields.detail == null ? null : JSON.stringify(fields.detail),
      now,
    ],
  ).run();
}

function publicSubscription(row: SubRow): PublicSubscription {
  return {
    id: row.id,
    name: row.name,
    last_sync_at: asNumber(row.last_sync_at),
    last_error: row.last_error || "",
    created_at: asNumber(row.created_at) ?? 0,
    updated_at: asNumber(row.updated_at) ?? 0,
  };
}

function statusOf(value: string): "" | "ok" | "fail" {
  if (value === "ok" || value === "fail") return value;
  return "";
}

function publicNode(row: NodeRow): PublicNode {
  return {
    id: row.id,
    subscription_id: row.subscription_id,
    name: row.name,
    protocol: row.protocol,
    server: row.server,
    port: Number(row.port),
    note: row.note || "",
    last_status: statusOf(row.last_status),
    last_latency_ms: asNumber(row.last_latency_ms),
    last_test_at: asNumber(row.last_test_at),
    created_at: asNumber(row.created_at) ?? 0,
    updated_at: asNumber(row.updated_at) ?? 0,
  };
}

async function listSubscriptionRows(db: D1Database): Promise<SubRow[]> {
  // 列表不读 url_enc，订阅地址只在同步和 reveal 时按 id 取出。
  const result = await prepare(
    db,
    "SELECT id, name, '' AS url_enc, last_sync_at, last_error, created_at, updated_at FROM proxy_subscriptions ORDER BY created_at ASC, id ASC",
  ).all<SubRow>();
  return rowsOf(result);
}

async function listNodeRows(db: D1Database): Promise<NodeRow[]> {
  // 列表不读 raw_enc。原文只在复制链接时按 id 取出。
  const result = await prepare(
    db,
    "SELECT id, subscription_id, name, protocol, server, port, note, '' AS raw_enc, '' AS dedupe_key, last_status, last_latency_ms, last_test_at, created_at, updated_at FROM proxy_nodes ORDER BY created_at ASC, id ASC",
  ).all<NodeRow>();
  return rowsOf(result);
}

async function getSubscription(db: D1Database, id: string): Promise<SubRow | null> {
  return prepare(
    db,
    "SELECT id, name, url_enc, last_sync_at, last_error, created_at, updated_at FROM proxy_subscriptions WHERE id = ?",
    [id],
  ).first<SubRow>();
}

async function getNode(db: D1Database, id: string): Promise<NodeRow | null> {
  return prepare(
    db,
    "SELECT id, subscription_id, name, protocol, server, port, note, raw_enc, dedupe_key, last_status, last_latency_ms, last_test_at, created_at, updated_at FROM proxy_nodes WHERE id = ?",
    [id],
  ).first<NodeRow>();
}

export async function listNodeBoard(db: D1Database): Promise<{ subscriptions: PublicSubscription[]; nodes: PublicNode[] }> {
  const [subs, nodes] = await Promise.all([listSubscriptionRows(db), listNodeRows(db)]);
  return {
    subscriptions: subs.map(publicSubscription),
    nodes: nodes.map(publicNode),
  };
}

function assertName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new NodeError(400, "请填写名称");
  const name = value.trim();
  if (name.length > 60) throw new NodeError(400, "名称过长");
  return name;
}

function assertSubscriptionUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new NodeError(400, "请填写订阅地址");
  const urlText = value.trim();
  if (urlText.length > 2048) throw new NodeError(400, "订阅地址过长");
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new NodeError(400, "订阅地址不正确");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new NodeError(400, "订阅地址只支持 http 或 https");
  if (url.username || url.password) throw new NodeError(400, "订阅地址不正确");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::1" || host === "169.254.169.254" || /^127\./.test(host)) {
    throw new NodeError(400, "订阅地址不正确");
  }
  return urlText;
}

async function dedupeKeyOf(node: ParsedNode): Promise<string> {
  const server = node.server.trim().toLowerCase();
  return sha256Hex(`${node.protocol}|${server}|${node.port}|${node.secret}`);
}

function storable(node: ParsedNode): boolean {
  return (
    node.raw.length > 0 &&
    node.raw.length <= MAX_RAW_CHARS &&
    node.name.trim().length > 0 &&
    node.protocol.trim().length > 0 &&
    node.protocol.length <= 32 &&
    node.server.trim().length > 0 &&
    node.server.length <= 253 &&
    Number.isInteger(node.port) &&
    node.port >= 1 &&
    node.port <= 65535
  );
}

async function scopeRows(db: D1Database, subscriptionId: string | null): Promise<Array<{ id: string; dedupe_key: string }>> {
  const sql = subscriptionId
    ? "SELECT id, dedupe_key FROM proxy_nodes WHERE subscription_id = ?"
    : "SELECT id, dedupe_key FROM proxy_nodes WHERE subscription_id IS NULL";
  const result = await prepare(db, sql, subscriptionId ? [subscriptionId] : []).all<{ id: string; dedupe_key: string }>();
  return rowsOf(result);
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    const chunk = statements.slice(i, i + BATCH_SIZE);
    if (chunk.length) await db.batch(chunk);
  }
}

// 同一 dedupe_key 只留一行：已有行更新名称和密封原文，测活字段不动。
// removeMissing 为真时，这次集合里没有的旧行删掉（订阅同步）；手动导入只增改。
async function upsertParsed(
  db: D1Database,
  env: Env,
  subscriptionId: string | null,
  nodes: ParsedNode[],
  now: number,
  removeMissing: boolean,
): Promise<{ added: number; updated: number; removed: number; dropped: number }> {
  const usable = nodes.filter(storable);
  const dropped = nodes.length - usable.length;
  const existing = await scopeRows(db, subscriptionId);
  const byKey = new Map<string, Array<{ id: string; dedupe_key: string }>>();
  for (const row of existing) {
    const group = byKey.get(row.dedupe_key) ?? [];
    group.push(row);
    byKey.set(row.dedupe_key, group);
  }

  const collapsed = new Map<string, ParsedNode>();
  for (const node of usable) {
    collapsed.set(await dedupeKeyOf(node), node);
  }

  const statements: D1PreparedStatement[] = [];
  let added = 0;
  let updated = 0;
  const seen = new Set<string>();
  for (const [key, node] of collapsed) {
    seen.add(key);
    const sealed = await sealSecret(env, node.raw);
    const name = clip(node.name, 200);
    const protocol = node.protocol.trim().toLowerCase();
    const server = node.server.trim();
    const group = byKey.get(key) ?? [];
    const keep = group[0];
    if (keep) {
      updated++;
      statements.push(
        prepare(
          db,
          "UPDATE proxy_nodes SET name = ?, protocol = ?, server = ?, port = ?, raw_enc = ?, updated_at = ? WHERE id = ?",
          [name, protocol, server, node.port, sealed, now, keep.id],
        ),
      );
    } else {
      added++;
      statements.push(
        prepare(
          db,
          "INSERT INTO proxy_nodes (id, subscription_id, name, protocol, server, port, raw_enc, dedupe_key, last_status, last_latency_ms, last_test_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', NULL, NULL, ?, ?)",
          [newId("pnode_"), subscriptionId, name, protocol, server, node.port, sealed, key, now, now],
        ),
      );
    }
  }

  const removeIds = new Set<string>();
  if (removeMissing) {
    for (const row of existing) {
      if (!seen.has(row.dedupe_key)) removeIds.add(row.id);
    }
  }
  for (const [key, group] of byKey) {
    if (!seen.has(key)) continue;
    for (const extra of group.slice(1)) removeIds.add(extra.id);
  }
  for (const id of removeIds) {
    statements.push(prepare(db, "DELETE FROM proxy_nodes WHERE id = ?", [id]));
  }
  await runBatches(db, statements);
  return { added, updated, removed: removeIds.size, dropped };
}

async function markSync(db: D1Database, id: string, error: string, synced: boolean, now: number): Promise<void> {
  if (synced) {
    await prepare(db, "UPDATE proxy_subscriptions SET last_sync_at = ?, last_error = '', updated_at = ? WHERE id = ?", [now, now, id]).run();
    return;
  }
  await prepare(db, "UPDATE proxy_subscriptions SET last_error = ?, updated_at = ? WHERE id = ?", [clip(error, 300), now, id]).run();
}

function emptySyncMessage(skipped: number): string {
  if (skipped > 0) return `没有解析出节点，跳过 ${skipped} 条，已保留原列表`;
  return "没有解析出节点，已保留原列表";
}

async function fetchSubscriptionText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "*/*",
        "user-agent": CLASH_UA,
      },
    });
    if (!response.ok) throw new NodeError(502, `订阅返回 ${response.status}`);
    const declared = Number(response.headers.get("content-length") || "");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new NodeError(400, "订阅内容超过 1 MB");
    const text = await readLimitedText(response, MAX_BODY_BYTES);
    const head = text.trim().slice(0, 240).toLowerCase();
    if (head.startsWith("<!doctype") || head.startsWith("<html") || head.startsWith("<head")) {
      throw new NodeError(502, "订阅内容不是节点列表");
    }
    return text;
  } catch (error) {
    if (error instanceof NodeError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new NodeError(502, "订阅拉取超时");
    throw new NodeError(502, "订阅拉取失败");
  } finally {
    clearTimeout(timer);
  }
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new NodeError(400, "订阅内容超过 1 MB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function syncSubscription(db: D1Database, env: Env, id: string, now: number): Promise<{ subscription: PublicSubscription; sync: SyncReport }> {
  const row = await getSubscription(db, id);
  if (!row) throw new NodeError(404, "订阅不存在");
  let report: SyncReport;
  try {
    const url = await openSecret(env, row.url_enc);
    const text = await fetchSubscriptionText(url);
    const parsed = parseNodeText(text);
    const usable = parsed.nodes.filter(storable);
    const skipped = parsed.skipped + (parsed.nodes.length - usable.length);
    if (usable.length === 0) {
      const error = emptySyncMessage(skipped);
      await markSync(db, id, error, false, now);
      report = { ok: false, error, added: 0, updated: 0, removed: 0, skipped };
    } else {
      const counts = await upsertParsed(db, env, id, usable, now, true);
      await markSync(db, id, "", true, now);
      report = { ok: true, error: "", added: counts.added, updated: counts.updated, removed: counts.removed, skipped: skipped };
    }
  } catch (error) {
    const message = error instanceof NodeError ? error.message : "订阅拉取失败";
    await markSync(db, id, message, false, now).catch(() => undefined);
    report = { ok: false, error: message, added: 0, updated: 0, removed: 0, skipped: 0 };
  }
  const fresh = await getSubscription(db, id);
  if (!fresh) throw new NodeError(404, "订阅不存在");
  return { subscription: publicSubscription(fresh), sync: report };
}

export async function createSubscription(
  db: D1Database,
  env: Env,
  input: { name: unknown; url: unknown },
  now: number,
): Promise<{ subscription: PublicSubscription; sync: SyncReport }> {
  const name = assertName(input.name);
  const url = assertSubscriptionUrl(input.url);
  const id = newId("psub_");
  const sealed = await sealSecret(env, url);
  await prepare(
    db,
    "INSERT INTO proxy_subscriptions (id, name, url_enc, last_sync_at, last_error, created_at, updated_at) VALUES (?, ?, ?, NULL, '', ?, ?)",
    [id, name, sealed, now, now],
  ).run();
  return syncSubscription(db, env, id, now);
}

export async function updateSubscription(
  db: D1Database,
  env: Env,
  id: string,
  input: { name?: unknown; url?: unknown },
  now: number,
): Promise<PublicSubscription> {
  const row = await getSubscription(db, id);
  if (!row) throw new NodeError(404, "订阅不存在");
  let name = row.name;
  if (input.name !== undefined) name = assertName(input.name);
  let urlEnc = row.url_enc;
  if (typeof input.url === "string" && input.url.trim()) urlEnc = await sealSecret(env, assertSubscriptionUrl(input.url));
  await prepare(db, "UPDATE proxy_subscriptions SET name = ?, url_enc = ?, updated_at = ? WHERE id = ?", [name, urlEnc, now, id]).run();
  const fresh = await getSubscription(db, id);
  if (!fresh) throw new NodeError(404, "订阅不存在");
  return publicSubscription(fresh);
}

export async function deleteSubscription(db: D1Database, id: string): Promise<{ name: string }> {
  const row = await getSubscription(db, id);
  if (!row) throw new NodeError(404, "订阅不存在");
  await prepare(db, "DELETE FROM proxy_nodes WHERE subscription_id = ?", [id]).run();
  await prepare(db, "DELETE FROM proxy_subscriptions WHERE id = ?", [id]).run();
  return { name: row.name };
}

export async function revealSubscriptionUrl(
  db: D1Database,
  env: Env,
  id: string,
  actor: string,
  now: number,
): Promise<{ name: string; url: string }> {
  const row = await getSubscription(db, id);
  if (!row) throw new NodeError(404, "订阅不存在");
  await writeAudit(db, { targetId: id, actor, action: "reveal", detail: { kind: "proxy_subscription", name: row.name } }, now);
  const url = await openSecret(env, row.url_enc);
  return { name: row.name, url };
}

export async function importManualNodes(db: D1Database, env: Env, text: unknown, now: number): Promise<ImportReport> {
  if (typeof text !== "string" || !text.trim()) throw new NodeError(400, "请粘贴节点或订阅内容");
  if (text.length > MAX_BODY_BYTES) throw new NodeError(400, "内容超过 1 MB");
  const parsed = parseNodeText(text);
  const usable = parsed.nodes.filter(storable);
  const skipped = parsed.skipped + (parsed.nodes.length - usable.length);
  if (!usable.length) return { added: 0, updated: 0, skipped };
  const counts = await upsertParsed(db, env, null, usable, now, false);
  return { added: counts.added, updated: counts.updated, skipped };
}

export async function deleteNode(db: D1Database, id: string): Promise<{ name: string }> {
  const row = await getNode(db, id);
  if (!row) throw new NodeError(404, "节点不存在");
  await prepare(db, "DELETE FROM proxy_nodes WHERE id = ?", [id]).run();
  return { name: row.name };
}

// 备注是节点自己的展示信息：同步对账不写这一列，改备注也不动其它字段。
export async function updateNodeNote(
  db: D1Database,
  id: string,
  input: { note?: unknown },
  now: number,
): Promise<PublicNode> {
  const row = await getNode(db, id);
  if (!row) throw new NodeError(404, "节点不存在");
  if (typeof input.note !== "string") throw new NodeError(400, "备注格式不正确");
  const note = input.note.trim();
  if (note.length > 200) throw new NodeError(400, "备注过长，最多 200 字");
  await prepare(db, "UPDATE proxy_nodes SET note = ?, updated_at = ? WHERE id = ?", [note, now, id]).run();
  const fresh = await getNode(db, id);
  if (!fresh) throw new NodeError(404, "节点不存在");
  return publicNode(fresh);
}

export async function copyNodeRaw(
  db: D1Database,
  env: Env,
  id: string,
  actor: string,
  now: number,
): Promise<{ name: string; raw: string }> {
  const row = await getNode(db, id);
  if (!row) throw new NodeError(404, "节点不存在");
  await writeAudit(db, { targetId: id, actor, action: "copy", detail: { kind: "proxy_node", name: row.name } }, now);
  const raw = await openSecret(env, row.raw_enc);
  return { name: row.name, raw };
}

// TCP 连通性：connect() 的 opened 成立即可达，耗时记为延迟。超时或拒绝都是不可达。
export async function probeTcp(server: string, port: number, timeoutMs = TEST_TIMEOUT_MS): Promise<{ ok: boolean; latencyMs: number | null }> {
  const host = server.trim();
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, latencyMs: null };
  const started = Date.now();
  let socket: ReturnType<typeof connect> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    socket = connect({ hostname: host, port });
    await Promise.race([
      socket.opened,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return { ok: true, latencyMs: Math.max(0, Date.now() - started) };
  } catch {
    return { ok: false, latencyMs: null };
  } finally {
    if (timer) clearTimeout(timer);
    if (socket) {
      try {
        await socket.close();
      } catch {
        // 没连上时关闭也会失败，结果已经是不可达。
      }
    }
  }
}

async function writeProbe(db: D1Database, id: string, ok: boolean, latencyMs: number | null, at: number): Promise<void> {
  await prepare(
    db,
    "UPDATE proxy_nodes SET last_status = ?, last_latency_ms = ?, last_test_at = ?, updated_at = ? WHERE id = ?",
    [ok ? "ok" : "fail", ok ? latencyMs : null, at, at, id],
  ).run();
}

export async function testNode(db: D1Database, id: string): Promise<{ node: PublicNode; reachable: boolean; latency_ms: number | null }> {
  const row = await getNode(db, id);
  if (!row) throw new NodeError(404, "节点不存在");
  const result = await probeTcp(row.server, Number(row.port));
  const at = Date.now();
  await writeProbe(db, id, result.ok, result.latencyMs, at);
  const fresh = await getNode(db, id);
  return {
    node: publicNode(fresh ?? { ...row, last_status: result.ok ? "ok" : "fail", last_latency_ms: result.ok ? result.latencyMs : null, last_test_at: at, updated_at: at }),
    reachable: result.ok,
    latency_ms: result.ok ? result.latencyMs : null,
  };
}

export async function testAllNodes(db: D1Database): Promise<{ reachable: number; unreachable: number }> {
  const rows = rowsOf(
    await prepare(db, "SELECT id, server, port FROM proxy_nodes ORDER BY created_at ASC, id ASC").all<{ id: string; server: string; port: number }>(),
  );
  let reachable = 0;
  let unreachable = 0;
  let cursor = 0;
  // 连接最多 8 路同时进行；落库串行，避免同一条 D1 上叠写。
  let writeQueue: Promise<unknown> = Promise.resolve();
  function enqueueWrite(task: () => Promise<void>): Promise<void> {
    const run = writeQueue.then(task, task);
    writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  const workers = Math.min(TEST_CONCURRENCY, rows.length);
  async function run(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= rows.length) return;
      const row = rows[index];
      if (!row) return;
      const result = await probeTcp(row.server, Number(row.port));
      await enqueueWrite(() => writeProbe(db, row.id, result.ok, result.latencyMs, Date.now()));
      if (result.ok) reachable++;
      else unreachable++;
    }
  }
  if (workers > 0) await Promise.all(Array.from({ length: workers }, () => run()));
  return { reachable, unreachable };
}
