-- 日历一期：calendars / events / calendar_audit / calendar_feed_tokens 四张表，
-- 加一张 caldav_devices 预留（二期 CalDAV 用，本期不写代码）。
-- 时间戳一律 Unix 毫秒；事件起止存 UTC 毫秒，tzid 保存原始时区，重复规则存
-- RRULE 原文、查询时按窗展开。删除走 deleted_at 软删除墓碑。

CREATE TABLE calendars (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#D97757',
  kind TEXT NOT NULL DEFAULT 'native' CHECK (kind IN ('native', 'mirror', 'imported')),
  source_url TEXT,
  source_etag TEXT,
  source_last_modified TEXT,
  last_sync_at INTEGER,
  sync_status TEXT,
  sync_error TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  ctag INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  tzid TEXT NOT NULL DEFAULT '',
  all_day INTEGER NOT NULL DEFAULT 0,
  rrule TEXT,
  exdates TEXT,
  rdates TEXT,
  recurrence_of TEXT,
  recurrence_id INTEGER,
  status TEXT NOT NULL DEFAULT 'confirmed',
  etag INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'panel',
  created_by TEXT,
  external_id TEXT,
  content_hash TEXT,
  tags_json TEXT,
  ai_status TEXT,
  related_json TEXT,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_events_calendar_uid ON events (calendar_id, uid, recurrence_id);
CREATE INDEX idx_events_calendar_start ON events (calendar_id, starts_at);
CREATE INDEX idx_events_recurrence_of ON events (recurrence_of);
CREATE INDEX idx_events_deleted ON events (deleted_at);

CREATE TABLE calendar_audit (
  id TEXT PRIMARY KEY,
  event_id TEXT,
  calendar_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  diff_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_calendar_audit_event ON calendar_audit (event_id, created_at);
CREATE INDEX idx_calendar_audit_calendar ON calendar_audit (calendar_id, created_at);

CREATE TABLE calendar_feed_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  calendar_id TEXT,
  last_used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

-- 二期 CalDAV 设备密码：先预留表结构，本期无任何读写代码。
CREATE TABLE caldav_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

-- 默认日历：agent 不指定日历时的落点。已有行时不重复插入。
INSERT OR IGNORE INTO calendars (id, name, color, kind, timezone, ctag, is_default, created_by, created_at, updated_at)
VALUES ('cal_default', '默认日历', '#D97757', 'native', 'Asia/Shanghai', 1, 1, 'system', 0, 0);
