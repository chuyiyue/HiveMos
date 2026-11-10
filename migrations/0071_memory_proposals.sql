-- 后台整理提案：cron 只产出提案，绝不自动改动记忆。
-- type：merge（合并，含标签整理）/ expire（过期）/ supersede（取代）/
--       summarize（补摘要）。
-- payload_json 保存执行动作所需的全部信息（含已生成的摘要），管理员批准后
-- 直接按 payload 落库，不再调用 AI。
-- status：pending / approved / rejected；decided_at / decided_by 记录裁决。

CREATE TABLE memory_proposals (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT
);

CREATE INDEX memory_proposals_status_idx ON memory_proposals (status, created_at);
CREATE INDEX memory_proposals_type_idx ON memory_proposals (type, status);
