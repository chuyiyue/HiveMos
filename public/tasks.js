/* mock: 任务传递占位。接入后改为 GET /api/tasks */
(function () {
  var C = window.HiveCommon;
  var TASKS = [
    { id: "task_heartbeat", title: "核对云电脑心跳", from: "编排", to: "值守", status: "active", updated: "2026-11-07 09:20" },
    { id: "task_memory", title: "把部署约定写入记忆", from: "研究", to: "档案", status: "queued", updated: "2026-11-07 09:12" },
    { id: "task_rotate", title: "轮换网关密钥展示", from: "编排", to: "编排", status: "done", updated: "2026-11-06 17:45" },
  ];
  var cards = TASKS.map(function (item) {
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
  C.mount(
    C.layout(
      "Agent 之间传递的任务，来源、去向与状态一次看清",
      '<div class="stack">' +
        C.section("任务", String(TASKS.length) + " 条", C.list(cards)) +
        C.section("失败队列", "", C.emptyState("失败队列是空的", "失败的传递会留在这里，方便原样重试")) +
        "</div>",
    ),
  );
})();
