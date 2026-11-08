-- Soul 历史版本的显示名与展示顺序。只加列，不改既有列。
-- label 为空时面板用默认名（版本号，时间仍单独显示）。
-- sort_order 越小越靠前；相同则版本号新的在前。旧行默认 0，因此
-- 未手动排序时仍是新版本在前。排序只影响展示，不改变当前生效版本。

ALTER TABLE soul_versions ADD COLUMN label TEXT;
ALTER TABLE soul_versions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
