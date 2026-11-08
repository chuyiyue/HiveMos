-- Provider connections for the cloud tab (phase 2): one connection holds a
-- provider's API credentials (sealed under VAULT_KEY as a JSON blob) and
-- owns any number of imported devices (machines rows with connection_id).
-- Deleting a connection detaches its devices (they stay as ordinary cloud
-- entries); deleting a device never touches the connection.
CREATE TABLE provider_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  config_enc TEXT NOT NULL DEFAULT '',
  config_tail TEXT NOT NULL DEFAULT '',
  last_test_at INTEGER,
  last_test_ok INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE machines ADD COLUMN connection_id TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN remote_id TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN remote_name TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN last_sync_at INTEGER;
