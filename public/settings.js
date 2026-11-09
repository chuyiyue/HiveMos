/* 管理员账号、两步验证、会话管理、功能设置、系统信息。
   版式照 SMSinBox /users：页内设置导航 + 分区面板。数据来自 /api/account/*、
   /api/settings 与 /api/system/info；定时任务频率与侧边栏自动展示上限都在
   /api/settings 这一处读写 */
(function () {
  var C = window.HiveCommon;
  var state = {
    loading: true,
    loadError: "",
    accountError: "",
    accountStatus: "",
    system: null,
    systemError: "",
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
    cronInterval: 6,
    savedCronInterval: 6,
    savedPinLimit: 5,
    featuresError: "",
    backup: null,
    backupError: "",
    backupSeeded: false,
    backupTab: "github",
    ghOwner: "",
    ghRepo: "",
    ghBranch: "",
    ghPath: "",
    ghToken: "",
    wdBase: "",
    wdUser: "",
    wdDir: "",
    wdPass: "",
    backupAuto: false,
    savedBackupAuto: false,
    backupTarget: "",
    savedBackupTarget: "",
    backupScheduleError: "",
    backupTest: {
      github: { ok: false, message: "", visibility: "", signature: "" },
      webdav: { ok: false, message: "", visibility: "", signature: "" },
    },
    busy: false,
    focus: "",
    focusSelect: false,
  };
  var loadToken = 0;
  var totpToken = 0;
  var bound = false;

  var CRON_INTERVAL_OPTIONS = [
    { hours: 1, label: "每小时" },
    { hours: 3, label: "每 3 小时" },
    { hours: 6, label: "每 6 小时" },
    { hours: 12, label: "每 12 小时" },
    { hours: 24, label: "每天" },
  ];

  function cronIntervalLabel(hours) {
    var value = Number(hours);
    for (var i = 0; i < CRON_INTERVAL_OPTIONS.length; i += 1) {
      if (CRON_INTERVAL_OPTIONS[i].hours === value) return CRON_INTERVAL_OPTIONS[i].label;
    }
    return "每 6 小时";
  }

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

  function panel(id, title, body) {
    return (
      '<section id="' +
      id +
      '" class="settings-section panel stack" aria-labelledby="' +
      id +
      '-title"><h2 id="' +
      id +
      '-title">' +
      C.escapeHtml(title) +
      "</h2>" +
      body +
      "</section>"
    );
  }

  function accountCallouts() {
    var html = "";
    if (state.accountError) {
      html += '<p class="callout danger" role="alert">' + C.escapeHtml(state.accountError) + "</p>";
    }
    if (state.accountStatus) {
      html += '<p class="callout ok">' + C.escapeHtml(state.accountStatus) + "</p>";
    }
    return html;
  }

  function accountPanel() {
    var profile = state.profile || {};
    var created = C.formatMinute(profile.created_at) || "未知";
    var profileForm =
      '<form id="profile-form" class="stack" novalidate><h3>用户名</h3>' +
      "<label>GitHub 用户名" +
      '<input data-field="profileInput" name="username" type="text" maxlength="39" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="例如 octocat，可留空" value="' +
      C.escapeHtml(state.profileInput) +
      '" />' +
      '<p class="subtle field-hint">仅用于显示，不用于登录；留空则清除</p></label>' +
      fieldError("profile-error", state.profileError) +
      '<div class="row-actions"><button type="submit"' +
      (state.busy ? " disabled" : "") +
      ">保存用户名</button></div></form>" +
      C.facts([
        ["登录用户名", C.escapeHtml(profile.username || "未知")],
        ["角色", C.escapeHtml(roleText(profile.role))],
        ["创建时间", C.escapeHtml(created)],
      ]);
    return panel(
      "account-panel",
      "管理员账号",
      accountCallouts() +
        '<div class="account-cols"><div class="stack account-col">' +
        profileForm +
        '</div><div class="stack account-col">' +
        totpPanel() +
        passwordForm() +
        "</div></div>",
    );
  }

  function passwordForm() {
    var score = passwordScore(state.newPassword);
    var type = state.revealPassword ? "text" : "password";
    return (
      '<form id="password-form" class="stack" novalidate hidden><h3>改密码</h3>' +
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
      '<p class="subtle">8–256 位；保存后需重新登录</p>' +
      fieldError("password-error", state.passwordError) +
      '<div class="row-actions"><button type="submit"' +
      (state.busy ? " disabled" : "") +
      ">保存密码</button>" +
      button("退出登录", "logout", "secondary") +
      "</div></form>"
    );
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
      "</h3>" +
      (text ? '<p class="subtle">' + C.escapeHtml(text) + "</p>" : "") +
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
        '<div class="inline-panel"><p class="subtle">在身份验证器里添加账户，然后输入它显示的 6 位验证码</p>' +
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
      return factorPanel("关闭两步验证", "", "关闭两步验证");
    }
    if (state.totpPanel === "recovery") {
      return factorPanel(
        "重新生成恢复码",
        "旧恢复码会立即作废",
        "生成新的恢复码",
      );
    }
    return "";
  }

  function totpPanel() {
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
    return '<div class="stack" id="totp-panel"><h3>两步验证</h3>' + body + "</div>";
  }

  function deviceText(value) {
    if (typeof value !== "string" || !value.trim()) return "未知设备";
    var ua = value;
    var os = /Windows NT/.test(ua)
      ? "Windows"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad|iPod/.test(ua)
          ? "iOS"
          : /Mac OS X/.test(ua)
            ? "macOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
    var m = ua.match(/Edg\/(\d+)/);
    var browser = m ? "Edge " + m[1] : "";
    if (!browser) {
      m = ua.match(/Chrome\/(\d+)/);
      if (m) browser = "Chrome " + m[1];
    }
    if (!browser) {
      m = ua.match(/Firefox\/(\d+)/);
      if (m) browser = "Firefox " + m[1];
    }
    if (!browser && /Safari\//.test(ua)) {
      m = ua.match(/Version\/(\d+)/);
      browser = "Safari" + (m ? " " + m[1] : "");
    }
    if (!browser) {
      m = ua.match(/^([A-Za-z][\w-]*)\//);
      browser = m ? m[1] : "未知浏览器";
    }
    return (os ? os + " · " : "") + browser;
  }

  function parseDevice(value) {
    if (typeof value !== "string" || !value.trim()) {
      return { os: "未知", browser: "未知浏览器", type: "未知" };
    }
    var ua = value;
    var isTool = !/^Mozilla\//.test(ua);
    var os = /Windows NT/.test(ua)
      ? "Windows"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad|iPod/.test(ua)
          ? "iOS"
          : /Mac OS X/.test(ua)
            ? "macOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "未知";
    var m = ua.match(/Edg\/(\d+)/);
    var browser = m ? "Edge " + m[1] : "";
    if (!browser) {
      m = ua.match(/Chrome\/(\d+)/);
      if (m) browser = "Chrome " + m[1];
    }
    if (!browser) {
      m = ua.match(/Firefox\/(\d+)/);
      if (m) browser = "Firefox " + m[1];
    }
    if (!browser && /Safari\//.test(ua)) {
      m = ua.match(/Version\/(\d+)/);
      browser = "Safari" + (m ? " " + m[1] : "");
    }
    if (!browser) {
      m = ua.match(/^([A-Za-z][\w-]*)\//);
      browser = m ? m[1] : "未知浏览器";
    }
    var type = isTool
      ? "工具"
      : /iPad|Tablet/.test(ua)
        ? "平板"
        : /Android|iPhone|iPod|Mobile/.test(ua)
          ? "手机"
          : os === "未知"
            ? "未知"
            : "桌面设备";
    if (isTool) os = "未知";
    return { os: os, browser: browser, type: type };
  }

  function sessionMeta(session) {
    var d = parseDevice(session.user_agent);
    return [sessionWhen(session), d.browser, d.os, d.type, "IP " + (session.ip || "未记录")].join(" · ");
  }

  function sessionWhen(session) {
    var created = C.formatMinute(session.created_at);
    return created ? "登录于 " + created : "会话时间未知";
  }

  function sessionRow(session) {
    var current = session.current === true;
    var id = String(session.id || "");
    return (
      '<article class="session-row' +
      (current ? " is-current" : "") +
      '"><div class="session-main"><div class="session-title"><h3>' +
      (current ? "当前会话" : "登录会话") +
      "</h3>" +
      (current ? C.badge("当前", "accent") : "") +
      '</div><p class="subtle">' +
      C.escapeHtml(sessionMeta(session)) +
      "</p></div>" +
      '<button type="button" class="' +
      (current ? "secondary" : "ghost") +
      '" data-action="revoke-session" data-id="' +
      C.escapeHtml(id) +
      '">' +
      (current ? "退出此会话" : "撤销") +
      '</button><div class="confirm-slot" data-confirm-for="' +
      C.escapeHtml(id) +
      '"></div></article>'
    );
  }

  function sessionsPanel() {
    var others = state.sessions.some(function (item) {
      return !item.current;
    });
    var list = state.sessions.length
      ? C.list(state.sessions.map(sessionRow).join(""))
      : C.emptyState("没有有效的登录会话", "登录后的会话会列在这里");
    var error = state.sessionsError
      ? '<p class="callout danger" role="alert">' + C.escapeHtml(state.sessionsError) + "</p>"
      : "";
    var actions =
      '<div class="row-actions">' +
      '<button type="button" class="secondary" data-action="revoke-others"' +
      (!others || state.busy ? " disabled" : "") +
      ">撤销其它会话</button>" +
      '<button type="button" class="ghost" data-action="refresh-sessions"' +
      (state.busy ? " disabled" : "") +
      ">刷新列表</button></div>";
    return panel(
      "sessions-panel",
      "会话管理",
      '<div class="confirm-slot" data-confirm-for="revoke-others"></div>' + error + list + actions,
    );
  }

  function systemFactValue(render) {
    if (state.systemError) return "读取失败";
    if (!state.system) return "读取中…";
    return render(state.system);
  }

  function systemPanel() {
    function count(key) {
      return systemFactValue(function (s) {
        var value = s.counts ? s.counts[key] : null;
        return value === null || value === undefined ? "—" : String(value);
      });
    }
    var rows = [
      ["版本", systemFactValue(function (s) { return s.version ? C.escapeHtml(s.version) : "未知"; })],
      ["部署提交", systemFactValue(function (s) { return s.build_commit ? C.escapeHtml(s.build_commit) : "未知"; })],
      ["运行环境", "Cloudflare Workers + D1"],
      ["数据库", systemFactValue(function (s) { return C.escapeHtml(s.database_name || "未知"); })],
      ["自定义域", systemFactValue(function (s) { return C.escapeHtml(s.domain || "未知"); })],
      [
        "MCP 工具",
        systemFactValue(function (s) {
          return (s.mcp_tools === null || s.mcp_tools === undefined ? "—" : String(s.mcp_tools)) + " 个";
        }),
      ],
      ["Agent", count("agents")],
      ["MCP 服务", count("mcp_servers")],
      ["记忆", count("memories")],
      ["Soul", count("souls")],
      ["任务", count("tasks")],
      ["日历", count("calendars")],
      ["日程", count("events")],
      ["云主机", count("machines")],
      ["保险库条目", count("vault_entries")],
      ["登录会话", String(state.sessions.length)],
      [
        "定时任务",
        systemFactValue(function (s) {
          var cron = s.cron || {};
          var head =
            cronIntervalLabel(cron.interval_hours) +
            "执行（" +
            C.escapeHtml(cron.schedule || "0 * * * *") +
            "，每小时检查）";
          if (cron.last_run_at) {
            var when = C.formatMinute(cron.last_run_at) || "未知时间";
            return cron.active
              ? head + "，已生效，最近运行 " + C.escapeHtml(when)
              : head + "，最近运行 " + C.escapeHtml(when) + "，已超时未再运行";
          }
          return head + "，未生效：尚未观察到定时运行";
        }),
      ],
    ];
    var body =
      '<dl class="system-facts">' +
      rows
        .map(function (row) {
          return "<div><dt>" + C.escapeHtml(row[0]) + "</dt><dd>" + row[1] + "</dd></div>";
        })
        .join("") +
      "</dl>";
    return panel("system-panel", "系统信息", body);
  }

  function featureDirty() {
    if (state.loading) return false;
    // 按文本比对：非法或空值也算「有改动」，这样保存按钮可点、提交时给出校验提示
    var raw = String(state.pinLimitInput).trim();
    return state.cronInterval !== state.savedCronInterval || raw !== String(state.savedPinLimit);
  }

  function paintFeatureState() {
    var dirty = featureDirty();
    var save = document.querySelector('#features-form [type="submit"]');
    if (save) save.disabled = !dirty || state.busy;
    var hint = document.getElementById("features-dirty");
    if (hint) hint.hidden = !dirty;
  }

  function cronSegment() {
    return (
      '<div class="segmented" role="group" aria-label="定时任务频率">' +
      CRON_INTERVAL_OPTIONS.map(function (option) {
        return (
          '<button type="button" class="segment" data-action="set-cron-interval" data-hours="' +
          option.hours +
          '" aria-pressed="' +
          (state.cronInterval === option.hours ? "true" : "false") +
          '">' +
          C.escapeHtml(option.label) +
          "</button>"
        );
      }).join("") +
      "</div>"
    );
  }

  function featuresPanel() {
    var dirty = featureDirty();
    var body =
      '<form id="features-form" class="stack" novalidate>' +
      '<div class="feature-cols">' +
      '<div class="stack feature-item"><h3>定时任务频率</h3>' +
      '<p class="subtle">系统每小时检查一次，未到间隔不执行</p>' +
      cronSegment() +
      "</div>" +
      '<div class="stack feature-item"><h3>侧边栏自动展示上限</h3>' +
      '<p class="subtle">固定的 Agent 不受影响，范围 1 到 20</p>' +
      '<label>展示上限<input data-field="pinLimitInput" name="pinLimitInput" type="number" min="1" max="20" step="1" inputmode="numeric" value="' +
      C.escapeHtml(state.pinLimitInput) +
      '" /></label>' +
      "</div>" +
      "</div>" +
      fieldError("features-error", state.featuresError, "callout danger") +
      '<div class="row-actions"><button type="submit"' +
      (!dirty || state.busy ? " disabled" : "") +
      ">保存功能设置</button><span id=\"features-dirty\" class=\"subtle\"" +
      (dirty ? "" : " hidden") +
      ">有改动尚未保存</span></div>" +
      "</form>";
    return panel("features-panel", "功能设置", body);
  }

  function setCronInterval(control) {
    var hours = Number(control.getAttribute("data-hours"));
    var known = CRON_INTERVAL_OPTIONS.some(function (option) {
      return option.hours === hours;
    });
    if (!known) return;
    state.cronInterval = hours;
    state.featuresError = "";
    state.focus = '[data-action="set-cron-interval"][data-hours="' + hours + '"]';
    render();
  }

  function submitFeatures() {
    var raw = String(fieldValue("pinLimitInput")).trim();
    var limit = Number(raw);
    state.pinLimitInput = raw;
    state.featuresError = "";
    if (raw === "" || !Number.isInteger(limit) || limit < 1 || limit > 20) {
      state.featuresError = "展示上限需要 1 到 20 之间的整数";
      state.focus = '[data-field="pinLimitInput"]';
      render();
      return;
    }
    state.busy = true;
    render();
    api("PATCH", "/api/settings", {
      sidebar_pin_limit: limit,
      cron_interval_hours: state.cronInterval,
    }).then(function (result) {
      state.busy = false;
      if (loggedOut(result)) return;
      var saved = result.data && result.data.settings;
      if (!result.data || result.data.ok !== true || !saved) {
        fail("", "featuresError", result, "保存失败，请重试");
        return;
      }
      state.savedPinLimit = Number(saved.sidebar_pin_limit);
      state.pinLimitInput = String(saved.sidebar_pin_limit);
      state.savedCronInterval = Number(saved.cron_interval_hours);
      state.cronInterval = state.savedCronInterval;
      state.featuresError = "";
      render();
      // 系统信息里的「定时任务」行按新间隔重算，否则刚存完还显示旧频率
      loadSystem();
      window.dispatchEvent(new CustomEvent("hivemos:sidebar-refresh"));
      toast("功能设置已保存");
    });
  }

  // ---- 同步与备份 ----

  function backupTargetName(id) {
    if (id === "github") return "GitHub 仓库";
    if (id === "webdav") return "WebDAV 网盘";
    return "未选择";
  }

  function backupTargetOf(id) {
    var backup = state.backup;
    if (!backup || !backup.targets) return null;
    return backup.targets[id] || null;
  }

  function humanBytes(value) {
    var bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return Math.round(bytes) + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function backupSignature(id) {
    if (id === "github") {
      return JSON.stringify([
        String(state.ghOwner).trim(),
        String(state.ghRepo).trim(),
        String(state.ghBranch).trim(),
        String(state.ghPath).trim(),
        String(state.ghToken),
      ]);
    }
    return JSON.stringify([
      String(state.wdBase).trim(),
      String(state.wdUser).trim(),
      String(state.wdDir).trim(),
      String(state.wdPass),
    ]);
  }

  function backupPayload(id) {
    if (id === "github") {
      return {
        target: "github",
        owner: String(state.ghOwner).trim(),
        repo: String(state.ghRepo).trim(),
        branch: String(state.ghBranch).trim(),
        path_prefix: String(state.ghPath).trim(),
        token: String(state.ghToken),
      };
    }
    return {
      target: "webdav",
      base_url: String(state.wdBase).trim(),
      username: String(state.wdUser).trim(),
      remote_dir: String(state.wdDir).trim(),
      password: String(state.wdPass),
    };
  }

  function backupTestPassed(id) {
    var test = state.backupTest[id];
    return !!(test && test.ok && test.signature === backupSignature(id));
  }

  function backupButton(label, action, id, variant, disabled) {
    return (
      '<button type="button"' +
      (variant ? ' class="' + variant + '"' : "") +
      ' data-action="' +
      action +
      '" data-target="' +
      id +
      '"' +
      (disabled || state.busy ? " disabled" : "") +
      ">" +
      C.escapeHtml(label) +
      "</button>"
    );
  }

  function backupNote(id) {
    var test = state.backupTest[id];
    if (test && test.ok) {
      return (
        '<p id="backup-' +
        id +
        '-note" class="callout ok" role="status">' +
        C.escapeHtml(test.message) +
        "</p>"
      );
    }
    if (test && test.message) {
      return (
        '<p id="backup-' +
        id +
        '-note" class="callout danger" role="alert">' +
        C.escapeHtml(test.message) +
        "</p>"
      );
    }
    return '<p id="backup-' + id + '-note" class="callout" hidden></p>';
  }

  function backupGithubIsPublic() {
    if (state.backupTest.github.ok && state.backupTest.github.visibility === "public") return true;
    var target = backupTargetOf("github");
    return !!(target && target.visibility === "public");
  }

  function backupSavedLine(id) {
    var target = backupTargetOf(id);
    if (!target) return '<p class="subtle">还没有保存这个目标</p>';
    if (!target.enabled) return '<p class="subtle">这个目标已停用</p>';
    if (id === "github") {
      var where = (target.owner || "?") + "/" + (target.repo || "?") + "（" + (target.branch || "?") + "）";
      if (target.path_prefix) where += "，路径 " + target.path_prefix;
      return '<p class="subtle">已保存：' + C.escapeHtml(where) + "</p>";
    }
    var place = target.base_url || "?";
    if (target.remote_dir) place += "，目录 " + target.remote_dir;
    return '<p class="subtle">已保存：' + C.escapeHtml(place) + "</p>";
  }

  function githubCard() {
    var target = backupTargetOf("github");
    var tokenHint = target && target.has_token ? "已保存 " + C.maskTail(target.token_tail) + "，留空表示不修改" : "建议使用 repo 权限的细粒度令牌";
    var tokenPlaceholder = target && target.has_token ? "留空表示不修改" : "粘贴访问令牌";
    return (
      '<div class="stack feature-item">' +
      '<label>仓库 owner<input data-field="ghOwner" name="ghOwner" type="text" maxlength="100" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="例如 octocat" value="' +
      C.escapeHtml(state.ghOwner) +
      '" /></label>' +
      '<label>仓库名<input data-field="ghRepo" name="ghRepo" type="text" maxlength="100" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="例如 hivemos-backup" value="' +
      C.escapeHtml(state.ghRepo) +
      '" /></label>' +
      '<label>分支<input data-field="ghBranch" name="ghBranch" type="text" maxlength="200" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="例如 main" value="' +
      C.escapeHtml(state.ghBranch) +
      '" /></label>' +
      '<label>路径前缀<input data-field="ghPath" name="ghPath" type="text" maxlength="300" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="可留空，例如 backups" value="' +
      C.escapeHtml(state.ghPath) +
      '" /></label>' +
      '<label>访问令牌<input data-field="ghToken" name="ghToken" type="password" maxlength="1000" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="' +
      C.escapeHtml(tokenPlaceholder) +
      '" value="' +
      C.escapeHtml(state.ghToken) +
      '" /><span class="subtle field-hint">' +
      C.escapeHtml(tokenHint) +
      "</span></label>" +
      '<p class="subtle">公开仓库里的备份文件可能被其他人看到，建议使用私有仓库或改用 WebDAV</p>' +
      '<p id="backup-github-visibility" class="callout warn"' +
      (backupGithubIsPublic() ? "" : " hidden") +
      ">这个 GitHub 目标看起来是公开仓库，备份内容可能被其他人看到</p>" +
      backupNote("github") +
      '<div class="row-actions">' +
      backupButton("测试连接", "backup-test", "github", "secondary", false) +
      backupButton("保存", "backup-save", "github", "", !backupTestPassed("github")) +
      (target && target.enabled ? backupButton("立即备份", "backup-run", "github", "ghost", false) : "") +
      "</div>" +
      backupSavedLine("github") +
      "</div>"
    );
  }

  function webdavCard() {
    var target = backupTargetOf("webdav");
    var passwordHint = target && target.has_password ? "已保存 " + C.maskTail(target.password_tail) + "，留空表示不修改" : "可留空";
    var passwordPlaceholder = target && target.has_password ? "留空表示不修改" : "粘贴密码";
    return (
      '<div class="stack feature-item">' +
      '<label>服务器地址<input data-field="wdBase" name="wdBase" type="url" maxlength="400" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="https://example.com/dav" value="' +
      C.escapeHtml(state.wdBase) +
      '" /></label>' +
      '<label>用户名<input data-field="wdUser" name="wdUser" type="text" maxlength="200" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="可留空" value="' +
      C.escapeHtml(state.wdUser) +
      '" /></label>' +
      '<label>远程目录<input data-field="wdDir" name="wdDir" type="text" maxlength="300" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="可留空，例如 hivemos" value="' +
      C.escapeHtml(state.wdDir) +
      '" /></label>' +
      '<label>密码<input data-field="wdPass" name="wdPass" type="password" maxlength="1000" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="' +
      C.escapeHtml(passwordPlaceholder) +
      '" value="' +
      C.escapeHtml(state.wdPass) +
      '" /><span class="subtle field-hint">' +
      C.escapeHtml(passwordHint) +
      "</span></label>" +
      backupNote("webdav") +
      '<div class="row-actions">' +
      backupButton("测试连接", "backup-test", "webdav", "secondary", false) +
      backupButton("保存", "backup-save", "webdav", "", !backupTestPassed("webdav")) +
      (target && target.enabled ? backupButton("立即备份", "backup-run", "webdav", "ghost", false) : "") +
      "</div>" +
      backupSavedLine("webdav") +
      "</div>"
    );
  }

  function backupTargetSegment() {
    var options = [
      { value: "", label: "未选择" },
      { value: "github", label: "GitHub 仓库" },
      { value: "webdav", label: "WebDAV 网盘" },
    ];
    return (
      '<div class="segmented" role="group" aria-label="自动备份目标">' +
      options
        .map(function (option) {
          return (
            '<button type="button" class="segment" data-action="set-backup-target" data-target="' +
            option.value +
            '" aria-pressed="' +
            (state.backupTarget === option.value ? "true" : "false") +
            '">' +
            C.escapeHtml(option.label) +
            "</button>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function backupStatusBlock() {
    if (state.backupError) {
      return '<p class="callout danger" role="alert">' + C.escapeHtml(state.backupError) + "</p>";
    }
    if (!state.backup) return '<p class="subtle">正在读取备份状态</p>';
    var schedule = state.backup.schedule || {};
    var summary = schedule.last_summary || null;
    var rows = [];
    rows.push([
      "自动备份",
      schedule.auto_enabled ? "已开启（" + C.escapeHtml(backupTargetName(schedule.target)) + "）" : "已关闭",
    ]);
    if (summary) {
      var when = C.formatMinute(summary.at) || "未知时间";
      var trigger = summary.trigger === "scheduled" ? "定时" : "手动";
      rows.push(["上次备份", C.escapeHtml(when + " · " + trigger + " · " + backupTargetName(summary.target))]);
      if (summary.ok) {
        rows.push([
          "上次结果",
          "成功，" +
            C.escapeHtml(String(summary.files || 0) + " 个文件，" + humanBytes(summary.bytes)) +
            "，耗时 " +
            C.escapeHtml(String(summary.duration_ms || 0) + " ms"),
        ]);
      } else {
        rows.push([
          "上次结果",
          "失败：" + C.escapeHtml(schedule.last_error || summary.error || "未知原因"),
        ]);
      }
    } else {
      rows.push(["上次备份", "还没有备份记录"]);
    }
    rows.push(["执行间隔", C.escapeHtml(cronIntervalLabel(state.backup.interval_hours || state.savedCronInterval))]);
    var next = "";
    if (!schedule.auto_enabled) next = "自动备份已关闭";
    else if (!schedule.target) next = "还没有选择备份目标";
    else if (schedule.last_success_at === null || schedule.last_success_at === undefined) next = "还没有成功备份，下次定时任务会执行";
    else if (state.backup.next_due_at) next = "下次不早于 " + (C.formatMinute(state.backup.next_due_at) || "未知时间");
    else next = "等待下次定时任务";
    rows.push(["下次自动备份", C.escapeHtml(next)]);
    return C.facts(rows);
  }

  function backupAutoPanel() {
    var dirty = state.backupAuto !== state.savedBackupAuto || state.backupTarget !== state.savedBackupTarget;
    return (
      '<form id="backup-auto-form" class="stack inline-panel" novalidate>' +
      "<h3>自动备份</h3>" +
      '<p class="subtle">自动备份跟随「定时任务频率」，达到间隔后在下一次定时任务里执行</p>' +
      '<div class="perm-row"><div class="perm-meta"><strong>自动备份</strong><span class="subtle">' +
      (state.backupAuto ? "已开启" : "已关闭") +
      '</span></div><button type="button" class="switch" role="switch" aria-checked="' +
      (state.backupAuto ? "true" : "false") +
      '" data-action="toggle-backup-auto" aria-label="自动备份"><span class="switch-knob"></span></button></div>' +
      '<div class="stack"><span>备份目标</span>' +
      backupTargetSegment() +
      "</div>" +
      (state.backupAuto && !state.backupTarget
        ? '<p class="callout warn">还没有选择备份目标，自动备份不会执行</p>'
        : "") +
      fieldError("backup-auto-error", state.backupScheduleError, "callout danger") +
      '<div class="row-actions"><button type="submit"' +
      (!dirty || state.busy ? " disabled" : "") +
      ">保存自动备份</button><span class=\"subtle\"" +
      (dirty ? "" : " hidden") +
      ">有改动尚未保存</span></div>" +
      "</form>"
    );
  }

  function currentBackupTab() {
    return state.backupTab === "webdav" ? "webdav" : "github";
  }

  function backupTabButton(id) {
    return (
      '<button type="button" class="page-tab" data-action="set-backup-tab" data-target="' +
      id +
      '" aria-selected="' +
      (currentBackupTab() === id ? "true" : "false") +
      '">' +
      C.escapeHtml(backupTargetName(id)) +
      "</button>"
    );
  }

  function backupTargets() {
    return (
      '<div><div class="page-tabs" role="tablist" aria-label="备份目标">' +
      backupTabButton("github") +
      backupTabButton("webdav") +
      "</div>" +
      (currentBackupTab() === "github" ? githubCard() : webdavCard()) +
      "</div>"
    );
  }

  function backupPanel() {
    return panel(
      "backup-panel",
      "同步与备份",
      '<div class="stack" id="backup-status"><h3>备份状态</h3>' +
        backupStatusBlock() +
        "</div>" +
        backupTargets() +
        backupAutoPanel(),
    );
  }

  function resetBackupTest(id) {
    state.backupTest[id] = { ok: false, message: "", visibility: "", signature: "" };
    paintBackupTarget(id);
  }

  function paintBackupTarget(id) {
    var passed = backupTestPassed(id);
    var test = state.backupTest[id];
    var save = document.querySelector('[data-action="backup-save"][data-target="' + id + '"]');
    if (save) save.disabled = !passed || state.busy;
    var note = document.getElementById("backup-" + id + "-note");
    if (note) {
      if (passed && test.message) {
        note.className = "callout ok";
        note.textContent = test.message;
        note.hidden = false;
      } else if (test.message) {
        note.className = "callout danger";
        note.textContent = test.message;
        note.hidden = false;
      } else {
        note.className = "callout";
        note.textContent = "";
        note.hidden = true;
      }
    }
    if (id === "github") {
      var warn = document.getElementById("backup-github-visibility");
      if (warn) warn.hidden = !backupGithubIsPublic();
    }
  }

  function applyBackupState(result) {
    if (!result.data || result.data.ok !== true || !result.data.backup) {
      state.backup = null;
      state.backupError =
        result.status === 0 ? "网络异常，请重试" : C.explain(result.data && result.data.error, "暂时无法读取同步与备份状态");
      return;
    }
    var backup = result.data.backup;
    state.backup = backup;
    state.backupError = "";
    if (backup.schedule) {
      var autoEnabled = backup.schedule.auto_enabled === true;
      var autoTarget = backup.schedule.target || "";
      // 后台刷新不覆盖还没保存的改动
      if (state.backupAuto === state.savedBackupAuto) state.backupAuto = autoEnabled;
      if (state.backupTarget === state.savedBackupTarget) state.backupTarget = autoTarget;
      state.savedBackupAuto = autoEnabled;
      state.savedBackupTarget = autoTarget;
    }
    if (!state.backupSeeded && backup.targets) {
      var github = backup.targets.github;
      if (github) {
        state.ghOwner = github.owner || "";
        state.ghRepo = github.repo || "";
        state.ghBranch = github.branch || "";
        state.ghPath = github.path_prefix || "";
      }
      var webdav = backup.targets.webdav;
      if (webdav) {
        state.wdBase = webdav.base_url || "";
        state.wdUser = webdav.username || "";
        state.wdDir = webdav.remote_dir || "";
      }
      if (github) state.backupTab = "github";
      else if (webdav) state.backupTab = "webdav";
    }
    state.backupSeeded = true;
  }

  function refreshBackup() {
    return api("GET", "/api/backup").then(function (result) {
      if (loggedOut(result)) return;
      applyBackupState(result);
      if (!state.loading) render();
    });
  }

  function toggleBackupAuto() {
    state.backupAuto = !state.backupAuto;
    state.backupScheduleError = "";
    render();
  }

  function setBackupTab(control) {
    var value = control.getAttribute("data-target") || "";
    if (value !== "github" && value !== "webdav") return;
    state.backupTab = value;
    render();
  }

  function setBackupTarget(control) {
    var value = control.getAttribute("data-target") || "";
    if (value !== "" && value !== "github" && value !== "webdav") return;
    state.backupTarget = value;
    state.backupScheduleError = "";
    render();
  }

  function testBackupTarget(id) {
    if (id !== "github" && id !== "webdav") return;
    state.backupTest[id] = { ok: false, message: "正在测试连接…", visibility: "", signature: "" };
    state.busy = true;
    render();
    api("POST", "/api/backup/test", backupPayload(id)).then(function (result) {
      state.busy = false;
      if (loggedOut(result)) return;
      if (!result.data || result.data.ok !== true) {
        state.backupTest[id] = {
          ok: false,
          message: result.status === 0 ? "网络异常，请重试" : C.explain(result.data && result.data.error, "测试连接失败，请重试"),
          visibility: "",
          signature: "",
        };
        render();
        return;
      }
      var outcome = result.data.result || {};
      if (outcome.ok === true) {
        state.backupTest[id] = {
          ok: true,
          message: outcome.detail || "连接正常",
          visibility: typeof outcome.visibility === "string" ? outcome.visibility : "",
          signature: backupSignature(id),
        };
        toast("连接测试通过");
      } else {
        state.backupTest[id] = {
          ok: false,
          message: outcome.error || "测试连接失败",
          visibility: "",
          signature: "",
        };
      }
      render();
    });
  }

  function saveBackupTarget(id) {
    if (id !== "github" && id !== "webdav") return;
    if (!backupTestPassed(id)) {
      state.backupTest[id] = {
        ok: false,
        message: "请先测试连接，测试通过后才能保存",
        visibility: "",
        signature: "",
      };
      render();
      return;
    }
    state.busy = true;
    state.backupTest[id].message = "";
    render();
    api("PUT", "/api/backup/targets/" + id, backupPayload(id)).then(function (result) {
      state.busy = false;
      if (loggedOut(result)) return;
      if (!result.data || result.data.ok !== true) {
        state.backupTest[id] = {
          ok: false,
          message: result.status === 0 ? "网络异常，请重试" : C.explain(result.data && result.data.error, "保存失败，请重试"),
          visibility: "",
          signature: "",
        };
        render();
        return;
      }
      state.backupTest[id] = { ok: false, message: "", visibility: "", signature: "" };
      if (id === "github") state.ghToken = "";
      else state.wdPass = "";
      toast(backupTargetName(id) + "备份目标已保存");
      refreshBackup();
    });
  }

  function runBackupNow(id) {
    if (id !== "github" && id !== "webdav") return;
    state.busy = true;
    render();
    api("POST", "/api/backup/run", { target: id }).then(function (result) {
      state.busy = false;
      if (loggedOut(result)) return;
      if (!result.data || result.data.ok !== true) {
        toast(
          result.status === 0 ? "网络异常，请重试" : C.explain(result.data && result.data.error, "备份失败，请重试"),
          "danger",
        );
        render();
        return;
      }
      var run = result.data.result || {};
      if (run.ok === true) toast("备份完成，" + String(run.files || 0) + " 个文件");
      else toast("备份失败：" + (run.error || "未知原因"), "danger");
      refreshBackup();
    });
  }

  function submitBackupAuto() {
    state.busy = true;
    state.backupScheduleError = "";
    render();
    api("PATCH", "/api/backup/settings", {
      auto_enabled: state.backupAuto,
      target: state.backupTarget,
    }).then(function (result) {
      state.busy = false;
      if (loggedOut(result)) return;
      if (!result.data || result.data.ok !== true) {
        state.backupScheduleError =
          result.status === 0 ? "网络异常，请重试" : C.explain(result.data && result.data.error, "保存自动备份设置失败，请重试");
        render();
        return;
      }
      var saved = result.data.schedule || {};
      state.backupAuto = saved.auto_enabled === true;
      state.savedBackupAuto = state.backupAuto;
      state.backupTarget = saved.target || "";
      state.savedBackupTarget = state.backupTarget;
      if (state.backup) {
        state.backup.schedule = saved;
        state.backup.interval_hours = Number(result.data.interval_hours) || state.backup.interval_hours;
        state.backup.next_due_at = result.data.next_due_at;
      }
      state.backupScheduleError = "";
      toast("自动备份设置已保存");
      refreshBackup();
    });
  }

  // 无左侧导航的堆叠版式（管理员账号 / 会话管理 / 功能设置 / 同步与备份 / 系统信息）
  function settingsLayout() {
    return (
      '<div class="settings"><div class="settings-body">' +
      accountPanel() +
      sessionsPanel() +
      featuresPanel() +
      backupPanel() +
      systemPanel() +
      "</div></div>"
    );
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
      html = settingsLayout();
    }
    C.mount(C.layout(html));
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
    if (field === "profileInput") {
      clearNote("profile-error", "profileError");
      state.accountStatus = "";
    }
    if (field === "currentPassword" || field === "newPassword" || field === "confirmPassword") {
      clearNote("password-error", "passwordError");
      state.accountError = "";
    }
    if (field === "totpCode" || field === "totpPassword") clearNote("totp-error", "totpError");
    if (field === "pinLimitInput") {
      clearNote("features-error", "featuresError");
      paintFeatureState();
    }
    if (field.indexOf("gh") === 0) resetBackupTest("github");
    if (field.indexOf("wd") === 0) resetBackupTest("webdav");
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
    else if (action === "logout") logout();
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
    else if (action === "set-cron-interval") setCronInterval(control);
    else if (action === "toggle-backup-auto") toggleBackupAuto();
    else if (action === "set-backup-target") setBackupTarget(control);
    else if (action === "set-backup-tab") setBackupTab(control);
    else if (action === "backup-test") testBackupTarget(control.getAttribute("data-target") || "");
    else if (action === "backup-save") saveBackupTarget(control.getAttribute("data-target") || "");
    else if (action === "backup-run") runBackupNow(control.getAttribute("data-target") || "");
  }

  function onSubmit(event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    if (state.busy) return;
    if (form.id === "profile-form") submitProfile();
    else if (form.id === "password-form") submitPassword();
    else if (form.id === "features-form") submitFeatures();
    else if (form.id === "backup-auto-form") submitBackupAuto();
  }

  function fail(slot, key, result, fallback) {
    state.busy = false;
    if (loggedOut(result)) return;
    var message = result.status === 0 ? "网络异常，请重试" : C.explain(result.data && result.data.error, fallback);
    state[key] = message;
    state.focus = slot;
    render();
  }

  function logout() {
    state.busy = true;
    api("POST", "/api/auth/logout", {}).then(function () {
      location.assign("/login.html");
    });
  }

  function submitProfile() {
    var username = fieldValue("profileInput").trim();
    state.profileInput = username;
    state.profileError = "";
    state.accountError = "";
    state.accountStatus = "";
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
      state.accountStatus = saved ? "用户名已保存" : "用户名已清除";
      paintSidebar(displayName(saved, state.profile.username));
      toast(state.accountStatus);
      render();
    });
  }

  function submitPassword() {
    var current = fieldValue("currentPassword");
    var next = fieldValue("newPassword");
    var again = fieldValue("confirmPassword");
    state.passwordError = "";
    state.accountError = "";
    state.accountStatus = "";
    // 反馈位置照 /users：新密码本身的校验留在字段下，其余（缺当前密码、
    // 与当前密码相同、服务端拒绝）走账号面板顶部的提示条。
    var fieldMessage = "";
    var panelMessage = "";
    var focus = "";
    if (!current) {
      panelMessage = "请填写当前密码";
      focus = '[data-field="currentPassword"]';
    } else if (current.length > 256) {
      panelMessage = "当前密码需要 1 到 256 个字符";
      focus = '[data-field="currentPassword"]';
    } else if (!next) {
      fieldMessage = "请填写新密码";
      focus = '[data-field="newPassword"]';
    } else if (next.length < 8 || next.length > 256) {
      fieldMessage = "新密码需要 8 到 256 个字符";
      focus = '[data-field="newPassword"]';
    } else if (next !== again) {
      fieldMessage = "两次输入的新密码不一致";
      focus = '[data-field="confirmPassword"]';
    } else if (next === current) {
      panelMessage = "新密码不能与当前密码相同";
      focus = '[data-field="newPassword"]';
    }
    if (fieldMessage || panelMessage) {
      state.passwordError = fieldMessage;
      state.accountError = panelMessage;
      state.focus = focus;
      render();
      return;
    }
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
      fail('[data-field="currentPassword"]', "accountError", result, "改密码失败，请重试");
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

  function loadSystem() {
    var token = loadToken;
    api("GET", "/api/system/info").then(function (result) {
      if (token !== loadToken) return;
      if (result.status === 401) return;
      if (!result.data || result.data.ok !== true) {
        state.systemError = "读取失败";
        state.system = null;
      } else {
        state.system = result.data;
        state.systemError = "";
      }
      if (!state.loading) render();
    });
  }

  function load() {
    var token = (loadToken += 1);
    state.loading = true;
    state.loadError = "";
    render();
    loadSystem();
    Promise.all([
      api("GET", "/api/account/profile"),
      api("GET", "/api/account/totp"),
      api("GET", "/api/account/sessions"),
      api("GET", "/api/settings"),
      api("GET", "/api/backup"),
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
        var settingsResult = results[3];
        var backupResult = results[4];
        if (settingsResult.data && settingsResult.data.ok === true && settingsResult.data.settings) {
          var savedSettings = settingsResult.data.settings;
          state.savedPinLimit = Number(savedSettings.sidebar_pin_limit);
          state.pinLimitInput = String(savedSettings.sidebar_pin_limit);
          state.savedCronInterval = Number(savedSettings.cron_interval_hours);
          state.cronInterval = state.savedCronInterval;
        }
        // 同步与备份读不到也不拦整页：面板显示提示，其它设置照常可用
        applyBackupState(backupResult);
        // 功能设置读不到不拦整页：面板回退到默认值，而保存按钮只有在真改过
        // （与默认值不同）时才会亮，不会把默认值误写回去。
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

  // 手动保存的同类设置：离开页面前提醒还没提交的改动
  window.addEventListener("beforeunload", function (event) {
    if (!featureDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  load();
})();
