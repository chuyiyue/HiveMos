#!/usr/bin/env node
// 记忆 P1 验证：FTS5 trigram 检索 + 公式排序 + ai_summary 旁路。
//
//   /data/workspace/node24/bin/node scripts/memory-p1-verify.mjs
//
// 用 node:sqlite 做 D1 垫片，真实执行迁移 0007/0017/0040 并调用
// src/memory.ts 的真实函数（类型剥离 + 解析钩子，同 totp-vectors.mjs）。
// 覆盖：中文子串命中（跨词组）、置顶恒前、公式排序（权重/衰减)、
// scope 过滤、软删除不出现在结果里、短查询与无 FTS 表时回退 LIKE、
// AI 失败写入照常、AI 成功摘要落库、正文不变不重生成、正文变化先清后补。
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      for (const suffix of [".ts", "/index.ts"]) {
        try { return await next(specifier + suffix, context); } catch {}
      }
    }
    throw error;
  }
}
`),
);

const { createMemory, updateMemory, deleteMemory, getMemoryRow, searchMemories, memoryPublic } =
  await import(new URL("../src/memory.ts", import.meta.url).href);
const { ingestMemories } = await import(new URL("../src/memory-ai.ts", import.meta.url).href);

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log("ok   " + name);
  } else {
    failures++;
    console.error("FAIL " + name);
  }
}

function makeDb(withFts) {
  const sqlite = new DatabaseSync(":memory:");
  const mig = (name) => sqlite.exec(readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8"));
  mig("0007_memory.sql");
  mig("0010_soul.sql");
  mig("0017_memory_tiers.sql");
  mig("0031_soul_version_manage.sql");
  mig("0032_soul_pending.sql");
  if (withFts) mig("0040_memory_fts.sql");
  mig("0060_memory_lifecycle.sql");
  mig("0061_soul_sections.sql");
  mig("0070_memory_vectors.sql");
  mig("0071_memory_proposals.sql");
  mig("0072_memory_ai_pending.sql");
  const db = {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      const wrap = (values) => ({
        bind(...next) {
          return wrap(next);
        },
        async first() {
          return stmt.get(...values) ?? null;
        },
        async all() {
          return { results: stmt.all(...values) };
        },
        async run() {
          return stmt.run(...values);
        },
      });
      return wrap([]);
    },
  };
  return db;
}

const CHANNEL = { actor: "verify", source: "panel", auditReads: false };
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.now();

// ---------- 检索与排序 ----------
{
  const db = makeDb(true);
  const old = await createMemory(db, {
    title: "验证码旧记录",
    content: "在登录页面输入验证码后继续操作，验证码五分钟内有效，过期重新获取验证码",
    tags: ["验证码"],
  }, CHANNEL, T0 - 60 * DAY);
  const fresh = await createMemory(db, {
    title: "新验证码流程",
    content: "验证码通过短信发送到手机",
    weight: 50,
  }, CHANNEL, T0);
  const pinned = await createMemory(db, {
    title: "置顶的验证码备忘",
    content: "验证码相关杂项",
    pinned: true,
  }, CHANNEL, T0 - 90 * DAY);
  const weak = await createMemory(db, {
    title: "杂项记录",
    content: "今天处理了很多事情，其中提到了一次验证码，其余都是日常琐事流水账记录下来备忘",
    scope: "工作",
  }, CHANNEL, T0 - 60 * DAY);
  const other = await createMemory(db, {
    title: "晚餐菜单",
    content: "番茄炒蛋和米饭",
  }, CHANNEL, T0);

  const hits = await searchMemories(db, "验证码");
  const ids = hits.map((row) => row.id);
  check("FTS 命中全部相关记忆", [old.id, fresh.id, pinned.id, weak.id].every((id) => ids.includes(id)));
  check("FTS 不命中无关记忆", !ids.includes(other.id));
  check("置顶恒在最前", ids[0] === pinned.id);
  check("新鲜+权重压过旧记录", ids.indexOf(fresh.id) < ids.indexOf(old.id));
  check("标题+多次命中压过单次弱命中", ids.indexOf(old.id) < ids.indexOf(weak.id));

  const span = await searchMemories(db, "入验证码后");
  check("跨词组子串命中（入验证码后）", span.some((row) => row.id === old.id));
  const span2 = await searchMemories(db, "证码五分");
  check("跨词组子串命中（证码五分）", span2.some((row) => row.id === old.id));

  const scoped = await searchMemories(db, "验证码", "全局");
  check("scope 过滤掉工作域", !scoped.some((row) => row.id === weak.id) && scoped.length > 0);
  const scopedWork = await searchMemories(db, "验证码", "工作");
  check("scope=工作只回该域", scopedWork.length === 1 && scopedWork[0].id === weak.id);

  const short = await searchMemories(db, "验证");
  check("两字查询回退 LIKE 仍命中", short.some((row) => row.id === old.id));

  await deleteMemory(db, old.id, CHANNEL, T0 + DAY);
  const afterDelete = await searchMemories(db, "验证码");
  check("软删除后不再命中", !afterDelete.some((row) => row.id === old.id));
}

// ---------- 无 FTS 表时回退 ----------
{
  const db = makeDb(false);
  const row = await createMemory(db, {
    title: "无索引的记忆",
    content: "这里记录了一个验证码的说明文字",
  }, CHANNEL, T0);
  const hits = await searchMemories(db, "验证码");
  check("FTS 表缺失时回退 LIKE 命中", hits.some((hit) => hit.id === row.id));
}

// ---------- ai_summary 旁路 ----------
{
  const db = makeDb(true);
  const pending = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const flush = async () => { await Promise.allSettled(pending.splice(0)); };

  let calls = 0;
  const okEnv = {
    AI: {
      async run() {
        calls++;
        return { response: "这是一句自动生成的摘要" };
      },
    },
  };
  const failEnv = {
    AI: {
      async run() {
        calls++;
        throw new Error("ai down");
      },
    },
  };

  const failed = await createMemory(db, {
    title: "AI 失败时",
    content: "这条记忆写入时 AI 应该失败，但内容必须照常保存下来不能丢",
  }, CHANNEL, T0, { ai: { env: failEnv, ctx } });
  await flush();
  check("AI 失败写入照常成功", !!failed.id);
  const failedRow = await getMemoryRow(db, failed.id);
  check("AI 失败摘要保持为空", !failedRow.ai_summary);

  const created = await createMemory(db, {
    title: "AI 成功时",
    content: "这条记忆写入后应该由 AI 生成一句话摘要并落库保存",
  }, CHANNEL, T0, { ai: { env: okEnv, ctx } });
  await flush();
  const createdRow = await getMemoryRow(db, created.id);
  check("AI 成功摘要落库", createdRow.ai_summary === "这是一句自动生成的摘要");
  check("memoryPublic 带出 ai_summary", memoryPublic(createdRow).ai_summary === "这是一句自动生成的摘要");

  const callsBefore = calls;
  const weighted = await updateMemory(db, created.id, { weight: 80 }, CHANNEL, T0 + DAY, { ai: { env: okEnv, ctx } });
  await flush();
  check("只改权重不重生成摘要", calls === callsBefore && weighted.ai_summary === "这是一句自动生成的摘要");

  const edited = await updateMemory(db, created.id, { content: "正文已经完全换成了新的内容" }, CHANNEL, T0 + 2 * DAY, { ai: { env: okEnv, ctx } });
  check("正文变化先清旧摘要", edited.ai_summary === null);
  await flush();
  const editedRow = await getMemoryRow(db, created.id);
  check("正文变化后补新摘要", editedRow.ai_summary === "这是一句自动生成的摘要");

  // 面板智能录入（ingest）也穿了摘要旁路：假 AI 返回非 JSON 文本时
  // 拆分退化为整段一条，随后摘要生成用同一假 AI 的文本落库。
  const ingestDb = makeDb(true);
  const realEnv = {
    DB: ingestDb,
    AI: {
      async run() {
        return { response: "录入记忆的摘要" };
      },
    },
  };
  const result2 = await ingestMemories(realEnv, { text: "下周三要交季度报表，记得提前准备数据" }, CHANNEL, T0, ctx);
  await flush();
  check("ingest 整段落库一条", result2.memories.length === 1);
  const row2 = await getMemoryRow(ingestDb, result2.memories[0].id);
  check("ingest 落库记忆带 ai_summary", row2.ai_summary === "录入记忆的摘要");
}

if (failures > 0) {
  console.error(`\nmemory-p1-verify: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nmemory-p1-verify: all checks passed");
