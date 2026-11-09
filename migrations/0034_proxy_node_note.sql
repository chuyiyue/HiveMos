-- 代理节点备注：每个节点一条自由文本备注，面板里可写、可清。
-- 只加列，不改既有列。备注是纯展示信息，不密封、不参与 dedupe_key；
-- 订阅同步与手动导入的对账 UPDATE 不写这一列，已有备注在同步后原样保留，
-- 新解析出的节点备注为空。时间戳一律 Unix 毫秒（沿用本表惯例）。

ALTER TABLE proxy_nodes ADD COLUMN note TEXT NOT NULL DEFAULT '';
