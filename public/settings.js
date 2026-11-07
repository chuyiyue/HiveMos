/* mock: 设置占位，含 MCP 设置与授权设备。令牌和设备标识只留末四位。接入后改为 GET /api/settings */
(function () {
  var C = window.HiveCommon;
  var SERVERS = [
    { name: "filesystem", transport: "stdio", tools: "12", status: "enabled" },
    { name: "github", transport: "http", tools: "8", status: "enabled" },
    { name: "browser", transport: "sse", tools: "5", status: "disabled" },
  ];
  var DEVICES = [
    { id: "dev_mac", name: "管理员的 Mac", platform: "macOS", seen: "2026-11-07 08:10", tail: "3F2A", status: "online" },
    { id: "dev_ipad", name: "工作室 iPad", platform: "iPadOS", seen: "2026-11-06 21:04", tail: "90C1", status: "idle" },
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
  var deviceCards = DEVICES.map(function (item) {
    return C.record({
      id: item.id,
      title: item.name,
      status: item.status,
      facts: [
        ["平台", C.escapeHtml(item.platform)],
        ["最近在线", C.escapeHtml(item.seen)],
        ["标识", C.copyLine(C.maskTail(item.tail), "复制末四位")],
      ],
    });
  }).join("");
  C.mount(
    C.layout(
      "工作区、MCP 与已授权设备。改动会在接口接通后保存",
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
        C.section("授权设备", String(DEVICES.length) + " 台", C.list(deviceCards)) +
        C.section("待批准", "", C.emptyState("没有待批准的设备", "新设备申请授权后会列在这里")) +
        "</div>",
    ),
  );
})();
