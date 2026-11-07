-- 管理员会话。id 是 Cookie 令牌的 SHA-256 十六进制，不是明文。
-- created_at 与 expires_at 是 Unix 纪元毫秒。注册表迁移从 0002 开始。
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_sessions_expires ON sessions (expires_at);
