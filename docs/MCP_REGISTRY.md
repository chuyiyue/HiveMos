# HiveMos MCP 注册表

注册表只负责发现。Agent 从 `POST /mcp` 查到条目、取回端点和配置模板，然后自己直连下游。调用流量不经过 HiveMos。本期不做端到端加密，也不做密钥租约。

## 1. 已冻结口径

- 不做实时代理。三个工具是 `mcp_search`、`mcp_list`、`mcp_get`。端点和配置只从 `mcp_get` 返回。
- 调用记录只靠取配置审计。`mcp_get` 成功返回前先写 `mcp_fetch_audit`（agent、条目、时间）。没有自报回执工具。
- 工具快照只用于搜索和面板展示，不出现在调用路径上。刷新来源有三处：Cron 按设置页「功能设置」里的定时任务频率（默认每 6 小时）、登记时探一次、面板上的刷新按钮。探活失败保留旧的 `snapshot_json`，只更新 `snapshot_status` 和 `snapshot_at`。
- 每个 Agent 一把 Bearer 令牌，库里只存 SHA-256。配置带 `version` 和 `ttl_seconds`。`config_json` 里的密钥一律写 `{{vault://…}}` 占位，不要写真实令牌。

## 2. 数据表

迁移文件是 `migrations/0002_mcp_registry.sql`。`0001` 是管理员 `sessions`。时间戳与会话表相同，都是 Unix 毫秒。

### agents

| 列 | 含义 |
| --- | --- |
| id | 主键，`agt_` 加 32 位十六进制 |
| name | 唯一显示名 |
| token_hash | 令牌的 SHA-256 十六进制，不是明文 |
| status | `active` 或 `disabled`，默认 `active` |
| last_seen_at | 最近一次通过令牌校验的时刻，可空 |
| created_at | 创建时刻 |

`DELETE /api/agents/:id` 只把 `status` 改成 `disabled`，不删行，审计仍能连上名字。停用后不能再启用，需要时重新生成。

### mcp_servers

| 列 | 含义 |
| --- | --- |
| id | 主键 |
| name | 唯一短名，小写字母、数字、下划线、连字符。`mcp_get` 可以按它取 |
| title / description / category | 展示和搜索用 |
| endpoint_url | http/sse 是 URL，stdio 是启动命令 |
| transport | `http`、`sse` 或 `stdio` |
| launch_config_json | 可空 JSON 文本 |
| auth_type | `none`、`bearer` 或 `oauth` |
| config_json | 可空配置模板，可含 `{{vault://…}}` |
| tags_json | `[{ "text", "source": "human" \| "ai" }]`。人工优先 |
| summary / summary_source | 一句话简介。`human` 或 `ai`，人工优先 |
| status | `active` 或 `disabled` |
| version | 从 1 起。会改变 Agent 拿到的登记内容时加 1。只刷新快照不加 |
| ttl_seconds | 默认 86400。Agent 在此时间内复用上次取到的配置 |
| snapshot_json | `{ "tools": [{ "name", "description", "inputSchema" }] }`，可空 |
| snapshot_at / snapshot_status | 快照时刻，以及 `ok`、`failed`、`manual`、`none` |
| content_hash | 名称、标题、说明、规范化配置、排序后的工具名，拼成一段再 SHA-256 |
| ai_status | `pending`、`done`、`failed`、`skipped` |
| embedding | 预留，本期不写 |
| created_at / updated_at | 创建与内容更新时刻。自动探活不改 `updated_at` |

### mcp_fetch_audit

| 列 | 含义 |
| --- | --- |
| id | 主键 |
| agent_id / server_id | 取配置的 Agent 和条目 |
| created_at | 写入时刻 |

删除条目不会删审计。面板列出最近 100 条，并左连接名称。

## 3. Agent 接入

### 3.1 拿令牌

管理员打开 `/agents.html`，输入名字，点「生成令牌」。响应里的 `agent.token` 只出现这一次，形如 `hvm_agt_` 加 32 字节的 base64url。库里只有哈希。请求头：

```http
Authorization: Bearer hvm_agt_…
```

`status` 不是 `active` 时，`tools/call` 返回 HTTP 401，正文是 JSON-RPC 错误「令牌已停用」。通过校验后更新 `last_seen_at`。

`initialize`、`notifications/initialized`、`tools/list` 不校验令牌，它们只暴露这三个工具的名字和参数形状，不返回任何条目。

### 3.2 协议

`POST /mcp`，`Content-Type: application/json`，无状态，不看管理员 Cookie。其他方法不进协议：已登录的 `GET /mcp` 仍交给静态页面（`html_handling` 可能把 `/mcp.html` 收到 `/mcp`），未登录则是管理员门禁的 401。

初始化：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": { "name": "example", "version": "0.1.0" }
  }
}
```

然后可以发不带 `id` 的 `notifications/initialized`（HTTP 202，空正文），再 `tools/list`。

搜索：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": { "name": "mcp_search", "arguments": { "query": "邮件", "tag": "inbox" } }
}
```

`query` 和 `tag` 都可省略。关键词对名称、标题、说明、标签、分类、快照工具名和工具描述做不区分大小写的包含匹配。`tag` 是标签文本的不区分大小写精确匹配，和关键词是「并且」。只返回 `status = active` 的条目。每条带 `matched_tools`（命中的工具名，关键词为空时是空数组）。列表里没有 `endpoint_url`、`config`、`launch_config`。

`mcp_list` 只有可选的 `tag`，没有 `matched_tools`。

取配置：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": { "name": "mcp_get", "arguments": { "name": "cloud-mail" } }
}
```

`server_id` 和 `name` 至少给一个。都给时优先 `server_id`；找不到再按 `name`。成功时工具结果的 JSON 是：

```json
{
  "endpoint_url": "https://mail.outtw.com/mcp",
  "transport": "http",
  "launch_config": null,
  "auth_type": "bearer",
  "config": { "headers": { "Authorization": "Bearer {{vault://cloud-mail/token}}" } },
  "version": 1,
  "ttl_seconds": 86400
}
```

文本在 `result.content[0].text`，同一对象也在 `result.structuredContent`。找不到、或条目已停用，是 `isError: true`，不写审计。

### 3.3 直连与复用

拿到上面的对象之后，Agent 按 `transport` 自己连接 `endpoint_url`。`config` 是模板，把 `{{vault://…}}` 换成自己保险库里的值再发出去。HiveMos 不代发，也看不到下游调用。

在 `ttl_seconds` 内复用这份配置。过期后再 `mcp_get`。条目内容有实质修改时 `version` 加 1；Agent 如果另外看到了更大的 version（搜索结果里带 version），应提前重取。只刷新工具快照不会抬高 version。

## 4. 面板接口

沿用管理员会话。未登录的 `/api/*` 一律 401 `{ "ok": false, "error": "未登录" }`，这里不再做第二套登录。变更请求若 `Sec-Fetch-Site: cross-site` 或 `Origin` 与本站不一致，返回 403。

| 方法与路径 | 作用 |
| --- | --- |
| `GET /api/mcp-servers` | 全部条目，含标签、快照、版本 |
| `POST /api/mcp-servers` | 登记。http/sse 且为启用时立刻探活一次 |
| `GET /api/mcp-servers/:id` | 单条 |
| `PUT /api/mcp-servers/:id` | 编辑。正文带 `name` 等字段 |
| `PUT /api/mcp-servers/:id` 且正文只有 `snapshot_json` | 手填快照，`snapshot_status` 记为 `manual` |
| `DELETE /api/mcp-servers/:id` | 删除条目 |
| `POST /api/mcp-servers/:id/refresh-snapshot` | 手动探活 |
| `GET /api/mcp-audit` | 最近 100 条审计，含 `agent_name` 与 `server_name` |
| `GET /api/agents` | `id`、`name`、`status`、`last_seen_at`、`created_at`。没有令牌哈希 |
| `POST /api/agents` | `{ "name" }`。响应里的 `agent.token` 只此一次 |
| `DELETE /api/agents/:id` | 停用 |

stdio 的探活返回 400「stdio 条目不能自动探活，请手填工具快照」，不改已有快照。http/sse 探活失败返回 502，正文里仍带更新后的条目，`snapshot_status` 为 `failed`。

手填内容接受下面三种形状：`tools/list` 的完整 JSON-RPC 响应、`{ "tools": [...] }`、或工具数组。

## 5. 快照刷新

探活对 `endpoint_url` 发两次 JSON-RPC POST：`initialize`，然后 `tools/list`。若响应带 `mcp-session-id`，第二次会带上。成功时保存精简工具列表，`snapshot_status = ok`。失败只改状态和时间。

`wrangler.jsonc` 的 Cron 是 `0 * * * *`，每小时检查一次；实际执行间隔取设置页「功能设置」里的定时任务频率（默认每 6 小时）。`scheduled()` 遍历 `status = active` 且 `transport` 不是 `stdio` 的条目，调用和手动刷新同一个函数。一个端点失败不影响后面的条目。

快照里的工具名和描述参与 `mcp_search`，不参与 `mcp_get` 的返回。

## 6. AI 打标与降级

内容哈希覆盖名称、标题、说明、配置的稳定 JSON、以及排序后的快照工具名。哈希变了才打标，内容不变不重复调用。

`env.AI` 存在时，用 `waitUntil` 调 `env.AI.run`。模型读 `env.AI_MODEL`，空白或未配置时用 `@cf/google/gemma-4-26b-a4b-it`。返回值同时接受 `{ "response" }` 和 OpenAI 的 `{ "choices": [{ "message": { "content" } }] }`。

模型输出 3 到 6 个短标签和一句话简介。写入时 `source` 为 `ai`，`ai_status` 为 `done`。已有人工标签则不改标签；已有人工简介则不改简介。只补空着的那一侧。

没有 AI 绑定：`ai_status = skipped`。调用抛错或解析失败：`ai_status = failed`。两种情况都不影响增删改查的响应。

## 7. 种子数据

种子写在 `migrations/0002_mcp_registry.sql` 末尾，没有单独的 `seed.sql`。`npx wrangler d1 migrations apply hivemos --local`（或 `--remote`）会建表并插入这两行。说明里都标了「种子条目」。

| name | 端点 | 配置占位 |
| --- | --- | --- |
| cloud-mail | `https://mail.outtw.com/mcp` | `{{vault://cloud-mail/token}}` |
| smsinbox | `https://example.com/mcp` | `{{vault://smsinbox/token}}` |

smsinbox 的地址是占位，待改成真实端点，不要当成生产地址。两行都没有真实令牌。`content_hash` 按第 6 节的规则预先算好，`ai_status` 为 `skipped`。之后只有内容哈希变化才会打标。

## 8. 本地预览

不在本期部署到 Cloudflare。本地：

```bash
npx wrangler d1 migrations apply hivemos --local
npx wrangler dev
```

管理员账号仍是 `ADMIN_USERNAME` 与 `ADMIN_PASSWORD`。AI 绑定留着；本地没有可用模型时，登记接口照常返回，打标状态记为 `skipped` 或 `failed`。

## 9. 后续待办

- 端到端加密和密钥租约。本期配置以占位符明文存在库里，面板上也可复制。
- 用 `embedding` 做语义搜索。本期搜索是关键词包含匹配。
