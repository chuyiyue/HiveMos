/* 登录：POST /api/auth/login。已登录则离开本页。 */
(function () {
  var C = window.HiveCommon;
  var nextParam = new URLSearchParams(location.search).get("next");
  C.mount(
    C.layout(
      "使用管理员账号进入控制面",
      '<div class="stack">' +
        '<p id="login-error" class="callout danger" role="alert" hidden></p>' +
        '<section class="panel auth-panel"><form id="login-form" novalidate>' +
        "<label>账号" +
        '<input id="username" name="username" type="text" autocomplete="username" maxlength="256" spellcheck="false" autofocus />' +
        "</label>" +
        "<label>密码" +
        '<span class="password-field">' +
        '<input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" />' +
        '<button id="password-toggle" class="icon-btn" type="button" aria-label="显示密码" aria-pressed="false">' +
        '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#icon-eye"/></svg>' +
        "</button></span></label>" +
        '<button id="login-submit" type="submit">登录</button>' +
        "</form></section>" +
        C.section("其他方式", "", C.emptyState("还没有其他登录方式", "两步验证和第三方登录接通后会出现在这里")) +
        "</div>",
    ),
  );

  var form = document.getElementById("login-form");
  var username = document.getElementById("username");
  var password = document.getElementById("password");
  var error = document.getElementById("login-error");
  var toggle = document.getElementById("password-toggle");
  var submit = document.getElementById("login-submit");
  var label = "登录";

  if (toggle && password) {
    toggle.addEventListener("click", function () {
      var show = password.type === "password";
      password.type = show ? "text" : "password";
      toggle.setAttribute("aria-pressed", show ? "true" : "false");
      toggle.setAttribute("aria-label", show ? "隐藏密码" : "显示密码");
    });
  }

  if (username) {
    username.addEventListener("input", clearTypedError);
  }
  if (password) {
    password.addEventListener("input", clearTypedError);
  }

  C.currentUser().then(function (name) {
    if (name) {
      location.replace(C.safeNext(nextParam));
      return;
    }
    probeUnconfigured();
  });

  if (!form || !error || !username || !password || !submit) return;
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var account = username.value.trim();
    var passwordValue = password.value;
    if (!account || !passwordValue) {
      showError("请填写账号和密码", "danger");
      (account ? password : username).focus();
      return;
    }
    hideError();
    setBusy(true);
    var left = false;
    fetch("/api/auth/login", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ username: account, password: passwordValue }),
      cache: "no-store",
    })
      .then(function (response) {
        return readBody(response).then(function (data) {
          if (response.ok && data.ok === true) {
            left = true;
            location.assign(C.safeNext(nextParam));
            return;
          }
          showError(explain(response.status, data.error), toneFor(response.status, data.error));
          password.select();
        });
      })
      .catch(function () {
        showError("网络错误，请重试", "danger");
      })
      .finally(function () {
        if (!left) setBusy(false);
      });
  });

  function probeUnconfigured() {
    fetch("/api/auth/login", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: "{}",
      cache: "no-store",
    })
      .then(function (response) {
        if (response.status !== 503) return null;
        return readBody(response).then(function (data) {
          showError(explain(503, data.error), "config");
        });
      })
      .catch(function () {});
  }

  function toneFor(status, value) {
    if (status === 503 && String(value || "").indexOf("尚未配置") !== -1) return "config";
    if (status === 503) return "warn";
    return "danger";
  }

  function explain(status, value) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (status === 401) return "用户名或密码不正确";
    if (status === 503) return "管理员账号尚未配置。请设置 Worker 机密 ADMIN_USERNAME 与 ADMIN_PASSWORD";
    if (status === 403) return "请求被拒绝，请刷新页面后重试";
    return "登录失败，请稍后重试";
  }

  function readBody(response) {
    return response.json().then(
      function (data) {
        return data && typeof data === "object" ? data : {};
      },
      function () {
        return {};
      },
    );
  }

  function showError(message, tone) {
    error.className = "callout " + (tone === "config" || tone === "warn" ? "warn" : "danger");
    error.dataset.tone = tone || "danger";
    error.textContent = message;
    error.hidden = false;
  }

  function hideError() {
    delete error.dataset.tone;
    error.hidden = true;
    error.textContent = "";
  }

  function clearTypedError() {
    if (!error || error.dataset.tone === "config") return;
    hideError();
  }

  function setBusy(busy) {
    submit.disabled = busy;
    username.disabled = busy;
    password.disabled = busy;
    submit.textContent = busy ? "登录中…" : label;
  }
})();
