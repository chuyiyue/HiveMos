/* mock: 任务与日历合并板块。任务为占位数据（接入后 GET /api/tasks），日历为静态示意（方案见 docs，接入后 GET /api/calendar/events） */
(function () {
  var C = window.HiveCommon;
  var TASKS = [
    { id: "task_heartbeat", title: "核对云电脑心跳", from: "编排", to: "值守", status: "active", updated: "2026-11-07 09:20" },
    { id: "task_memory", title: "把部署约定写入记忆", from: "研究", to: "档案", status: "queued", updated: "2026-11-07 09:12" },
    { id: "task_rotate", title: "轮换网关密钥展示", from: "编排", to: "编排", status: "done", updated: "2026-11-06 17:45" },
  ];
  var taskCards = TASKS.map(function (item) {
    return C.record({
      id: item.id,
      title: item.title,
      status: item.status,
      facts: [
        ["从", C.escapeHtml(item.from)],
        ["到", C.escapeHtml(item.to)],
        ["更新时间", C.escapeHtml(item.updated)],
      ],
    });
  }).join("");
  var tasksHtml =
    "<div class=\"stack\">" +
    C.section("任务", String(TASKS.length) + " 条", C.list(taskCards)) +
    C.section("失败队列", "", C.emptyState("失败队列是空的", "失败的传递会留在这里，方便原样重试")) +
    "</div>";

  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth();
  var today = now.getDate();
  var MOCK_EVENTS = {};
  MOCK_EVENTS[Math.min(today + 2, 28)] = "示例日程（mock）";
  MOCK_EVENTS[Math.max(today - 3, 1)] = "已结束的示例（mock）";
  var firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
  var daysInMonth = new Date(year, month + 1, 0).getDate();
  var head = ["一", "二", "三", "四", "五", "六", "日"]
    .map(function (d) { return "<div class=\"cal-dow\">" + d + "</div>"; })
    .join("");
  var cells = "";
  for (var i = 0; i < firstDow; i++) cells += "<div class=\"cal-cell cal-pad\"></div>";
  for (var d = 1; d <= daysInMonth; d++) {
    var cls = "cal-cell" + (d === today ? " cal-today" : "");
    var ev = MOCK_EVENTS[d] ? "<span class=\"cal-event\">" + C.escapeHtml(MOCK_EVENTS[d]) + "</span>" : "";
    cells += "<div class=\"" + cls + "\"><span class=\"cal-day\">" + d + "</span>" + ev + "</div>";
  }
  var grid = "<div class=\"cal-grid\">" + head + cells + "</div>";
  var calendarHtml =
    "<div class=\"stack\">" +
    C.section("功能开发中", "", C.emptyState("日历功能还在设计阶段", "当前是静态占位，月视图与示例日程均为 mock 数据，不会真实保存或同步")) +
    C.section("月视图", year + " 年 " + (month + 1) + " 月 · 静态示意", grid) +
    C.section("即将到来的日程", "", C.emptyState("还没有日程", "功能上线后，agent 写入与订阅同步进来的日程会出现在这里")) +
    "</div>";

  C.mount(
    C.layout(
      "任务传递与日程聚合在一个板块，页签切换",
      "<div class=\"page-tabs\" role=\"tablist\">" +
        "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"tasks\" aria-selected=\"true\">任务</button>" +
        "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"calendar\" aria-selected=\"false\">日历</button>" +
        "</div>" +
        "<div data-panel=\"tasks\">" + tasksHtml + "</div>" +
        "<div data-panel=\"calendar\" hidden>" + calendarHtml + "</div>",
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
  activate(location.hash === "#calendar" ? "calendar" : "tasks");
})();
