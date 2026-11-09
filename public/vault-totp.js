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
        "<button type=\"button\" data-totp-act=\"add\">手动添加</button>" +
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
    html += "<button type=\"button\" class=\"totp-chip totp-chip-add\" data-action=\"add-vgroup\">添加分组</button>";
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

  function switchHtml(field, on) {
    return (
      "<span class=\"totp-switch-row\"><span>允许 AI 读取</span>" +
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
      "<label>密钥<input name=\"secret\" maxlength=\"512\" autocomplete=\"off\" value=\"" + esc(v.secret || "") + "\" />" +
      "<p class=\"subtle totp-preview\" data-add-preview></p></label>" +
      "<button type=\"button\" class=\"ghost totp-more-toggle\" data-more-toggle aria-expanded=\"false\">更多选项</button>" +
      "<div class=\"totp-more\" data-more hidden>" +
      "<div class=\"tag-field\"><span>算法</span>" + segmentedHtml("algorithm", [["SHA1", "SHA1"], ["SHA256", "SHA256"], ["SHA512", "SHA512"]], v.algorithm || "SHA1") + "</div>" +
      "<div class=\"tag-field\"><span>位数</span>" + segmentedHtml("digits", [["6", "6 位"], ["7", "7 位"], ["8", "8 位"]], String(v.digits || 6)) + "</div>" +
      "<label>周期（秒）<input name=\"period\" type=\"number\" min=\"5\" max=\"600\" step=\"1\" inputmode=\"numeric\" value=\"" + esc(v.period || 30) + "\" /></label>" +
      "<label>分组" + C.groupSelect("group_id", S.groups || [], v.group_id || "") + "</label>" +
      "<label>备注<textarea name=\"note\" rows=\"2\" maxlength=\"300\">" + esc(v.note || "") + "</textarea></label>" +
      switchHtml("ai_read", v.ai_read !== false) +
      "</div>";
    var ctrl = C.openFormDialog({
      title: "添加验证码",
      bodyHtml: body,
      submitLabel: "添加",
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

  function openManage(entry) {
    var state = { icon: entry.icon || "" };
    var body =
      "<div class=\"totp-form-icon-row\">" +
      "<button type=\"button\" class=\"totp-icon-btn\" data-mng-icon aria-label=\"选择图标\">" + iconPreviewHtml(state.icon, entry.issuer || "") + "</button>" +
      "<span class=\"subtle\">图标</span></div>" +
      "<label>服务名<input name=\"issuer\" maxlength=\"120\" autocomplete=\"off\" value=\"" + esc(entry.issuer || "") + "\" /></label>" +
      "<label>账号<input name=\"account\" maxlength=\"200\" autocomplete=\"off\" value=\"" + esc(entry.account || "") + "\" /></label>" +
      "<label>分组" + C.groupSelect("group_id", S.groups || [], entry.group_id || "") + "</label>" +
      "<label>备注<textarea name=\"note\" rows=\"2\" maxlength=\"300\">" + esc(entry.note || "") + "</textarea></label>" +
      switchHtml("ai_read", entry.ai_read !== false) +
      "<div class=\"totp-secret-row\"><span>密钥</span><span data-totp-secret-zone>" +
      "<button type=\"button\" class=\"secondary\" data-totp-reveal>显示密钥</button></span></div>" +
      "<p class=\"field-error\" data-mng-error hidden></p>" +
      "<div class=\"manage-actions\">" +
      "<button type=\"button\" class=\"danger\" data-confirm-delete data-totp-delete=\"" + esc(entry.id) + "\">删除</button>" +
      "<button type=\"button\" data-totp-save>保存</button>" +
      "</div>";
    var ctrl = C.openManageDialog({ title: entry.issuer || "验证码", size: "sm", bodyHtml: body });
    var dialog = ctrl.dialog;
    C.refreshSelects(dialog);
    wireFormBits(dialog, null);
    var revealArmed = false;
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
      var revealBtn = target.closest("[data-totp-reveal]");
      if (revealBtn) {
        if (!revealArmed) {
          revealArmed = true;
          revealBtn.textContent = "再点一次显示";
          window.setTimeout(function () {
            revealArmed = false;
            if (revealBtn.isConnected) revealBtn.textContent = "显示密钥";
          }, 3500);
          return;
        }
        revealBtn.disabled = true;
        api("POST", "/api/vault/reveal", { kind: "totp", id: entry.id }).then(function (result) {
          var zone = dialog.querySelector("[data-totp-secret-zone]");
          if (!zone || !dialog.isConnected) return;
          var value = result.data && result.data.ok && result.data.reveal ? result.data.reveal.value : null;
          if (typeof value === "string" && value) {
            var shown = esc(value);
            zone.innerHTML = "<span class=\"copy-text\" data-copy=\"" + shown + "\" data-label=\"" + shown + "\" title=\"点击复制\">" + shown + "</span>";
          } else {
            C.toast((result.data && result.data.error) || "读取失败", "danger");
            revealBtn.disabled = false;
            revealBtn.textContent = "显示密钥";
            revealArmed = false;
          }
        }).catch(function () {
          if (!dialog.isConnected) return;
          C.toast("网络异常，请重试", "danger");
          revealBtn.disabled = false;
          revealBtn.textContent = "显示密钥";
          revealArmed = false;
        });
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
        if (actBtn.getAttribute("data-totp-act") === "add") openAddDialog(null);
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
  };

  // 本脚本后于 vault.js 加载：首屏若已在验证码页签，主动补一次
  if (location.hash === "#totp") {
    S.active = true;
    paint();
    loadAll();
  }
})();
