#!/usr/bin/env node
// Pre-deploy guard for HiveMos.
//
// Why this exists: pages.css once shipped with an unclosed @media block
// (one missing "}"). Every rule after it was silently dead on desktop —
// no error anywhere, the page just looked subtly wrong for days. CSS has
// no compiler to catch that, so this script is the compiler:
//
//   1. Every stylesheet under public/css/ is scanned with a small
//      tokenizer (comments and strings are skipped) and must end at
//      brace depth 0 without ever dipping below it.
//   2. Every script under public/ must parse (vm.Script compile check).
//
// Run directly (`node scripts/check.mjs`, extra CSS files may be passed
// as arguments to check them too) or via scripts/deploy.sh, which refuses
// to deploy when the check fails.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const root = new URL("..", import.meta.url).pathname;
let failures = 0;

function checkCss(path) {
  const src = readFileSync(path, "utf8");
  let depth = 0;
  let line = 1;
  let state = "code"; // code | comment | string
  let quote = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1] || "";
    if (ch === "\n") line++;
    if (state === "comment") {
      if (ch === "*" && next === "/") { state = "code"; i++; }
      continue;
    }
    if (state === "string") {
      if (ch === "\\") { i++; continue; }
      if (ch === quote) state = "code";
      continue;
    }
    if (ch === "/" && next === "*") { state = "comment"; i++; continue; }
    if (ch === '"' || ch === "'") { state = "string"; quote = ch; continue; }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth < 0) {
        console.error(`CSS FAIL ${path}: line ${line} closes a block that was never opened`);
        failures++;
        return;
      }
    }
  }
  if (state === "comment") {
    console.error(`CSS FAIL ${path}: unterminated comment`);
    failures++;
  } else if (depth !== 0) {
    console.error(`CSS FAIL ${path}: ${depth} block(s) never closed (brace depth ${depth} at end of file)`);
    failures++;
  } else {
    console.log(`CSS ok ${path}`);
  }
}

function checkJs(path) {
  const src = readFileSync(path, "utf8");
  try {
    new vm.Script(src, { filename: path });
    console.log(`JS ok ${path}`);
  } catch (err) {
    console.error(`JS FAIL ${path}: ${err.message}`);
    failures++;
  }
}

const cssDir = join(root, "public", "css");
for (const name of readdirSync(cssDir).filter((n) => n.endsWith(".css")).sort()) {
  checkCss(join(cssDir, name));
}
for (const extra of process.argv.slice(2)) checkCss(extra);

const publicDir = join(root, "public");
for (const name of readdirSync(publicDir).filter((n) => n.endsWith(".js")).sort()) {
  checkJs(join(publicDir, name));
}

if (failures > 0) {
  console.error(`\ncheck failed: ${failures} problem(s) — deploy blocked`);
  process.exit(1);
}
console.log("\ncheck passed");
