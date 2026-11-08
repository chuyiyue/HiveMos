// GitHub 目标：仓库配置的活体测试 + 一次提交上传整棵目录树。
//
// 上传走 Git Trees API，不逐文件刷 contents API：
//   1. GET  /git/ref/heads/{branch}      取当前提交
//   2. GET  /git/commits/{sha}           取 base tree
//   3. POST /git/trees                   一次带上全部文件内容（base_tree 保留仓库里其它文件）
//   4. POST /git/commits                 一个提交
//   5. PATCH /git/refs/heads/{branch}    移动分支
// 因此一次备份 = 一个 commit，提交信息带时间与条数。

import { BackupError, fetchWithTimeout, upstreamError } from "./backup-net";

export interface GithubConfig {
  owner: string;
  repo: string;
  branch: string;
  pathPrefix: string;
  token: string;
}

export interface GithubProbe {
  visibility: "public" | "private";
  default_branch: string;
  branch: string;
  can_push: boolean;
}

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";

function repoPath(config: GithubConfig): string {
  return `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
}

function refPath(config: GithubConfig): string {
  const branch = config.branch
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${repoPath(config)}/git/ref/heads/${branch}`;
}

function headers(config: GithubConfig): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${config.token}`,
    "x-github-api-version": API_VERSION,
    "user-agent": "HiveMos-Backup",
  };
}

async function githubJson(config: GithubConfig, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetchWithTimeout(`${API}${path}`, {
    ...init,
    headers: {
      ...headers(config),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401) throw new BackupError("GitHub 拒绝了访问令牌，请检查令牌与过期时间", 400);
    if (response.status === 404) {
      throw new BackupError(
        "仓库或分支不可达，请检查仓库是否存在、令牌是否有该仓库的访问权限",
        400,
      );
    }
    throw new BackupError(upstreamError(response.status, text, "GitHub 接口返回错误"), 502);
  }
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BackupError("GitHub 返回的内容不是 JSON", 502);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function ghProbe(config: GithubConfig): Promise<GithubProbe> {
  if (!config.owner || !config.repo) throw new BackupError("请填写仓库的 owner 与 repo", 400);
  if (!config.token) throw new BackupError("请填写访问令牌", 400);

  const repo = asRecord(await githubJson(config, repoPath(config)));
  if (repo["archived"] === true) throw new BackupError("这个仓库已归档，不能再写入", 400);
  const permissions = asRecord(repo["permissions"]);
  if (Object.keys(permissions).length > 0 && permissions["push"] !== true) {
    throw new BackupError("令牌对该仓库没有推送权限，请换一个可写的令牌", 403);
  }

  // 分支必须已经存在：v1 不替用户建分支，免得把默认分支指错。
  await githubJson(config, refPath(config));

  return {
    visibility: repo["private"] === true ? "private" : "public",
    default_branch: typeof repo["default_branch"] === "string" ? repo["default_branch"] : "",
    branch: config.branch,
    can_push: true,
  };
}

export function ghProbeDetail(probe: GithubProbe): string {
  const visibility = probe.visibility === "private" ? "私有" : "公开";
  return `仓库可达（${visibility}），分支 ${probe.branch} 存在，令牌可推送`;
}

function joinRepoPath(prefix: string, path: string): string {
  const clean = prefix
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
  return clean ? `${clean}/${path}` : path;
}

interface FileInput {
  path: string;
  text: string;
}

export interface GithubUploadResult {
  commit: string;
  files: number;
}

export async function ghUpload(
  config: GithubConfig,
  files: FileInput[],
  message: string,
): Promise<GithubUploadResult> {
  const ref = asRecord(await githubJson(config, refPath(config)));
  const headSha = typeof asRecord(ref["object"])["sha"] === "string" ? (asRecord(ref["object"])["sha"] as string) : "";
  if (!headSha) throw new BackupError("读不到分支当前的提交，无法建立父子关系", 502);

  const commit = asRecord(await githubJson(config, `${repoPath(config)}/git/commits/${headSha}`));
  const baseTree = typeof asRecord(commit["tree"])["sha"] === "string" ? (asRecord(commit["tree"])["sha"] as string) : "";

  const tree = files.map((file) => ({
    path: joinRepoPath(config.pathPrefix, file.path),
    mode: "100644",
    type: "blob",
    content: file.text,
  }));

  const createdTree = asRecord(
    await githubJson(config, `${repoPath(config)}/git/trees`, {
      method: "POST",
      body: JSON.stringify(baseTree ? { base_tree: baseTree, tree } : { tree }),
    }),
  );
  const treeSha = typeof createdTree["sha"] === "string" ? (createdTree["sha"] as string) : "";
  if (!treeSha) throw new BackupError("GitHub 没有返回新的 tree，上传中止", 502);

  const createdCommit = asRecord(
    await githubJson(config, `${repoPath(config)}/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message, tree: treeSha, parents: [headSha] }),
    }),
  );
  const commitSha = typeof createdCommit["sha"] === "string" ? (createdCommit["sha"] as string) : "";
  if (!commitSha) throw new BackupError("GitHub 没有返回新的 commit，上传中止", 502);

  await githubJson(config, `${repoPath(config)}/git/refs/heads/${config.branch
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commitSha }),
  });

  return { commit: commitSha, files: files.length };
}
