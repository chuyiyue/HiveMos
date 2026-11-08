/* 任务与日历合并板块。任务走 /api/tasks 接口（面板 REST，Agent 侧走 tasks_* 工具）；
   日历为一期真实功能，走 /api/calendar/* 接口（日历/日程/订阅令牌） */
(function () {
  var C = window.HiveCommon;
  var activeTab = location.hash === "#calendar" ? "calendar" : "tasks";
  function now() {
    var d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function val(ctrl, name) {
    var el = ctrl.form.querySelector("[name=\"" + name + "\"]");
    return el ? el.value.trim() : "";
  }

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

  // ------------------------------------------------------------------ tasks
  var STATUS_OPTIONS = [
    ["queued", "排队"],
    ["active", "进行中"],
    ["done", "已完成"],
  ];
  var taskState = { loaded: false, loading: false, error: "", tasks: [] };

  function taskById(id) {
    for (var i = 0; i < taskState.tasks.length; i++) if (taskState.tasks[i].id === id) return taskState.tasks[i];
    return null;
  }

  function loadTasks() {
    if (taskState.loading) return;
    taskState.loading = true;
    api("GET", "/api/tasks").then(function (res) {
      taskState.loading = false;
      if (res.status === 401) { location.assign("/login.html?next=" + encodeURIComponent(location.pathname)); return; }
      if (!res.data.ok) { taskState.error = res.data.error || "任务读取失败"; render(); return; }
      taskState.error = "";
      taskState.tasks = res.data.tasks || [];
      taskState.loaded = true;
      render();
    }).catch(function () {
      taskState.loading = false;
      taskState.error = "任务读取失败，请稍后重试";
      render();
    });
  }

  function refreshTasks() {
    taskState.loaded = false;
    loadTasks();
  }

  // 添加与编辑共用同一套字段构建；item 为空是添加，传入条目是编辑并预填
  function taskFields(item) {
    var v = item || { title: "", from: "", assignee: "", note: "", status: "queued" };
    var options = STATUS_OPTIONS.map(function (pair) {
      return "<option value=\"" + pair[0] + "\"" + (v.status === pair[0] ? " selected" : "") + ">" + pair[1] + "</option>";
    }).join("");
    return (
      "<label>标题<input name=\"title\" maxlength=\"80\" autocomplete=\"off\" value=\"" + C.escapeHtml(v.title || "") + "\" /></label>" +
      "<label>从<input name=\"from\" maxlength=\"40\" autocomplete=\"off\" placeholder=\"发起的 Agent\" value=\"" + C.escapeHtml(v.from || "") + "\" /></label>" +
      "<label>到<input name=\"assignee\" maxlength=\"40\" autocomplete=\"off\" placeholder=\"接收的 Agent\" value=\"" + C.escapeHtml(v.assignee || "") + "\" /></label>" +
      "<label>备注<textarea name=\"note\" rows=\"3\" maxlength=\"2000\">" + C.escapeHtml(v.note || "") + "</textarea></label>" +
      "<label>状态<select name=\"status\">" + options + "</select></label>"
    );
  }

  function openTaskDialog(item) {
    var editing = !!item;
    C.openFormDialog({
      title: editing ? "编辑任务" : "添加任务",
      bodyHtml: taskFields(item),
      submitLabel: editing ? "保存" : "添加",
      onSubmit: function (ctrl) {
        var title = val(ctrl, "title");
        if (!title) { ctrl.setError("请填写标题"); return; }
        var payload = {
          title: title,
          from: val(ctrl, "from"),
          assignee: val(ctrl, "assignee"),
          note: val(ctrl, "note"),
          status: val(ctrl, "status") || "queued",
        };
        ctrl.setBusy(true);
        var request = editing
          ? api("PATCH", "/api/tasks/" + encodeURIComponent(item.id), payload)
          : api("POST", "/api/tasks", payload);
        request.then(function (res) {
          if (!res.data.ok) { ctrl.setBusy(false); ctrl.setError(res.data.error || "保存失败"); return; }
          ctrl.close();
          refreshTasks();
        }).catch(function () {
          ctrl.setBusy(false);
          ctrl.setError("保存失败，请稍后重试");
        });
      },
    });
  }

  function completeTask(item) {
    api("POST", "/api/tasks/" + encodeURIComponent(item.id) + "/complete").then(function (res) {
      if (!res.data.ok) { taskState.error = res.data.error || "操作失败"; render(); return; }
      refreshTasks();
    }).catch(function () {
      taskState.error = "操作失败，请稍后重试";
      render();
    });
  }

  function deleteTask(item, anchor) {
    C.askConfirm({
      anchor: anchor,
      title: "删除任务",
      text: "确认删除任务「" + item.title + "」吗？删除后无法恢复",
      confirmLabel: "删除",
      danger: true,
    }).then(function (yes) {
      if (!yes) return;
      api("DELETE", "/api/tasks/" + encodeURIComponent(item.id)).then(function (res) {
        if (!res.data.ok) { taskState.error = res.data.error || "删除失败"; render(); return; }
        refreshTasks();
      });
    });
  }

  function openTaskMenu(item, anchor) {
    var items = [
      {
        label: "编辑",
        onSelect: function () { openTaskDialog(item); },
      },
    ];
    if (item.status !== "done") {
      items.push({
        label: "标记完成",
        onSelect: function () { completeTask(item); },
      });
    }
    items.push({
      label: "删除",
      danger: true,
      onSelect: function () { deleteTask(item, anchor); },
    });
    C.openActionMenu({
      title: item.title,
      items: items,
    });
  }

  // --------------------------------------------------------------- calendar
  var SOURCE_LABEL = { panel: "面板", mcp: "Agent", caldav: "设备", import: "导入", mirror: "订阅同步" };
  var KIND_LABEL = { native: "原生", mirror: "订阅", imported: "导入" };
  var browserTz = "Asia/Shanghai";
  try { browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || browserTz; } catch (e) { /* keep default */ }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function dateKeyOf(y, mo, d) { return y + "-" + pad2(mo) + "-" + pad2(d); }

  function tzParts(ms, tzid) {
    var fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid || undefined, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    var bag = {};
    fmt.formatToParts(new Date(ms)).forEach(function (part) { bag[part.type] = part.value; });
    return { y: Number(bag.year), mo: Number(bag.month), d: Number(bag.day), h: Number(bag.hour) % 24, mi: Number(bag.minute), s: Number(bag.second) };
  }
  function instanceDateKey(inst) {
    var ms = Date.parse(inst.start);
    if (inst.all_day) {
      var dt = new Date(ms);
      return dateKeyOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
    var p = tzParts(ms, inst.tzid || browserTz);
    return dateKeyOf(p.y, p.mo, p.d);
  }
  function timeRangeText(inst) {
    if (inst.all_day) return "全天";
    var start = tzParts(Date.parse(inst.start), inst.tzid || browserTz);
    var end = tzParts(Date.parse(inst.end), inst.tzid || browserTz);
    return pad2(start.h) + ":" + pad2(start.mi) + " – " + pad2(end.h) + ":" + pad2(end.mi);
  }
  function tzOffsetMs(ms, tzid) {
    var p = tzParts(ms, tzid);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
  }
  function wallToUtcMs(y, mo, d, h, mi, tzid) {
    var guess = Date.UTC(y, mo - 1, d, h, mi, 0);
    var utc = guess - tzOffsetMs(guess, tzid);
    return guess - tzOffsetMs(utc, tzid);
  }
  function parseLocalInput(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value || "");
    if (!m) return null;
    return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), h: Number(m[4]), mi: Number(m[5]) };
  }
  function localInputValue(ms, tzid) {
    var p = tzParts(ms, tzid);
    return p.y + "-" + pad2(p.mo) + "-" + pad2(p.d) + "T" + pad2(p.h) + ":" + pad2(p.mi);
  }

  var todayDate = new Date();
  var cal = {
    loaded: false,
    loading: false,
    error: "",
    notice: "",
    noticeDanger: false,
    calendars: [],
    instances: [],
    byKey: {},
    feeds: [],
    year: todayDate.getFullYear(),
    month: todayDate.getMonth(),
    selected: dateKeyOf(todayDate.getFullYear(), todayDate.getMonth() + 1, todayDate.getDate()),
  };

  function calById(id) {
    for (var i = 0; i < cal.calendars.length; i++) if (cal.calendars[i].id === id) return cal.calendars[i];
    return null;
  }
  function writableCalendars() {
    return cal.calendars.filter(function (item) { return item.kind !== "mirror"; });
  }
  function instKey(inst) { return inst.event_id + "@" + inst.start; }

  function loadCalendar() {
    if (cal.loading) return;
    cal.loading = true;
    var from = new Date(Date.UTC(cal.year, cal.month, 1) - 7 * 86400000).toISOString();
    var to = new Date(Date.UTC(cal.year, cal.month + 1, 1) + 7 * 86400000).toISOString();
    Promise.all([
      api("GET", "/api/calendar/calendars"),
      api("GET", "/api/calendar/events?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to)),
      api("GET", "/api/calendar/feeds"),
    ]).then(function (results) {
      cal.loading = false;
      if (results[0].status === 401) { location.assign("/login.html?next=" + encodeURIComponent(location.pathname + "#calendar")); return; }
      if (!results[0].data.ok) { cal.error = results[0].data.error || "日历读取失败"; render(); return; }
      cal.error = "";
      cal.calendars = results[0].data.calendars || [];
      cal.instances = (results[1].data && results[1].data.instances) || [];
      cal.feeds = (results[2].data && results[2].data.feeds) || [];
      cal.byKey = {};
      cal.instances.forEach(function (inst) { cal.byKey[instKey(inst)] = inst; });
      cal.loaded = true;
      render();
    }).catch(function () {
      cal.loading = false;
      cal.error = "日历读取失败，请稍后重试";
      render();
    });
  }

  function setNotice(text, danger) {
    cal.notice = text || "";
    cal.noticeDanger = !!danger;
  }

  function calendarRecord(item) {
    var facts = [
      ["类型", C.escapeHtml(KIND_LABEL[item.kind] || item.kind) + (item.is_default ? " · 默认" : "")],
      ["时区", C.escapeHtml(item.timezone || "")],
    ];
    if (item.kind === "mirror") {
      facts.push(["来源", C.escapeHtml((item.source_host || "") + "…" + (item.source_tail || ""))]);
      facts.push(["上次同步", C.escapeHtml(item.last_sync_at ? (C.formatMinute(item.last_sync_at) || "") : "还没同步") + (item.sync_status === "error" ? " · 失败：" + (item.sync_error || "") : "")]);
    }
    return C.record({
      id: "calrow-" + item.id,
      title: item.name,
      status: item.kind === "mirror" ? "idle" : "active",
      lede: item.kind === "mirror" ? "只读 · 外部订阅" : "",
      extra: '<span class="cal-dot" style="background:' + C.escapeHtml(item.color || "#D97757") + '"></span>',
      facts: facts,
    }) + "";
  }

  function calendarListHtml() {
    if (!cal.calendars.length) return C.emptyState("还没有日历", "点上方「添加日历」新建，或订阅一个外部日历");
    return C.list(cal.calendars.map(function (item) {
      var recordHtml = calendarRecord(item);
      var button = '<div class="row-actions"><button type="button" class="secondary" data-action="cal-menu" data-id="' + C.escapeHtml(item.id) + '">管理</button></div>';
      return recordHtml.replace("</article>", button + "</article>");
    }).join(""));
  }

  function monthGridHtml() {
    var firstDow = (new Date(cal.year, cal.month, 1).getDay() + 6) % 7;
    var daysInMonth = new Date(cal.year, cal.month + 1, 0).getDate();
    var byDay = {};
    cal.instances.forEach(function (inst) {
      var key = instanceDateKey(inst);
      (byDay[key] = byDay[key] || []).push(inst);
    });
    var head = ["一", "二", "三", "四", "五", "六", "日"].map(function (d) { return "<div class=\"cal-dow\">" + d + "</div>"; }).join("");
    var cells = "";
    for (var i = 0; i < firstDow; i++) cells += "<div class=\"cal-cell cal-pad\"></div>";
    var todayKey = dateKeyOf(todayDate.getFullYear(), todayDate.getMonth() + 1, todayDate.getDate());
    for (var d = 1; d <= daysInMonth; d++) {
      var key = dateKeyOf(cal.year, cal.month + 1, d);
      var cls = "cal-cell" + (key === todayKey ? " cal-today" : "") + (key === cal.selected ? " cal-selected" : "");
      var chips = "";
      (byDay[key] || []).slice(0, 3).forEach(function (inst) {
        var owner = calById(inst.calendar_id);
        var color = owner ? owner.color : "#D97757";
        chips += "<span class=\"cal-event\" data-event-key=\"" + C.escapeHtml(instKey(inst)) + "\" style=\"background:" + C.escapeHtml(color) + "2e;border-left:3px solid " + C.escapeHtml(color) + "\">" + C.escapeHtml(inst.title) + "</span>";
      });
      if ((byDay[key] || []).length > 3) chips += "<span class=\"cal-more\">还有 " + ((byDay[key] || []).length - 3) + " 条</span>";
      cells += "<div class=\"" + cls + "\" data-day=\"" + key + "\"><span class=\"cal-day\">" + d + "</span>" + chips + "</div>";
    }
    return "<div class=\"cal-grid\">" + head + cells + "</div>";
  }

  function dayListHtml() {
    var dayInsts = cal.instances.filter(function (inst) { return instanceDateKey(inst) === cal.selected; });
    if (!dayInsts.length) return C.emptyState("这一天没有日程", "点上方「添加日程」新建");
    return C.list(dayInsts.map(function (inst) {
      var owner = calById(inst.calendar_id);
      var facts = [
        ["时间", C.escapeHtml(timeRangeText(inst))],
        ["日历", C.escapeHtml(owner ? owner.name : "")],
        ["来源", C.escapeHtml(SOURCE_LABEL[inst.source] || inst.source || "")],
      ];
      if (inst.location) facts.push(["地点", C.escapeHtml(inst.location)]);
      if (inst.recurring) facts.push(["重复", inst.is_exception ? "系列中的一次（已单独修改）" : "重复日程"]);
      var html = C.record({
        id: "evrow-" + instKey(inst).replace(/[^A-Za-z0-9_-]/g, "_"),
        title: inst.title,
        status: inst.status === "cancelled" ? "disabled" : "active",
        facts: facts,
      });
      var button = '<div class="row-actions"><button type="button" class="secondary" data-action="event-menu" data-key="' + C.escapeHtml(instKey(inst)) + '">管理</button></div>';
      return html.replace("</article>", button + "</article>");
    }).join(""));
  }

  function feedsHtml() {
    var addButton = '<button type="button" class="secondary" data-action="add-feed">新建订阅</button>';
    if (!cal.feeds.length) return C.section("订阅链接", "给手机或电脑日历用的只读订阅地址", C.emptyState("还没有订阅链接", "新建一条后，把地址填进设备日历的订阅日历里就能看到全部日程"), addButton);
    var rows = cal.feeds.map(function (feed) {
      var scope = feed.calendar_id ? (calById(feed.calendar_id) ? calById(feed.calendar_id).name : "指定日历") : "全部日历";
      var html = C.record({
        id: "feedrow-" + feed.id,
        title: feed.name,
        status: feed.revoked ? "disabled" : "active",
        facts: [
          ["范围", C.escapeHtml(scope)],
          ["最近使用", C.escapeHtml(feed.last_used_at ? (C.formatMinute(feed.last_used_at) || "未知") : "还没被拉取")],
        ],
      });
      var button = feed.revoked ? "" : '<div class="row-actions"><button type="button" class="secondary" data-action="feed-revoke" data-id="' + C.escapeHtml(feed.id) + '">吊销</button></div>';
      return html.replace("</article>", button + "</article>");
    }).join("");
    return C.section("订阅链接", "刷新间隔由设备日历决定，不是实时同步", C.list(rows), addButton);
  }

  function calendarHtml() {
    if (!cal.loaded) {
      if (cal.error) return "<div class=\"stack\">" + C.section("日历", "", '<p class="callout danger" role="alert">' + C.escapeHtml(cal.error) + "</p>") + "</div>";
      return "<div class=\"stack\">" + C.section("日历", "", C.emptyState("正在读取", "稍等片刻")) + "</div>";
    }
    var nav =
      '<button type="button" class="secondary" data-action="cal-prev">上个月</button> ' +
      '<button type="button" class="secondary" data-action="cal-next">下个月</button>';
    return (
      "<div class=\"stack\">" +
      C.addBar({ addLabel: "添加日程", addAction: "add-event", groupLabel: "添加日历", groupAction: "add-calendar" }) +
      (cal.notice ? '<p class="callout' + (cal.noticeDanger ? " danger" : "") + '" role="status">' + C.escapeHtml(cal.notice) + "</p>" : "") +
      (cal.error ? '<p class="callout danger" role="alert">' + C.escapeHtml(cal.error) + "</p>" : "") +
      C.section("日历", cal.calendars.length + " 个", calendarListHtml()) +
      C.section("月视图", cal.year + " 年 " + (cal.month + 1) + " 月", monthGridHtml(), nav) +
      C.section(cal.selected + " 的日程", "", dayListHtml()) +
      feedsHtml() +
      "</div>"
    );
  }

  // ------------------------------------------------------------ cal dialogs
  function calendarOptions(selectedId) {
    return writableCalendars().map(function (item) {
      return '<option value="' + C.escapeHtml(item.id) + '"' + (item.id === selectedId ? " selected" : "") + ">" + C.escapeHtml(item.name) + "</option>";
    }).join("");
  }

  function openAddCalendar() {
    var ctrl = C.openFormDialog({
      title: "添加日历",
      bodyHtml:
        "<label>类型<select name=\"kind\"><option value=\"native\">新建日历</option><option value=\"mirror\">订阅外部日历</option><option value=\"import\">导入 ICS</option></select></label>" +
        "<label>名称<input name=\"name\" maxlength=\"80\" autocomplete=\"off\" /></label>" +
        "<div data-kind-fields=\"native import\"><label>颜色<input name=\"color\" maxlength=\"7\" value=\"#D97757\" autocomplete=\"off\" /></label>" +
        "<label>时区<input name=\"timezone\" maxlength=\"64\" value=\"" + C.escapeHtml(browserTz) + "\" autocomplete=\"off\" /></label></div>" +
        "<div data-kind-fields=\"mirror\" hidden><label>ICS 订阅链接<input name=\"source_url\" maxlength=\"2000\" autocomplete=\"off\" placeholder=\"https://…\" /></label></div>" +
        "<div data-kind-fields=\"import\" hidden><label>ICS 内容<textarea name=\"ics\" rows=\"6\" placeholder=\"把 .ics 文件内容粘贴到这里\"></textarea></label>" +
        "<label>或选择文件<input type=\"file\" name=\"ics_file\" accept=\".ics,text/calendar\" /></label></div>",
      submitLabel: "添加",
      onSubmit: function (c) {
        var kind = val(c, "kind");
        var name = val(c, "name");
        if (!name) { c.setError("请填写名称"); return; }
        if (kind === "mirror") {
          var url = val(c, "source_url");
          if (!/^https?:\/\//i.test(url)) { c.setError("请填写 http 或 https 的 ICS 链接"); return; }
          c.setBusy(true);
          api("POST", "/api/calendar/calendars", { name: name, kind: "mirror", source_url: url }).then(function (res) {
            c.setBusy(false);
            if (!res.data.ok) { c.setError(res.data.error || "添加失败"); return; }
            var sync = res.data.sync || {};
            setNotice(sync.ok ? "订阅日历已添加，首次同步完成：新增 " + (sync.added || 0) + " 条" : "订阅日历已添加，但首次同步失败：" + (sync.error || "未知错误"), !sync.ok);
            c.close();
            cal.loaded = false;
            loadCalendar();
          });
          return;
        }
        if (kind === "import") {
          var ics = val(c, "ics");
          if (!ics) { c.setError("请粘贴 ICS 内容或选择文件"); return; }
          c.setBusy(true);
          api("POST", "/api/calendar/import", { new_calendar_name: name, ics: ics }).then(function (res) {
            c.setBusy(false);
            if (!res.data.ok) { c.setError(res.data.error || "导入失败"); return; }
            var report = res.data.import || {};
            var text = "导入完成：新建 " + report.created + " 条、更新 " + report.updated + " 条";
            if (report.duplicates && report.duplicates.length) text += "；疑似重复 " + report.duplicates.length + " 条已跳过，需要时勾选「包含疑似重复」重新导入";
            c.showResult("<p>" + C.escapeHtml(text) + "</p>", "完成");
            setNotice(text, false);
            cal.loaded = false;
            loadCalendar();
          });
          return;
        }
        c.setBusy(true);
        api("POST", "/api/calendar/calendars", { name: name, kind: "native", color: val(c, "color") || "#D97757", timezone: val(c, "timezone") || browserTz }).then(function (res) {
          c.setBusy(false);
          if (!res.data.ok) { c.setError(res.data.error || "添加失败"); return; }
          setNotice("日历已添加", false);
          c.close();
          cal.loaded = false;
          loadCalendar();
        });
      },
    });
    var kindSelect = ctrl.form.querySelector("[name=\"kind\"]");
    var fileInput = ctrl.form.querySelector("[name=\"ics_file\"]");
    function syncKind() {
      var kind = kindSelect.value;
      ctrl.form.querySelectorAll("[data-kind-fields]").forEach(function (box) {
        box.hidden = box.getAttribute("data-kind-fields").split(" ").indexOf(kind) === -1;
      });
    }
    kindSelect.addEventListener("change", syncKind);
    syncKind();
    if (fileInput) {
      fileInput.addEventListener("change", function () {
        var file = fileInput.files && fileInput.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          var textarea = ctrl.form.querySelector("[name=\"ics\"]");
          if (textarea) textarea.value = String(reader.result || "");
        };
        reader.readAsText(file);
      });
    }
  }

  function openCalendarMenu(item, anchor) {
    var items = [
      { label: "编辑", hint: "改名、颜色、时区", onSelect: function () { openEditCalendar(item); } },
    ];
    if (!item.is_default) {
      items.push({
        label: "设为默认", hint: "Agent 不指定日历时落到这里",
        onSelect: function () {
          api("PATCH", "/api/calendar/calendars/" + encodeURIComponent(item.id), { is_default: true }).then(function (res) {
            setNotice(res.data.ok ? "已设为默认日历" : (res.data.error || "设置失败"), !res.data.ok);
            cal.loaded = false;
            loadCalendar();
          });
        },
      });
    }
    if (item.kind === "mirror") {
      items.push({
        label: "立即刷新", hint: "马上拉一次订阅源",
        onSelect: function () {
          setNotice("正在刷新订阅…", false);
          render();
          api("POST", "/api/calendar/calendars/" + encodeURIComponent(item.id) + "/refresh").then(function (res) {
            var sync = res.data.sync || {};
            setNotice(res.data.ok ? (sync.ok ? "刷新完成：新增 " + (sync.added || 0) + "、更新 " + (sync.updated || 0) + "、删除 " + (sync.deleted || 0) : "刷新失败：" + (sync.error || "未知错误")) : (res.data.error || "刷新失败"), !(res.data.ok && sync.ok));
            cal.loaded = false;
            loadCalendar();
          });
        },
      });
    }
    items.push({
      label: "删除日历", hint: "里面的日程会一起删掉", danger: true,
      onSelect: function () {
        C.askConfirm({
          anchor: anchor,
          title: "删除日历",
          text: "确认删除日历「" + item.name + "」吗？里面的日程会一起被删除",
          confirmLabel: "删除",
          danger: true,
        }).then(function (yes) {
          if (!yes) return;
          api("DELETE", "/api/calendar/calendars/" + encodeURIComponent(item.id)).then(function (res) {
            setNotice(res.data.ok ? "日历已删除" : (res.data.error || "删除失败"), !res.data.ok);
            cal.loaded = false;
            loadCalendar();
          });
        });
      },
    });
    C.openActionMenu({ title: item.name, items: items });
  }

  function openEditCalendar(item) {
    C.openFormDialog({
      title: "编辑日历",
      bodyHtml:
        "<label>名称<input name=\"name\" maxlength=\"80\" value=\"" + C.escapeHtml(item.name) + "\" autocomplete=\"off\" /></label>" +
        "<label>颜色<input name=\"color\" maxlength=\"7\" value=\"" + C.escapeHtml(item.color || "#D97757") + "\" autocomplete=\"off\" /></label>" +
        "<label>时区<input name=\"timezone\" maxlength=\"64\" value=\"" + C.escapeHtml(item.timezone || browserTz) + "\" autocomplete=\"off\" /></label>",
      submitLabel: "保存",
      onSubmit: function (c) {
        var name = val(c, "name");
        if (!name) { c.setError("请填写名称"); return; }
        c.setBusy(true);
        api("PATCH", "/api/calendar/calendars/" + encodeURIComponent(item.id), { name: name, color: val(c, "color"), timezone: val(c, "timezone") }).then(function (res) {
          c.setBusy(false);
          if (!res.data.ok) { c.setError(res.data.error || "保存失败"); return; }
          setNotice("日历已更新", false);
          c.close();
          cal.loaded = false;
          loadCalendar();
        });
      },
    });
  }

  var DOW_CODE = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  function buildRrule(repeat, untilDate, startParts) {
    if (!repeat || repeat === "none") return null;
    var rule = "FREQ=" + repeat.toUpperCase();
    if (repeat === "weekly") rule += ";BYDAY=" + DOW_CODE[new Date(Date.UTC(startParts.y, startParts.mo - 1, startParts.d)).getUTCDay()];
    if (untilDate) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(untilDate);
      if (m) rule += ";UNTIL=" + m[1] + m[2] + m[3];
    }
    return rule;
  }
  function repeatOf(rrule) {
    if (!rrule) return "none";
    var m = /FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/.exec(rrule);
    return m ? m[1].toLowerCase() : "none";
  }
  function untilOf(rrule) {
    if (!rrule) return "";
    var m = /UNTIL=(\d{4})(\d{2})(\d{2})/.exec(rrule);
    return m ? m[1] + "-" + m[2] + "-" + m[3] : "";
  }

  function eventFormHtml(ev, calendars) {
    var tzid = ev ? ev.tzid || browserTz : browserTz;
    var startMs = ev ? Date.parse(ev.start) : wallToUtcMs(
      Number(cal.selected.slice(0, 4)), Number(cal.selected.slice(5, 7)), Number(cal.selected.slice(8, 10)), 10, 0, tzid);
    var endMs = ev ? Date.parse(ev.end) : startMs + 60 * 60 * 1000;
    var repeat = ev ? repeatOf(ev.rrule) : "none";
    return (
      "<label>标题<input name=\"title\" maxlength=\"200\" value=\"" + C.escapeHtml(ev ? ev.title : "") + "\" autocomplete=\"off\" /></label>" +
      "<label>日历<select name=\"calendar_id\">" + calendarOptions(ev ? ev.calendar_id : (calendars[0] && calendars[0].id)) + "</select></label>" +
      "<label>全天日程<span class=\"choice-row\"><input type=\"checkbox\" name=\"all_day\"" + (ev && ev.all_day ? " checked" : "") + " /> 是</span></label>" +
      "<label>开始<input type=\"datetime-local\" name=\"start\" value=\"" + localInputValue(startMs, tzid) + "\" /></label>" +
      "<label>结束<input type=\"datetime-local\" name=\"end\" value=\"" + localInputValue(endMs, tzid) + "\" /></label>" +
      "<label>时区<input name=\"tzid\" maxlength=\"64\" value=\"" + C.escapeHtml(tzid) + "\" autocomplete=\"off\" /></label>" +
      "<label>地点<input name=\"location\" maxlength=\"500\" value=\"" + C.escapeHtml(ev ? ev.location || "" : "") + "\" autocomplete=\"off\" /></label>" +
      "<label>描述<textarea name=\"description\" rows=\"3\">" + C.escapeHtml(ev ? ev.description || "" : "") + "</textarea></label>" +
      "<label>重复<select name=\"repeat\">" +
      "<option value=\"none\"" + (repeat === "none" ? " selected" : "") + ">不重复</option>" +
      "<option value=\"daily\"" + (repeat === "daily" ? " selected" : "") + ">每天</option>" +
      "<option value=\"weekly\"" + (repeat === "weekly" ? " selected" : "") + ">每周</option>" +
      "<option value=\"monthly\"" + (repeat === "monthly" ? " selected" : "") + ">每月</option>" +
      "<option value=\"yearly\"" + (repeat === "yearly" ? " selected" : "") + ">每年</option></select></label>" +
      "<label>重复到（可空）<input type=\"date\" name=\"until\" value=\"" + (ev ? untilOf(ev.rrule) : "") + "\" /></label>"
    );
  }

  function readEventForm(c) {
    var tzid = val(c, "tzid") || browserTz;
    var allDay = c.form.querySelector("[name=\"all_day\"]").checked;
    var startParts = parseLocalInput(val(c, "start"));
    var endParts = parseLocalInput(val(c, "end"));
    if (!startParts || !endParts) return { error: "请填写完整的开始和结束时间" };
    var payload = {
      title: val(c, "title"),
      calendar_id: val(c, "calendar_id"),
      all_day: allDay,
      tzid: tzid,
      location: val(c, "location"),
      description: val(c, "description"),
    };
    if (allDay) {
      payload.start = dateKeyOf(startParts.y, startParts.mo, startParts.d);
      payload.end = dateKeyOf(endParts.y, endParts.mo, endParts.d);
    } else {
      payload.start = new Date(wallToUtcMs(startParts.y, startParts.mo, startParts.d, startParts.h, startParts.mi, tzid)).toISOString();
      payload.end = new Date(wallToUtcMs(endParts.y, endParts.mo, endParts.d, endParts.h, endParts.mi, tzid)).toISOString();
    }
    payload.rrule = buildRrule(val(c, "repeat"), val(c, "until"), startParts);
    if (!payload.title) return { error: "请填写标题" };
    return { payload: payload };
  }

  function openAddEvent() {
    if (!writableCalendars().length) { setNotice("还没有可写的日历，先添加一个日历", true); render(); return; }
    C.openFormDialog({
      title: "添加日程",
      bodyHtml: eventFormHtml(null, writableCalendars()),
      submitLabel: "添加",
      onSubmit: function (c) {
        var read = readEventForm(c);
        if (read.error) { c.setError(read.error); return; }
        c.setBusy(true);
        api("POST", "/api/calendar/events", read.payload).then(function (res) {
          c.setBusy(false);
          if (!res.data.ok) { c.setError(res.data.error || "添加失败"); return; }
          var conflicts = res.data.conflicts || [];
          setNotice(conflicts.length ? "日程已添加；注意与 " + conflicts.length + " 条已有日程时间重叠" : "日程已添加", false);
          c.close();
          cal.loaded = false;
          loadCalendar();
        });
      },
    });
  }

  function openEventDetail(inst) {
    api("GET", "/api/calendar/events/" + encodeURIComponent(inst.master_id)).then(function (res) {
      var ev = res.data.ok ? res.data.event : null;
      var owner = calById(inst.calendar_id);
      var facts = [
        ["时间", inst.all_day ? instanceDateKey(inst) + "（全天）" : instanceDateKey(inst) + " " + timeRangeText(inst)],
        ["日历", owner ? owner.name : ""],
        ["来源", SOURCE_LABEL[inst.source] || inst.source || ""],
      ];
      if (inst.location) facts.push(["地点", inst.location]);
      if (inst.description) facts.push(["描述", inst.description]);
      if (ev && ev.rrule) facts.push(["重复规则", ev.rrule]);
      var auditHtml = "";
      var trail = (res.data && res.data.audit) || [];
      if (trail.length) {
        auditHtml = "<h3>变更记录</h3>" + trail.slice(0, 10).map(function (row) {
          var actionLabel = { create: "创建", update: "修改", delete: "删除" }[row.action] || row.action;
          return "<p class=\"subtle\">" + C.escapeHtml(C.formatMinute(row.created_at) || "") + " · " + C.escapeHtml(row.actor) + " · " + C.escapeHtml(actionLabel) + "</p>";
        }).join("");
      }
      var readOnly = owner && owner.kind === "mirror";
      C.openFormDialog({
        title: inst.title,
        bodyHtml: C.facts(facts) + auditHtml,
        submitLabel: readOnly ? "关闭" : "编辑",
        cancelLabel: "关闭",
        onSubmit: function (c) {
          c.close();
          if (!readOnly) openEditEvent(inst, ev);
        },
      });
    });
  }

  function openEditEvent(inst, ev) {
    C.openFormDialog({
      title: "编辑日程",
      bodyHtml: eventFormHtml(ev || inst, writableCalendars()),
      submitLabel: "保存",
      onSubmit: function (c) {
        var read = readEventForm(c);
        if (read.error) { c.setError(read.error); return; }
        var payload = read.payload;
        var url;
        if (inst.is_exception && inst.scope === "instance") {
          payload.etag = inst.etag;
          url = "/api/calendar/events/" + encodeURIComponent(inst.event_id);
        } else if (inst.scope === "instance") {
          payload.etag = ev ? ev.etag : inst.etag;
          payload.instance_start = inst.start;
          url = "/api/calendar/events/" + encodeURIComponent(inst.master_id);
        } else {
          payload.etag = ev ? ev.etag : inst.etag;
          url = "/api/calendar/events/" + encodeURIComponent(ev ? ev.id : inst.event_id);
        }
        c.setBusy(true);
        api("PATCH", url, payload).then(function (res) {
          c.setBusy(false);
          if (!res.data.ok) { c.setError(res.data.error || "保存失败"); return; }
          setNotice("日程已保存", false);
          c.close();
          cal.loaded = false;
          loadCalendar();
        });
      },
    });
  }

  function openEventMenu(inst, anchor) {
    inst.scope = undefined;
    var owner = calById(inst.calendar_id);
    var readOnly = owner && owner.kind === "mirror";
    var doDelete = function (scope) {
      var url = "/api/calendar/events/" + encodeURIComponent(inst.is_exception && scope === "instance" ? inst.event_id : inst.master_id);
      if (scope === "instance" && !inst.is_exception) url += "?scope=instance&instance_start=" + encodeURIComponent(inst.start);
      api("DELETE", url).then(function (res) {
        setNotice(res.data.ok ? "日程已删除" : (res.data.error || "删除失败"), !res.data.ok);
        cal.loaded = false;
        loadCalendar();
      });
    };
    var items = [
      { label: "查看详情", onSelect: function () { openEventDetail(inst); } },
    ];
    if (!readOnly) {
      items.push({
        label: "编辑",
        onSelect: function () {
          if (inst.recurring) {
            C.openActionMenu({
              title: "编辑重复日程",
              items: [
                { label: "只改这一次", onSelect: function () { pickScope("instance"); } },
                { label: "改整个系列", onSelect: function () { pickScope("series"); } },
              ],
            });
          } else {
            api("GET", "/api/calendar/events/" + encodeURIComponent(inst.event_id)).then(function (res) {
              openEditEvent(inst, res.data.ok ? res.data.event : null);
            });
          }
          function pickScope(scope) {
            inst.scope = scope;
            api("GET", "/api/calendar/events/" + encodeURIComponent(inst.master_id)).then(function (res) {
              openEditEvent(inst, res.data.ok ? res.data.event : null);
            });
          }
        },
      });
      items.push({
        label: "删除", danger: true,
        onSelect: function () {
          if (inst.recurring) {
            C.openActionMenu({
              title: "删除重复日程",
              items: [
                { label: "只删这一次", onSelect: function () { doDelete("instance"); } },
                { label: "删整个系列", danger: true, onSelect: function () { doDelete("series"); } },
              ],
            });
          } else {
            C.askConfirm({
              anchor: anchor,
              title: "删除日程",
              text: "确认删除日程「" + inst.title + "」吗？",
              confirmLabel: "删除",
              danger: true,
            }).then(function (yes) { if (yes) doDelete("series"); });
          }
        },
      });
    }
    C.openActionMenu({ title: inst.title, items: items });
  }

  function openAddFeed() {
    var options = '<option value="">全部日历</option>' + cal.calendars.map(function (item) {
      return '<option value="' + C.escapeHtml(item.id) + '">' + C.escapeHtml(item.name) + "</option>";
    }).join("");
    C.openFormDialog({
      title: "新建订阅链接",
      bodyHtml:
        "<label>设备名称<input name=\"name\" maxlength=\"80\" autocomplete=\"off\" placeholder=\"例如 我的 iPhone\" /></label>" +
        "<label>范围<select name=\"calendar_id\">" + options + "</select></label>" +
        "<p class=\"subtle\">链接里的令牌就是凭证，只在创建时显示一次；哪台设备丢了就吊销哪条。刷新间隔由设备日历决定，不是实时同步</p>",
      submitLabel: "创建",
      onSubmit: function (c) {
        var name = val(c, "name");
        if (!name) { c.setError("请填写设备名称"); return; }
        c.setBusy(true);
        api("POST", "/api/calendar/feeds", { name: name, calendar_id: val(c, "calendar_id") || null }).then(function (res) {
          c.setBusy(false);
          if (!res.data.ok) { c.setError(res.data.error || "创建失败"); return; }
          c.showResult("<p>订阅地址只显示这一次，请立刻复制到设备日历里</p>" + C.copyLine(res.data.feed.url, "复制订阅地址"), "完成");
          cal.loaded = false;
          loadCalendar();
        });
      },
    });
  }

  function revokeFeed(feed, anchor) {
    C.askConfirm({
      anchor: anchor,
      title: "吊销订阅",
      text: "确认吊销「" + feed.name + "」的订阅链接吗？用这条链接的设备将立刻看不到日程",
      confirmLabel: "吊销",
      danger: true,
    }).then(function (yes) {
      if (!yes) return;
      api("DELETE", "/api/calendar/feeds/" + encodeURIComponent(feed.id)).then(function (res) {
        setNotice(res.data.ok ? "订阅已吊销" : (res.data.error || "吊销失败"), !res.data.ok);
        cal.loaded = false;
        loadCalendar();
      });
    });
  }

  // ---------------------------------------------------------------- render
  function render() {
    var taskCards = taskState.tasks.map(function (item) {
      var facts = [["从", C.escapeHtml(item.from || "管理员")], ["到", C.escapeHtml(item.assignee || "未指派")]];
      if (item.note) facts.push(["备注", C.escapeHtml(item.note)]);
      facts.push(["更新时间", C.escapeHtml(C.formatMinute(Date.parse(item.updated_at)))]);
      if (item.completed_at) facts.push(["完成时间", C.escapeHtml(C.formatMinute(Date.parse(item.completed_at)))]);
      return C.record({ id: item.id, title: item.title, status: item.status, facts: facts, extra: "<div class=\"row-actions\"><button type=\"button\" class=\"secondary\" data-action=\"task-menu\" data-id=\"" + C.escapeHtml(item.id) + "\">高级</button></div>" });
    }).join("");
    var tasksBody;
    if (taskState.error) tasksBody = C.emptyState("任务读取失败", taskState.error);
    else if (!taskState.loaded) tasksBody = C.emptyState("正在读取任务", "请稍候");
    else if (!taskState.tasks.length) tasksBody = C.emptyState("还没有任务", "点上方「添加任务」新建第一条");
    else tasksBody = C.list(taskCards);
    var tasksHtml =
      "<div class=\"stack\">" +
      "<button type=\"button\" class=\"add-button\" data-add=\"task\">添加任务</button>" +
      C.section("任务", String(taskState.tasks.length) + " 条", tasksBody) +
      C.section("失败队列", "", C.emptyState("失败队列是空的", "失败的传递会留在这里，方便原样重试")) +
      "</div>";

    C.mount(
      C.layout(
        "",
        "<div class=\"page-tabs\" role=\"tablist\">" +
          "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"tasks\" aria-selected=\"" + (activeTab === "tasks" ? "true" : "false") + "\">任务</button>" +
          "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"calendar\" aria-selected=\"" + (activeTab === "calendar" ? "true" : "false") + "\">日历</button>" +
          "</div>" +
          "<div data-panel=\"tasks\"" + (activeTab === "tasks" ? "" : " hidden") + ">" + tasksHtml + "</div>" +
          "<div data-panel=\"calendar\"" + (activeTab === "calendar" ? "" : " hidden") + ">" + calendarHtml() + "</div>"
      )
    );
  }

  var page = document.getElementById("page");
  page.addEventListener("click", function (event) {
    var target = event.target;
    if (!(target instanceof Element)) return;
    var tab = target.closest(".page-tab");
    if (tab) {
      activeTab = tab.getAttribute("data-tab");
      history.replaceState(null, "", "#" + activeTab);
      render();
      if (activeTab === "calendar" && !cal.loaded) loadCalendar();
      if (activeTab === "tasks" && !taskState.loaded) loadTasks();
      return;
    }
    var actionEl = target.closest("[data-action]");
    if (actionEl) {
      var action = actionEl.getAttribute("data-action");
      if (action === "add-event") { setNotice("", false); openAddEvent(); }
      else if (action === "add-calendar") { setNotice("", false); openAddCalendar(); }
      else if (action === "add-feed") openAddFeed();
      else if (action === "task-menu") {
        var task = taskById(actionEl.getAttribute("data-id"));
        if (task) openTaskMenu(task, actionEl.closest("article") || actionEl);
      }
      else if (action === "cal-prev") { cal.month--; if (cal.month < 0) { cal.month = 11; cal.year--; } cal.loaded = false; loadCalendar(); }
      else if (action === "cal-next") { cal.month++; if (cal.month > 11) { cal.month = 0; cal.year++; } cal.loaded = false; loadCalendar(); }
      else if (action === "cal-menu") {
        var item = calById(actionEl.getAttribute("data-id"));
        if (item) openCalendarMenu(item, actionEl.closest("article") || actionEl);
      } else if (action === "event-menu") {
        var inst = cal.byKey[actionEl.getAttribute("data-key")];
        if (inst) openEventMenu(inst, actionEl.closest("article") || actionEl);
      } else if (action === "feed-revoke") {
        var feed = null;
        cal.feeds.forEach(function (f) { if (f.id === actionEl.getAttribute("data-id")) feed = f; });
        if (feed) revokeFeed(feed, actionEl.closest("article") || actionEl);
      }
      return;
    }
    var chip = target.closest("[data-event-key]");
    if (chip) {
      var chipInst = cal.byKey[chip.getAttribute("data-event-key")];
      if (chipInst) openEventMenu(chipInst, chip);
      return;
    }
    var day = target.closest("[data-day]");
    if (day) {
      cal.selected = day.getAttribute("data-day");
      render();
      return;
    }
    var add = target.closest("[data-add]");
    if (add && add.getAttribute("data-add") === "task") openTaskDialog(null);
  });
  render();
  if (activeTab === "calendar") loadCalendar();
  else loadTasks();
})();
