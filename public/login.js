/* mock: 登录表单只做静态校验，不建立会话。接入后改为 POST /api/session */
(function () {
  var C = window.HiveCommon;
  C.mount(
    C.layout(
      "使用工作区账号进入控制面",
      '<div class="stack">' +
        '<section class="panel auth-panel"><form id="login-form" method="post" action="/login.html">' +
        '<p id="login-error" class="field-error" hidden></p>' +
        "<label>账号" +
        '<input id="account" name="account" type="text" autocomplete="username" maxlength="80" spellcheck="false" />' +
        "</label>" +
        "<label>密码" +
        '<span class="password-field">' +
        '<input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" />' +
        '<button id="password-toggle" class="icon-btn" type="button" aria-label="显示密码" aria-pressed="false">' +
        '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#icon-eye"/></svg>' +
        "</button></span></label>" +
        '<p id="login-note" class="callout">静态骨架，提交不会建立会话</p>' +
        '<button id="login-submit" type="submit">登录</button>' +
        "</form></section>" +
        C.section("其他方式", "", C.emptyState("还没有其他登录方式", "通行密钥与第三方登录接通后会出现在这里")) +
        "</div>",
    ),
  );

  var form = document.getElementById("login-form");
  var account = document.getElementById("account");
  var password = document.getElementById("password");
  var error = document.getElementById("login-error");
  var toggle = document.getElementById("password-toggle");
  if (toggle && password) {
    toggle.addEventListener("click", function () {
      var show = password.type === "password";
      password.type = show ? "text" : "password";
      toggle.setAttribute("aria-pressed", show ? "true" : "false");
      toggle.setAttribute("aria-label", show ? "隐藏密码" : "显示密码");
    });
  }
  if (!form || !error || !account || !password) return;
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var missing = account.value.trim().length === 0 || password.value.length === 0;
    error.hidden = !missing;
    error.textContent = missing ? "请填写账号和密码" : "";
  });
})();
