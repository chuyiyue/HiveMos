/* 云主机板块三页签（服务器 / 云主机 / Workers），数据走 /api/machines。
   状态、最近心跳是运行态字段（由 Agent 经 MCP 上报），表单里不出现；
   绑定是普通文本字段，随添加/编辑一起保存。
   二期接入：服务器改为极简录入（IP、用户名、密码或密钥二选一、备注），
   保存后用存好的配置真连 SSH 探活回填主机名、系统、内核与架构；卡片只
   展示备注、主机名、系统与主机 IP，用户名只在编辑弹窗里出现，密码经
   「查看 SSH 密码」走 reveal 接口；打开列表时对过期条目后台补测（暂无
   Cron，阈值 10 分钟）。
   云主机走服务商连接向导（华为云 API / MCP 通用）导入设备，凭据加密存、
   设备可改本地别名、可从连接手动同步；Workers 存 Cloudflare 账号 ID 与
   API 令牌（加密保存），可实时查看该账号名下的 Workers。
   分组：三页签共用一个分组池（groups 表 scope=machines），按分组分区
   展示、未分组置后；分组可改名/删除，删组后条目回未分组、不删条目。 */
(function () {
  var C = window.HiveCommon;
  var activeTab = location.hash === "#hosts" ? "hosts" : location.hash === "#workers" ? "workers" : "servers";
  var API_KIND = { server: "server", host: "cloud", worker: "worker" };
  var TITLE_FOR = { server: "服务器", host: "云主机", worker: "Worker" };

  var state = { items: [], connections: [], groups: [], loaded: false, loadError: "" };

  function api(method, url, body) {
    var headers = { accept: "application/json" };
    var options = { method: method, headers: headers, cache: "no-store" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return fetch(url, options).then(function (response) {
      return response
        .json()
        .catch(function () { return {}; })
        .then(function (data) { return { status: response.status, data: data || {} }; });
    });
  }

  function val(ctrl, name) {
    var el = ctrl.form.querySelector("[name=\"" + name + "\"]");
    return el ? el.value.trim() : "";
  }

  function byKind(uiKind) {
    var kind = API_KIND[uiKind];
    return state.items.filter(function (item) { return item.kind === kind; });
  }

  function heartbeatText(item) {
    var text = C.formatMinute(item.last_heartbeat_at);
    return text || "还没有心跳";
  }

  // ---- 管理弹窗（点卡片信息区打开） ----

  function openManage(key) {
    if (!key) return;
    var parts = key.split(":");
    if (parts[0] !== "machine") return;
    var kind = parts[1];
    var id = parts.slice(2).join(":");
    var found = null;
    state.items.forEach(function (entry) {
      if (entry.id === id) found = entry;
    });
    if (found) openMachineManage(kind, found);
  }

  function openMachineManage(kind, item) {
    var id = C.escapeHtml(item.id);
    var btns = "";
    if (kind === "server") {
      btns += "<button type=\"button\" class=\"secondary\" data-mact=\"probe\" data-kind=\"server\" data-id=\"" + id + "\">测试连接</button>";
      btns += "<button type=\"button\" class=\"secondary\" data-mact=\"reveal\" data-kind=\"server\" data-id=\"" + id + "\">查看 SSH 密码</button>";
    }
    if (kind === "worker")
      btns += "<button type=\"button\" class=\"secondary\" data-mact=\"workers\" data-kind=\"worker\" data-id=\"" + id + "\">查看 Workers</button>";
    btns += "<button type=\"button\" class=\"secondary\" data-mact=\"group\" data-kind=\"" + kind + "\" data-id=\"" + id + "\">设置分组</button>";
    btns += "<button type=\"button\" class=\"secondary\" data-mact=\"edit\" data-kind=\"" + kind + "\" data-id=\"" + id + "\">编辑</button>";
    btns += "<button type=\"button\" class=\"danger\" data-mact=\"delete\" data-kind=\"" + kind + "\" data-id=\"" + id + "\">删除</button>";
    var body = "";
    if (kind === "server") body += C.record({ id: item.id, title: "探活信息", facts: probeFactsRows(item) });
    body += "<div class=\"manage-actions\">" + btns + "</div>";
    var ctrl = C.openManageDialog({
      title: item.name,
      bodyHtml: body,
    });
    ctrl.dialog.addEventListener("click", handleClick);
  }

  function deleteMachine(kind, item, anchor) {
    var dlg = anchor && anchor.closest ? anchor.closest("[data-manage-dialog]") : null;
    var mount = (dlg && dlg.querySelector("[data-manage-confirm]")) || anchor;
    C.askConfirm({
      anchor: mount,
      title: "删除" + TITLE_FOR[kind],
      text: "确认删除「" + item.name + "」吗？删除后无法恢复",
      confirmLabel: "删除",
      danger: true,
    }).then(function (yes) {
      if (!yes) return;
      api("DELETE", "/api/machines/" + encodeURIComponent(item.id)).then(function (res) {
        if (res.data && res.data.ok) { C.closeCurrentOverlay(); load(); }
      });
    });
  }

  function card(kind, item, facts) {
    var lede = kind === "worker" ? item.description : item.region;
    var id = C.escapeHtml(item.id);
    var actions = "";
    if (kind === "server") {
      actions += "<button type=\"button\" class=\"secondary\" data-mact=\"probe\" data-kind=\"server\" data-id=\"" + id + "\">测试连接</button>";
      actions += "<button type=\"button\" class=\"secondary\" data-mact=\"reveal\" data-kind=\"server\" data-id=\"" + id + "\">查看密码</button>";
      if (item.ip) actions += "<button type=\"button\" class=\"secondary\" data-copy=\"" + C.escapeHtml(item.ip) + "\" data-label=\"复制 IP\">复制 IP</button>";
    } else if (kind === "worker") {
      actions += "<button type=\"button\" class=\"secondary\" data-mact=\"workers\" data-kind=\"worker\" data-id=\"" + id + "\">查看 Workers</button>";
    } else {
      actions += "<button type=\"button\" class=\"secondary\" data-mact=\"edit\" data-kind=\"" + kind + "\" data-id=\"" + id + "\">编辑</button>";
    }
    return C.record({
      id: item.id,
      icon: kind === "worker" ? "layout" : "monitor",
      title: item.name,
      status: item.status,
      lede: lede || "",
      facts: facts,
      actions: actions,
      manage: "machine:" + kind + ":" + item.id,
    });
  }


  function cardFor(uiKind, item) {
    if (uiKind === "worker") {
      var facts = [["版本", C.escapeHtml(item.version || "未记录")], ["更新时间", C.escapeHtml(C.formatMinute(item.updated_at) || "—")]];
      if (item.cf_account_id) facts.push(["Cloudflare 账号", C.escapeHtml(item.cf_account_id)]);
      if (item.api_token_tail) facts.push(["API 令牌", "末四位 " + C.escapeHtml(item.api_token_tail)]);
      return card("worker", item, facts);
    }
    if (uiKind === "server") {
      return card("server", item, [
        ["备注", C.escapeHtml(item.note || "无")],
        ["主机名", C.escapeHtml(item.hostname || "尚未探活")],
        ["系统", C.escapeHtml(item.os || "尚未探活")],
        ["主机 IP", C.escapeHtml(item.ip || "未填写")],
      ]);
    }
    if (item.connection_id) {
      return card(uiKind, item, [
        ["系统", C.escapeHtml(item.os || "未同步")],
        ["规格", C.escapeHtml(item.spec || "未同步")],
        ["主机 IP", C.escapeHtml(item.ip || "未同步")],
        ["服务商", C.escapeHtml(item.vendor || "")],
        ["远端名称", C.escapeHtml(item.remote_name || "")],
        ["最近同步", C.escapeHtml(item.last_sync_at ? C.formatMinute(item.last_sync_at) || "—" : "尚未同步")],
      ]);
    }
    var facts = [
      ["规格", C.escapeHtml(item.spec)],
      ["绑定", C.escapeHtml(item.binding || "未绑定")],
      ["最近心跳", C.escapeHtml(heartbeatText(item))],
    ];
    if (item.note) facts.push(["备注", C.escapeHtml(item.note)]);
    if (item.vendor) facts.push(["厂商", C.escapeHtml(item.vendor)]);
    if (item.access_note) facts.push(["接入备注", C.escapeHtml(item.access_note)]);
    return card(uiKind, item, facts);
  }

  function groupActionsHtml(group) {
    var gid = C.escapeHtml(group.id);
    return (
      "<button type=\"button\" class=\"secondary\" data-mgroup=\"rename\" data-id=\"" + gid + "\">改名</button>" +
      "<button type=\"button\" class=\"danger\" data-mgroup=\"delete\" data-id=\"" + gid + "\">删除</button>" +
      "<span class=\"confirm-slot\" data-confirm-group=\"" + gid + "\"></span>"
    );
  }

  function listSection(uiKind, title, unit) {
    if (!state.loaded) return C.section(title, "", C.emptyState("正在加载", "正在读取云主机数据"));
    if (state.loadError) return C.section(title, "", '<p class="callout danger" role="alert">' + C.escapeHtml(state.loadError) + "</p>");
    return C.groupedSections({
      groups: state.groups,
      items: byKind(uiKind),
      groupOf: function (item) { return item.group_id || null; },
      renderItem: function (item) { return cardFor(uiKind, item); },
      groupActions: groupActionsHtml,
      ungroupedTitle: state.groups.length ? "未分组" : title,
      cardGrid: true,
      emptyTitle: "暂无内容",
      emptyText: "点上方按钮添加",
      emptyGroupText: "添加或编辑条目时选择这个分组即可归入",
    });
  }

  function render() {
    var serverHtml =
      "<div class=\"stack\">" +
      listSection("server", "服务器", "台") +
      "</div>";
    var hostHtml =
      "<div class=\"stack\">" +
      connectionsSection() +
      listSection("host", "云主机", "台") +
      C.section("已释放", "", C.emptyState("没有已释放的云主机", "释放后的实例会留在这里，直到记录被清掉")) +
      "</div>";
    var workerHtml =
      "<div class=\"stack\">" +
      listSection("worker", "Workers", "个") +
      "</div>";
    var head =
      '<div class="page-head"><div class="page-tabs" role="tablist">' +
      '<button class="page-tab" type="button" role="tab" data-tab="servers" aria-selected="' +
      (activeTab === "servers" ? "true" : "false") +
      '">服务器</button>' +
      '<button class="page-tab" type="button" role="tab" data-tab="hosts" aria-selected="' +
      (activeTab === "hosts" ? "true" : "false") +
      '">云主机</button>' +
      '<button class="page-tab" type="button" role="tab" data-tab="workers" aria-selected="' +
      (activeTab === "workers" ? "true" : "false") +
      '">Workers</button>' +
      "</div>" +
      '<div class="page-head-actions">' +
      (activeTab === "servers"
        ? '<button type="button" class="add-button" data-add="server">添加服务器</button>'
        : activeTab === "hosts"
          ? '<button type="button" class="add-button" data-add="host">添加云主机</button>'
          : '<button type="button" class="add-button" data-add="worker">添加 Worker</button>') +
      '<button type="button" class="secondary add-group-button" data-add-group>添加分组</button>' +
      "</div></div>";
    C.mount(
      C.layout(
        "",
        head +
          "<div data-panel=\"servers\"" + (activeTab === "servers" ? "" : " hidden") + ">" + serverHtml + "</div>" +
          "<div data-panel=\"hosts\"" + (activeTab === "hosts" ? "" : " hidden") + ">" + hostHtml + "</div>" +
          "<div data-panel=\"workers\"" + (activeTab === "workers" ? "" : " hidden") + ">" + workerHtml + "</div>"
      )
    );
  }

  function load() {
    var machinesReq = api("GET", "/api/machines");
    var connsReq = api("GET", "/api/machines/providers").catch(function () { return { data: {} }; });
    var groupsReq = api("GET", "/api/groups?scope=machines").catch(function () { return { data: {} }; });
    return Promise.all([machinesReq, connsReq, groupsReq])
      .then(function (results) {
        var res = results[0];
        var connRes = results[1];
        var groupsRes = results[2];
        state.loaded = true;
        if (res.data && res.data.ok) {
          state.items = res.data.machines || [];
          state.loadError = "";
        } else {
          state.loadError = (res.data && res.data.error) || "云主机数据读取失败";
        }
        if (connRes.data && connRes.data.ok) state.connections = connRes.data.connections || [];
        if (groupsRes.data && groupsRes.data.ok) state.groups = groupsRes.data.groups || [];
        render();
        scheduleProbeRefresh();
      })
      .catch(function () {
        state.loaded = true;
        state.loadError = "云主机数据读取失败";
        render();
      });
  }

  // 添加与编辑共用同一套字段构建；item 为空是添加，传入条目是编辑并预填。
  // 状态、心跳、版本是运行态字段，不在表单里，编辑时保持不变；
  // 密码或私钥、API 令牌不回填，编辑时留空表示不修改
  function itemFields(kind, item) {
    var v = item || {};
    var nameField = "<label>名称<input name=\"name\" maxlength=\"60\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.name || "") + "\" /></label>";
    if (kind === "server") {
      return (
        nameField +
        "<label>备注<input name=\"note\" maxlength=\"200\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.note || "") + "\" /></label>" +
        "<label>主机名<input name=\"hostname\" maxlength=\"60\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.hostname || "") + "\" /></label>" +
        "<label>系统<input name=\"os\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 Debian 12\" value=\"" + C.escapeHtml(v.os || "") + "\" /></label>" +
        "<label>主机 IP<input name=\"ip\" maxlength=\"64\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.ip || "") + "\" /></label>" +
        "<label>地域<input name=\"lede\" maxlength=\"30\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.region || "") + "\" /></label>" +
        "<label>配置<input name=\"spec\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 2 核 / 4 GB / 40 GB\" value=\"" + C.escapeHtml(v.spec || "") + "\" /></label>" +
        "<label>SSH 地址<input name=\"ssh_host\" maxlength=\"120\" autocomplete=\"off\" placeholder=\"留空时用主机 IP\" value=\"" + C.escapeHtml(v.ssh_host || "") + "\" /></label>" +
        "<label>SSH 端口<input name=\"ssh_port\" type=\"number\" min=\"1\" max=\"65535\" value=\"" + (v.ssh_port != null ? v.ssh_port : 22) + "\" /></label>" +
        "<label>SSH 用户名<input name=\"ssh_user\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"" + (item ? "留空表示不修改" : "例如 root") + "\" /></label>" +
        "<label>SSH 密码或私钥<textarea name=\"ssh_secret\" rows=\"3\" maxlength=\"16384\" placeholder=\"" + (item ? "留空表示不修改" : "密码或私钥") + "\"></textarea></label>"
      );
    }
    if (kind === "host") {
      return (
        nameField +
        "<label>备注<input name=\"note\" maxlength=\"200\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.note || "") + "\" /></label>" +
        "<label>地域<input name=\"lede\" maxlength=\"30\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.region || "") + "\" /></label>" +
        "<label>规格<input name=\"spec\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 2 核 / 4 GB / 40 GB\" value=\"" + C.escapeHtml(v.spec || "") + "\" /></label>" +
        "<label>厂商<input name=\"vendor\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 Vultr\" value=\"" + C.escapeHtml(v.vendor || "") + "\" /></label>" +
        "<label>接入方式备注<textarea name=\"access_note\" rows=\"2\" maxlength=\"200\" placeholder=\"例如 厂商面板开机，密钥在保险库\">" + C.escapeHtml(v.access_note || "") + "</textarea></label>" +
        "<label>绑定<input name=\"binding\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 值守（留空为未绑定）\" value=\"" + C.escapeHtml(item ? v.binding || "" : "") + "\" /></label>" +
        "<label>分组" + C.groupSelect("group_id", state.groups, v.group_id || "") + "</label>"
      );
    }
    return (
      nameField +
      "<label>说明<input name=\"lede\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 本控制面\" value=\"" + C.escapeHtml(v.description || "") + "\" /></label>" +
      "<label>Cloudflare 账号 ID<input name=\"cf_account_id\" maxlength=\"64\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.cf_account_id || "") + "\" /></label>" +
      "<label>API 令牌<input name=\"api_token\" type=\"password\" maxlength=\"16384\" autocomplete=\"off\" placeholder=\"" + (item ? "留空表示不修改" : "有 Workers 读取权限的令牌") + "\" /></label>" +
      "<label>分组" + C.groupSelect("group_id", state.groups, v.group_id || "") + "</label>"
    );
  }

  function openItemDialog(kind, item) {
    var editing = !!item;
    C.openFormDialog({
      title: (editing ? "编辑" : "添加") + TITLE_FOR[kind],
      bodyHtml: itemFields(kind, item),
      submitLabel: editing ? "保存" : "添加",
      onSubmit: function (ctrl) {
        var name = val(ctrl, "name");
        if (!name) { ctrl.setError("请填写名称"); return; }
        var payload;
        if (kind === "server") {
          payload = {
            name: name,
            note: val(ctrl, "note"),
            hostname: val(ctrl, "hostname"),
            os: val(ctrl, "os"),
            ip: val(ctrl, "ip"),
            region: val(ctrl, "lede"),
            spec: val(ctrl, "spec") || "未填写配置",
            ssh_host: val(ctrl, "ssh_host"),
            ssh_port: Number(val(ctrl, "ssh_port")) || 22,
          };
          var sshUser = val(ctrl, "ssh_user");
          if (sshUser) payload.ssh_user = sshUser;
          var secret = val(ctrl, "ssh_secret");
          if (secret) payload.ssh_secret = secret;
        } else if (kind === "host") {
          payload = {
            name: name,
            note: val(ctrl, "note"),
            region: val(ctrl, "lede"),
            spec: val(ctrl, "spec") || "未填写规格",
            vendor: val(ctrl, "vendor"),
            access_note: val(ctrl, "access_note"),
            binding: val(ctrl, "binding"),
            group_id: val(ctrl, "group_id") || null,
          };
        } else {
          payload = {
            name: name,
            description: val(ctrl, "lede"),
            cf_account_id: val(ctrl, "cf_account_id"),
            group_id: val(ctrl, "group_id") || null,
          };
          var token = val(ctrl, "api_token");
          if (token) payload.api_token = token;
        }
        ctrl.setBusy(true);
        var request = editing
          ? api("PATCH", "/api/machines/" + encodeURIComponent(item.id), payload)
          : api("POST", "/api/machines", Object.assign({ kind: API_KIND[kind] }, payload));
        request
          .then(function (res) {
            ctrl.setBusy(false);
            if (!res.data || !res.data.ok) {
              ctrl.setError((res.data && res.data.error) || "保存失败，请重试");
              return;
            }
            ctrl.close();
            load();
          })
          .catch(function () {
            ctrl.setBusy(false);
            ctrl.setError("网络异常，请重试");
          });
      },
    });
  }

  // ---- 服务器：极简表单（IP / 用户名 / 认证二选一 / 备注）+ 真探活 ----

  function probeFactsRows(item) {
    var rows = [
      ["探活状态", item.probe_status === "ok" ? "在线" : item.probe_status === "error" ? "离线" : "尚未探活"],
      ["主机名", item.hostname || "尚未探活"],
      ["系统", item.os || "尚未探活"],
      ["内核", item.kernel || "尚未探活"],
      ["架构", item.arch || "尚未探活"],
      ["最近探活", item.probe_at ? C.formatMinute(item.probe_at) || "—" : "尚未探活"],
    ];
    if (item.host_fingerprint) rows.push(["主机指纹", item.host_fingerprint]);
    if (item.probe_status === "error" && item.probe_error) rows.push(["失败原因", item.probe_error]);
    return rows.map(function (row) { return [row[0], C.escapeHtml(String(row[1]))]; });
  }

  // 列表打开后服务端会经 waitUntil 对过期服务器后台补测；若本页有这类
  // 条目，8 秒后静默重拉一次，让补测结果自己浮现（只排一次，不轮询）。
  var probeRefreshTimer = null;
  function scheduleProbeRefresh() {
    if (probeRefreshTimer) return;
    var now = Date.now();
    var stale = state.items.some(function (item) {
      return item.kind === "server" && item.ssh_tail && (item.probe_at == null || now - item.probe_at > 10 * 60 * 1000);
    });
    if (!stale) return;
    probeRefreshTimer = setTimeout(function () {
      probeRefreshTimer = null;
      load();
    }, 8000);
  }

  function probeServer(item, btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "正在测试…";
    }
    api("POST", "/api/machines/" + encodeURIComponent(item.id) + "/probe")
      .then(function (res) {
        return load().then(function () {
          var failed = !res.data || !res.data.ok || (res.data.probe && !res.data.probe.ok);
          if (failed) {
            var fresh = null;
            state.items.forEach(function (entry) { if (entry.id === item.id) fresh = entry; });
            if (fresh) openMachineManage("server", fresh);
          }
        });
      })
      .catch(function () { load(); });
  }

  // 认证方式二选一：只渲染选中方式的输入框，另一个不出现在 DOM 里。
  function secretFieldHtml(authType, editing) {
    if (authType === "key") {
      return "<label>私钥<textarea name=\"ssh_secret\" rows=\"5\" maxlength=\"16384\" autocomplete=\"off\" placeholder=\"" + (editing ? "留空表示不修改" : "粘贴 OpenSSH 或 PEM 私钥") + "\"></textarea></label>";
    }
    return "<label>密码<input name=\"ssh_secret\" type=\"password\" maxlength=\"200\" autocomplete=\"off\" placeholder=\"" + (editing ? "留空表示不修改" : "SSH 登录密码") + "\" /></label>";
  }

  function serverFields(item) {
    var v = item || {};
    var authType = v.auth_type === "key" ? "key" : "password";
    var html = "";
    if (item) html += C.record({ id: item.id, title: "探活信息", facts: probeFactsRows(item) });
    html +=
      "<label>IP<input name=\"ip\" maxlength=\"120\" autocomplete=\"off\" placeholder=\"例如 203.0.113.10\" value=\"" + C.escapeHtml(v.ip || "") + "\" /></label>" +
      "<label>用户名<input name=\"ssh_user\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"" + (item ? "留空表示不修改" : "例如 root") + "\" /></label>" +
      "<fieldset class=\"auth-type\"><legend>认证方式</legend>" +
      "<label><input type=\"radio\" name=\"auth_type\" value=\"password\"" + (authType === "password" ? " checked" : "") + " /> 密码</label>" +
      "<label><input type=\"radio\" name=\"auth_type\" value=\"key\"" + (authType === "key" ? " checked" : "") + " /> 密钥</label>" +
      "</fieldset>" +
      "<div data-secret-slot>" + secretFieldHtml(authType, !!item) + "</div>" +
      "<label>备注<input name=\"note\" maxlength=\"200\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.note || "") + "\" /></label>" +
      "<details><summary>高级</summary>" +
      "<label>SSH 端口<input name=\"ssh_port\" type=\"number\" min=\"1\" max=\"65535\" value=\"" + (v.ssh_port != null ? v.ssh_port : 22) + "\" /></label>" +
      "<label>SSH 地址<input name=\"ssh_host\" maxlength=\"120\" autocomplete=\"off\" placeholder=\"留空时用 IP\" value=\"" + C.escapeHtml(v.ssh_host || "") + "\" /></label>" +
      "<label>分组" + C.groupSelect("group_id", state.groups, v.group_id || "") + "</label>" +
      "</details>";
    return html;
  }

  function openServerDialog(item) {
    var editing = !!item;
    var ctrl = C.openFormDialog({
      title: (editing ? "编辑" : "添加") + "服务器",
      bodyHtml: serverFields(item),
      submitLabel: editing ? "保存" : "添加",
      onSubmit: function (c) {
        var ip = val(c, "ip");
        var checked = c.form.querySelector("[name=\"auth_type\"]:checked");
        var authType = checked && checked.value === "key" ? "key" : "password";
        var secret = val(c, "ssh_secret");
        var sshUser = val(c, "ssh_user");
        if (!editing) {
          if (!ip) { c.setError("请填写 IP"); return; }
          if (!sshUser) { c.setError("请填写用户名"); return; }
          if (!secret) { c.setError(authType === "key" ? "请粘贴私钥" : "请填写密码"); return; }
        }
        var payload = { auth_type: authType, note: val(c, "note"), ssh_port: Number(val(c, "ssh_port")) || 22 };
        payload.group_id = val(c, "group_id") || null;
        if (ip) payload.ip = ip;
        payload.ssh_host = val(c, "ssh_host") || ip;
        if (sshUser) payload.ssh_user = sshUser;
        if (secret) payload.ssh_secret = secret;
        c.setBusy(true);
        var request = editing
          ? api("PATCH", "/api/machines/" + encodeURIComponent(item.id), payload)
          : api("POST", "/api/machines", Object.assign({ kind: "server" }, payload));
        request
          .then(function (res) {
            c.setBusy(false);
            if (!res.data || !res.data.ok) {
              c.setError((res.data && res.data.error) || "保存失败，请重试");
              return;
            }
            c.close();
            if (!editing && res.data.machine && res.data.machine.id) {
              var created = res.data.machine;
              load().then(function () { probeServer(created, null); });
            } else {
              load();
            }
          })
          .catch(function () {
            c.setBusy(false);
            c.setError("网络异常，请重试");
          });
      },
    });
    var slot = ctrl.form.querySelector("[data-secret-slot]");
    ctrl.form.addEventListener("change", function (event) {
      var t = event.target;
      if (t && t.name === "auth_type" && slot) {
        slot.innerHTML = secretFieldHtml(t.value === "key" ? "key" : "password", editing);
      }
    });
  }

  // ---- 分组（全板块共用一个池，scope=machines） ----

  function openGroupDialog(group) {
    var editing = !!group;
    C.openFormDialog({
      title: editing ? "分组改名" : "添加分组",
      bodyHtml: "<label>分组名<input name=\"name\" maxlength=\"64\" autocomplete=\"off\" value=\"" + (editing ? C.escapeHtml(group.name) : "") + "\" /></label>",
      submitLabel: editing ? "保存" : "添加分组",
      onSubmit: function (ctrl) {
        var name = val(ctrl, "name");
        if (!name) { ctrl.setError("请填写分组名"); return; }
        ctrl.setBusy(true);
        var request = editing
          ? api("PATCH", "/api/groups/" + encodeURIComponent(group.id), { name: name })
          : api("POST", "/api/groups", { scope: "machines", name: name });
        request
          .then(function (res) {
            ctrl.setBusy(false);
            if (!res.data || !res.data.ok) { ctrl.setError((res.data && res.data.error) || "保存失败，请重试"); return; }
            ctrl.close();
            load();
          })
          .catch(function () { ctrl.setBusy(false); ctrl.setError("网络异常，请重试"); });
      },
    });
  }

  function deleteGroupFlow(group, btn) {
    var section = btn.closest("section");
    var slot = section ? section.querySelector('[data-confirm-group="' + group.id + '"]') : null;
    C.askConfirm({
      anchor: slot || btn,
      title: "删除分组",
      text: "确认删除分组「" + group.name + "」吗？组内条目会回到未分组，不会被删除",
      confirmLabel: "删除",
      danger: true,
    }).then(function (yes) {
      if (!yes) return;
      api("DELETE", "/api/groups/" + encodeURIComponent(group.id)).then(function (res) {
        if (res.data && res.data.ok) load();
      });
    });
  }

  function openGroupMoveDialog(item) {
    C.openFormDialog({
      title: "设置分组",
      bodyHtml: "<label>分组" + C.groupSelect("group_id", state.groups, item.group_id || "") + "</label>",
      submitLabel: "保存",
      onSubmit: function (ctrl) {
        ctrl.setBusy(true);
        api("PATCH", "/api/machines/" + encodeURIComponent(item.id), { group_id: val(ctrl, "group_id") || null })
          .then(function (res) {
            ctrl.setBusy(false);
            if (!res.data || !res.data.ok) { ctrl.setError((res.data && res.data.error) || "保存失败，请重试"); return; }
            ctrl.close();
            C.closeCurrentOverlay();
            load();
          })
          .catch(function () { ctrl.setBusy(false); ctrl.setError("网络异常，请重试"); });
      },
    });
  }

  // ---- 云主机：服务商连接（第二阶段） ----

  function connectionsSection() {
    if (!state.loaded || !state.connections.length) return "";
    var cards = state.connections.map(function (conn) {
      var id = C.escapeHtml(conn.id);
      var facts = [
        ["服务商", C.escapeHtml(conn.provider_label)],
        ["凭据", conn.config_tail ? "末四位 " + C.escapeHtml(conn.config_tail) : "未保存"],
        ["已接入设备", String(conn.device_count) + " 台"],
        ["最近测试", conn.last_test_at ? (conn.last_test_ok ? "成功 · " : "失败 · ") + (C.formatMinute(conn.last_test_at) || "") : "尚未测试"],
      ];
      if (!conn.last_test_ok && conn.last_error) facts.push(["失败原因", C.escapeHtml(conn.last_error)]);
      var actions =
        "<button type=\"button\" class=\"secondary\" data-conn=\"test\" data-id=\"" + id + "\">测试连接</button>" +
        "<button type=\"button\" class=\"secondary\" data-conn=\"sync\" data-id=\"" + id + "\">同步</button>" +
        "<button type=\"button\" class=\"danger\" data-conn=\"delete\" data-id=\"" + id + "\">删除连接</button>";
      return C.record({ id: conn.id, icon: "layout", title: conn.name, facts: facts, actions: actions });
    });
    return C.section("服务商连接", String(state.connections.length) + " 个", C.cardList(cards.join("")));
  }

  function connectionAction(conn, act, btn) {
    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = act === "sync" ? "正在同步…" : "正在测试…";
    api("POST", "/api/machines/providers/" + encodeURIComponent(conn.id) + "/" + act)
      .then(function () { load(); })
      .catch(function () { btn.disabled = false; btn.textContent = original; load(); });
  }

  function deleteConnection(conn, anchor) {
    C.askConfirm({
      anchor: anchor,
      title: "删除服务商连接",
      text: "确认删除连接「" + conn.name + "」吗？已接入的设备会保留为普通云主机条目，不会被删除",
      confirmLabel: "删除连接",
      danger: true,
    }).then(function (yes) {
      if (!yes) return;
      api("DELETE", "/api/machines/providers/" + encodeURIComponent(conn.id)).then(function (res) {
        if (res.data && res.data.ok) load();
      });
    });
  }

  function openCloudAliasDialog(item) {
    C.openFormDialog({
      title: "编辑本地别名",
      bodyHtml:
        "<label>本地名称<input name=\"name\" maxlength=\"60\" autocomplete=\"off\" value=\"" + C.escapeHtml(item.name) + "\" /></label>" +
        "<label>备注<input name=\"note\" maxlength=\"200\" autocomplete=\"off\" value=\"" + C.escapeHtml(item.note || "") + "\" /></label>" +
        "<label>绑定<input name=\"binding\" maxlength=\"60\" autocomplete=\"off\" value=\"" + C.escapeHtml(item.binding || "") + "\" /></label>" +
        "<label>分组" + C.groupSelect("group_id", state.groups, item.group_id || "") + "</label>" +
        "<p class=\"subtle\">远端名称：" + C.escapeHtml(item.remote_name || "") + "（由服务商同步，不在这里改）</p>",
      submitLabel: "保存",
      onSubmit: function (ctrl) {
        var name = val(ctrl, "name");
        if (!name) { ctrl.setError("请填写本地名称"); return; }
        ctrl.setBusy(true);
        api("PATCH", "/api/machines/" + encodeURIComponent(item.id), { name: name, note: val(ctrl, "note"), binding: val(ctrl, "binding"), group_id: val(ctrl, "group_id") || null })
          .then(function (res) {
            ctrl.setBusy(false);
            if (!res.data || !res.data.ok) { ctrl.setError((res.data && res.data.error) || "保存失败，请重试"); return; }
            ctrl.close();
            load();
          })
          .catch(function () { ctrl.setBusy(false); ctrl.setError("网络异常，请重试"); });
      },
    });
  }

  // 添加云主机向导：选服务商 → 填配置 → 测试并拉设备 → 勾选 → 保存。
  // 测试不过或改过配置（测试结果作废）时，onSubmit 会拦下不让保存。
  function wizardConfigFields(provider) {
    if (provider === "mcp") {
      return (
        "<label>MCP 端点<input data-wiz-field=\"endpoint\" maxlength=\"500\" autocomplete=\"off\" placeholder=\"例如 https://example.com/mcp\" /></label>" +
        "<label>令牌<input data-wiz-field=\"token\" type=\"password\" maxlength=\"2000\" autocomplete=\"off\" placeholder=\"无鉴权的端点可留空\" /></label>" +
        "<label>设备列表工具名<input data-wiz-field=\"toolName\" maxlength=\"200\" autocomplete=\"off\" placeholder=\"例如 list_devices\" /></label>"
      );
    }
    return (
      "<label>Access Key<input data-wiz-field=\"accessKey\" maxlength=\"200\" autocomplete=\"off\" /></label>" +
      "<label>Secret Key<input data-wiz-field=\"secretKey\" type=\"password\" maxlength=\"500\" autocomplete=\"off\" /></label>" +
      "<label>区域<input data-wiz-field=\"region\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 cn-north-4\" /></label>" +
      "<label>Project ID<input data-wiz-field=\"projectId\" maxlength=\"200\" autocomplete=\"off\" /></label>" +
      "<details><summary>高级</summary><label>接口地址<input data-wiz-field=\"endpoint\" maxlength=\"300\" autocomplete=\"off\" placeholder=\"留空用官方地址\" /></label></details>"
    );
  }

  function openCloudWizard() {
    var wiz = { provider: "huawei", tested: false, devices: [] };
    var ctrl = C.openFormDialog({
      title: "添加云主机",
      wide: true,
      bodyHtml:
        "<fieldset class=\"auth-type\"><legend>服务商</legend>" +
        "<label><input type=\"radio\" name=\"wiz_provider\" value=\"huawei\" checked /> 华为云（API）</label>" +
        "<label><input type=\"radio\" name=\"wiz_provider\" value=\"mcp\" /> MCP 通用</label>" +
        "<label><input type=\"radio\" name=\"wiz_provider\" value=\"other\" disabled /> 阿里云（即将支持）</label>" +
        "<label><input type=\"radio\" name=\"wiz_provider\" value=\"other2\" disabled /> 腾讯云（即将支持）</label>" +
        "</fieldset>" +
        "<div data-wiz-config>" + wizardConfigFields("huawei") + "</div>" +
        "<label>连接名称（可留空）<input name=\"conn_name\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"留空按服务商与区域自动命名\" /></label>" +
        "<label>导入到分组" + C.groupSelect("group_id", state.groups, "") + "</label>" +
        "<div class=\"manage-actions\"><button type=\"button\" class=\"secondary\" data-wiz-test>测试连接</button><span class=\"subtle\" data-wiz-status>尚未测试</span></div>" +
        "<div data-wiz-devices></div>",
      submitLabel: "保存",
      onSubmit: function (c) {
        if (!wiz.tested) { c.setError("请先点「测试连接」，拉到设备列表后才能保存"); return; }
        var ids = [];
        c.form.querySelectorAll("[data-wiz-device]:checked").forEach(function (box) { ids.push(box.getAttribute("data-wiz-device")); });
        if (!ids.length) { c.setError("请至少勾选一台要接入的设备"); return; }
        c.setBusy(true);
        api("POST", "/api/machines/providers", {
          provider: wiz.provider,
          name: val(c, "conn_name"),
          config: wiz.config || {},
          device_ids: ids,
          group_id: val(c, "group_id") || null,
        })
          .then(function (res) {
            c.setBusy(false);
            if (!res.data || !res.data.ok) { c.setError((res.data && res.data.error) || "保存失败，请重试"); return; }
            c.close();
            load();
          })
          .catch(function () { c.setBusy(false); c.setError("网络异常，请重试"); });
      },
    });
    var form = ctrl.form;
    var configBox = form.querySelector("[data-wiz-config]");
    var statusEl = form.querySelector("[data-wiz-status]");
    var devicesBox = form.querySelector("[data-wiz-devices]");
    function invalidate(message) {
      wiz.tested = false;
      wiz.devices = [];
      devicesBox.innerHTML = "";
      statusEl.textContent = message || "尚未测试";
    }
    function readConfig() {
      var config = {};
      form.querySelectorAll("[data-wiz-field]").forEach(function (el) {
        config[el.getAttribute("data-wiz-field")] = el.value.trim();
      });
      return config;
    }
    form.addEventListener("change", function (event) {
      var t = event.target;
      if (t && t.name === "wiz_provider") {
        wiz.provider = t.value;
        configBox.innerHTML = wizardConfigFields(wiz.provider);
        invalidate("尚未测试");
      }
    });
    form.addEventListener("input", function (event) {
      var t = event.target;
      if (t && t.hasAttribute("data-wiz-field") && wiz.tested) invalidate("配置已变更，请重新测试");
    });
    form.addEventListener("click", function (event) {
      var btn = event.target.closest("[data-wiz-test]");
      if (!btn) return;
      var config = readConfig();
      btn.disabled = true;
      statusEl.textContent = "正在测试…";
      devicesBox.innerHTML = "";
      api("POST", "/api/machines/providers/test", { provider: wiz.provider, config: config })
        .then(function (res) {
          btn.disabled = false;
          if (!res.data || !res.data.ok) {
            wiz.tested = false;
            statusEl.textContent = "测试失败：" + ((res.data && res.data.error) || "请稍后重试");
            return;
          }
          wiz.tested = true;
          wiz.config = config;
          wiz.devices = res.data.devices || [];
          statusEl.textContent = "测试成功，共 " + wiz.devices.length + " 台设备可接入";
          devicesBox.innerHTML = wiz.devices.map(function (device) {
            var meta = [device.status === "running" ? "运行中" : "已停止", device.os, device.spec, device.ip].filter(Boolean).join(" · ");
            return "<label><input type=\"checkbox\" data-wiz-device=\"" + C.escapeHtml(device.remoteId) + "\" /> " + C.escapeHtml(device.name || device.remoteId) + (meta ? "（" + C.escapeHtml(meta) + "）" : "") + "</label>";
          }).join("");
        })
        .catch(function () {
          btn.disabled = false;
          wiz.tested = false;
          statusEl.textContent = "测试失败：网络异常，请重试";
        });
    });
  }

  // 查看 SSH 密码：走 reveal 接口拿明文（服务端记审计），与保险库同口径
  function openRevealDialog(item) {
    var ctrl = C.openFormDialog({
      title: "查看 SSH 密码",
      bodyHtml: C.emptyState("正在读取", "马上就好"),
      submitLabel: "关闭",
      onSubmit: function (c) { c.close(); },
    });
    api("POST", "/api/machines/" + encodeURIComponent(item.id) + "/reveal")
      .then(function (result) {
        if (!result.data || !result.data.ok) {
          ctrl.setBody(C.emptyState("读取失败", (result.data && result.data.error) || "请稍后重试"));
          return;
        }
        var value = result.data.reveal.secret;
        var secretHtml = value
          ? C.copyLine(value, "复制密码")
          : "<p class=\"subtle\">还没有保存 SSH 密码或私钥</p>";
        var facts = [
          ["主机", C.escapeHtml((item.ssh_host || item.ip || "未填写") + (item.ssh_port ? ":" + item.ssh_port : ""))],
          ["用户名", C.escapeHtml(result.data.reveal.ssh_user || "未填写")],
          ["密码末四位", C.escapeHtml(item.ssh_tail || "无")],
          ["更新时间", C.escapeHtml(C.formatMinute(item.updated_at) || "—")],
        ];
        ctrl.setBody(secretHtml + C.record({ id: item.id, title: item.name, facts: facts }));
      })
      .catch(function () {
        ctrl.setBody(C.emptyState("读取失败", "网络异常，请重试"));
      });
  }

  // 查看 Workers：服务端用存好的令牌实时拉取，失败把 Cloudflare 的错误原样展示
  function openWorkersDialog(item) {
    var ctrl = C.openFormDialog({
      title: item.name + " 名下的 Workers",
      wide: true,
      bodyHtml: C.emptyState("正在读取", "马上就好"),
      submitLabel: "关闭",
      onSubmit: function (c) { c.close(); },
    });
    if (!item.api_token_tail) {
      ctrl.setBody(C.emptyState("还没有保存 API 令牌", "先在编辑里补上 Cloudflare 账号 ID 与 API 令牌，再来查看名下 Workers"));
      return;
    }
    api("POST", "/api/machines/" + encodeURIComponent(item.id) + "/workers")
      .then(function (result) {
        if (!result.data || !result.data.ok) {
          ctrl.setBody(C.emptyState("读取失败", (result.data && result.data.error) || "请稍后重试"));
          return;
        }
        var workers = result.data.workers || [];
        if (!workers.length) {
          ctrl.setBody(C.emptyState("这个账号下还没有 Workers", "拉取于 " + (C.formatMinute(result.data.fetched_at) || "刚刚")));
          return;
        }
        var rows = workers.map(function (w) {
          var modified = w.modified_on ? String(w.modified_on).slice(0, 10) + " " + String(w.modified_on).slice(11, 16) : "未记录";
          return C.record({ id: w.name, title: w.name, facts: [["更新时间", C.escapeHtml(modified)]] });
        }).join("");
        ctrl.setBody(
          "<p class=\"subtle\">拉取于 " + C.escapeHtml(C.formatMinute(result.data.fetched_at) || "刚刚") + "，共 " + workers.length + " 个</p>" + C.list(rows)
        );
      })
      .catch(function () {
        ctrl.setBody(C.emptyState("读取失败", "网络异常，请重试"));
      });
  }

  var page = document.getElementById("page");
  page.addEventListener("click", handleClick);

  function handleClick(event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var tab = target.closest(".page-tab");
    if (tab) {
      activeTab = tab.getAttribute("data-tab");
      history.replaceState(null, "", "#" + activeTab);
      render();
      return;
    }
    var addGroupBtn = target.closest("[data-add-group]");
    if (addGroupBtn) { openGroupDialog(null); return; }
    var mgroup = target.closest("[data-mgroup]");
    if (mgroup) {
      var mgroupId = mgroup.getAttribute("data-id");
      var mgroupFound = null;
      state.groups.forEach(function (entry) { if (entry.id === mgroupId) mgroupFound = entry; });
      if (mgroupFound) {
        if (mgroup.getAttribute("data-mgroup") === "rename") openGroupDialog(mgroupFound);
        else deleteGroupFlow(mgroupFound, mgroup);
      }
      return;
    }
    var add = target.closest("[data-add]");
    if (add) {
      var addKind = add.getAttribute("data-add");
      if (addKind === "server") openServerDialog(null);
      else if (addKind === "host") openCloudWizard();
      else openItemDialog(addKind, null);
      return;
    }
    var zone = target.closest("[data-manage]");
    if (zone && !target.closest("button, a, input, select, textarea")) {
      openManage(zone.getAttribute("data-manage"));
      return;
    }
    var connBtn = target.closest("[data-conn]");
    if (connBtn) {
      var connId = connBtn.getAttribute("data-id");
      var connAct = connBtn.getAttribute("data-conn");
      var conn = null;
      state.connections.forEach(function (entry) { if (entry.id === connId) conn = entry; });
      if (conn) {
        if (connAct === "delete") deleteConnection(conn, connBtn);
        else connectionAction(conn, connAct, connBtn);
      }
      return;
    }
    var mact = target.closest("[data-mact]");
    if (mact) {
      var mkind = mact.getAttribute("data-kind");
      var mid = mact.getAttribute("data-id");
      var found = null;
      state.items.forEach(function (entry) { if (entry.id === mid) found = entry; });
      if (found) {
        var act = mact.getAttribute("data-mact");
        if (act === "probe") probeServer(found, mact);
        else if (act === "reveal") openRevealDialog(found);
        else if (act === "workers") openWorkersDialog(found);
        else if (act === "group") openGroupMoveDialog(found);
        else if (act === "edit") {
          if (mkind === "server") openServerDialog(found);
          else if (mkind === "host" && found.connection_id) openCloudAliasDialog(found);
          else openItemDialog(mkind, found);
        }
        else if (act === "delete") deleteMachine(mkind, found, mact);
      }
    }
  }
  render();
  load();
})();
