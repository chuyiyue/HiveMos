/* 总览：第一页是真数据，GET /api/overview（各模块计数、最近动态、告警）；第二页「调用记录」也是真数据，GET /api/mcp-audit（agent 取用 MCP 配置的审计） */
(function () {
  var C = window.HiveCommon;

  C.mount(
    C.layout(
      "",
      "<div class=\"page-tabs\" role=\"tablist\">" +
        "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"overview\" aria-selected=\"true\">总览</button>" +
        "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"calls\" aria-selected=\"false\">调用记录</button>" +
        "</div>" +
        "<div data-panel=\"overview\">" +
        C.section("最近动态", "", C.emptyState("正在读取", "稍等片刻")) +
        "</div>" +
        "<div data-panel=\"calls\" hidden>" +
        C.section("调用记录", "", C.emptyState("正在读取", "稍等片刻")) +
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
  activate(location.hash === "#calls" ? "calls" : "overview");

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
        C.section("最近动态", "", activity.length ? feedList(activity) : C.emptyState("还没有动态", "各模块的操作会汇总到这里")) +
        C.section("告警", "", alerts.length ? alertList(alerts) : C.emptyState("还没有告警", "运行中的异常会列在这里")) +
        statCards(data.stats) +
        "</div>";
      renderOverview(html);
    })
    .catch(function () {
      renderOverview(C.section("总览", "", C.emptyState("读取失败", "总览数据暂时读不到，刷新页面再试")));
    });

  // ---- 调用记录页签：真数据（原有逻辑，不动） ----

  function renderCalls(html) {
    var panel = document.querySelector("[data-panel=\"calls\"]");
    if (panel) panel.innerHTML = html;
  }
  fetch("/api/mcp-audit", { headers: { accept: "application/json" }, cache: "no-store" })
    .then(function (response) { return response.json(); })
    .then(function (data) {
      var audit = data && data.ok === true && Array.isArray(data.audit) ? data.audit : [];
      if (!audit.length) {
        renderCalls(C.section("调用记录", "", C.emptyState("还没有调用记录", "Agent 通过 mcp_get 取用 MCP 配置后，每一次都会留在这里")));
        return;
      }
      var cards = audit.map(function (item) {
        return C.record({
          id: item.id,
          title: item.agent_name || "未知 Agent",
          lede: "取用「" + (item.server_name || item.server_id || "未知") + "」的配置",
          facts: [["时间", C.escapeHtml(C.formatMinute(item.created_at) || "未知时间")]],
        });
      }).join("");
      renderCalls(C.section("调用记录", String(audit.length) + " 条", C.list(cards)));
    })
    .catch(function () {
      renderCalls(C.section("调用记录", "", C.emptyState("读取失败", "调用记录暂时读不到，刷新页面再试")));
    });
})();
