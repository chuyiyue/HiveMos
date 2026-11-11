// 机场订阅原文的最小解析（纯函数，便于单测）。
//
// 只取展示需要的四样：节点名、协议、服务器 host:port、地区；不解析加密方式、
// 密码、传输参数，也不做测活。原始链接只在 Worker 内存里过一遍，列表接口
// 只回脱敏后的服务器文本，明文链接只走 reveal 一条路（先审计）。
//
// 支持三种常见形态：
//   1. base64 包着的一行一条节点链接（v2rayN 口径，绝大多数机场对 v2rayN UA 回这个）
//   2. 不包 base64 的明文链接列表
//   3. Clash YAML 的 proxies 段（行内 {name: …} 与块状两种写法都认）；这种
//      形态没有原始链接，只能展示，不能复制。

export const SUPPORTED_NODE_PROTOCOLS = [
  "ss",
  "ssr",
  "vmess",
  "vless",
  "trojan",
  "hysteria",
  "hysteria2",
  "hy",
  "hy2",
  "tuic",
  "anytls",
  "socks5",
  "socks",
  "snell",
  "naive+https",
  "naive+quic",
  "naive+http",
  "wireguard",
  "http",
  "https",
] as const;

const LINK_PROTOCOLS = new Set<string>(SUPPORTED_NODE_PROTOCOLS.filter((p) => p !== "http" && p !== "https"));

export const MAX_NODES_PER_SUBSCRIPTION = 3000;

export interface ParsedNode {
  name: string;
  protocol: string;
  host: string;
  port: number | null;
  // 原始节点链接；Clash YAML 来源为 null（没有可复制的链接）。
  link: string | null;
}

export interface ParsedSubscription {
  format: "base64" | "plain" | "clash" | "unknown";
  nodes: ParsedNode[];
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// base64 / 文本工具

function b64ToBytes(input: string): Uint8Array | null {
  const normalized = input.trim().replace(/\s+/g, "").replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/g, "");
  if (!normalized || /[^A-Za-z0-9+/]/.test(normalized)) return null;
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function decodeBase64Text(input: string): string | null {
  const bytes = b64ToBytes(input);
  if (!bytes) return null;
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

function safeDecodeURIComponent(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, "%20"));
  } catch {
    return text;
  }
}

function validPort(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

function stripBrackets(host: string): string {
  return host.replace(/^\[/, "").replace(/\]$/, "");
}

// ---------------------------------------------------------------------------
// 单条链接

export function protocolOf(link: string): string {
  const m = /^([a-z0-9+]+):\/\//i.exec(link.trim());
  return m && m[1] ? m[1].toLowerCase() : "";
}

function hostPortFromAuthority(authority: string): { host: string; port: number | null } {
  const at = authority.lastIndexOf("@");
  const hp = at >= 0 ? authority.slice(at + 1) : authority;
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(hp);
  if (v6 && v6[1]) return { host: v6[1], port: validPort(v6[2]) };
  const colon = hp.lastIndexOf(":");
  if (colon > 0) return { host: hp.slice(0, colon), port: validPort(hp.slice(colon + 1)) };
  return { host: hp, port: null };
}

// 解析一条节点链接；不认识的协议或坏链接返回 null。
export function parseNodeLink(rawLink: string): ParsedNode | null {
  const link = rawLink.trim();
  const protocol = protocolOf(link);
  if (!protocol || !LINK_PROTOCOLS.has(protocol)) return null;
  const body = link.slice(link.indexOf("://") + 3);

  if (protocol === "vmess") {
    const payload = body.split(/[?#]/)[0] ?? "";
    const text = decodeBase64Text(payload);
    if (text) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const host = typeof parsed["add"] === "string" ? parsed["add"].trim() : "";
        const name = typeof parsed["ps"] === "string" ? parsed["ps"] : "";
        return { name: name.trim(), protocol, host: stripBrackets(host), port: validPort(parsed["port"]), link };
      } catch {
        // 落到下面的通用处理
      }
    }
    const hashAt = body.indexOf("#");
    return { name: hashAt >= 0 ? safeDecodeURIComponent(body.slice(hashAt + 1)).trim() : "", protocol, host: "", port: null, link };
  }

  if (protocol === "ssr") {
    // ssr://base64(host:port:protocol:method:obfs:base64pass/?remarks=base64&…)
    const text = decodeBase64Text(body.split("#")[0] ?? "") ?? "";
    const [main = "", query = ""] = text.split("/?");
    const parts = main.split(":");
    let host = "";
    let port: number | null = null;
    if (parts.length >= 6) {
      port = validPort(parts[parts.length - 5]);
      host = parts.slice(0, parts.length - 5).join(":");
    }
    let name = "";
    const remarks = /(?:^|&)remarks=([^&]*)/.exec(query);
    if (remarks && remarks[1]) name = decodeBase64Text(remarks[1]) ?? "";
    return { name: name.trim(), protocol, host: stripBrackets(host), port, link };
  }

  const hashAt = body.indexOf("#");
  const name = hashAt >= 0 ? safeDecodeURIComponent(body.slice(hashAt + 1)).trim() : "";
  const beforeHash = hashAt >= 0 ? body.slice(0, hashAt) : body;
  const authority = (beforeHash.split(/[/?]/)[0] ?? "").trim();

  if (protocol === "ss" && !authority.includes("@")) {
    // SIP002 之前的老写法：ss://base64(method:password@host:port)#name
    const text = decodeBase64Text(authority);
    if (text && text.includes("@")) {
      const hp = hostPortFromAuthority(text.trim());
      return { name, protocol, host: stripBrackets(hp.host), port: hp.port, link };
    }
  }

  const hp = hostPortFromAuthority(authority);
  return { name, protocol, host: stripBrackets(hp.host), port: hp.port, link };
}

// ---------------------------------------------------------------------------
// Clash YAML（只认 proxies 段里的 name / type / server / port）

function yamlScalar(raw: string): string {
  let text = raw.trim();
  // 去掉行尾注释（引号外的 " #"）
  if (!/^["']/.test(text)) {
    const hash = text.indexOf(" #");
    if (hash >= 0) text = text.slice(0, hash).trim();
  }
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  return text;
}

function flowField(flow: string, key: string): string {
  const re = new RegExp("(?:^|[{,])\\s*[\"']?" + key + "[\"']?\\s*:\\s*(\"[^\"]*\"|'[^']*'|[^,}]*)");
  const m = re.exec(flow);
  return m && m[1] !== undefined ? yamlScalar(m[1]) : "";
}

export function parseClashProxies(text: string): ParsedNode[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^proxies\s*:/.test(l));
  if (start < 0) return [];
  const nodes: ParsedNode[] = [];
  let current: Record<string, string> | null = null;
  let itemIndent = -1;
  const flush = () => {
    if (current && (current["name"] || current["server"])) {
      nodes.push({
        name: (current["name"] ?? "").trim(),
        protocol: (current["type"] ?? "").toLowerCase(),
        host: stripBrackets(current["server"] ?? ""),
        port: validPort(current["port"]),
        link: null,
      });
    }
    current = null;
  };
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim() || /^\s*#/.test(line)) continue;
    // 下一个顶层键才结束；YAML 允许列表项与 proxies 同列（「- name: …」顶格写），那不算结束
    if (/^\S/.test(line) && !/^-(?:\s|$)/.test(line)) break;
    const item = /^(\s*)-(?:\s+(.*))?$/.exec(line);
    if (item && (itemIndent < 0 || (item[1] ?? "").length <= itemIndent)) {
      flush();
      itemIndent = (item[1] ?? "").length;
      let rest = (item[2] ?? "").trim();
      current = {};
      if (rest.startsWith("{")) {
        // 行内写法可能跨多行：拼到右花括号为止
        while (!rest.includes("}") && i + 1 < lines.length) rest += " " + (lines[++i] ?? "").trim();
        for (const key of ["name", "type", "server", "port"]) current[key] = flowField(rest, key);
        flush();
        if (nodes.length >= MAX_NODES_PER_SUBSCRIPTION) break;
        continue;
      }
      const kv = /^["']?([A-Za-z0-9_-]+)["']?\s*:\s*(.*)$/.exec(rest);
      if (kv && kv[1]) current[kv[1]] = yamlScalar(kv[2] ?? "");
      continue;
    }
    if (current) {
      const kv = /^\s+["']?([A-Za-z0-9_-]+)["']?\s*:\s*(.*)$/.exec(line);
      if (kv && kv[1] && ["name", "type", "server", "port"].includes(kv[1]) && current[kv[1]] === undefined) {
        current[kv[1]] = yamlScalar(kv[2] ?? "");
      }
    }
    if (nodes.length >= MAX_NODES_PER_SUBSCRIPTION) break;
  }
  flush();
  return nodes;
}

// ---------------------------------------------------------------------------
// 整份订阅

function parseLinkLines(text: string): { nodes: ParsedNode[]; truncated: boolean } {
  const nodes: ParsedNode[] = [];
  let truncated = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const node = parseNodeLink(trimmed);
    if (!node) continue;
    if (nodes.length >= MAX_NODES_PER_SUBSCRIPTION) {
      truncated = true;
      break;
    }
    nodes.push(node);
  }
  return { nodes, truncated };
}

export function parseSubscriptionContent(raw: string): ParsedSubscription {
  const text = (typeof raw === "string" ? raw : "").replace(/^\uFEFF/, "").trim();
  if (!text) return { format: "unknown", nodes: [], truncated: false };
  if (/^proxies\s*:/m.test(text)) {
    const nodes = parseClashProxies(text);
    return { format: "clash", nodes: nodes.slice(0, MAX_NODES_PER_SUBSCRIPTION), truncated: nodes.length > MAX_NODES_PER_SUBSCRIPTION };
  }
  if (!text.includes("://")) {
    const decoded = decodeBase64Text(text);
    if (decoded && decoded.includes("://")) {
      const { nodes, truncated } = parseLinkLines(decoded);
      return { format: "base64", nodes, truncated };
    }
    return { format: "unknown", nodes: [], truncated: false };
  }
  const { nodes, truncated } = parseLinkLines(text);
  return { format: nodes.length ? "plain" : "unknown", nodes, truncated };
}

// subscription-userinfo: upload=1; download=2; total=3; expire=4
export function parseUserInfoHeader(
  value: string | null,
): { upload: number; download: number; total: number; expire: number | null } | null {
  if (!value) return null;
  const out: Record<string, number> = {};
  for (const part of value.split(";")) {
    const m = /^\s*([a-z]+)\s*=\s*([0-9.eE+]+)\s*$/i.exec(part);
    if (m && m[1] && m[2]) {
      const n = Number(m[2]);
      if (Number.isFinite(n) && n >= 0) out[m[1].toLowerCase()] = Math.floor(n);
    }
  }
  if (!("upload" in out) && !("download" in out) && !("total" in out) && !("expire" in out)) return null;
  return {
    upload: out["upload"] ?? 0,
    download: out["download"] ?? 0,
    total: out["total"] ?? 0,
    expire: out["expire"] && out["expire"] > 0 ? out["expire"] : null,
  };
}

// ---------------------------------------------------------------------------
// 地区：先认节点名里的旗帜 emoji，再认中英文关键词；都认不出返回空串。

const REGION_KEYWORDS: Array<[string, string[], string[]]> = [
  // [ISO 代码, 中文/长英文关键词（包含即命中）, 需要词边界的短英文代码]
  ["HK", ["香港", "港", "hong kong", "hongkong"], ["HK", "HKG"]],
  ["MO", ["澳门", "澳門", "macau", "macao"], ["MO"]],
  ["TW", ["台湾", "台灣", "臺灣", "台北", "taiwan", "taipei"], ["TW", "TWN"]],
  ["JP", ["日本", "东京", "東京", "大阪", "japan", "tokyo", "osaka"], ["JP", "JPN"]],
  ["SG", ["新加坡", "狮城", "獅城", "singapore"], ["SG", "SGP"]],
  ["KR", ["韩国", "韓國", "首尔", "首爾", "korea", "seoul"], ["KR", "KOR"]],
  ["US", ["美国", "美國", "洛杉矶", "硅谷", "圣何塞", "西雅图", "纽约", "芝加哥", "达拉斯", "united states", "america", "los angeles", "san jose", "seattle", "new york"], ["US", "USA"]],
  ["GB", ["英国", "英國", "伦敦", "united kingdom", "britain", "london"], ["UK", "GB", "GBR"]],
  ["DE", ["德国", "德國", "法兰克福", "germany", "frankfurt"], ["DE", "DEU"]],
  ["FR", ["法国", "法國", "巴黎", "france", "paris"], ["FR", "FRA"]],
  ["NL", ["荷兰", "荷蘭", "阿姆斯特丹", "netherlands", "amsterdam"], ["NL", "NLD"]],
  ["CA", ["加拿大", "canada", "toronto"], ["CA", "CAN"]],
  ["AU", ["澳大利亚", "澳洲", "悉尼", "australia", "sydney"], ["AU", "AUS"]],
  ["RU", ["俄罗斯", "俄羅斯", "莫斯科", "russia", "moscow"], ["RU", "RUS"]],
  ["ID", ["印度尼西亚", "印尼", "雅加达", "indonesia", "jakarta"], []],
  ["IN", ["印度", "孟买", "india", "mumbai"], []],
  ["TR", ["土耳其", "turkey", "türkiye", "istanbul"], ["TR"]],
  ["MY", ["马来西亚", "馬來西亞", "吉隆坡", "malaysia"], ["MY"]],
  ["TH", ["泰国", "泰國", "曼谷", "thailand", "bangkok"], ["TH"]],
  ["VN", ["越南", "vietnam"], ["VN"]],
  ["PH", ["菲律宾", "菲律賓", "philippines", "manila"], ["PH"]],
  ["AE", ["阿联酋", "迪拜", "dubai", "emirates"], ["UAE"]],
  ["AR", ["阿根廷", "argentina"], []],
  ["BR", ["巴西", "brazil"], []],
  ["MX", ["墨西哥", "mexico"], []],
  ["IT", ["意大利", "italy", "milan"], []],
  ["ES", ["西班牙", "spain", "madrid"], []],
  ["CH", ["瑞士", "switzerland", "zurich"], []],
  ["SE", ["瑞典", "sweden", "stockholm"], []],
  ["IE", ["爱尔兰", "愛爾蘭", "ireland", "dublin"], []],
  ["PL", ["波兰", "poland", "warsaw"], []],
  ["IL", ["以色列", "israel"], []],
  ["ZA", ["南非", "south africa"], []],
  ["CN", ["中国", "回国", "china"], ["CN"]],
];

export function detectRegion(name: string): string {
  const text = typeof name === "string" ? name : "";
  if (!text) return "";
  const chars = Array.from(text);
  for (let i = 0; i + 1 < chars.length; i++) {
    const a = chars[i]!.codePointAt(0) ?? 0;
    const b = chars[i + 1]!.codePointAt(0) ?? 0;
    if (a >= 0x1f1e6 && a <= 0x1f1ff && b >= 0x1f1e6 && b <= 0x1f1ff) {
      const code = String.fromCharCode(65 + a - 0x1f1e6) + String.fromCharCode(65 + b - 0x1f1e6);
      return code === "UK" ? "GB" : code;
    }
  }
  const lower = text.toLowerCase();
  // 「港」单字太宽，放到最后兜底，避免「港」误伤其它地区的长关键词。
  for (const [code, words, codes] of REGION_KEYWORDS) {
    for (const w of words) if (w.length > 1 && lower.includes(w)) return code;
    for (const c of codes) {
      if (new RegExp("(^|[^A-Za-z0-9])" + c + "(?=[^A-Za-z]|$)").test(text)) return code;
    }
  }
  if (text.includes("港")) return "HK";
  return "";
}
