-- 保险库外部连接「纯指引」（2026-11-11 Roye 定版）：只做连接目录＋指引。
-- 硬纪律：这组表只存引用与说明，字段里不许出现任何能装凭据值的列
-- （没有 token / password / secret / value 类列名）；HiveMos 对
-- 1Password / Bitwarden 零出站，引用只在写入时做本地格式校验。
-- 时间戳是 Unix 毫秒，与其余表一致；enabled 用 1/0。

CREATE TABLE vault_guide_provider (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('1password', 'bitwarden', 'other')),
  connect_guide TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE vault_guide_entry (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL,
  ref TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  inject_hint TEXT NOT NULL DEFAULT '',
  allowed_hosts TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_vault_guide_entry_provider ON vault_guide_entry (provider_id);

-- 授权只管「哪个 agent 能看哪条指引」：无次数、无用量概念。
CREATE TABLE vault_guide_grant (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  expires_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_vault_guide_grant_entry ON vault_guide_grant (entry_id);
CREATE INDEX idx_vault_guide_grant_agent ON vault_guide_grant (agent_id);

-- 查看审计：只记谁在何时看了哪条指引，meta 只放最小元数据。
CREATE TABLE vault_guide_audit (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'view',
  meta TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_vault_guide_audit_ts ON vault_guide_audit (ts DESC);
CREATE INDEX idx_vault_guide_audit_entry ON vault_guide_audit (entry_id, ts DESC);

-- per-agent 技能开关：Skills 系统没有按 agent 启用的机制（阶段 0 已核），
-- 内置技能 vault-broker 的开关新存这一列，默认关。
ALTER TABLE agents ADD COLUMN vault_guide_enabled INTEGER NOT NULL DEFAULT 0;
