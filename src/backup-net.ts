// 备份目标共用的网络小工具：带超时的 fetch、错误类型、base64 编码与
// 末四位摘要。GitHub 与 WebDAV 两个模块都从这里取，避免各自复制一份。

export class BackupError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export const BACKUP_TIMEOUT_MS = 20000;

// AbortController + 定时器：Workers 的 fetch 没有默认超时，外部存储卡住时
// 不能让整个请求一直悬着。
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = BACKUP_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new BackupError("连接超时，请检查地址与网络", 504);
    throw new BackupError("连接失败：" + (error instanceof Error ? error.message : String(error)), 502);
  } finally {
    clearTimeout(timer);
  }
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// 手写 base64（不依赖 btoa/atob），对非 ASCII 的用户名与密码也正确。
export function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : null;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : null;
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === null ? "=" : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === null ? "=" : BASE64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function basicAuth(username: string, password: string): string {
  return "Basic " + base64Utf8(`${username}:${password}`);
}

export function tailOf(secret: string): string {
  return Array.from(secret).slice(-4).join("");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// 上游返回的 JSON 或文本里取一句人类可读的话，供面板显示。
export function upstreamError(status: number, body: string, fallback: string): string {
  let detail = "";
  try {
    const data = JSON.parse(body) as unknown;
    if (data && typeof data === "object") {
      const record = data as Record<string, unknown>;
      if (typeof record["message"] === "string") detail = record["message"];
      else if (typeof record["error"] === "string") detail = record["error"];
      else if (record["error"] && typeof record["error"] === "object") {
        const inner = record["error"] as Record<string, unknown>;
        if (typeof inner["message"] === "string") detail = inner["message"];
      }
    }
  } catch {
    detail = body.slice(0, 200).trim();
  }
  const head = `${fallback}（HTTP ${status}）`;
  return detail ? `${head}：${detail}` : head;
}
