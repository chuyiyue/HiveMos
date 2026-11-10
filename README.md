<p align="center">
  <img src="public/logo.png" alt="HiveMos" width="120">
</p>

<h1 align="center">HiveMos</h1>

<p align="center">多 Agent 的配置同步与控制面 —— 整站运行在 Cloudflare Workers 上</p>

## 这是什么

HiveMos 是为多个 AI Agent 准备的「中枢」：每个 Agent 的身份、权限、记忆、人格（Soul）、技能、任务和日历都集中存放在一处，由 Agent 通过 MCP 协议随时取用和更新，管理员则通过一个 Web 面板统一管理。

它解决的是多 Agent 场景下配置四处散落的问题：不用再把每个 Agent 的记忆、技能包、接入凭据分别塞进每台机器。Workers 端是唯一事实来源，Agent 在哪里运行，就从哪里连回 HiveMos 拿自己的配置。

- 单管理员 Web 面板（登录 + 两步验证）
- Agent 通过 MCP 接入，每个 Agent 一枚独立令牌
- 全部数据存放在 D1，前端是无构建步骤的原生 HTML/CSS/JavaScript

## 功能

### Agents 与权限

- Agent 注册表：创建、启停、置顶、头像，标识为 `agt_` + 12 位十六进制
- 令牌可经面板审计后取回明文（保险库同级加密密封保存，不做只显示一次）
- 权限是按功能域划分的读写矩阵：每个域（MCP、Skills、API、记忆、Soul、任务、日历、保险库、云计算资源）分别勾选读与写，再加三个独立的高级权限——查看机器凭据、代写他人 Soul、读取保险库验证码
- 每次 MCP 调用都有记录，被拒绝的调用同样留痕

### MCP 注册表、Skills 与 API

- 下游 MCP 服务注册表：登记名称、端点与连接配置，Agent 用 `mcp_search` / `mcp_list` 发现服务，用 `mcp_get` 取连接配置去直连——HiveMos 只做注册与发现，不代理转发流量
- Skills 技能库与 API 注册表同样开放给 Agent 按权限读取，取用前先写审计

### 记忆与 Soul

- 记忆：跨 Agent 共享的长期记忆库，支持置顶、权重排序、标签治理（标签总量上限、AI 补全与合并近义标签），MCP 列表默认只回摘要，需要时再取全文
- Soul：每个 Agent 的人格文档，带完整版本历史；Agent 经 MCP 改自己的 Soul 只生成待批准草稿，管理员在面板批准后才生效；改版有乐观锁版本校验

### 任务与日历

- 任务：Agent 之间派发与领取的任务队列（创建、更新、完成均经 MCP 或面板）
- 日历：原生事件 + 外部日历镜像同步 + ICS 订阅（每设备一枚可撤销的订阅令牌），重复事件按 RRULE 在读取时展开

### 云计算资源

- 服务器：SSH 直连探测（主机名、系统、规格、在线状态），凭据加密保存，经审计取用
- 云主机：服务商接入（首个支持 InstaBox）——填 API 配置、测试、勾选设备导入；同步时主动探测运行中机器的系统版本与出口所在地；设备卡片带电源、端口转发、保活与快照
- 边缘计算：Cloudflare / Vercel 账号的项目、域名、部署与用量总览
- 代理：订阅导入与节点管理（测活、备注、复制链接），订阅地址与节点原始链接加密保存

### 保险库

- 账号密码条目、模型网关（多协议密钥）、邮箱（含 SMTP 配置）
- 验证码（TOTP）：扫码、手动或从 Aegis / 2FAS / Google Authenticator 迁移导入，当前码与下一个码同屏显示，支持加密导出
- 所有明文查看都先写访问记录再放行；保险库的密码与网关不通过 MCP 开放，验证码可经专用工具取码（需高级权限，且每条可单独开关是否允许 AI 读取）

### 总览、日志与备份

- 总览页汇总系统状态与告警；调用记录与系统操作日志统一可查
- 同步与备份：可把全量数据（机密只以密文形态）备份到 GitHub 仓库或 WebDAV，支持定时自动备份，目标保存前必须先通过连接测试

### AI 辅助

Workers AI 作为底座预埋在各功能里：记忆标签补全与合并建议、内容摘要等。模型由单个配置项 `AI_MODEL` 指定（默认 `@cf/google/gemma-4-26b-a4b-it`），AI 不可用时所有核心功能照常工作——AI 只提建议，不直接修改数据。

## MCP 接入

Agent 以自己令牌连接：

```
POST /mcp
Authorization: Bearer <agent-token>
```

也支持把令牌放在接入地址的 `?token=` 参数里（请求头优先）。`tools/list` 只返回该 Agent 权限覆盖的工具，`tools/call` 每次再按域与读写复查。共 41 个工具：

| 域 | 工具 |
| --- | --- |
| MCP 注册表 | `mcp_search`、`mcp_list`、`mcp_get`、`mcp_create`、`mcp_update`、`mcp_delete` |
| Skills / API | `skills_list`、`skills_get`、`skills_create`、`skills_update`、`skills_delete`、`apis_list`、`apis_get` |
| 记忆 | `memory_list`、`memory_search`、`memory_get`、`memory_remember`、`memory_upsert`、`memory_delete` |
| Soul | `soul_list`、`soul_get`、`soul_update`、`soul_patch`、`soul_diff` |
| 保险库 | `vault_2fa_list`、`vault_2fa_get_code` |
| 任务 | `tasks_list`、`tasks_create`、`tasks_update`、`tasks_complete` |
| 日历 | `calendar_list_calendars`、`calendar_list_events`、`calendar_get_event`、`calendar_search`、`calendar_create_event`、`calendar_update_event`、`calendar_delete_event` |
| 云计算资源 | `machines_list`、`machines_get`、`machines_report`、`machines_get_access` |

注册表的设计说明见 [docs/MCP_REGISTRY.md](docs/MCP_REGISTRY.md)，界面架构见 [docs/UI_ARCHITECTURE.md](docs/UI_ARCHITECTURE.md)。

## 安全模型

- 权限默认拒绝：Agent 只能调用其读写矩阵（含高级权限）明确覆盖的工具
- 敏感读取走「先审计、后放行」：取凭据、取连接配置、导出验证码，审计行写入失败则不返回明文
- 机密以 AES-GCM 密封存储（`VAULT_KEY`），列表与详情接口一律不带明文
- 管理员只有一个：用户名与密码以部署机密为准，每次部署后由同步脚本对齐到管理员行（密码变更即清空全部会话）；系统内不提供改密码入口，改密码的唯一路径是改机密后重新部署
- 登录带失败限流（用户名 + IP 组合键）；管理员登录支持 TOTP 两步验证
- OAuth 授权：外部 AI 客户端经授权码 + PKCE 接入；授权必须先登录管理员，管理员在授权页填应用名并勾完整权限矩阵，批准即创建一个独立的「应用」（自带令牌与权限），在 Agents 板块的「应用」页签管理（改权限、查看令牌、删除）；令牌密封存储、轮换与复用整族撤销、审计全程保留。手动创建的 Agent 与 OAuth 应用是两条独立的身份线
- GitHub 登录：绑定 GitHub 数字 ID 后可用 GitHub 登录（只认 ID、不认用户名，登录回调永不写绑定；未配置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET 时入口隐藏）

## 架构

```
public/   原生多页前端（无框架、无构建步骤），Workers 静态资源托管
src/      TypeScript Worker：路由分发、各域业务模块、MCP 服务端
migrations/  D1 迁移，按序号只增不改
scripts/  部署入口 deploy.sh、部署前检查 check.mjs、管理员同步 sync-admin.mjs
```

- 运行时：Cloudflare Workers + D1 + Workers AI（绑定名 `DB`、`AI`）
- 定时任务：Worker 每小时触发，实际执行频率由面板的功能设置控制（默认 6 小时），执行日历镜像同步、服务商连接同步、保活扫描与定时备份
- 页面带部署版本握手：新版本上线后，已打开的面板会自动刷新一次，不会停留在旧资源上

## 部署

需要一个 Cloudflare 账号与 Node.js 环境。

```bash
# 1. 创建数据库（把得到的 database_id 回填到 wrangler.jsonc）
npx wrangler d1 create hivemos

# 2. 设置保险库主密钥（32 字节随机值的 base64）
npx wrangler secret put VAULT_KEY

# 3. 部署（先过检查门，再部署，最后按机密同步管理员行）
CLOUDFLARE_ACCOUNT_ID=<你的账号 ID> ADMIN_USERNAME=<管理员名> ADMIN_PASSWORD=<管理员密码> sh scripts/deploy.sh
```

部署完成后用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录面板即可。后续修改管理员密码：改掉部署机密里的 `ADMIN_PASSWORD` 再跑一次部署。

本地预览：

```bash
npx wrangler d1 migrations apply hivemos --local
npx wrangler dev
```

未登录访问页面会跳转到 `/login.html`；`GET /api/health` 返回 `{"ok":true,"service":"hivemos"}`。

可选配置：

| 机密 / 变量 | 用途 |
| --- | --- |
| `VAULT_KEY` | 保险库与凭据的加密主密钥（必需） |
| `ADMIN_USERNAME`、`ADMIN_PASSWORD` | 部署时同步管理员账号（改密码走这里） |
| `AI_MODEL` | AI 辅助使用的模型，未配置时用默认值 |
| `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET` | GitHub 登录绑定，未配置时相关入口隐藏 |

## 说明

HiveMos 是个人自托管项目，按现状提供。数据全部存放在部署者自己的 Cloudflare 账号内，不经过任何第三方服务。
