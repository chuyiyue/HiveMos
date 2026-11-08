-- 云主机模块：machines 一张表承载服务器 / 云主机 / Workers 三类（kind 区分），
-- machines_audit 记面板与 MCP 的读写审计（口径同 calendar_audit）。
-- 时间戳一律 Unix 毫秒；种子条目即原面板 mock 的七条，上线即是现在的样子。
-- ai_summary / ai_tags 只预留列，本期不写代码。

CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('server', 'cloud', 'worker')),
  name TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  spec TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  binding TEXT NOT NULL DEFAULT '',
  last_heartbeat_at INTEGER,
  ai_summary TEXT,
  ai_tags TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_machines_kind ON machines (kind, created_at);

CREATE TABLE machines_audit (
  id TEXT PRIMARY KEY,
  machine_id TEXT,
  actor TEXT NOT NULL,
  source TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_machines_audit_machine ON machines_audit (machine_id, created_at);

-- 种子：时间按原 mock 展示值（北京时间）换算为 UTC 毫秒。
INSERT INTO machines (id, kind, name, region, spec, description, version, status, binding, last_heartbeat_at, created_at, updated_at) VALUES
  ('sv_sh', 'server', '上海-01', '华东', '8 核 / 16 GB / 500 GB', '', '', 'running', '编排、值守',
   CAST(strftime('%s', '2026-11-07 01:24:00') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-10-20 16:00:00') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-11-07 01:24:00') AS INTEGER) * 1000),
  ('sv_sg', 'server', '新加坡-02', '东南亚', '4 核 / 8 GB / 200 GB', '', '', 'running', '研究',
   CAST(strftime('%s', '2026-11-07 01:18:00') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-10-21 16:00:00') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-11-07 01:18:00') AS INTEGER) * 1000),
  ('pc_hk', 'cloud', '香港-01', '香港', '2 核 / 4 GB / 40 GB', '', '', 'running', '值守',
   CAST(strftime('%s', '2026-11-07 01:21:00') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-10-22 16:00:00') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-11-07 01:21:00') AS INTEGER) * 1000),
  ('pc_local', 'cloud', '本地沙箱', '本机', '沙箱环境', '', '', 'paused', '未绑定',
   CAST(strftime('%s', '2026-11-06 10:02:00') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-10-23 16:00:00') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-11-06 10:02:00') AS INTEGER) * 1000),
  ('wk_hivemos', 'worker', 'hivemos', '', '', '本控制面', '最新提交', 'active', '',
   NULL,
   CAST(strftime('%s', '2026-10-24 16:00:00') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-11-07 19:50:00') AS INTEGER) * 1000),
  ('wk_mail', 'worker', 'cloud-mail', '', '', 'mail.outtw.com', '最新提交', 'active', '',
   NULL,
   CAST(strftime('%s', '2026-10-25 16:00:00') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-11-07 16:03:00') AS INTEGER) * 1000),
  ('wk_sms', 'worker', 'smsinbox', '', '', 'SMSinBox', '最新提交', 'active', '',
   NULL,
   CAST(strftime('%s', '2026-10-26 16:00:00') AS INTEGER) * 1000,
   CAST(strftime('%s', '2026-11-07 14:10:00') AS INTEGER) * 1000);
