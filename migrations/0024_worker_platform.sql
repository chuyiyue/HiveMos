-- Workers 接入分平台：cloudflare（默认，存量行）与 vercel。
-- platform 只对 kind='worker' 有意义；team_id 是 Vercel 的团队 ID（个人账号留空）。
ALTER TABLE machines ADD COLUMN platform TEXT NOT NULL DEFAULT 'cloudflare';
ALTER TABLE machines ADD COLUMN team_id TEXT NOT NULL DEFAULT '';
