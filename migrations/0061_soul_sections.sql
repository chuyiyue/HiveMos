-- Soul 分段（memory-soul 优化方案 P2）：把 Soul 拆成带字符上限的命名段落
-- （persona / rules / tools / learned_context，上限在 src/soul.ts 常量里）。
-- soul_sections 只存「当前已生效」的分段：souls.content 恒等于 active 版本
-- 全文，有分段时即各段按固定顺序拼接的结果；无分段行表示该 Soul 尚未
-- 分段化，全文以 souls.content 为准。
-- soul_section_drafts 是待批准草稿的分段快照暂存：Agent 经 MCP 用
-- soul_patch 提交的 pending 版本在批准前不能动 soul_sections，快照先放
-- 这里，keyed by (soul_id, version)；批准时整表替换进 soul_sections 并
-- 删除快照，拒绝时直接删除快照。只加表，不改既有列。

CREATE TABLE soul_sections (
  soul_id TEXT NOT NULL,
  section TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (soul_id, section)
);

CREATE TABLE soul_section_drafts (
  soul_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  sections_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (soul_id, version)
);
