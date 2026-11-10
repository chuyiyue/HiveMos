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
    stopped: ["danger", "已停止"],
    error: ["danger", "运行异常"],
    creating: ["warn", "创建中"],
    starting: ["warn", "启动中"],
    stopping: ["warn", "停止中"],
    suspending: ["warn", "暂停中"],
    suspended: ["idle", "已暂停"],
    resuming: ["warn", "恢复中"],
    deleting: ["warn", "删除中"],
    deleted: ["idle", "已删除"],
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
    return '<div class="empty-state"><p class="empty-title">' + escapeHtml(title) + "</p>" + (text ? "<p>" + escapeHtml(text) + "</p>" : "") + "</div>";
  }

  function section(title, hint, body, actionsHtml) {
    return (
      '<section class="panel"><div class="section-head"><h2>' +
      escapeHtml(title) +
      "</h2>" +
      (hint ? '<p class="subtle">' + escapeHtml(hint) + "</p>" : "") +
      (actionsHtml ? '<div class="section-actions">' + actionsHtml + "</div>" : "") +
      "</div>" +
      body +
      "</section>"
    );
  }

  // Top action row shared by list pages and by every tab inside a section:
  // one primary add button plus a secondary add-group button, same spot and
  // same markup everywhere. Actions are data-action values handled by the
  // click delegation of the page.
  function addBar(options) {
    options = options || {};
    return (
      '<div class="add-bar"><button type="button" class="secondary add-group-button" data-action="' +
      escapeHtml(options.groupAction || "add-group") +
      '">' +
      escapeHtml(options.groupLabel || "添加分组") +
      '</button><button type="button" class="add-button" data-action="' +
      escapeHtml(options.addAction || "add") +
      '">' +
      escapeHtml(options.addLabel || "添加") +
      "</button></div>"
    );
  }

  // Group picker used by create/edit dialogs: blank value means ungrouped.
  // Toast bubbles, SMSinBox style: stacked bottom-right, auto-dismiss,
  // click to dismiss sooner. When a native dialog is open the bubble is
  // hosted inside it so it stays in the top layer with the dialog.
  function toast(message, tone) {
    if (!message) return;
    var host = document.querySelector("dialog[open]") || document.body;
    var box = null;
    for (var i = 0; i < host.children.length; i++) {
      if (host.children[i].classList && host.children[i].classList.contains("toasts")) box = host.children[i];
    }
    if (!box) {
      box = document.createElement("div");
      box.className = "toasts";
      box.setAttribute("aria-live", "polite");
      host.append(box);
    }
    var el = document.createElement("div");
    el.className = "toast" + (tone === "danger" ? " is-danger" : "");
    var span = document.createElement("span");
    span.textContent = message;
    el.append(span);
    box.append(el);
    var gone = false;
    function dismiss() {
      if (gone) return;
      gone = true;
      el.classList.add("is-out");
      window.setTimeout(function () {
        el.remove();
      }, 260);
    }
    el.addEventListener("click", dismiss);
    window.setTimeout(dismiss, tone === "danger" ? 5200 : 3600);
  }

  function groupSelect(name, groups, current) {
    var html =
      '<select data-field="' +
      escapeHtml(name) +
      '" name="' +
      escapeHtml(name) +
      '"><option value=""' +
      (!current ? " selected" : "") +
      ">未分组</option>";
    (groups || []).forEach(function (group) {
      html +=
        '<option value="' +
        escapeHtml(group.id) +
        '"' +
        (group.id === current ? " selected" : "") +
        ">" +
        escapeHtml(group.name) +
        "</option>";
    });
    return html + "</select>";
  }

  // Renders items bucketed into group sections (group order as given),
  // ungrouped items last. Group sections always render, even when empty, so
  // rename/delete stays reachable; the ungrouped section renders when it has
  // items or when there are no groups at all.
  // options: { groups, items, groupOf, renderItem, groupActions,
  //            ungroupedTitle, emptyGroupText, emptyTitle, emptyText }
  function groupedSections(options) {
    var groups = options.groups || [];
    var buckets = {};
    groups.forEach(function (group) {
      buckets[group.id] = [];
    });
    var loose = [];
    (options.items || []).forEach(function (item) {
      var gid = options.groupOf(item);
      if (gid && Object.prototype.hasOwnProperty.call(buckets, gid)) buckets[gid].push(item);
      else loose.push(item);
    });
    var html = "";
    groups.forEach(function (group) {
      var members = buckets[group.id];
      var body = members.length
        ? (options.cardGrid ? cardList : list)(members.map(options.renderItem).join(""))
        : emptyState("还没有成员", options.emptyGroupText || "添加时选择这个分组即可归入");
      html += section(
        group.name,
        members.length ? members.length + " 个" : "",
        body,
        options.groupActions ? options.groupActions(group) : "",
      );
    });
    if (loose.length || !groups.length) {
      var looseBody = loose.length
        ? (options.cardGrid ? cardList : list)(loose.map(options.renderItem).join(""))
        : emptyState(options.emptyTitle || "暂无内容", options.emptyText || "");
      html += options.bareUngrouped
        ? looseBody
        : section(options.ungroupedTitle || "未分组", loose.length ? loose.length + " 个" : "", looseBody);
    }
    return html;
  }

  function badge(label, tone) {
    return '<span class="badge' + (tone ? " is-" + tone : "") + '">' + escapeHtml(label) + "</span>";
  }

  // Prefer the server's error string. fallback is only for an empty body.
  function explain(value, fallback) {
    if (typeof value === "string" && value.trim()) return value.trim();
    return fallback || "操作失败，请稍后重试";
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

  // ---- Card structure (SMSinBox device-card layout) ----
  // A card is one column: a head row (icon, big name, type capsule, status,
  // optional corner control), an optional lede/extra, a two-column
  // label-over-value meta grid, and an equal-width outline button row for
  // direct actions. The head + meta area is the card info zone: when
  // options.manage is set it becomes the click target (focusable, Enter /
  // Space friendly) that opens the item management dialog. Management
  // itself never lives inside the card any more.
  function iconSvg(name) {
    return (
      "<svg class=\"icon record-icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><use href=\"/icons.svg#icon-" +
      escapeHtml(name) +
      "\"/></svg>"
    );
  }

  // ---- Agent avatars ----
  // One render rule everywhere an Agent avatar appears: an uploaded image
  // or an external image link wins, then the library icon, then the
  // default bot icon. The three sources are mutually exclusive (the
  // server clears the others whenever one is set).
  var avatarStylesDone = false;
  function ensureAvatarStyles() {
    if (avatarStylesDone) return;
    avatarStylesDone = true;
    var style = document.createElement("style");
    style.id = "hive-avatar-styles";
    style.textContent = [
      ".agent-avatar-img{object-fit:cover;border-radius:26%}",
      ".agent-avatar-tile{display:inline-grid;place-items:center;width:36px;height:36px;flex:none;border-radius:var(--r-md);background:var(--bg-sunken);overflow:hidden}",
      ".agent-avatar-tile img.agent-avatar-img{width:100%;height:100%;object-fit:cover;display:block;border-radius:0}",
      ".agent-avatar-tile svg{width:20px;height:20px}",
      ".manage-avatar-btn{position:relative;overflow:hidden;display:grid;place-items:center;width:44px;height:44px;padding:0;border:0;border-radius:var(--r-md);background:var(--bg-sunken);color:var(--text-2);cursor:pointer}",
      ".manage-avatar-btn:hover{box-shadow:0 0 0 2px var(--accent)}",
      ".manage-avatar-btn .icon{width:24px;height:24px}",
      ".manage-avatar-btn img.agent-avatar-img{width:44px;height:44px;border-radius:inherit;object-fit:cover;display:block}",
      ".manage-avatar-edit{position:absolute;inset:0;display:grid;place-items:center;background:rgba(28,25,23,.38);color:#fff;opacity:0;pointer-events:none;transition:opacity var(--dur-base) var(--ease)}",
      ".manage-avatar-btn:hover .manage-avatar-edit,.manage-avatar-btn:focus-visible .manage-avatar-edit{opacity:1}",
      ".manage-avatar-edit .icon{width:18px;height:18px}",
      ".avatar-search-label{display:block}",
      ".avatar-search-label input{width:100%;margin-top:6px}",
      ".avatar-cat{margin:16px 0 8px;font-size:var(--fs-sm);font-weight:600;color:var(--text-2)}",
      ".avatar-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(62px,1fr));gap:8px}",
      ".avatar-cell{display:flex;flex-direction:column;align-items:center;gap:5px;padding:10px 2px 8px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface);color:var(--text-2);cursor:pointer;font-size:var(--fs-xs);line-height:1.2}",
      ".avatar-cell:hover{border-color:var(--accent);color:var(--text)}",
      ".avatar-cell.is-current{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent);color:var(--accent-text)}",
      ".avatar-cell .icon{width:28px;height:28px}",
      ".avatar-preview{display:grid;place-items:center;padding:14px 0 6px}",
      ".avatar-preview img{width:96px;height:96px;border-radius:var(--r-lg);object-fit:cover;border:1px solid var(--border)}",
      ".avatar-picker-foot{margin-top:18px;justify-content:space-between}",
    ].join("\n");
    document.head.append(style);
  }

  function agentAvatarSrc(agent) {
    if (!agent) return "";
    if (agent.has_custom_avatar) return "/api/agents/" + encodeURIComponent(agent.id) + "/avatar";
    if (agent.avatar_url) return String(agent.avatar_url);
    return "";
  }

  function agentAvatarHtml(agent, cls) {
    ensureAvatarStyles();
    var src = agentAvatarSrc(agent);
    if (src) {
      return "<img class=\"" + cls + " agent-avatar-img\" src=\"" + escapeHtml(src) + "\" alt=\"\" loading=\"lazy\" />";
    }
    var symbol = agent && agent.avatar_icon ? "avatar-" + agent.avatar_icon : "icon-bot";
    return (
      "<svg class=\"" + cls + "\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><use href=\"/icons.svg#" +
      escapeHtml(symbol) +
      "\"></use></svg>"
    );
  }

  function metaGrid(pairs) {
    if (!pairs || !pairs.length) return "";
    return (
      "<dl class=\"card-meta\">" +
      pairs
        .map(function (pair) {
          return "<div><dt>" + escapeHtml(pair[0]) + "</dt><dd>" + pair[1] + "</dd></div>";
        })
        .join("") +
      "</dl>"
    );
  }

  function record(options) {
    var idAttr = options.id ? " id=\"" + escapeHtml(options.id) + "\"" : "";
    var zoneAttrs = options.manage
      ? " data-manage=\"" +
        escapeHtml(options.manage) +
        "\" tabindex=\"0\" role=\"button\" aria-haspopup=\"dialog\" aria-label=\"" +
        escapeHtml("管理：" + (options.title || "")) +
        "\""
      : "";
    var head =
      "<div class=\"record-head\">" +
      (options.iconHtml ? options.iconHtml : options.icon ? iconSvg(options.icon) : "") +
      "<h3 class=\"record-name\">" +
      escapeHtml(options.title) +
      "</h3>" +
      (options.pillHtml ? '<span class="badge">' + options.pillHtml + "</span>" : options.pill ? badge(options.pill) : "") +
      (options.statusHtml ? options.statusHtml : options.status ? statusPill(options.status) : "") +
      (options.corner ? "<span class=\"record-corner\">" + options.corner + "</span>" : "") +
      "</div>";
    return (
      "<article class=\"record" + (options.className ? " " + escapeHtml(options.className) : "") + "\"" +
      idAttr +
      "><div class=\"record-info\"" +
      zoneAttrs +
      ">" +
      head +
      (options.lede ? "<p class=\"lede\">" + escapeHtml(options.lede) + "</p>" : "") +
      (options.extra || "") +
      metaGrid(options.facts || []) +
      "</div>" +
      (options.actions ? "<div class=\"card-actions\">" + options.actions + "</div>" : "") +
      "</article>"
    );
  }

  // ---- Overlay containers for secondary (management) content ----
  // Two shared shells, both a modal <dialog> appended to <body> so a page
  // render() never destroys them: a centered floating dialog (card and row
  // management) and a right-hand slide-over panel (sidebar Agent detail).
  // Pages fill the body, wire their own delegated handlers onto ctrl.dialog
  // (the mcp-skills wireDialog pattern), and use ctrl.confirmSlot as the
  // askConfirm anchor for flows started inside.
  // ---- Two-step in-place delete confirmation (global) ----
  // Any [data-confirm-delete] button: the first click only arms it (the
  // label becomes the confirm text); the second click on the same button
  // lets the page handler run the delete. Arming resets after a few
  // seconds, when another button is clicked, or when a new overlay opens.
  // Disable / revoke actions do not use this; they keep their own flows.
  var armedDeleteBtn = null;
  var armedDeleteTimer = null;
  function disarmDelete() {
    if (armedDeleteTimer) {
      clearTimeout(armedDeleteTimer);
      armedDeleteTimer = null;
    }
    if (armedDeleteBtn) {
      var btn = armedDeleteBtn;
      armedDeleteBtn = null;
      btn.classList.remove("is-armed");
      btn.removeAttribute("data-armed");
      if (btn.dataset.armLabel !== undefined) {
        btn.innerHTML = btn.dataset.armLabel;
        delete btn.dataset.armLabel;
      }
    }
  }
  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var btn = target.closest("[data-confirm-delete]");
      if (btn && btn === armedDeleteBtn) {
        disarmDelete();
        return;
      }
      if (armedDeleteBtn) disarmDelete();
      if (!btn) return;
      event.preventDefault();
      event.stopPropagation();
      armedDeleteBtn = btn;
      btn.dataset.armLabel = btn.innerHTML;
      btn.textContent = "确认删除";
      btn.classList.add("is-armed");
      btn.setAttribute("data-armed", "1");
      armedDeleteTimer = setTimeout(disarmDelete, 3500);
    },
    true,
  );

  var currentOverlay = null;

  var CLOSE_ICON =
    "<svg class=\"icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M6 6l12 12M18 6L6 18\"/></svg>";

  function buildOverlay(options, panel) {
    disarmDelete();
    if (currentOverlay) currentOverlay.close();
    var dialog = document.createElement("dialog");
    var sizeCls = options.size === "lg" || options.wide ? " size-lg" : options.size === "sm" ? " size-sm" : " size-md";
    dialog.className = panel ? "modal side-panel" : "modal manage-dialog" + sizeCls;
    dialog.setAttribute("data-manage-dialog", "");
    dialog.setAttribute("aria-label", options.title || "管理");
    var card = document.createElement("div");
    card.className = "modal-card";
    var head = document.createElement("div");
    head.className = "manage-head";
    var heading = document.createElement("h2");
    heading.className = "modal-title";
    heading.textContent = options.title || "";
    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "icon-btn ghost manage-close";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.innerHTML = CLOSE_ICON;
    if (!options.hideHead) head.append(heading, closeBtn);
    var body = document.createElement("div");
    body.className = "manage-body";
    body.innerHTML = options.bodyHtml || "";
    var confirmSlot = document.createElement("div");
    confirmSlot.className = "confirm-slot";
    confirmSlot.setAttribute("data-manage-confirm", "");
    body.append(confirmSlot);
    if (options.hideHead) {
      card.classList.add("headless");
      card.append(closeBtn, body);
    } else {
      card.append(head, body);
    }
    dialog.append(card);
    document.body.append(dialog);
    var ctrl = {
      dialog: dialog,
      bodyEl: body,
      confirmSlot: confirmSlot,
      setTitle: function (text) {
        heading.textContent = text || "";
        dialog.setAttribute("aria-label", text || "管理");
      },
      setBody: function (html) {
        body.innerHTML = html || "";
        body.append(confirmSlot);
      },
      close: function () {
        if (dialog.open) dialog.close();
      },
    };
    currentOverlay = ctrl;
    var closeGuard = typeof options.onBeforeClose === "function" ? options.onBeforeClose : null;
    var closeApproved = false;
    ctrl.requestClose = function () {
      if (!closeGuard || closeApproved) {
        ctrl.close();
        return;
      }
      Promise.resolve(closeGuard()).then(function (ok) {
        if (ok) {
          closeApproved = true;
          ctrl.close();
        }
      });
    };
    ctrl.forceClose = function () {
      closeApproved = true;
      ctrl.close();
    };
    closeBtn.addEventListener("click", function () {
      ctrl.requestClose();
    });
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) ctrl.requestClose();
    });
    dialog.addEventListener("cancel", function (event) {
      if (closeGuard && !closeApproved) {
        event.preventDefault();
        ctrl.requestClose();
      }
    });
    dialog.addEventListener("close", function () {
      document.body.classList.remove("modal-open");
      if (currentOverlay === ctrl) currentOverlay = null;
      dialog.remove();
      if (typeof options.onClose === "function") options.onClose();
    });
    dialog.showModal();
    document.body.classList.add("modal-open");
    closeBtn.focus();
    return ctrl;
  }

  function openManageDialog(options) {
    return buildOverlay(options || {}, false);
  }

  function openSidePanel(options) {
    return buildOverlay(options || {}, true);
  }

  // ---- Agent management (shared by the Agents board dialog and the
  // sidebar side panel) ----
  // One builder + one wiring for both hosts: detail facts, the full
  // management action set and the per-Agent permission switches (saved the
  // moment they are flipped, PATCH with the complete set). The host only
  // picks where it opens (centered dialog vs side panel) and passes an
  // onChanged(message) callback so its own list can refresh.
  // Permission model: a read/write matrix over nine domains plus three
  // advanced domains (agents_other / soul_other / totp), each also a
  // read/write pair in its own separate menu. The server stores
  // permissions as an object ({domain: {read, write}, ..., advanced:
  // {key: {read, write}}}); rows that have not been re-saved yet may still
  // carry the legacy array form or the old boolean advanced switches,
  // which normalizePerms folds in (each listed domain = read-only;
  // "registry" expands to mcp/skills/api; old soul_write_any migrates to
  // soul_other.write, old vault_totp_code to totp.read, old
  // machines_secret is dropped).
  var PERM_MATRIX = [
    ["mcp", "MCP"],
    ["skills", "Skills"],
    ["api", "API"],
    ["memory", "记忆"],
    ["soul", "Soul"],
    ["tasks", "任务"],
    ["calendar", "日历"],
    ["vault", "保险库"],
    ["machines", "云计算资源"],
  ];
  var PERM_ADVANCED = [
    ["agents_other", "操作其他 Agent"],
    ["soul_other", "操作其他 Soul"],
    ["totp", "操作2FA"],
  ];
  // Legacy triple list ([key, label, hint]) kept for the permDomains export.
  var PERM_DOMAINS = [
    ["mcp", "MCP", "MCP 注册表的搜索、列表与取配置"],
    ["skills", "Skills", "Skills 的列表与取用"],
    ["api", "API", "API 条目的列表与取用"],
    ["memory", "记忆", "记忆的读写与同步"],
    ["soul", "Soul", "Soul 的读写与同步"],
    ["soul_write_any", "代写他人 Soul", "写入其他 Agent 的 Soul，默认不给任何 Agent"],
    ["tasks", "任务", "任务的查看与处理"],
    ["calendar", "日历", "日程的查看与编辑"],
    ["vault", "保险库", "保险库条目的取用"],
    ["machines", "云计算资源", "服务器、云主机与 Workers 的状态与操作"],
  ];

  function emptyPerms() {
    var out = {};
    PERM_MATRIX.forEach(function (entry) {
      out[entry[0]] = { read: false, write: false };
    });
    out.advanced = {};
    PERM_ADVANCED.forEach(function (entry) {
      out.advanced[entry[0]] = { read: false, write: false };
    });
    return out;
  }

  function normalizePerms(input) {
    var out = emptyPerms();
    if (Array.isArray(input)) {
      input.forEach(function (domain) {
        if (domain === "registry") {
          ["mcp", "skills", "api"].forEach(function (key) {
            out[key].read = true;
          });
        } else if (domain === "soul_write_any") {
          out.advanced.soul_other.write = true;
        } else if (domain !== "advanced" && out[domain]) {
          out[domain].read = true;
        }
      });
      return out;
    }
    if (input && typeof input === "object") {
      PERM_MATRIX.forEach(function (entry) {
        var cell = input[entry[0]];
        if (cell && typeof cell === "object") {
          out[entry[0]].read = !!cell.read;
          out[entry[0]].write = !!cell.write;
        }
      });
      var adv = input.advanced;
      if (adv && typeof adv === "object") {
        PERM_ADVANCED.forEach(function (entry) {
          var cell = adv[entry[0]];
          if (cell && typeof cell === "object") {
            out.advanced[entry[0]].read = !!cell.read;
            out.advanced[entry[0]].write = !!cell.write;
          }
        });
        // Old boolean switches migrate; machines_secret is dropped.
        if (adv.soul_write_any === true) out.advanced.soul_other.write = true;
        if (adv.vault_totp_code === true) out.advanced.totp.read = true;
      }
    }
    return out;
  }

  function clonePerms(perms) {
    return normalizePerms(JSON.parse(JSON.stringify(perms || {})));
  }

  // Both sides always come from normalizePerms/clonePerms, so key order
  // is fixed and a string compare is an exact compare.
  function permsEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function agentApi(method, url, body) {
    var headers = { accept: "application/json" };
    var init = { method: method, headers: headers, cache: "no-store" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetch(url, init).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          return { status: response.status, data: data || {} };
        });
    });
  }

  function permTextOf(agent) {
    var perms = normalizePerms(agent ? agent.permissions : null);
    var parts = [];
    PERM_MATRIX.forEach(function (entry) {
      var cell = perms[entry[0]];
      if (cell.read && cell.write) parts.push(entry[1] + " 读写");
      else if (cell.read) parts.push(entry[1] + " 只读");
      else if (cell.write) parts.push(entry[1] + " 只写");
    });
    return parts.length ? parts.join(" · ") : "无权限";
  }

  function permMatrixHtml(agent) {
    var perms = normalizePerms(agent ? agent.permissions : null);
    var rows = PERM_MATRIX.map(function (entry) {
      var key = entry[0];
      var cell = perms[key];
      return (
        '<div class="perm-mrow">' +
        '<span class="perm-mname">' +
        escapeHtml(entry[1]) +
        "</span>" +
        '<label class="perm-check"><input type="checkbox" data-perm-cell="' +
        key +
        '" data-perm-op="read"' +
        (cell.read ? " checked" : "") +
        ' aria-label="' +
        escapeHtml(entry[1] + " 读取") +
        '" /></label>' +
        '<label class="perm-check"><input type="checkbox" data-perm-cell="' +
        key +
        '" data-perm-op="write"' +
        (cell.write ? " checked" : "") +
        ' aria-label="' +
        escapeHtml(entry[1] + " 写入") +
        '" /></label></div>'
      );
    }).join("");
    var advanced = PERM_ADVANCED.map(function (entry) {
      var key = entry[0];
      var cell = perms.advanced[key];
      function advCell(op) {
        return (
          '<label class="perm-check"><input type="checkbox" data-perm-adv="' +
          key +
          '" data-perm-op="' +
          op +
          '"' +
          (cell[op] ? " checked" : "") +
          ' aria-label="' +
          escapeHtml(entry[1] + (op === "read" ? " 读取" : " 写入")) +
          '" /></label>'
        );
      }
      return (
        '<div class="perm-mrow">' +
        '<span class="perm-mname">' +
        escapeHtml(entry[1]) +
        "</span>" +
        advCell("read") +
        advCell("write") +
        "</div>"
      );
    }).join("");
    return (
      '<div class="perm-matrix" data-perm-matrix>' +
      '<div class="perm-mgrid" aria-label="功能权限">' +
      '<div class="perm-mrow perm-mhead"><span class="perm-mname">功能</span><span class="perm-mcol">读取</span><span class="perm-mcol">写入</span></div>' +
      rows +
      "</div>" +
      '<div class="perm-advanced"><div class="perm-advanced-title">高级权限</div><div class="perm-mgrid" aria-label="高级权限">' +
      '<div class="perm-mrow perm-mhead"><span class="perm-mname">功能</span><span class="perm-mcol">读取</span><span class="perm-mcol">写入</span></div>' +
      advanced +
      "</div></div>" +
      '<div class="perm-foot"><button type="button" class="secondary perm-clear" data-perm-clear>全部关闭</button><button type="button" class="perm-save" data-perm-save disabled>保存权限</button></div>' +
      "</div>"
    );
  }

  function mcpEndpoint() {
    return location.origin + "/mcp";
  }

  function manageInfoHead(o) {
    return (
      "<div class=\"manage-info-head\"><span class=\"manage-info-icon\">" +
      (o.iconHtml
        ? o.iconHtml
        : "<svg class=\"icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><use href=\"/icons.svg#icon-" +
          escapeHtml(o.icon || "bot") +
          "\"></use></svg>") +
      "</span>" +
      "<div class=\"manage-info-titles\"><h3 class=\"manage-info-name\">" +
      escapeHtml(o.title || "") +
      (o.titleSuffix || "") +
      "</h3>" +
      (o.sub ? "<p class=\"manage-info-sub\">" + escapeHtml(o.sub) + "</p>" : "") +
      "</div></div>"
    );
  }

  function wireManageTabs(ctrl) {
    ctrl.dialog.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var tab = target.closest("[data-mtab]");
      if (!tab) return;
      var name = tab.getAttribute("data-mtab");
      Array.prototype.forEach.call(ctrl.bodyEl.querySelectorAll("[data-mtab]"), function (btn) {
        btn.setAttribute("aria-selected", btn.getAttribute("data-mtab") === name ? "true" : "false");
      });
      Array.prototype.forEach.call(ctrl.bodyEl.querySelectorAll("[data-mpanel]"), function (panel) {
        panel.hidden = panel.getAttribute("data-mpanel") !== name;
      });
    });
  }

  function agentManageBody(agent, groupName, opts) {
    var partial = !!(opts && opts.partial);
    var initialTab = opts && (opts.tab === "perms" || opts.tab === "advanced") ? opts.tab : "overview";
    var active = agent.status === "active";
    var endpoint = mcpEndpoint();
    var advanced =
      "<div class=\"manage-actions\">" +
      (active
        ? "<button type=\"button\" class=\"secondary\" data-agent-act=\"disable\">停用</button>"
        : "<button type=\"button\" data-agent-act=\"enable\">启用</button>") +
      "<button type=\"button\" class=\"secondary\" data-agent-act=\"move\">分组</button>" +
      (active ? "<button type=\"button\" class=\"secondary\" data-agent-act=\"rotate\">令牌</button>" : "") +
      "<button type=\"button\" class=\"danger\" data-agent-act=\"delete\">删除</button>" +
      "</div>" +
      (active ? "" : "<p class=\"subtle\">这个 Agent 已停用，启用后可继续调用</p>");
    var permSection = partial
      ? '<p class="subtle" data-perm-pending>权限读取中</p>'
      : permMatrixHtml(agent);
    return (
      "<p class=\"manage-status\" data-manage-status role=\"status\"></p>" +
      manageInfoHead({
        iconHtml:
          "<button type=\"button\" class=\"manage-avatar-btn\" data-agent-act=\"avatar\" title=\"更换头像\" aria-label=\"更换头像\">" +
          agentAvatarHtml(agent, "icon") +
          "<span class=\"manage-avatar-edit\" aria-hidden=\"true\"><svg class=\"icon\" viewBox=\"0 0 24 24\"><use href=\"/icons.svg#icon-edit\"></use></svg></span>" +
          "</button>",
        title: agent.name,
        sub: (active ? "已启用" : "已停用") + " · Agent · " + (partial ? "读取中" : groupName || "未分组"),
        titleSuffix: "<button type=\"button\" class=\"manage-name-edit\" data-agent-act=\"rename\" title=\"改名\" aria-label=\"改名\"><svg class=\"icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><use href=\"/icons.svg#icon-edit\"></use></svg></button>",
      }) +
      "<div class=\"manage-info-card\"><dl class=\"kv\">" +
      "<div><dt>状态</dt><dd>" +
      statusPill(active ? "enabled" : "disabled") +
      "</dd></div>" +
      "<div><dt>标识</dt><dd><span class=\"mono copy-text\" data-copy=\"" +
      escapeHtml(agent.id) +
      "\" title=\"点击复制\">" +
      escapeHtml(agent.id) +
      "</span></dd></div>" +
      "<div><dt>接入地址</dt><dd><span class=\"mono copy-text\" data-agent-endpoint data-copy=\"" +
      escapeHtml(endpoint) +
      "\" title=\"点击复制\">…" +
      escapeHtml(endpoint.slice(-16)) +
      "</span></dd></div>" +
      "</dl></div>" +
      "<div class=\"page-tabs manage-tabs\" role=\"tablist\" aria-label=\"Agent 管理\">" +
      "<button type=\"button\" class=\"page-tab\" role=\"tab\" data-mtab=\"overview\" aria-selected=\"" + (initialTab === "overview" ? "true" : "false") + "\">概览</button>" +
      "<button type=\"button\" class=\"page-tab\" role=\"tab\" data-mtab=\"perms\" aria-selected=\"" + (initialTab === "perms" ? "true" : "false") + "\">权限</button>" +
      "<button type=\"button\" class=\"page-tab\" role=\"tab\" data-mtab=\"records\" aria-selected=\"" + (initialTab === "records" ? "true" : "false") + "\">记录</button>" +
      "<button type=\"button\" class=\"page-tab\" role=\"tab\" data-mtab=\"advanced\" aria-selected=\"" + (initialTab === "advanced" ? "true" : "false") + "\">高级</button>" +
      "</div>" +
      "<div data-mpanel=\"overview\"" + (initialTab === "overview" ? "" : " hidden") + ">" +
      "<dl class=\"kv\">" +
      "<div><dt>权限</dt><dd><span data-perm-summary>" +
      (partial ? "读取中" : escapeHtml(permTextOf(agent))) +
      "</span></dd></div>" +
      "<div><dt>上次调用</dt><dd>" +
      escapeHtml(formatMinute(agent.last_seen_at) || "还没有调用") +
      "</dd></div>" +
      "<div><dt>创建时间</dt><dd>" +
      (partial ? "读取中" : escapeHtml(formatMinute(agent.created_at) || "未知")) +
      "</dd></div>" +
      "</dl>" +
      "</div>" +
      "<div data-mpanel=\"records\"" + (initialTab === "records" ? "" : " hidden") + ">" +
      "<div data-agent-records-body>" +
      (opts && opts.recordsHtml ? opts.recordsHtml : '<p class="subtle">正在读取</p>') +
      "</div>" +
      "</div>" +
      "<div data-mpanel=\"perms\"" + (initialTab === "perms" ? "" : " hidden") + ">" +
      permSection +
      "</div>" +
      "<div data-mpanel=\"advanced\"" + (initialTab === "advanced" ? "" : " hidden") + ">" +
      advanced +
      "</div>"
    );
  }

  // ---- Anchored dropdown menu (shared) ----
  // C.openMenu(anchorBtn, items): a small white card that drops below the
  // anchor (flips above when the viewport runs out of room), one row per
  // item, danger rows in red. Closes on outside press, Esc, scroll, or
  // resize; arrow keys move between rows, and focus returns to the anchor
  // after Esc. An item with armLabel is a two-step action: the first click
  // arms it in place (label swaps to armLabel, solid danger), a second
  // click within a few seconds runs onSelect. Calling openMenu again with
  // the same anchor toggles the menu shut.
  var currentMenu = null;

  function closeMenu() {
    if (!currentMenu) return;
    var menu = currentMenu;
    currentMenu = null;
    if (menu.timer) window.clearTimeout(menu.timer);
    document.removeEventListener("mousedown", menu.onDocDown, true);
    document.removeEventListener("keydown", menu.onKey, true);
    window.removeEventListener("resize", menu.onClose);
    document.removeEventListener("scroll", menu.onClose, true);
    if (menu.anchor) {
      menu.anchor.removeAttribute("aria-expanded");
      if (menu.restoreFocus) menu.anchor.focus();
    }
    menu.el.remove();
  }

  function openMenu(anchor, items) {
    if (currentMenu && currentMenu.anchor === anchor) {
      closeMenu();
      return null;
    }
    closeMenu();
    disarmDelete();
    var el = document.createElement("div");
    el.className = "pop-menu";
    el.setAttribute("role", "menu");
    var state = {
      el: el,
      anchor: anchor,
      timer: null,
      restoreFocus: false,
      onClose: null,
      onDocDown: null,
      onKey: null,
    };
    var buttons = [];
    (items || []).forEach(function (item) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pop-menu-item" + (item.danger ? " danger" : "");
      btn.setAttribute("role", "menuitem");
      btn.textContent = item.label || "";
      if (item.disabled) btn.disabled = true;
      var armed = false;
      btn.addEventListener("click", function () {
        if (item.armLabel && !armed) {
          armed = true;
          var original = btn.textContent;
          btn.textContent = item.armLabel;
          btn.classList.add("is-armed");
          state.timer = window.setTimeout(function () {
            armed = false;
            btn.textContent = original;
            btn.classList.remove("is-armed");
          }, 3500);
          return;
        }
        state.restoreFocus = false;
        closeMenu();
        if (typeof item.onSelect === "function") item.onSelect();
      });
      buttons.push(btn);
      el.append(btn);
    });
    document.body.append(el);
    var rect = anchor.getBoundingClientRect();
    var menuRect = el.getBoundingClientRect();
    var top = rect.bottom + 6;
    if (top + menuRect.height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - menuRect.height - 6);
    }
    var left = Math.min(rect.left, window.innerWidth - menuRect.width - 8);
    el.style.top = Math.max(8, top) + "px";
    el.style.left = Math.max(8, left) + "px";
    anchor.setAttribute("aria-expanded", "true");
    state.onClose = function () {
      closeMenu();
    };
    state.onDocDown = function (event) {
      var target = event.target;
      if (target instanceof Element && (el.contains(target) || anchor.contains(target))) return;
      closeMenu();
    };
    state.onKey = function (event) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        state.restoreFocus = true;
        closeMenu();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      var active = buttons.indexOf(document.activeElement);
      if (active === -1) return;
      event.preventDefault();
      var next =
        event.key === "ArrowDown"
          ? Math.min(active + 1, buttons.length - 1)
          : Math.max(active - 1, 0);
      if (buttons[next]) buttons[next].focus();
    };
    document.addEventListener("mousedown", state.onDocDown, true);
    document.addEventListener("keydown", state.onKey, true);
    window.addEventListener("resize", state.onClose);
    document.addEventListener("scroll", state.onClose, true);
    currentMenu = state;
    var first = buttons.find(function (btn) {
      return !btn.disabled;
    });
    if (first) first.focus();
    return { close: closeMenu };
  }

  function closeCurrentOverlay() {
    if (currentOverlay) currentOverlay.close();
  }

  function openAgentManage(agentId, options) {
    options = options || {};
    var currentTab = options.tab === "perms" || options.tab === "advanced" ? options.tab : "overview";
    var seed = options.agent && options.agent.id === agentId ? options.agent : null;
    var agent = seed;
    var groups = Array.isArray(options.groups) ? options.groups.slice() : [];
    var groupsKnown = Array.isArray(options.groups);
    var partial = !!seed && !("group_id" in seed);
    var busy = false;
    var interacted = false;

    var permSaved = normalizePerms(seed ? seed.permissions : null);
    var permDesired = clonePerms(permSaved);
    var permSaving = false;
    var promptOpen = false;

    function groupNameOf(target) {
      if (!target || !target.group_id) return "未分组";
      var found = groups.find(function (item) {
        return item.id === target.group_id;
      });
      return found ? found.name : "未分组";
    }

    var ctrl = (options.panel ? openSidePanel : openManageDialog)({
      size: "lg",
      hideHead: true,
      title: seed ? seed.name : "Agent",
      bodyHtml: seed
        ? agentManageBody(seed, groupNameOf(seed), { partial: partial, tab: currentTab })
        : emptyState("正在读取", "稍等片刻"),
      onBeforeClose: function () {
        return guardClose();
      },
    });

    function setStatus(text, isError) {
      var el = ctrl.bodyEl.querySelector("[data-manage-status]");
      if (!el) return;
      el.textContent = text || "";
      el.classList.toggle("is-error", !!isError);
    }

    function changed(message) {
      window.dispatchEvent(new CustomEvent("hivemos:sidebar-refresh"));
      if (typeof options.onChanged === "function") options.onChanged(message || "");
    }

    // Endpoint URL with the token appended: revealed once per open and
    // swapped into the info head (both the visible text and what the
    // copy button copies). When the token cannot be revealed (legacy
    // agents without a retrievable token, or any failure) the plain
    // address stays. After a rotation the old token is dead, so the row
    // falls back to the plain address until the next open.
    var endpointWithToken = null;
    function applyEndpointToken() {
      var url = endpointWithToken || mcpEndpoint();
      var text = ctrl.bodyEl.querySelector("[data-agent-endpoint]");
      if (text) {
        text.textContent = "…" + url.slice(-16);
        text.setAttribute("data-copy", url);
      }
    }
    function loadEndpointToken() {
      agentApi("POST", "/api/agents/" + encodeURIComponent(agentId) + "/reveal-token")
        .then(function (result) {
          if (!result.data || result.data.ok !== true || !result.data.token) return;
          endpointWithToken = mcpEndpoint() + "?token=" + encodeURIComponent(result.data.token);
          applyEndpointToken();
        })
        .catch(function () {});
    }

    // ---- Permission matrix (local pending state; one PATCH on save) ----

    function isPermDirty() {
      return !partial && !permsEqual(permDesired, permSaved);
    }

    function permEls() {
      return {
        matrix: ctrl.bodyEl.querySelector("[data-perm-matrix]"),
        save: ctrl.bodyEl.querySelector("[data-perm-save]"),
        summary: ctrl.bodyEl.querySelector("[data-perm-summary]"),
      };
    }

    function syncPermUI() {
      var els = permEls();
      if (els.matrix) {
        Array.prototype.forEach.call(els.matrix.querySelectorAll("[data-perm-cell]"), function (input) {
          var cell = permDesired[input.getAttribute("data-perm-cell")];
          input.checked = !!(cell && cell[input.getAttribute("data-perm-op")]);
        });
        Array.prototype.forEach.call(els.matrix.querySelectorAll("[data-perm-adv]"), function (input) {
          var cell = permDesired.advanced[input.getAttribute("data-perm-adv")];
          input.checked = !!(cell && cell[input.getAttribute("data-perm-op")]);
        });
      }
      var dirty = isPermDirty();
      if (els.save) {
        els.save.disabled = !dirty || permSaving;
        els.save.classList.toggle("is-dirty", dirty);
      }
    }

    function updatePermSummary() {
      var els = permEls();
      if (els.summary && agent) els.summary.textContent = permTextOf(agent);
    }

    function setPermCell(domain, op, on) {
      if (partial || !domain || !permDesired[domain]) return;
      interacted = true;
      permDesired[domain][op] = !!on;
      syncPermUI();
    }

    function setPermAdvanced(key, op, on) {
      if (partial || !key || !(key in permDesired.advanced)) return;
      interacted = true;
      permDesired.advanced[key][op] = !!on;
      syncPermUI();
    }

    function clearPerms() {
      if (partial) return;
      interacted = true;
      permDesired = emptyPerms();
      syncPermUI();
    }

    function flashPermSaved() {
      var els = permEls();
      if (!els.save) return;
      var btn = els.save;
      btn.textContent = "已保存";
      btn.classList.add("is-saved");
      setTimeout(function () {
        if (btn.isConnected) {
          btn.textContent = "保存权限";
          btn.classList.remove("is-saved");
        }
      }, 1600);
    }

    function savePerms() {
      if (permSaving) return Promise.resolve(false);
      if (!isPermDirty()) return Promise.resolve(true);
      permSaving = true;
      syncPermUI();
      var target = clonePerms(permDesired);
      return agentApi("PATCH", "/api/agents/" + encodeURIComponent(agentId), { permissions: target })
        .then(function (result) {
          permSaving = false;
          if (result.status === 401) {
            location.assign("/login.html");
            return false;
          }
          if (!result.data || result.data.ok !== true) {
            setStatus((result.data && result.data.error) || "权限没有保存，请重试", true);
            syncPermUI();
            return false;
          }
          permSaved = clonePerms(target);
          if (agent) agent.permissions = clonePerms(target);
          updatePermSummary();
          syncPermUI();
          flashPermSaved();
          setStatus("已保存权限", false);
          changed("已保存权限");
          return true;
        })
        .catch(function () {
          permSaving = false;
          setStatus("网络异常，请重试", true);
          syncPermUI();
          return false;
        });
    }

    function promptPendingPerms(saveLabel, discardLabel) {
      if (!isPermDirty()) return Promise.resolve("saved");
      if (promptOpen) return Promise.resolve("stay");
      promptOpen = true;
      return new Promise(function (resolve) {
        var slot = ctrl.confirmSlot;
        var panel = document.createElement("div");
        panel.className = "confirm-panel";
        panel.setAttribute("role", "group");
        panel.setAttribute("aria-label", "权限未保存");
        var text = document.createElement("p");
        text.textContent = "权限改动还没有保存，离开前要保存吗？";
        var actions = document.createElement("div");
        actions.className = "confirm-actions";
        var saveBtn = document.createElement("button");
        saveBtn.type = "button";
        saveBtn.textContent = saveLabel;
        var discardBtn = document.createElement("button");
        discardBtn.type = "button";
        discardBtn.className = "secondary";
        discardBtn.textContent = discardLabel;
        var stayBtn = document.createElement("button");
        stayBtn.type = "button";
        stayBtn.className = "secondary";
        stayBtn.textContent = "继续编辑";
        actions.append(saveBtn, discardBtn, stayBtn);
        panel.append(text, actions);
        slot.append(panel);
        function finish(value) {
          promptOpen = false;
          panel.remove();
          resolve(value);
        }
        saveBtn.addEventListener("click", function () {
          saveBtn.disabled = true;
          savePerms().then(function (ok) {
            finish(ok ? "saved" : "stay");
          });
        });
        discardBtn.addEventListener("click", function () {
          permDesired = clonePerms(permSaved);
          syncPermUI();
          finish("discarded");
        });
        stayBtn.addEventListener("click", function () {
          finish("stay");
        });
        saveBtn.focus();
      });
    }

    function guardClose() {
      if (!isPermDirty()) return true;
      return promptPendingPerms("保存并退出", "不保存退出").then(function (r) {
        return r !== "stay";
      });
    }

    function guardAction() {
      if (!isPermDirty()) return Promise.resolve(true);
      return promptPendingPerms("保存并继续", "不保存").then(function (r) {
        return r !== "stay";
      });
    }

    // ---- Data: render from the seed at once; verify silently in background ----

    function refresh(settings) {
      var silent = !!(settings && settings.silent);
      return Promise.all([agentApi("GET", "/api/agents"), agentApi("GET", "/api/groups?scope=agent")])
        .then(function (results) {
          if (results[0].status === 401) {
            location.assign("/login.html");
            return;
          }
          var list = results[0].data && results[0].data.ok === true ? results[0].data.agents || [] : [];
          var freshGroups = results[1].data && results[1].data.ok === true ? results[1].data.groups || [] : [];
          var fresh =
            list.find(function (item) {
              return item.id === agentId;
            }) || null;
          if (!fresh) {
            if (!silent || !agent) {
              ctrl.setTitle("Agent");
              ctrl.setBody(emptyState("找不到这个 Agent", "它可能已经被停用或删除"));
            }
            return;
          }
          var dataChanged =
            !agent ||
            partial ||
            JSON.stringify(fresh) !== JSON.stringify(agent) ||
            JSON.stringify(freshGroups) !== JSON.stringify(groups);
          groups = freshGroups;
          groupsKnown = true;
          agent = fresh;
          partial = false;
          if (!isPermDirty() && !permSaving) {
            permSaved = normalizePerms(fresh.permissions);
            permDesired = clonePerms(permSaved);
          }
          if (!dataChanged) return;
          if (silent && (interacted || busy)) return;
          ctrl.setTitle(fresh.name);
          ctrl.setBody(agentManageBody(fresh, groupNameOf(fresh), { recordsHtml: agentRecordsHtml, tab: currentTab }));
          syncPermUI();
          applyEndpointToken();
        })
        .catch(function () {
          if (!silent) ctrl.setBody(emptyState("读取失败", "网络异常，请稍后重试"));
        });
    }

    function patch(body, okMessage) {
      if (busy || !agent) return Promise.resolve(false);
      interacted = true;
      busy = true;
      return agentApi("PATCH", "/api/agents/" + encodeURIComponent(agent.id), body)
        .then(function (result) {
          busy = false;
          if (result.status === 401) {
            location.assign("/login.html");
            return false;
          }
          if (!result.data || result.data.ok !== true) {
            var message = (result.data && result.data.error) || "没有保存，请重试";
            return refresh().then(function () {
              setStatus(message, true);
              return false;
            });
          }
          changed(okMessage);
          return refresh().then(function () {
            setStatus(okMessage, false);
            return true;
          });
        })
        .catch(function () {
          busy = false;
          setStatus("网络异常，请重试", true);
          return false;
        });
    }

    function doRename() {
      guardAction().then(function (ok) {
        if (ok) openRenameForm();
      });
    }

    function openRenameForm() {
      openFormDialog({
        title: "改名",
        bodyHtml:
          "<label>名字" +
          "<input data-field=\"name\" name=\"name\" maxlength=\"64\" autocomplete=\"off\" value=\"" +
          escapeHtml(agent.name) +
          "\" /></label>",
        submitLabel: "保存",
        onSubmit: function (c) {
          var input = c.form.querySelector("[data-field=\"name\"]");
          var name = input ? input.value.trim() : "";
          if (!name) {
            c.setError("请填写设备名字");
            return;
          }
          c.setBusy(true);
          patch({ name: name }, "已改名").then(function (ok) {
            c.setBusy(false);
            if (ok) c.close();
          });
        },
      });
    }

    function doMove() {
      guardAction().then(function (ok) {
        if (!ok) return;
        if (!groupsKnown) {
          initialRefresh.then(function () {
            openMoveForm();
          });
          return;
        }
        openMoveForm();
      });
    }

    function openMoveForm() {
      openFormDialog({
        title: "移动分组",
        bodyHtml: "<label>分组" + groupSelect("group_id", groups, agent.group_id || "") + "</label>",
        submitLabel: "保存",
        onSubmit: function (c) {
          var input = c.form.querySelector("[data-field=\"group_id\"]");
          var groupId = input ? input.value : "";
          c.setBusy(true);
          patch({ group_id: groupId || null }, "已移动分组").then(function (ok) {
            c.setBusy(false);
            if (ok) c.close();
          });
        },
      });
    }

    // ---- Avatar picker ----
    // Three mutually exclusive sources in one form, shaped like a chat
    // sticker panel: a searchable library grid with a recent row, an
    // upload pane (center-cropped to a 128x128 square client-side), and
    // an external-link pane that only saves after its preview loads.

    var AVATAR_RECENT_KEY = "hivemos-avatar-recent";
    var avatarDialog = null;

    function avatarRecents() {
      try {
        var raw = JSON.parse(localStorage.getItem(AVATAR_RECENT_KEY) || "[]");
        return Array.isArray(raw)
          ? raw.filter(function (id) {
              return typeof id === "string";
            })
          : [];
      } catch (error) {
        return [];
      }
    }

    function pushAvatarRecent(id) {
      try {
        var list = avatarRecents().filter(function (item) {
          return item !== id;
        });
        list.unshift(id);
        localStorage.setItem(AVATAR_RECENT_KEY, JSON.stringify(list.slice(0, 8)));
      } catch (error) {}
    }

    function loadAvatarCatalog() {
      if (window.HiveAvatars) return Promise.resolve(window.HiveAvatars);
      return new Promise(function (resolve, reject) {
        var script = document.createElement("script");
        script.src = "/avatars.js";
        script.onload = function () {
          if (window.HiveAvatars) resolve(window.HiveAvatars);
          else reject(new Error("catalog missing"));
        };
        script.onerror = function () {
          reject(new Error("catalog load failed"));
        };
        document.head.append(script);
      });
    }

    function doAvatar() {
      guardAction().then(function (ok) {
        if (ok) openAvatarPicker();
      });
    }

    function openAvatarPicker() {
      if (!agent) return;
      ensureAvatarStyles();
      loadAvatarCatalog()
        .then(function (catalog) {
          buildAvatarPicker(catalog);
        })
        .catch(function () {
          setStatus("图标库加载失败，请重试", true);
        });
    }

    function buildAvatarPicker(catalog) {
      if (avatarDialog) avatarDialog.close();
      var target = agent;
      var pickerBusy = false;
      var pendingBlob = null;
      var pendingPreviewUrl = "";
      var linkOk = false;
      var currentPane = "icons";
      var linkTimer = null;

      var dialog = document.createElement("dialog");
      dialog.className = "modal size-sm";
      dialog.setAttribute("aria-label", "更换头像");
      var card = document.createElement("div");
      card.className = "modal-card";
      var heading = document.createElement("h2");
      heading.className = "modal-title";
      heading.textContent = "更换头像";
      var body = document.createElement("div");
      body.className = "modal-body avatar-picker";
      body.innerHTML =
        '<div class="page-tabs" role="tablist" aria-label="头像来源">' +
        '<button type="button" class="page-tab" role="tab" data-avatar-tab="icons" aria-selected="true">图标库</button>' +
        '<button type="button" class="page-tab" role="tab" data-avatar-tab="upload" aria-selected="false">上传图片</button>' +
        '<button type="button" class="page-tab" role="tab" data-avatar-tab="link" aria-selected="false">图片链接</button>' +
        "</div>" +
        '<p class="callout danger" role="alert" data-avatar-error hidden></p>' +
        '<div data-avatar-pane="icons">' +
        '<label class="avatar-search-label">搜索<input data-avatar-search type="search" placeholder="搜索图标名称或关键词" autocomplete="off" /></label>' +
        "<div data-avatar-results></div>" +
        "</div>" +
        '<div data-avatar-pane="upload" hidden>' +
        '<div class="avatar-preview" data-avatar-upload-preview></div>' +
        '<input type="file" accept="image/*" data-avatar-file hidden />' +
        '<div class="manage-actions">' +
        '<button type="button" class="secondary" data-avatar-choose>选择图片</button>' +
        "</div>" +
        '<p class="subtle">选图后自动居中裁剪为方图，文件不超过 200 KB</p>' +
        "</div>" +
        '<div data-avatar-pane="link" hidden>' +
        '<label>图片链接<input data-avatar-url type="url" inputmode="url" placeholder="https://example.com/avatar.png" autocomplete="off" /></label>' +
        '<div class="avatar-preview" data-avatar-link-preview hidden><img alt="头像预览" /></div>' +
        '<p class="subtle" data-avatar-link-hint>输入 http 或 https 链接，预览加载成功后才能保存</p>' +
        "</div>" +
        '<div class="manage-actions avatar-picker-foot">' +
        '<button type="button" class="secondary" data-avatar-default>恢复默认</button>' +
        '<span class="avatar-picker-right">' +
        '<button type="button" class="secondary" data-avatar-cancel>取消</button>' +
        '<button type="button" data-avatar-save disabled hidden>保存</button>' +
        "</span>" +
        "</div>";
      card.append(heading, body);
      dialog.append(card);
      document.body.append(dialog);

      var ctrl = {
        dialog: dialog,
        close: function () {
          if (dialog.open) dialog.close();
        },
      };
      avatarDialog = ctrl;

      var searchInput = body.querySelector("[data-avatar-search]");
      var resultsBox = body.querySelector("[data-avatar-results]");
      var errorBox = body.querySelector("[data-avatar-error]");
      var fileInput = body.querySelector("[data-avatar-file]");
      var uploadPreview = body.querySelector("[data-avatar-upload-preview]");
      var urlInput = body.querySelector("[data-avatar-url]");
      var linkPreview = body.querySelector("[data-avatar-link-preview]");
      var linkPreviewImg = linkPreview.querySelector("img");
      var linkHint = body.querySelector("[data-avatar-link-hint]");
      var saveBtn = body.querySelector("[data-avatar-save]");
      var LINK_HINT_DEFAULT = "输入 http 或 https 链接，预览加载成功后才能保存";

      function showAvatarError(message) {
        if (message) {
          errorBox.textContent = message;
          errorBox.hidden = false;
        } else {
          errorBox.textContent = "";
          errorBox.hidden = true;
        }
      }

      function cellHtml(icon) {
        var current =
          target.avatar_icon === icon.id && !target.has_custom_avatar && !target.avatar_url;
        return (
          '<button type="button" class="avatar-cell' +
          (current ? " is-current" : "") +
          '" data-avatar-icon="' +
          escapeHtml(icon.id) +
          '" title="' +
          escapeHtml(icon.name) +
          '"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/icons.svg#avatar-' +
          escapeHtml(icon.id) +
          '"></use></svg><span>' +
          escapeHtml(icon.name) +
          "</span></button>"
        );
      }

      function renderAvatarResults() {
        var keyword = searchInput ? searchInput.value : "";
        var html = "";
        if (String(keyword || "").trim()) {
          var hits = catalog.search(keyword);
          html = hits.length
            ? '<div class="avatar-grid">' + hits.map(cellHtml).join("") + "</div>"
            : '<p class="subtle">没有找到匹配的图标</p>';
        } else {
          var recents = avatarRecents().filter(function (id) {
            return catalog.byId(id);
          });
          if (recents.length) {
            html +=
              '<h3 class="avatar-cat">最近使用</h3><div class="avatar-grid">' +
              recents
                .map(function (id) {
                  return cellHtml(catalog.byId(id));
                })
                .join("") +
              "</div>";
          }
          catalog.categories.forEach(function (cat) {
            var items = catalog.icons.filter(function (icon) {
              return icon.cat === cat.key;
            });
            html +=
              '<h3 class="avatar-cat">' +
              escapeHtml(cat.label) +
              '</h3><div class="avatar-grid">' +
              items.map(cellHtml).join("") +
              "</div>";
          });
        }
        resultsBox.innerHTML = html;
      }

      // One save button in the footer serves the upload and link panes;
      // the icon library applies instantly and never shows it.
      function syncAvatarSave() {
        if (currentPane === "upload") {
          saveBtn.hidden = false;
          saveBtn.disabled = !pendingBlob;
        } else if (currentPane === "link") {
          saveBtn.hidden = false;
          saveBtn.disabled = !linkOk;
        } else {
          saveBtn.hidden = true;
        }
      }

      function showPane(name) {
        Array.prototype.forEach.call(body.querySelectorAll("[data-avatar-tab]"), function (tab) {
          tab.setAttribute("aria-selected", tab.getAttribute("data-avatar-tab") === name ? "true" : "false");
        });
        Array.prototype.forEach.call(body.querySelectorAll("[data-avatar-pane]"), function (pane) {
          pane.hidden = pane.getAttribute("data-avatar-pane") !== name;
        });
        currentPane = name;
        syncAvatarSave();
      }

      function finishAvatarChange(message) {
        changed(message);
        ctrl.close();
        refresh().then(function () {
          setStatus(message, false);
        });
      }

      function applyAvatarIcon(id) {
        if (pickerBusy) return;
        pickerBusy = true;
        showAvatarError("");
        patch({ avatar_icon: id }, "已更新头像").then(function (ok) {
          pickerBusy = false;
          if (ok) {
            pushAvatarRecent(id);
            ctrl.close();
          } else {
            showAvatarError("没有保存成功，请重试");
          }
        });
      }

      function processAvatarFile(file) {
        if (!file) return;
        if (!/^image\//.test(file.type || "")) {
          showAvatarError("请选择图片文件");
          return;
        }
        showAvatarError("");
        var objectUrl = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          var side = Math.min(img.naturalWidth, img.naturalHeight);
          if (!side) {
            URL.revokeObjectURL(objectUrl);
            showAvatarError("这张图片打不开，请换一张");
            return;
          }
          var canvas = document.createElement("canvas");
          canvas.width = 128;
          canvas.height = 128;
          var ctx = canvas.getContext("2d");
          ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 128, 128);
          URL.revokeObjectURL(objectUrl);
          var wantsPng = file.type === "image/png";
          canvas.toBlob(
            function (blob) {
              if (!blob) {
                showAvatarError("图片处理失败，请换一张");
                return;
              }
              if (blob.size > 200 * 1024 && wantsPng) {
                canvas.toBlob(
                  function (jpegBlob) {
                    if (jpegBlob && jpegBlob.size <= 200 * 1024) acceptUploadBlob(jpegBlob);
                    else showAvatarError("图片压缩后仍超过 200 KB，请换一张");
                  },
                  "image/jpeg",
                  0.88,
                );
                return;
              }
              if (blob.size > 200 * 1024) {
                showAvatarError("图片压缩后仍超过 200 KB，请换一张");
                return;
              }
              acceptUploadBlob(blob);
            },
            wantsPng ? "image/png" : "image/jpeg",
            0.92,
          );
        };
        img.onerror = function () {
          URL.revokeObjectURL(objectUrl);
          showAvatarError("这张图片打不开，请换一张");
        };
        img.src = objectUrl;
      }

      function acceptUploadBlob(blob) {
        pendingBlob = blob;
        if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
        pendingPreviewUrl = URL.createObjectURL(blob);
        uploadPreview.innerHTML = '<img alt="头像预览" src="' + pendingPreviewUrl + '" />';
        syncAvatarSave();
      }

      function saveAvatarUpload() {
        if (!pendingBlob || pickerBusy) return;
        pickerBusy = true;
        showAvatarError("");
        fetch("/api/agents/" + encodeURIComponent(target.id) + "/avatar", {
          method: "POST",
          headers: { "content-type": pendingBlob.type || "application/octet-stream", accept: "application/json" },
          body: pendingBlob,
        })
          .then(function (response) {
            return response
              .json()
              .catch(function () {
                return {};
              })
              .then(function (data) {
                return { status: response.status, data: data || {} };
              });
          })
          .then(function (result) {
            pickerBusy = false;
            if (result.status === 401) {
              location.assign("/login.html");
              return;
            }
            if (!result.data || result.data.ok !== true) {
              showAvatarError((result.data && result.data.error) || "没有保存成功，请重试");
              return;
            }
            finishAvatarChange("已更新头像");
          })
          .catch(function () {
            pickerBusy = false;
            showAvatarError("网络异常，请重试");
          });
      }

      function checkLinkPreview() {
        var value = urlInput.value.trim();
        linkOk = false;
        syncAvatarSave();
        if (!value) {
          linkPreview.hidden = true;
          linkHint.textContent = LINK_HINT_DEFAULT;
          return;
        }
        if (!/^https?:\/\//i.test(value)) {
          linkPreview.hidden = true;
          linkHint.textContent = "链接要以 http:// 或 https:// 开头";
          return;
        }
        linkHint.textContent = "正在加载预览…";
        var probe = new Image();
        probe.onload = function () {
          if (urlInput.value.trim() !== value) return;
          linkOk = true;
          linkPreviewImg.src = value;
          linkPreview.hidden = false;
          syncAvatarSave();
          linkHint.textContent = "预览加载成功，可以保存";
        };
        probe.onerror = function () {
          if (urlInput.value.trim() !== value) return;
          linkPreview.hidden = true;
          linkHint.textContent = "预览加载失败，请检查链接是否正确";
        };
        probe.src = value;
      }

      function saveAvatarLink() {
        var value = urlInput.value.trim();
        if (!linkOk || !value || pickerBusy) return;
        pickerBusy = true;
        showAvatarError("");
        patch({ avatar_url: value }, "已更新头像").then(function (ok) {
          pickerBusy = false;
          if (ok) ctrl.close();
          else showAvatarError("没有保存成功，请检查链接后重试");
        });
      }

      function restoreDefaultAvatar() {
        if (pickerBusy) return;
        pickerBusy = true;
        showAvatarError("");
        var removeUpload = target.has_custom_avatar
          ? fetch("/api/agents/" + encodeURIComponent(target.id) + "/avatar", {
              method: "DELETE",
              headers: { accept: "application/json" },
            }).then(function (response) {
              return response.status !== 401;
            })
          : Promise.resolve(true);
        removeUpload
          .then(function (kept) {
            if (!kept) {
              location.assign("/login.html");
              return false;
            }
            return patch({ avatar_icon: null, avatar_url: null }, "已恢复默认头像");
          })
          .then(function (ok) {
            pickerBusy = false;
            if (ok) ctrl.close();
            else if (ok === false) showAvatarError("没有恢复成功，请重试");
          })
          .catch(function () {
            pickerBusy = false;
            showAvatarError("网络异常，请重试");
          });
      }

      dialog.addEventListener("click", function (event) {
        var eventTarget = event.target;
        if (eventTarget === dialog) {
          ctrl.close();
          return;
        }
        if (!(eventTarget instanceof Element)) return;
        var tab = eventTarget.closest("[data-avatar-tab]");
        if (tab) {
          showPane(tab.getAttribute("data-avatar-tab"));
          return;
        }
        var cell = eventTarget.closest("[data-avatar-icon]");
        if (cell) {
          applyAvatarIcon(cell.getAttribute("data-avatar-icon"));
          return;
        }
        if (eventTarget.closest("[data-avatar-choose]")) {
          fileInput.click();
          return;
        }
        if (eventTarget.closest("[data-avatar-save]")) {
          if (currentPane === "upload") saveAvatarUpload();
          else if (currentPane === "link") saveAvatarLink();
          return;
        }
        if (eventTarget.closest("[data-avatar-default]")) {
          restoreDefaultAvatar();
          return;
        }
        if (eventTarget.closest("[data-avatar-cancel]")) ctrl.close();
      });
      dialog.addEventListener("input", function (event) {
        if (event.target === searchInput) renderAvatarResults();
        if (event.target === urlInput) {
          if (linkTimer) clearTimeout(linkTimer);
          linkTimer = setTimeout(checkLinkPreview, 350);
        }
      });
      dialog.addEventListener("change", function (event) {
        if (event.target === fileInput) {
          processAvatarFile(fileInput.files && fileInput.files[0]);
          fileInput.value = "";
        }
      });
      dialog.addEventListener("close", function () {
        if (linkTimer) clearTimeout(linkTimer);
        if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl);
        if (avatarDialog === ctrl) avatarDialog = null;
        dialog.remove();
      });

      if (target.has_custom_avatar) {
        uploadPreview.innerHTML =
          '<img alt="当前头像" src="/api/agents/' + encodeURIComponent(target.id) + '/avatar" />';
      } else if (target.avatar_url) {
        uploadPreview.innerHTML = '<img alt="当前头像" src="' + escapeHtml(target.avatar_url) + '" />';
        urlInput.value = target.avatar_url;
        showPane("link");
        checkLinkPreview();
      } else if (target.avatar_icon) {
        uploadPreview.innerHTML =
          '<svg class="icon" viewBox="0 0 24 24" width="96" height="96" aria-hidden="true"><use href="/icons.svg#avatar-' +
          escapeHtml(target.avatar_icon) +
          '"></use></svg>';
      } else {
        uploadPreview.innerHTML =
          '<svg class="icon" viewBox="0 0 24 24" width="96" height="96" aria-hidden="true"><use href="/icons.svg#icon-bot"></use></svg>';
      }
      renderAvatarResults();
      dialog.showModal();
    }

    function doRotate() {
      guardAction().then(function (ok) {
        if (ok) openRotateConfirm();
      });
    }

    function openRotateConfirm() {
      askConfirm({
        anchor: ctrl.confirmSlot,
        title: "轮换令牌",
        text: "确认轮换「" + agent.name + "」的令牌吗？旧令牌会立即失效",
        confirmLabel: "轮换",
        danger: true,
      }).then(function (yes) {
        if (!yes || busy) return;
        busy = true;
        agentApi("POST", "/api/agents/" + encodeURIComponent(agent.id) + "/rotate")
          .then(function (result) {
            busy = false;
            if (result.status === 401) {
              location.assign("/login.html");
              return;
            }
            if (!result.data || result.data.ok !== true || !result.data.token) {
              setStatus((result.data && result.data.error) || "没有轮换成功，请重试", true);
              return;
            }
            changed("已轮换令牌");
            endpointWithToken = null;
            applyEndpointToken();
            var resultDialog = openFormDialog({
              title: "新令牌",
              bodyHtml: "",
              submitLabel: "完成",
              onSubmit: function (c) {
                c.close();
              },
            });
            resultDialog.showResult(
              "<p>新令牌只显示这一次。旧令牌已经失效，请立刻复制并换到设备上</p>" + copyLine(result.data.token, "复制令牌"),
              "我已复制",
            );
          })
          .catch(function () {
            busy = false;
            setStatus("网络异常，请重试", true);
          });
      });
    }

    function doDisable() {
      guardAction().then(function (ok) {
        if (!ok) return;
        busy = true;
        agentApi("PATCH", "/api/agents/" + encodeURIComponent(agent.id), { status: "disabled" })
          .then(function (result) {
            busy = false;
            if (result.status === 401) {
              location.assign("/login.html");
              return;
            }
            if (!result.data || result.data.ok !== true) {
              setStatus((result.data && result.data.error) || "没有停用成功，请重试", true);
              return;
            }
            ctrl.forceClose();
            changed("已停用");
          })
          .catch(function () {
            busy = false;
            setStatus("网络异常，请重试", true);
          });
      });
    }

    function doDelete() {
      guardAction().then(function (ok) {
        if (ok) openDeleteConfirm();
      });
    }

    function doEnable() {
      guardAction().then(function (ok) {
        if (!ok) return;
        busy = true;
        agentApi("PATCH", "/api/agents/" + encodeURIComponent(agent.id), { status: "active" })
          .then(function (result) {
            busy = false;
            if (result.status === 401) {
              location.assign("/login.html");
              return;
            }
            if (!result.data || result.data.ok !== true) {
              setStatus((result.data && result.data.error) || "没有启用成功，请重试", true);
              return;
            }
            ctrl.forceClose();
            changed("已启用");
          })
          .catch(function () {
            busy = false;
            setStatus("网络异常，请重试", true);
          });
      });
    }

    function openDeleteConfirm() {
      askConfirm({
        anchor: ctrl.confirmSlot,
        title: "删除 Agent",
        text:
          "确定要删除 Agent「" +
          agent.name +
          "」吗？删除后不可恢复，该 Agent 将无法再访问，它写下的 Soul、记忆等数据会保留",
        confirmLabel: "删除",
        danger: true,
      }).then(function (yes) {
        if (!yes || busy) return;
        busy = true;
        agentApi("DELETE", "/api/agents/" + encodeURIComponent(agent.id))
          .then(function (result) {
            busy = false;
            if (result.status === 401) {
              location.assign("/login.html");
              return;
            }
            if (!result.data || result.data.ok !== true) {
              setStatus((result.data && result.data.error) || "没有删除成功，请重试", true);
              return;
            }
            ctrl.forceClose();
            changed("已删除");
          })
          .catch(function () {
            busy = false;
            setStatus("网络异常，请重试", true);
          });
      });
    }

    ctrl.dialog.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-perm-clear]")) {
        clearPerms();
        return;
      }
      if (target.closest("[data-perm-save]")) {
        savePerms();
        return;
      }
      var actBtn = target.closest("[data-agent-act]");
      if (!actBtn || busy || !agent) return;
      var act = actBtn.getAttribute("data-agent-act");
      interacted = true;
      if (act === "rename") doRename();
      else if (act === "move") doMove();
      else if (act === "rotate") doRotate();
      else if (act === "disable") doDisable();
      else if (act === "delete") doDelete();
      else if (act === "enable") doEnable();
      else if (act === "avatar") doAvatar();
    });

    ctrl.dialog.addEventListener("change", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var cell = target.closest("[data-perm-cell]");
      if (cell) {
        setPermCell(cell.getAttribute("data-perm-cell"), cell.getAttribute("data-perm-op"), cell.checked);
        return;
      }
      var adv = target.closest("[data-perm-adv]");
      if (adv) setPermAdvanced(adv.getAttribute("data-perm-adv"), adv.getAttribute("data-perm-op"), adv.checked);
    });

    wireManageTabs(ctrl);
    ctrl.dialog.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var tabBtn = target.closest("[data-mtab]");
      if (tabBtn) currentTab = tabBtn.getAttribute("data-mtab") || "overview";
    });
    syncPermUI();
    // ---- This agent's own records (local async fill; never blocks open) ----

    var agentRecordsHtml = null;

    function fillAgentRecords() {
      if (!ctrl.bodyEl || agentRecordsHtml === null) return;
      var body = ctrl.bodyEl.querySelector("[data-agent-records-body]");
      if (body) body.innerHTML = agentRecordsHtml;
    }

    function loadAgentRecords() {
      agentApi("GET", "/api/records?agent_id=" + encodeURIComponent(agentId) + "&limit=8")
        .then(function (result) {
          if (result.status === 401) {
            location.assign("/login.html");
            return;
          }
          var records =
            result.data && result.data.ok === true && Array.isArray(result.data.records) ? result.data.records : null;
          if (!records) {
            agentRecordsHtml = '<p class="subtle">访问记录暂时读不到</p>';
          } else if (!records.length) {
            agentRecordsHtml = '<p class="subtle">还没有访问记录</p>';
          } else {
            agentRecordsHtml =
              '<ol class="feed">' +
              records
                .map(function (item) {
                  return (
                    '<li><time datetime="' +
                    escapeHtml(new Date(item.at).toISOString()) +
                    '">' +
                    feedStamp(item.at) +
                    '</time><span><span class="tag">' +
                    escapeHtml(item.module_label) +
                    "</span> " +
                    escapeHtml(item.text) +
                    "</span></li>"
                  );
                })
                .join("") +
              "</ol>";
          }
          fillAgentRecords();
        })
        .catch(function () {
          agentRecordsHtml = '<p class="subtle">访问记录暂时读不到</p>';
          fillAgentRecords();
        });
    }


    var initialRefresh = refresh(seed ? { silent: true } : undefined);
    loadAgentRecords();
    loadEndpointToken();
    return ctrl;
  }

  function list(html, extraClass) {
    return '<div class="list' + (extraClass ? " " + extraClass : "") + '">' + html + "</div>";
  }

  // Card lists render as a responsive grid (two columns on desktop, one
  // on mobile); row lists keep the plain .list. See .card-grid in
  // components.css for the breakpoints.
  function cardList(html) {
    return list(html, "card-grid");
  }

  function stat(label, value, hint) {
    return (
      '<article class="card stat"><p class="stat-label">' +
      escapeHtml(label) +
      '</p><p class="stat-value">' +
      escapeHtml(value) +
      "</p>" +
      (hint ? '<p class="subtle">' + escapeHtml(hint) + "</p>" : "") +
      "</article>"
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

  function layout(body) {
    return body;
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
  var mePromise = null;

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

  function currentMe() {
    if (!mePromise) {
      mePromise = fetch("/api/auth/me", {
        headers: { accept: "application/json" },
        cache: "no-store",
      }).then(
        function (response) {
          if (!response.ok) return null;
          return response.json().then(
            function (data) {
              if (!data || data.ok !== true) return null;
              return data;
            },
            function () {
              return null;
            },
          );
        },
        function () {
          return null;
        },
      );
    }
    return mePromise;
  }

  // Layered account avatar, ported from SMSinBox's paintSidebarAvatar: the
  // uploaded custom avatar first, then the bound GitHub account's avatar,
  // then a GitHub photo when the nickname is a real GitHub handle, then a
  // DiceBear initials avatar generated from the name, then the local initial.
  // Any source that fails to load steps down to the next one.
  function paintAccountAvatar(avatar, me) {
    if (!avatar) return;
    var profileUsername =
      me && typeof me.profile_username === "string" ? me.profile_username.trim() : "";
    var loginName =
      me && me.user && typeof me.user.username === "string" ? me.user.username.trim() : "";
    var display =
      profileUsername || (me && typeof me.username === "string" ? me.username.trim() : "") || loginName;
    var initial = display ? Array.from(display)[0].toUpperCase() : "管";
    var sources = [];
    var custom = me && typeof me.avatar_data === "string" ? me.avatar_data : "";
    if (custom) sources.push(custom);
    var githubAvatar = me && typeof me.github_avatar_url === "string" ? me.github_avatar_url : "";
    if (githubAvatar) sources.push(githubAvatar);
    if (profileUsername) {
      sources.push("https://github.com/" + encodeURIComponent(profileUsername) + ".png?s=96");
    }
    var seed = profileUsername || loginName;
    if (seed) {
      sources.push("https://api.dicebear.com/10.x/initials/svg?seed=" + encodeURIComponent(seed));
    }
    var sig = initial + "|" + sources.join("|");
    if (avatar.getAttribute("data-avatar-sig") === sig) return;
    avatar.setAttribute("data-avatar-sig", sig);
    if (!sources.length) {
      avatar.textContent = initial;
      return;
    }
    var img = document.createElement("img");
    img.alt = "";
    var step = 0;
    img.addEventListener("error", function () {
      step += 1;
      if (step < sources.length) {
        img.src = sources[step];
        return;
      }
      avatar.textContent = initial;
    });
    img.src = sources[0];
    avatar.replaceChildren(img);
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
      mePromise = null;
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

  // Feed timestamp as two stacked lines: date (YY-MM-DD) over time (HH:MM).
  function feedStamp(value) {
    var time = Number(value);
    if (!Number.isFinite(time) || time <= 0) return "";
    var date = new Date(time);
    if (Number.isNaN(date.getTime())) return "";
    function pad(number) {
      return String(number).padStart(2, "0");
    }
    return (
      '<span class="feed-d">' +
      String(date.getFullYear()).slice(2) + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
      '</span><span class="feed-t">' +
      pad(date.getHours()) + ":" + pad(date.getMinutes()) +
      "</span>"
    );
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

  var currentFormDialog = null;

  // Shared form dialog built on <dialog>. The element lives on <body>,
  // outside #page, so a page render() (innerHTML swap) never destroys it;
  // it removes itself from the DOM when closed. Pages must use this instead
  // of inline page forms or window.prompt.
  // options: { title, bodyHtml, submitLabel, cancelLabel, size, wide, onSubmit, onClose }
  // size picks a width tier (see components.css); forms default to sm
  // and wide stays as an alias of lg.
  // onSubmit(ctrl) decides what happens next: ctrl.setError() keeps the
  // dialog open with a message, ctrl.showResult() swaps in a result view,
  // ctrl.close() dismisses it.
  function openFormDialog(options) {
    options = options || {};
    if (currentFormDialog) currentFormDialog.close();
    var dialog = document.createElement("dialog");
    dialog.className =
      "modal" + (options.size === "lg" || options.wide ? " size-lg" : options.size === "md" ? " size-md" : " size-sm");
    dialog.setAttribute("aria-label", options.title || "表单");
    var card = document.createElement("div");
    card.className = "modal-card";
    var heading = document.createElement("h2");
    heading.className = "modal-title";
    heading.textContent = options.title || "";
    var form = document.createElement("form");
    form.className = "modal-form";
    form.setAttribute("novalidate", "");
    var body = document.createElement("div");
    body.className = "modal-body form-grid";
    body.innerHTML = options.bodyHtml || "";
    var error = document.createElement("p");
    error.className = "field-error modal-error";
    error.hidden = true;
    var actions = document.createElement("div");
    actions.className = "modal-actions";
    if (options.actionsLeftHtml) {
      var actionsLeft = document.createElement("div");
      actionsLeft.className = "modal-actions-left";
      actionsLeft.innerHTML = options.actionsLeftHtml;
      actions.append(actionsLeft);
    }
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = options.cancelLabel || "取消";
    var submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = options.submitLabel || "保存";
    actions.append(cancel, submit);
    form.append(body, error, actions);
    card.append(heading, form);
    dialog.append(card);
    document.body.append(dialog);

    var submitLabel = submit.textContent;
    var ctrl = {
      dialog: dialog,
      form: form,
      close: function () {
        if (dialog.open) dialog.close();
      },
      setError: function (message) {
        if (message) {
          error.textContent = message;
          error.hidden = false;
        } else {
          error.textContent = "";
          error.hidden = true;
        }
      },
      setBusy: function (busy) {
        submit.disabled = !!busy;
        cancel.disabled = !!busy;
        submit.textContent = busy ? "处理中…" : submitLabel;
      },
      setBody: function (html) {
        body.innerHTML = html;
      },
      showResult: function (html, closeLabel) {
        body.innerHTML = html;
        error.hidden = true;
        submit.hidden = true;
        cancel.disabled = false;
        cancel.textContent = closeLabel || "完成";
        cancel.focus();
      },
    };
    currentFormDialog = ctrl;
    cancel.addEventListener("click", function () {
      ctrl.close();
    });
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) ctrl.close();
    });
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      ctrl.setError("");
      if (typeof options.onSubmit === "function") options.onSubmit(ctrl);
    });
    dialog.addEventListener("close", function () {
      document.body.classList.remove("modal-open");
      if (currentFormDialog === ctrl) currentFormDialog = null;
      dialog.remove();
      if (typeof options.onClose === "function") options.onClose();
    });
    dialog.showModal();
    document.body.classList.add("modal-open");
    var first = form.querySelector("input, textarea, select");
    if (first) first.focus();
    return ctrl;
  }


  var currentActionMenu = null;

  // Centered floating action menu for per-item management actions. One
  // shared implementation for every page: a modal dialog centered on
  // screen (phones included, never an edge drawer); backdrop click and Esc
  // close it. Selecting an item closes the menu first, then runs the
  // onSelect of the item; items that need a form open openFormDialog from
  // there. options: { title, items: [{ label, hint, danger, onSelect }],
  // cancelLabel }
  function openActionMenu(options) {
    options = options || {};
    if (currentActionMenu) currentActionMenu.close();
    var dialog = document.createElement("dialog");
    dialog.className = "action-menu";
    dialog.setAttribute("aria-label", options.title || "操作菜单");
    var card = document.createElement("div");
    card.className = "action-menu-card";
    if (options.title) {
      var heading = document.createElement("h2");
      heading.className = "action-menu-title";
      heading.textContent = options.title;
      card.append(heading);
    }
    var listBox = document.createElement("div");
    listBox.className = "action-menu-list";
    (options.items || []).forEach(function (item) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "action-menu-item" + (item.danger ? " danger" : "");
      var label = document.createElement("span");
      label.textContent = item.label || "";
      button.append(label);
      if (item.hint) {
        var hint = document.createElement("span");
        hint.className = "action-menu-hint";
        hint.textContent = item.hint;
        button.append(hint);
      }
      button.addEventListener("click", function () {
        ctrl.close();
        if (typeof item.onSelect === "function") item.onSelect();
      });
      listBox.append(button);
    });
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "action-menu-item cancel";
    cancel.textContent = options.cancelLabel || "取消";
    cancel.addEventListener("click", function () {
      ctrl.close();
    });
    listBox.append(cancel);
    card.append(listBox);
    dialog.append(card);
    document.body.append(dialog);
    var ctrl = {
      dialog: dialog,
      close: function () {
        if (dialog.open) dialog.close();
      },
    };
    currentActionMenu = ctrl;
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) ctrl.close();
    });
    dialog.addEventListener("close", function () {
      document.body.classList.remove("modal-open");
      if (currentActionMenu === ctrl) currentActionMenu = null;
      dialog.remove();
    });
    dialog.showModal();
    document.body.classList.add("modal-open");
    return ctrl;
  }

    // Info zones (record manage targets) are focusable buttons: Enter and
  // Space open the management dialog through the page click delegation.
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    var target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.hasAttribute("data-manage")) return;
    event.preventDefault();
    target.click();
  });

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


  // ---- Custom select enhancer ------------------------------------------------
  // Native <select> elements stay in the DOM as the data source: every
  // existing .value read, FormData harvest and change listener keeps
  // working. Each select gets a styled button + popover list next to it.
  // Skip a select with data-cs-skip; call C.refreshSelects(root) after
  // refilling options from code so the button label re-syncs.
  var csOpenWrap = null;

  function csLabelOf(select) {
    var opt = select.options[select.selectedIndex];
    return opt ? opt.textContent : "";
  }

  function csSyncWrap(wrap) {
    var select = wrap.querySelector("select.cs-native");
    if (!select) return;
    var label = wrap.querySelector(".cs-label");
    if (label) label.textContent = csLabelOf(select);
    var btn = wrap.querySelector(".cs-btn");
    if (btn) btn.disabled = !!select.disabled;
  }

  function csBuildList(wrap) {
    var select = wrap.querySelector("select.cs-native");
    var list = wrap.querySelector(".cs-list");
    if (!select || !list) return;
    if (!select.options.length) {
      list.innerHTML = '<div class="cs-empty">无可选项</div>';
      return;
    }
    var html = "";
    Array.prototype.forEach.call(select.options, function (opt, idx) {
      var selected = idx === select.selectedIndex;
      html +=
        '<button type="button" class="cs-opt' +
        (selected ? " is-selected" : "") +
        '" role="option" data-cs-index="' +
        idx +
        '" aria-selected="' +
        (selected ? "true" : "false") +
        '"' +
        (opt.disabled ? " disabled" : "") +
        '><span class="cs-opt-text">' +
        escapeHtml(opt.textContent) +
        "</span>" +
        (selected
          ? '<svg class="icon cs-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
          : "") +
        "</button>";
    });
    list.innerHTML = html;
  }

  function csCloseList() {
    if (!csOpenWrap) return;
    var list = csOpenWrap.querySelector(".cs-list");
    if (list) list.hidden = true;
    var btn = csOpenWrap.querySelector(".cs-btn");
    if (btn) btn.setAttribute("aria-expanded", "false");
    csOpenWrap = null;
  }

  function csOpenList(wrap) {
    if (csOpenWrap === wrap) return;
    csCloseList();
    csBuildList(wrap);
    var list = wrap.querySelector(".cs-list");
    var btn = wrap.querySelector(".cs-btn");
    if (list) list.hidden = false;
    if (btn) btn.setAttribute("aria-expanded", "true");
    csOpenWrap = wrap;
  }

  function enhanceSelect(select) {
    if (!select || select.dataset.csEnhanced) return;
    if (select.hasAttribute("data-cs-skip") || select.multiple || select.size > 1) return;
    if (!select.parentNode) return;
    select.dataset.csEnhanced = "1";
    var wrap = document.createElement("span");
    wrap.className = "cs-wrap";
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    select.classList.add("cs-native");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cs-btn";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML =
      '<span class="cs-label"></span>' +
      '<svg class="icon cs-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var list = document.createElement("div");
    list.className = "cs-list";
    list.setAttribute("role", "listbox");
    list.hidden = true;
    wrap.append(btn, list);
    csSyncWrap(wrap);
    btn.addEventListener("click", function () {
      if (btn.disabled) return;
      if (csOpenWrap === wrap) csCloseList();
      else csOpenList(wrap);
    });
    list.addEventListener("click", function (event) {
      var target = event.target instanceof Element ? event.target.closest("[data-cs-index]") : null;
      if (!target || target.disabled) return;
      var idx = Number(target.getAttribute("data-cs-index"));
      if (select.selectedIndex !== idx) {
        select.selectedIndex = idx;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      csSyncWrap(wrap);
      csCloseList();
      btn.focus();
    });
    select.addEventListener("change", function () {
      csSyncWrap(wrap);
    });
  }

  function refreshSelects(root) {
    var scope = root && root.querySelectorAll ? root : document;
    if (root && root.tagName === "SELECT") enhanceSelect(root);
    Array.prototype.forEach.call(scope.querySelectorAll("select"), enhanceSelect);
    Array.prototype.forEach.call(scope.querySelectorAll(".cs-wrap"), function (wrap) {
      csSyncWrap(wrap);
      if (csOpenWrap === wrap) csBuildList(wrap);
    });
  }

  function initCustomSelects() {
    if (!document.body) return;
    refreshSelects(document);
    document.addEventListener("click", function (event) {
      if (csOpenWrap && !csOpenWrap.contains(event.target)) csCloseList();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") csCloseList();
    });
    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        Array.prototype.forEach.call(mutation.addedNodes, function (node) {
          if (!(node instanceof Element)) return;
          if (node.tagName === "SELECT") enhanceSelect(node);
          else if (node.querySelectorAll) {
            Array.prototype.forEach.call(node.querySelectorAll("select"), enhanceSelect);
          }
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCustomSelects);
  } else {
    initCustomSelects();
  }

  window.HiveCommon = {
    escapeHtml: escapeHtml,
    maskTail: maskTail,
    statusMeta: statusMeta,
    statusPill: statusPill,
    emptyState: emptyState,
    section: section,
    badge: badge,
    explain: explain,
    facts: facts,
    record: record,
    list: list,
    cardList: cardList,
    stat: stat,
    copyLine: copyLine,
    layout: layout,
    mount: mount,
    safeNext: safeNext,
    currentUser: currentUser,
    currentMe: currentMe,
    paintAccountAvatar: paintAccountAvatar,
    logout: logout,
    formatMinute: formatMinute,
    feedStamp: feedStamp,
    askConfirm: askConfirm,
    openFormDialog: openFormDialog,
    openActionMenu: openActionMenu,
    openMenu: openMenu,
    copyText: copyText,
    openManageDialog: openManageDialog,
    closeCurrentOverlay: closeCurrentOverlay,
    openSidePanel: openSidePanel,
    openAgentManage: openAgentManage,
    manageInfoHead: manageInfoHead,
    wireManageTabs: wireManageTabs,
    mcpEndpoint: mcpEndpoint,
    permDomains: PERM_DOMAINS,
    permSummaryOf: permTextOf,
    normalizePerms: normalizePerms,
    permMatrixHtml: permMatrixHtml,
    permClone: clonePerms,
    permsEqual: permsEqual,
    emptyPerms: emptyPerms,
    metaGrid: metaGrid,
    iconSvg: iconSvg,
    agentAvatarHtml: agentAvatarHtml,
    addBar: addBar,
    groupSelect: groupSelect,
    toast: toast,
    groupedSections: groupedSections,
    refreshSelects: refreshSelects,
  };
})();
