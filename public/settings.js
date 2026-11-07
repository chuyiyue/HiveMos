/* mock: 设置占位，含 MCP 设置与登录记录。接入后改为 GET /api/settings；登录记录将由管理员账号体系提供真实会话数据 */
(function () {
  var C = window.HiveCommon;
  var SERVERS = [
    { name: "filesystem", transport: "stdio", tools: "12", status: "enabled" },
    { name: "github", transport: "http", tools: "8", status: "enabled" },
    { name: "browser", transport: "sse", tools: "5", status: "disabled" },
  ];
  var LOGINS = [
    { id: "sess_mac", name: "管理员的 Mac · Safari", at: "2026-11-08 03:12", current: true },
    { id: "sess_ipad", name: "工作室 iPad · Safari", at: "2026-11-07 21:44", current: false },
  ];
  var serverCards = SERVERS.map(function (item) {
    return C.record({
      title: item.name,
      status: item.status,
      facts: [
        ["传输", C.escapeHtml(item.transport)],
        ["工具", C.escapeHtml(item.tools)],
      ],
    });
  }).join("");
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
        C.section(
          "MCP 设置",
          "聚合入口、访问令牌与已登记服务",
          '<div class="stack-tight">' +
            C.facts([
              ["聚合入口", C.copyLine("https://hivemos.example/mcp")],
              ["访问令牌", C.copyLine(C.maskTail("88c0"), "复制末四位")],
            ]) +
            C.list(serverCards) +
            "</div>",
        ) +
        C.section("登录记录", String(LOGINS.length) + " 条", C.list(loginCards)) +
        "</div>",
    ),
  );
})();
