/* 总览：第一页为占位统计（接入后 GET /api/overview）；第二页「调用记录」是真数据，GET /api/mcp-audit（agent 取用 MCP 配置的审计） */
(function () {
  var C = window.HiveCommon;
  var stats = [
    ["Agent", "4", "1 在线，1 个同步中，1 个离线"],
    ["云主机", "3", "2 台运行中"],
    ["任务", "2", "1 个进行中，1 个排队"],
    ["记忆", "3", "没有待合并冲突"],
    ["Soul", "3", "1 个正在同步"],
    ["保险库", "3", "列表只显示末四位"],
  ];
  var feed = [
    ["09:24", "2026-11-07T09:24", "研究写回记忆「部署约定」"],
    ["09:20", "2026-11-07T09:20", "编排把「核对云主机心跳」交给值守"],
    ["08:41", "2026-11-07T08:41", "新加坡-02 心跳恢复"],
  ];
  var statHtml =
    "<div class=\"stat-grid\">" +
    stats.map(function (item) { return C.stat(item[0], item[1], item[2]); }).join("") +
    "</div>";
  var feedHtml =
    "<ol class=\"feed\">" +
    feed.map(function (item) {
      return "<li><time datetime=\"" + C.escapeHtml(item[1]) + "\">" + C.escapeHtml(item[0]) + "</time><span>" + C.escapeHtml(item[2]) + "</span></li>";
    }).join("") +
    "</ol>";
  var overviewHtml =
    statHtml +
    "<div class=\"stack\">" +
    C.section("最近动态", "2026-11-07", feedHtml) +
    C.section("告警", "", C.emptyState("还没有告警", "运行中的异常会列在这里")) +
    "</div>";

  C.mount(
    C.layout(
      "",
      "<div class=\"page-tabs\" role=\"tablist\">" +
        "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"overview\" aria-selected=\"true\">总览</button>" +
        "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"calls\" aria-selected=\"false\">调用记录</button>" +
        "</div>" +
        "<div data-panel=\"overview\">" + overviewHtml + "</div>" +
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
