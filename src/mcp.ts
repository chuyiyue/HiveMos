// POST /mcp is a stateless JSON-RPC registry. tools/call checks the agent
// bearer. Search and list never return endpoint or config; mcp_get does,
// and only after the fetch audit row is written.

import { json } from "./http";
import type { Env, WaitCtx } from "./env";
import {
  createServer,
  deleteServer,
  fetchConfigForAgent,
  listAgents,
  readPublicServer,
  recordToolDenied,
  resolveAgent,
  resolveServer,
  revealAgentToken,
  rotateAgentToken,
  searchServers,
  updateAgent,
  updateServerPartial,
} from "./registry";
import type { PublicAgent } from "./registry";
import { authenticateMcp } from "./oauth";
import { toolPermissionOf, toolAccessError, toolVisibleToAgent } from "./tool-permissions";
import { hasAdvanced } from "./permissions";
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
  rememberMemory,
  searchMemoriesHybridAudited,
  upsertMemory,
} from "./memory";
import type { MemoryRow } from "./memory";
import {
  TaskError,
  agentName,
  completeTask,
  createTask,
  deleteTask,
  getTask,
  listTasksForAgent,
  taskPublic,
  updateTask,
} from "./tasks";

import {
  createMachine,
  deleteMachine,
  getMachine,
  getMachineAccessForAgent,
  getMachineByName,
  getMachineForAgent,
  listMachines,
  MachineError,
  MACHINE_KIND_LABELS,
  machinePublic,
  probeMachineById,
  reportMachine,
  updateMachine,
  vaultKeyOf,
} from "./machines";

import {
  apiSummary,
  createApi,
  createSkill,
  deleteApi,
  deleteSkill,
  ExtraError,
  getApi,
  getApiByName,
  getApiForAgent,
  getSkill,
  getSkillByName,
  getSkillForAgent,
  listApis,
  listSkills,
  skillSummary,
  updateApi,
  updateSkill,
} from "./extras";
import {
  VaultError,
  createEmail,
  createEntry,
  createGateway,
  deleteEmail,
  deleteEntry,
  deleteGateway,
  emailPublic,
  entryPublic,
  gatewayPublic,
  listEmails,
  listEntries,
  listGateways,
  revealSecret,
  updateEmail,
  updateEntry,
  updateGateway,
} from "./vault";
import type { EmailRow, GatewayRow, VaultEntryRow } from "./vault";
import { getTotpCodeForAgent, listTotpForAgent } from "./vault-totp";
import { GuideError, listGuideForAgent } from "./vault-guide";

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
    name: "mcp_create",
    description: "登记一个新的 MCP 条目，字段与校验与面板新建一致。保存后会尝试探活工具快照，探活失败时条目照样建成、原因放在 probe_error 里",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "条目 name（小写字母、数字、下划线、连字符，全局唯一）" },
        title: { type: "string", description: "标题" },
        description: { type: "string", description: "说明" },
        endpoint_url: { type: "string", description: "端点地址（http / sse 需要 http:// 或 https:// 开头）" },
        transport: { type: "string", description: "传输方式：http、sse 或 stdio" },
        launch_config_json: { type: "string", description: "启动配置（JSON 字符串，stdio 用）" },
        auth_type: { type: "string", description: "鉴权方式：none、bearer 或 oauth" },
        config_json: { type: "string", description: "配置模板（JSON 字符串，密钥用 {{vault://…}} 占位）" },
        tags: { type: "array", items: { type: "string" }, description: "人工标签，最多 20 个" },
        category: { type: "string", description: "分类" },
        group_id: { type: "string", description: "分组 id（scope=mcp 的分组）；null 或空表示未分组" },
        summary: { type: "string", description: "简介，最长 200 字" },
        status: { type: "string", description: "状态：active 或 disabled" },
        ttl_seconds: { type: "integer", description: "快照存活秒数，60 到 2592000，缺省 86400" },
      },
      required: ["name", "title", "endpoint_url", "transport", "auth_type"],
      additionalProperties: false,
    },
  },
  {
    name: "mcp_update",
    description: "局部更新一个 MCP 条目：用 server_id 或 name 定位，只改给出的字段，校验与面板一致。只给 name 时它仅作定位、不能改名；改名要带 server_id 再给新 name",
    inputSchema: {
      type: "object",
      properties: {
        server_id: { type: "string", description: "条目 id" },
        name: { type: "string", description: "条目 name（小写字母、数字、下划线、连字符，全局唯一）" },
        title: { type: "string", description: "标题" },
        description: { type: "string", description: "说明" },
        endpoint_url: { type: "string", description: "端点地址（http / sse 需要 http:// 或 https:// 开头）" },
        transport: { type: "string", description: "传输方式：http、sse 或 stdio" },
        launch_config_json: { type: "string", description: "启动配置（JSON 字符串，stdio 用）" },
        auth_type: { type: "string", description: "鉴权方式：none、bearer 或 oauth" },
        config_json: { type: "string", description: "配置模板（JSON 字符串，密钥用 {{vault://…}} 占位）" },
        tags: { type: "array", items: { type: "string" }, description: "人工标签，最多 20 个" },
        category: { type: "string", description: "分类" },
        group_id: { type: "string", description: "分组 id（scope=mcp 的分组）；null 或空表示未分组" },
        summary: { type: "string", description: "简介，最长 200 字" },
        status: { type: "string", description: "状态：active 或 disabled" },
        ttl_seconds: { type: "integer", description: "快照存活秒数，60 到 2592000，缺省 86400" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mcp_delete",
    description: "按 server_id 或 name 删除一个 MCP 条目（真删行）",
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
    name: "memory_remember",
    description: "用一句话记住一件事：立即同步落一条待补全的记忆并返回 id，拆分、打标、摘要由后台异步完成。适合 Agent 随手记下一条线索；需要精确覆盖已有条目时仍用 memory_upsert",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要记住的内容（一句话或一小段）" },
        title: { type: "string", description: "可选标题；不填则取正文开头作为标题" },
        tags: { type: "array", items: { type: "string" }, description: "可选标签" },
      },
      required: ["text"],
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
    description: "写入自己的 Soul 新版全文。新版本先进待批准草稿，管理员在面板批准后才生效。该 Agent 还没有 Soul 时自动新建。默认只能写自己的 Soul，写其他 Agent 的 Soul 需要「操作其他 Soul」的写入权限",
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
    description: "按段落增量修改 Soul：只改 persona、rules、tools、learned_context 四段中的一段（字符上限依次 2000、2000、2000、6000），不必提交整份全文。改动合成新全文先进待批准草稿，管理员批准后才生效，分段也随批准才同步。默认写自己的 Soul，写其他 Agent 的 Soul 需要「操作其他 Soul」的写入权限",
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
    name: "tasks_get",
    description: "按 task_id 取一条任务的完整信息：公共字段外还带 AI 状态（ai_status）与 AI 摘要（ai_summary），tasks_list 不回这两个字段",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string", description: "任务 id" } },
      required: ["task_id"],
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
    name: "machines_create",
    description: "新建一条云计算资源条目（服务器 server、云主机 cloud 或边缘计算 worker），字段与校验与面板新建完全一致。服务器建成后会同步探活一次（与面板一致），探活失败不影响建成；服务器不传 name 时按备注、IP、SSH 地址依次兜底生成。凭据（ssh_secret / api_token）只密封保存，返回永不带明文",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "类型：server、cloud 或 worker" },
        name: { type: "string", description: "名称；云主机与边缘计算必填，服务器可省略（按备注/IP 兜底）" },
        region: { type: "string", description: "地域" },
        spec: { type: "string", description: "配置" },
        description: { type: "string", description: "说明" },
        binding: { type: "string", description: "绑定" },
        note: { type: "string", description: "备注（服务器 / 云主机）" },
        group_id: { type: "string", description: "分组 id（scope=machines 的分组）；null 或空表示未分组" },
        hostname: { type: "string", description: "主机名（服务器）" },
        os: { type: "string", description: "系统（服务器）" },
        ip: { type: "string", description: "主机 IP（服务器；IP 与 SSH 地址至少填一个）" },
        ssh_host: { type: "string", description: "SSH 地址（服务器）" },
        ssh_port: { type: "integer", description: "SSH 端口，缺省 22（服务器）" },
        ssh_user: { type: "string", description: "SSH 用户名（服务器）" },
        auth_type: { type: "string", description: "SSH 鉴权方式：password 或 key（服务器）" },
        ssh_secret: { type: "string", description: "SSH 密码或私钥（服务器，密封保存，不回显）" },
        vendor: { type: "string", description: "厂商（云主机）" },
        access_note: { type: "string", description: "接入方式备注（云主机）" },
        platform: { type: "string", description: "平台：cloudflare 或 vercel（边缘计算，缺省 cloudflare）" },
        cf_account_id: { type: "string", description: "Cloudflare 账号 ID（边缘计算，cloudflare 平台）" },
        team_id: { type: "string", description: "Team ID（边缘计算，vercel 平台）" },
        api_token: { type: "string", description: "API 令牌（边缘计算，密封保存，不回显）" },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "machines_update",
    description: "局部更新一条云计算资源条目：用 machine_id 或 name 定位，只改给出的字段，校验与面板一致，凭据不回显。只给 name 时它仅作定位、不能改名；改名要带 machine_id 再给新 name",
    inputSchema: {
      type: "object",
      properties: {
        machine_id: { type: "string", description: "机器 id" },
        name: { type: "string", description: "名称；仅定位时是定位键，带 machine_id 时可作为新名" },
        region: { type: "string", description: "地域" },
        spec: { type: "string", description: "配置" },
        description: { type: "string", description: "说明" },
        binding: { type: "string", description: "绑定" },
        note: { type: "string", description: "备注（服务器 / 云主机）" },
        group_id: { type: "string", description: "分组 id（scope=machines 的分组）；null 或空表示未分组" },
        hostname: { type: "string", description: "主机名（服务器）" },
        os: { type: "string", description: "系统（服务器）" },
        ip: { type: "string", description: "主机 IP（服务器）" },
        ssh_host: { type: "string", description: "SSH 地址（服务器）" },
        ssh_port: { type: "integer", description: "SSH 端口（服务器）" },
        ssh_user: { type: "string", description: "SSH 用户名（服务器）；空值表示保留原值" },
        auth_type: { type: "string", description: "SSH 鉴权方式：password 或 key（服务器）" },
        ssh_secret: { type: "string", description: "SSH 密码或私钥（服务器）；空值表示保留原值" },
        vendor: { type: "string", description: "厂商（云主机）" },
        access_note: { type: "string", description: "接入方式备注（云主机）" },
        cf_account_id: { type: "string", description: "Cloudflare 账号 ID（边缘计算）" },
        team_id: { type: "string", description: "Team ID（边缘计算）" },
        api_token: { type: "string", description: "API 令牌（边缘计算）；空值表示保留原值" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "machines_delete",
    description: "按 machine_id 或 name 删除一条云计算资源条目（真删行）。这是条目删除，不是关机或停用",
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
    name: "skills_create",
    description: "登记一个新的 Skill 条目，字段与校验与面板新建一致。正文是单篇全文",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名称，最长 64 字" },
        description: { type: "string", description: "说明，最长 300 字" },
        source: { type: "string", description: "来源，最长 64 字" },
        content: { type: "string", description: "正文（单篇全文），最长 20000 字" },
        version: { type: "string", description: "版本，最长 32 字" },
        used_by: { type: "string", description: "引用方，最长 120 字" },
        status: { type: "string", description: "状态：enabled 或 disabled" },
        group_id: { type: "string", description: "分组 id（与 MCP 页签共用 scope=mcp 分组池）；null 或空表示未分组" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "skills_update",
    description: "局部更新一个 Skill：用 skill_id 或 name 定位，只改给出的字段；正文只在给出 content 时整体替换，未给出的字段不动。只给 name 时它仅作定位、不能改名；改名要带 skill_id 再给新 name",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "技能 id" },
        name: { type: "string", description: "技能名称，最长 64 字" },
        description: { type: "string", description: "说明，最长 300 字" },
        source: { type: "string", description: "来源，最长 64 字" },
        content: { type: "string", description: "正文（单篇全文），最长 20000 字" },
        version: { type: "string", description: "版本，最长 32 字" },
        used_by: { type: "string", description: "引用方，最长 120 字" },
        status: { type: "string", description: "状态：enabled 或 disabled" },
        group_id: { type: "string", description: "分组 id（与 MCP 页签共用 scope=mcp 分组池）；null 或空表示未分组" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "skills_delete",
    description: "按 skill_id 或 name 删除一个 Skill 条目（真删行）",
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
  {
    name: "apis_create",
    description: "登记一个新的 API 条目，字段与校验与面板新建一致",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "条目名称，最长 64 字" },
        base_url: { type: "string", description: "端点，最长 300 字" },
        auth_note: { type: "string", description: "鉴权说明，最长 64 字" },
        note: { type: "string", description: "说明，最长 300 字" },
        status: { type: "string", description: "状态：active 或 disabled，缺省 active" },
        group_id: { type: "string", description: "分组 id（与 MCP 页签共用 scope=mcp 分组池）；null 或空表示未分组" },
      },
      required: ["name", "base_url"],
      additionalProperties: false,
    },
  },
  {
    name: "apis_update",
    description: "局部更新一个 API 条目：用 api_id 或 name 定位，只改给出的字段，校验与面板一致。只给 name 时它仅作定位、不能改名；改名要带 api_id 再给新 name",
    inputSchema: {
      type: "object",
      properties: {
        api_id: { type: "string", description: "API 条目 id" },
        name: { type: "string", description: "条目名称，最长 64 字" },
        base_url: { type: "string", description: "端点，最长 300 字" },
        auth_note: { type: "string", description: "鉴权说明，最长 64 字" },
        note: { type: "string", description: "说明，最长 300 字" },
        status: { type: "string", description: "状态：active 或 disabled" },
        group_id: { type: "string", description: "分组 id（与 MCP 页签共用 scope=mcp 分组池）；null 或空表示未分组" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "apis_delete",
    description: "按 api_id 或 name 删除一个 API 条目（真删行）",
    inputSchema: {
      type: "object",
      properties: {
        api_id: { type: "string", description: "API 条目 id" },
        name: { type: "string", description: "API 条目名称" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vault_list_entries",
    description: "列出保险库的账号密码条目（名称、网址、账号、密码末四位、备注、分组），不含密码明文",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "vault_get_entry",
    description: "按 entry_id 或 name 取一条保险库条目并回明文密码。放行前先写一条访问记录（审计失败就不返回明文），与面板「查看」同一条路径。只在当前任务确实需要登录时调用，不要把密码写入记忆、日志或文件",
    inputSchema: {
      type: "object",
      properties: {
        entry_id: { type: "string", description: "条目 id" },
        name: { type: "string", description: "条目名称" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vault_create_entry",
    description: "新建一条保险库账号密码条目，字段与校验与面板新建一致（密码密封保存，只回末四位）",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "名称，最长 60 字" },
        url: { type: "string", description: "网址" },
        username: { type: "string", description: "账号" },
        password: { type: "string", description: "密码（密封保存）" },
        note: { type: "string", description: "备注" },
        group_id: { type: "string", description: "分组 id（保险库分组池 vault_groups，与验证码共用）；null 或空表示未分组" },
      },
      required: ["name", "password"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_update_entry",
    description: "局部更新一条保险库条目：用 entry_id 或 name 定位，只改给出的字段；密码只在给出非空 password 时更换。只给 name 时它仅作定位、不能改名；改名要带 entry_id 再给新 name",
    inputSchema: {
      type: "object",
      properties: {
        entry_id: { type: "string", description: "条目 id" },
        name: { type: "string", description: "名称，最长 60 字" },
        url: { type: "string", description: "网址" },
        username: { type: "string", description: "账号" },
        password: { type: "string", description: "新密码（密封保存）；不给或空表示保留原密码" },
        note: { type: "string", description: "备注" },
        group_id: { type: "string", description: "分组 id（保险库分组池 vault_groups）；null 或空表示未分组" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vault_delete_entry",
    description: "按 entry_id 或 name 删除一条保险库条目（真删行）",
    inputSchema: {
      type: "object",
      properties: {
        entry_id: { type: "string", description: "条目 id" },
        name: { type: "string", description: "条目名称" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vault_list_emails",
    description: "列出保险库的发信邮箱（地址、用途、入口、备注与 SMTP 配置概况），不含 SMTP 密码明文",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "vault_get_email",
    description: "按 email_id 或 address 取一个发信邮箱并回 SMTP 密码明文。放行前先写一条访问记录（审计失败就不返回明文），与面板「查看」同一条路径。只在当前任务确实需要发信时调用，不要把密码写入记忆、日志或文件",
    inputSchema: {
      type: "object",
      properties: {
        email_id: { type: "string", description: "邮箱 id" },
        address: { type: "string", description: "邮箱地址" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vault_create_email",
    description: "新建一个发信邮箱，字段与校验与面板新建一致。SMTP 是一组可选配置：给了任一 smtp_* 字段就要把服务器与加密方式填全，密码密封保存",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "邮箱地址" },
        purpose: { type: "string", description: "用途" },
        portal: { type: "string", description: "入口" },
        note: { type: "string", description: "备注" },
        smtp_host: { type: "string", description: "SMTP 服务器" },
        smtp_port: { type: "integer", description: "SMTP 端口；缺省按加密方式取 465 / 587 / 25" },
        smtp_security: { type: "string", description: "加密方式：ssl、starttls 或 none" },
        smtp_user: { type: "string", description: "SMTP 用户名，缺省用邮箱地址" },
        smtp_secret: { type: "string", description: "SMTP 密码（密封保存）" },
      },
      required: ["address"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_update_email",
    description: "局部更新一个发信邮箱：用 email_id 或 address 定位，只改给出的字段；SMTP 组只在给出任一 smtp_* 字段时整体处理（空密码保留原密码），完全不给则不动已存的 SMTP 配置。只给 address 时它仅作定位、不能改地址；改地址要带 email_id 再给新 address",
    inputSchema: {
      type: "object",
      properties: {
        email_id: { type: "string", description: "邮箱 id" },
        address: { type: "string", description: "邮箱地址" },
        purpose: { type: "string", description: "用途" },
        portal: { type: "string", description: "入口" },
        note: { type: "string", description: "备注" },
        smtp_host: { type: "string", description: "SMTP 服务器" },
        smtp_port: { type: "integer", description: "SMTP 端口；缺省按加密方式取 465 / 587 / 25" },
        smtp_security: { type: "string", description: "加密方式：ssl、starttls 或 none" },
        smtp_user: { type: "string", description: "SMTP 用户名" },
        smtp_secret: { type: "string", description: "SMTP 密码（密封保存）；空表示保留原密码" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vault_delete_email",
    description: "按 email_id 或 address 删除一个发信邮箱（真删行）",
    inputSchema: {
      type: "object",
      properties: {
        email_id: { type: "string", description: "邮箱 id" },
        address: { type: "string", description: "邮箱地址" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vault_list_gateways",
    description: "列出保险库的模型网关（名称、协议、地址、模型、密钥末四位、状态、分组），不含密钥明文",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "vault_get_gateway",
    description: "按 gateway_id 或 name 取一个模型网关并回密钥明文。放行前先写一条访问记录（审计失败就不返回明文），与面板「查看」同一条路径。只在当前任务确实需要调用该网关时调用，不要把密钥写入记忆、日志或文件",
    inputSchema: {
      type: "object",
      properties: {
        gateway_id: { type: "string", description: "网关 id" },
        name: { type: "string", description: "网关名称" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vault_create_gateway",
    description: "新建一个模型网关，字段与校验与面板新建一致（密钥密封保存，只回末四位）",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "名称，最长 60 字" },
        proto: { type: "string", description: "协议" },
        base_url: { type: "string", description: "地址" },
        models: { type: "string", description: "模型" },
        key: { type: "string", description: "密钥（密封保存）" },
        status: { type: "string", description: "状态：active 或 paused，缺省 paused" },
        group_id: { type: "string", description: "分组 id（保险库分组池 vault_groups）；null 或空表示未分组" },
      },
      required: ["name", "key"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_update_gateway",
    description: "局部更新一个模型网关：用 gateway_id 或 name 定位，只改给出的字段；密钥只在给出非空 key 时更换。只给 name 时它仅作定位、不能改名；改名要带 gateway_id 再给新 name",
    inputSchema: {
      type: "object",
      properties: {
        gateway_id: { type: "string", description: "网关 id" },
        name: { type: "string", description: "名称，最长 60 字" },
        proto: { type: "string", description: "协议" },
        base_url: { type: "string", description: "地址" },
        models: { type: "string", description: "模型" },
        key: { type: "string", description: "新密钥（密封保存）；不给或空表示保留原密钥" },
        status: { type: "string", description: "状态：active 或 paused" },
        group_id: { type: "string", description: "分组 id（保险库分组池 vault_groups）；null 或空表示未分组" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vault_delete_gateway",
    description: "按 gateway_id 或 name 删除一个模型网关（真删行）",
    inputSchema: {
      type: "object",
      properties: {
        gateway_id: { type: "string", description: "网关 id" },
        name: { type: "string", description: "网关名称" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agents_list",
    description: "列出全部 Agent 的公开信息（名字、状态、权限、调用次数、最近活跃），不含任何令牌。只能操作其他 Agent 的工具组：列的是别人，自己不在结果里",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "agents_get",
    description: "按 agent_id 或 name 取另一个 Agent 的公开信息、令牌明文与接入地址。令牌放行前先写一条访问审计（审计失败就不返回令牌），与面板「复制密钥」同一条路径。只能查其他 Agent，不能查自己；旧令牌只存了摘要时取不出，需先轮换",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent id" },
        name: { type: "string", description: "Agent 名字" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agents_rotate_token",
    description: "轮换另一个 Agent 的令牌：旧令牌立即失效，新令牌明文在本响应里返回（同时密封保存，之后可经 agents_get 再取）。只能轮换其他 Agent，不能轮换自己",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent id" },
        name: { type: "string", description: "Agent 名字" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agents_set_enabled",
    description: "启用或停用另一个 Agent。停用后它的令牌立即不能再调用。只能操作其他 Agent，不能启停自己",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent id" },
        name: { type: "string", description: "Agent 名字" },
        enabled: { type: "boolean", description: "true 启用，false 停用" },
      },
      required: ["enabled"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_2fa_list",
    description: "列出保险库中允许 AI 读取的验证码条目（id、服务名、账号、位数、周期、分组），不含密钥与验证码",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "vault_2fa_get_code",
    description: "按 id 取一条验证码条目的当前码与剩余秒数，只返回验证码，不返回密钥。取码前先写一条访问记录。只在当前任务确实需要登录时调用，不要把验证码写入记忆、日志或文件",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "验证码条目 id" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_guide_list",
    description: "列出管理员授权给你的外部保险库连接指引（服务商与连接说明、条目引用、用途、建议注入方式、允许主机、标签）。指引只有引用与说明、没有任何凭据值；取值要按连接说明在你自己那端完成。未被授权的条目不会出现在这里",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
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

// tools/list 只返回当前身份有效权限覆盖的工具：域的开关键或 advanced
// 开关没给，工具直接不出现（纯高级域工具如 agents_list、vault_2fa_list
// 只看 advanced）。鉴权走
// authenticateMcp：Agent 令牌用基础权限，OAuth 令牌用基础 ∩ 连接权限。
// 无 Bearer 的请求保持历史行为（返回全部工具）；Bearer 认证失败与
// tools/call 一样报错。
async function listTools(request: Request, env: Env, id: unknown): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return rpcResult(id, { tools: TOOLS });
  const auth = await authenticateMcp(env, token, Date.now());
  if (!auth.ok) return rpcError(id, -32001, auth.error, 401);
  const tools = TOOLS.filter((tool) => toolVisibleToAgent(tool.name, auth.permissions));
  return rpcResult(id, { tools });
}

async function callTool(request: Request, env: Env, ctx: WaitCtx, id: unknown, params: unknown): Promise<Response> {
  const token = bearerToken(request);
  if (!token) return rpcError(id, -32001, "缺少 Bearer 令牌", 401);
  const auth = await authenticateMcp(env, token, Date.now());
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
  const denial = toolAccessError(name, auth.permissions, auth.agentName, record as Record<string, unknown>, auth.agentId);
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
  if (name === "mcp_create") {
    const created = await createServer(env, ctx, record);
    if (!created.ok) return toolResult(id, created.error, true);
    const label = created.server.title || created.server.name;
    await logOp(env.DB, {
      actor: auth.agentName,
      module: "MCP",
      action: "添加",
      targetId: created.server.id,
      targetName: label,
      text: `添加了 MCP「${label}」`,
    });
    const payload: Record<string, unknown> = { server: created.server };
    if (created.probe_error) payload.probe_error = created.probe_error;
    return toolResult(id, payload);
  }
  if (name === "mcp_update" || name === "mcp_delete") {
    const serverId = readString(fields.server_id);
    const serverName = readString(fields.name);
    if (serverId == null || serverName == null) return rpcError(id, -32602, "参数不正确");
    if (!serverId.trim() && !serverName.trim()) return toolResult(id, "请提供 server_id 或 name", true);
    const row = await resolveServer(env.DB, serverId.trim(), serverName.trim());
    if (!row) return toolResult(id, "未找到条目", true);
    if (name === "mcp_delete") {
      const before = await readPublicServer(env.DB, row.id);
      const removed = await deleteServer(env.DB, row.id);
      if (!removed.ok) return toolResult(id, removed.error, true);
      const label = before ? before.title || before.name : row.name;
      await logOp(env.DB, {
        actor: auth.agentName,
        module: "MCP",
        action: "删除",
        targetId: row.id,
        targetName: label,
        text: `删除了 MCP「${label}」`,
      });
      return toolResult(id, { server: before, deleted: true });
    }
    const { server_id: _omit, ...fieldsToPatch } = record as Record<string, unknown>;
    const patchBody: Record<string, unknown> = { ...fieldsToPatch };
    // 只用 name 定位时 name 是定位键而非新名（改名走 server_id + 新 name）。
    if (!serverId.trim()) delete patchBody.name;
    const updated = await updateServerPartial(env, ctx, row.id, patchBody);
    if (!updated.ok) return toolResult(id, updated.error, true);
    const label = updated.server.title || updated.server.name;
    await logOp(env.DB, {
      actor: auth.agentName,
      module: "MCP",
      action: "修改",
      targetId: row.id,
      targetName: label,
      text: `修改了 MCP「${label}」`,
    });
    const payload: Record<string, unknown> = { server: updated.server };
    if (updated.probe_error) payload.probe_error = updated.probe_error;
    return toolResult(id, payload);
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
      return await callMachinesTool(env, id, name, record as Record<string, unknown>, auth);
    } catch (error) {
      if (error instanceof MachineError) return toolResult(id, error.message, true);
      throw error;
    }
  }
  if (name.startsWith("vault_2fa_")) {
    try {
      return await callVaultTotpTool(env, id, name, record as Record<string, unknown>, auth.agentName);
    } catch (error) {
      if (error instanceof VaultError) return toolResult(id, error.message, true);
      throw error;
    }
  }
  if (name.startsWith("apis_")) {
    try {
      return await callApisTool(env, id, name, record as Record<string, unknown>, auth);
    } catch (error) {
      if (error instanceof ExtraError) return toolResult(id, error.message, true);
      throw error;
    }
  }
  if (name.startsWith("agents_")) {
    return await callAgentsTool(env, request, id, name, record as Record<string, unknown>, auth);
  }
  if (name === "vault_guide_list") {
    // 三重门中的后两重（per-agent 技能开关 + grant 行级 ACL）在
    // listGuideForAgent 里判：不过的条目不出现在结果里、不泄露存在性；
    // 返回的每条都会逐条写 view 审计，审计失败整次按错误返回。
    try {
      const entries = await listGuideForAgent(env.DB, auth.agentId, Date.now());
      return toolResult(id, { entries });
    } catch (error) {
      if (error instanceof GuideError) return toolResult(id, error.message, true);
      throw error;
    }
  }
  if (name.startsWith("vault_")) {
    try {
      return await callVaultTool(env, id, name, record as Record<string, unknown>, auth.agentName);
    } catch (error) {
      if (error instanceof VaultError) return toolResult(id, error.message, true);
      throw error;
    }
  }
  if (name.startsWith("skills_")) {
    try {
      return await callSkillsTool(env, id, name, record as Record<string, unknown>, auth);
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
    // 无 soul_other 读时别人的 Soul 等于不存在：只返回自己名下那一份。
    const visible = hasAdvanced(auth.permissions, "soul_other", "read")
      ? souls
      : souls.filter((soul) => soul.agent_name === auth.agentName);
    return toolResult(id, { souls: visible.map(soulSummary) });
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
    // 归属与 soul_other 写的校验在 toolAccessError
    // （src/tool-permissions.ts）统一做，身份仍取自 Bearer，写别人的 Soul
    // （含以他人名义新建）需要 soul_other 写。这里只管草稿与版本流程，逻辑不变。
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
    // （src/tool-permissions.ts）统一做（soul_other 写），与 soul_update 同一条口径。
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
    const rows = await searchMemoriesHybridAudited(
      env,
      query.trim(),
      scope || null,
      { limit: page.limit + 1, offset: page.offset },
      channel,
      now,
    );
    return memoryPageResult(id, rows, page);
  }
  if (name === "memory_remember") {
    const text = argString(args, "text");
    if (!text || !text.trim()) return toolResult(id, "请提供 text", true);
    const row = await rememberMemory(
      env.DB,
      { text: text.trim(), title: argString(args, "title"), tags: args.tags, scope: args.scope },
      channel,
      now,
    );
    return toolResult(id, { memory: memoryPublic(row), id: row.id, ai_state: "pending" });
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
  if (name === "tasks_get") {
    const taskId = argString(args, "task_id");
    if (!taskId) return toolResult(id, "请提供 task_id", true);
    const row = await getTask(env.DB, taskId);
    if (!row) return toolResult(id, "任务不存在", true);
    // tasks_get 是 tasks_list 之外的完整读：taskPublic 之外多带 AI 状态与
    // AI 摘要（任务被 AI 处理过才有值），其余字段同 taskPublic。
    return toolResult(id, { task: { ...taskPublic(row), ai_status: row.ai_status, ai_summary: row.ai_summary } });
  }
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

async function callVaultTotpTool(
  env: Env,
  id: unknown,
  name: string,
  args: Record<string, unknown>,
  agentName: string,
): Promise<Response> {
  if (name === "vault_2fa_list") {
    const entries = await listTotpForAgent(env.DB);
    return toolResult(id, { entries });
  }
  if (name === "vault_2fa_get_code") {
    const now = Date.now();
    const entryId = argString(args, "id") ?? "";
    if (!entryId.trim()) return toolResult(id, "请提供 id", true);
    const code = await getTotpCodeForAgent(env.DB, env, entryId.trim(), agentName, now);
    // ai_read=0 与真的不存在同一口径，不暴露条目是否被关闭。
    if (!code) return toolResult(id, "验证码条目不存在", true);
    return toolResult(id, code);
  }
  return toolResult(id, "未知工具", true);
}

async function callMachinesTool(
  env: Env,
  id: unknown,
  name: string,
  args: Record<string, unknown>,
  auth: { agentId: string; agentName: string },
): Promise<Response> {
  const agentId = auth.agentId;
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
  if (name === "machines_create") {
    // 与面板同一条创建路径：createMachine 自带 machines_audit 的 create
    // 行（actor 记调用 Agent 名、source "mcp"，与 machines_report 的审计
    // 归属口径一致）；服务器建成后同步探活一次，也与面板一致（面板的
    // test-before-save 实际就是这条「建成即探活」——createMachine 本身
    // 不预检，探活失败不回滚）。代理订阅/节点不在 machines 表里，属另一
    // 个模块，本工具组只管 server / cloud / worker 三类条目。
    const created = await createMachine(env.DB, args, auth.agentName, "mcp", now, vaultKeyOf(env));
    let fresh = created;
    if (created.kind === "server") {
      await probeMachineById(env.DB, created.id, vaultKeyOf(env), auth.agentName, now).catch(() => undefined);
      fresh = (await getMachine(env.DB, created.id)) ?? created;
    }
    const kindLabel = MACHINE_KIND_LABELS[created.kind] ?? created.kind;
    await logOp(env.DB, {
      actor: auth.agentName,
      module: "云主机",
      action: "添加",
      targetId: created.id,
      targetName: created.name,
      text: `添加了${kindLabel}「${created.name}」`,
    });
    return toolResult(id, { machine: machinePublic(fresh) });
  }
  if (name === "machines_update" || name === "machines_delete") {
    const machineId = argString(args, "machine_id") ?? "";
    const machineName = argString(args, "name") ?? "";
    if (!machineId.trim() && !machineName.trim()) return toolResult(id, "请提供 machine_id 或 name", true);
    let row = machineId.trim() ? await getMachine(env.DB, machineId.trim()) : null;
    if (!row && machineName.trim()) row = await getMachineByName(env.DB, machineName.trim());
    if (!row) return toolResult(id, "机器不存在", true);
    if (name === "machines_delete") {
      await deleteMachine(env.DB, row.id, auth.agentName, "mcp", now);
      await logOp(env.DB, {
        actor: auth.agentName,
        module: "云主机",
        action: "删除",
        targetId: row.id,
        targetName: row.name,
        text: `删除了「${row.name}」`,
      });
      return toolResult(id, { machine: machinePublic(row), deleted: true });
    }
    const { machine_id: _omit, ...patch } = args;
    const patchBody: Record<string, unknown> = { ...patch };
    // 只用 name 定位时 name 是定位键而非新名（改名走 machine_id + 新 name）。
    if (!machineId.trim()) delete patchBody.name;
    const updated = await updateMachine(env.DB, row.id, patchBody, auth.agentName, "mcp", now, vaultKeyOf(env));
    await logOp(env.DB, {
      actor: auth.agentName,
      module: "云主机",
      action: "修改",
      targetId: row.id,
      targetName: updated.name,
      text: `修改了「${updated.name}」`,
    });
    return toolResult(id, { machine: machinePublic(updated) });
  }
  return toolResult(id, "未知工具", true);
}

async function callSkillsTool(
  env: Env,
  id: unknown,
  name: string,
  args: Record<string, unknown>,
  auth: { agentId: string; agentName: string },
): Promise<Response> {
  const now = Date.now();
  if (name === "skills_list") {
    const rows = await listSkills(env.DB, null);
    return toolResult(id, { skills: rows.map(skillSummary) });
  }
  if (name === "skills_get") {
    const skillId = argString(args, "skill_id") ?? "";
    const skillName = argString(args, "name") ?? "";
    if (!skillId.trim() && !skillName.trim()) return toolResult(id, "请提供 skill_id 或 name", true);
    const row = await getSkillForAgent(env.DB, skillId.trim(), skillName.trim(), auth.agentId, now);
    if (!row) return toolResult(id, "技能不存在", true);
    return toolResult(id, { skill: row });
  }
  if (name === "skills_create") {
    const created = await createSkill(env.DB, args, now);
    await logOp(env.DB, {
      actor: auth.agentName,
      module: "Skills",
      action: "添加",
      targetId: created.id,
      targetName: created.name,
      text: `添加了Skills「${created.name}」`,
    });
    return toolResult(id, { skill: created });
  }
  if (name === "skills_update" || name === "skills_delete") {
    const skillId = argString(args, "skill_id") ?? "";
    const skillName = argString(args, "name") ?? "";
    if (!skillId.trim() && !skillName.trim()) return toolResult(id, "请提供 skill_id 或 name", true);
    // 定位口径与 skills_get 一致（先 id 后 name），但写路径不记获取审计。
    let row = skillId.trim() ? await getSkill(env.DB, skillId.trim()) : null;
    if (!row && skillName.trim()) row = await getSkillByName(env.DB, skillName.trim());
    if (!row) return toolResult(id, "技能不存在", true);
    if (name === "skills_delete") {
      await deleteSkill(env.DB, row.id);
      await logOp(env.DB, {
        actor: auth.agentName,
        module: "Skills",
        action: "删除",
        targetId: row.id,
        targetName: row.name,
        text: `删除了Skills「${row.name}」`,
      });
      return toolResult(id, { skill: row, deleted: true });
    }
    const { skill_id: _omit, ...patch } = args;
    const patchBody: Record<string, unknown> = { ...patch };
    // 只用 name 定位时 name 是定位键而非新名（改名走 skill_id + 新 name）。
    if (!skillId.trim()) delete patchBody.name;
    const updated = await updateSkill(env.DB, row.id, patchBody, now);
    await logOp(env.DB, {
      actor: auth.agentName,
      module: "Skills",
      action: "修改",
      targetId: row.id,
      targetName: updated.name,
      text: `修改了Skills「${updated.name}」`,
    });
    return toolResult(id, { skill: updated });
  }
  return toolResult(id, "未知工具", true);
}

async function callApisTool(
  env: Env,
  id: unknown,
  name: string,
  args: Record<string, unknown>,
  auth: { agentId: string; agentName: string },
): Promise<Response> {
  const now = Date.now();
  if (name === "apis_list") {
    const rows = await listApis(env.DB, null);
    return toolResult(id, { apis: rows.map(apiSummary) });
  }
  if (name === "apis_get") {
    const apiId = argString(args, "api_id") ?? "";
    const apiName = argString(args, "name") ?? "";
    if (!apiId.trim() && !apiName.trim()) return toolResult(id, "请提供 api_id 或 name", true);
    const row = await getApiForAgent(env.DB, apiId.trim(), apiName.trim(), auth.agentId, now);
    if (!row) return toolResult(id, "API 条目不存在", true);
    return toolResult(id, { api: apiSummary(row) });
  }
  if (name === "apis_create") {
    const created = await createApi(env.DB, args, now);
    await logOp(env.DB, {
      actor: auth.agentName,
      module: "API",
      action: "添加",
      targetId: created.id,
      targetName: created.name,
      text: `添加了API「${created.name}」`,
    });
    return toolResult(id, { api: apiSummary(created) });
  }
  if (name === "apis_update" || name === "apis_delete") {
    const apiId = argString(args, "api_id") ?? "";
    const apiName = argString(args, "name") ?? "";
    if (!apiId.trim() && !apiName.trim()) return toolResult(id, "请提供 api_id 或 name", true);
    // 定位口径与 apis_get 一致（先 id 后 name），但写路径不记获取审计。
    let row = apiId.trim() ? await getApi(env.DB, apiId.trim()) : null;
    if (!row && apiName.trim()) row = await getApiByName(env.DB, apiName.trim());
    if (!row) return toolResult(id, "API 条目不存在", true);
    if (name === "apis_delete") {
      await deleteApi(env.DB, row.id);
      await logOp(env.DB, {
        actor: auth.agentName,
        module: "API",
        action: "删除",
        targetId: row.id,
        targetName: row.name,
        text: `删除了API「${row.name}」`,
      });
      return toolResult(id, { api: apiSummary(row), deleted: true });
    }
    const { api_id: _omit, ...patch } = args;
    const patchBody: Record<string, unknown> = { ...patch };
    // 只用 name 定位时 name 是定位键而非新名（改名走 api_id + 新 name）。
    if (!apiId.trim()) delete patchBody.name;
    const updated = await updateApi(env.DB, row.id, patchBody, now);
    await logOp(env.DB, {
      actor: auth.agentName,
      module: "API",
      action: "修改",
      targetId: row.id,
      targetName: updated.name,
      text: `修改了API「${updated.name}」`,
    });
    return toolResult(id, { api: apiSummary(updated) });
  }
  return toolResult(id, "未知工具", true);
}

// agents_* 工具组（高级域 agents_other）：只能操作「其他」Agent。自我门
// 分两层：toolAccessError 先按 agent_id / name 参数预判（403 口径），这里
// 解析出目标后再按 id 复判一次——name 定位命中自己、或 id 与 name 指向
// 不同人时以解析结果为准。OAuth 应用身份没有「自己」这个 Agent 行：
// 按 id / name 定位不到自己，直接走目标逻辑（列表为空过滤无效果）。
const AGENTS_SELF_ERROR = "只能操作其他 Agent，不能用这个工具操作自己";

async function callAgentsTool(
  env: Env,
  request: Request,
  id: unknown,
  name: string,
  args: Record<string, unknown>,
  auth: { agentId: string; agentName: string },
): Promise<Response> {
  if (name === "agents_list") {
    const agents = await listAgents(env.DB);
    return toolResult(id, { agents: agents.filter((agent) => agent.id !== auth.agentId) });
  }
  const agentId = argString(args, "agent_id") ?? "";
  const targetName = argString(args, "name") ?? "";
  if (!agentId.trim() && !targetName.trim()) return toolResult(id, "请提供 agent_id 或 name", true);
  const target = await resolveAgent(env.DB, agentId.trim(), targetName.trim());
  if (!target) return toolResult(id, "未找到 Agent", true);
  if (target.id === auth.agentId) return toolResult(id, AGENTS_SELF_ERROR, true);
  if (name === "agents_get") {
    // 令牌与接入地址：revealAgentToken 先写 agents_audit（actor = 调用
    // Agent 名）再解密，审计写不进就 503、不返回令牌（fail-closed）。
    const revealed = await revealAgentToken(env, target.id, auth.agentName);
    if (!revealed.ok) return toolResult(id, revealed.error, true);
    await logOp(env.DB, {
      actor: auth.agentName,
      module: "Agent",
      action: "查看",
      targetId: target.id,
      targetName: target.name,
      text: `复制了 Agent「${target.name}」的密钥`,
    });
    const endpoint = new URL(request.url).origin + "/mcp?token=" + encodeURIComponent(revealed.token);
    return toolResult(id, { agent: target, token: revealed.token, endpoint });
  }
  if (name === "agents_rotate_token") {
    const rotated = await rotateAgentToken(env, target.id, auth.agentName);
    if (!rotated.ok) return toolResult(id, rotated.error, true);
    await logOp(env.DB, {
      actor: auth.agentName,
      module: "Agent",
      action: "轮换密钥",
      targetId: target.id,
      targetName: target.name,
      text: `轮换了 Agent「${target.name}」的密钥`,
    });
    return toolResult(id, { agent: rotated.agent, token: rotated.token });
  }
  if (name === "agents_set_enabled") {
    if (typeof args.enabled !== "boolean") return toolResult(id, "请提供 enabled（true 或 false）", true);
    const status = args.enabled ? "active" : "disabled";
    // 启停走面板同款 updateAgent({status})，不用 disableAgent（它记的是
    // delete 审计、语义是删除相邻路径）；updateAgent 自己写 update 审计。
    const updated = await updateAgent(env.DB, target.id, { status });
    if (!updated.ok) return toolResult(id, updated.error, true);
    const action = args.enabled ? "启用" : "停用";
    await logOp(env.DB, {
      actor: auth.agentName,
      module: "Agent",
      action,
      targetId: target.id,
      targetName: target.name,
      text: `${action}了 Agent「${target.name}」`,
    });
    return toolResult(id, { agent: updated.agent });
  }
  return toolResult(id, "未知工具", true);
}

// vault_* 工具组（vault_2fa_* 除外，那组只认 totp.read、走
// callVaultTotpTool）：保险库条目 / 邮箱 / 模型网关的读写，全部复用
// vault.ts 的面板同款函数（createEntry / updateEntry / …自带校验与密封）。
// 明文只从 vault_get_* 出：revealSecret 先写 vault_access_log（actor =
// 调用 Agent 名）与 oplog 再解密，审计写不进就不返回明文（fail-closed）。
// 定位口径与同类工具一致：先 id 后 name（邮箱按 address 定位），name 只
// 作定位时不能改名。
async function callVaultTool(
  env: Env,
  id: unknown,
  name: string,
  args: Record<string, unknown>,
  agentName: string,
): Promise<Response> {
  const now = Date.now();
  if (name === "vault_list_entries") {
    const rows = await listEntries(env.DB);
    return toolResult(id, { entries: rows.map(entryPublic) });
  }
  if (name === "vault_list_emails") {
    const rows = await listEmails(env.DB);
    return toolResult(id, { emails: rows.map(emailPublic) });
  }
  if (name === "vault_list_gateways") {
    const rows = await listGateways(env.DB);
    return toolResult(id, { gateways: rows.map(gatewayPublic) });
  }

  const resolveEntry = async (): Promise<VaultEntryRow | null> => {
    const entryId = argString(args, "entry_id") ?? "";
    const entryName = argString(args, "name") ?? "";
    if (!entryId.trim() && !entryName.trim()) return null;
    const rows = await listEntries(env.DB);
    return (
      (entryId.trim() ? rows.find((row) => row.id === entryId.trim()) : undefined) ??
      (entryName.trim() ? rows.find((row) => row.name === entryName.trim()) : undefined) ??
      null
    );
  };
  const resolveEmail = async (): Promise<EmailRow | null> => {
    const emailId = argString(args, "email_id") ?? "";
    const address = argString(args, "address") ?? "";
    if (!emailId.trim() && !address.trim()) return null;
    const rows = await listEmails(env.DB);
    return (
      (emailId.trim() ? rows.find((row) => row.id === emailId.trim()) : undefined) ??
      (address.trim() ? rows.find((row) => row.address === address.trim()) : undefined) ??
      null
    );
  };
  const resolveGateway = async (): Promise<GatewayRow | null> => {
    const gatewayId = argString(args, "gateway_id") ?? "";
    const gatewayName = argString(args, "name") ?? "";
    if (!gatewayId.trim() && !gatewayName.trim()) return null;
    const rows = await listGateways(env.DB);
    return (
      (gatewayId.trim() ? rows.find((row) => row.id === gatewayId.trim()) : undefined) ??
      (gatewayName.trim() ? rows.find((row) => row.name === gatewayName.trim()) : undefined) ??
      null
    );
  };

  if (name === "vault_get_entry" || name === "vault_get_email" || name === "vault_get_gateway") {
    const kind = name === "vault_get_entry" ? "entry" : name === "vault_get_email" ? "email" : "gateway";
    const row = kind === "entry" ? await resolveEntry() : kind === "email" ? await resolveEmail() : await resolveGateway();
    if (!row) {
      const hint =
        kind === "entry"
          ? "请提供 entry_id 或 name"
          : kind === "email"
            ? "请提供 email_id 或 address"
            : "请提供 gateway_id 或 name";
      const given =
        kind === "entry"
          ? (argString(args, "entry_id") ?? "") || (argString(args, "name") ?? "")
          : kind === "email"
            ? (argString(args, "email_id") ?? "") || (argString(args, "address") ?? "")
            : (argString(args, "gateway_id") ?? "") || (argString(args, "name") ?? "");
      if (!given.trim()) return toolResult(id, hint, true);
      return toolResult(id, kind === "entry" ? "条目不存在" : kind === "email" ? "邮箱不存在" : "网关不存在", true);
    }
    const revealed = await revealSecret(env.DB, env, { kind, id: row.id }, now, { panel: agentName, agent: agentName });
    if (kind === "entry") {
      const entry = row as VaultEntryRow;
      return toolResult(id, { entry: { ...entryPublic(entry), password: revealed.value } });
    }
    if (kind === "email") {
      const email = row as EmailRow;
      return toolResult(id, { email: { ...emailPublic(email), smtp_secret: email.smtp_secret ? revealed.value : "" } });
    }
    const gateway = row as GatewayRow;
    return toolResult(id, { gateway: { ...gatewayPublic(gateway), key: revealed.value } });
  }

  if (name === "vault_create_entry") {
    const created = await createEntry(env.DB, env, args, now);
    await logOp(env.DB, {
      actor: agentName,
      module: "保险库",
      action: "添加",
      targetId: created.id,
      targetName: created.name,
      text: `添加了保险库条目「${created.name}」`,
    });
    return toolResult(id, { entry: entryPublic(created) });
  }
  if (name === "vault_create_email") {
    const created = await createEmail(env.DB, env, args, now);
    await logOp(env.DB, {
      actor: agentName,
      module: "保险库",
      action: "添加",
      targetId: created.id,
      targetName: created.address,
      text: `添加了发信邮箱「${created.address}」`,
    });
    return toolResult(id, { email: emailPublic(created) });
  }
  if (name === "vault_create_gateway") {
    const created = await createGateway(env.DB, env, args, now);
    await logOp(env.DB, {
      actor: agentName,
      module: "保险库",
      action: "添加",
      targetId: created.id,
      targetName: created.name,
      text: `添加了模型网关「${created.name}」`,
    });
    return toolResult(id, { gateway: gatewayPublic(created) });
  }

  if (name === "vault_update_entry" || name === "vault_delete_entry") {
    const entryId = argString(args, "entry_id") ?? "";
    const row = await resolveEntry();
    if (!row) {
      if (!entryId.trim() && !(argString(args, "name") ?? "").trim()) return toolResult(id, "请提供 entry_id 或 name", true);
      return toolResult(id, "条目不存在", true);
    }
    if (name === "vault_delete_entry") {
      const deleted = await deleteEntry(env.DB, row.id);
      await logOp(env.DB, {
        actor: agentName,
        module: "保险库",
        action: "删除",
        targetId: row.id,
        targetName: deleted.name,
        text: `删除了保险库条目「${deleted.name}」`,
      });
      return toolResult(id, { entry: entryPublic(deleted), deleted: true });
    }
    const { entry_id: _omit, ...patch } = args;
    const patchBody: Record<string, unknown> = { ...patch };
    if (!entryId.trim()) delete patchBody.name;
    const updated = await updateEntry(env.DB, env, row.id, patchBody, now);
    await logOp(env.DB, {
      actor: agentName,
      module: "保险库",
      action: "修改",
      targetId: row.id,
      targetName: updated.name,
      text: `修改了保险库条目「${updated.name}」`,
    });
    return toolResult(id, { entry: entryPublic(updated) });
  }
  if (name === "vault_update_email" || name === "vault_delete_email") {
    const emailId = argString(args, "email_id") ?? "";
    const row = await resolveEmail();
    if (!row) {
      if (!emailId.trim() && !(argString(args, "address") ?? "").trim()) return toolResult(id, "请提供 email_id 或 address", true);
      return toolResult(id, "邮箱不存在", true);
    }
    if (name === "vault_delete_email") {
      const deleted = await deleteEmail(env.DB, row.id);
      await logOp(env.DB, {
        actor: agentName,
        module: "保险库",
        action: "删除",
        targetId: row.id,
        targetName: deleted.address,
        text: `删除了发信邮箱「${deleted.address}」`,
      });
      return toolResult(id, { email: emailPublic(deleted), deleted: true });
    }
    const { email_id: _omit, ...patch } = args;
    const patchBody: Record<string, unknown> = { ...patch };
    if (!emailId.trim()) delete patchBody.address;
    const updated = await updateEmail(env.DB, env, row.id, patchBody, now);
    await logOp(env.DB, {
      actor: agentName,
      module: "保险库",
      action: "修改",
      targetId: row.id,
      targetName: updated.address,
      text: `修改了发信邮箱「${updated.address}」`,
    });
    return toolResult(id, { email: emailPublic(updated) });
  }
  if (name === "vault_update_gateway" || name === "vault_delete_gateway") {
    const gatewayId = argString(args, "gateway_id") ?? "";
    const row = await resolveGateway();
    if (!row) {
      if (!gatewayId.trim() && !(argString(args, "name") ?? "").trim()) return toolResult(id, "请提供 gateway_id 或 name", true);
      return toolResult(id, "网关不存在", true);
    }
    if (name === "vault_delete_gateway") {
      const deleted = await deleteGateway(env.DB, row.id);
      await logOp(env.DB, {
        actor: agentName,
        module: "保险库",
        action: "删除",
        targetId: row.id,
        targetName: deleted.name,
        text: `删除了模型网关「${deleted.name}」`,
      });
      return toolResult(id, { gateway: gatewayPublic(deleted), deleted: true });
    }
    const { gateway_id: _omit, ...patch } = args;
    const patchBody: Record<string, unknown> = { ...patch };
    if (!gatewayId.trim()) delete patchBody.name;
    const updated = await updateGateway(env.DB, env, row.id, patchBody, now);
    await logOp(env.DB, {
      actor: agentName,
      module: "保险库",
      action: "修改",
      targetId: row.id,
      targetName: updated.name,
      text: `修改了模型网关「${updated.name}」`,
    });
    return toolResult(id, { gateway: gatewayPublic(updated) });
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
