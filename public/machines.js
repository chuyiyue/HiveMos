/* mock: 云电脑占位。接入后改为 GET /api/machines */
(function () {
  var C = window.HiveCommon;
  var MACHINES = [
    {
      id: "pc_sh_01",
      name: "上海-01",
      status: "running",
      region: "华东",
      agent: "编排、值守",
      heartbeat: "2026-11-07 09:24",
    },
    {
      id: "pc_sg_02",
      name: "新加坡-02",
      status: "running",
      region: "东南亚",
      agent: "研究",
      heartbeat: "2026-11-07 09:18",
    },
    {
      id: "pc_local",
      name: "本地沙箱",
      status: "paused",
      region: "本机",
      agent: "未绑定",
      heartbeat: "2026-11-06 18:02",
    },
  ];
  var cards = MACHINES.map(function (item) {
    return C.record({
      id: item.id,
      title: item.name,
      status: item.status,
      lede: item.region,
      facts: [
        ["绑定", C.escapeHtml(item.agent)],
        ["最近心跳", C.escapeHtml(item.heartbeat)],
      ],
    });
  }).join("");
  C.mount(
    C.layout(
      "云端与本机的电脑，心跳和绑定关系摊在列表里",
      '<div class="stack">' +
        C.section("电脑", String(MACHINES.length) + " 台", C.list(cards)) +
        C.section("已释放", "", C.emptyState("没有已释放的云电脑", "释放后的实例会留在这里，直到记录被清掉")) +
        "</div>",
    ),
  );
})();
