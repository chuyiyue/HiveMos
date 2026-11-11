/* 保险库「外部指引」子层：外部保险库的连接目录与指引（纯指引版）。
   只展示服务商连接说明、条目引用、注入方式与允许主机等指引元数据，
   全程没有令牌/密码/值输入框，也不向服务商发任何请求。
   数据走 /api/vault-broker/ 契约（providers / entries / grants / audit），
   fetch 封装集中在 brokerApi 一处；USE_MOCK 开关保留供本地自测，
   线上为 false 走真实接口。Agent 名单从 /api/agents 拉取，不写死。
   vault.js 负责顶层页签与容器，本模块通过 window.HiveVaultGuide.afterRender
   被通知重绘（模式与 vault-totp.js 一致）。 */
(function () {
  var C = window.HiveCommon;
  if (!C) return;
  var esc = C.escapeHtml;

  // ===== 数据层：mock 与真实接口的唯一切换点 =====
  var USE_MOCK = false;
  var API_BASE = "/api/vault-broker";

  var DAY = 24 * 60 * 60 * 1000;
  var now = Date.now();

  var MOCK_AGENTS = [
    { id: "agt_19d2f5e889e2", name: "Muse（连接器）" },
    { id: "agt_grok00000001", name: "Grok Bot" },
    { id: "agt_hermes000001", name: "Hermes" },
  ];

  var MOCK = {
    providers: [
      {
        id: "prov_1password_main",
        name: "1Password 主库",
        type: "1password",
        connect_guide: "用 op CLI 2.x 读取，服务账号令牌由使用者在自己设备上保存，HiveMos 不经手。库名「AI 凭据」，引用形如 op://AI 凭据/<条目>/<字段>，字段名按条目页签里的实际名称填写",
        note: "个人账户，条目只放 AI 与开发用的凭据引用",
        enabled: true,
      },
      {
        id: "prov_bitwarden_team",
        name: "Bitwarden 团队库",
        type: "bitwarden",
        connect_guide: "Bitwarden Secrets Manager，组织「HiveMos 运维」。用 bws CLI 以机器账号登录后按机密 ID 读取，引用写成「项目名 / 机密 ID」，项目在 Secrets Manager 控制台的 Projects 页查看",
        note: "",
        enabled: true,
      },
      {
        id: "prov_other_offline",
        name: "离线备份库",
        type: "other",
        connect_guide: "离线 KeePass 备份，不走网络，需要时找管理员当面获取",
        note: "仅作灾备登记",
        enabled: false,
      },
    ],
    entries: [
      {
        id: "gent_openai",
        provider_id: "prov_1password_main",
        name: "OpenAI 接口密钥",
        ref: "op://AI 凭据/OpenAI/api key",
        purpose: "调用 OpenAI 接口",
        inject_hint: "bearer",
        allowed_hosts: ["api.openai.com"],
        tags: ["AI", "生产"],
        enabled: true,
      },
      {
        id: "gent_github",
        provider_id: "prov_1password_main",
        name: "GitHub 访问令牌",
        ref: "op://AI 凭据/GitHub/token",
        purpose: "拉取私有仓库与发布版本",
        inject_hint: "header",
        allowed_hosts: ["api.github.com", "github.com"],
        tags: ["代码"],
        enabled: true,
      },
      {
        id: "gent_cloudflare",
        provider_id: "prov_bitwarden_team",
        name: "Cloudflare 接口令牌",
        ref: "基础设施 / 9c2e5ab0-3f8a-4c1d-9e77-0123456789ab",
        purpose: "部署与管理 Worker",
        inject_hint: "bearer",
        allowed_hosts: ["api.cloudflare.com"],
        tags: ["部署", "生产"],
        enabled: true,
      },
      {
        id: "gent_legacy",
        provider_id: "prov_bitwarden_team",
        name: "旧测试库口令",
        ref: "归档 / 71bd0e55-90aa-4b21-8c3d-fedcba987654",
        purpose: "历史测试环境，已下线",
        inject_hint: "basic",
        allowed_hosts: [],
        tags: ["归档"],
        enabled: false,
      },
    ],
    grants: [
      { id: "grt_1", entry_id: "gent_openai", agent_id: "agt_19d2f5e889e2", expires_at: null, enabled: true },
      { id: "grt_2", entry_id: "gent_openai", agent_id: "agt_grok00000001", expires_at: now + 30 * DAY, enabled: true },
      { id: "grt_3", entry_id: "gent_cloudflare", agent_id: "agt_19d2f5e889e2", expires_at: now - 2 * DAY, enabled: true },
      { id: "grt_4", entry_id: "gent_github", agent_id: "agt_hermes000001", expires_at: null, enabled: false },
    ],
    audit: [
      { id: "aud_1", ts: now - 2 * 60 * 1000, agent_id: "agt_19d2f5e889e2", entry_id: "gent_openai", action: "view" },
      { id: "aud_2", ts: now - 47 * 60 * 1000, agent_id: "agt_grok00000001", entry_id: "gent_openai", action: "view" },
      { id: "aud_3", ts: now - 5 * 60 * 60 * 1000, agent_id: "agt_19d2f5e889e2", entry_id: "gent_cloudflare", action: "view" },
      { id: "aud_4", ts: now - 26 * 60 * 60 * 1000, agent_id: "agt_hermes000001", entry_id: "gent_github", action: "view" },
    ],
  };

  var COLLECTION_KEY = { providers: "providers", entries: "entries", grants: "grants", audit: "audit" };

  function mockRequest(method, parts, body) {
    var coll = parts[0];
    var id = parts[1] || "";
    var rows = MOCK[coll];
    if (!rows) return { status: 404, data: { ok: false, error: "接口不存在" } };
    if (method === "GET" && !id) {
      var out = {};
      out[COLLECTION_KEY[coll]] = rows.slice();
      out.ok = true;
      return { status: 200, data: out };
    }
    if (method === "POST" && !id) {
      var item = Object.assign({}, body || {});
      item.id = (coll === "providers" ? "prov_" : coll === "entries" ? "gent_" : "grt_") + Math.random().toString(16).slice(2, 10);
      rows.push(item);
      return { status: 201, data: { ok: true, item: item } };
    }
    var found = null;
    rows.forEach(function (row) { if (row.id === id) found = row; });
    if (!found) return { status: 404, data: { ok: false, error: "记录不存在" } };
    if (method === "PATCH") {
      Object.assign(found, body || {});
      return { status: 200, data: { ok: true, item: found } };
    }
    if (method === "DELETE") {
      MOCK[coll] = rows.filter(function (row) { return row.id !== id; });
      return { status: 200, data: { ok: true } };
    }
    return { status: 405, data: { ok: false, error: "方法不支持" } };
  }

  // 唯一的数据入口：mock 时本地异步模拟，真实时走 fetch，返回形状一致
  function brokerApi(method, path, body) {
    if (USE_MOCK) {
      return new Promise(function (resolve) {
        window.setTimeout(function () {
          var parts = path.split("/").filter(function (seg) { return !!seg; });
          resolve(mockRequest(method, parts, body));
        }, 160);
      });
    }
    var headers = { accept: "application/json" };
    var options = { method: method, headers: headers, cache: "no-store" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return fetch(API_BASE + path, options).then(function (response) {
      return response
        .json()
        .catch(function () { return {}; })
        .then(function (data) { return { status: response.status, data: data || {} }; });
    });
  }

  function pickList(result, key) {
    var data = result && result.data;
    if (!data) return null;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data[key])) return data[key];
    return null;
  }

  function resultOk(result) {
    return !!result && result.status < 300 && !(result.data && result.data.ok === false);
  }

  function resultError(result, fallback) {
    return (result && result.data && result.data.error) || fallback;
  }

  // ===== 状态 =====
  var S = {
    sub: "providers",
    loaded: false,
    loading: false,
    loadError: "",
    providers: null,
    entries: null,
    grants: null,
    audit: null,
    agents: null,
    expandedGuides: {},
    auditEntryFilter: "",
  };

  function rootEl() {
    return document.querySelector("[data-guide-root]");
  }

  function findIn(rows, id) {
    var found = null;
    (rows || []).forEach(function (row) { if (row.id === id) found = row; });
    return found;
  }
  function providerOf(entry) { return entry ? findIn(S.providers, entry.provider_id) : null; }
  function providerName(id) {
    var p = findIn(S.providers, id);
    return p ? p.name : "服务商已删除";
  }
  function agentRows() {
    if (S.agents) return S.agents;
    return USE_MOCK ? MOCK_AGENTS : [];
  }
  function agentName(id) {
    var found = findIn(agentRows(), id);
    return found ? found.name : id;
  }
  function loadAgents() {
    if (S.agents) return Promise.resolve(S.agents);
    if (USE_MOCK) { S.agents = MOCK_AGENTS; return Promise.resolve(S.agents); }
    return fetch("/api/agents", { headers: { accept: "application/json" }, cache: "no-store" })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (data) {
        var rows = (data && Array.isArray(data.agents)) ? data.agents : [];
        S.agents = rows.map(function (a) { return { id: a.id, name: a.name || a.id }; });
        return S.agents;
      })
      .catch(function () { S.agents = []; return S.agents; });
  }
  var TYPE_LABELS = { "1password": "1Password", bitwarden: "Bitwarden", other: "其他" };
  function typeLabel(type) { return TYPE_LABELS[type] || "其他"; }
  function grantExpired(grant) {
    return grant.expires_at != null && grant.expires_at !== "" && Number(grant.expires_at) < Date.now();
  }
  function fmtTime(ts) {
    if (ts == null || ts === "") return "未填写";
    return C.formatMinute(ts);
  }
  function enabledBadge(on) {
    return on ? C.badge("已启用", "accent") : C.badge("已停用");
  }

  // ===== 加载（先画壳，数据异步填入） =====
  function loadAll() {
    if (S.loading) return;
    S.loading = true;
    S.loadError = "";
    paint();
    Promise.all([
      brokerApi("GET", "/providers"),
      brokerApi("GET", "/entries"),
      brokerApi("GET", "/grants"),
      brokerApi("GET", "/audit"),
      loadAgents(),
    ]).then(function (results) {
      S.loading = false;
      var providers = pickList(results[0], "providers");
      var entries = pickList(results[1], "entries");
      var grants = pickList(results[2], "grants");
      var audit = pickList(results[3], "audit");
      if (!providers || !entries || !grants || !audit) {
        S.loadError = "指引数据加载失败";
      } else {
        S.providers = providers;
        S.entries = entries;
        S.grants = grants;
        S.audit = audit;
        S.loaded = true;
      }
      paint();
    }).catch(function () {
      S.loading = false;
      S.loadError = "指引数据加载失败";
      paint();
    });
  }

  function reload(coll) {
    return brokerApi("GET", "/" + coll).then(function (result) {
      var rows = pickList(result, COLLECTION_KEY[coll]);
      if (rows) S[coll] = rows;
      paint();
    }).catch(function () { paint(); });
  }

  // ===== 渲染 =====
  var SUBTABS = [
    ["providers", "服务商"],
    ["entries", "条目"],
    ["grants", "授权"],
    ["audit", "审计"],
  ];

  function paint() {
    var root = rootEl();
    if (!root) return;
    var tabs = SUBTABS.map(function (tab) {
      return (
        '<button type="button" class="guide-tab" role="tab" data-guide-tab="' + tab[0] + '" aria-selected="' +
        (S.sub === tab[0] ? "true" : "false") + '">' + tab[1] + "</button>"
      );
    }).join("");
    var body;
    if (S.loadError) body = C.emptyState("加载失败", S.loadError);
    else if (!S.loaded) body = C.emptyState("正在加载", "马上就好");
    else if (S.sub === "providers") body = providersHtml();
    else if (S.sub === "entries") body = entriesHtml();
    else if (S.sub === "grants") body = grantsHtml();
    else body = auditHtml();
    root.innerHTML =
      '<div class="stack"><div class="page-tabs guide-subtabs" role="tablist" aria-label="外部指引">' + tabs + "</div>" + body + "</div>";
  }

  function addButton(kind, label) {
    return '<button type="button" class="add-button" data-guide-add="' + kind + '">' + label + "</button>";
  }

  // ---- 服务商 ----
  function providersHtml() {
    var rows = S.providers || [];
    var body = !rows.length
      ? C.emptyState("还没有服务商", "点右上方「添加服务商」登记第一个外部保险库")
      : C.cardList(rows.map(providerCard).join(""));
    return C.section("服务商", rows.length ? rows.length + " 个" : "", body, addButton("provider", "添加服务商"));
  }

  function providerCard(item) {
    var expanded = !!S.expandedGuides[item.id];
    var guide = item.connect_guide || "未填写连接说明";
    var guideHtml = expanded
      ? '<p class="guide-full">' + esc(guide) + "</p>"
      : '<p class="guide-clamp">' + esc(guide) + "</p>";
    return C.record({
      id: "guide-" + item.id,
      icon: "lock",
      title: item.name,
      pill: typeLabel(item.type),
      corner: enabledBadge(item.enabled),
      extra: guideHtml,
      facts: item.note ? [["备注", esc(item.note)]] : [],
      manage: null,
      actions:
        '<button type="button" class="secondary" data-guide-expand="' + esc(item.id) + '">' + (expanded ? "收起说明" : "展开说明") + "</button>" +
        '<button type="button" class="secondary" data-guide-edit-provider="' + esc(item.id) + '">编辑</button>' +
        '<button type="button" class="secondary" data-guide-toggle-provider="' + esc(item.id) + '">' + (item.enabled ? "停用" : "启用") + "</button>" +
        '<button type="button" class="danger" data-confirm-delete data-guide-delete-provider="' + esc(item.id) + '">删除</button>',
    });
  }

  // ---- 条目 ----
  function entriesHtml() {
    var rows = S.entries || [];
    var body = !rows.length
      ? C.emptyState("还没有条目", "点右上方「添加条目」登记第一条指引")
      : C.list(rows.map(entryRow).join(""));
    return C.section("条目", rows.length ? rows.length + " 条" : "", body, addButton("entry", "添加条目"));
  }

  function entryRow(item) {
    var id = esc(item.id);
    var tags = (item.tags || []).map(function (tag) { return " " + C.badge(tag); }).join("");
    return (
      '<div class="entry-row"><article class="session-row" data-guide-entry="' + id + '" tabindex="0" role="button" aria-haspopup="dialog" aria-label="查看指引：' + esc(item.name) + '">' +
      '<div class="session-main"><div class="session-title"><h3>' + esc(item.name) + "</h3>" + tags + "</div>" +
      '<p class="subtle">' + esc(providerName(item.provider_id)) + (item.purpose ? " · " + esc(item.purpose) : "") + "</p></div>" +
      enabledBadge(item.enabled) +
      '<span class="row-chev" aria-hidden="true">›</span>' +
      "</article></div>"
    );
  }

  function entryDrawer(item) {
    var provider = providerOf(item);
    var grants = (S.grants || []).filter(function (g) { return g.entry_id === item.id; });
    var views = (S.audit || []).filter(function (a) { return a.entry_id === item.id; }).slice(0, 5);
    var hosts = (item.allowed_hosts || []).length ? item.allowed_hosts.join("、") : "未限定";
    var tags = (item.tags || []).length ? item.tags.join("、") : "无";
    var grantHtml = grants.length
      ? grants.map(function (g) {
          var state = !g.enabled ? "已停用" : grantExpired(g) ? "已过期" : "有效";
          return (
            '<div class="guide-line"><span>' + esc(agentName(g.agent_id)) + '</span><span class="subtle">' +
            (g.expires_at ? "到期 " + esc(fmtTime(g.expires_at)) : "长期有效") + " · " + state + "</span></div>"
          );
        }).join("")
      : C.emptyState("暂无授权", "在「授权」页添加后，对应 Agent 才能看到这条指引");
    var viewHtml = views.length
      ? views.map(function (a) {
          return '<div class="guide-line"><span>' + esc(agentName(a.agent_id)) + '</span><span class="subtle">' + esc(fmtTime(a.ts)) + " 查看</span></div>";
        }).join("")
      : C.emptyState("暂无查看记录", "");
    var ctrl = C.openSidePanel({
      title: item.name,
      bodyHtml:
        C.manageInfoHead({ icon: "lock", title: item.name, sub: "外部指引 · " + providerName(item.provider_id) }) +
        '<div class="manage-info-card"><dl class="kv">' +
        "<div><dt>引用</dt><dd><span class=\"copy-text mono guide-ref\" data-copy=\"" + esc(item.ref) + "\" title=\"点击复制\">" + esc(item.ref) + '</span> <button type="button" class="copy-btn" data-copy="' + esc(item.ref) + '">复制</button></dd></div>' +
        "<div><dt>用途</dt><dd>" + esc(item.purpose || "未填写") + "</dd></div>" +
        "<div><dt>状态</dt><dd>" + (item.enabled ? "已启用" : "已停用") + "</dd></div>" +
        "</dl></div>" +
        C.section("完整指引", "",
          '<dl class="kv">' +
          "<div><dt>连接说明</dt><dd><p class=\"guide-full\">" + esc(provider ? provider.connect_guide || "未填写" : "服务商已删除") + "</p></dd></div>" +
          "<div><dt>注入方式</dt><dd>" + esc(item.inject_hint || "未填写") + "</dd></div>" +
          "<div><dt>允许主机</dt><dd>" + esc(hosts) + "</dd></div>" +
          "<div><dt>标签</dt><dd>" + esc(tags) + "</dd></div>" +
          "</dl>") +
        C.section("授权列表", grants.length ? grants.length + " 条" : "", grantHtml) +
        C.section("最近查看", "", viewHtml) +
        '<div class="manage-actions">' +
        '<button type="button" class="secondary" data-guide-edit-entry="' + esc(item.id) + '">编辑</button>' +
        '<button type="button" class="secondary" data-guide-toggle-entry="' + esc(item.id) + '">' + (item.enabled ? "停用" : "启用") + "</button>" +
        '<button type="button" class="danger" data-confirm-delete data-guide-delete-entry="' + esc(item.id) + '">删除</button>' +
        "</div>",
    });
    ctrl.dialog.addEventListener("click", onGuideClick);
  }

  // ---- 授权 ----
  function grantsHtml() {
    var rows = S.grants || [];
    var body = !rows.length
      ? C.emptyState("还没有授权", "点右上方「添加授权」把条目指引开放给某个 Agent")
      : C.list(rows.map(grantRow).join(""));
    return C.section("授权", rows.length ? rows.length + " 条" : "", body, addButton("grant", "添加授权"));
  }

  function grantRow(item) {
    var entry = findIn(S.entries, item.entry_id);
    var id = esc(item.id);
    var state = !item.enabled ? C.badge("已停用") : grantExpired(item) ? C.badge("已过期", "danger") : C.badge("有效", "accent");
    return (
      '<div class="entry-row"><article class="session-row">' +
      '<div class="session-main"><div class="session-title"><h3>' + esc(entry ? entry.name : "条目已删除") + "</h3></div>" +
      '<p class="subtle">' + esc(agentName(item.agent_id)) + " · " + (item.expires_at ? "到期 " + esc(fmtTime(item.expires_at)) : "长期有效") + "</p></div>" +
      state +
      '<button type="button" class="secondary" data-guide-edit-grant="' + id + '">编辑</button>' +
      '<button type="button" class="secondary" data-guide-toggle-grant="' + id + '">' + (item.enabled ? "停用" : "启用") + "</button>" +
      '<button type="button" class="danger" data-confirm-delete data-guide-delete-grant="' + id + '">删除</button>' +
      "</article></div>"
    );
  }

  // ---- 审计 ----
  function auditHtml() {
    var rows = (S.audit || []).filter(function (a) { return !S.auditEntryFilter || a.entry_id === S.auditEntryFilter; });
    var options = '<option value="">全部条目</option>' + (S.entries || []).map(function (entry) {
      return '<option value="' + esc(entry.id) + '"' + (S.auditEntryFilter === entry.id ? " selected" : "") + ">" + esc(entry.name) + "</option>";
    }).join("");
    var filter = '<label class="guide-filter">按条目筛选<select data-guide-audit-filter>' + options + "</select></label>";
    var body = !rows.length
      ? C.emptyState("暂无查看记录", "被授权的 Agent 查看指引后会记在这里")
      : C.list(rows.map(function (a) {
          var entry = findIn(S.entries, a.entry_id);
          return (
            '<div class="entry-row"><article class="session-row">' +
            '<div class="session-main"><div class="session-title"><h3>' + esc(entry ? entry.name : "条目已删除") + "</h3></div>" +
            '<p class="subtle">' + esc(agentName(a.agent_id)) + " · " + esc(fmtTime(a.ts)) + "</p></div>" +
            C.badge("查看") +
            "</article></div>"
          );
        }).join(""));
    return C.section("审计", "查看记录", filter + body);
  }

  // ===== 表单 =====
  function segHtml(field, options, current) {
    return (
      '<div class="segmented" role="group" aria-label="' + esc(field) + '">' +
      options.map(function (option) {
        return (
          '<button type="button" class="segment" data-guide-seg="' + esc(field) + '" data-value="' + esc(option[0]) + '" aria-pressed="' +
          (String(current) === String(option[0]) ? "true" : "false") + '">' + esc(option[1]) + "</button>"
        );
      }).join("") +
      "</div>" +
      '<input type="hidden" name="' + esc(field) + '" value="' + esc(current) + '" />'
    );
  }

  function switchHtml(field, on) {
    return (
      '<span class="totp-switch-row"><span>启用</span>' +
      '<button type="button" class="switch" role="switch" aria-checked="' + (on ? "true" : "false") + '" data-guide-switch="' + esc(field) + '" aria-label="启用"><span class="switch-knob"></span></button>' +
      '<input type="hidden" name="' + esc(field) + '" value="' + (on ? "1" : "") + '" /></span>'
    );
  }

  function wireFormBits(form) {
    form.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var seg = target.closest("[data-guide-seg]");
      if (seg) {
        var field = seg.getAttribute("data-guide-seg");
        form.querySelectorAll('[data-guide-seg="' + field + '"]').forEach(function (peer) {
          peer.setAttribute("aria-pressed", peer === seg ? "true" : "false");
        });
        var hidden = form.querySelector('input[name="' + field + '"]');
        if (hidden) hidden.value = seg.getAttribute("data-value") || "";
        return;
      }
      var sw = target.closest("[data-guide-switch]");
      if (sw) {
        var on = sw.getAttribute("aria-checked") !== "true";
        sw.setAttribute("aria-checked", on ? "true" : "false");
        var input = form.querySelector('input[name="' + sw.getAttribute("data-guide-switch") + '"]');
        if (input) input.value = on ? "1" : "";
      }
    });
  }

  function formVal(ctrl, name) {
    var el = ctrl.form.querySelector('[name="' + name + '"]');
    return el ? el.value.trim() : "";
  }

  function submitGuide(ctrl, request, coll, after) {
    ctrl.setBusy(true);
    request.then(function (result) {
      ctrl.setBusy(false);
      if (resultOk(result)) {
        ctrl.close();
        if (after) after();
        if (coll) reload(coll);
      } else {
        ctrl.setError(resultError(result, "保存失败，请重试"));
      }
    }).catch(function () {
      ctrl.setBusy(false);
      ctrl.setError("网络异常，请重试");
    });
  }

  function providerFields(item) {
    var v = item || { name: "", type: "1password", connect_guide: "", note: "", enabled: true };
    return (
      '<label>名称<input name="name" maxlength="60" autocomplete="off" value="' + esc(v.name) + '" /></label>' +
      '<div class="tag-field"><span>类型</span>' + segHtml("type", [["1password", "1Password"], ["bitwarden", "Bitwarden"], ["other", "其他"]], v.type || "other") + "</div>" +
      '<label>连接说明<textarea name="connect_guide" rows="4" maxlength="2000" placeholder="写清用哪个客户端或控制台、库名与引用形状">' + esc(v.connect_guide) + "</textarea></label>" +
      '<label>备注<textarea name="note" rows="2" maxlength="300">' + esc(v.note) + "</textarea></label>" +
      switchHtml("enabled", v.enabled !== false)
    );
  }

  function openProviderDialog(item) {
    var editing = !!item;
    var ctrl = C.openFormDialog({
      title: editing ? "编辑服务商" : "添加服务商",
      bodyHtml: providerFields(item),
      submitLabel: editing ? "保存" : "添加",
      onSubmit: function (c) {
        var name = formVal(c, "name");
        if (!name) { c.setError("请填写名称"); return; }
        var payload = {
          name: name,
          type: formVal(c, "type") || "other",
          connect_guide: formVal(c, "connect_guide"),
          note: formVal(c, "note"),
          enabled: formVal(c, "enabled") === "1",
        };
        submitGuide(c,
          editing ? brokerApi("PATCH", "/providers/" + encodeURIComponent(item.id), payload) : brokerApi("POST", "/providers", payload),
          "providers");
      },
    });
    wireFormBits(ctrl.form);
  }

  function entryFields(item) {
    var v = item || { provider_id: "", name: "", ref: "", purpose: "", inject_hint: "", allowed_hosts: [], tags: [], enabled: true };
    var providerOptions = (S.providers || []).map(function (p) {
      return '<option value="' + esc(p.id) + '"' + (v.provider_id === p.id ? " selected" : "") + ">" + esc(p.name) + (p.enabled ? "" : "（已停用）") + "</option>";
    }).join("");
    return (
      '<label>名称<input name="name" maxlength="60" autocomplete="off" value="' + esc(v.name) + '" /></label>' +
      '<label>服务商<select name="provider_id">' + providerOptions + "</select></label>" +
      '<label>引用<input name="ref" maxlength="500" autocomplete="off" placeholder="如 op://库/条目/字段 或 项目名 / 机密 ID" value="' + esc(v.ref) + '" /></label>' +
      '<label>用途<input name="purpose" maxlength="120" autocomplete="off" value="' + esc(v.purpose) + '" /></label>' +
      '<label>注入方式<input name="inject_hint" maxlength="120" autocomplete="off" placeholder="如 bearer / header / basic 或自由说明" value="' + esc(v.inject_hint) + '" /></label>' +
      '<label>允许主机<input name="allowed_hosts" maxlength="500" autocomplete="off" placeholder="多个主机用逗号分隔，可留空" value="' + esc((v.allowed_hosts || []).join(", ")) + '" /></label>' +
      '<label>标签<input name="tags" maxlength="200" autocomplete="off" placeholder="多个标签用逗号分隔，可留空" value="' + esc((v.tags || []).join(", ")) + '" /></label>' +
      switchHtml("enabled", v.enabled !== false)
    );
  }

  function splitList(text) {
    return String(text || "").split(/[,，]/).map(function (part) { return part.trim(); }).filter(function (part) { return !!part; });
  }

  // 引用只做本地格式校验，不向服务商发任何请求
  function validateRef(provider, ref) {
    if (!ref) return "请填写引用";
    if (provider && provider.type === "1password" && ref.indexOf("op://") !== 0) return "1Password 的引用需以 op:// 开头";
    return "";
  }

  function openEntryDialog(item) {
    var editing = !!item;
    var ctrl = C.openFormDialog({
      title: editing ? "编辑条目" : "添加条目",
      bodyHtml: entryFields(item),
      submitLabel: editing ? "保存" : "添加",
      onSubmit: function (c) {
        var name = formVal(c, "name");
        if (!name) { c.setError("请填写名称"); return; }
        var providerId = formVal(c, "provider_id");
        if (!providerId) { c.setError("请选择服务商"); return; }
        var ref = formVal(c, "ref");
        var refError = validateRef(findIn(S.providers, providerId), ref);
        if (refError) { c.setError(refError); return; }
        var payload = {
          name: name,
          provider_id: providerId,
          ref: ref,
          purpose: formVal(c, "purpose"),
          inject_hint: formVal(c, "inject_hint"),
          allowed_hosts: splitList(formVal(c, "allowed_hosts")),
          tags: splitList(formVal(c, "tags")),
          enabled: formVal(c, "enabled") === "1",
        };
        submitGuide(c,
          editing ? brokerApi("PATCH", "/entries/" + encodeURIComponent(item.id), payload) : brokerApi("POST", "/entries", payload),
          "entries",
          function () { C.closeCurrentOverlay(); });
      },
    });
    wireFormBits(ctrl.form);
  }

  function toLocalInput(ts) {
    if (ts == null || ts === "") return "";
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return "";
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function grantFields(item) {
    var v = item || { entry_id: "", agent_id: "", expires_at: null, enabled: true };
    var entryOptions = (S.entries || []).map(function (e) {
      return '<option value="' + esc(e.id) + '"' + (v.entry_id === e.id ? " selected" : "") + ">" + esc(e.name) + "</option>";
    }).join("");
    var agentRowsNow = agentRows().slice();
    if (v.agent_id && !findIn(agentRowsNow, v.agent_id)) agentRowsNow.push({ id: v.agent_id, name: v.agent_id });
    var agentOptions = agentRowsNow.map(function (a) {
      return '<option value="' + esc(a.id) + '"' + (v.agent_id === a.id ? " selected" : "") + ">" + esc(a.name) + "</option>";
    }).join("");
    return (
      '<label>条目<select name="entry_id">' + entryOptions + "</select></label>" +
      '<label>Agent<select name="agent_id">' + agentOptions + "</select></label>" +
      '<label>到期时间<input name="expires_at" type="datetime-local" value="' + esc(toLocalInput(v.expires_at)) + '" /></label>' +
      '<p class="subtle field-hint">到期时间留空表示长期有效</p>' +
      switchHtml("enabled", v.enabled !== false)
    );
  }

  function openGrantDialog(item) {
    var editing = !!item;
    var ctrl = C.openFormDialog({
      title: editing ? "编辑授权" : "添加授权",
      bodyHtml: grantFields(item),
      submitLabel: editing ? "保存" : "添加",
      onSubmit: function (c) {
        var entryId = formVal(c, "entry_id");
        var agentId = formVal(c, "agent_id");
        if (!entryId) { c.setError("请选择条目"); return; }
        if (!agentId) { c.setError("请选择 Agent"); return; }
        var expiresText = formVal(c, "expires_at");
        var expiresAt = null;
        if (expiresText) {
          var parsed = new Date(expiresText).getTime();
          if (isNaN(parsed)) { c.setError("到期时间格式不正确"); return; }
          expiresAt = parsed;
        }
        var payload = { entry_id: entryId, agent_id: agentId, expires_at: expiresAt, enabled: formVal(c, "enabled") === "1" };
        submitGuide(c,
          editing ? brokerApi("PATCH", "/grants/" + encodeURIComponent(item.id), payload) : brokerApi("POST", "/grants", payload),
          "grants");
      },
    });
    wireFormBits(ctrl.form);
  }

  // ===== 动作 =====
  function toggleRow(coll, item) {
    brokerApi("PATCH", "/" + coll + "/" + encodeURIComponent(item.id), { enabled: !item.enabled }).then(function (result) {
      if (resultOk(result)) {
        C.closeCurrentOverlay();
        reload(coll);
      } else {
        C.toast(resultError(result, "操作失败，请重试"), "danger");
      }
    }).catch(function () { C.toast("网络异常，请重试", "danger"); });
  }

  function deleteRow(coll, item) {
    brokerApi("DELETE", "/" + coll + "/" + encodeURIComponent(item.id)).then(function (result) {
      if (resultOk(result)) {
        C.closeCurrentOverlay();
        reload(coll);
      } else {
        C.toast(resultError(result, "删除失败，请重试"), "danger");
      }
    }).catch(function () { C.toast("网络异常，请重试", "danger"); });
  }

  function onGuideClick(event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("[data-copy]")) return;
    var tab = target.closest("[data-guide-tab]");
    if (tab) { S.sub = tab.getAttribute("data-guide-tab"); paint(); return; }
    var add = target.closest("[data-guide-add]");
    if (add) {
      var kind = add.getAttribute("data-guide-add");
      if (kind === "provider") openProviderDialog(null);
      else if (kind === "entry") openEntryDialog(null);
      else if (kind === "grant") openGrantDialog(null);
      return;
    }
    var expand = target.closest("[data-guide-expand]");
    if (expand) {
      var eid = expand.getAttribute("data-guide-expand");
      S.expandedGuides[eid] = !S.expandedGuides[eid];
      paint();
      return;
    }
    var row = target.closest("[data-guide-entry]");
    if (row && !target.closest("button, a, input, select, textarea")) {
      var entry = findIn(S.entries, row.getAttribute("data-guide-entry"));
      if (entry) entryDrawer(entry);
      return;
    }
    var checks = [
      ["data-guide-edit-provider", S.providers, openProviderDialog],
      ["data-guide-edit-entry", S.entries, openEntryDialog],
      ["data-guide-edit-grant", S.grants, openGrantDialog],
    ];
    for (var i = 0; i < checks.length; i++) {
      var el = target.closest("[" + checks[i][0] + "]");
      if (el) {
        var found = findIn(checks[i][1], el.getAttribute(checks[i][0]));
        if (found) checks[i][2](found);
        return;
      }
    }
    var toggles = [
      ["data-guide-toggle-provider", "providers", S.providers],
      ["data-guide-toggle-entry", "entries", S.entries],
      ["data-guide-toggle-grant", "grants", S.grants],
    ];
    for (var j = 0; j < toggles.length; j++) {
      var tel = target.closest("[" + toggles[j][0] + "]");
      if (tel) {
        var titem = findIn(toggles[j][2], tel.getAttribute(toggles[j][0]));
        if (titem) toggleRow(toggles[j][1], titem);
        return;
      }
    }
    var deletes = [
      ["data-guide-delete-provider", "providers", S.providers],
      ["data-guide-delete-entry", "entries", S.entries],
      ["data-guide-delete-grant", "grants", S.grants],
    ];
    for (var k = 0; k < deletes.length; k++) {
      var del = target.closest("[" + deletes[k][0] + "]");
      if (del) {
        var ditem = findIn(deletes[k][2], del.getAttribute(deletes[k][0]));
        if (ditem) deleteRow(deletes[k][1], ditem);
        return;
      }
    }
  }

  function onGuideChange(event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var filter = target.closest("[data-guide-audit-filter]");
    if (filter) {
      S.auditEntryFilter = filter.value;
      paint();
    }
  }

  // ===== 接入 vault.js =====
  function afterRender(isActive) {
    if (!isActive) return;
    paint();
    if (!S.loaded && !S.loading) loadAll();
  }

  var page = document.getElementById("page");
  if (page) {
    page.addEventListener("click", onGuideClick);
    page.addEventListener("change", onGuideChange);
  }
  // 脚本在 vault.js 首轮 render 之后才加载：先把壳画进隐藏容器，
  // 直接以 #guide 打开时也能立即接管
  if (rootEl()) paint();

  window.HiveVaultGuide = { afterRender: afterRender };
})();
