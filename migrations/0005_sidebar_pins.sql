-- 侧边栏 pin：pinned_at 是固定时刻（Unix 毫秒），为空表示未固定。
-- pin 的排序与 last_seen_at 填充都靠这两列，顺手补上索引。

ALTER TABLE agents ADD COLUMN pinned_at INTEGER;

CREATE INDEX idx_agents_pinned_at ON agents (pinned_at);
CREATE INDEX idx_agents_last_seen_at ON agents (last_seen_at);
