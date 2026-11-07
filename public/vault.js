/* mock: 保险库与模型网关合并板块。条目只保留末四位（接入后 GET /api/vault 只返回 tail）；访问记录、网关均为占位。添加先在页内生效 */
(function () {
  var C = window.HiveCommon;
  var activeTab = location.hash === "#gateway" ? "gateway" : "vault";
  function now() {
    var d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function val(ctrl, name) {
    var el = ctrl.form.querySelector("[name=\"" + name + "\"]");
    return el ? el.value.trim() : "";
  }

  var SECRETS = [
    { id: "sec_gateway", name: "模型网关密钥", kind: "API Key", tail: "91f2", updated: "2026-11-06 09:12" },
    { id: "sec_deploy", name: "部署令牌", kind: "Token", tail: "k7Qm", updated: "2026-11-04 14:33" },
    { id: "sec_recovery", name: "设备恢复码", kind: "Recovery", tail: "4418", updated: "2026-10-28 08:05" },
  ];
  var AUDIT = [
    { id: "va_1", who: "编排", what: "读取「模型网关密钥」配置", when: "2026-11-07 09:20" },
    { id: "va_2", who: "值守", what: "读取「部署令牌」配置", when: "2026-11-06 17:45" },
  ];
  var GATEWAYS = [
    { id: "gw_cf", name: "Workers AI 网关", proto: "OpenAI 兼容", base: "gateway.ai.cloudflare.com", models: "12 个模型", tail: "91f2", status: "active" },
    { id: "gw_grok", name: "grok2api", proto: "OpenAI 兼容", base: "grok2api 部署地址", models: "3 个模型", tail: "77ab", status: "active" },
    { id: "gw_local", name: "本地中转", proto: "Anthropic 兼容", base: "云主机内网地址", models: "5 个模型", tail: "c041", status: "paused" },
  ];

  function render() {
    var cards = SECRETS.map(function (item) {
      return C.record({ id: item.id, title: item.name, status: "stored", facts: [["类型", C.escapeHtml(item.kind)], ["末四位", C.copyLine(C.maskTail(item.tail), "复制末四位")], ["更新时间", C.escapeHtml(item.updated)]] });
    }).join("");
    var auditCards = AUDIT.map(function (item) {
      return C.record({ id: item.id, title: item.who, lede: item.what, facts: [["时间", C.escapeHtml(item.when)]] });
    }).join("");
    var vaultHtml =
      "<div class=\"stack\">" +
      "<button type=\"button\" class=\"add-button\" data-add=\"secret\">添加条目</button>" +
      C.section("条目", String(SECRETS.length) + " 条", C.list(cards)) +
      C.section("访问记录", String(AUDIT.length) + " 条", C.list(auditCards)) +
      C.section("回收站", "", C.emptyState("回收站是空的", "删除的条目会在这里停留，方便核对末四位")) +
      "</div>";
    var gwCards = GATEWAYS.map(function (item) {
      return C.record({ id: item.id, title: item.name, status: item.status, facts: [["协议", C.escapeHtml(item.proto)], ["地址", C.escapeHtml(item.base)], ["模型", C.escapeHtml(item.models)], ["密钥末四位", C.escapeHtml(item.tail)]] });
    }).join("");
    var gatewayHtml =
      "<div class=\"stack\">" +
      "<button type=\"button\" class=\"add-button\" data-add=\"gateway\">添加网关</button>" +
      C.section("网关", String(GATEWAYS.length) + " 个", C.list(gwCards)) +
      C.section("模型路由", "", C.emptyState("还没有路由规则", "逻辑模型名映射到哪个网关的哪个模型，会列在这里")) +
      C.section("用量", "", C.emptyState("还没有用量数据", "各网关的请求数与 token 用量会汇总到这里")) +
      "</div>";
    C.mount(
      C.layout(
        "",
        "<div class=\"page-tabs\" role=\"tablist\">" +
          "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"vault\" aria-selected=\"" + (activeTab === "vault" ? "true" : "false") + "\">保险库</button>" +
          "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"gateway\" aria-selected=\"" + (activeTab === "gateway" ? "true" : "false") + "\">模型网关</button>" +
          "</div>" +
          "<div data-panel=\"vault\"" + (activeTab === "vault" ? "" : " hidden") + ">" + vaultHtml + "</div>" +
          "<div data-panel=\"gateway\"" + (activeTab === "gateway" ? "" : " hidden") + ">" + gatewayHtml + "</div>"
      )
    );
  }

  function openAddSecret() {
    C.openFormDialog({
      title: "添加条目",
      bodyHtml:
        "<label>名称<input name=\"name\" maxlength=\"60\" autocomplete=\"off\" /></label>" +
        "<label>类型<input name=\"kind\" maxlength=\"30\" autocomplete=\"off\" placeholder=\"例如 API Key、Token\" /></label>" +
        "<label>值<input name=\"value\" maxlength=\"200\" autocomplete=\"off\" /><p class=\"subtle field-hint\">列表里只会保留末四位</p></label>",
      submitLabel: "添加",
      onSubmit: function (ctrl) {
        var name = val(ctrl, "name");
        var value = val(ctrl, "value");
        if (!name) { ctrl.setError("请填写名称"); return; }
        if (!value) { ctrl.setError("请填写值"); return; }
        SECRETS.unshift({ id: "sec_" + Date.now(), name: name, kind: val(ctrl, "kind") || "Token", tail: value.slice(-4), updated: now() });
        ctrl.close();
        render();
      },
    });
  }
  function openAddGateway() {
    C.openFormDialog({
      title: "添加网关",
      bodyHtml:
        "<label>名称<input name=\"name\" maxlength=\"60\" autocomplete=\"off\" /></label>" +
        "<label>协议<input name=\"proto\" maxlength=\"30\" autocomplete=\"off\" placeholder=\"例如 OpenAI 兼容\" /></label>" +
        "<label>地址<input name=\"base\" maxlength=\"120\" autocomplete=\"off\" /></label>" +
        "<label>密钥<input name=\"key\" maxlength=\"200\" autocomplete=\"off\" /><p class=\"subtle field-hint\">列表里只会保留末四位</p></label>",
      submitLabel: "添加",
      onSubmit: function (ctrl) {
        var name = val(ctrl, "name");
        var key = val(ctrl, "key");
        if (!name) { ctrl.setError("请填写名称"); return; }
        if (!key) { ctrl.setError("请填写密钥"); return; }
        GATEWAYS.push({ id: "gw_" + Date.now(), name: name, proto: val(ctrl, "proto") || "OpenAI 兼容", base: val(ctrl, "base") || "未填写地址", models: "0 个模型", tail: key.slice(-4), status: "paused" });
        ctrl.close();
        render();
      },
    });
  }

  var page = document.getElementById("page");
  page.addEventListener("click", function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var tab = target.closest(".page-tab");
    if (tab) {
      activeTab = tab.getAttribute("data-tab");
      history.replaceState(null, "", "#" + activeTab);
      render();
      return;
    }
    var add = target.closest("[data-add]");
    if (add) {
      if (add.getAttribute("data-add") === "secret") openAddSecret();
      else openAddGateway();
    }
  });
  render();
})();
