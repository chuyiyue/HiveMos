# hivemos
HiveMOS — Multi-agent Operating System for agents: panel, memory, soul, skills, vault and config sync on Cloudflare Workers

## 项目简介

HiveMos 是多 Agent 的控制面，整站运行在 Cloudflare Workers 上。管理员登录和会话已经接入。MCP 注册表与 Agent 令牌也已接入，其余业务页仍是静态骨架

界面沿用 SMSinBox 的多页外壳（侧栏、顶栏、注册表驱动的导航），配色换成 Claude 官网的暖象牙与陶土橙。注册表说明见 [docs/MCP_REGISTRY.md](docs/MCP_REGISTRY.md)

## UI 架构

设计原则、配色 token、断点、逐页区块和管理员系统见 [docs/UI_ARCHITECTURE.md](docs/UI_ARCHITECTURE.md)

## 本地预览

先应用本地迁移，再启动：

```bash
npx wrangler d1 migrations apply hivemos --local
npx wrangler dev
```

浏览器打开命令输出的本地地址。未登录打开页面会转到 `/login.html`。`GET /api/health` 返回 `{"ok":true,"service":"hivemos"}`。管理员账号来自 Worker 机密 `ADMIN_USERNAME` 与 `ADMIN_PASSWORD`，未配置时登录页会说明这两项
