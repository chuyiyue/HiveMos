/* mock: Agent 占位。接入后改为 GET /api/agents。侧栏名单见 shell.js，需与这里的 id、名称、状态保持一致 */
(function () {
  var C = window.HiveCommon;
  var AGENTS = [
    {
      id: "agt_orch",
      name: "编排",
      status: "online",
      role: "拆解目标并分发任务",
      model: "claude-opus",
      machine: "上海-01",
      seen: "2026-11-07 09:24",
    },
    {
      id: "agt_research",
      name: "研究",
      status: "syncing",
      role: "检索资料并写回记忆",
      model: "claude-sonnet",
      machine: "新加坡-02",
      seen: "2026-11-07 09:18",
    },
    {
      id: "agt_ops",
      name: "值守",
      status: "idle",
      role: "看守告警与定时任务",
      model: "claude-haiku",
      machine: "上海-01",
      seen: "2026-11-07 08:40",
    },
    {
      id: "agt_archive",
      name: "档案",
      status: "offline",
      role: "整理 Soul 与长期记忆",
      model: "claude-sonnet",
      machine: "未绑定",
      seen: "2026-11-06 22:15",
    },
  ];
  var cards = AGENTS.map(function (agent) {
    return C.record({
      id: agent.id,
      title: agent.name,
      status: agent.status,
      lede: agent.role,
      facts: [
        ["模型", C.escapeHtml(agent.model)],
        ["云电脑", C.escapeHtml(agent.machine)],
        ["最近活动", C.escapeHtml(agent.seen)],
      ],
    });
  }).join("");
  C.mount(
    C.layout(
      "已登记的 Agent、状态，以及各自绑定的云电脑",
      '<div class="stack">' +
        C.section("已登记", String(AGENTS.length) + " 个", AGENTS.length ? C.list(cards) : C.emptyState("还没有 Agent", "登记后会出现在这张列表里")) +
        C.section("待接入", "", C.emptyState("还没有待接入的 Agent", "新接入的实例会先停在这里")) +
        "</div>",
    ),
  );
})();
