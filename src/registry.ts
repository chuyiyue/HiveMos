// MCP registry: discovery records, fetch audit, snapshot probe, and AI tags.
// Agents never proxy through this Worker. mcp_get is the only audited read.

import { sha256Hex } from "./auth";
import { decryptString, resolveContentKey, sealString } from "./crypto";
import { readChatResponse, resolveAiModel } from "./ai-model";
import type { D1Database, Env, WaitCtx } from "./env";

export interface Tag {
  text: string;
  source: "human" | "ai";
}

export interface RegistryTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ServerRow {
  id: string;
  name: string;
  title: string;
  description: string;
  endpoint_url: string;
  transport: string;
  launch_config_json: string | null;
  auth_type: string;
  config_json: string | null;
  tags_json: string;
  category: string;
  group_id: string | null;
  summary: string | null;
  summary_source: string | null;
  status: string;
  version: number | string;
  ttl_seconds: number | string;
  snapshot_json: string | null;
  snapshot_at: number | string | null;
  snapshot_status: string;
  content_hash: string;
  ai_status: string;
  created_at: number | string;
  updated_at: number | string;
}

export interface PublicServer {
  id: string;
  name: string;
  title: string;
  description: string;
  endpoint_url: string;
  transport: string;
  launch_config_json: string | null;
  auth_type: string;
  config_json: string | null;
  tags: Tag[];
  category: string;
  group_id: string | null;
  summary: string | null;
  summary_source: string | null;
  status: string;
  version: number;
  ttl_seconds: number;
  snapshot: { tools: RegistryTool[] } | null;
  snapshot_at: number | null;
  snapshot_status: string;
  ai_status: string;
  created_at: number;
  updated_at: number;
}

// Library avatar icon ids. Mirror of the catalog in public/avatars.js —
// keep the two lists in sync; PATCH validates against this set.
export const AVATAR_ICON_IDS: ReadonlySet<string> = new Set([
  "robot", "terminal", "code", "chip", "brain", "network", "rocket", "satellite", "spark", "message",
  "cat", "owl", "fox", "octopus", "whale", "bird", "fish", "panda", "turtle", "butterfly",
  "ghost", "alien", "eye", "bulb", "cube", "wrench", "crown", "shield", "bolt", "planet",
]);

// Accepts only absolute http/https image links, stored verbatim (the
// browser loads them directly; the Worker never fetches them).
export function parseAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return trimmed;
}

export interface PublicAgent {
  id: string;
  name: string;
  status: string;
  group_id: string | null;
  permissions: string[];
  last_seen_at: number | null;
  pinned_at: number | null;
  created_at: number;
  avatar_icon: string | null;
  avatar_url: string | null;
  has_custom_avatar: boolean;
  call_count: number;
}

export interface PublicGroup {
  id: string;
  scope: string;
  name: string;
  created_at: number;
  member_count: number;
}

interface GroupRow {
  id: string;
  scope: string;
  name: string;
  created_at: number | string;
  member_count?: number | string | null;
}

interface AgentRow {
  id: string;
  name: string;
  status: string;
  group_id: string | null;
  permissions: string | null;
  last_seen_at: number | string | null;
  pinned_at: number | string | null;
  created_at: number | string;
  avatar_icon?: string | null;
  avatar_url?: string | null;
  has_custom_avatar?: number | string | null;
  call_count: number | string | null;
}

export interface AuditItem {
  id: string;
  agent_id: string;
  agent_name: string;
  server_id: string;
  server_name: string;
  created_at: number;
}

export interface AgentConfig {
  endpoint_url: string;
  transport: string;
  launch_config: unknown;
  auth_type: string;
  config: unknown;
  version: number;
  ttl_seconds: number;
}

export interface SearchHit {
  id: string;
  name: string;
  title: string;
  description: string;
  category: string;
  tags: Tag[];
  transport: string;
  auth_type: string;
  summary: string | null;
  version: number;
  matched_tools?: string[];
}

interface SearchEntry {
  name: string;
  title: string;
  description: string;
  category: string;
  tags: Tag[];
  tools: Array<{ name: string; description: string }>;
}

type Failure = { ok: false; status: number; error: string };
type ServerResult = { ok: true; server: PublicServer; probe_error?: string } | (Failure & { server?: PublicServer });

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROBE_TIMEOUT_MS = 8000;
const AI_TIMEOUT_MS = 20000;

export function prepare(db: D1Database, sql: string, values: Array<string | number | null> = []) {
  const statement = db.prepare(sql);
  return values.length > 0 ? statement.bind(...values) : statement;
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

function newId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return prefix + hex;
}

// Agent ids stay short by request: agt_ plus 12 hex characters.
function newAgentId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return "agt_" + hex;
}

// ---- Agent audit + recoverable token storage ------------------------------
// agents_audit is the panel-side trail for agent management (create /
// update / delete / rotate / permissions / token_reveal). Writes on the
// management paths are best-effort: a missing table must not break the
// operation itself. The reveal path is the exception — it writes its row
// strictly BEFORE decrypting, so a failed audit write fails the reveal.

async function writeAgentAudit(db: D1Database, agentId: string, action: string): Promise<void> {
  await prepare(db, "INSERT INTO agents_audit (id, agent_id, actor, action, created_at) VALUES (?, ?, 'user', ?, ?)", [
    newId("aud_"),
    agentId,
    action,
    Date.now(),
  ]).run();
}

async function auditAgentQuietly(db: D1Database, agentId: string, action: string): Promise<void> {
  try {
    await writeAgentAudit(db, agentId, action);
  } catch {
    // best-effort: management operations never fail over their audit row
  }
}

// Tokens are sealed with the same VAULT_KEY AES-GCM envelope as the vault,
// so the panel can copy a key long after creation. When VAULT_KEY is not
// configured the seal is null and the token stays hash-only (copy reports
// it as unavailable, exactly like a legacy row).
async function sealAgentToken(env: Env, token: string): Promise<string | null> {
  const raw = (env as unknown as Record<string, unknown>)["VAULT_KEY"];
  const key = resolveContentKey(typeof raw === "string" ? raw : undefined);
  if (key.state !== "on") return null;
  return sealString(key, token);
}

export async function revealAgentToken(env: Env, id: string): Promise<{ ok: true; token: string } | Failure> {
  const row = await prepare(env.DB, "SELECT id, token_enc FROM agents WHERE id = ?", [id]).first<{
    id: string;
    token_enc: string | null;
  }>();
  if (!row) return { ok: false, status: 404, error: "未找到" };
  if (!row.token_enc) {
    return { ok: false, status: 409, error: "旧令牌只存了摘要、无法取出，轮换后即可复制" };
  }
  const raw = (env as unknown as Record<string, unknown>)["VAULT_KEY"];
  const key = resolveContentKey(typeof raw === "string" ? raw : undefined);
  if (key.state !== "on") return { ok: false, status: 503, error: "保险库密钥未配置，暂时不能复制密钥" };
  try {
    await writeAgentAudit(env.DB, id, "token_reveal");
  } catch {
    return { ok: false, status: 503, error: "审计写入失败，暂时不能复制密钥" };
  }
  const token = await decryptString(key.raw, row.token_enc);
  if (token === null) return { ok: false, status: 500, error: "解密失败，保险库密钥可能不正确" };
  return { ok: true, token };
}

export function randomAgentToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  return `hvm_agt_${encoded}`;
}

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((item) => stableStringify(item)).join(",") + "]";
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + stableStringify(record[key])).join(",") + "}";
  }
  return "null";
}

export function canonicalConfig(raw: string | null | undefined): string {
  if (raw == null) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return stableStringify(JSON.parse(trimmed) as unknown);
  } catch {
    return trimmed;
  }
}

// Hash input is name, title, description, canonical config, and sorted tool names.
export function contentIdentity(
  name: string,
  title: string,
  description: string,
  configJson: string | null,
  toolNames: string[],
): string {
  const tools = toolNames.map((tool) => tool.trim()).filter((tool) => tool.length > 0).sort();
  return [name, title, description, canonicalConfig(configJson), tools.join("\n")].join("\n");
}

async function hashIdentity(identity: string): Promise<string> {
  return sha256Hex(identity);
}

export function parseStoredTags(raw: string | null | undefined): Tag[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const tags: Tag[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const text = (item as { text?: unknown }).text;
    const source = (item as { source?: unknown }).source;
    if (typeof text !== "string") continue;
    const trimmed = text.trim();
    if (!trimmed || (source !== "human" && source !== "ai")) continue;
    tags.push({ text: trimmed.slice(0, 32), source });
  }
  return tags;
}

export function humanTagsFromInput(value: unknown): { ok: true; tags: Tag[] } | Failure {
  const parts: string[] = [];
  if (value == null || value === "") return { ok: true, tags: [] };
  if (typeof value === "string") parts.push(...value.split(/[,，]/));
  else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") return { ok: false, status: 400, error: "标签格式不正确" };
      parts.push(item);
    }
  } else return { ok: false, status: 400, error: "标签格式不正确" };

  const tags: Tag[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const text = part.trim();
    if (!text) continue;
    if (text.length > 32) return { ok: false, status: 400, error: "单个标签不能超过 32 个字" };
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push({ text, source: "human" });
    if (tags.length > 20) return { ok: false, status: 400, error: "标签最多 20 个" };
  }
  return { ok: true, tags };
}

function normalizeTool(value: unknown): RegistryTool | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { name?: unknown; description?: unknown; inputSchema?: unknown };
  if (typeof record.name !== "string") return null;
  const name = record.name.trim().slice(0, 128);
  if (!name) return null;
  const description = typeof record.description === "string" ? record.description.trim().slice(0, 500) : "";
  const inputSchema = record.inputSchema && typeof record.inputSchema === "object" ? record.inputSchema : { type: "object" };
  return { name, description, inputSchema };
}

export function toolsFromSnapshot(snapshotJson: string | null | undefined): RegistryTool[] {
  if (!snapshotJson) return [];
  try {
    const parsed = JSON.parse(snapshotJson) as { tools?: unknown };
    if (!parsed || !Array.isArray(parsed.tools)) return [];
    return parsed.tools.map(normalizeTool).filter((tool): tool is RegistryTool => tool !== null);
  } catch {
    return [];
  }
}

export function parseToolsPayload(value: unknown): RegistryTool[] | null {
  const extracted = extractTools(value);
  if (!extracted) return null;
  const tools = extracted.map(normalizeTool).filter((tool): tool is RegistryTool => tool !== null);
  if (extracted.length > 0 && tools.length === 0) return null;
  return tools;
}

function extractTools(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  const record = value as { tools?: unknown; result?: unknown };
  if (Array.isArray(record.tools)) return record.tools;
  if (record.result && typeof record.result === "object") {
    const nested = (record.result as { tools?: unknown }).tools;
    if (Array.isArray(nested)) return nested;
  }
  return null;
}

export function matchEntry(entry: SearchEntry, query: string, tag: string): { matched: boolean; matchedTools: string[] } {
  const wanted = tag.trim().toLowerCase();
  if (wanted && !entry.tags.some((item) => item.text.toLowerCase() === wanted)) {
    return { matched: false, matchedTools: [] };
  }
  const needle = query.trim().toLowerCase();
  if (!needle) return { matched: true, matchedTools: [] };
  const matchedTools: string[] = [];
  const seen = new Set<string>();
  for (const tool of entry.tools) {
    const blob = (tool.name + "\n" + tool.description).toLowerCase();
    if (!blob.includes(needle) || seen.has(tool.name)) continue;
    seen.add(tool.name);
    matchedTools.push(tool.name);
  }
  const haystack = [
    entry.name,
    entry.title,
    entry.description,
    entry.category,
    ...entry.tags.map((item) => item.text),
    ...entry.tools.flatMap((tool) => [tool.name, tool.description]),
  ]
    .join("\n")
    .toLowerCase();
  if (!haystack.includes(needle)) return { matched: false, matchedTools: [] };
  return { matched: true, matchedTools };
}

function toPublic(row: ServerRow): PublicServer {
  const tools = toolsFromSnapshot(row.snapshot_json);
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    description: row.description ?? "",
    endpoint_url: row.endpoint_url,
    transport: row.transport,
    launch_config_json: row.launch_config_json,
    auth_type: row.auth_type,
    config_json: row.config_json,
    tags: parseStoredTags(row.tags_json),
    category: row.category ?? "",
    group_id: row.group_id ?? null,
    summary: row.summary,
    summary_source: row.summary_source,
    status: row.status,
    version: asNumber(row.version) ?? 1,
    ttl_seconds: asNumber(row.ttl_seconds) ?? 86400,
    snapshot: row.snapshot_json ? { tools } : null,
    snapshot_at: asNumber(row.snapshot_at),
    snapshot_status: row.snapshot_status || "none",
    ai_status: row.ai_status || "pending",
    created_at: asNumber(row.created_at) ?? 0,
    updated_at: asNumber(row.updated_at) ?? 0,
  };
}

function toHit(row: ServerRow, matchedTools: string[] | null): SearchHit {
  const hit: SearchHit = {
    id: row.id,
    name: row.name,
    title: row.title,
    description: row.description ?? "",
    category: row.category ?? "",
    tags: parseStoredTags(row.tags_json),
    transport: row.transport,
    auth_type: row.auth_type,
    summary: row.summary,
    version: asNumber(row.version) ?? 1,
  };
  if (matchedTools) hit.matched_tools = matchedTools;
  return hit;
}

function parseJsonColumn(raw: string | null): unknown {
  if (raw == null || raw.trim() === "") return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function toAgentConfig(row: ServerRow): AgentConfig {
  return {
    endpoint_url: row.endpoint_url,
    transport: row.transport,
    launch_config: parseJsonColumn(row.launch_config_json),
    auth_type: row.auth_type,
    config: parseJsonColumn(row.config_json),
    version: asNumber(row.version) ?? 1,
    ttl_seconds: asNumber(row.ttl_seconds) ?? 86400,
  };
}

export async function getServer(db: D1Database, id: string): Promise<ServerRow | null> {
  return prepare(db, "SELECT * FROM mcp_servers WHERE id = ?", [id]).first<ServerRow>();
}

export async function readPublicServer(db: D1Database, id: string): Promise<PublicServer | null> {
  const row = await getServer(db, id);
  return row ? toPublic(row) : null;
}

async function getServerByName(db: D1Database, name: string): Promise<ServerRow | null> {
  return prepare(db, "SELECT * FROM mcp_servers WHERE name = ?", [name]).first<ServerRow>();
}

function isUniqueError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("unique");
}

function dbFailure(): Failure {
  return { ok: false, status: 503, error: "暂时无法读写注册表。请确认已经创建 D1 并应用迁移" };
}

interface ServerInput {
  name: string;
  title: string;
  description: string;
  endpoint_url: string;
  transport: string;
  launch_config_json: string | null;
  auth_type: string;
  config_json: string | null;
  tags: Tag[];
  category: string;
  group_id: string | null;
  summary: string | null;
  summary_source: string | null;
  status: string;
  ttl_seconds: number;
}

function optionalJson(value: unknown, label: string): { ok: true; text: string | null } | Failure {
  if (value == null) return { ok: true, text: null };
  if (typeof value !== "string") return { ok: false, status: 400, error: label + "不是合法的 JSON" };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, text: null };
  if (trimmed.length > 16000) return { ok: false, status: 400, error: label + "过长" };
  try {
    JSON.parse(trimmed);
  } catch {
    return { ok: false, status: 400, error: label + "不是合法的 JSON" };
  }
  return { ok: true, text: trimmed };
}

function readServerInput(value: unknown, existing: ServerRow | null): { ok: true; input: ServerInput } | Failure {
  if (!value || typeof value !== "object") return { ok: false, status: 400, error: "请求格式不正确" };
  const body = value as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { ok: false, status: 400, error: "请填写名称" };
  if (!NAME_RE.test(name)) return { ok: false, status: 400, error: "名称只能使用小写字母、数字、下划线和连字符" };
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return { ok: false, status: 400, error: "请填写标题" };
  if (title.length > 120) return { ok: false, status: 400, error: "标题过长" };
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (description.length > 4000) return { ok: false, status: 400, error: "说明过长" };
  const transport = typeof body.transport === "string" ? body.transport : "";
  if (transport !== "http" && transport !== "sse" && transport !== "stdio") {
    return { ok: false, status: 400, error: "传输方式不正确" };
  }
  const endpoint = typeof body.endpoint_url === "string" ? body.endpoint_url.trim() : "";
  if (!endpoint) return { ok: false, status: 400, error: "请填写端点" };
  if (endpoint.length > 2000) return { ok: false, status: 400, error: "端点过长" };
  if (transport !== "stdio") {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return { ok: false, status: 400, error: "http 和 sse 的端点需要以 http:// 或 https:// 开头" };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, status: 400, error: "http 和 sse 的端点需要以 http:// 或 https:// 开头" };
    }
  }
  const auth = typeof body.auth_type === "string" ? body.auth_type : "";
  if (auth !== "none" && auth !== "bearer" && auth !== "oauth") {
    return { ok: false, status: 400, error: "鉴权方式不正确" };
  }
  const status = body.status == null || body.status === "" ? "active" : body.status;
  if (status !== "active" && status !== "disabled") return { ok: false, status: 400, error: "状态不正确" };
  const launch = optionalJson(body.launch_config_json ?? "", "启动配置");
  if (!launch.ok) return launch;
  const config = optionalJson(body.config_json ?? "", "配置");
  if (!config.ok) return config;
  const tags = humanTagsFromInput(body.tags ?? body.tags_text ?? "");
  if (!tags.ok) return tags;
  const category = typeof body.category === "string" ? body.category.trim() : "";
  if (category.length > 40) return { ok: false, status: 400, error: "分类过长" };
  if (hasControl(title) || hasControl(endpoint) || hasControl(category)) {
    return { ok: false, status: 400, error: "文本里不能包含控制字符" };
  }
  const groupId = typeof body.group_id === "string" ? body.group_id.trim() : "";
  if (groupId.length > 64) return { ok: false, status: 400, error: "分组不正确" };
  const summaryText = typeof body.summary === "string" ? body.summary.trim() : "";
  if (summaryText.length > 200) return { ok: false, status: 400, error: "简介过长" };
  let summary: string | null = null;
  let summarySource: string | null = null;
  if (summaryText) {
    summary = summaryText.replace(/[。．.]+$/u, "");
    if (summary) summarySource = "human";
    else summary = null;
  } else if (existing && existing.summary_source === "ai" && existing.summary && existing.summary.trim()) {
    summary = existing.summary;
    summarySource = "ai";
  }
  let ttl = 86400;
  if (body.ttl_seconds != null && body.ttl_seconds !== "") {
    const parsed = Number(body.ttl_seconds);
    if (!Number.isInteger(parsed) || parsed < 60 || parsed > 2592000) {
      return { ok: false, status: 400, error: "存活时间需要在 60 到 2592000 秒之间" };
    }
    ttl = parsed;
  }
  return {
    ok: true,
    input: {
      name,
      title,
      description,
      endpoint_url: endpoint,
      transport,
      launch_config_json: launch.text,
      auth_type: auth,
      config_json: config.text,
      tags: tags.tags,
      category,
      group_id: groupId || null,
      summary,
      summary_source: summarySource,
      status,
      ttl_seconds: ttl,
    },
  };
}

function hasControl(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function versionChanged(existing: ServerRow, input: ServerInput): boolean {
  const previousTags = JSON.stringify(parseStoredTags(existing.tags_json).filter((tag) => tag.source === "human"));
  const nextTags = JSON.stringify(input.tags);
  return (
    existing.name !== input.name ||
    (existing.title ?? "") !== input.title ||
    (existing.description ?? "") !== input.description ||
    existing.endpoint_url !== input.endpoint_url ||
    existing.transport !== input.transport ||
    (existing.launch_config_json ?? "") !== (input.launch_config_json ?? "") ||
    existing.auth_type !== input.auth_type ||
    canonicalConfig(existing.config_json) !== canonicalConfig(input.config_json) ||
    previousTags !== nextTags ||
    (existing.category ?? "") !== input.category ||
    (existing.summary ?? "") !== (input.summary ?? "") ||
    (existing.summary_source ?? "") !== (input.summary_source ?? "") ||
    existing.status !== input.status ||
    (asNumber(existing.ttl_seconds) ?? 0) !== input.ttl_seconds
  );
}

function hasHumanTags(row: ServerRow): boolean {
  return parseStoredTags(row.tags_json).some((tag) => tag.source === "human" && tag.text.trim().length > 0);
}

function hasHumanSummary(row: ServerRow): boolean {
  return row.summary_source === "human" && !!row.summary && row.summary.trim().length > 0;
}

function needsAi(row: ServerRow): boolean {
  return !hasHumanTags(row) || !hasHumanSummary(row);
}

async function setAiStatus(db: D1Database, id: string, status: string, hash: string): Promise<void> {
  await prepare(db, "UPDATE mcp_servers SET ai_status = ? WHERE id = ? AND content_hash = ?", [status, id, hash]).run();
}

export function parseAiPayload(text: string | null): { tags: string[]; summary: string } | null {
  if (!text) return null;
  let raw = text.trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) raw = fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: { tags?: unknown; summary?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { tags?: unknown; summary?: unknown };
  } catch {
    return null;
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(parsed.tags)) {
    for (const item of parsed.tags) {
      if (typeof item !== "string") continue;
      const tag = item.trim().replace(/\s+/g, " ");
      if (!tag || tag.length > 32) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
      if (tags.length >= 6) break;
    }
  }
  let summary = typeof parsed.summary === "string" ? parsed.summary.trim().replace(/\s+/g, " ") : "";
  summary = summary.replace(/[。．.]+$/u, "").slice(0, 80);
  if (tags.length === 0 && !summary) return null;
  return { tags, summary };
}

function buildTagPrompt(row: ServerRow): string {
  const tools = toolsFromSnapshot(row.snapshot_json)
    .slice(0, 40)
    .map((tool) => tool.name + (tool.description ? "：" + tool.description.slice(0, 80) : ""))
    .join("\n");
  const config = canonicalConfig(row.config_json).slice(0, 2000);
  return [
    "名称：" + row.name,
    "标题：" + row.title,
    "说明：" + (row.description || ""),
    "分类：" + (row.category || ""),
    "配置：" + config,
    "工具：",
    tools || "（无）",
  ].join("\n");
}

async function applySuggestion(db: D1Database, id: string, hash: string, suggestion: { tags: string[]; summary: string }): Promise<void> {
  const row = await getServer(db, id);
  if (!row || row.content_hash !== hash) return;
  let tags = parseStoredTags(row.tags_json);
  if (!hasHumanTags(row) && suggestion.tags.length > 0) {
    tags = suggestion.tags.map((text) => ({ text, source: "ai" as const }));
  }
  let summary = row.summary;
  let summarySource = row.summary_source;
  if (!hasHumanSummary(row) && suggestion.summary) {
    summary = suggestion.summary;
    summarySource = "ai";
  }
  await prepare(
    db,
    "UPDATE mcp_servers SET tags_json = ?, summary = ?, summary_source = ?, ai_status = 'done' WHERE id = ? AND content_hash = ?",
    [JSON.stringify(tags), summary, summarySource, id, hash],
  ).run();
}

async function runTagJob(env: Env, id: string, hash: string): Promise<void> {
  try {
    const row = await getServer(env.DB, id);
    if (!row || row.content_hash !== hash) return;
    if (!env.AI || typeof env.AI.run !== "function") {
      await setAiStatus(env.DB, id, "skipped", hash);
      return;
    }
    const output = await withTimeout(
      env.AI.run(resolveAiModel(env), {
        messages: [
          {
            role: "system",
            content: "你只输出一个 JSON 对象，不要其他文字。格式为 {\"tags\":[\"标签\"],\"summary\":\"一句话\"}。tags 给 3 到 6 个中文或英文短标签。summary 用一句中文，结尾不要句号",
          },
          { role: "user", content: buildTagPrompt(row) },
        ],
        temperature: 0,
        max_tokens: 400,
      }),
      AI_TIMEOUT_MS,
    );
    const suggestion = parseAiPayload(readChatResponse(output));
    if (!suggestion) throw new Error("unparsed");
    await applySuggestion(env.DB, id, hash, suggestion);
  } catch {
    try {
      await setAiStatus(env.DB, id, "failed", hash);
    } catch {
      // The registry row is already saved. Tagging must not surface as a request error.
    }
  }
}

export async function considerAi(env: Env, ctx: WaitCtx, id: string, previousHash: string): Promise<void> {
  const row = await getServer(env.DB, id);
  if (!row || row.content_hash === previousHash) return;
  if (!env.AI || typeof env.AI.run !== "function") {
    await setAiStatus(env.DB, id, "skipped", row.content_hash);
    return;
  }
  if (!needsAi(row)) {
    await setAiStatus(env.DB, id, "done", row.content_hash);
    return;
  }
  await setAiStatus(env.DB, id, "pending", row.content_hash);
  const hash = row.content_hash;
  ctx.waitUntil(
    runTagJob(env, id, hash).catch(() => {
      // runTagJob records ai_status=failed itself.
    }),
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("failed"));
      },
    );
  });
}

async function probeTools(endpoint: string): Promise<RegistryTool[]> {
  const init = await postRpc(endpoint, 1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "HiveMos", version: "0.1.0" },
  });
  const listed = await postRpc(endpoint, 2, "tools/list", {}, init.sessionId);
  const tools = parseToolsPayload(listed.body);
  if (!tools) throw new Error("tools");
  return trimTools(tools);
}

function trimTools(tools: RegistryTool[]): RegistryTool[] {
  let snapshot = JSON.stringify({ tools });
  if (snapshot.length <= 60000) return tools;
  const slim = tools.map((tool) => ({ ...tool, inputSchema: { type: "object" } }));
  snapshot = JSON.stringify({ tools: slim });
  if (snapshot.length <= 60000) return slim;
  return slim.slice(0, 80).map((tool) => ({ ...tool, description: tool.description.slice(0, 120) }));
}

async function postRpc(
  endpoint: string,
  id: number,
  method: string,
  params: unknown,
  sessionId?: string | null,
): Promise<{ body: unknown; sessionId: string | null }> {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  if (sessionId) headers.set("mcp-session-id", sessionId);
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error("status");
  const body = parseRpcText(text, id);
  if (!body || (typeof body === "object" && body && "error" in body && (body as { error?: unknown }).error)) {
    throw new Error("rpc");
  }
  return { body, sessionId: response.headers.get("mcp-session-id") };
}

function parseRpcText(text: string, id: number): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed) as unknown;
  let found: unknown = null;
  for (const line of trimmed.split("\n")) {
    const row = line.trim();
    if (!row.startsWith("data:")) continue;
    const payload = row.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as { id?: unknown };
      found = parsed;
      if (parsed.id === id) return parsed;
    } catch {
      // Ignore non-JSON SSE comments.
    }
  }
  if (found) return found;
  throw new Error("sse");
}

async function writeSnapshot(
  db: D1Database,
  row: ServerRow,
  tools: RegistryTool[] | null,
  status: "ok" | "failed",
): Promise<void> {
  const now = Date.now();
  if (status === "failed" || !tools) {
    await prepare(db, "UPDATE mcp_servers SET snapshot_status = 'failed', snapshot_at = ? WHERE id = ?", [now, row.id]).run();
    return;
  }
  const snapshot = JSON.stringify({ tools });
  const hash = await hashIdentity(contentIdentity(row.name, row.title, row.description ?? "", row.config_json, tools.map((tool) => tool.name)));
  await prepare(
    db,
    "UPDATE mcp_servers SET snapshot_json = ?, snapshot_at = ?, snapshot_status = 'ok', content_hash = ? WHERE id = ?",
    [snapshot, now, hash, row.id],
  ).run();
}

export async function refreshServerSnapshot(
  env: Env,
  ctx: WaitCtx,
  id: string,
  aiBaseline: string | null,
): Promise<ServerResult> {
  const row = await getServer(env.DB, id);
  if (!row) return { ok: false, status: 404, error: "未找到" };
  if (row.transport === "stdio") {
    return { ok: false, status: 400, error: "stdio 条目不能自动探活，请手填工具快照", server: toPublic(row) };
  }
  const baseline = aiBaseline === null ? row.content_hash : aiBaseline;
  const hadSnapshot = !!row.snapshot_json;
  try {
    const tools = await probeTools(row.endpoint_url);
    await writeSnapshot(env.DB, row, tools, "ok");
  } catch {
    try {
      await writeSnapshot(env.DB, row, null, "failed");
    } catch {
      return dbFailure();
    }
    await considerAi(env, ctx, id, baseline);
    const failed = await getServer(env.DB, id);
    return {
      ok: false,
      status: 502,
      error: hadSnapshot ? "探活失败，已保留已有快照" : "探活失败，还没有工具快照",
      server: failed ? toPublic(failed) : toPublic(row),
    };
  }
  await considerAi(env, ctx, id, baseline);
  const fresh = await getServer(env.DB, id);
  if (!fresh) return { ok: false, status: 404, error: "未找到" };
  return { ok: true, server: toPublic(fresh) };
}

export async function refreshActiveSnapshots(env: Env, ctx: WaitCtx): Promise<void> {
  const listed = await prepare(
    env.DB,
    "SELECT id FROM mcp_servers WHERE status = 'active' AND transport != 'stdio'",
  ).all<{ id: string }>();
  for (const row of rowsOf(listed)) {
    try {
      await refreshServerSnapshot(env, ctx, row.id, null);
    } catch {
      // One dead endpoint must not stop the rest of the sweep.
    }
  }
}

export async function listServers(db: D1Database): Promise<PublicServer[]> {
  const listed = await prepare(db, "SELECT * FROM mcp_servers ORDER BY updated_at DESC").all<ServerRow>();
  return rowsOf(listed).map(toPublic);
}

export async function createServer(env: Env, ctx: WaitCtx, value: unknown): Promise<ServerResult> {
  const parsed = readServerInput(value, null);
  if (!parsed.ok) return parsed;
  const input = parsed.input;
  if (input.group_id) {
    const group = await getGroup(env.DB, input.group_id);
    if (!group || group.scope !== "mcp") return { ok: false, status: 400, error: "分组不存在" };
  }
  const now = Date.now();
  const id = newId("mcp_");
  const hash = await hashIdentity(contentIdentity(input.name, input.title, input.description, input.config_json, []));
  try {
    await prepare(
      env.DB,
      `INSERT INTO mcp_servers (
        id, name, title, description, endpoint_url, transport, launch_config_json, auth_type, config_json,
        tags_json, category, summary, summary_source, status, version, ttl_seconds, snapshot_json, snapshot_at,
        snapshot_status, content_hash, ai_status, embedding, created_at, updated_at, group_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, 'none', ?, 'pending', NULL, ?, ?, ?)`,
      [
        id,
        input.name,
        input.title,
        input.description,
        input.endpoint_url,
        input.transport,
        input.launch_config_json,
        input.auth_type,
        input.config_json,
        JSON.stringify(input.tags),
        input.category,
        input.summary,
        input.summary_source,
        input.status,
        input.ttl_seconds,
        hash,
        now,
        now,
        input.group_id,
      ],
    ).run();
  } catch (error) {
    if (isUniqueError(error)) return { ok: false, status: 409, error: "名称已存在" };
    return dbFailure();
  }
  if (input.transport === "stdio" || input.status !== "active") {
    await considerAi(env, ctx, id, "");
    const row = await getServer(env.DB, id);
    if (!row) return { ok: false, status: 404, error: "未找到" };
    return { ok: true, server: toPublic(row) };
  }
  const probed = await refreshServerSnapshot(env, ctx, id, "");
  if (!probed.ok && probed.server) return { ok: true, server: probed.server, probe_error: probed.error };
  return probed;
}

export async function updateServer(env: Env, ctx: WaitCtx, id: string, value: unknown): Promise<ServerResult> {
  const existing = await getServer(env.DB, id);
  if (!existing) return { ok: false, status: 404, error: "未找到" };
  const parsed = readServerInput(value, existing);
  if (!parsed.ok) return parsed;
  const input = parsed.input;
  if (input.group_id) {
    const group = await getGroup(env.DB, input.group_id);
    if (!group || group.scope !== "mcp") return { ok: false, status: 400, error: "分组不存在" };
  }
  let tagsToStore = input.tags;
  if (tagsToStore.length === 0) {
    const stored = parseStoredTags(existing.tags_json);
    if (stored.length > 0 && !stored.some((tag) => tag.source === "human")) tagsToStore = stored;
  }
  const toolNames = toolsFromSnapshot(existing.snapshot_json).map((tool) => tool.name);
  const hash = await hashIdentity(contentIdentity(input.name, input.title, input.description, input.config_json, toolNames));
  const nextVersion = (asNumber(existing.version) ?? 1) + (versionChanged(existing, input) ? 1 : 0);
  const now = Date.now();
  const previousHash = existing.content_hash;
  try {
    await prepare(
      env.DB,
      `UPDATE mcp_servers SET
        name = ?, title = ?, description = ?, endpoint_url = ?, transport = ?, launch_config_json = ?,
        auth_type = ?, config_json = ?, tags_json = ?, category = ?, summary = ?, summary_source = ?,
        status = ?, version = ?, ttl_seconds = ?, content_hash = ?, updated_at = ?, group_id = ?
      WHERE id = ?`,
      [
        input.name,
        input.title,
        input.description,
        input.endpoint_url,
        input.transport,
        input.launch_config_json,
        input.auth_type,
        input.config_json,
        JSON.stringify(tagsToStore),
        input.category,
        input.summary,
        input.summary_source,
        input.status,
        nextVersion,
        input.ttl_seconds,
        hash,
        now,
        input.group_id,
        id,
      ],
    ).run();
  } catch (error) {
    if (isUniqueError(error)) return { ok: false, status: 409, error: "名称已存在" };
    return dbFailure();
  }
  const endpointChanged = existing.endpoint_url !== input.endpoint_url || existing.transport !== input.transport;
  if (endpointChanged && input.transport !== "stdio" && input.status === "active") {
    const probed = await refreshServerSnapshot(env, ctx, id, previousHash);
    if (!probed.ok && probed.server) return { ok: true, server: probed.server, probe_error: probed.error };
    return probed;
  }
  await considerAi(env, ctx, id, previousHash);
  const fresh = await getServer(env.DB, id);
  if (!fresh) return { ok: false, status: 404, error: "未找到" };
  return { ok: true, server: toPublic(fresh) };
}

export async function deleteServer(db: D1Database, id: string): Promise<{ ok: true } | Failure> {
  const existing = await getServer(db, id);
  if (!existing) return { ok: false, status: 404, error: "未找到" };
  try {
    await prepare(db, "DELETE FROM mcp_servers WHERE id = ?", [id]).run();
  } catch {
    return dbFailure();
  }
  return { ok: true };
}

export async function saveManualSnapshot(env: Env, ctx: WaitCtx, id: string, raw: unknown): Promise<ServerResult> {
  const row = await getServer(env.DB, id);
  if (!row) return { ok: false, status: 404, error: "未找到" };
  if (typeof raw !== "string" || raw.trim().length === 0) return { ok: false, status: 400, error: "请粘贴 tools/list JSON" };
  if (raw.length > 60000) return { ok: false, status: 400, error: "快照过长" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, status: 400, error: "快照不是可识别的 tools/list JSON" };
  }
  const tools = parseToolsPayload(parsed);
  if (!tools) return { ok: false, status: 400, error: "快照不是可识别的 tools/list JSON" };
  const slim = trimTools(tools);
  const snapshot = JSON.stringify({ tools: slim });
  const hash = await hashIdentity(contentIdentity(row.name, row.title, row.description ?? "", row.config_json, slim.map((tool) => tool.name)));
  const now = Date.now();
  const previousHash = row.content_hash;
  try {
    await prepare(
      env.DB,
      "UPDATE mcp_servers SET snapshot_json = ?, snapshot_at = ?, snapshot_status = 'manual', content_hash = ? WHERE id = ?",
      [snapshot, now, hash, id],
    ).run();
  } catch {
    return dbFailure();
  }
  await considerAi(env, ctx, id, previousHash);
  const fresh = await getServer(env.DB, id);
  if (!fresh) return { ok: false, status: 404, error: "未找到" };
  return { ok: true, server: toPublic(fresh) };
}

export async function listAudit(db: D1Database): Promise<AuditItem[]> {
  const listed = await prepare(
    db,
    `SELECT a.id, a.agent_id, a.server_id, a.created_at,
            COALESCE(ag.name, '') AS agent_name,
            COALESCE(s.name, '') AS server_name
     FROM mcp_fetch_audit AS a
     LEFT JOIN agents AS ag ON ag.id = a.agent_id
     LEFT JOIN mcp_servers AS s ON s.id = a.server_id
     ORDER BY a.created_at DESC
     LIMIT 100`,
  ).all<AuditItem>();
  return rowsOf(listed).map((item) => ({
    id: item.id,
    agent_id: item.agent_id,
    agent_name: item.agent_name || "",
    server_id: item.server_id,
    server_name: item.server_name || "",
    created_at: asNumber(item.created_at) ?? 0,
  }));
}

// ---- Groups (scope: agent | mcp) ----

function toPublicGroup(row: GroupRow): PublicGroup {
  return {
    id: row.id,
    scope: row.scope,
    name: row.name,
    created_at: asNumber(row.created_at) ?? 0,
    member_count: asNumber(row.member_count) ?? 0,
  };
}

const GROUP_MEMBER_TABLES: Record<string, string> = { agent: "agents", mcp: "mcp_servers", machines: "machines" };

export async function getGroup(db: D1Database, id: string): Promise<GroupRow | null> {
  return prepare(db, "SELECT id, scope, name, created_at FROM groups WHERE id = ?", [id]).first<GroupRow>();
}

async function countGroupMembers(db: D1Database, scope: string, groupId: string): Promise<number> {
  const table = GROUP_MEMBER_TABLES[scope] ?? "mcp_servers";
  const row = await prepare(db, "SELECT COUNT(*) AS n FROM " + table + " WHERE group_id = ?", [groupId]).first<{ n: number | string }>();
  return asNumber(row?.n) ?? 0;
}

export async function listGroups(db: D1Database, scope: string): Promise<PublicGroup[]> {
  const table = GROUP_MEMBER_TABLES[scope] ?? "mcp_servers";
  const listed = await prepare(
    db,
    "SELECT g.id, g.scope, g.name, g.created_at, (SELECT COUNT(*) FROM " +
      table +
      " AS m WHERE m.group_id = g.id) AS member_count FROM groups AS g WHERE g.scope = ? ORDER BY g.created_at ASC, g.name ASC",
    [scope],
  ).all<GroupRow>();
  return rowsOf(listed).map(toPublicGroup);
}

function readGroupName(value: unknown): { ok: true; name: string } | Failure {
  if (!value || typeof value !== "object") return { ok: false, status: 400, error: "请求格式不正确" };
  const name = typeof (value as { name?: unknown }).name === "string" ? (value as { name: string }).name.trim() : "";
  if (!name) return { ok: false, status: 400, error: "请填写分组名" };
  if (name.length > 64 || hasControl(name)) return { ok: false, status: 400, error: "分组名过长" };
  return { ok: true, name };
}

export async function createGroup(db: D1Database, scope: string, value: unknown): Promise<{ ok: true; group: PublicGroup } | Failure> {
  const parsed = readGroupName(value);
  if (!parsed.ok) return parsed;
  const id = newId("grp_");
  const now = Date.now();
  try {
    await prepare(db, "INSERT INTO groups (id, scope, name, created_at) VALUES (?, ?, ?, ?)", [id, scope, parsed.name, now]).run();
  } catch (error) {
    if (isUniqueError(error)) return { ok: false, status: 409, error: "这个分组名已存在" };
    return dbFailure();
  }
  return { ok: true, group: { id, scope, name: parsed.name, created_at: now, member_count: 0 } };
}

export async function renameGroup(db: D1Database, id: string, value: unknown): Promise<{ ok: true; group: PublicGroup } | Failure> {
  const existing = await getGroup(db, id);
  if (!existing) return { ok: false, status: 404, error: "未找到" };
  const parsed = readGroupName(value);
  if (!parsed.ok) return parsed;
  try {
    await prepare(db, "UPDATE groups SET name = ? WHERE id = ?", [parsed.name, id]).run();
  } catch (error) {
    if (isUniqueError(error)) return { ok: false, status: 409, error: "这个分组名已存在" };
    return dbFailure();
  }
  const count = await countGroupMembers(db, existing.scope, id);
  return {
    ok: true,
    group: { id, scope: existing.scope, name: parsed.name, created_at: asNumber(existing.created_at) ?? 0, member_count: count },
  };
}

// Deleting a group only ungroups its members; members themselves are kept.
export async function deleteGroup(db: D1Database, id: string): Promise<{ ok: true } | Failure> {
  const existing = await getGroup(db, id);
  if (!existing) return { ok: false, status: 404, error: "未找到" };
  try {
    await prepare(db, "UPDATE agents SET group_id = NULL WHERE group_id = ?", [id]).run();
    await prepare(db, "UPDATE mcp_servers SET group_id = NULL WHERE group_id = ?", [id]).run();
    await prepare(db, "UPDATE machines SET group_id = NULL WHERE group_id = ?", [id]).run();
    await prepare(db, "DELETE FROM groups WHERE id = ?", [id]).run();
  } catch {
    return dbFailure();
  }
  return { ok: true };
}

// System feature domains an agent can be granted, one per board. Stored on
// the agent as a JSON array; anything not listed is denied at the MCP edge.
// soul_write_any is additive: it unlocks writing other agents' souls and is
// never granted by default, so existing agents keep their stored grants.
export const PERMISSION_DOMAINS = ["mcp", "skills", "api", "memory", "soul", "soul_write_any", "tasks", "calendar", "vault", "machines"];

// The old single "registry" domain covered the whole MCP 与 Skills board;
// it now splits per tab (MCP / Skills / API). Stored grants expand on read.
const LEGACY_REGISTRY_EXPANSION = ["mcp", "skills", "api"];

// Stored JSON that is missing or unreadable falls back to the historical
// capability set: registry only.
export function parsePermissions(raw: string | null | undefined): string[] {
  let parsed: unknown = null;
  if (typeof raw === "string" && raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  if (!Array.isArray(parsed)) return [...LEGACY_REGISTRY_EXPANSION];
  const wanted = new Set(parsed.filter((item): item is string => typeof item === "string"));
  if (wanted.has("registry")) {
    for (const domain of LEGACY_REGISTRY_EXPANSION) wanted.add(domain);
  }
  return PERMISSION_DOMAINS.filter((domain) => wanted.has(domain));
}

// PATCH input must be a wholesale replacement drawn from the known domains.
function readPermissionsInput(value: unknown): { ok: true; permissions: string[] } | Failure {
  if (!Array.isArray(value)) return { ok: false, status: 400, error: "权限格式不正确" };
  for (const item of value) {
    if (typeof item !== "string" || !PERMISSION_DOMAINS.includes(item)) {
      return { ok: false, status: 400, error: "权限包含未知项" };
    }
  }
  return { ok: true, permissions: PERMISSION_DOMAINS.filter((domain) => value.includes(domain)) };
}

function toPublicAgent(row: AgentRow): PublicAgent {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    group_id: row.group_id ?? null,
    permissions: parsePermissions(row.permissions),
    last_seen_at: asNumber(row.last_seen_at),
    pinned_at: asNumber(row.pinned_at),
    created_at: asNumber(row.created_at) ?? 0,
    avatar_icon: row.avatar_icon ?? null,
    avatar_url: row.avatar_url ?? null,
    has_custom_avatar: asNumber(row.has_custom_avatar) === 1,
    call_count: asNumber(row.call_count) ?? 0,
  };
}

async function getAgentRow(db: D1Database, id: string): Promise<AgentRow | null> {
  return prepare(db, "SELECT id, name, status, group_id, permissions, last_seen_at, pinned_at, created_at, call_count, avatar_icon, avatar_url, EXISTS(SELECT 1 FROM agent_avatars WHERE agent_id = agents.id) AS has_custom_avatar FROM agents WHERE id = ?", [id]).first<AgentRow>();
}

// Resolves an optional group reference for the agent scope. Absent or blank
// means ungrouped; a present id must exist in the same scope.
async function resolveAgentGroupId(db: D1Database, value: unknown): Promise<{ ok: true; groupId: string | null } | Failure> {
  if (value == null || value === "") return { ok: true, groupId: null };
  if (typeof value !== "string") return { ok: false, status: 400, error: "分组不正确" };
  const groupId = value.trim();
  if (!groupId) return { ok: true, groupId: null };
  const group = await getGroup(db, groupId);
  if (!group || group.scope !== "agent") return { ok: false, status: 400, error: "分组不存在" };
  return { ok: true, groupId };
}

export async function listAgents(db: D1Database): Promise<PublicAgent[]> {
  const listed = await prepare(
    db,
    "SELECT id, name, status, group_id, permissions, last_seen_at, pinned_at, created_at, call_count, avatar_icon, avatar_url, EXISTS(SELECT 1 FROM agent_avatars WHERE agent_id = agents.id) AS has_custom_avatar FROM agents ORDER BY created_at DESC",
  ).all<AgentRow>();
  return rowsOf(listed).map(toPublicAgent);
}

export interface SidebarAgent {
  id: string;
  name: string;
  status: string;
  last_seen_at: number | null;
  pinned: boolean;
  avatar_icon: string | null;
  avatar_url: string | null;
  has_custom_avatar: boolean;
}

// The sidebar rail is assembled here so every client shows the same list:
// pinned agents first (in pin order, never capped by the limit), then the
// most recently active agents fill the remaining slots up to the limit.
// Pinned agents always appear (an explicit pin wins, even while disabled);
// the recent-activity fill below only draws from enabled agents.
export async function listSidebarAgents(db: D1Database, limit: number): Promise<SidebarAgent[]> {
  const toItem = (row: AgentRow, pinned: boolean): SidebarAgent => ({
    id: row.id,
    name: row.name,
    status: row.status,
    last_seen_at: asNumber(row.last_seen_at),
    pinned,
    avatar_icon: row.avatar_icon ?? null,
    avatar_url: row.avatar_url ?? null,
    has_custom_avatar: asNumber(row.has_custom_avatar) === 1,
  });
  const pinnedListed = await prepare(
    db,
    "SELECT id, name, status, group_id, permissions, last_seen_at, pinned_at, created_at, avatar_icon, avatar_url, EXISTS(SELECT 1 FROM agent_avatars WHERE agent_id = agents.id) AS has_custom_avatar FROM agents WHERE pinned_at IS NOT NULL ORDER BY pinned_at ASC, created_at ASC",
  ).all<AgentRow>();
  const pinned = rowsOf(pinnedListed).map((row) => toItem(row, true));
  if (pinned.length >= limit) return pinned;
  const fillListed = await prepare(
    db,
    "SELECT id, name, status, group_id, permissions, last_seen_at, pinned_at, created_at, avatar_icon, avatar_url, EXISTS(SELECT 1 FROM agent_avatars WHERE agent_id = agents.id) AS has_custom_avatar FROM agents WHERE status = 'active' AND pinned_at IS NULL ORDER BY last_seen_at DESC, created_at DESC LIMIT ?",
    [limit - pinned.length],
  ).all<AgentRow>();
  return pinned.concat(rowsOf(fillListed).map((row) => toItem(row, false)));
}

export async function createAgent(env: Env, value: unknown): Promise<{ ok: true; agent: PublicAgent & { token: string } } | Failure> {
  if (!value || typeof value !== "object") return { ok: false, status: 400, error: "请求格式不正确" };
  const name = typeof (value as { name?: unknown }).name === "string" ? (value as { name: string }).name.trim() : "";
  if (!name) return { ok: false, status: 400, error: "请填写 Agent 名字" };
  if (name.length > 64 || hasControl(name)) return { ok: false, status: 400, error: "名字过长" };
  const db = env.DB;
  const resolved = await resolveAgentGroupId(db, (value as { group_id?: unknown }).group_id);
  if (!resolved.ok) return resolved;
  const token = randomAgentToken();
  const now = Date.now();
  let id = newAgentId();
  for (let attempt = 0; attempt < 5 && (await getAgentRow(db, id)); attempt++) id = newAgentId();
  const tokenEnc = await sealAgentToken(env, token);
  try {
    await prepare(db, "INSERT INTO agents (id, name, token_hash, token_enc, status, group_id, permissions, last_seen_at, created_at) VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, ?)", [
      id,
      name,
      await sha256Hex(token),
      tokenEnc,
      resolved.groupId,
      JSON.stringify(["mcp", "skills", "api"]),
      now,
    ]).run();
  } catch (error) {
    if (isUniqueError(error)) return { ok: false, status: 409, error: "这个名字已存在" };
    return dbFailure();
  }
  await auditAgentQuietly(db, id, "create");
  return { ok: true, agent: { id, name, status: "active", group_id: resolved.groupId, permissions: ["mcp", "skills", "api"], last_seen_at: null, pinned_at: null, created_at: now, call_count: 0, avatar_icon: null, avatar_url: null, has_custom_avatar: false, token } };
}

export async function updateAgent(db: D1Database, id: string, value: unknown): Promise<{ ok: true; agent: PublicAgent } | Failure> {
  const existing = await getAgentRow(db, id);
  if (!existing) return { ok: false, status: 404, error: "未找到" };
  if (!value || typeof value !== "object") return { ok: false, status: 400, error: "请求格式不正确" };
  const body = value as Record<string, unknown>;
  let name = existing.name;
  if ("name" in body) {
    name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return { ok: false, status: 400, error: "请填写 Agent 名字" };
    if (name.length > 64 || hasControl(name)) return { ok: false, status: 400, error: "名字过长" };
  }
  let groupId = existing.group_id ?? null;
  if ("group_id" in body) {
    const resolved = await resolveAgentGroupId(db, body.group_id);
    if (!resolved.ok) return resolved;
    groupId = resolved.groupId;
  }
  let permissions = parsePermissions(existing.permissions);
  if ("permissions" in body) {
    const parsedPermissions = readPermissionsInput(body.permissions);
    if (!parsedPermissions.ok) return parsedPermissions;
    permissions = parsedPermissions.permissions;
  }
  let pinnedAt = asNumber(existing.pinned_at);
  if ("pinned" in body) {
    if (typeof body.pinned !== "boolean") return { ok: false, status: 400, error: "固定状态不正确" };
    pinnedAt = body.pinned ? Date.now() : null;
  }
  let status = existing.status;
  if ("status" in body) {
    if (body.status !== "active" && body.status !== "disabled") return { ok: false, status: 400, error: "状态不正确" };
    status = body.status;
  }
  // Avatar sources are mutually exclusive: setting one clears the others
  // (the uploaded image row is dropped below once the update lands).
  let avatarIcon = existing.avatar_icon ?? null;
  let avatarUrl = existing.avatar_url ?? null;
  let clearUploadedAvatar = false;
  if ("avatar_icon" in body) {
    if (body.avatar_icon == null || body.avatar_icon === "") {
      avatarIcon = null;
    } else if (typeof body.avatar_icon === "string" && AVATAR_ICON_IDS.has(body.avatar_icon)) {
      avatarIcon = body.avatar_icon;
    } else {
      return { ok: false, status: 400, error: "头像图标不正确" };
    }
    if (avatarIcon) {
      avatarUrl = null;
      clearUploadedAvatar = true;
    }
  }
  if ("avatar_url" in body) {
    if (body.avatar_url == null || body.avatar_url === "") {
      avatarUrl = null;
    } else {
      const parsed = parseAvatarUrl(body.avatar_url);
      if (!parsed) return { ok: false, status: 400, error: "图片链接不正确" };
      avatarUrl = parsed;
    }
    if (avatarUrl) {
      avatarIcon = null;
      clearUploadedAvatar = true;
    }
  }
  try {
    await prepare(db, "UPDATE agents SET name = ?, group_id = ?, permissions = ?, pinned_at = ?, status = ?, avatar_icon = ?, avatar_url = ? WHERE id = ?", [name, groupId, JSON.stringify(permissions), pinnedAt, status, avatarIcon, avatarUrl, id]).run();
  } catch (error) {
    if (isUniqueError(error)) return { ok: false, status: 409, error: "这个名字已存在" };
    return dbFailure();
  }
  if (clearUploadedAvatar) {
    try {
      await prepare(db, "DELETE FROM agent_avatars WHERE agent_id = ?", [id]).run();
    } catch {
      return dbFailure();
    }
  }
  if ("permissions" in body) await auditAgentQuietly(db, id, "permissions");
  if ("name" in body || "group_id" in body || "pinned" in body || "status" in body) await auditAgentQuietly(db, id, "update");
  const fresh = await getAgentRow(db, id);
  if (!fresh) return { ok: false, status: 404, error: "未找到" };
  return { ok: true, agent: toPublicAgent(fresh) };
}

// ---- Uploaded avatar images ----

export interface AgentAvatarImage {
  content_type: string;
  data: Uint8Array;
}

// D1 hands BLOB values back as an ArrayBuffer in production but as a
// plain number array through the local dev binding; normalize all forms.
function blobToBytes(raw: unknown): Uint8Array {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]);
  return new Uint8Array(0);
}

export async function getAgentAvatar(db: D1Database, id: string): Promise<AgentAvatarImage | null> {
  const row = await prepare(db, "SELECT content_type, data FROM agent_avatars WHERE agent_id = ?", [id]).first<{
    content_type: string;
    data: ArrayBuffer | Uint8Array | number[];
  }>();
  if (!row) return null;
  return { content_type: row.content_type, data: blobToBytes(row.data) };
}

// Storing an upload makes it the single avatar source: the library icon
// and the external link are cleared in the same step.
export async function setAgentAvatar(
  db: D1Database,
  id: string,
  contentType: string,
  data: Uint8Array,
): Promise<{ ok: true; agent: PublicAgent } | Failure> {
  const existing = await getAgentRow(db, id);
  if (!existing) return { ok: false, status: 404, error: "未找到" };
  try {
    await prepare(
      db,
      "INSERT INTO agent_avatars (agent_id, content_type, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET content_type = excluded.content_type, data = excluded.data, updated_at = excluded.updated_at",
      [id, contentType, data, Date.now()],
    ).run();
    await prepare(db, "UPDATE agents SET avatar_icon = NULL, avatar_url = NULL WHERE id = ?", [id]).run();
  } catch {
    return dbFailure();
  }
  const fresh = await getAgentRow(db, id);
  if (!fresh) return { ok: false, status: 404, error: "未找到" };
  return { ok: true, agent: toPublicAgent(fresh) };
}

export async function clearAgentAvatar(db: D1Database, id: string): Promise<{ ok: true; agent: PublicAgent } | Failure> {
  const existing = await getAgentRow(db, id);
  if (!existing) return { ok: false, status: 404, error: "未找到" };
  try {
    await prepare(db, "DELETE FROM agent_avatars WHERE agent_id = ?", [id]).run();
  } catch {
    return dbFailure();
  }
  const fresh = await getAgentRow(db, id);
  if (!fresh) return { ok: false, status: 404, error: "未找到" };
  return { ok: true, agent: toPublicAgent(fresh) };
}

// Rotation swaps the stored hash, so the old token stops working the moment
// this returns. The new token is also sealed into token_enc, so the panel
// can copy it again later via revealAgentToken.
export async function rotateAgentToken(env: Env, id: string): Promise<{ ok: true; agent: PublicAgent; token: string } | Failure> {
  const db = env.DB;
  const existing = await getAgentRow(db, id);
  if (!existing) return { ok: false, status: 404, error: "未找到" };
  const token = randomAgentToken();
  const tokenEnc = await sealAgentToken(env, token);
  try {
    await prepare(db, "UPDATE agents SET token_hash = ?, token_enc = ? WHERE id = ?", [await sha256Hex(token), tokenEnc, id]).run();
  } catch {
    return dbFailure();
  }
  await auditAgentQuietly(db, id, "rotate");
  return { ok: true, agent: toPublicAgent(existing), token };
}

export async function disableAgent(db: D1Database, id: string): Promise<{ ok: true } | Failure> {
  const row = await prepare(db, "SELECT id FROM agents WHERE id = ?", [id]).first<{ id: string }>();
  if (!row) return { ok: false, status: 404, error: "未找到" };
  try {
    await prepare(db, "UPDATE agents SET status = 'disabled' WHERE id = ?", [id]).run();
  } catch {
    return dbFailure();
  }
  await auditAgentQuietly(db, id, "delete");
  return { ok: true };
}

export async function authenticateAgent(
  db: D1Database,
  token: string,
  now: number,
): Promise<{ ok: true; agentId: string; agentName: string; permissions: string[] } | Failure> {
  const row = await prepare(db, "SELECT id, name, status, permissions, last_seen_at FROM agents WHERE token_hash = ?", [await sha256Hex(token)]).first<{
    id: string;
    name: string;
    status: string;
    permissions: string | null;
    last_seen_at: number | string | null;
  }>();
  if (!row) return { ok: false, status: 401, error: "令牌无效" };
  if (row.status !== "active") return { ok: false, status: 401, error: "令牌已停用" };
  // last_seen_at drives the sidebar fill order; one write per agent per
  // minute is plenty of resolution, so skip the write inside the window.
  const seen = asNumber(row.last_seen_at);
  if (seen === null || now - seen >= 60_000) {
    await prepare(db, "UPDATE agents SET last_seen_at = ? WHERE id = ?", [now, row.id]).run();
  }
  // call_count backs the card's 调用次数: every authenticated /mcp request
  // counts, so unlike last_seen_at this write is deliberately unthrottled.
  await prepare(db, "UPDATE agents SET call_count = call_count + 1 WHERE id = ?", [row.id]).run();
  return { ok: true, agentId: row.id, agentName: row.name, permissions: parsePermissions(row.permissions) };
}

export async function searchServers(db: D1Database, query: string, tag: string, withMatches: boolean): Promise<SearchHit[]> {
  const listed = await prepare(db, "SELECT * FROM mcp_servers WHERE status = 'active'").all<ServerRow>();
  const hits: SearchHit[] = [];
  for (const row of rowsOf(listed)) {
    const tools = toolsFromSnapshot(row.snapshot_json);
    const matched = matchEntry(
      {
        name: row.name,
        title: row.title,
        description: row.description ?? "",
        category: row.category ?? "",
        tags: parseStoredTags(row.tags_json),
        tools,
      },
      query,
      tag,
    );
    if (!matched.matched) continue;
    hits.push(toHit(row, withMatches ? matched.matchedTools : null));
  }
  hits.sort((left, right) => left.name.localeCompare(right.name, "zh"));
  return hits;
}

// Writes the audit row before building the config payload. A failed insert throws
// and the caller must not send endpoint or config.
export async function fetchConfigForAgent(
  db: D1Database,
  agentId: string,
  serverId: string,
  name: string,
  now: number,
): Promise<{ ok: true; config: AgentConfig } | { ok: false; error: string }> {
  let row: ServerRow | null = null;
  if (serverId) {
    const byId = await getServer(db, serverId);
    if (byId) {
      if (byId.status !== "active") return { ok: false, error: "未找到条目" };
      row = byId;
    }
  }
  if (!row && name) {
    const byName = await getServerByName(db, name);
    if (!byName || byName.status !== "active") return { ok: false, error: "未找到条目" };
    row = byName;
  }
  if (!row) return { ok: false, error: "未找到条目" };
  await prepare(db, "INSERT INTO mcp_fetch_audit (id, agent_id, server_id, created_at) VALUES (?, ?, ?, ?)", [
    crypto.randomUUID(),
    agentId,
    row.id,
    now,
  ]).run();
  return { ok: true, config: toAgentConfig(row) };
}
