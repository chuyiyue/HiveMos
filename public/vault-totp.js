/* 保险库「验证码」页签：TOTP 条目卡片、倒计时、手动添加与管理弹窗。
   验证码由服务端 /api/vault/totp/codes 计算，密钥不下发；本文件只负责
   展示、复制、添加/管理表单与（第二批）扫码和导入导出。
   图标走 window.HMIcons 共享注册表（icons 分支提供），缺失时回退首字头像。
   vault.js 负责页签与容器，本模块通过 window.HiveVaultTotp.afterRender
   被通知重绘与启停倒计时。 */
(function () {
  var C = window.HiveCommon;
  if (!C) return;
  var esc = C.escapeHtml;

  var S = {
    active: false,
    loaded: false,
    entries: null,
    groups: null,
    vaultKeySet: true,
    loadError: "",
    codes: {},
    codesError: false,
    serverNowAtFetch: 0,
    offsetMs: 0,
    fetchingCodes: false,
    prefetchCycle: {},
    timer: null,
    search: "",
    groupFilter: "",
  };

  var AVATAR_PAIRS = [
    ["var(--accent-soft)", "var(--accent-text)"],
    ["var(--success-soft)", "var(--success-text)"],
    ["var(--warning-soft)", "var(--warning-text)"],
    ["var(--danger-soft)", "var(--danger-text)"],
    ["var(--bg-sunken)", "var(--text-2)"],
  ];
  var RING_LEN = 100; // pathLength 归一化后的圆环总长

  function api(method, url, body) {
    var headers = { accept: "application/json" };
    var options = { method: method, headers: headers, cache: "no-store" };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return fetch(url, options).then(function (response) {
      return response
        .json()
        .catch(function () { return {}; })
        .then(function (data) { return { status: response.status, data: data || {} }; });
    });
  }

  function rootEl() {
    return document.querySelector("[data-totp-root]");
  }

  function icons() {
    return window.HMIcons || null;
  }

  function letterAvatarHtml(name, cls) {
    var text = String(name || "?").trim();
    var ch = text ? text.charAt(0).toUpperCase() : "?";
    var hash = 0;
    for (var i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    var pair = AVATAR_PAIRS[hash % AVATAR_PAIRS.length];
    return (
      "<span class=\"totp-letter " + (cls || "") + "\" style=\"background:" + pair[0] + ";color:" + pair[1] + "\" aria-hidden=\"true\">" +
      esc(ch) + "</span>"
    );
  }

  // 条目图标：存了标识用标识，没存按服务名自动匹配，再不中用首字头像
  function entryIconHtml(entry, cls) {
    var H = icons();
    var id = entry.icon || null;
    if (!id && H && typeof H.match === "function") {
      try { id = H.match(entry.issuer || ""); } catch (error) { id = null; }
    }
    if (id && H && typeof H.svg === "function") {
      try {
        var svg = H.svg(id, "totp-icon-svg");
        if (svg) return "<span class=\"totp-icon " + (cls || "") + "\" aria-hidden=\"true\">" + svg + "</span>";
      } catch (error) { /* 回退首字 */ }
    }
    return "<span class=\"totp-icon " + (cls || "") + "\" aria-hidden=\"true\">" + letterAvatarHtml(entry.issuer, "totp-letter-in") + "</span>";
  }

  function iconPreviewHtml(iconId, issuer) {
    var H = icons();
    if (iconId && H && typeof H.svg === "function") {
      try {
        var svg = H.svg(iconId, "totp-icon-svg");
        if (svg) return "<span class=\"totp-icon\" aria-hidden=\"true\">" + svg + "</span>";
      } catch (error) { /* 回退 */ }
    }
    if (!iconId && H && typeof H.match === "function") {
      try {
        var matched = H.match(issuer || "");
        if (matched) {
          var svg2 = H.svg(matched, "totp-icon-svg");
          if (svg2) return "<span class=\"totp-icon\" aria-hidden=\"true\">" + svg2 + "</span>";
        }
      } catch (error) { /* 回退 */ }
    }
    return "<span class=\"totp-icon\" aria-hidden=\"true\">" + letterAvatarHtml(issuer, "totp-letter-in") + "</span>";
  }

  function groupName(gid) {
    var name = "未分组";
    (S.groups || []).forEach(function (group) {
      if (group.id === gid) name = group.name;
    });
    return name;
  }

  function findEntry(id) {
    var found = null;
    (S.entries || []).forEach(function (entry) {
      if (entry.id === id) found = entry;
    });
    return found;
  }

  function formatCode(code) {
    var text = String(code || "");
    return text.replace(/(\d{3})(?=\d)/g, "$1 ");
  }

  // ---------- 数据 ----------

  function loadGroups() {
    return api("GET", "/api/vault/groups").then(function (result) {
      if (result.data && result.data.ok && Array.isArray(result.data.groups)) {
        S.groups = result.data.groups;
        paint();
      }
    }).catch(function () {});
  }

  // 验证码页签的分组与保险库/网关共用 vault_groups 池（同一端点）；
  // 分组管理面板里的成员数按 TOTP 条目计。新建/改名弹窗在本模块内走
  // 同一套 /api/vault/groups 接口，口径与保险库页签一致。
  function totpGroupCounts() {
    var counts = {};
    (S.entries || []).forEach(function (entry) {
      if (entry.group_id) counts[entry.group_id] = (counts[entry.group_id] || 0) + 1;
    });
    return counts;
  }

  function openTotpGroupDialog(group) {
    var editing = !!group;
    C.openFormDialog({
      title: editing ? "重命名分组" : "添加分组",
      bodyHtml: "<label>分组名<input name=\"name\" maxlength=\"60\" autocomplete=\"off\" value=\"" + (editing ? esc(group.name) : "") + "\" /></label>",
      submitLabel: editing ? "保存" : "添加分组",
      onSubmit: function (ctrl) {
        var input = ctrl.form.querySelector('[name="name"]');
        var name = input ? input.value.trim() : "";
        if (!name) { ctrl.setError("请填写分组名"); return; }
        ctrl.setBusy(true);
        api(editing ? "PATCH" : "POST", editing ? "/api/vault/groups/" + encodeURIComponent(group.id) : "/api/vault/groups", { name: name })
          .then(function (result) {
            ctrl.setBusy(false);
            if (!result.data || !result.data.ok) {
              ctrl.setError((result.data && result.data.error) || "保存失败，请重试");
              return;
            }
            ctrl.close();
            loadGroups();
          })
          .catch(function () {
            ctrl.setBusy(false);
            ctrl.setError("网络异常，请重试");
          });
      },
    });
  }

  function openTotpGroupManager(btn) {
    C.openGroupManager({
      anchor: btn,
      groups: S.groups || [],
      counts: totpGroupCounts(),
      onCreate: function () { openTotpGroupDialog(null); },
      onRename: function (group) { openTotpGroupDialog(group); },
      onDelete: function (group, slot) {
        C.askConfirm({
          anchor: slot,
          title: "删除分组",
          text: "确认删除分组「" + group.name + "」吗？组内条目会回到未分组，不会被删除",
          confirmLabel: "删除",
          danger: true,
        }).then(function (yes) {
          if (!yes) return;
          api("DELETE", "/api/vault/groups/" + encodeURIComponent(group.id)).then(function (result) {
            if (result.data && result.data.ok) {
              loadGroups();
              loadEntries();
            }
          });
        });
      },
      onReorder: function (ids) {
        api("POST", "/api/vault/groups/reorder", { ids: ids }).then(function (result) {
          if (result.data && result.data.ok) loadGroups();
        });
      },
      onSettled: function () {
        return { groups: S.groups || [], counts: totpGroupCounts() };
      },
    });
  }

  function loadEntries() {
    return api("GET", "/api/vault/totp").then(function (result) {
      if (result.data && result.data.ok && Array.isArray(result.data.entries)) {
        S.entries = result.data.entries;
        S.vaultKeySet = result.data.vaultKeySet !== false;
        S.loadError = "";
      } else {
        S.loadError = (result.data && result.data.error) || "条目加载失败";
      }
      S.loaded = true;
      paint();
      fetchCodes();
    }).catch(function () {
      S.loadError = "条目加载失败";
      S.loaded = true;
      paint();
    });
  }

  function loadAll() {
    loadGroups();
    loadEntries();
  }

  function fetchCodes() {
    if (S.fetchingCodes || !S.entries || !S.entries.length) return;
    S.fetchingCodes = true;
    api("GET", "/api/vault/totp/codes").then(function (result) {
      S.fetchingCodes = false;
      if (result.data && result.data.ok && Array.isArray(result.data.entries)) {
        var map = {};
        result.data.entries.forEach(function (row) { map[row.id] = row; });
        S.codes = map;
        if (typeof result.data.serverNow === "number") {
          S.serverNowAtFetch = result.data.serverNow;
          S.offsetMs = result.data.serverNow - Date.now();
        }
        S.codesError = false;
        S.prefetchCycle = {};
        paintCodes();
        tick();
      } else {
        S.codesError = true;
        paintCodes();
      }
    }).catch(function () {
      S.fetchingCodes = false;
      S.codesError = true;
      paintCodes();
    });
  }

  // ---------- 倒计时引擎 ----------

  function adjustedNow() {
    return Date.now() + S.offsetMs;
  }

  function remainingOf(entry) {
    var info = S.codes[entry.id];
    if (!info || typeof info.remaining !== "number" || !S.serverNowAtFetch) return null;
    return info.remaining - (adjustedNow() - S.serverNowAtFetch) / 1000;
  }

  function cycleOf(entry) {
    var period = Number(entry.period) || 30;
    return Math.floor(adjustedNow() / 1000 / period);
  }

  function startTick() {
    if (S.timer) return;
    S.timer = window.setInterval(tick, 200);
  }

  function stopTick() {
    if (S.timer) {
      window.clearInterval(S.timer);
      S.timer = null;
    }
  }

  function tick() {
    if (!S.active || document.hidden) return;
    (S.entries || []).forEach(function (entry) {
      var rem = remainingOf(entry);
      if (rem === null) return;
      if (rem <= 0) {
        // 周期已过：先用下一个码顶替（预取通常已带回新数据），再补一次取码
        swapCard(entry);
        fetchCodes();
        return;
      }
      if (rem <= 2 && !S.prefetchCycle[entry.id + ":" + cycleOf(entry)]) {
        S.prefetchCycle[entry.id + ":" + cycleOf(entry)] = true;
        fetchCodes();
      }
      paintCardClock(entry, rem);
    });
  }

  function swapCard(entry) {
    var info = S.codes[entry.id];
    if (!info || !info.nextCode) return;
    var card = cardEl(entry.id);
    if (!card) return;
    var codeEl = card.querySelector("[data-totp-code]");
    var nextEl = card.querySelector("[data-totp-next-code]");
    if (codeEl) codeEl.textContent = formatCode(info.nextCode);
    if (nextEl) nextEl.textContent = "———";
    info.code = info.nextCode;
    info.remaining = Number(entry.period) || 30;
    S.serverNowAtFetch = adjustedNow();
    S.offsetMs = S.serverNowAtFetch - Date.now();
  }

  function cardEl(id) {
    var root = rootEl();
    if (!root) return null;
    var found = null;
    root.querySelectorAll("[data-totp-card]").forEach(function (el) {
      if (el.getAttribute("data-totp-card") === id) found = el;
    });
    return found;
  }

  function paintCardClock(entry, rem) {
    var card = cardEl(entry.id);
    if (!card) return;
    var period = Number(entry.period) || 30;
    var secs = Math.max(0, Math.ceil(rem));
    var secsEl = card.querySelector("[data-totp-secs]");
    if (secsEl && secsEl.textContent !== String(secs)) secsEl.textContent = String(secs);
    var ring = card.querySelector("[data-totp-ring-arc]");
    if (ring) {
      var frac = Math.max(0, Math.min(1, rem / period));
      ring.style.strokeDashoffset = String(RING_LEN * (1 - frac));
    }
    card.classList.toggle("is-danger", rem <= 5);
  }

  function paintCodes() {
    (S.entries || []).forEach(function (entry) {
      var card = cardEl(entry.id);
      if (!card) return;
      var codeEl = card.querySelector("[data-totp-code]");
      var nextEl = card.querySelector("[data-totp-next-code]");
      var info = S.codes[entry.id];
      if (S.codesError) {
        if (codeEl) codeEl.textContent = "— — —";
        if (nextEl) nextEl.textContent = "";
        return;
      }
      if (!info) {
        if (codeEl) codeEl.textContent = "— — —";
        if (nextEl) nextEl.textContent = "";
        var retry = card.querySelector("[data-totp-retry]");
        if (retry) retry.hidden = false;
        return;
      }
      if (codeEl) codeEl.textContent = formatCode(info.code || "");
      if (nextEl) nextEl.textContent = info.nextCode ? formatCode(info.nextCode) : "";
      var rem = remainingOf(entry);
      if (rem !== null) paintCardClock(entry, Math.max(0, rem));
    });
    var banner = rootEl() ? rootEl().querySelector("[data-totp-codes-banner]") : null;
    if (banner) banner.hidden = !S.codesError;
  }

  // ---------- 渲染 ----------

  function filteredEntries() {
    var q = S.search.trim().toLowerCase();
    var list = (S.entries || []).filter(function (entry) {
      if (S.groupFilter === "__none__" && entry.group_id) return false;
      if (S.groupFilter && S.groupFilter !== "__none__" && entry.group_id !== S.groupFilter) return false;
      if (q) {
        var hay = ((entry.issuer || "") + " " + (entry.account || "")).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    list.sort(function (a, b) {
      return String(a.issuer || "").localeCompare(String(b.issuer || ""), "zh-CN");
    });
    return list;
  }

  function cardHtml(entry) {
    var id = esc(entry.id);
    var info = S.codes[entry.id];
    var failed = S.loaded && !S.codesError && S.entries && S.entries.length && !info && Object.keys(S.codes).length > 0;
    return (
      "<article class=\"totp-card\" data-totp-card=\"" + id + "\">" +
      "<div class=\"totp-card-main\" data-totp-open=\"" + id + "\" tabindex=\"0\" role=\"button\" aria-haspopup=\"dialog\" aria-label=\"" +
      esc("管理：" + (entry.issuer || "") + " " + (entry.account || "")) + "\">" +
      "<div class=\"totp-card-top\">" +
      entryIconHtml(entry) +
      "<div class=\"totp-name\"><h3>" + esc(entry.issuer || "") + "</h3>" +
      (entry.account ? "<p>" + esc(entry.account) + "</p>" : "") +
      "</div>" +
      "<span class=\"totp-ring\" aria-hidden=\"true\">" +
      "<svg viewBox=\"0 0 36 36\"><circle class=\"totp-ring-bg\" cx=\"18\" cy=\"18\" r=\"15.5\" pathLength=\"100\"></circle>" +
      "<circle class=\"totp-ring-arc\" data-totp-ring-arc cx=\"18\" cy=\"18\" r=\"15.5\" pathLength=\"100\"></circle></svg>" +
      "<span class=\"totp-ring-secs\" data-totp-secs></span>" +
      "</span>" +
      "</div>" +
      "<div class=\"totp-codes\">" +
      "<button type=\"button\" class=\"totp-code\" data-totp-copy=\"" + id + "\" aria-label=\"复制验证码\"><span data-totp-code>— — —</span></button>" +
      "<span class=\"totp-next\">下一个 <span data-totp-next-code></span></span>" +
      "</div>" +
      (failed ? "<button type=\"button\" class=\"ghost totp-retry\" data-totp-retry=\"" + id + "\">重试</button>" : "") +
      "</div></article>"
    );
  }

  function gridHtml() {
    if (S.loadError) return C.emptyState("加载失败", S.loadError);
    if (!S.loaded || !S.entries) return C.emptyState("正在加载", "马上就好");
    if (!S.entries.length) {
      return (
        "<div class=\"empty-state\"><p class=\"empty-title\">还没有验证码</p>" +
        "<div class=\"totp-empty-actions\">" +
        "<button type=\"button\" data-totp-act=\"scan\">扫码添加</button>" +
        "<button type=\"button\" class=\"secondary\" data-totp-act=\"io\" data-io-mode=\"import\">导入</button>" +
        "</div></div>"
      );
    }
    var list = filteredEntries();
    if (!list.length) return C.emptyState("没有匹配的条目", "");
    return "<div class=\"totp-grid\">" + list.map(cardHtml).join("") + "</div>";
  }

  function chipsHtml() {
    if (!S.groups) return "";
    var html = "<div class=\"totp-chips\" role=\"group\" aria-label=\"分组\">";
    html += "<button type=\"button\" class=\"totp-chip\" data-totp-chip=\"\" aria-pressed=\"" + (S.groupFilter === "" ? "true" : "false") + "\">全部</button>";
    S.groups.forEach(function (group) {
      html +=
        "<button type=\"button\" class=\"totp-chip\" data-totp-chip=\"" + esc(group.id) + "\" aria-pressed=\"" +
        (S.groupFilter === group.id ? "true" : "false") + "\">" + esc(group.name) + "</button>";
    });
    html += "<button type=\"button\" class=\"totp-chip\" data-totp-chip=\"__none__\" aria-pressed=\"" + (S.groupFilter === "__none__" ? "true" : "false") + "\">未分组</button>";
    html += "<button type=\"button\" class=\"totp-chip totp-chip-add\" data-totp-act=\"group-manager\">分组管理</button>";
    return html + "</div>";
  }

  function paint() {
    var root = rootEl();
    if (!root) return;
    var activeSearch = document.activeElement && document.activeElement.hasAttribute("data-totp-search");
    root.innerHTML =
      "<div class=\"totp-wrap\">" +
      (S.vaultKeySet === false
        ? "<p class=\"totp-banner\">未配置 VAULT_KEY，暂时不能添加或查看验证码</p>"
        : "") +
      "<p class=\"totp-banner is-danger\" data-totp-codes-banner" + (S.codesError ? "" : " hidden") + ">验证码加载失败 <button type=\"button\" class=\"ghost\" data-totp-act=\"retry-codes\">重试</button></p>" +
      "<div class=\"totp-toolbar\">" +
      "<input type=\"search\" class=\"totp-search\" data-totp-search placeholder=\"搜索服务或账号\" autocomplete=\"off\" value=\"" + esc(S.search) + "\" />" +
      "</div>" +
      chipsHtml() +
      "<div data-totp-grid>" + gridHtml() + "</div>" +
      "</div>";
    if (activeSearch) {
      var input = root.querySelector("[data-totp-search]");
      if (input) {
        input.focus();
        try { input.setSelectionRange(input.value.length, input.value.length); } catch (error) {}
      }
    }
    document.querySelectorAll("[data-totp-add-btn]").forEach(function (btn) {
      btn.disabled = S.vaultKeySet === false;
    });
    paintCodes();
    if (S.active && S.loaded && S.entries && S.entries.length) startTick();
  }

  function paintGrid() {
    var root = rootEl();
    if (!root) return;
    var grid = root.querySelector("[data-totp-grid]");
    if (!grid) { paint(); return; }
    grid.innerHTML = gridHtml();
    paintCodes();
  }

  // ---------- 本地 TOTP 计算（手动添加时预览用） ----------

  function base32Decode(text) {
    var cleaned = String(text || "").toUpperCase().replace(/[\s-]/g, "");
    if (!cleaned || /[^A-Z2-7=]/.test(cleaned)) return null;
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    var bits = 0;
    var value = 0;
    var out = [];
    for (var i = 0; i < cleaned.length; i++) {
      var ch = cleaned.charAt(i);
      if (ch === "=") break;
      var idx = alphabet.indexOf(ch);
      if (idx < 0) return null;
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        out.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    if (!out.length) return null;
    return new Uint8Array(out);
  }

  function normalizeSecret(text) {
    return String(text || "").toUpperCase().replace(/[\s-]/g, "");
  }

  function computeLocalCode(secret, algorithm, digits, period) {
    var keyBytes = base32Decode(secret);
    if (!keyBytes) return Promise.resolve(null);
    var counter = Math.floor(Date.now() / 1000 / (Number(period) || 30));
    var buf = new ArrayBuffer(8);
    var view = new DataView(buf);
    view.setUint32(4, counter >>> 0);
    return crypto.subtle
      .importKey("raw", keyBytes, { name: "HMAC", hash: algorithm || "SHA1" }, false, ["sign"])
      .then(function (key) { return crypto.subtle.sign("HMAC", key, buf); })
      .then(function (sig) {
        var bytes = new Uint8Array(sig);
        var off = bytes[bytes.length - 1] & 0x0f;
        var bin = ((bytes[off] & 0x7f) << 24) | ((bytes[off + 1] & 0xff) << 16) | ((bytes[off + 2] & 0xff) << 8) | (bytes[off + 3] & 0xff);
        var code = bin % Math.pow(10, Number(digits) || 6);
        return String(code).padStart(Number(digits) || 6, "0");
      })
      .catch(function () { return null; });
  }

  // ---------- 图标选择 ----------

  function openIconPicker(currentId, issuer, onPick) {
    var H = icons();
    var tiles = "<button type=\"button\" class=\"totp-icon-tile\" data-icon-pick=\"\">" + letterAvatarHtml(issuer, "") + "<span>用首字</span></button>";
    if (H && typeof H.list === "function") {
      try {
        (H.list() || []).forEach(function (item) {
          var svg = "";
          try { svg = H.svg(item.id, "totp-icon-svg"); } catch (error) { svg = ""; }
          if (!svg) return;
          tiles +=
            "<button type=\"button\" class=\"totp-icon-tile\" data-icon-pick=\"" + esc(item.id) + "\" data-icon-name=\"" + esc(item.name || item.id) + "\">" +
            "<span class=\"totp-icon\" aria-hidden=\"true\">" + svg + "</span><span>" + esc(item.name || item.id) + "</span></button>";
        });
      } catch (error) { /* 只有首字可选 */ }
    }
    var ctrl = C.openManageDialog({
      title: "选择图标",
      size: "sm",
      bodyHtml:
        "<input type=\"search\" class=\"totp-icon-search\" data-icon-search placeholder=\"搜索图标\" autocomplete=\"off\" />" +
        "<div class=\"totp-icon-grid\">" + tiles + "</div>",
    });
    ctrl.dialog.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var tile = target.closest("[data-icon-pick]");
      if (!tile) return;
      var picked = tile.getAttribute("data-icon-pick") || "";
      ctrl.close();
      onPick(picked);
    });
    ctrl.dialog.addEventListener("input", function (event) {
      var target = event.target;
      if (!(target instanceof Element) || !target.hasAttribute("data-icon-search")) return;
      var q = target.value.trim().toLowerCase();
      ctrl.dialog.querySelectorAll("[data-icon-pick]").forEach(function (tile) {
        var name = (tile.getAttribute("data-icon-name") || "").toLowerCase();
        tile.hidden = !!q && name.indexOf(q) === -1 && tile.getAttribute("data-icon-pick") !== "";
      });
    });
  }

  // ---------- 表单部件 ----------

  function segmentedHtml(field, options, current) {
    return (
      "<div class=\"segmented\" role=\"group\" aria-label=\"" + esc(field) + "\">" +
      options.map(function (option) {
        return (
          "<button type=\"button\" class=\"segment\" data-seg=\"" + esc(field) + "\" data-value=\"" + esc(option[0]) + "\" aria-pressed=\"" +
          (String(current) === String(option[0]) ? "true" : "false") + "\">" + esc(option[1]) + "</button>"
        );
      }).join("") +
      "</div>" +
      "<input type=\"hidden\" name=\"" + esc(field) + "\" value=\"" + esc(current) + "\" />"
    );
  }

  function switchHtml(field, on, label) {
    return (
      "<span class=\"totp-switch-row\"><span>" + esc(label || "") + "</span>" +
      "<button type=\"button\" class=\"switch\" role=\"switch\" aria-checked=\"" + (on ? "true" : "false") + "\" data-switch=\"" + esc(field) + "\" aria-label=\"允许 AI 读取\"><span class=\"switch-knob\"></span></button>" +
      "<input type=\"hidden\" name=\"" + esc(field) + "\" value=\"" + (on ? "1" : "") + "\" /></span>"
    );
  }

  function wireFormBits(form, onPreviewInput) {
    form.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var seg = target.closest("[data-seg]");
      if (seg) {
        var field = seg.getAttribute("data-seg");
        form.querySelectorAll("[data-seg=\"" + field + "\"]").forEach(function (peer) {
          peer.setAttribute("aria-pressed", peer === seg ? "true" : "false");
        });
        var hidden = form.querySelector("input[name=\"" + field + "\"]");
        if (hidden) hidden.value = seg.getAttribute("data-value") || "";
        if (onPreviewInput) onPreviewInput();
        return;
      }
      var sw = target.closest("[data-switch]");
      if (sw) {
        var on = sw.getAttribute("aria-checked") !== "true";
        sw.setAttribute("aria-checked", on ? "true" : "false");
        var input = form.querySelector("input[name=\"" + sw.getAttribute("data-switch") + "\"]");
        if (input) input.value = on ? "1" : "";
      }
    });
  }

  function formVal(form, name) {
    var el = form.querySelector("[name=\"" + name + "\"]");
    return el ? el.value.trim() : "";
  }

  // ---------- 手动添加 ----------

  function openAddDialog(prefill, opts) {
    opts = opts || {};
    var v = prefill || {};
    var state = { icon: v.icon || "" };
    var body =
      "<div class=\"totp-form-icon-row\">" +
      "<button type=\"button\" class=\"totp-icon-btn\" data-add-icon aria-label=\"选择图标\">" + iconPreviewHtml(state.icon, v.issuer || "") + "</button>" +
      "<span class=\"subtle\">图标</span></div>" +
      "<label>服务名<input name=\"issuer\" maxlength=\"120\" autocomplete=\"off\" value=\"" + esc(v.issuer || "") + "\" /></label>" +
      "<label>账号<input name=\"account\" maxlength=\"200\" autocomplete=\"off\" value=\"" + esc(v.account || "") + "\" /></label>" +
      "<label>密钥<input name=\"secret\" data-secret-input maxlength=\"512\" autocomplete=\"off\" value=\"" + esc(v.secret || "") + "\" />" +
      "<p class=\"subtle totp-preview\" data-add-preview></p></label>" +
      "<button type=\"button\" class=\"ghost totp-more-toggle\" data-more-toggle aria-expanded=\"false\">更多选项</button>" +
      "<div class=\"totp-more\" data-more hidden>" +
      "<div class=\"tag-field\"><span>算法</span>" + segmentedHtml("algorithm", [["SHA1", "SHA1"], ["SHA256", "SHA256"], ["SHA512", "SHA512"]], v.algorithm || "SHA1") + "</div>" +
      "<div class=\"tag-field\"><span>位数</span>" + segmentedHtml("digits", [["6", "6 位"], ["7", "7 位"], ["8", "8 位"]], String(v.digits || 6)) + "</div>" +
      "<label>周期（秒）<input name=\"period\" type=\"number\" min=\"5\" max=\"600\" step=\"1\" inputmode=\"numeric\" value=\"" + esc(v.period || 30) + "\" /></label>" +
      "<label>分组" + C.groupSelect("group_id", S.groups || [], v.group_id || "") + "</label>" +
      "<label>备注<textarea name=\"note\" rows=\"2\" maxlength=\"300\">" + esc(v.note || "") + "</textarea></label>" +
      switchHtml("ai_read", v.ai_read !== false, "允许 AI 读取") +
      "</div>";
    var ctrl = C.openFormDialog({
      title: "添加验证码",
      bodyHtml: body,
      submitLabel: "添加",
      onClose: typeof opts.onClose === "function" ? opts.onClose : undefined,
      onSubmit: function (c) {
        var issuer = formVal(c.form, "issuer");
        var account = formVal(c.form, "account");
        var secret = normalizeSecret(formVal(c.form, "secret"));
        if (!issuer) { c.setError("请填写服务名"); return; }
        if (!account) { c.setError("请填写账号"); return; }
        if (!secret || !base32Decode(secret)) { c.setError("密钥格式不正确"); return; }
        var period = Number(formVal(c.form, "period")) || 30;
        var payload = {
          issuer: issuer,
          account: account,
          secret: secret,
          algorithm: formVal(c.form, "algorithm") || "SHA1",
          digits: Number(formVal(c.form, "digits")) || 6,
          period: period,
          icon: state.icon || null,
          note: formVal(c.form, "note"),
          group_id: formVal(c.form, "group_id") || null,
          ai_read: formVal(c.form, "ai_read") === "1",
        };
        c.setBusy(true);
        api("POST", "/api/vault/totp", payload).then(function (result) {
          c.setBusy(false);
          if (result.data && result.data.ok) {
            c.close();
            C.toast("已添加");
            loadEntries();
            if (typeof opts.onAdded === "function") opts.onAdded(payload);
          } else if (result.status === 409) {
            c.setError((result.data && result.data.error) || "已存在相同密钥的条目");
          } else {
            c.setError((result.data && result.data.error) || "添加失败，请重试");
          }
        }).catch(function () {
          c.setBusy(false);
          c.setError("网络异常，请重试");
        });
      },
    });

    var previewTimer = null;
    function updatePreview() {
      var preview = ctrl.form.querySelector("[data-add-preview]");
      if (!preview) return;
      var secret = normalizeSecret(formVal(ctrl.form, "secret"));
      if (!secret) { preview.textContent = ""; return; }
      if (!base32Decode(secret)) { preview.textContent = "密钥格式不正确"; return; }
      computeLocalCode(secret, formVal(ctrl.form, "algorithm") || "SHA1", Number(formVal(ctrl.form, "digits")) || 6, Number(formVal(ctrl.form, "period")) || 30).then(function (code) {
        if (!preview.isConnected) return;
        preview.textContent = code ? "当前验证码 " + formatCode(code) : "密钥格式不正确";
      });
    }
    function queuePreview() {
      if (previewTimer) window.clearTimeout(previewTimer);
      previewTimer = window.setTimeout(updatePreview, 150);
    }
    ctrl.form.addEventListener("input", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      if (target.hasAttribute("name") && (target.getAttribute("name") === "secret" || target.getAttribute("name") === "period")) queuePreview();
      if (target.getAttribute("name") === "issuer") {
        var btn = ctrl.form.querySelector("[data-add-icon]");
        if (btn && !state.icon) btn.innerHTML = iconPreviewHtml("", target.value);
      }
    });
    wireFormBits(ctrl.form, queuePreview);
    ctrl.form.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-more-toggle]")) {
        var more = ctrl.form.querySelector("[data-more]");
        var toggle = ctrl.form.querySelector("[data-more-toggle]");
        if (more) {
          more.hidden = !more.hidden;
          if (toggle) toggle.setAttribute("aria-expanded", more.hidden ? "false" : "true");
          C.refreshSelects(ctrl.form);
        }
        return;
      }
      if (target.closest("[data-add-icon]")) {
        openIconPicker(state.icon, formVal(ctrl.form, "issuer"), function (picked) {
          state.icon = picked;
          var btn = ctrl.form.querySelector("[data-add-icon]");
          if (btn) btn.innerHTML = iconPreviewHtml(state.icon, formVal(ctrl.form, "issuer"));
        });
      }
    });
    updatePreview();
    return ctrl;
  }

  // ---------- 管理弹窗 ----------

  var EYE_SVG = "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/></svg>";
  var EYE_OFF_SVG = "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M4 4l16 16\"/><path d=\"M2 12s3.5-7 10-7c1.7 0 3.2.4 4.5 1.1M22 12s-3.5 7-10 7c-1.7 0-3.2-.4-4.5-1.1\"/><path d=\"M9.9 9.9a3 3 0 0 0 4.2 4.2\"/></svg>";

  function openManage(entry) {
    var state = { icon: entry.icon || "" };
    var body =
      "<div class=\"totp-form-icon-row\">" +
      "<button type=\"button\" class=\"totp-icon-btn\" data-mng-icon aria-label=\"选择图标\">" + iconPreviewHtml(state.icon, entry.issuer || "") + "</button>" +
      "<span class=\"subtle\">图标</span></div>" +
      "<label>服务名<input name=\"issuer\" maxlength=\"120\" autocomplete=\"off\" value=\"" + esc(entry.issuer || "") + "\" /></label>" +
      "<label>账号<input name=\"account\" maxlength=\"200\" autocomplete=\"off\" value=\"" + esc(entry.account || "") + "\" /></label>" +
      "<label>密钥<span class=\"secret-field\"><input type=\"text\" data-totp-secret readonly autocomplete=\"off\" data-1p-ignore=\"true\" data-lpignore=\"true\" data-bwignore=\"true\" />" +
      "<button type=\"button\" class=\"secret-eye\" data-totp-eye aria-label=\"隐藏密钥\">" + EYE_OFF_SVG + "</button></span></label>" +
      "<label>分组" + C.groupSelect("group_id", S.groups || [], entry.group_id || "") + "</label>" +
      "<label>备注<textarea name=\"note\" rows=\"2\" maxlength=\"300\">" + esc(entry.note || "") + "</textarea></label>" +
      switchHtml("ai_read", entry.ai_read !== false, "允许 AI 读取") +
      "<p class=\"field-error\" data-mng-error hidden></p>" +
      "<div class=\"manage-actions\">" +
      "<button type=\"button\" class=\"danger\" data-confirm-delete data-totp-delete=\"" + esc(entry.id) + "\">删除</button>" +
      "<button type=\"button\" data-totp-save>保存</button>" +
      "</div>";
    var ctrl = C.openManageDialog({ title: entry.issuer || "验证码", size: "sm", bodyHtml: body });
    var dialog = ctrl.dialog;
    C.refreshSelects(dialog);
    wireFormBits(dialog, null);
    // 密钥默认明文：打开弹窗就经 reveal 拉一次填进框里（框初始就是
    // type=text）；眼睛按钮只负责在明文/打码之间切换，拉取失败时点
    // 眼睛重试。notify 只在用户点眼睛触发时弹错误提示。
    var secretInput0 = dialog.querySelector("[data-totp-secret]");
    var eyeBtn0 = dialog.querySelector("[data-totp-eye]");
    function loadManageSecret(notify) {
      if (!secretInput0 || secretInput0.getAttribute("data-loaded")) return;
      if (eyeBtn0) eyeBtn0.disabled = true;
      api("POST", "/api/vault/reveal", { kind: "totp", id: entry.id }).then(function (result) {
        if (eyeBtn0) eyeBtn0.disabled = false;
        if (!dialog.isConnected) return;
        var value = result.data && result.data.ok && result.data.reveal ? result.data.reveal.value : null;
        if (typeof value === "string" && value) {
          secretInput0.value = value;
          secretInput0.setAttribute("data-loaded", "1");
        } else if (notify) {
          C.toast((result.data && result.data.error) || "读取失败", "danger");
        }
      }).catch(function () {
        if (eyeBtn0) eyeBtn0.disabled = false;
        if (notify && dialog.isConnected) C.toast("网络异常，请重试", "danger");
      });
    }
    loadManageSecret(false);
    dialog.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-mng-icon]")) {
        openIconPicker(state.icon, formVal(dialog, "issuer"), function (picked) {
          state.icon = picked;
          var btn = dialog.querySelector("[data-mng-icon]");
          if (btn) btn.innerHTML = iconPreviewHtml(state.icon, formVal(dialog, "issuer"));
        });
        return;
      }
      var eyeBtn = target.closest("[data-totp-eye]");
      if (eyeBtn) {
        var secretInput = dialog.querySelector("[data-totp-secret]");
        if (!secretInput) return;
        if (!secretInput.getAttribute("data-loaded")) {
          loadManageSecret(true);
          return;
        }
        if (secretInput.type === "text") {
          secretInput.type = "password";
          eyeBtn.innerHTML = EYE_SVG;
          eyeBtn.setAttribute("aria-label", "显示密钥");
          return;
        }
        secretInput.type = "text";
        eyeBtn.innerHTML = EYE_OFF_SVG;
        eyeBtn.setAttribute("aria-label", "隐藏密钥");
        return;
      }

      if (target.closest("[data-totp-delete]")) {
        api("DELETE", "/api/vault/totp/" + encodeURIComponent(entry.id)).then(function (result) {
          if (result.data && result.data.ok) {
            ctrl.close();
            C.toast("已删除");
            loadEntries();
          } else {
            C.toast((result.data && result.data.error) || "删除失败", "danger");
          }
        }).catch(function () { C.toast("网络异常，请重试", "danger"); });
        return;
      }
      if (target.closest("[data-totp-save]")) {
        var issuer = formVal(dialog, "issuer");
        var account = formVal(dialog, "account");
        var error = dialog.querySelector("[data-mng-error]");
        if (!issuer || !account) {
          if (error) { error.textContent = !issuer ? "请填写服务名" : "请填写账号"; error.hidden = false; }
          return;
        }
        var payload = {
          issuer: issuer,
          account: account,
          icon: state.icon || null,
          group_id: formVal(dialog, "group_id") || null,
          note: formVal(dialog, "note"),
          ai_read: formVal(dialog, "ai_read") === "1",
        };
        api("PATCH", "/api/vault/totp/" + encodeURIComponent(entry.id), payload).then(function (result) {
          if (result.data && result.data.ok) {
            ctrl.close();
            C.toast("已保存");
            loadEntries();
          } else if (error) {
            error.textContent = (result.data && result.data.error) || "保存失败，请重试";
            error.hidden = false;
          }
        }).catch(function () {
          if (error) { error.textContent = "网络异常，请重试"; error.hidden = false; }
        });
      }
    });
  }

  // ---------- 复制 ----------

  function copyEntryCode(entry) {
    var info = S.codes[entry.id];
    if (!info || !info.code) {
      C.toast("验证码还没加载好", "danger");
      return;
    }
    var rem = remainingOf(entry);
    var useNext = rem !== null && rem < 5 && info.nextCode;
    var value = useNext ? info.nextCode : info.code;
    C.copyText(value).then(function () {
      C.toast(useNext ? "已复制下一个码" : "已复制");
    }).catch(function () {
      C.toast("复制失败", "danger");
    });
  }

  // ---------- 页面事件 ----------

  var page = document.getElementById("page");
  if (page) {
    page.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      // 页头按钮在面板容器之外，先处理
      var actBtn = target.closest("[data-totp-act]");
      if (actBtn && actBtn.hasAttribute("data-totp-add-btn")) {
        var headAct = actBtn.getAttribute("data-totp-act");
        if (headAct === "add") openAddDialog(null);
        else if (headAct === "scan") openScanDialog();
        else if (headAct === "io") openIoDialog("import");
        return;
      }
      var root = rootEl();
      if (!root) return;
      if (!root.contains(target)) return;
      var copyBtn = target.closest("[data-totp-copy]");
      if (copyBtn) {
        var entry1 = findEntry(copyBtn.getAttribute("data-totp-copy"));
        if (entry1) copyEntryCode(entry1);
        return;
      }
      var retry = target.closest("[data-totp-retry]");
      if (retry) {
        S.codes = {};
        fetchCodes();
        return;
      }
      var chip = target.closest("[data-totp-chip]");
      if (chip) {
        S.groupFilter = chip.getAttribute("data-totp-chip") || "";
        paint();
        return;
      }
      var act = target.closest("[data-totp-act]");
      if (act) {
        var name = act.getAttribute("data-totp-act");
        if (name === "retry-codes") fetchCodes();
        else if (name === "add") openAddDialog(null);
        else if (name === "scan") openScanDialog();
        else if (name === "io") openIoDialog(act.getAttribute("data-io-mode") === "export" ? "export" : "import");
        else if (name === "group-manager") openTotpGroupManager(act);
        return;
      }
      var open = target.closest("[data-totp-open]");
      if (open && !target.closest("button")) {
        var entry2 = findEntry(open.getAttribute("data-totp-open"));
        if (entry2) openManage(entry2);
      }
    });
    page.addEventListener("input", function (event) {
      var target = event.target;
      if (!(target instanceof Element) || !target.hasAttribute("data-totp-search")) return;
      S.search = target.value;
      paintGrid();
    });
    page.addEventListener("keydown", function (event) {
      if (event.key !== "Enter") return;
      var target = event.target;
      if (!(target instanceof Element)) return;
      var open = target.closest("[data-totp-open]");
      if (open && !target.closest("[data-totp-copy]")) {
        event.preventDefault();
        var entry = findEntry(open.getAttribute("data-totp-open"));
        if (entry) copyEntryCode(entry);
      }
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      stopTick();
    } else if (S.active) {
      fetchCodes();
      startTick();
      tick();
    }
  });


  // ---------- otpauth 解析（扫码/粘贴单个条目） ----------

  function parseOtpauth(text) {
    var raw = String(text || "").trim();
    if (raw.indexOf("otpauth://") !== 0) return null;
    var rest = raw.slice("otpauth://".length);
    var type = rest.split("/")[0].toLowerCase();
    if (type !== "totp") return null;
    var qIndex = rest.indexOf("?");
    var label = qIndex >= 0 ? rest.slice(rest.indexOf("/") + 1, qIndex) : rest.slice(rest.indexOf("/") + 1);
    var query = qIndex >= 0 ? rest.slice(qIndex + 1) : "";
    var params = {};
    query.split("&").forEach(function (pair) {
      if (!pair) return;
      var eq = pair.indexOf("=");
      var key = eq >= 0 ? pair.slice(0, eq) : pair;
      var value = eq >= 0 ? pair.slice(eq + 1) : "";
      try { params[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, " ")); } catch (error) {}
    });
    var labelText = "";
    try { labelText = decodeURIComponent(label); } catch (error) { labelText = label; }
    var issuer = params.issuer || "";
    var account = labelText || "";
    if (labelText.indexOf(":") > -1) {
      var parts = labelText.split(":");
      if (!issuer) issuer = parts[0].trim();
      account = parts.slice(1).join(":").trim();
    }
    if (!params.secret) return null;
    return {
      issuer: issuer || account,
      account: account,
      secret: normalizeSecret(params.secret),
      algorithm: (params.algorithm || "SHA1").toUpperCase(),
      digits: Number(params.digits) || 6,
      period: Number(params.period) || 30,
    };
  }

  // ---------- 二维码解码：BarcodeDetector 优先，jsQR 回退 ----------

  var jsqrPromise = null;
  function loadJsQR() {
    if (window.jsQR) return Promise.resolve(window.jsQR);
    if (!jsqrPromise) {
      jsqrPromise = new Promise(function (resolve, reject) {
        var script = document.createElement("script");
        script.src = "/vendor/jsqr.min.js";
        script.onload = function () { resolve(window.jsQR || null); };
        script.onerror = function () { reject(new Error("jsQR 加载失败")); };
        document.head.append(script);
      });
    }
    return jsqrPromise;
  }

  function makeDetector() {
    if (!("BarcodeDetector" in window)) return null;
    try { return new window.BarcodeDetector({ formats: ["qr_code"] }); } catch (error) { return null; }
  }

  function jsqrDecodeCanvas(canvas) {
    return loadJsQR().then(function (jsQR) {
      if (!jsQR) return null;
      var ctx = canvas.getContext("2d", { willReadFrequently: true });
      var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      var result = jsQR(imageData.data, imageData.width, imageData.height);
      return result && result.data ? result.data : null;
    }).catch(function () { return null; });
  }

  function decodeImageFile(file) {
    var detector = makeDetector();
    if (detector && typeof createImageBitmap === "function") {
      return createImageBitmap(file).then(function (bitmap) {
        return detector.detect(bitmap).then(function (results) {
          if (results && results.length && results[0].rawValue) return results[0].rawValue;
          throw new Error("empty");
        });
      }).catch(function () { return decodeImageViaJsQR(file); });
    }
    return decodeImageViaJsQR(file);
  }

  function decodeImageViaJsQR(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var canvas = document.createElement("canvas");
        var scale = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        var ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        jsqrDecodeCanvas(canvas).then(resolve);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  // ---------- 扫码添加 ----------

  function openScanDialog() {
    var body =
      "<div class=\"totp-scan-frame\">" +
      "<video data-scan-video playsinline muted></video>" +
      "<div class=\"totp-scan-fallback\" data-scan-fallback hidden><p>摄像头不可用</p></div>" +
      "</div>" +
      "<div class=\"totp-scan-actions\">" +
      "<button type=\"button\" class=\"secondary\" data-scan-image>选择图片</button>" +
      "<button type=\"button\" class=\"secondary\" data-scan-paste-toggle>粘贴链接</button>" +
      "<input type=\"file\" accept=\"image/*\" hidden data-scan-file />" +
      "</div>" +
      "<div class=\"totp-scan-paste\" data-scan-paste hidden>" +
      "<textarea data-scan-text rows=\"3\" placeholder=\"粘贴 otpauth:// 链接\"></textarea>" +
      "<button type=\"button\" data-scan-text-go>识别</button>" +
      "</div>" +
      "<div class=\"totp-scan-added\" data-scan-added></div>" +
      "<div class=\"manage-actions\"><button type=\"button\" data-scan-done>完成</button></div>";
    var ctrl = C.openManageDialog({
      title: "扫码添加",
      size: "sm",
      bodyHtml: body,
      onClose: function () { stopScan(); },
    });
    var dialog = ctrl.dialog;
    var video = dialog.querySelector("[data-scan-video]");
    var fallback = dialog.querySelector("[data-scan-fallback]");
    var fileInput = dialog.querySelector("[data-scan-file]");
    var addedBox = dialog.querySelector("[data-scan-added]");
    var state = { stream: null, raf: 0, stopped: false, paused: false, lastPayload: "", lastAt: 0, detector: makeDetector(), canvas: document.createElement("canvas") };

    function stopScan() {
      state.stopped = true;
      if (state.raf) window.cancelAnimationFrame(state.raf);
      if (state.stream) {
        state.stream.getTracks().forEach(function (track) { track.stop(); });
        state.stream = null;
      }
    }

    function addChip(item) {
      var chip = document.createElement("span");
      chip.className = "totp-scan-chip";
      chip.textContent = "已添加 " + (item.issuer || "") + (item.account ? " · " + item.account : "");
      addedBox.append(chip);
    }

    function handlePayload(rawText) {
      var text = String(rawText || "").trim();
      if (!text) return;
      var now = Date.now();
      if (text === state.lastPayload && now - state.lastAt < 3000) return;
      state.lastPayload = text;
      state.lastAt = now;
      if (text.indexOf("otpauth-migration://") === 0) {
        ctrl.close();
        openIoDialog("import", { content: text });
        return;
      }
      if (text.indexOf("otpauth://") === 0 && text.indexOf("\n") === -1) {
        var parsed = parseOtpauth(text);
        if (!parsed) {
          C.toast("无法识别这个验证码链接", "danger");
          return;
        }
        state.paused = true;
        openAddDialog(parsed, {
          onAdded: function (payload) { addChip(payload); },
          onClose: function () { state.paused = false; },
        });
        return;
      }
      if (text.indexOf("otpauth://") === 0) {
        ctrl.close();
        openIoDialog("import", { content: text });
        return;
      }
      C.toast("未识别到验证码二维码", "danger");
    }

    function scanLoop() {
      if (state.stopped) return;
      state.raf = window.requestAnimationFrame(scanLoop);
      if (state.paused || !video.srcObject || video.readyState < 2) return;
      var now = Date.now();
      if (state.lastTick && now - state.lastTick < 250) return;
      state.lastTick = now;
      if (state.detector) {
        state.detector.detect(video).then(function (results) {
          if (results && results.length && results[0].rawValue) handlePayload(results[0].rawValue);
        }).catch(function () {});
      } else {
        var canvas = state.canvas;
        var w = video.videoWidth;
        var h = video.videoHeight;
        if (!w || !h) return;
        var scale = Math.min(1, 800 / Math.max(w, h));
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        var ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        jsqrDecodeCanvas(canvas).then(function (text) {
          if (text) handlePayload(text);
        });
      }
    }

    function startCamera() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        fallback.hidden = false;
        video.hidden = true;
        return;
      }
      navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }).then(function (stream) {
        if (state.stopped) {
          stream.getTracks().forEach(function (track) { track.stop(); });
          return;
        }
        state.stream = stream;
        video.srcObject = stream;
        video.play().catch(function () {});
        scanLoop();
      }).catch(function () {
        fallback.hidden = false;
        video.hidden = true;
      });
    }

    dialog.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-scan-done]")) { ctrl.close(); return; }
      if (target.closest("[data-scan-image]")) { fileInput.click(); return; }
      if (target.closest("[data-scan-paste-toggle]")) {
        var paste = dialog.querySelector("[data-scan-paste]");
        if (paste) paste.hidden = !paste.hidden;
        return;
      }
      if (target.closest("[data-scan-text-go]")) {
        var textEl = dialog.querySelector("[data-scan-text]");
        if (textEl && textEl.value.trim()) handlePayload(textEl.value);
      }
    });
    fileInput.addEventListener("change", function () {
      var file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      decodeImageFile(file).then(function (text) {
        if (text) handlePayload(text);
        else C.toast("未识别到二维码", "danger");
      });
    });
    startCamera();
  }

  // ---------- 导入导出 ----------

  function looksEncrypted(text) {
    try {
      var obj = JSON.parse(String(text || ""));
      return !!(obj && typeof obj === "object" && (obj.encrypted || obj.ciphertext || obj.kdf));
    } catch (error) {
      return false;
    }
  }

  function openIoDialog(mode, preset) {
    preset = preset || {};
    var body =
      "<div class=\"segmented totp-io-tabs\" role=\"group\" aria-label=\"导入导出\">" +
      "<button type=\"button\" class=\"segment\" data-io-tab=\"import\" aria-pressed=\"" + (mode === "export" ? "false" : "true") + "\">导入</button>" +
      "<button type=\"button\" class=\"segment\" data-io-tab=\"export\" aria-pressed=\"" + (mode === "export" ? "true" : "false") + "\">导出</button>" +
      "</div>" +
      "<div data-io-pane=\"import\"" + (mode === "export" ? " hidden" : "") + ">" +
      "<div class=\"totp-drop\" data-io-drop>把文件拖到这里，或点这里选择文件<input type=\"file\" hidden data-io-file /></div>" +
      "<label>粘贴内容<textarea data-io-text rows=\"4\">" + esc(preset.content || "") + "</textarea></label>" +
      "<label data-io-pw-row hidden>文件口令<input type=\"password\" data-io-password autocomplete=\"off\" /></label>" +
      "<p class=\"field-error\" data-io-error hidden></p>" +
      "<div class=\"totp-io-actions\"><button type=\"button\" data-io-preview>识别</button></div>" +
      "<div data-io-confirm></div>" +
      "</div>" +
      "<div data-io-pane=\"export\"" + (mode === "export" ? "" : " hidden") + ">" +
      "<div class=\"tag-field\"><span>范围</span>" + segmentedHtml("exp_scope", [["all", "全部"], ["group", "当前分组"]], "all") + "</div>" +
      "<div class=\"tag-field\"><span>格式</span>" + segmentedHtml("exp_format", [["hivemos", "HiveMos JSON"], ["aegis", "Aegis JSON"], ["otpauth", "验证码链接"]], "hivemos") + "</div>" +
      "<div data-exp-encrypt-row>" + switchHtml("exp_encrypt", true, "用口令加密") + "</div>" +
      "<label data-exp-pw-row>口令<input type=\"password\" data-exp-password autocomplete=\"off\" /></label>" +
      "<p class=\"subtle\" data-exp-note>口令忘了无法找回</p>" +
      "<p class=\"subtle\" data-exp-warn hidden>文件包含明文密钥</p>" +
      "<label>管理员密码<input type=\"password\" data-exp-current autocomplete=\"off\" /></label>" +
      "<p class=\"field-error\" data-exp-error hidden></p>" +
      "<div class=\"totp-io-actions\"><button type=\"button\" data-io-export>导出</button></div>" +
      "</div>";
    var ctrl = C.openManageDialog({ title: "导入导出", size: "md", bodyHtml: body });
    var dialog = ctrl.dialog;
    C.refreshSelects(dialog);
    var ioState = { preview: null, selected: {}, content: preset.content || "" };

    function setIoError(message) {
      var el = dialog.querySelector("[data-io-error]");
      if (!el) return;
      el.textContent = message || "";
      el.hidden = !message;
    }
    function setExpError(message) {
      var el = dialog.querySelector("[data-exp-error]");
      if (!el) return;
      el.textContent = message || "";
      el.hidden = !message;
    }

    function renderConfirm() {
      var box = dialog.querySelector("[data-io-confirm]");
      if (!box || !ioState.preview) return;
      var items = ioState.preview.items || [];
      var main = "";
      var unsupported = "";
      items.forEach(function (item, position) {
        var idx = typeof item.index === "number" ? item.index : position;
        var label = esc((item.issuer || "") + (item.account ? " · " + item.account : ""));
        if (item.supported === false) {
          unsupported += "<div class=\"totp-import-row is-off\"><span>" + label + "</span><span class=\"subtle\">" + esc(item.reason || "不支持") + "</span></div>";
          return;
        }
        if (item.duplicate) {
          main += "<div class=\"totp-import-row is-off\"><span>" + label + "</span><span class=\"subtle\">已存在</span></div>";
          return;
        }
        var on = ioState.selected[idx] !== false;
        main +=
          "<button type=\"button\" class=\"totp-import-row\" data-import-row=\"" + idx + "\" aria-pressed=\"" + (on ? "true" : "false") + "\">" +
          "<span>" + label + "</span><span class=\"totp-import-check\" aria-hidden=\"true\">" + (on ? "✓" : "") + "</span></button>";
      });
      var count = selectedEntries().length;
      box.innerHTML =
        (main ? "<div class=\"totp-import-list\">" + main + "</div>" : "") +
        (unsupported ? "<p class=\"subtle totp-import-unsupported-title\">不支持的条目</p><div class=\"totp-import-list\">" + unsupported + "</div>" : "") +
        "<div class=\"totp-io-actions\"><button type=\"button\" data-io-import" + (count ? "" : " disabled") + ">导入 " + count + " 个</button></div>";
    }

    function selectedEntries() {
      if (!ioState.preview) return [];
      var entries = ioState.preview.entries || [];
      var picked = [];
      (ioState.preview.items || []).forEach(function (item, position) {
        var idx = typeof item.index === "number" ? item.index : position;
        if (item.supported === false || item.duplicate) return;
        if (ioState.selected[idx] === false) return;
        var entry = entries[idx] || entries[position];
        if (entry) picked.push(entry);
      });
      return picked;
    }

    function runPreview() {
      var textEl = dialog.querySelector("[data-io-text]");
      var content = textEl ? textEl.value : ioState.content;
      if (!content || !content.trim()) { setIoError("先粘贴内容或选择文件"); return; }
      if (content.length > 512 * 1024) { setIoError("内容超过 512 KB"); return; }
      ioState.content = content;
      var pwRow = dialog.querySelector("[data-io-pw-row]");
      var pwEl = dialog.querySelector("[data-io-password]");
      if (looksEncrypted(content) && pwRow && pwRow.hidden) {
        pwRow.hidden = false;
        setIoError("这个文件已加密，填入口令后再点识别");
        return;
      }
      var payload = { content: content };
      if (pwEl && pwEl.value) payload.password = pwEl.value;
      setIoError("");
      api("POST", "/api/vault/totp/import/preview", payload).then(function (result) {
        if (result.data && result.data.ok && Array.isArray(result.data.items)) {
          ioState.preview = result.data;
          ioState.selected = {};
          renderConfirm();
        } else {
          var message = (result.data && result.data.error) || "识别失败";
          if (pwRow && (result.data && result.data.needsPassword || message.indexOf("口令") > -1)) {
            pwRow.hidden = false;
          }
          setIoError(message);
        }
      }).catch(function () { setIoError("网络异常，请重试"); });
    }

    function syncExportVisibility() {
      var format = formVal(dialog, "exp_format") || "hivemos";
      var encryptOn = formVal(dialog, "exp_encrypt") === "1";
      var isHivemos = format === "hivemos";
      var encRow = dialog.querySelector("[data-exp-encrypt-row]");
      var pwRow = dialog.querySelector("[data-exp-pw-row]");
      var note = dialog.querySelector("[data-exp-note]");
      var warn = dialog.querySelector("[data-exp-warn]");
      if (encRow) encRow.hidden = !isHivemos;
      if (pwRow) pwRow.hidden = !(isHivemos && encryptOn);
      if (note) note.hidden = !(isHivemos && encryptOn);
      if (warn) warn.hidden = isHivemos;
    }
    wireFormBits(dialog, syncExportVisibility);
    syncExportVisibility();

    var drop = dialog.querySelector("[data-io-drop]");
    var fileInput = dialog.querySelector("[data-io-file]");
    function readImportFile(file) {
      if (!file) return;
      if (file.size > 512 * 1024) { setIoError("文件超过 512 KB"); return; }
      file.text().then(function (text) {
        var textEl = dialog.querySelector("[data-io-text]");
        if (textEl) textEl.value = text;
        ioState.content = text;
        if (looksEncrypted(text)) {
          var pwRow = dialog.querySelector("[data-io-pw-row]");
          if (pwRow) pwRow.hidden = false;
        }
        runPreview();
      }).catch(function () { setIoError("文件读取失败"); });
    }
    if (drop && fileInput) {
      drop.addEventListener("click", function () { fileInput.click(); });
      fileInput.addEventListener("change", function () {
        readImportFile(fileInput.files && fileInput.files[0]);
        fileInput.value = "";
      });
      drop.addEventListener("dragover", function (event) {
        event.preventDefault();
        drop.classList.add("is-over");
      });
      drop.addEventListener("dragleave", function () { drop.classList.remove("is-over"); });
      drop.addEventListener("drop", function (event) {
        event.preventDefault();
        drop.classList.remove("is-over");
        var file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
        readImportFile(file);
      });
    }

    dialog.addEventListener("click", function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var tab = target.closest("[data-io-tab]");
      if (tab) {
        var which = tab.getAttribute("data-io-tab");
        dialog.querySelectorAll("[data-io-tab]").forEach(function (peer) {
          peer.setAttribute("aria-pressed", peer === tab ? "true" : "false");
        });
        dialog.querySelectorAll("[data-io-pane]").forEach(function (pane) {
          pane.hidden = pane.getAttribute("data-io-pane") !== which;
        });
        return;
      }
      if (target.closest("[data-io-preview]")) { runPreview(); return; }
      var row = target.closest("[data-import-row]");
      if (row) {
        var idx = row.getAttribute("data-import-row");
        ioState.selected[idx] = ioState.selected[idx] === false ? true : false;
        renderConfirm();
        return;
      }
      if (target.closest("[data-io-import]")) {
        var entries = selectedEntries();
        if (!entries.length) return;
        api("POST", "/api/vault/totp/import/confirm", { entries: entries }).then(function (result) {
          if (result.data && result.data.ok) {
            var imported = typeof result.data.imported === "number" ? result.data.imported : entries.length;
            var skipped = typeof result.data.skipped === "number" ? result.data.skipped : 0;
            C.toast(skipped > 0 ? "已导入 " + imported + " 个，跳过 " + skipped + " 个" : "已导入 " + imported + " 个");
            ctrl.close();
            loadEntries();
          } else {
            setIoError((result.data && result.data.error) || "导入失败");
          }
        }).catch(function () { setIoError("网络异常，请重试"); });
        return;
      }
      if (target.closest("[data-io-export]")) {
        var scope = formVal(dialog, "exp_scope") || "all";
        var format = formVal(dialog, "exp_format") || "hivemos";
        var currentEl = dialog.querySelector("[data-exp-current]");
        var currentPassword = currentEl ? currentEl.value : "";
        if (scope === "group" && !S.groupFilter) { setExpError("先在页面上选一个分组"); return; }
        if (!currentPassword) { setExpError("请填写管理员密码"); return; }
        var encrypt = format === "hivemos" && formVal(dialog, "exp_encrypt") === "1";
        var pwEl2 = dialog.querySelector("[data-exp-password]");
        if (encrypt && !(pwEl2 && pwEl2.value)) { setExpError("请填写导出口令"); return; }
        var payload2 = { scope: scope, format: format, encrypt: encrypt, currentPassword: currentPassword };
        if (scope === "group") payload2.group_id = S.groupFilter === "__none__" ? null : S.groupFilter;
        if (encrypt && pwEl2) payload2.password = pwEl2.value;
        setExpError("");
        api("POST", "/api/vault/totp/export", payload2).then(function (result) {
          if (result.data && result.data.ok && typeof result.data.content === "string") {
            var blob = new Blob([result.data.content], { type: "application/octet-stream" });
            var url = URL.createObjectURL(blob);
            var a = document.createElement("a");
            a.href = url;
            a.download = result.data.filename || "hivemos-totp.json";
            document.body.append(a);
            a.click();
            a.remove();
            window.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
            C.toast("已导出");
            ctrl.close();
          } else {
            setExpError((result.data && result.data.error) || "导出失败");
          }
        }).catch(function () { setExpError("网络异常，请重试"); });
      }
    });

    if (preset.content) runPreview();
  }

  // ---------- 对外接口（vault.js 调用） ----------

  window.HiveVaultTotp = {
    afterRender: function (isActive) {
      S.active = !!isActive;
      paint();
      if (S.active) {
        if (!S.loaded) loadAll();
        else {
          fetchCodes();
          startTick();
        }
      } else {
        stopTick();
      }
    },
    openAdd: openAddDialog,
    openScan: openScanDialog,
    openIo: openIoDialog,
  };

  // 本脚本后于 vault.js 加载：首屏若已在验证码页签，主动补一次
  if (location.hash === "#totp") {
    S.active = true;
    paint();
    loadAll();
  }
})();
