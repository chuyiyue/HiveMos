/* mock: 保险库。条目只保留末四位（接入后 GET /api/vault 也只返回 tail）；访问记录为占位（接入后 GET /api/vault/audit） */
(function () {
  var C = window.HiveCommon;
  var SECRETS = [
    { id: "sec_gateway", name: "模型网关密钥", kind: "API Key", tail: "91f2", updated: "2026-11-06 09:12" },
    { id: "sec_deploy", name: "部署令牌", kind: "Token", tail: "k7Qm", updated: "2026-11-04 14:33" },
    { id: "sec_recovery", name: "设备恢复码", kind: "Recovery", tail: "4418", updated: "2026-10-28 08:05" },
  ];
  var cards = SECRETS.map(function (item) {
    return C.record({
      id: item.id,
      title: item.name,
      status: "stored",
      facts: [
        ["类型", C.escapeHtml(item.kind)],
        ["末四位", C.copyLine(C.maskTail(item.tail), "复制末四位")],
        ["更新时间", C.escapeHtml(item.updated)],
      ],
    });
  }).join("");
  var entriesHtml =
    "<div class=\"stack\">" +
    C.section("条目", String(SECRETS.length) + " 条", C.list(cards)) +
    C.section("回收站", "", C.emptyState("回收站是空的", "删除的条目会在这里停留，方便核对末四位")) +
    "</div>";

  var AUDIT = [
    { id: "va_1", who: "编排", what: "读取「模型网关密钥」配置", when: "2026-11-07 09:20" },
    { id: "va_2", who: "值守", what: "读取「部署令牌」配置", when: "2026-11-06 17:45" },
  ];
  var auditCards = AUDIT.map(function (item) {
    return C.record({
      id: item.id,
      title: item.who,
      lede: item.what,
      facts: [["时间", C.escapeHtml(item.when)]],
    });
  }).join("");
  var auditHtml =
    "<div class=\"stack\">" +
    C.section("访问记录", String(AUDIT.length) + " 条", C.list(auditCards)) +
    "</div>";

  C.mount(
    C.layout(
      "密钥与令牌只显示末四位。完整值不进入页面",
      "<div class=\"page-tabs\" role=\"tablist\">" +
        "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"entries\" aria-selected=\"true\">条目</button>" +
        "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"audit\" aria-selected=\"false\">访问记录</button>" +
        "</div>" +
        "<div data-panel=\"entries\">" + entriesHtml + "</div>" +
        "<div data-panel=\"audit\" hidden>" + auditHtml + "</div>",
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
  activate(location.hash === "#audit" ? "audit" : "entries");
})();
