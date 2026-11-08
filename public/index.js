/* 总览：第一页是真数据，GET /api/overview（各模块计数、最近动态、告警）；第二页「调用记录」只看 Agent 经 MCP 的调用，GET /api/records；第三页「系统日志」是管理员在面板里的操作记录，GET /api/oplog */
(function () {
  var C = window.HiveCommon;

  C.mount(
    C.layout(
      "",
      "<div class=\"page-tabs\" role=\"tablist\">" +
        "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"overview\" aria-selected=\"true\">总览</button>" +
        "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"calls\" aria-selected=\"false\">调用记录</button>" +
        "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"oplog\" aria-selected=\"false\">系统日志</button>" +
        "</div>" +
        "<div data-panel=\"overview\">" +
        C.section("最近动态", "", C.emptyState("正在读取", "稍等片刻")) +
        "</div>" +
        "<div data-panel=\"calls\" hidden>" +
        C.section("调用记录", "", C.emptyState("正在读取", "稍等片刻")) +
        "</div>" +
        "<div data-panel=\"oplog\" hidden>" +
        C.section("系统日志", "", C.emptyState("正在读取", "稍等片刻")) +
        "</div>",
    ),
  );

  function activate(name) {
    document.querySelectorAll(".page-tab").forEach(function (btn) {
      btn.setAttribute("aria-selected", btn.getAttribute("data-tab") === name ? "true" : "false");
    });
    document.querySelectorAll("[data-panel]").forEach(function (panel) {
      panel.hidden = panel.getAttribute("data-panel") !== name;
    });
  }
  document.querySelectorAll(".page-tab").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var name = btn.getAttribute("data-tab");
      activate(name);
      history.replaceState(null, "", "#" + name);
    });
  });
  activate(location.hash === "#calls" ? "calls" : location.hash === "#oplog" ? "oplog" : "overview");

  // ---- 总览页签：真数据 ----

  function renderOverview(html) {
    var panel = document.querySelector("[data-panel=\"overview\"]");
    if (panel) panel.innerHTML = html;
  }

  function pad(number) {
    return String(number).padStart(2, "0");
  }

  function feedTime(ms) {
    var d = new Date(ms);
    var now = new Date();
    var clock = pad(d.getHours()) + ":" + pad(d.getMinutes());
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return clock;
    return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + clock;
  }

  function statCards(stats) {
    var cards = [];
    var agents = stats.agents || { total: 0, active: 0, disabled: 0 };
    cards.push(["Agent", agents.total, agents.disabled ? agents.active + " 个启用，" + agents.disabled + " 个停用" : agents.active + " 个启用"]);
    var servers = stats.mcp_servers || { total: 0, active: 0, disabled: 0 };
    cards.push(["MCP", servers.total, servers.disabled ? servers.active + " 个启用，" + servers.disabled + " 个停用" : servers.active + " 个启用"]);
    var machines = stats.machines || { total: 0, by_kind: { server: 0, cloud: 0, worker: 0 } };
    var kind = machines.by_kind || { server: 0, cloud: 0, worker: 0 };
    cards.push([
      "云主机",
      machines.total,
      machines.total ? kind.server + " 台服务器 · " + kind.cloud + " 台云主机 · " + kind.worker + " 个 Worker" : "还没有机器",
    ]);
    var tasks = stats.tasks || { total: 0, queued: 0, active: 0, done: 0 };
    cards.push(["任务", tasks.total, tasks.total ? tasks.active + " 个进行中，" + tasks.queued + " 个排队，" + tasks.done + " 个已完成" : "还没有任务"]);
    cards.push(["记忆", stats.memories || 0, stats.memories ? "跨 Agent 共享与同步" : "还没有记忆"]);
    cards.push(["Soul", stats.souls || 0, stats.souls ? "个 Agent 的人格定义" : "还没有 Soul"]);
    var calendars = stats.calendars || { total: 0, events_next_7d: 0 };
    cards.push(["日历", calendars.total, calendars.total ? "未来 7 天 " + calendars.events_next_7d + " 个日程" : "还没有日历"]);
    if (stats.vault_entries !== null && stats.vault_entries !== undefined) {
      cards.push(["保险库", stats.vault_entries, "列表只显示末四位"]);
    }
    return (
      "<div class=\"stat-grid\">" +
      cards.map(function (item) { return C.stat(item[0], item[1], item[2]); }).join("") +
      "</div>"
    );
  }

  function feedList(items) {
    return (
      "<ol class=\"feed\">" +
      items.map(function (item) {
        return (
          "<li><time datetime=\"" + C.escapeHtml(new Date(item.at).toISOString()) + "\">" +
          C.escapeHtml(feedTime(item.at)) +
          "</time><span>" +
          C.escapeHtml(item.actor + " " + item.text) +
          "</span></li>"
        );
      }).join("") +
      "</ol>"
    );
  }

  function alertList(alerts) {
    return (
      "<ol class=\"feed\">" +
      alerts.map(function (item) {
        var time = item.at
          ? "<time datetime=\"" + C.escapeHtml(new Date(item.at).toISOString()) + "\">" + C.escapeHtml(feedTime(item.at)) + "</time>"
          : "";
        return "<li>" + time + "<span>" + C.escapeHtml(item.text) + "</span></li>";
      }).join("") +
      "</ol>"
    );
  }

  fetch("/api/overview", { headers: { accept: "application/json" }, cache: "no-store" })
    .then(function (response) { return response.json(); })
    .then(function (data) {
      if (!data || data.ok !== true || !data.stats) throw new Error("bad overview");
      var activity = Array.isArray(data.activity) ? data.activity : [];
      var alerts = Array.isArray(data.alerts) ? data.alerts : [];
      var html =
        "<div class=\"stack\">" +
        '<div class="overview-split">' +
        C.section("最近动态", "", activity.length ? feedList(activity.slice(0, 10)) : C.emptyState("还没有动态", "各模块的操作会汇总到这里")) +
        C.section("告警", "", alerts.length ? alertList(alerts) : C.emptyState("还没有告警", "运行中的异常会列在这里")) +
        "</div>" +
        statCards(data.stats) +
        "</div>";
      renderOverview(html);
    })
    .catch(function () {
      renderOverview(C.section("总览", "", C.emptyState("读取失败", "总览数据暂时读不到，刷新页面再试")));
    });

  // ---- 调用记录页签：只看 Agent 经 MCP 的调用（GET /api/records） ----

  function storedPageSize(key) {
    var v = parseInt(window.localStorage.getItem(key) || "", 10);
    return v === 20 || v === 50 || v === 100 ? v : 50;
  }
  function pagerPages(state) {
    return state.total != null ? Math.max(1, Math.ceil(state.total / state.pageSize)) : null;
  }
  function pagerHtml(kind, state) {
    var pages = pagerPages(state);
    var opts = [20, 50, 100]
      .map(function (n) {
        return '<option value="' + n + '"' + (state.pageSize === n ? " selected" : "") + ">" + n + "</option>";
      })
      .join("");
    var nextOff = state.loading || (pages != null ? state.page >= pages : !state.hasMore);
    return (
      '<div class="pager">' +
      '<label class="pager-size">每页 <select data-pager-size="' + kind + '">' + opts + "</select> 条</label>" +
      '<span class="pager-info">' + (pages != null ? "第 " + state.page + " / " + pages + " 页" : "第 " + state.page + " 页") + "</span>" +
      '<span class="pager-btns">' +
      '<button type="button" class="secondary" data-pager-prev="' + kind + '"' + (state.page <= 1 || state.loading ? " disabled" : "") + ">上一页</button>" +
      '<button type="button" class="secondary" data-pager-next="' + kind + '"' + (nextOff ? " disabled" : "") + ">下一页</button>" +
      "</span></div>"
    );
  }

  var REC_MODULES = [
    ["all", "全部"],
    ["mcp", "MCP 与 Skills"],
    ["calendar", "日历"],
    ["tasks", "任务"],
    ["memory", "记忆"],
    ["soul", "Soul"],
    ["machines", "云计算资源"],
  ];
  var recState = { module: "all", page: 1, pageSize: storedPageSize("hivemos-records-size"), total: null, hasMore: false, items: [], loading: false, failed: false, started: false };

  function recPanel() {
    return document.querySelector("[data-panel=\"calls\"]");
  }

  function recChips() {
    return (
      "<div class=\"tag-row\" role=\"group\" aria-label=\"按板块筛选\">" +
      REC_MODULES.map(function (item) {
        var selected = recState.module === item[0];
        return (
          "<button type=\"button\" class=\"tag" +
          (selected ? " is-accent" : "") +
          "\" data-rec-module=\"" +
          item[0] +
          "\" aria-pressed=\"" +
          (selected ? "true" : "false") +
          "\">" +
          C.escapeHtml(item[1]) +
          "</button>"
        );
      }).join("") +
      "</div>"
    );
  }

  function recFeed(items) {
    return (
      "<ol class=\"feed\">" +
      items
        .map(function (item) {
          return (
            "<li><time datetime=\"" +
            C.escapeHtml(new Date(item.at).toISOString()) +
            "\">" +
            C.escapeHtml(feedTime(item.at)) +
            "</time><span><span class=\"tag\">" +
            C.escapeHtml(item.module_label) +
            "</span> " +
            C.escapeHtml(item.actor + " " + item.text) +
            "</span></li>"
          );
        })
        .join("") +
      "</ol>"
    );
  }

  function renderCalls() {
    var panel = recPanel();
    if (!panel) return;
    var body;
    if (recState.failed && !recState.items.length) {
      body = C.emptyState("读取失败", "记录暂时读不到，点任意板块或刷新页面再试");
    } else if (!recState.started || (recState.loading && !recState.items.length)) {
      body = C.emptyState("正在读取", "稍等片刻");
    } else if (!recState.items.length) {
      body = C.emptyState("还没有记录", "Agent 通过 MCP 的调用会汇总到这里");
    } else {
      body = recFeed(recState.items) + pagerHtml("rec", recState);
    }
    var sub = recState.started && recState.total != null ? "共 " + recState.total + " 条" : "";
    panel.innerHTML = C.section("调用记录", sub, recChips() + body);
  }

  function loadRecords() {
    if (recState.loading) return;
    recState.loading = true;
    recState.failed = false;
    renderCalls();
    var query =
      "/api/records?limit=" +
      recState.pageSize +
      "&offset=" +
      (recState.page - 1) * recState.pageSize +
      (recState.module !== "all" ? "&module=" + encodeURIComponent(recState.module) : "");
    fetch(query, { headers: { accept: "application/json" }, cache: "no-store" })
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        recState.loading = false;
        recState.started = true;
        if (!data || data.ok !== true || !Array.isArray(data.records)) throw new Error("bad records");
        recState.items = data.records;
        recState.total = typeof data.total === "number" ? data.total : null;
        recState.hasMore = data.has_more === true;
        var pages = pagerPages(recState);
        if (pages != null && recState.page > pages) {
          recState.page = pages;
          loadRecords();
          return;
        }
        renderCalls();
      })
      .catch(function () {
        recState.loading = false;
        recState.started = true;
        recState.failed = true;
        renderCalls();
      });
  }

  var callsPanel = recPanel();
  if (callsPanel) {
    callsPanel.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var chip = target.closest("[data-rec-module]");
      if (chip) {
        var key = chip.getAttribute("data-rec-module") || "all";
        if (key !== recState.module || recState.failed) {
          recState.module = key;
          recState.page = 1;
          loadRecords();
        }
        return;
      }
      var prevR = target.closest("[data-pager-prev]");
      if (prevR && !prevR.disabled) {
        recState.page -= 1;
        loadRecords();
        return;
      }
      var nextR = target.closest("[data-pager-next]");
      if (nextR && !nextR.disabled) {
        recState.page += 1;
        loadRecords();
        return;
      }
    });
  }
  if (callsPanel) {
    callsPanel.addEventListener("change", function (event) {
      var sel = event.target;
      if (!(sel instanceof Element) || !sel.hasAttribute("data-pager-size")) return;
      var n = parseInt(sel.value, 10);
      if (n === 20 || n === 50 || n === 100) {
        recState.pageSize = n;
        window.localStorage.setItem("hivemos-records-size", String(n));
        recState.page = 1;
        loadRecords();
      }
    });
  }
  renderCalls();
  loadRecords();

  // ---- 系统日志页签：管理员在面板里的操作记录（GET /api/oplog） ----

  var OP_MODULES = [
    ["all", "全部"],
    ["agents", "Agents 与应用"],
    ["mcp-skills", "MCP 与 Skills"],
    ["machines", "云计算资源"],
    ["memory-soul", "记忆与 Soul"],
    ["tasks-calendar", "任务与日历"],
    ["vault", "保险库"],
    ["settings", "设置"],
    ["groups", "分组"],
  ];
  var opState = { module: "all", page: 1, pageSize: storedPageSize("hivemos-oplog-size"), total: 0, hasMore: false, items: [], loading: false, failed: false, started: false };

  function opPanel() {
    return document.querySelector("[data-panel=\"oplog\"]");
  }

  function opChips() {
    return (
      "<div class=\"tag-row\" role=\"group\" aria-label=\"按板块筛选\">" +
      OP_MODULES.map(function (item) {
        var selected = opState.module === item[0];
        return (
          "<button type=\"button\" class=\"tag" +
          (selected ? " is-accent" : "") +
          "\" data-op-module=\"" +
          item[0] +
          "\" aria-pressed=\"" +
          (selected ? "true" : "false") +
          "\">" +
          C.escapeHtml(item[1]) +
          "</button>"
        );
      }).join("") +
      "</div>"
    );
  }

  function opFeed(items) {
    return (
      "<ol class=\"feed\">" +
      items
        .map(function (item) {
          return (
            "<li><time datetime=\"" +
            C.escapeHtml(new Date(item.at).toISOString()) +
            "\">" +
            C.escapeHtml(feedTime(item.at)) +
            "</time><span><span class=\"tag\">" +
            C.escapeHtml(item.module) +
            "</span> " +
            C.escapeHtml(item.action + " " + item.text) +
            "</span></li>"
          );
        })
        .join("") +
      "</ol>"
    );
  }

  function renderOps() {
    var panel = opPanel();
    if (!panel) return;
    var body;
    if (opState.failed && !opState.items.length) {
      body = C.emptyState("读取失败", "日志暂时读不到，点任意板块或刷新页面再试");
    } else if (!opState.started || (opState.loading && !opState.items.length)) {
      body = C.emptyState("正在读取", "稍等片刻");
    } else if (!opState.items.length) {
      body = C.emptyState("还没有日志", "你在面板里的操作会记录到这里");
    } else {
      body = opFeed(opState.items) + pagerHtml("op", opState);
    }
    var sub = opState.started ? "共 " + opState.total + " 条" : "";
    panel.innerHTML = C.section("系统日志", sub, opChips() + body);
  }

  function loadOps() {
    if (opState.loading) return;
    opState.loading = true;
    opState.failed = false;
    renderOps();
    var query =
      "/api/oplog?limit=" +
      opState.pageSize +
      "&offset=" +
      (opState.page - 1) * opState.pageSize +
      (opState.module !== "all" ? "&board=" + encodeURIComponent(opState.module) : "");
    fetch(query, { headers: { accept: "application/json" }, cache: "no-store" })
      .then(function (response) {
        return response.json();
      })
      .then(function (data) {
        opState.loading = false;
        opState.started = true;
        if (!data || data.ok !== true || !Array.isArray(data.entries)) throw new Error("bad oplog");
        opState.items = data.entries;
        opState.total = typeof data.total === "number" ? data.total : 0;
        opState.hasMore = data.has_more === true;
        var pages = pagerPages(opState);
        if (pages != null && opState.page > pages) {
          opState.page = pages;
          loadOps();
          return;
        }
        renderOps();
      })
      .catch(function () {
        opState.loading = false;
        opState.started = true;
        opState.failed = true;
        renderOps();
      });
  }

  var opsPanel = opPanel();
  if (opsPanel) {
    opsPanel.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var chip = target.closest("[data-op-module]");
      if (chip) {
        var key = chip.getAttribute("data-op-module") || "all";
        if (key !== opState.module || opState.failed) {
          opState.module = key;
          opState.page = 1;
          loadOps();
        }
        return;
      }
      var prevO = target.closest("[data-pager-prev]");
      if (prevO && !prevO.disabled) {
        opState.page -= 1;
        loadOps();
        return;
      }
      var nextO = target.closest("[data-pager-next]");
      if (nextO && !nextO.disabled) {
        opState.page += 1;
        loadOps();
        return;
      }
    });
  }
  if (opsPanel) {
    opsPanel.addEventListener("change", function (event) {
      var sel = event.target;
      if (!(sel instanceof Element) || !sel.hasAttribute("data-pager-size")) return;
      var n = parseInt(sel.value, 10);
      if (n === 20 || n === 50 || n === 100) {
        opState.pageSize = n;
        window.localStorage.setItem("hivemos-oplog-size", String(n));
        opState.page = 1;
        loadOps();
      }
    });
  }
  renderOps();
  loadOps();
})();
