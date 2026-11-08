#!/usr/bin/env node
// Admin alignment for the admin-init design (see
// admin-init-and-binding-design.md). Runs at deploy time, after the
// Worker is deployed, with ADMIN_USERNAME / ADMIN_PASSWORD in the
// environment. Aligns the single administrator row to the secrets:
//   - no row        -> create it (role admin)
//   - username drift -> rename to the secret username (case-insensitive
//                       comparison; the secret's casing wins)
//   - password fails -> replace the hash and clear ALL sessions
//   - all matching  -> write nothing (idempotent)
// Multiple rows are data corruption: refuse (exit 1), write nothing.
// Only the username and password hash are ever touched — never role,
// disabled state, or profile/display fields. Output never contains the
// password or any hash.

import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ITERATIONS = 100_000;
const DB = "hivemos";

const username = process.env.ADMIN_USERNAME ?? "";
const password = process.env.ADMIN_PASSWORD ?? "";
if (!username || !password) {
  console.error("sync-admin: ADMIN_USERNAME and ADMIN_PASSWORD are both required");
  process.exit(1);
}

function b64urlEncode(bytes) {
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function b64urlDecode(text) {
  return new Uint8Array(Buffer.from(text.replaceAll("-", "+").replaceAll("_", "/"), "base64"));
}

async function pbkdf2(pw, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return new Uint8Array(bits);
}

async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(pw, salt, ITERATIONS);
  return `pbkdf2-sha256$${ITERATIONS}$${b64urlEncode(salt)}$${b64urlEncode(hash)}`;
}

async function verifyPassword(pw, stored) {
  const parts = String(stored).split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  const salt = b64urlDecode(parts[2]);
  const expected = b64urlDecode(parts[3]);
  const actual = await pbkdf2(pw, salt, iterations);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

function d1Json(sql) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const start = out.indexOf("[");
  const parsed = JSON.parse(out.slice(start));
  return parsed[0]?.results ?? [];
}

function d1File(statements) {
  const path = join(tmpdir(), `hivemos-sync-admin-${process.pid}.sql`);
  writeFileSync(path, statements.join("\n") + "\n", "utf8");
  try {
    execFileSync("npx", ["wrangler", "d1", "execute", DB, "--remote", "--file", path], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "inherit"],
    });
  } finally {
    unlinkSync(path);
  }
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const rows = d1Json("SELECT id, username, password_hash FROM users");
if (rows.length > 1) {
  console.error(`sync-admin: users table has ${rows.length} rows; refusing to guess the administrator`);
  process.exit(1);
}

if (rows.length === 0) {
  const hash = await hashPassword(password);
  d1File([
    `INSERT INTO users (id, username, password_hash, role, created_at) VALUES (${sqlString(crypto.randomUUID())}, ${sqlString(username)}, ${sqlString(hash)}, 'admin', ${Date.now()});`,
  ]);
  console.log("sync-admin: created");
  process.exit(0);
}

const row = rows[0];
const statements = [];
if (String(row.username).toLowerCase() !== username.toLowerCase()) {
  statements.push(`UPDATE users SET username = ${sqlString(username)} WHERE id = ${sqlString(row.id)};`);
}
const passwordOk = await verifyPassword(password, row.password_hash);
let cleared = false;
if (!passwordOk) {
  const hash = await hashPassword(password);
  statements.push(`UPDATE users SET password_hash = ${sqlString(hash)} WHERE id = ${sqlString(row.id)};`);
  statements.push("DELETE FROM sessions;");
  cleared = true;
}
if (statements.length === 0) {
  console.log("sync-admin: unchanged");
} else {
  d1File(statements);
  console.log(`sync-admin: updated${cleared ? " (sessions cleared)" : ""}`);
}
