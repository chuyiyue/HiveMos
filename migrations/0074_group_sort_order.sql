-- 分组排序：groups（agent / mcp / machines 三个 scope 共用）与保险库自有池
-- vault_groups 各加 sort_order，分组列表改按 sort_order 展示。回填按现有
-- 展示顺序编号（groups 为 created_at、name；vault_groups 为 created_at、
-- id），步长 10；新建分组追加到末尾（服务端取当前最大值 +10）。

ALTER TABLE groups ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

UPDATE groups
SET sort_order = (
  SELECT (COUNT(*) + 1) * 10
  FROM groups AS g2
  WHERE g2.scope = groups.scope
    AND (
      g2.created_at < groups.created_at
      OR (g2.created_at = groups.created_at AND g2.name < groups.name)
      OR (g2.created_at = groups.created_at AND g2.name = groups.name AND g2.id < groups.id)
    )
);

CREATE INDEX idx_groups_scope_sort ON groups (scope, sort_order);

ALTER TABLE vault_groups ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

UPDATE vault_groups
SET sort_order = (
  SELECT (COUNT(*) + 1) * 10
  FROM vault_groups AS g2
  WHERE g2.created_at < vault_groups.created_at
     OR (g2.created_at = vault_groups.created_at AND g2.id < vault_groups.id)
);

CREATE INDEX idx_vault_groups_sort ON vault_groups (sort_order);
