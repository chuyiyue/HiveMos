/* Agent 令牌。列表走 GET /api/agents，明文只在生成那一次响应里出现 */
(function () {
  var C = window.HiveCommon;
  var state = {
    loading: true,
    loadError: "",
    agents: [],
    name: "",
    notice: "",
    noticeKind: "danger",
    token: "",
    tokenName: "",
    busy: false,
  };

  function pill(kind, label) {
    return '<span class="status-indicator" data-status="' + kind + '">' + C.escapeHtml(label) + "</span>";
  }

  function kv(label, html) {
    return "<div><dt>" + C.escapeHtml(label) + "</dt><dd>" + html + "</dd></div>";
  }

  function noticeHtml() {
    var html = "";
    if (state.token) {
      html +=
        '<div class="callout ok" role="status"><p>令牌只显示这一次。离开或刷新页面后无法再查看，请立刻复制</p>' +
        C.copyLine(state.token, "复制令牌") +
        '<div class="row-actions"><button type="button" class="secondary" data-action="dismiss-token">我已复制</button></div></div>';
    }
    if (state.notice) {
      var kind = state.noticeKind === "ok" ? "ok" : "danger";
      html += '<p class="callout ' + kind + '" role="status">' + C.escapeHtml(state.notice) + "</p>";
    }
    return html;
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
      "</div>" +
      (active
        ? '<div class="row-actions"><button type="button" class="danger" data-action="disable" data-id="' +
          C.escapeHtml(agent.id) +
          '">停用</button></div><div class="confirm-slot" data-confirm-for="' +
          C.escapeHtml(agent.id) +
          '"></div>'
        : "") +
      '</div><dl class="kv">' +
      kv("标识", '<span class="mono">' + C.escapeHtml(agent.id) + "</span>") +
      kv("最近调用", C.escapeHtml(seen || "还没有调用")) +
      kv("创建", C.escapeHtml(C.formatMinute(agent.created_at) || "未知")) +
      "</dl></article>"
    );
  }

  function render() {
    var list = state.loading
      ? C.emptyState("正在读取", "稍等片刻")
      : state.loadError
        ? '<p class="callout danger" role="alert">' + C.escapeHtml(state.loadError) + "</p>"
        : state.agents.length
          ? C.list(state.agents.map(card).join(""))
          : C.emptyState("还没有 Agent", "在下方输入名字并生成令牌");
    var form =
      '<section class="panel"><div class="section-head"><h2>生成令牌</h2></div><form id="agent-form" class="form-grid" novalidate>' +
      "<label>名字" +
      '<input data-field="name" name="name" maxlength="64" autocomplete="off" value="' +
      C.escapeHtml(state.name) +
      '" />' +
      '<p class="subtle field-hint">生成后请立刻复制。令牌不会再次显示</p></label>' +
      '<div class="row-actions"><button type="submit">生成令牌</button></div></form></section>';
    C.mount(
      C.layout(
        "可以调用注册表的 Agent。令牌只在生成时出现一次",
        '<div class="stack">' + noticeHtml() + C.section("已登记", state.agents.length ? state.agents.length + " 个" : "", list) + form + "</div>",
      ),
    );
    bind();
  }

  var bound = false;
  function bind() {
    var page = document.getElementById("page");
    if (!page || bound) return;
    bound = true;
    page.addEventListener("input", function (event) {
      var target = event.target;
      if (target instanceof HTMLElement && target.getAttribute("data-field") === "name") state.name = target.value;
    });
    page.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var button = target.closest("[data-action]");
      if (!button || state.busy) return;
      var action = button.getAttribute("data-action");
      if (action === "dismiss-token") {
        state.token = "";
        state.tokenName = "";
        render();
      } else if (action === "disable") disable(button.getAttribute("data-id") || "");
    });
    page.addEventListener("submit", function (event) {
      if (!(event.target instanceof HTMLFormElement) || event.target.id !== "agent-form") return;
      event.preventDefault();
      create();
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
      return response.json().catch(function () {
        return {};
      }).then(function (data) {
        return { status: response.status, data: data || {} };
      });
    });
  }

  function authRedirect(status) {
    if (status !== 401) return false;
    location.assign("/login.html?next=" + encodeURIComponent(location.pathname + location.search));
    return true;
  }

  function create() {
    if (state.busy) return;
    var name = state.name.trim();
    if (!name) {
      state.token = "";
      state.notice = "请填写 Agent 名字";
      state.noticeKind = "danger";
      render();
      return;
    }
    state.busy = true;
    api("POST", "/api/agents", { name: name })
      .then(function (result) {
        state.busy = false;
        if (authRedirect(result.status)) return;
        if (!result.data || result.data.ok !== true || !result.data.agent) {
          state.token = "";
          state.notice = (result.data && result.data.error) || "没有生成，请重试";
          state.noticeKind = "danger";
          render();
          return;
        }
        var agent = result.data.agent;
        state.token = agent.token || "";
        state.tokenName = agent.name || name;
        state.notice = "";
        state.name = "";
        var listed = {
          id: agent.id,
          name: agent.name,
          status: agent.status,
          last_seen_at: agent.last_seen_at,
          created_at: agent.created_at,
        };
        state.agents = [listed].concat(
          state.agents.filter(function (item) {
            return item.id !== listed.id;
          }),
        );
        render();
      })
      .catch(function () {
        state.busy = false;
        state.notice = "网络异常，请重试";
        state.noticeKind = "danger";
        render();
      });
  }

  function disable(id) {
    var agent = state.agents.find(function (item) {
      return item.id === id;
    });
    if (!agent || state.busy) return;
    var anchor = document.querySelector('[data-confirm-for="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    C.askConfirm({
      anchor: anchor,
      title: "停用 Agent",
      text: "确认停用「" + agent.name + "」吗？停用后该令牌不能再调用注册表",
      confirmLabel: "停用",
      danger: true,
    }).then(function (yes) {
      if (!yes) return;
      state.busy = true;
      api("DELETE", "/api/agents/" + encodeURIComponent(id))
        .then(function (result) {
          state.busy = false;
          if (authRedirect(result.status)) return;
          if (!result.data || result.data.ok !== true) {
            state.notice = (result.data && result.data.error) || "没有停用，请重试";
            state.noticeKind = "danger";
            render();
            return;
          }
          state.agents = state.agents.map(function (item) {
            if (item.id !== id) return item;
            return {
              id: item.id,
              name: item.name,
              status: "disabled",
              last_seen_at: item.last_seen_at,
              created_at: item.created_at,
            };
          });
          state.notice = "已停用";
          state.noticeKind = "ok";
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

  render();
  api("GET", "/api/agents")
    .then(function (result) {
      if (authRedirect(result.status)) return;
      state.loading = false;
      if (!result.data || result.data.ok !== true) {
        state.loadError = (result.data && result.data.error) || "没有读到 Agent，请重试";
        render();
        return;
      }
      state.agents = result.data.agents || [];
      render();
    })
    .catch(function () {
      state.loading = false;
      state.loadError = "网络异常，请重试";
      render();
    });
})();
