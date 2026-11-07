/* mock: 记忆与 Soul 合并板块。记忆为占位摘要（接入后 GET /api/memories），Soul 为版本占位（接入后 GET /api/souls） */
(function () {
  var C = window.HiveCommon;
  var MEMORIES = [
    { id: "mem_pref", title: "回复用简体中文", scope: "工作区", source: "管理员", updated: "2026-11-05 11:02", excerpt: "界面对用户使用简体中文，术语保留英文原名" },
    { id: "mem_deploy", title: "部署走 Wrangler", scope: "编排", source: "研究", updated: "2026-11-07 09:12", excerpt: "控制面只部署在 Cloudflare Workers，不引入构建步骤" },
    { id: "mem_name", title: "如何称呼操作者", scope: "全局", source: "管理员", updated: "2026-11-01 16:40", excerpt: "操作者在界面中显示为管理员" },
  ];
  var memCards = MEMORIES.map(function (item) {
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
  var memoryHtml =
    "<div class=\"stack\">" +
    C.section("记忆", String(MEMORIES.length) + " 条", C.list(memCards)) +
    C.section("冲突", "", C.emptyState("没有待合并的记忆", "同一作用域发生冲突时会列在这里")) +
    "</div>";

  var SOULS = [
    { id: "soul_orch", agent: "编排", version: "v12", status: "synced", updated: "2026-11-07 08:55" },
    { id: "soul_research", agent: "研究", version: "v7", status: "syncing", updated: "2026-11-07 09:16" },
    { id: "soul_ops", agent: "值守", version: "v3", status: "paused", updated: "2026-11-06 19:04" },
  ];
  var soulCards = SOULS.map(function (item) {
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
  var soulHtml =
    "<div class=\"stack\">" +
    C.section("Soul", String(SOULS.length) + " 份", C.list(soulCards)) +
    C.section("草稿", "", C.emptyState("没有未发布的草稿", "尚未同步的 Soul 草稿会留在这里")) +
    "</div>";

  C.mount(
    C.layout(
      "记忆与每个 Agent 的 Soul 在一个板块，页签切换",
      "<div class=\"page-tabs\" role=\"tablist\">" +
        "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"memory\" aria-selected=\"true\">记忆</button>" +
        "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"soul\" aria-selected=\"false\">Soul</button>" +
        "</div>" +
        "<div data-panel=\"memory\">" + memoryHtml + "</div>" +
        "<div data-panel=\"soul\" hidden>" + soulHtml + "</div>",
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
  activate(location.hash === "#soul" ? "soul" : "memory");
})();
