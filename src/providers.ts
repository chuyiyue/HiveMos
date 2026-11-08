// Provider connections for the cloud tab (phase 2, Roye 2026-11-08).
// A connection stores one provider account's API credentials — sealed as a
// JSON blob under VAULT_KEY with the same envelope as machine secrets — and
// owns the cloud devices imported from it (machines rows carrying
// connection_id / remote_id). The local display name of a device is the
// machine's own `name` (a local alias); the provider-side name lives in
// remote_name and is refreshed by sync, never overwriting the alias.
//
// Adapters share one shape: given a config, list the account's devices in a
// normalized form. "Test connection" and "sync" are the same call — a test
// only counts as passed when the device list actually comes back. Adding a
// provider means adding one adapter function and one form description in
// the panel; nothing else changes.
//
// Deleting a connection detaches its devices (they stay as ordinary cloud
// entries with connection_id cleared); deleting a device never touches the
// connection. Automatic sync has the same Cron-quota boundary as server
// probing: there is deliberately no scheduled sync — the panel syncs on
// demand, and a scheduled() call site can reuse syncAllConnections later.

import { prepare } from "./registry";
import type { D1Database } from "./env";
import type { ContentKey } from "./crypto";
import { MachineError, machinePublic, openMachineSecret, readGroupId, sealMachineSecret, type PublicMachine } from "./machines";

export interface ProviderDevice {
  remoteId: string;
  name: string;
  status: string; // normalized: "running" | "offline"
  state?: string; // raw provider state, e.g. InstaBox "suspended"
  os: string;
  spec: string;
  ip: string;
}

export type ProviderConfig = Record<string, string>;

export const PROVIDER_LABELS: Record<string, string> = {
  instabox: "InstaBox",
  huawei: "华为云",
  mcp: "MCP 通用",
};

interface ConnectionRow {
  id: string;
  provider: string;
  name: string;
  config_enc: string;
  config_tail: string;
  last_test_at: number | null;
  last_test_ok: number;
  last_error: string;
  created_at: number;
  updated_at: number;
}

export interface PublicConnection {
  id: string;
  provider: string;
  provider_label: string;
  name: string;
  config_tail: string;
  device_count: number;
  last_test_at: number | null;
  last_test_ok: boolean;
  last_error: string;
  created_at: number;
  updated_at: number;
}

const CONN_COLUMNS = "id, provider, name, config_enc, config_tail, last_test_at, last_test_ok, last_error, created_at, updated_at";

function newId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return prefix + hex;
}

function rowsOf<T>(value: { results?: T[] } | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.results)) return value.results;
  return [];
}

async function getConnection(db: D1Database, id: string): Promise<ConnectionRow | null> {
  const rows = rowsOf<ConnectionRow>(await prepare(db, "SELECT " + CONN_COLUMNS + " FROM provider_connections WHERE id = ?", [id]).all<ConnectionRow>());
  return rows[0] ?? null;
}

export async function listConnections(db: D1Database): Promise<PublicConnection[]> {
  const rows = rowsOf<ConnectionRow>(await prepare(db, "SELECT " + CONN_COLUMNS + " FROM provider_connections ORDER BY created_at ASC, rowid ASC", []).all<ConnectionRow>());
  const counts = rowsOf<{ connection_id: string; n: number }>(
    await prepare(db, "SELECT connection_id, COUNT(*) AS n FROM machines WHERE connection_id != '' GROUP BY connection_id", []).all<{ connection_id: string; n: number }>(),
  );
  const byId = new Map(counts.map((row) => [row.connection_id, row.n]));
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    provider_label: PROVIDER_LABELS[row.provider] ?? row.provider,
    name: row.name,
    config_tail: row.config_tail,
    device_count: byId.get(row.id) ?? 0,
    last_test_at: row.last_test_at,
    last_test_ok: row.last_test_ok === 1,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

// ---------------------------------------------------------------------------
// Config validation. Unknown providers and missing fields are input errors
// (400); anything the provider itself does wrong surfaces as 502 with the
// provider-facing reason.

function readField(input: Record<string, unknown>, field: string, label: string, required: boolean, max = 500): string {
  const value = input[field];
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    if (required) throw new MachineError(400, "请填写" + label);
    return "";
  }
  if (text.length > max) throw new MachineError(400, label + "太长");
  return text;
}

export function readProviderConfig(provider: string, input: Record<string, unknown>): ProviderConfig {
  if (provider === "huawei") {
    return {
      accessKey: readField(input, "accessKey", "Access Key", true, 200),
      secretKey: readField(input, "secretKey", "Secret Key", true, 500),
      region: readField(input, "region", "区域", true, 60),
      projectId: readField(input, "projectId", "Project ID", true, 200),
      endpoint: readField(input, "endpoint", "接口地址", false, 300),
    };
  }
  if (provider === "instabox") {
    return {
      apiKey: readField(input, "apiKey", "API 密钥", true, 500),
      endpoint: readField(input, "endpoint", "接口地址", false, 300),
    };
  }
  if (provider === "mcp") {
    const endpoint = readField(input, "endpoint", "MCP 端点", true, 500);
    if (!/^https?:\/\//i.test(endpoint)) throw new MachineError(400, "MCP 端点需要以 http:// 或 https:// 开头");
    return {
      endpoint,
      token: readField(input, "token", "令牌", false, 2000),
      toolName: readField(input, "toolName", "设备列表工具名", true, 200),
    };
  }
  throw new MachineError(400, "暂不支持这个服务商");
}

function mainSecretOf(provider: string, config: ProviderConfig): string {
  if (provider === "instabox") return config["apiKey"] ?? "";
  if (provider === "huawei") return config["secretKey"] ?? "";
  if (provider === "mcp") return config["token"] ?? "";
  return "";
}

function defaultConnectionName(provider: string, config: ProviderConfig): string {
  if (provider === "instabox") return "InstaBox 账号";
  if (provider === "huawei") return "华为云 · " + (config["region"] || "");
  if (provider === "mcp") {
    try {
      return "MCP · " + new URL(config["endpoint"] || "").host;
    } catch {
      return "MCP 连接";
    }
  }
  return provider;
}

function normalizeStatus(raw: string): string {
  const value = (raw || "").trim().toLowerCase();
  if (!value) return "offline";
  if (["active", "running", "up", "on", "ok", "online", "started", "available", "in-use", "building", "creating", "booting"].includes(value)) return "running";
  if (value.includes("run") || value.includes("active")) return "running";
  return "offline";
}

// ---------------------------------------------------------------------------
// Adapters

export async function fetchProviderDevices(provider: string, config: ProviderConfig): Promise<ProviderDevice[]> {
  if (provider === "instabox") return instaboxListDevices(config);
  if (provider === "huawei") return huaweiListDevices(config);
  if (provider === "mcp") return mcpListDevices(config);
  throw new MachineError(400, "暂不支持这个服务商");
}

// ---- InstaBox (X-API-Key, REST /v1) ----
// The vendor this board is built around: an account API key lists the
// account's boxes (GET /v1/machines, cursor-paginated). Boxes have no
// public IP or OS in the API view — name, state and spec are what syncs.

async function instaboxFetch(config: ProviderConfig, path: string): Promise<unknown> {
  const base = (config["endpoint"] || "https://api.instabox.sh").replace(/\/+$/, "");
  let response: Response;
  try {
    response = await fetch(base + path, {
      headers: { "X-API-Key": config["apiKey"] ?? "", accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new MachineError(502, "连接 InstaBox 失败，请稍后重试");
  }
  if (response.status === 401 || response.status === 403) {
    throw new MachineError(502, "InstaBox：API 密钥不正确或无权限");
  }
  if (response.status === 429) throw new MachineError(502, "InstaBox：请求过于频繁，请稍后重试");
  if (!response.ok) throw new MachineError(502, "InstaBox 返回异常（HTTP " + response.status + "）");
  return response.json().catch(() => null);
}

async function instaboxListDevices(config: ProviderConfig): Promise<ProviderDevice[]> {
  const devices: ProviderDevice[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const data = (await instaboxFetch(config, "/v1/machines?" + query.toString())) as {
      machines?: Array<Record<string, unknown>>;
      nextCursor?: string | null;
    } | null;
    if (!data || !Array.isArray(data.machines)) {
      throw new MachineError(502, "InstaBox 返回了无法识别的响应");
    }
    for (const raw of data.machines) {
      const spec = (raw.spec ?? {}) as Record<string, unknown>;
      const vcpus = Number(spec.vcpus) || 0;
      const memGiB = (Number(spec.memMiB) || 0) / 1024;
      const state = String(raw.state ?? "");
      devices.push({
        remoteId: String(raw.id ?? ""),
        name: String(raw.name ?? raw.id ?? ""),
        status: ["running", "starting", "resuming", "creating"].includes(state) ? "running" : "offline",
        state,
        os: "",
        spec: vcpus || memGiB ? vcpus + " 核 / " + (Number.isInteger(memGiB) ? String(memGiB) : memGiB.toFixed(1)) + " GB" : "",
        ip: "",
      });
    }
    if (!data.nextCursor) break;
    cursor = String(data.nextCursor);
  }
  return devices.filter((device) => device.remoteId !== "");
}

// ---- Huawei Cloud ECS (AK/SK, SDK-HMAC-SHA256) ----

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", utf8(key) as unknown as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, utf8(data) as unknown as BufferSource);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sdkDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    String(now.getUTCFullYear()) +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    "T" +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds()) +
    "Z"
  );
}

function canonicalUri(path: string): string {
  const encoded = path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return encoded.endsWith("/") ? encoded : encoded + "/";
}

function canonicalQuery(params: Array<[string, string]>): string {
  return params
    .slice()
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");
}

// Builds the signed header set for one Huawei request. Exported so the
// signing can be verified against a mock that recomputes it independently.
export async function huaweiAuthorization(config: ProviderConfig, method: string, url: URL, bodyText: string, now: Date): Promise<Record<string, string>> {
  const date = sdkDate(now);
  const signedHeaders = "host;x-sdk-date";
  const canonicalHeaders = "host:" + url.host + "\n" + "x-sdk-date:" + date + "\n";
  const query = canonicalQuery([...url.searchParams.entries()]);
  const canonicalRequest = [method.toUpperCase(), canonicalUri(url.pathname), query, canonicalHeaders, signedHeaders, await sha256Hex(bodyText)].join("\n");
  const stringToSign = "SDK-HMAC-SHA256\n" + date + "\n" + (await sha256Hex(canonicalRequest));
  const signature = await hmacSha256Hex(config["secretKey"] ?? "", stringToSign);
  return {
    Authorization: "SDK-HMAC-SHA256 Access=" + (config["accessKey"] ?? "") + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature,
    "X-Sdk-Date": date,
  };
}

async function huaweiListDevices(config: ProviderConfig): Promise<ProviderDevice[]> {
  const base = (config["endpoint"] || "https://ecs." + config["region"] + ".myhuaweicloud.com").replace(/\/+$/, "");
  const url = new URL(base + "/v1/" + encodeURIComponent(config["projectId"] ?? "") + "/cloudservers/detail");
  url.searchParams.set("limit", "100");
  const headers = await huaweiAuthorization(config, "GET", url, "", new Date());
  let response: Response;
  try {
    response = await fetch(url.toString(), { method: "GET", headers });
  } catch {
    throw new MachineError(502, "无法连接到华为云接口，请检查网络与区域");
  }
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new MachineError(502, "华为云拒绝了请求（" + response.status + "），请检查 AK、SK、区域与 Project ID");
    }
    throw new MachineError(502, "华为云接口返回 " + response.status + "：" + text.slice(0, 160));
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new MachineError(502, "华为云接口返回的内容不是 JSON");
  }
  const servers = (data as { servers?: unknown[] } | null)?.servers;
  if (!Array.isArray(servers)) throw new MachineError(502, "华为云接口返回里没有设备列表");
  return servers.map((raw) => {
    const server = raw as Record<string, unknown>;
    const flavor = (server["flavor"] ?? {}) as Record<string, unknown>;
    const vcpus = Number(flavor["vcpus"] ?? 0);
    const ramMb = Number(flavor["ram"] ?? 0);
    let spec = "";
    if (vcpus > 0 && ramMb > 0) spec = vcpus + " 核 / " + Math.round((ramMb / 1024) * 10) / 10 + " GB";
    else if (typeof flavor["id"] === "string") spec = flavor["id"] as string;
    let ip = "";
    const addresses = (server["addresses"] ?? {}) as Record<string, unknown>;
    const flat: Array<Record<string, unknown>> = [];
    for (const list of Object.values(addresses)) {
      if (Array.isArray(list)) for (const entry of list) flat.push(entry as Record<string, unknown>);
    }
    const floating = flat.find((entry) => entry["OS-EXT-IPS:type"] === "floating" && typeof entry["addr"] === "string");
    const anyAddr = flat.find((entry) => typeof entry["addr"] === "string");
    if (floating) ip = String(floating["addr"]);
    else if (anyAddr) ip = String(anyAddr["addr"]);
    const image = (server["image"] ?? {}) as Record<string, unknown>;
    const metadata = (server["metadata"] ?? {}) as Record<string, unknown>;
    return {
      remoteId: String(server["id"] ?? ""),
      name: String(server["name"] ?? ""),
      status: normalizeStatus(String(server["status"] ?? "")),
      os: String(image["name"] ?? metadata["image_name"] ?? ""),
      spec,
      ip,
    };
  }).filter((device) => device.remoteId);
}

// ---- Generic MCP over HTTP (initialize + tools/list + tools/call) ----

interface McpReply {
  json: Record<string, unknown> | null;
  sessionId: string;
}

async function mcpRpc(config: ProviderConfig, method: string, params: unknown, id: number | null, sessionId: string): Promise<McpReply> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (config["token"]) headers["authorization"] = "Bearer " + config["token"];
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const body = id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };
  let response: Response;
  try {
    response = await fetch(config["endpoint"] ?? "", { method: "POST", headers, body: JSON.stringify(body) });
  } catch {
    throw new MachineError(502, "无法连接到 MCP 端点，请检查地址与网络");
  }
  const nextSession = response.headers.get("mcp-session-id") || sessionId;
  const text = await response.text();
  if (!response.ok) {
    throw new MachineError(502, "MCP 端点返回 " + response.status + "：" + text.slice(0, 160));
  }
  const contentType = response.headers.get("content-type") || "";
  let json: Record<string, unknown> | null = null;
  if (contentType.includes("text/event-stream")) {
    // SSE: take the JSON-RPC message that answers this request (matching id,
    // or the last one carrying a result/error).
    let fallback: Record<string, unknown> | null = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        const parsed = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        if (parsed && typeof parsed === "object" && ("result" in parsed || "error" in parsed)) {
          if (id !== null && parsed["id"] === id) { json = parsed; break; }
          fallback = parsed;
        }
      } catch { /* not a JSON data line */ }
    }
    json = json ?? fallback;
  } else if (text.trim()) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new MachineError(502, "MCP 端点返回的内容不是 JSON");
    }
  }
  return { json, sessionId: nextSession };
}

function mcpResultOrThrow(reply: McpReply, what: string): Record<string, unknown> {
  const json = reply.json;
  if (!json) throw new MachineError(502, "MCP " + what + "没有返回内容");
  const error = json["error"] as { message?: string } | undefined;
  if (error) throw new MachineError(502, "MCP " + what + "失败：" + (error.message || "未知错误"));
  const result = json["result"];
  if (!result || typeof result !== "object") throw new MachineError(502, "MCP " + what + "没有返回 result");
  return result as Record<string, unknown>;
}

function findDeviceArray(value: unknown, depth: number): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object" || depth > 3) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["devices", "items", "list", "servers", "instances", "hosts", "data", "result", "content"]) {
    const inner = findDeviceArray(record[key], depth + 1);
    if (inner) return inner;
  }
  return null;
}

function pickField(record: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

async function mcpListDevices(config: ProviderConfig): Promise<ProviderDevice[]> {
  const init = await mcpRpc(config, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "HiveMos", version: "1" },
  }, 1, "");
  mcpResultOrThrow(init, "初始化");
  const sessionId = init.sessionId;
  await mcpRpc(config, "notifications/initialized", {}, null, sessionId).catch(() => undefined);
  const toolsReply = await mcpRpc(config, "tools/list", {}, 2, sessionId);
  const toolsResult = mcpResultOrThrow(toolsReply, "工具列表");
  const tools = Array.isArray(toolsResult["tools"]) ? (toolsResult["tools"] as Array<Record<string, unknown>>) : [];
  if (tools.length && !tools.some((tool) => tool["name"] === config["toolName"])) {
    throw new MachineError(502, "这个 MCP 上没有名为「" + config["toolName"] + "」的工具");
  }
  const callReply = await mcpRpc(config, "tools/call", { name: config["toolName"], arguments: {} }, 3, sessionId);
  const callResult = mcpResultOrThrow(callReply, "设备工具调用");
  if (callResult["isError"] === true) {
    const content = Array.isArray(callResult["content"]) ? (callResult["content"] as Array<Record<string, unknown>>) : [];
    const message = content.map((part) => (typeof part["text"] === "string" ? part["text"] : "")).join(" ").trim();
    throw new MachineError(502, "设备工具返回错误：" + (message || "未知错误"));
  }
  let payload: unknown = callResult["structuredContent"];
  if (payload === undefined) {
    const content = Array.isArray(callResult["content"]) ? (callResult["content"] as Array<Record<string, unknown>>) : [];
    for (const part of content) {
      if (part["type"] === "text" && typeof part["text"] === "string") {
        try {
          payload = JSON.parse(part["text"]);
          break;
        } catch { /* try the next part */ }
      }
    }
  }
  const list = findDeviceArray(payload, 0);
  if (!list) throw new MachineError(502, "设备工具的返回里没有找到设备列表，请检查工具名与返回结构");
  return list
    .map((raw) => {
      const record = (raw ?? {}) as Record<string, unknown>;
      return {
        remoteId: pickField(record, ["id", "remote_id", "instance_id", "server_id", "uuid"]),
        name: pickField(record, ["name", "instance_name", "server_name", "hostname", "title"]),
        status: normalizeStatus(pickField(record, ["status", "state"])),
        os: pickField(record, ["os", "image", "os_name", "system"]),
        spec: pickField(record, ["spec", "flavor", "instance_type", "plan", "size"]),
        ip: pickField(record, ["ip", "ip_address", "public_ip", "private_ip", "address"]),
      };
    })
    .filter((device) => device.remoteId);
}

// ---------------------------------------------------------------------------
// Connection operations

export interface TestOutcome {
  ok: boolean;
  error?: string;
  devices?: ProviderDevice[];
}

export async function testAdHocConnection(provider: string, configInput: Record<string, unknown>): Promise<TestOutcome> {
  try {
    const config = readProviderConfig(provider, configInput);
    const devices = await fetchProviderDevices(provider, config);
    return { ok: true, devices };
  } catch (error) {
    if (error instanceof MachineError) return { ok: false, error: error.message };
    throw error;
  }
}

async function recordTest(db: D1Database, id: string, ok: boolean, error: string, now: number): Promise<void> {
  await prepare(db, "UPDATE provider_connections SET last_test_at = ?, last_test_ok = ?, last_error = ?, updated_at = ? WHERE id = ?", [now, ok ? 1 : 0, error, now, id]).run();
}

async function storedConfig(db: D1Database, key: ContentKey, row: ConnectionRow): Promise<ProviderConfig> {
  const plain = await openMachineSecret(key, row.config_enc);
  try {
    return JSON.parse(plain) as ProviderConfig;
  } catch {
    throw new MachineError(500, "连接配置解密后无法解析");
  }
}

export async function testStoredConnection(db: D1Database, key: ContentKey, id: string, now: number): Promise<TestOutcome> {
  const row = await getConnection(db, id);
  if (!row) throw new MachineError(404, "连接不存在");
  try {
    const config = await storedConfig(db, key, row);
    const devices = await fetchProviderDevices(row.provider, config);
    await recordTest(db, id, true, "", now);
    return { ok: true, devices };
  } catch (error) {
    if (error instanceof MachineError) {
      await recordTest(db, id, false, error.message, now);
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

const MACHINE_INSERT =
  "INSERT INTO machines (id, kind, name, region, spec, description, version, status, binding, last_heartbeat_at, note, hostname, os, ip, ssh_host, ssh_port, ssh_user, auth_type, ssh_secret_enc, ssh_tail, vendor, access_note, cf_account_id, api_token_enc, api_token_tail, connection_id, remote_id, remote_name, remote_state, last_sync_at, group_id, created_at, updated_at) VALUES (?, 'cloud', ?, ?, ?, '', '', ?, '未绑定', NULL, '', '', ?, ?, '', 22, '', 'password', '', '', ?, '', '', '', '', ?, ?, ?, ?, ?, ?, ?, ?)";

export async function createConnectionWithDevices(
  db: D1Database,
  key: ContentKey,
  input: { provider: string; name?: string; config: Record<string, unknown>; deviceIds: string[]; groupId?: unknown },
  actor: string,
  now: number,
): Promise<{ connection: PublicConnection; machines: PublicMachine[] }> {
  const provider = input.provider;
  const groupId = await readGroupId(db, input.groupId);
  const config = readProviderConfig(provider, input.config);
  // Saving re-lists from the provider: the client picks remote ids only, so
  // device facts can never be fabricated by the panel request.
  const devices = await fetchProviderDevices(provider, config);
  const wanted = new Set(input.deviceIds);
  const selected = devices.filter((device) => wanted.has(device.remoteId));
  if (!selected.length) throw new MachineError(400, "请至少勾选一台设备");
  const label = PROVIDER_LABELS[provider] ?? provider;
  const name = (input.name ?? "").trim() || defaultConnectionName(provider, config);
  const connectionId = newId("cn_");
  const configEnc = await sealMachineSecret(key, JSON.stringify(config));
  const tail = mainSecretOf(provider, config).slice(-4);
  await prepare(
    db,
    "INSERT INTO provider_connections (id, provider, name, config_enc, config_tail, last_test_at, last_test_ok, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, '', ?, ?)",
    [connectionId, provider, name, configEnc, tail, now, now, now],
  ).run();
  const created: PublicMachine[] = [];
  for (const device of selected) {
    const machineId = newId("pc_");
    await prepare(db, MACHINE_INSERT, [
      machineId,
      device.name || device.remoteId,
      provider === "huawei" ? config["region"] ?? "" : "",
      device.spec,
      device.status,
      device.os,
      device.ip,
      label,
      connectionId,
      device.remoteId,
      device.name,
      device.state ?? null,
      now,
      groupId,
      now,
      now,
    ]).run();
    await prepare(db, "INSERT INTO machines_audit (id, machine_id, actor, source, action, detail, created_at) VALUES (?, ?, ?, 'panel', 'create', ?, ?)", [
      crypto.randomUUID(),
      machineId,
      actor,
      JSON.stringify({ via: "provider_import", provider, remote_id: device.remoteId }),
      now,
    ]).run();
    const rows = rowsOf<Record<string, unknown>>(await prepare(db, "SELECT * FROM machines WHERE id = ?", [machineId]).all());
    if (rows[0]) created.push(machinePublic(rows[0] as never));
  }
  const connections = await listConnections(db);
  const connection = connections.find((entry) => entry.id === connectionId);
  if (!connection) throw new MachineError(500, "连接保存后读取失败");
  return { connection, machines: created };
}

export async function syncConnection(db: D1Database, key: ContentKey, id: string, now: number): Promise<{ updated: number; missing: number; devices: ProviderDevice[] }> {
  const row = await getConnection(db, id);
  if (!row) throw new MachineError(404, "连接不存在");
  const config = await storedConfig(db, key, row);
  let devices: ProviderDevice[];
  try {
    devices = await fetchProviderDevices(row.provider, config);
    await recordTest(db, id, true, "", now);
  } catch (error) {
    if (error instanceof MachineError) await recordTest(db, id, false, error.message, now);
    throw error;
  }
  const byRemote = new Map(devices.map((device) => [device.remoteId, device]));
  const locals = rowsOf<{ id: string; remote_id: string }>(
    await prepare(db, "SELECT id, remote_id FROM machines WHERE connection_id = ?", [id]).all<{ id: string; remote_id: string }>(),
  );
  let updated = 0;
  let missing = 0;
  for (const local of locals) {
    const remote = byRemote.get(local.remote_id);
    if (!remote) {
      missing++;
      continue;
    }
    // The local alias (machines.name) is never overwritten by a sync.
    await prepare(db, "UPDATE machines SET os = ?, spec = ?, ip = ?, status = ?, remote_name = ?, remote_state = ?, last_sync_at = ?, updated_at = ? WHERE id = ?", [
      remote.os,
      remote.spec,
      remote.ip,
      remote.status,
      remote.name,
      remote.state ?? null,
      now,
      now,
      local.id,
    ]).run();
    updated++;
  }
  return { updated, missing, devices };
}

export async function deleteConnection(db: D1Database, id: string, now: number): Promise<void> {
  const row = await getConnection(db, id);
  if (!row) throw new MachineError(404, "连接不存在");
  // Detach, don't delete: imported devices stay as ordinary cloud entries.
  await prepare(db, "UPDATE machines SET connection_id = '', updated_at = ? WHERE connection_id = ?", [now, id]).run();
  await prepare(db, "DELETE FROM provider_connections WHERE id = ?", [id]).run();
}

// Cron note: once the account's cron quota allows a trigger, a scheduled
// handler can call this to refresh every connection; until then sync is
// manual from the panel (same boundary as server probing).
export async function syncAllConnections(db: D1Database, key: ContentKey, now: number): Promise<void> {
  const rows = rowsOf<ConnectionRow>(await prepare(db, "SELECT " + CONN_COLUMNS + " FROM provider_connections", []).all<ConnectionRow>());
  for (const row of rows) {
    try {
      await syncConnection(db, key, row.id, Date.now());
    } catch {
      // One bad connection must not stop the others.
    }
  }
  void now;
}


// ---------------------------------------------------------------------------
// Per-machine operations (power / public ports / keepalive)
// InstaBox natively exposes power (POST /v1/machines/:id/<action> with an
// Idempotency-Key) and public ports (/v1/machines/:id/ports). Keepalive
// policy is stored locally; execution rides the scheduled sweep and, as an
// interim while cron slots are scarce, manual connection syncs.

export interface ProviderPort {
  id: string;
  port: number;
  name: string;
  url: string;
  createdAt: string;
}

async function instaboxRequest(
  config: ProviderConfig,
  path: string,
  init?: { method?: string; body?: unknown; idempotencyKey?: string },
): Promise<unknown> {
  const base = (config["endpoint"] || "https://api.instabox.sh").replace(/\/+$/, "");
  const headers: Record<string, string> = { "X-API-Key": config["apiKey"] ?? "", accept: "application/json" };
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  if (init?.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  let response: Response;
  try {
    response = await fetch(base + path, {
      method: init?.method || "GET",
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new MachineError(502, "连接 InstaBox 失败，请稍后重试");
  }
  if (response.status === 401 || response.status === 403) {
    throw new MachineError(502, "InstaBox：API 密钥不正确或权限不足（此操作需要带 machines:write 权限的密钥）");
  }
  if (response.status === 429) throw new MachineError(502, "InstaBox：请求过于频繁或额度受限，请稍后重试");
  if (!response.ok) throw new MachineError(502, "InstaBox 返回异常（HTTP " + response.status + "）");
  return response.json().catch(() => null);
}

interface MachineConnContext {
  provider: string;
  config: ProviderConfig;
  remoteId: string;
}

async function machineConnContext(db: D1Database, key: ContentKey, machineId: string): Promise<MachineConnContext> {
  const rows = rowsOf<{ connection_id: string; remote_id: string }>(
    await prepare(db, "SELECT connection_id, remote_id FROM machines WHERE id = ?", [machineId]).all<{ connection_id: string; remote_id: string }>(),
  );
  const machine = rows[0];
  if (!machine) throw new MachineError(404, "云主机不存在");
  if (!machine.connection_id) throw new MachineError(400, "这台云主机不是接入设备，没有来源连接");
  const conn = await getConnection(db, machine.connection_id);
  if (!conn) throw new MachineError(404, "来源连接不存在");
  const config = await storedConfig(db, key, conn);
  return { provider: conn.provider, config, remoteId: machine.remote_id };
}

function requireInstabox(ctx: MachineConnContext): void {
  if (ctx.provider !== "instabox") throw new MachineError(400, "该来源暂不支持此操作");
}

export async function providerPower(db: D1Database, key: ContentKey, machineId: string, action: string): Promise<void> {
  if (!["start", "stop", "suspend", "resume"].includes(action)) throw new MachineError(400, "操作不正确");
  const ctx = await machineConnContext(db, key, machineId);
  requireInstabox(ctx);
  await instaboxRequest(ctx.config, "/v1/machines/" + encodeURIComponent(ctx.remoteId) + "/" + action, {
    method: "POST",
    idempotencyKey: crypto.randomUUID(),
  });
}

function portView(raw: unknown): ProviderPort | null {
  const p = (raw ?? {}) as Record<string, unknown>;
  const port = Number(p.port);
  if (!Number.isInteger(port) || port <= 0) return null;
  return {
    id: String(p.id ?? ""),
    port,
    name: String(p.name ?? ""),
    url: String(p.url ?? ""),
    createdAt: String(p.createdAt ?? ""),
  };
}

export async function providerPortsList(
  db: D1Database,
  key: ContentKey,
  machineId: string,
): Promise<{ enabled: boolean; ports: ProviderPort[] }> {
  const ctx = await machineConnContext(db, key, machineId);
  requireInstabox(ctx);
  const raw = (await instaboxRequest(ctx.config, "/v1/machines/" + encodeURIComponent(ctx.remoteId) + "/ports")) as {
    enabled?: unknown;
    ports?: unknown[];
  } | null;
  if (!raw || !Array.isArray(raw.ports)) throw new MachineError(502, "InstaBox 返回了无法识别的响应");
  const ports = raw.ports
    .map(portView)
    .filter((entry): entry is ProviderPort => entry !== null)
    .sort((a, b) => a.port - b.port);
  return { enabled: raw.enabled === true, ports };
}

export async function providerPortAdd(db: D1Database, key: ContentKey, machineId: string, port: number, name: string): Promise<ProviderPort> {
  const ctx = await machineConnContext(db, key, machineId);
  requireInstabox(ctx);
  const raw = await instaboxRequest(ctx.config, "/v1/machines/" + encodeURIComponent(ctx.remoteId) + "/ports", {
    method: "POST",
    body: { port, name },
  });
  const view = portView(raw);
  if (!view) throw new MachineError(502, "InstaBox 返回了无法识别的响应");
  return view;
}

export async function providerPortRemove(db: D1Database, key: ContentKey, machineId: string, port: number): Promise<void> {
  const ctx = await machineConnContext(db, key, machineId);
  requireInstabox(ctx);
  await instaboxRequest(ctx.config, "/v1/machines/" + encodeURIComponent(ctx.remoteId) + "/ports/" + port, { method: "DELETE" });
}

// ---- keepalive ----

export interface KeepalivePolicy {
  machine_id: string;
  mode: "off" | "always" | "windows";
  timezone: string;
  windows: Array<{ start: string; end: string }>;
  last_checked_at: number | null;
  last_result: string;
}

export async function getKeepalive(db: D1Database, machineId: string): Promise<KeepalivePolicy> {
  const rows = rowsOf<{ mode: string; timezone: string; windows_json: string; last_checked_at: number | null; last_result: string }>(
    await prepare(db, "SELECT mode, timezone, windows_json, last_checked_at, last_result FROM machine_keepalive WHERE machine_id = ?", [
      machineId,
    ]).all<{ mode: string; timezone: string; windows_json: string; last_checked_at: number | null; last_result: string }>(),
  );
  const row = rows[0];
  if (!row) {
    return { machine_id: machineId, mode: "off", timezone: "Asia/Shanghai", windows: [], last_checked_at: null, last_result: "" };
  }
  let windows: Array<{ start: string; end: string }> = [];
  try {
    const parsed = JSON.parse(row.windows_json || "[]") as unknown;
    if (Array.isArray(parsed)) {
      windows = parsed
        .filter(
          (entry): entry is { start: string; end: string } =>
            !!entry && typeof entry === "object" && typeof (entry as { start?: unknown }).start === "string" && typeof (entry as { end?: unknown }).end === "string",
        )
        .map((entry) => ({ start: entry.start, end: entry.end }));
    }
  } catch {
    windows = [];
  }
  return {
    machine_id: machineId,
    mode: row.mode === "always" || row.mode === "windows" ? row.mode : "off",
    timezone: row.timezone || "Asia/Shanghai",
    windows,
    last_checked_at: row.last_checked_at ?? null,
    last_result: row.last_result || "",
  };
}

export async function putKeepalive(
  db: D1Database,
  machineId: string,
  policy: { mode: "off" | "always" | "windows"; timezone: string; windows: Array<{ start: string; end: string }> },
  now: number,
): Promise<KeepalivePolicy> {
  await prepare(
    db,
    "INSERT INTO machine_keepalive (machine_id, mode, timezone, windows_json, last_checked_at, last_result, updated_at) VALUES (?, ?, ?, ?, NULL, '', ?) ON CONFLICT(machine_id) DO UPDATE SET mode = excluded.mode, timezone = excluded.timezone, windows_json = excluded.windows_json, updated_at = excluded.updated_at",
    [machineId, policy.mode, policy.timezone, JSON.stringify(policy.windows), now],
  ).run();
  return getKeepalive(db, machineId);
}

function keepaliveInWindow(policy: KeepalivePolicy, now: number): boolean {
  if (policy.mode === "always") return true;
  if (policy.mode !== "windows" || !policy.windows.length) return false;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", { timeZone: policy.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(
      new Date(now),
    );
  } catch {
    return false;
  }
  const pick = (type: string): number => Number((parts.find((part) => part.type === type) || { value: "0" }).value) || 0;
  const current = pick("hour") * 60 + pick("minute");
  const toMinutes = (value: string): number => {
    const bits = value.split(":");
    return (Number(bits[0]) || 0) * 60 + (Number(bits[1]) || 0);
  };
  return policy.windows.some((window) => {
    const start = toMinutes(window.start);
    const end = toMinutes(window.end);
    return start <= end ? current >= start && current < end : current >= start || current < end;
  });
}

export async function runKeepaliveSweep(db: D1Database, key: ContentKey, now: number, onlyConnectionId?: string): Promise<void> {
  const rows = rowsOf<{ machine_id: string; connection_id: string; remote_id: string }>(
    await prepare(
      db,
      "SELECT k.machine_id AS machine_id, m.connection_id AS connection_id, m.remote_id AS remote_id FROM machine_keepalive k JOIN machines m ON m.id = k.machine_id WHERE k.mode != 'off' AND m.connection_id != ''",
      [],
    ).all<{ machine_id: string; connection_id: string; remote_id: string }>(),
  );
  const deviceCache = new Map<string, ProviderDevice[]>();
  for (const row of rows) {
    if (onlyConnectionId && row.connection_id !== onlyConnectionId) continue;
    try {
      const policy = await getKeepalive(db, row.machine_id);
      let result: string;
      if (!keepaliveInWindow(policy, now)) {
        result = "不在保活时段";
      } else {
        let devices = deviceCache.get(row.connection_id);
        if (!devices) {
          const conn = await getConnection(db, row.connection_id);
          if (!conn) continue;
          const config = await storedConfig(db, key, conn);
          devices = await fetchProviderDevices(conn.provider, config);
          deviceCache.set(row.connection_id, devices);
        }
        const device = devices.find((entry) => entry.remoteId === row.remote_id);
        if (!device) {
          result = "远端设备不存在";
        } else if (device.status === "running") {
          result = "运行中";
        } else if (device.state === "suspended") {
          await providerPower(db, key, row.machine_id, "resume");
          result = "已恢复运行";
        } else if (device.state === "stopped") {
          await providerPower(db, key, row.machine_id, "start");
          result = "已启动";
        } else {
          result = "当前状态未处理（" + (device.state || device.status) + "）";
        }
      }
      await prepare(db, "UPDATE machine_keepalive SET last_checked_at = ?, last_result = ?, updated_at = ? WHERE machine_id = ?", [
        now,
        result,
        now,
        row.machine_id,
      ]).run();
    } catch {
      // One bad policy must not stop the sweep.
    }
  }
}
