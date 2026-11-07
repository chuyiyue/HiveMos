/* mock: Skills 注册表占位。接入后改为 GET /api/skills */
(function () {
  var C = window.HiveCommon;
  var SKILLS = [
    { id: "skill_search", name: "web-search", version: "1.4.0", source: "官方注册表", used: "研究、编排", status: "enabled" },
    { id: "skill_deploy", name: "wrangler-deploy", version: "0.9.2", source: "工作区", used: "编排", status: "enabled" },
    { id: "skill_vault", name: "vault-read", version: "1.0.1", source: "官方注册表", used: "值守", status: "disabled" },
  ];
  var cards = SKILLS.map(function (item) {
    return C.record({
      id: item.id,
      title: item.name,
      status: item.status,
      lede: item.source,
      facts: [
        ["版本", C.escapeHtml(item.version)],
        ["引用", C.escapeHtml(item.used)],
      ],
    });
  }).join("");
  C.mount(
    C.layout(
      "技能注册表：名称、版本、来源，以及引用它的 Agent",
      '<div class="stack">' +
        C.section("已登记", String(SKILLS.length) + " 个", C.list(cards)) +
        C.section("待审核", "", C.emptyState("没有待审核的技能", "新提交的技能会先出现在这里")) +
        "</div>",
    ),
  );
})();
