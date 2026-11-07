// AES-GCM envelope for TOTP secrets. Ported from SMSinBox src/crypto.ts.
// Message sealing (sealMessage / revealText / revealCode / revealRaw) stays there.

import { base64UrlToBytes, bytesToBase64Url, copyBytes } from "./auth";

export const ENCRYPTED_PREFIX = "enc1:";

export type ContentKey = { state: "off" } | { state: "invalid" } | { state: "on"; raw: Uint8Array };

export function resolveContentKey(value: string | undefined): ContentKey {
  if (!value?.trim()) return { state: "off" };
  const raw = decodeKey(value.trim());
  if (!raw || raw.byteLength !== 32) return { state: "invalid" };
  return { state: "on", raw };
}

// Callers outside message storage (TOTP secrets) reuse the same AES-GCM envelope.
export async function sealString(key: ContentKey, plaintext: string): Promise<string | null> {
  if (key.state !== "on") return null;
  return encryptString(await importKey(key.raw), plaintext);
}

export async function decryptString(rawKey: Uint8Array, stored: string): Promise<string | null> {
  if (!stored.startsWith(ENCRYPTED_PREFIX)) return null;
  const body = stored.slice(ENCRYPTED_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0) return null;
  const iv = base64UrlToBytes(body.slice(0, dot));
  const cipher = base64UrlToBytes(body.slice(dot + 1));
  if (!iv || !cipher || iv.byteLength !== 12 || cipher.byteLength < 16) return null;
  try {
    const aes = await importKey(rawKey);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: copyBytes(iv) }, aes, copyBytes(cipher));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

async function encryptString(aes: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(plaintext));
  return `${ENCRYPTED_PREFIX}${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(cipher))}`;
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", copyBytes(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function decodeKey(value: string): Uint8Array | null {
  const normalized = value.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
  return base64UrlToBytes(normalized);
}
