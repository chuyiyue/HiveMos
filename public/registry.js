// Single source of truth for primary modules.
// shell.js renders the sidebar from this list. Each page still loads its own
// script tag; the script field is the view file reserved for a later in-shell
// switch. Field meanings:
//   key    stable id, also the nav item's data-nav-key
//   title  sidebar label
//   href   canonical path
//   icon   symbol id in /icons.svg
//   script view file for this href
//   nav    set false to keep a module routable but out of the sidebar
window.HIVEMOS_MODULES = Object.freeze([
  Object.freeze({ key: "overview", title: "总览", href: "/", icon: "icon-layout", script: "/index.js" }),
  Object.freeze({ key: "agents", title: "Agents", href: "/agents.html", icon: "icon-bot", script: "/agents.js" }),
  Object.freeze({ key: "machines", title: "云计算资源", href: "/machines.html", icon: "icon-monitor", script: "/machines.js" }),
  Object.freeze({ key: "memory-soul", title: "记忆与 Soul", href: "/memory-soul.html", icon: "icon-memory", script: "/memory-soul.js" }),
  Object.freeze({ key: "mcp-skills", title: "MCP 与 Skills", href: "/mcp-skills.html", icon: "icon-plug", script: "/mcp-skills.js" }),
  Object.freeze({ key: "tasks-calendar", title: "任务与日历", href: "/tasks-calendar.html", icon: "icon-tasks", script: "/tasks-calendar.js" }),
  Object.freeze({ key: "vault", title: "保险库", href: "/vault.html", icon: "icon-lock", script: "/vault.js" }),
  Object.freeze({ key: "settings", title: "设置", href: "/settings.html", icon: "icon-settings", script: "/settings.js", nav: false }),
  Object.freeze({ key: "login", title: "登录", href: "/login.html", icon: "icon-log-in", script: "/login.js", nav: false }),
]);
