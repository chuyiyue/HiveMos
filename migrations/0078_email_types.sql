-- 保险库邮箱按类型展示（首批 smtp / resend）。
-- type 只允许 smtp 或 resend，缺省 smtp：迁移前的老行会自动成为 smtp，
-- 原来的 SMTP 配置列保持原值不动。
-- Resend 的 API Key 复用 smtp_secret 这一密封列（同一把 VAULT_KEY、同一个
-- enc1 信封），smtp_* 配置列对 resend 行保持空白；公开视图按类型命名，
-- resend 行只回 resend_api_key_set。

ALTER TABLE emails ADD COLUMN type TEXT NOT NULL DEFAULT 'smtp' CHECK (type IN ('smtp', 'resend'));
