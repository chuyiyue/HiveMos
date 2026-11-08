-- Agent 令牌可取回存储 + Agent 管理审计。
-- 此前 agents 只存 token_hash（SHA-256 摘要），明文只在创建/轮换响应里出现
-- 一次，面板「复制密钥」无从取起。新增 token_enc：与保险库同款 AES-GCM
-- 信封（VAULT_KEY，enc1: 前缀）密封的令牌明文；token_hash 继续承担鉴权
-- 查找。存量行 token_enc 为 NULL，复制时明确报不可取用、轮换后补上。
-- agents_audit 记面板侧的 Agent 管理动作（此前该板块无审计表）：actor 恒
-- 为管理员（user），action ∈ create/update/delete/rotate/permissions/
-- token_reveal；reveal 先写审计行再解密回明文。

ALTER TABLE agents ADD COLUMN token_enc TEXT;

CREATE TABLE agents_audit (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'user',
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_agents_audit_agent ON agents_audit (agent_id, created_at DESC);
CREATE INDEX idx_agents_audit_created ON agents_audit (created_at DESC);
