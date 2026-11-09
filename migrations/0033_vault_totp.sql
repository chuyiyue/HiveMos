-- 保险库「验证码」：TOTP 两步验证条目（阶段 1、3、4 的服务端）。
--
-- 与条目密码同一套机密口径：secret_enc 是 VAULT_KEY 信封的 AES-GCM 密文
-- （openSecret / sealSecret 复用 vault.ts 的同一套实现），列表只回公开字段。
-- 密钥明文只有两条出路：/api/vault/reveal（kind=totp）与重验管理员密码的
-- 导出接口，两者都先写一条 vault_access_log（action 'reveal' / 'export'）。
--
-- secret_hash 是归一化密钥（base32 大写无填充）的 SHA-256 十六进制，只用于
-- 判重（同一条密钥重复导入/添加时返回 409），不可逆推明文，也不进备份包。
--
-- 分组复用 vault_groups 这张自有分组池（与 vault_entries / gateways 同一张
-- 表、同一删除语义：删组时置空回未分组，不连带删条目）。
--
-- ai_read 与 vault_access_log.actor 是给阶段 6（MCP 面 + 权限 P0）预留的：
-- 本轮没有 MCP 工具，面板路径的 actor 一律留 NULL。

CREATE TABLE vault_totp (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT '',
  secret_enc TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'SHA1',
  digits INTEGER NOT NULL DEFAULT 6,
  period INTEGER NOT NULL DEFAULT 30,
  icon TEXT,
  note TEXT NOT NULL DEFAULT '',
  group_id TEXT,
  ai_read INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_vault_totp_secret_hash ON vault_totp (secret_hash);
CREATE INDEX idx_vault_totp_group ON vault_totp (group_id);

-- 访问日志的操作者：面板操作留 NULL，MCP 写入（阶段 6）才填 Agent 名。
ALTER TABLE vault_access_log ADD COLUMN actor TEXT;
