-- 邮箱 SMTP。服务器、端口、加密方式、用户名明文存；密码用 VAULT_KEY 的
-- enc1 信封密封在 smtp_secret，列表只回 smtp_secret_set，明文走 reveal。
-- 未配置时 host / security / user 为空串，port 与 secret 为 NULL。
-- smtp_security 取值 ssl / starttls / none。

ALTER TABLE emails ADD COLUMN smtp_host TEXT NOT NULL DEFAULT '';
ALTER TABLE emails ADD COLUMN smtp_port INTEGER;
ALTER TABLE emails ADD COLUMN smtp_security TEXT NOT NULL DEFAULT '';
ALTER TABLE emails ADD COLUMN smtp_user TEXT NOT NULL DEFAULT '';
ALTER TABLE emails ADD COLUMN smtp_secret TEXT;
