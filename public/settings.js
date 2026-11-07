/* mock: 设置占位（工作区与登录记录）。接入后改为 GET /api/settings；登录记录将由管理员账号体系提供真实会话数据。系统 MCP 设置已迁到 Agents 与应用板块（per-Agent 权限） */
(function () {
  var C = window.HiveCommon;
  var LOGINS = [
    { id: "sess_mac", name: "管理员的 Mac · Safari", at: "2026-11-08 03:12", current: true },
    { id: "sess_ipad", name: "工作室 iPad · Safari", at: "2026-11-07 21:44", current: false },
  ];
  var loginCards = LOGINS.map(function (item) {
    return C.record({
      id: item.id,
      title: item.name,
      status: item.current ? "active" : "",
      lede: item.current ? "当前会话" : "",
      facts: [["登录时间", C.escapeHtml(item.at)]],
    });
  }).join("");
  C.mount(
    C.layout(
      "",
      '<div class="stack">' +
        C.section(
          "工作区",
          "",
          C.facts([
            ["名称", C.escapeHtml("HiveMos 默认工作区")],
            ["区域", C.escapeHtml("自动")],
            ["操作者", C.escapeHtml("管理员")],
          ]),
        ) +
        C.section("登录记录", String(LOGINS.length) + " 条", C.list(loginCards)) +
        "</div>",
    ),
  );
})();
