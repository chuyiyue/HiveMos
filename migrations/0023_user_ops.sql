-- 用户操作日志（总览页「系统日志」页签的数据源）。
-- 各模块的审计表记的是「谁取用了什么」，行为者既有 Agent（经 MCP 调用）
-- 也有管理员（面板操作），两个视角混在一起。这张表只收管理员在面板里
-- 的写操作：添加、修改、删除、打标、启停、同步、登录等，一行一个动作，
-- 与调用记录彻底拆分。写入由 src/oplog.ts 的 logOp 尽力而为完成，写失败
-- 不阻塞业务，所以这里不需要外键与额外约束。

CREATE TABLE user_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  module TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  target_name TEXT,
  text TEXT NOT NULL
);

CREATE INDEX idx_user_ops_at ON user_ops (at DESC);
CREATE INDEX idx_user_ops_module_at ON user_ops (module, at DESC);
