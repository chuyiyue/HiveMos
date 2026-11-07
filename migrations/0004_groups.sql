-- 分组：Agent 与 MCP 条目各自一套分组（scope 区分），成员靠 group_id 归属。
-- 删组只解绑成员（group_id 置空），不删成员。时间戳是 Unix 毫秒。

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('agent', 'mcp')),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_groups_scope_name ON groups (scope, name);
CREATE INDEX idx_groups_scope_created ON groups (scope, created_at);

ALTER TABLE agents ADD COLUMN group_id TEXT;
ALTER TABLE mcp_servers ADD COLUMN group_id TEXT;

CREATE INDEX idx_agents_group ON agents (group_id);
CREATE INDEX idx_mcp_servers_group ON mcp_servers (group_id);

-- 系统功能权限：per-Agent 的 permissions JSON 数组（域见 registry.ts 的
-- PERMISSION_DOMAINS）。存量与新建 Agent 默认只开 registry，与现行能力一致。
ALTER TABLE agents ADD COLUMN permissions TEXT NOT NULL DEFAULT '["registry"]';
