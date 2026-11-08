// POST /mcp is a stateless JSON-RPC registry. tools/call checks the agent
// bearer. Search and list never return endpoint or config; mcp_get does,
// and only after the fetch audit row is written.

import { json } from "./http";
import type { Env, WaitCtx } from "./env";
import { authenticateAgent, fetchConfigForAgent, searchServers } from "./registry";
import {
  CalError,
  calendarPublic,
  createEvent,
  deleteEvent,
  eventPublic,
  findConflicts,
  getEvent,
  instancePublic,
  listCalendars,
  listInstances,
  parseIsoInstant,
  searchEvents,
  updateEvent,
} from "./calendar";

const MAX_BODY_BYTES = 64 * 1024;

const TOOLS = [
  {
    name: "mcp_search",
    description: "按关键词搜索已登记的 MCP 条目，可叠加标签过滤。不返回端点或配置",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词，匹配名称、标题、说明、标签、分类和快照里的工具名与描述" },
        tag: { type: "string", description: "只保留标签文本完全相同的条目，不区分大小写" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mcp_list",
    description: "列出已启用的 MCP 条目，可按标签过滤。不返回端点或配置",
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "只保留标签文本完全相同的条目，不区分大小写" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mcp_get",
    description: "按 server_id 或 name 取回端点、传输和配置模板。成功时记一条获取审计。密钥是 {{vault://…}} 占位，请直连下游，不要把流量送回本服务",
    inputSchema: {
      type: "object",
      properties: {
        server_id: { type: "string", description: "条目 id" },
        name: { type: "string", description: "条目 name" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "calendar_list_calendars",
    description: "列出全部日历，含类型、颜色、是否只读与同步状态",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "calendar_list_events",
    description: "按时间段查日程，重复日程已按规则展开。时间用带时区的 ISO 8601",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "起始时间（ISO 8601），缺省为现在" },
        to: { type: "string", description: "结束时间（ISO 8601），缺省为一个月后" },
        calendar_id: { type: "string", description: "只看指定日历，缺省为全部" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "calendar_get_event",
    description: "按 event_id 取一条日程的完整信息",
    inputSchema: {
      type: "object",
      properties: { event_id: { type: "string", description: "日程 id" } },
      required: ["event_id"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_search",
    description: "按关键词搜日程（标题、地点、描述），返回时间段内的实例",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词" },
        from: { type: "string", description: "起始时间（ISO 8601），缺省为一个月前" },
        to: { type: "string", description: "结束时间（ISO 8601），缺省为十三个月后" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_create_event",
    description: "新建日程。默认查冲突：与已有日程重叠时返回 conflicts 清单，只提示不拦截。重复日程传 rrule 原文，起止时间用带时区的 ISO 8601 并给 tzid",
    inputSchema: {
      type: "object",
      properties: {
        calendar_id: { type: "string", description: "目标日历，缺省用默认日历" },
        title: { type: "string", description: "标题" },
        start: { type: "string", description: "开始时间（ISO 8601）；全天日程用 YYYY-MM-DD" },
        end: { type: "string", description: "结束时间（ISO 8601）；全天日程用 YYYY-MM-DD（不含当天）" },
        tzid: { type: "string", description: "时区，如 Asia/Shanghai" },
        all_day: { type: "boolean", description: "是否全天日程" },
        rrule: { type: "string", description: "重复规则原文，如 FREQ=WEEKLY;BYDAY=MO,WE" },
        location: { type: "string", description: "地点" },
        description: { type: "string", description: "描述" },
        check_conflict: { type: "boolean", description: "是否查冲突，缺省查" },
      },
      required: ["title", "start", "end"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_update_event",
    description: "修改日程，只传要改的字段。改重复日程的某一次：传 instance_start（那一次的开始时间）会生成例外实例，不动整组",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "日程 id" },
        instance_start: { type: "string", description: "只改这一次时传那一次的开始时间（ISO 8601）" },
        etag: { type: "number", description: "读到的版本号，传了就做并发校验" },
        title: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        tzid: { type: "string" },
        all_day: { type: "boolean" },
        rrule: { type: ["string", "null"], description: "新的重复规则；传 null 表示取消重复" },
        location: { type: "string" },
        description: { type: "string" },
        status: { type: "string", description: "confirmed 或 cancelled" },
      },
      required: ["event_id"],
      additionalProperties: false,
    },
  },
  {
    name: "calendar_delete_event",
    description: "删除日程。scope 为 series 删整组（缺省），instance 加 instance_start 只删某一次",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "日程 id" },
        scope: { type: "string", description: "series 或 instance" },
        instance_start: { type: "string", description: "删某一次时传那一次的开始时间（ISO 8601）" },
      },
      required: ["event_id"],
      additionalProperties: false,
    },
  },
];

// Every panel tool belongs to a permission domain (see PERMISSION_DOMAINS
// in registry.ts). All current tools are registry-domain; future boards add
// their own entries here.
const TOOL_DOMAINS: Record<string, string> = {
  mcp_search: "registry",
  mcp_list: "registry",
  mcp_get: "registry",
  calendar_list_calendars: "calendar",
  calendar_list_events: "calendar",
  calendar_get_event: "calendar",
  calendar_search: "calendar",
  calendar_create_event: "calendar",
  calendar_update_event: "calendar",
  calendar_delete_event: "calendar",
};

function domainOfTool(name: string): string | null {
  return Object.prototype.hasOwnProperty.call(TOOL_DOMAINS, name) ? TOOL_DOMAINS[name] : null;
}

export async function handleMcp(request: Request, env: Env, _ctx: WaitCtx): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "只接受 POST" } }, 405, { allow: "POST" });
  }
  const body = await readBody(request);
  if (!body.ok) return rpcError(null, body.code, body.message, body.status);
  const message = body.value;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(null, -32600, "请求格式不正确");
  }
  const record = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (record.jsonrpc != null && record.jsonrpc !== "2.0") return rpcError(idOf(record), -32600, "请求格式不正确");
  if (typeof record.method !== "string" || !record.method) return rpcError(idOf(record), -32600, "请求格式不正确");
  if (!Object.prototype.hasOwnProperty.call(record, "id") || record.id === undefined) {
    return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
  }
  const id = record.id;
  if (id !== null && typeof id !== "string" && typeof id !== "number") return rpcError(null, -32600, "请求格式不正确");
  try {
    if (record.method === "initialize") return initialize(id, record.params);
    if (record.method === "notifications/initialized") return rpcResult(id, {});
    if (record.method === "tools/list") return listTools(request, env, id);
    if (record.method === "tools/call") return callTool(request, env, id, record.params);
    return rpcError(id, -32601, "方法不存在");
  } catch {
    return rpcError(id, -32603, "服务器错误", 500);
  }
}

function initialize(id: unknown, params: unknown): Response {
  let protocol = "2024-11-05";
  if (params && typeof params === "object" && typeof (params as { protocolVersion?: unknown }).protocolVersion === "string") {
    const requested = (params as { protocolVersion: string }).protocolVersion.trim();
    if (requested) protocol = requested;
  }
  return rpcResult(id, {
    protocolVersion: protocol,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "HiveMos", version: "0.1.0" },
  });
}

// tools/list is filtered by the calling agent permissions: a tool whose
// domain is not granted simply does not appear. Requests without a bearer
// keep the historical public listing (downstream snapshot probes rely on
// it); a bearer that fails authentication is rejected like tools/call.
async function listTools(request: Request, env: Env, id: unknown): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return rpcResult(id, { tools: TOOLS });
  const auth = await authenticateAgent(env.DB, token, Date.now());
  if (!auth.ok) return rpcError(id, -32001, auth.error, 401);
  const tools = TOOLS.filter((tool) => {
    const domain = domainOfTool(tool.name);
    return domain !== null && auth.permissions.includes(domain);
  });
  return rpcResult(id, { tools });
}

async function callTool(request: Request, env: Env, id: unknown, params: unknown): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return rpcError(id, -32001, "缺少 Bearer 令牌", 401);
  const auth = await authenticateAgent(env.DB, token, Date.now());
  if (!auth.ok) return rpcError(id, -32001, auth.error, 401);
  if (!params || typeof params !== "object") return rpcError(id, -32602, "参数不正确");
  const name = (params as { name?: unknown }).name;
  const args = (params as { arguments?: unknown }).arguments;
  if (typeof name !== "string") return rpcError(id, -32602, "参数不正确");
  const record = args == null ? {} : args;
  if (typeof record !== "object" || Array.isArray(record)) return rpcError(id, -32602, "参数不正确");
  const fields = record as { query?: unknown; tag?: unknown; server_id?: unknown; name?: unknown };
  const domain = domainOfTool(name);
  if (domain && !auth.permissions.includes(domain)) {
    return rpcError(id, -32003, "该 Agent 没有 " + domain + " 权限，无法调用这个工具", 403);
  }
  if (name === "mcp_search") {
    const query = readString(fields.query);
    const tag = readString(fields.tag);
    if (query == null || tag == null) return rpcError(id, -32602, "参数不正确");
    const servers = await searchServers(env.DB, query, tag, true);
    return toolResult(id, { servers });
  }
  if (name === "mcp_list") {
    const tag = readString(fields.tag);
    if (tag == null) return rpcError(id, -32602, "参数不正确");
    const servers = await searchServers(env.DB, "", tag, false);
    return toolResult(id, { servers });
  }
  if (name === "mcp_get") {
    const serverId = readString(fields.server_id);
    const serverName = readString(fields.name);
    if (serverId == null || serverName == null) return rpcError(id, -32602, "参数不正确");
    if (!serverId.trim() && !serverName.trim()) return toolResult(id, "请提供 server_id 或 name", true);
    const fetched = await fetchConfigForAgent(env.DB, auth.agentId, serverId.trim(), serverName.trim(), Date.now());
    if (!fetched.ok) return toolResult(id, fetched.error, true);
    return toolResult(id, fetched.config);
  }
  if (name.startsWith("calendar_")) {
    try {
      return await callCalendarTool(env, id, name, record as Record<string, unknown>, auth.agentId);
    } catch (error) {
      if (error instanceof CalError) return toolResult(id, error.message, true);
      throw error;
    }
  }
  return toolResult(id, "未知工具", true);
}

function argString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

async function callCalendarTool(env: Env, id: unknown, name: string, args: Record<string, unknown>, agentId: string): Promise<Response> {
  const now = Date.now();
  if (name === "calendar_list_calendars") {
    const calendars = await listCalendars(env.DB);
    return toolResult(id, { calendars: calendars.map(calendarPublic) });
  }
  if (name === "calendar_list_events") {
    const fromMs = parseIsoInstant(args.from) ?? now;
    const toMs = parseIsoInstant(args.to) ?? now + 31 * 24 * 60 * 60 * 1000;
    const calendarId = argString(args, "calendar_id");
    const instances = await listInstances(env.DB, { fromMs, toMs, calendarIds: calendarId ? [calendarId] : null });
    return toolResult(id, { instances: instances.map(instancePublic) });
  }
  if (name === "calendar_get_event") {
    const eventId = argString(args, "event_id");
    if (!eventId) return toolResult(id, "请提供 event_id", true);
    const row = await getEvent(env.DB, eventId);
    if (!row || row.deleted_at != null) return toolResult(id, "日程不存在或已删除", true);
    return toolResult(id, { event: eventPublic(row) });
  }
  if (name === "calendar_search") {
    const query = argString(args, "query");
    if (!query || !query.trim()) return toolResult(id, "请提供 query", true);
    const fromMs = parseIsoInstant(args.from) ?? now - 30 * 24 * 60 * 60 * 1000;
    const toMs = parseIsoInstant(args.to) ?? now + 395 * 24 * 60 * 60 * 1000;
    const instances = await searchEvents(env.DB, query.trim(), { fromMs, toMs });
    return toolResult(id, { instances: instances.map(instancePublic) });
  }
  if (name === "calendar_create_event") {
    const created = await createEvent(env.DB, args, agentId, "mcp", now);
    const conflicts = args.check_conflict === false
      ? []
      : await findConflicts(env.DB, { startMs: created.starts_at, endMs: created.ends_at, excludeEventId: created.id });
    return toolResult(id, { event: eventPublic(created), conflicts });
  }
  if (name === "calendar_update_event") {
    const eventId = argString(args, "event_id");
    if (!eventId) return toolResult(id, "请提供 event_id", true);
    const etag = typeof args.etag === "number" ? args.etag : null;
    const updated = await updateEvent(env.DB, eventId, args, agentId, "mcp", now, etag);
    return toolResult(id, { event: eventPublic(updated) });
  }
  if (name === "calendar_delete_event") {
    const eventId = argString(args, "event_id");
    if (!eventId) return toolResult(id, "请提供 event_id", true);
    const result = await deleteEvent(env.DB, eventId, args, agentId, now);
    return toolResult(id, result);
  }
  return toolResult(id, "未知工具", true);
}

function readString(value: unknown): string | null {
  if (value == null) return "";
  if (typeof value !== "string") return null;
  return value;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

function idOf(record: { id?: unknown }): unknown {
  return record.id === undefined ? null : record.id;
}

function rpcResult(id: unknown, result: unknown, status = 200): Response {
  return json({ jsonrpc: "2.0", id, result }, status);
}

function rpcError(id: unknown, code: number, message: string, status = 200): Response {
  const headers = status === 401 ? { "www-authenticate": "Bearer" } : undefined;
  return json({ jsonrpc: "2.0", id, error: { code, message } }, status, headers);
}

function toolResult(id: unknown, payload: unknown, isError = false): Response {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  const result: Record<string, unknown> = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  else if (payload && typeof payload === "object") result.structuredContent = payload;
  return rpcResult(id, result);
}

async function readBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; code: number; message: string; status: number }> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0 || length > MAX_BODY_BYTES) {
      return { ok: false, code: -32600, message: "请求格式不正确", status: 400 };
    }
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, code: -32700, message: "解析失败", status: 400 };
  }
  if (text.length > MAX_BODY_BYTES) return { ok: false, code: -32600, message: "请求格式不正确", status: 400 };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, code: -32700, message: "解析失败", status: 400 };
  }
}
