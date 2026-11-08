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
      '<div class="add-bar"><button type="button" class="add-button" data-action="' +
      escapeHtml(options.addAction || "add") +
      '">' +
      escapeHtml(options.addLabel || "添加") +
      '</button><button type="button" class="secondary add-group-button" data-action="' +
      escapeHtml(options.groupAction || "add-group") +
      '">' +
      escapeHtml(options.groupLabel || "添加分组") +
      "</button></div>"
    );
  }

  // Group picker used by create/edit dialogs: blank value means ungrouped.
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
        ? list(members.map(options.renderItem).join(""))
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
        ? list(loose.map(options.renderItem).join(""))
        : emptyState(options.emptyTitle || "暂无内容", options.emptyText || "");
      html += section(options.ungroupedTitle || "未分组", loose.length ? loose.length + " 个" : "", looseBody);
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
      (options.icon ? iconSvg(options.icon) : "") +
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
  var currentOverlay = null;

  var CLOSE_ICON =
    "<svg class=\"icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M6 6l12 12M18 6L6 18\"/></svg>";

  function buildOverlay(options, panel) {
    if (currentOverlay) currentOverlay.close();
    var dialog = document.createElement("dialog");
    dialog.className = panel ? "modal side-panel" : "modal manage-dialog" + (options.wide ? " wide" : "");
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
    closeBtn.addEventListener("click", function () {
      ctrl.close();
    });
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) ctrl.close();
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
    ["registry", "注册表", "MCP 注册表的搜索、列表与取配置"],
    ["memory", "记忆", "记忆的读写与同步"],
    ["soul", "Soul", "Soul 的读写与同步"],
    ["tasks", "任务", "任务的查看与处理"],
    ["calendar", "日历", "日程的查看与编辑"],
    ["vault", "保险库", "保险库条目的取用"],
    ["machines", "云主机", "云主机状态与操作"],
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

  function agentPermRows(agent) {
    var enabled = new Set(agent.permissions || []);
    return PERM_DOMAINS.map(function (entry) {
      var on = enabled.has(entry[0]);
      return (
        "<div class=\"perm-row\"><div class=\"perm-meta\"><strong>" +
        escapeHtml(entry[1]) +
        "</strong><span class=\"subtle\">" +
        escapeHtml(entry[0] + " · " + entry[2]) +
        "</span></div><button type=\"button\" class=\"switch\" role=\"switch\" aria-checked=\"" +
        (on ? "true" : "false") +
        "\" data-perm=\"" +
        escapeHtml(entry[0]) +
        "\" aria-label=\"" +
        escapeHtml(entry[1]) +
        "\"><span class=\"switch-knob\"></span></button></div>"
      );
    }).join("");
  }

  function agentManageBody(agent, groupName) {
    var active = agent.status === "active";
    var actions =
      "<button type=\"button\" class=\"secondary\" data-agent-act=\"rename\">改名</button>" +
      "<button type=\"button\" class=\"secondary\" data-agent-act=\"move\">移动分组</button>" +
      "<button type=\"button\" class=\"secondary\" data-agent-act=\"pin\">" +
      (agent.pinned_at ? "取消固定" : "固定到侧边栏") +
      "</button>";
    if (active) {
      actions +=
        "<button type=\"button\" class=\"secondary\" data-agent-act=\"rotate\">轮换令牌</button>" +
        "<button type=\"button\" class=\"danger\" data-agent-act=\"disable\">停用</button>";
    }
    return (
      "<p class=\"manage-status\" data-manage-status role=\"status\"></p>" +
      "<dl class=\"kv\">" +
      "<div><dt>标识</dt><dd><span class=\"mono\">" +
      escapeHtml(agent.id) +
      "</span></dd></div>" +
      "<div><dt>状态</dt><dd>" +
      statusPill(active ? "enabled" : "disabled") +
      "</dd></div>" +
      "<div><dt>分组</dt><dd>" +
      escapeHtml(groupName || "未分组") +
      "</dd></div>" +
      "<div><dt>权限</dt><dd>" +
      escapeHtml(permTextOf(agent)) +
      "</dd></div>" +
      "<div><dt>最近调用</dt><dd>" +
      escapeHtml(formatMinute(agent.last_seen_at) || "还没有调用") +
      "</dd></div>" +
      "<div><dt>创建</dt><dd>" +
      escapeHtml(formatMinute(agent.created_at) || "未知") +
      "</dd></div>" +
      "</dl>" +
      "<div class=\"manage-actions\">" +
      actions +
      "</div>" +
      "<h3 class=\"manage-subhead\">系统功能权限</h3>" +
      "<p class=\"subtle manage-note\">这个 Agent 通过面板 MCP 能访问的系统功能，拨动开关立即生效</p>" +
      "<div class=\"perm-list\">" +
      agentPermRows(agent) +
      "</div>"
    );
  }

  function closeCurrentOverlay() {
    if (currentOverlay) currentOverlay.close();
  }

  function openAgentManage(agentId, options) {
    options = options || {};
    var ctrl = (options.panel ? openSidePanel : openManageDialog)({
      title: "Agent",
      bodyHtml: emptyState("正在读取", "稍等片刻"),
    });
    var agent = null;
    var groups = [];
    var busy = false;

    function groupNameOf(target) {
      if (!target || !target.group_id) return "未分组";
      var found = groups.find(function (item) {
        return item.id === target.group_id;
      });
      return found ? found.name : "未分组";
    }

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

    function refresh() {
      return Promise.all([agentApi("GET", "/api/agents"), agentApi("GET", "/api/groups?scope=agent")])
        .then(function (results) {
          if (results[0].status === 401) {
            location.assign("/login.html");
            return;
          }
          var list = results[0].data && results[0].data.ok === true ? results[0].data.agents || [] : [];
          groups = results[1].data && results[1].data.ok === true ? results[1].data.groups || [] : [];
          agent =
            list.find(function (item) {
              return item.id === agentId;
            }) || null;
          if (!agent) {
            ctrl.setTitle("Agent");
            ctrl.setBody(emptyState("找不到这个 Agent", "它可能已经被停用或删除"));
            return;
          }
          ctrl.setTitle(agent.name);
          ctrl.setBody(agentManageBody(agent, groupNameOf(agent)));
        })
        .catch(function () {
          ctrl.setBody(emptyState("读取失败", "网络异常，请稍后重试"));
        });
    }

    function patch(body, okMessage) {
      if (busy || !agent) return Promise.resolve(false);
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

    function doRotate() {
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
      askConfirm({
        anchor: ctrl.confirmSlot,
        title: "停用设备",
        text: "确认停用「" + agent.name + "」吗？停用后该令牌不能再调用注册表",
        confirmLabel: "停用",
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
              setStatus((result.data && result.data.error) || "没有停用，请重试", true);
              return;
            }
            ctrl.close();
            changed("已停用");
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
      var permBtn = target.closest("[data-perm]");
      if (permBtn) {
        if (busy || !agent) return;
        var domain = permBtn.getAttribute("data-perm");
        var next = new Set(agent.permissions || []);
        if (next.has(domain)) next.delete(domain);
        else next.add(domain);
        permBtn.setAttribute("aria-checked", next.has(domain) ? "true" : "false");
        var ordered = PERM_DOMAINS.map(function (entry) {
          return entry[0];
        }).filter(function (entry) {
          return next.has(entry);
        });
        patch({ permissions: ordered }, "已保存权限");
        return;
      }
      var actBtn = target.closest("[data-agent-act]");
      if (!actBtn || busy || !agent) return;
      var act = actBtn.getAttribute("data-agent-act");
      if (act === "rename") doRename();
      else if (act === "move") doMove();
      else if (act === "pin") patch({ pinned: !agent.pinned_at }, agent.pinned_at ? "已取消固定" : "已固定到侧边栏");
      else if (act === "rotate") doRotate();
      else if (act === "disable") doDisable();
    });
    refresh();
    return ctrl;
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

  var currentFormDialog = null;

  // Shared form dialog built on <dialog>. The element lives on <body>,
  // outside #page, so a page render() (innerHTML swap) never destroys it;
  // it removes itself from the DOM when closed. Pages must use this instead
  // of inline page forms or window.prompt.
  // options: { title, bodyHtml, submitLabel, cancelLabel, wide, onSubmit, onClose }
  // onSubmit(ctrl) decides what happens next: ctrl.setError() keeps the
  // dialog open with a message, ctrl.showResult() swaps in a result view,
  // ctrl.close() dismisses it.
  function openFormDialog(options) {
    options = options || {};
    if (currentFormDialog) currentFormDialog.close();
    var dialog = document.createElement("dialog");
    dialog.className = "modal" + (options.wide ? " wide" : "");
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
    openManageDialog: openManageDialog,
    closeCurrentOverlay: closeCurrentOverlay,
    openSidePanel: openSidePanel,
    openAgentManage: openAgentManage,
    permDomains: PERM_DOMAINS,
    metaGrid: metaGrid,
    iconSvg: iconSvg,
    addBar: addBar,
    groupSelect: groupSelect,
    groupedSections: groupedSections,
  };
})();
