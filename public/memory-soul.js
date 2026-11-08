/* mock: 记忆与 Soul 合并板块。记忆为占位摘要（接入后 GET /api/memories），Soul 走 /api/soul 真实接口，全量版本与历史都在服务端。记忆添加先在页内生效 */
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

  // Soul 页签的接口助手（记忆页签仍是页内数据，不走这里）
  function soulApi(method, url, body) {
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
  // 与其它板块同一套卡片菜单入口：record 的 extra 里放「高级」按钮
  // 记忆走真后端 /api/memory；加改删后一律以服务端返回为准重新拉取
  var MEMORIES = [];
  var memoryLoaded = false;
  var memoryError = "";
  var memTagFilter = "";
  var memNotice = "";
  var memNoticeKind = "ok";

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
  function refreshMemories() {
    loadMemories();
  }

  function setMemNotice(text, kind) {
    if (text) C.toast(text, kind === "danger" ? "danger" : "ok");
  }

  var SOULS = [];
  var soulsLoaded = false;

  // ---- 管理弹窗（点卡片信息区打开） ----

  function openManage(key) {
    if (!key) return;
    var sep = key.indexOf(":");
    var kind = key.slice(0, sep);
    var id = key.slice(sep + 1);
    var pool = kind === "memory" ? MEMORIES : SOULS;
    var found = null;
    pool.forEach(function (entry) {
      if (entry.id === id) found = entry;
    });
    if (!found) return;
    if (kind === "memory") openMemoryManage(found);
    else openSoulManage(found);
  }

  function openMemoryManage(item) {
    var id = C.escapeHtml(item.id);
    var ctrl = C.openManageDialog({
      title: item.title,
      bodyHtml:
        C.manageInfoHead({ icon: "memory", title: item.title, sub: (item.scope || "未注明作用域") + " · 记忆" }) +
        "<dl class=\"kv\">" +
        "<div><dt>作用域</dt><dd>" + C.escapeHtml(item.scope || "未注明") + "</dd></div>" +
        "<div><dt>来源</dt><dd>" + C.escapeHtml(item.source || "未注明") + "</dd></div>" +
        "<div><dt>更新时间</dt><dd>" + C.escapeHtml(C.formatMinute(item.updated_at) || "未知") + "</dd></div>" +
        "</dl>" +
        "<h3 class=\"manage-subhead\">内容</h3>" +
        "<p>" + C.escapeHtml(excerptOf(item.content)) + "</p>" +
        "<h3 class=\"manage-subhead\">分级设置</h3>" +
        "<label>权重（0–100，读取时高权重排前面）<input name=\"mem-weight\" type=\"number\" min=\"0\" max=\"100\" step=\"1\" value=\"" + (item.weight || 0) + "\" /></label>" +
        "<div class=\"manage-actions\">" +
        "<button type=\"button\" class=\"secondary\" data-card-act=\"tier\" data-kind=\"memory\" data-id=\"" + id + "\">保存分级设置</button>" +
        "<button type=\"button\" class=\"secondary\" data-card-act=\"pin\" data-kind=\"memory\" data-id=\"" + id + "\">" + (item.pinned ? "取消置顶" : "置顶") + "</button>" +
        "<button type=\"button\" class=\"secondary\" data-card-act=\"ai-tag\" data-kind=\"memory\" data-id=\"" + id + "\">AI 打标签</button>" +
        "</div>" +
        "<div class=\"manage-actions\">" +
        "<button type=\"button\" class=\"secondary\" data-card-act=\"edit\" data-kind=\"memory\" data-id=\"" + id + "\">编辑</button>" +
        "<button type=\"button\" class=\"danger\" data-confirm-delete data-card-act=\"delete\" data-kind=\"memory\" data-id=\"" + id + "\">删除</button>" +
        "</div>",
    });
    ctrl.dialog.addEventListener("click", handleClick);
  }

  function openSoulManage(item) {
    var id = C.escapeHtml(item.id);
    var ctrl = C.openManageDialog({
      title: item.agent_name,
      bodyHtml:
        C.manageInfoHead({ icon: "soul", title: item.agent_name, sub: "v" + String(item.version) + " · Soul" }) +
        "<dl class=\"kv\">" +
        "<div><dt>版本</dt><dd>v" + C.escapeHtml(String(item.version)) + "</dd></div>" +
        "<div><dt>更新时间</dt><dd>" + C.escapeHtml(C.formatMinute(item.updated_at) || "未知") + "</dd></div>" +
        "</dl>" +
        "<div class=\"manage-actions\">" +
        "<button type=\"button\" class=\"secondary\" data-card-act=\"edit\" data-kind=\"soul\" data-id=\"" + id + "\">编辑</button>" +
        "<button type=\"button\" class=\"danger\" data-confirm-delete data-card-act=\"delete\" data-kind=\"soul\" data-id=\"" + id + "\">删除</button>" +
        "</div>"
    });
    ctrl.dialog.addEventListener("click", handleClick);
  }

  function memPinCorner(item) {
    var pinned = !!item.pinned;
    return (
      "<button type=\"button\" class=\"pin-btn\" data-mem-pin=\"" +
      C.escapeHtml(item.id) +
      "\" aria-pressed=\"" +
      (pinned ? "true" : "false") +
      "\" title=\"" +
      (pinned ? "取消置顶" : "置顶") +
      "\" aria-label=\"" +
      (pinned ? "取消置顶" : "置顶") +
      "\"><svg class=\"icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><use href=\"/icons.svg#icon-pin\"/></svg></button>"
    );
  }

  function memoryFacts(item) {
    var facts = [
      ["来源", C.escapeHtml(item.source || "未注明")],
      ["更新时间", C.escapeHtml(fmtTime(item.updated_at))],
    ];
    if (item.weight) facts.push(["权重", String(item.weight)]);
    if (item.ai_state === "split") facts.push(["AI", "已拆分打标"]);
    else if (item.ai_state === "tagged") facts.push(["AI", "已打标"]);
    else if (item.ai_state === "failed") facts.push(["AI", "处理失败，已整段保存"]);
    return facts;
  }

  function sentenceOf(content) {
    var text = String(content || "").trim();
    if (!text) return "";
    var match = text.match(/^[^。！？.!?\n]+[。！？.!?]?/);
    return (match ? match[0] : text).trim();
  }

  function memoryCard(item) {
    var sentence = sentenceOf(item.content) || item.title || "";
    return (
      '<article class="record mem-card">' +
      '<div class="record-info" data-manage="memory:' +
      C.escapeHtml(item.id) +
      '" tabindex="0" role="button" aria-haspopup="dialog" aria-label="查看记忆">' +
      '<p class="lede mem-one-line">' +
      C.escapeHtml(sentence) +
      "</p>" +
      "</div>" +
      memPinCorner(item) +
      "</article>"
    );
  }

  function allMemTags() {
    var seen = {};
    var list = [];
    MEMORIES.forEach(function (m) {
      (m.tags || []).forEach(function (t) {
        if (!seen[t]) {
          seen[t] = 1;
          list.push(t);
        }
      });
    });
    return list;
  }

  function filterChip(attr, value, label, active) {
    return (
      "<button type=\"button\" class=\"tag" + (active ? " is-accent" : "") + "\" " + attr + "=\"" +
      C.escapeHtml(value) + "\">" + C.escapeHtml(label) + "</button>"
    );
  }

  function memoryToolbar() {
    var tags = allMemTags();
    if (!tags.length) return "";
    return (
      "<div class=\"tag-row\"><span class=\"subtle\">标签</span>" +
      tags
        .map(function (t) {
          return filterChip("data-mem-tag", t, t, memTagFilter === t);
        })
        .join("") +
      "</div>"
    );
  }

  // 置顶优先，其次权重降序，再按更新时间降序。与列表接口同一口径。
  function compareMemories(a, b) {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    var byWeight = (Number(b.weight) || 0) - (Number(a.weight) || 0);
    if (byWeight) return byWeight;
    return (Number(b.updated_at) || 0) - (Number(a.updated_at) || 0);
  }

  function memoryCardsHtml(rows) {
    return C.cardList(rows.map(memoryCard).join(""));
  }

  function memoryBodyHtml() {
    if (memoryError) return C.emptyState("记忆加载失败", memoryError);
    if (!memoryLoaded) return C.emptyState("正在加载记忆", "");
    if (!MEMORIES.length) return C.emptyState("还没有记忆", "点上方按钮添加第一条");
    var rows = MEMORIES.filter(function (item) {
      if (memTagFilter && (item.tags || []).indexOf(memTagFilter) === -1) return false;
      return true;
    });
    if (!rows.length) return C.emptyState("没有符合筛选的记忆", "换个标签看看");
    rows.sort(compareMemories);
    // 标签筛选不再按分组切，整表平铺成一个网格（置顶仍靠排序排在前面）。
    if (memTagFilter) return memoryCardsHtml(rows);
    var pinned = [];
    var rest = [];
    rows.forEach(function (item) {
      if (item.pinned) pinned.push(item);
      else rest.push(item);
    });
    var html = "";
    if (pinned.length) html += C.section("置顶", String(pinned.length) + " 条", memoryCardsHtml(pinned));
    if (rest.length) html += memoryCardsHtml(rest);
    return html;
  }

  function render() {
    var memoryBody = memoryBodyHtml();
    var memoryHtml =
      "<div class=\"stack\">" +
      (activeTab === "memory" ? memoryToolbar() : "") +
      C.section("记忆", String(MEMORIES.length) + " 条", memoryBody) +
      C.section("冲突", "", C.emptyState("没有待合并的记忆", "同一作用域发生冲突时会列在这里")) +
      "<div id=\"memory-confirm\"></div>" +
      "</div>";
    var soulCards = SOULS.map(function (item) {
      return C.record({
        id: item.id,
        icon: "soul",
        title: item.agent_name,
        facts: [
          ["版本", "v" + item.version],
          ["更新时间", C.escapeHtml(C.formatMinute(item.updated_at) || "—")],
        ],
        actions:
          "<button type=\"button\" class=\"secondary\" data-card-act=\"history\" data-kind=\"soul\" data-id=\"" + C.escapeHtml(item.id) + "\">历史版本</button>",
        manage: "soul:" + item.id,
      });
    }).join("");
    var soulBody = !soulsLoaded
      ? C.emptyState("正在加载 Soul", "马上就好")
      : SOULS.length
        ? C.cardList(soulCards)
        : C.emptyState("还没有 Soul", "给 Agent 添加人格定义后会列在这里");
    var soulHtml =
      "<div class=\"stack\">" +
      C.section("Soul", String(SOULS.length) + " 份", soulBody) +
      "</div>";
    var head =
      '<div class="page-head"><div class="page-tabs" role="tablist">' +
      '<button class="page-tab" type="button" role="tab" data-tab="memory" aria-selected="' +
      (activeTab === "memory" ? "true" : "false") +
      '">记忆</button>' +
      '<button class="page-tab" type="button" role="tab" data-tab="soul" aria-selected="' +
      (activeTab === "soul" ? "true" : "false") +
      '">Soul</button>' +
      "</div>" +
      '<div class="page-head-actions">' +
      (activeTab === "memory"
        ? '<button type="button" class="secondary" data-mem-act="tag-all">AI 补全标签</button>' +
          '<button type="button" class="add-button" data-add="memory">添加记忆</button>'
        : '<button type="button" class="add-button" data-add="soul">添加 Soul</button>') +
      "</div></div>";
    C.mount(
      C.layout(
        "",
        head +
          "<div data-panel=\"memory\"" + (activeTab === "memory" ? "" : " hidden") + ">" + memoryHtml + "</div>" +
          "<div data-panel=\"soul\"" + (activeTab === "soul" ? "" : " hidden") + ">" + soulHtml + "</div>"
      )
    );
  }

  function tagFieldHtml(initialTags) {
    return (
      "<div class=\"tag-field\" data-tag-field>" +
      "<span>标签</span>" +
      "<div class=\"perm-tags\" data-tag-selected></div>" +
      "<input type=\"text\" data-tag-search autocomplete=\"off\" placeholder=\"#新标签，空格或回车创建；或从下方标签云点选\" />" +
      "<div class=\"perm-menu\" data-tag-cloud></div>" +
      "<input type=\"hidden\" name=\"tags\" value=\"" + C.escapeHtml((initialTags || []).join(",")) + "\" />" +
      "</div>"
    );
  }

  function wireTagField(form, initialTags) {
    var field = form.querySelector("[data-tag-field]");
    if (!field) return;
    var selected = (initialTags || []).slice();
    var selectedEl = field.querySelector("[data-tag-selected]");
    var cloudEl = field.querySelector("[data-tag-cloud]");
    var searchEl = field.querySelector("[data-tag-search]");
    var hiddenEl = field.querySelector("[name=\"tags\"]");
    function cleanTag(raw) {
      return String(raw || "").replace(/^#+/, "").replace(/[,，、]/g, "").trim();
    }
    function render() {
      hiddenEl.value = selected.join(",");
      selectedEl.innerHTML = selected.length
        ? selected
            .map(function (t) {
              return (
                "<span class=\"perm-tag\">" +
                C.escapeHtml(t) +
                "<button type=\"button\" class=\"perm-tag-x\" data-tag-remove=\"" +
                C.escapeHtml(t) +
                "\" aria-label=\"移除标签\">×</button></span>"
              );
            })
            .join("")
        : "<span class=\"subtle\">还没有标签</span>";
      var q = cleanTag(searchEl.value).toLowerCase();
      var candidates = allMemTags().filter(function (t) {
        return selected.indexOf(t) === -1 && (!q || t.toLowerCase().indexOf(q) !== -1);
      });
      cloudEl.innerHTML = candidates.length
        ? candidates
            .map(function (t) {
              return "<button type=\"button\" class=\"perm-item\" data-tag-add=\"" + C.escapeHtml(t) + "\">" + C.escapeHtml(t) + "</button>";
            })
            .join("")
        : "<p class=\"perm-menu-empty\">" +
          (allMemTags().length ? "没有更多可点选的标签" : "暂无已有标签，在上方输入 #新标签 创建") +
          "</p>";
    }
    function commit(raw) {
      String(raw || "")
        .split(/\s+/)
        .forEach(function (piece) {
          var t = cleanTag(piece);
          if (t && selected.indexOf(t) === -1) selected.push(t);
        });
      searchEl.value = "";
      render();
    }
    field.addEventListener("click", function (event) {
      var add = event.target.closest ? event.target.closest("[data-tag-add]") : null;
      if (add) {
        var t = add.getAttribute("data-tag-add");
        if (selected.indexOf(t) === -1) selected.push(t);
        render();
        return;
      }
      var rm = event.target.closest ? event.target.closest("[data-tag-remove]") : null;
      if (rm) {
        var v = rm.getAttribute("data-tag-remove");
        selected = selected.filter(function (x) { return x !== v; });
        render();
      }
    });
    searchEl.addEventListener("input", render);
    searchEl.addEventListener("keydown", function (event) {
      if (event.isComposing) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        commit(searchEl.value);
      }
    });
    searchEl.addEventListener("blur", function () {
      if (searchEl.value.trim()) commit(searchEl.value);
    });
    render();
  }

  // 添加与编辑共用同一套字段构建；item 为空是添加，传入条目是编辑并预填
  function memoryFields(item) {
    var v = item || { title: "", scope: "", content: "", tags: [], weight: 0 };
    return (
      "<label>标题<input name=\"title\" maxlength=\"80\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.title) + "\" /></label>" +
      "<label>作用域<input name=\"scope\" maxlength=\"40\" autocomplete=\"off\" placeholder=\"例如 全局、工作区或某个 Agent\" value=\"" + C.escapeHtml(v.scope) + "\" /></label>" +
      "<label>内容<textarea name=\"content\" rows=\"4\" maxlength=\"2000\">" + C.escapeHtml(v.content) + "</textarea></label>" +
      "<label>权重（0–100）<input name=\"weight\" type=\"number\" min=\"0\" max=\"100\" step=\"1\" value=\"" + (v.weight || 0) + "\" /></label>" +
      tagFieldHtml(v.tags || [])
    );
  }

  // 添加记忆走自然语言 ingest：整段交给服务端，Workers AI 拆成记忆点并打标；
  // AI 不可用时服务端整段存一条，这里如实把结果告诉用户。
  function openIngestDialog() {
    var done = false;
    var ctrl = C.openFormDialog({
      title: "添加记忆",
      bodyHtml:
        "<label>内容<textarea name=\"text\" rows=\"6\" maxlength=\"20000\" placeholder=\"用自然语言写下要记住的事，一段里可以包含多个事实，保存时 AI 会拆成一条条记忆点并打上标签\"></textarea></label>" +
        "<label>作用域<input name=\"scope\" maxlength=\"40\" autocomplete=\"off\" placeholder=\"例如 全局、工作区或某个 Agent，可留空\"></label>" +
        tagFieldHtml([]),
      submitLabel: "保存",
      onSubmit: function (ctrl) {
        if (done) {
          ctrl.close();
          return;
        }
        var text = val(ctrl, "text");
        if (!text) {
          ctrl.setError("请填写要保存的内容");
          return;
        }
        var payload = { text: text };
        var tagsEl = ctrl.form.querySelector("[name=\"tags\"]");
        if (tagsEl && tagsEl.value) payload.tags = tagsEl.value.split(",").filter(function (t) { return !!t; });
        var scope = val(ctrl, "scope");
        if (scope) payload.scope = scope;
        if (ctrl.setBusy) ctrl.setBusy(true);
        api("POST", "/api/memory/ingest", payload)
          .then(function (result) {
            if (ctrl.setBusy) ctrl.setBusy(false);
            if (result.data && result.data.ok) {
              done = true;
              var titles = (result.data.memories || [])
                .map(function (m) {
                  return "<li>" + C.escapeHtml(m.title) + "</li>";
                })
                .join("");
              var head = result.data.split
                ? "已保存，AI 拆成了 " + result.data.count + " 条记忆"
                : "AI 暂不可用，已把整段保存为一条记忆，之后可用「AI 打标签」补标";
              ctrl.showResult("<p>" + head + "</p>" + (titles ? "<ul>" + titles + "</ul>" : ""), "完成");
              refreshMemories();
            } else {
              ctrl.setError((result.data && result.data.error) || "保存失败，请重试");
            }
          })
          .catch(function () {
            if (ctrl.setBusy) ctrl.setBusy(false);
            ctrl.setError("保存失败，请重试");
          });
      },
    });
    wireTagField(ctrl.form, []);
  }
  function openMemoryDialog(item) {
    var editing = !!item;
    var ctrl = C.openFormDialog({
      title: editing ? "编辑记忆" : "添加记忆",
      bodyHtml: memoryFields(item),
      submitLabel: editing ? "保存" : "添加",
      onSubmit: function (ctrl) {
        var title = val(ctrl, "title");
        if (!title) { ctrl.setError("请填写标题"); return; }
        var weightEl = ctrl.form.querySelector("[name=\"weight\"]");
        var weight = weightEl ? Number(weightEl.value) : 0;
        if (!isFinite(weight) || weight < 0 || weight > 100) {
          ctrl.setError("权重需在 0 到 100 之间");
          return;
        }
        var tags = val(ctrl, "tags")
          .split(/[,，、]/)
          .map(function (t) { return t.trim(); })
          .filter(function (t) { return !!t; });
        var payload = {
          title: title,
          scope: val(ctrl, "scope") || "全局",
          content: val(ctrl, "content"),
          weight: Math.floor(weight),
          tags: tags,
        };
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
    wireTagField(ctrl.form, editing ? item.tags || [] : []);
  }

  function soulFields(item) {
    var v = item || { agent_name: "", content: "" };
    return (
      "<label>Agent<input name=\"agent\" maxlength=\"80\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.agent_name) + "\" /></label>" +
      "<label>内容<textarea name=\"content\" rows=\"12\" placeholder=\"这个 Agent 的人格与行为定义全文\">" + C.escapeHtml(v.content) + "</textarea></label>"
    );
  }

  function loadSouls() {
    return soulApi("GET", "/api/soul")
      .then(function (res) {
        if (res.status === 200 && res.data.souls) {
          SOULS = res.data.souls;
          soulsLoaded = true;
          render();
        }
      })
      .catch(function () {
        // 加载失败时保持未加载状态，下一次成功写入后会重新拉取
      });
  }

  function openSoulDialog(item) {
    if (item && item.content === undefined) {
      // 列表只带摘要，编辑前先取回全文再打开弹窗
      soulApi("GET", "/api/soul/" + encodeURIComponent(item.id)).then(function (res) {
        if (res.status === 200 && res.data.soul) openSoulDialog(res.data.soul);
      });
      return;
    }
    var editing = !!item;
    C.openFormDialog({
      title: editing ? "编辑 Soul" : "添加 Soul",
      size: "md",
      bodyHtml: soulFields(item),
      submitLabel: editing ? "保存" : "添加",
      onSubmit: function (ctrl) {
        var agent = val(ctrl, "agent");
        if (!agent) { ctrl.setError("请填写 Agent"); return; }
        var contentEl = ctrl.form.querySelector("[name=\"content\"]");
        var content = contentEl ? contentEl.value : "";
        ctrl.setBusy(true);
        var request = editing
          ? soulApi("PATCH", "/api/soul/" + encodeURIComponent(item.id), { agent_name: agent, content: content })
          : soulApi("POST", "/api/soul", { agent_name: agent, content: content });
        request
          .then(function (res) {
            ctrl.setBusy(false);
            if ((res.status === 200 || res.status === 201) && res.data.soul) {
              ctrl.close();
              loadSouls();
            } else {
              ctrl.setError(C.explain(res.data.error, "保存失败，请稍后重试"));
            }
          })
          .catch(function () {
            ctrl.setBusy(false);
            ctrl.setError("网络异常，请重试");
          });
      },
    });
  }

  function patchMemory(item, payload, okText) {
    return api("PATCH", "/api/memory/" + encodeURIComponent(item.id), payload).then(function (result) {
      if (result.data && result.data.ok) {
        if (okText) setMemNotice(okText, "ok");
        refreshMemories();
        return true;
      }
      setMemNotice((result.data && result.data.error) || "保存失败，请重试", "danger");
      render();
      return false;
    });
  }

  function toggleMemPin(item) {
    patchMemory(item, { pinned: !item.pinned }, item.pinned ? "已取消置顶" : "已置顶");
  }

  function saveMemTier(item, srcEl) {
    var dlg = srcEl && srcEl.closest ? srcEl.closest("[data-manage-dialog]") : null;
    var wEl = dlg ? dlg.querySelector("[name=\"mem-weight\"]") : null;
    var weight = wEl ? Number(wEl.value) : item.weight || 0;
    if (!isFinite(weight) || weight < 0 || weight > 100) {
      setMemNotice("权重需在 0 到 100 之间", "danger");
      C.closeCurrentOverlay();
      render();
      return;
    }
    var payload = {
      weight: Math.floor(weight),
    };
    patchMemory(item, payload, "分级设置已保存").then(function () {
      C.closeCurrentOverlay();
    });
  }

  function tagMemory(item, srcEl) {
    if (srcEl) srcEl.disabled = true;
    api("POST", "/api/memory/" + encodeURIComponent(item.id) + "/tag")
      .then(function (result) {
        C.closeCurrentOverlay();
        if (result.data && result.data.ok) {
          var tags = (result.data.memory && result.data.memory.tags) || [];
          setMemNotice(tags.length ? "已打上标签：" + tags.join("、") : "已完成打标", "ok");
          refreshMemories();
        } else {
          setMemNotice((result.data && result.data.error) || "打标签失败，请重试", "danger");
          render();
        }
      })
      .catch(function () {
        C.closeCurrentOverlay();
        setMemNotice("打标签失败，请重试", "danger");
        render();
      });
  }

  function tagAllMemories(srcEl) {
    if (srcEl) srcEl.disabled = true;
    api("POST", "/api/memory/tag-untagged", {})
      .then(function (result) {
        if (result.data && result.data.ok) {
          if (result.data.scanned === 0) setMemNotice("没有待打标的记忆", "ok");
          else setMemNotice("补标完成：成功 " + result.data.tagged + " 条，失败 " + result.data.failed + " 条", result.data.failed ? "danger" : "ok");
          refreshMemories();
        } else {
          setMemNotice((result.data && result.data.error) || "补标失败，请重试", "danger");
          render();
        }
      })
      .catch(function () {
        setMemNotice("补标失败，请重试", "danger");
        render();
      });
  }

  function removeMemory(item, srcEl) {
    var dlg = srcEl && srcEl.closest ? srcEl.closest("[data-manage-dialog]") : null;
    
      api("DELETE", "/api/memory/" + encodeURIComponent(item.id)).then(function (result) {
        if (result.data && result.data.ok) { C.closeCurrentOverlay(); loadMemories(); }
      });
    
  }

  function openSoulHistory(item) {
    var currentHtml = C.list(
      C.record({
        title: "v" + item.version,
        lede: excerptOf(item.content),
        facts: [["更新时间", C.escapeHtml(C.formatMinute(item.updated_at) || "—")]],
        extra: '<span class="subtle">当前版本</span>',
      })
    );
    var ctrl = C.openFormDialog({
      title: item.agent_name + " 的历史版本",
      size: "md",
      bodyHtml: currentHtml + '<p class="subtle">其余历史版本读取中</p>',
      submitLabel: "关闭",
      onSubmit: function (c) {
        c.close();
      },
    });
    soulApi("GET", "/api/soul/" + encodeURIComponent(item.id) + "/versions")
      .then(function (res) {
        var versions = (res.data && res.data.versions) || [];
        var cards = versions
          .map(function (v) {
            var sourceLabel = v.source === "mcp" ? "Agent 写入" : v.source === "rollback" ? "回滚生成" : "面板编辑";
            var excerpt = String(v.content || "").slice(0, 120);
            var action =
              v.version === item.version
                ? "<span class=\"subtle\">当前版本</span>"
                : "<div class=\"row-actions\"><button type=\"button\" class=\"secondary\" data-rollback=\"" + v.version + "\">回滚到此版</button></div>";
            return C.record({
              title: "v" + v.version,
              lede: excerpt,
              facts: [
                ["来源", sourceLabel],
                ["时间", C.escapeHtml(C.formatMinute(v.created_at) || "—")],
              ],
              extra: action,
            });
          })
          .join("");
        ctrl.showResult(cards ? C.list(cards) : C.emptyState("没有历史版本", ""), "关闭");
        Array.prototype.forEach.call(ctrl.form.querySelectorAll("[data-rollback]"), function (btn) {
          btn.addEventListener("click", function () {
            var target = Number(btn.getAttribute("data-rollback"));
            btn.disabled = true;
            soulApi("POST", "/api/soul/" + encodeURIComponent(item.id) + "/rollback", { version: target })
              .then(function (r) {
                if (r.status === 200 && r.data.soul) {
                  ctrl.close();
                  loadSouls();
                } else {
                  btn.disabled = false;
                }
              })
              .catch(function () {
                btn.disabled = false;
              });
          });
        });
      })
      .catch(function () {
        ctrl.showResult(currentHtml + C.emptyState("历史版本读取失败", "网络异常，请稍后重试"), "关闭");
      });
  }

  function deleteSoul(item) {
    
      soulApi("DELETE", "/api/soul/" + encodeURIComponent(item.id)).then(function (res) {
        if (res.status === 200) { C.closeCurrentOverlay(); loadSouls(); }
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
      if (add.getAttribute("data-add") === "memory") openIngestDialog();
      else openSoulDialog(null);
      return;
    }
    var memPin = target.closest("[data-mem-pin]");
    if (memPin) {
      var pinId = memPin.getAttribute("data-mem-pin");
      var pinItem = null;
      MEMORIES.forEach(function (entry) { if (entry.id === pinId) pinItem = entry; });
      if (pinItem) toggleMemPin(pinItem);
      return;
    }
    var tagChip = target.closest("[data-mem-tag]");
    if (tagChip) {
      var tagValue = tagChip.getAttribute("data-mem-tag") || "";
      memTagFilter = memTagFilter === tagValue ? "" : tagValue;
      render();
      return;
    }
    var memAct = target.closest("[data-mem-act]");
    if (memAct) {
      if (memAct.getAttribute("data-mem-act") === "tag-all") tagAllMemories(memAct);
      return;
    }
    var zone = target.closest("[data-manage]");
    if (zone && !target.closest("button, a, input, select, textarea")) {
      openManage(zone.getAttribute("data-manage"));
      return;
    }
    var cardAct = target.closest("[data-card-act]");
    if (cardAct) {
      var akind = cardAct.getAttribute("data-kind");
      var aid = cardAct.getAttribute("data-id");
      var apool = akind === "memory" ? MEMORIES : SOULS;
      var afound = null;
      apool.forEach(function (entry) { if (entry.id === aid) afound = entry; });
      if (afound) {
        var act = cardAct.getAttribute("data-card-act");
        if (act === "edit") { if (akind === "memory") openMemoryDialog(afound); else openSoulDialog(afound); }
        else if (act === "history") openSoulHistory(afound);
        else if (act === "delete") { if (akind === "memory") removeMemory(afound, cardAct); else deleteSoul(afound); }
        else if (akind === "memory" && act === "pin") { C.closeCurrentOverlay(); toggleMemPin(afound); }
        else if (akind === "memory" && act === "tier") saveMemTier(afound, cardAct);
        else if (akind === "memory" && act === "ai-tag") tagMemory(afound, cardAct);
      }
    }
  }
  render();
  loadMemories();
  loadSouls();
})();
