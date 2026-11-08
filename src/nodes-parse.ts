// 订阅正文与粘贴内容的解析器。不访问网络、不落库。
//
// 支持的链接：vless、vmess（base64 JSON 与旧式 method:uuid@host:port）、
// trojan、ss（SIP002 与旧式整段 base64）、hysteria2（含 hy2://）、tuic。
// 解析失败的行计入 skipped，不让整批失败。空行与整行注释不计数。
//
// Clash YAML 子集见 YAML_SUBSET_BOUNDARY。

export const YAML_SUBSET_BOUNDARY =
  "只读取顶层 proxies 列表。每个节点提取 name、type、server、port，原始片段原样保留。" +
  "支持缩进块，以及单行或跨行的花括号对象。不解析锚点与别名、合并键、多文档、块标量、proxy-providers，也不读取嵌套字段";

export interface ParsedNode {
  name: string;
  protocol: string;
  server: string;
  port: number;
  /** 原始链接或该节点在 YAML 里的片段，含凭据，调用方密封后落库。 */
  raw: string;
  /** 凭据材料，只参与 dedupe 哈希，不单独落库。 */
  secret: string;
}

export interface ParseResult {
  nodes: ParsedNode[];
  skipped: number;
  format: "empty" | "lines" | "base64" | "yaml" | "base64-yaml";
}

const NAME_MAX = 200;
const SECRET_KEYS = ["password", "uuid", "id", "auth", "token", "cipher"];

export function parseNodeText(input: string): ParseResult {
  const text = normalizeNewlines(input).trim();
  if (!text) return { nodes: [], skipped: 0, format: "empty" };
  const unwrapped = unwrapBase64Document(text);
  const body = unwrapped ?? text;
  if (isClashYaml(body)) {
    const yaml = parseClashProxies(body);
    return { nodes: yaml.nodes, skipped: yaml.skipped, format: unwrapped ? "base64-yaml" : "yaml" };
  }
  const lines = parseLinkLines(body);
  return { nodes: lines.nodes, skipped: lines.skipped, format: unwrapped ? "base64" : "lines" };
}

function parseLinkLines(text: string): { nodes: ParsedNode[]; skipped: number } {
  const nodes: ParsedNode[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    const scheme = schemeOf(trimmed);
    if (!scheme) {
      skipped++;
      continue;
    }
    const node = parseLink(trimmed, scheme);
    if (node) nodes.push(node);
    else skipped++;
  }
  return { nodes, skipped };
}

function parseLink(line: string, scheme: string): ParsedNode | null {
  if (scheme === "vmess") return parseVmess(line);
  if (scheme === "ss") return parseSs(line);
  if (scheme === "vless") return parseUserinfoProtocol(line, "vless", "vless");
  if (scheme === "trojan") return parseUserinfoProtocol(line, "trojan", "trojan");
  if (scheme === "hysteria2" || scheme === "hy2") return parseHysteria2(line, scheme);
  if (scheme === "tuic") return parseTuic(line);
  return null;
}

function parseUserinfoProtocol(line: string, scheme: string, protocol: string): ParsedNode | null {
  const parts = splitShareLink(line, scheme);
  if (!parts || !parts.userinfo) return null;
  const secret = safeDecode(parts.userinfo);
  if (!secret) return null;
  const name = linkName(parts.fragment, parts.query, parts.host, parts.port);
  return { name, protocol, server: parts.host, port: parts.port, raw: line, secret };
}

function parseHysteria2(line: string, scheme: string): ParsedNode | null {
  const parts = splitShareLink(line, scheme);
  if (!parts) return null;
  const params = queryParams(parts.query);
  const secret = safeDecode(parts.userinfo) || params.get("auth") || params.get("password") || "";
  if (!secret) return null;
  const name = linkName(parts.fragment, parts.query, parts.host, parts.port);
  return { name, protocol: "hysteria2", server: parts.host, port: parts.port, raw: line, secret };
}

function parseTuic(line: string): ParsedNode | null {
  const parts = splitShareLink(line, "tuic");
  if (!parts || !parts.userinfo) return null;
  const user = safeDecode(parts.userinfo);
  const colon = user.indexOf(":");
  const uuid = colon >= 0 ? user.slice(0, colon) : user;
  let password = colon >= 0 ? user.slice(colon + 1) : "";
  const params = queryParams(parts.query);
  if (!password) password = params.get("password") || params.get("token") || "";
  if (!uuid) return null;
  const secret = password ? `${uuid}:${password}` : uuid;
  const name = linkName(parts.fragment, parts.query, parts.host, parts.port);
  return { name, protocol: "tuic", server: parts.host, port: parts.port, raw: line, secret };
}

function parseVmess(line: string): ParsedNode | null {
  const rest = line.slice("vmess://".length);
  const hashAt = rest.indexOf("#");
  const fragment = hashAt >= 0 ? rest.slice(hashAt + 1) : "";
  let main = hashAt >= 0 ? rest.slice(0, hashAt) : rest;
  const queryAt = main.indexOf("?");
  const query = queryAt >= 0 ? main.slice(queryAt + 1) : "";
  if (queryAt >= 0) main = main.slice(0, queryAt);

  // 新式：vmess://uuid@host:port?...#name，userinfo 里没有再套一层 base64。
  if (main.includes("@")) {
    const decodedUser = tryDecodeUserinfo(main.slice(0, main.indexOf("@")));
    if (decodedUser && !decodedUser.includes("@") && !decodedUser.startsWith("{")) {
      const parts = splitShareLink(line, "vmess");
      if (parts && parts.userinfo) {
        const secret = safeDecode(parts.userinfo);
        if (secret && parts.host) {
          return {
            name: linkName(parts.fragment, parts.query, parts.host, parts.port),
            protocol: "vmess",
            server: parts.host,
            port: parts.port,
            raw: line,
            secret,
          };
        }
      }
    }
  }

  const decoded = decodeBase64Utf8(main);
  if (!decoded) return null;
  const text = decoded.trim();
  if (text.startsWith("{")) return vmessFromJson(text, line);
  return vmessFromLegacy(text, line, fragment, query);
}

function tryDecodeUserinfo(userinfo: string): string | null {
  const decoded = decodeBase64Utf8(userinfo);
  if (!decoded) return null;
  if (decoded.includes("\u0000")) return null;
  return decoded;
}

function vmessFromJson(text: string, raw: string): ParsedNode | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const server = scalar(obj.add ?? obj.addr ?? obj.host ?? obj.server);
  const port = Number(scalar(obj.port));
  const secret = scalar(obj.id ?? obj.uuid);
  if (!validServer(server) || !validPort(port) || !secret) return null;
  const named = scalar(obj.ps ?? obj.remarks ?? obj.name);
  return {
    name: clipName(named || fallbackName(server, port)),
    protocol: "vmess",
    server,
    port,
    raw,
    secret,
  };
}

function vmessFromLegacy(text: string, raw: string, fragment: string, query: string): ParsedNode | null {
  const split = splitUserAndHost(text.trim());
  if (!split) return null;
  const colon = split.user.indexOf(":");
  const secret = (colon >= 0 ? split.user.slice(colon + 1) : split.user).trim();
  if (!secret) return null;
  return {
    name: linkName(fragment, query, split.host, split.port),
    protocol: "vmess",
    server: split.host,
    port: split.port,
    raw,
    secret,
  };
}

function parseSs(line: string): ParsedNode | null {
  const restAll = line.slice("ss://".length);
  const hashAt = restAll.indexOf("#");
  const fragment = hashAt >= 0 ? restAll.slice(hashAt + 1) : "";
  let body = hashAt >= 0 ? restAll.slice(0, hashAt) : restAll;
  const queryAt = body.indexOf("?");
  if (queryAt >= 0) body = body.slice(0, queryAt);

  if (body.includes("@")) {
    const at = body.lastIndexOf("@");
    const userinfo = body.slice(0, at);
    const hostport = body.slice(at + 1);
    const hp = splitHostPort(safeDecode(hostport));
    if (!hp) return null;
    const methodPass = ssMethodPassword(userinfo);
    if (!methodPass) return null;
    return {
      name: linkName(fragment, "", hp.host, hp.port),
      protocol: "ss",
      server: hp.host,
      port: hp.port,
      raw: line,
      secret: methodPass,
    };
  }

  const decoded = decodeBase64Utf8(body);
  if (!decoded) return null;
  const split = splitUserAndHost(decoded.trim());
  if (!split) return null;
  const methodPass = splitMethodPassword(split.user);
  if (!methodPass) return null;
  return {
    name: linkName(fragment, "", split.host, split.port),
    protocol: "ss",
    server: split.host,
    port: split.port,
    raw: line,
    secret: methodPass,
  };
}

function ssMethodPassword(userinfo: string): string | null {
  const decoded = decodeBase64Utf8(safeDecode(userinfo).replace(/ /g, "+"));
  if (decoded) {
    const pair = splitMethodPassword(decoded.trim());
    if (pair) return pair;
  }
  return splitMethodPassword(safeDecode(userinfo));
}

function splitMethodPassword(value: string): string | null {
  const colon = value.indexOf(":");
  if (colon <= 0 || colon === value.length - 1) return null;
  const method = value.slice(0, colon).trim();
  const password = value.slice(colon + 1);
  if (!/^[A-Za-z0-9_.:-]+$/.test(method) || !password) return null;
  return `${method}:${password}`;
}

interface ShareParts {
  userinfo: string;
  host: string;
  port: number;
  query: string;
  fragment: string;
}

function splitShareLink(line: string, scheme: string): ShareParts | null {
  const prefix = `${scheme}://`;
  if (line.slice(0, prefix.length).toLowerCase() !== prefix) return null;
  let rest = line.slice(prefix.length);
  const hashAt = rest.indexOf("#");
  const fragment = hashAt >= 0 ? rest.slice(hashAt + 1) : "";
  if (hashAt >= 0) rest = rest.slice(0, hashAt);
  const queryAt = rest.indexOf("?");
  const query = queryAt >= 0 ? rest.slice(queryAt + 1) : "";
  if (queryAt >= 0) rest = rest.slice(0, queryAt);
  const split = splitUserAndHost(rest);
  if (!split) return null;
  return { userinfo: split.user, host: split.host, port: split.port, query, fragment };
}

function splitUserAndHost(text: string): { user: string; host: string; port: number } | null {
  let at = text.lastIndexOf("@");
  while (at > 0) {
    const hp = splitHostPort(safeDecode(text.slice(at + 1)));
    if (hp) return { user: text.slice(0, at), host: hp.host, port: hp.port };
    at = text.lastIndexOf("@", at - 1);
  }
  return null;
}

function splitHostPort(hostport: string): { host: string; port: number } | null {
  const text = hostport.trim();
  if (!text) return null;
  let host = "";
  let portText = "";
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end <= 1) return null;
    host = text.slice(1, end);
    if (!text.slice(end + 1).startsWith(":")) return null;
    portText = text.slice(end + 2);
  } else {
    const colon = text.lastIndexOf(":");
    if (colon <= 0) return null;
    host = text.slice(0, colon);
    portText = text.slice(colon + 1);
  }
  host = safeDecode(host).trim();
  const port = Number(portText.trim());
  if (!validServer(host) || !validPort(port)) return null;
  return { host, port };
}

function linkName(fragment: string, query: string, host: string, port: number): string {
  const fromFragment = safeDecode(fragment).trim();
  if (fromFragment) return clipName(fromFragment);
  const params = queryParams(query);
  const remark = (params.get("remarks") || params.get("remark") || params.get("ps") || "").trim();
  if (remark) return clipName(remark);
  return fallbackName(host, port);
}

function queryParams(query: string): URLSearchParams {
  try {
    return new URLSearchParams(query);
  } catch {
    return new URLSearchParams();
  }
}

// ---- Clash YAML 子集 -------------------------------------------------------

function isClashYaml(text: string): boolean {
  return /(^|\n)[ \t]*proxies[ \t]*:/.test(text);
}

function parseClashProxies(text: string): { nodes: ParsedNode[]; skipped: number } {
  const lines = text.split("\n");
  let proxiesAt = -1;
  let baseIndent = 0;
  let inline = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([ \t]*)proxies[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    proxiesAt = i;
    baseIndent = (match[1] ?? "").length;
    inline = stripYamlComment((match[2] ?? "").trim());
    break;
  }
  if (proxiesAt < 0) return { nodes: [], skipped: 0 };
  if (inline.startsWith("[")) {
    const collected = collectFlowList(lines, proxiesAt, inline);
    return parseFlowSequence(collected);
  }
  if (inline) return { nodes: [], skipped: 1 };

  const nodes: ParsedNode[] = [];
  let skipped = 0;
  let i = proxiesAt + 1;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }
    const indent = leadingIndent(line);
    if (indent <= baseIndent) break;
    if (!trimmed.startsWith("-")) {
      i++;
      continue;
    }
    const itemIndent = indent;
    const item = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i] ?? "";
      const nextTrim = next.trim();
      if (!nextTrim) {
        item.push(next);
        i++;
        continue;
      }
      const nextIndent = leadingIndent(next);
      if (nextIndent <= baseIndent) break;
      if (nextIndent <= itemIndent && nextTrim.startsWith("-")) break;
      if (nextIndent < itemIndent) break;
      item.push(next);
      i++;
    }
    const raw = item.join("\n").trim();
    const node = proxyFromRaw(raw);
    if (node) nodes.push(node);
    else skipped++;
  }
  return { nodes, skipped };
}

function collectFlowList(lines: string[], start: number, firstRemainder: string): string {
  let blob = firstRemainder;
  let depth = bracketDepth(firstRemainder);
  if (depth > 0) {
    for (let i = start + 1; i < lines.length && depth > 0; i++) {
      const line = lines[i] ?? "";
      blob += `\n${line}`;
      depth += bracketDepth(line);
    }
  }
  const open = blob.indexOf("[");
  const close = blob.lastIndexOf("]");
  if (open >= 0 && close > open) return blob.slice(open + 1, close);
  return blob.replace(/^\[/, "").replace(/\]$/, "");
}

function bracketDepth(text: string): number {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
  }
  return depth;
}

function parseFlowSequence(body: string): { nodes: ParsedNode[]; skipped: number } {
  const nodes: ParsedNode[] = [];
  let skipped = 0;
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i] ?? "")) i++;
    if (i >= body.length) break;
    if (body[i] !== "{") {
      skipped++;
      break;
    }
    const end = skipGroup(body, i);
    if (end < 0) {
      skipped++;
      break;
    }
    const raw = body.slice(i, end).trim();
    const node = nodeFromMap(parseFlowMap(body.slice(i + 1, end - 1)), raw);
    if (node) nodes.push(node);
    else skipped++;
    i = end;
  }
  return { nodes, skipped };
}

function proxyFromRaw(raw: string): ParsedNode | null {
  const trimmed = raw.trim();
  const flow = /^-\s*\{([\s\S]*)\}\s*$/.exec(trimmed);
  if (flow) return nodeFromMap(parseFlowMap(flow[1] ?? ""), trimmed);
  return nodeFromMap(parseBlockMap(raw), trimmed);
}

function parseBlockMap(raw: string): Record<string, string> {
  const lines = raw.split("\n");
  const map: Record<string, string> = {};
  let keyIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = i === 0 ? line.replace(/^\s*-\s*/, "").trim() : line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = i === 0 ? 0 : leadingIndent(line);
    if (i > 0) {
      if (keyIndent < 0) keyIndent = indent;
      if (indent !== keyIndent) continue;
    }
    const pair = splitKv(trimmed);
    if (!pair) continue;
    if (map[pair[0]] === undefined) map[pair[0]] = pair[1];
  }
  return map;
}

function parseFlowMap(body: string): Record<string, string> {
  const map: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i] ?? "")) i++;
    if (i >= body.length || body[i] === "}") break;
    const keyStart = i;
    while (i < body.length && /[A-Za-z0-9_-]/.test(body[i] ?? "")) i++;
    const key = body.slice(keyStart, i).toLowerCase();
    while (i < body.length && (body[i] === " " || body[i] === "\t")) i++;
    if (!key || body[i] !== ":") break;
    i++;
    while (i < body.length && (body[i] === " " || body[i] === "\t")) i++;
    const read = readFlowValue(body, i);
    i = read.next;
    if (map[key] === undefined) map[key] = read.value;
  }
  return map;
}

function readFlowValue(body: string, start: number): { value: string; next: number } {
  let i = start;
  const ch = body[i] ?? "";
  if (ch === '"' || ch === "'") {
    const quote = ch;
    i++;
    let out = "";
    while (i < body.length) {
      const cur = body[i] ?? "";
      if (quote === "'" && cur === "'" && body[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      if (cur === "\\" && quote === '"') {
        const next = body[i + 1] ?? "";
        if (next === "n") out += "\n";
        else if (next === '"') out += '"';
        else if (next === "\\") out += "\\";
        else out += next;
        i += 2;
        continue;
      }
      if (cur === quote) {
        i++;
        break;
      }
      out += cur;
      i++;
    }
    return { value: out.trim(), next: i };
  }
  if (ch === "{" || ch === "[") {
    const end = skipGroup(body, i);
    return { value: "", next: end < 0 ? body.length : end };
  }
  let out = "";
  while (i < body.length && body[i] !== "," && body[i] !== "}" && body[i] !== "]") {
    out += body[i];
    i++;
  }
  return { value: unquote(stripYamlComment(out.trim())), next: i };
}

function skipGroup(body: string, start: number): number {
  const open = body[start];
  const close = open === "{" ? "}" : open === "[" ? "]" : "";
  if (!close) return -1;
  let depth = 0;
  let quote = "";
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function splitKv(text: string): [string, string] | null {
  const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(text);
  if (!match) return null;
  const key = (match[1] ?? "").toLowerCase();
  const value = unquote(stripYamlComment((match[2] ?? "").trim()));
  if (!key) return null;
  return [key, value];
}

function nodeFromMap(map: Record<string, string>, raw: string): ParsedNode | null {
  const name = (map.name || "").trim();
  const protocol = normalizeProtocol(map.type || "");
  const server = (map.server || "").trim();
  const port = Number((map.port || "").trim());
  if (!name || !protocol || !validServer(server) || !validPort(port)) return null;
  const secret = SECRET_KEYS.map((key) => (map[key] || "").trim()).filter(Boolean).join("|");
  return {
    name: clipName(name),
    protocol,
    server,
    port,
    raw,
    secret: secret || raw,
  };
}

function stripYamlComment(value: string): string {
  let quote = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i++;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || value[i - 1] === " ")) return value.slice(0, i).trim();
  }
  return value.trim();
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

// ---- 文本工具 --------------------------------------------------------------

function unwrapBase64Document(text: string): string | null {
  if (text.includes("://") || isClashYaml(text)) return null;
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 16 || !/^[A-Za-z0-9+/_=-]+$/.test(compact)) return null;
  const decoded = decodeBase64Utf8(compact);
  if (!decoded) return null;
  const body = decoded.trim();
  if (!body || body === text) return null;
  if (body.includes("://") || isClashYaml(body)) return body;
  return null;
}

function decodeBase64Utf8(input: string): string | null {
  let encoded = input.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!encoded || !/^[A-Za-z0-9+/=]+$/.test(encoded)) return null;
  const pad = encoded.length % 4;
  if (pad === 1) return null;
  if (pad) encoded += "=".repeat(4 - pad);
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function schemeOf(line: string): string | null {
  const match = /^([a-z0-9+.-]+):\/\//i.exec(line);
  return match ? (match[1] ?? "").toLowerCase() : null;
}

function normalizeProtocol(type: string): string {
  const value = type.trim().toLowerCase();
  if (value === "hy2" || value === "hysteria2") return "hysteria2";
  return value;
}

function normalizeNewlines(input: string): string {
  return input.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function leadingIndent(line: string): number {
  let count = 0;
  while (count < line.length && (line[count] === " " || line[count] === "\t")) count++;
  return count;
}

function scalar(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function safeDecode(value: string): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function validServer(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (/[\s/?#@\\]/.test(host)) return false;
  return true;
}

function fallbackName(server: string, port: number): string {
  const host = server.includes(":") ? `[${server}]` : server;
  return `${host}:${port}`;
}

function clipName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > NAME_MAX ? trimmed.slice(0, NAME_MAX) : trimmed;
}
