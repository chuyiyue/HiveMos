-- 任务模块：tasks / task_audit 两张表。
-- 任务是在面板与 Agent 之间传递的工作项：面板经 REST、Agent 经 MCP 读写，
-- 两边写同一张表。状态枚举沿用面板既有取值 queued（排队）/ active（进行中）/
-- done（已完成），时间戳一律 Unix 毫秒。ai_status / ai_summary 只预留列，
-- 本期不写任何 AI 逻辑。

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'active', 'done')),
  assignee TEXT,
  from_label TEXT,
  source TEXT NOT NULL DEFAULT 'panel' CHECK (source IN ('panel', 'agent')),
  ai_status TEXT,
  ai_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX idx_tasks_status ON tasks (status, updated_at);
CREATE INDEX idx_tasks_assignee ON tasks (assignee, updated_at);

CREATE TABLE task_audit (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'complete', 'list')),
  diff_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_task_audit_task ON task_audit (task_id, created_at);
