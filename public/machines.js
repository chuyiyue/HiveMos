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

  var REMOTE_STATE_LABELS = {
    creating: "创建中", starting: "启动中", running: "运行中", stopping: "停止中",
    stopped: "已停止", suspending: "暂停中", suspended: "已暂停", resuming: "恢复中",
    deleting: "删除中", deleted: "已删除", error: "运行异常",
  };
  function remoteStateOf(item) {
    if (item.remote_state) return item.remote_state;
    return item.status === "running" ? "running" : "stopped";
  }
  function remoteStateLabel(item) {
    return REMOTE_STATE_LABELS[remoteStateOf(item)] || (item.status === "running" ? "运行中" : "已停止");
  }
  function powerFor(item) {
    var st = remoteStateOf(item);
    if (st === "stopped" || st === "error") return { label: "启动", action: "start" };
    if (st === "suspended") return { label: "恢复", action: "resume" };
    if (st === "running") return { label: "暂停", action: "suspend" };
    return { label: remoteStateLabel(item), action: "" };
  }
  function findMachine(id) {
    var found = null;
    state.items.forEach(function (entry) { if (entry.id === id) found = entry; });
    return found;
  }

  function connName(item) {
    if (!item || !item.connection_id) return "";
    var found = null;
    state.connections.forEach(function (conn) { if (conn.id === item.connection_id) found = conn; });
    return found ? found.name : "";
  }

  function openMachineManage(kind, item) {
    var id = C.escapeHtml(item.id);
    function row(label, valueHtml) {
      return "<div><dt>" + label + "</dt><dd>" + valueHtml + "</dd></div>";
    }
    var facts = "";
    if (kind === "server") {
      facts =
        row("备注", C.escapeHtml(item.note || "无")) +
        row("主机名", C.escapeHtml(item.hostname || "未填写")) +
        row("系统", C.escapeHtml(item.os || "未填写")) +
        row(
          "主机 IP",
          C.escapeHtml(item.ip || "未填写") +
            (item.ip
              ? " <button type=\"button\" class=\"copy-btn\" data-copy=\"" + C.escapeHtml(item.ip) + "\" data-label=\"复制\">复制</button>"
              : "")
        );
    } else if (kind === "worker") {
      facts =
        row("平台", item.platform === "vercel" ? "Vercel" : "Cloudflare") +
        (item.platform === "vercel"
          ? row("Team ID", C.escapeHtml(item.team_id || "个人账号"))
          : row("Cloudflare 账号", C.escapeHtml(item.cf_account_id || "未填写"))) +
        row("API 令牌", item.api_token_tail ? "末四位 " + C.escapeHtml(item.api_token_tail) : "未填写") +
        row("版本", C.escapeHtml(item.version || "未记录")) +
        row("更新时间", C.escapeHtml(C.formatMinute(item.updated_at) || "—"));
    } else if (item.connection_id) {
      facts =
        row("来源", C.escapeHtml(connName(item) || "服务商连接")) +
        (item.remote_name ? row("远端名称", C.escapeHtml(item.remote_name)) : "") +
        row("最近同步", C.escapeHtml(item.last_sync_at ? C.formatMinute(item.last_sync_at) || "—" : "尚未同步"));
    } else {
      facts =
        row("厂商", C.escapeHtml(item.vendor || "未填写")) +
        row("接入备注", C.escapeHtml(item.access_note || "无")) +
        row("地域", C.escapeHtml(item.region || "未填写"));
    }
    // 按钮排序：本机操作 → 来源连接 → 日常管理 → 删除类垫底
    var btns = "";
    if (kind === "server") {
      btns += "<button type=\"button\" class=\"secondary\" data-mact=\"probe\" data-kind=\"server\" data-id=\"" + id + "\">测试连接</button>";
      btns += "<button type=\"button\" class=\"secondary\" data-mact=\"reveal\" data-kind=\"server\" data-id=\"" + id + "\">查看 SSH 密码</button>";
    }
    if (kind === "worker") {
      btns += "<button type=\"button\" class=\"secondary\" data-mact=\"workers\" data-kind=\"worker\" data-id=\"" + id + "\">" + (item.platform === "vercel" ? "查看项目" : "查看 Workers") + "</button>";
    }
    var connId = item.connection_id ? C.escapeHtml(item.connection_id) : "";
    if (connId) {
      btns += "<button type=\"button\" class=\"secondary\" data-conn=\"test\" data-id=\"" + connId + "\">测试连接</button>";
      btns += "<button type=\"button\" class=\"secondary\" data-conn=\"sync\" data-id=\"" + connId + "\">同步连接</button>";
    }
    btns += "<button type=\"button\" class=\"secondary\" data-mact=\"group\" data-kind=\"" + kind + "\" data-id=\"" + id + "\">设置分组</button>";
    btns += "<button type=\"button\" class=\"secondary\" data-mact=\"edit\" data-kind=\"" + kind + "\" data-id=\"" + id + "\">编辑</button>";
    btns += "<button type=\"button\" class=\"danger\" data-confirm-delete data-mact=\"delete\" data-kind=\"" + kind + "\" data-id=\"" + id + "\">删除</button>";
    if (connId) {
      btns += "<button type=\"button\" class=\"danger\" data-conn=\"delete\" data-id=\"" + connId + "\">删除连接</button>";
    }
    var kindLabel = kind === "server" ? "服务器" : kind === "worker" ? "Worker" : "云主机";
    var ctrl = C.openManageDialog({
      title: item.name,
      bodyHtml:
        C.manageInfoHead({
          icon: kind === "worker" ? "layout" : "monitor",
          title: item.name,
          sub: kindLabel + (item.region && kind !== "worker" ? " · " + item.region : ""),
        }) +
        "<div class=\"manage-info-card\"><dl class=\"kv\">" +
        facts +
        "</dl></div>" +
        (kind === "server" ? C.record({ id: item.id, title: "探活信息", facts: probeFactsRows(item) }) : "") +
        "<div class=\"manage-actions\">" +
        btns +
        "</div>",
    });
    ctrl.dialog.addEventListener("click", handleClick);
  }

  function deleteMachine(kind, item, anchor) {
    var dlg = anchor && anchor.closest ? anchor.closest("[data-manage-dialog]") : null;
    var mount = (dlg && dlg.querySelector("[data-manage-confirm]")) || anchor;
    
      api("DELETE", "/api/machines/" + encodeURIComponent(item.id)).then(function (res) {
        if (res.data && res.data.ok) { C.closeCurrentOverlay(); load(); }
      });
    
  }

  function card(kind, item, facts, actionsOverride) {
    var lede = kind === "worker" ? item.description : item.region;
    var id = C.escapeHtml(item.id);
    var actions = "";
    if (kind === "server") {
      actions += "<button type=\"button\" class=\"secondary\" data-mact=\"probe\" data-kind=\"server\" data-id=\"" + id + "\">测试连接</button>";
      actions += "<button type=\"button\" class=\"secondary\" data-mact=\"reveal\" data-kind=\"server\" data-id=\"" + id + "\">查看密码</button>";
      if (item.ip) actions += "<button type=\"button\" class=\"secondary\" data-copy=\"" + C.escapeHtml(item.ip) + "\" data-label=\"复制 IP\">复制 IP</button>";
    } else if (kind === "worker") {
      actions += "<button type=\"button\" class=\"secondary\" data-mact=\"workers\" data-kind=\"worker\" data-id=\"" + id + "\">" + (item.platform === "vercel" ? "查看项目" : "查看 Workers") + "</button>";
    } else if (actionsOverride !== undefined) {
      actions = actionsOverride;
    } else {
      actions += "<button type=\"button\" class=\"secondary\" data-mact=\"edit\" data-kind=\"" + kind + "\" data-id=\"" + id + "\">编辑</button>";
    }
    return C.record({
      id: item.id,
      icon: kind === "worker" ? "layout" : "monitor",
      title: item.name,
      pill: kind === "host" ? connName(item) || undefined : undefined,
      status: item.status,
      statusText: item.connection_id ? remoteStateLabel(item) : undefined,
      lede: lede || "",
      facts: facts,
      actions: actions,
      manage: "machine:" + kind + ":" + item.id,
    });
  }


  function cardFor(uiKind, item) {
    if (uiKind === "worker") {
      var facts = [["平台", item.platform === "vercel" ? "Vercel" : "Cloudflare"], ["版本", C.escapeHtml(item.version || "未记录")], ["更新时间", C.escapeHtml(C.formatMinute(item.updated_at) || "—")]];
      if (item.platform === "vercel") {
        if (item.team_id) facts.push(["Team ID", C.escapeHtml(item.team_id)]);
      } else if (item.cf_account_id) facts.push(["Cloudflare 账号", C.escapeHtml(item.cf_account_id)]);
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
      var connFacts = [
        ["状态", C.escapeHtml(remoteStateLabel(item))],
        ["规格", C.escapeHtml(item.spec || "未同步")],
        ["最近同步", C.escapeHtml(item.last_sync_at ? C.formatMinute(item.last_sync_at) || "—" : "尚未同步")],
      ];
      if (item.remote_name && item.remote_name !== item.name) connFacts.push(["远端名称", C.escapeHtml(item.remote_name)]);
      var pw = powerFor(item);
      var pid = C.escapeHtml(item.id);
      var quick =
        (pw.action
          ? "<button type=\"button\" class=\"secondary\" data-mpower=\"" + pw.action + "\" data-id=\"" + pid + "\">" + pw.label + "</button>"
          : "<button type=\"button\" class=\"secondary\" disabled>" + pw.label + "</button>") +
        "<button type=\"button\" class=\"secondary\" data-mports data-id=\"" + pid + "\">端口转发</button>" +
        "<button type=\"button\" class=\"secondary\" data-mkeep data-id=\"" + pid + "\">保活</button>";
      return card(uiKind, item, connFacts, quick);
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
      (activeTab === "hosts" ? '<button type="button" class="secondary" data-providers>服务商管理</button>' : "") +
      '<button type="button" class="secondary add-group-button" data-add-group>添加分组</button>' +
      (activeTab === "servers"
        ? '<button type="button" class="add-button" data-add="server">添加服务器</button>'
        : activeTab === "hosts"
          ? '<button type="button" class="add-button" data-add="host">添加云主机</button>'
          : '<button type="button" class="add-button" data-add="worker">添加 Worker</button>') +
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
        refreshConnPanel();
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
  function workerPlatformFields(platform, v, editing) {
    v = v || {};
    var tokenField =
      "<label>API 令牌<input name=\"api_token\" type=\"password\" maxlength=\"16384\" autocomplete=\"off\" placeholder=\"" +
      (editing ? "留空表示不修改" : platform === "vercel" ? "有项目读取权限的 Vercel 令牌" : "有 Workers 读取权限的令牌") +
      "\" /></label>";
    if (platform === "vercel") {
      return (
        tokenField +
        "<label>Team ID（选填）<input name=\"team_id\" maxlength=\"64\" autocomplete=\"off\" placeholder=\"团队账号才需要，个人账号留空\" value=\"" +
        C.escapeHtml(v.team_id || "") +
        "\" /></label>"
      );
    }
    return (
      "<label>Cloudflare 账号 ID<input name=\"cf_account_id\" maxlength=\"64\" autocomplete=\"off\" value=\"" +
      C.escapeHtml(v.cf_account_id || "") +
      "\" /></label>" +
      tokenField
    );
  }

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
    var platform = v.platform === "vercel" ? "vercel" : "cloudflare";
    return (
      nameField +
      "<label>说明<input name=\"lede\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 本控制面\" value=\"" + C.escapeHtml(v.description || "") + "\" /></label>" +
      "<div class=\"auth-type\"><span>平台</span>" +
      "<div class=\"page-tabs auth-tabs\" role=\"tablist\" aria-label=\"平台\">" +
      "<button type=\"button\" class=\"page-tab\" role=\"tab\" data-wplatform=\"cloudflare\" aria-selected=\"" + (platform === "cloudflare" ? "true" : "false") + "\"" + (item ? " disabled" : "") + ">Cloudflare Workers</button>" +
      "<button type=\"button\" class=\"page-tab\" role=\"tab\" data-wplatform=\"vercel\" aria-selected=\"" + (platform === "vercel" ? "true" : "false") + "\"" + (item ? " disabled" : "") + ">Vercel</button>" +
      "</div>" +
      "<input type=\"hidden\" name=\"platform\" value=\"" + platform + "\" />" +
      "</div>" +
      "<div data-worker-fields>" + workerPlatformFields(platform, v, !!item) + "</div>" +
      "<label>分组" + C.groupSelect("group_id", state.groups, v.group_id || "") + "</label>"
    );
  }

  function openItemDialog(kind, item) {
    var editing = !!item;
    var dlg = C.openFormDialog({
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
          var platform = val(ctrl, "platform") || "cloudflare";
          payload = {
            name: name,
            description: val(ctrl, "lede"),
            platform: platform,
            group_id: val(ctrl, "group_id") || null,
          };
          if (platform === "vercel") payload.team_id = val(ctrl, "team_id");
          else payload.cf_account_id = val(ctrl, "cf_account_id");
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
    if (kind === "worker" && !editing) {
      dlg.form.addEventListener("click", function (event) {
        var tab = event.target.closest("[data-wplatform]");
        if (!tab || tab.disabled) return;
        var platform = tab.getAttribute("data-wplatform");
        dlg.form.querySelectorAll("[data-wplatform]").forEach(function (b) {
          b.setAttribute("aria-selected", b === tab ? "true" : "false");
        });
        var hidden = dlg.form.querySelector("[name=\"platform\"]");
        if (hidden) hidden.value = platform;
        var box = dlg.form.querySelector("[data-worker-fields]");
        if (box) box.innerHTML = workerPlatformFields(platform, null, false);
      });
    }
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
      "<div class=\"auth-type\"><span>认证方式</span>" +
      "<div class=\"page-tabs auth-tabs\" role=\"tablist\" aria-label=\"认证方式\">" +
      "<button type=\"button\" class=\"page-tab\" data-auth=\"password\" aria-selected=\"" + (authType === "password") + "\">密码</button>" +
      "<button type=\"button\" class=\"page-tab\" data-auth=\"key\" aria-selected=\"" + (authType === "key") + "\">密钥</button>" +
      "</div><input type=\"hidden\" name=\"auth_type\" value=\"" + authType + "\" /></div>" +
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
        var authInput = c.form.querySelector("[name=\"auth_type\"]");
        var authType = authInput && authInput.value === "key" ? "key" : "password";
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
    ctrl.form.addEventListener("click", function (event) {
      var t = event.target && event.target.closest ? event.target.closest("[data-auth]") : null;
      if (!t || !slot) return;
      var next = t.getAttribute("data-auth") === "key" ? "key" : "password";
      var hidden = ctrl.form.querySelector("[name=\"auth_type\"]");
      if (hidden) hidden.value = next;
      ctrl.form.querySelectorAll("[data-auth]").forEach(function (b) {
        b.setAttribute("aria-selected", b === t ? "true" : "false");
      });
      slot.innerHTML = secretFieldHtml(next, editing);
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
    return (
      "<label>API 密钥<input data-wiz-field=\"apiKey\" type=\"password\" maxlength=\"500\" autocomplete=\"off\" placeholder=\"InstaBox 的 API Key\" /></label>" +
      "<details><summary>高级</summary><label>接口地址<input data-wiz-field=\"endpoint\" maxlength=\"300\" autocomplete=\"off\" placeholder=\"留空用官方地址 api.instabox.sh\" /></label></details>"
    );
  }

  // ---- 接入设备快捷功能：电源 / 端口转发 / 保活 ----

  function powerMachine(btn) {
    var id = btn.getAttribute("data-id");
    var action = btn.getAttribute("data-mpower");
    var labels = { start: "启动", resume: "恢复", suspend: "暂停", stop: "停止" };
    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = "处理中…";
    api("POST", "/api/machines/" + encodeURIComponent(id) + "/power", { action: action })
      .then(function (res) {
        if (res.data && res.data.ok) {
          C.toast("已发送" + (labels[action] || "操作") + "指令，状态刷新中");
          return load();
        }
        C.toast((res.data && res.data.error) || "操作失败", "error");
      })
      .catch(function () { C.toast("操作失败", "error"); })
      .then(function () {
        btn.disabled = false;
        btn.textContent = original;
      });
  }

  function openPortsDialog(id) {
    var ctrl = C.openManageDialog({
      title: "端口转发",
      size: "md",
      bodyHtml: '<div data-ports-body>' + C.emptyState("正在读取", "稍等片刻") + "</div>",
    });
    var bodyEl = ctrl.bodyEl.querySelector("[data-ports-body]");
    function renderPorts(data) {
      var ports = data.ports || [];
      var rows = ports.length
        ? ports
            .map(function (p) {
              return (
                '<div class="port-row"><div class="port-main"><span class="port-name">' +
                C.escapeHtml(p.name || "未命名") +
                ' <span class="subtle">端口 ' +
                p.port +
                "</span></span>" +
                (p.url
                  ? '<a class="port-url" href="' + C.escapeHtml(p.url) + '" target="_blank" rel="noopener">' + C.escapeHtml(p.url) + "</a>"
                  : "") +
                '</div><button type="button" class="ghost" data-port-del="' +
                p.port +
                '">取消公开</button></div>'
              );
            })
            .join("")
        : C.emptyState("还没有公开的端口", "把机器上的服务端口公开后，会生成一个公网地址");
      bodyEl.innerHTML =
        (data.enabled === false ? '<p class="callout danger">这台机器的公网端口功能未开启</p>' : "") +
        rows +
        '<form class="port-add" data-port-form><label>端口<input name="port" type="number" min="1024" max="65535" placeholder="1024 – 65535" /></label>' +
        '<label>名称<input name="name" maxlength="100" placeholder="例如 Web 服务" /></label>' +
        '<button type="submit">公开端口</button></form>' +
        '<p class="subtle">5901 和 6768 是平台保留端口；每台机器最多公开 16 个</p>';
    }
    function refresh() {
      return api("GET", "/api/machines/" + encodeURIComponent(id) + "/ports").then(function (res) {
        if (res.data && res.data.ok) renderPorts(res.data);
        else bodyEl.innerHTML = C.emptyState("读取失败", (res.data && res.data.error) || "请稍后再试");
      });
    }
    ctrl.dialog.addEventListener("submit", function (event) {
      var form = event.target.closest("[data-port-form]");
      if (!form) return;
      event.preventDefault();
      var data = new FormData(form);
      api("POST", "/api/machines/" + encodeURIComponent(id) + "/ports", {
        port: Number(data.get("port")),
        name: String(data.get("name") || ""),
      }).then(function (res) {
        if (res.data && res.data.ok) {
          C.toast("端口已公开");
          refresh();
        } else C.toast((res.data && res.data.error) || "公开失败", "error");
      });
    });
    ctrl.dialog.addEventListener("click", function (event) {
      var del = event.target.closest("[data-port-del]");
      if (!del) return;
      var port = del.getAttribute("data-port-del");
      C.askConfirm(del, {
        title: "取消公开端口 " + port + "？",
        confirmLabel: "取消公开",
        danger: true,
        onConfirm: function () {
          return api("DELETE", "/api/machines/" + encodeURIComponent(id) + "/ports/" + port).then(function (res) {
            if (res.data && res.data.ok) {
              C.toast("已取消公开");
              refresh();
            } else C.toast((res.data && res.data.error) || "取消失败", "error");
          });
        },
      });
    });
    refresh();
  }

  function openKeepaliveDialog(id) {
    api("GET", "/api/machines/" + encodeURIComponent(id) + "/keepalive").then(function (res) {
      var policy = (res.data && res.data.keepalive) || { mode: "off", timezone: "Asia/Shanghai", windows: [] };
      var mode = policy.mode || "off";
      var windows = (policy.windows || []).map(function (w) { return { start: w.start, end: w.end }; });
      function windowsHtml() {
        return windows
          .map(function (w, i) {
            return (
              '<div class="keep-window"><input type="time" value="' +
              C.escapeHtml(w.start) +
              '" data-kw-start="' +
              i +
              '" /><span>至</span><input type="time" value="' +
              C.escapeHtml(w.end) +
              '" data-kw-end="' +
              i +
              '" /><button type="button" class="ghost" data-kw-del="' +
              i +
              '">删除</button></div>'
            );
          })
          .join("");
      }
      var ctrl = C.openFormDialog({
        title: "保活设置",
        bodyHtml:
          "<label>保活模式</label>" +
          '<div class="page-tabs" role="tablist">' +
          [
            ["off", "关闭"],
            ["always", "全天"],
            ["windows", "时段"],
          ]
            .map(function (opt) {
              return '<button type="button" class="page-tab" data-kmode="' + opt[0] + '" aria-selected="' + (mode === opt[0] ? "true" : "false") + '">' + opt[1] + "</button>";
            })
            .join("") +
          "</div>" +
          '<div data-kwindows' +
          (mode === "windows" ? "" : " hidden") +
          ">" +
          '<div data-kw-list>' +
          windowsHtml() +
          "</div>" +
          '<button type="button" class="secondary" data-kw-add>添加时段</button>' +
          '<label>时区<input name="timezone" autocomplete="off" value="' +
          C.escapeHtml(policy.timezone || "Asia/Shanghai") +
          '" /></label>' +
          "</div>" +
          (policy.last_result
            ? '<p class="subtle">上次检查：' + C.escapeHtml(policy.last_result) + (policy.last_checked_at ? " · " + C.escapeHtml(C.formatMinute(policy.last_checked_at) || "") : "") + "</p>"
            : "") +
          '<p class="subtle">保活时段内机器被停机或暂停时会自动拉起；定时检查随 Cron 一起生效，目前手动同步连接时也会顺带检查一次</p>',
        submitLabel: "保存",
        onSubmit: function (form) {
          syncWindowInputs();
          var tz = String(new FormData(form).get("timezone") || "Asia/Shanghai");
          return api("PUT", "/api/machines/" + encodeURIComponent(id) + "/keepalive", {
            mode: mode,
            timezone: tz,
            windows: mode === "windows" ? windows : [],
          }).then(function (res) {
            if (res.data && res.data.ok) {
              C.toast("保活设置已保存");
              return true;
            }
            throw new Error((res.data && res.data.error) || "保存失败");
          });
        },
      });
      function syncWindowInputs() {
        ctrl.dialog.querySelectorAll("[data-kw-start]").forEach(function (input) {
          var entry = windows[Number(input.getAttribute("data-kw-start"))];
          if (entry) entry.start = input.value;
        });
        ctrl.dialog.querySelectorAll("[data-kw-end]").forEach(function (input) {
          var entry = windows[Number(input.getAttribute("data-kw-end"))];
          if (entry) entry.end = input.value;
        });
      }
      ctrl.dialog.addEventListener("click", function (event) {
        var tab = event.target.closest("[data-kmode]");
        if (tab) {
          mode = tab.getAttribute("data-kmode");
          ctrl.dialog.querySelectorAll("[data-kmode]").forEach(function (b) {
            b.setAttribute("aria-selected", b === tab ? "true" : "false");
          });
          var kw = ctrl.dialog.querySelector("[data-kwindows]");
          if (kw) kw.hidden = mode !== "windows";
          return;
        }
        if (event.target.closest("[data-kw-add]")) {
          if (windows.length >= 5) {
            C.toast("最多 5 个时段", "error");
            return;
          }
          syncWindowInputs();
          windows.push({ start: "09:00", end: "18:00" });
          ctrl.dialog.querySelector("[data-kw-list]").innerHTML = windowsHtml();
          return;
        }
        var del = event.target.closest("[data-kw-del]");
        if (del) {
          syncWindowInputs();
          windows.splice(Number(del.getAttribute("data-kw-del")), 1);
          ctrl.dialog.querySelector("[data-kw-list]").innerHTML = windowsHtml();
        }
      });
    });
  }

  // 服务商管理悬浮面板：连接以与云主机相同的卡片呈现
  var connPanelCtrl = null;
  function connCardsHtml() {
    if (!state.connections.length) return C.emptyState("还没有服务商连接", "用「添加云主机」接入第一个来源");
    return (
      '<div class="card-grid">' +
      state.connections
        .map(function (conn) {
          var count = state.items.filter(function (it) { return it.connection_id === conn.id; }).length;
          var cid = C.escapeHtml(conn.id);
          return C.record({
            id: conn.id,
            icon: "layout",
            title: conn.name,
            pill: providerLabel(conn.provider),
            status: conn.last_test_at ? (conn.last_test_ok ? "running" : "error") : "unknown",
            statusText: conn.last_test_at ? (conn.last_test_ok ? "测试成功" : "测试失败") : "未测试",
            facts: [
              ["凭据", conn.secret_tail ? "末四位 " + C.escapeHtml(conn.secret_tail) : "已保存"],
              ["已接入设备", count + " 台"],
              ["最近测试", conn.last_test_at ? C.formatMinute(conn.last_test_at) || "—" : "尚未测试"],
            ],
            actions: [
              { label: "测试连接", attrs: 'data-conn="test" data-id="' + cid + '"' },
              { label: "同步", attrs: 'data-conn="sync" data-id="' + cid + '"' },
              { label: "删除连接", danger: true, attrs: 'data-conn="delete" data-id="' + cid + '"' },
            ],
          });
        })
        .join("") +
      "</div>"
    );
  }
  function openProvidersPanel() {
    connPanelCtrl = C.openManageDialog({
      title: "服务商管理",
      size: "md",
      bodyHtml: '<div data-conn-panel>' + connCardsHtml() + "</div>",
    });
    connPanelCtrl.dialog.addEventListener("click", handleClick);
  }
  function refreshConnPanel() {
    if (!connPanelCtrl || !connPanelCtrl.dialog.open) return;
    var slot = connPanelCtrl.bodyEl.querySelector("[data-conn-panel]");
    if (slot) slot.innerHTML = connCardsHtml();
  }

  function openCloudWizard() {
    var wiz = { provider: "instabox", tested: false, devices: [] };
    var ctrl = C.openFormDialog({
      title: "添加云主机",
      wide: true,
      actionsLeftHtml: "<button type=\"button\" class=\"secondary\" data-wiz-test>测试连接</button>",
      bodyHtml:
        "<div class=\"auth-type\"><span>服务商</span>" +
        "<div class=\"page-tabs auth-tabs\" role=\"tablist\" aria-label=\"服务商\">" +
        "<button type=\"button\" class=\"page-tab\" role=\"tab\" data-wiz-provider=\"instabox\" aria-selected=\"true\">InstaBox</button>" +
        "<button type=\"button\" class=\"page-tab\" role=\"tab\" data-wiz-provider=\"future\" aria-selected=\"false\" disabled>更多厂商（即将支持）</button>" +
        "</div></div>" +
        "<div data-wiz-config>" + wizardConfigFields("huawei") + "</div>" +
        "<label>连接名称（可留空）<input name=\"conn_name\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"留空按服务商自动命名\" /></label>" +
        "<label>导入到分组" + C.groupSelect("group_id", state.groups, "") + "</label>" +
        "<p class=\"subtle\" data-wiz-status>尚未测试</p>" +
        "<div class=\"wiz-devices\" data-wiz-devices></div>",
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
    form.addEventListener("click", function (event) {
      var tab = event.target.closest("[data-wiz-provider]");
      if (!tab || tab.disabled) return;
      form.querySelectorAll("[data-wiz-provider]").forEach(function (b) {
        b.setAttribute("aria-selected", b === tab ? "true" : "false");
      });
      wiz.provider = tab.getAttribute("data-wiz-provider");
      configBox.innerHTML = wizardConfigFields(wiz.provider);
      invalidate("尚未测试");
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
            return "<label class=\"wiz-device\"><input type=\"checkbox\" data-wiz-device=\"" + C.escapeHtml(device.remoteId) + "\" /><span class=\"wiz-device-main\"><span class=\"wiz-device-name\">" + C.escapeHtml(device.name || device.remoteId) + "</span>" + (meta ? "<span class=\"wiz-device-meta\">" + C.escapeHtml(meta) + "</span>" : "") + "</span></label>";
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
      title: item.name + (item.platform === "vercel" ? " 名下的项目" : " 名下的 Workers"),
      size: "md",
      bodyHtml: C.emptyState("正在读取", "马上就好"),
      submitLabel: "关闭",
      onSubmit: function (c) { c.close(); },
    });
    if (!item.api_token_tail) {
      ctrl.setBody(C.emptyState("还没有保存 API 令牌", item.platform === "vercel" ? "先在编辑里补上 API 令牌，再来查看名下项目" : "先在编辑里补上 Cloudflare 账号 ID 与 API 令牌，再来查看名下 Workers"));
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
          ctrl.setBody(C.emptyState(item.platform === "vercel" ? "这个账号下还没有项目" : "这个账号下还没有 Workers", "拉取于 " + (C.formatMinute(result.data.fetched_at) || "刚刚")));
          return;
        }
        var rows = workers.map(function (w) {
          var modified = w.modified_on ? String(w.modified_on).slice(0, 10) + " " + String(w.modified_on).slice(11, 16) : "未记录";
          var wfacts = w.meta ? [["框架", C.escapeHtml(w.meta)], ["更新时间", C.escapeHtml(modified)]] : [["更新时间", C.escapeHtml(modified)]];
          return C.record({ id: w.name, title: w.name, facts: wfacts });
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
    var provBtn = target.closest("[data-providers]");
    if (provBtn) return void openProvidersPanel();
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
    var pwBtn = target.closest("[data-mpower]");
    if (pwBtn && !pwBtn.disabled) return void powerMachine(pwBtn);
    var portsBtn = target.closest("[data-mports]");
    if (portsBtn) return void openPortsDialog(portsBtn.getAttribute("data-id"));
    var keepBtn = target.closest("[data-mkeep]");
    if (keepBtn) return void openKeepaliveDialog(keepBtn.getAttribute("data-id"));
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
