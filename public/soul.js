/* mock: Soul 占位。接入后改为 GET /api/souls */
(function () {
  var C = window.HiveCommon;
  var SOULS = [
    { id: "soul_orch", agent: "编排", version: "v12", status: "synced", updated: "2026-11-07 08:55" },
    { id: "soul_research", agent: "研究", version: "v7", status: "syncing", updated: "2026-11-07 09:16" },
    { id: "soul_ops", agent: "值守", version: "v3", status: "paused", updated: "2026-11-06 19:04" },
  ];
  var cards = SOULS.map(function (item) {
    return C.record({
      id: item.id,
      title: item.agent,
      status: item.status,
      lede: "当前版本 " + item.version,
      facts: [
        ["版本", C.escapeHtml(item.version)],
        ["同步时间", C.escapeHtml(item.updated)],
      ],
    });
  }).join("");
  C.mount(
    C.layout(
      "每个 Agent 的 Soul 版本与同步状态",
      '<div class="stack">' +
        C.section("Soul", String(SOULS.length) + " 份", C.list(cards)) +
        C.section("草稿", "", C.emptyState("没有未发布的草稿", "尚未同步的 Soul 草稿会留在这里")) +
        "</div>",
    ),
  );
})();
