// POST /mcp is a stateless JSON-RPC registry. tools/call checks the agent
// bearer. Search and list never return endpoint or config; mcp_get does,
// and only after the fetch audit row is written.

import { json } from "./http";
import type { Env, WaitCtx } from "./env";
import { authenticateAgent, fetchConfigForAgent, searchServers } from "./registry";

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
];

// Every panel tool belongs to a permission domain (see PERMISSION_DOMAINS
// in registry.ts). All current tools are registry-domain; future boards add
// their own entries here.
const TOOL_DOMAINS: Record<string, string> = {
  mcp_search: "registry",
  mcp_list: "registry",
  mcp_get: "registry",
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
