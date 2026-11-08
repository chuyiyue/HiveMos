-- Agent avatars: three mutually exclusive sources, resolved in one render
-- rule (custom image > library icon > default bot icon):
--   avatar_icon  a redrawn library icon id (see public/avatars.js)
--   avatar_url   an external http/https image link shown as-is
--   agent_avatars row  an uploaded image, kept in its own table so list
--                      payloads stay lean (lists carry only the fields
--                      below plus a has_custom_avatar flag)
ALTER TABLE agents ADD COLUMN avatar_icon TEXT;
ALTER TABLE agents ADD COLUMN avatar_url TEXT;

CREATE TABLE IF NOT EXISTS agent_avatars (
  agent_id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  data BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
