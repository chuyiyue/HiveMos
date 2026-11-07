// Password and session-token helpers, ported from SMSinBox src/auth.ts.
// The cookie value is the raw token. Callers persist only sha256Hex(token).

export const SESSION_COOKIE = "hivemos_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

// 10_000 PBKDF2-SHA256 iterations stay inside the Workers Free 10ms CPU budget.
// Raise this only on a paid plan with a higher cpu_ms limit.
export const PBKDF2_ITERATIONS = 10_000;

const HASH_PREFIX = "pbkdf2-sha256";

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function" && left.byteLength === right.byteLength) {
    return subtle.timingSafeEqual(left, right);
  }
  const length = Math.max(left.byteLength, right.byteLength);
  let diff = left.byteLength === right.byteLength ? 0 : 1;
  for (let index = 0; index < length; index += 1) {
    const leftByte = index < left.byteLength ? left[index]! : 0;
    const rightByte = index < right.byteLength ? right[index]! : 0;
    diff |= leftByte ^ rightByte;
  }
  return diff === 0;
}

export async function secretsEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  return equalBytes(new Uint8Array(leftHash), new Uint8Array(rightHash));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `hvm_${bytesToBase64Url(bytes)}`;
}

export function requestIsSecure(request: Request): boolean {
  if (new URL(request.url).protocol === "https:") return true;
  const forwarded = request.headers.get("x-forwarded-proto");
  return forwarded?.split(",")[0]?.trim() === "https";
}

export function sessionCookieHeader(token: string, secure: boolean, maxAgeSeconds: number): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `${HASH_PREFIX}$${PBKDF2_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  const iterations = parsed?.iterations ?? PBKDF2_ITERATIONS;
  const salt = parsed?.salt ?? new Uint8Array(16);
  const expected = parsed?.hash ?? new Uint8Array(32);
  const actual = await pbkdf2(password, salt, iterations);
  return parsed !== null && equalBytes(actual, expected);
}

function parseStoredHash(stored: string): { iterations: number; salt: Uint8Array; hash: Uint8Array } | null {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== HASH_PREFIX) return null;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000_000) return null;
  const salt = base64UrlToBytes(parts[2] ?? "");
  const hash = base64UrlToBytes(parts[3] ?? "");
  if (!salt || !hash || salt.byteLength < 8 || hash.byteLength !== 32) return null;
  return { iterations, salt, hash };
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: copyBytes(salt), iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export function copyBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
