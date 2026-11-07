/* mock: 任务与日历合并板块。任务为占位数据（接入后 GET /api/tasks），日历为静态示意（方案见 docs，接入后 GET /api/calendar/events）。添加先在页内生效 */
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

  var TASKS = [
    { id: "task_heartbeat", title: "核对云主机心跳", from: "编排", to: "值守", status: "active", updated: "2026-11-07 09:20" },
    { id: "task_memory", title: "把部署约定写入记忆", from: "研究", to: "档案", status: "queued", updated: "2026-11-07 09:12" },
    { id: "task_rotate", title: "轮换网关密钥展示", from: "编排", to: "编排", status: "done", updated: "2026-11-06 17:45" },
  ];
  var EVENTS = [];

  function render() {
    var taskCards = TASKS.map(function (item) {
      return C.record({ id: item.id, title: item.title, status: item.status, facts: [["从", C.escapeHtml(item.from)], ["到", C.escapeHtml(item.to)], ["更新时间", C.escapeHtml(item.updated)]] });
    }).join("");
    var tasksHtml =
      "<div class=\"stack\">" +
      "<button type=\"button\" class=\"add-button\" data-add=\"task\">添加任务</button>" +
      C.section("任务", String(TASKS.length) + " 条", C.list(taskCards)) +
      C.section("失败队列", "", C.emptyState("失败队列是空的", "失败的传递会留在这里，方便原样重试")) +
      "</div>";

    var nowDate = new Date();
    var year = nowDate.getFullYear();
    var month = nowDate.getMonth();
    var today = nowDate.getDate();
    var MOCK_EVENTS = {};
    MOCK_EVENTS[Math.min(today + 2, 28)] = "示例日程（mock）";
    MOCK_EVENTS[Math.max(today - 3, 1)] = "已结束的示例（mock）";
    var firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var head = ["一", "二", "三", "四", "五", "六", "日"].map(function (d) { return "<div class=\"cal-dow\">" + d + "</div>"; }).join("");
    var cells = "";
    for (var i = 0; i < firstDow; i++) cells += "<div class=\"cal-cell cal-pad\"></div>";
    for (var d = 1; d <= daysInMonth; d++) {
      var cls = "cal-cell" + (d === today ? " cal-today" : "");
      var ev = MOCK_EVENTS[d] ? "<span class=\"cal-event\">" + C.escapeHtml(MOCK_EVENTS[d]) + "</span>" : "";
      cells += "<div class=\"" + cls + "\"><span class=\"cal-day\">" + d + "</span>" + ev + "</div>";
    }
    var grid = "<div class=\"cal-grid\">" + head + cells + "</div>";
    var eventBody = EVENTS.length
      ? C.list(EVENTS.map(function (item) {
          return C.record({ id: item.id, title: item.title, facts: [["日期", C.escapeHtml(item.date)]] });
        }).join(""))
      : C.emptyState("还没有日程", "功能上线后，agent 写入与订阅同步进来的日程会出现在这里");
    var calendarHtml =
      "<div class=\"stack\">" +
      "<button type=\"button\" class=\"add-button\" data-add=\"event\">添加日程</button>" +
      C.section("功能开发中", "", C.emptyState("日历功能还在设计阶段", "当前是静态占位，月视图与示例日程均为 mock 数据，不会真实保存或同步")) +
      C.section("月视图", year + " 年 " + (month + 1) + " 月 · 静态示意", grid) +
      C.section("即将到来的日程", EVENTS.length ? String(EVENTS.length) + " 条" : "", eventBody) +
      "</div>";

    C.mount(
      C.layout(
        "",
        "<div class=\"page-tabs\" role=\"tablist\">" +
          "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"tasks\" aria-selected=\"" + (activeTab === "tasks" ? "true" : "false") + "\">任务</button>" +
          "<button class=\"page-tab\" type=\"button\" role=\"tab\" data-tab=\"calendar\" aria-selected=\"" + (activeTab === "calendar" ? "true" : "false") + "\">日历</button>" +
          "</div>" +
          "<div data-panel=\"tasks\"" + (activeTab === "tasks" ? "" : " hidden") + ">" + tasksHtml + "</div>" +
          "<div data-panel=\"calendar\"" + (activeTab === "calendar" ? "" : " hidden") + ">" + calendarHtml + "</div>"
      )
    );
  }

  function openAddTask() {
    C.openFormDialog({
      title: "添加任务",
      bodyHtml:
        "<label>标题<input name=\"title\" maxlength=\"80\" autocomplete=\"off\" /></label>" +
        "<label>从<input name=\"from\" maxlength=\"40\" autocomplete=\"off\" placeholder=\"发起的 Agent\" /></label>" +
        "<label>到<input name=\"to\" maxlength=\"40\" autocomplete=\"off\" placeholder=\"接收的 Agent\" /></label>",
      submitLabel: "添加",
      onSubmit: function (ctrl) {
        var title = val(ctrl, "title");
        if (!title) { ctrl.setError("请填写标题"); return; }
        TASKS.unshift({ id: "task_" + Date.now(), title: title, from: val(ctrl, "from") || "管理员", to: val(ctrl, "to") || "未指派", status: "queued", updated: now() });
        ctrl.close();
        render();
      },
    });
  }
  function openAddEvent() {
    C.openFormDialog({
      title: "添加日程",
      bodyHtml:
        "<label>标题<input name=\"title\" maxlength=\"80\" autocomplete=\"off\" /></label>" +
        "<label>日期<input name=\"date\" maxlength=\"20\" autocomplete=\"off\" placeholder=\"例如 2026-11-12 10:00\" /></label>",
      submitLabel: "添加",
      onSubmit: function (ctrl) {
        var title = val(ctrl, "title");
        if (!title) { ctrl.setError("请填写标题"); return; }
        EVENTS.push({ id: "ev_" + Date.now(), title: title, date: val(ctrl, "date") || "未定日期" });
        ctrl.close();
        render();
      },
    });
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
      return;
    }
    var add = target.closest("[data-add]");
    if (add) {
      if (add.getAttribute("data-add") === "task") openAddTask();
      else openAddEvent();
    }
  });
  render();
})();
