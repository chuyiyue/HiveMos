/* mock: 记忆占位。接入后改为 GET /api/memories。正文只是摘要 */
(function () {
  var C = window.HiveCommon;
  var MEMORIES = [
    {
      id: "mem_pref",
      title: "回复用简体中文",
      scope: "工作区",
      source: "管理员",
      updated: "2026-11-05 11:02",
      excerpt: "界面对用户使用简体中文，术语保留英文原名",
    },
    {
      id: "mem_deploy",
      title: "部署走 Wrangler",
      scope: "编排",
      source: "研究",
      updated: "2026-11-07 09:12",
      excerpt: "控制面只部署在 Cloudflare Workers，不引入构建步骤",
    },
    {
      id: "mem_name",
      title: "如何称呼操作者",
      scope: "全局",
      source: "管理员",
      updated: "2026-11-01 16:40",
      excerpt: "操作者在界面中显示为管理员",
    },
  ];
  var cards = MEMORIES.map(function (item) {
    return C.record({
      id: item.id,
      title: item.title,
      lede: item.excerpt,
      facts: [
        ["作用域", C.escapeHtml(item.scope)],
        ["来源", C.escapeHtml(item.source)],
        ["更新时间", C.escapeHtml(item.updated)],
      ],
    });
  }).join("");
  C.mount(
    C.layout(
      "按作用域同步的记忆，正文是占位摘要",
      '<div class="stack">' +
        C.section("记忆", String(MEMORIES.length) + " 条", C.list(cards)) +
        C.section("冲突", "", C.emptyState("没有待合并的记忆", "同一作用域发生冲突时会列在这里")) +
        "</div>",
    ),
  );
})();
