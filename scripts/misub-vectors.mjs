#!/usr/bin/env node
// MiSub 纯函数的测试向量：src/misub-region.ts 的地区识别。
//
//   node scripts/misub-vectors.mjs   （node ≥ 22.18 / 23：类型剥离默认开启）
//
// 与 totp-vectors.mjs 同口径：进程内注册解析钩子，给无扩展名的相对 import 补 `.ts`。

import { register } from "node:module";

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

const region = await import("../src/misub-region.ts");

let pass = 0;
let fail = 0;
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else {
    fail++;
    console.error("FAIL " + label + "\n  got      " + a + "\n  expected " + e);
  }
}

// 地区
eq("flag", region.detectRegion("🇸🇬 Singapore 01"), "SG");
eq("flag uk", region.detectRegion("🇬🇧 London"), "GB");
eq("zh", region.detectRegion("日本东京 IPLC"), "JP");
eq("code", region.detectRegion("HK-02 | x2"), "HK");
eq("code boundary", region.detectRegion("PLUS 节点"), "");
eq("indonesia before india", region.detectRegion("印度尼西亚 01"), "ID");
eq("india", region.detectRegion("印度 01"), "IN");
eq("US word", region.detectRegion("US 洛杉矶"), "US");
eq("none", region.detectRegion("剩余流量：100GB"), "");

console.log(`misub vectors: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
