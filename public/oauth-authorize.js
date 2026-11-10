// OAuth 授权页的交互：身份选择（已有 / 新建 / 链接密钥绑定）+ 两层权限
// 矩阵。页面数据由服务端渲染进 window.__OAUTH_PAGE__；这里只管状态与
// 提交，权限交集服务端还会再算一次，前端的置灰只是提示。
(function () {
  var P = window.__OAUTH_PAGE__ || {};
  var DOMAIN_LABELS = {
    mcp: "MCP", skills: "Skills", api: "API", memory: "记忆", soul: "Soul",
    tasks: "任务", calendar: "日历", vault: "保险库", machines: "云计算资源",
  };
  var ADV_LABELS = {
    machines_secret: "查看凭据",
    soul_write_any: "代写他人 Soul",
    vault_totp_code: "读取保险库验证码",
  };
  var domains = (P.domains || []).map(function (d) { return d.key; });
  var advancedKeys = (P.advanced || []).map(function (a) { return a.key; });

  function emptyPerms() {
    var out = {};
    domains.forEach(function (d) { out[d] = { read: false, write: false }; });
    out.advanced = {};
    advancedKeys.forEach(function (k) { out.advanced[k] = false; });
    return out;
  }
  function norm(input) {
    var out = emptyPerms();
    if (!input || typeof input !== "object") return out;
    domains.forEach(function (d) {
      var cell = input[d];
      if (cell && typeof cell === "object") {
        out[d].read = !!cell.read;
        out[d].write = !!cell.write;
      }
    });
    var adv = input.advanced;
    if (adv && typeof adv === "object") {
      advancedKeys.forEach(function (k) { out.advanced[k] = !!adv[k]; });
    }
    return out;
  }
  function clampToBase(state, base) {
    domains.forEach(function (d) {
      if (!base[d].read) state[d].read = false;
      if (!base[d].write) state[d].write = false;
    });
    advancedKeys.forEach(function (k) {
      if (!base.advanced[k]) state.advanced[k] = false;
    });
  }

  var base = emptyPerms();
  var baseReady = false;
  var baseState = emptyPerms(); // 新建模式下管理员设的基础权限
  var connState = emptyPerms();
  var boundName = "";

  var msg = document.getElementById("msg");
  function say(text) { if (msg) msg.textContent = text || ""; }

  function matrixHtml(state, baseCap, prefix) {
    var html = '<div class="oauth-matrix"><span class="mhead mname">功能</span><span class="mhead">读取</span><span class="mhead">写入</span>';
    domains.forEach(function (d) {
      html += "<span>" + DOMAIN_LABELS[d] + "</span>";
      ["read", "write"].forEach(function (op) {
        var capped = baseCap && !baseCap[d][op];
        html +=
          '<label><input type="checkbox" data-' + prefix + '-cell="' + d + '" data-' + prefix + '-op="' + op + '"' +
          (state[d][op] ? " checked" : "") + (capped ? " disabled" : "") + "></label>";
      });
    });
    html += "</div><div class=\"oauth-adv\">";
    advancedKeys.forEach(function (k) {
      var capped = baseCap && !baseCap.advanced[k];
      html +=
        '<label><input type="checkbox" data-' + prefix + '-adv="' + k + '"' +
        (state.advanced[k] ? " checked" : "") + (capped ? " disabled" : "") + "> " + ADV_LABELS[k] + "（高级）</label>";
    });
    html += "</div>";
    return html;
  }

  function wireMatrix(container, state, prefix, onChange) {
    container.addEventListener("change", function (event) {
      var t = event.target;
      if (!(t instanceof HTMLInputElement)) return;
      var cell = t.getAttribute("data-" + prefix + "-cell");
      var adv = t.getAttribute("data-" + prefix + "-adv");
      if (cell) state[cell][t.getAttribute("data-" + prefix + "-op")] = t.checked;
      else if (adv) state.advanced[adv] = t.checked;
      else return;
      if (onChange) onChange();
    });
  }

  var connBox = document.getElementById("connMatrix");
  function renderConn() {
    if (!connBox) return;
    clampToBase(connState, base);
    connBox.innerHTML = matrixHtml(connState, baseReady ? base : null, "conn");
  }

  var mode = "bind";
  if (P.admin) {
    mode = "existing";
    var sel = document.getElementById("agentSel");
    (P.agents || []).forEach(function (agent) {
      var opt = document.createElement("option");
      opt.value = agent.id;
      opt.textContent = agent.name;
      sel.appendChild(opt);
    });
    function pickAgent() {
      var agent = (P.agents || []).find(function (a) { return a.id === sel.value; });
      if (agent) {
        base = norm(agent.permissions);
        baseReady = true;
      } else {
        base = emptyPerms();
        baseReady = false;
        say("还没有可用的 Agent，可以切换到「创建新 Agent」");
      }
      renderConn();
    }
    if (sel) {
      sel.addEventListener("change", pickAgent);
      pickAgent();
    }
    var baseBox = document.getElementById("baseMatrix");
    if (baseBox) {
      baseBox.innerHTML = matrixHtml(baseState, null, "base");
      wireMatrix(baseBox, baseState, "base", function () {
        if (mode === "new") {
          base = norm(baseState);
          baseReady = true;
          renderConn();
        }
      });
    }
    Array.prototype.forEach.call(document.querySelectorAll('input[name="mode"]'), function (radio) {
      radio.addEventListener("change", function () {
        mode = radio.value;
        if (mode === "existing") pickAgent();
        else {
          base = norm(baseState);
          baseReady = true;
          renderConn();
        }
      });
    });
  } else {
    var bindBtn = document.getElementById("bindBtn");
    var bindState = document.getElementById("bindState");
    if (bindBtn) {
      bindBtn.addEventListener("click", function () {
        var secret = document.getElementById("linkSecret").value;
        say("正在验证");
        fetch("/oauth/bind-check", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ link_secret: secret }),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data || data.ok !== true) {
              say((data && data.error) || "验证失败");
              return;
            }
            boundName = data.agent_name || "";
            base = norm(data.permissions);
            baseReady = true;
            if (bindState) bindState.textContent = "已绑定：" + boundName;
            say("");
            renderConn();
          })
          .catch(function () { say("网络异常，请重试"); });
      });
    }
  }
  if (connBox) wireMatrix(connBox, connState, "conn", null);
  renderConn();

  var denyBtn = document.getElementById("denyBtn");
  if (denyBtn) {
    denyBtn.addEventListener("click", function () {
      var target = new URL(P.params.redirect_uri);
      target.searchParams.set("error", "access_denied");
      if (P.params.state) target.searchParams.set("state", P.params.state);
      location.assign(target.toString());
    });
  }

  var allowBtn = document.getElementById("allowBtn");
  if (allowBtn) {
    allowBtn.addEventListener("click", function () {
      if (!baseReady) {
        say(mode === "bind" ? "请先验证链接密钥" : "请先选择身份");
        return;
      }
      var payload = {
        client_id: P.params.client_id,
        redirect_uri: P.params.redirect_uri,
        state: P.params.state,
        code_challenge: P.params.code_challenge,
        code_challenge_method: "S256",
        mode: mode,
        grants: connState,
      };
      if (mode === "existing") {
        var sel = document.getElementById("agentSel");
        payload.agent_id = sel ? sel.value : "";
      } else if (mode === "new") {
        var name = document.getElementById("newName");
        payload.agent_name = name ? name.value : "";
        payload.base_permissions = baseState;
      } else {
        var secret = document.getElementById("linkSecret");
        payload.link_secret = secret ? secret.value : "";
      }
      allowBtn.disabled = true;
      say("正在提交");
      fetch("/oauth/authorize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.ok === true && data.redirect) {
            location.assign(data.redirect);
            return;
          }
          allowBtn.disabled = false;
          say((data && data.error) || "提交失败，请重试");
        })
        .catch(function () {
          allowBtn.disabled = false;
          say("网络异常，请重试");
        });
    });
  }
})();
