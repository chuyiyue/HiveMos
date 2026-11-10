-- 镜像日历连续同步失败计数：达到阈值（代码常量 MIRROR_SYNC_FAIL_LIMIT=3）
-- 即暂停自动同步，手动同步成功清零恢复。

ALTER TABLE calendars ADD COLUMN sync_fail_count INTEGER NOT NULL DEFAULT 0;
