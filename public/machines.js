/* 云主机板块三页签（服务器 / 云主机 / Workers），数据走 /api/machines。
   状态、最近心跳是运行态字段（由 Agent 经 MCP 上报），表单里不出现；
   绑定是普通文本字段，随添加/编辑一起保存。
   二期接入：服务器存 SSH 信息（密码或私钥加密保存，卡片只展示备注、主机名、
   系统与主机 IP，用户名只在编辑弹窗里出现，密码经「查看 SSH 密码」走
   reveal 接口）；云主机只记厂商与接入方式备注；Workers 存 Cloudflare
   账号 ID 与 API 令牌（加密保存），可实时查看该账号名下的 Workers。 */
(function () {
  var C = window.HiveCommon;
  var activeTab = location.hash === "#hosts" ? "hosts" : location.hash === "#workers" ? "workers" : "servers";
  var API_KIND = { server: "server", host: "cloud", worker: "worker" };
  var TITLE_FOR = { server: "服务器", host: "云主机", worker: "Worker" };

  var state = { items: [], loaded: false, loadError: "" };

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
        row("Cloudflare 账号", C.escapeHtml(item.cf_account_id || "未填写")) +
        row("API 令牌", item.api_token_tail ? "末四位 " + C.escapeHtml(item.api_token_tail) : "未填写") +
        row("版本", C.escapeHtml(item.version || "未记录")) +
        row("更新时间", C.escapeHtml(C.formatMinute(item.updated_at) || "—"));
    } else {
      facts =
        row("厂商", C.escapeHtml(item.vendor || "未填写")) +
        row("接入备注", C.escapeHtml(item.access_note || "无")) +
        row("地域", C.escapeHtml(item.region || "未填写"));
    }
    var btns = "";
    if (kind !== "cloud")
      btns += "<button type=\"button\" class=\"secondary\" data-mact=\"edit\" data-kind=\"" + kind + "\" data-id=\"" + id + "\">编辑</button>";
    btns += "<button type=\"button\" class=\"danger\" data-confirm-delete data-mact=\"delete\" data-kind=\"" + kind + "\" data-id=\"" + id + "\">删除</button>";
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

  function card(kind, item, facts) {
    var lede = kind === "worker" ? item.description : item.region;
    var id = C.escapeHtml(item.id);
    var actions = "";
    if (kind === "server") {
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


  function listSection(uiKind, title, unit) {
    var items = byKind(uiKind);
    if (!state.loaded) return C.section(title, "", C.emptyState("正在加载", "正在读取云主机数据"));
    if (state.loadError) return C.section(title, "", '<p class="callout danger" role="alert">' + C.escapeHtml(state.loadError) + "</p>");
    var cards;
    if (uiKind === "worker") {
      cards = items.map(function (item) {
        var facts = [["版本", C.escapeHtml(item.version || "未记录")], ["更新时间", C.escapeHtml(C.formatMinute(item.updated_at) || "—")]];
        if (item.cf_account_id) facts.push(["Cloudflare 账号", C.escapeHtml(item.cf_account_id)]);
        if (item.api_token_tail) facts.push(["API 令牌", "末四位 " + C.escapeHtml(item.api_token_tail)]);
        return card("worker", item, facts);
      });
    } else if (uiKind === "server") {
      cards = items.map(function (item) {
        return card("server", item, [
          ["备注", C.escapeHtml(item.note || "无")],
          ["主机名", C.escapeHtml(item.hostname || "未填写")],
          ["系统", C.escapeHtml(item.os || "未填写")],
          ["主机 IP", C.escapeHtml(item.ip || "未填写")],
        ]);
      });
    } else {
      cards = items.map(function (item) {
        var facts = [
          ["规格", C.escapeHtml(item.spec)],
          ["绑定", C.escapeHtml(item.binding || "未绑定")],
          ["最近心跳", C.escapeHtml(heartbeatText(item))],
        ];
        if (item.note) facts.push(["备注", C.escapeHtml(item.note)]);
        if (item.vendor) facts.push(["厂商", C.escapeHtml(item.vendor)]);
        if (item.access_note) facts.push(["接入备注", C.escapeHtml(item.access_note)]);
        return card(uiKind, item, facts);
      });
    }
    return C.section(title, String(items.length) + " " + unit, C.cardList(cards.join("")));
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
    return api("GET", "/api/machines")
      .then(function (res) {
        state.loaded = true;
        if (res.data && res.data.ok) {
          state.items = res.data.machines || [];
          state.loadError = "";
        } else {
          state.loadError = (res.data && res.data.error) || "云主机数据读取失败";
        }
        render();
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
        "<label>绑定<input name=\"binding\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 值守（留空为未绑定）\" value=\"" + C.escapeHtml(item ? v.binding || "" : "") + "\" /></label>"
      );
    }
    return (
      nameField +
      "<label>说明<input name=\"lede\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 本控制面\" value=\"" + C.escapeHtml(v.description || "") + "\" /></label>" +
      "<label>Cloudflare 账号 ID<input name=\"cf_account_id\" maxlength=\"64\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.cf_account_id || "") + "\" /></label>" +
      "<label>API 令牌<input name=\"api_token\" type=\"password\" maxlength=\"16384\" autocomplete=\"off\" placeholder=\"" + (item ? "留空表示不修改" : "有 Workers 读取权限的令牌") + "\" /></label>"
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
          };
        } else {
          payload = {
            name: name,
            description: val(ctrl, "lede"),
            cf_account_id: val(ctrl, "cf_account_id"),
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
    var add = target.closest("[data-add]");
    if (add) {
      openItemDialog(add.getAttribute("data-add"), null);
      return;
    }
    var zone = target.closest("[data-manage]");
    if (zone && !target.closest("button, a, input, select, textarea")) {
      openManage(zone.getAttribute("data-manage"));
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
        if (act === "reveal") openRevealDialog(found);
        else if (act === "workers") openWorkersDialog(found);
        else if (act === "edit") openItemDialog(mkind, found);
        else if (act === "delete") deleteMachine(mkind, found, mact);
      }
    }
  }
  render();
  load();
})();
