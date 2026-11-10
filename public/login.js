/* 登录：POST /api/auth/login。密码通过且已启用两步验证时，同页进入验证码步骤。已登录则离开本页。 */
(function () {
  var C = window.HiveCommon;
  var nextParam = new URLSearchParams(location.search).get("next");
  var errorParam = new URLSearchParams(location.search).get("error");
  var form = document.getElementById("login-form");
  var username = document.getElementById("username");
  var password = document.getElementById("password");
  var error = document.getElementById("login-error");
  var toggle = document.getElementById("password-toggle");
  var submit = document.getElementById("login-submit");
  var totpForm = document.getElementById("totp-form");
  var totpError = document.getElementById("totp-error");
  var totpCode = document.getElementById("totp-code");
  var totpSubmit = document.getElementById("totp-submit");
  var totpCancel = document.getElementById("totp-cancel");
  var label = "登录";
  var githubBox = document.getElementById("github-login");
  var githubEnabled = false;
  var ticket = "";
  var lockedUntil = 0;
  var countdownTimer = 0;

  if (toggle && password) {
    toggle.addEventListener("click", function () {
      var show = password.type === "password";
      password.type = show ? "text" : "password";
      toggle.setAttribute("aria-pressed", show ? "true" : "false");
      toggle.setAttribute("aria-label", show ? "隐藏密码" : "显示密码");
    });
  }

  if (username) username.addEventListener("input", clearTypedError);
  if (password) password.addEventListener("input", clearTypedError);
  if (totpCode) {
    totpCode.addEventListener("input", function () {
      if (Date.now() < lockedUntil) return;
      hideTotpError();
    });
  }

  C.currentUser().then(function (name) {
    if (name) {
      location.replace(C.safeNext(nextParam));
      return;
    }
    probeUnconfigured();
    probeGithub();
  });

  if (!form || !error || !username || !password || !submit) return;
  if (errorParam && errorParam.indexOf("github_") === 0) {
    showError(githubErrorText(errorParam), "danger");
  }
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
          if (response.ok && data.ok === true && data.totp_required === true) {
            if (!data.ticket) {
              showError("登录失败，请稍后重试", "danger");
              return;
            }
            ticket = String(data.ticket);
            showTotpStep();
            return;
          }
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

  if (totpForm && totpError && totpCode && totpSubmit) {
    totpForm.addEventListener("submit", function (event) {
      event.preventDefault();
      if (Date.now() < lockedUntil) return;
      var code = totpCode.value.trim();
      if (!code) {
        showTotpError("请输入验证码或恢复码");
        totpCode.focus();
        return;
      }
      hideTotpError();
      setTotpBusy(true);
      var left = false;
      var sent = ticket;
      fetch("/api/auth/totp/verify", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ ticket: sent, code: code }),
        cache: "no-store",
      })
        .then(function (response) {
          return readBody(response).then(function (data) {
            if (ticket !== sent && !(response.ok && data.ok === true)) return;
            if (response.ok && data.ok === true) {
              left = true;
              location.assign(C.safeNext(nextParam));
              return;
            }
            if (response.status === 429) {
              showTotpError(explainTotp(response.status, data.error));
              startCountdown(retrySeconds(response, data));
              return;
            }
            var message = explainTotp(response.status, data.error);
            if (response.status === 401 && message.indexOf("过期") !== -1) {
              backToPassword(message);
              return;
            }
            if (response.status === 401) totpCode.value = "";
            showTotpError(message);
            totpCode.focus();
          });
        })
        .catch(function () {
          if (ticket === sent) showTotpError("网络错误，请重试");
        })
        .finally(function () {
          if (!left) setTotpBusy(false);
        });
    });
  }

  if (totpCancel) {
    totpCancel.addEventListener("click", function () {
      backToPassword("");
    });
  }

  function showTotpStep() {
    stopCountdown();
    setTotpBusy(false);
    form.hidden = true;
    if (totpForm) totpForm.hidden = false;
    paintGithub();
    hideTotpError();
    if (totpCode) {
      totpCode.value = "";
      totpCode.focus();
    }
  }

  function backToPassword(message) {
    stopCountdown();
    setTotpBusy(false);
    ticket = "";
    if (totpForm) totpForm.hidden = true;
    if (totpCode) totpCode.value = "";
    hideTotpError();
    form.hidden = false;
    paintGithub();
    if (message) showError(message, "danger");
    else hideError();
    password.focus();
  }

  function probeGithub() {
    fetch("/api/v1/auth/config", {
      headers: { accept: "application/json" },
      cache: "no-store",
    })
      .then(function (response) {
        return readBody(response);
      })
      .then(function (data) {
        githubEnabled = !!(data && data.github_enabled === true);
        paintGithub();
      })
      .catch(function () {});
  }

  function paintGithub() {
    if (!githubBox) return;
    githubBox.hidden = !(githubEnabled && form && !form.hidden);
  }

  function githubErrorText(code) {
    if (code === "github_state") return "GitHub 登录已失效，请重新尝试";
    if (code === "github_forbidden") return "这个 GitHub 账号还没有绑定，无法登录";
    return "GitHub 登录失败，请稍后重试";
  }

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

  function explainTotp(status, value) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (status === 401) return "验证码或恢复码不正确";
    if (status === 429) return "尝试次数过多，请稍后再试";
    if (status === 403) return "请求被拒绝，请刷新页面后重试";
    return "登录失败，请稍后重试";
  }

  function retrySeconds(response, data) {
    var bodyValue = data && (data.retry_after != null ? data.retry_after : data.retryAfter);
    var fromBody = Number(bodyValue);
    if (Number.isFinite(fromBody) && fromBody > 0) return Math.min(Math.ceil(fromBody), 60 * 60);
    var header = Number(response.headers.get("retry-after"));
    if (Number.isFinite(header) && header > 0) return Math.min(Math.ceil(header), 60 * 60);
    return 60;
  }

  function startCountdown(seconds) {
    window.clearInterval(countdownTimer);
    countdownTimer = 0;
    lockedUntil = Date.now() + seconds * 1000;
    paintCountdown(seconds);
    countdownTimer = window.setInterval(function () {
      var left = Math.ceil((lockedUntil - Date.now()) / 1000);
      if (left <= 0) {
        stopCountdown();
        hideTotpError();
        setTotpBusy(false);
        if (totpCode) totpCode.focus();
        return;
      }
      paintCountdown(left);
    }, 1000);
  }

  function paintCountdown(seconds) {
    if (!totpSubmit) return;
    totpSubmit.disabled = true;
    totpSubmit.textContent = seconds + " 秒后可重试";
  }

  function stopCountdown() {
    window.clearInterval(countdownTimer);
    countdownTimer = 0;
    lockedUntil = 0;
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

  function showTotpError(message) {
    if (!totpError) return;
    totpError.className = "callout danger";
    totpError.textContent = message;
    totpError.hidden = false;
  }

  function hideTotpError() {
    if (!totpError) return;
    totpError.hidden = true;
    totpError.textContent = "";
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

  function setTotpBusy(busy) {
    if (!totpSubmit || !totpCode) return;
    var locked = Date.now() < lockedUntil;
    totpSubmit.disabled = busy || locked;
    totpCode.disabled = busy;
    if (busy) totpSubmit.textContent = "验证中…";
    else if (!locked) totpSubmit.textContent = "验证并登录";
  }
})();
