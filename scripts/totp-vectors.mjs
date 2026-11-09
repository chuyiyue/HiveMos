#!/usr/bin/env node
// RFC 6238 / RFC 4226 官方测试向量：跑 src/totp.ts 的 hotp/totpCounter。
//
//   /data/workspace/node24/bin/node scripts/totp-vectors.mjs
//   （普通 node ≥ 23 也行：类型剥离默认开启）
//
// 盒子上的源码用无扩展名的相对 import（`./auth`），这是 Worker 打包器的习惯，
// 直接 import 到 Node 会 ERR_MODULE_NOT_FOUND。这里在进程内注册一个解析钩子，
// 只对解析失败的相对说明符补 `.ts` / `/index.ts`，不改动源码本身。
//
// 全过时以 0 退出并打印计数；任一条不符以 1 退出，方便接进 CI。

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

const { base32Decode, base32Encode, hotp, matchTotp, normalizeBase32, totpCounter } = await import(
  "../src/totp.ts"
);

const utf8 = (value) => new TextEncoder().encode(value);

// RFC 6238 附录 B：三种 HMAC 各自的密钥（长度不同）。
const SEEDS = {
  SHA1: utf8("12345678901234567890"),
  SHA256: utf8("12345678901234567890123456789012"),
  SHA512: utf8("1234567890123456789012345678901234567890123456789012345678901234"),
};

// [时间戳秒, SHA1 八位码, SHA256 八位码, SHA512 八位码]
const VECTORS = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

let checks = 0;
let failures = 0;

function expect(label, actual, expected) {
  checks += 1;
  // JSON.stringify 也覆盖数组（base32 往返拿字节数组做比较）。
  const shown = JSON.stringify(actual);
  if (shown === JSON.stringify(expected)) {
    console.log(`ok   ${label} = ${shown}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}: got ${shown}, want ${JSON.stringify(expected)}`);
  }
}

for (const [time, sha1, sha256, sha512] of VECTORS) {
  for (const algorithm of ["SHA1", "SHA256", "SHA512"]) {
    const expected = { SHA1: sha1, SHA256: sha256, SHA512: sha512 }[algorithm];
    const counter = totpCounter(time * 1000, 30);
    const code = await hotp(SEEDS[algorithm], counter, 8, algorithm);
    expect(`TOTP ${algorithm} T=${time}`, code, expected);
  }
}

// 判决口径自身也要对得上 RFC 4226 附录 D 的第一条（HOTP 计数 0，6 位）。
expect("HOTP SHA1 counter=0 digits=6", await hotp(SEEDS.SHA1, 0, 6, "SHA1"), "755224");

// base32：编码/解码往返、容错（大小写、空格、横线、缺填充）。
const raw = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef]);
const encoded = base32Encode(raw);
const tolerant = encoded.toLowerCase().replace(/([a-z2-7]{4})(?=[a-z2-7])/g, "$1 -") + "  ====";
expect("base32 编码", encoded, "JBSWY3DPEHPK3PXP");
expect("base32 解码（往返）", [...base32Decode(encoded)], [...raw]);
expect("base32 容错：小写 + 空格 + 横线 + 填充", [...base32Decode(tolerant)], [...raw]);
expect("base32 归一化", normalizeBase32(tolerant), encoded);
expect("base32 拒绝非法字符", base32Decode("JBSWY3D1"), null);
expect("归一化拒绝空值", normalizeBase32(""), null);

// 登录 2FA 的回归口径：调用方不传 algorithm/digits/period，仍走 SHA-1、6 位、
// 30 秒，且 matchTotp 的窗口与防重放（lastCounter）行为不变。
const loginSecret = "JBSWY3DPEHPK3PXP";
const loginNow = 1794096000000;
const loginCounter = totpCounter(loginNow);
expect("登录默认参数 = RFC 4226 第 0 步 6 位", await hotp(SEEDS.SHA1, 0), "755224");
expect(
  "登录默认参数 = 显式 SHA1/6 位/30 秒步长",
  await hotp(base32Decode(loginSecret), loginCounter),
  await hotp(base32Decode(loginSecret), loginCounter, 6, "SHA1"),
);
expect("matchTotp 接受默认码", await matchTotp({ secret: loginSecret, code: await hotp(base32Decode(loginSecret), loginCounter), nowMs: loginNow }), loginCounter);
expect("matchTotp 拒绝旧码（防重放）", await matchTotp({ secret: loginSecret, code: await hotp(base32Decode(loginSecret), loginCounter), nowMs: loginNow, lastCounter: loginCounter }), null);
expect("matchTotp 拒绝错码", await matchTotp({ secret: loginSecret, code: "000000", nowMs: loginNow }), null);

// 取码窗口：period 非 30 秒时步长跟着变。
expect("totpCounter period=60", totpCounter(120 * 1000, 60), 2);
expect("totpCounter 默认 30", totpCounter(61 * 1000), 2);

if (failures > 0) {
  console.error(`\n${failures}/${checks} 条不符`);
  process.exit(1);
}
console.log(`\n全部通过：${checks} 条检查（RFC 6238 附录 B 18 条 + RFC 4226 + base32/步长 + 登录默认行为回归）`);
