-- 记忆向量元数据：一行对应 Vectorize 里的一条记忆向量。
-- memory_id 即向量 id（与 memories.id 一致）；content_hash 用来判定向量是否
-- 已经落后于最新内容；model 记录实际使用的嵌入模型，换模型后旧向量会被重算。
-- vector_json 只是本地缓存（纯成本优化）：cron 做相似度去重时直接算余弦，
-- 不必为每条记忆再调一次 Workers AI。它不参与对外接口。
-- 写路径只删本表行（标脏），真正嵌入与清理都由 cron 回填。

CREATE TABLE memory_vectors (
  memory_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  embedded_at INTEGER NOT NULL,
  vector_json TEXT
);

CREATE INDEX memory_vectors_embedded_idx ON memory_vectors (embedded_at);
