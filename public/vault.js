/* 保险库板块：账号密码 / 模型网关 / 邮箱三页签都走 /api/vault 真后端。
   列表只显示条目名称与末四位口径的信息，密码/密钥明文只能经 reveal
   接口在弹窗里看，每次查看都会在访问记录里留一条。 */
(function () {
  var C = window.HiveCommon;
  var activeTab = location.hash === "#gateway" ? "gateway" : location.hash === "#email" ? "email" : "vault";

  var ENTRIES = null;
  var GROUPS = null;
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

  function loadGroups() {
    return api("GET", "/api/vault/groups").then(function (result) {
      if (result.data && result.data.ok && Array.isArray(result.data.groups)) {
        GROUPS = result.data.groups;
        delete loadErrors.groups;
      } else {
        loadErrors.groups = (result.data && result.data.error) || "分组加载失败";
      }
      render();
    }).catch(function () {
      loadErrors.groups = "分组加载失败";
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
    return kind === "gateways" || kind === "emails" ? C.cardList(renderItems(items)) : C.list(renderItems(items));
  }

  // 账号密码是列表行：一行只呈现名称与「查看密码」，点行打开管理弹窗，
  // 其余字段与管理动作都在弹窗里。行样式复用 session-row
  function vaultFact(label, value) {
    return "<div><dt>" + C.escapeHtml(label) + "</dt><dd>" + C.escapeHtml(value) + "</dd></div>";
  }

  function entryManageBody(item) {
    var id = C.escapeHtml(item.id);
    return (
      "<dl class=\"kv\">" +
      vaultFact("网址", item.url || "未填写") +
      vaultFact("账号", item.username || "未填写") +
      vaultFact("密码", item.tail ? "末四位 " + item.tail : "已保存") +
      vaultFact("备注", item.note || "无") +
      vaultFact("分组", groupName(item.group_id)) +
      "</dl>" +
      "<div class=\"manage-actions\">" +
      "<button type=\"button\" class=\"secondary\" data-vact=\"edit\" data-kind=\"secret\" data-id=\"" + id + "\">编辑</button>" +
      "<button type=\"button\" class=\"secondary\" data-vact=\"group\" data-kind=\"secret\" data-id=\"" + id + "\">设置分组</button>" +
      "<button type=\"button\" class=\"danger\" data-confirm-delete data-vact=\"delete\" data-kind=\"secret\" data-id=\"" + id + "\">删除</button>" +
      "</div>"
    );
  }

  function entryRow(item) {
    var id = C.escapeHtml(item.id);
    return (
      "<div class=\"entry-row\"><article class=\"session-row\" data-manage=\"entry:" + id + "\" tabindex=\"0\" role=\"button\" aria-haspopup=\"dialog\" aria-label=\"管理：" + C.escapeHtml(item.name) + "\">" +
      "<div class=\"session-main\"><div class=\"session-title\"><h3>" + C.escapeHtml(item.name) + "</h3></div></div>" +
      "<button type=\"button\" class=\"secondary\" data-vact=\"reveal\" data-kind=\"secret\" data-id=\"" + id + "\">查看密码</button>" +
      "<span class=\"row-chev\" aria-hidden=\"true\">›</span>" +
      "</article></div>"
    );
  }

  // ---- 管理弹窗（点行/卡信息区打开） ----

  function openManage(key) {
    if (!key) return;
    var sep = key.indexOf(":");
    var kind = key.slice(0, sep);
    var id = key.slice(sep + 1);
    var pool = kind === "entry" ? ENTRIES : kind === "gateway" ? GATEWAYS : EMAILS;
    var found = null;
    (pool || []).forEach(function (entry) {
      if (entry.id === id) found = entry;
    });
    if (!found) return;
    if (kind === "entry") openEntryManage(found);
    else if (kind === "gateway") openGatewayManage(found);
    else openEmailManage(found);
  }

  function wireManage(ctrl) {
    ctrl.dialog.addEventListener("click", handleClick);
  }

  function openEntryManage(item) {
    wireManage(
      C.openManageDialog({
        size: "sm",
        title: item.name,
        bodyHtml:
          C.manageInfoHead({ icon: "lock", title: item.name, sub: "账号密码" }) + entryManageBody(item),
      })
    );
  }

  function openGatewayManage(item) {
    var id = C.escapeHtml(item.id);
    wireManage(
      C.openManageDialog({
        size: "sm",
        title: item.name,
        bodyHtml:
          C.manageInfoHead({ icon: "gateway", title: item.name, sub: "模型网关" }) +
          "<div class=\"manage-info-card\"><dl class=\"kv\">" +
          vaultFact("协议", item.proto || "未填写") +
          vaultFact("地址", item.base_url || "未填写") +
          vaultFact("模型", item.models || "0 个模型") +
          vaultFact("密钥", item.tail ? "末四位 " + item.tail : "已保存") +
          vaultFact("分组", groupName(item.group_id)) +
          "</dl></div>" +
          "<div class=\"manage-actions\">" +
          "<button type=\"button\" class=\"secondary\" data-vact=\"edit\" data-kind=\"gateway\" data-id=\"" + id + "\">编辑</button>" +
          "<button type=\"button\" class=\"secondary\" data-vact=\"group\" data-kind=\"gateway\" data-id=\"" + id + "\">设置分组</button>" +
          "<button type=\"button\" class=\"danger\" data-confirm-delete data-vact=\"delete\" data-kind=\"gateway\" data-id=\"" + id + "\">删除</button>" +
          "</div>",
      })
    );
  }

  function openEmailManage(item) {
    var id = C.escapeHtml(item.id);
    wireManage(
      C.openManageDialog({
        size: "sm",
        title: item.address,
        bodyHtml:
          C.manageInfoHead({ icon: "lock", title: item.address, sub: "邮箱" }) +
          "<div class=\"manage-info-card\"><dl class=\"kv\">" +
          vaultFact("用途", item.purpose || "未标注") +
          vaultFact("入口", item.portal || "未填写") +
          (item.note ? vaultFact("备注", item.note) : "") +
          "</dl></div>" +
          "<div class=\"manage-actions\">" +
          "<button type=\"button\" class=\"danger\" data-confirm-delete data-vact=\"delete\" data-kind=\"email\" data-id=\"" + id + "\">删除</button>" +
          "</div>",
      })
    );
  }

  function groupName(gid) {
    var name = "未分组";
    (GROUPS || []).forEach(function (group) {
      if (group.id === gid) name = group.name;
    });
    return name;
  }

  function groupActions(group) {
    var id = C.escapeHtml(group.id);
    return (
      "<button type=\"button\" class=\"secondary\" data-action=\"rename-vgroup\" data-id=\"" + id + "\">改名</button>" +
      "<button type=\"button\" class=\"danger\" data-confirm-delete data-action=\"delete-vgroup\" data-id=\"" + id + "\">删除</button>"
    );
  }

  // 账号密码与模型网关按共用分组池分区展示，分组在前、未分组置后
  function entriesGroupedBody() {
    if (loadErrors.entries) return C.emptyState("加载失败", loadErrors.entries);
    if (!ENTRIES || !GROUPS) return C.emptyState("正在加载", "马上就好");
    if (!ENTRIES.length && !GROUPS.length) return C.emptyState("还没有条目", "点上方「添加条目」把第一个账号密码存进来");
    return C.groupedSections({
      groups: GROUPS,
      items: ENTRIES,
      groupOf: function (item) { return item.group_id || null; },
      renderItem: entryRow,
      groupActions: groupActions,
      ungroupedTitle: "未分组",
      emptyGroupText: "添加条目时选择这个分组即可归入",
    });
  }

  function gatewayCard(item) {
    return C.record({
      id: item.id,
      icon: "gateway",
      title: item.name,
      status: item.status,
      facts: [["协议", C.escapeHtml(item.proto || "未填写")], ["地址", C.escapeHtml(item.base_url || "未填写")], ["模型", C.escapeHtml(item.models || "0 个模型")], ["密钥末四位", C.escapeHtml(item.tail)]],
      actions: "<button type=\"button\" class=\"secondary\" data-vact=\"reveal\" data-kind=\"gateway\" data-id=\"" + C.escapeHtml(item.id) + "\">查看密钥</button>",
      manage: "gateway:" + item.id,
    });
  }

  function gatewaysGroupedBody() {
    if (loadErrors.gateways) return C.emptyState("加载失败", loadErrors.gateways);
    if (!GATEWAYS || !GROUPS) return C.emptyState("正在加载", "马上就好");
    if (!GATEWAYS.length && !GROUPS.length) return C.emptyState("还没有网关", "点上方「添加网关」接入第一个模型网关");
    return C.groupedSections({
      groups: GROUPS,
      items: GATEWAYS,
      groupOf: function (item) { return item.group_id || null; },
      renderItem: gatewayCard,
      groupActions: groupActions,
      cardGrid: true,
      ungroupedTitle: "未分组",
      emptyGroupText: "添加网关时选择这个分组即可归入",
    });
  }

  function openGroupDialog(group) {
    var editing = !!group;
    C.openFormDialog({
      title: editing ? "重命名分组" : "添加分组",
      bodyHtml: "<label>分组名<input name=\"name\" maxlength=\"60\" autocomplete=\"off\" value=\"" + (editing ? C.escapeHtml(group.name) : "") + "\" /></label>",
      submitLabel: editing ? "保存" : "添加分组",
      onSubmit: function (ctrl) {
        var name = val(ctrl, "name");
        if (!name) { ctrl.setError("请填写分组名"); return; }
        submitForm(
          ctrl,
          editing ? api("PATCH", "/api/vault/groups/" + encodeURIComponent(group.id), { name: name }) : api("POST", "/api/vault/groups", { name: name }),
          loadGroups
        );
      },
    });
  }

  function deleteVaultGroup(group) {
    api("DELETE", "/api/vault/groups/" + encodeURIComponent(group.id)).then(function (result) {
      if (result.data && result.data.ok) {
        loadGroups();
        loadEntries();
        loadGateways();
      }
    });
  }

  // 管理弹窗里的「设置分组」：单独一个小表单，保存后关掉管理弹窗并刷新列表
  function openSetGroupDialog(kind, item) {
    var isEntry = kind === "secret";
    C.openFormDialog({
      title: "设置分组",
      bodyHtml: "<label>分组" + C.groupSelect("group_id", GROUPS || [], item.group_id || "") + "</label>",
      submitLabel: "保存",
      onSubmit: function (ctrl) {
        var gid = val(ctrl, "group_id");
        submitForm(
          ctrl,
          api("PATCH", (isEntry ? "/api/vault/entries/" : "/api/vault/gateways/") + encodeURIComponent(item.id), { group_id: gid || null }),
          function () {
            C.closeCurrentOverlay();
            if (isEntry) loadEntries();
            else loadGateways();
          }
        );
      },
    });
  }

  function render() {
    var entriesBody = entriesGroupedBody();
    var accessBody = sectionBody("access", ACCESS, "还没有访问记录", "查看条目密码或网关密钥后会在这里留下一条", function (items) {
      return items.map(function (row) {
        var what = row.target_kind === "entry" ? "查看密码" : "查看密钥";
        return C.record({
          id: row.id,
          icon: "eye",
          title: row.target_name || row.target_id,
          lede: what,
          facts: [["时间", C.escapeHtml(C.formatMinute(row.created_at))]],
        });
      }).join("");
    });
    var vaultHtml =
      "<div class=\"stack\">" +
      entriesBody +
      C.section("访问记录", ACCESS ? String(ACCESS.length) + " 条" : "", accessBody) +
      C.section("回收站", "", C.emptyState("回收站是空的", "删除的条目会在这里停留，方便核对末四位")) +
      "</div>";
    var gatewayBody = gatewaysGroupedBody();
    var gatewayHtml =
      "<div class=\"stack\">" +
      gatewayBody +
      C.section("模型路由", "", C.emptyState("还没有路由规则", "逻辑模型名映射到哪个网关的哪个模型，会列在这里")) +
      C.section("用量", "", C.emptyState("还没有用量数据", "各网关的请求数与 token 用量会汇总到这里")) +
      "</div>";
    var emailBody = sectionBody("emails", EMAILS, "还没有邮箱", "点上方「添加邮箱」把第一个邮箱存进来", function (items) {
      return items.map(function (item) {
        var facts = [["用途", C.escapeHtml(item.purpose || "未标注")], ["入口", C.escapeHtml(item.portal || "未填写")]];
        if (item.note) facts.push(["备注", C.escapeHtml(item.note)]);
        return C.record({
          id: item.id,
          icon: "lock",
          title: item.address,
          facts: facts,
          actions: "<button type=\"button\" class=\"secondary\" data-vact=\"edit\" data-kind=\"email\" data-id=\"" + C.escapeHtml(item.id) + "\">编辑</button>",
          manage: "email:" + item.id,
        });
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
        ? C.addBar({ addLabel: "添加条目", addAction: "add-secret", groupAction: "add-vgroup" })
        : activeTab === "gateway"
          ? C.addBar({ addLabel: "添加网关", addAction: "add-gateway", groupAction: "add-vgroup" })
          : '<button type="button" class="add-button" data-add="email">添加邮箱</button>') +
      "</div></div>";
    C.mount(
      C.layout(
        "",
        head +
          "<div data-panel=\"vault\"" + (activeTab === "vault" ? "" : " hidden") + ">" + vaultHtml + "</div>" +
          "<div data-panel=\"gateway\"" + (activeTab === "gateway" ? "" : " hidden") + ">" + gatewayHtml + "</div>" +
          "<div data-panel=\"email\"" + (activeTab === "email" ? "" : " hidden") + ">" + emailHtml + "</div>"
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
      "<label>备注<textarea name=\"note\" rows=\"3\" maxlength=\"300\">" + C.escapeHtml(v.note) + "</textarea></label>" +
      "<label>分组" + C.groupSelect("group_id", GROUPS || [], v.group_id || "") + "</label>"
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
        var payload = { name: name, url: val(ctrl, "url"), username: val(ctrl, "username"), note: val(ctrl, "note"), group_id: val(ctrl, "group_id") || null };
        if (password) payload.password = password;
        submitForm(
          ctrl,
          editing ? api("PATCH", "/api/vault/entries/" + encodeURIComponent(item.id), payload) : api("POST", "/api/vault/entries", payload),
          loadEntries
        );
      },
    });
  }

  var PROTO_OPTIONS = ["OpenAI 兼容", "Anthropic", "Gemini", "Azure OpenAI", "Ollama"];

  // 协议标签云多选：预置选项 + 存量自定义值（历史自由文本）追加为额外 chip；
  // 隐藏的 proto 输入与所有选中 chip 同步（", " 连接），提交逻辑仍按 name 取值。
  function protoField(proto) {
    var selected = String(proto || "")
      .split(/\s*[,、]\s*/)
      .filter(function (part) { return !!part; });
    var options = PROTO_OPTIONS.slice();
    selected.forEach(function (part) {
      if (options.indexOf(part) === -1) options.push(part);
    });
    return (
      "<div class=\"tag-field\" data-proto-field>" +
      "<span>协议</span>" +
      "<div class=\"choice-row\" role=\"group\" aria-label=\"协议\">" +
      options.map(function (option) {
        return (
          "<button type=\"button\" class=\"perm-item\" data-proto-option=\"" + C.escapeHtml(option) + "\" aria-pressed=\"" +
          (selected.indexOf(option) !== -1 ? "true" : "false") + "\">" + C.escapeHtml(option) + "</button>"
        );
      }).join("") +
      "</div>" +
      "<input type=\"hidden\" name=\"proto\" value=\"" + C.escapeHtml(selected.join(", ")) + "\" />" +
      "</div>"
    );
  }
  function wireProtoField(form) {
    var field = form.querySelector("[data-proto-field]");
    if (!field) return;
    var hidden = field.querySelector("input[name=\"proto\"]");
    field.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var chip = target.closest("[data-proto-option]");
      if (!chip) return;
      var wasOn = chip.getAttribute("aria-pressed") === "true";
      chip.setAttribute("aria-pressed", wasOn ? "false" : "true");
      var values = [];
      Array.prototype.forEach.call(field.querySelectorAll("[data-proto-option]"), function (peer) {
        if (peer.getAttribute("aria-pressed") === "true") values.push(peer.getAttribute("data-proto-option"));
      });
      hidden.value = values.join(", ");
    });
  }

  function gatewayFields(item) {
    var v = item || { name: "", proto: "", base_url: "" };
    return (
      "<label>名称<input name=\"name\" maxlength=\"60\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.name) + "\" /></label>" +
      protoField(v.proto) +
      "<label>地址<input name=\"base\" maxlength=\"120\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.base_url) + "\" /></label>" +
      "<label>密钥<input name=\"key\" maxlength=\"200\" autocomplete=\"off\" /><p class=\"subtle field-hint\">" + (item ? "留空表示不修改，填写后只保留末四位" : "列表里只会保留末四位") + "</p></label>" +
      "<label>分组" + C.groupSelect("group_id", GROUPS || [], v.group_id || "") + "</label>"
    );
  }
  function openGatewayDialog(item) {
    var editing = !!item;
    var ctrl = C.openFormDialog({
      title: editing ? "编辑网关" : "添加网关",
      bodyHtml: gatewayFields(item),
      submitLabel: editing ? "保存" : "添加",
      onSubmit: function (ctrl) {
        var name = val(ctrl, "name");
        var key = val(ctrl, "key");
        if (!name) { ctrl.setError("请填写名称"); return; }
        if (!editing && !key) { ctrl.setError("请填写密钥"); return; }
        var payload = { name: name, proto: val(ctrl, "proto"), base_url: val(ctrl, "base"), group_id: val(ctrl, "group_id") || null };
        if (key) payload.key = key;
        submitForm(
          ctrl,
          editing ? api("PATCH", "/api/vault/gateways/" + encodeURIComponent(item.id), payload) : api("POST", "/api/vault/gateways", payload),
          loadGateways
        );
      },
    });
    wireProtoField(ctrl.form);
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

  function confirmDelete(kind, item, srcEl) {
    var label = kind === "secret" ? "条目" : kind === "gateway" ? "网关" : "邮箱";
    var title = kind === "email" ? item.address : item.name;
    var url = kind === "secret" ? "/api/vault/entries/" : kind === "gateway" ? "/api/vault/gateways/" : "/api/vault/emails/";
    var reload = kind === "secret" ? loadEntries : kind === "gateway" ? loadGateways : loadEmails;
    var dlg = srcEl && srcEl.closest ? srcEl.closest("[data-manage-dialog]") : null;
    
      api("DELETE", url + encodeURIComponent(item.id)).then(function (result) {
        if (result.data && result.data.ok) { C.closeCurrentOverlay(); reload(); }
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
    var act2 = target.closest("[data-action]");
    if (act2) {
      var a2 = act2.getAttribute("data-action");
      var gid2 = act2.getAttribute("data-id") || "";
      var gfound = null;
      (GROUPS || []).forEach(function (g) { if (g.id === gid2) gfound = g; });
      if (a2 === "add-secret") { openSecretDialog(null); return; }
      if (a2 === "add-gateway") { openGatewayDialog(null); return; }
      if (a2 === "add-vgroup") { openGroupDialog(null); return; }
      if (a2 === "rename-vgroup" && gfound) { openGroupDialog(gfound); return; }
      if (a2 === "delete-vgroup" && gfound) { deleteVaultGroup(gfound); return; }
    }
    var add = target.closest("[data-add]");
    if (add) {
      var kind = add.getAttribute("data-add");
      if (kind === "secret") openSecretDialog(null);
      else if (kind === "gateway") openGatewayDialog(null);
      else openEmailDialog(null);
      return;
    }
    var zone = target.closest("[data-manage]");
    if (zone && !target.closest("button, a, input, select, textarea")) {
      openManage(zone.getAttribute("data-manage"));
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
        } else if (act === "group") openSetGroupDialog(vkind, vfound);
        else if (act === "reveal") openReveal(vkind, vfound);
        else if (act === "delete") confirmDelete(vkind, vfound, vact);
      }
    }
  }
  render();
  loadGroups();
  loadEntries();
  loadGateways();
  loadEmails();
  loadAccess();
})();
