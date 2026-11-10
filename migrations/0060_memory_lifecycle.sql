-- 记忆生命周期（memory-soul 优化方案 P2）：只加列，不改既有列。
-- - kind：fact / preference / procedure / episode，服务层校验，可空。
-- - agent_name：归属 Agent（MCP 写入默认取调用 Agent），空/NULL 表示全局。
-- - expires_at：到期时间（毫秒），到期后默认列表/搜索排除，get 仍可达。
-- - last_accessed_at / access_count：读取统计，供衰减与淘汰使用；
--   access_count 由 memory_get 节流更新（距上次超过 1 小时才写）。
-- - content_hash：标题+正文规范化后的 SHA-256（hex），写入时精确去重。
-- - supersedes_id：本条取代的旧记忆 id；旧记忆 invalidated 置 1 保留行。
-- - invalidated：被取代/失效标记，默认列表/搜索排除，历史可追溯。

ALTER TABLE memories ADD COLUMN kind TEXT;
ALTER TABLE memories ADD COLUMN agent_name TEXT;
ALTER TABLE memories ADD COLUMN expires_at INTEGER;
ALTER TABLE memories ADD COLUMN last_accessed_at INTEGER;
ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN content_hash TEXT;
ALTER TABLE memories ADD COLUMN supersedes_id TEXT;
ALTER TABLE memories ADD COLUMN invalidated INTEGER NOT NULL DEFAULT 0;

CREATE INDEX memories_content_hash_idx ON memories (content_hash);
CREATE INDEX memories_agent_idx ON memories (agent_name);
