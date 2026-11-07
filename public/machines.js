/* mock: 云主机板块三页签（服务器 / 云主机 / Workers 容器）。接入后分别改为 GET /api/servers、/api/machines、/api/workers */
(function () {
  var C = window.HiveCommon;

  function card(item, facts) {
    return C.record({ id: item.id, title: item.name, status: item.status, lede: item.lede || "", facts: facts });
  }

  var SERVERS = [
    { id: "sv_sh", name: "上海-01", status: "running", lede: "华东", spec: "8 核 / 16 GB / 500 GB", agent: "编排、值守", heartbeat: "2026-11-07 09:24" },
    { id: "sv_sg", name: "新加坡-02", status: "running", lede: "东南亚", spec: "4 核 / 8 GB / 200 GB", agent: "研究", heartbeat: "2026-11-07 09:18" },
  ];
  var serverHtml =
    "<div class=\"stack\">" +
    C.section("服务器", String(SERVERS.length) + " 台", C.list(SERVERS.map(function (item) {
      return card(item, [
        ["配置", C.escapeHtml(item.spec)],
        ["绑定", C.escapeHtml(item.agent)],
        ["最近心跳", C.escapeHtml(item.heartbeat)],
      ]);
    }).join(""))) +
    "</div>";

  var HOSTS = [
    { id: "pc_hk", name: "香港-01", status: "running", lede: "香港", spec: "2 核 / 4 GB / 40 GB", agent: "值守", heartbeat: "2026-11-07 09:21" },
    { id: "pc_local", name: "本地沙箱", status: "paused", lede: "本机", spec: "沙箱环境", agent: "未绑定", heartbeat: "2026-11-06 18:02" },
  ];
  var hostHtml =
    "<div class=\"stack\">" +
    C.section("云主机", String(HOSTS.length) + " 台", C.list(HOSTS.map(function (item) {
      return card(item, [
        ["规格", C.escapeHtml(item.spec)],
        ["绑定", C.escapeHtml(item.agent)],
        ["最近心跳", C.escapeHtml(item.heartbeat)],
      ]);
    }).join(""))) +
    C.section("已释放", "", C.emptyState("没有已释放的云主机", "释放后的实例会留在这里，直到记录被清掉")) +
    "</div>";

  var WORKERS = [
    { id: "wk_hivemos", name: "hivemos", status: "active", lede: "本控制面", ver: "最新提交", updated: "2026-11-08 03:50" },
    { id: "wk_mail", name: "cloud-mail", status: "active", lede: "mail.outtw.com", ver: "最新提交", updated: "2026-11-08 00:03" },
    { id: "wk_sms", name: "smsinbox", status: "active", lede: "SMSinBox", ver: "最新提交", updated: "2026-11-07 22:10" },
  ];
  var workerHtml =
    "<div class=\"stack\">" +
    C.section("Workers 容器", String(WORKERS.length) + " 个", C.list(WORKERS.map(function (item) {
      return card(item, [
        ["版本", C.escapeHtml(item.ver)],
        ["更新时间", C.escapeHtml(item.updated)],
      ]);
    }).join(""))) +
    "</div>";

  C.mount(
    C.layout(
      "云端与本机的电脑，心跳和绑定关系摊在列表里",
      "<div class=\"page-tabs\" role=\"tablist\">" +
        "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"servers\" aria-selected=\"true\">服务器</button>" +
        "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"hosts\" aria-selected=\"false\">云主机</button>" +
        "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"workers\" aria-selected=\"false\">Workers 容器</button>" +
        "</div>" +
        "<div data-panel=\"servers\">" + serverHtml + "</div>" +
        "<div data-panel=\"hosts\" hidden>" + hostHtml + "</div>" +
        "<div data-panel=\"workers\" hidden>" + workerHtml + "</div>",
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
  var initial = location.hash === "#hosts" ? "hosts" : location.hash === "#workers" ? "workers" : "servers";
  activate(initial);
})();
