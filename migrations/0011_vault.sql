-- 保险库模块 v1：账号密码条目、模型网关、邮箱三张表 + 访问日志。
-- 只有条目密码与网关密钥是机密：AES-GCM 加密存（密钥来自 Worker 机密
-- VAULT_KEY），其余字段（网址、账号、备注、邮箱信息）v1 明文存。
-- 列表只回末四位（tail），明文只能经 reveal 接口读取并写一条访问日志。
-- 种子即原面板 mock：条目/网关没有真值，password_enc / key_enc 存空、
-- tail 用原展示尾号；条目的原「类型」并入备注。

CREATE TABLE vault_entries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  password_enc TEXT NOT NULL DEFAULT '',
  tail TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE gateways (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  proto TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT '',
  models TEXT NOT NULL DEFAULT '',
  key_enc TEXT NOT NULL DEFAULT '',
  tail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'paused',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE emails (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  portal TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE vault_access_log (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_vault_access_log_created ON vault_access_log (created_at DESC);

-- 种子：时间按原 mock 展示值（北京时间）换算为 UTC 毫秒。
INSERT INTO vault_entries (id, name, url, username, password_enc, tail, note, created_at, updated_at) VALUES
  ('sec_gateway', '模型网关密钥', '', '', '', '91f2', 'API Key',
   CAST(strftime('%s', '2026-11-06 01:12:00') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-11-06 01:12:00') AS INTEGER) * 1000),
  ('sec_deploy', '部署令牌', '', '', '', 'k7Qm', 'Token',
   CAST(strftime('%s', '2026-11-04 06:33:00') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-11-04 06:33:00') AS INTEGER) * 1000),
  ('sec_recovery', '设备恢复码', '', '', '', '4418', 'Recovery',
   CAST(strftime('%s', '2026-10-28 00:05:00') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-10-28 00:05:00') AS INTEGER) * 1000);

INSERT INTO gateways (id, name, proto, base_url, models, key_enc, tail, status, created_at, updated_at) VALUES
  ('gw_cf', 'Workers AI 网关', 'OpenAI 兼容', 'gateway.ai.cloudflare.com', '12 个模型', '', '91f2', 'active',
   CAST(strftime('%s', '2026-11-05 01:00:00') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-11-05 01:00:00') AS INTEGER) * 1000),
  ('gw_grok', 'grok2api', 'OpenAI 兼容', 'grok2api 部署地址', '3 个模型', '', '77ab', 'active',
   CAST(strftime('%s', '2026-11-05 01:00:00') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-11-05 01:00:00') AS INTEGER) * 1000),
  ('gw_local', '本地中转', 'Anthropic 兼容', '云主机内网地址', '5 个模型', '', 'c041', 'paused',
   CAST(strftime('%s', '2026-11-05 01:00:00') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-11-05 01:00:00') AS INTEGER) * 1000);

INSERT INTO emails (id, address, purpose, portal, note, created_at, updated_at) VALUES
  ('em_main', 'royecc@outlook.com', '主邮箱', 'Outlook', '微软账号与订阅都在这个邮箱',
   CAST(strftime('%s', '2026-11-01 00:00:00') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-11-01 00:00:00') AS INTEGER) * 1000),
  ('em_chuyiyue', 'chuyiyue@outtw.com', '注册优先', 'mail.outtw.com', '注册类事务优先用它，验证码可直接读取',
   CAST(strftime('%s', '2026-11-01 00:00:01') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-11-01 00:00:01') AS INTEGER) * 1000),
  ('em_admin', 'admin@outtw.com', '邮局管理员', 'mail.outtw.com', '自建邮局管理员，可切换到各子邮箱',
   CAST(strftime('%s', '2026-11-01 00:00:02') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-11-01 00:00:02') AS INTEGER) * 1000),
  ('em_ling', 'ling@outtw.com', '申诉与纠纷', 'mail.outtw.com', 'giffgaff 与 Ombudsman 案件用邮箱',
   CAST(strftime('%s', '2026-11-01 00:00:03') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-11-01 00:00:03') AS INTEGER) * 1000),
  ('em_mail', 'mail@outtw.com', '子邮箱', 'mail.outtw.com', '',
   CAST(strftime('%s', '2026-11-01 00:00:04') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-11-01 00:00:04') AS INTEGER) * 1000),
  ('em_i', 'i@outtw.com', '子邮箱', 'mail.outtw.com', '',
   CAST(strftime('%s', '2026-11-01 00:00:05') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-11-01 00:00:05') AS INTEGER) * 1000),
  ('em_2026', '20260613@outtw.com', '子邮箱', 'mail.outtw.com', '',
   CAST(strftime('%s', '2026-11-01 00:00:06') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-11-01 00:00:06') AS INTEGER) * 1000);
