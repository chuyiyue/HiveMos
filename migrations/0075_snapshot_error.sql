-- 注册表探活失败原因：探活实际失败即停用时把人话原因连同 snapshot_at
-- 一起落库，供总览告警展示；探活成功或手填快照时清空。

ALTER TABLE mcp_servers ADD COLUMN snapshot_error TEXT;
