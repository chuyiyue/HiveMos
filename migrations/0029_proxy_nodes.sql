-- 网络节点：机场订阅与从订阅或粘贴内容解析出的节点。
-- 订阅地址（含令牌）与节点原始链接（含凭据）一律用 VAULT_KEY 的 enc1: 信封密封，
-- 列表接口不选出这两列。subscription_id 为空表示手动导入，不属于任何订阅。
-- dedupe_key 是协议、服务器、端口与凭据材料的哈希，同步时按它 upsert。
-- last_status 空字符串表示还没测过，ok / fail 只表示 TCP 连通，不是协议握手。
-- 时间戳一律 Unix 毫秒。删订阅时由应用先删其节点，不依赖外键级联是否打开。

CREATE TABLE proxy_subscriptions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url_enc TEXT NOT NULL,
  last_sync_at INTEGER,
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE proxy_nodes (
  id TEXT PRIMARY KEY,
  subscription_id TEXT,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  server TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  raw_enc TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  last_status TEXT NOT NULL DEFAULT '' CHECK (last_status IN ('', 'ok', 'fail')),
  last_latency_ms INTEGER,
  last_test_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (subscription_id) REFERENCES proxy_subscriptions (id)
);

CREATE INDEX idx_proxy_nodes_sub_dedupe ON proxy_nodes (subscription_id, dedupe_key);
