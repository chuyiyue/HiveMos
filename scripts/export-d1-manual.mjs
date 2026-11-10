#!/usr/bin/env node
// Manual full dump of the hivemos D1 database (schema + data as SQL),
// used because `wrangler d1 export` refuses databases containing FTS5
// virtual tables. Builds INSERT statements server-side with quote() so
// values are escaped exactly (text, numbers, NULLs, blobs as X'..').
//
// Usage: node scripts/export-d1-manual.mjs <output.sql>
// Requires CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID in the env and
// npx wrangler on PATH. Output includes, per virtual (FTS) table, its
// CREATE statement plus a trailing rebuild statement so a restore
// regenerates the index from the restored base data.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const out = process.argv[2];
if (!out) {
  console.error("usage: export-d1-manual.mjs <output.sql>");
  process.exit(1);
}

function q(sql) {
  const raw = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "hivemos", "--remote", "--json", "--command", sql],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
  );
  const parsed = JSON.parse(raw);
  return parsed[0].results;
}

const schemaRows = q(
  "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name != 'sqlite_sequence' " +
    "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END, name"
);
const virtualTables = new Set(
  schemaRows
    .filter((r) => r.type === "table" && /^CREATE VIRTUAL TABLE/i.test(r.sql))
    .map((r) => r.name)
);
const dataTables = schemaRows.filter((r) => r.type === "table" && !virtualTables.has(r.name));

const lines = [];
lines.push("-- HiveMos D1 full export (manual dump; wrangler d1 export cannot handle FTS5)");
lines.push("-- Database: hivemos (6c07d734-ca39-41ea-ba81-2a392e4abdf2)");
lines.push("PRAGMA foreign_keys=OFF;");
lines.push("BEGIN TRANSACTION;");

for (const r of schemaRows) lines.push(r.sql + ";");

const counts = {};
for (const t of dataTables) {
  const cols = q(`SELECT name FROM pragma_table_info('${t.name.replaceAll("'", "''")}') ORDER BY cid`).map(
    (c) => c.name
  );
  if (!cols.length) continue;
  const expr = cols.map((c) => `quote("${c.replaceAll('"', '""')}")`).join(" || ',' || ");
  const rows = q(
    `SELECT 'INSERT INTO "${t.name.replaceAll('"', '""')}" VALUES(' || ${expr} || ');' AS line FROM "${t.name.replaceAll('"', '""')}"`
  );
  counts[t.name] = rows.length;
  for (const r of rows) lines.push(r.line);
}

// AUTOINCREMENT high-water marks, if the table exists.
const seqExists = q("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'");
if (seqExists.length) {
  const rows = q(
    "SELECT 'INSERT OR REPLACE INTO sqlite_sequence VALUES(' || quote(name) || ',' || quote(seq) || ');' AS line FROM sqlite_sequence"
  );
  for (const r of rows) lines.push(r.line);
}

for (const vt of virtualTables) {
  lines.push(`INSERT INTO "${vt}"("${vt}") VALUES('rebuild');`);
}
lines.push("COMMIT;");

writeFileSync(out, lines.join("\n") + "\n");
console.log(JSON.stringify({ tables: schemaRows.filter((r) => r.type === "table").length, counts }, null, 1));
