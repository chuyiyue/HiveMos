-- Machine operations: raw remote state for imported devices (drives the
-- power button and honest status labels) + per-machine keepalive policy.
ALTER TABLE machines ADD COLUMN remote_state TEXT;

CREATE TABLE IF NOT EXISTS machine_keepalive (
  machine_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'off',
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  windows_json TEXT NOT NULL DEFAULT '[]',
  last_checked_at INTEGER,
  last_result TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);
