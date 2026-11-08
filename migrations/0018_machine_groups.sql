-- Machines board groups (phase 3): one group pool shared by all three
-- machines tabs, reusing the board-wide groups table with a new scope.
-- SQLite cannot alter a CHECK constraint, so the groups table is rebuilt
-- with 'machines' added; members reference groups by plain TEXT id (no
-- foreign keys), so the rebuild copies every row losslessly.
CREATE TABLE groups_new (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('agent', 'mcp', 'machines')),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO groups_new (id, scope, name, created_at) SELECT id, scope, name, created_at FROM groups;

DROP TABLE groups;
ALTER TABLE groups_new RENAME TO groups;

CREATE UNIQUE INDEX idx_groups_scope_name ON groups (scope, name);
CREATE INDEX idx_groups_scope_created ON groups (scope, created_at);

ALTER TABLE machines ADD COLUMN group_id TEXT;
CREATE INDEX idx_machines_group ON machines (group_id);
