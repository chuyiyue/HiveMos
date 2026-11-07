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
  Object.freeze({ key: "agents", title: "Agent", href: "/agents.html", icon: "icon-bot", script: "/agents.js" }),
  Object.freeze({ key: "machines", title: "云电脑", href: "/machines.html", icon: "icon-monitor", script: "/machines.js" }),
  Object.freeze({ key: "memory", title: "记忆", href: "/memory.html", icon: "icon-memory", script: "/memory.js" }),
  Object.freeze({ key: "soul", title: "Soul", href: "/soul.html", icon: "icon-soul", script: "/soul.js" }),
  Object.freeze({ key: "skills", title: "Skills", href: "/skills.html", icon: "icon-puzzle", script: "/skills.js" }),
  Object.freeze({ key: "tasks", title: "任务", href: "/tasks.html", icon: "icon-tasks", script: "/tasks.js" }),
  Object.freeze({ key: "calendar", title: "日历", href: "/calendar.html", icon: "icon-calendar", script: "/calendar.js" }),
  Object.freeze({ key: "mcp", title: "MCP", href: "/mcp.html", icon: "icon-plug", script: "/mcp.js" }),
  Object.freeze({ key: "vault", title: "保险库", href: "/vault.html", icon: "icon-lock", script: "/vault.js" }),
  Object.freeze({ key: "settings", title: "设置", href: "/settings.html", icon: "icon-settings", script: "/settings.js" }),
  Object.freeze({ key: "login", title: "登录", href: "/login.html", icon: "icon-log-in", script: "/login.js" }),
]);
