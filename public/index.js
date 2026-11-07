/* mock: 总览占位。接入后改为 GET /api/overview，字段与下面的数组一致 */
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
    '<div class="stat-grid">' +
    stats
      .map(function (item) {
        return C.stat(item[0], item[1], item[2]);
      })
      .join("") +
    "</div>";
  var feedHtml =
    '<ol class="feed">' +
    feed
      .map(function (item) {
        return (
          '<li><time datetime="' +
          C.escapeHtml(item[1]) +
          '">' +
          C.escapeHtml(item[0]) +
          "</time><span>" +
          C.escapeHtml(item[2]) +
          "</span></li>"
        );
      })
      .join("") +
    "</ol>";
  C.mount(
    C.layout(
      "工作区此刻的 Agent、云主机、任务与同步",
      statHtml +
        '<div class="stack">' +
        C.section("最近动态", "2026-11-07", feedHtml) +
        C.section("告警", "", C.emptyState("还没有告警", "运行中的异常会列在这里")) +
        "</div>",
    ),
  );
})();
