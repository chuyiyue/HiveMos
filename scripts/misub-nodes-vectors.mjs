#!/usr/bin/env node
// 机场订阅最小解析的测试向量：跑 src/misub-nodes-parse.ts 与 src/misub.ts 的脱敏函数。
//
//   node scripts/misub-nodes-vectors.mjs   （node ≥ 22.18 / 23：类型剥离默认开启）
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

const parse = await import("../src/misub-nodes-parse.ts");
const misub = await import("../src/misub.ts");

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

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// 单条链接
const vmess = "vmess://" + b64(JSON.stringify({ v: "2", ps: "🇯🇵 日本 01", add: "jp1.example.com", port: "443", id: "x" }));
let n = parse.parseNodeLink(vmess);
eq("vmess name", n.name, "🇯🇵 日本 01");
eq("vmess host", [n.host, n.port, n.protocol], ["jp1.example.com", 443, "vmess"]);

n = parse.parseNodeLink("vless://uuid@hk.example.com:8443?security=tls#%E9%A6%99%E6%B8%AF%2001");
eq("vless", [n.name, n.host, n.port], ["香港 01", "hk.example.com", 8443]);

n = parse.parseNodeLink("trojan://pass@[2001:db8::1]:443#v6");
eq("trojan v6", [n.host, n.port], ["2001:db8::1", 443]);

n = parse.parseNodeLink("ss://" + b64("aes-256-gcm:pw@1.2.3.4:8388") + "#SG%20old");
eq("ss legacy", [n.name, n.host, n.port], ["SG old", "1.2.3.4", 8388]);

n = parse.parseNodeLink("ss://" + b64("aes-128-gcm:pw") + "@us.example.com:1234#US-1");
eq("ss sip002", [n.name, n.host, n.port], ["US-1", "us.example.com", 1234]);

const ssr = "ssr://" + b64("ssr.example.com:9000:origin:aes-256-cfb:plain:" + b64("pw") + "/?remarks=" + b64("台湾 SSR"));
n = parse.parseNodeLink(ssr);
eq("ssr", [n.name, n.host, n.port], ["台湾 SSR", "ssr.example.com", 9000]);

eq("unknown proto", parse.parseNodeLink("foo://bar"), null);
eq("http not a node", parse.parseNodeLink("https://example.com/sub"), null);

// 整份订阅
const lines = [vmess, "vless://u@a.example.com:443#A", "", "garbage", "hy2://p@b.example.com:443#B"].join("\n");
let sub = parse.parseSubscriptionContent(b64(lines));
eq("base64 format", [sub.format, sub.nodes.length], ["base64", 3]);
sub = parse.parseSubscriptionContent(lines);
eq("plain format", [sub.format, sub.nodes.length], ["plain", 3]);
sub = parse.parseSubscriptionContent("<html>nope</html>");
eq("unknown", sub.format, "unknown");

const clash = `port: 7890
proxies:
  - {name: "🇭🇰 HK 01", type: ss, server: hk.example.com, port: 443, cipher: aes-128-gcm, password: x}
  - name: 美国 02
    type: trojan
    server: 5.6.7.8
    port: 8443
    password: y
proxy-groups:
  - name: auto
    type: url-test
`;
sub = parse.parseSubscriptionContent(clash);
eq("clash count", [sub.format, sub.nodes.length], ["clash", 2]);
eq("clash flow", [sub.nodes[0].name, sub.nodes[0].protocol, sub.nodes[0].host, sub.nodes[0].port, sub.nodes[0].link], ["🇭🇰 HK 01", "ss", "hk.example.com", 443, null]);
eq("clash block", [sub.nodes[1].name, sub.nodes[1].protocol, sub.nodes[1].host, sub.nodes[1].port], ["美国 02", "trojan", "5.6.7.8", 8443]);

// 列表项顶格（与 proxies 同列）：块状、行内、混写，后面跟顶层键
const clashFlat = `mixed-port: 7890
proxies:
- name: 洛杉矶 01
  type: vless
  server: la.example.net
  port: 443
  ws-opts:
    path: /x
    headers:
      Host: cdn.example.com
- {name: 日本 02, type: vmess, server: 1.2.3.4, port: 8080, uuid: u}
-
  name: 德国 03
  type: hysteria2
  server: "de.example.org"
  port: '9929'
proxy-groups:
- name: auto
  type: select
rules:
- MATCH,auto
`;
sub = parse.parseSubscriptionContent(clashFlat);
eq("clash flat count", [sub.format, sub.nodes.length], ["clash", 3]);
eq("clash flat block", [sub.nodes[0].name, sub.nodes[0].protocol, sub.nodes[0].host, sub.nodes[0].port], ["洛杉矶 01", "vless", "la.example.net", 443]);
eq("clash flat flow", [sub.nodes[1].name, sub.nodes[1].protocol, sub.nodes[1].host, sub.nodes[1].port], ["日本 02", "vmess", "1.2.3.4", 8080]);
eq("clash flat bare dash", [sub.nodes[2].name, sub.nodes[2].protocol, sub.nodes[2].host, sub.nodes[2].port], ["德国 03", "hysteria2", "de.example.org", 9929]);

// 单个节点、CRLF、引号键、跨行的行内写法
const clashOne = 'proxies:\r\n- { "name": "JP Skyline", "type": "ss",\r\n    "server": "jp.example.com", "port": 443 }\r\nrules:\r\n- MATCH,DIRECT\r\n';
sub = parse.parseSubscriptionContent(clashOne);
eq("clash single multiline flow", [sub.format, sub.nodes.map((n) => [n.name, n.protocol, n.host, n.port])], ["clash", [["JP Skyline", "ss", "jp.example.com", 443]]]);

// 缩进写法里嵌套的 name/server 不能当成新节点或覆盖已有字段
const clashNested = `proxies:
    - name: A
      type: vmess
      server: a.example.com
      port: 1
      ws-opts:
        headers:
          name: not-a-node
    - name: B
      type: trojan
      server: b.example.com
      port: 2
`;
sub = parse.parseSubscriptionContent(clashNested);
eq("clash nested", sub.nodes.map((n) => [n.name, n.host]), [["A", "a.example.com"], ["B", "b.example.com"]]);

// userinfo
eq("userinfo", parse.parseUserInfoHeader("upload=1; download=2; total=1073741824; expire=1790000000"), { upload: 1, download: 2, total: 1073741824, expire: 1790000000 });
eq("userinfo none", parse.parseUserInfoHeader(""), null);

// 地区
eq("flag", parse.detectRegion("🇸🇬 Singapore 01"), "SG");
eq("flag uk", parse.detectRegion("🇬🇧 London"), "GB");
eq("zh", parse.detectRegion("日本东京 IPLC"), "JP");
eq("code", parse.detectRegion("HK-02 | x2"), "HK");
eq("code boundary", parse.detectRegion("PLUS 节点"), "");
eq("indonesia before india", parse.detectRegion("印度尼西亚 01"), "ID");
eq("india", parse.detectRegion("印度 01"), "IN");
eq("US word", parse.detectRegion("US 洛杉矶"), "US");
eq("none", parse.detectRegion("剩余流量：100GB"), "");

// 订阅地址脱敏
eq("mask sub url", misub.maskSubscriptionUrl("https://sub.airport.example.com/api/v1/client/subscribe?token=abcdef"), "https://su***.airport.example.com/••••");
eq("mask sub url bad", misub.maskSubscriptionUrl("not a url"), "••••");

console.log(`misub-nodes vectors: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
