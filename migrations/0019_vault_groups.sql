-- 保险库分组：账号密码与模型网关共用一个自有分组池（不复用 scope 受限的
-- groups 表）。条目与网关各加可空 group_id；删组时由服务端把 group_id
-- 置空回未分组，不连带删条目。

CREATE TABLE vault_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

ALTER TABLE vault_entries ADD COLUMN group_id TEXT;
ALTER TABLE gateways ADD COLUMN group_id TEXT;
