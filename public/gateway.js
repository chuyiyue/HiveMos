/* mock: 模型网关占位。接入后改为 GET /api/gateways。密钥只显示末四位 */
(function () {
  var C = window.HiveCommon;
  var GATEWAYS = [
    { id: "gw_cf", name: "Workers AI 网关", proto: "OpenAI 兼容", base: "gateway.ai.cloudflare.com", models: "12 个模型", tail: "91f2", status: "active" },
    { id: "gw_grok", name: "grok2api", proto: "OpenAI 兼容", base: "grok2api 部署地址", models: "3 个模型", tail: "77ab", status: "active" },
    { id: "gw_local", name: "本地中转", proto: "Anthropic 兼容", base: "云主机内网地址", models: "5 个模型", tail: "c041", status: "paused" },
  ];
  var cards = GATEWAYS.map(function (item) {
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
  C.mount(
    C.layout(
      "",
      "<div class=\"stack\">" +
        C.section("网关", String(GATEWAYS.length) + " 个", C.list(cards)) +
        C.section("模型路由", "", C.emptyState("还没有路由规则", "逻辑模型名映射到哪个网关的哪个模型，会列在这里")) +
        C.section("用量", "", C.emptyState("还没有用量数据", "各网关的请求数与 token 用量会汇总到这里")) +
        "</div>",
    ),
  );
})();
