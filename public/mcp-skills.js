/* MCP 与 Skills 合并板块。MCP 注册表走 /api/mcp-servers，Skills 与 API 走
   /api/extras/skills 与 /api/extras/apis；三个页签的分组都走
   /api/groups?scope=mcp 同一套分组池。三个页签共用同一套操作区、
   分组分区、卡片与中央高级菜单组件 */
(function () {
  var C = window.HiveCommon;
  var state = {
    loading: true,
    loadError: "",
    servers: [],
    groups: [],
    audit: [],
    selectedId: "",
    mode: "create",
    draft: emptyDraft(),
    snapshotText: "",
    notice: "",
    noticeKind: "danger",
    busy: false,
    // Skills / API 页签的条目走 /api/extras/*（load 时拉取）；分组与 MCP
    // 页签共用后端 scope=mcp 分组池（state.groups），这里只留条目数组
    local: {
      seq: 0,
      skills: { groups: [], items: [] },
      api: { groups: [], items: [] },
    },
  };

  function emptyDraft() {
    return {
      name: "",
      title: "",
      description: "",
      endpoint_url: "",
      transport: "http",
      launch_config_json: "",
      auth_type: "bearer",
      config_json: "",
      tags: "",
      category: "",
      group_id: "",
      summary: "",
      status: "active",
      ttl_seconds: "86400",
    };
  }

  function selected() {
    return state.servers.find(function (server) {
      return server.id === state.selectedId;
    });
  }

  function humanTagText(server) {
    return (server.tags || [])
      .filter(function (tag) {
        return tag.source === "human";
      })
      .map(function (tag) {
        return tag.text;
      })
      .join(", ");
  }

  function draftFrom(server) {
    return {
      name: server.name || "",
      title: server.title || "",
      description: server.description || "",
      endpoint_url: server.endpoint_url || "",
      transport: server.transport || "http",
      launch_config_json: server.launch_config_json || "",
      auth_type: server.auth_type || "none",
      config_json: server.config_json || "",
      tags: humanTagText(server),
      category: server.category || "",
      group_id: server.group_id || "",
      summary: server.summary_source === "human" ? server.summary || "" : "",
      status: server.status || "active",
      ttl_seconds: String(server.ttl_seconds || 86400),
    };
  }

  function pill(kind, label) {
    return '<span class="status-indicator" data-status="' + kind + '">' + C.escapeHtml(label) + "</span>";
  }

  function kv(label, html) {
    return "<div><dt>" + C.escapeHtml(label) + "</dt><dd>" + html + "</dd></div>";
  }

  function tagsHtml(tags) {
    if (!tags || !tags.length) return '<p class="subtle">无标签</p>';
    return (
      '<div class="tag-row">' +
      tags
        .map(function (tag) {
          var source = tag.source === "ai" ? "ai" : "human";
          var mark = source === "ai" ? "AI" : "人工";
          return '<span class="tag tag-' + source + '">' + C.escapeHtml(tag.text) + '<span class="tag-source">' + mark + "</span></span>";
        })
        .join("") +
      "</div>"
    );
  }

  function snapshotMeta(server) {
    var map = {
      ok: ["ok", "探活成功"],
      failed: ["danger", "探活失败"],
      manual: ["warn", "手填"],
      none: ["idle", "尚无快照"],
    };
    return map[server.snapshot_status] || map.none;
  }

  function copyBlock(value, label) {
    if (!value) return '<p class="subtle">未填写</p>';
    return (
      '<div class="copy-block"><pre class="config-block">' +
      C.escapeHtml(value) +
      '</pre><button type="button" class="copy-btn" data-copy="' +
      C.escapeHtml(value) +
      '" data-label="' +
      C.escapeHtml(label) +
      '">' +
      C.escapeHtml(label) +
      "</button></div>"
    );
  }

  function choices(name, current, options) {
    return (
      '<div class="choice-row" role="group">' +
      options
        .map(function (option) {
          var pressed = option[0] === current ? "true" : "false";
          return (
            '<button type="button" class="secondary" data-choice="' +
            C.escapeHtml(name) +
            '" data-value="' +
            C.escapeHtml(option[0]) +
            '" aria-pressed="' +
            pressed +
            '">' +
            C.escapeHtml(option[1]) +
            "</button>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function field(label, control, hint) {
    return "<label>" + C.escapeHtml(label) + control + (hint ? '<p class="subtle field-hint">' + C.escapeHtml(hint) + "</p>" : "") + "</label>";
  }

  function input(name, value, extra) {
    return '<input data-field="' + name + '" name="' + name + '" value="' + C.escapeHtml(value) + '" ' + (extra || "") + " />";
  }

  function area(name, value, rows) {
    return '<textarea data-field="' + name + '" name="' + name + '" rows="' + rows + '">' + C.escapeHtml(value) + "</textarea>";
  }

  function noticeHtml() {
    if (state.notice) {
      var text = state.notice;
      var kind = state.noticeKind;
      state.notice = "";
      C.toast(text, kind === "ok" ? "ok" : kind === "warn" ? "warn" : "danger");
    }
    return "";
  }


  function card(server) {
    var meta = snapshotMeta(server);
    var time = C.formatMinute(server.snapshot_at);
    var id = C.escapeHtml(server.id);
    return C.record({
      id: server.id,
      className: server.id === state.selectedId ? "is-selected" : "",
      icon: "plug",
      title: server.title,
      pill: server.transport || "",
      status: server.status === "active" ? "enabled" : "disabled",
      extra: "<p class=\"mono\">" + C.escapeHtml(server.name) + "</p>" + tagsHtml(server.tags),
      facts: [
        ["分类", C.escapeHtml(server.category || "未分类")],
        ["快照", pill(meta[0], meta[1]) + (time ? " <span class=\"subtle\">" + C.escapeHtml(time) + "</span>" : "")],
        ["版本", "<span class=\"mono\">v" + C.escapeHtml(String(server.version)) + "</span>"],
      ],
      actions:
        "<button type=\"button\" class=\"secondary\" data-action=\"refresh\" data-id=\"" + id + "\">刷新快照</button>" +
        "<button type=\"button\" class=\"secondary\" data-copy=\"" + C.escapeHtml(server.endpoint_url || "") + "\" data-label=\"复制地址\">复制地址</button>",
      manage: "mcp:" + server.id,
    });
  }

  // ---- 管理弹窗（点卡片信息区打开） ----

  function openManage(key) {
    if (!key) return;
    var sep = key.indexOf(":");
    var kind = key.slice(0, sep);
    var id = key.slice(sep + 1);
    if (kind === "mcp") {
      var server = state.servers.find(function (item) {
        return item.id === id;
      });
      if (server) openServerManage(server);
    } else if (kind === "skills" || kind === "api") {
      var item = findLocalItem(kind, id);
      if (item) openLocalManage(kind, item);
    }
  }

  function openServerManage(server) {
    var id = C.escapeHtml(server.id);
    var meta = snapshotMeta(server);
    var aiMap = { pending: "打标中", done: "已打标", failed: "打标失败", skipped: "未打标" };
    var tools = server.snapshot && server.snapshot.tools ? server.snapshot.tools : [];
    var toolList = tools.length
      ? '<ul class="tool-list">' +
        tools
          .map(function (tool) {
            return "<li><p class=\"mono tool-name\">" + C.escapeHtml(tool.name) + "</p></li>";
          })
          .join("") +
        "</ul>"
      : C.emptyState("还没有工具快照", "http 与 sse 可以用卡片上的刷新快照探活，stdio 请用手填快照");
    var ctrl = C.openManageDialog({
      size: "lg",
      hideHead: true,
      title: server.title,
      bodyHtml:
        C.manageInfoHead({
          icon: "plug",
          title: server.title,
          sub: (server.status === "active" ? "已启用" : "已停用") + " · " + (server.transport || "") + " · MCP",
        }) +
        "<div class=\"manage-info-card\"><dl class=\"kv\">" +
        kv(
          "端点",
          "<span class=\"mono\">" +
            C.escapeHtml(server.endpoint_url || "") +
            "</span> <button type=\"button\" class=\"copy-btn\" data-copy=\"" +
            C.escapeHtml(server.endpoint_url || "") +
            "\" data-label=\"复制\">复制</button>"
        ) +
        kv("状态", pill(server.status === "active" ? "ok" : "idle", server.status === "active" ? "已启用" : "已停用")) +
        "</dl></div>" +
        "<div class=\"page-tabs manage-tabs\" role=\"tablist\" aria-label=\"MCP 管理\">" +
        "<button type=\"button\" class=\"page-tab\" role=\"tab\" data-mtab=\"overview\" aria-selected=\"true\">概览</button>" +
        "<button type=\"button\" class=\"page-tab\" role=\"tab\" data-mtab=\"snapshot\" aria-selected=\"false\">快照</button>" +
        "<button type=\"button\" class=\"page-tab\" role=\"tab\" data-mtab=\"settings\" aria-selected=\"false\">设置</button>" +
        "</div>" +
        "<div data-mpanel=\"overview\">" +
        "<dl class=\"kv\">" +
        kv("传输", C.escapeHtml(server.transport)) +
        kv("鉴权", C.escapeHtml(server.auth_type)) +
        kv("分类", C.escapeHtml(server.category || "未分类")) +
        kv("快照", meta[1] + " · " + (C.formatMinute(server.snapshot_at) || "尚无")) +
        kv("AI 打标", aiMap[server.ai_status] || "未打标") +
        "</dl>" +
        "<div class=\"manage-actions\">" +
        "<button type=\"button\" class=\"secondary\" data-copy=\"" +
        C.escapeHtml(server.endpoint_url || "") +
        "\" data-label=\"复制地址\">复制地址</button>" +
        "</div>" +
        "</div>" +
        "<div data-mpanel=\"snapshot\" hidden>" +
        "<dl class=\"kv\">" +
        kv("快照状态", meta[1]) +
        kv("快照时间", C.formatMinute(server.snapshot_at) || "尚无") +
        kv("工具数量", String(tools.length) + " 个") +
        "</dl>" +
        toolList +
        "<div class=\"manage-actions\">" +
        "<button type=\"button\" class=\"secondary\" data-action=\"snapshot\" data-id=\"" + id + "\">手填快照</button>" +
        "<button type=\"button\" class=\"secondary\" data-action=\"open\" data-id=\"" + id + "\">查看详情</button>" +
        "</div>" +
        "</div>" +
        "<div data-mpanel=\"settings\" hidden>" +
        "<div class=\"manage-actions\">" +
        "<button type=\"button\" class=\"secondary\" data-action=\"edit\" data-id=\"" + id + "\">编辑条目</button>" +
        "<button type=\"button\" class=\"danger\" data-confirm-delete data-action=\"delete\" data-id=\"" + id + "\">删除条目</button>" +
        "</div>" +
        "</div>",
    });
    wireDialog(ctrl);
    C.wireManageTabs(ctrl);
  }

  function detailHtml(server) {
    if (!server) {
      return C.section("详情", "", C.emptyState("还没有选中条目", ""));
    }
    var meta = snapshotMeta(server);
    var time = C.formatMinute(server.snapshot_at) || "尚无";
    var aiMap = { pending: ["warn", "打标中"], done: ["ok", "已打标"], failed: ["danger", "打标失败"], skipped: ["idle", "未打标"] };
    var ai = aiMap[server.ai_status] || aiMap.skipped;
    var tools = server.snapshot && server.snapshot.tools ? server.snapshot.tools : [];
    var toolList = tools.length
      ? '<ul class="tool-list">' +
        tools
          .map(function (tool) {
            return (
              "<li><p class=\"mono tool-name\">" +
              C.escapeHtml(tool.name) +
              "</p>" +
              (tool.description ? "<p>" + C.escapeHtml(tool.description) + "</p>" : "") +
              "</li>"
            );
          })
          .join("") +
        "</ul>" +
        copyBlock(JSON.stringify(server.snapshot, null, 2), "复制快照")
      : C.emptyState("还没有工具快照", "http 与 sse 可以刷新探活，stdio 请用手填快照");
    var audits = state.audit.filter(function (item) {
      return item.server_id === server.id;
    });
    var auditHtml = audits.length
      ? '<ul class="feed">' +
        audits
          .map(function (item) {
            var when = C.feedStamp(item.created_at) || "未知时间";
            var who = item.agent_name || "未知 Agent";
            return "<li><time>" + when + "</time><span>" + C.escapeHtml(who) + " 取过配置</span></li>";
          })
          .join("") +
        "</ul>"
      : C.emptyState("还没有获取记录", "");
    return (
      '<section class="panel" id="mcp-detail"><div class="section-head"><h2>' +
      C.escapeHtml(server.title) +
      '</h2><p class="subtle mono">' +
      C.escapeHtml(server.name) +
      "</p></div>" +
      '<dl class="kv">' +
      kv("状态", pill(server.status === "active" ? "ok" : "idle", server.status === "active" ? "已启用" : "已停用")) +
      kv("传输", C.escapeHtml(server.transport)) +
      kv("鉴权", C.escapeHtml(server.auth_type)) +
      kv("分类", C.escapeHtml(server.category || "未分类")) +
      kv("版本", '<span class="mono">v' + C.escapeHtml(String(server.version)) + "</span>") +
      kv("存活", '<span class="mono">' + C.escapeHtml(String(server.ttl_seconds)) + "</span> 秒") +
      kv("快照", pill(meta[0], meta[1]) + " " + C.escapeHtml(time)) +
      kv("打标", pill(ai[0], ai[1])) +
      "</dl>" +
      "<h3>端点</h3>" +
      copyBlock(server.endpoint_url, "复制端点") +
      "<h3>配置</h3>" +
      copyBlock(server.config_json, "复制配置") +
      "<h3>启动配置</h3>" +
      copyBlock(server.launch_config_json, "复制启动配置") +
      "<h3>标签</h3>" +
      tagsHtml(server.tags) +
      "<h3>简介</h3>" +
      (server.summary
        ? "<p>" + C.escapeHtml(server.summary) + ' <span class="subtle">' + (server.summary_source === "human" ? "人工" : "AI") + "</span></p>"
        : '<p class="subtle">还没有简介</p>') +
      "<h3>工具快照</h3>" +
      toolList +
      "<h3>最近获取</h3>" +
      auditHtml +
      '<div class="row-actions"><button type="button" data-action="refresh" data-id="' +
      C.escapeHtml(server.id) +
      '">刷新快照</button><button type="button" class="secondary" data-action="snapshot" data-id="' +
      C.escapeHtml(server.id) +
      '">手填快照</button><button type="button" class="danger" data-confirm-delete data-action="delete" data-id="' +
      C.escapeHtml(server.id) +
      '">删除</button></div></section>'
    );
  }

  // Fields only: the dialog supplies the <form>, title and actions.
  function formFieldsHtml() {
    var draft = state.draft;
    var current = state.mode === "edit" ? selected() : null;
    var aiHint = current && current.summary_source === "ai" && current.summary ? "当前 AI 简介：" + current.summary : "留空时由 AI 补一句，已有人工简介不会被覆盖";
    // 登记只留常用字段，其余在编辑里补全。
    if (state.mode !== "edit") {
      return (
        field("名称", input("name", draft.name, 'maxlength="64" spellcheck="false" autocomplete="off"'), "小写字母、数字、下划线或连字符") +
        field("端点", input("endpoint_url", draft.endpoint_url, 'spellcheck="false" autocomplete="off"'), "http 与 sse 填 URL，stdio 填启动命令") +
        field("传输", choices("transport", draft.transport, [["http", "http"], ["sse", "sse"], ["stdio", "stdio"]])) +
        field("鉴权", choices("auth_type", draft.auth_type, [["none", "无"], ["bearer", "Bearer"], ["oauth", "OAuth"]])) +
        field("配置 JSON", area("config_json", draft.config_json, 5), "密钥写成 {{vault://路径}} 占位，不要粘贴真实令牌") +
        field("分组", C.groupSelect("group_id", state.groups, draft.group_id))
      );
    }
    return (
      field("名称", input("name", draft.name, 'maxlength="64" spellcheck="false" autocomplete="off"'), "小写字母、数字、下划线或连字符") +
      field("标题", input("title", draft.title, 'maxlength="120"')) +
      field("说明", area("description", draft.description, 3)) +
      field("端点", input("endpoint_url", draft.endpoint_url, 'spellcheck="false" autocomplete="off"'), "http 与 sse 填 URL，stdio 填启动命令") +
      field("传输", choices("transport", draft.transport, [["http", "http"], ["sse", "sse"], ["stdio", "stdio"]])) +
      field("鉴权", choices("auth_type", draft.auth_type, [["none", "无"], ["bearer", "Bearer"], ["oauth", "OAuth"]])) +
      field("启动配置 JSON", area("launch_config_json", draft.launch_config_json, 4), "留空表示没有。需要时填 JSON") +
      field("配置 JSON", area("config_json", draft.config_json, 5), "密钥写成 {{vault://路径}} 占位，不要粘贴真实令牌") +
      field("标签", input("tags", draft.tags, 'placeholder="邮件, inbox"'), "逗号分隔，保存为人工标签") +
      field("分类", input("category", draft.category, 'maxlength="40"')) +
      field("分组", C.groupSelect("group_id", state.groups, draft.group_id)) +
      field("简介", input("summary", draft.summary, 'maxlength="200"'), aiHint) +
      field("状态", choices("status", draft.status, [["active", "已启用"], ["disabled", "已停用"]])) +
      field("存活秒数", input("ttl_seconds", draft.ttl_seconds, 'inputmode="numeric"'), "Agent 在这段时间内复用配置，过期后重新 mcp_get")
    );
  }

  var activeTab = location.hash === "#skills" ? "skills" : location.hash === "#api" ? "api" : "mcp";

  // ---- 三个页签共用的列表骨架 ----
  // 操作区（C.addBar）、分组分区（C.groupedSections）、卡片（C.record）与
  // 分组 section 头操作在三个页签里是同一套渲染；差异只在 data-action 前缀
  // 与卡片内容。三个页签的分组都走后端 scope=mcp 分组池

  function groupActionsFor(scope) {
    return function (group) {
      var prefix = scope === "mcp" || scope === "skills" || scope === "api" ? "" : "local-";
      var scopeAttr = scope === "mcp" ? "" : ' data-scope="' + scope + '"';
      var gid = C.escapeHtml(group.id);
      return (
        '<button type="button" class="icon-btn ghost group-menu-btn" data-action="' +
        prefix +
        'group-menu" data-id="' +
        gid +
        '"' +
        scopeAttr +
        ' aria-label="分组操作" aria-haspopup="menu">' +
        GROUP_MENU_ICON +
        "</button>" +
        '<span class="confirm-slot" data-confirm-group="' +
        gid +
        '"></span>'
      );
    };
  }

  // 分组头只留一个三条线菜单按钮：改名/删除收进 C.openActionMenu；
  // 删除沿用机器页 deleteGroupFlow 的 askConfirm 文案做二次确认。
  var GROUP_MENU_ICON =
    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';

  function confirmDeleteGroup(group, btn, run) {
    var section = btn ? btn.closest("section") : null;
    var slot = section ? section.querySelector('[data-confirm-group="' + group.id + '"]') : null;
    C.askConfirm({
      anchor: slot || btn,
      title: "删除分组",
      text: "确认删除分组「" + group.name + "」吗？组内条目会回到未分组，不会被删除",
      confirmLabel: "删除",
      danger: true,
    }).then(function (yes) {
      if (yes) run();
    });
  }

  function openGroupMenu(group, btn, renameFn, deleteFn) {
    C.openActionMenu({
      items: [
        { label: "改名", onSelect: renameFn },
        {
          label: "删除",
          danger: true,
          onSelect: function () {
            confirmDeleteGroup(group, btn, deleteFn);
          },
        },
      ],
    });
  }


  function groupedHtml(scope, groups, items, renderItem, emptyText) {
    return C.groupedSections({
      cardGrid: true,
      groups: groups,
      items: items,
      groupOf: function (item) {
        return item.group_id || null;
      },
      renderItem: renderItem,
      groupActions: groupActionsFor(scope),
      ungroupedTitle: "未分组",
      emptyGroupText: "添加时选择这个分组即可归入",
      emptyTitle: "暂无内容",
      emptyText: emptyText,
    });
  }

  function openLocalManage(scope, item) {
    var id = C.escapeHtml(item.id);
    var facts;
    if (scope === "skills") {
      facts =
        kv("版本", C.escapeHtml(item.version)) +
        kv("引用", C.escapeHtml(item.used || "暂无")) +
        kv("来源", C.escapeHtml(item.source || "未注明"));
    } else {
      facts =
        kv("端点", C.escapeHtml(item.base)) +
        kv("鉴权", C.escapeHtml(item.auth)) +
        kv("说明", C.escapeHtml(item.note || "无"));
    }
    var ctrl = C.openManageDialog({
      hideHead: true,
      title: item.name,
      bodyHtml:
        C.manageInfoHead({
          icon: scope === "skills" ? "puzzle" : "gateway",
          title: item.name,
          sub: scope === "skills" ? (item.source || "未注明来源") + " · 技能" : (item.auth || "") + " · API",
        }) +
        "<dl class=\"kv\">" + facts + "</dl>" +
        "<div class=\"manage-actions\">" +
        "<button type=\"button\" class=\"secondary\" data-action=\"local-edit\" data-scope=\"" + scope + "\" data-id=\"" + id + "\">编辑</button>" +
        "<button type=\"button\" class=\"danger\" data-confirm-delete data-action=\"local-delete\" data-scope=\"" + scope + "\" data-id=\"" + id + "\">删除</button>" +
        "</div>"
    });
    wireDialog(ctrl);
  }

  function skillsCard(item) {
    return C.record({
      id: item.id,
      icon: "puzzle",
      title: item.name,
      status: item.status,
      pill: item.source || "",
      facts: [
        ["版本", C.escapeHtml(item.version)],
        ["引用", C.escapeHtml(item.used || "暂无")],
      ],
      actions:
        "<button type=\"button\" class=\"secondary\" data-copy=\"" + C.escapeHtml(item.content || "") + "\" data-label=\"复制正文\">复制正文</button>",
      manage: "skills:" + item.id,
    });
  }

  function skillsHtml() {
    var store = state.local.skills;
    return (
      '<div class="stack">' +
      groupedHtml("skills", state.groups, store.items, skillsCard, "点上方「添加技能」登记第一个") +
      C.section("待审核", "", C.emptyState("没有待审核的技能", "")) +
      "</div>"
    );
  }

  function apiCard(item) {
    return C.record({
      id: item.id,
      icon: "gateway",
      title: item.name,
      status: item.status,
      lede: item.note,
      facts: [
        ["端点", C.escapeHtml(item.base)],
        ["鉴权", C.escapeHtml(item.auth)],
      ],
      actions:
        "<button type=\"button\" class=\"secondary\" data-copy=\"" + C.escapeHtml(item.base || "") + "\" data-label=\"复制地址\">复制地址</button>",
      manage: "api:" + item.id,
    });
  }

  function apiHtml() {
    var store = state.local.api;
    return (
      '<div class="stack">' +
      groupedHtml("api", state.groups, store.items, apiCard, "点上方「添加 API」登记第一个") +
      "</div>"
    );
  }

  function activateTab(name) {
    activeTab = name;
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

  function render() {
    var body = noticeHtml();
    if (state.loading) body += C.section("服务", "", C.emptyState("正在读取", ""));
    else if (state.loadError) body += C.section("服务", "", '<p class="callout danger" role="alert">' + C.escapeHtml(state.loadError) + "</p>");
    else {
      body += groupedHtml("mcp", state.groups, state.servers, card, "点上方「添加条目」登记第一条");
      body += detailHtml(selected());
    }
    var head =
      '<div class="page-head"><div class="page-tabs" role="tablist">' +
      '<button class="page-tab" type="button" role="tab" data-tab="mcp" aria-selected="' +
      (activeTab === "mcp" ? "true" : "false") +
      '">MCP</button>' +
      '<button class="page-tab" type="button" role="tab" data-tab="skills" aria-selected="' +
      (activeTab === "skills" ? "true" : "false") +
      '">Skills</button>' +
      '<button class="page-tab" type="button" role="tab" data-tab="api" aria-selected="' +
      (activeTab === "api" ? "true" : "false") +
      '">API</button>' +
      "</div>" +
      '<div class="page-head-actions" data-head-actions="mcp"' +
      (activeTab === "mcp" ? "" : " hidden") +
      ">" +
      C.addBar({ addLabel: "添加 MCP", addAction: "add", groupAction: "add-group" }) +
      "</div>" +
      '<div class="page-head-actions" data-head-actions="skills"' +
      (activeTab === "skills" ? "" : " hidden") +
      ">" +
      C.addBar({ addLabel: "添加 Skill", addAction: "local-add", groupAction: "add-group" }) +
      "</div>" +
      '<div class="page-head-actions" data-head-actions="api"' +
      (activeTab === "api" ? "" : " hidden") +
      ">" +
      C.addBar({ addLabel: "添加 API", addAction: "local-add", groupAction: "add-group" }) +
      "</div></div>";
    C.mount(
      C.layout(
        head +
          "<div data-panel=\"mcp\"" +
          (activeTab === "mcp" ? "" : " hidden") +
          "><div class=\"stack\">" +
          body +
          "</div></div>" +
          "<div data-panel=\"skills\"" +
          (activeTab === "skills" ? "" : " hidden") +
          ">" +
          skillsHtml() +
          "</div>" +
          "<div data-panel=\"api\"" +
          (activeTab === "api" ? "" : " hidden") +
          ">" +
          apiHtml() +
          "</div>"
      )
    );
    bind();
  }

  var bound = false;
  function bind() {
    var page = document.getElementById("page");
    if (!page || bound) return;
    bound = true;
    page.addEventListener("input", onInput);
    page.addEventListener("click", onClick);
  }

  function onInput(event) {
    var target = event.target;
    if (!(target instanceof HTMLElement)) return;
    var key = target.getAttribute("data-field");
    if (!key) return;
    if (key === "snapshotText") state.snapshotText = target.value;
    else if (state.draft) state.draft[key] = target.value;
  }

  function onClick(event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var tab = target.closest(".page-tab");
    if (tab) {
      activateTab(tab.getAttribute("data-tab"));
      return;
    }
    var choice = target.closest("[data-choice]");
    if (choice) {
      var group = choice.getAttribute("data-choice");
      var value = choice.getAttribute("data-value") || "";
      if (group && state.draft) state.draft[group] = value;
      var row = choice.parentElement;
      if (row) {
        row.querySelectorAll("[data-choice]").forEach(function (peer) {
          peer.setAttribute("aria-pressed", peer === choice ? "true" : "false");
        });
      }
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
    var id = button.getAttribute("data-id") || state.selectedId;
    if (action === "open") { openServer(id, true); C.closeCurrentOverlay(); }
    else if (action === "add") openCreateDialog();
    else if (action === "edit") { openEditDialog(id); C.closeCurrentOverlay(); }
    else if (action === "snapshot") { openSnapshotDialog(id); C.closeCurrentOverlay(); }
    else if (action === "refresh") refresh(id);
    else if (action === "delete") removeServer(id, button);
    else if (action === "add-group") openGroupDialog();
    else if (action === "group-menu") {
      var group = findGroup(id);
      if (group)
        openGroupMenu(
          group,
          button,
          function () { openRenameGroupDialog(group); },
          function () { deleteGroupFlow(group); }
        );
    } else if (action === "local-add") openLocalDialog(activeTab, null);
    else if (action === "local-add-group") openLocalGroupDialog(activeTab, null);
    else if (action === "local-edit") {
      var editScope = button.getAttribute("data-scope") || "";
      var editItem = findLocalItem(editScope, id);
      if (editItem) openLocalDialog(editScope, editItem);
    } else if (action === "local-delete") {
      var delScope2 = button.getAttribute("data-scope") || "";
      var delItem = findLocalItem(delScope2, id);
      if (delItem) deleteLocalItem(delScope2, delItem);
    } else if (action === "local-group-menu") {
      var menuScope = button.getAttribute("data-scope") || "";
      var localGroup = findLocalGroup(menuScope, id);
      if (localGroup)
        openGroupMenu(
          localGroup,
          button,
          function () { openLocalGroupDialog(menuScope, localGroup); },
          function () { deleteLocalGroup(menuScope, localGroup); }
        );
    }
  }

  // The dialog lives outside #page, so the page-level delegation never
  // sees its events; wire the same handlers onto the dialog element so
  // data-field inputs and data-choice groups keep updating state.draft.
  function wireDialog(ctrl) {
    ctrl.dialog.addEventListener("input", onInput);
    ctrl.dialog.addEventListener("change", onInput);
    ctrl.dialog.addEventListener("click", onClick);
  }

  function openServerDialog() {
    var creating = state.mode !== "edit";
    var ctrl = C.openFormDialog({
      title: creating ? "登记条目" : "编辑条目",
      bodyHtml: formFieldsHtml(),
      submitLabel: creating ? "登记条目" : "保存修改",
      size: creating ? "md" : "lg",
      onSubmit: function (c) {
        saveServer(c);
      },
    });
    wireDialog(ctrl);
  }

  function openCreateDialog() {
    if (state.busy) return;
    state.mode = "create";
    state.draft = emptyDraft();
    openServerDialog();
  }

  function openEditDialog(id) {
    var server = state.servers.find(function (item) {
      return item.id === id;
    });
    if (!server || state.busy) return;
    state.selectedId = id;
    state.mode = "edit";
    state.draft = draftFrom(server);
    state.snapshotText = server.snapshot ? JSON.stringify(server.snapshot, null, 2) : "";
    render();
    openServerDialog();
  }

  function openSnapshotDialog(id) {
    var server = state.servers.find(function (item) {
      return item.id === id;
    });
    if (!server || state.busy) return;
    if (state.selectedId !== id) openServer(id, false);
    var ctrl = C.openFormDialog({
      title: "手填快照",
      bodyHtml:
        '<p class="subtle field-hint">stdio 不能自动探活</p>' +
        '<textarea data-field="snapshotText" rows="8">' +
        C.escapeHtml(state.snapshotText) +
        "</textarea>",
      submitLabel: "保存手填快照",
      size: "md",
      onSubmit: function (c) {
        saveSnapshot(c);
      },
    });
    wireDialog(ctrl);
  }

  function openServer(id, scroll) {
    var server = state.servers.find(function (item) {
      return item.id === id;
    });
    if (!server) return;
    state.selectedId = id;
    state.mode = "edit";
    state.draft = draftFrom(server);
    state.snapshotText = server.snapshot ? JSON.stringify(server.snapshot, null, 2) : "";
    render();
    if (history.replaceState) history.replaceState(null, "", "#" + encodeURIComponent(id));
    if (!scroll) return;
    var detail = document.getElementById("mcp-detail");
    if (detail) detail.scrollIntoView({ block: "start" });
  }

  function replaceServer(server, keepDraft) {
    var found = false;
    state.servers = state.servers.map(function (item) {
      if (item.id !== server.id) return item;
      found = true;
      return server;
    });
    if (!found) state.servers.unshift(server);
    state.selectedId = server.id;
    state.mode = "edit";
    if (!keepDraft) state.draft = draftFrom(server);
    if (server.snapshot) state.snapshotText = JSON.stringify(server.snapshot, null, 2);
  }

  function api(method, url, body) {
    var headers = { accept: "application/json" };
    var options = { method: method, headers: headers, cache: "no-store" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return fetch(url, options).then(function (response) {
      return response.json().catch(function () {
        return {};
      }).then(function (data) {
        return { status: response.status, data: data || {} };
      });
    });
  }

  function authRedirect(status) {
    if (status !== 401) return false;
    location.assign("/login.html?next=" + encodeURIComponent(location.pathname + location.search + location.hash));
    return true;
  }

  function showResult(result, okText, keepDraft) {
    if (authRedirect(result.status)) return false;
    if (result.data && result.data.server) replaceServer(result.data.server, keepDraft);
    if (result.data && result.data.probe_error) {
      state.notice = okText + "。" + result.data.probe_error;
      state.noticeKind = "warn";
    } else if (result.data && result.data.ok === true) {
      state.notice = okText;
      state.noticeKind = "ok";
    } else {
      state.notice = (result.data && result.data.error) || "没有保存成功，请重试";
      state.noticeKind = "danger";
    }
    return !!(result.data && result.data.ok === true);
  }

  function payload() {
    var draft = state.draft;
    return {
      name: draft.name.trim(),
      title: draft.title.trim(),
      description: draft.description.trim(),
      endpoint_url: draft.endpoint_url.trim(),
      transport: draft.transport,
      launch_config_json: draft.launch_config_json,
      auth_type: draft.auth_type,
      config_json: draft.config_json,
      tags: draft.tags,
      category: draft.category.trim(),
      group_id: draft.group_id || null,
      summary: draft.summary.trim(),
      status: draft.status,
      ttl_seconds: draft.ttl_seconds.trim(),
    };
  }

  // Failures stay inside the dialog (state.notice is borrowed as the
  // message, then cleared so the page does not repeat it); success closes
  // the dialog and lets the page show the notice as before.
  function dialogFailure(ctrl) {
    ctrl.setBusy(false);
    ctrl.setError(state.notice || "没有保存成功，请重试");
    state.notice = "";
  }

  function saveServer(ctrl) {
    if (state.busy) return;
    state.busy = true;
    ctrl.setBusy(true);
    var creating = state.mode !== "edit" || !state.selectedId;
    var url = creating ? "/api/mcp-servers" : "/api/mcp-servers/" + encodeURIComponent(state.selectedId);
    var body = payload();
    // 登记弹窗不再问标题，后端又要求标题非空，用名称兜底。
    if (creating && !body.title) body.title = body.name;
    api(creating ? "POST" : "PUT", url, body)
      .then(function (result) {
        state.busy = false;
        var ok = showResult(result, creating ? "已登记" : "已保存");
        if (!ok) {
          dialogFailure(ctrl);
          return;
        }
        ctrl.close();
        render();
        if (state.selectedId && history.replaceState) history.replaceState(null, "", "#" + encodeURIComponent(state.selectedId));
      })
      .catch(function () {
        state.busy = false;
        ctrl.setBusy(false);
        ctrl.setError("网络异常，请重试");
      });
  }

  function saveSnapshot(ctrl) {
    var server = selected();
    if (!server || state.busy) return;
    state.busy = true;
    ctrl.setBusy(true);
    api("PUT", "/api/mcp-servers/" + encodeURIComponent(server.id), { snapshot_json: state.snapshotText })
      .then(function (result) {
        state.busy = false;
        var ok = showResult(result, "已保存手填快照");
        if (!ok) {
          dialogFailure(ctrl);
          return;
        }
        ctrl.close();
        render();
      })
      .catch(function () {
        state.busy = false;
        ctrl.setBusy(false);
        ctrl.setError("网络异常，请重试");
      });
  }

  function refresh(id) {
    if (state.busy) return;
    state.busy = true;
    api("POST", "/api/mcp-servers/" + encodeURIComponent(id) + "/refresh-snapshot")
      .then(function (result) {
        state.busy = false;
        showResult(result, "已刷新工具快照", true);
        render();
      })
      .catch(function () {
        state.busy = false;
        state.notice = "网络异常，请重试";
        state.noticeKind = "danger";
        render();
      });
  }

  function removeServer(id, srcEl) {
    var server = state.servers.find(function (item) {
      return item.id === id;
    });
    if (!server || state.busy) return;
    var dlg = srcEl && srcEl.closest ? srcEl.closest("[data-manage-dialog]") : null;
    
      state.busy = true;
      api("DELETE", "/api/mcp-servers/" + encodeURIComponent(id))
        .then(function (result) {
          state.busy = false;
          if (authRedirect(result.status)) return;
          if (!result.data || result.data.ok !== true) {
            state.notice = (result.data && result.data.error) || "没有删除，请重试";
            state.noticeKind = "danger";
            render();
            return;
          }
          state.servers = state.servers.filter(function (item) {
            return item.id !== id;
          });
          state.notice = "已删除";
          state.noticeKind = "ok";
          C.closeCurrentOverlay();
          if (state.selectedId === id) {
            state.selectedId = "";
            state.mode = "create";
            state.draft = emptyDraft();
            state.snapshotText = "";
          }
          render();
        })
        .catch(function () {
          state.busy = false;
          state.notice = "网络异常，请重试";
          state.noticeKind = "danger";
          render();
        });
    
  }

  // ---- MCP 分组（走后端 /api/groups?scope=mcp） ----

  function findGroup(id) {
    return state.groups.find(function (group) {
      return group.id === id;
    });
  }

  function refreshGroups() {
    return api("GET", "/api/groups?scope=mcp")
      .then(function (result) {
        if (result.data && result.data.ok === true) state.groups = result.data.groups || [];
      })
      .catch(function () {});
  }

  function groupNameField(value) {
    return (
      "<label>分组名" +
      '<input data-field="groupName" name="groupName" maxlength="64" autocomplete="off" value="' +
      C.escapeHtml(value || "") +
      '" /></label>'
    );
  }

  function readGroupName(ctrl) {
    var input = ctrl.form.querySelector('[data-field="groupName"]');
    return input ? input.value.trim() : "";
  }

  function openGroupDialog() {
    if (state.busy) return;
    C.openFormDialog({
      title: "添加分组",
      bodyHtml: groupNameField(""),
      submitLabel: "添加分组",
      onSubmit: function (ctrl) {
        var name = readGroupName(ctrl);
        if (!name) {
          ctrl.setError("请填写分组名");
          return;
        }
        state.busy = true;
        ctrl.setBusy(true);
        api("POST", "/api/groups", { scope: "mcp", name: name })
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
            refreshGroups().then(render);
          })
          .catch(function () {
            state.busy = false;
            ctrl.setBusy(false);
            ctrl.setError("网络异常，请重试");
          });
      },
    });
  }

  function openRenameGroupDialog(group) {
    if (state.busy) return;
    C.openFormDialog({
      title: "分组改名",
      bodyHtml: groupNameField(group.name),
      submitLabel: "保存",
      onSubmit: function (ctrl) {
        var name = readGroupName(ctrl);
        if (!name) {
          ctrl.setError("请填写分组名");
          return;
        }
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
            refreshGroups().then(render);
          })
          .catch(function () {
            state.busy = false;
            ctrl.setBusy(false);
            ctrl.setError("网络异常，请重试");
          });
      },
    });
  }

  function deleteGroupFlow(group) {
    var slotScope = activeTab === "skills" || activeTab === "api" ? activeTab : "mcp";
    
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
          state.groups = state.groups.filter(function (item) {
            return item.id !== group.id;
          });
          state.servers = state.servers.map(function (server) {
            if (server.group_id !== group.id) return server;
            var copy = Object.assign({}, server);
            copy.group_id = null;
            return copy;
          });
          ["skills", "api"].forEach(function (scope) {
            var store = state.local[scope];
            if (!store) return;
            store.items = store.items.map(function (entry) {
              if (entry.group_id !== group.id) return entry;
              var copy = Object.assign({}, entry);
              copy.group_id = null;
              return copy;
            });
          });
          if (state.draft && state.draft.group_id === group.id) state.draft.group_id = "";
          state.notice = "已删除分组";
          state.noticeKind = "ok";
          render();
        })
        .catch(function () {
          state.busy = false;
          state.notice = "网络异常，请重试";
          state.noticeKind = "danger";
          render();
        });
    
  }

  // ---- MCP 卡片动作（展开区按钮直达，逻辑与原菜单一致） ----

  // ---- Skills / API 页签（条目走 /api/extras/*，分组共用后端池） ----

  function localStore(scope) {
    return state.local[scope] || null;
  }

  function findLocalItem(scope, id) {
    var store = localStore(scope);
    if (!store) return null;
    return store.items.find(function (item) {
      return item.id === id;
    });
  }

  function findLocalGroup(scope, id) {
    var store = localStore(scope);
    if (!store) return null;
    return store.groups.find(function (group) {
      return group.id === id;
    });
  }

  function authOptions(current) {
    return ["无", "Bearer 令牌", "Bearer API Key", "API Key", "Admin Token", "OAuth"]
      .map(function (option) {
        return (
          '<option value="' +
          C.escapeHtml(option) +
          '"' +
          (option === current ? " selected" : "") +
          ">" +
          C.escapeHtml(option) +
          "</option>"
        );
      })
      .join("");
  }

  function mapSkillRow(row) {
    return {
      id: row.id,
      name: row.name,
      version: row.version || "",
      source: row.source || "",
      used: row.used_by || "",
      status: row.status || "enabled",
      group_id: row.group_id || null,
      description: row.description || "",
      content: row.content || "",
    };
  }

  function mapApiRow(row) {
    return {
      id: row.id,
      name: row.name,
      base: row.base_url || "",
      auth: row.auth_note || "",
      note: row.note || "",
      status: row.status || "active",
      group_id: row.group_id || null,
    };
  }

  function openLocalDialog(scope, item) {
    var store = localStore(scope);
    if (!store) return;
    var editing = !!item;
    var bodyHtml;
    if (scope === "skills") {
      bodyHtml =
        field("名称", input("name", editing ? item.name : "", 'maxlength="64" autocomplete="off"')) +
        field("版本", input("version", editing ? item.version : "", 'maxlength="32" placeholder="1.0.0"')) +
        field("来源", input("source", editing ? item.source : "", 'maxlength="64" placeholder="官方注册表"')) +
        field("说明", area("description", editing ? item.description || "" : "", 2)) +
        field("正文", area("content", editing ? item.content || "" : "", 6), "技能正文，Agent 用 skills_get 取到的就是这一份") +
        field("分组", C.groupSelect("group_id", state.groups, editing ? item.group_id || "" : ""));
    } else {
      bodyHtml =
        field("名称", input("name", editing ? item.name : "", 'maxlength="64" autocomplete="off"')) +
        field("端点", input("base", editing ? item.base : "", 'spellcheck="false" autocomplete="off" placeholder="https://"')) +
        field("鉴权方式", '<select data-field="auth" name="auth">' + authOptions(editing ? item.auth : "Bearer <redacted> Key") + "</select>") +
        field("说明", area("note", editing ? item.note || "" : "", 2)) +
        field("分组", C.groupSelect("group_id", state.groups, editing ? item.group_id || "" : ""));
    }
    C.openFormDialog({
      title: (editing ? "编辑" : "添加") + (scope === "skills" ? "技能" : " API"),
      bodyHtml: bodyHtml,
      submitLabel: editing ? "保存" : scope === "skills" ? "添加技能" : "添加 API",
      size: scope === "skills" ? "md" : "sm",
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
        var groupId = read("group_id") || null;
        var payload;
        if (scope === "skills") {
          payload = {
            name: name,
            version: read("version") || (editing ? item.version : "0.1.0"),
            source: read("source") || (editing ? item.source : "工作区"),
            description: read("description"),
            content: read("content"),
            group_id: groupId,
          };
        } else {
          var base = read("base");
          if (!base) {
            ctrl.setError("请填写端点");
            return;
          }
          payload = { name: name, base_url: base, auth_note: read("auth"), note: read("note"), group_id: groupId };
        }
        var collection = scope === "skills" ? "/api/extras/skills" : "/api/extras/apis";
        ctrl.setBusy(true);
        api(editing ? "PATCH" : "POST", editing ? collection + "/" + encodeURIComponent(item.id) : collection, payload)
          .then(function (result) {
            if (authRedirect(result.status)) return;
            var saved = result.data && (scope === "skills" ? result.data.skill : result.data.api);
            if (!result.data || result.data.ok !== true || !saved) {
              ctrl.setBusy(false);
              ctrl.setError((result.data && result.data.error) || "没有保存成功，请重试");
              return;
            }
            var mapped = scope === "skills" ? mapSkillRow(saved) : mapApiRow(saved);
            if (editing) {
              store.items = store.items.map(function (entry) {
                return entry.id === mapped.id ? mapped : entry;
              });
            } else {
              store.items.unshift(mapped);
            }
            state.notice = editing ? "已保存" : "已添加";
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

  function openLocalGroupDialog(scope, group) {
    var store = localStore(scope);
    if (!store) return;
    var editing = !!group;
    C.openFormDialog({
      title: editing ? "分组改名" : "添加分组",
      bodyHtml: groupNameField(editing ? group.name : ""),
      submitLabel: editing ? "保存" : "添加分组",
      onSubmit: function (ctrl) {
        var name = readGroupName(ctrl);
        if (!name) {
          ctrl.setError("请填写分组名");
          return;
        }
        var dup = store.groups.some(function (item) {
          return item.name === name && (!editing || item.id !== group.id);
        });
        if (dup) {
          ctrl.setError("这个分组名已存在");
          return;
        }
        if (editing) group.name = name;
        else store.groups.push({ id: "grp_local_" + ++state.local.seq, name: name });
        state.notice = editing ? "已改名" : "已添加分组";
        state.noticeKind = "ok";
        ctrl.close();
        render();
      },
    });
  }

  function deleteLocalGroup(scope, group) {
    
      var store = localStore(scope);
      if (!store) return;
      store.groups = store.groups.filter(function (item) {
        return item.id !== group.id;
      });
      store.items.forEach(function (item) {
        if (item.group_id === group.id) item.group_id = null;
      });
      state.notice = "已删除分组";
      state.noticeKind = "ok";
      render();
    
  }

  function deleteLocalItem(scope, item) {
    
      var store = localStore(scope);
      if (!store) return;
      var collection = scope === "skills" ? "/api/extras/skills" : "/api/extras/apis";
      api("DELETE", collection + "/" + encodeURIComponent(item.id))
        .then(function (result) {
          if (authRedirect(result.status)) return;
          if (!result.data || result.data.ok !== true) {
            state.notice = (result.data && result.data.error) || "没有删除，请重试";
            state.noticeKind = "danger";
            render();
            return;
          }
          store.items = store.items.filter(function (entry) {
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
    
  }

  function load() {
    Promise.all([
      api("GET", "/api/mcp-servers"),
      api("GET", "/api/mcp-audit"),
      api("GET", "/api/groups?scope=mcp"),
      api("GET", "/api/extras/skills"),
      api("GET", "/api/extras/apis"),
    ])
      .then(function (results) {
        if (authRedirect(results[0].status) || authRedirect(results[1].status)) return;
        state.loading = false;
        if (!results[0].data || results[0].data.ok !== true) {
          state.loadError = (results[0].data && results[0].data.error) || "没有读到条目，请重试";
          render();
          return;
        }
        state.servers = results[0].data.servers || [];
        state.audit = results[1].data && results[1].data.ok === true ? results[1].data.audit || [] : [];
        state.groups = results[2].data && results[2].data.ok === true ? results[2].data.groups || [] : [];
        if (results[3].data && results[3].data.ok === true) {
          state.local.skills.items = (results[3].data.skills || []).map(mapSkillRow);
        }
        if (results[4].data && results[4].data.ok === true) {
          state.local.api.items = (results[4].data.apis || []).map(mapApiRow);
        }
        var hash = "";
        try {
          hash = decodeURIComponent(location.hash.slice(1));
        } catch (error) {
          hash = "";
        }
        render();
        if (hash) openServer(hash, false);
      })
      .catch(function () {
        state.loading = false;
        state.loadError = "网络异常，请重试";
        render();
      });
  }

  render();
  load();
})();
