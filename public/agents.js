/* Agent 集群板块，两页签。Agents：按设备管理的方式组织，列表走
   GET /api/agents + GET /api/groups?scope=agent，按分组分区展示；添加设备/
   添加分组走弹窗，卡片高级操作（改名、移动分组、高级设置、轮换令牌、停用）
   走中央菜单，高级设置里是 per-Agent 的系统功能权限开关（PATCH 保存）。
   应用：接入 MCP 的应用条目，走 /api/extras/apps；分组没有独立的后端
   scope，仍是页内状态（group_id 不落库），其余与 Agents 页签共用同一套
   操作区、分组分区、卡片与中央菜单。令牌明文只在生成/轮换那一次响应里出现 */
(function () {
  var C = window.HiveCommon;

  // Permission domains, mirroring PERMISSION_DOMAINS in src/registry.ts.
  var PERM_DOMAINS = C.permDomains;

  var state = {
    loading: true,
    loadError: "",
    agents: [],
    groups: [],
    notice: "",
    noticeKind: "danger",
    busy: false,
    activeTab: location.hash === "#apps" ? "apps" : "agents",
    // 应用页签：条目走 /api/extras/apps（loadAll 时拉取）；分组没有后端
    // scope 可用，仍是页内状态，条目的 group_id 只在页内生效、不落库
    apps: {
      seq: 0,
      groups: [],
      items: [],
    },
  };

  function kv(label, html) {
    return "<div><dt>" + C.escapeHtml(label) + "</dt><dd>" + html + "</dd></div>";
  }

  function noticeHtml() {
    if (!state.notice) return "";
    var kind = state.noticeKind === "ok" ? "ok" : "danger";
    return '<p class="callout ' + kind + '" role="status">' + C.escapeHtml(state.notice) + "</p>";
  }

  function findAgent(id) {
    return state.agents.find(function (item) {
      return item.id === id;
    });
  }

  function findGroup(id) {
    return state.groups.find(function (item) {
      return item.id === id;
    });
  }

  function permText(agent) {
    var perms = agent.permissions || [];
    if (!perms.length) return "未开启任何功能";
    var labels = perms.map(function (domain) {
      var entry = PERM_DOMAINS.find(function (item) {
        return item[0] === domain;
      });
      return entry ? entry[1] : domain;
    });
    return perms.length + " / " + PERM_DOMAINS.length + "：" + labels.join("、");
  }

  function pinCorner(agent) {
    var pinned = !!agent.pinned_at;
    return (
      "<button type=\"button\" class=\"pin-btn\" data-action=\"pin\" data-id=\"" +
      C.escapeHtml(agent.id) +
      "\" aria-pressed=\"" +
      (pinned ? "true" : "false") +
      "\" title=\"" +
      (pinned ? "取消固定" : "固定到侧边栏") +
      "\" aria-label=\"" +
      (pinned ? "取消固定" : "固定到侧边栏") +
      "\"><svg class=\"icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><use href=\"/icons.svg#icon-pin\"/></svg></button>"
    );
  }

  function card(agent) {
    var seen = C.formatMinute(agent.last_seen_at);
    var active = agent.status === "active";
    return C.record({
      id: agent.id,
      icon: "bot",
      title: agent.name,
      status: active ? "enabled" : "disabled",
      corner: pinCorner(agent),
      facts: [
        ["标识", "<span class=\"mono\">" + C.escapeHtml(agent.id) + "</span>"],
        ["权限", C.escapeHtml(permText(agent))],
        ["最近调用", C.escapeHtml(seen || "还没有调用")],
        ["创建", C.escapeHtml(C.formatMinute(agent.created_at) || "未知")],
      ],
      actions:
        "<button type=\"button\" class=\"secondary\" data-copy=\"" +
        C.escapeHtml(agent.id) +
        "\" data-label=\"复制标识\">复制标识</button>",
      manage: "agent:" + agent.id,
    });
  }

  function groupActions(group) {
    return (
      '<button type="button" class="secondary" data-action="rename-group" data-id="' +
      C.escapeHtml(group.id) +
      '">改名</button><button type="button" class="danger" data-action="delete-group" data-id="' +
      C.escapeHtml(group.id) +
      '">删除</button><span class="confirm-slot" data-confirm-group="' +
      C.escapeHtml(group.id) +
      '"></span>'
    );
  }

  function render() {
    var body;
    if (state.loading) {
      body = C.section("设备", "", C.emptyState("正在读取", "稍等片刻"));
    } else if (state.loadError) {
      body = C.section("设备", "", '<p class="callout danger" role="alert">' + C.escapeHtml(state.loadError) + "</p>");
    } else {
      body = C.groupedSections({
        groups: state.groups,
        items: state.agents,
        groupOf: function (agent) {
          return agent.group_id || null;
        },
        renderItem: card,
        groupActions: groupActions,
        ungroupedTitle: "未分组",
        emptyGroupText: "添加设备时选择这个分组即可归入",
        emptyTitle: "还没有设备",
        emptyText: "点上方「添加设备」创建第一个",
      });
    }
    var agentsPanel = '<div class="stack">' + noticeHtml() + body + "</div>";
    var head =
      '<div class="page-head"><div class="page-tabs" role="tablist">' +
      '<button class="page-tab" type="button" role="tab" data-tab="agents" aria-selected="' +
      (state.activeTab === "agents" ? "true" : "false") +
      '">Agents</button>' +
      '<button class="page-tab" type="button" role="tab" data-tab="apps" aria-selected="' +
      (state.activeTab === "apps" ? "true" : "false") +
      '">应用</button>' +
      "</div>" +
      '<div class="page-head-actions" data-head-actions="agents"' +
      (state.activeTab === "agents" ? "" : " hidden") +
      ">" +
      C.addBar({ addLabel: "添加设备", addAction: "open-create", groupAction: "add-group" }) +
      "</div>" +
      '<div class="page-head-actions" data-head-actions="apps"' +
      (state.activeTab === "apps" ? "" : " hidden") +
      ">" +
      C.addBar({ addLabel: "添加应用", addAction: "app-add", groupAction: "app-add-group" }) +
      "</div></div>";
    C.mount(
      C.layout(
        "",
        head +
          '<div data-panel="agents"' +
          (state.activeTab === "agents" ? "" : " hidden") +
          ">" +
          agentsPanel +
          "</div>" +
          '<div data-panel="apps"' +
          (state.activeTab === "apps" ? "" : " hidden") +
          ">" +
          appsHtml() +
          "</div>",
      ),
    );
    bind();
  }

  function activateTab(name) {
    state.activeTab = name;
    document.querySelectorAll(".page-tab").forEach(function (btn) {
      btn.setAttribute("aria-selected", btn.getAttribute("data-tab") === name ? "true" : "false");
    });
    document.querySelectorAll("[data-panel]").forEach(function (panel) {
      panel.hidden = panel.getAttribute("data-panel") !== name;
    });
    document.querySelectorAll("[data-head-actions]").forEach(function (el) {
      el.hidden = el.getAttribute("data-head-actions") !== name;
    });
    history.replaceState(null, "", "#" + name);
  }

  var bound = false;
  function bind() {
    var page = document.getElementById("page");
    if (!page || bound) return;
    bound = true;
    page.addEventListener("click", handleClick);
  }

  function handleClick(event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var tab = target.closest(".page-tab");
      if (tab) {
        activateTab(tab.getAttribute("data-tab"));
        return;
      }
      var zone = target.closest("[data-manage]");
      if (zone && !target.closest("button, a, input, select, textarea")) {
        openManage(zone.getAttribute("data-manage"));
        return;
      }
      var button = target.closest("[data-action]");
      if (!button || state.busy) return;
      var action = button.getAttribute("data-action");
      var id = button.getAttribute("data-id") || "";
      if (action === "open-create") openCreate();
      else if (action === "add-group") openGroup();
      else if (action === "pin") {
        var agent3 = findAgent(id);
        if (agent3) togglePin(agent3);
      } else if (action === "rename-group") {
        var group = findGroup(id);
        if (group) openRenameGroup(group);
      } else if (action === "delete-group") {
        var target2 = findGroup(id);
        if (target2) deleteGroup(target2, button);
      } else if (action === "app-add") openAppDialog(null);
      else if (action === "app-add-group") openAppGroupDialog(null);
      else if (action === "app-edit") {
        var app = findApp(id);
        if (app) openAppDialog(app);
      } else if (action === "app-delete") {
        var app2 = findApp(id);
        if (app2) deleteApp(app2);
      } else if (action === "app-rename-group") {
        var appGroup = findAppGroup(id);
        if (appGroup) openAppGroupDialog(appGroup);
      } else if (action === "app-delete-group") {
        var appGroup2 = findAppGroup(id);
        if (appGroup2) deleteAppGroup(appGroup2);
      }
  }

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
        .catch(function () {
          return {};
        })
        .then(function (data) {
          return { status: response.status, data: data || {} };
        });
    });
  }

  function authRedirect(status) {
    if (status !== 401) return false;
    location.assign("/login.html?next=" + encodeURIComponent(location.pathname + location.search));
    return true;
  }

  function loadAll() {
    return Promise.all([api("GET", "/api/agents"), api("GET", "/api/groups?scope=agent"), api("GET", "/api/extras/apps")])
      .then(function (results) {
        if (authRedirect(results[0].status) || authRedirect(results[1].status)) return;
        state.loading = false;
        if (!results[0].data || results[0].data.ok !== true) {
          state.loadError = (results[0].data && results[0].data.error) || "没有读到设备，请重试";
          render();
          return;
        }
        state.agents = results[0].data.agents || [];
        state.groups = results[1].data && results[1].data.ok === true ? results[1].data.groups || [] : [];
        if (results[2].data && results[2].data.ok === true) {
          state.apps.items = (results[2].data.apps || []).map(mapApp);
        }
        state.loadError = "";
        render();
      })
      .catch(function () {
        state.loading = false;
        state.loadError = "网络异常，请重试";
        render();
      });
  }

  function confirmAnchor(selector) {
    return document.querySelector(selector);
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : value;
  }

  // ---- 添加设备 ----

  function openCreate() {
    C.openFormDialog({
      title: "添加设备",
      bodyHtml:
        "<label>名字" +
        '<input data-field="name" name="name" maxlength="64" autocomplete="off" />' +
        '<p class="subtle field-hint">生成后请立刻复制。令牌不会再次显示</p></label>' +
        "<label>分组" +
        C.groupSelect("group_id", state.groups, "") +
        "</label>",
      submitLabel: "添加设备",
      onSubmit: function (ctrl) {
        create(ctrl);
      },
      onClose: function () {
        loadAll();
      },
    });
  }

  // The plaintext token only ever exists in this closure and in the
  // dialog DOM: closing the dialog removes both, and page state never
  // holds it, so a render() can never leak it back onto the page.
  function create(ctrl) {
    if (state.busy) return;
    var nameInput = ctrl.form.querySelector('[data-field="name"]');
    var groupInput = ctrl.form.querySelector('[data-field="group_id"]');
    var name = nameInput ? nameInput.value.trim() : "";
    var groupId = groupInput ? groupInput.value : "";
    if (!name) {
      ctrl.setError("请填写设备名字");
      return;
    }
    state.busy = true;
    ctrl.setBusy(true);
    api("POST", "/api/agents", { name: name, group_id: groupId || null })
      .then(function (result) {
        state.busy = false;
        if (authRedirect(result.status)) return;
        if (!result.data || result.data.ok !== true || !result.data.agent) {
          ctrl.setBusy(false);
          ctrl.setError((result.data && result.data.error) || "没有添加成功，请重试");
          return;
        }
        state.notice = "";
        ctrl.showResult(
          "<p>令牌只显示这一次。关掉这个面板后无法再查看，请立刻复制</p>" + C.copyLine(result.data.agent.token || "", "复制令牌"),
          "我已复制",
        );
      })
      .catch(function () {
        state.busy = false;
        ctrl.setBusy(false);
        ctrl.setError("网络异常，请重试");
      });
  }

  // ---- 分组 ----

  function openGroup() {
    C.openFormDialog({
      title: "添加分组",
      bodyHtml: "<label>分组名" + '<input data-field="name" name="name" maxlength="64" autocomplete="off" />' + "</label>",
      submitLabel: "添加分组",
      onSubmit: function (ctrl) {
        var input = ctrl.form.querySelector('[data-field="name"]');
        var name = input ? input.value.trim() : "";
        if (!name) {
          ctrl.setError("请填写分组名");
          return;
        }
        if (state.busy) return;
        state.busy = true;
        ctrl.setBusy(true);
        api("POST", "/api/groups", { scope: "agent", name: name })
          .then(function (result) {
            state.busy = false;
            if (authRedirect(result.status)) return;
            if (!result.data || result.data.ok !== true) {
              ctrl.setBusy(false);
              ctrl.setError((result.data && result.data.error) || "没有添加成功，请重试");
              return;
            }
            state.notice = "已添加分组";
            state.noticeKind = "ok";
            ctrl.close();
            loadAll();
          })
          .catch(function () {
            state.busy = false;
            ctrl.setBusy(false);
            ctrl.setError("网络异常，请重试");
          });
      },
    });
  }

  function openRenameGroup(group) {
    C.openFormDialog({
      title: "分组改名",
      bodyHtml:
        "<label>分组名" +
        '<input data-field="name" name="name" maxlength="64" autocomplete="off" value="' +
        C.escapeHtml(group.name) +
        '" /></label>',
      submitLabel: "保存",
      onSubmit: function (ctrl) {
        var input = ctrl.form.querySelector('[data-field="name"]');
        var name = input ? input.value.trim() : "";
        if (!name) {
          ctrl.setError("请填写分组名");
          return;
        }
        if (state.busy) return;
        state.busy = true;
        ctrl.setBusy(true);
        api("PATCH", "/api/groups/" + encodeURIComponent(group.id), { name: name })
          .then(function (result) {
            state.busy = false;
            if (authRedirect(result.status)) return;
            if (!result.data || result.data.ok !== true) {
              ctrl.setBusy(false);
              ctrl.setError((result.data && result.data.error) || "没有保存成功，请重试");
              return;
            }
            state.notice = "已改名";
            state.noticeKind = "ok";
            ctrl.close();
            loadAll();
          })
          .catch(function () {
            state.busy = false;
            ctrl.setBusy(false);
            ctrl.setError("网络异常，请重试");
          });
      },
    });
  }

  function deleteGroup(group) {
    var anchor = confirmAnchor('[data-confirm-group="' + cssEscape(group.id) + '"]');
    C.askConfirm({
      anchor: anchor,
      title: "删除分组",
      text: "确认删除分组「" + group.name + "」吗？组内设备会回到未分组，不会被删除",
      confirmLabel: "删除",
      danger: true,
    }).then(function (yes) {
      if (!yes || state.busy) return;
      state.busy = true;
      api("DELETE", "/api/groups/" + encodeURIComponent(group.id))
        .then(function (result) {
          state.busy = false;
          if (authRedirect(result.status)) return;
          if (!result.data || result.data.ok !== true) {
            state.notice = (result.data && result.data.error) || "没有删除，请重试";
            state.noticeKind = "danger";
            render();
            return;
          }
          state.notice = "已删除分组";
          state.noticeKind = "ok";
          loadAll();
        })
        .catch(function () {
          state.busy = false;
          state.notice = "网络异常，请重试";
          state.noticeKind = "danger";
          render();
        });
    });
  }

  function togglePin(agent) {
    if (state.busy) return;
    state.busy = true;
    api("PATCH", "/api/agents/" + encodeURIComponent(agent.id), { pinned: !agent.pinned_at })
      .then(function (result) {
        state.busy = false;
        if (authRedirect(result.status)) return;
        if (!result.data || result.data.ok !== true) {
          state.notice = (result.data && result.data.error) || "没有保存，请重试";
          state.noticeKind = "danger";
          render();
          return;
        }
        state.notice = agent.pinned_at ? "已取消固定" : "已固定到侧边栏";
        state.noticeKind = "ok";
        window.dispatchEvent(new CustomEvent("hivemos:sidebar-refresh"));
        loadAll();
      })
      .catch(function () {
        state.busy = false;
        state.notice = "网络异常，请重试";
        state.noticeKind = "danger";
        render();
      });
  }

  // ---- 应用页签（条目走后端，分组页内，与 Agents 页签同一套骨架） ----

  function mapApp(row) {
    return {
      id: row.id,
      name: row.name,
      type: row.type || "",
      note: row.note || "",
      last_used: row.last_used_at ? C.formatMinute(row.last_used_at) : "还没有使用",
      group_id: row.group_id || null,
    };
  }

  function findApp(id) {
    return state.apps.items.find(function (item) {
      return item.id === id;
    });
  }

  function findAppGroup(id) {
    return state.apps.groups.find(function (item) {
      return item.id === id;
    });
  }

  function appCard(item) {
    var id = C.escapeHtml(item.id);
    return C.record({
      id: item.id,
      icon: "layout",
      title: item.name,
      pill: item.type || "",
      facts: [
        ["最近使用", C.escapeHtml(item.last_used || "还没有使用")],
        ["说明", C.escapeHtml(item.note || "无")],
      ],
      actions:
        "<button type=\"button\" class=\"secondary\" data-action=\"app-edit\" data-id=\"" + id + "\">编辑</button>",
      manage: "app:" + item.id,
    });
  }

  // ---- 管理弹窗（点卡片信息区打开；Agent 走 common 的共用构建） ----

  function openManage(key) {
    if (!key) return;
    var sep = key.indexOf(":");
    var kind = key.slice(0, sep);
    var id = key.slice(sep + 1);
    if (kind === "agent") {
      var agent = findAgent(id);
      if (!agent) return;
      C.openAgentManage(agent.id, {
        onChanged: function (message) {
          if (message) {
            state.notice = message;
            state.noticeKind = "ok";
          }
          loadAll();
        },
      });
    } else if (kind === "app") {
      var app = findApp(id);
      if (app) openAppManage(app);
    }
  }

  function openAppManage(item) {
    var id = C.escapeHtml(item.id);
    var ctrl = C.openManageDialog({
      title: item.name,
      bodyHtml:
        "<dl class=\"kv\">" +
        kv("类型", C.escapeHtml(item.type || "未注明类型")) +
        kv("最近使用", C.escapeHtml(item.last_used || "还没有使用")) +
        kv("说明", C.escapeHtml(item.note || "无")) +
        "</dl>" +
        "<div class=\"manage-actions\">" +
        "<button type=\"button\" class=\"secondary\" data-action=\"app-edit\" data-id=\"" + id + "\">编辑</button>" +
        "<button type=\"button\" class=\"danger\" data-action=\"app-delete\" data-id=\"" + id + "\">删除</button>" +
        "</div>" +
        "<div class=\"confirm-slot\" data-confirm-app-item=\"" + id + "\"></div>",
    });
    ctrl.dialog.addEventListener("click", handleClick);
  }

  function appGroupActions(group) {
    return (
      '<button type="button" class="secondary" data-action="app-rename-group" data-id="' +
      C.escapeHtml(group.id) +
      '">改名</button><button type="button" class="danger" data-action="app-delete-group" data-id="' +
      C.escapeHtml(group.id) +
      '">删除</button><span class="confirm-slot" data-confirm-app-group="' +
      C.escapeHtml(group.id) +
      '"></span>'
    );
  }

  function appsHtml() {
    return (
      '<div class="stack">' +
      C.groupedSections({
        groups: state.apps.groups,
        items: state.apps.items,
        groupOf: function (item) {
          return item.group_id || null;
        },
        renderItem: appCard,
        groupActions: appGroupActions,
        ungroupedTitle: "未分组",
        emptyGroupText: "添加应用时选择这个分组即可归入",
        emptyTitle: "还没有应用",
        emptyText: "点上方「添加应用」接入第一个",
      }) +
      "</div>"
    );
  }

  function openAppDialog(item) {
    var editing = !!item;
    C.openFormDialog({
      title: editing ? "编辑应用" : "添加应用",
      bodyHtml:
        "<label>名称" +
        '<input data-field="name" name="name" maxlength="64" autocomplete="off" value="' +
        C.escapeHtml(editing ? item.name : "") +
        '" /></label>' +
        "<label>类型" +
        '<input data-field="type" name="type" maxlength="40" autocomplete="off" placeholder="如：桌面客户端" value="' +
        C.escapeHtml(editing ? item.type : "") +
        '" /></label>' +
        "<label>说明（可选）" +
        '<textarea data-field="note" name="note" rows="2" maxlength="200">' +
        C.escapeHtml(editing ? item.note : "") +
        "</textarea></label>" +
        "<label>分组" +
        C.groupSelect("group_id", state.apps.groups, editing ? item.group_id || "" : "") +
        "</label>",
      submitLabel: editing ? "保存" : "添加应用",
      onSubmit: function (ctrl) {
        var read = function (name) {
          var el = ctrl.form.querySelector('[data-field="' + name + '"]');
          return el ? el.value.trim() : "";
        };
        var name = read("name");
        if (!name) {
          ctrl.setError("请填写名称");
          return;
        }
        var type = read("type") || "未注明类型";
        var note = read("note");
        var groupId = read("group_id") || null;
        ctrl.setBusy(true);
        api(editing ? "PATCH" : "POST", editing ? "/api/extras/apps/" + encodeURIComponent(item.id) : "/api/extras/apps", {
          name: name,
          type: type,
          note: note,
        })
          .then(function (result) {
            if (authRedirect(result.status)) return;
            if (!result.data || result.data.ok !== true || !result.data.app) {
              ctrl.setBusy(false);
              ctrl.setError((result.data && result.data.error) || "没有保存成功，请重试");
              return;
            }
            var saved = mapApp(result.data.app);
            saved.group_id = groupId;
            if (editing) {
              state.apps.items = state.apps.items.map(function (entry) {
                return entry.id === saved.id ? saved : entry;
              });
            } else {
              state.apps.items.unshift(saved);
            }
            state.notice = editing ? "已保存" : "已添加应用";
            state.noticeKind = "ok";
            ctrl.close();
            render();
          })
          .catch(function () {
            ctrl.setBusy(false);
            ctrl.setError("网络异常，请重试");
          });
      },
    });
  }

  function openAppGroupDialog(group) {
    var editing = !!group;
    C.openFormDialog({
      title: editing ? "分组改名" : "添加分组",
      bodyHtml:
        "<label>分组名" +
        '<input data-field="name" name="name" maxlength="64" autocomplete="off" value="' +
        C.escapeHtml(editing ? group.name : "") +
        '" /></label>',
      submitLabel: editing ? "保存" : "添加分组",
      onSubmit: function (ctrl) {
        var input = ctrl.form.querySelector('[data-field="name"]');
        var name = input ? input.value.trim() : "";
        if (!name) {
          ctrl.setError("请填写分组名");
          return;
        }
        var dup = state.apps.groups.some(function (item) {
          return item.name === name && (!editing || item.id !== group.id);
        });
        if (dup) {
          ctrl.setError("这个分组名已存在");
          return;
        }
        if (editing) group.name = name;
        else state.apps.groups.push({ id: "grp_app_" + ++state.apps.seq, name: name });
        state.notice = editing ? "已改名" : "已添加分组";
        state.noticeKind = "ok";
        ctrl.close();
        render();
      },
    });
  }

  function deleteAppGroup(group) {
    var anchor = confirmAnchor('[data-confirm-app-group="' + cssEscape(group.id) + '"]');
    C.askConfirm({
      anchor: anchor,
      title: "删除分组",
      text: "确认删除分组「" + group.name + "」吗？组内应用会回到未分组，不会被删除",
      confirmLabel: "删除",
      danger: true,
    }).then(function (yes) {
      if (!yes) return;
      state.apps.groups = state.apps.groups.filter(function (item) {
        return item.id !== group.id;
      });
      state.apps.items.forEach(function (item) {
        if (item.group_id === group.id) item.group_id = null;
      });
      state.notice = "已删除分组";
      state.noticeKind = "ok";
      render();
    });
  }

  function deleteApp(item) {
    var anchor = confirmAnchor('[data-confirm-app-item="' + cssEscape(item.id) + '"]');
    C.askConfirm({
      anchor: anchor,
      title: "删除应用",
      text: "确认删除「" + item.name + "」吗？删除后不可恢复",
      confirmLabel: "删除",
      danger: true,
    }).then(function (yes) {
      if (!yes) return;
      api("DELETE", "/api/extras/apps/" + encodeURIComponent(item.id))
        .then(function (result) {
          if (authRedirect(result.status)) return;
          if (!result.data || result.data.ok !== true) {
            state.notice = (result.data && result.data.error) || "没有删除，请重试";
            state.noticeKind = "danger";
            render();
            return;
          }
          state.apps.items = state.apps.items.filter(function (entry) {
            return entry.id !== item.id;
          });
          state.notice = "已删除";
          C.closeCurrentOverlay();
          state.noticeKind = "ok";
          render();
        })
        .catch(function () {
          state.notice = "网络异常，请重试";
          state.noticeKind = "danger";
          render();
        });
    });
  }

  render();
  loadAll();
})();
