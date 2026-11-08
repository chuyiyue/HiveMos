/* mock: 记忆与 Soul 合并板块。记忆为占位摘要（接入后 GET /api/memories），Soul 为版本占位（接入后 GET /api/souls）。添加先在页内生效 */
(function () {
  var C = window.HiveCommon;
  var activeTab = location.hash === "#soul" ? "soul" : "memory";
  function now() {
    var d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function val(ctrl, name) {
    var el = ctrl.form.querySelector("[name=\"" + name + "\"]");
    return el ? el.value.trim() : "";
  }
  // 与其它板块同一套卡片菜单入口：record 的 extra 里放「高级」按钮
  function manageBtn(kind, id) {
    return '<div class="row-actions"><button type="button" class="secondary" data-manage="' + kind + '" data-id="' + C.escapeHtml(id) + '">高级</button></div>';
  }

  // 记忆走真后端 /api/memory；加改删后一律以服务端返回为准重新拉取
  var MEMORIES = [];
  var memoryLoaded = false;
  var memoryError = "";

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

  function fmtTime(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function excerptOf(content) {
    var text = String(content || "");
    return text.length > 140 ? text.slice(0, 140) + "…" : text;
  }

  function loadMemories() {
    api("GET", "/api/memory")
      .then(function (result) {
        memoryLoaded = true;
        if (result.data && result.data.ok && Array.isArray(result.data.memories)) {
          MEMORIES = result.data.memories;
          memoryError = "";
        } else {
          memoryError = (result.data && result.data.error) || "记忆加载失败";
        }
        render();
      })
      .catch(function () {
        memoryLoaded = true;
        memoryError = "记忆加载失败";
        render();
      });
  }
  var SOULS = [
    { id: "soul_orch", agent: "编排", version: "v12", status: "synced", updated: "2026-11-07 08:55" },
    { id: "soul_research", agent: "研究", version: "v7", status: "syncing", updated: "2026-11-07 09:16" },
    { id: "soul_ops", agent: "值守", version: "v3", status: "paused", updated: "2026-11-06 19:04" },
  ];

  function render() {
    var memCards = MEMORIES.map(function (item) {
      return C.record({ id: item.id, title: item.title, lede: excerptOf(item.content), facts: [["作用域", C.escapeHtml(item.scope)], ["来源", C.escapeHtml(item.source)], ["更新时间", C.escapeHtml(fmtTime(item.updated_at))]], extra: manageBtn("memory", item.id) });
    }).join("");
    var memoryBody;
    if (memoryError) memoryBody = C.emptyState("记忆加载失败", memoryError);
    else if (!memoryLoaded) memoryBody = C.emptyState("正在加载记忆", "");
    else if (!MEMORIES.length) memoryBody = C.emptyState("还没有记忆", "点上方按钮添加第一条");
    else memoryBody = C.list(memCards);
    var memoryHtml =
      "<div class=\"stack\">" +
      "<button type=\"button\" class=\"add-button\" data-add=\"memory\">添加记忆</button>" +
      C.section("记忆", String(MEMORIES.length) + " 条", memoryBody) +
      C.section("冲突", "", C.emptyState("没有待合并的记忆", "同一作用域发生冲突时会列在这里")) +
      "<div id=\"memory-confirm\"></div>" +
      "</div>";
    var soulCards = SOULS.map(function (item) {
      return C.record({ id: item.id, title: item.agent, status: item.status, lede: "当前版本 " + item.version, facts: [["版本", C.escapeHtml(item.version)], ["同步时间", C.escapeHtml(item.updated)]], extra: manageBtn("soul", item.id) });
    }).join("");
    var soulHtml =
      "<div class=\"stack\">" +
      "<button type=\"button\" class=\"add-button\" data-add=\"soul\">添加 Soul</button>" +
      C.section("Soul", String(SOULS.length) + " 份", C.list(soulCards)) +
      C.section("草稿", "", C.emptyState("没有未发布的草稿", "尚未同步的 Soul 草稿会留在这里")) +
      "</div>";
    C.mount(
      C.layout(
        "",
        "<div class=\"page-tabs\" role=\"tablist\">" +
          "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"memory\" aria-selected=\"" + (activeTab === "memory" ? "true" : "false") + "\">记忆</button>" +
          "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"soul\" aria-selected=\"" + (activeTab === "soul" ? "true" : "false") + "\">Soul</button>" +
          "</div>" +
          "<div data-panel=\"memory\"" + (activeTab === "memory" ? "" : " hidden") + ">" + memoryHtml + "</div>" +
          "<div data-panel=\"soul\"" + (activeTab === "soul" ? "" : " hidden") + ">" + soulHtml + "</div>"
      )
    );
  }

  // 添加与编辑共用同一套字段构建；item 为空是添加，传入条目是编辑并预填
  function memoryFields(item) {
    var v = item || { title: "", scope: "", content: "" };
    return (
      "<label>标题<input name=\"title\" maxlength=\"80\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.title) + "\" /></label>" +
      "<label>作用域<input name=\"scope\" maxlength=\"40\" autocomplete=\"off\" placeholder=\"例如 全局、工作区或某个 Agent\" value=\"" + C.escapeHtml(v.scope) + "\" /></label>" +
      "<label>内容<textarea name=\"content\" rows=\"4\" maxlength=\"2000\">" + C.escapeHtml(v.content) + "</textarea></label>"
    );
  }
  function openMemoryDialog(item) {
    var editing = !!item;
    C.openFormDialog({
      title: editing ? "编辑记忆" : "添加记忆",
      bodyHtml: memoryFields(item),
      submitLabel: editing ? "保存" : "添加",
      onSubmit: function (ctrl) {
        var title = val(ctrl, "title");
        if (!title) { ctrl.setError("请填写标题"); return; }
        var payload = { title: title, scope: val(ctrl, "scope") || "全局", content: val(ctrl, "content") };
        if (ctrl.setBusy) ctrl.setBusy(true);
        var request = editing
          ? api("PATCH", "/api/memory/" + encodeURIComponent(item.id), payload)
          : api("POST", "/api/memory", payload);
        request
          .then(function (result) {
            if (result.data && result.data.ok) {
              ctrl.close();
              loadMemories();
            } else {
              if (ctrl.setBusy) ctrl.setBusy(false);
              ctrl.setError((result.data && result.data.error) || "保存失败，请重试");
            }
          })
          .catch(function () {
            if (ctrl.setBusy) ctrl.setBusy(false);
            ctrl.setError("保存失败，请重试");
          });
      },
    });
  }

  function soulFields(item) {
    var v = item || { agent: "", version: "" };
    return (
      "<label>Agent<input name=\"agent\" maxlength=\"40\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.agent) + "\" /></label>" +
      "<label>版本<input name=\"version\" maxlength=\"20\" autocomplete=\"off\" placeholder=\"v1\" value=\"" + C.escapeHtml(v.version) + "\" /></label>"
    );
  }
  function openSoulDialog(item) {
    var editing = !!item;
    C.openFormDialog({
      title: editing ? "编辑 Soul" : "添加 Soul",
      bodyHtml: soulFields(item),
      submitLabel: editing ? "保存" : "添加",
      onSubmit: function (ctrl) {
        var agent = val(ctrl, "agent");
        if (!agent) { ctrl.setError("请填写 Agent"); return; }
        if (editing) {
          item.agent = agent;
          item.version = val(ctrl, "version") || "v1";
          item.updated = now();
        } else {
          SOULS.push({ id: "soul_" + Date.now(), agent: agent, version: val(ctrl, "version") || "v1", status: "paused", updated: now() });
        }
        ctrl.close();
        render();
      },
    });
  }

  function removeMemory(item) {
    var anchor = document.getElementById("memory-confirm");
    C.askConfirm({
      anchor: anchor,
      title: "删除记忆",
      text: "确认删除「" + item.title + "」吗？删除后从列表移除",
      confirmLabel: "删除",
      danger: true,
    }).then(function (yes) {
      if (!yes) return;
      api("DELETE", "/api/memory/" + encodeURIComponent(item.id)).then(function (result) {
        if (result.data && result.data.ok) loadMemories();
      });
    });
  }

  function openManageMenu(kind, item) {
    var items = [
      {
        label: "编辑",
        onSelect: function () {
          if (kind === "memory") openMemoryDialog(item);
          else openSoulDialog(item);
        },
      },
    ];
    if (kind === "memory") {
      items.push({
        label: "删除",
        danger: true,
        onSelect: function () {
          removeMemory(item);
        },
      });
    }
    C.openActionMenu({
      title: kind === "memory" ? item.title : item.agent,
      items: items,
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
      if (add.getAttribute("data-add") === "memory") openMemoryDialog(null);
      else openSoulDialog(null);
      return;
    }
    var manage = target.closest("[data-manage]");
    if (manage) {
      var mkind = manage.getAttribute("data-manage");
      var mid = manage.getAttribute("data-id");
      var pool = mkind === "memory" ? MEMORIES : SOULS;
      var found = null;
      pool.forEach(function (entry) { if (entry.id === mid) found = entry; });
      if (found) openManageMenu(mkind, found);
    }
  });
  render();
  loadMemories();
})();
