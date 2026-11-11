-- MiSub 代理数据落库（2026-11-12 用户改口：「写到 d1 吧，控制拉取频率就行」）。
--
-- 两张表，都按「一行一个整体」存，避免免费计划每次调用的 D1 查询数上限：
--   misub_snapshots           每个 MiSub 连接一行：订阅源 / 手工节点 / 订阅组列表的
--                             公开快照（JSON，已脱敏），以及密封的拉取参数
--                             （订阅地址 + UA、手工节点原始链接）
--   misub_subscription_nodes  每个机场订阅一行：节点列表（JSON，已脱敏）与密封的
--                             原始链接数组，拉取状态与频率设置
--
-- 机密列（*_enc）一律是 VAULT_KEY 的 enc1: 信封，列表接口不读它们，明文只走
-- reveal（先写审计）。拉取失败只更新 last_* 状态，不覆盖上一次成功的数据。
-- 时间戳一律 Unix 毫秒；*_ok 用 1/0。连接删除时由应用删这两张表里的对应行。

CREATE TABLE misub_snapshots (
  connection_id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL DEFAULT '',
  secrets_enc TEXT NOT NULL DEFAULT '',
  synced_at INTEGER,
  last_attempt_at INTEGER,
  last_ok INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  manual_at INTEGER
);

CREATE TABLE misub_subscription_nodes (
  connection_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  -- NULL 表示跟随连接的自动拉取间隔；0 表示这个订阅不自动拉取
  interval_hours INTEGER,
  nodes_json TEXT NOT NULL DEFAULT '[]',
  links_enc TEXT NOT NULL DEFAULT '',
  node_count INTEGER NOT NULL DEFAULT 0,
  format TEXT NOT NULL DEFAULT '',
  truncated INTEGER NOT NULL DEFAULT 0,
  user_info_json TEXT NOT NULL DEFAULT '',
  last_attempt_at INTEGER,
  last_ok INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  last_success_at INTEGER,
  manual_at INTEGER,
  PRIMARY KEY (connection_id, subscription_id)
);

CREATE INDEX idx_misub_sub_nodes_attempt ON misub_subscription_nodes (connection_id, last_attempt_at);
