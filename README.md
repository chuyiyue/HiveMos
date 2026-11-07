# hivemos
HiveMOS — Multi-agent Operating System for agents: panel, memory, soul, skills, vault and config sync on Cloudflare Workers

## 项目简介

HiveMos 是多 Agent 的控制面，整站运行在 Cloudflare Workers 上。第一阶段只交付 UI 架构和静态前端骨架：总览、Agent、云电脑、记忆、Soul、Skills、任务、MCP、保险库、设置和登录都已就位，页面数据是写死的占位

界面沿用 SMSinBox 的多页外壳（侧栏、顶栏、注册表驱动的导航），配色换成 Claude 官网的暖象牙与陶土橙。业务接口、数据库和登录会话都不在这一阶段

## UI 架构

设计原则、配色 token、断点、逐页区块和后续 API 约定见 [docs/UI_ARCHITECTURE.md](docs/UI_ARCHITECTURE.md)

## 本地预览

```bash
npx wrangler dev
```

浏览器打开命令输出的本地地址。`GET /api/health` 返回 `{"ok":true,"service":"hivemos"}`，其余路径由 `public/` 静态资源响应
