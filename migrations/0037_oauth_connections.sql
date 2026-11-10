-- OAuth 阶段 2/3：授权连接与授权码。
--
-- 一条 connection = 某客户端以某 Agent 身份获得的一次独立授权：
-- grants_json 是连接权限（与 agents.permissions 同格式的对象），实际生效
-- 权限恒为 基础 ∩ 连接，在每次 MCP 调用时动态计算，所以收紧基础权限
-- 不需要回写这里。status: active / revoked，撤销立即生效。
--
-- 授权码只存 SHA-256（code_hash 主键），绑定 client、connection、
-- redirect_uri 与 PKCE challenge，5 分钟过期、used_at 标记单次使用。

CREATE TABLE oauth_connections (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  grants_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX idx_oauth_connections_agent ON oauth_connections(agent_id);
CREATE INDEX idx_oauth_connections_client ON oauth_connections(client_id);

CREATE TABLE oauth_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
