-- 0014: 清除开发期演示种子（Roye 2026-11-08 指示：项目不填充演示内容）
-- 只删迁移 0002/0009/0011/0012 写入的种子 id；真实条目 cloud-mail 与邮箱名单不在此列
DELETE FROM mcp_servers WHERE id IN ('mcp_smsinbox');
DELETE FROM machines WHERE id IN ('pc_hk', 'pc_local', 'sv_sg', 'sv_sh', 'wk_hivemos', 'wk_mail', 'wk_sms');
DELETE FROM vault_entries WHERE id IN ('sec_deploy', 'sec_gateway', 'sec_recovery');
DELETE FROM gateways WHERE id IN ('gw_cf', 'gw_grok', 'gw_local');
DELETE FROM apps WHERE id IN ('app_claude', 'app_cursor');
DELETE FROM skills WHERE id IN ('skill_deploy', 'skill_search', 'skill_vault');
DELETE FROM apis WHERE id IN ('api_mails', 'api_mistgate');
