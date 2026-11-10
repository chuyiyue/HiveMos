-- OAuth 阶段 2：外部 AI 客户端注册表（动态客户端注册 RFC 7591）。
--
-- 只支持公共客户端（token_endpoint_auth_method = 'none'，强制 PKCE），
-- 因此 client_secret_hash 目前恒为 NULL，列先留着，将来若开放机密客户端
-- 只需补签发逻辑，不用再动表。redirect_uris_json 是精确匹配清单，
-- 授权时逐字比对，不做前缀/通配。

CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  client_secret_hash TEXT,
  client_name TEXT NOT NULL DEFAULT '',
  client_uri TEXT,
  logo_uri TEXT,
  redirect_uris_json TEXT NOT NULL DEFAULT '[]',
  grant_types_json TEXT NOT NULL DEFAULT '["authorization_code","refresh_token"]',
  response_types_json TEXT NOT NULL DEFAULT '["code"]',
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
