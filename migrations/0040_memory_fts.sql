-- 记忆检索 P1：FTS5 trigram 索引 + 同步触发器 + 存量回填。
--
-- 采用 external content：索引只存 trigram 倒排，正文仍以 memories 为准，
-- 不复制一份内容（避免双写与容量翻倍）。列名必须与 content 表一致，所以
-- 标签列沿用 memories.tags_json，而不是另造 tags。
--
-- tokenize='trigram'：按三字符滑窗切词，支持中文与英文的子串搜索
-- （例如「验证码」能在「输入验证码后继续」中命中）。两字以内的查询没有
-- 完整 trigram，服务层会回退到原 LIKE 路径。
--
-- 触发器必须同时给出 INSERT 与 DELETE 两个方向：external content 表的
-- 'delete' 命令要拿到旧值才能把旧 terms 从倒排里移除。

CREATE VIRTUAL TABLE memories_fts USING fts5(
  title,
  content,
  tags_json,
  content='memories',
  content_rowid='rowid',
  tokenize='trigram'
);

CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, content, tags_json)
  VALUES (new.rowid, new.title, new.content, coalesce(new.tags_json, ''));
END;

CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, tags_json)
  VALUES ('delete', old.rowid, old.title, old.content, coalesce(old.tags_json, ''));
END;

CREATE TRIGGER memories_fts_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content, tags_json)
  VALUES ('delete', old.rowid, old.title, old.content, coalesce(old.tags_json, ''));
  INSERT INTO memories_fts(rowid, title, content, tags_json)
  VALUES (new.rowid, new.title, new.content, coalesce(new.tags_json, ''));
END;

-- 存量回填：rebuild 让 FTS5 按 content 表逐行重建索引。
INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
