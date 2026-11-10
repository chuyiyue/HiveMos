/* 保险库板块：账号密码 / 模型网关 / 邮箱三页签都走 /api/vault 真后端。
   账号列表只显示名称。密码仍要点「显示」或「查看密码」才经 reveal 取明文，
   服务端先写 vault_access_log 再返回；明文用 copy-text，点击即复制完整值。
   模型网关密钥在网关页签和管理弹窗里完整展示，同样走 reveal；太长只在视觉上
   单行省略。某一条拉取失败时该格回退末四位，不让整张卡片报错。
   邮箱 SMTP 密码只在管理弹窗里经同一条 reveal 取出后全量展示，点文本复制。 */
(function () {
  var C = window.HiveCommon;
  var activeTab = location.hash === "#gateway" ? "gateway" : location.hash === "#email" ? "email" : location.hash === "#totp" ? "totp" : "vault";

  var ENTRIES = null;
  var GROUPS = null;
  var GATEWAYS = null;
  var EMAILS = null;
  var loadErrors = {};
  // 网关密钥明文缓存：ok 后不再重复 reveal，避免每次重绘都多写一条访问记录。
  var gatewayKeys = {};
  // 邮箱 SMTP 密码同样缓存，管理弹窗重复打开不再多写访问记录。
  var emailSecrets = {};

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

  function vaultFactHtml(label, valueHtml) {
    return "<div><dt>" + C.escapeHtml(label) + "</dt><dd>" + valueHtml + "</dd></div>";
  }

  // 与服务器卡片 IP 相同：data-copy / data-label 都是完整值，视觉省略由 .copy-text 负责。
  function copyValueHtml(value) {
    var shown = C.escapeHtml(value);
    return "<span class=\"copy-text\" data-copy=\"" + shown + "\" data-label=\"" + shown + "\" title=\"点击复制\">" + shown + "</span>";
  }

  function findGateway(id) {
    var found = null;
    (GATEWAYS || []).forEach(function (entry) { if (entry.id === id) found = entry; });
    return found;
  }

  function gatewayTailHtml(item) {
    return item.tail ? "末四位 " + C.escapeHtml(item.tail) : "已保存";
  }

  function gatewayKeyInner(item) {
    var entry = gatewayKeys[item.id];
    if (entry && entry.status === "ok") return entry.value ? copyValueHtml(entry.value) : "已保存";
    if (entry && entry.status === "error") {
      return "<span class=\"copy-text\" data-gateway-key-retry=\"" + C.escapeHtml(item.id) + "\" title=\"读取失败，点击重试\">" + gatewayTailHtml(item) + "</span>";
    }
    if (entry && entry.status === "loading") return "读取中";
    return gatewayTailHtml(item);
  }

  // kick: "once" 只在还没拉过时拉；"force" 在失败后再拉一次（打开管理弹窗）。
  // 已成功或正在拉取时不重复请求。
  function ensureGatewayKey(id, force) {
    var entry = gatewayKeys[id];
    if (entry && (entry.status === "loading" || entry.status === "ok")) return;
    if (entry && entry.status === "error" && !force) return;
    var ticket = {};
    gatewayKeys[id] = { status: "loading", value: "", ticket: ticket };
    api("POST", "/api/vault/reveal", { kind: "gateway", id: id }).then(function (result) {
      if (!gatewayKeys[id] || gatewayKeys[id].ticket !== ticket) return;
      var value = result.data && result.data.ok && result.data.reveal ? result.data.reveal.value : null;
      if (typeof value === "string") {
        gatewayKeys[id] = { status: "ok", value: value };
        paintGatewayKey(id);
      } else {
        gatewayKeys[id] = { status: "error", value: "" };
        paintGatewayKey(id);
      }
    }).catch(function () {
      if (!gatewayKeys[id] || gatewayKeys[id].ticket !== ticket) return;
      gatewayKeys[id] = { status: "error", value: "" };
      paintGatewayKey(id);
    });
  }

  function gatewayKeyHtml(item, kick) {
    var cached = gatewayKeys[item.id];
    if (!item.tail && !(cached && cached.status === "ok" && cached.value)) return "已保存";
    if (kick === "force") ensureGatewayKey(item.id, true);
    else if (kick === "once") ensureGatewayKey(item.id, false);
    return "<span data-gateway-key=\"" + C.escapeHtml(item.id) + "\">" + gatewayKeyInner(item) + "</span>";
  }

  function paintGatewayKey(id) {
    var item = findGateway(id);
    if (!item) return;
    var html = gatewayKeyInner(item);
    document.querySelectorAll("[data-gateway-key]").forEach(function (node) {
      if (node.getAttribute("data-gateway-key") === id) node.innerHTML = html;
    });
  }

  function retryGatewayKey(id) {
    if (!id) return;
    delete gatewayKeys[id];
    ensureGatewayKey(id, true);
    paintGatewayKey(id);
  }

  // 密码不预取。点「显示」才 reveal，成功后换成 copy-text；失败只提示，对话框其余部分不动。
  function entryPasswordFact(item) {
    var id = C.escapeHtml(item.id);
    var tail = item.tail ? "末四位 " + C.escapeHtml(item.tail) : "已保存";
    return "<div><dt>密码</dt><dd data-entry-secret=\"" + id + "\">" + tail +
      " <button type=\"button\" class=\"ghost\" data-entry-show=\"" + id + "\">显示</button></dd></div>";
  }

  function showEntrySecret(id) {
    var node = null;
    document.querySelectorAll("[data-entry-secret]").forEach(function (el) {
      if (el.getAttribute("data-entry-secret") === id) node = el;
    });
    if (!node || node.getAttribute("data-revealing") === "1") return;
    node.setAttribute("data-revealing", "1");
    var button = node.querySelector("[data-entry-show]");
    if (button) button.disabled = true;
    api("POST", "/api/vault/reveal", { kind: "entry", id: id }).then(function (result) {
      if (!node.isConnected) return;
      node.removeAttribute("data-revealing");
      var value = result.data && result.data.ok && result.data.reveal ? result.data.reveal.value : null;
      if (typeof value !== "string") {
        if (button) button.disabled = false;
        C.toast((result.data && result.data.error) || "读取失败", "danger");
        return;
      }
      node.innerHTML = value ? copyValueHtml(value) : "已保存";
    }).catch(function () {
      if (!node.isConnected) return;
      node.removeAttribute("data-revealing");
      if (button) button.disabled = false;
      C.toast("网络异常，请重试", "danger");
    });
  }

  function entryManageBody(item) {
    var id = C.escapeHtml(item.id);
    return (
      "<dl class=\"kv\">" +
      vaultFact("网址", item.url || "未填写") +
      vaultFact("账号", item.username || "未填写") +
      entryPasswordFact(item) +
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
          C.manageInfoHead({ icon: "lock", title: item.name, sub: "保险库" }) + entryManageBody(item),
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
          vaultFactHtml("密钥", gatewayKeyHtml(item, "force")) +
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

  function findEmail(id) {
    var found = null;
    (EMAILS || []).forEach(function (entry) { if (entry.id === id) found = entry; });
    return found;
  }

  function emailSecretInner(item) {
    var entry = emailSecrets[item.id];
    if (entry && entry.status === "ok") return entry.value ? copyValueHtml(entry.value) : "已保存";
    if (entry && entry.status === "error") {
      return "<span class=\"copy-text\" data-email-secret-retry=\"" + C.escapeHtml(item.id) + "\" title=\"读取失败，点击重试\">读取失败</span>";
    }
    return "读取中";
  }

  // 管理弹窗打开时拉一次。已成功或正在拉取时不重复请求；force 只用来在失败后再拉。
  function ensureEmailSecret(id, force) {
    var entry = emailSecrets[id];
    if (entry && (entry.status === "loading" || entry.status === "ok")) return;
    if (entry && entry.status === "error" && !force) return;
    var ticket = {};
    emailSecrets[id] = { status: "loading", value: "", ticket: ticket };
    api("POST", "/api/vault/reveal", { kind: "email", id: id }).then(function (result) {
      if (!emailSecrets[id] || emailSecrets[id].ticket !== ticket) return;
      var value = result.data && result.data.ok && result.data.reveal ? result.data.reveal.value : null;
      if (typeof value === "string") {
        emailSecrets[id] = { status: "ok", value: value };
        paintEmailSecret(id);
      } else {
        emailSecrets[id] = { status: "error", value: "" };
        paintEmailSecret(id);
      }
    }).catch(function () {
      if (!emailSecrets[id] || emailSecrets[id].ticket !== ticket) return;
      emailSecrets[id] = { status: "error", value: "" };
      paintEmailSecret(id);
    });
  }

  function emailSecretHtml(item) {
    if (!item.smtp_secret_set && !(emailSecrets[item.id] && emailSecrets[item.id].status === "ok" && emailSecrets[item.id].value)) {
      return "未设置";
    }
    ensureEmailSecret(item.id, true);
    return "<span data-email-secret=\"" + C.escapeHtml(item.id) + "\">" + emailSecretInner(item) + "</span>";
  }

  function paintEmailSecret(id) {
    var item = findEmail(id);
    if (!item) return;
    var html = emailSecretInner(item);
    document.querySelectorAll("[data-email-secret]").forEach(function (node) {
      if (node.getAttribute("data-email-secret") === id) node.innerHTML = html;
    });
  }

  function retryEmailSecret(id) {
    if (!id) return;
    delete emailSecrets[id];
    ensureEmailSecret(id, true);
    paintEmailSecret(id);
  }

  function smtpSecurityLabel(value) {
    if (value === "ssl") return "SSL";
    if (value === "starttls") return "STARTTLS";
    if (value === "none") return "无";
    return "未选择";
  }

  function emailSmtpBlock(item) {
    if (!item.smtp_host) {
      return C.record({ id: "smtp-" + item.id, title: "SMTP", lede: "未配置 SMTP" });
    }
    var port = item.smtp_port != null && item.smtp_port !== "" ? String(item.smtp_port) : "未填写";
    return C.record({
      id: "smtp-" + item.id,
      title: "SMTP",
      facts: [
        ["服务器", C.escapeHtml(item.smtp_host)],
        ["端口", C.escapeHtml(port)],
        ["加密", C.escapeHtml(smtpSecurityLabel(item.smtp_security))],
        ["用户名", C.escapeHtml(item.smtp_user || "未填写")],
        ["密码", emailSecretHtml(item)],
      ],
    });
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
          emailSmtpBlock(item) +
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

  // 分组头不再放按钮：分组的排序/改名/删除/新建统一走页头「分组管理」
  // 按钮打开的 C.openGroupManager 面板，管保险库与模型网关共用的
  // vault_groups 池；成员数按当前页签的条目计。
  function vaultGroupCounts() {
    var items = activeTab === "gateway" ? GATEWAYS || [] : ENTRIES || [];
    var counts = {};
    items.forEach(function (item) {
      if (item.group_id) counts[item.group_id] = (counts[item.group_id] || 0) + 1;
    });
    return counts;
  }

  function openVaultGroupManager(btn) {
    C.openGroupManager({
      anchor: btn,
      groups: GROUPS || [],
      counts: vaultGroupCounts(),
      onCreate: function () { openGroupDialog(null); },
      onRename: function (group) { openGroupDialog(group); },
      onDelete: function (group, slot) {
        C.askConfirm({
          anchor: slot,
          title: "删除分组",
          text: "确认删除分组「" + group.name + "」吗？组内条目会回到未分组，不会被删除",
          confirmLabel: "删除",
          danger: true,
        }).then(function (yes) {
          if (yes) deleteVaultGroup(group);
        });
      },
      onReorder: function (ids) {
        api("POST", "/api/vault/groups/reorder", { ids: ids }).then(function (result) {
          if (result.data && result.data.ok) loadGroups();
        });
      },
      onSettled: function () {
        return { groups: GROUPS || [], counts: vaultGroupCounts() };
      },
    });
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
      facts: [
        ["协议", C.escapeHtml(item.proto || "未填写")],
        ["地址", C.escapeHtml(item.base_url || "未填写")],
        ["模型", C.escapeHtml(item.models || "0 个模型")],
        ["密钥", gatewayKeyHtml(item, activeTab === "gateway" ? "once" : "off")],
      ],
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
    var vaultHtml =
      "<div class=\"stack\">" +
      entriesBody +
      C.section("回收站", "", C.emptyState("回收站是空的", "")) +
      "</div>";
    var gatewayBody = gatewaysGroupedBody();
    var gatewayHtml =
      "<div class=\"stack\">" +
      gatewayBody +
      C.section("模型路由", "", C.emptyState("还没有路由规则", "")) +
      C.section("用量", "", C.emptyState("还没有用量数据", "")) +
      "</div>";
    var emailBody = sectionBody("emails", EMAILS, "还没有邮箱", "点上方「添加邮箱」把第一个邮箱存进来", function (items) {
      return items.map(function (item) {
        var facts = [["用途", C.escapeHtml(item.purpose || "未标注")], ["入口", C.escapeHtml(item.portal || "未填写")]];
        if (item.smtp_host) {
          var smtpEndpoint = item.smtp_host + (item.smtp_port != null && item.smtp_port !== "" ? ":" + item.smtp_port : "");
          facts.push(["SMTP", C.escapeHtml(smtpEndpoint)]);
        }
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
      '">保险库</button>' +
      '<button class="page-tab" type="button" role="tab" data-tab="email" aria-selected="' +
      (activeTab === "email" ? "true" : "false") +
      '">邮箱</button>' +
      '<button class="page-tab" type="button" role="tab" data-tab="totp" aria-selected="' +
      (activeTab === "totp" ? "true" : "false") +
      '">验证码</button>' +
      '<button class="page-tab" type="button" role="tab" data-tab="gateway" aria-selected="' +
      (activeTab === "gateway" ? "true" : "false") +
      '">模型网关</button>' +
      "</div>" +
      '<div class="page-head-actions">' +
      (activeTab === "vault"
        ? C.addBar({ addLabel: "添加条目", addAction: "add-secret", groupAction: "add-vgroup" })
        : activeTab === "gateway"
          ? C.addBar({ addLabel: "添加网关", addAction: "add-gateway", groupAction: "add-vgroup" })
          : activeTab === "totp"
            ? '<button type=\"button\" class=\"secondary\" data-totp-act=\"scan\" data-totp-add-btn>扫码添加</button><button type=\"button\" class=\"secondary\" data-totp-act=\"io\" data-totp-add-btn>导入导出</button><button type=\"button\" class=\"add-button\" data-totp-act=\"add\" data-totp-add-btn>手动添加</button>'
            : '<button type="button" class="add-button" data-add="email">添加邮箱</button>') +
      "</div></div>";
    C.mount(
      C.layout(
        head +
          "<div data-panel=\"vault\"" + (activeTab === "vault" ? "" : " hidden") + ">" + vaultHtml + "</div>" +
          "<div data-panel=\"gateway\"" + (activeTab === "gateway" ? "" : " hidden") + ">" + gatewayHtml + "</div>" +
          "<div data-panel=\"email\"" + (activeTab === "email" ? "" : " hidden") + ">" + emailHtml + "</div>" +
          "<div data-panel=\"totp\"" + (activeTab === "totp" ? "" : " hidden") + "><div data-totp-root></div></div>"
      )
    );
    if (window.HiveVaultTotp) window.HiveVaultTotp.afterRender(activeTab === "totp");
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
      "<label>密码<input name=\"password\" maxlength=\"200\" autocomplete=\"off\" />" + (item ? "<p class=\"subtle field-hint\">留空表示不修改</p>" : "") + "</label>" +
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
      "<label>密钥<input name=\"key\" maxlength=\"200\" autocomplete=\"off\" />" + (item ? "<p class=\"subtle field-hint\">留空表示不修改</p>" : "") + "</label>" +
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
          function () {
            if (editing && key) delete gatewayKeys[item.id];
            loadGateways();
          }
        );
      },
    });
    wireProtoField(ctrl.form);
  }

  var SMTP_PORTS = { ssl: "465", starttls: "587", none: "25" };

  function smtpSecurityField(selected) {
    var current = selected || "";
    var options = [["ssl", "SSL"], ["starttls", "STARTTLS"], ["none", "无"]];
    return (
      "<div class=\"tag-field\" data-smtp-security>" +
      "<span>加密方式</span>" +
      "<div class=\"segmented\" role=\"group\" aria-label=\"加密方式\">" +
      options.map(function (option) {
        return (
          "<button type=\"button\" class=\"segment\" data-smtp-sec=\"" + option[0] + "\" aria-pressed=\"" +
          (current === option[0] ? "true" : "false") + "\">" + C.escapeHtml(option[1]) + "</button>"
        );
      }).join("") +
      "</div>" +
      "<input type=\"hidden\" name=\"smtp_security\" value=\"" + C.escapeHtml(current) + "\" />" +
      "</div>"
    );
  }

  // 再点一次已选项会取消，方便整组留空表示不配置。端口仍是上一种加密的默认值时跟着改。
  function wireSmtpField(form) {
    var field = form.querySelector("[data-smtp-security]");
    if (!field) return;
    var hidden = field.querySelector("input[name=\"smtp_security\"]");
    var port = form.querySelector("input[name=\"smtp_port\"]");
    field.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var btn = target.closest("[data-smtp-sec]");
      if (!btn || !field.contains(btn)) return;
      var next = btn.getAttribute("data-smtp-sec") || "";
      var prev = hidden.value;
      if (prev === next) next = "";
      Array.prototype.forEach.call(field.querySelectorAll("[data-smtp-sec]"), function (peer) {
        peer.setAttribute("aria-pressed", peer.getAttribute("data-smtp-sec") === next ? "true" : "false");
      });
      hidden.value = next;
      if (!port) return;
      var currentPort = port.value.trim();
      var prevDefault = SMTP_PORTS[prev] || "";
      if (!next) {
        if (!currentPort || currentPort === prevDefault) port.value = "";
        return;
      }
      if (!currentPort || currentPort === prevDefault) port.value = SMTP_PORTS[next] || "";
    });
  }

  function emailFields(item) {
    var v = item || { address: "", purpose: "", portal: "", note: "", smtp_host: "", smtp_port: null, smtp_security: "", smtp_user: "" };
    var port = v.smtp_port != null && v.smtp_port !== "" ? String(v.smtp_port) : "";
    return (
      "<label>邮箱地址<input name=\"address\" maxlength=\"120\" autocomplete=\"off\" placeholder=\"name@example.com\" value=\"" + C.escapeHtml(v.address) + "\" /></label>" +
      "<label>用途<input name=\"use\" maxlength=\"40\" autocomplete=\"off\" placeholder=\"例如 主邮箱、注册优先\" value=\"" + C.escapeHtml(v.purpose) + "\" /></label>" +
      "<label>入口<input name=\"portal\" maxlength=\"80\" autocomplete=\"off\" placeholder=\"例如 mail.outtw.com\" value=\"" + C.escapeHtml(v.portal) + "\" /></label>" +
      "<label>备注<textarea name=\"note\" rows=\"3\" maxlength=\"300\">" + C.escapeHtml(v.note) + "</textarea></label>" +
      "<div class=\"tag-field\"><span>SMTP</span></div>" +
      "<label>服务器<input name=\"smtp_host\" maxlength=\"253\" autocomplete=\"off\" placeholder=\"例如 smtp.example.com\" value=\"" + C.escapeHtml(v.smtp_host || "") + "\" /></label>" +
      "<label>端口<input name=\"smtp_port\" type=\"number\" min=\"1\" max=\"65535\" step=\"1\" inputmode=\"numeric\" autocomplete=\"off\" value=\"" + C.escapeHtml(port) + "\" /></label>" +
      smtpSecurityField(v.smtp_security || "") +
      "<label>用户名<input name=\"smtp_user\" maxlength=\"120\" autocomplete=\"off\" placeholder=\"留空则与邮箱地址相同\" value=\"" + C.escapeHtml(v.smtp_user || "") + "\" /></label>" +
      "<label>密码<input name=\"smtp_secret\" type=\"password\" maxlength=\"2000\" autocomplete=\"off\" />" +
      (item ? "<p class=\"subtle field-hint\">留空表示不修改</p>" : "") +
      "</label>"
    );
  }
  function openEmailDialog(item) {
    var editing = !!item;
    var ctrl = C.openFormDialog({
      title: editing ? "编辑邮箱" : "添加邮箱",
      bodyHtml: emailFields(item),
      submitLabel: editing ? "保存" : "添加",
      onSubmit: function (ctrl) {
        var address = val(ctrl, "address");
        if (!address) { ctrl.setError("请填写邮箱地址"); return; }
        var smtpHost = val(ctrl, "smtp_host");
        var smtpPort = val(ctrl, "smtp_port");
        var smtpSecurity = val(ctrl, "smtp_security");
        var smtpUser = val(ctrl, "smtp_user");
        var smtpSecret = val(ctrl, "smtp_secret");
        var smtpAny = smtpHost || smtpPort || smtpSecurity || smtpUser || smtpSecret;
        if (smtpAny && !smtpHost) { ctrl.setError("请填写 SMTP 服务器"); return; }
        if (smtpHost) {
          if (smtpSecurity !== "ssl" && smtpSecurity !== "starttls" && smtpSecurity !== "none") {
            ctrl.setError("请选择加密方式");
            return;
          }
          if (!smtpPort) smtpPort = SMTP_PORTS[smtpSecurity];
          if (!/^[0-9]+$/.test(smtpPort) || Number(smtpPort) < 1 || Number(smtpPort) > 65535) {
            ctrl.setError("端口需为 1 到 65535 的整数");
            return;
          }
        }
        var payload = {
          address: address,
          purpose: val(ctrl, "use"),
          portal: val(ctrl, "portal"),
          note: val(ctrl, "note"),
          smtp_host: smtpHost,
          smtp_port: smtpHost ? Number(smtpPort) : "",
          smtp_security: smtpHost ? smtpSecurity : "",
          smtp_user: smtpHost ? smtpUser : "",
        };
        if (smtpSecret) payload.smtp_secret = smtpSecret;
        submitForm(
          ctrl,
          editing ? api("PATCH", "/api/vault/emails/" + encodeURIComponent(item.id), payload) : api("POST", "/api/vault/emails", payload),
          function () {
            if (editing && (smtpSecret || !smtpHost)) delete emailSecrets[item.id];
            loadEmails();
          }
        );
      },
    });
    wireSmtpField(ctrl.form);
  }

  // 列表上的「查看密码」：仍要点一次才取明文（服务端记访问记录）。
  // 取到的密码用 copy-text，点击文本即复制完整值。
  function openReveal(item) {
    var ctrl = C.openFormDialog({
      title: "查看密码",
      bodyHtml: C.emptyState("正在读取", "马上就好"),
      submitLabel: "关闭",
      onSubmit: function (c) { c.close(); },
    });
    api("POST", "/api/vault/reveal", { kind: "entry", id: item.id }).then(function (result) {
      if (!result.data || !result.data.ok || !result.data.reveal || typeof result.data.reveal.value !== "string") {
        ctrl.setBody(C.emptyState("读取失败", (result.data && result.data.error) || "请稍后重试"));
        return;
      }
      var value = result.data.reveal.value;
      ctrl.setBody(C.record({
        id: item.id,
        title: item.name,
        facts: [
          ["网址", C.escapeHtml(item.url || "未填写")],
          ["账号", C.escapeHtml(item.username || "未填写")],
          ["密码", value ? copyValueHtml(value) : "已保存"],
          ["备注", C.escapeHtml(item.note || "无")],
          ["更新时间", C.escapeHtml(C.formatMinute(item.updated_at))],
        ],
      }));
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
    if (target.closest("[data-copy]")) return;
    var emailRetry = target.closest("[data-email-secret-retry]");
    if (emailRetry) {
      retryEmailSecret(emailRetry.getAttribute("data-email-secret-retry"));
      return;
    }
    var keyRetry = target.closest("[data-gateway-key-retry]");
    if (keyRetry) {
      retryGatewayKey(keyRetry.getAttribute("data-gateway-key-retry"));
      return;
    }
    var showSecret = target.closest("[data-entry-show]");
    if (showSecret) {
      showEntrySecret(showSecret.getAttribute("data-entry-show"));
      return;
    }
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
      if (a2 === "add-vgroup") { openVaultGroupManager(act2); return; }
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
        else if (act === "reveal" && vkind === "secret") openReveal(vfound);
        else if (act === "delete") confirmDelete(vkind, vfound, vact);
      }
    }
  }
  render();
  loadGroups();
  loadEntries();
  loadGateways();
  loadEmails();
})();
