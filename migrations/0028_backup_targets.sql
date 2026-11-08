-- 同步与备份目标（GitHub 仓库 / WebDAV 网盘）。每行一个目标，id 只有
-- 'github' 与 'webdav' 两值。访问令牌与网盘密码与保险库同款 AES-GCM 信封
-- （VAULT_KEY，enc1: 前缀）密封存，独立于 vault_entries，不塞进保险库条目。
-- enabled 只表示「已保存且启用」，保存前先做一次活体测试，测试不过不落库。
-- last_test_* 记最近一次测试结果与细节（GitHub 会放仓库可见性），失败原因
-- 面板上保留；last_error 同时作为「上次失败原因」的来源之一。
-- 时间戳一律 Unix 毫秒。

CREATE TABLE backup_targets (
  id TEXT PRIMARY KEY CHECK (id IN ('github', 'webdav')),
  enabled INTEGER NOT NULL DEFAULT 0,
  owner TEXT NOT NULL DEFAULT '',
  repo TEXT NOT NULL DEFAULT '',
  branch TEXT NOT NULL DEFAULT '',
  path_prefix TEXT NOT NULL DEFAULT '',
  token_enc TEXT NOT NULL DEFAULT '',
  token_tail TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  password_enc TEXT NOT NULL DEFAULT '',
  password_tail TEXT NOT NULL DEFAULT '',
  remote_dir TEXT NOT NULL DEFAULT '',
  last_test_at INTEGER,
  last_test_ok INTEGER NOT NULL DEFAULT 0,
  last_test_detail TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
