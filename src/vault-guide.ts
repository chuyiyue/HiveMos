// 保险库外部连接「纯指引」（2026-11-11 Roye 定版）：连接目录 + 指引元数据。
//
// 定位写死：HiveMos 只告诉被授权的 agent「这条凭据在哪个服务商、引用是
// 什么、怎么连、建议怎么注入」，取值由使用者自己那端完成。本模块不取
// 值、不代用、不持有任何服务商凭据、对 1Password / Bitwarden 零出站
// （连测试连接都没有），引用只在写入时做本地格式校验。表里只有引用与
// 说明，结构上不存在能装值的字段。
//
// 可见性三重门（vault_guide_list）：vault.read 域门（在 tool-permissions
// 登记）之上，再加 per-agent 技能开关（agents.vault_guide_enabled，对应
// 内置技能 vault-broker）与 grant 行级 ACL；任一门不过，条目直接不出现
// 在结果里，不报错、不泄露存在性。每次调用对实际返回的每条条目写一条
// view 审计，审计写不进整次调用失败（fail-closed，与保险库 reveal 同口径）。

import { prepare } from "./registry";
import type { D1Database } from "./env";

export class GuideError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const GUIDE_PROVIDER_TYPES = ["1password", "bitwarden", "other"] as const;
export type GuideProviderType = (typeof GUIDE_PROVIDER_TYPES)[number];

const NAME_MAX = 60;
const GUIDE_MAX = 2000;
const NOTE_MAX = 300;
const REF_MAX = 500;
const PURPOSE_MAX = 300;
const INJECT_HINT_MAX = 300;
const HOST_MAX = 253;
const HOSTS_MAX = 50;
const TAG_MAX = 40;
const TAGS_MAX = 30;

function rowsOf<T>(value: { results?: T[] } | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.results)) return value.results;
  return [];
}

function newGuideId(prefix: string): string {
  return prefix + "_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

function asBool(value: number | string | null | undefined): boolean {
  return Number(value ?? 0) === 1;
}

function optText(body: Record<string, unknown>, key: string, max: number, label: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new GuideError(label + "格式不正确");
  const trimmed = value.trim();
  if (trimmed.length > max) throw new GuideError(label + "太长了");
  return trimmed;
}

function reqText(body: Record<string, unknown>, key: string, max: number, label: string): string {
  const value = optText(body, key, max, label);
  if (!value) throw new GuideError("请填写" + label);
  return value;
}

function optEnabled(body: Record<string, unknown>): boolean | undefined {
  const value = body.enabled;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new GuideError("启用状态不正确");
  return value;
}

function stringList(value: unknown, maxItem: number, maxCount: number, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new GuideError(label + "格式不正确");
  if (value.length > maxCount) throw new GuideError(label + "太多了");
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new GuideError(label + "格式不正确");
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > maxItem) throw new GuideError(label + "太长了");
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function parseJsonList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

// 引用只做本地格式校验，绝不发任何外部请求验证（零出站纪律）。
// 返回错误文案或 null（通过）。1password 型须是 op:// 形状（至少
// 库/条目两段）；bitwarden 型与其余只要求非空（project＋机密标识的
// 自由文本），非空由 reqText 先行保证。
export function validateGuideRef(type: GuideProviderType, ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return "请填写引用";
  if (type === "1password") {
    if (!/^op:\/\/[^/\s]+(\/[^/\s]+)+\/?$/.test(trimmed)) {
      return "1Password 引用须是 op://库/条目/字段 形状";
    }
  }
  return null;
}

// ---- 行形状与对外视图 -------------------------------------------------------

export interface GuideProviderRow {
  id: string;
  name: string;
  type: string;
  connect_guide: string;
  note: string;
  enabled: number | string;
  created_at: number | string;
  updated_at: number | string;
}

export interface GuideEntryRow {
  id: string;
  provider_id: string;
  name: string;
  ref: string;
  purpose: string;
  inject_hint: string;
  allowed_hosts: string;
  tags: string;
  enabled: number | string;
  created_at: number | string;
  updated_at: number | string;
}

export interface GuideGrantRow {
  id: string;
  entry_id: string;
  agent_id: string;
  expires_at: number | string | null;
  enabled: number | string;
  created_at: number | string;
}

export interface GuideAuditRow {
  id: string;
  ts: number | string;
  agent_id: string;
  entry_id: string;
  action: string;
  meta: string;
}

const PROVIDER_COLUMNS = "id, name, type, connect_guide, note, enabled, created_at, updated_at";
const ENTRY_COLUMNS = "id, provider_id, name, ref, purpose, inject_hint, allowed_hosts, tags, enabled, created_at, updated_at";
const GRANT_COLUMNS = "id, entry_id, agent_id, expires_at, enabled, created_at";
const AUDIT_COLUMNS = "id, ts, agent_id, entry_id, action, meta";

export function providerPublic(row: GuideProviderRow) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    connect_guide: row.connect_guide,
    note: row.note,
    enabled: asBool(row.enabled),
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
  };
}

export function entryPublic(row: GuideEntryRow, provider?: GuideProviderRow | null) {
  return {
    id: row.id,
    provider_id: row.provider_id,
    provider_name: provider?.name ?? null,
    provider_type: provider?.type ?? null,
    name: row.name,
    ref: row.ref,
    purpose: row.purpose,
    inject_hint: row.inject_hint,
    allowed_hosts: parseJsonList(row.allowed_hosts),
    tags: parseJsonList(row.tags),
    enabled: asBool(row.enabled),
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
  };
}

export function grantPublic(row: GuideGrantRow, agentName: string | null, now: number) {
  const expiresAt = row.expires_at == null ? null : Number(row.expires_at);
  return {
    id: row.id,
    entry_id: row.entry_id,
    agent_id: row.agent_id,
    agent_name: agentName,
    expires_at: expiresAt,
    enabled: asBool(row.enabled),
    expired: expiresAt != null && expiresAt <= now,
    created_at: Number(row.created_at) || 0,
  };
}

export function auditPublic(row: GuideAuditRow) {
  let meta: unknown = {};
  try {
    meta = JSON.parse(row.meta) as unknown;
  } catch {
    meta = {};
  }
  return {
    id: row.id,
    ts: Number(row.ts) || 0,
    agent_id: row.agent_id,
    entry_id: row.entry_id,
    action: row.action,
    meta,
  };
}

// ---- 服务商 -----------------------------------------------------------------

export async function listGuideProviders(db: D1Database): Promise<GuideProviderRow[]> {
  return rowsOf(
    await prepare(db, `SELECT ${PROVIDER_COLUMNS} FROM vault_guide_provider ORDER BY name ASC, created_at ASC, id ASC`).all<GuideProviderRow>(),
  );
}

export async function getGuideProvider(db: D1Database, id: string): Promise<GuideProviderRow | null> {
  return prepare(db, `SELECT ${PROVIDER_COLUMNS} FROM vault_guide_provider WHERE id = ?`, [id]).first<GuideProviderRow>();
}

function readProviderType(body: Record<string, unknown>, fallback?: string): GuideProviderType {
  const value = body.type === undefined || body.type === null ? fallback : body.type;
  if (value !== "1password" && value !== "bitwarden" && value !== "other") {
    throw new GuideError("服务商类型不正确");
  }
  return value;
}

export async function createGuideProvider(db: D1Database, body: Record<string, unknown>): Promise<GuideProviderRow> {
  const now = Date.now();
  const row: GuideProviderRow = {
    id: newGuideId("gprov"),
    name: reqText(body, "name", NAME_MAX, "服务商名称"),
    type: readProviderType(body),
    connect_guide: optText(body, "connect_guide", GUIDE_MAX, "连接说明") ?? "",
    note: optText(body, "note", NOTE_MAX, "备注") ?? "",
    enabled: (optEnabled(body) ?? true) ? 1 : 0,
    created_at: now,
    updated_at: now,
  };
  await prepare(
    db,
    "INSERT INTO vault_guide_provider (id, name, type, connect_guide, note, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [row.id, row.name, row.type, row.connect_guide, row.note, row.enabled, row.created_at, row.updated_at],
  ).run();
  return row;
}

export async function updateGuideProvider(
  db: D1Database,
  id: string,
  body: Record<string, unknown>,
): Promise<GuideProviderRow> {
  const existing = await getGuideProvider(db, id);
  if (!existing) throw new GuideError("未找到这个服务商", 404);
  const next: GuideProviderRow = {
    ...existing,
    name: optText(body, "name", NAME_MAX, "服务商名称") ?? existing.name,
    type: readProviderType(body, existing.type),
    connect_guide: optText(body, "connect_guide", GUIDE_MAX, "连接说明") ?? existing.connect_guide,
    note: optText(body, "note", NOTE_MAX, "备注") ?? existing.note,
    enabled: (optEnabled(body) ?? asBool(existing.enabled)) ? 1 : 0,
    updated_at: Date.now(),
  };
  if (!next.name) throw new GuideError("请填写服务商名称");
  // 类型变更会改变既有条目引用的校验口径：先按新类型复核全部条目，
  // 有不合形状的引用就整体拒绝，不留下半套不一致的目录。
  if (next.type !== existing.type) {
    const entries = await listGuideEntries(db);
    const bad = entries.filter((entry) => entry.provider_id === id && validateGuideRef(next.type as GuideProviderType, entry.ref) !== null);
    if (bad.length > 0) {
      throw new GuideError(`类型改为 ${next.type} 后有 ${bad.length} 条既有引用不符合该类型的格式，请先修正引用`, 409);
    }
  }
  await prepare(
    db,
    "UPDATE vault_guide_provider SET name = ?, type = ?, connect_guide = ?, note = ?, enabled = ?, updated_at = ? WHERE id = ?",
    [next.name, next.type, next.connect_guide, next.note, next.enabled, next.updated_at, id],
  ).run();
  return next;
}

export async function deleteGuideProvider(db: D1Database, id: string): Promise<GuideProviderRow> {
  const existing = await getGuideProvider(db, id);
  if (!existing) throw new GuideError("未找到这个服务商", 404);
  const count = await prepare(db, "SELECT COUNT(*) AS n FROM vault_guide_entry WHERE provider_id = ?", [id]).first<{ n: number | string }>();
  if (Number(count?.n ?? 0) > 0) throw new GuideError("这个服务商下还有条目，请先删除或迁移条目", 409);
  await prepare(db, "DELETE FROM vault_guide_provider WHERE id = ?", [id]).run();
  return existing;
}

// ---- 条目 -------------------------------------------------------------------

export async function listGuideEntries(db: D1Database): Promise<GuideEntryRow[]> {
  return rowsOf(
    await prepare(db, `SELECT ${ENTRY_COLUMNS} FROM vault_guide_entry ORDER BY name ASC, created_at ASC, id ASC`).all<GuideEntryRow>(),
  );
}

export async function getGuideEntry(db: D1Database, id: string): Promise<GuideEntryRow | null> {
  return prepare(db, `SELECT ${ENTRY_COLUMNS} FROM vault_guide_entry WHERE id = ?`, [id]).first<GuideEntryRow>();
}

async function requireProvider(db: D1Database, providerId: unknown): Promise<GuideProviderRow> {
  if (typeof providerId !== "string" || !providerId.trim()) throw new GuideError("请选择服务商");
  const provider = await getGuideProvider(db, providerId.trim());
  if (!provider) throw new GuideError("未找到这个服务商", 404);
  return provider;
}

export async function createGuideEntry(db: D1Database, body: Record<string, unknown>): Promise<GuideEntryRow> {
  const provider = await requireProvider(db, body.provider_id);
  const ref = reqText(body, "ref", REF_MAX, "引用");
  const refError = validateGuideRef(provider.type as GuideProviderType, ref);
  if (refError) throw new GuideError(refError);
  const now = Date.now();
  const hosts = stringList(body.allowed_hosts, HOST_MAX, HOSTS_MAX, "允许主机") ?? [];
  const tags = stringList(body.tags, TAG_MAX, TAGS_MAX, "标签") ?? [];
  const row: GuideEntryRow = {
    id: newGuideId("gent"),
    provider_id: provider.id,
    name: reqText(body, "name", NAME_MAX, "条目名称"),
    ref,
    purpose: optText(body, "purpose", PURPOSE_MAX, "用途") ?? "",
    inject_hint: optText(body, "inject_hint", INJECT_HINT_MAX, "注入方式") ?? "",
    allowed_hosts: JSON.stringify(hosts),
    tags: JSON.stringify(tags),
    enabled: (optEnabled(body) ?? true) ? 1 : 0,
    created_at: now,
    updated_at: now,
  };
  await prepare(
    db,
    "INSERT INTO vault_guide_entry (id, provider_id, name, ref, purpose, inject_hint, allowed_hosts, tags, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [row.id, row.provider_id, row.name, row.ref, row.purpose, row.inject_hint, row.allowed_hosts, row.tags, row.enabled, row.created_at, row.updated_at],
  ).run();
  return row;
}

export async function updateGuideEntry(db: D1Database, id: string, body: Record<string, unknown>): Promise<GuideEntryRow> {
  const existing = await getGuideEntry(db, id);
  if (!existing) throw new GuideError("未找到这个条目", 404);
  const provider =
    body.provider_id === undefined || body.provider_id === null
      ? await getGuideProvider(db, existing.provider_id)
      : await requireProvider(db, body.provider_id);
  if (!provider) throw new GuideError("未找到这个服务商", 404);
  const ref = optText(body, "ref", REF_MAX, "引用") ?? existing.ref;
  if (!ref) throw new GuideError("请填写引用");
  const refError = validateGuideRef(provider.type as GuideProviderType, ref);
  if (refError) throw new GuideError(refError);
  const hosts = stringList(body.allowed_hosts, HOST_MAX, HOSTS_MAX, "允许主机");
  const tags = stringList(body.tags, TAG_MAX, TAGS_MAX, "标签");
  const next: GuideEntryRow = {
    ...existing,
    provider_id: provider.id,
    name: optText(body, "name", NAME_MAX, "条目名称") ?? existing.name,
    ref,
    purpose: optText(body, "purpose", PURPOSE_MAX, "用途") ?? existing.purpose,
    inject_hint: optText(body, "inject_hint", INJECT_HINT_MAX, "注入方式") ?? existing.inject_hint,
    allowed_hosts: hosts === undefined ? existing.allowed_hosts : JSON.stringify(hosts),
    tags: tags === undefined ? existing.tags : JSON.stringify(tags),
    enabled: (optEnabled(body) ?? asBool(existing.enabled)) ? 1 : 0,
    updated_at: Date.now(),
  };
  if (!next.name) throw new GuideError("请填写条目名称");
  await prepare(
    db,
    "UPDATE vault_guide_entry SET provider_id = ?, name = ?, ref = ?, purpose = ?, inject_hint = ?, allowed_hosts = ?, tags = ?, enabled = ?, updated_at = ? WHERE id = ?",
    [next.provider_id, next.name, next.ref, next.purpose, next.inject_hint, next.allowed_hosts, next.tags, next.enabled, next.updated_at, id],
  ).run();
  return next;
}

export async function deleteGuideEntry(db: D1Database, id: string): Promise<GuideEntryRow> {
  const existing = await getGuideEntry(db, id);
  if (!existing) throw new GuideError("未找到这个条目", 404);
  // 授权随条目一并删除；审计行保留为历史事实，不随删。
  await prepare(db, "DELETE FROM vault_guide_grant WHERE entry_id = ?", [id]).run();
  await prepare(db, "DELETE FROM vault_guide_entry WHERE id = ?", [id]).run();
  return existing;
}

// ---- 授权 -------------------------------------------------------------------

export async function listGuideGrants(db: D1Database): Promise<GuideGrantRow[]> {
  return rowsOf(
    await prepare(db, `SELECT ${GRANT_COLUMNS} FROM vault_guide_grant ORDER BY created_at ASC, id ASC`).all<GuideGrantRow>(),
  );
}

export async function getGuideGrant(db: D1Database, id: string): Promise<GuideGrantRow | null> {
  return prepare(db, `SELECT ${GRANT_COLUMNS} FROM vault_guide_grant WHERE id = ?`, [id]).first<GuideGrantRow>();
}

export async function findAgentName(db: D1Database, agentId: string): Promise<string | null> {
  const row = await prepare(db, "SELECT id, name FROM agents WHERE id = ?", [agentId]).first<{ id: string; name: string }>();
  return row?.name ?? null;
}

function readExpiresAt(body: Record<string, unknown>, fallback: number | null): number | null {
  const value = body.expires_at;
  if (value === undefined) return fallback;
  if (value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new GuideError("过期时间不正确");
  return Math.floor(value);
}

export async function createGuideGrant(db: D1Database, body: Record<string, unknown>): Promise<GuideGrantRow> {
  const entryId = typeof body.entry_id === "string" ? body.entry_id.trim() : "";
  if (!entryId) throw new GuideError("请选择条目");
  const entry = await getGuideEntry(db, entryId);
  if (!entry) throw new GuideError("未找到这个条目", 404);
  const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
  if (!agentId) throw new GuideError("请选择 Agent");
  const agentName = await findAgentName(db, agentId);
  if (agentName === null) throw new GuideError("未找到这个 Agent", 404);
  const duplicate = await prepare(db, `SELECT ${GRANT_COLUMNS} FROM vault_guide_grant WHERE entry_id = ? AND agent_id = ?`, [
    entryId,
    agentId,
  ]).first<GuideGrantRow>();
  if (duplicate) throw new GuideError("这个 Agent 对这条条目已有授权，请直接编辑既有授权", 409);
  const row: GuideGrantRow = {
    id: newGuideId("ggrt"),
    entry_id: entryId,
    agent_id: agentId,
    expires_at: readExpiresAt(body, null),
    enabled: (optEnabled(body) ?? true) ? 1 : 0,
    created_at: Date.now(),
  };
  await prepare(db, "INSERT INTO vault_guide_grant (id, entry_id, agent_id, expires_at, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    row.id,
    row.entry_id,
    row.agent_id,
    row.expires_at,
    row.enabled,
    row.created_at,
  ]).run();
  return row;
}

export async function updateGuideGrant(db: D1Database, id: string, body: Record<string, unknown>): Promise<GuideGrantRow> {
  const existing = await getGuideGrant(db, id);
  if (!existing) throw new GuideError("未找到这条授权", 404);
  const next: GuideGrantRow = {
    ...existing,
    expires_at: readExpiresAt(body, existing.expires_at == null ? null : Number(existing.expires_at)),
    enabled: (optEnabled(body) ?? asBool(existing.enabled)) ? 1 : 0,
  };
  await prepare(db, "UPDATE vault_guide_grant SET expires_at = ?, enabled = ? WHERE id = ?", [next.expires_at, next.enabled, id]).run();
  return next;
}

export async function deleteGuideGrant(db: D1Database, id: string): Promise<GuideGrantRow> {
  const existing = await getGuideGrant(db, id);
  if (!existing) throw new GuideError("未找到这条授权", 404);
  await prepare(db, "DELETE FROM vault_guide_grant WHERE id = ?", [id]).run();
  return existing;
}

// ---- per-agent 技能开关 -------------------------------------------------------

export async function getVaultGuideEnabled(db: D1Database, agentId: string): Promise<boolean> {
  const row = await prepare(db, "SELECT vault_guide_enabled FROM agents WHERE id = ?", [agentId]).first<{
    vault_guide_enabled: number | string | null;
  }>();
  return asBool(row?.vault_guide_enabled);
}

export async function setVaultGuideEnabled(db: D1Database, agentId: string, enabled: boolean): Promise<void> {
  await prepare(db, "UPDATE agents SET vault_guide_enabled = ? WHERE id = ?", [enabled ? 1 : 0, agentId]).run();
}

// ---- Agent 面：指引查询（三重门中的后两重） ------------------------------------

export interface GuideForAgentItem {
  entry_id: string;
  name: string;
  ref: string;
  purpose: string;
  inject_hint: string;
  allowed_hosts: string[];
  tags: string[];
  provider: { id: string; name: string; type: string; connect_guide: string };
}

interface GuideVisibleRow extends GuideEntryRow {
  provider_name: string;
  provider_type: string;
  provider_connect_guide: string;
}

// 返回调用 agent 当前可见的指引全集，并对返回的每条逐条写 view 审计。
// 技能开关没开、没有有效 grant、条目或服务商停用、grant 过期——一律
// 表现为「不在结果里」，不区分原因、不泄露存在性。审计写失败整次抛出
// GuideError（fail-closed），不返回未审计的指引。
export async function listGuideForAgent(db: D1Database, agentId: string, now: number): Promise<GuideForAgentItem[]> {
  if (!agentId) return [];
  if (!(await getVaultGuideEnabled(db, agentId))) return [];
  const rows = rowsOf(
    await prepare(
      db,
      "SELECT e.id, e.provider_id, e.name, e.ref, e.purpose, e.inject_hint, e.allowed_hosts, e.tags, e.enabled, e.created_at, e.updated_at, " +
        "p.name AS provider_name, p.type AS provider_type, p.connect_guide AS provider_connect_guide " +
        "FROM vault_guide_entry e " +
        "JOIN vault_guide_provider p ON p.id = e.provider_id " +
        "JOIN vault_guide_grant g ON g.entry_id = e.id AND g.agent_id = ? " +
        "WHERE e.enabled = 1 AND p.enabled = 1 AND g.enabled = 1 AND (g.expires_at IS NULL OR g.expires_at > ?) " +
        "ORDER BY p.name ASC, e.name ASC, e.id ASC",
      [agentId, now],
    ).all<GuideVisibleRow>(),
  );
  const items = rows.map((row) => ({
    entry_id: row.id,
    name: row.name,
    ref: row.ref,
    purpose: row.purpose,
    inject_hint: row.inject_hint,
    allowed_hosts: parseJsonList(row.allowed_hosts),
    tags: parseJsonList(row.tags),
    provider: {
      id: row.provider_id,
      name: row.provider_name,
      type: row.provider_type,
      connect_guide: row.provider_connect_guide,
    },
  }));
  for (const item of items) {
    try {
      await prepare(db, "INSERT INTO vault_guide_audit (id, ts, agent_id, entry_id, action, meta) VALUES (?, ?, ?, ?, ?, ?)", [
        newGuideId("gaud"),
        now,
        agentId,
        item.entry_id,
        "view",
        JSON.stringify({ via: "mcp", tool: "vault_guide_list" }),
      ]).run();
    } catch {
      throw new GuideError("审计写入失败，本次指引未返回", 503);
    }
  }
  return items;
}

// ---- 审计（管理侧只读） -------------------------------------------------------

const AUDIT_FETCH_CAP = 5000;

export async function listGuideAudit(
  db: D1Database,
  filter: { entryId?: string; agentId?: string; limit?: number } = {},
): Promise<GuideAuditRow[]> {
  const limit = Math.min(Math.max(Math.floor(filter.limit ?? 100) || 100, 1), 500);
  const rows = rowsOf(
    await prepare(db, `SELECT ${AUDIT_COLUMNS} FROM vault_guide_audit ORDER BY ts DESC, id DESC LIMIT ?`, [AUDIT_FETCH_CAP]).all<GuideAuditRow>(),
  );
  return rows
    .filter((row) => (filter.entryId ? row.entry_id === filter.entryId : true))
    .filter((row) => (filter.agentId ? row.agent_id === filter.agentId : true))
    .slice(0, limit);
}
