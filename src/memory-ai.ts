// 记忆的 Workers AI 入口：面板自然语言保存时一次调用完成拆分 + 打标；
// 已落库的条目（面板直存或 MCP 写入）事后补打标，且只给「标签为空」的
// 记忆自动打标，已有标签的永不覆盖或补充。AI 是地基不是门槛：
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
  listAllActiveMemories,
  listMemoryTagStats,
  listMemoryTags,
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

// AI 返回标签的唯一 normalize 入口（拆分、单条补标、批量补标共用）：
// trim + 折叠空白；与已有标签库按大小写/空格归一匹配，等价的直接换成
// 库里现有写法；同 key 去重；最后截断到 3 个。超过 32 字的新词丢弃
// （已有标签本身较长时仍按库里的写法保留）。
export function normalizeAiTags(value: unknown, existing: string[], limit = TAG_LIMIT): string[] {
  if (!Array.isArray(value)) return [];
  const library = new Map<string, string>();
  for (const tag of existing) {
    const key = normalizeTagKey(tag);
    if (key && !library.has(key)) library.set(key, tag.trim().replace(/\s+/g, " "));
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const raw = item.trim().replace(/\s+/g, " ");
    if (!raw) continue;
    const key = normalizeTagKey(raw);
    const canonical = library.get(key) ?? (raw.length <= 32 ? raw : "");
    if (!canonical || seen.has(key)) continue;
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

const TAG_RULES =
  "标签规则：优先复用已有标签库里的标签；意思相近时必须用已有标签，禁止创造同义新词；每条记忆最多 3 个标签（1 到 3 个）；标签是简短的类目词，不要把一次性的内容词（具体令牌、人名、产品名）当标签。";

// 三条打标路径共用的提示词组装：规则写死，标签库按全量去重清单注入；
// 新系统没有标签时只给规则，不留空库占位。
function tagSystem(base: string, existing: string[]): string {
  const library = existing.length
    ? "已有标签库（优先复用）：" + existing.join("、")
    : "已有标签库：暂无（新系统，没有可复用的标签，按规则直接给出类目标签）。";
  return base + "\n" + TAG_RULES + "\n" + library;
}

export async function splitAndTag(env: Env, text: string, existing: string[]): Promise<SplitPoint[] | null> {
  // 输入太长时截断喂给 AI 的部分（落库退化路径仍存全文）
  const feed = text.length > 8000 ? text.slice(0, 8000) : text;
  const raw = await runAi(env, tagSystem(SPLIT_SYSTEM, existing), feed, SPLIT_MAX_TOKENS, SPLIT_TIMEOUT_MS);
  return parseSplitPayload(raw, existing);
}

export async function suggestTags(env: Env, title: string, content: string, existing: string[]): Promise<string[] | null> {
  const user = "标题：" + title + "\n内容：" + (content || "").slice(0, 1200);
  const raw = await runAi(env, tagSystem(TAG_SYSTEM, existing), user, TAG_MAX_TOKENS, TAG_TIMEOUT_MS);
  return parseTagsPayload(raw, existing);
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
  const userTags: string[] = Array.isArray(input.tags)
    ? Array.from(new Set(input.tags.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean)))
    : [];
  // 已有标签库：一次查询，提示词注入与 normalize 复用同一份清单。
  const existing = await listMemoryTags(env.DB);
  const points = await splitAndTag(env, text, existing);
  if (points && points.length > 0) {
    const rows: MemoryRow[] = [];
    for (const point of points) {
      rows.push(
        await insertPoint(
          env.DB,
          { ...base, title: deriveTitle(point.content), content: point.content, tags: mergeWithUserTags(point.tags, userTags), ai_state: "split" },
          channel,
          now,
        ),
      );
    }
    return { split: true, memories: rows };
  }
  const row = await insertPoint(
    env.DB,
    { ...base, title: deriveTitle(text), content: text, tags: userTags, ai_state: "failed" },
    channel,
    now,
  );
  return { split: false, memories: [row] };
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
  const raw = await runAi(env, MERGE_SYSTEM, user, MERGE_MAX_TOKENS, MERGE_TIMEOUT_MS);
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

// 存量近义合并：先算全量映射（含代码侧校验），再一次性落库。
// AI 不可用或映射不可用 → 抛错，一条都不改。
export async function mergeSimilarTags(
  env: Env,
  channel: Channel,
  now: number,
  ask: MergeMappingFn = askMergeMapping,
): Promise<MergeTagsResult> {
  void channel;
  const stats = await listMemoryTagStats(env.DB);
  if (stats.length < 2) return { mapping: {}, updated: 0 };
  if (stats.length > MERGE_TAG_LIMIT) {
    throw new MemError("当前有 " + stats.length + " 个标签，超过 " + MERGE_TAG_LIMIT + " 个上限，请先手动整理再合并", 400);
  }
  const mapping = await ask(env, stats);
  if (!mapping) throw new MemError("AI 暂不可用，标签没有做任何改动", 502);
  const plan = planTagMerge(mapping, stats);
  if (Object.keys(plan).length === 0) {
    if (Object.keys(mapping).length > 0) throw new MemError("AI 返回的标签合并结果不合法，标签没有做任何改动", 502);
    return { mapping: {}, updated: 0 };
  }
  const replace = new Map<string, string>();
  for (const [from, to] of Object.entries(plan)) replace.set(normalizeTagKey(from), to);
  const updates: Array<{ id: string; tags: string[] }> = [];
  for (const row of await listAllActiveMemories(env.DB)) {
    const tags = parseTags(row.tags_json);
    const next = mapMemoryTags(tags, replace);
    if (next.length === tags.length && next.every((tag, index) => tag === tags[index])) continue;
    updates.push({ id: row.id, tags: next });
  }
  const updated = updates.length ? await rewriteMemoryTags(env.DB, updates, now) : 0;
  return { mapping: plan, updated };
}
