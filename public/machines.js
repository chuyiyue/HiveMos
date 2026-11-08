/* 云主机板块三页签（服务器 / 云主机 / Workers），数据走 /api/machines。
   状态、最近心跳是运行态字段（由 Agent 经 MCP 上报），表单里不出现；
   绑定是普通文本字段，随添加/编辑一起保存。 */
(function () {
  var C = window.HiveCommon;
  var activeTab = location.hash === "#hosts" ? "hosts" : location.hash === "#workers" ? "workers" : "servers";
  var API_KIND = { server: "server", host: "cloud", worker: "worker" };
  var TITLE_FOR = { server: "服务器", host: "云主机", worker: "Worker" };

  var state = { items: [], loaded: false, loadError: "" };

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

  function byKind(uiKind) {
    var kind = API_KIND[uiKind];
    return state.items.filter(function (item) { return item.kind === kind; });
  }

  function heartbeatText(item) {
    var text = C.formatMinute(item.last_heartbeat_at);
    return text || "还没有心跳";
  }

  // 与其它板块同一套卡片菜单入口：record 的 extra 里放「高级」按钮
  function manageBtn(kind, id) {
    return '<div class="row-actions"><button type="button" class="secondary" data-manage="' + kind + '" data-id="' + C.escapeHtml(id) + '">高级</button></div>';
  }
  function card(kind, item, facts) {
    var lede = kind === "worker" ? item.description : item.region;
    return C.record({ id: item.id, title: item.name, status: item.status, lede: lede || "", facts: facts, extra: manageBtn(kind, item.id) });
  }

  function listSection(uiKind, title, unit) {
    var items = byKind(uiKind);
    if (!state.loaded) return C.section(title, "", C.emptyState("正在加载", "正在读取云主机数据"));
    if (state.loadError) return C.section(title, "", '<p class="callout danger" role="alert">' + C.escapeHtml(state.loadError) + "</p>");
    var cards;
    if (uiKind === "worker") {
      cards = items.map(function (item) {
        return card("worker", item, [["版本", C.escapeHtml(item.version || "未记录")], ["更新时间", C.escapeHtml(C.formatMinute(item.updated_at) || "—")]]);
      });
    } else {
      var specLabel = uiKind === "server" ? "配置" : "规格";
      cards = items.map(function (item) {
        return card(uiKind, item, [[specLabel, C.escapeHtml(item.spec)], ["绑定", C.escapeHtml(item.binding || "未绑定")], ["最近心跳", C.escapeHtml(heartbeatText(item))]]);
      });
    }
    return C.section(title, String(items.length) + " " + unit, C.list(cards.join("")));
  }

  function render() {
    var serverHtml =
      "<div class=\"stack\">" +
      "<button type=\"button\" class=\"add-button\" data-add=\"server\">添加服务器</button>" +
      listSection("server", "服务器", "台") +
      "</div>";
    var hostHtml =
      "<div class=\"stack\">" +
      "<button type=\"button\" class=\"add-button\" data-add=\"host\">添加云主机</button>" +
      listSection("host", "云主机", "台") +
      C.section("已释放", "", C.emptyState("没有已释放的云主机", "释放后的实例会留在这里，直到记录被清掉")) +
      "</div>";
    var workerHtml =
      "<div class=\"stack\">" +
      "<button type=\"button\" class=\"add-button\" data-add=\"worker\">添加 Worker</button>" +
      listSection("worker", "Workers", "个") +
      "</div>";
    C.mount(
      C.layout(
        "",
        "<div class=\"page-tabs\" role=\"tablist\">" +
          "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"servers\" aria-selected=\"" + (activeTab === "servers" ? "true" : "false") + "\">服务器</button>" +
          "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"hosts\" aria-selected=\"" + (activeTab === "hosts" ? "true" : "false") + "\">云主机</button>" +
          "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"workers\" aria-selected=\"" + (activeTab === "workers" ? "true" : "false") + "\">Workers</button>" +
          "</div>" +
          "<div data-panel=\"servers\"" + (activeTab === "servers" ? "" : " hidden") + ">" + serverHtml + "</div>" +
          "<div data-panel=\"hosts\"" + (activeTab === "hosts" ? "" : " hidden") + ">" + hostHtml + "</div>" +
          "<div data-panel=\"workers\"" + (activeTab === "workers" ? "" : " hidden") + ">" + workerHtml + "</div>"
      )
    );
  }

  function load() {
    return api("GET", "/api/machines")
      .then(function (res) {
        state.loaded = true;
        if (res.data && res.data.ok) {
          state.items = res.data.machines || [];
          state.loadError = "";
        } else {
          state.loadError = (res.data && res.data.error) || "云主机数据读取失败";
        }
        render();
      })
      .catch(function () {
        state.loaded = true;
        state.loadError = "云主机数据读取失败";
        render();
      });
  }

  // 添加与编辑共用同一套字段构建；item 为空是添加，传入条目是编辑并预填。
  // 状态、心跳、版本是运行态字段，不在表单里，编辑时保持不变
  function itemFields(kind, item) {
    var isWorker = kind === "worker";
    var v = item || { name: "", region: "", spec: "", description: "", binding: "" };
    var ledeValue = isWorker ? v.description : v.region;
    var html =
      "<label>名称<input name=\"name\" maxlength=\"60\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.name) + "\" /></label>" +
      (isWorker
        ? "<label>说明<input name=\"lede\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 本控制面\" value=\"" + C.escapeHtml(ledeValue || "") + "\" /></label>"
        : "<label>地域<input name=\"lede\" maxlength=\"30\" autocomplete=\"off\" value=\"" + C.escapeHtml(ledeValue || "") + "\" /></label>" +
          "<label>" + (kind === "server" ? "配置" : "规格") + "<input name=\"spec\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 2 核 / 4 GB / 40 GB\" value=\"" + C.escapeHtml(v.spec || "") + "\" /></label>" +
          "<label>绑定<input name=\"binding\" maxlength=\"60\" autocomplete=\"off\" placeholder=\"例如 值守（留空为未绑定）\" value=\"" + C.escapeHtml(item ? v.binding || "" : "") + "\" /></label>");
    return html;
  }

  function openItemDialog(kind, item) {
    var editing = !!item;
    var isWorker = kind === "worker";
    C.openFormDialog({
      title: (editing ? "编辑" : "添加") + TITLE_FOR[kind],
      bodyHtml: itemFields(kind, item),
      submitLabel: editing ? "保存" : "添加",
      onSubmit: function (ctrl) {
        var name = val(ctrl, "name");
        if (!name) { ctrl.setError("请填写名称"); return; }
        var payload;
        if (isWorker) {
          payload = { name: name, description: val(ctrl, "lede") };
        } else {
          payload = {
            name: name,
            region: val(ctrl, "lede"),
            spec: val(ctrl, "spec") || (kind === "server" ? "未填写配置" : "未填写规格"),
            binding: val(ctrl, "binding"),
          };
        }
        ctrl.setBusy(true);
        var request = editing
          ? api("PATCH", "/api/machines/" + encodeURIComponent(item.id), payload)
          : api("POST", "/api/machines", Object.assign({ kind: API_KIND[kind] }, payload));
        request
          .then(function (res) {
            ctrl.setBusy(false);
            if (!res.data || !res.data.ok) {
              ctrl.setError((res.data && res.data.error) || "保存失败，请重试");
              return;
            }
            ctrl.close();
            load();
          })
          .catch(function () {
            ctrl.setBusy(false);
            ctrl.setError("网络异常，请重试");
          });
      },
    });
  }

  function openManageMenu(kind, item, anchor) {
    C.openActionMenu({
      title: item.name,
      items: [
        {
          label: "编辑",
          onSelect: function () { openItemDialog(kind, item); },
        },
        {
          label: "删除",
          hint: "删除后记录不再保留",
          danger: true,
          onSelect: function () {
            C.askConfirm({
              anchor: anchor,
              title: "删除" + TITLE_FOR[kind],
              text: "确认删除「" + item.name + "」吗？删除后无法恢复",
              confirmLabel: "删除",
              danger: true,
            }).then(function (yes) {
              if (!yes) return;
              api("DELETE", "/api/machines/" + encodeURIComponent(item.id)).then(function (res) {
                if (res.data && res.data.ok) load();
              });
            });
          },
        },
      ],
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
      openItemDialog(add.getAttribute("data-add"), null);
      return;
    }
    var manage = target.closest("[data-manage]");
    if (manage) {
      var mkind = manage.getAttribute("data-manage");
      var mid = manage.getAttribute("data-id");
      var found = null;
      state.items.forEach(function (entry) { if (entry.id === mid) found = entry; });
      if (found) openManageMenu(mkind, found, manage);
    }
  });
  render();
  load();
})();
