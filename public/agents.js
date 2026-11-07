/* Agent 集群板块，两页签。Agents：按设备管理的方式组织，列表走
   GET /api/agents + GET /api/groups?scope=agent，按分组分区展示；添加设备/
   添加分组走弹窗，卡片高级操作（改名、移动分组、高级设置、轮换令牌、停用）
   走中央菜单，高级设置里是 per-Agent 的系统功能权限开关（PATCH 保存）。
   应用：接入 MCP 的应用条目，本地状态占位，与 Agents 页签共用同一套
   操作区、分组分区、卡片与中央菜单。令牌明文只在生成/轮换那一次响应里出现 */
(function () {
  var C = window.HiveCommon;

  // Permission domains, mirroring PERMISSION_DOMAINS in src/registry.ts.
  var PERM_DOMAINS = [
    ["registry", "注册表", "MCP 注册表的搜索、列表与取配置"],
    ["memory", "记忆", "记忆的读写与同步"],
    ["soul", "Soul", "Soul 的读写与同步"],
    ["tasks", "任务", "任务的查看与处理"],
    ["calendar", "日历", "日程的查看与编辑"],
    ["vault", "保险库", "保险库条目的取用"],
    ["machines", "云主机", "云主机状态与操作"],
  ];

  var state = {
    loading: true,
    loadError: "",
    agents: [],
    groups: [],
    notice: "",
    noticeKind: "danger",
    busy: false,
    activeTab: location.hash === "#apps" ? "apps" : "agents",
    // 应用页签的本地状态：结构与 Agents 页签一致（分组 + 条目），添加与
    // 分组在页内即时生效，接后端时把这层换成接口即可
    apps: {
      seq: 0,
      groups: [],
      items: [
        { id: "app_claude", name: "Claude 桌面端", type: "桌面客户端", note: "通过 MCP 接入注册表", last_used: "2026-11-08 03:40", group_id: null },
        { id: "app_cursor", name: "Cursor", type: "桌面客户端", note: "", last_used: "2026-11-07 22:15", group_id: null },
      ],
    },
  };

  function pill(kind, label) {
    return '<span class="status-indicator" data-status="' + kind + '">' + C.escapeHtml(label) + "</span>";
  }

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

  function card(agent) {
    var seen = C.formatMinute(agent.last_seen_at);
    var active = agent.status === "active";
    return (
      '<article class="record" id="' +
      C.escapeHtml(agent.id) +
      '"><div class="record-main"><div class="record-title-row"><h3>' +
      C.escapeHtml(agent.name) +
      "</h3>" +
      pill(active ? "ok" : "idle", active ? "已启用" : "已停用") +
      '</div><div class="row-actions"><button type="button" class="secondary" data-action="menu" data-id="' +
      C.escapeHtml(agent.id) +
      '">高级</button></div><div class="confirm-slot" data-confirm-for="' +
      C.escapeHtml(agent.id) +
      '"></div></div><dl class="kv">' +
      kv("标识", '<span class="mono">' + C.escapeHtml(agent.id) + "</span>") +
      kv("权限", C.escapeHtml(permText(agent))) +
      kv("最近调用", C.escapeHtml(seen || "还没有调用")) +
      kv("创建", C.escapeHtml(C.formatMinute(agent.created_at) || "未知")) +
      "</dl></article>"
    );
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
    var addBar = C.addBar({ addLabel: "添加设备", addAction: "open-create", groupAction: "add-group" });
    var agentsPanel = '<div class="stack">' + noticeHtml() + addBar + body + "</div>";
    C.mount(
      C.layout(
        "",
        '<div class="page-tabs" role="tablist">' +
          '<button class="page-tab" type="button" role="tab" data-tab="agents" aria-selected="' +
          (state.activeTab === "agents" ? "true" : "false") +
          '">Agents</button>' +
          '<button class="page-tab" type="button" role="tab" data-tab="apps" aria-selected="' +
          (state.activeTab === "apps" ? "true" : "false") +
          '">应用</button>' +
          "</div>" +
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
    history.replaceState(null, "", "#" + name);
  }

  var bound = false;
  function bind() {
    var page = document.getElementById("page");
    if (!page || bound) return;
    bound = true;
    page.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var tab = target.closest(".page-tab");
      if (tab) {
        activateTab(tab.getAttribute("data-tab"));
        return;
      }
      var button = target.closest("[data-action]");
      if (!button || state.busy) return;
      var action = button.getAttribute("data-action");
      var id = button.getAttribute("data-id") || "";
      if (action === "open-create") openCreate();
      else if (action === "add-group") openGroup();
      else if (action === "menu") {
        var agent = findAgent(id);
        if (agent) openMenu(agent);
      } else if (action === "rename-group") {
        var group = findGroup(id);
        if (group) openRenameGroup(group);
      } else if (action === "delete-group") {
        var target2 = findGroup(id);
        if (target2) deleteGroup(target2, button);
      } else if (action === "app-add") openAppDialog(null);
      else if (action === "app-add-group") openAppGroupDialog(null);
      else if (action === "app-menu") {
        var app = findApp(id);
        if (app) openAppMenu(app);
      } else if (action === "app-rename-group") {
        var appGroup = findAppGroup(id);
        if (appGroup) openAppGroupDialog(appGroup);
      } else if (action === "app-delete-group") {
        var appGroup2 = findAppGroup(id);
        if (appGroup2) deleteAppGroup(appGroup2);
      }
    });
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
    return Promise.all([api("GET", "/api/agents"), api("GET", "/api/groups?scope=agent")])
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

  // ---- 卡片高级菜单 ----

  function openMenu(agent) {
    var items = [
      {
        label: "改名",
        onSelect: function () {
          openRename(agent);
        },
      },
      {
        label: "移动分组",
        hint: groupNameOf(agent),
        onSelect: function () {
          openMove(agent);
        },
      },
      {
        label: "高级设置",
        hint: "系统功能权限",
        onSelect: function () {
          openPermissions(agent);
        },
      },
    ];
    if (agent.status === "active") {
      items.push({
        label: "轮换令牌",
        hint: "旧令牌立即失效",
        onSelect: function () {
          rotate(agent);
        },
      });
      items.push({
        label: "停用",
        danger: true,
        onSelect: function () {
          disable(agent);
        },
      });
    }
    C.openActionMenu({ title: agent.name, items: items });
  }

  function groupNameOf(agent) {
    if (!agent.group_id) return "未分组";
    var group = findGroup(agent.group_id);
    return group ? group.name : "未分组";
  }

  function openRename(agent) {
    C.openFormDialog({
      title: "改名",
      bodyHtml:
        "<label>名字" +
        '<input data-field="name" name="name" maxlength="64" autocomplete="off" value="' +
        C.escapeHtml(agent.name) +
        '" /></label>',
      submitLabel: "保存",
      onSubmit: function (ctrl) {
        var input = ctrl.form.querySelector('[data-field="name"]');
        var name = input ? input.value.trim() : "";
        if (!name) {
          ctrl.setError("请填写设备名字");
          return;
        }
        patchAgent(ctrl, agent.id, { name: name }, "已改名");
      },
    });
  }

  function openMove(agent) {
    C.openFormDialog({
      title: "移动分组",
      bodyHtml: "<label>分组" + C.groupSelect("group_id", state.groups, agent.group_id || "") + "</label>",
      submitLabel: "保存",
      onSubmit: function (ctrl) {
        var input = ctrl.form.querySelector('[data-field="group_id"]');
        var groupId = input ? input.value : "";
        patchAgent(ctrl, agent.id, { group_id: groupId || null }, "已移动分组");
      },
    });
  }

  function patchAgent(ctrl, id, body, okText) {
    if (state.busy) return;
    state.busy = true;
    ctrl.setBusy(true);
    api("PATCH", "/api/agents/" + encodeURIComponent(id), body)
      .then(function (result) {
        state.busy = false;
        if (authRedirect(result.status)) return;
        if (!result.data || result.data.ok !== true) {
          ctrl.setBusy(false);
          ctrl.setError((result.data && result.data.error) || "没有保存成功，请重试");
          return;
        }
        state.notice = okText;
        state.noticeKind = "ok";
        ctrl.close();
        loadAll();
      })
      .catch(function () {
        state.busy = false;
        ctrl.setBusy(false);
        ctrl.setError("网络异常，请重试");
      });
  }

  function openPermissions(agent) {
    var enabled = new Set(agent.permissions || []);
    var rows = PERM_DOMAINS.map(function (entry) {
      var on = enabled.has(entry[0]);
      return (
        '<div class="perm-row"><div class="perm-meta"><strong>' +
        C.escapeHtml(entry[1]) +
        '</strong><span class="subtle">' +
        C.escapeHtml(entry[0] + " · " + entry[2]) +
        '</span></div><button type="button" class="switch" role="switch" aria-checked="' +
        (on ? "true" : "false") +
        '" data-domain="' +
        C.escapeHtml(entry[0]) +
        '" aria-label="' +
        C.escapeHtml(entry[1]) +
        '"><span class="switch-knob"></span></button></div>'
      );
    }).join("");
    var ctrl = C.openFormDialog({
      title: "高级设置",
      bodyHtml:
        '<p class="subtle field-hint">设置这个 Agent 通过面板 MCP 能访问的系统功能，保存后立即生效</p><div class="perm-list">' +
        rows +
        "</div>",
      submitLabel: "保存权限",
      onSubmit: function (c) {
        var perms = PERM_DOMAINS.filter(function (entry) {
          var btn = c.form.querySelector('[data-domain="' + entry[0] + '"]');
          return btn && btn.getAttribute("aria-checked") === "true";
        }).map(function (entry) {
          return entry[0];
        });
        patchAgent(c, agent.id, { permissions: perms }, "已保存权限");
      },
    });
    ctrl.dialog.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var btn = target.closest(".switch");
      if (!btn) return;
      btn.setAttribute("aria-checked", btn.getAttribute("aria-checked") === "true" ? "false" : "true");
    });
  }

  function rotate(agent) {
    var anchor = confirmAnchor('[data-confirm-for="' + cssEscape(agent.id) + '"]');
    C.askConfirm({
      anchor: anchor,
      title: "轮换令牌",
      text: "确认轮换「" + agent.name + "」的令牌吗？旧令牌会立即失效",
      confirmLabel: "轮换",
      danger: true,
    }).then(function (yes) {
      if (!yes || state.busy) return;
      state.busy = true;
      api("POST", "/api/agents/" + encodeURIComponent(agent.id) + "/rotate")
        .then(function (result) {
          state.busy = false;
          if (authRedirect(result.status)) return;
          if (!result.data || result.data.ok !== true || !result.data.token) {
            state.notice = (result.data && result.data.error) || "没有轮换成功，请重试";
            state.noticeKind = "danger";
            render();
            return;
          }
          var ctrl = C.openFormDialog({
            title: "新令牌",
            bodyHtml: "",
            submitLabel: "完成",
            onSubmit: function (c) {
              c.close();
            },
          });
          ctrl.showResult(
            "<p>新令牌只显示这一次。旧令牌已经失效，请立刻复制并换到设备上</p>" + C.copyLine(result.data.token, "复制令牌"),
            "我已复制",
          );
        })
        .catch(function () {
          state.busy = false;
          state.notice = "网络异常，请重试";
          state.noticeKind = "danger";
          render();
        });
    });
  }

  function disable(agent) {
    var anchor = confirmAnchor('[data-confirm-for="' + cssEscape(agent.id) + '"]');
    C.askConfirm({
      anchor: anchor,
      title: "停用设备",
      text: "确认停用「" + agent.name + "」吗？停用后该令牌不能再调用注册表",
      confirmLabel: "停用",
      danger: true,
    }).then(function (yes) {
      if (!yes || state.busy) return;
      state.busy = true;
      api("DELETE", "/api/agents/" + encodeURIComponent(agent.id))
        .then(function (result) {
          state.busy = false;
          if (authRedirect(result.status)) return;
          if (!result.data || result.data.ok !== true) {
            state.notice = (result.data && result.data.error) || "没有停用，请重试";
            state.noticeKind = "danger";
            render();
            return;
          }
          state.notice = "已停用";
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

  // ---- 应用页签（本地状态，与 Agents 页签同一套骨架） ----

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
    return C.record({
      id: item.id,
      title: item.name,
      lede: item.type,
      facts: [
        ["类型", C.escapeHtml(item.type)],
        ["最近使用", C.escapeHtml(item.last_used || "还没有使用")],
        ["说明", C.escapeHtml(item.note || "无")],
      ],
      extra:
        '<div class="row-actions"><button type="button" class="secondary" data-action="app-menu" data-id="' +
        C.escapeHtml(item.id) +
        '">高级</button></div><div class="confirm-slot" data-confirm-app-item="' +
        C.escapeHtml(item.id) +
        '"></div>',
    });
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
      C.addBar({ addLabel: "添加应用", addAction: "app-add", groupAction: "app-add-group" }) +
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
        if (editing) {
          item.name = name;
          item.type = type;
          item.note = note;
          item.group_id = groupId;
        } else {
          state.apps.items.unshift({
            id: "app_local_" + ++state.apps.seq,
            name: name,
            type: type,
            note: note,
            last_used: "还没有使用",
            group_id: groupId,
          });
        }
        state.notice = editing ? "已保存" : "已添加应用";
        state.noticeKind = "ok";
        ctrl.close();
        render();
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

  function openAppMenu(item) {
    C.openActionMenu({
      title: item.name,
      items: [
        {
          label: "编辑",
          onSelect: function () {
            openAppDialog(item);
          },
        },
        {
          label: "删除",
          danger: true,
          onSelect: function () {
            deleteApp(item);
          },
        },
      ],
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
      state.apps.items = state.apps.items.filter(function (entry) {
        return entry.id !== item.id;
      });
      state.notice = "已删除";
      state.noticeKind = "ok";
      render();
    });
  }

  render();
  loadAll();
})();
