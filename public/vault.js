/* mock: 保险库占位。只保留末四位，完整密钥不写入前端。接入后 GET /api/vault 也只返回 tail */
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
  C.mount(
    C.layout(
      "密钥与令牌只显示末四位。完整值不进入页面",
      '<div class="stack">' +
        C.section("条目", String(SECRETS.length) + " 条", C.list(cards)) +
        C.section("回收站", "", C.emptyState("回收站是空的", "删除的条目会在这里停留，方便核对末四位")) +
        "</div>",
    ),
  );
})();
