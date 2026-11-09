-- 历史回填：vault_access_log（审计事实源）→ user_ops（系统日志「保险库」board）。
--
-- 背景：保险库页自己的「访问记录」视图与 GET /api/vault/access-log 已下线，
-- 访问记录的展示统一归入总览页「系统日志」的「保险库」板块。新产生的
-- reveal / export 会由代码同时写 vault_access_log 与 oplog（src/vault.ts 的
-- revealSecret、src/vault-http.ts 的 totpExport），本文件只负责把存量审计行
-- 补进 user_ops。vault_access_log 本身不动：它仍是审计事实源，备份导出也照旧。
--
-- 映射口径（与代码里的文案一一对应）：
--   module     = '保险库'（oplog board key = vault）
--   at         = vault_access_log.created_at 原样保留（毫秒时间戳，不改时区）
--   action     = '导出'（action='export'）/ '查看'（action='reveal' 及其它）
--   target_id  = 原 target_id；导出「未分组」（target_id 为 NULL/空/'__none__'）落 NULL
--   target_name= JOIN 到目标名就带（条目名 / 网关名 / 邮箱地址 /
--                「服务名（账号）」/「验证码（全部|未分组|分组名）」），
--                JOIN 不到（条目已删）用 kind + 短 id 兜底
--   text       = 「查看条目密码 · X」「查看网关密钥 · X」
--                「查看邮箱 SMTP 密码 · X」「查看验证码密钥 · X」
--                「导出验证码 · 全部|未分组|分组名」
--                （历史行没有条数信息，导出文案不带「（N 条）」；新写入的行带）
--   actor      = actor 非空时带入（阶段 6 的 MCP/Agent 名），文案末尾追加
--                「（Agent <名字>）」；actor 为空的面板行记「管理员」，
--                与 logOp 的默认口径一致
--
-- 防重：用 NOT EXISTS 按 (at, module, action, target_id, text) 五元组判断。
-- INSERT…SELECT 的 NOT EXISTS 只看到语句开始前的 user_ops 快照，所以：
--   * 重复执行整份文件不会产生双份（第二次起全部被 NOT EXISTS 挡住）；
--   * 同一次里同一毫秒对同一目标的重复审计行仍各补一条（条数与审计行一致，
--     user_ops 没有 source id 可回溯，不尝试折叠）。
-- 若某个时间段已经有过新版代码写的同 at/action/target 行（文案不同，例如带
-- 「（N 条）」），会再补一条历史口径的行；这是预期行为，两行都以审计行数为准。
--
-- 执行方式：本文件只跑一次（预发/生产各一次）。跑前跑后各跑一遍下面的
-- 计数查询核对条数；如需先看预演结果，把最后的 INSERT 换成 SELECT *。
--
--   跑前：
--     SELECT COUNT(*) AS vault_rows,
--            SUM(action = 'reveal') AS reveal_rows,
--            SUM(action = 'export') AS export_rows,
--            SUM(actor IS NOT NULL AND actor <> '') AS agent_rows
--       FROM vault_access_log;
--     SELECT COUNT(*) AS oplog_vault_rows FROM user_ops WHERE module = '保险库';
--
--   跑后（oplog_vault_rows 的增量应 = vault_rows - 已有等价行的条数，通常就是 vault_rows）：
--     SELECT COUNT(*) AS oplog_vault_rows FROM user_ops WHERE module = '保险库';
--

WITH src AS (
  SELECT
    l.id,
    l.target_kind,
    l.target_id,
    l.action,
    l.actor,
    l.created_at,
    CASE l.target_kind
      WHEN 'entry' THEN (SELECT e.name FROM vault_entries e WHERE e.id = l.target_id)
      WHEN 'gateway' THEN (SELECT g.name FROM gateways g WHERE g.id = l.target_id)
      WHEN 'email' THEN (SELECT m.address FROM emails m WHERE m.id = l.target_id)
      WHEN 'totp' THEN (
        SELECT CASE WHEN t.account <> '' THEN t.issuer || '（' || t.account || '）' ELSE t.issuer END
          FROM vault_totp t WHERE t.id = l.target_id
      )
    END AS resolved_name,
    CASE
      WHEN l.target_kind = 'totp'
        AND l.action = 'export'
        AND l.target_id IS NOT NULL
        AND l.target_id <> ''
        AND l.target_id <> 'all'
        AND l.target_id <> '__none__'
        THEN (SELECT g.name FROM vault_groups g WHERE g.id = l.target_id)
      ELSE NULL
    END AS resolved_group
  FROM vault_access_log l
),
mapped AS (
  SELECT
    s.id,
    s.created_at,
    COALESCE(NULLIF(s.actor, ''), '管理员') AS op_actor,
    CASE s.action WHEN 'export' THEN '导出' ELSE '查看' END AS op_action,
    CASE
      WHEN s.action = 'export' AND (s.target_id IS NULL OR s.target_id = '' OR s.target_id = '__none__') THEN NULL
      ELSE s.target_id
    END AS op_target_id,
    CASE
      WHEN s.action = 'export' THEN
        CASE
          WHEN s.target_id = 'all' THEN '验证码（全部）'
          WHEN s.target_id IS NULL OR s.target_id = '' OR s.target_id = '__none__' THEN '验证码（未分组）'
          ELSE '验证码（' || COALESCE(s.resolved_group, '未知分组') || '）'
        END
      WHEN s.target_kind = 'entry' THEN COALESCE(s.resolved_name, '条目 ' || substr(s.target_id, 1, 8))
      WHEN s.target_kind = 'gateway' THEN COALESCE(s.resolved_name, '网关 ' || substr(s.target_id, 1, 8))
      WHEN s.target_kind = 'email' THEN COALESCE(s.resolved_name, '邮箱 ' || substr(s.target_id, 1, 8))
      WHEN s.target_kind = 'totp' THEN COALESCE(s.resolved_name, '验证码 ' || substr(s.target_id, 1, 8))
      ELSE s.target_kind || ' ' || COALESCE(substr(s.target_id, 1, 8), '')
    END AS op_target_name,
    (
      CASE
        WHEN s.action = 'export' THEN
          '导出验证码 · ' ||
          CASE
            WHEN s.target_id = 'all' THEN '全部'
            WHEN s.target_id IS NULL OR s.target_id = '' OR s.target_id = '__none__' THEN '未分组'
            ELSE COALESCE(s.resolved_group, '分组 ' || substr(s.target_id, 1, 8))
          END
        WHEN s.target_kind = 'entry' THEN
          '查看条目密码 · ' || COALESCE(s.resolved_name, '条目 ' || substr(s.target_id, 1, 8))
        WHEN s.target_kind = 'gateway' THEN
          '查看网关密钥 · ' || COALESCE(s.resolved_name, '网关 ' || substr(s.target_id, 1, 8))
        WHEN s.target_kind = 'email' THEN
          '查看邮箱 SMTP 密码 · ' || COALESCE(s.resolved_name, '邮箱 ' || substr(s.target_id, 1, 8))
        WHEN s.target_kind = 'totp' THEN
          '查看验证码密钥 · ' || COALESCE(s.resolved_name, '验证码 ' || substr(s.target_id, 1, 8))
        ELSE '查看保险库记录 · ' || s.target_kind || ' ' || COALESCE(substr(s.target_id, 1, 8), '')
      END
    ) || CASE WHEN s.actor IS NOT NULL AND s.actor <> '' THEN '（Agent ' || s.actor || '）' ELSE '' END AS op_text
  FROM src s
)
INSERT INTO user_ops (at, actor, module, action, target_id, target_name, text)
SELECT
  m.created_at,
  m.op_actor,
  '保险库',
  m.op_action,
  m.op_target_id,
  m.op_target_name,
  m.op_text
FROM mapped m
WHERE NOT EXISTS (
  SELECT 1
  FROM user_ops u
  WHERE u.at = m.created_at
    AND u.module = '保险库'
    AND u.action = m.op_action
    AND u.target_id IS m.op_target_id
    AND u.text = m.op_text
);
