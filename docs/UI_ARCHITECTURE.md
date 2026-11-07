# HiveMos UI 架构

第一阶段只建立控制面的页面骨架。技术形态与 SMSinBox 对齐：Cloudflare Worker 提供静态资源和一个健康检查，`public/` 下每个模块是一个 HTML 加一个同名脚本，没有构建步骤，也没有 npm 依赖。视觉只改配色和标题字体，布局、组件和交互保持 SMSinBox 的外壳。

业务接口、数据库、登录会话都不在这一阶段。页面上的名单、状态和密钥尾号全部写死，并在对应脚本顶部用 `mock` 注释标出。

## 1. 设计原则

- **外壳先行。** 每个业务页都有同一套侧栏和顶栏。导航从 `public/registry.js` 读出，由 `public/shell.js` 画进空的 `nav.sidebar-nav`，页面 HTML 不手写导航链接。
- **类名平移。** 沿用 SMSinBox 的 `.app-layout`、`.sidebar`、`.sidebar-nav`、`.sidebar-devices`、`.sidebar-footer`、`.main`、`.topbar`、`.page`、`.card`、`.panel`、`.callout`、`.empty-state`、`.status-indicator`。侧栏里的 Agent 轨复用 `.device-link`，避免另起一套轨。
- **配色只换值。** `tokens.css` 的变量名与 SMSinBox 同名同义。浅色是暖象牙，深色是暖深灰，陶土橙只用于主按钮、导航选中态和强调。侧栏跟随主题，不拼色，没有渐变，没有彩色装饰条。
- **扁平、可复制。** 关键字段直接铺在卡片上，不用折叠面板藏内容，不用 `alert`、`confirm`、`prompt` 或 `<select>`。密钥、令牌和设备标识只显示末四位，旁边有复制按钮，复制出去的也是脱敏字符串。
- **空状态与有数据同时在场。** 每页主列表用静态示例画成真实卡片；列表之外另有一块此刻为空的区域，空态文案说明这里以后会出现什么。
- **整页加载。** 注册表里的 `script` 字段记下该页脚本，供以后做成 SMSinBox 那种壳内换页。这一阶段每个 HTML 自己引入脚本，点击导航是一次完整跳转。

## 2. 配色 token

正文用无衬线栈，与 SMSinBox 相同。品牌名（`.brand-name`）和页面大标题（`h1`、`.topbar-title`、`.auth-title`）使用：

```css
--font-serif: Georgia, "Times New Roman", "Songti SC", "SimSun", serif;
```

`--font-serif` 是相对 SMSinBox 新增的唯一 token 名。其余名字保持不变。

### 2.1 浅色

简报指定的值原样写入 `:root`。

| Token | 值 | 用途 |
| --- | --- | --- |
| `--bg` | `#FAF9F5` | 页面与侧栏底 |
| `--bg-sunken` | `#F0EEE6` | 下沉底、侧栏悬停 |
| `--surface` | `#FFFFFF` | 卡片、输入框、顶栏按钮 |
| `--border` | `#E6E3D8` | 分割线、卡片边 |
| `--border-strong` | `#D8D4C4` | 输入框与次按钮边 |
| `--text` | `#1F1E1D` | 主文字 |
| `--text-2` | `#57554E` | 次文字、侧栏默认字 |
| `--text-3` | `#86837A` | 辅助说明、图标 |
| `--accent` | `#D97757` | 陶土橙，焦点与强调 |
| `--accent-hover` | `#C6613F` | 主按钮悬停 |
| `--accent-button` | `#D97757` | 主按钮底 |
| `--accent-soft` | `#F7E8E0` | 选中底、弱强调 |
| `--on-accent` | `#FFFFFF` | 主按钮上的字 |
| `--focus-ring` | `rgba(217,119,87,.35)` | 焦点环 |

由上面的值推导、没有在简报里逐个点名的浅色 token：

| Token | 值 | 推导 |
| --- | --- | --- |
| `--surface-hover` | `#F3F1E8` | 比白卡片略沉一档的象牙 |
| `--overlay` | `rgba(31, 30, 29, 0.42)` | 用 `--text` 做抽屉遮罩 |
| `--accent-button-hover` | `#C6613F` | 等于 `--accent-hover` |
| `--accent-text` | `#C6613F` | 链接和选中字，比按钮色更深一档以便落在浅底上 |
| `--sidebar-bg` | `#FAF9F5` | 等于 `--bg` |
| `--sidebar-bg-hover` | `#F0EEE6` | 等于 `--bg-sunken` |
| `--sidebar-active-bg` | `#F7E8E0` | 等于 `--accent-soft` |
| `--sidebar-border` | `#E6E3D8` | 等于 `--border` |
| `--sidebar-text` | `#57554E` | 等于 `--text-2` |
| `--sidebar-text-strong` | `#1F1E1D` | 等于 `--text` |
| `--sidebar-text-muted` / `--sidebar-icon` | `#86837A` | 等于 `--text-3` |
| `--sidebar-active-ink` | `#C6613F` | 选中项用陶土色字 |
| `--sidebar-mark-bg` | `#F7E8E0` | 品牌方块底 |
| `--sidebar-mark-border` | `#E4C8B8` | 品牌方块边，浅陶土 |
| `--toast-bg` / `--toast-ink` | `#1F1E1D` / `#FAF9F5` | 深字浅底对调，这一阶段还没有吐司 |
| `--avatar-1` … `--avatar-6` | 象牙到淡陶土 | 只作头像底，不引入冷色 |

### 2.2 深色

写在 `:root[data-theme="dark"]`，并在 `@media (prefers-color-scheme: dark)` 里对 `data-theme="system"` 和未设置主题再写一份相同的值，这样「跟随系统」不用等脚本改属性。

简报指定：

| Token | 值 |
| --- | --- |
| `--bg` | `#262624` |
| `--bg-sunken` | `#1F1E1D` |
| `--surface` | `#30302E` |
| `--border` | `#3E3E3A` |
| `--text` | `#ECEAE2` |
| `--accent` | `#D97757` |
| `--accent-soft` | `#453630` |

按同一暖深灰方向推导：

| Token | 值 | 推导 |
| --- | --- | --- |
| `--surface-hover` | `#3A3A36` | 比 `--surface` 亮一档 |
| `--border-strong` | `#524E48` | 比 `--border` 更清晰 |
| `--text-2` | `#C4C0B4` | 暖灰中间档 |
| `--text-3` | `#8F8C83` | 暖灰弱档 |
| `--overlay` | `rgba(20, 19, 18, 0.62)` | 暖黑遮罩 |
| `--accent-hover` / `--accent-button-hover` | `#E08A6C` | 深底上把陶土提亮，悬停才看得见 |
| `--accent-button` | `#D97757` | 与浅色相同 |
| `--on-accent` | `#FFFFFF` | 主按钮白字 |
| `--accent-text` / `--sidebar-active-ink` | `#E7A08A` | 深底上的陶土字 |
| `--focus-ring` | `rgba(217,119,87,.45)` | 比浅色略实 |
| `--sidebar-bg` | `#262624` | 等于 `--bg`，不另做一条更黑的轨 |
| `--sidebar-bg-hover` | `#30302E` | 等于 `--surface` |
| `--sidebar-active-bg` | `#453630` | 等于 `--accent-soft` |
| `--sidebar-border` | `#3E3E3A` | 等于 `--border` |
| `--sidebar-text` | `#C4C0B4` | 等于 `--text-2` |
| `--sidebar-text-strong` | `#ECEAE2` | 等于 `--text` |
| `--sidebar-text-muted` / `--sidebar-icon` | `#8F8C83` | 等于 `--text-3` |
| `--sidebar-mark-bg` | `#453630` | 等于 `--accent-soft` |
| `--sidebar-mark-border` | `#6A4E43` | 深陶土边 |

深色头像底是同一组暖灰褐，没有蓝色。

### 2.3 语义色

成功、警告、危险沿用 SMSinBox，不改。

| Token | 浅色 | 深色 |
| --- | --- | --- |
| `--success` | `#16a34a` | `#4ade80` |
| `--success-text` | `#15803d` | `#86efac` |
| `--success-soft` | `#dcfce7` | `rgba(74, 222, 128, 0.14)` |
| `--warning` | `#d97706` | `#fbbf24` |
| `--warning-text` | `#b45309` | `#fcd34d` |
| `--warning-soft` | `#fef3c7` | `rgba(251, 191, 36, 0.14)` |
| `--danger` | `#dc2626` | `#f87171` |
| `--danger-text` | `#b91c1c` | `#fca5a5` |
| `--danger-soft` | `#fee2e2` | `rgba(248, 113, 113, 0.14)` |
| `--on-danger` | `#ffffff` | `#171717` |

浅色状态条背景同样照搬：`--danger-bg: #fde8e4`、`--ok-bg: #e7f5ef`、`--warn-bg: #fff7e8`。深色这三项改指向上面的 soft token。

### 2.4 主题怎么切换

`public/theme-boot.js` 在样式表之前运行，读取 `localStorage["hivemos-theme"]`（`light`、`dark` 或 `system`，缺省 `system`），写到 `<html data-theme>`。顶栏按钮按「跟随系统 → 浅色 → 深色」循环，并把同一键写回。按钮的 `aria-label` 与图标一起换：显示器、太阳、月亮。

## 3. 布局与断点

外壳结构：

```text
.app-layout
  aside.sidebar
    .sidebar-brand-row        品牌（H + HiveMos）+ 收起按钮
    nav.sidebar-nav           注册表渲染的主导航
    .sidebar-devices          侧栏区：Agent 名称与状态，类名与 SMSinBox 设备轨相同
    .sidebar-footer           账号区：管理员（链到设置）+ 登录
  .main
    header.topbar             菜单按钮 + 页面标题 + 「静态骨架」+ 主题按钮
    .page                     本页内容，最大宽度 1080px
.sidebar-backdrop             移动抽屉遮罩
```

断点口径与 `tokens.css` 文件头、以及 SMSinBox 完全一致。CSS 变量不能放进 `@media`，下面的像素值才是权威。

| 档 | 宽度 | 媒体查询 | 行为 |
| --- | --- | --- | --- |
| 移动抽屉 | 640px | `max-width: 639px` | 内容占满屏。顶栏汉堡打开左侧抽屉，宽 `min(84vw, 320px)`，遮罩点击或 Esc 关闭。抽屉里标签和 Agent 列表全部展开，不受桌面收起状态影响 |
| 平板图标轨 | 768px 这一档的侧栏行为覆盖 640–1023 | `min-width: 640px` 且 `max-width: 1023px` | 侧栏固定 64px，只留图标。悬停或键盘聚焦时，用固定定位的标签当提示 |
| 平板内容折叠 | 768px | `max-width: 767px` | 统计卡、记录卡改成单列。768–1023 仍是双列内容加 64px 图标轨 |
| 桌面 | 1024px | `min-width: 1024px` | 侧栏 248px，可收成 64px 图标轨。收起状态记在 `localStorage["hivemos-sidebar"]`。内容区 `min(1080px, 100% - 64px)` 居中 |
| 极窄 | 380px | `max-width: 380px` | 顶栏和页面再收一档水平留白 |

侧栏 Agent 列表没有单独的折叠开关。关键字段不放进折叠面板。图标轨会按 SMSinBox 把整段 Agent 列表藏起来，因为 64px 轨只放得下图标；移动抽屉里这段列表是展开的。

顶栏粘在顶部。页面标题用衬线，是该页唯一的 `h1`。

## 4. 导航与页面信息架构

注册表顺序就是侧栏顺序。

| key | 标题 | 路径 | 脚本 | 图标 |
| --- | --- | --- | --- | --- |
| overview | 总览 | `/` | `/index.js` | `icon-layout` |
| agents | Agent | `/agents.html` | `/agents.js` | `icon-bot` |
| machines | 云电脑 | `/machines.html` | `/machines.js` | `icon-monitor` |
| memory | 记忆 | `/memory.html` | `/memory.js` | `icon-memory` |
| soul | Soul | `/soul.html` | `/soul.js` | `icon-soul` |
| skills | Skills | `/skills.html` | `/skills.js` | `icon-puzzle` |
| tasks | 任务 | `/tasks.html` | `/tasks.js` | `icon-tasks` |
| mcp | MCP | `/mcp.html` | `/mcp.js` | `icon-plug` |
| vault | 保险库 | `/vault.html` | `/vault.js` | `icon-lock` |
| settings | 设置 | `/settings.html` | `/settings.js` | `icon-settings` |
| login | 登录 | `/login.html` | `/login.js` | `icon-log-in` |

账号区的「管理员」也指向设置。当前页是设置时，导航项和账号按钮一起带 `aria-current="page"`。`nav: false` 预留着，这一阶段没有使用。

匹配当前页时会去掉尾部斜线和 `.html`，`/index.html` 视为 `/`。这样静态资源把 `/agents.html` 收成 `/agents` 时，高亮仍然正确。

### 4.1 总览 `/`

- 导语：工作区此刻的规模。
- 六张统计卡：Agent、云电脑、任务、记忆、Soul、保险库。数字来自各页 mock 的计数。
- 「最近动态」：三条带时刻的文本。
- 「告警」空态：还没有告警。

### 4.2 Agent `/agents.html`

- 四张卡：编排（在线）、研究（同步中）、值守（空闲）、档案（离线）。每张有职责、模型、绑定的云电脑、最近活动。
- 卡片 `id` 与侧栏链接的 hash 相同，例如 `#agt_orch`。命中的卡片用陶土边标出。
- 「待接入」空态。

侧栏 Agent 轨与这四条的 id、名称、状态必须一起改。轨的数据在 `shell.js` 的 `SIDEBAR_AGENTS`。

### 4.3 云电脑 `/machines.html`

- 上海-01、新加坡-02 运行中，本地沙箱已暂停且未绑定。字段是区域、绑定的 Agent、最近心跳。
- 「已释放」空态。

### 4.4 记忆 `/memory.html`

- 三条记忆：标题、摘要、作用域、来源、更新时间。摘要是占位正文，整段可见。
- 「冲突」空态，留给以后的合并。

### 4.5 Soul `/soul.html`

- 编排 v12 已同步，研究 v7 同步中，值守 v3 已暂停。
- 「草稿」空态。

### 4.6 Skills `/skills.html`

- `web-search`、`wrangler-deploy` 已启用，`vault-read` 已停用。字段是版本、来源、引用它的 Agent。
- 「待审核」空态。

### 4.7 任务 `/tasks.html`

- 三条传递：进行中、排队、已完成。字段是从哪个 Agent、到哪个 Agent、更新时间。
- 「失败队列」空态。

### 4.8 MCP `/mcp.html`

- filesystem（stdio，12 个工具，在线）、github（http，8，在线）、browser（sse，5，离线）。入口地址直接写在卡片上。
- 这一页不出现令牌。令牌只在设置里以末四位出现。
- 「待批准」空态。

### 4.9 保险库 `/vault.html`

- 三条：模型网关密钥、部署令牌、设备恢复码。
- 每条只渲染末四位，格式是 `•••• ` 加四个字符，例如 `•••• 91f2`。脚本里只有 `tail` 字段，没有完整密钥。
- 「末四位」一列带复制按钮，复制的字符串与屏幕上相同。
- 「回收站」空态。

### 4.10 设置 `/settings.html`

三块都展开，不用标签页互相遮挡。

- **工作区**：名称、区域、操作者。
- **MCP 设置**：聚合入口 `https://hivemos.example/mcp`（可复制）、访问令牌只显示 `•••• 88c0`、已登记服务列表（与 MCP 页同一组服务，状态用已启用 / 已停用）。
- **授权设备**：管理员的 Mac（末四位 `3F2A`）、工作室 iPad（末四位 `90C1`）。平台、最近在线、脱敏标识都直接可见。
- **待批准**空态。

### 4.11 登录 `/login.html`

登录也使用完整外壳，方便在骨架阶段从导航进入。

- 账号、密码。密码可在输入框内切换可见，不弹窗。
- 不使用 `required`，避免浏览器自带的校验气泡。缺字段时在表单里写「请填写账号和密码」。
- 始终可见的说明：静态骨架，提交不会建立会话。提交被脚本拦住，不会发出请求。
- 「其他方式」空态，留给通行密钥和第三方登录。

### 4.12 找不到页面

`public/404.html` 不是导航项。Wrangler 的 `not_found_handling` 指向它。页面是一张居中的卡片，链回总览。

## 5. 组件清单

| 组件 | 类名 | 出现位置 |
| --- | --- | --- |
| 应用壳 | `.app-layout` `.sidebar` `.main` | 全部业务页 |
| 品牌 | `.brand` `.mark` `.brand-name` | 侧栏、404。方块里是衬线字母 H |
| 主导航 | `.sidebar-nav` `a.active` | `shell.js` 按注册表生成 |
| 收起按钮 | `.sidebar-collapse` | 桌面把侧栏收成 64px |
| Agent 轨 | `.sidebar-devices` `.device-link` `.ui-status-dot` | 侧栏底部以上。状态点用 success / warning / danger / idle |
| 账号区 | `.sidebar-footer` `.account-btn` `.account-avatar` `.account-logout` | 管理员、登录 |
| 顶栏 | `.topbar` `.topbar-title` `.live-status` `.icon-btn` | 标题、静态骨架标记、主题 |
| 抽屉 | `#menu-toggle` `.sidebar-backdrop` `.is-open` | 仅 639px 以下显示菜单按钮 |
| 页面栈 | `.page` `.lede` `.stack` `.section-head` | 每页导语和分节 |
| 统计卡 | `.stat-grid` `.card.stat` | 总览。桌面三列，1023 以下两列，767 以下一列 |
| 记录卡 | `.list` `.record` `.kv` | 各模块列表。宽屏左右两栏，767 以下上下堆叠 |
| 状态 | `.status-indicator[data-status]` | `ok` `warn` `danger` `idle`。文案由 `common.js` 的状态表给出，不只靠颜色 |
| 空态 | `.empty-state` `.empty-title` | 每页至少一处，左对齐，不把信息藏进折叠 |
| 提示条 | `.callout` 及 `.warn` `.danger` `.ok` | 登录说明。危险色留给以后的请求错误 |
| 复制行 | `.copy-line` `button.copy-btn` | 保险库末四位、MCP 入口、设置里的令牌和设备标识 |
| 表单 | `label` `input` `.password-field` `.field-error` | 登录 |
| 认证卡 | `.auth-body` `.auth-card` | 仅 404。背景里有一枚很淡的「巢」 |

按钮分三档：默认是陶土主按钮，`.secondary` 是白底描边，`.ghost` 是透明。顶栏图标按钮在 `.topbar .icon-btn` 上收回描边表面，和 SMSinBox 一样。

状态文案表（`common.js`）：

| status | 呈现 |
| --- | --- |
| `online` | 在线 |
| `syncing` | 同步中 |
| `idle` | 空闲 |
| `offline` | 离线 |
| `running` | 运行中 |
| `paused` | 已暂停 |
| `queued` | 排队 |
| `active` | 进行中 |
| `done` | 已完成 |
| `enabled` | 已启用 |
| `disabled` | 已停用 |
| `synced` | 已同步 |
| `stored` | 已保管 |

## 6. 文件结构

```text
wrangler.jsonc          name: hivemos，assets: ./public，main: src/index.ts
src/index.ts            /api/health 返回 JSON，其余交给 ASSETS
docs/UI_ARCHITECTURE.md 本文
public/
  style.css             按顺序引入下面五个样式
  css/tokens.css        颜色、字体、间距、断点变量
  css/base.css          复位、按钮、焦点、衬线标题
  css/components.css    卡片、状态、空态、表单
  css/shell.css         侧栏、顶栏、抽屉、三档断点
  css/pages.css         统计卡、记录卡、复制行、登录面板
  theme-boot.js         首屏前设置 data-theme
  registry.js           HIVEMOS_MODULES
  shell.js              画导航、Agent 轨、收起、抽屉、主题
  common.js             转义、脱敏、卡片、复制
  icons.svg             导航和顶栏用的线性图标
  index.html + index.js
  agents.html + agents.js
  machines.html + machines.js
  memory.html + memory.js
  soul.html + soul.js
  skills.html + skills.js
  tasks.html + tasks.js
  mcp.html + mcp.js
  vault.html + vault.js
  settings.html + settings.js
  login.html + login.js
  404.html
```

`wrangler.jsonc` 的 `compatibility_date` 是 `2026-10-30`。`assets.run_worker_first` 包含 `/api/*`，健康检查不会被静态资源拦住；Worker 只处理 `/api/health`，其他路径包括未知的 `/api/...` 仍 `ASSETS.fetch`。`html_handling` 为 `auto-trailing-slash`，找不到页面时用 `404.html`。

本地预览：

```bash
npx wrangler dev
```

脚本用经典全局加载，顺序是 `registry.js`、`common.js`、`shell.js`、本页脚本。没有模块打包。

## 7. 占位数据与后续 API

页面脚本不发请求。每个文件顶部的 `mock` 注释写了打算接的路径。接入时用同一批字段替换数组，保留 `HiveCommon` 的渲染，这样卡片结构不用重画。

已实现：

```http
GET /api/health
```

```json
{ "ok": true, "service": "hivemos" }
```

尾部斜杠会先去掉再匹配。建议以后的错误体为 `{ "ok": false, "error": "给人看的短句" }`，页面把它放进 `.callout.danger`，不要使用浏览器弹窗。

计划中的只读接口与脚本里的字段对应。时间在骨架里是写死的 `YYYY-MM-DD HH:mm`，接上接口后仍用绝对时间到分钟。

| 方法与路径 | 替换 | 主要字段 |
| --- | --- | --- |
| `GET /api/overview` | `index.js` | `stats[]`（label、value、hint）、`activity[]`（time、text）、`alerts[]` |
| `GET /api/agents` | `agents.js` 与 `shell.js` 的侧栏 | `id` `name` `status` `role` `model` `machine` `seen` |
| `GET /api/machines` | `machines.js` | `id` `name` `status` `region` `agent` `heartbeat` |
| `GET /api/memories` | `memory.js` | `id` `title` `scope` `source` `updated` `excerpt` |
| `GET /api/souls` | `soul.js` | `id` `agent` `version` `status` `updated` |
| `GET /api/skills` | `skills.js` | `id` `name` `version` `source` `used` `status` |
| `GET /api/tasks` | `tasks.js` | `id` `title` `from` `to` `status` `updated` |
| `GET /api/mcp` | `mcp.js` 与设置里的服务列表 | `id` `name` `transport` `tools` `status` `endpoint` |
| `GET /api/vault` | `vault.js` | `id` `name` `kind` `tail` `updated`。响应里禁止出现完整密钥 |
| `GET /api/settings` | `settings.js` | `workspace`、`mcp.endpoint`、`mcp.tokenTail`、`devices[]`（`name` `platform` `seen` `tail` `status`） |
| `POST /api/session` | `login.js` | 本期不实现。接通前提交必须继续被拦住 |

脱敏约定：

- 前端源码只保存 `tail`（恰好 4 个字符）。`HiveCommon.maskTail` 渲染成 `•••• ` 加这四位。
- 列表、设置、复制按钮三条路径都走这个函数。复制结果等于屏幕上的脱敏串，不是还原后的密钥。
- 接口即使将来持有完整值，列表响应也只给 `tail`。详情若必须展示完整值，要单独的显式操作，不能当成列表的默认字段。这一阶段没有这条路径。

空数组要走已经写好的空态，而不是留一块空白。各页「待接入 / 已释放 / 冲突 / 草稿 / 待审核 / 失败队列 / 待批准 / 回收站」就是这些空态的落点。

## 8. 文案规范

界面语言是简体中文。术语 Agent、Soul、Skills、MCP、API Key、Token 保留英文，不另造译名。

面向界面和 README 里对使用者说的句子：最后一句的最后一个字后面不加句号。前面的句子保留句号。例如保险库导语是「密钥与令牌只显示末四位。完整值不进入页面」。按钮用动词或名词，不加句号，例如「登录」「复制」「复制末四位」。

空态先说现状，再说以后这里会出现什么，不写致歉，也不用感叹号。

架构文档本身使用常规标点，不受上面这条界面规则约束。

不要用颜色单独传递状态，状态点旁边始终有文字。时间写到分钟。数字和标识用等宽字体，方便对齐和复制。

## 9. AI 预留原则

- 全局原则：系统内部的 AI 支持是地基、不是插件。每个功能在设计之初就要考虑使用 Workers AI，数据模型与流程都要为 AI 预留位置
- 数据模型预留：标签区分来源（human 与 ai 并存、人工优先）、简介 summary、AI 处理状态、内容哈希、embedding 预留列。第一版功能可以先不跑 AI，但字段不能后补
- AI 只提案、不直接改权威数据：自动打标、记忆整理、soul 一致性检查、事件打标等产出均为建议，人工确认后才生效；已有人工内容时 AI 只补空缺
- 统一模型变量 AI_MODEL 管理模型编号（未配时用默认模型），换模型只改变量不改代码；AI 结果按内容哈希缓存，内容不变不重复调用
- AI 不可用或失败时功能照常运行：只记处理状态，绝不阻塞任何增删改查
- 已留位的功能：MCP 条目自动打标与一句话简介（注册表已按此实现）、记忆条目提取与整理提案、Skills 自动分类与查重、任务派单建议与交接摘要、日历导入去重与事件打标

## 10. 日历板块设计预留（占位，未实现）

- 定位：日历聚合中枢。agent 可经面板 MCP 增删改查日程，用户可用手机与电脑同步。本节只是设计预留，功能本体不在本期实现；/calendar.html 是静态占位页（月视图示意 + 空状态 + 开发中说明，数据均为 mock）
- 数据模型按 iCalendar 语义设计：calendars 与 events 两张表。events 关键字段：UID、起止时间（UTC 存储并保留原时区）、RRULE 重复规则、all_day、source（来源：manual、mcp、ics_import、ics_feed、caldav、google、outlook）、created_by（用户或哪个 agent）、etag 与同步令牌、软删除墓碑（deleted_at 不真删），另设操作审计表 calendar_audit
- 接口分期：
  - 一期：面板 MCP 工具 calendar_*（list_calendars、list_events、create_event、update_event、delete_event、search_events）；ICS 订阅源输出（带可撤销令牌的签名 URL，每台设备一条，可在设置里吊销）；ICS 文件导入；外部 ICS 链接拉取聚合（Cron 定时刷新、只读镜像）
  - 二期：CalDAV 双向同步；iPhone 原生日历可直接订阅 ICS，或走 CalDAV 接入
  - 三期：Google 与 Outlook 的 OAuth 同步
- AI 预留：导入去重、事件自动打标、冲突提示、每日简报摘要，产出均为提案、人工确认后生效
