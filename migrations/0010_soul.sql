-- Soul 模块：每个 Agent 一份人格/行为定义文档，跨设备同步。
-- souls 存当前版，soul_versions 留全量历史（回滚也产生新版本，不覆盖旧行），
-- soul_audit 记读写审计（面板与 MCP 都记，口径对齐 calendar_audit）。
-- ai_status / ai_summary 是 AI 预留列，本期只建列不实现。

CREATE TABLE souls (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  ai_status TEXT,
  ai_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE soul_versions (
  id TEXT PRIMARY KEY,
  soul_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'panel' CHECK (source IN ('panel', 'mcp', 'rollback')),
  actor TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (soul_id, version)
);

CREATE INDEX idx_soul_versions_soul ON soul_versions (soul_id, version DESC);

CREATE TABLE soul_audit (
  id TEXT PRIMARY KEY,
  soul_id TEXT,
  agent_name TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'rollback', 'delete', 'read')),
  version INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_soul_audit_soul ON soul_audit (soul_id, created_at);
