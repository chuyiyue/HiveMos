// 同步与备份面板 REST：
//   GET    /api/backup                     目标状态 + 定时设置 + 频率
//   PATCH  /api/backup/settings            自动备份开关与目标
//   POST   /api/backup/test                用表单值（或已存凭据）做活体测试，不落库
//   POST   /api/backup/run                 立即备份（或 dry_run 只产包）
//   PUT    /api/backup/targets/:id         先测活再保存
//   DELETE /api/backup/targets/:id         清空该目标（停用并抹掉凭据）
//
// index.ts 已做过管理员会话校验；写操作在这里补跨站检查，口径与其它模块一致。

import type { Env } from "./env";
import { isCrossSite, json, readJsonLimited } from "./http";
import { BackupError } from "./backup-net";
import {
  backupDue,
  clearTarget,
  dryRunPackage,
  getTargetRow,
  isTargetId,
  readBackupSchedule,
  readPublicTargets,
  runBackup,
  saveGithubTarget,
  targetLabel,
  testGithubTarget,
  writeBackupSchedule,
} from "./backup";
import type { BackupRunResult, TargetId } from "./backup";
import { cronIntervalMs, getCronIntervalHours } from "./settings";
import { logOp, panelActor } from "./oplog";

const MAX_BODY_BYTES = 16 * 1024;

export async function handleBackupRequest(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path === "/api/backup") {
    if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
    return readState(env);
  }
  if (path === "/api/backup/settings") {
    if (request.method.toUpperCase() !== "PATCH") return methodNotAllowed("PATCH");
    return updateSettings(request, env);
  }
  if (path === "/api/backup/test") {
    if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
    return testTarget(request, env);
  }
  if (path === "/api/backup/run") {
    if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
    return startRun(request, env);
  }
  const target = /^\/api\/backup\/targets\/([A-Za-z0-9_-]+)$/.exec(path);
  if (target && target[1]) {
    const method = request.method.toUpperCase();
    if (method === "PUT") return saveTarget(request, env, target[1]);
    if (method === "DELETE") return removeTarget(request, env, target[1]);
    return methodNotAllowed("PUT, DELETE");
  }
  return null;
}

function methodNotAllowed(allow: string): Response {
  return json({ ok: false, error: "方法不允许" }, 405, { allow });
}

function fail(error: unknown): Response {
  if (error instanceof BackupError) return json({ ok: false, error: error.message }, error.status);
  return json({ ok: false, error: "同步与备份暂时不可用，请确认已经应用数据库迁移" }, 503);
}

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  const body = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!body.ok) return json({ ok: false, error: body.error }, body.status);
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
    return json({ ok: false, error: "请求格式不正确" }, 400);
  }
  return body.value as Record<string, unknown>;
}

async function mutationGate(request: Request): Promise<Response | null> {
  if (isCrossSite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  return null;
}

async function readState(env: Env): Promise<Response> {
  try {
    const [targets, schedule, intervalHours] = await Promise.all([
      readPublicTargets(env.DB),
      readBackupSchedule(env.DB),
      getCronIntervalHours(env.DB),
    ]);
    const gate = await backupDue(env.DB, schedule, Date.now());
    return json({
      ok: true,
      backup: {
        targets,
        schedule,
        interval_hours: intervalHours,
        next_due_at: schedule.last_success_at === null ? null : schedule.last_success_at + cronIntervalMs(intervalHours),
        due: gate.due,
      },
    });
  } catch {
    return json({ ok: false, error: "暂时无法读取同步与备份状态" }, 503);
  }
}

async function updateSettings(request: Request, env: Env): Promise<Response> {
  const gate = await mutationGate(request);
  if (gate) return gate;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  try {
    const saved = await writeBackupSchedule(env.DB, body);
    const actor = await panelActor(request, env);
    const changes: string[] = [];
    if (Object.prototype.hasOwnProperty.call(body, "auto_enabled")) {
      changes.push(saved.auto_enabled ? "开启自动备份" : "关闭自动备份");
    }
    if (Object.prototype.hasOwnProperty.call(body, "target")) {
      changes.push(saved.target ? `备份目标改为${targetLabel(saved.target)}` : "清空备份目标");
    }
    if (changes.length > 0) {
      await logOp(env.DB, {
        actor,
        module: "设置",
        action: "修改",
        targetId: "backup",
        targetName: "同步与备份",
        text: changes.join("，"),
      });
    }
    const intervalHours = await getCronIntervalHours(env.DB);
    return json({
      ok: true,
      schedule: saved,
      interval_hours: intervalHours,
      next_due_at: saved.last_success_at === null ? null : saved.last_success_at + cronIntervalMs(intervalHours),
    });
  } catch (error) {
    return fail(error);
  }
}

function readTarget(value: unknown): TargetId {
  if (!isTargetId(value)) throw new BackupError("备份目标不正确", 400);
  return value;
}

async function testTarget(request: Request, env: Env): Promise<Response> {
  const gate = await mutationGate(request);
  if (gate) return gate;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  try {
    const target = readTarget(body["target"]);
    if (target === "github") {
      const result = await testGithubTarget(env, body, Date.now());
      return json({ ok: true, target, result });
    }
    return json({ ok: false, error: "WebDAV 目标的测试还没有接入" }, 400);
  } catch (error) {
    return fail(error);
  }
}

async function saveTarget(request: Request, env: Env, id: string): Promise<Response> {
  const gate = await mutationGate(request);
  if (gate) return gate;
  if (!isTargetId(id)) return json({ ok: false, error: "备份目标不正确" }, 400);
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const now = Date.now();
  try {
    if (id === "github") {
      const row = await saveGithubTarget(env, body, now);
      await logOp(env.DB, {
        actor: await panelActor(request, env),
        module: "设置",
        action: "修改",
        targetId: "backup",
        targetName: "同步与备份",
        text: `保存 GitHub 备份目标 ${row.owner}/${row.repo}（${row.branch}）`,
      });
      const targets = await readPublicTargets(env.DB);
      return json({ ok: true, target: targets.github });
    }
    return json({ ok: false, error: "WebDAV 目标的保存还没有接入" }, 400);
  } catch (error) {
    return fail(error);
  }
}

async function removeTarget(request: Request, env: Env, id: string): Promise<Response> {
  const gate = await mutationGate(request);
  if (gate) return gate;
  if (!isTargetId(id)) return json({ ok: false, error: "备份目标不正确" }, 400);
  try {
    await clearTarget(env.DB, id, Date.now());
    await logOp(env.DB, {
      actor: await panelActor(request, env),
      module: "设置",
      action: "删除",
      targetId: "backup",
      targetName: "同步与备份",
      text: `停用${targetLabel(id)}备份目标`,
    });
    const targets = await readPublicTargets(env.DB);
    return json({ ok: true, target: targets[id] });
  } catch (error) {
    return fail(error);
  }
}

async function startRun(request: Request, env: Env): Promise<Response> {
  const gate = await mutationGate(request);
  if (gate) return gate;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const now = Date.now();
  try {
    if (body["dry_run"] === true) {
      const preview = await dryRunPackage(env.DB, now);
      return json({ ok: true, dry_run: true, preview });
    }
    const target = readTarget(body["target"]);
    const row = await getTargetRow(env.DB, target);
    if (!row || row.enabled !== 1) {
      throw new BackupError(`${targetLabel(target)}还没有保存为启用状态`, 400);
    }
    const result: BackupRunResult = await runBackup(
      env,
      target,
      "manual",
      await panelActor(request, env),
      now,
    );
    return json({ ok: true, target, result });
  } catch (error) {
    return fail(error);
  }
}
