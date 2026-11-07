/* mock: MCP 聚合占位。接入后改为 GET /api/mcp。这里不放令牌，令牌只在设置页以末四位出现 */
(function () {
  var C = window.HiveCommon;
  var SERVERS = [
    { id: "mcp_fs", name: "filesystem", transport: "stdio", tools: "12", status: "online", endpoint: "local" },
    { id: "mcp_gh", name: "github", transport: "http", tools: "8", status: "online", endpoint: "https://mcp.example/github" },
    { id: "mcp_browser", name: "browser", transport: "sse", tools: "5", status: "offline", endpoint: "https://mcp.example/browser" },
  ];
  var cards = SERVERS.map(function (item) {
    return C.record({
      id: item.id,
      title: item.name,
      status: item.status,
      lede: item.endpoint,
      facts: [
        ["传输", C.escapeHtml(item.transport)],
        ["工具", C.escapeHtml(item.tools)],
      ],
    });
  }).join("");
  C.mount(
    C.layout(
      "聚合后的 MCP 服务、传输方式与工具数量",
      '<div class="stack">' +
        C.section("服务", String(SERVERS.length) + " 个", C.list(cards)) +
        C.section("待批准", "", C.emptyState("没有待批准的 MCP 服务", "新上报的连接会先停在这里")) +
        "</div>",
    ),
  );
})();
