/* MCP 与 Skills 合并板块。MCP 注册表走 /api/mcp-servers；Skills 为 mock 占位（接入后 GET /api/skills） */
(function () {
  var C = window.HiveCommon;
  var state = {
    loading: true,
    loadError: "",
    servers: [],
    audit: [],
    selectedId: "",
    mode: "create",
    draft: emptyDraft(),
    snapshotText: "",
    notice: "",
    noticeKind: "danger",
    busy: false,
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
    if (!state.notice) return "";
    var kind = state.noticeKind === "ok" ? "ok" : state.noticeKind === "warn" ? "warn" : "danger";
    return '<p class="callout ' + kind + '" role="status">' + C.escapeHtml(state.notice) + "</p>";
  }

  function card(server) {
    var meta = snapshotMeta(server);
    var time = C.formatMinute(server.snapshot_at);
    var selectedClass = server.id === state.selectedId ? " is-selected" : "";
    return (
      '<article class="record' +
      selectedClass +
      '" id="' +
      C.escapeHtml(server.id) +
      '"><div class="record-main"><div class="record-title-row"><h3>' +
      C.escapeHtml(server.title) +
      "</h3>" +
      pill(server.status === "active" ? "ok" : "idle", server.status === "active" ? "已启用" : "已停用") +
      '</div><p class="mono">' +
      C.escapeHtml(server.name) +
      "</p>" +
      tagsHtml(server.tags) +
      '<div class="row-actions"><button type="button" class="secondary" data-action="open" data-id="' +
      C.escapeHtml(server.id) +
      '">查看</button></div></div><dl class="kv">' +
      kv("分类", C.escapeHtml(server.category || "未分类")) +
      kv("快照", pill(meta[0], meta[1]) + (time ? ' <span class="subtle">' + C.escapeHtml(time) + "</span>" : "")) +
      kv("版本", '<span class="mono">v' + C.escapeHtml(String(server.version)) + "</span>") +
      "</dl></article>"
    );
  }

  function detailHtml(server) {
    if (!server) {
      return C.section("详情", "", C.emptyState("还没有选中条目", "点列表里的查看，展开端点、配置和工具快照"));
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
      : C.emptyState("还没有工具快照", "http 与 sse 可以刷新探活，stdio 请在下方手填");
    var audits = state.audit.filter(function (item) {
      return item.server_id === server.id;
    });
    var auditHtml = audits.length
      ? '<ul class="feed">' +
        audits
          .map(function (item) {
            var when = C.formatMinute(item.created_at) || "未知时间";
            var who = item.agent_name || "未知 Agent";
            return "<li><time>" + C.escapeHtml(when) + "</time><span>" + C.escapeHtml(who) + " 取过配置</span></li>";
          })
          .join("") +
        "</ul>"
      : C.emptyState("还没有获取记录", "Agent 调用 mcp_get 之后会出现在这里");
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
      '">刷新快照</button><button type="button" class="danger" data-action="delete" data-id="' +
      C.escapeHtml(server.id) +
      '">删除</button></div><div id="mcp-confirm"></div>' +
      '<form id="snapshot-form" class="form-grid stack-form" novalidate><h3>手填快照</h3><p class="subtle field-hint">把 tools/list 的 JSON 贴在这里。stdio 不能自动探活</p>' +
      '<textarea data-field="snapshotText" rows="8">' +
      C.escapeHtml(state.snapshotText) +
      '</textarea><button type="submit" class="secondary">保存手填快照</button></form></section>'
    );
  }

  function formHtml() {
    var draft = state.draft;
    var current = state.mode === "edit" ? selected() : null;
    var aiHint = current && current.summary_source === "ai" && current.summary ? "当前 AI 简介：" + current.summary : "留空时由 AI 补一句，已有人工简介不会被覆盖";
    return (
      '<section class="panel" id="mcp-form-panel"><div class="section-head"><h2>' +
      (state.mode === "edit" ? "编辑条目" : "登记条目") +
      "</h2></div><form id=\"mcp-form\" class=\"form-grid\" novalidate>" +
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
      field("简介", input("summary", draft.summary, 'maxlength="200"'), aiHint) +
      field("状态", choices("status", draft.status, [["active", "已启用"], ["disabled", "已停用"]])) +
      field("存活秒数", input("ttl_seconds", draft.ttl_seconds, 'inputmode="numeric"'), "Agent 在这段时间内复用配置，过期后重新 mcp_get") +
      '<div class="row-actions"><button type="submit">' +
      (state.mode === "edit" ? "保存修改" : "登记条目") +
      '</button><button type="button" class="secondary" data-action="create-new">改为新增</button></div></form></section>'
    );
  }

  var activeTab = location.hash === "#skills" ? "skills" : "mcp";

  function skillsHtml() {
    var SKILLS = [
      { id: "skill_search", name: "web-search", version: "1.4.0", source: "官方注册表", used: "研究、编排", status: "enabled" },
      { id: "skill_deploy", name: "wrangler-deploy", version: "0.9.2", source: "工作区", used: "编排", status: "enabled" },
      { id: "skill_vault", name: "vault-read", version: "1.0.1", source: "官方注册表", used: "值守", status: "disabled" },
    ];
    var cards = SKILLS.map(function (item) {
      return C.record({
        id: item.id,
        title: item.name,
        status: item.status,
        lede: item.source,
        facts: [
          ["版本", C.escapeHtml(item.version)],
          ["引用", C.escapeHtml(item.used)],
        ],
      });
    }).join("");
    return (
      "<div class=\"stack\">" +
      C.section("已登记", String(SKILLS.length) + " 个", C.list(cards)) +
      C.section("待审核", "", C.emptyState("没有待审核的技能", "新提交的技能会先出现在这里")) +
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
    history.replaceState(null, "", name === "skills" ? "#skills" : "#mcp");
  }

  function render() {
    var body = noticeHtml();
    if (state.loading) body += C.section("服务", "", C.emptyState("正在读取", "稍等片刻"));
    else if (state.loadError) body += C.section("服务", "", '<p class="callout danger" role="alert">' + C.escapeHtml(state.loadError) + "</p>");
    else {
      body += C.section(
        "服务",
        state.servers.length ? state.servers.length + " 个" : "",
        state.servers.length ? C.list(state.servers.map(card).join("")) : C.emptyState("还没有 MCP 条目", "用下方表单登记第一条"),
      );
      body += detailHtml(selected());
    }
    body += formHtml();
    C.mount(
      C.layout(
        "",
        "<div class=\"page-tabs\" role=\"tablist\">" +
          "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"mcp\" aria-selected=\"" +
          (activeTab === "mcp" ? "true" : "false") +
          "\">MCP</button>" +
          "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"skills\" aria-selected=\"" +
          (activeTab === "skills" ? "true" : "false") +
          "\">Skills</button>" +
          "</div>" +
          "<div data-panel=\"mcp\"" +
          (activeTab === "mcp" ? "" : " hidden") +
          "><div class=\"stack\">" +
          body +
          "</div></div>" +
          "<div data-panel=\"skills\"" +
          (activeTab === "skills" ? "" : " hidden") +
          ">" +
          skillsHtml() +
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
    page.addEventListener("submit", onSubmit);
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
    var button = target.closest("[data-action]");
    if (!button || state.busy) return;
    var action = button.getAttribute("data-action");
    var id = button.getAttribute("data-id") || state.selectedId;
    if (action === "open") openServer(id, true);
    else if (action === "create-new") startCreate();
    else if (action === "refresh") refresh(id);
    else if (action === "delete") removeServer(id);
  }

  function onSubmit(event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.id === "mcp-form") {
      event.preventDefault();
      saveServer();
    } else if (form.id === "snapshot-form") {
      event.preventDefault();
      saveSnapshot();
    }
  }

  function startCreate() {
    state.mode = "create";
    state.selectedId = "";
    state.draft = emptyDraft();
    state.snapshotText = "";
    state.notice = "";
    render();
    if (history.replaceState) history.replaceState(null, "", location.pathname);
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
      summary: draft.summary.trim(),
      status: draft.status,
      ttl_seconds: draft.ttl_seconds.trim(),
    };
  }

  function saveServer() {
    if (state.busy) return;
    state.busy = true;
    var creating = state.mode !== "edit" || !state.selectedId;
    var url = creating ? "/api/mcp-servers" : "/api/mcp-servers/" + encodeURIComponent(state.selectedId);
    api(creating ? "POST" : "PUT", url, payload())
      .then(function (result) {
        state.busy = false;
        var ok = showResult(result, creating ? "已登记" : "已保存");
        render();
        if (ok && state.selectedId && history.replaceState) history.replaceState(null, "", "#" + encodeURIComponent(state.selectedId));
      })
      .catch(function () {
        state.busy = false;
        state.notice = "网络异常，请重试";
        state.noticeKind = "danger";
        render();
      });
  }

  function saveSnapshot() {
    var server = selected();
    if (!server || state.busy) return;
    state.busy = true;
    api("PUT", "/api/mcp-servers/" + encodeURIComponent(server.id), { snapshot_json: state.snapshotText })
      .then(function (result) {
        state.busy = false;
        showResult(result, "已保存手填快照");
        render();
      })
      .catch(function () {
        state.busy = false;
        state.notice = "网络异常，请重试";
        state.noticeKind = "danger";
        render();
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

  function removeServer(id) {
    var server = state.servers.find(function (item) {
      return item.id === id;
    });
    if (!server || state.busy) return;
    var anchor = document.getElementById("mcp-confirm");
    C.askConfirm({
      anchor: anchor,
      title: "删除条目",
      text: "确认删除「" + server.name + "」吗？删除后不可恢复",
      confirmLabel: "删除",
      danger: true,
    }).then(function (yes) {
      if (!yes) return;
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
    });
  }

  function load() {
    Promise.all([api("GET", "/api/mcp-servers"), api("GET", "/api/mcp-audit")])
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
