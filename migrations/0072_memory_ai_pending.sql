-- AI 移出请求路径：ai_state 列在 0017_memory_tiers 已经存在（none / split /
-- tagged / failed），本迁移不重复加列，只补一个「进入待补全队列的时间」和
-- 索引。ai_state = 'pending' 是新状态：写入同步落库、立即返回，拆分/打标/
-- 摘要由 cron 异步补全；所有 non-pending 的旧状态都视为 ready（存量天然
-- 兼容，无需回填）。

ALTER TABLE memories ADD COLUMN ai_pending_at INTEGER;
CREATE INDEX memories_ai_state_idx ON memories (ai_state);
