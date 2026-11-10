// 记忆的 Workers AI 入口。自然语言保存已移出请求路径：ingest 先同步落一条
// ai_state=pending 的原文并立即返回，拆分/打标/摘要由 cron 的
// processPendingMemories 批量补全；AI 不可用或超时时保留 pending，下一轮重试。
// 已落库条目的事后补标仍只给「标签为空」的记忆，已有标签的永不覆盖或补充。
// 模型口径与注册表打标一致：AI_MODEL 变量可配，缺省 gemma-4-26b-a4b-it，
// 只输出 JSON、解析容错。

import { readChatResponse, resolveAiModel } from "./ai-model";
import type { Env } from "./env";
import { prepare } from "./registry";
import {
  MAX_MEMORY_TAGS,
  MemError,
  applyAiTags,
  createMemory,
  deriveMemoryTitle,
  getMemoryRow,
  invalidateMemoryWithAudit,
  listAllActiveMemories,
  listMemoryTagStats,
  listMemoryTags,
  listPendingAiMemories,
  normalizeTagKey,
  parseTags,
  rewriteMemoryTags,
  type MemoryRow,
  type MemoryTagStat,
} from "./memory";

// gemma-4 是推理模型：先吐 reasoning 再给正文，max_tokens 给小了正文为空、
// 调用耗时也长（实测一次拆分约 30 秒），所以额度与超时都按推理模型留足。
const SPLIT_MAX_TOKENS = 4096;
const SPLIT_TIMEOUT_MS = 60000;
const TAG_MAX_TOKENS = 2048;
const TAG_TIMEOUT_MS = 45000;
const MERGE_MAX_TOKENS = 2048;
const MERGE_TIMEOUT_MS = 45000;
const SUMMARY_MAX_TOKENS = 1024;
const SUMMARY_TIMEOUT_MS = 45000;
const TAG_LIMIT = 3;
const MERGE_TAG_LIMIT = 60;
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

async function runAi(
  env: Env,
  system: string,
  user: string,
  maxTokens: number,
  timeoutMs: number,
): Promise<string | null> {
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
      timeoutMs,
    );
    return readChatResponse(output);
  } catch {
    return null;
  }
}

const TAG_NAME_MAX = 32;

// AI 返回标签的唯一 normalize 入口（拆分、单条补标、批量补标共用）：
// trim + 折叠空白；与已有标签库按大小写/空格归一匹配，等价的直接换成
// 库里现有写法；同 key 去重；最后截断到 3 个。超过 32 字的新词丢弃
// （已有标签本身较长时仍按库里的写法保留）。
// 总量硬约束：库已达 MAX_MEMORY_TAGS 时新标签一律丢弃；未达上限时放行新
// 标签，但累计（含同批后续调用）不得越过上限。新标签会写回 existing，
// 让同一次拆分/批量补标共享同一份额度。
export function normalizeAiTags(value: unknown, existing: string[], limit = TAG_LIMIT): string[] {
  if (!Array.isArray(value)) return [];
  const library = new Map<string, string>();
  for (const tag of existing) {
    const key = normalizeTagKey(tag);
    if (key && !library.has(key)) library.set(key, tag.trim().replace(/\s+/g, " "));
  }
  let librarySize = library.size;
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const raw = item.trim().replace(/\s+/g, " ");
    if (!raw) continue;
    const key = normalizeTagKey(raw);
    let canonical = library.get(key);
    if (!canonical) {
      if (librarySize >= MAX_MEMORY_TAGS || raw.length > TAG_NAME_MAX) continue;
      canonical = raw;
      library.set(key, canonical);
      librarySize++;
      existing.push(canonical);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(canonical);
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
export function parseSplitPayload(text: string | null, existing: string[] = []): SplitPoint[] | null {
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
      tags: normalizeAiTags((item as { tags?: unknown }).tags, existing, TAG_LIMIT),
    });
    if (points.length >= MAX_POINTS) break;
  }
  return points.length > 0 ? points : null;
}

export function parseTagsPayload(text: string | null, existing: string[] = []): string[] | null {
  if (!text) return null;
  const slice = stripFenceAndSlice(text, "{", "}");
  if (!slice) return null;
  let parsed: { tags?: unknown };
  try {
    parsed = JSON.parse(slice) as { tags?: unknown };
  } catch {
    return null;
  }
  const tags = normalizeAiTags(parsed.tags, existing, TAG_LIMIT);
  return tags.length > 0 ? tags : null;
}

const SPLIT_SYSTEM =
  "你负责把用户的一段话拆成独立的记忆点，并给每个记忆点打标签。你只输出一个 JSON 数组，不要输出其他文字。数组元素格式为 {\"content\":\"一个记忆点\",\"tags\":[\"标签\"]}。拆分规则：一个独立事实或偏好算一个记忆点，content 用一句简洁陈述完整转述这个事实，保留原意，不要增删或推测原文没有的信息，不要合并多个事实；tags 给每个记忆点 1 到 3 个中文短标签";

const TAG_SYSTEM =
  "你负责给一条记忆打标签。你只输出一个 JSON 对象，不要输出其他文字。格式为 {\"tags\":[\"标签\"]}，给 1 到 3 个中文短标签，概括这条记忆的主题";

const SUMMARY_SYSTEM =
  "你负责给一条记忆写摘要。只输出摘要正文，不要输出其他文字、不要加引号。用一句不超过 60 个汉字的陈述概括这条记忆的核心信息，保留关键事实、偏好或约定";

// 大分类示例：提示词、库满约束、存量收敛共用同一份宽泛类目口径。
const BIG_CATEGORY_HINT = "偏好、凭据、项目、沟通、设备、账户、约定、环境、流程、人物关系、时间安排、健康、财务";

const TAG_RULES =
  "标签规则：标签必须是大分类（宽泛类别），例如" + BIG_CATEGORY_HINT + "这类，不要用过于具体的词；禁止用专有名词、机器名、人名、产品名、一次性事件、具体令牌或临时内容作标签；优先复用已有标签库里的标签，意思相近时必须用已有标签，禁止创造同义新词；每条记忆最多 3 个标签（1 到 3 个）。";

const TAG_LIBRARY_FULL = "当前标签库已有 " + MAX_MEMORY_TAGS + " 个标签，达到总量上限，只能从已有标签库里选，不得新建标签。";

// 三条打标路径共用的提示词组装：规则写死，标签库按全量去重清单注入；
// 新系统没有标签时只给规则，不留空库占位；库满时明确禁止新建标签。
function tagSystem(base: string, existing: string[]): string {
  const library = existing.length
    ? "已有标签库（优先复用）：" + existing.join("、")
    : "已有标签库：暂无（新系统，没有可复用的标签，按规则直接给出大分类标签）。";
  const full = existing.length >= MAX_MEMORY_TAGS ? "\n" + TAG_LIBRARY_FULL : "";
  return base + "\n" + TAG_RULES + "\n" + library + full;
}

export async function splitAndTag(env: Env, text: string, existing: string[]): Promise<SplitPoint[] | null> {
  // 输入太长时截断喂给 AI 的部分（落库退化路径仍存全文）
  const feed = text.length > 8000 ? text.slice(0, 8000) : text;
  const raw = await runAi(env, tagSystem(SPLIT_SYSTEM, existing), feed, SPLIT_MAX_TOKENS, SPLIT_TIMEOUT_MS);
  return parseSplitPayload(raw, existing);
}

export async function suggestTags(
  env: Env,
  title: string,
  content: string,
  existing: string[] = [],
): Promise<string[] | null> {
  const user = "标题：" + title + "\n内容：" + (content || "").slice(0, 1200);
  const raw = await runAi(env, tagSystem(TAG_SYSTEM, existing), user, TAG_MAX_TOKENS, TAG_TIMEOUT_MS);
  return parseTagsPayload(raw, existing);
}

// cron 补摘要用：只产出一句话，失败返回 null（调用方跳过这条）。
export async function summarizeMemory(env: Env, title: string, content: string): Promise<string | null> {
  const raw = await runAi(
    env,
    SUMMARY_SYSTEM,
    "标题：" + title + "\n内容：" + (content || "").slice(0, 1200),
    SUMMARY_MAX_TOKENS,
    SUMMARY_TIMEOUT_MS,
  );
  if (!raw) return null;
  const flat = raw.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.slice(0, 120);
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
      // AI 打标是旁路：ingest 不因标签总量校验失败而丢内容。
      return await createMemory(db, { ...base, title }, channel, now, { enforceTagCap: false });
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

// 拆分点标签 + 面板手填标签：只按归一 key 去重。手填是人工意图，不因
// 自动打标被砍掉——「最多 3 个」约束的是 AI 自己给的那一份。
function mergeWithUserTags(aiTags: string[], userTags: string[]): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const tag of [...aiTags, ...userTags]) {
    const key = normalizeTagKey(tag);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

export interface IngestResult {
  split: boolean;
  // pending=true 表示请求路径只落了原文，拆分/打标/摘要交给 cron 异步完成。
  pending: boolean;
  memories: MemoryRow[];
}

// 面板自然语言保存（AI 已移出请求路径）：同步先落一条原文记忆，标
// ai_state=pending 后立即返回；拆分/打标/摘要由 cron 批量补全。AI 不可用
// 或失败都不影响这次保存，原文已经安全落库。
export async function ingestMemories(
  env: Env,
  input: Record<string, unknown>,
  channel: Channel,
  now: number,
): Promise<IngestResult> {
  if (typeof input.text !== "string" || !input.text.trim()) throw new MemError("请填写要保存的内容");
  const text = input.text.trim();
  if (text.length > INGEST_TEXT_MAX) throw new MemError("内容过长，请分段保存");
  // 录入不推导置顶或权重：显式不置顶、权重 0，不从内容重要程度换算。
  const base: Record<string, unknown> = {
    scope: input.scope,
    group_id: input.group_id,
    weight: 0,
    pinned: false,
    ai_state: "pending",
    ai_pending_at: now,
  };
  const userTags: string[] = Array.isArray(input.tags)
    ? Array.from(new Set(input.tags.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean)))
    : [];
  const row = await insertPoint(
    env.DB,
    { ...base, title: deriveMemoryTitle(text), content: text, tags: userTags },
    channel,
    now,
  );
  return { split: false, pending: true, memories: [row] };
}

export type PendingSplitFn = (env: Env, text: string, existing: string[]) => Promise<SplitPoint[] | null>;

export interface PendingProcessResult {
  scanned: number;
  split: number;
  tagged: number;
  failed: number;
}

// cron 批量补全 pending 记忆：拆出多个记忆点时子条目落库、原文以 ai_split
// 审计软删除；只有一个记忆点时原地补标签。AI 失败保留 pending，下一轮再试。
export async function processPendingMemories(
  env: Env,
  now: number,
  limit = 10,
  splitFn: PendingSplitFn = splitAndTag,
): Promise<PendingProcessResult> {
  const result: PendingProcessResult = { scanned: 0, split: 0, tagged: 0, failed: 0 };
  if (!env.AI || typeof env.AI.run !== "function") return result;
  const rows = await listPendingAiMemories(env.DB, limit);
  result.scanned = rows.length;
  if (!rows.length) return result;
  const existing = await listMemoryTags(env.DB);
  for (const row of rows) {
    const points = await splitFn(env, row.content, existing);
    if (!points || points.length === 0) {
      // AI 不可用/超时/不可解析：状态保持 pending，下一轮自动重试。
      result.failed++;
      continue;
    }
    const userTags = parseTags(row.tags_json);
    const channel: Channel = { actor: "cron", source: row.source || "panel", auditReads: false };
    if (points.length === 1) {
      const only = points[0] as SplitPoint;
      const tags = mergeWithUserTags(only.tags, userTags);
      await applyAiTags(env.DB, row.id, tags, channel, now);
      result.tagged++;
      continue;
    }
    const children: string[] = [];
    for (const point of points) {
      const child = await insertPoint(
        env.DB,
        {
          scope: row.scope,
          group_id: row.group_id,
          weight: 0,
          pinned: false,
          title: deriveMemoryTitle(point.content),
          content: point.content,
          tags: mergeWithUserTags(point.tags, userTags),
          ai_state: "split",
        },
        channel,
        now,
      );
      children.push(child.id);
    }
    await invalidateMemoryWithAudit(env.DB, row.id, channel, now, "ai_split", { children });
    result.split++;
  }
  return result;
}

export type SuggestTagsFn = (
  env: Env,
  title: string,
  content: string,
  existing?: string[],
) => Promise<string[] | null>;

export interface TagOneResult {
  memory: MemoryRow;
  skipped: boolean;
}

export interface TagUntaggedResult {
  scanned: number;
  tagged: number;
  failed: number;
  remaining: number;
}

// 未打标只看实际标签内容：解析后为空数组 / null / '[]'（及非数组 JSON）
// 才算未打标。不看 ai_state：用户手动加过标签或拆分落库时已有标签的，
// 一律不自动覆盖或补充。
function isUntagged(row: MemoryRow): boolean {
  return parseTags(row.tags_json).length === 0;
}

// 单条补打标：已有 ≥1 个标签则跳过，不调 AI、不改数据。
// 未打标时成功才落库；AI 不可用抛 502 让面板明确提示，状态不动。
// suggest 可注入，便于本地验收证明跳过发生在 suggestTags 之前。
export async function tagOneMemory(
  env: Env,
  id: string,
  channel: Channel,
  now: number,
  suggest: SuggestTagsFn = suggestTags,
): Promise<TagOneResult> {
  const row = await getMemoryRow(env.DB, id);
  if (!row) throw new MemError("记忆不存在或已删除", 404);
  if (!isUntagged(row)) return { memory: row, skipped: true };
  const existing = await listMemoryTags(env.DB);
  const suggested = await suggest(env, row.title, row.content, existing);
  // 注入的 suggest 也走同一道 normalize，保证三条路径落库口径一致。
  const tags = normalizeAiTags(suggested, existing);
  if (!tags.length) throw new MemError("AI 暂不可用，未能打标签", 502);
  return { memory: await applyAiTags(env.DB, id, tags, channel, now), skipped: false };
}

// 批量补标：只选标签为空的记忆，已打标的一律不选、不调 AI。
// 不看 ai_state。逐条调用、逐条计数，单条失败不影响其余。
// 响应保留 scanned/tagged/failed，并带 remaining（剩余未打标数）。
export async function tagUntaggedMemories(
  env: Env,
  limitInput: unknown,
  channel: Channel,
  now: number,
  suggest: SuggestTagsFn = suggestTags,
): Promise<TagUntaggedResult> {
  let limit = 20;
  if (typeof limitInput === "number" && Number.isFinite(limitInput)) {
    limit = Math.min(50, Math.max(1, Math.floor(limitInput)));
  }
  const result = await prepare(
    env.DB,
    "SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY updated_at DESC",
  ).all<MemoryRow>();
  const all = (Array.isArray(result) ? result : (result.results ?? [])) as MemoryRow[];
  const untagged = all.filter(isUntagged);
  const rows = untagged.slice(0, limit);
  // 标签库整批只查一次；本批新打上的标签并进清单，后续条目也能复用。
  const existing = await listMemoryTags(env.DB);
  let tagged = 0;
  let failed = 0;
  for (const row of rows) {
    const suggested = await suggest(env, row.title, row.content, existing);
    const tags = normalizeAiTags(suggested, existing);
    if (!tags.length) {
      failed++;
      continue;
    }
    try {
      await applyAiTags(env.DB, row.id, tags, channel, Date.now());
      for (const tag of tags) if (!existing.some((item) => normalizeTagKey(item) === normalizeTagKey(tag))) existing.push(tag);
      tagged++;
    } catch {
      failed++;
    }
  }
  void now;
  return { scanned: rows.length, tagged, failed, remaining: untagged.length - tagged };
}

// ---- 存量近义标签合并 ----
// 标签总数不多才做聚类：清单太长时 AI 分组会失真，先人工整理更可靠。
const MERGE_SYSTEM =
  "你负责整理记忆的标签库：把意思相近、重复的标签分到同一组，并给每组选一个保留标签。你只输出一个 JSON 对象，不要输出其他文字。对象格式为 {\"要改的标签\":\"保留的标签\"}：键是会被替换掉的标签，值是该组保留的标签。规则：只能用清单里已有的标签原文，禁止新造标签；每组的保留标签必须是这一组里使用条数最多的那个已有标签；意思不同的标签不要硬合并；没有可合并的标签就输出空对象 {}。";

// 超过上限时的收敛提示词：目标不是近义合并，而是把全库压到不超过 30 个
// 大分类。canonical 可以取清单里已有的宽泛标签，也可以新建宽泛类名；
// 大小写/写法不同的同一标签要统一成一种写法（如 github → GitHub）。
const MERGE_CONVERGE_SYSTEM =
  "你负责整理记忆的标签库：当前标签总数超过上限，需要把全库收敛成不超过 " + MAX_MEMORY_TAGS + " 个大分类。你只输出一个 JSON 对象，不要输出其他文字。对象格式为 {\"要改的标签\":\"大分类名\"}：键必须是清单里已有的标签原文；值是它归入的大分类名，优先使用清单里已有的宽泛标签，必要时可以用新的宽泛类名（如 " + BIG_CATEGORY_HINT + "）。规则：把过细、一次性、专有名词、机器名、人名、产品名标签都归入对应的大分类；大小写和写法不同的同一标签统一成同一种写法（例如 github 统一成 GitHub）；每个标签只归一个分类；清单里过于具体的标签都要落到某个大分类，直到分类总数不超过 " + MAX_MEMORY_TAGS + " 个；已经在宽泛分类里的标签保持不动。";

export type MergeMappingFn = (env: Env, stats: MemoryTagStat[]) => Promise<Record<string, string> | null>;

export function parseMergePayload(text: string | null): Record<string, string> | null {
  if (!text) return null;
  const slice = stripFenceAndSlice(text, "{", "}");
  if (!slice) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const mapping: Record<string, string> = {};
  for (const [from, to] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof to === "string" && from.trim() && to.trim()) mapping[from.trim()] = to.trim();
  }
  return mapping;
}

export async function askMergeMapping(env: Env, stats: MemoryTagStat[]): Promise<Record<string, string> | null> {
  const user = "标签清单（括号内是使用条数）：\n" + stats.map((stat) => stat.name + "（" + stat.count + " 条）").join("\n");
  const system = stats.length > MAX_MEMORY_TAGS ? MERGE_CONVERGE_SYSTEM : MERGE_SYSTEM;
  const raw = await runAi(env, system, user, MERGE_MAX_TOKENS, MERGE_TIMEOUT_MS);
  return parseMergePayload(raw);
}

// 映射的代码侧校验（不只靠提示词）：
//   - 键和值都必须命中已有标签（按归一 key 匹配，且改回库里的原文写法）；
//   - 自映射丢掉；
//   - 同一条映射链的标签归为一组（AI 逐对给出，连成组才是真正的组）；
//   - 每组的保留标签强制取组内条数最多的那个（并列时优先 AI 指的那个）；
//   - 最终只留「要改 → 保留」且两边不同的项。不合法的条目直接丢弃，
//     一条都不改的任务交给调用方（plan 为空时调用方报错）。
export function planTagMerge(mapping: Record<string, string>, stats: MemoryTagStat[]): Record<string, string> {
  const byKey = new Map<string, MemoryTagStat>();
  for (const stat of stats) byKey.set(normalizeTagKey(stat.name), stat);
  const parent = new Map<string, string>();
  function find(key: string): string {
    let root = key;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root) as string;
    let cursor = key;
    while (parent.get(cursor) !== undefined && parent.get(cursor) !== cursor) {
      const next = parent.get(cursor) as string;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }
  function union(a: string, b: string): void {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }
  const valueHits = new Map<string, number>();
  for (const [rawFrom, rawTo] of Object.entries(mapping)) {
    if (typeof rawTo !== "string") continue;
    const from = normalizeTagKey(rawFrom);
    const to = normalizeTagKey(rawTo);
    if (!from || !to || from === to) continue;
    if (!byKey.has(from) || !byKey.has(to)) continue;
    union(from, to);
    valueHits.set(to, (valueHits.get(to) ?? 0) + 1);
  }
  const groups = new Map<string, string[]>();
  for (const key of parent.keys()) {
    const root = find(key);
    const members = groups.get(root) ?? [];
    members.push(key);
    groups.set(root, members);
  }
  const plan: Record<string, string> = {};
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    // 保留标签 = 条数最多；并列时取被 AI 当成值的次数更多、再按名称定序。
    let keep = members[0] as string;
    for (const member of members) {
      const stat = byKey.get(member);
      const keepStat = byKey.get(keep);
      const count = stat?.count ?? 0;
      const keepCount = keepStat?.count ?? 0;
      if (count > keepCount) {
        keep = member;
        continue;
      }
      if (count < keepCount) continue;
      const hits = valueHits.get(member) ?? 0;
      const keepHits = valueHits.get(keep) ?? 0;
      if (hits > keepHits || (hits === keepHits && member < keep)) keep = member;
    }
    const keepTag = byKey.get(keep);
    if (!keepTag) continue;
    for (const member of members) {
      if (member === keep) continue;
      const stat = byKey.get(member);
      if (stat) plan[stat.name] = keepTag.name;
    }
  }
  return plan;
}

// 超过上限时的收敛校验：键必须命中已有标签；值可以是已有标签，也可以是
// 新的宽泛类名（大小写/写法归一时优先换成库里现有的写法）。映射链会传递
// 解析到最终分类，避免 A→B、B→C 后 A 落在一个已不存在的标签上。
// 不合法的条目直接丢弃，最终只留「当前写法 → 最终分类」的真实改动。
export function planTagConverge(mapping: Record<string, string>, stats: MemoryTagStat[]): Record<string, string> {
  const byKey = new Map<string, MemoryTagStat>();
  for (const stat of stats) byKey.set(normalizeTagKey(stat.name), stat);
  const direct = new Map<string, string>();
  for (const [rawFrom, rawTo] of Object.entries(mapping)) {
    if (typeof rawTo !== "string") continue;
    const from = normalizeTagKey(rawFrom);
    if (!from || !byKey.has(from)) continue;
    let canonical = rawTo.trim().replace(/\s+/g, " ");
    if (!canonical || canonical.length > TAG_NAME_MAX) continue;
    const existing = byKey.get(normalizeTagKey(canonical));
    if (existing) canonical = existing.name;
    direct.set(from, canonical);
  }
  function resolve(key: string): string {
    let canonical = direct.get(key) as string;
    const seen = new Set<string>([key]);
    for (let step = 0; step <= stats.length; step++) {
      const targetKey = normalizeTagKey(canonical);
      const next = direct.get(targetKey);
      if (next === undefined || seen.has(targetKey)) return canonical;
      seen.add(targetKey);
      canonical = next;
    }
    return canonical;
  }
  const groups = new Map<string, { canonical: string; members: string[] }>();
  for (const key of direct.keys()) {
    const canonical = resolve(key);
    const groupKey = normalizeTagKey(canonical);
    const group = groups.get(groupKey) ?? { canonical, members: [] };
    group.members.push(key);
    groups.set(groupKey, group);
  }
  const plan: Record<string, string> = {};
  for (const group of groups.values()) {
    for (const member of group.members) {
      const stat = byKey.get(member);
      if (!stat || stat.name === group.canonical) continue;
      plan[stat.name] = group.canonical;
    }
  }
  return plan;
}

// 应用收敛映射后的标签库总量：移除被改写的标签，加入新出现的分类名。
export function convergeTagTotal(plan: Record<string, string>, stats: MemoryTagStat[]): number {
  const library = new Set(stats.map((stat) => normalizeTagKey(stat.name)));
  const removed = new Set<string>();
  const added = new Set<string>();
  for (const [from, to] of Object.entries(plan)) {
    removed.add(normalizeTagKey(from));
    const key = normalizeTagKey(to);
    if (!removed.has(key) && !library.has(key)) added.add(key);
  }
  return stats.length - removed.size + added.size;
}

// 映射落到记忆上：按归一键替换，同一组撞出的重复自然去掉。
// 合并只减少同义项，不因为这个动作再砍标签数量（不截断）。
function mapMemoryTags(tags: string[], replace: Map<string, string>): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const target = replace.get(normalizeTagKey(tag));
    const value = target ?? tag.trim().replace(/\s+/g, " ");
    const key = normalizeTagKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(value);
  }
  return next;
}

export interface MergeTagsResult {
  mapping: Record<string, string>;
  updated: number;
}

export interface TagMergePlan {
  mapping: Record<string, string>;
  stats: MemoryTagStat[];
  converging: boolean;
}

// 只算“会合并什么”，不落库：cron 把它做成提案，管理员批准后才执行。
// 判定逻辑与 mergeSimilarTags 共用这一份，禁止复制。
export async function planSimilarTags(
  env: Env,
  ask: MergeMappingFn = askMergeMapping,
): Promise<TagMergePlan> {
  const stats = await listMemoryTagStats(env.DB);
  if (stats.length < 2) return { mapping: {}, stats, converging: false };
  if (stats.length > MERGE_TAG_LIMIT) {
    throw new MemError("当前有 " + stats.length + " 个标签，超过 " + MERGE_TAG_LIMIT + " 个上限，请先手动整理再合并", 400);
  }
  // 超过上限走收敛：目标是把全库压到不超过 MAX_MEMORY_TAGS 个大分类；
  // 未超过时维持原来的近义合并口径。两条路径都是全有全无。
  const converging = stats.length > MAX_MEMORY_TAGS;
  const mapping = await ask(env, stats);
  if (!mapping) throw new MemError("AI 暂不可用，标签没有做任何改动", 502);
  const plan = converging ? planTagConverge(mapping, stats) : planTagMerge(mapping, stats);
  if (Object.keys(plan).length === 0) {
    if (Object.keys(mapping).length > 0) throw new MemError("AI 返回的标签合并结果不合法，标签没有做任何改动", 502);
    return { mapping: {}, stats, converging };
  }
  if (converging && convergeTagTotal(plan, stats) > MAX_MEMORY_TAGS) {
    throw new MemError("AI 未能把标签收敛到 " + MAX_MEMORY_TAGS + " 个以内，标签没有做任何改动", 502);
  }
  return { mapping: plan, stats, converging };
}

// 把映射落到记忆上（不改 AI、不再算映射）：批准标签提案与手动合并共用。
export async function applyTagPlan(
  env: Env,
  mapping: Record<string, string>,
  now: number,
): Promise<number> {
  const replace = new Map<string, string>();
  for (const [from, to] of Object.entries(mapping)) replace.set(normalizeTagKey(from), to);
  const updates: Array<{ id: string; tags: string[] }> = [];
  for (const row of await listAllActiveMemories(env.DB)) {
    const tags = parseTags(row.tags_json);
    const next = mapMemoryTags(tags, replace);
    if (next.length === tags.length && next.every((tag, index) => tag === tags[index])) continue;
    updates.push({ id: row.id, tags: next });
  }
  return updates.length ? await rewriteMemoryTags(env.DB, updates, now) : 0;
}

// 存量近义合并（手动入口）：先算全量映射（含代码侧校验），再一次性落库。
// AI 不可用或映射不可用 → 抛错，一条都不改。
export async function mergeSimilarTags(
  env: Env,
  channel: Channel,
  now: number,
  ask: MergeMappingFn = askMergeMapping,
): Promise<MergeTagsResult> {
  void channel;
  const plan = await planSimilarTags(env, ask);
  if (Object.keys(plan.mapping).length === 0) return { mapping: {}, updated: 0 };
  return { mapping: plan.mapping, updated: await applyTagPlan(env, plan.mapping, now) };
}
