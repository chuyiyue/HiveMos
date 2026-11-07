/* 管理员账号、修改密码、两步验证、会话。数据来自 /api/account/* */
(function () {
  var C = window.HiveCommon;
  var state = {
    loading: true,
    loadError: "",
    profile: null,
    profileInput: "",
    profileError: "",
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
    passwordError: "",
    revealPassword: false,
    totp: null,
    totpError: "",
    totpPanel: "",
    totpSecret: "",
    totpUri: "",
    totpCode: "",
    totpPassword: "",
    recoveryCodes: [],
    sessions: [],
    sessionsError: "",
    pinLimitInput: "",
    pinLimitError: "",
    busy: false,
    focus: "",
    focusSelect: false,
  };
  var loadToken = 0;
  var totpToken = 0;
  var bound = false;

  function passwordScore(password) {
    var value = String(password || "");
    var score = 0;
    if (value.length >= 8) score += 1;
    if (value.length >= 12) score += 1;
    if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
    if (/\d/.test(value) && /[^A-Za-z0-9]/.test(value)) score += 1;
    return Math.min(4, score);
  }

  function strengthText(value, score) {
    if (!value) return "";
    if (score <= 0) return "太短";
    if (score === 1) return "较弱";
    if (score === 2) return "一般";
    if (score === 3) return "较强";
    return "很强";
  }

  function generatePassword() {
    var alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
    var bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    var value = "";
    for (var i = 0; i < bytes.length; i += 1) value += alphabet[bytes[i] % alphabet.length];
    return value;
  }

  function renderSecret(secret) {
    return String(secret || "").replace(/(.{4})/g, "$1 ").trim();
  }

  function api(method, url, body) {
    var headers = { accept: "application/json" };
    var options = { method: method, headers: headers, cache: "no-store" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return fetch(url, options).then(
      function (response) {
        return response.json().then(
          function (data) {
            return { status: response.status, data: data && typeof data === "object" ? data : {} };
          },
          function () {
            return { status: response.status, data: {} };
          },
        );
      },
      function () {
        return { status: 0, data: {} };
      },
    );
  }

  function loggedOut(result) {
    if (!result || result.status !== 401) return false;
    var message = result.data && typeof result.data.error === "string" ? result.data.error : "";
    if (message && message !== "未登录") return false;
    location.assign("/login.html");
    return true;
  }

  function fieldValue(name) {
    var node = document.querySelector('[data-field="' + name + '"]');
    if (node && "value" in node) state[name] = node.value;
    return state[name] || "";
  }

  function button(label, action, variant, disabled) {
    var cls = variant ? ' class="' + variant + '"' : "";
    return (
      '<button type="button"' +
      cls +
      ' data-action="' +
      action +
      '"' +
      (disabled || state.busy ? " disabled" : "") +
      ">" +
      C.escapeHtml(label) +
      "</button>"
    );
  }

  function fieldError(id, message, cls) {
    var className = cls || "field-error";
    if (!message) return '<p id="' + id + '" class="' + className + '" hidden></p>';
    return '<p id="' + id + '" class="' + className + '" role="alert">' + C.escapeHtml(message) + "</p>";
  }

  function roleText(role) {
    if (role === "member") return "成员";
    return "管理员";
  }

  function displayName(profileUsername, loginName) {
    var nick = String(profileUsername || "").trim();
    if (nick) return nick;
    var login = String(loginName || "").trim();
    return login || "管理员";
  }

  function paintSidebar(name) {
    var nameEl = document.querySelector(".account-name");
    var avatar = document.querySelector(".account-avatar");
    var accountBtn = document.querySelector(".account-btn");
    if (nameEl) nameEl.textContent = name;
    if (avatar) {
      var value = String(name || "").trim();
      avatar.textContent = value ? Array.from(value)[0].toUpperCase() : "管";
    }
    if (accountBtn) {
      var title = name + " · 设置";
      accountBtn.title = title;
      accountBtn.setAttribute("aria-label", title);
    }
  }

  function toast(message) {
    var text = String(message || "").trim();
    if (!text) return;
    var root = document.getElementById("toasts");
    if (!root) {
      root = document.createElement("div");
      root.id = "toasts";
      root.className = "toasts";
      document.body.append(root);
    }
    while (root.children.length >= 3) root.removeChild(root.firstChild);
    var item = document.createElement("div");
    item.className = "toast";
    item.setAttribute("role", "status");
    item.textContent = text;
    root.append(item);
    window.setTimeout(function () {
      item.remove();
    }, 2800);
  }

  function accountSection() {
    var profile = state.profile || {};
    var created = C.formatMinute(profile.created_at) || "未知";
    var form =
      '<form id="profile-form" class="form-grid" novalidate><label>展示用户名' +
      '<input data-field="profileInput" name="username" type="text" maxlength="39" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="例如 octocat，可留空" value="' +
      C.escapeHtml(state.profileInput) +
      '" />' +
      '<p class="subtle field-hint">只显示在侧栏，不用于登录，留空则清除</p></label>' +
      fieldError("profile-error", state.profileError) +
      '<div class="row-actions"><button type="submit"' +
      (state.busy ? " disabled" : "") +
      ">保存</button></div></form>" +
      C.facts([
        ["登录用户名", C.escapeHtml(profile.username || "未知")],
        ["角色", C.escapeHtml(roleText(profile.role))],
        ["创建时间", C.escapeHtml(created)],
      ]);
    return C.section("管理员账号", "", form);
  }

  function passwordSection() {
    var score = passwordScore(state.newPassword);
    var type = state.revealPassword ? "text" : "password";
    var form =
      '<form id="password-form" class="form-grid" novalidate>' +
      "<label>当前密码" +
      '<input data-field="currentPassword" name="currentPassword" type="password" maxlength="256" autocomplete="current-password" value="' +
      C.escapeHtml(state.currentPassword) +
      '" /></label>' +
      "<label>新密码" +
      '<input data-field="newPassword" name="newPassword" type="' +
      type +
      '" maxlength="256" autocomplete="new-password" value="' +
      C.escapeHtml(state.newPassword) +
      '" /></label>' +
      '<div id="password-strength" class="strength" data-score="' +
      score +
      '" aria-hidden="true"><i></i><i></i><i></i><i></i></div>' +
      '<p id="password-strength-label" class="strength-label">' +
      C.escapeHtml(strengthText(state.newPassword, score)) +
      "</p>" +
      "<label>确认新密码" +
      '<input data-field="confirmPassword" name="confirmPassword" type="' +
      type +
      '" maxlength="256" autocomplete="new-password" value="' +
      C.escapeHtml(state.confirmPassword) +
      '" /></label>' +
      '<div class="row-actions">' +
      button("生成强密码", "generate-password", "ghost") +
      "</div>" +
      fieldError("password-error", state.passwordError) +
      '<div class="row-actions"><button type="submit"' +
      (state.busy ? " disabled" : "") +
      ">保存密码</button></div></form>";
    return C.section("修改密码", "8–256 位，保存后需重新登录", form);
  }

  function totpStateText(status) {
    if (!status) return "正在读取两步验证状态";
    if (status.enabled) {
      var since = Number(status.enabled_at);
      var when = Number.isFinite(since) && since > 0 ? C.formatMinute(since) : "";
      if (when) return "已启用，" + when + "开始生效。登录时需要验证器上的 6 位码或一个恢复码";
      return "已启用。登录时需要验证器上的 6 位码或一个恢复码";
    }
    if (status.pending) return "上一次绑定还没确认，请重新开始并输入验证器上的验证码";
    return "未启用。启用后，登录还需要验证器上的一次性验证码";
  }

  function totpExtra(status) {
    if (!status) return null;
    if (status.enabled) {
      var remaining = Number(status.recovery_codes_remaining) || 0;
      if (remaining > 0) return { text: "剩余恢复码 " + remaining + " 个，每个只能用一次", warn: false };
      return { text: "恢复码已用完，请重新生成，或关闭两步验证后重新绑定", warn: true };
    }
    if (status.pending && Number(status.pending_expires_at) > Date.now()) {
      var when = C.formatMinute(status.pending_expires_at);
      if (when) return { text: "待确认的绑定会在 " + when + " 过期", warn: false };
    }
    return null;
  }

  function secretLine(secret) {
    return (
      '<div class="copy-line"><code>' +
      C.escapeHtml(renderSecret(secret)) +
      '</code><button type="button" class="copy-btn" data-copy="' +
      C.escapeHtml(secret) +
      '" data-label="复制密钥">复制密钥</button></div>'
    );
  }

  function codesBlock() {
    return (
      '<div class="inline-panel"><h3>保存恢复码</h3>' +
      '<p class="subtle">每个恢复码只能使用一次。关闭后无法再次查看</p>' +
      '<p class="callout warn">恢复码只显示这一次。请保存到安全的地方；每个码只能用一次</p>' +
      '<pre class="recovery-codes">' +
      C.escapeHtml(state.recoveryCodes.join("\n")) +
      "</pre>" +
      '<div class="row-actions"><button type="button" class="ghost copy-btn" data-copy="' +
      C.escapeHtml(state.recoveryCodes.join("\n")) +
      '" data-label="复制恢复码">复制恢复码</button>' +
      button("完成", "totp-done") +
      "</div></div>"
    );
  }

  function factorPanel(title, text, confirmLabel) {
    return (
      '<div class="inline-panel"><h3>' +
      C.escapeHtml(title) +
      '</h3><p class="subtle">' +
      C.escapeHtml(text) +
      "</p>" +
      "<label>当前密码" +
      '<input data-field="totpPassword" type="password" autocomplete="current-password" maxlength="256" value="' +
      C.escapeHtml(state.totpPassword) +
      '" /></label>' +
      "<label>验证码或恢复码" +
      '<input data-field="totpCode" autocomplete="one-time-code" maxlength="24" value="' +
      C.escapeHtml(state.totpCode) +
      '" /></label>' +
      fieldError("totp-error", state.totpError) +
      '<div class="row-actions">' +
      button(confirmLabel, "totp-submit") +
      button("取消", "totp-cancel", "secondary") +
      "</div></div>"
    );
  }

  function totpPanelBody() {
    if (state.totpPanel === "codes") return codesBlock();
    if (state.totpPanel === "setup") {
      return (
        '<div class="inline-panel"><p class="subtle">在身份验证器里添加账户，然后输入它显示的 6 位验证码。若无法扫码，请手动输入下面的密钥</p>' +
        '<p class="subtle">密钥</p>' +
        secretLine(state.totpSecret) +
        '<p class="subtle">或使用这个链接添加账户</p>' +
        C.copyLine(state.totpUri, "复制链接") +
        "<label>验证码" +
        '<input data-field="totpCode" inputmode="numeric" autocomplete="one-time-code" maxlength="24" value="' +
        C.escapeHtml(state.totpCode) +
        '" /></label>' +
        fieldError("totp-error", state.totpError) +
        '<div class="row-actions">' +
        button("确认并启用", "totp-enable") +
        button("取消", "totp-cancel", "secondary") +
        "</div></div>"
      );
    }
    if (state.totpPanel === "disable") {
      return factorPanel("关闭两步验证", "需要当前密码，再加一个验证器验证码或未使用的恢复码", "关闭两步验证");
    }
    if (state.totpPanel === "recovery") {
      return factorPanel(
        "重新生成恢复码",
        "需要当前密码，再加一个验证器验证码或未使用的恢复码。旧恢复码会立即作废",
        "生成新的恢复码",
      );
    }
    return "";
  }

  function totpSection() {
    var status = state.totp;
    var extra = totpExtra(status);
    var actions = "";
    if (status && state.totpPanel !== "codes") {
      if (status.enabled) {
        actions = button("重新生成恢复码", "totp-recovery", "secondary") + button("关闭两步验证", "totp-disable", "secondary");
      } else {
        actions = button(status.pending ? "重新开始绑定" : "启用两步验证", "totp-setup");
      }
    }
    var error = state.totpPanel ? "" : fieldError("totp-error", state.totpError, "callout danger");
    var body =
      '<p class="subtle">' +
      C.escapeHtml(totpStateText(status)) +
      "</p>" +
      (extra ? '<p class="' + (extra.warn ? "callout warn" : "subtle") + '">' + C.escapeHtml(extra.text) + "</p>" : "") +
      error +
      (actions ? '<div class="row-actions">' + actions + "</div>" : "") +
      totpPanelBody();
    return C.section("两步验证", "", body);
  }

  function deviceText(value) {
    if (typeof value !== "string") return "未知设备";
    var text = value.trim();
    return text || "未知设备";
  }

  function sessionWhen(session) {
    var created = C.formatMinute(session.created_at);
    var expires = C.formatMinute(session.expires_at);
    var parts = [];
    if (created) parts.push("登录于 " + created);
    if (expires) parts.push("有效期至 " + expires);
    return parts.length ? parts.join(" · ") : "会话时间未知";
  }

  function sessionRow(session) {
    var current = session.current === true;
    var id = String(session.id || "");
    return (
      '<article class="session-row' +
      (current ? " is-current" : "") +
      '"><div class="session-main"><div class="session-title"><h3>' +
      C.escapeHtml(current ? "当前会话" : "登录会话") +
      "</h3>" +
      (current ? C.badge("当前", "accent") : "") +
      '</div><p class="subtle">' +
      C.escapeHtml(deviceText(session.user_agent)) +
      '</p><p class="subtle">' +
      C.escapeHtml(sessionWhen(session)) +
      "</p></div>" +
      '<button type="button" class="' +
      (current ? "danger" : "secondary") +
      '" data-action="revoke-session" data-id="' +
      C.escapeHtml(id) +
      '">' +
      (current ? "退出此会话" : "撤销") +
      '</button><div class="confirm-slot" data-confirm-for="' +
      C.escapeHtml(id) +
      '"></div></article>'
    );
  }

  function sessionsSection() {
    var others = state.sessions.some(function (item) {
      return !item.current;
    });
    var actions =
      '<button type="button" class="ghost" data-action="refresh-sessions"' +
      (state.busy ? " disabled" : "") +
      ">刷新</button>" +
      '<button type="button" class="secondary" data-action="revoke-others"' +
      (!others || state.busy ? " disabled" : "") +
      ">撤销其它会话</button>";
    var list = state.sessions.length
      ? C.list(state.sessions.map(sessionRow).join(""))
      : C.emptyState("没有有效的登录会话", "登录后的会话会列在这里");
    var error = state.sessionsError
      ? '<p class="callout danger" role="alert">' + C.escapeHtml(state.sessionsError) + "</p>"
      : "";
    return C.section("会话管理", "", '<div class="confirm-slot" data-confirm-for="revoke-others"></div>' + error + list, actions);
  }

  function sidebarSection() {
    var form =
      '<form id="sidebar-form" class="form-grid" novalidate>' +
      '<label>展示上限<input data-field="pinLimitInput" name="pinLimitInput" type="number" min="1" max="20" step="1" inputmode="numeric" value="' +
      C.escapeHtml(state.pinLimitInput) +
      '" /><p class="subtle field-hint">侧边栏最多展示的 Agent 数量，固定的包含在内，范围 1–20</p></label>' +
      fieldError("pin-limit-error", state.pinLimitError) +
      '<div class="row-actions"><button type="submit"' +
      (state.busy ? " disabled" : "") +
      ">保存</button></div></form>";
    return C.section("侧边栏", "", form);
  }

  function submitPinLimit() {
    var parsed = Number(fieldValue("pinLimitInput"));
    state.busy = true;
    state.pinLimitError = "";
    render();
    api("PATCH", "/api/account/preferences", { sidebar_pin_limit: parsed }).then(function (result) {
      state.busy = false;
      if (!result.data || result.data.ok !== true || !result.data.preferences) {
        fail('[data-field="pinLimitInput"]', "pinLimitError", result, "保存失败，请重试");
        return;
      }
      state.pinLimitInput = String(result.data.preferences.sidebar_pin_limit);
      state.pinLimitError = "";
      render();
      window.dispatchEvent(new CustomEvent("hivemos:sidebar-refresh"));
      toast("侧边栏上限已保存");
    });
  }

  function render() {
    var active = document.activeElement;
    var activeField = active && active.getAttribute ? active.getAttribute("data-field") : "";
    var selectionStart = active && typeof active.selectionStart === "number" ? active.selectionStart : null;
    var html = "";
    if (state.loading) html = C.emptyState("正在读取", "稍等片刻");
    else if (state.loadError) {
      html =
        C.emptyState("没有读到账号", state.loadError) +
        '<div class="row-actions"><button type="button" data-action="reload">重试</button></div>';
    } else {
      html =
        '<div class="stack">' +
        accountSection() +
        passwordSection() +
        totpSection() +
        sessionsSection() +
        sidebarSection() +
        "</div>";
    }
    C.mount(C.layout("管理员账号、两步验证与登录会话", html));
    bind();
    var focusSelector = state.focus;
    state.focus = "";
    if (focusSelector) {
      var chosen = document.querySelector(focusSelector);
      if (chosen && chosen.focus) {
        chosen.focus();
        if (state.focusSelect && chosen.select) chosen.select();
      }
      state.focusSelect = false;
      return;
    }
    state.focusSelect = false;
    if (!activeField) return;
    var again = document.querySelector('[data-field="' + activeField + '"]');
    if (!again || !again.focus) return;
    again.focus();
    if (selectionStart != null && again.setSelectionRange) {
      var pos = Math.min(selectionStart, again.value.length);
      again.setSelectionRange(pos, pos);
    }
  }

  function bind() {
    var page = document.getElementById("page");
    if (!page || bound) return;
    bound = true;
    page.addEventListener("input", onInput);
    page.addEventListener("click", onClick);
    page.addEventListener("submit", onSubmit);
  }

  function onInput(event) {
    var target = event.target;
    if (!(target instanceof HTMLElement)) return;
    var field = target.getAttribute("data-field");
    if (!field || !Object.prototype.hasOwnProperty.call(state, field)) return;
    state[field] = target.value;
    if (field === "newPassword") paintStrength(target.value);
    if (field === "profileInput") clearNote("profile-error", "profileError");
    if (field === "currentPassword" || field === "newPassword" || field === "confirmPassword") {
      clearNote("password-error", "passwordError");
    }
    if (field === "totpCode" || field === "totpPassword") clearNote("totp-error", "totpError");
    if (field === "pinLimitInput") clearNote("pin-limit-error", "pinLimitError");
  }

  function clearNote(id, key) {
    state[key] = "";
    var node = document.getElementById(id);
    if (!node) return;
    node.hidden = true;
    node.textContent = "";
  }

  function paintStrength(value) {
    var score = passwordScore(value);
    var bar = document.getElementById("password-strength");
    var label = document.getElementById("password-strength-label");
    if (bar) bar.setAttribute("data-score", String(score));
    if (label) label.textContent = strengthText(value, score);
  }

  function onClick(event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".confirm-panel") || target.closest("[data-copy]")) return;
    var control = target.closest("[data-action]");
    if (!control || state.busy) return;
    var action = control.getAttribute("data-action");
    if (action === "reload") load();
    else if (action === "generate-password") fillGenerated();
    else if (action === "totp-setup") beginSetup();
    else if (action === "totp-enable") enableTotp();
    else if (action === "totp-disable") openFactor("disable");
    else if (action === "totp-recovery") openFactor("recovery");
    else if (action === "totp-submit") submitFactor();
    else if (action === "totp-cancel" || action === "totp-done") closeTotpPanel();
    else if (action === "refresh-sessions") reloadSessions();
    else if (action === "revoke-session") revokeSession(control.getAttribute("data-id") || "");
    else if (action === "revoke-others") revokeOthers(control);
  }

  function onSubmit(event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    if (state.busy) return;
    if (form.id === "profile-form") submitProfile();
    else if (form.id === "password-form") submitPassword();
    else if (form.id === "sidebar-form") submitPinLimit();
  }

  function fail(slot, key, result, fallback) {
    state.busy = false;
    if (loggedOut(result)) return;
    var message = result.status === 0 ? "网络异常，请重试" : C.explain(result.data && result.data.error, fallback);
    state[key] = message;
    state.focus = slot;
    render();
  }

  function submitProfile() {
    var username = fieldValue("profileInput").trim();
    state.profileInput = username;
    state.profileError = "";
    state.busy = true;
    render();
    api("POST", "/api/account/profile", { username: username }).then(function (result) {
      state.busy = false;
      if (!result.data || result.data.ok !== true) {
        fail('[data-field="profileInput"]', "profileError", result, "保存用户名失败，请重试");
        return;
      }
      var saved = typeof result.data.profile_username === "string" ? result.data.profile_username : username;
      state.profileInput = saved;
      if (!state.profile) state.profile = {};
      state.profile.profile_username = saved;
      state.profileError = "";
      paintSidebar(displayName(saved, state.profile.username));
      toast(saved ? "用户名已保存" : "用户名已清除");
      render();
    });
  }

  function submitPassword() {
    var current = fieldValue("currentPassword");
    var next = fieldValue("newPassword");
    var again = fieldValue("confirmPassword");
    var message = "";
    var focus = "";
    if (!current) {
      message = "请填写当前密码";
      focus = '[data-field="currentPassword"]';
    } else if (current.length > 256) {
      message = "当前密码需要 1 到 256 个字符";
      focus = '[data-field="currentPassword"]';
    } else if (!next) {
      message = "请填写新密码";
      focus = '[data-field="newPassword"]';
    } else if (next.length < 8 || next.length > 256) {
      message = "新密码需要 8 到 256 个字符";
      focus = '[data-field="newPassword"]';
    } else if (next !== again) {
      message = "两次输入的新密码不一致";
      focus = '[data-field="confirmPassword"]';
    } else if (next === current) {
      message = "新密码不能与当前密码相同";
      focus = '[data-field="newPassword"]';
    }
    if (message) {
      state.passwordError = message;
      state.focus = focus;
      render();
      return;
    }
    state.passwordError = "";
    state.busy = true;
    render();
    api("POST", "/api/account/password", { currentPassword: current, newPassword: next }).then(function (result) {
      if (result.data && result.data.ok === true) {
        toast("密码已更新，请用新密码重新登录");
        window.setTimeout(function () {
          location.assign("/login.html");
        }, 600);
        return;
      }
      fail('[data-field="currentPassword"]', "passwordError", result, "改密码失败，请重试");
    });
  }

  function fillGenerated() {
    var value = generatePassword();
    state.newPassword = value;
    state.confirmPassword = value;
    state.revealPassword = true;
    state.passwordError = "";
    state.focus = '[data-field="newPassword"]';
    state.focusSelect = true;
    render();
  }

  function closeTotpPanel() {
    state.totpPanel = "";
    state.totpError = "";
    state.totpCode = "";
    state.totpPassword = "";
    state.totpSecret = "";
    state.totpUri = "";
    state.recoveryCodes = [];
    render();
  }

  function openFactor(mode) {
    state.totpPanel = mode;
    state.totpError = "";
    state.totpCode = "";
    state.totpPassword = "";
    state.totpSecret = "";
    state.totpUri = "";
    state.recoveryCodes = [];
    state.focus = '[data-field="totpPassword"]';
    render();
  }

  function beginSetup() {
    state.busy = true;
    state.totpError = "";
    render();
    api("POST", "/api/account/totp/setup", {}).then(function (result) {
      state.busy = false;
      if (!result.data || result.data.ok !== true) {
        fail("", "totpError", result, "无法开始绑定，请重试");
        return;
      }
      state.totpPanel = "setup";
      state.totpSecret = String(result.data.secret || "");
      state.totpUri = String(result.data.otpauth_uri || "");
      state.totpCode = "";
      state.totpPassword = "";
      state.recoveryCodes = [];
      state.totpError = "";
      state.focus = '[data-field="totpCode"]';
      if (state.totp) {
        state.totp.pending = true;
        if (result.data.pending_expires_at) state.totp.pending_expires_at = result.data.pending_expires_at;
      }
      render();
      refreshTotp();
    });
  }

  function enableTotp() {
    var code = fieldValue("totpCode").trim();
    state.totpCode = code;
    if (!code) {
      state.totpError = "请输入验证器上的 6 位验证码";
      state.focus = '[data-field="totpCode"]';
      render();
      return;
    }
    state.busy = true;
    state.totpError = "";
    render();
    api("POST", "/api/account/totp/enable", { code: code }).then(function (result) {
      state.busy = false;
      if (!result.data || result.data.ok !== true) {
        fail('[data-field="totpCode"]', "totpError", result, "无法启用两步验证，请重试");
        return;
      }
      showCodes(result.data.recovery_codes);
    });
  }

  function submitFactor() {
    var passwordValue = fieldValue("totpPassword");
    var code = fieldValue("totpCode").trim();
    state.totpCode = code;
    if (!passwordValue) {
      state.totpError = "请填写当前密码";
      state.focus = '[data-field="totpPassword"]';
      render();
      return;
    }
    if (!code) {
      state.totpError = "请输入验证码或恢复码";
      state.focus = '[data-field="totpCode"]';
      render();
      return;
    }
    var path = state.totpPanel === "disable" ? "/api/account/totp/disable" : "/api/account/totp/recovery";
    state.busy = true;
    state.totpError = "";
    render();
    api("POST", path, { password: passwordValue, code: code }).then(function (result) {
      state.busy = false;
      if (!result.data || result.data.ok !== true) {
        fail('[data-field="totpCode"]', "totpError", result, "操作失败，请重试");
        return;
      }
      if (state.totpPanel === "disable") {
        state.totpPanel = "";
        state.totpPassword = "";
        state.totpCode = "";
        state.totpError = "";
        if (state.totp) {
          state.totp.enabled = false;
          state.totp.pending = false;
          state.totp.recovery_codes_remaining = 0;
        }
        toast("两步验证已关闭");
        refreshTotp();
        return;
      }
      showCodes(result.data.recovery_codes);
    });
  }

  function showCodes(codes) {
    state.recoveryCodes = Array.isArray(codes) ? codes.map(function (item) { return String(item); }) : [];
    state.totpPanel = "codes";
    state.totpSecret = "";
    state.totpUri = "";
    state.totpCode = "";
    state.totpPassword = "";
    state.totpError = "";
    if (state.totp) state.totp.enabled = true;
    render();
    refreshTotp();
  }

  function refreshTotp() {
    var token = (totpToken += 1);
    api("GET", "/api/account/totp").then(function (result) {
      if (token !== totpToken) return;
      if (loggedOut(result)) return;
      if (result.data && result.data.ok === true) state.totp = result.data;
      render();
    });
  }

  function anchorFor(id) {
    var value = window.CSS && CSS.escape ? CSS.escape(id) : String(id).replace(/"/g, "");
    return document.querySelector('[data-confirm-for="' + value + '"]');
  }

  function revokeSession(id) {
    var session = null;
    for (var i = 0; i < state.sessions.length; i += 1) {
      if (state.sessions[i].id === id) session = state.sessions[i];
    }
    if (!session) return;
    var current = session.current === true;
    C.askConfirm({
      anchor: anchorFor(id),
      title: current ? "退出当前会话？" : "撤销这个会话？",
      text: current ? "退出当前会话？撤销后这个浏览器需要重新登录" : "撤销这个会话？撤销后，对应浏览器需要重新登录",
      confirmLabel: current ? "退出" : "撤销",
      danger: true,
    }).then(function (yes) {
      if (!yes) return;
      state.busy = true;
      render();
      api("DELETE", "/api/account/sessions/" + encodeURIComponent(id)).then(function (result) {
        if (result.data && result.data.ok === true) {
          if (current) {
            toast("当前会话已撤销，请重新登录");
            window.setTimeout(function () {
              location.assign("/login.html");
            }, 600);
            return;
          }
          toast("已撤销这个会话");
          reloadSessions();
          return;
        }
        state.busy = false;
        if (loggedOut(result)) return;
        state.sessionsError = result.status === 0 ? "网络异常，请重试" : C.explain(result.data && result.data.error, "撤销会话失败，请重试");
        render();
      });
    });
  }

  function revokeOthers(control) {
    if (
      !state.sessions.some(function (item) {
        return !item.current;
      })
    ) {
      return;
    }
    C.askConfirm({
      anchor: anchorFor("revoke-others") || control.parentNode,
      title: "撤销其它会话？",
      text: "撤销其它会话？当前会话会保留，其它浏览器需要重新登录",
      confirmLabel: "撤销其它会话",
      danger: true,
    }).then(function (yes) {
      if (!yes) return;
      state.busy = true;
      state.sessionsError = "";
      render();
      api("POST", "/api/account/sessions/revoke-others", {}).then(function (result) {
        if (!result.data || result.data.ok !== true) {
          state.busy = false;
          if (loggedOut(result)) return;
          state.sessionsError = result.status === 0 ? "网络异常，请重试" : C.explain(result.data && result.data.error, "撤销其它会话失败，请重试");
          render();
          return;
        }
        toast("已撤销其它会话");
        reloadSessions();
      });
    });
  }

  function reloadSessions() {
    state.busy = true;
    state.sessionsError = "";
    render();
    api("GET", "/api/account/sessions").then(function (result) {
      state.busy = false;
      if (result.status === 401) {
        location.assign("/login.html");
        return;
      }
      if (!result.data || result.data.ok !== true) {
        state.sessionsError = result.status === 0 ? "网络异常，请重试" : C.explain(result.data && result.data.error, "加载会话失败，请重试");
        render();
        return;
      }
      state.sessions = Array.isArray(result.data.sessions) ? result.data.sessions : [];
      state.sessionsError = "";
      render();
    });
  }

  function load() {
    var token = (loadToken += 1);
    state.loading = true;
    state.loadError = "";
    render();
    Promise.all([
      api("GET", "/api/account/profile"),
      api("GET", "/api/account/totp"),
      api("GET", "/api/account/sessions"),
      api("GET", "/api/account/preferences"),
    ]).then(
      function (results) {
        if (token !== loadToken) return;
        if (
          results.some(function (item) {
            return item.status === 401;
          })
        ) {
          location.assign("/login.html");
          return;
        }
        var profile = results[0];
        var totp = results[1];
        var sessions = results[2];
        var preferences = results[3];
        if (preferences.data && preferences.data.ok === true && preferences.data.preferences) {
          state.pinLimitInput = String(preferences.data.preferences.sidebar_pin_limit);
        } else if (!state.pinLimitInput) {
          state.pinLimitInput = "5";
        }
        var failed = [profile, totp, sessions].filter(function (item) {
          return !item.data || item.data.ok !== true;
        })[0];
        state.loading = false;
        if (failed) {
          state.loadError =
            failed.status === 0 ? "网络异常，请重试" : C.explain(failed.data && failed.data.error, "没有读到账号，请重试");
          render();
          return;
        }
        state.profile = profile.data;
        if (!state.profileInput) state.profileInput = profile.data.profile_username || "";
        state.totp = totp.data;
        state.sessions = Array.isArray(sessions.data.sessions) ? sessions.data.sessions : [];
        state.loadError = "";
        render();
      },
    );
  }

  load();
})();
