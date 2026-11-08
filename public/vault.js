/* 保险库板块：账号密码 / 模型网关 / 邮箱三页签都走 /api/vault 真后端。
   列表只显示条目名称与末四位口径的信息，密码/密钥明文只能经 reveal
   接口在弹窗里看，每次查看都会在访问记录里留一条。 */
(function () {
  var C = window.HiveCommon;
  var activeTab = location.hash === "#gateway" ? "gateway" : location.hash === "#email" ? "email" : "vault";

  var ENTRIES = null;
  var GATEWAYS = null;
  var EMAILS = null;
  var ACCESS = null;
  var loadErrors = {};

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

  // 网关/邮箱卡片沿用 record 的 extra 里放「高级」按钮；条目是列表行，按钮直接放行尾
  function loadEntries() {
    return api("GET", "/api/vault/entries").then(function (result) {
      if (result.data && result.data.ok && Array.isArray(result.data.entries)) {
        ENTRIES = result.data.entries;
        delete loadErrors.entries;
      } else {
        loadErrors.entries = (result.data && result.data.error) || "条目加载失败";
      }
      render();
    }).catch(function () {
      loadErrors.entries = "条目加载失败";
      render();
    });
  }

  function loadGateways() {
    return api("GET", "/api/vault/gateways").then(function (result) {
      if (result.data && result.data.ok && Array.isArray(result.data.gateways)) {
        GATEWAYS = result.data.gateways;
        delete loadErrors.gateways;
      } else {
        loadErrors.gateways = (result.data && result.data.error) || "网关加载失败";
      }
      render();
    }).catch(function () {
      loadErrors.gateways = "网关加载失败";
      render();
    });
  }

  function loadEmails() {
    return api("GET", "/api/vault/emails").then(function (result) {
      if (result.data && result.data.ok && Array.isArray(result.data.emails)) {
        EMAILS = result.data.emails;
        delete loadErrors.emails;
      } else {
        loadErrors.emails = (result.data && result.data.error) || "邮箱加载失败";
      }
      render();
    }).catch(function () {
      loadErrors.emails = "邮箱加载失败";
      render();
    });
  }

  function loadAccess() {
    return api("GET", "/api/vault/access-log").then(function (result) {
      if (result.data && result.data.ok && Array.isArray(result.data.access_log)) {
        ACCESS = result.data.access_log;
        delete loadErrors.access;
      } else {
        loadErrors.access = (result.data && result.data.error) || "访问记录加载失败";
      }
      render();
    }).catch(function () {
      loadErrors.access = "访问记录加载失败";
      render();
    });
  }

  function sectionBody(kind, items, emptyTitle, emptyText, renderItems) {
    if (loadErrors[kind]) return C.emptyState("加载失败", loadErrors[kind]);
    if (!items) return C.emptyState("正在加载", "马上就好");
    if (!items.length) return C.emptyState(emptyTitle, emptyText);
    return C.list(renderItems(items));
  }

  // 账号密码是列表行：一行只呈现名称与行尾「高级」按钮，
  // 其余字段只在编辑弹窗与查看密码弹窗里出现。行样式复用设置页的 session-row
  function vaultFact(label, value) {
    return "<div><dt>" + C.escapeHtml(label) + "</dt><dd>" + C.escapeHtml(value) + "</dd></div>";
  }

  function entryExpandBody(item) {
    var id = C.escapeHtml(item.id);
    return (
      '<dl class="kv">' +
      vaultFact("网址", item.url || "未填写") +
      vaultFact("账号", item.username || "未填写") +
      vaultFact("密码", item.tail ? "末四位 " + item.tail : "已保存") +
      vaultFact("备注", item.note || "无") +
      "</dl>" +
      C.expandActions(
        '<button type="button" class="secondary" data-vact="edit" data-kind="secret" data-id="' + id + '">编辑</button>' +
          '<button type="button" class="secondary" data-vact="reveal" data-kind="secret" data-id="' + id + '">查看密码</button>' +
          '<button type="button" class="danger" data-vact="delete" data-kind="secret" data-id="' + id + '">删除</button>',
      )
    );
  }

  function entryRow(item) {
    var key = "vault-entry:" + item.id;
    return (
      '<div class="entry-row"><article class="session-row"><div class="session-main"><div class="session-title"><h3>' +
      C.escapeHtml(item.name) +
      "</h3></div></div>" +
      C.expandToggle(key) +
      "</article>" +
      C.expandPanel(key, entryExpandBody(item)) +
      "</div>"
    );
  }

  function render() {
    var entriesBody = sectionBody("entries", ENTRIES, "还没有条目", "点上方「添加条目」把第一个账号密码存进来", function (items) {
      return items.map(entryRow).join("");
    });
    var accessBody = sectionBody("access", ACCESS, "还没有访问记录", "查看条目密码或网关密钥后会在这里留下一条", function (items) {
      return items.map(function (row) {
        var what = row.target_kind === "entry" ? "查看密码" : "查看密钥";
        return C.record({
          id: row.id,
          title: row.target_name || row.target_id,
          lede: what,
          facts: [["时间", C.escapeHtml(C.formatMinute(row.created_at))]],
        });
      }).join("");
    });
    var vaultHtml =
      "<div class=\"stack\">" +
      C.section("条目", ENTRIES ? String(ENTRIES.length) + " 条" : "", entriesBody) +
      C.section("访问记录", ACCESS ? String(ACCESS.length) + " 条" : "", accessBody) +
      C.section("回收站", "", C.emptyState("回收站是空的", "删除的条目会在这里停留，方便核对末四位")) +
      "</div>";
    var gatewayBody = sectionBody("gateways", GATEWAYS, "还没有网关", "点上方「添加网关」接入第一个模型网关", function (items) {
      return items.map(function (item) {
        return C.record({
          id: item.id,
          title: item.name,
          status: item.status,
          facts: [["协议", C.escapeHtml(item.proto || "未填写")], ["地址", C.escapeHtml(item.base_url || "未填写")], ["模型", C.escapeHtml(item.models || "0 个模型")], ["密钥末四位", C.escapeHtml(item.tail)]],
          expandKey: "gateway:" + item.id, expandBody: C.expandActions('<button type="button" class="secondary" data-vact="edit" data-kind="gateway" data-id="' + C.escapeHtml(item.id) + '">编辑</button><button type="button" class="secondary" data-vact="reveal" data-kind="gateway" data-id="' + C.escapeHtml(item.id) + '">查看密钥</button><button type="button" class="danger" data-vact="delete" data-kind="gateway" data-id="' + C.escapeHtml(item.id) + '">删除</button>'),
        });
      }).join("");
    });
    var gatewayHtml =
      "<div class=\"stack\">" +
      C.section("网关", GATEWAYS ? String(GATEWAYS.length) + " 个" : "", gatewayBody) +
      C.section("模型路由", "", C.emptyState("还没有路由规则", "逻辑模型名映射到哪个网关的哪个模型，会列在这里")) +
      C.section("用量", "", C.emptyState("还没有用量数据", "各网关的请求数与 token 用量会汇总到这里")) +
      "</div>";
    var emailBody = sectionBody("emails", EMAILS, "还没有邮箱", "点上方「添加邮箱」把第一个邮箱存进来", function (items) {
      return items.map(function (item) {
        var facts = [["用途", C.escapeHtml(item.purpose || "未标注")], ["入口", C.escapeHtml(item.portal || "未填写")]];
        if (item.note) facts.push(["备注", C.escapeHtml(item.note)]);
        return C.record({ id: item.id, title: item.address, facts: facts, expandKey: "email:" + item.id, expandBody: C.expandActions('<button type="button" class="secondary" data-vact="edit" data-kind="email" data-id="' + C.escapeHtml(item.id) + '">编辑</button><button type="button" class="danger" data-vact="delete" data-kind="email" data-id="' + C.escapeHtml(item.id) + '">删除</button>') });
      }).join("");
    });
    var emailHtml =
      "<div class=\"stack\">" +
      C.section("邮箱", EMAILS ? String(EMAILS.length) + " 个" : "", emailBody) +
      "</div>";
    var head =
      '<div class="page-head"><div class="page-tabs" role="tablist">' +
      '<button class="page-tab" type="button" role="tab" data-tab="vault" aria-selected="' +
      (activeTab === "vault" ? "true" : "false") +
      '">账号密码</button>' +
      '<button class="page-tab" type="button" role="tab" data-tab="gateway" aria-selected="' +
      (activeTab === "gateway" ? "true" : "false") +
      '">模型网关</button>' +
      '<button class="page-tab" type="button" role="tab" data-tab="email" aria-selected="' +
      (activeTab === "email" ? "true" : "false") +
      '">邮箱</button>' +
      "</div>" +
      '<div class="page-head-actions">' +
      (activeTab === "vault"
        ? '<button type="button" class="add-button" data-add="secret">添加条目</button>'
        : activeTab === "gateway"
          ? '<button type="button" class="add-button" data-add="gateway">添加网关</button>'
          : '<button type="button" class="add-button" data-add="email">添加邮箱</button>') +
      "</div></div>";
    C.mount(
      C.layout(
        "",
        head +
          "<div data-panel=\"vault\"" + (activeTab === "vault" ? "" : " hidden") + ">" + vaultHtml + "</div>" +
          "<div data-panel=\"gateway\"" + (activeTab === "gateway" ? "" : " hidden") + ">" + gatewayHtml + "</div>" +
          "<div data-panel=\"email\"" + (activeTab === "email" ? "" : " hidden") + ">" + emailHtml + "</div>" +
          "<div id=\"vault-confirm\"></div>"
      )
    );
  }

  function submitForm(ctrl, request, onOk) {
    ctrl.setBusy(true);
    request.then(function (result) {
      ctrl.setBusy(false);
      if (result.data && result.data.ok) {
        ctrl.close();
        onOk();
      } else {
        ctrl.setError((result.data && result.data.error) || "保存失败，请重试");
      }
    }).catch(function () {
      ctrl.setBusy(false);
      ctrl.setError("网络异常，请重试");
    });
  }

  // 添加与编辑共用同一套字段构建；item 为空是添加，传入条目是编辑并预填。
  // 密码只存加密值与末四位，编辑时密码留空表示不修改
  function secretFields(item) {
    var v = item || { name: "", url: "", username: "", note: "" };
    return (
      "<label>名称<input name=\"name\" maxlength=\"60\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.name) + "\" /></label>" +
      "<label>网址<input name=\"url\" maxlength=\"300\" autocomplete=\"off\" placeholder=\"例如 https://example.com\" value=\"" + C.escapeHtml(v.url) + "\" /></label>" +
      "<label>账号<input name=\"username\" maxlength=\"120\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.username) + "\" /></label>" +
      "<label>密码<input name=\"password\" maxlength=\"200\" autocomplete=\"off\" /><p class=\"subtle field-hint\">" + (item ? "留空表示不修改，填写后只保留末四位" : "列表里只会保留末四位") + "</p></label>" +
      "<label>备注<textarea name=\"note\" rows=\"3\" maxlength=\"300\">" + C.escapeHtml(v.note) + "</textarea></label>"
    );
  }
  function openSecretDialog(item) {
    var editing = !!item;
    C.openFormDialog({
      title: editing ? "编辑条目" : "添加条目",
      bodyHtml: secretFields(item),
      submitLabel: editing ? "保存" : "添加",
      onSubmit: function (ctrl) {
        var name = val(ctrl, "name");
        var password = val(ctrl, "password");
        if (!name) { ctrl.setError("请填写名称"); return; }
        if (!editing && !password) { ctrl.setError("请填写密码"); return; }
        var payload = { name: name, url: val(ctrl, "url"), username: val(ctrl, "username"), note: val(ctrl, "note") };
        if (password) payload.password = password;
        submitForm(
          ctrl,
          editing ? api("PATCH", "/api/vault/entries/" + encodeURIComponent(item.id), payload) : api("POST", "/api/vault/entries", payload),
          loadEntries
        );
      },
    });
  }

  function gatewayFields(item) {
    var v = item || { name: "", proto: "", base_url: "" };
    return (
      "<label>名称<input name=\"name\" maxlength=\"60\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.name) + "\" /></label>" +
      "<label>协议<input name=\"proto\" maxlength=\"30\" autocomplete=\"off\" placeholder=\"例如 OpenAI 兼容\" value=\"" + C.escapeHtml(v.proto) + "\" /></label>" +
      "<label>地址<input name=\"base\" maxlength=\"120\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.base_url) + "\" /></label>" +
      "<label>密钥<input name=\"key\" maxlength=\"200\" autocomplete=\"off\" /><p class=\"subtle field-hint\">" + (item ? "留空表示不修改，填写后只保留末四位" : "列表里只会保留末四位") + "</p></label>"
    );
  }
  function openGatewayDialog(item) {
    var editing = !!item;
    C.openFormDialog({
      title: editing ? "编辑网关" : "添加网关",
      bodyHtml: gatewayFields(item),
      submitLabel: editing ? "保存" : "添加",
      onSubmit: function (ctrl) {
        var name = val(ctrl, "name");
        var key = val(ctrl, "key");
        if (!name) { ctrl.setError("请填写名称"); return; }
        if (!editing && !key) { ctrl.setError("请填写密钥"); return; }
        var payload = { name: name, proto: val(ctrl, "proto"), base_url: val(ctrl, "base") };
        if (key) payload.key = key;
        submitForm(
          ctrl,
          editing ? api("PATCH", "/api/vault/gateways/" + encodeURIComponent(item.id), payload) : api("POST", "/api/vault/gateways", payload),
          loadGateways
        );
      },
    });
  }

  function emailFields(item) {
    var v = item || { address: "", purpose: "", portal: "", note: "" };
    return (
      "<label>邮箱地址<input name=\"address\" maxlength=\"120\" autocomplete=\"off\" placeholder=\"name@example.com\" value=\"" + C.escapeHtml(v.address) + "\" /></label>" +
      "<label>用途<input name=\"use\" maxlength=\"40\" autocomplete=\"off\" placeholder=\"例如 主邮箱、注册优先\" value=\"" + C.escapeHtml(v.purpose) + "\" /></label>" +
      "<label>入口<input name=\"portal\" maxlength=\"80\" autocomplete=\"off\" placeholder=\"例如 mail.outtw.com\" value=\"" + C.escapeHtml(v.portal) + "\" /></label>" +
      "<label>备注<textarea name=\"note\" rows=\"3\" maxlength=\"300\">" + C.escapeHtml(v.note) + "</textarea></label>"
    );
  }
  function openEmailDialog(item) {
    var editing = !!item;
    C.openFormDialog({
      title: editing ? "编辑邮箱" : "添加邮箱",
      bodyHtml: emailFields(item),
      submitLabel: editing ? "保存" : "添加",
      onSubmit: function (ctrl) {
        var address = val(ctrl, "address");
        if (!address) { ctrl.setError("请填写邮箱地址"); return; }
        var payload = { address: address, purpose: val(ctrl, "use"), portal: val(ctrl, "portal"), note: val(ctrl, "note") };
        submitForm(
          ctrl,
          editing ? api("PATCH", "/api/vault/emails/" + encodeURIComponent(item.id), payload) : api("POST", "/api/vault/emails", payload),
          loadEmails
        );
      },
    });
  }

  // 查看密码/密钥：先开弹窗占位，再走 reveal 接口拿明文；
  // 成功后把全字段摆进弹窗（密码/密钥一行带复制按钮），并刷新访问记录
  function openReveal(kind, item) {
    var isEntry = kind === "secret";
    var ctrl = C.openFormDialog({
      title: isEntry ? "查看密码" : "查看密钥",
      bodyHtml: C.emptyState("正在读取", "马上就好"),
      submitLabel: "关闭",
      onSubmit: function (c) { c.close(); },
    });
    api("POST", "/api/vault/reveal", { kind: isEntry ? "entry" : "gateway", id: item.id }).then(function (result) {
      if (!result.data || !result.data.ok) {
        ctrl.setBody(C.emptyState("读取失败", (result.data && result.data.error) || "请稍后重试"));
        return;
      }
      var value = result.data.reveal.value;
      var secretHtml = value
        ? C.copyLine(value, isEntry ? "复制密码" : "复制密钥")
        : "<p class=\"subtle\">" + (isEntry ? "还没有保存真实密码" : "还没有保存真实密钥") + "</p>";
      var facts;
      if (isEntry) {
        facts = [["网址", C.escapeHtml(item.url || "未填写")], ["账号", C.escapeHtml(item.username || "未填写")], ["密码末四位", C.escapeHtml(item.tail)], ["备注", C.escapeHtml(item.note || "无")], ["更新时间", C.escapeHtml(C.formatMinute(item.updated_at))]];
      } else {
        facts = [["协议", C.escapeHtml(item.proto || "未填写")], ["地址", C.escapeHtml(item.base_url || "未填写")], ["密钥末四位", C.escapeHtml(item.tail)], ["更新时间", C.escapeHtml(C.formatMinute(item.updated_at))]];
      }
      ctrl.setBody(secretHtml + C.record({ id: item.id, title: item.name, facts: facts }));
      loadAccess();
    }).catch(function () {
      ctrl.setBody(C.emptyState("读取失败", "网络异常，请重试"));
    });
  }

  function confirmDelete(kind, item) {
    var label = kind === "secret" ? "条目" : kind === "gateway" ? "网关" : "邮箱";
    var title = kind === "email" ? item.address : item.name;
    var url = kind === "secret" ? "/api/vault/entries/" : kind === "gateway" ? "/api/vault/gateways/" : "/api/vault/emails/";
    var reload = kind === "secret" ? loadEntries : kind === "gateway" ? loadGateways : loadEmails;
    C.askConfirm({
      anchor: document.getElementById("vault-confirm"),
      title: "删除" + label,
      text: "确认删除「" + title + "」吗？删除后无法恢复",
      confirmLabel: "删除",
      danger: true,
    }).then(function (yes) {
      if (!yes) return;
      api("DELETE", url + encodeURIComponent(item.id)).then(function (result) {
        if (result.data && result.data.ok) reload();
      });
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
      var kind = add.getAttribute("data-add");
      if (kind === "secret") openSecretDialog(null);
      else if (kind === "gateway") openGatewayDialog(null);
      else openEmailDialog(null);
      return;
    }
    var vact = target.closest("[data-vact]");
    if (vact) {
      var vkind = vact.getAttribute("data-kind");
      var vid = vact.getAttribute("data-id");
      var vpool = vkind === "secret" ? ENTRIES : vkind === "gateway" ? GATEWAYS : EMAILS;
      var vfound = null;
      (vpool || []).forEach(function (entry) { if (entry.id === vid) vfound = entry; });
      if (vfound) {
        var act = vact.getAttribute("data-vact");
        if (act === "edit") {
          if (vkind === "secret") openSecretDialog(vfound);
          else if (vkind === "gateway") openGatewayDialog(vfound);
          else openEmailDialog(vfound);
        } else if (act === "reveal") openReveal(vkind, vfound);
        else if (act === "delete") confirmDelete(vkind, vfound);
      }
    }
  });
  render();
  loadEntries();
  loadGateways();
  loadEmails();
  loadAccess();
})();
