/* mock: 保险库与模型网关合并板块。条目只保留末四位（接入后 GET /api/vault 只返回 tail）；访问记录、网关均为占位 */
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
  var AUDIT = [
    { id: "va_1", who: "编排", what: "读取「模型网关密钥」配置", when: "2026-11-07 09:20" },
    { id: "va_2", who: "值守", what: "读取「部署令牌」配置", when: "2026-11-06 17:45" },
  ];
  var auditCards = AUDIT.map(function (item) {
    return C.record({ id: item.id, title: item.who, lede: item.what, facts: [["时间", C.escapeHtml(item.when)]] });
  }).join("");
  var vaultHtml =
    "<div class=\"stack\">" +
    C.section("条目", String(SECRETS.length) + " 条", C.list(cards)) +
    C.section("访问记录", String(AUDIT.length) + " 条", C.list(auditCards)) +
    C.section("回收站", "", C.emptyState("回收站是空的", "删除的条目会在这里停留，方便核对末四位")) +
    "</div>";

  var GATEWAYS = [
    { id: "gw_cf", name: "Workers AI 网关", proto: "OpenAI 兼容", base: "gateway.ai.cloudflare.com", models: "12 个模型", tail: "91f2", status: "active" },
    { id: "gw_grok", name: "grok2api", proto: "OpenAI 兼容", base: "grok2api 部署地址", models: "3 个模型", tail: "77ab", status: "active" },
    { id: "gw_local", name: "本地中转", proto: "Anthropic 兼容", base: "云主机内网地址", models: "5 个模型", tail: "c041", status: "paused" },
  ];
  var gwCards = GATEWAYS.map(function (item) {
    return C.record({
      id: item.id,
      title: item.name,
      status: item.status,
      facts: [
        ["协议", C.escapeHtml(item.proto)],
        ["地址", C.escapeHtml(item.base)],
        ["模型", C.escapeHtml(item.models)],
        ["密钥末四位", C.escapeHtml(item.tail)],
      ],
    });
  }).join("");
  var gatewayHtml =
    "<div class=\"stack\">" +
    C.section("网关", String(GATEWAYS.length) + " 个", C.list(gwCards)) +
    C.section("模型路由", "", C.emptyState("还没有路由规则", "逻辑模型名映射到哪个网关的哪个模型，会列在这里")) +
    C.section("用量", "", C.emptyState("还没有用量数据", "各网关的请求数与 token 用量会汇总到这里")) +
    "</div>";

  C.mount(
    C.layout(
      "密钥与令牌只显示末四位。完整值不进入页面",
      "<div class=\"page-tabs\" role=\"tablist\">" +
        "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"vault\" aria-selected=\"true\">保险库</button>" +
        "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"gateway\" aria-selected=\"false\">模型网关</button>" +
        "</div>" +
        "<div data-panel=\"vault\">" + vaultHtml + "</div>" +
        "<div data-panel=\"gateway\" hidden>" + gatewayHtml + "</div>",
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
  activate(location.hash === "#gateway" ? "gateway" : "vault");
})();
