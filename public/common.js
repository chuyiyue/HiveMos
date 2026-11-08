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
    return '<div class="empty-state"><p class="empty-title">' + escapeHtml(title) + "</p><p>" + escapeHtml(text) + "</p></div>";
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
      (options.pill ? badge(options.pill) : "") +
      (options.status ? statusPill(options.status) : "") +
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
    head.append(heading, closeBtn);
    var body = document.createElement("div");
    body.className = "manage-body";
    body.innerHTML = options.bodyHtml || "";
    var confirmSlot = document.createElement("div");
    confirmSlot.className = "confirm-slot";
    confirmSlot.setAttribute("data-manage-confirm", "");
    body.append(confirmSlot);
    card.append(head, body);
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
  var PERM_DOMAINS = [
    ["mcp", "MCP", "MCP 注册表的搜索、列表与取配置"],
    ["skills", "Skills", "Skills 的列表与取用"],
    ["api", "API", "API 条目的列表与取用"],
    ["memory", "记忆", "记忆的读写与同步"],
    ["soul", "Soul", "Soul 的读写与同步"],
    ["tasks", "任务", "任务的查看与处理"],
    ["calendar", "日历", "日程的查看与编辑"],
    ["vault", "保险库", "保险库条目的取用"],
    ["machines", "云计算资源", "服务器、云主机与 Workers 的状态与操作"],
  ];

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
    var perms = agent.permissions || [];
    if (!perms.length) return "未开启任何功能";
    var labels = perms.map(function (domain) {
      var entry = PERM_DOMAINS.find(function (item) {
        return item[0] === domain;
      });
      return entry ? entry[1] : domain;
    });
    return perms.length + " / " + PERM_DOMAINS.length + "：" + labels.join("、");
  }

  function orderedPerms(set) {
    return PERM_DOMAINS.map(function (entry) {
      return entry[0];
    }).filter(function (domain) {
      return set.has(domain);
    });
  }

  function permSetsEqual(a, b) {
    if (a.size !== b.size) return false;
    var same = true;
    a.forEach(function (domain) {
      if (!b.has(domain)) same = false;
    });
    return same;
  }

  function permTagsHtml(set) {
    var chosen = PERM_DOMAINS.filter(function (entry) {
      return set.has(entry[0]);
    });
    if (!chosen.length) return '<span class="subtle">未开启任何功能</span>';
    return chosen
      .map(function (entry) {
        return (
          '<span class="perm-tag">' +
          escapeHtml(entry[1]) +
          '<button type="button" class="perm-tag-x" data-perm-remove="' +
          escapeHtml(entry[0]) +
          '" aria-label="移除' +
          escapeHtml(entry[1]) +
          '权限">×</button></span>'
        );
      })
      .join("");
  }

  function permPickerHtml(agent) {
    var enabled = new Set(agent.permissions || []);
    var items = PERM_DOMAINS.map(function (entry) {
      var on = enabled.has(entry[0]);
      return (
        '<button type="button" class="perm-item' +
        (on ? " is-selected" : "") +
        '" role="option" aria-selected="' +
        (on ? "true" : "false") +
        '" title="' +
        escapeHtml(entry[0] + " · " + entry[2]) +
        '" data-perm-item="' +
        escapeHtml(entry[0]) +
        '"><span class="perm-item-text"><strong>' +
        escapeHtml(entry[1]) +
        '</strong><span class="perm-item-sub">' +
        escapeHtml(entry[0] + " · " + entry[2]) +
        '</span></span></button>'
      );
    }).join("");
    return (
      '<div class="perm-picker" data-perm-picker>' +
      '<input type="text" class="perm-search" data-perm-search placeholder="搜索权限" autocomplete="off" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-label="搜索并点选权限" />' +
      '<div class="perm-menu" data-perm-menu role="listbox" aria-multiselectable="true" aria-label="权限列表" hidden>' +
      items +
      '<p class="perm-menu-empty" data-perm-menu-empty hidden>没有匹配的权限</p></div>' +
      '<div class="perm-tags" data-perm-tags>' +
      permTagsHtml(enabled) +
      "</div>" +
      '<div class="perm-foot"><button type="button" class="perm-save" data-perm-save disabled>保存权限</button></div>' +
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
      "<button type=\"button\" class=\"secondary\" data-agent-act=\"move\">设置分组</button>" +
      (active ? "<button type=\"button\" class=\"secondary\" data-agent-act=\"rotate\">轮换令牌</button>" : "") +
      "</div>" +
      (active
        ? "<div class=\"manage-danger-zone\"><p class=\"subtle\">删除后该 Agent 会被停用，令牌立即失效</p>" +
          "<button type=\"button\" class=\"danger\" data-confirm-delete data-agent-act=\"disable\">删除</button></div>"
        : "<p class=\"subtle\">这个 Agent 已停用，启用后可继续调用</p>" +
          "<div class=\"manage-actions\"><button type=\"button\" data-agent-act=\"enable\">启用</button></div>");
    var permSection = partial
      ? '<p class="subtle" data-perm-pending>权限读取中</p>'
      : permPickerHtml(agent);
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
      "<div><dt>标识</dt><dd><span class=\"mono\">" +
      escapeHtml(agent.id) +
      "</span> <button type=\"button\" class=\"copy-btn\" data-copy=\"" +
      escapeHtml(agent.id) +
      "\" data-label=\"复制\">复制</button></dd></div>" +
      "<div><dt>接入地址</dt><dd><span class=\"mono\" data-agent-endpoint>" +
      escapeHtml(endpoint) +
      "</span> <button type=\"button\" class=\"copy-btn\" data-agent-endpoint-copy data-copy=\"" +
      escapeHtml(endpoint) +
      "\" data-label=\"复制\">复制</button></dd></div>" +
      "</dl></div>" +
      "<div class=\"page-tabs manage-tabs\" role=\"tablist\" aria-label=\"Agent 管理\">" +
      "<button type=\"button\" class=\"page-tab\" role=\"tab\" data-mtab=\"overview\" aria-selected=\"" + (initialTab === "overview" ? "true" : "false") + "\">概览</button>" +
      "<button type=\"button\" class=\"page-tab\" role=\"tab\" data-mtab=\"perms\" aria-selected=\"" + (initialTab === "perms" ? "true" : "false") + "\">权限</button>" +
      "<button type=\"button\" class=\"page-tab\" role=\"tab\" data-mtab=\"advanced\" aria-selected=\"" + (initialTab === "advanced" ? "true" : "false") + "\">高级设置</button>" +
      "</div>" +
      "<div data-mpanel=\"overview\"" + (initialTab === "overview" ? "" : " hidden") + ">" +
      "<dl class=\"kv\">" +
      "<div><dt>名称</dt><dd>" +
      escapeHtml(agent.name) +
      "</dd></div>" +
      "<div><dt>状态</dt><dd>" +
      (active ? "已启用" : "已停用") +
      "</dd></div>" +
      "<div><dt>分组</dt><dd>" +
      (partial ? "读取中" : escapeHtml(groupName || "未分组")) +
      "</dd></div>" +
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
      "<div class=\"agent-records\">" +
      "<h3>访问记录</h3>" +
      "<div data-agent-records-body>" +
      (opts && opts.recordsHtml ? opts.recordsHtml : '<p class="subtle">正在读取</p>') +
      "</div>" +
      "</div>" +
      "</div>" +
      "<div data-mpanel=\"perms\"" + (initialTab === "perms" ? "" : " hidden") + ">" +
      "<p class=\"subtle manage-note\">这个 Agent 通过面板 MCP 能访问的系统功能，在下方点选后点保存权限统一生效</p>" +
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

    var permSaved = new Set(seed && seed.permissions ? seed.permissions : []);
    var permDesired = new Set(permSaved);
    var permSaving = false;
    var permActiveKey = null;
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
      if (text) text.textContent = url;
      var copyBtn = ctrl.bodyEl.querySelector("[data-agent-endpoint-copy]");
      if (copyBtn) copyBtn.setAttribute("data-copy", url);
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

    // ---- Permission picker (local pending state; one PATCH on save) ----

    function isPermDirty() {
      return !partial && !permSetsEqual(permDesired, permSaved);
    }

    function permEls() {
      return {
        search: ctrl.bodyEl.querySelector("[data-perm-search]"),
        menu: ctrl.bodyEl.querySelector("[data-perm-menu]"),
        tags: ctrl.bodyEl.querySelector("[data-perm-tags]"),
        save: ctrl.bodyEl.querySelector("[data-perm-save]"),
        dirty: ctrl.bodyEl.querySelector("[data-perm-dirty]"),
        summary: ctrl.bodyEl.querySelector("[data-perm-summary]"),
        empty: ctrl.bodyEl.querySelector("[data-perm-menu-empty]"),
      };
    }

    function syncPermUI() {
      var els = permEls();
      if (els.tags) els.tags.innerHTML = permTagsHtml(permDesired);
      if (els.menu) {
        Array.prototype.forEach.call(els.menu.querySelectorAll("[data-perm-item]"), function (btn) {
          var key = btn.getAttribute("data-perm-item");
          var on = permDesired.has(key);
          btn.classList.toggle("is-selected", on);
          btn.setAttribute("aria-selected", on ? "true" : "false");
          btn.classList.toggle("is-active", key === permActiveKey);
        });
      }
      var dirty = isPermDirty();
      if (els.save) {
        els.save.disabled = !dirty || permSaving;
        els.save.classList.toggle("is-dirty", dirty);
      }
      if (els.dirty) els.dirty.hidden = !dirty;
    }

    function updatePermSummary() {
      var els = permEls();
      if (els.summary && agent) els.summary.textContent = permTextOf(agent);
    }

    function visiblePermItems() {
      var els = permEls();
      if (!els.menu) return [];
      return Array.prototype.filter.call(els.menu.querySelectorAll("[data-perm-item]"), function (btn) {
        return !btn.hidden;
      });
    }

    function filterPermMenu(keyword) {
      var els = permEls();
      if (!els.menu) return;
      var needle = String(keyword || "").trim().toLowerCase();
      var shown = 0;
      Array.prototype.forEach.call(els.menu.querySelectorAll("[data-perm-item]"), function (btn) {
        var key = btn.getAttribute("data-perm-item");
        var entry = PERM_DOMAINS.find(function (item) {
          return item[0] === key;
        });
        var hay = entry ? (entry[1] + " " + entry[0] + " " + entry[2]).toLowerCase() : key;
        var hit = !permDesired.has(key) && (!needle || hay.indexOf(needle) !== -1);
        btn.hidden = !hit;
        if (hit) shown += 1;
      });
      if (els.empty) {
        els.empty.hidden = shown > 0;
        if (shown === 0) els.empty.textContent = permDesired.size >= PERM_DOMAINS.length ? "已拥有全部权限" : "没有匹配的权限";
      }
      var visible = visiblePermItems();
      if (
        permActiveKey &&
        !visible.some(function (btn) {
          return btn.getAttribute("data-perm-item") === permActiveKey;
        })
      ) {
        permActiveKey = visible.length ? visible[0].getAttribute("data-perm-item") : null;
        syncPermUI();
      }
    }

    function openPermMenu() {
      var els = permEls();
      if (!els.menu) return;
      els.menu.hidden = false;
      if (els.search) els.search.setAttribute("aria-expanded", "true");
      if (!permActiveKey) permActiveKey = PERM_DOMAINS[0][0];
      filterPermMenu(els.search ? els.search.value : "");
      syncPermUI();
    }

    function closePermMenu() {
      var els = permEls();
      if (!els.menu) return;
      els.menu.hidden = true;
      if (els.search) els.search.setAttribute("aria-expanded", "false");
    }

    function permMenuOpen() {
      var els = permEls();
      return !!els.menu && !els.menu.hidden;
    }

    function togglePerm(domain) {
      if (partial || !domain) return;
      interacted = true;
      if (permDesired.has(domain)) permDesired.delete(domain);
      else permDesired.add(domain);
      var elsNow = permEls();
      filterPermMenu(elsNow.search ? elsNow.search.value : "");
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
      var target = orderedPerms(permDesired);
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
          permSaved = new Set(target);
          if (agent) agent.permissions = target.slice();
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
          permDesired = new Set(permSaved);
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
            permSaved = new Set(fresh.permissions || []);
            permDesired = new Set(permSaved);
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
        '<button type="button" data-avatar-upload-save disabled>保存这张图</button>' +
        "</div>" +
        '<p class="subtle">选图后会自动居中裁剪并缩放为 128×128 方图再保存，文件不超过 200 KB</p>' +
        "</div>" +
        '<div data-avatar-pane="link" hidden>' +
        '<label>图片链接<input data-avatar-url type="url" inputmode="url" placeholder="https://example.com/avatar.png" autocomplete="off" /></label>' +
        '<div class="avatar-preview" data-avatar-link-preview hidden><img alt="头像预览" /></div>' +
        '<p class="subtle" data-avatar-link-hint>输入 http 或 https 链接，预览加载成功后才能保存</p>' +
        '<div class="manage-actions"><button type="button" data-avatar-link-save disabled>保存链接</button></div>' +
        "</div>" +
        '<div class="manage-actions avatar-picker-foot">' +
        '<button type="button" class="secondary" data-avatar-default>恢复默认</button>' +
        '<button type="button" class="secondary" data-avatar-cancel>取消</button>' +
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
      var uploadSaveBtn = body.querySelector("[data-avatar-upload-save]");
      var urlInput = body.querySelector("[data-avatar-url]");
      var linkPreview = body.querySelector("[data-avatar-link-preview]");
      var linkPreviewImg = linkPreview.querySelector("img");
      var linkHint = body.querySelector("[data-avatar-link-hint]");
      var linkSaveBtn = body.querySelector("[data-avatar-link-save]");
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

      function showPane(name) {
        Array.prototype.forEach.call(body.querySelectorAll("[data-avatar-tab]"), function (tab) {
          tab.setAttribute("aria-selected", tab.getAttribute("data-avatar-tab") === name ? "true" : "false");
        });
        Array.prototype.forEach.call(body.querySelectorAll("[data-avatar-pane]"), function (pane) {
          pane.hidden = pane.getAttribute("data-avatar-pane") !== name;
        });
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
        uploadSaveBtn.disabled = false;
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
        linkSaveBtn.disabled = true;
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
          linkSaveBtn.disabled = false;
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
        if (eventTarget.closest("[data-avatar-upload-save]")) {
          saveAvatarUpload();
          return;
        }
        if (eventTarget.closest("[data-avatar-link-save]")) {
          saveAvatarLink();
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
        if (ok) openDisableConfirm();
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

    function openDisableConfirm() {
      
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
      
    }

    ctrl.dialog.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var removeBtn = target.closest("[data-perm-remove]");
      if (removeBtn) {
        togglePerm(removeBtn.getAttribute("data-perm-remove"));
        return;
      }
      var itemBtn = target.closest("[data-perm-item]");
      if (itemBtn) {
        togglePerm(itemBtn.getAttribute("data-perm-item"));
        var els = permEls();
        if (els.search) els.search.focus();
        return;
      }
      if (target.closest("[data-perm-save]")) {
        savePerms();
        return;
      }
      if (!target.closest("[data-perm-picker]")) closePermMenu();
      var actBtn = target.closest("[data-agent-act]");
      if (!actBtn || busy || !agent) return;
      var act = actBtn.getAttribute("data-agent-act");
      interacted = true;
      if (act === "rename") doRename();
      else if (act === "move") doMove();
      else if (act === "rotate") doRotate();
      else if (act === "disable") doDisable();
      else if (act === "enable") doEnable();
      else if (act === "avatar") doAvatar();
    });

    ctrl.dialog.addEventListener("focusin", function (event) {
      if (event.target instanceof Element && event.target.closest("[data-perm-search]")) openPermMenu();
    });

    ctrl.dialog.addEventListener("input", function (event) {
      if (event.target instanceof Element && event.target.closest("[data-perm-search]")) {
        openPermMenu();
        filterPermMenu(event.target.value);
      }
    });

    ctrl.dialog.addEventListener("keydown", function (event) {
      var target = event.target;
      if (!(target instanceof Element) || !target.closest("[data-perm-search]")) return;
      if (event.key === "Escape") {
        if (permMenuOpen()) {
          event.preventDefault();
          event.stopPropagation();
          closePermMenu();
        }
        return;
      }
      if (!permMenuOpen()) return;
      var visible = visiblePermItems();
      if (!visible.length) return;
      var keys = visible.map(function (btn) {
        return btn.getAttribute("data-perm-item");
      });
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        var idx = keys.indexOf(permActiveKey);
        idx = event.key === "ArrowDown" ? Math.min(idx + 1, keys.length - 1) : Math.max(idx - 1, 0);
        permActiveKey = keys[idx];
        syncPermUI();
        if (visible[idx] && visible[idx].scrollIntoView) visible[idx].scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (permActiveKey && keys.indexOf(permActiveKey) !== -1) togglePerm(permActiveKey);
      }
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
            agentRecordsHtml = '<p class="subtle">还没有访问记录，这个 Agent 的取用与操作会留在这里</p>';
          } else {
            agentRecordsHtml =
              '<ol class="feed">' +
              records
                .map(function (item) {
                  return (
                    '<li><time datetime="' +
                    escapeHtml(new Date(item.at).toISOString()) +
                    '">' +
                    escapeHtml(formatMinute(item.at) || "") +
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
    logout: logout,
    formatMinute: formatMinute,
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
    metaGrid: metaGrid,
    iconSvg: iconSvg,
    agentAvatarHtml: agentAvatarHtml,
    addBar: addBar,
    groupSelect: groupSelect,
    toast: toast,
    groupedSections: groupedSections,
  };
})();
