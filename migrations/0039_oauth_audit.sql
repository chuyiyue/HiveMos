-- OAuth 阶段 4：协议侧审计。客户端注册、授权、绑定、兑换、刷新轮换与
-- 重放、撤销、面板查看令牌都在这里留痕（与 user_ops 的系统日志并行：
-- 那边记「管理员做了什么」，这边记协议事件全量，含无会话的绑定路径）。
--
-- detail 只放权限摘要、令牌末四位之类的安全信息，绝不记录令牌/授权码
-- 明文或链接密钥。

CREATE TABLE oauth_audit (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL,
  client_id TEXT,
  connection_id TEXT,
  agent_id TEXT,
  agent_name TEXT,
  detail TEXT
);

CREATE INDEX idx_oauth_audit_connection ON oauth_audit(connection_id);
CREATE INDEX idx_oauth_audit_at ON oauth_audit(at);
