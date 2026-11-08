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
        "<dl class=\"kv\">" +
        "<div><dt>作用域</dt><dd>" + C.escapeHtml(item.scope || "未注明") + "</dd></div>" +
        "<div><dt>来源</dt><dd>" + C.escapeHtml(item.source || "未注明") + "</dd></div>" +
        "<div><dt>更新时间</dt><dd>" + C.escapeHtml(C.formatMinute(item.updated_at) || "未知") + "</dd></div>" +
        "</dl>" +
        "<h3 class=\"manage-subhead\">内容</h3>" +
        "<p>" + C.escapeHtml(excerptOf(item.content)) + "</p>" +
        "<div class=\"manage-actions\">" +
        "<button type=\"button\" class=\"secondary\" data-card-act=\"edit\" data-kind=\"memory\" data-id=\"" + id + "\">编辑</button>" +
        "<button type=\"button\" class=\"danger\" data-card-act=\"delete\" data-kind=\"memory\" data-id=\"" + id + "\">删除</button>" +
        "</div>",
    });
    ctrl.dialog.addEventListener("click", handleClick);
  }

  function openSoulManage(item) {
    var id = C.escapeHtml(item.id);
    var ctrl = C.openManageDialog({
      title: item.agent_name,
      bodyHtml:
        "<dl class=\"kv\">" +
        "<div><dt>版本</dt><dd>v" + C.escapeHtml(String(item.version)) + "</dd></div>" +
        "<div><dt>更新时间</dt><dd>" + C.escapeHtml(C.formatMinute(item.updated_at) || "未知") + "</dd></div>" +
        "</dl>" +
        "<div class=\"manage-actions\">" +
        "<button type=\"button\" class=\"secondary\" data-card-act=\"edit\" data-kind=\"soul\" data-id=\"" + id + "\">编辑</button>" +
        "<button type=\"button\" class=\"secondary\" data-card-act=\"history\" data-kind=\"soul\" data-id=\"" + id + "\">历史版本</button>" +
        "<button type=\"button\" class=\"danger\" data-card-act=\"delete\" data-kind=\"soul\" data-id=\"" + id + "\">删除</button>" +
        "</div>" +
        "<div class=\"confirm-slot\" data-confirm-soul=\"" + id + "\"></div>",
    });
    ctrl.dialog.addEventListener("click", handleClick);
  }

  function render() {
    var memCards = MEMORIES.map(function (item) {
      return C.record({
        id: item.id,
        icon: "memory",
        title: item.title,
        pill: item.scope,
        lede: excerptOf(item.content),
        facts: [
          ["来源", C.escapeHtml(item.source || "未注明")],
          ["更新时间", C.escapeHtml(fmtTime(item.updated_at))],
        ],
        actions:
          "<button type=\"button\" class=\"secondary\" data-copy=\"" + C.escapeHtml(item.content || "") + "\" data-label=\"复制内容\">复制内容</button>",
        manage: "memory:" + item.id,
      });
    }).join("");
    var memoryBody;
    if (memoryError) memoryBody = C.emptyState("记忆加载失败", memoryError);
    else if (!memoryLoaded) memoryBody = C.emptyState("正在加载记忆", "");
    else if (!MEMORIES.length) memoryBody = C.emptyState("还没有记忆", "点上方按钮添加第一条");
    else memoryBody = C.list(memCards);
    var memoryHtml =
      "<div class=\"stack\">" +
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
        ? C.list(soulCards)
        : C.emptyState("还没有 Soul", "给 Agent 添加人格定义后会列在这里");
    var soulHtml =
      "<div class=\"stack\">" +
      C.section("Soul", String(SOULS.length) + " 份", soulBody) +
      C.section("草稿", "", C.emptyState("没有未发布的草稿", "尚未同步的 Soul 草稿会留在这里")) +
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
        ? '<button type="button" class="add-button" data-add="memory">添加记忆</button>'
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
      wide: true,
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

  function removeMemory(item, srcEl) {
    var dlg = srcEl && srcEl.closest ? srcEl.closest("[data-manage-dialog]") : null;
    var anchor = (dlg && dlg.querySelector("[data-manage-confirm]")) || document.getElementById("memory-confirm");
    C.askConfirm({
      anchor: anchor,
      title: "删除记忆",
      text: "确认删除「" + item.title + "」吗？删除后从列表移除",
      confirmLabel: "删除",
      danger: true,
    }).then(function (yes) {
      if (!yes) return;
      api("DELETE", "/api/memory/" + encodeURIComponent(item.id)).then(function (result) {
        if (result.data && result.data.ok) { C.closeCurrentOverlay(); loadMemories(); }
      });
    });
  }

  function openSoulHistory(item) {
    var ctrl = C.openFormDialog({
      title: item.agent_name + " 的历史版本",
      wide: true,
      bodyHtml: C.emptyState("正在加载历史版本", "马上就好"),
      submitLabel: "关闭",
      onSubmit: function (c) {
        c.close();
      },
    });
    soulApi("GET", "/api/soul/" + encodeURIComponent(item.id) + "/versions").then(function (res) {
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
    });
  }

  function deleteSoul(item) {
    var anchor = document.querySelector("[data-confirm-soul=\"" + item.id + "\"]");
    C.askConfirm({
      anchor: anchor,
      title: "删除 Soul",
      text: "确认删除「" + item.agent_name + "」的 Soul 吗？全部历史版本会一并删除",
      confirmLabel: "删除",
      danger: true,
    }).then(function (yes) {
      if (!yes) return;
      soulApi("DELETE", "/api/soul/" + encodeURIComponent(item.id)).then(function (res) {
        if (res.status === 200) { C.closeCurrentOverlay(); loadSouls(); }
      });
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
      if (add.getAttribute("data-add") === "memory") openMemoryDialog(null);
      else openSoulDialog(null);
      return;
    }
    var zone = target.closest("[data-manage]");
    if (zone) {
      if (target.closest("button, a, input, select, textarea")) return;
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
      }
    }
  }
  render();
  loadMemories();
  loadSouls();
})();
