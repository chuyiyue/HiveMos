// Dynamic shell features: the Agent rail, the mobile drawer, and the theme
// cycle. The static chrome (registry nav, collapse button, persisted sidebar
// state) is painted before the first frame by sidebar-boot.js; when its flag
// is present the chrome init below is skipped so nothing is rendered twice.
// Page bodies are rendered by each page's own script.
(function () {
  var THEME_KEY = "hivemos-theme";
  var SIDEBAR_KEY = "hivemos-sidebar";
  var THEME_CYCLE = ["system", "light", "dark"];
  var THEME_LABEL = {
    system: "主题：跟随系统",
    light: "主题：浅色",
    dark: "主题：深色",
  };
  var THEME_ICON = {
    system: "icon-monitor",
    light: "icon-sun",
    dark: "icon-moon",
  };

  // Pin 栏数据由服务端组装（GET /api/sidebar/agents）：固定在前、最近
  // 活动填充其后，这里只负责渲染。拉不到时整区隐藏，不挡其他功能。
  var sidebarAgents = [];

  // A page held open across a deployment can keep running old script in a
  // mobile WebView. Remember the server build in this tab; when a later
  // check sees it move, refresh once so the page picks up matching assets.
  var BUILD_KEY = "hm_build";
  var BUILD_RELOADS_KEY = "hm_build_reloads";
  var BUILD_RELOAD_WINDOW_MS = 10 * 60 * 1000;
  var buildCheckInFlight = false;
  var buildReloading = false;

  function buildStorageGet(key) {
    try {
      return window.sessionStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function buildStorageSet(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch (error) {
      // Storage can be unavailable in restricted WebViews; checks stay inert.
    }
  }

  function recentBuildReloads(now) {
    var parsed;
    try {
      parsed = JSON.parse(buildStorageGet(BUILD_RELOADS_KEY) || "[]");
    } catch (error) {
      parsed = [];
    }
    if (!Array.isArray(parsed)) parsed = [];
    return parsed.filter(function (time) {
      return Number.isFinite(time) && now - time >= 0 && now - time < BUILD_RELOAD_WINDOW_MS;
    });
  }

  function checkBuild() {
    if (buildCheckInFlight || buildReloading || typeof window.fetch !== "function") return;
    buildCheckInFlight = true;
    window
      .fetch("/api/version", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      })
      .then(function (response) {
        if (!response.ok) throw new Error("version check failed");
        return response.json();
      })
      .then(function (data) {
        var build = data && typeof data.build === "string" ? data.build : "";
        if (!build || build === "dev") return;
        var known = buildStorageGet(BUILD_KEY);
        if (!known) {
          buildStorageSet(BUILD_KEY, build);
          return;
        }
        if (known === build) return;
        var now = Date.now();
        var reloads = recentBuildReloads(now);
        buildStorageSet(BUILD_RELOADS_KEY, JSON.stringify(reloads));
        if (reloads.length >= 2) return;
        reloads.push(now);
        buildStorageSet(BUILD_RELOADS_KEY, JSON.stringify(reloads));
        buildStorageSet(BUILD_KEY, build);
        buildReloading = true;
        window.location.reload();
      })
      .catch(function () {
        // A failed check says nothing about the deployment; try a later one.
      })
      .finally(function () {
        buildCheckInFlight = false;
      });
  }

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) checkBuild();
  });
  window.addEventListener("pageshow", checkBuild);
  checkBuild();

  function canonicalPath(pathname) {
    var path = pathname || "/";
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    if (path === "/index.html" || path === "/index") return "/";
    if (path.endsWith(".html")) path = path.slice(0, -5);
    return path || "/";
  }

  function iconRef(id) {
    return "/icons.svg#" + id;
  }

  function svgIcon(id) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    var ref = iconRef(id);
    use.setAttribute("href", ref);
    use.setAttributeNS("http://www.w3.org/1999/xlink", "href", ref);
    svg.append(use);
    return svg;
  }

  function renderNav() {
    var nav = document.querySelector(".sidebar-nav");
    if (!nav) return;
    var active = canonicalPath(location.pathname);
    var items = window.HIVEMOS_MODULES || [];
    nav.replaceChildren();
    items.forEach(function (item) {
      if (item.nav === false) return;
      var icon = /^icon-[a-z0-9-]+$/.test(item.icon || "") ? item.icon : "icon-layout";
      var link = document.createElement("a");
      link.href = item.href;
      link.setAttribute("data-nav-key", item.key || "");
      link.title = item.title;
      if (canonicalPath(item.href) === active) {
        link.classList.add("active");
        link.setAttribute("aria-current", "page");
      }
      var label = document.createElement("span");
      label.className = "nav-label";
      label.textContent = item.title;
      link.append(svgIcon(icon), label);
      nav.append(link);
    });
  }

  function fullSeenText(value) {
    var time = Number(value);
    if (!Number.isFinite(time) || time <= 0) return "还没有调用记录";
    var formatted = window.HiveCommon ? window.HiveCommon.formatMinute(time) : "";
    return "上次调用 " + (formatted || new Date(time).toLocaleString());
  }

  function relativeSeenText(value) {
    var time = Number(value);
    if (!Number.isFinite(time) || time <= 0) return "还没有调用记录";
    var diff = Date.now() - time;
    if (diff < 60 * 1000) return "刚刚调用";
    if (diff < 60 * 60 * 1000) return Math.floor(diff / (60 * 1000)) + " 分钟前调用";
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / (60 * 60 * 1000)) + " 小时前调用";
    if (diff < 30 * 24 * 60 * 60 * 1000) return Math.floor(diff / (24 * 60 * 60 * 1000)) + " 天前调用";
    return fullSeenText(time);
  }

  function renderAgents() {
    var box = document.getElementById("sidebar-agents");
    if (!box) return;
    var section = box.closest(".sidebar-devices");
    if (section) section.hidden = sidebarAgents.length === 0;
    box.replaceChildren();
    var activeHash = location.hash || "";
    sidebarAgents.forEach(function (agent) {
      var meta = window.HiveCommon ? window.HiveCommon.statusMeta(agent.status) : ["idle", agent.status];
      var item = document.createElement("div");
      item.className = "device-item";
      var link = document.createElement("a");
      link.className = "device-link";
      link.href = "/agents.html#" + encodeURIComponent(agent.id);
      link.title = fullSeenText(agent.last_seen_at);
      if (activeHash === "#" + agent.id) link.classList.add("is-active");
      var dot = document.createElement("span");
      dot.className = "ui-status-dot";
      dot.setAttribute("data-status", meta[0]);
      var name = document.createElement("span");
      name.className = "device-name";
      name.textContent = agent.name;
      var state = document.createElement("span");
      state.className = "device-state";
      state.textContent = relativeSeenText(agent.last_seen_at);
      var avatarNode;
      if (agent.has_custom_avatar || agent.avatar_url) {
        avatarNode = document.createElement("img");
        avatarNode.className = "icon agent-avatar-img";
        avatarNode.src = agent.has_custom_avatar
          ? "/api/agents/" + encodeURIComponent(agent.id) + "/avatar"
          : agent.avatar_url;
        avatarNode.alt = "";
        avatarNode.style.borderRadius = "26%";
        avatarNode.style.objectFit = "cover";
      } else if (agent.avatar_icon) {
        avatarNode = svgIcon("avatar-" + agent.avatar_icon);
      } else {
        avatarNode = svgIcon("icon-bot");
      }
      link.append(dot, avatarNode, name, state);
      link.addEventListener("click", function (event) {
        event.preventDefault();
        var common = window.HiveCommon;
        if (common && typeof common.openAgentManage === "function") {
          common.openAgentManage(agent.id, {
            panel: true,
            agent: {
              id: agent.id,
              name: agent.name,
              status: agent.status,
              last_seen_at: agent.last_seen_at,
              pinned_at: agent.pinned ? agent.last_seen_at || 1 : null,
              avatar_icon: agent.avatar_icon || null,
              avatar_url: agent.avatar_url || null,
              has_custom_avatar: !!agent.has_custom_avatar,
            },
            onChanged: function () {
              loadSidebarAgents();
            },
          });
        }
      });
      item.append(link);
      if (agent.pinned) {
        var unpin = document.createElement("button");
        unpin.type = "button";
        unpin.className = "device-unpin";
        unpin.title = "取消固定";
        unpin.setAttribute("aria-label", "取消固定 " + agent.name);
        unpin.append(svgIcon("icon-pin"));
        unpin.addEventListener("click", function () {
          unpin.disabled = true;
          fetch("/api/agents/" + encodeURIComponent(agent.id), {
            method: "PATCH",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ pinned: false }),
          })
            .then(function (response) {
              if (!response.ok) throw new Error("unpin failed");
              loadSidebarAgents();
            })
            .catch(function () {
              unpin.disabled = false;
            });
        });
        item.append(unpin);
      }
      box.append(item);
    });
  }

  function loadSidebarAgents() {
    fetch("/api/sidebar/agents", { headers: { accept: "application/json" }, cache: "no-store" })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (data) {
        if (!data || data.ok !== true || !Array.isArray(data.agents)) return;
        sidebarAgents = data.agents;
        renderAgents();
      })
      .catch(function () {
        // 侧栏拿不到数据时保持隐藏，不影响页面主体
      });
  }

  function readCollapsed() {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "collapsed";
    } catch (error) {
      return false;
    }
  }

  function applySidebarState(collapsed, persist) {
    document.documentElement.setAttribute("data-sidebar", collapsed ? "collapsed" : "expanded");
    if (persist) {
      try {
        localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded");
      } catch (error) {
        // 无存储时只在这次浏览里收起
      }
    }
    var button = document.querySelector(".sidebar-collapse");
    if (!button) return;
    var label = collapsed ? "展开侧栏" : "收起侧栏";
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }

  function injectCollapseButton() {
    var button = document.querySelector(".sidebar-collapse");
    if (button) {
      // Static markup already carries the button; bind it if nobody has.
      if (button.dataset.bound === "1") return;
      button.dataset.bound = "1";
      button.addEventListener("click", function () {
        var collapsed = document.documentElement.getAttribute("data-sidebar") === "collapsed";
        applySidebarState(!collapsed, true);
      });
      applySidebarState(document.documentElement.getAttribute("data-sidebar") === "collapsed", false);
      return;
    }
    var brand = document.querySelector(".sidebar > .brand");
    if (!brand) return;
    button = document.createElement("button");
    button.type = "button";
    button.className = "sidebar-collapse ghost icon-btn";
    button.dataset.bound = "1";
    button.append(svgIcon("icon-chevron-left"));
    button.addEventListener("click", function () {
      var collapsed = document.documentElement.getAttribute("data-sidebar") === "collapsed";
      applySidebarState(!collapsed, true);
    });
    var row = document.createElement("div");
    row.className = "sidebar-brand-row";
    brand.parentNode.insertBefore(row, brand);
    row.append(brand, button);
    applySidebarState(document.documentElement.getAttribute("data-sidebar") === "collapsed", false);
  }

  function markAccount() {
    var button = document.querySelector(".account-btn");
    if (!button) return;
    var on = canonicalPath(location.pathname) === "/settings";
    button.classList.toggle("active", on);
    if (on) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }

  function alignDrawer() {
    var sidebar = document.getElementById("sidebar");
    if (!sidebar) return;
    var vv = window.visualViewport;
    var mobile = window.matchMedia("(max-width: 639px)").matches;
    if (vv && mobile && sidebar.classList.contains("is-open")) {
      sidebar.style.top = vv.offsetTop + "px";
      sidebar.style.height = vv.height + "px";
    } else {
      sidebar.style.top = "";
      sidebar.style.height = "";
    }
  }

  function closeSidebar() {
    var sidebar = document.getElementById("sidebar");
    if (sidebar) sidebar.classList.remove("is-open");
    alignDrawer();
    var backdrop = document.getElementById("sidebar-backdrop");
    if (backdrop) backdrop.hidden = true;
    var menu = document.getElementById("menu-toggle");
    if (menu) menu.setAttribute("aria-expanded", "false");
    document.body.classList.remove("nav-open");
  }

  function openSidebar() {
    var sidebar = document.getElementById("sidebar");
    if (sidebar) sidebar.classList.add("is-open");
    var backdrop = document.getElementById("sidebar-backdrop");
    if (backdrop) backdrop.hidden = false;
    var menu = document.getElementById("menu-toggle");
    if (menu) menu.setAttribute("aria-expanded", "true");
    document.body.classList.add("nav-open");
    alignDrawer();
  }

  function bindDrawer() {
    var menu = document.getElementById("menu-toggle");
    var backdrop = document.getElementById("sidebar-backdrop");
    if (menu) {
      menu.addEventListener("click", function () {
        var sidebar = document.getElementById("sidebar");
        if (sidebar && sidebar.classList.contains("is-open")) closeSidebar();
        else openSidebar();
      });
    }
    if (backdrop) backdrop.addEventListener("click", closeSidebar);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", alignDrawer);
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeSidebar();
    });
  }

  function applyTheme(theme, persist) {
    var next = THEME_CYCLE.indexOf(theme) === -1 ? "system" : theme;
    document.documentElement.setAttribute("data-theme", next);
    if (persist) {
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch (error) {
        // 无存储时只在这次浏览里换主题
      }
    }
    var button = document.querySelector("[data-theme-toggle]");
    if (!button) return;
    var label = THEME_LABEL[next];
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    var text = button.querySelector(".btn-label");
    if (text) text.textContent = label;
    var use = button.querySelector("use");
    if (use) {
      var ref = iconRef(THEME_ICON[next]);
      use.setAttribute("href", ref);
      use.setAttributeNS("http://www.w3.org/1999/xlink", "href", ref);
    }
  }

  function bindTheme() {
    var button = document.querySelector("[data-theme-toggle]");
    applyTheme(document.documentElement.getAttribute("data-theme") || "system", false);
    if (!button) return;
    button.addEventListener("click", function () {
      var now = document.documentElement.getAttribute("data-theme") || "system";
      var index = THEME_CYCLE.indexOf(now);
      applyTheme(THEME_CYCLE[(index + 1) % THEME_CYCLE.length], true);
    });
  }

  function initialOf(name) {
    var value = String(name || "").trim();
    if (!value) return "管";
    return Array.from(value)[0].toUpperCase();
  }

  function showLoggedIn(username) {
    var nameEl = document.querySelector(".account-name");
    var avatar = document.querySelector(".account-avatar");
    var accountBtn = document.querySelector(".account-btn");
    var action = document.querySelector(".account-logout");
    if (nameEl) nameEl.textContent = username;
    if (avatar) avatar.textContent = initialOf(username);
    if (accountBtn) {
      var title = username + " · 设置";
      accountBtn.title = title;
      accountBtn.setAttribute("aria-label", title);
    }
    if (!action || action.tagName === "BUTTON") return;
    var button = document.createElement("button");
    button.type = "button";
    button.className = "account-logout ghost";
    button.title = "退出登录";
    button.setAttribute("aria-label", "退出登录");
    var icon = action.querySelector("svg");
    if (icon) button.append(icon.cloneNode(true));
    button.addEventListener("click", function () {
      if (button.disabled) return;
      button.disabled = true;
      var common = window.HiveCommon;
      if (!common || typeof common.logout !== "function") {
        location.assign("/login.html");
        return;
      }
      common.logout().catch(function () {
        button.disabled = false;
        button.title = "退出失败，请重试";
      });
    });
    action.replaceWith(button);
  }

  function paintAccount() {
    var common = window.HiveCommon;
    if (!common || typeof common.currentUser !== "function") return;
    common.currentUser().then(function (username) {
      if (!username) return;
      showLoggedIn(username);
    });
  }

  window.addEventListener("hivemos:sidebar-refresh", loadSidebarAgents);
  var chromeDone = !!window.__HIVEMOS_SIDEBAR_BOOT__ &&
    !!document.querySelector(".sidebar-collapse[data-bound=\"1\"]");
  if (!chromeDone) {
    renderNav();
    markAccount();
    injectCollapseButton();
    applySidebarState(readCollapsed(), false);
  }
  renderAgents();
  loadSidebarAgents();
  bindDrawer();
  bindTheme();
  paintAccount();
})();
