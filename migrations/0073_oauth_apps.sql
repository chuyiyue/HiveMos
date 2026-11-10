-- OAuth 模型大改：连接（connection）整体删除，OAuth 授权改为创建独立的
-- 「应用」（oauth_apps）。应用自带令牌与权限：权限就是授权页上管理员勾选
-- 的完整矩阵，不再有 Agent 基础 ∩ 连接的交集。
--
-- 动手前已核查生产行数：oauth_clients / oauth_connections /
-- oauth_authorization_codes / oauth_tokens / oauth_audit 全部 0 行，因此
-- 授权码与令牌表直接 DROP 重建、连接表直接删除，无数据可丢。
--
-- 授权码不再指向连接，改为携带「批准的应用名 + 批准的权限集」快照，
-- 兑换时才真正建 app 并签发首对令牌（没兑换就不会留下应用）。
-- oauth_audit 保留，加 app_id / app_name 两列作为事件主体；旧的
-- connection_id / agent_id / agent_name 列留着不用（历史恒为空）。

CREATE TABLE oauth_apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  client_id TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX idx_oauth_apps_client ON oauth_apps(client_id);

DROP TABLE IF EXISTS oauth_connections;

DROP TABLE IF EXISTS oauth_authorization_codes;

CREATE TABLE oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  app_name TEXT NOT NULL,
  permissions_json TEXT NOT NULL DEFAULT '{}',
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

DROP TABLE IF EXISTS oauth_tokens;

CREATE TABLE oauth_tokens (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
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

CREATE INDEX idx_oauth_tokens_app ON oauth_tokens(app_id);
CREATE INDEX idx_oauth_tokens_family ON oauth_tokens(family_id);

ALTER TABLE oauth_audit ADD COLUMN app_id TEXT;
ALTER TABLE oauth_audit ADD COLUMN app_name TEXT;

CREATE INDEX idx_oauth_audit_app ON oauth_audit(app_id);
