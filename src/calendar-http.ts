// Panel REST for the calendar board plus the public ICS subscription feed.
// Panel routes sit behind the admin session gate (the caller in index.ts has
// already authenticated); the feed route is public because the token in the
// URL is the credential, same pattern as the TOTP ticket.

import { isCrossSite, json, readJsonLimited } from "./http";
import type { Env, WaitCtx } from "./env";
import {
  CalError,
  calendarPublic,
  createCalendar,
  createEvent,
  createFeedToken,
  deleteCalendar,
  deleteEvent,
  eventPublic,
  feedEvents,
  feedPublic,
  generateIcs,
  getEvent,
  importIcs,
  instancePublic,
  listCalendars,
  listEventAudit,
  listFeedTokens,
  listInstances,
  parseIsoInstant,
  resolveFeedToken,
  revokeFeedToken,
  syncMirror,
  updateCalendar,
  updateEvent,
  findConflicts,
} from "./calendar";

const MAX_BODY_BYTES = 2 * 1024 * 1024; // ICS imports can be sizeable.
const ACTOR = "user";

export async function handleCalendarRequest(request: Request, env: Env, ctx: WaitCtx, path: string): Promise<Response | null> {
  void ctx;
  if (request.method.toUpperCase() !== "GET" && isCrossSite(request)) {
    return json({ ok: false, error: "跨站请求被拒绝" }, 403);
  }
  if (path === "/api/calendar/calendars") return calendars(request, env);
  const calendar = /^\/api\/calendar\/calendars\/([A-Za-z0-9_-]+)$/.exec(path);
  if (calendar && calendar[1]) return calendarOne(request, env, calendar[1]);
  const refresh = /^\/api\/calendar\/calendars\/([A-Za-z0-9_-]+)\/refresh$/.exec(path);
  if (refresh && refresh[1]) return calendarRefresh(request, env, refresh[1]);
  if (path === "/api/calendar/events") return events(request, env);
  const event = /^\/api\/calendar\/events\/([A-Za-z0-9_-]+)$/.exec(path);
  if (event && event[1]) return eventOne(request, env, event[1]);
  if (path === "/api/calendar/import") return importRoute(request, env);
  if (path === "/api/calendar/feeds") return feeds(request, env);
  const feed = /^\/api\/calendar\/feeds\/([A-Za-z0-9_-]+)$/.exec(path);
  if (feed && feed[1]) return feedOne(request, env, feed[1]);
  return null;
}

// Public subscription feed: GET /cal/<token>.ics
export async function handleCalendarFeed(request: Request, env: Env, token: string): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") return new Response("方法不允许", { status: 405 });
  try {
    const now = Date.now();
    const row = await resolveFeedToken(env.DB, token, now);
    if (!row) return new Response("订阅链接无效或已吊销", { status: 404 });
    const calendars = await listCalendars(env.DB);
    const scoped = row.calendar_id ? calendars.filter((cal) => cal.id === row.calendar_id) : calendars;
    const events = await feedEvents(env.DB, scoped.map((cal) => cal.id), now);
    const body = generateIcs(scoped, events, now);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "cache-control": "private, max-age=300",
        "content-disposition": "attachment; filename=\"hivemos.ics\"",
      },
    });
  } catch {
    return new Response("订阅生成失败", { status: 500 });
  }
}

function wrap(handler: () => Promise<Response>): Promise<Response> {
  return handler().catch((error: unknown) => {
    if (error instanceof CalError) return json({ ok: false, error: error.message }, error.status);
    return json({ ok: false, error: "暂时无法读写日历。请确认已经创建 D1 并应用迁移" }, 503);
  });
}

async function readBody(request: Request): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const body = await readJsonLimited(request, MAX_BODY_BYTES);
  if (!body.ok) return { ok: false, response: json({ ok: false, error: body.error }, body.status) };
  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
    return { ok: false, response: json({ ok: false, error: "请求格式不正确" }, 400) };
  }
  return { ok: true, value: body.value as Record<string, unknown> };
}

function methodNotAllowed(allow: string): Response {
  return json({ ok: false, error: "方法不允许" }, 405, { allow });
}

async function calendars(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return wrap(async () => json({ ok: true, calendars: (await listCalendars(env.DB)).map(calendarPublic) }));
  }
  if (method === "POST") {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => {
      const created = await createCalendar(env.DB, body.value, ACTOR, Date.now());
      if (created.kind === "mirror") {
        const report = await syncMirror(env.DB, created, Date.now());
        const fresh = (await listCalendars(env.DB)).find((cal) => cal.id === created.id) ?? created;
        return json({ ok: true, calendar: calendarPublic(fresh), sync: report }, 201);
      }
      return json({ ok: true, calendar: calendarPublic(created) }, 201);
    });
  }
  return methodNotAllowed("GET, POST");
}

async function calendarOne(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "PATCH") {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => json({ ok: true, calendar: calendarPublic(await updateCalendar(env.DB, id, body.value, Date.now())) }));
  }
  if (method === "DELETE") {
    return wrap(async () => {
      await deleteCalendar(env.DB, id, ACTOR, Date.now());
      return json({ ok: true });
    });
  }
  return methodNotAllowed("PATCH, DELETE");
}

async function calendarRefresh(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  return wrap(async () => {
    const calendars = await listCalendars(env.DB);
    const cal = calendars.find((item) => item.id === id);
    if (!cal) return json({ ok: false, error: "日历不存在" }, 404);
    const report = await syncMirror(env.DB, cal, Date.now());
    const fresh = (await listCalendars(env.DB)).find((item) => item.id === id) ?? cal;
    return json({ ok: true, calendar: calendarPublic(fresh), sync: report });
  });
}

async function events(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    const url = new URL(request.url);
    const fromMs = parseIsoInstant(url.searchParams.get("from")) ?? Date.now() - 31 * 24 * 60 * 60 * 1000;
    const toMs = parseIsoInstant(url.searchParams.get("to")) ?? Date.now() + 62 * 24 * 60 * 60 * 1000;
    const calendarId = url.searchParams.get("calendar_id");
    return wrap(async () => {
      const instances = await listInstances(env.DB, {
        fromMs,
        toMs,
        calendarIds: calendarId ? [calendarId] : null,
      });
      return json({ ok: true, instances: instances.map(instancePublic) });
    });
  }
  if (method === "POST") {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => {
      const now = Date.now();
      const created = await createEvent(env.DB, body.value, ACTOR, "panel", now);
      const conflicts = body.value.check_conflict === false
        ? []
        : await findConflicts(env.DB, { startMs: created.starts_at, endMs: created.ends_at, excludeEventId: created.id });
      return json({ ok: true, event: eventPublic(created), conflicts }, 201);
    });
  }
  return methodNotAllowed("GET, POST");
}

async function eventOne(request: Request, env: Env, id: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return wrap(async () => {
      const row = await getEvent(env.DB, id);
      if (!row || row.deleted_at != null) return json({ ok: false, error: "日程不存在或已删除" }, 404);
      const auditTrail = await listEventAudit(env.DB, id);
      return json({ ok: true, event: eventPublic(row), audit: auditTrail });
    });
  }
  if (method === "PATCH") {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    const ifMatch = request.headers.get("if-match");
    const etag = ifMatch ? Number(ifMatch.replace(/"/g, "")) : typeof body.value.etag === "number" ? body.value.etag : null;
    return wrap(async () => {
      const updated = await updateEvent(env.DB, id, body.value, ACTOR, "panel", Date.now(), Number.isFinite(etag) ? etag : null);
      return json({ ok: true, event: eventPublic(updated) });
    });
  }
  if (method === "DELETE") {
    const url = new URL(request.url);
    return wrap(async () => {
      const result = await deleteEvent(
        env.DB,
        id,
        { scope: url.searchParams.get("scope") ?? undefined, instance_start: url.searchParams.get("instance_start") ?? undefined },
        ACTOR,
        Date.now(),
      );
      return json({ ok: true, ...result });
    });
  }
  return methodNotAllowed("GET, PATCH, DELETE");
}

async function importRoute(request: Request, env: Env): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const body = await readBody(request);
  if (!body.ok) return body.response;
  if (typeof body.value.ics !== "string" || !body.value.ics.trim()) {
    return json({ ok: false, error: "请提供 ICS 内容" }, 400);
  }
  return wrap(async () => {
    const report = await importIcs(env.DB, {
      icsText: body.value.ics as string,
      calendarId: typeof body.value.calendar_id === "string" ? body.value.calendar_id : null,
      newCalendarName: typeof body.value.new_calendar_name === "string" ? body.value.new_calendar_name : null,
      includeDuplicates: body.value.include_duplicates === true,
      actor: ACTOR,
    }, Date.now());
    return json({ ok: true, import: report });
  });
}

async function feeds(request: Request, env: Env): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return wrap(async () => json({ ok: true, feeds: (await listFeedTokens(env.DB)).map(feedPublic) }));
  }
  if (method === "POST") {
    const body = await readBody(request);
    if (!body.ok) return body.response;
    return wrap(async () => {
      const { row, token } = await createFeedToken(env.DB, body.value, Date.now());
      const origin = new URL(request.url).origin;
      return json({ ok: true, feed: { ...feedPublic(row), token, url: origin + "/cal/" + token + ".ics" } }, 201);
    });
  }
  return methodNotAllowed("GET, POST");
}

async function feedOne(request: Request, env: Env, id: string): Promise<Response> {
  if (request.method.toUpperCase() !== "DELETE") return methodNotAllowed("DELETE");
  return wrap(async () => {
    await revokeFeedToken(env.DB, id, Date.now());
    return json({ ok: true });
  });
}
