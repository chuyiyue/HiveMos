-- Soul 版本状态：Agent 经 MCP 写入的新版本先落 pending 草稿，管理员在
-- 面板批准后才推进 souls.content/version；rejected 保留行作为审计痕迹。
-- 只加列，不改既有列。旧行由默认值变为 active。

ALTER TABLE soul_versions ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
