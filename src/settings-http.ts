// Feature-settings REST ("功能设置" panel). GET returns the saved values,
// PATCH writes them. The gate in index.ts has already authenticated the
// admin session; PATCH also passes the cross-site check, same as the other
// module handlers.
//
// Writes are strict: an out-of-range value is a 400, never a silent clamp,
// because the panel shows what the endpoint returned and a silent fallback
// would look like "saved" while discarding the operator's input.

import { isCrossSite, json, readJsonLimited } from "./http";
import type { Env } from "./env";
import { logOp, panelActor } from "./oplog";
import {
  CRON_INTERVAL_OPTIONS,
  SIDEBAR_PIN_LIMIT_MAX,
  SIDEBAR_PIN_LIMIT_MIN,
  cronIntervalLabel,
  isCronIntervalOption,
  isSidebarPinLimit,
  readSystemSettings,
  setCronIntervalHours,
  setSidebarPinLimit,
} from "./settings";

const MAX_BODY_BYTES = 8 * 1024;

export async function handleSettingsRequest(request: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== "/api/settings") return null;
  const method = request.method.toUpperCase();
  if (method === "GET") return readSettings(env);
  if (method === "PATCH") return updateSettings(request, env);
  return json({ ok: false, error: "方法不允许" }, 405, { allow: "GET, PATCH" });
}

async function readSettings(env: Env): Promise<Response> {
  try {
    return json({ ok: true, settings: await readSystemSettings(env.DB) });
  } catch {
    return json({ ok: false, error: "暂时无法读取功能设置" }, 503);
  }
}

async function updateSettings(request: Request, env: Env): Promise<Response> {
  if (isCrossSite(request)) return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  const body = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!body.ok) return json({ ok: false, error: body.error }, body.status);
  const parsed = readSettingsPatch(body.value);
  if ("error" in parsed) return json({ ok: false, error: parsed.error }, 400);

  const actor = await panelActor(request, env);
  try {
    const saved = await readSystemSettings(env.DB);
    if (parsed.cronIntervalHours !== undefined) {
      saved.cron_interval_hours = await setCronIntervalHours(env.DB, parsed.cronIntervalHours);
    }
    if (parsed.sidebarPinLimit !== undefined) {
      saved.sidebar_pin_limit = await setSidebarPinLimit(env.DB, parsed.sidebarPinLimit);
    }
    const changed: string[] = [];
    if (parsed.cronIntervalHours !== undefined) {
      changed.push(`把定时任务频率改为${cronIntervalLabel(saved.cron_interval_hours)}`);
    }
    if (parsed.sidebarPinLimit !== undefined) changed.push(`把侧边栏自动展示上限改为 ${saved.sidebar_pin_limit}`);
    if (changed.length > 0) {
      await logOp(env.DB, {
        actor,
        module: "设置",
        action: "修改",
        targetId: "settings",
        targetName: "功能设置",
        text: changed.join("，"),
      });
    }
    return json({ ok: true, settings: saved });
  } catch {
    return json({ ok: false, error: "暂时无法保存功能设置" }, 503);
  }
}

// Both fields are optional so a panel can save one item without sending the
// other, but at least one must be present.
function readSettingsPatch(
  value: unknown,
): { cronIntervalHours?: number; sidebarPinLimit?: number } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "请求格式不正确" };
  const record = value as Record<string, unknown>;
  const result: { cronIntervalHours?: number; sidebarPinLimit?: number } = {};
  let seen = false;
  if (Object.prototype.hasOwnProperty.call(record, "cron_interval_hours")) {
    if (!isCronIntervalOption(record.cron_interval_hours)) {
      return { error: `定时任务频率只支持 ${CRON_INTERVAL_OPTIONS.join(" / ")} 小时` };
    }
    result.cronIntervalHours = Number(record.cron_interval_hours);
    seen = true;
  }
  if (Object.prototype.hasOwnProperty.call(record, "sidebar_pin_limit")) {
    if (!isSidebarPinLimit(record.sidebar_pin_limit)) {
      return { error: `侧边栏自动展示上限需要 ${SIDEBAR_PIN_LIMIT_MIN} 到 ${SIDEBAR_PIN_LIMIT_MAX} 之间的整数` };
    }
    result.sidebarPinLimit = Number(record.sidebar_pin_limit);
    seen = true;
  }
  if (!seen) return { error: "没有要保存的设置" };
  return result;
}
