-- 扩展条目：应用 / Skills / API 三个页签的真后端（迁移 0012）。
-- skills / apis 的 group_id 指向 scope=mcp 的分组池，与 MCP 页签共用同一
-- 套分组；apps 的分组不落库（groups.scope 只有 agent 与 mcp 两值），应用
-- 页签分组仍是页内状态，group_id 列先预留、恒为 NULL。
-- 时间戳是 Unix 毫秒；种子即原页内 mock 条目，展示时间按北京时间换算。

CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  last_used_at INTEGER,
  group_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'enabled',
  version TEXT NOT NULL DEFAULT '',
  used_by TEXT NOT NULL DEFAULT '',
  group_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE apis (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL DEFAULT '',
  auth_note TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  group_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_apps_created ON apps (created_at);
CREATE INDEX idx_skills_created ON skills (created_at);
CREATE INDEX idx_skills_group ON skills (group_id);
CREATE INDEX idx_apis_created ON apis (created_at);
CREATE INDEX idx_apis_group ON apis (group_id);

INSERT INTO apps (id, name, type, note, last_used_at, group_id, created_at, updated_at) VALUES
  ('app_claude', 'Claude 桌面端', '桌面客户端', '通过 MCP 接入注册表', 1794080400000, NULL, 1794067200000, 1794067200000),
  ('app_cursor', 'Cursor', '桌面客户端', '', 1794060900000, NULL, 1794067200000, 1794067200000);

INSERT INTO skills (id, name, description, source, content, status, version, used_by, group_id, created_at, updated_at) VALUES
  ('skill_search', 'web-search', '', '官方注册表', '', 'enabled', '1.4.0', '研究、编排', NULL, 1794067200000, 1794067200000),
  ('skill_deploy', 'wrangler-deploy', '', '工作区', '', 'enabled', '0.9.2', '编排', NULL, 1794067200000, 1794067200000),
  ('skill_vault', 'vault-read', '', '官方注册表', '', 'disabled', '1.0.1', '值守', NULL, 1794067200000, 1794067200000);

INSERT INTO apis (id, name, base_url, auth_note, note, status, group_id, created_at, updated_at) VALUES
  ('api_mails', 'mails.dev', 'https://api.mails.dev', 'Bearer <redacted> Key', '邮箱服务 API，没有 MCP', 'active', NULL, 1794067200000, 1794067200000),
  ('api_mistgate', 'Mistgate 管理 API', 'http://127.0.0.1:18446', 'Admin Token', '面板管理接口，没有 MCP', 'active', NULL, 1794067200000, 1794067200000);
