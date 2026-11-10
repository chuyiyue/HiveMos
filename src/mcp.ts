// POST /mcp is a stateless JSON-RPC registry. tools/call checks the agent
// bearer. Search and list never return endpoint or config; mcp_get does,
// and only after the fetch audit row is written.

import { json } from "./http";
import type { Env, WaitCtx } from "./env";
import { authenticateAgent, fetchConfigForAgent, recordToolDenied, searchServers } from "./registry";
import { toolPermissionOf, toolAccessError, toolVisibleToAgent } from "./tool-permissions";
import type { AgentPermissions } from "./permissions";
import {
  SoulError,
  diffSoulVersions,
  getSoulByName,
  getVersion,
  listSouls,
  patchSoulByName,
  recordSoulRead,
  soulDetail,
  soulFullView,
  soulSummary,
  soulVersionStatus,
  upsertSoulByName,
} from "./soul";
import { logOp } from "./oplog";
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
import {
  MemError,
  deleteMemory,
  listMemoriesAudited,
  memoryPublic,
  parseTags,
  readMemory,
  searchMemoriesAudited,
  upsertMemory,
} from "./memory";
import type { MemoryRow } from "./memory";
import {
  TaskError,
  agentName,
  completeTask,
  createTask,
  deleteTask,
  listTasksForAgent,
  taskPublic,
  updateTask,
} from "./tasks";

import {
  getMachineAccessForAgent,
  getMachineForAgent,
  listMachines,
  MachineError,
  machinePublic,
  reportMachine,
  vaultKeyOf,
} from "./machines";

import { apiSummary, ExtraError, getApiForAgent, getSkillForAgent, listApis, listSkills, skillSummary } from "./extras";

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
  {
    name: "memory_list",
    description: "列出记忆，可按作用域过滤。全量结果先置顶组、后普通组，组内按权重降序、再按更新时间降序；置顶与权重互不影响。传 since（毫秒时间戳或 ISO 时间）只回增量（含这之后被删的墓碑，带 deleted_at），增量按更新时间序返回。默认每条只回 id、title、tags、snippet（有摘要用摘要，否则正文前 200 字）；传 full=true 回完整内容。limit 默认 50、上限 200，翻页传上次返回的 next_cursor",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", description: "只看指定作用域，缺省为全部" },
        since: { type: ["number", "string"], description: "增量起点：毫秒时间戳或 ISO 8601 时间" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "每页条数，默认 50，上限 200" },
        cursor: { type: "string", description: "翻页游标，传上次返回的 next_cursor" },
        full: { type: "boolean", description: "true 时每条返回完整内容" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_search",
    description: "按关键词搜记忆（标题、内容、标签）。结果先置顶组、后普通组，组内按权重降序、再按更新时间降序。默认每条只回 id、title、tags、snippet（有摘要用摘要，否则正文前 200 字）；传 full=true 回完整内容。limit 默认 50、上限 200，翻页传上次返回的 next_cursor",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词" },
        scope: { type: "string", description: "只在指定作用域内搜，缺省为全部" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "每页条数，默认 50，上限 200" },
        cursor: { type: "string", description: "翻页游标，传上次返回的 next_cursor" },
        full: { type: "boolean", description: "true 时每条返回完整内容" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_get",
    description: "按 id 取一条记忆的完整信息。成功读取会记一条审计",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "记忆 id" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_upsert",
    description: "幂等写入记忆：给 id 按 id 更新（已软删会复活），否则按标题+作用域匹配更新，都没有才新建；每次写入版本号递增。可选 weight（权重 0–100，不改变置顶）、pinned（是否置顶，不改变权重）、group_id（手动分组 id，传 null 移出分组）各自写入，未传的字段保持原值",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "记忆 id，可选" },
        title: { type: "string", description: "标题" },
        scope: { type: "string", description: "作用域，缺省为全局" },
        content: { type: "string", description: "内容" },
        tags: { type: "array", items: { type: "string" }, description: "标签，可选" },
        weight: { type: "integer", minimum: 0, maximum: 100, description: "权重 0–100。只写这个数字，不改变是否置顶。同一置顶状态下高权重排前面，可选" },
        pinned: { type: "boolean", description: "是否置顶。只写置顶标记，不改权重。置顶的记忆整组排在未置顶之前，可选" },
        group_id: { type: ["string", "null"], description: "手动分组 id；传 null 移出分组，可选" },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_delete",
    description: "软删除一条记忆（留墓碑，增量拉取能看到）",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "记忆 id" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "soul_list",
    description: "列出全部 Agent 的 Soul 当前版本摘要（Agent 名、版本号、更新时间），不含全文",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "soul_get",
    description: "按 Agent 名取 Soul 全文，只返回已生效的当前版本号；传 version 可取某个已生效的历史版本。读取会记审计",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "Agent 名" },
        version: { type: "number", description: "要取的历史版本号，缺省取当前版" },
      },
      required: ["agent_name"],
      additionalProperties: false,
    },
  },
  {
    name: "soul_update",
    description: "写入自己的 Soul 新版全文。新版本先进待批准草稿，管理员在面板批准后才生效。该 Agent 还没有 Soul 时自动新建。默认只能写自己的 Soul，代写他人需要 soul_write_any 权限",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "Agent 名，必须是令牌对应的 Agent 自己" },
        content: { type: "string", description: "Soul 全文" },
        expected_version: {
          type: "number",
          description: "可选。当前生效版本号；与服务器不一致时返回 409，避免覆盖没看过的版本",
        },
      },
      required: ["agent_name", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "soul_patch",
    description: "按段落增量修改 Soul：只改 persona、rules、tools、learned_context 四段中的一段（字符上限依次 2000、2000、2000、6000），不必提交整份全文。改动合成新全文先进待批准草稿，管理员批准后才生效，分段也随批准才同步。默认写自己的 Soul，代写他人需要 soul_write_any 权限",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "Agent 名，缺省为令牌对应的 Agent 自己" },
        section: { type: "string", description: "段落名：persona、rules、tools 或 learned_context" },
        content: { type: "string", description: "该段落的新全文" },
        expected_version: {
          type: "number",
          description: "可选。当前生效版本号；与服务器不一致时返回 409，避免覆盖没看过的版本",
        },
      },
      required: ["section", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "soul_diff",
    description: "对比 Soul 两个已生效版本的行级差异，只返回新增行与删除行，不回显全文。缺省对比当前版本与上一个已生效版本",
    inputSchema: {
      type: "object",
      properties: {
        agent_name: { type: "string", description: "Agent 名" },
        from_version: { type: "number", description: "旧版本号，可选" },
        to_version: { type: "number", description: "新版本号，可选，缺省为当前生效版本" },
      },
      required: ["agent_name"],
      additionalProperties: false,
    },
  },
  {
    name: "tasks_list",
    description: "列出任务（面板与 Agent 之间传递的工作项），可按状态或分配对象过滤。状态为 queued（排队）、active（进行中）、done（已完成）",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "只看指定状态：queued、active 或 done" },
        assignee: { type: "string", description: "只看分配给这个对象（名字）的任务" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "tasks_create",
    description: "新建任务。标题必填，可给备注、分配对象与初始状态（缺省 queued）",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "标题" },
        note: { type: "string", description: "备注" },
        assignee: { type: "string", description: "分配对象（名字），缺省不分配" },
        status: { type: "string", description: "初始状态：queued、active 或 done，缺省 queued" },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "tasks_update",
    description: "修改任务，只传要改的字段：标题、备注、状态或分配对象。状态改成 done 时会记下完成时间",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "任务 id" },
        title: { type: "string" },
        note: { type: "string" },
        status: { type: "string", description: "queued、active 或 done" },
        assignee: { type: "string", description: "新的分配对象（名字）" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "tasks_complete",
    description: "把任务标记为已完成，并记下完成时间",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "任务 id" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "machines_list",
    description: "列出云主机板块的机器（服务器、云主机、Workers），可按 kind 只看一类",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "server、cloud 或 worker，缺省为全部" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "machines_get",
    description: "按 machine_id 或 name 取一台机器的完整信息。成功时记一条获取审计",
    inputSchema: {
      type: "object",
      properties: {
        machine_id: { type: "string", description: "机器 id" },
        name: { type: "string", description: "机器名称" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "machines_report",
    description: "上报自己这台机器的状态与心跳：按 machine_id 或 name 定位，心跳时间记为当下，status 不传则保持不变",
    inputSchema: {
      type: "object",
      properties: {
        machine_id: { type: "string", description: "机器 id" },
        name: { type: "string", description: "机器名称" },
        status: { type: "string", description: "当前状态，如 running、paused、offline" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "machines_get_access",
    description: "取一台机器的接入凭据（调用先记一条取用审计）：服务器回 SSH 地址、端口、用户名与密码或私钥明文，Workers 回 Cloudflare 账号 ID 与 API 令牌明文，云主机回厂商与接入备注",
    inputSchema: {
      type: "object",
      properties: {
        machine_id: { type: "string", description: "机器 id" },
        name: { type: "string", description: "机器名称" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "skills_list",
    description: "列出 Skills 页签登记的技能摘要（名称、说明、来源、版本），不含正文",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "skills_get",
    description: "按 skill_id 或 name 取一个技能的完整内容（含正文）。成功时记一条获取审计",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "技能 id" },
        name: { type: "string", description: "技能名称" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "apis_list",
    description: "列出 API 页签登记的接口摘要（名称、端点、鉴权说明、备注），不含任何凭据",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "apis_get",
    description: "按 api_id 或 name 取一个 API 条目的完整信息。成功时记一条获取审计",
    inputSchema: {
      type: "object",
      properties: {
        api_id: { type: "string", description: "API 条目 id" },
        name: { type: "string", description: "API 条目名称" },
      },
      additionalProperties: false,
    },
  },
];

// 权限分类（域、操作、advanced 开关）在 src/tool-permissions.ts，单一事实
// 来源；这里不再维护副本。

// Read by the system-info endpoint so the settings page can report the
// size of the public tool surface without duplicating the list.
export const MCP_TOOL_COUNT = TOOLS.length;

export async function handleMcp(request: Request, env: Env, ctx: WaitCtx): Promise<Response> {
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
    if (record.method === "tools/call") return callTool(request, env, ctx, id, record.params);
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

// tools/list 只返回当前 Agent 有效权限覆盖的工具：域的开关键或 advanced
// 开关没给，工具直接不出现（machines_get_access 就是一个例子）。无 Bearer
// 的请求保持历史行为（返回全部工具，OAuth 阶段再收紧）；Bearer 认证失败
// 与 tools/call 一样报错。
async function listTools(request: Request, env: Env, id: unknown): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return rpcResult(id, { tools: TOOLS });
  const auth = await authenticateAgent(env.DB, token, Date.now());
  if (!auth.ok) return rpcError(id, -32001, auth.error, 401);
  const tools = TOOLS.filter((tool) => toolVisibleToAgent(tool.name, auth.permissions));
  return rpcResult(id, { tools });
}

async function callTool(request: Request, env: Env, ctx: WaitCtx, id: unknown, params: unknown): Promise<Response> {
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
  // 每次调用都按 (域, 操作, advanced) 复查，不靠 tools/list 的过滤结果。
  // 被拒也要在调用记录里留痕（沿用 mcp_fetch_audit，不新建表）。
  const denial = toolAccessError(name, auth.permissions, auth.agentName, record as Record<string, unknown>);
  if (denial !== null) {
    if (toolPermissionOf(name)) await recordToolDenied(env.DB, auth.agentId, name, Date.now());
    return rpcError(id, -32003, denial, 403);
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
  if (name.startsWith("memory_")) {
    try {
      return await callMemoryTool(env, ctx, id, name, record as Record<string, unknown>, auth.agentId);
    } catch (error) {
      if (error instanceof MemError) return toolResult(id, error.message, true);
      throw error;
    }
  }
  if (name.startsWith("soul_")) {
    try {
      return await callSoulTool(env, id, name, record as Record<string, unknown>, auth);
    } catch (error) {
      // Version conflicts (expected_version or a lost UNIQUE race) keep their
      // 409 on the wire; ordinary tool errors stay tool results as before.
      if (error instanceof SoulError) {
        if (error.status === 409) return rpcError(id, -32002, error.message, 409);
        return toolResult(id, error.message, true);
      }
      throw error;
    }
  }
  if (name.startsWith("machines_")) {
    try {
      return await callMachinesTool(env, id, name, record as Record<string, unknown>, auth.agentId);
    } catch (error) {
      if (error instanceof MachineError) return toolResult(id, error.message, true);
      throw error;
    }
  }
  if (name.startsWith("apis_")) {
    try {
      return await callApisTool(env, id, name, record as Record<string, unknown>, auth.agentId);
    } catch (error) {
      if (error instanceof ExtraError) return toolResult(id, error.message, true);
      throw error;
    }
  }
  if (name.startsWith("skills_")) {
    try {
      return await callSkillsTool(env, id, name, record as Record<string, unknown>, auth.agentId);
    } catch (error) {
      if (error instanceof ExtraError) return toolResult(id, error.message, true);
      throw error;
    }
  }
  if (name.startsWith("calendar_")) {
    try {
      return await callCalendarTool(env, id, name, record as Record<string, unknown>, auth.agentId);
    } catch (error) {
      if (error instanceof CalError) return toolResult(id, error.message, true);
      throw error;
    }
  }
  if (name.startsWith("tasks_")) {
    try {
      return await callTasksTool(env, id, name, record as Record<string, unknown>, auth.agentId);
    } catch (error) {
      if (error instanceof TaskError) return toolResult(id, error.message, true);
      throw error;
    }
  }
  return toolResult(id, "未知工具", true);
}

function argString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

async function callSoulTool(
  env: Env,
  id: unknown,
  name: string,
  args: Record<string, unknown>,
  auth: { agentId: string; agentName: string; permissions: AgentPermissions },
): Promise<Response> {
  const now = Date.now();
  if (name === "soul_list") {
    const souls = await listSouls(env.DB);
    return toolResult(id, { souls: souls.map(soulSummary) });
  }
  if (name === "soul_get") {
    const agentName = argString(args, "agent_name");
    if (!agentName || !agentName.trim()) return toolResult(id, "请提供 agent_name", true);
    const row = await getSoulByName(env.DB, agentName.trim());
    if (!row) return toolResult(id, "这个 Agent 还没有 Soul", true);
    const wanted = typeof args.version === "number" ? args.version : null;
    if (wanted !== null) {
      const versionRow = await getVersion(env.DB, row.id, wanted);
      // Pending and rejected rows are drafts: an agent must never read one
      // as if it were the persona currently in force.
      if (!versionRow || soulVersionStatus(versionRow) !== "active") {
        return toolResult(id, "这个版本不存在或尚未生效", true);
      }
      await recordSoulRead(env.DB, row, auth.agentId, versionRow.version, now);
      return toolResult(id, {
        agent_name: row.agent_name,
        version: versionRow.version,
        content: versionRow.content,
        created_at: versionRow.created_at,
      });
    }
    if (row.version < 1) return toolResult(id, "这个 Agent 还没有生效的 Soul，草稿待管理员批准", true);
    await recordSoulRead(env.DB, row, auth.agentId, row.version, now);
    return toolResult(id, await soulFullView(env.DB, row, now));
  }
  if (name === "soul_update") {
    const requested = argString(args, "agent_name");
    if (!requested || !requested.trim()) return toolResult(id, "请提供 agent_name", true);
    // 归属与 advanced.soul_write_any 的校验在 toolAccessError
    // （src/tool-permissions.ts）统一做，身份仍取自 Bearer，写别人的 Soul
    // 需要 soul_write_any。这里只管草稿与版本流程，逻辑不变。
    const expectedVersion = args.expected_version == null ? null : args.expected_version;
    const updated = await upsertSoulByName(
      env.DB,
      args.agent_name,
      args.content,
      expectedVersion,
      auth.agentId,
      "mcp",
      now,
    );
    if (updated.pending_version) {
      await logOp(env.DB, {
        actor: auth.agentName,
        module: "Soul",
        action: "草稿",
        targetId: updated.id,
        targetName: updated.agent_name,
        text: `Agent ${auth.agentName} 提交了 Soul（${updated.agent_name}）的待批准草稿 v${updated.pending_version}`,
      });
      return toolResult(id, {
        ...soulDetail(updated),
        status: updated.pending_status,
        pending_version: updated.pending_version,
        note: "新版本已作为草稿保存，管理员批准后才会成为当前版本",
      });
    }
    return toolResult(id, soulDetail(updated));
  }
  if (name === "soul_patch") {
    // agent_name 缺省写自己；写他人的归属校验在 toolAccessError
    // （src/tool-permissions.ts）统一做，与 soul_update 同一条口径。
    const requested = argString(args, "agent_name");
    const targetName = requested && requested.trim() ? requested.trim() : auth.agentName;
    const patched = await patchSoulByName(
      env.DB,
      targetName,
      args.section,
      args.content,
      args.expected_version == null ? null : args.expected_version,
      auth.agentId,
      "mcp",
      now,
    );
    if (patched.pending_version) {
      await logOp(env.DB, {
        actor: auth.agentName,
        module: "Soul",
        action: "草稿",
        targetId: patched.id,
        targetName: patched.agent_name,
        text: `Agent ${auth.agentName} 用 soul_patch 提交了 Soul（${patched.agent_name}）的待批准草稿 v${patched.pending_version}`,
      });
      return toolResult(id, {
        ...soulDetail(patched),
        sections: patched.sections,
        status: patched.pending_status,
        pending_version: patched.pending_version,
        note: "新版本已作为草稿保存，管理员批准后才会成为当前版本",
      });
    }
    return toolResult(id, { ...soulDetail(patched), sections: patched.sections });
  }
  if (name === "soul_diff") {
    const agentName = argString(args, "agent_name");
    if (!agentName || !agentName.trim()) return toolResult(id, "请提供 agent_name", true);
    const diff = await diffSoulVersions(env.DB, agentName.trim(), args.from_version ?? null, args.to_version ?? null);
    return toolResult(id, diff);
  }
  return toolResult(id, "未知工具", true);
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

function parseSince(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) return Math.floor(asNumber);
  }
  return null;
}

const MEMORY_PAGE_DEFAULT = 50;
const MEMORY_PAGE_MAX = 200;

// 游标用 base64 编码的偏移量，前端不需要理解内容；解码失败按无效游标处理。
function encodeMemoryCursor(offset: number): string {
  return btoa(String(offset));
}

function decodeMemoryCursor(cursor: string): number | null {
  try {
    const text = atob(cursor);
    if (!/^\d+$/.test(text)) return null;
    const offset = Number(text);
    return Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
  } catch {
    return null;
  }
}

interface MemoryPage {
  limit: number;
  offset: number;
  full: boolean;
}

function parseMemoryPage(args: Record<string, unknown>): MemoryPage | null {
  let limit = MEMORY_PAGE_DEFAULT;
  const raw = args.limit;
  const numeric = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
  if (Number.isFinite(numeric) && numeric > 0) limit = Math.floor(numeric);
  if (limit > MEMORY_PAGE_MAX) limit = MEMORY_PAGE_MAX;
  let offset = 0;
  const cursor = argString(args, "cursor");
  if (cursor && cursor.trim()) {
    const decoded = decodeMemoryCursor(cursor.trim());
    if (decoded === null) return null;
    offset = decoded;
  }
  return { limit, offset, full: args.full === true };
}

function memoryBrief(row: MemoryRow): Record<string, unknown> {
  const summary = row.ai_summary && row.ai_summary.trim() ? row.ai_summary : row.content.slice(0, 200);
  const view: Record<string, unknown> = { id: row.id, title: row.title, tags: parseTags(row.tags_json), snippet: summary };
  // since 增量的墓碑仍要能被同步方识别，其余字段照旧不返回。
  if (row.deleted_at != null) view.deleted_at = row.deleted_at;
  return view;
}

function memoryPageResult(id: unknown, rows: MemoryRow[], page: MemoryPage): Response {
  const hasMore = rows.length > page.limit;
  const visible = hasMore ? rows.slice(0, page.limit) : rows;
  return toolResult(id, {
    memories: visible.map((row) => (page.full ? memoryPublic(row) : memoryBrief(row))),
    next_cursor: hasMore ? encodeMemoryCursor(page.offset + page.limit) : null,
  });
}

async function callMemoryTool(env: Env, ctx: WaitCtx, id: unknown, name: string, args: Record<string, unknown>, agentId: string): Promise<Response> {
  const now = Date.now();
  // MCP 写入的记忆默认归属调用 Agent（agent_name 列），面板写入为全局。
  const channel = { actor: agentId, source: "mcp", auditReads: true, agentName: (await agentName(env.DB, agentId)) ?? null };
  if (name === "memory_list") {
    const page = parseMemoryPage(args);
    if (!page) return toolResult(id, "游标无效", true);
    const scope = argString(args, "scope");
    const since = parseSince(args.since);
    const rows = await listMemoriesAudited(
      env.DB,
      { scope: scope || null, since, limit: page.limit + 1, offset: page.offset },
      channel,
      now,
    );
    return memoryPageResult(id, rows, page);
  }
  if (name === "memory_search") {
    const query = argString(args, "query");
    if (!query || !query.trim()) return toolResult(id, "请提供 query", true);
    const page = parseMemoryPage(args);
    if (!page) return toolResult(id, "游标无效", true);
    const scope = argString(args, "scope");
    const rows = await searchMemoriesAudited(
      env.DB,
      query.trim(),
      scope || null,
      { limit: page.limit + 1, offset: page.offset },
      channel,
      now,
    );
    return memoryPageResult(id, rows, page);
  }
  if (name === "memory_get") {
    const memId = argString(args, "id");
    if (!memId) return toolResult(id, "请提供 id", true);
    const row = await readMemory(env.DB, memId, channel, now);
    if (!row) return toolResult(id, "记忆不存在或已删除", true);
    return toolResult(id, { memory: memoryPublic(row) });
  }
  if (name === "memory_upsert") {
    const row = await upsertMemory(env.DB, args, channel, now, { ai: { env, ctx } });
    return toolResult(id, { memory: memoryPublic(row) });
  }
  if (name === "memory_delete") {
    const memId = argString(args, "id");
    if (!memId) return toolResult(id, "请提供 id", true);
    const row = await deleteMemory(env.DB, memId, channel, now);
    return toolResult(id, { memory: memoryPublic(row), deleted: true });
  }
  return toolResult(id, "未知工具", true);
}
async function callTasksTool(env: Env, id: unknown, name: string, args: Record<string, unknown>, agentId: string): Promise<Response> {
  const now = Date.now();
  if (name === "tasks_list") {
    const status = argString(args, "status");
    const assignee = argString(args, "assignee");
    const tasks = await listTasksForAgent(env.DB, { status: status ?? null, assignee: assignee ?? null }, agentId, now);
    return toolResult(id, { tasks: tasks.map(taskPublic) });
  }
  if (name === "tasks_create") {
    const from = await agentName(env.DB, agentId);
    const created = await createTask(env.DB, { ...args, from: from ?? undefined }, agentId, "agent", now);
    return toolResult(id, { task: taskPublic(created) });
  }
  if (name === "tasks_update") {
    const taskId = argString(args, "task_id");
    if (!taskId) return toolResult(id, "请提供 task_id", true);
    const { task_id: _omit, ...fields } = args;
    const updated = await updateTask(env.DB, taskId, fields, agentId, now);
    return toolResult(id, { task: taskPublic(updated) });
  }
  if (name === "tasks_complete") {
    const taskId = argString(args, "task_id");
    if (!taskId) return toolResult(id, "请提供 task_id", true);
    const completed = await completeTask(env.DB, taskId, agentId, now);
    return toolResult(id, { task: taskPublic(completed) });
  }
  return toolResult(id, "未知工具", true);
}

async function callMachinesTool(env: Env, id: unknown, name: string, args: Record<string, unknown>, agentId: string): Promise<Response> {
  const now = Date.now();
  if (name === "machines_list") {
    const kind = argString(args, "kind");
    if (kind !== undefined && kind !== "") {
      if (kind !== "server" && kind !== "cloud" && kind !== "worker") return toolResult(id, "类型不正确", true);
      const rows = await listMachines(env.DB, kind);
      return toolResult(id, { machines: rows.map(machinePublic) });
    }
    const rows = await listMachines(env.DB, null);
    return toolResult(id, { machines: rows.map(machinePublic) });
  }
  if (name === "machines_get") {
    const machineId = argString(args, "machine_id") ?? "";
    const machineName = argString(args, "name") ?? "";
    if (!machineId.trim() && !machineName.trim()) return toolResult(id, "请提供 machine_id 或 name", true);
    const row = await getMachineForAgent(env.DB, machineId.trim(), machineName.trim(), agentId, now);
    if (!row) return toolResult(id, "机器不存在", true);
    return toolResult(id, { machine: machinePublic(row) });
  }
  if (name === "machines_report") {
    const updated = await reportMachine(env.DB, args, agentId, now);
    return toolResult(id, { machine: machinePublic(updated) });
  }
  if (name === "machines_get_access") {
    const machineId = argString(args, "machine_id") ?? "";
    const machineName = argString(args, "name") ?? "";
    if (!machineId.trim() && !machineName.trim()) return toolResult(id, "请提供 machine_id 或 name", true);
    const access = await getMachineAccessForAgent(env.DB, machineId.trim(), machineName.trim(), agentId, vaultKeyOf(env), now);
    if (!access) return toolResult(id, "机器不存在", true);
    return toolResult(id, access);
  }
  return toolResult(id, "未知工具", true);
}

async function callSkillsTool(env: Env, id: unknown, name: string, args: Record<string, unknown>, agentId: string): Promise<Response> {
  const now = Date.now();
  if (name === "skills_list") {
    const rows = await listSkills(env.DB, null);
    return toolResult(id, { skills: rows.map(skillSummary) });
  }
  if (name === "skills_get") {
    const skillId = argString(args, "skill_id") ?? "";
    const skillName = argString(args, "name") ?? "";
    if (!skillId.trim() && !skillName.trim()) return toolResult(id, "请提供 skill_id 或 name", true);
    const row = await getSkillForAgent(env.DB, skillId.trim(), skillName.trim(), agentId, now);
    if (!row) return toolResult(id, "技能不存在", true);
    return toolResult(id, { skill: row });
  }
  return toolResult(id, "未知工具", true);
}

async function callApisTool(env: Env, id: unknown, name: string, args: Record<string, unknown>, agentId: string): Promise<Response> {
  const now = Date.now();
  if (name === "apis_list") {
    const rows = await listApis(env.DB, null);
    return toolResult(id, { apis: rows.map(apiSummary) });
  }
  if (name === "apis_get") {
    const apiId = argString(args, "api_id") ?? "";
    const apiName = argString(args, "name") ?? "";
    if (!apiId.trim() && !apiName.trim()) return toolResult(id, "请提供 api_id 或 name", true);
    const row = await getApiForAgent(env.DB, apiId.trim(), apiName.trim(), agentId, now);
    if (!row) return toolResult(id, "API 条目不存在", true);
    return toolResult(id, { api: apiSummary(row) });
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
  if (header) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (match?.[1]) return match[1];
  }
  // The panel hands out endpoint URLs with the token in the query string
  // (.../mcp?token=...), so a bare URL is enough to configure a client.
  // The Authorization header stays the primary channel and wins whenever
  // it carries a usable Bearer token; the query value goes through the
  // exact same authenticateAgent check as a header token.
  const fromQuery = new URL(request.url).searchParams.get("token");
  return fromQuery ? fromQuery : null;
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
