export function json(body: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "same-origin");
  return new Response(JSON.stringify(body), { status, headers });
}

export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export function isCrossSite(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  try {
    return origin !== new URL(request.url).origin;
  } catch {
    return true;
  }
}

// SameSite=Lax already withholds the cookie on cross-site POST. Account writes
// also reject Origin: null and any Sec-Fetch-Site other than same-origin or none,
// so a same-site subdomain cannot change the password. Missing Origin stays
// allowed for non-browser clients.
export function rejectsSensitiveWrite(request: Request): boolean {
  if (isCrossSite(request)) return true;
  if (request.headers.get("origin") === "null") return true;
  const site = request.headers.get("sec-fetch-site")?.trim().toLowerCase() ?? "";
  if (!site) return false;
  return site !== "same-origin" && site !== "none";
}

export function clientAddress(request: Request): string | null {
  const value = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  if (!value || value.length > 64 || /[\u0000-\u001f\s]/.test(value)) return null;
  return value;
}

export async function readLimitedBytes(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0 || length > maxBytes) return null;
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readJsonLimited(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
  const bytes = await readLimitedBytes(request, maxBytes);
  if (bytes === null) return { ok: false, status: 413, error: "请求体过大" };
  if (bytes.byteLength === 0) return { ok: false, status: 400, error: "请求体为空" };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { ok: false, status: 400, error: "JSON 无法解析" };
  }
}
