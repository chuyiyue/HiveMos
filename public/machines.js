/* mock: 云主机板块三页签（服务器 / 云主机 / Workers）。接入后分别改为 GET /api/servers、/api/machines、/api/workers。添加先在页内生效 */
(function () {
  var C = window.HiveCommon;
  var activeTab = location.hash === "#hosts" ? "hosts" : location.hash === "#workers" ? "workers" : "servers";
  function now() {
    var d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function val(ctrl, name) {
    var el = ctrl.form.querySelector("[name=\"" + name + "\"]");
    return el ? el.value.trim() : "";
  }
  // 与其它板块同一套卡片菜单入口：record 的 extra 里放「高级」按钮
  function manageBtn(kind, id) {
    return '<div class="row-actions"><button type="button" class="secondary" data-manage="' + kind + '" data-id="' + C.escapeHtml(id) + '">高级</button></div>';
  }
  function card(kind, item, facts) {
    return C.record({ id: item.id, title: item.name, status: item.status, lede: item.lede || "", facts: facts, extra: manageBtn(kind, item.id) });
  }

  var SERVERS = [
    { id: "sv_sh", name: "上海-01", status: "running", lede: "华东", spec: "8 核 / 16 GB / 500 GB", agent: "编排、值守", heartbeat: "2026-11-07 09:24" },
    { id: "sv_sg", name: "新加坡-02", status: "running", lede: "东南亚", spec: "4 核 / 8 GB / 200 GB", agent: "研究", heartbeat: "2026-11-07 09:18" },
  ];
  var HOSTS = [
    { id: "pc_hk", name: "香港-01", status: "running", lede: "香港", spec: "2 核 / 4 GB / 40 GB", agent: "值守", heartbeat: "2026-11-07 09:21" },
    { id: "pc_local", name: "本地沙箱", status: "paused", lede: "本机", spec: "沙箱环境", agent: "未绑定", heartbeat: "2026-11-06 18:02" },
  ];
  var WORKERS = [
    { id: "wk_hivemos", name: "hivemos", status: "active", lede: "本控制面", ver: "最新提交", updated: "2026-11-08 03:50" },
    { id: "wk_mail", name: "cloud-mail", status: "active", lede: "mail.outtw.com", ver: "最新提交", updated: "2026-11-08 00:03" },
    { id: "wk_sms", name: "smsinbox", status: "active", lede: "SMSinBox", ver: "最新提交", updated: "2026-11-07 22:10" },
  ];

  function render() {
    var serverHtml =
      "<div class=\"stack\">" +
      "<button type=\"button\" class=\"add-button\" data-add=\"server\">添加服务器</button>" +
      C.section("服务器", String(SERVERS.length) + " 台", C.list(SERVERS.map(function (item) {
        return card("server", item, [["配置", C.escapeHtml(item.spec)], ["绑定", C.escapeHtml(item.agent)], ["最近心跳", C.escapeHtml(item.heartbeat)]]);
      }).join(""))) +
      "</div>";
    var hostHtml =
      "<div class=\"stack\">" +
      "<button type=\"button\" class=\"add-button\" data-add=\"host\">添加云主机</button>" +
      C.section("云主机", String(HOSTS.length) + " 台", C.list(HOSTS.map(function (item) {
        return card("host", item, [["规格", C.escapeHtml(item.spec)], ["绑定", C.escapeHtml(item.agent)], ["最近心跳", C.escapeHtml(item.heartbeat)]]);
      }).join(""))) +
      C.section("已释放", "", C.emptyState("没有已释放的云主机", "释放后的实例会留在这里，直到记录被清掉")) +
      "</div>";
    var workerHtml =
      "<div class=\"stack\">" +
      "<button type=\"button\" class=\"add-button\" data-add=\"worker\">添加 Worker</button>" +
      C.section("Workers", String(WORKERS.length) + " 个", C.list(WORKERS.map(function (item) {
        return card("worker", item, [["版本", C.escapeHtml(item.ver)], ["更新时间", C.escapeHtml(item.updated)]]);
      }).join(""))) +
      "</div>";
    C.mount(
      C.layout(
        "",
        "<div class=\"page-tabs\" role=\"tablist\">" +
          "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"servers\" aria-selected=\"" + (activeTab === "servers" ? "true" : "false") + "\">服务器</button>" +
          "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"hosts\" aria-selected=\"" + (activeTab === "hosts" ? "true" : "false") + "\">云主机</button>" +
          "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"workers\" aria-selected=\"" + (activeTab === "workers" ? "true" : "false") + "\">Workers</button>" +
          "</div>" +
          "<div data-panel=\"servers\"" + (activeTab === "servers" ? "" : " hidden") + ">" + serverHtml + "</div>" +
          "<div data-panel=\"hosts\"" + (activeTab === "hosts" ? "" : " hidden") + ">" + hostHtml + "</div>" +
          "<div data-panel=\"workers\"" + (activeTab === "workers" ? "" : " hidden") + ">" + workerHtml + "</div>"
      )
    );
  }

  // 添加与编辑共用同一套字段构建；item 为空是添加，传入条目是编辑并预填。
  // 状态、绑定、心跳、版本是运行态字段，不在表单里，编辑时保持不变
  function itemFields(kind, item) {
    var v = item || { name: "", lede: "", spec: "" };
    var isWorker = kind === "worker";
    return (
      "<label>名称<input name=\"name\" maxlength=\"60\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.name) + "\" /></label>" +
      (isWorker
        ? "<label>说明<input name=\"lede\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 本控制面\" value=\"" + C.escapeHtml(v.lede) + "\" /></label>"
        : "<label>地域<input name=\"lede\" maxlength=\"30\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.lede) + "\" /></label><label>" + (kind === "server" ? "配置" : "规格") + "<input name=\"spec\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 2 核 / 4 GB / 40 GB\" value=\"" + C.escapeHtml(v.spec || "") + "\" /></label>")
    );
  }

  function openItemDialog(kind, item) {
    var editing = !!item;
    var isWorker = kind === "worker";
    var titleFor = { server: "服务器", host: "云主机", worker: "Worker" }[kind];
    C.openFormDialog({
      title: (editing ? "编辑" : "添加") + titleFor,
      bodyHtml: itemFields(kind, item),
      submitLabel: editing ? "保存" : "添加",
      onSubmit: function (ctrl) {
        var name = val(ctrl, "name");
        if (!name) { ctrl.setError("请填写名称"); return; }
        if (editing) {
          item.name = name;
          item.lede = val(ctrl, "lede");
          if (!isWorker) item.spec = val(ctrl, "spec") || (kind === "server" ? "未填写配置" : "未填写规格");
        } else if (isWorker) {
          WORKERS.push({ id: "wk_" + Date.now(), name: name, status: "active", lede: val(ctrl, "lede"), ver: "最新提交", updated: now() });
        } else if (kind === "server") {
          SERVERS.push({ id: "sv_" + Date.now(), name: name, status: "running", lede: val(ctrl, "lede"), spec: val(ctrl, "spec") || "未填写配置", agent: "未绑定", heartbeat: now() });
        } else {
          HOSTS.push({ id: "pc_" + Date.now(), name: name, status: "running", lede: val(ctrl, "lede"), spec: val(ctrl, "spec") || "未填写规格", agent: "未绑定", heartbeat: now() });
        }
        ctrl.close();
        render();
      },
    });
  }

  function openManageMenu(kind, item) {
    C.openActionMenu({
      title: item.name,
      items: [
        {
          label: "编辑",
          onSelect: function () { openItemDialog(kind, item); },
        },
      ],
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
      openItemDialog(add.getAttribute("data-add"), null);
      return;
    }
    var manage = target.closest("[data-manage]");
    if (manage) {
      var mkind = manage.getAttribute("data-manage");
      var mid = manage.getAttribute("data-id");
      var pool = mkind === "server" ? SERVERS : mkind === "host" ? HOSTS : WORKERS;
      var found = null;
      pool.forEach(function (entry) { if (entry.id === mid) found = entry; });
      if (found) openManageMenu(mkind, found);
    }
  });
  render();
})();
