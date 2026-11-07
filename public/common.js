// DOM helpers shared by the shell and the page scripts.
// Session helpers talk to /api/auth/me and /api/auth/logout.
(function () {
  var STATUS = {
    online: ["ok", "在线"],
    syncing: ["warn", "同步中"],
    idle: ["idle", "空闲"],
    offline: ["danger", "离线"],
    running: ["ok", "运行中"],
    paused: ["idle", "已暂停"],
    queued: ["warn", "排队"],
    active: ["ok", "进行中"],
    done: ["ok", "已完成"],
    enabled: ["ok", "已启用"],
    disabled: ["idle", "已停用"],
    synced: ["ok", "已同步"],
    stored: ["ok", "已保管"],
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Visible form is four bullets, a space, and the last four characters.
  function maskTail(tail) {
    return "•••• " + String(tail ?? "").slice(-4);
  }

  function statusMeta(status) {
    return STATUS[status] || ["idle", String(status || "")];
  }

  function statusPill(status) {
    var meta = statusMeta(status);
    return '<span class="status-indicator" data-status="' + meta[0] + '">' + escapeHtml(meta[1]) + "</span>";
  }

  function emptyState(title, text) {
    return '<div class="empty-state"><p class="empty-title">' + escapeHtml(title) + "</p><p>" + escapeHtml(text) + "</p></div>";
  }

  function section(title, hint, body) {
    return (
      '<section class="panel"><div class="section-head"><h2>' +
      escapeHtml(title) +
      "</h2>" +
      (hint ? '<p class="subtle">' + escapeHtml(hint) + "</p>" : "") +
      "</div>" +
      body +
      "</section>"
    );
  }

  function facts(pairs) {
    if (!pairs || !pairs.length) return "";
    return (
      '<dl class="kv">' +
      pairs
        .map(function (pair) {
          return "<div><dt>" + escapeHtml(pair[0]) + "</dt><dd>" + pair[1] + "</dd></div>";
        })
        .join("") +
      "</dl>"
    );
  }

  function record(options) {
    var idAttr = options.id ? ' id="' + escapeHtml(options.id) + '"' : "";
    return (
      '<article class="record"' +
      idAttr +
      '><div class="record-main"><div class="record-title-row"><h3>' +
      escapeHtml(options.title) +
      "</h3>" +
      (options.status ? statusPill(options.status) : "") +
      "</div>" +
      (options.lede ? '<p class="lede">' + escapeHtml(options.lede) + "</p>" : "") +
      (options.extra || "") +
      "</div>" +
      facts(options.facts || []) +
      "</article>"
    );
  }

  function list(html) {
    return '<div class="list">' + html + "</div>";
  }

  function stat(label, value, hint) {
    return (
      '<article class="card stat"><p class="stat-label">' +
      escapeHtml(label) +
      '</p><p class="stat-value">' +
      escapeHtml(value) +
      '</p><p class="subtle">' +
      escapeHtml(hint) +
      "</p></article>"
    );
  }

  function copyLine(value, label) {
    var text = label || "复制";
    return (
      '<div class="copy-line"><code>' +
      escapeHtml(value) +
      '</code><button type="button" class="copy-btn" data-copy="' +
      escapeHtml(value) +
      '" data-label="' +
      escapeHtml(text) +
      '">' +
      escapeHtml(text) +
      "</button></div>"
    );
  }

  function layout(lede, body) {
    return (lede ? '<p class="lede">' + escapeHtml(lede) + "</p>" : "") + body;
  }

  function mount(html) {
    var page = document.getElementById("page");
    if (!page) return;
    page.innerHTML = html;
    if (!location.hash) return;
    var node = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (node && page.contains(node)) node.scrollIntoView();
  }

  var sessionPromise = null;

  function safeNext(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 2048) return "/";
    if (value.charAt(0) !== "/" || value.charAt(1) === "/" || value.charAt(1) === "\\") return "/";
    if (value.indexOf("\\") !== -1 || value.indexOf("://") !== -1) return "/";
    if (/[\u0000-\u001f]/.test(value)) return "/";
    if (value.indexOf("/login") === 0) return "/";
    return value;
  }

  function currentUser() {
    if (!sessionPromise) {
      sessionPromise = fetch("/api/auth/me", {
        headers: { accept: "application/json" },
        cache: "no-store",
      }).then(
        function (response) {
          if (!response.ok) return "";
          return response.json().then(
            function (data) {
              if (!data || data.ok !== true || typeof data.username !== "string") return "";
              return data.username.trim();
            },
            function () {
              return "";
            },
          );
        },
        function () {
          return "";
        },
      );
    }
    return sessionPromise;
  }

  function logout() {
    return fetch("/api/auth/logout", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: "{}",
      cache: "no-store",
    }).then(function (response) {
      if (!response.ok && response.status !== 401) throw new Error("logout");
      sessionPromise = null;
      location.assign("/login.html");
    });
  }

  function copyText(value) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(value);
    }
    return new Promise(function (resolve, reject) {
      var area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.append(area);
      area.select();
      var ok = document.execCommand("copy");
      area.remove();
      if (ok) resolve();
      else reject(new Error("copy failed"));
    });
  }

  function formatMinute(value) {
    var time = Number(value);
    if (!Number.isFinite(time) || time <= 0) return "";
    var date = new Date(time);
    if (Number.isNaN(date.getTime())) return "";
    function pad(number) {
      return String(number).padStart(2, "0");
    }
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
  }

  var closeConfirm = null;

  // Inline confirm. Pages must use this instead of window.confirm.
  function askConfirm(options) {
    var anchor = options && options.anchor;
    if (!anchor) return Promise.resolve(false);
    if (closeConfirm) closeConfirm(false);
    return new Promise(function (resolve) {
      var panel = document.createElement("div");
      panel.className = "confirm-panel";
      panel.setAttribute("role", "group");
      panel.setAttribute("aria-label", (options && options.title) || "确认");
      var text = document.createElement("p");
      text.textContent = (options && options.text) || "";
      var actions = document.createElement("div");
      actions.className = "confirm-actions";
      var cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "secondary";
      cancel.textContent = (options && options.cancelLabel) || "取消";
      var confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = options && options.danger ? "danger" : "";
      confirm.textContent = (options && options.confirmLabel) || "确认";
      actions.append(cancel, confirm);
      panel.append(text, actions);
      anchor.append(panel);
      var done = false;
      function finish(value) {
        if (done) return;
        done = true;
        if (closeConfirm === finish) closeConfirm = null;
        document.removeEventListener("keydown", onKey, true);
        panel.remove();
        resolve(value);
      }
      function onKey(event) {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
      closeConfirm = finish;
      cancel.addEventListener("click", function () {
        finish(false);
      });
      confirm.addEventListener("click", function () {
        finish(true);
      });
      document.addEventListener("keydown", onKey, true);
      cancel.focus();
    });
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var button = target.closest("[data-copy]");
    if (!button) return;
    var value = button.getAttribute("data-copy") || "";
    var label = button.getAttribute("data-label") || "复制";
    copyText(value).then(
      function () {
        button.textContent = "已复制";
        window.clearTimeout(button._copyTimer);
        button._copyTimer = window.setTimeout(function () {
          button.textContent = label;
        }, 1500);
      },
      function () {
        button.textContent = "请手动复制";
        window.clearTimeout(button._copyTimer);
        button._copyTimer = window.setTimeout(function () {
          button.textContent = label;
        }, 1500);
      },
    );
  });

  window.HiveCommon = {
    escapeHtml: escapeHtml,
    maskTail: maskTail,
    statusMeta: statusMeta,
    statusPill: statusPill,
    emptyState: emptyState,
    section: section,
    facts: facts,
    record: record,
    list: list,
    stat: stat,
    copyLine: copyLine,
    layout: layout,
    mount: mount,
    safeNext: safeNext,
    currentUser: currentUser,
    logout: logout,
    formatMinute: formatMinute,
    askConfirm: askConfirm,
  };
})();
