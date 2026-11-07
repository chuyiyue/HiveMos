/* mock: 日历板块占位。月视图与日程均为静态示意，功能未实现；接入后改为 GET /api/calendar/events */
(function () {
  var C = window.HiveCommon;
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth();
  var today = now.getDate();
  // mock 日程：仅用于占位示意，键为本月日期
  var MOCK_EVENTS = {};
  MOCK_EVENTS[Math.min(today + 2, 28)] = "示例日程（mock）";
  MOCK_EVENTS[Math.max(today - 3, 1)] = "已结束的示例（mock）";
  var firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // 周一为一周首日
  var daysInMonth = new Date(year, month + 1, 0).getDate();
  var head = ["一", "二", "三", "四", "五", "六", "日"]
    .map(function (d) {
      return '<div class="cal-dow">' + d + "</div>";
    })
    .join("");
  var cells = "";
  for (var i = 0; i < firstDow; i++) cells += '<div class="cal-cell cal-pad"></div>';
  for (var d = 1; d <= daysInMonth; d++) {
    var cls = "cal-cell" + (d === today ? " cal-today" : "");
    var ev = MOCK_EVENTS[d]
      ? '<span class="cal-event">' + C.escapeHtml(MOCK_EVENTS[d]) + "</span>"
      : "";
    cells += '<div class="' + cls + '"><span class="cal-day">' + d + "</span>" + ev + "</div>";
  }
  var grid = '<div class="cal-grid">' + head + cells + "</div>";
  C.mount(
    C.layout(
      "日历聚合中枢，日程在这里汇合，agent 与各台设备都能同步",
      '<div class="stack">' +
        C.section(
          "功能开发中",
          "",
          C.emptyState(
            "日历功能还在设计阶段",
            "当前页面是静态占位，月视图与示例日程均为 mock 数据，不会真实保存或同步",
          ),
        ) +
        C.section("月视图", year + " 年 " + (month + 1) + " 月 · 静态示意", grid) +
        C.section(
          "即将到来的日程",
          "",
          C.emptyState("还没有日程", "功能上线后，agent 写入与订阅同步进来的日程会出现在这里"),
        ) +
        "</div>",
    ),
  );
})();
