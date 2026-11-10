-- GitHub 登录绑定。只存 GitHub 数字 ID（唯一授权依据），
-- 登录名与头像仅用于展示，登录回调只会刷新它们。
-- github_rebind_until 是换绑授权窗口：当前密码复验后写入，回调消费即清空。
ALTER TABLE users ADD COLUMN github_id TEXT;
ALTER TABLE users ADD COLUMN github_login TEXT;
ALTER TABLE users ADD COLUMN github_avatar_url TEXT;
ALTER TABLE users ADD COLUMN github_rebind_until INTEGER;
