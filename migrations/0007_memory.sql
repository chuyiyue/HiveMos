-- 记忆模块：memories 主表 + memory_audit 审计表。
-- 时间戳一律 Unix 毫秒；删除走 deleted_at 软删除墓碑；同一作用域下标题唯一
-- （仅对未删除行生效），支撑 memory_upsert 按 title+scope 幂等写入。
-- ai_summary 只建列预留，本期不写不读。

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '全局',
  content TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'panel',
  tags_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  ai_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE UNIQUE INDEX memories_title_scope_active
  ON memories (title, scope) WHERE deleted_at IS NULL;
CREATE INDEX memories_scope_idx ON memories (scope);
CREATE INDEX memories_updated_idx ON memories (updated_at);

CREATE TABLE memory_audit (
  id TEXT PRIMARY KEY,
  memory_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  diff_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX memory_audit_memory_idx ON memory_audit (memory_id, created_at);
