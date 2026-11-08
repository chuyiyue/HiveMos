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

  var ALERT_TONES = {
    calendar_sync: { tone: "danger", icon: "calendar", href: "tasks-calendar.html#calendar" },
    task_stale: { tone: "warn", icon: "tasks", href: "tasks-calendar.html#tasks" },
    agent_disabled: { tone: "info", icon: "bot", href: "agents.html" },
  };
  var ALERT_ORDER = { danger: 0, warn: 1, info: 2 };
  function alertList(alerts) {
    var sorted = alerts.slice().sort(function (a, b) {
      var ta = ALERT_TONES[a.kind] ? ALERT_ORDER[ALERT_TONES[a.kind].tone] : 3;
      var tb = ALERT_TONES[b.kind] ? ALERT_ORDER[ALERT_TONES[b.kind].tone] : 3;
      return ta - tb;
    });
    return (
      '<div class="alert-list">' +
      sorted
        .map(function (item) {
          var meta = ALERT_TONES[item.kind] || { tone: "info", icon: "bot", href: "" };
          var time = item.at
            ? '<time datetime="' + C.escapeHtml(new Date(item.at).toISOString()) + '">' + C.escapeHtml(feedTime(item.at)) + "</time>"
            : "";
          var inner =
            '<span class="alert-icon tone-' + meta.tone + '">' + C.iconSvg(meta.icon) + "</span>" +
            '<span class="alert-main"><span class="alert-text">' + C.escapeHtml(item.text) + "</span>" + time + "</span>";
          return meta.href
            ? '<a class="alert-row tone-' + meta.tone + '" href="' + meta.href + '">' + inner + "</a>"
            : '<div class="alert-row tone-' + meta.tone + '">' + inner + "</div>";
        })
        .join("") +
      "</div>"
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
        C.section("告警", alerts.length ? alerts.length + " 条" : "", alerts.length ? alertList(alerts) : C.emptyState("还没有告警", "运行中的异常会列在这里")) +
        "</div>" +
        statCards(data.stats) +
        "</div>";
      renderOverview(html);
    })
    .catch(function () {
      renderOverview(C.section("总览", "", C.emptyState("读取失败", "总览数据暂时读不到，刷新页面再试")));
    });

  // ---- 日志面板共用实现：调用记录与系统日志共用同一套筛选、列表与
  // 分页逻辑，改一处两页同时生效；两页的差异只在各自的配置里
  // （板块清单、接口与参数、行文案、空态文案）。

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

  function createLogPanel(cfg) {
    var state = {
      filter: "all",
      page: 1,
      pageSize: storedPageSize(cfg.sizeKey),
      total: null,
      hasMore: false,
      items: [],
      loading: false,
      failed: false,
      started: false,
    };
    function panel() {
      return document.querySelector('[data-panel="' + cfg.panel + '"]');
    }
    function chipsHtml() {
      return (
        '<div class="tag-row" role="group" aria-label="按板块筛选">' +
        cfg.chips
          .map(function (item) {
            var selected = state.filter === item[0];
            return (
              '<button type="button" class="tag' +
              (selected ? " is-accent" : "") +
              '" data-log-filter="' +
              item[0] +
              '" aria-pressed="' +
              (selected ? "true" : "false") +
              '">' +
              C.escapeHtml(item[1]) +
              "</button>"
            );
          })
          .join("") +
        "</div>"
      );
    }
    function feedHtml(items) {
      return (
        '<ol class="feed">' +
        items
          .map(function (item) {
            var row = cfg.row(item);
            return (
              '<li><time datetime="' +
              C.escapeHtml(new Date(item.at).toISOString()) +
              '">' +
              C.escapeHtml(feedTime(item.at)) +
              '</time><span><span class="tag">' +
              C.escapeHtml(row.tag) +
              "</span> " +
              C.escapeHtml(row.text) +
              "</span></li>"
            );
          })
          .join("") +
        "</ol>"
      );
    }
    function render() {
      var el = panel();
      if (!el) return;
      var body;
      if (state.failed && !state.items.length) {
        body = C.emptyState("读取失败", cfg.failText);
      } else if (!state.started || (state.loading && !state.items.length)) {
        body = C.emptyState("正在读取", "稍等片刻");
      } else if (!state.items.length) {
        body = C.emptyState(cfg.emptyTitle, cfg.emptyText);
      } else {
        body = feedHtml(state.items) + pagerHtml(cfg.panel, state);
      }
      var sub = state.started && state.total != null ? "共 " + state.total + " 条" : "";
      el.innerHTML = C.section(cfg.title, sub, chipsHtml() + body);
    }
    function load() {
      if (state.loading) return;
      state.loading = true;
      state.failed = false;
      render();
      var query =
        cfg.endpoint +
        "?limit=" +
        state.pageSize +
        "&offset=" +
        (state.page - 1) * state.pageSize +
        (state.filter !== "all" ? "&" + cfg.filterParam + "=" + encodeURIComponent(state.filter) : "");
      fetch(query, { headers: { accept: "application/json" }, cache: "no-store" })
        .then(function (response) {
          return response.json();
        })
        .then(function (data) {
          state.loading = false;
          state.started = true;
          if (!data || data.ok !== true || !Array.isArray(data[cfg.listKey])) throw new Error("bad log");
          state.items = data[cfg.listKey];
          state.total = typeof data.total === "number" ? data.total : null;
          state.hasMore = data.has_more === true;
          var pages = pagerPages(state);
          if (pages != null && state.page > pages) {
            state.page = pages;
            load();
            return;
          }
          render();
        })
        .catch(function () {
          state.loading = false;
          state.started = true;
          state.failed = true;
          render();
        });
    }
    var el = panel();
    if (el) {
      el.addEventListener("click", function (event) {
        var target = event.target;
        if (!(target instanceof Element)) return;
        var chip = target.closest("[data-log-filter]");
        if (chip) {
          var key = chip.getAttribute("data-log-filter") || "all";
          if (key !== state.filter || state.failed) {
            state.filter = key;
            state.page = 1;
            load();
          }
          return;
        }
        var prev = target.closest("[data-pager-prev]");
        if (prev && !prev.disabled) {
          state.page -= 1;
          load();
          return;
        }
        var next = target.closest("[data-pager-next]");
        if (next && !next.disabled) {
          state.page += 1;
          load();
          return;
        }
      });
      el.addEventListener("change", function (event) {
        var sel = event.target;
        if (!(sel instanceof Element) || !sel.hasAttribute("data-pager-size")) return;
        var n = parseInt(sel.value, 10);
        if (n === 20 || n === 50 || n === 100) {
          state.pageSize = n;
          window.localStorage.setItem(cfg.sizeKey, String(n));
          state.page = 1;
          load();
        }
      });
    }
    render();
    load();
    return { state: state, load: load, render: render };
  }

  // ---- 调用记录：只看 Agent 经 MCP 的调用（GET /api/records） ----

  createLogPanel({
    panel: "calls",
    title: "调用记录",
    endpoint: "/api/records",
    filterParam: "module",
    listKey: "records",
    sizeKey: "hivemos-records-size",
    chips: [
      ["all", "全部"],
      ["mcp", "MCP 与 Skills"],
      ["calendar", "日历"],
      ["tasks", "任务"],
      ["memory", "记忆"],
      ["soul", "Soul"],
      ["machines", "云计算资源"],
    ],
    row: function (item) {
      return { tag: item.module_label, text: item.actor + " " + item.text };
    },
    emptyTitle: "还没有记录",
    emptyText: "Agent 通过 MCP 的调用会汇总到这里",
    failText: "记录暂时读不到，点任意板块或刷新页面再试",
  });

  // ---- 系统日志：管理员在面板里的操作记录（GET /api/oplog） ----

  createLogPanel({
    panel: "oplog",
    title: "系统日志",
    endpoint: "/api/oplog",
    filterParam: "board",
    listKey: "entries",
    sizeKey: "hivemos-oplog-size",
    chips: [
      ["all", "全部"],
      ["agents", "Agents 与应用"],
      ["mcp-skills", "MCP 与 Skills"],
      ["machines", "云计算资源"],
      ["memory-soul", "记忆与 Soul"],
      ["tasks-calendar", "任务与日历"],
      ["vault", "保险库"],
      ["settings", "设置"],
      ["groups", "分组"],
    ],
    row: function (item) {
      return { tag: item.module, text: item.action + " " + item.text };
    },
    emptyTitle: "还没有日志",
    emptyText: "你在面板里的操作会记录到这里",
    failText: "日志暂时读不到，点任意板块或刷新页面再试",
  });
})();
