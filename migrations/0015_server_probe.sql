-- 服务器探活（Roye 2026-11-08）：添加服务器只填 IP / 用户名 / 密码或密钥 /
-- 备注，保存、手动测试与列表打开时用保存的配置真连 SSH 探活，回填主机名、
-- 系统、内核与架构。auth_type 区分 ssh_secret_enc 里存的是密码还是私钥；
-- probe_* 记最近一次探活结果；host_fingerprint 是主机公钥指纹（TOFU：首次
-- 探活记录，之后不一致直接拒绝连接）。时间戳一律 Unix 毫秒。
ALTER TABLE machines ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'password';
ALTER TABLE machines ADD COLUMN kernel TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN arch TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN probe_status TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN probe_at INTEGER;
ALTER TABLE machines ADD COLUMN probe_error TEXT NOT NULL DEFAULT '';
ALTER TABLE machines ADD COLUMN host_fingerprint TEXT NOT NULL DEFAULT '';
