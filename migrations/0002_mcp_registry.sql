-- MCP 注册表。时间戳是 Unix 毫秒，与 sessions 一致。
-- 种子在本文件末尾，随 wrangler d1 migrations apply 写入，没有单独的 seed.sql。
-- 配置里只有 {{vault://…}} 占位，没有真实令牌。

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_agents_status ON agents (status);

CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  endpoint_url TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL CHECK (transport IN ('http', 'sse', 'stdio')),
  launch_config_json TEXT,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('none', 'bearer', 'oauth')),
  config_json TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  category TEXT NOT NULL DEFAULT '',
  summary TEXT,
  summary_source TEXT CHECK (summary_source IS NULL OR summary_source IN ('human', 'ai')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  version INTEGER NOT NULL DEFAULT 1,
  ttl_seconds INTEGER NOT NULL DEFAULT 86400,
  snapshot_json TEXT,
  snapshot_at INTEGER,
  snapshot_status TEXT NOT NULL DEFAULT 'none' CHECK (snapshot_status IN ('ok', 'failed', 'manual', 'none')),
  content_hash TEXT NOT NULL DEFAULT '',
  ai_status TEXT NOT NULL DEFAULT 'pending' CHECK (ai_status IN ('pending', 'done', 'failed', 'skipped')),
  embedding TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_mcp_servers_status_transport ON mcp_servers (status, transport);
CREATE INDEX idx_mcp_servers_updated ON mcp_servers (updated_at DESC);

CREATE TABLE mcp_fetch_audit (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_mcp_fetch_audit_created ON mcp_fetch_audit (created_at DESC);
CREATE INDEX idx_mcp_fetch_audit_server ON mcp_fetch_audit (server_id, created_at DESC);

-- content_hash 与运行时 contentIdentity 一致：名称、标题、说明、规范化配置、排序后的工具名。
-- 种子的 ai_status 为 skipped。内容哈希变化之后才会打标。
INSERT INTO mcp_servers (
  id, name, title, description, endpoint_url, transport, launch_config_json, auth_type, config_json,
  tags_json, category, summary, summary_source, status, version, ttl_seconds, snapshot_json, snapshot_at,
  snapshot_status, content_hash, ai_status, embedding, created_at, updated_at
) VALUES
(
  'mcp_cloud_mail',
  'cloud-mail',
  'Cloud Mail 邮件',
  '种子条目。Cloud Mail 邮件能力的发现记录，密钥只保留 vault 占位符',
  'https://mail.outtw.com/mcp',
  'http',
  NULL,
  'bearer',
  '{"headers":{"Authorization":"Bearer {{vault://cloud-mail/token}}"}}',
  '[]',
  '邮件',
  NULL,
  NULL,
  'active',
  1,
  86400,
  NULL,
  NULL,
  'none',
  '9d4b027e304a2ee8644178efe39d4db5901723af848aab4eac41bbf9c817b8ce',
  'skipped',
  NULL,
  1762473600000,
  1762473600000
),
(
  'mcp_smsinbox',
  'smsinbox',
  'SMSinBox 短信',
  '种子条目。端点 https://example.com/mcp 是占位地址，待改成真实地址',
  'https://example.com/mcp',
  'http',
  NULL,
  'bearer',
  '{"headers":{"Authorization":"Bearer {{vault://smsinbox/token}}"}}',
  '[]',
  '短信',
  NULL,
  NULL,
  'active',
  1,
  86400,
  NULL,
  NULL,
  'none',
  '01b30093c9ac1ddc93f98260dd168e4d0956f00e45ab2adee97c047c14d8879a',
  'skipped',
  NULL,
  1762473600000,
  1762473600000
);
