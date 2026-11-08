-- 云主机二期接入（Roye 2026-11-08 定）：三类机器三种接入方式。
-- 服务器直接存 SSH 信息（密码或私钥经 AES-GCM 加密存 ssh_secret_enc，明文只经
-- 面板 reveal 与 MCP machines_get_access 给出，两条路都先写 machines_audit）；
-- 云主机各厂商接入方式不同，本期只记厂商与接入备注，后续在仓库里逐家支持；
-- Workers 在面板保存 Cloudflare 账号 ID + API 令牌（加密存），面板据此实时
-- 拉取该账号名下的 Workers 展示。
-- 展示字段 note / hostname / os / ip 主要给服务器用（卡片事实行），cloud 可复用 note。
-- ssh_user 只存不用：不进卡片、不进 public 投影，只在编辑弹窗与
-- machines_get_access 返回里出现。时间戳一律 Unix 毫秒（本迁移只有结构变更）。

ALTER TABLE machines ADD COLUMN note TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN hostname TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN os TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN ip TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN ssh_host TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN ssh_port INTEGER NOT NULL DEFAULT 22;
ALTER TABLE machines ADD COLUMN ssh_user TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN ssh_secret_enc TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN ssh_tail TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN vendor TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN access_note TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN cf_account_id TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN api_token_enc TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN api_token_tail TEXT NOT NULL DEFAULT '';
