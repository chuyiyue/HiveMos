// OAuth 的纯工具函数：令牌生成、PKCE、redirect URI 校验。
// 不碰数据库、不引 Worker 专属模块，scripts/oauth-vectors.mjs 可以直接
// 用 node 的类型剥离导入这里跑断言。

import { base64UrlToBytes, bytesToBase64Url, secretsEqual, sha256Hex } from "./auth";

export const ACCESS_TOKEN_PREFIX = "hvm_oat_";
export const REFRESH_TOKEN_PREFIX = "hvm_ort_";
export const AUTH_CODE_PREFIX = "hvm_oac_";

// 高熵随机凭据：32 字节 base64url，与 Agent 令牌同一强度。
export function randomOAuthSecret(prefix: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return prefix + bytesToBase64Url(bytes);
}

export function newOAuthId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return prefix + hex;
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

// PKCE S256：challenge = BASE64URL(SHA256(verifier))。
export async function pkceChallengeFor(verifier: string): Promise<string> {
  return sha256Base64Url(verifier);
}

// RFC 7636：verifier 是 43–128 个非保留字符。格式不对直接判负，不进比对。
export function isValidCodeVerifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

export function isValidCodeChallenge(value: string): boolean {
  // SHA-256 的 base64url 恒为 43 字符。
  return /^[A-Za-z0-9_-]{43}$/.test(value) && base64UrlToBytes(value) !== null;
}

export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(challenge)) return false;
  const computed = await pkceChallengeFor(verifier);
  return secretsEqual(computed, challenge);
}

// redirect URI 的准入（注册时）：只允许 https；http 仅限回环地址的本地
// 开发回调。不许 fragment（授权码会走 query 回跳，fragment 会把参数藏进
// 客户端不可见区）、不许通配与内嵌凭据。授权时再与注册值逐字精确比对。
export function isAllowedRedirectUri(raw: string): boolean {
  if (!raw || raw.length > 2048 || raw.includes("*")) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") {
    const host = url.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  }
  return false;
}

