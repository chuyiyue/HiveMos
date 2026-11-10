-- OAuth 阶段 2：访问/刷新令牌。
--
-- 业主裁定（推翻总纲 §7.3 的只存哈希）：令牌可恢复存储——token_enc 是
-- VAULT_KEY 信封的 AES-GCM 密文（与 Agent 令牌同一套 seal），面板经审计
-- 后可查看/复制；token_hash 是 SHA-256 索引列，鉴权只走哈希查找，明文
-- 不落日志。VAULT_KEY 未配置时 token_enc 为 NULL，令牌照常签发与校验，
-- 只是面板复制会报「不可用」（与旧 Agent 令牌的口径一致）。
--
-- family_id 标记一次授权码兑换长出的令牌链：刷新轮换在同族内进行，
-- 检出旧 refresh 复用时整族撤销。rotated_at 记录该 refresh 已被轮换
-- 用过一次，再次出现即按重放处理。

CREATE TABLE oauth_tokens (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  family_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_enc TEXT,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  rotated_at INTEGER,
  replaced_by_id TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX idx_oauth_tokens_connection ON oauth_tokens(connection_id);
CREATE INDEX idx_oauth_tokens_family ON oauth_tokens(family_id);
