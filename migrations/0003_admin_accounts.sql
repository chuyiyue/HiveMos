-- 管理员账号、展示名、TOTP 列和登录限流。
-- 只追加。旧会话没有 user_id，对不上用户，升级后需要重新登录。
-- totp_secret 本步不写入。恢复码存哈希，票据只活在密码通过之后。

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  disabled_at INTEGER,
  created_at INTEGER NOT NULL,
  totp_secret TEXT,
  totp_pending_secret TEXT,
  totp_pending_created_at INTEGER,
  totp_enabled_at INTEGER,
  totp_last_counter INTEGER
);

CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE totp_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_totp_recovery_user_hash ON totp_recovery_codes(user_id, code_hash);
CREATE INDEX idx_totp_recovery_user ON totp_recovery_codes(user_id);

CREATE TABLE totp_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_totp_tickets_expires ON totp_tickets(expires_at);
CREATE INDEX idx_totp_tickets_user ON totp_tickets(user_id);

CREATE TABLE rate_limits (
  token_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (token_hash, window_start)
);

ALTER TABLE sessions ADD COLUMN user_id TEXT;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
