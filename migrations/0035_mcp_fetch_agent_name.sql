-- mcp_fetch_audit keeps the calling agent's name after the agent is
-- hard-deleted: the name is snapshotted into this column at delete time
-- and the records/overview readers COALESCE it with the live agents row.
ALTER TABLE mcp_fetch_audit ADD COLUMN agent_name TEXT;
