-- 记忆分级分类（Roye 2026-11-08 定）：记忆是一个记忆点一条，与 Soul 的完整
-- 人格文本相区别。本迁移给 memories 加四列并新建手动分组表：
-- - group_id：用户手动分组（memory_groups），AI 不自动分组；删组时由服务层
--   把组内记忆的 group_id 置空回未分组，不连带删记忆。
-- - pinned_at：置顶时间（毫秒），非空即置顶；面板与 MCP 读取都排最前。
-- - weight：权重 0–100（服务层校验），读取排序为置顶优先 → 权重降序 →
--   updated_at 降序。
-- - ai_state：AI 处理状态：none 未经 AI / split 面板自然语言经 AI 拆分落库 /
--   tagged 经 AI 补打标签 / failed AI 拆分失败退化为整段一条。
-- 标签沿用 0007 的 tags_json 列，不另加列。时间戳一律 Unix 毫秒。

CREATE TABLE memory_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX memory_groups_name_idx ON memory_groups (name);

ALTER TABLE memories ADD COLUMN group_id TEXT;
ALTER TABLE memories ADD COLUMN pinned_at INTEGER;
ALTER TABLE memories ADD COLUMN weight INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN ai_state TEXT NOT NULL DEFAULT 'none';

CREATE INDEX memories_group_idx ON memories (group_id);
CREATE INDEX memories_rank_idx ON memories (pinned_at, weight, updated_at);
