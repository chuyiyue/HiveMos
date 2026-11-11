#!/usr/bin/env node
// MiSub 自动拉取下放到各连接：未设置间隔 = 关闭，sweep 零出站。
//
//   node scripts/misub-sweep-vectors.mjs
//
// 用可计数的假 fetch 覆盖简报四条：
//   ① 连接未设间隔：出站 0
//   ② 间隔 6 且已到期：只拉该连接
//   ③ 间隔 6 未到期：出站 0
//   ④ 订阅 interval_hours=0 不被拉，其余到期订阅正常拉

import { register } from "node:module";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      for (const suffix of [".ts", "/index.ts"]) {
        try { return await next(specifier + suffix, context); } catch {}
      }
    }
    throw error;
  }
}
`),
);

const { effectiveAutoIntervalHours, listMisubConnections } = await import("../src/misub.ts");
const { readMisubView, runMisubSweep } = await import("../src/misub-store.ts");
const { resolveContentKey, sealString } = await import("../src/crypto.ts");

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const VAULT_KEY = Buffer.alloc(32, 7).toString("base64url");
const contentKey = resolveContentKey(VAULT_KEY);
if (contentKey.state !== "on") throw new Error("测试密钥无效");
const tokenEnc = await sealString(contentKey, "misub-token-1234");

let pass = 0;
let fail = 0;
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log("ok   " + label + " = " + a);
  } else {
    fail++;
    console.error("FAIL " + label + "\n  got      " + a + "\n  expected " + e);
  }
}

function makeD1() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  raw.exec(readFileSync(new URL("../migrations/0078_misub_store.sql", import.meta.url), "utf8"));
  const wrap = (sql, params = []) => ({
    bind: (...next) => wrap(sql, next),
    first: async () => {
      const row = raw.prepare(sql).get(...params);
      return row === undefined ? null : row;
    },
    all: async () => ({ results: raw.prepare(sql).all(...params) }),
    run: async () => {
      const result = raw.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  });
  return {
    raw,
    prepare: (sql) => wrap(sql),
    batch: async (statements) => {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

function envOf(db) {
  return { DB: db, VAULT_KEY };
}

function connection(partial) {
  const row = {
    id: partial.id,
    name: partial.name || partial.id,
    base_url: partial.base_url,
    token_enc: tokenEnc,
    token_tail: "1234",
    refresh_enabled: false,
    node_ua: "",
    last_test_at: 0,
    last_test_ok: true,
    last_error: "",
    created_at: 1,
    updated_at: 1,
  };
  if (Object.prototype.hasOwnProperty.call(partial, "auto_interval_hours")) {
    row.auto_interval_hours = partial.auto_interval_hours;
  }
  return row;
}

async function putConnections(db, rows) {
  const value = JSON.stringify({ connections: rows, active_id: rows[0] ? rows[0].id : "" });
  await db
    .prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('misub_connections', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(value)
    .run();
  return value;
}

async function putSnapshot(db, connId, subs, lastAttempt) {
  const data = {
    config: { base_url: "https://stored.example", token_tail: "", refresh_enabled: false },
    fetched_at: NOW,
    overview: {
      subscriptions: subs.length,
      manual_nodes: 0,
      profiles: 0,
      total_nodes: 0,
      traffic_used: 0,
      traffic_total: 0,
      nearest_expire: null,
    },
    subscriptions: subs.map((sub) => ({
      id: sub.id,
      name: sub.name || sub.id,
      enabled: sub.enabled !== false,
      group: "",
      tags: [],
      url_masked: "https://ai***.example/••••",
      node_count: 1,
      upload: 0,
      download: 0,
      total: 0,
      expire: null,
      last_update: null,
      last_error: "",
    })),
    manual_nodes: [],
    profiles: [],
  };
  const sources = {};
  for (const sub of subs) sources[sub.id] = { url: sub.url, user_agent: "" };
  const secrets = await sealString(contentKey, JSON.stringify({ sources, manual_links: {} }));
  await db
    .prepare(
      "INSERT INTO misub_snapshots (connection_id, data_json, secrets_enc, synced_at, last_attempt_at, last_ok, last_error) VALUES (?, ?, ?, ?, ?, 1, '')",
    )
    .bind(connId, JSON.stringify(data), secrets, NOW, lastAttempt)
    .run();
  for (const sub of subs) {
    if (sub.interval === undefined && sub.lastAttempt === undefined) continue;
    await db
      .prepare(
        "INSERT INTO misub_subscription_nodes (connection_id, subscription_id, interval_hours, last_attempt_at) VALUES (?, ?, ?, ?)",
      )
      .bind(
        connId,
        sub.id,
        sub.interval === undefined ? null : sub.interval,
        sub.lastAttempt === undefined ? null : sub.lastAttempt,
      )
      .run();
  }
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function textResponse(body) {
  return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
}

const NODE_BODY = "vless://uuid@a.example.com:443#A";
const EMPTY_LIST = { success: true, data: [], meta: { total: 0, page: 1, pageSize: 200 } };

async function withFetch(handler, fn) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  };
  try {
    return { calls, result: await fn() };
  } finally {
    globalThis.fetch = previous;
  }
}

function count(calls, prefix) {
  return calls.filter((url) => url.startsWith(prefix)).length;
}

eq("有效间隔 缺失", effectiveAutoIntervalHours(undefined), 0);
eq("有效间隔 null", effectiveAutoIntervalHours(null), 0);
eq("有效间隔 0", effectiveAutoIntervalHours(0), 0);
eq("有效间隔 已存 6", effectiveAutoIntervalHours(6), 6);

// 已存明确数值保持原样；缺字段的连接读出来是 0，并且不把 6 写回库。
{
  const db = makeD1();
  const missing = connection({ id: "c-missing", base_url: "https://missing.example" });
  const kept = connection({ id: "c-kept", base_url: "https://kept.example", auto_interval_hours: 6 });
  const off = connection({ id: "c-off", base_url: "https://off.example", auto_interval_hours: 0 });
  await putConnections(db, [missing, kept, off]);
  const listed = await listMisubConnections(db);
  const byId = Object.fromEntries(listed.connections.map((row) => [row.id, row.auto_interval_hours]));
  eq("读取 未设间隔", byId["c-missing"], 0);
  eq("读取 已存 6", byId["c-kept"], 6);
  eq("读取 已存 0", byId["c-off"], 0);
  const raw = db.raw.prepare("SELECT value FROM schema_meta WHERE key = 'misub_connections'").get().value;
  const stored = JSON.parse(raw).connections;
  eq("落库 未设字段仍缺失", Object.prototype.hasOwnProperty.call(stored[0], "auto_interval_hours"), false);
  eq("落库 已存 6 不动", stored[1].auto_interval_hours, 6);
}

// ① 连接未设间隔，快照和订阅都像「从没拉过」（旧逻辑会按 6 小时立刻出站）。
{
  const db = makeD1();
  const row = connection({ id: "c-unset", base_url: "https://unset.example" });
  await putConnections(db, [row]);
  await putSnapshot(
    db,
    "c-unset",
    [{ id: "sub-follow", url: "https://airport-unset.example/sub" }],
    null,
  );
  const env = envOf(db);
  const view = await readMisubView(env, "c-unset");
  eq("① 连接有效间隔", view.sync.auto_interval_hours, 0);
  eq("① 下次自动", view.sync.next_auto_at, null);
  eq("① 订阅跟随有效间隔", view.snapshot.subscriptions[0].effective_interval_hours, 0);
  const { calls, result } = await withFetch(
    () => textResponse("should-not-be-called"),
    () => runMisubSweep(env, NOW),
  );
  eq("① 出站次数", calls.length, 0);
  eq("① sweep 统计", result, { lists: 0, fetched: 0, failed: 0 });
  console.log("sweep① outbound=" + calls.length);
}

// ② 间隔 6 且已到期的连接会拉列表和它自己的机场；未设间隔、未到期的连接不出站。
{
  const db = makeD1();
  const unset = connection({ id: "c-unset", base_url: "https://unset.example" });
  const quiet = connection({ id: "c-quiet", base_url: "https://quiet.example", auto_interval_hours: 6 });
  const due = connection({ id: "c-due", base_url: "https://due.example", auto_interval_hours: 6 });
  await putConnections(db, [unset, quiet, due]);
  await putSnapshot(db, "c-unset", [{ id: "sub-unset", url: "https://airport-unset.example/sub" }], null);
  await putSnapshot(
    db,
    "c-quiet",
    [{ id: "sub-quiet", url: "https://airport-quiet.example/sub", lastAttempt: NOW - HOUR }],
    NOW - HOUR,
  );
  const env = envOf(db);
  const { calls, result } = await withFetch((url) => {
    if (url.startsWith("https://due.example/api/ext/v1/subscriptions")) {
      return jsonResponse({
        success: true,
        data: [{ id: "sub-due", name: "到期机场", enabled: true, url: "https://airport-due.example/sub", nodeCount: 1 }],
        meta: { total: 1, page: 1, pageSize: 200 },
      });
    }
    if (url.startsWith("https://due.example/api/ext/v1/")) return jsonResponse(EMPTY_LIST);
    if (url === "https://airport-due.example/sub") return textResponse(NODE_BODY);
    return textResponse("unexpected", 500);
  }, () => runMisubSweep(env, NOW));
  const dueCalls = calls.filter((url) => url.startsWith("https://due.example/") || url.startsWith("https://airport-due.example/"));
  const otherCalls = calls.filter((url) => !dueCalls.includes(url));
  eq("② 只拉到期连接", otherCalls, []);
  eq("② 列表三次", count(calls, "https://due.example/api/ext/v1/"), 3);
  eq("② 机场一次", count(calls, "https://airport-due.example/"), 1);
  eq("② 出站次数", calls.length, 4);
  eq("② sweep 统计", result, { lists: 1, fetched: 1, failed: 0 });
  console.log("sweep② outbound=" + calls.length + " other=" + otherCalls.length);
}

// ③ 间隔 6，列表和订阅都在一小时前拉过，不到 6 小时。
{
  const db = makeD1();
  const row = connection({ id: "c-wait", base_url: "https://wait.example", auto_interval_hours: 6 });
  await putConnections(db, [row]);
  await putSnapshot(
    db,
    "c-wait",
    [{ id: "sub-wait", url: "https://airport-wait.example/sub", lastAttempt: NOW - HOUR }],
    NOW - HOUR,
  );
  const { calls, result } = await withFetch(
    () => textResponse("should-not-be-called"),
    () => runMisubSweep(envOf(db), NOW),
  );
  eq("③ 出站次数", calls.length, 0);
  eq("③ sweep 统计", result, { lists: 0, fetched: 0, failed: 0 });
  console.log("sweep③ outbound=" + calls.length);
}

// ④ 连接间隔 6 且列表未到期。interval_hours=0 的订阅不拉，跟随连接且到期的照拉。
{
  const db = makeD1();
  const row = connection({ id: "c-mix", base_url: "https://mix.example", auto_interval_hours: 6 });
  await putConnections(db, [row]);
  await putSnapshot(
    db,
    "c-mix",
    [
      { id: "sub-never", name: "单独关闭", url: "https://airport-skip.example/sub", interval: 0 },
      { id: "sub-due", name: "跟随且到期", url: "https://airport-keep.example/sub" },
      { id: "sub-fresh", name: "跟随未到期", url: "https://airport-fresh.example/sub", lastAttempt: NOW - HOUR },
    ],
    NOW - HOUR,
  );
  const env = envOf(db);
  const view = await readMisubView(env, "c-mix");
  const stateOf = Object.fromEntries(view.snapshot.subscriptions.map((sub) => [sub.id, sub.effective_interval_hours]));
  eq("④ 关闭订阅有效间隔", stateOf["sub-never"], 0);
  eq("④ 跟随订阅有效间隔", stateOf["sub-due"], 6);
  const { calls, result } = await withFetch((url) => {
    if (url === "https://airport-keep.example/sub") return textResponse(NODE_BODY);
    return textResponse("unexpected", 500);
  }, () => runMisubSweep(env, NOW));
  eq("④ 关闭订阅出站", count(calls, "https://airport-skip.example/"), 0);
  eq("④ 未到期订阅出站", count(calls, "https://airport-fresh.example/"), 0);
  eq("④ 列表出站", count(calls, "https://mix.example/"), 0);
  eq("④ 到期订阅出站", count(calls, "https://airport-keep.example/"), 1);
  eq("④ 出站次数", calls.length, 1);
  eq("④ sweep 统计", result, { lists: 0, fetched: 1, failed: 0 });
  console.log("sweep④ skipped=0 kept=" + count(calls, "https://airport-keep.example/") + " outbound=" + calls.length);
}

console.log(`misub-sweep vectors: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
