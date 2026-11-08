// WebDAV 目标：PROPFIND 测活（顺带确认远程目录、缺了就 MKCOL 建出来），
// 备份时把同一棵目录树打成 zip，用 PUT 上传成带时间戳的单个文件。
//
// 选择 zip + store（不压缩）：Workers 只有 CompressionStream(gzip)，没有 zip
// 写入器也没有 deflate 打包器；store 模式让 zip 结构合法、可被任何解压工具
// 打开，代价只是体积大一点。备份包本身是 JSON 文本，服务器端 gzip 传输仍能
// 压，所以这个取舍对网盘场景可接受（见 backup-zip.ts 注释）。

import { BackupError, basicAuth, fetchWithTimeout, formatBytes, upstreamError } from "./backup-net";

export interface WebdavConfig {
  baseUrl: string;
  username: string;
  password: string;
  remoteDir: string;
}

export interface WebdavProbe {
  path: string;
  status: number;
  created: boolean;
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>';

export function webdavBaseUrl(config: WebdavConfig): string {
  return config.baseUrl.replace(/\/+$/g, "") + "/";
}

export function webdavRemoteUrl(config: WebdavConfig, filename = ""): string {
  const base = config.baseUrl.replace(/\/+$/g, "");
  const segments = [...config.remoteDir.split("/"), filename]
    .map((part) => part.trim())
    .filter(Boolean);
  if (segments.length === 0) return base + "/";
  return base + "/" + segments.map((part) => encodeURIComponent(part)).join("/");
}

function authHeaders(config: WebdavConfig): Record<string, string> {
  if (!config.username) return {};
  return { authorization: basicAuth(config.username, config.password) };
}

async function propfind(config: WebdavConfig, url: string): Promise<{ status: number; body: string }> {
  const response = await fetchWithTimeout(url, {
    method: "PROPFIND",
    headers: {
      ...authHeaders(config),
      depth: "0",
      "content-type": "application/xml; charset=utf-8",
    },
    body: PROPFIND_BODY,
  });
  const body = await response.text();
  return { status: response.status, body };
}

function isCollection(body: string): boolean {
  return /<[^>]*:?collection(?::?|\s+|>)/i.test(body);
}

function isDavStatus(status: number): boolean {
  return status === 207 || status === 200;
}

export async function wdProbe(config: WebdavConfig): Promise<WebdavProbe> {
  const base = await propfind(config, webdavBaseUrl(config));
  if (base.status === 401 || base.status === 403) throw new BackupError("WebDAV 用户名或密码不正确", 400);
  if (base.status === 404) throw new BackupError("WebDAV 地址不可达，请检查网盘地址", 400);
  if (!isDavStatus(base.status)) {
    throw new BackupError(upstreamError(base.status, base.body, "WebDAV 服务器拒绝了 PROPFIND"), 502);
  }
  if (!isCollection(base.body)) {
    throw new BackupError("这个地址不是 WebDAV 目录，请填写网盘提供的 WebDAV 根地址", 400);
  }

  if (!config.remoteDir) return { path: "/", status: base.status, created: false };

  const remoteUrl = webdavRemoteUrl(config);
  const remote = await propfind(config, remoteUrl);
  if (isDavStatus(remote.status)) {
    if (!isCollection(remote.body)) throw new BackupError("远程目录路径指向的不是目录，请换一个", 400);
    return { path: "/" + config.remoteDir, status: remote.status, created: false };
  }
  if (remote.status !== 404) {
    throw new BackupError(upstreamError(remote.status, remote.body, "远程目录不可读"), 502);
  }

  // 目录不存在：MKCOL 建出来，免得备份时 PUT 撞 409。
  const create = await fetchWithTimeout(remoteUrl, { method: "MKCOL", headers: authHeaders(config) });
  const createBody = await create.text();
  if (create.status === 201 || create.status === 200) {
    return { path: "/" + config.remoteDir, status: create.status, created: true };
  }
  throw new BackupError(upstreamError(create.status, createBody, "创建远程目录失败"), 502);
}

export function wdProbeDetail(probe: WebdavProbe): string {
  return JSON.stringify({
    path: probe.path,
    status: probe.status,
    created: probe.created,
    protocol: "WebDAV",
  });
}

export interface WebdavUploadResult {
  path: string;
  status: number;
  bytes: number;
}

export async function wdUpload(
  config: WebdavConfig,
  zip: Uint8Array,
  filename: string,
): Promise<WebdavUploadResult> {
  const url = webdavRemoteUrl(config, filename);
  const response = await fetchWithTimeout(
    url,
    {
      method: "PUT",
      headers: {
        ...authHeaders(config),
        "content-type": "application/zip",
        "content-length": String(zip.byteLength),
      },
      body: zip,
    },
    60000,
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new BackupError(upstreamError(response.status, text, "上传到 WebDAV 失败"), 502);
  }
  return { path: "/" + [config.remoteDir, filename].filter(Boolean).join("/"), status: response.status, bytes: zip.byteLength };
}

export function wdUploadDetail(result: WebdavUploadResult): string {
  return JSON.stringify({ path: result.path, status: result.status, bytes: result.bytes, size: formatBytes(result.bytes) });
}

// 文件名用 UTC 时间戳：跨时区也不会重名，且与 manifest 的 exported_at 对齐。
export function backupFileName(at: number): string {
  const date = new Date(at);
  const pad = (value: number, size = 2): string => String(value).padStart(size, "0");
  return (
    "hivemos-backup-" +
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    "-" +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}` +
    ".zip"
  );
}
