#!/usr/bin/env node
// MiSub 自动同步下放到各连接：未设置间隔 = 关闭，sweep 零出站。
// 针对现行「只同步 MiSub API」架构（misub-store 只同步连接快照，无订阅级拉取）：
//
//   node scripts/misub-sweep-vectors.mjs
//
// 用可计数的假 fetch 覆盖：
//   ① 连接未设间隔：sweep 出站 0
//   ② 间隔 6 且到期：只同步该连接，未设间隔的连接不出站
//   ③ 间隔 6 未到期：出站 0

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
const { runMisubSweep } = await import("../src/misub-store.ts");
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
}

async function putSnapshotRow(db, connId, lastAttempt) {
  await db
    .prepare(
      "INSERT INTO misub_snapshots (connection_id, data_json, secrets_enc, synced_at, last_attempt_at, last_ok, last_error, manual_at) VALUES (?, '', '', ?, ?, 1, '', NULL)",
    )
    .bind(connId, lastAttempt, lastAttempt)
    .run();
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
const EMPTY_LIST = { success: true, data: [], meta: { total: 0, page: 1, pageSize: 200 } };

async function withFetch(fn) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input && input.url ? input.url : input);
    calls.push(url);
    return jsonResponse(EMPTY_LIST);
  };
  try {
    return { calls, result: await fn() };
  } finally {
    globalThis.fetch = previous;
  }
}

eq("有效间隔 缺失", effectiveAutoIntervalHours(undefined), 0);
eq("有效间隔 null", effectiveAutoIntervalHours(null), 0);
eq("有效间隔 0", effectiveAutoIntervalHours(0), 0);
eq("有效间隔 已存 6", effectiveAutoIntervalHours(6), 6);
eq("有效间隔 字符串", effectiveAutoIntervalHours("6"), 0);
eq("有效间隔 越界", effectiveAutoIntervalHours(200), 0);

// 已存明确数值保持原样；缺字段的连接读出来是 0，并且不把默认值写回库。
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

// ① 连接未设间隔、从没同步过：旧逻辑会按 6 小时立刻出站，现行必须零出站。
{
  const db = makeD1();
  await putConnections(db, [connection({ id: "c-unset", base_url: "https://unset.example" })]);
  const env = envOf(db);
  const { calls, result } = await withFetch(() => runMisubSweep(env, NOW));
  eq("① sweep 同步数", result, 0);
  eq("① 出站次数", calls.length, 0);
}

// ② 间隔 6 且从没同步过（到期）的连接被同步；同场未设间隔的连接零出站。
{
  const db = makeD1();
  await putConnections(db, [
    connection({ id: "c-due", base_url: "https://due.example", auto_interval_hours: 6 }),
    connection({ id: "c-unset", base_url: "https://unset.example" }),
  ]);
  const env = envOf(db);
  const { calls, result } = await withFetch(() => runMisubSweep(env, NOW));
  eq("② sweep 同步数", result, 1);
  eq("② 全部出站只去到期连接", calls.length > 0 && calls.every((u) => u.startsWith("https://due.example/")), true);
  eq("② 出站端点数", calls.length, 3);
}

// ③ 间隔 6 但上次尝试在 1 小时前（未到期）：零出站。
{
  const db = makeD1();
  await putConnections(db, [
    connection({ id: "c-quiet", base_url: "https://quiet.example", auto_interval_hours: 6 }),
  ]);
  await putSnapshotRow(db, "c-quiet", NOW - 1 * HOUR);
  const env = envOf(db);
  const { calls, result } = await withFetch(() => runMisubSweep(env, NOW));
  eq("③ sweep 同步数", result, 0);
  eq("③ 出站次数", calls.length, 0);
}

console.log(`\nmisub-sweep vectors: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
