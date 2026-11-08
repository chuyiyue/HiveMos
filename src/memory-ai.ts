// 记忆的 Workers AI 入口：面板自然语言保存时一次调用完成拆分 + 打标；
// 已落库的条目（面板直存或 MCP 写入）事后补打标。AI 是地基不是门槛：
// 拆分不可用/超时/不可解析时，保存退化为整段一条（ai_state=failed），
// 绝不因 AI 失败丢掉用户要存的内容。模型口径与注册表打标一致：
// AI_MODEL 变量可配，缺省 gemma-4-26b-a4b-it，只输出 JSON、解析容错。

import { readChatResponse, resolveAiModel } from "./ai-model";
import type { Env } from "./env";
import { prepare } from "./registry";
import {
  MemError,
  applyAiTags,
  createMemory,
  getMemoryRow,
  parseTags,
  type MemoryRow,
} from "./memory";

const AI_TIMEOUT_MS = 20000;
const INGEST_TEXT_MAX = 20000;
const POINT_CONTENT_MAX = 2000;
const MAX_POINTS = 50;
const TITLE_MAX_CHARS = 60;

interface Channel {
  actor: string;
  source: string;
  auditReads: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("failed"));
      },
    );
  });
}

async function runAi(env: Env, system: string, user: string, maxTokens: number): Promise<string | null> {
  if (!env.AI || typeof env.AI.run !== "function") return null;
  try {
    const output = await withTimeout(
      env.AI.run(resolveAiModel(env), {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: maxTokens,
      }),
      AI_TIMEOUT_MS,
    );
    return readChatResponse(output);
  } catch {
    return null;
  }
}

// 标签清洗与注册表 AI 打标同口径：折叠空白、单个不超过 32 字、
// 大小写不敏感去重、上限截断。
function cleanAiTags(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const tag = item.trim().replace(/\s+/g, " ");
    if (!tag || tag.length > 32) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= limit) break;
  }
  return tags;
}

function stripFenceAndSlice(text: string, open: string, close: string): string | null {
  let raw = text.trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) raw = fenced[1].trim();
  const start = raw.indexOf(open);
  const end = raw.lastIndexOf(close);
  if (start === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

export interface SplitPoint {
  content: string;
  tags: string[];
}

// 解析拆分结果：容错去围栏、截取 JSON 数组；元素不合规就跳过，
// 全部不可用返回 null（调用方据此退化整段保存）。
export function parseSplitPayload(text: string | null): SplitPoint[] | null {
  if (!text) return null;
  const slice = stripFenceAndSlice(text, "[", "]");
  if (!slice) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const points: SplitPoint[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rawContent = (item as { content?: unknown }).content;
    if (typeof rawContent !== "string") continue;
    const content = rawContent.trim().replace(/\s+/g, " ");
    if (!content) continue;
    points.push({
      content: content.slice(0, POINT_CONTENT_MAX),
      tags: cleanAiTags((item as { tags?: unknown }).tags, 6),
    });
    if (points.length >= MAX_POINTS) break;
  }
  return points.length > 0 ? points : null;
}

export function parseTagsPayload(text: string | null): string[] | null {
  if (!text) return null;
  const slice = stripFenceAndSlice(text, "{", "}");
  if (!slice) return null;
  let parsed: { tags?: unknown };
  try {
    parsed = JSON.parse(slice) as { tags?: unknown };
  } catch {
    return null;
  }
  const tags = cleanAiTags(parsed.tags, 6);
  return tags.length > 0 ? tags : null;
}

const SPLIT_SYSTEM =
  "你负责把用户的一段话拆成独立的记忆点，并给每个记忆点打标签。你只输出一个 JSON 数组，不要输出其他文字。数组元素格式为 {\"content\":\"一个记忆点\",\"tags\":[\"标签\"]}。拆分规则：一个独立事实或偏好算一个记忆点，content 用一句简洁陈述完整转述这个事实，保留原意，不要增删或推测原文没有的信息，不要合并多个事实；tags 给每个记忆点 1 到 4 个中文短标签";

const TAG_SYSTEM =
  "你负责给一条记忆打标签。你只输出一个 JSON 对象，不要输出其他文字。格式为 {\"tags\":[\"标签\"]}，给 1 到 4 个中文短标签，概括这条记忆的主题";

export async function splitAndTag(env: Env, text: string): Promise<SplitPoint[] | null> {
  // 输入太长时截断喂给 AI 的部分（落库退化路径仍存全文）
  const feed = text.length > 8000 ? text.slice(0, 8000) : text;
  const raw = await runAi(env, SPLIT_SYSTEM, feed, 1600);
  return parseSplitPayload(raw);
}

export async function suggestTags(env: Env, title: string, content: string): Promise<string[] | null> {
  const user = "标题：" + title + "\n内容：" + (content || "").slice(0, 1200);
  const raw = await runAi(env, TAG_SYSTEM, user, 300);
  return parseTagsPayload(raw);
}

function deriveTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return (flat.slice(0, TITLE_MAX_CHARS) || "未命名记忆").trim();
}

// 同作用域同名唯一：拆分点或重复保存撞标题时加序号后缀重试，
// 不让整批 ingest 因一条冲突失败。
async function insertPoint(
  db: Env["DB"],
  base: Record<string, unknown>,
  channel: Channel,
  now: number,
): Promise<MemoryRow> {
  const original = typeof base.title === "string" ? base.title : "未命名记忆";
  let title = original;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await createMemory(db, { ...base, title }, channel, now);
    } catch (error) {
      if (error instanceof MemError && error.status === 409) {
        title = original.slice(0, TITLE_MAX_CHARS - 4) + "（" + (attempt + 2) + "）";
        continue;
      }
      throw error;
    }
  }
  throw new MemError("同名记忆过多，请改短内容后重试", 409);
}

export interface IngestResult {
  split: boolean;
  memories: MemoryRow[];
}

// 面板自然语言保存：先尝试 AI 拆分，成功逐点落库（ai_state=split）；
// 任何一步不可用都退化为整段一条（ai_state=failed），保证先存下来。
export async function ingestMemories(
  env: Env,
  input: Record<string, unknown>,
  channel: Channel,
  now: number,
): Promise<IngestResult> {
  if (typeof input.text !== "string" || !input.text.trim()) throw new MemError("请填写要保存的内容");
  const text = input.text.trim();
  if (text.length > INGEST_TEXT_MAX) throw new MemError("内容过长，请分段保存");
  const base: Record<string, unknown> = { scope: input.scope, group_id: input.group_id };
  const points = await splitAndTag(env, text);
  if (points && points.length > 0) {
    const rows: MemoryRow[] = [];
    for (const point of points) {
      rows.push(
        await insertPoint(
          env.DB,
          { ...base, title: deriveTitle(point.content), content: point.content, tags: point.tags, ai_state: "split" },
          channel,
          now,
        ),
      );
    }
    return { split: true, memories: rows };
  }
  const row = await insertPoint(
    env.DB,
    { ...base, title: deriveTitle(text), content: text, tags: [], ai_state: "failed" },
    channel,
    now,
  );
  return { split: false, memories: [row] };
}

// 单条补打标：成功才落库；AI 不可用抛 502 让面板明确提示，状态不动。
export async function tagOneMemory(env: Env, id: string, channel: Channel, now: number): Promise<MemoryRow> {
  const row = await getMemoryRow(env.DB, id);
  if (!row) throw new MemError("记忆不存在或已删除", 404);
  const tags = await suggestTags(env, row.title, row.content);
  if (!tags) throw new MemError("AI 暂不可用，未能打标签", 502);
  return applyAiTags(env.DB, id, tags, channel, now);
}

// 批量补标：只处理未打标签且未经 AI 成功处理的条目（none / failed），
// 逐条调用、逐条计数，单条失败不影响其余。
export async function tagUntaggedMemories(
  env: Env,
  limitInput: unknown,
  channel: Channel,
  now: number,
): Promise<{ scanned: number; tagged: number; failed: number }> {
  let limit = 20;
  if (typeof limitInput === "number" && Number.isFinite(limitInput)) {
    limit = Math.min(50, Math.max(1, Math.floor(limitInput)));
  }
  const result = await prepare(
    env.DB,
    "SELECT * FROM memories WHERE deleted_at IS NULL AND ai_state IN ('none', 'failed') AND (tags_json IS NULL OR tags_json = '' OR tags_json = '[]') ORDER BY updated_at DESC LIMIT ?",
    [limit],
  ).all<MemoryRow>();
  const rows = Array.isArray(result) ? result : (result.results ?? []);
  let tagged = 0;
  let failed = 0;
  for (const row of rows as MemoryRow[]) {
    if (parseTags(row.tags_json).length > 0) continue;
    const tags = await suggestTags(env, row.title, row.content);
    if (!tags) {
      failed++;
      continue;
    }
    try {
      await applyAiTags(env.DB, row.id, tags, channel, Date.now());
      tagged++;
    } catch {
      failed++;
    }
  }
  void now;
  return { scanned: (rows as MemoryRow[]).length, tagged, failed };
}
