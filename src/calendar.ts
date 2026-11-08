// Calendar phase 1: calendars / events / audit / feed tokens on D1, ICS
// parse + generate, RRULE expansion at read time, mirror sync and import.
// Times are epoch milliseconds in storage; events store UTC instants plus
// the original tzid, and recurrence expands in that tzid so DST never drifts.

import { randomToken, sha256Hex } from "./auth";
import type { D1Database } from "./env";
import { prepare } from "./registry";

export class CalError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface CalendarRow {
  id: string;
  name: string;
  color: string;
  kind: string;
  source_url: string | null;
  source_etag: string | null;
  source_last_modified: string | null;
  last_sync_at: number | null;
  sync_status: string | null;
  sync_error: string | null;
  timezone: string;
  ctag: number;
  is_default: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface EventRow {
  id: string;
  calendar_id: string;
  uid: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: number;
  ends_at: number;
  tzid: string;
  all_day: number;
  rrule: string | null;
  exdates: string | null;
  rdates: string | null;
  recurrence_of: string | null;
  recurrence_id: number | null;
  status: string;
  etag: number;
  source: string;
  created_by: string | null;
  external_id: string | null;
  content_hash: string | null;
  tags_json: string | null;
  ai_status: string | null;
  related_json: string | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface Instance {
  eventId: string;
  masterId: string;
  calendarId: string;
  uid: string;
  title: string;
  description: string | null;
  location: string | null;
  startMs: number;
  endMs: number;
  tzid: string;
  allDay: boolean;
  status: string;
  isException: boolean;
  recurring: boolean;
  source: string;
  etag: number;
}

const MAX_WINDOW_MS = 395 * 24 * 60 * 60 * 1000; // 13 months
const MAX_INSTANCES_PER_EVENT = 1000;
const MAX_GENERATED = 10000;

function rowsOf<T>(value: { results?: T[] } | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.results)) return value.results;
  return [];
}

function newId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return prefix + hex;
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function parseIsoInstant(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? ms : null;
}

export function parseIsoList(value: unknown): number[] | null {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  const out: number[] = [];
  for (const item of value) {
    const ms = typeof item === "number" ? item : parseIsoInstant(item);
    if (ms == null || !Number.isFinite(ms)) return null;
    out.push(ms);
  }
  return out;
}

function parseMsList(json: string | null): number[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  } catch {
    return [];
  }
}

function validTimezone(tzid: string): boolean {
  if (!tzid) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tzid });
    return true;
  } catch {
    return false;
  }
}

export function requireTimezone(tzid: string): string {
  if (!validTimezone(tzid)) throw new CalError(400, "时区不正确：" + tzid);
  return tzid;
}

// ---------------------------------------------------------------------------
// Timezone conversion built on Intl (no tz database dependency).

interface LocalParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  dow: number; // ISO: 1 = Monday .. 7 = Sunday
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(tzid: string): Intl.DateTimeFormat {
  let cached = dtfCache.get(tzid);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    dtfCache.set(tzid, cached);
  }
  return cached;
}

const DOW_FROM_SHORT: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function utcToLocalParts(ms: number, tzid: string): LocalParts {
  const parts = dtf(tzid).formatToParts(new Date(ms));
  const bag: Record<string, string> = {};
  for (const part of parts) bag[part.type] = part.value;
  return {
    y: Number(bag.year),
    mo: Number(bag.month),
    d: Number(bag.day),
    h: Number(bag.hour) % 24,
    mi: Number(bag.minute),
    s: Number(bag.second),
    dow: DOW_FROM_SHORT[bag.weekday ?? ""] ?? 1,
  };
}

function tzOffsetMs(utcMs: number, tzid: string): number {
  const p = utcToLocalParts(utcMs, tzid);
  const localAsUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return localAsUtc - Math.floor(utcMs / 1000) * 1000;
}

export function localToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tzid: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let utc = guess - tzOffsetMs(guess, tzid);
  utc = guess - tzOffsetMs(utc, tzid);
  return utc;
}

function localPartsToUtc(p: LocalParts, tzid: string): number {
  return localToUtc(p.y, p.mo, p.d, p.h, p.mi, p.s, tzid);
}

function addDays(y: number, mo: number, d: number, days: number): { y: number; mo: number; d: number } {
  const t = new Date(Date.UTC(y, mo - 1, d + days));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function isoDowOfDate(y: number, mo: number, d: number): number {
  const js = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return js === 0 ? 7 : js;
}

// ---------------------------------------------------------------------------
// RRULE: parse + expand the common subset (FREQ / INTERVAL / COUNT / UNTIL /
// BYDAY / BYMONTHDAY / BYMONTH). Anything else in the rule is ignored.

export interface RRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count: number | null;
  untilMs: number | null;
  untilDate: { y: number; mo: number; d: number } | null;
  byday: Array<{ ord: number | null; dow: number }>;
  bymonthday: number[];
  bymonth: number[];
}

const DOW_FROM_CODE: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

export function parseRRule(text: string): RRule {
  const rule: RRule = { freq: "DAILY", interval: 1, count: null, untilMs: null, untilDate: null, byday: [], bymonthday: [], bymonth: [] };
  let freqSeen = false;
  for (const part of text.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toUpperCase();
    const value = part.slice(eq + 1).trim();
    if (key === "FREQ") {
      const freq = value.toUpperCase();
      if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") {
        throw new CalError(400, "暂不支持的重复频率：" + value);
      }
      rule.freq = freq;
      freqSeen = true;
    } else if (key === "INTERVAL") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 1) rule.interval = Math.floor(n);
    } else if (key === "COUNT") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 1) rule.count = Math.floor(n);
    } else if (key === "UNTIL") {
      const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
      if (dateOnly) {
        rule.untilDate = { y: Number(dateOnly[1]), mo: Number(dateOnly[2]), d: Number(dateOnly[3]) };
      } else {
        const parsed = parseIcsDateTime(value, {}, "UTC");
        if (parsed) rule.untilMs = parsed.ms;
      }
    } else if (key === "BYDAY") {
      for (const token of value.split(",")) {
        const match = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(token.trim().toUpperCase());
        if (!match) continue;
        const dow = DOW_FROM_CODE[match[2] ?? ""];
        if (!dow) continue;
        rule.byday.push({ ord: match[1] ? Number(match[1]) : null, dow });
      }
    } else if (key === "BYMONTHDAY") {
      for (const token of value.split(",")) {
        const n = Number(token.trim());
        if (Number.isFinite(n) && n !== 0) rule.bymonthday.push(n);
      }
    } else if (key === "BYMONTH") {
      for (const token of value.split(",")) {
        const n = Number(token.trim());
        if (Number.isFinite(n) && n >= 1 && n <= 12) rule.bymonth.push(n);
      }
    }
  }
  if (!freqSeen) throw new CalError(400, "重复规则缺少 FREQ");
  return rule;
}

interface LocalDateTime {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function monthDays(y: number, mo: number, rule: RRule, start: LocalParts): number[] {
  const dim = daysInMonth(y, mo);
  const days = new Set<number>();
  if (rule.bymonthday.length) {
    for (const raw of rule.bymonthday) {
      const day = raw > 0 ? raw : dim + raw + 1;
      if (day >= 1 && day <= dim) days.add(day);
    }
  } else if (rule.byday.length) {
    for (const item of rule.byday) {
      if (item.ord == null) {
        for (let d = 1; d <= dim; d++) if (isoDowOfDate(y, mo, d) === item.dow) days.add(d);
      } else if (item.ord > 0) {
        let seen = 0;
        for (let d = 1; d <= dim; d++) {
          if (isoDowOfDate(y, mo, d) === item.dow) {
            seen++;
            if (seen === item.ord) days.add(d);
          }
        }
      } else {
        let seen = 0;
        for (let d = dim; d >= 1; d--) {
          if (isoDowOfDate(y, mo, d) === item.dow) {
            seen++;
            if (seen === -item.ord) days.add(d);
          }
        }
      }
    }
  } else if (start.d <= dim) {
    days.add(start.d);
  }
  return [...days].sort((a, b) => a - b);
}

// Generates the series' local start times in chronological order. Stops at
// COUNT / UNTIL / stopAfterUtcMs, with a hard generation cap.
function* seriesStarts(ev: EventRow, tzid: string, stopAfterUtcMs: number): Generator<LocalDateTime> {
  if (!ev.rrule) return;
  const rule = parseRRule(ev.rrule);
  const start = ev.all_day ? utcToLocalParts(ev.starts_at, "UTC") : utcToLocalParts(ev.starts_at, tzid);
  const time = { h: start.h, mi: start.mi, s: start.s };
  let produced = 0;
  let generated = 0;

  const accept = (cand: LocalDateTime): boolean => {
    // Returns false when generation must stop entirely.
    generated++;
    if (generated > MAX_GENERATED) return false;
    if (rule.bymonth.length && !rule.bymonth.includes(cand.mo)) return true;
    if (rule.freq === "DAILY" || rule.freq === "WEEKLY") {
      if (rule.bymonthday.length) {
        const dim = daysInMonth(cand.y, cand.mo);
        const ok = rule.bymonthday.some((raw) => (raw > 0 ? raw : dim + raw + 1) === cand.d);
        if (!ok) return true;
      }
      if ((rule.freq === "DAILY" || rule.byday.some((b) => b.ord != null)) && rule.byday.length && rule.freq === "DAILY") {
        if (!rule.byday.some((b) => b.dow === isoDowOfDate(cand.y, cand.mo, cand.d))) return true;
      }
    }
    if (rule.untilDate) {
      const cmp = cand.y * 10000 + cand.mo * 100 + cand.d;
      const until = rule.untilDate.y * 10000 + rule.untilDate.mo * 100 + rule.untilDate.d;
      if (cmp > until) return false;
    }
    const utcMs = ev.all_day
      ? Date.UTC(cand.y, cand.mo - 1, cand.d)
      : localToUtc(cand.y, cand.mo, cand.d, cand.h, cand.mi, cand.s, tzid);
    if (rule.untilMs != null && utcMs > rule.untilMs) return false;
    if (utcMs > stopAfterUtcMs) return false;
    return true;
  };

  if (rule.freq === "DAILY") {
    for (let i = 0; ; i++) {
      const date = addDays(start.y, start.mo, start.d, i * rule.interval);
      const cand = { ...date, ...time };
      if (!accept(cand)) return;
      produced++;
      yield cand;
      if (rule.count != null && produced >= rule.count) return;
    }
  } else if (rule.freq === "WEEKLY") {
    const startDow = isoDowOfDate(start.y, start.mo, start.d);
    const monday = addDays(start.y, start.mo, start.d, -(startDow - 1));
    const dows = rule.byday.length ? [...new Set(rule.byday.map((b) => b.dow))].sort((a, b) => a - b) : [startDow];
    for (let w = 0; ; w++) {
      const weekBase = addDays(monday.y, monday.mo, monday.d, w * rule.interval * 7);
      let stopped = false;
      for (const dow of dows) {
        const date = addDays(weekBase.y, weekBase.mo, weekBase.d, dow - 1);
        const cand = { ...date, ...time };
        const candUtc = ev.all_day
          ? Date.UTC(cand.y, cand.mo - 1, cand.d)
          : localToUtc(cand.y, cand.mo, cand.d, cand.h, cand.mi, cand.s, tzid);
        if (candUtc < ev.starts_at) continue;
        if (!accept(cand)) {
          stopped = true;
          break;
        }
        produced++;
        yield cand;
        if (rule.count != null && produced >= rule.count) return;
      }
      if (stopped) return;
    }
  } else if (rule.freq === "MONTHLY") {
    for (let m = 0; ; m++) {
      const totalMonths = start.y * 12 + (start.mo - 1) + m * rule.interval;
      const y = Math.floor(totalMonths / 12);
      const mo = (totalMonths % 12) + 1;
      let stopped = false;
      for (const day of monthDays(y, mo, rule, start)) {
        const cand = { y, mo, d: day, ...time };
        const candUtc = ev.all_day
          ? Date.UTC(y, mo - 1, day)
          : localToUtc(y, mo, day, cand.h, cand.mi, cand.s, tzid);
        if (candUtc < ev.starts_at) continue;
        if (!accept(cand)) {
          stopped = true;
          break;
        }
        produced++;
        yield cand;
        if (rule.count != null && produced >= rule.count) return;
      }
      if (stopped) return;
    }
  } else {
    // YEARLY
    for (let yy = 0; ; yy++) {
      const y = start.y + yy * rule.interval;
      const months = rule.bymonth.length ? [...rule.bymonth].sort((a, b) => a - b) : [start.mo];
      let stopped = false;
      for (const mo of months) {
        for (const day of monthDays(y, mo, rule, start)) {
          const cand = { y, mo, d: day, ...time };
          const candUtc = ev.all_day
            ? Date.UTC(y, mo - 1, day)
            : localToUtc(y, mo, day, cand.h, cand.mi, cand.s, tzid);
          if (candUtc < ev.starts_at) continue;
          if (!accept(cand)) {
            stopped = true;
            break;
          }
          produced++;
          yield cand;
          if (rule.count != null && produced >= rule.count) return;
        }
        if (stopped) break;
      }
      if (stopped) return;
    }
  }
}

// Expands one master event into instances overlapping [fromMs, toMs).
// Exceptions are merged by listInstances, not here.
export function expandMaster(ev: EventRow, fromMs: number, toMs: number, exceptionIds: Set<number>): Instance[] {
  const tzid = ev.tzid || "UTC";
  const duration = ev.ends_at - ev.starts_at;
  const exdates = new Set(parseMsList(ev.exdates));
  const out: Instance[] = [];
  const pushInstance = (startMs: number) => {
    if (out.length >= MAX_INSTANCES_PER_EVENT) return;
    if (startMs + duration <= fromMs || startMs >= toMs) return;
    if (exdates.has(startMs)) return;
    if (exceptionIds.has(startMs)) return;
    out.push({
      eventId: ev.id,
      masterId: ev.id,
      calendarId: ev.calendar_id,
      uid: ev.uid,
      title: ev.title,
      description: ev.description,
      location: ev.location,
      startMs,
      endMs: startMs + duration,
      tzid: ev.tzid,
      allDay: ev.all_day === 1,
      status: ev.status,
      isException: false,
      recurring: Boolean(ev.rrule),
      source: ev.source,
      etag: ev.etag,
    });
  };
  if (!ev.rrule) {
    pushInstance(ev.starts_at);
  } else {
    for (const cand of seriesStarts(ev, tzid, toMs)) {
      const startMs = ev.all_day
        ? Date.UTC(cand.y, cand.mo - 1, cand.d)
        : localToUtc(cand.y, cand.mo, cand.d, cand.h, cand.mi, cand.s, tzid);
      if (startMs + duration > fromMs) pushInstance(startMs);
      if (out.length >= MAX_INSTANCES_PER_EVENT) break;
    }
  }
  for (const extra of parseMsList(ev.rdates)) pushInstance(extra);
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

// ---------------------------------------------------------------------------
// Public JSON shapes.

export function calendarPublic(row: CalendarRow): Record<string, unknown> {
  let sourceHost: string | null = null;
  let sourceTail: string | null = null;
  if (row.source_url) {
    try {
      sourceHost = new URL(row.source_url).host;
    } catch {
      sourceHost = null;
    }
    sourceTail = row.source_url.length > 6 ? row.source_url.slice(-6) : row.source_url;
  }
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    kind: row.kind,
    read_only: row.kind === "mirror",
    timezone: row.timezone,
    is_default: row.is_default === 1,
    ctag: row.ctag,
    last_sync_at: row.last_sync_at,
    sync_status: row.sync_status,
    sync_error: row.sync_error,
    source_host: sourceHost,
    source_tail: sourceTail,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function eventPublic(row: EventRow): Record<string, unknown> {
  return {
    id: row.id,
    calendar_id: row.calendar_id,
    uid: row.uid,
    title: row.title,
    description: row.description,
    location: row.location,
    start: toIso(row.starts_at),
    end: toIso(row.ends_at),
    tzid: row.tzid,
    all_day: row.all_day === 1,
    rrule: row.rrule,
    exdates: parseMsList(row.exdates).map(toIso),
    rdates: parseMsList(row.rdates).map(toIso),
    recurrence_of: row.recurrence_of,
    recurrence_id: row.recurrence_id != null ? toIso(row.recurrence_id) : null,
    status: row.status,
    etag: row.etag,
    source: row.source,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function instancePublic(inst: Instance): Record<string, unknown> {
  return {
    event_id: inst.eventId,
    master_id: inst.masterId,
    calendar_id: inst.calendarId,
    uid: inst.uid,
    title: inst.title,
    description: inst.description,
    location: inst.location,
    start: toIso(inst.startMs),
    end: toIso(inst.endMs),
    tzid: inst.tzid,
    all_day: inst.allDay,
    status: inst.status,
    is_exception: inst.isException,
    recurring: inst.recurring,
    source: inst.source,
    etag: inst.etag,
  };
}

// ---------------------------------------------------------------------------
// Storage helpers.

async function audit(
  db: D1Database,
  fields: { eventId: string | null; calendarId: string | null; actor: string; action: string; diff: unknown },
  now: number,
): Promise<void> {
  await prepare(db, "INSERT INTO calendar_audit (id, event_id, calendar_id, actor, action, diff_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    newId("aud_"),
    fields.eventId,
    fields.calendarId,
    fields.actor,
    fields.action,
    fields.diff == null ? null : JSON.stringify(fields.diff),
    now,
  ]).run();
}

async function bumpCtag(db: D1Database, calendarId: string, now: number): Promise<void> {
  await prepare(db, "UPDATE calendars SET ctag = ctag + 1, updated_at = ? WHERE id = ?", [now, calendarId]).run();
}

export async function getCalendar(db: D1Database, id: string): Promise<CalendarRow | null> {
  return prepare(db, "SELECT * FROM calendars WHERE id = ?", [id]).first<CalendarRow>();
}

export async function listCalendars(db: D1Database): Promise<CalendarRow[]> {
  const listed = await prepare(db, "SELECT * FROM calendars ORDER BY is_default DESC, created_at ASC, id ASC").all<CalendarRow>();
  return rowsOf(listed);
}

export async function defaultCalendar(db: D1Database): Promise<CalendarRow | null> {
  const preferred = await prepare(db, "SELECT * FROM calendars WHERE is_default = 1 ORDER BY created_at ASC LIMIT 1").first<CalendarRow>();
  if (preferred) return preferred;
  return prepare(db, "SELECT * FROM calendars WHERE kind != 'mirror' ORDER BY created_at ASC LIMIT 1").first<CalendarRow>();
}

export async function getEvent(db: D1Database, id: string): Promise<EventRow | null> {
  return prepare(db, "SELECT * FROM events WHERE id = ?", [id]).first<EventRow>();
}

async function contentHash(fields: {
  calendarId: string;
  uid: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: number;
  endsAt: number;
  tzid: string;
  allDay: boolean;
  rrule: string | null;
  status: string;
}): Promise<string> {
  return sha256Hex(
    JSON.stringify([
      fields.calendarId, fields.uid, fields.title, fields.description, fields.location,
      fields.startsAt, fields.endsAt, fields.tzid, fields.allDay ? 1 : 0, fields.rrule, fields.status,
    ]),
  );
}

function assertWritable(cal: CalendarRow): void {
  if (cal.kind === "mirror") throw new CalError(400, "订阅日历是只读的，不能修改");
}

// ---------------------------------------------------------------------------
// Calendar CRUD.

export interface CalendarInput {
  name?: unknown;
  color?: unknown;
  kind?: unknown;
  source_url?: unknown;
  timezone?: unknown;
  is_default?: unknown;
}

function readName(value: unknown, label: string): string {
  if (typeof value !== "string") throw new CalError(400, "请填写" + label);
  const name = value.trim();
  if (!name || name.length > 80) throw new CalError(400, label + "需要 1 到 80 个字符");
  return name;
}

function readColor(value: unknown): string {
  if (value == null) return "#D97757";
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value.trim())) throw new CalError(400, "颜色格式不正确");
  return value.trim();
}

export async function createCalendar(
  db: D1Database,
  input: CalendarInput,
  actor: string,
  now: number,
): Promise<CalendarRow> {
  const name = readName(input.name, "日历名称");
  const kind = input.kind == null ? "native" : input.kind;
  if (kind !== "native" && kind !== "mirror" && kind !== "imported") throw new CalError(400, "日历类型不正确");
  let sourceUrl: string | null = null;
  if (kind === "mirror") {
    if (typeof input.source_url !== "string" || !/^https?:\/\//i.test(input.source_url.trim())) {
      throw new CalError(400, "订阅日历需要 http 或 https 的 ICS 链接");
    }
    sourceUrl = input.source_url.trim();
  }
  const timezone = input.timezone == null ? "Asia/Shanghai" : requireTimezone(String(input.timezone));
  const id = newId("cal_");
  const isDefault = input.is_default === true ? 1 : 0;
  if (isDefault) await prepare(db, "UPDATE calendars SET is_default = 0").run();
  await prepare(
    db,
    "INSERT INTO calendars (id, name, color, kind, source_url, timezone, ctag, is_default, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
    [id, name, readColor(input.color), kind, sourceUrl, timezone, isDefault, actor, now, now],
  ).run();
  const created = await getCalendar(db, id);
  if (!created) throw new CalError(500, "创建日历失败");
  return created;
}

export async function updateCalendar(
  db: D1Database,
  id: string,
  patch: CalendarInput,
  now: number,
): Promise<CalendarRow> {
  const cal = await getCalendar(db, id);
  if (!cal) throw new CalError(404, "日历不存在");
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.name !== undefined) {
    sets.push("name = ?");
    values.push(readName(patch.name, "日历名称"));
  }
  if (patch.color !== undefined) {
    sets.push("color = ?");
    values.push(readColor(patch.color));
  }
  if (patch.timezone !== undefined) {
    sets.push("timezone = ?");
    values.push(requireTimezone(String(patch.timezone)));
  }
  if (patch.is_default === true) {
    await prepare(db, "UPDATE calendars SET is_default = 0").run();
    sets.push("is_default = 1");
  } else if (patch.is_default === false) {
    sets.push("is_default = 0");
  }
  if (!sets.length) return cal;
  sets.push("updated_at = ?");
  values.push(now, id);
  await prepare(db, "UPDATE calendars SET " + sets.join(", ") + " WHERE id = ?", values).run();
  const updated = await getCalendar(db, id);
  if (!updated) throw new CalError(500, "更新日历失败");
  return updated;
}

export async function deleteCalendar(db: D1Database, id: string, actor: string, now: number): Promise<void> {
  const cal = await getCalendar(db, id);
  if (!cal) throw new CalError(404, "日历不存在");
  const events = await prepare(db, "SELECT id FROM events WHERE calendar_id = ? AND deleted_at IS NULL", [id]).all<{ id: string }>();
  for (const row of rowsOf(events)) {
    await prepare(db, "UPDATE events SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, row.id]).run();
    await audit(db, { eventId: row.id, calendarId: id, actor, action: "delete", diff: { calendar_deleted: cal.name } }, now);
  }
  await prepare(db, "DELETE FROM calendars WHERE id = ?", [id]).run();
  if (cal.is_default === 1) {
    const next = await prepare(db, "SELECT id FROM calendars WHERE kind != 'mirror' ORDER BY created_at ASC LIMIT 1").first<{ id: string }>();
    if (next) await prepare(db, "UPDATE calendars SET is_default = 1 WHERE id = ?", [next.id]).run();
  }
}

// ---------------------------------------------------------------------------
// Event CRUD.

export interface EventInput {
  calendar_id?: unknown;
  title?: unknown;
  description?: unknown;
  location?: unknown;
  start?: unknown;
  end?: unknown;
  tzid?: unknown;
  all_day?: unknown;
  rrule?: unknown;
  exdates?: unknown;
  rdates?: unknown;
  status?: unknown;
  uid?: unknown;
}

interface EventFields {
  calendarId: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: number;
  endsAt: number;
  tzid: string;
  allDay: boolean;
  rrule: string | null;
  exdates: number[];
  rdates: number[];
  status: string;
}

function readOptionalText(value: unknown, label: string, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new CalError(400, label + "格式不正确");
  const text = value.trim();
  if (text.length > max) throw new CalError(400, label + "太长");
  return text || null;
}

function fieldsFromInput(input: EventInput, base: EventFields | null, cal: CalendarRow): EventFields {
  const title = input.title !== undefined ? readName(input.title, "日程标题") : base?.title;
  if (!title) throw new CalError(400, "请填写日程标题");
  const allDay = input.all_day !== undefined ? input.all_day === true : base?.allDay ?? false;
  let startsAt: number;
  let endsAt: number;
  if (allDay) {
    const startDate = typeof input.start === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(input.start.trim()) : null;
    const endDate = typeof input.end === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(input.end.trim()) : null;
    startsAt = startDate
      ? Date.UTC(Number(startDate[1]), Number(startDate[2]) - 1, Number(startDate[3]))
      : base && input.start === undefined
        ? base.startsAt
        : (() => { throw new CalError(400, "全天日程的开始日期不正确"); })();
    endsAt = endDate
      ? Date.UTC(Number(endDate[1]), Number(endDate[2]) - 1, Number(endDate[3]))
      : base && input.end === undefined
        ? base.endsAt
        : startsAt + 24 * 60 * 60 * 1000;
    if (endsAt <= startsAt) endsAt = startsAt + 24 * 60 * 60 * 1000;
  } else {
    startsAt = input.start !== undefined ? (parseIsoInstant(input.start) ?? NaN) : base?.startsAt ?? NaN;
    endsAt = input.end !== undefined ? (parseIsoInstant(input.end) ?? NaN) : base?.endsAt ?? NaN;
    if (!Number.isFinite(startsAt)) throw new CalError(400, "开始时间不正确，请用带时区的 ISO 8601 时间");
    if (!Number.isFinite(endsAt)) throw new CalError(400, "结束时间不正确，请用带时区的 ISO 8601 时间");
    if (endsAt <= startsAt) throw new CalError(400, "结束时间需要晚于开始时间");
  }
  let rrule: string | null;
  if (input.rrule !== undefined) {
    if (input.rrule == null || input.rrule === "") rrule = null;
    else if (typeof input.rrule === "string") {
      parseRRule(input.rrule.trim());
      rrule = input.rrule.trim();
    } else throw new CalError(400, "重复规则格式不正确");
  } else rrule = base?.rrule ?? null;
  const exdates = input.exdates !== undefined ? parseIsoList(input.exdates) : base?.exdates ?? [];
  if (exdates == null) throw new CalError(400, "例外日期格式不正确");
  const rdates = input.rdates !== undefined ? parseIsoList(input.rdates) : base?.rdates ?? [];
  if (rdates == null) throw new CalError(400, "额外日期格式不正确");
  const tzid = allDay ? "" : input.tzid !== undefined ? requireTimezone(String(input.tzid)) : base?.tzid ?? cal.timezone;
  const status = input.status !== undefined ? String(input.status) : base?.status ?? "confirmed";
  if (status !== "confirmed" && status !== "cancelled") throw new CalError(400, "日程状态不正确");
  return {
    calendarId: cal.id,
    title,
    description: input.description !== undefined ? readOptionalText(input.description, "描述", 4000) : base?.description ?? null,
    location: input.location !== undefined ? readOptionalText(input.location, "地点", 500) : base?.location ?? null,
    startsAt,
    endsAt,
    tzid,
    allDay,
    rrule,
    exdates,
    rdates,
    status,
  };
}

function fieldsFromRow(row: EventRow): EventFields {
  return {
    calendarId: row.calendar_id,
    title: row.title,
    description: row.description,
    location: row.location,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    tzid: row.tzid,
    allDay: row.all_day === 1,
    rrule: row.rrule,
    exdates: parseMsList(row.exdates),
    rdates: parseMsList(row.rdates),
    status: row.status,
  };
}

export async function createEvent(
  db: D1Database,
  input: EventInput,
  actor: string,
  source: string,
  now: number,
): Promise<EventRow> {
  let cal: CalendarRow | null = null;
  if (typeof input.calendar_id === "string" && input.calendar_id) {
    cal = await getCalendar(db, input.calendar_id);
    if (!cal) throw new CalError(404, "日历不存在");
  } else {
    cal = await defaultCalendar(db);
    if (!cal) throw new CalError(400, "还没有可用的日历");
  }
  assertWritable(cal);
  const fields = fieldsFromInput(input, null, cal);
  const id = newId("evt_");
  const uid = typeof input.uid === "string" && input.uid.trim() ? input.uid.trim() : id + "@hivemos";
  const clash = await prepare(db, "SELECT id FROM events WHERE calendar_id = ? AND uid = ? AND recurrence_id IS NULL", [cal.id, uid]).first<{ id: string }>();
  if (clash) throw new CalError(409, "同一日历里已有相同 UID 的日程");
  const hash = await contentHash({ ...fields, uid });
  await prepare(
    db,
    `INSERT INTO events (id, calendar_id, uid, title, description, location, starts_at, ends_at, tzid, all_day, rrule, exdates, rdates, status, etag, source, created_by, content_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      id, cal.id, uid, fields.title, fields.description, fields.location, fields.startsAt, fields.endsAt,
      fields.tzid, fields.allDay ? 1 : 0, fields.rrule, JSON.stringify(fields.exdates), JSON.stringify(fields.rdates),
      fields.status, source, actor, hash, now, now,
    ],
  ).run();
  await audit(db, { eventId: id, calendarId: cal.id, actor, action: "create", diff: { title: fields.title, start: toIso(fields.startsAt), end: toIso(fields.endsAt) } }, now);
  await bumpCtag(db, cal.id, now);
  const created = await getEvent(db, id);
  if (!created) throw new CalError(500, "创建日程失败");
  return created;
}

export async function updateEvent(
  db: D1Database,
  id: string,
  patch: EventInput & { instance_start?: unknown },
  actor: string,
  source: string,
  now: number,
  ifMatchEtag?: number | null,
): Promise<EventRow> {
  const row = await getEvent(db, id);
  if (!row || row.deleted_at != null) throw new CalError(404, "日程不存在或已删除");
  const cal = await getCalendar(db, row.calendar_id);
  if (!cal) throw new CalError(404, "日历不存在");
  assertWritable(cal);
  if (ifMatchEtag != null && ifMatchEtag !== row.etag) {
    throw new CalError(409, "这条日程已经被改过（当前版本 " + row.etag + "），请重读后再改");
  }
  const instanceStart = patch.instance_start != null ? parseIsoInstant(patch.instance_start) : null;
  if (patch.instance_start != null && instanceStart == null) throw new CalError(400, "instance_start 格式不正确");

  // Changing one instance of a recurring series creates an exception row and
  // excludes the original instance on the master.
  if (instanceStart != null && row.recurrence_of == null && row.rrule) {
    const base = fieldsFromRow(row);
    const targetCal = patch.calendar_id && typeof patch.calendar_id === "string" ? await getCalendar(db, patch.calendar_id) : cal;
    if (!targetCal) throw new CalError(404, "日历不存在");
    const fields = fieldsFromInput({ ...patch, start: patch.start ?? toIso(instanceStart) }, { ...base, startsAt: instanceStart, endsAt: instanceStart + (row.ends_at - row.starts_at) }, targetCal);
    const exId = newId("evt_");
    const hash = await contentHash({ ...fields, uid: row.uid });
    await prepare(
      db,
      `INSERT INTO events (id, calendar_id, uid, title, description, location, starts_at, ends_at, tzid, all_day, status, etag, source, created_by, recurrence_of, recurrence_id, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      [
        exId, targetCal.id, row.uid, fields.title, fields.description, fields.location, fields.startsAt, fields.endsAt,
        fields.tzid, fields.allDay ? 1 : 0, fields.status, source, actor, row.id, instanceStart, hash, now, now,
      ],
    ).run();
    const exdates = new Set(parseMsList(row.exdates));
    if (!exdates.has(instanceStart)) {
      exdates.add(instanceStart);
      await prepare(db, "UPDATE events SET exdates = ?, etag = etag + 1, updated_at = ? WHERE id = ?", [
        JSON.stringify([...exdates]), now, row.id,
      ]).run();
    }
    await audit(db, { eventId: exId, calendarId: targetCal.id, actor, action: "create", diff: { exception_of: row.id, recurrence_id: toIso(instanceStart), title: fields.title } }, now);
    await bumpCtag(db, targetCal.id, now);
    if (targetCal.id !== cal.id) await bumpCtag(db, cal.id, now);
    const created = await getEvent(db, exId);
    if (!created) throw new CalError(500, "创建例外日程失败");
    return created;
  }

  let targetCal = cal;
  if (patch.calendar_id !== undefined && typeof patch.calendar_id === "string" && patch.calendar_id !== row.calendar_id) {
    const found = await getCalendar(db, patch.calendar_id);
    if (!found) throw new CalError(404, "日历不存在");
    assertWritable(found);
    targetCal = found;
  }
  const fields = fieldsFromInput(patch, fieldsFromRow(row), targetCal);
  const hash = await contentHash({ ...fields, uid: row.uid });
  const diff: Record<string, unknown> = {};
  const before = fieldsFromRow(row);
  (Object.keys(fields) as Array<keyof EventFields>).forEach((key) => {
    if (JSON.stringify(fields[key]) !== JSON.stringify(before[key])) diff[key] = fields[key];
  });
  await prepare(
    db,
    `UPDATE events SET calendar_id = ?, title = ?, description = ?, location = ?, starts_at = ?, ends_at = ?, tzid = ?, all_day = ?, rrule = ?, exdates = ?, rdates = ?, status = ?, etag = etag + 1, content_hash = ?, updated_at = ? WHERE id = ?`,
    [
      targetCal.id, fields.title, fields.description, fields.location, fields.startsAt, fields.endsAt, fields.tzid,
      fields.allDay ? 1 : 0, fields.rrule, JSON.stringify(fields.exdates), JSON.stringify(fields.rdates), fields.status,
      hash, now, id,
    ],
  ).run();
  await audit(db, { eventId: id, calendarId: targetCal.id, actor, action: "update", diff }, now);
  await bumpCtag(db, targetCal.id, now);
  if (targetCal.id !== cal.id) await bumpCtag(db, cal.id, now);
  const updated = await getEvent(db, id);
  if (!updated) throw new CalError(500, "更新日程失败");
  return updated;
}

export async function deleteEvent(
  db: D1Database,
  id: string,
  options: { scope?: unknown; instance_start?: unknown },
  actor: string,
  now: number,
): Promise<{ deleted: string }> {
  const row = await getEvent(db, id);
  if (!row || row.deleted_at != null) throw new CalError(404, "日程不存在或已删除");
  const cal = await getCalendar(db, row.calendar_id);
  if (cal) assertWritable(cal);
  const instanceStart = options.instance_start != null ? parseIsoInstant(options.instance_start) : null;
  if (options.instance_start != null && instanceStart == null) throw new CalError(400, "instance_start 格式不正确");
  const scope = options.scope === "instance" ? "instance" : "series";

  if (scope === "instance" && instanceStart != null) {
    if (row.recurrence_of != null) {
      // Deleting an exception instance itself: tombstone the row.
      await prepare(db, "UPDATE events SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, id]).run();
      await audit(db, { eventId: id, calendarId: row.calendar_id, actor, action: "delete", diff: { scope: "instance" } }, now);
    } else if (row.rrule) {
      const exdates = new Set(parseMsList(row.exdates));
      exdates.add(instanceStart);
      await prepare(db, "UPDATE events SET exdates = ?, etag = etag + 1, updated_at = ? WHERE id = ?", [
        JSON.stringify([...exdates]), now, id,
      ]).run();
      await audit(db, { eventId: id, calendarId: row.calendar_id, actor, action: "delete", diff: { scope: "instance", instance_start: toIso(instanceStart) } }, now);
    } else {
      await prepare(db, "UPDATE events SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, id]).run();
      await audit(db, { eventId: id, calendarId: row.calendar_id, actor, action: "delete", diff: { scope: "instance" } }, now);
    }
    if (cal) await bumpCtag(db, cal.id, now);
    return { deleted: "instance" };
  }

  await prepare(db, "UPDATE events SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, id]).run();
  if (row.recurrence_of == null) {
    await prepare(db, "UPDATE events SET deleted_at = ?, updated_at = ? WHERE recurrence_of = ? AND deleted_at IS NULL", [now, now, id]).run();
  }
  await audit(db, { eventId: id, calendarId: row.calendar_id, actor, action: "delete", diff: { scope: "series", title: row.title } }, now);
  if (cal) await bumpCtag(db, cal.id, now);
  return { deleted: "series" };
}

// ---------------------------------------------------------------------------
// Listing with expansion, search, conflicts.

export function clampWindow(fromMs: number, toMs: number): { fromMs: number; toMs: number } {
  if (toMs <= fromMs) toMs = fromMs + 24 * 60 * 60 * 1000;
  if (toMs - fromMs > MAX_WINDOW_MS) toMs = fromMs + MAX_WINDOW_MS;
  return { fromMs, toMs };
}

export async function listInstances(
  db: D1Database,
  options: { fromMs: number; toMs: number; calendarIds?: string[] | null },
): Promise<Instance[]> {
  const { fromMs, toMs } = clampWindow(options.fromMs, options.toMs);
  let rows: EventRow[];
  if (options.calendarIds && options.calendarIds.length) {
    const marks = options.calendarIds.map(() => "?").join(", ");
    const listed = await prepare(
      db,
      `SELECT * FROM events WHERE deleted_at IS NULL AND recurrence_of IS NULL AND calendar_id IN (${marks})
       AND starts_at < ? AND (ends_at > ? OR rrule IS NOT NULL OR rdates IS NOT NULL)`,
      [...options.calendarIds, toMs, fromMs],
    ).all<EventRow>();
    rows = rowsOf(listed);
  } else {
    const listed = await prepare(
      db,
      `SELECT * FROM events WHERE deleted_at IS NULL AND recurrence_of IS NULL
       AND starts_at < ? AND (ends_at > ? OR rrule IS NOT NULL OR rdates IS NOT NULL)`,
      [toMs, fromMs],
    ).all<EventRow>();
    rows = rowsOf(listed);
  }
  const out: Instance[] = [];
  if (rows.length) {
    const marks = rows.map(() => "?").join(", ");
    const exceptions = await prepare(
      db,
      `SELECT * FROM events WHERE deleted_at IS NULL AND recurrence_of IN (${marks})`,
      rows.map((row) => row.id),
    ).all<EventRow>();
    const byMaster = new Map<string, EventRow[]>();
    for (const ex of rowsOf(exceptions)) {
      const list = byMaster.get(ex.recurrence_of ?? "") ?? [];
      list.push(ex);
      byMaster.set(ex.recurrence_of ?? "", list);
    }
    for (const row of rows) {
      const exs = byMaster.get(row.id) ?? [];
      const exceptionIds = new Set(exs.map((ex) => ex.recurrence_id).filter((v): v is number => v != null));
      out.push(...expandMaster(row, fromMs, toMs, exceptionIds));
      for (const ex of exs) {
        if (ex.status === "cancelled") continue;
        if (ex.starts_at < toMs && ex.ends_at > fromMs) {
          out.push({
            eventId: ex.id,
            masterId: row.id,
            calendarId: ex.calendar_id,
            uid: ex.uid,
            title: ex.title,
            description: ex.description,
            location: ex.location,
            startMs: ex.starts_at,
            endMs: ex.ends_at,
            tzid: ex.tzid,
            allDay: ex.all_day === 1,
            status: ex.status,
            isException: true,
            recurring: true,
            source: ex.source,
            etag: ex.etag,
          });
        }
      }
    }
  }
  out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return out;
}

export async function searchEvents(
  db: D1Database,
  query: string,
  options: { fromMs: number; toMs: number },
): Promise<Instance[]> {
  const like = "%" + query.replace(/[%_]/g, "") + "%";
  const listed = await prepare(
    db,
    `SELECT * FROM events WHERE deleted_at IS NULL AND recurrence_of IS NULL
     AND (title LIKE ? OR COALESCE(location, '') LIKE ? OR COALESCE(description, '') LIKE ?)`,
    [like, like, like],
  ).all<EventRow>();
  const rows = rowsOf(listed);
  if (!rows.length) return [];
  const { fromMs, toMs } = clampWindow(options.fromMs, options.toMs);
  const marks = rows.map(() => "?").join(", ");
  const exceptions = await prepare(
    db,
    `SELECT * FROM events WHERE deleted_at IS NULL AND recurrence_of IN (${marks})`,
    rows.map((row) => row.id),
  ).all<EventRow>();
  const byMaster = new Map<string, EventRow[]>();
  for (const ex of rowsOf(exceptions)) {
    const list = byMaster.get(ex.recurrence_of ?? "") ?? [];
    list.push(ex);
    byMaster.set(ex.recurrence_of ?? "", list);
  }
  const out: Instance[] = [];
  for (const row of rows) {
    const exs = byMaster.get(row.id) ?? [];
    const exceptionIds = new Set(exs.map((ex) => ex.recurrence_id).filter((v): v is number => v != null));
    out.push(...expandMaster(row, fromMs, toMs, exceptionIds));
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out.slice(0, 200);
}

export async function findConflicts(
  db: D1Database,
  fields: { startMs: number; endMs: number; excludeEventId?: string | null },
): Promise<Array<Record<string, unknown>>> {
  const calendars = await listCalendars(db);
  const writableIds = calendars.filter((cal) => cal.kind !== "mirror").map((cal) => cal.id);
  if (!writableIds.length) return [];
  const instances = await listInstances(db, { fromMs: fields.startMs, toMs: fields.endMs, calendarIds: writableIds });
  return instances
    .filter((inst) => !inst.allDay && inst.status !== "cancelled")
    .filter((inst) => fields.excludeEventId == null || (inst.eventId !== fields.excludeEventId && inst.masterId !== fields.excludeEventId))
    .filter((inst) => inst.startMs < fields.endMs && inst.endMs > fields.startMs)
    .slice(0, 20)
    .map((inst) => ({
      event_id: inst.eventId,
      title: inst.title,
      calendar_id: inst.calendarId,
      start: toIso(inst.startMs),
      end: toIso(inst.endMs),
    }));
}

export async function listEventAudit(db: D1Database, eventId: string): Promise<Array<Record<string, unknown>>> {
  const listed = await prepare(
    db,
    `SELECT * FROM calendar_audit WHERE event_id = ? OR event_id IN (SELECT id FROM events WHERE recurrence_of = ?)
     ORDER BY created_at DESC LIMIT 100`,
    [eventId, eventId],
  ).all<{ id: string; event_id: string | null; calendar_id: string | null; actor: string; action: string; diff_json: string | null; created_at: number }>();
  return rowsOf(listed).map((row) => ({
    id: row.id,
    event_id: row.event_id,
    calendar_id: row.calendar_id,
    actor: row.actor,
    action: row.action,
    diff: row.diff_json ? (JSON.parse(row.diff_json) as unknown) : null,
    created_at: row.created_at,
  }));
}

// ---------------------------------------------------------------------------
// ICS parse / generate.

export interface IcsDateTime {
  ms: number;
  tzid: string;
  allDay: boolean;
}

export function parseIcsDateTime(value: string, params: Record<string, string>, defaultTz: string): IcsDateTime | null {
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly) {
    return { ms: Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])), tzid: "", allDay: true };
  }
  const timed = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!timed) return null;
  const y = Number(timed[1]);
  const mo = Number(timed[2]);
  const d = Number(timed[3]);
  const h = Number(timed[4]);
  const mi = Number(timed[5]);
  const s = Number(timed[6]);
  if (timed[7] === "Z") return { ms: Date.UTC(y, mo - 1, d, h, mi, s), tzid: "UTC", allDay: false };
  const tzid = params.TZID && validTimezone(params.TZID) ? params.TZID : defaultTz;
  return { ms: localToUtc(y, mo, d, h, mi, s, tzid), tzid, allDay: false };
}

function parseIcsDurationMs(value: string): number | null {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const total =
    (Number(match[2] ?? 0) * 7 * 24 * 3600 + Number(match[3] ?? 0) * 24 * 3600 +
      Number(match[4] ?? 0) * 3600 + Number(match[5] ?? 0) * 60 + Number(match[6] ?? 0)) * 1000;
  return sign * total;
}

function icsUnescape(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function icsEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

export interface ParsedEvent {
  uid: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: number;
  endsAt: number;
  tzid: string;
  allDay: boolean;
  rrule: string | null;
  exdates: number[];
  rdates: number[];
  recurrenceId: number | null;
  status: string;
}

export function parseIcs(text: string, defaultTz: string): ParsedEvent[] {
  const rawLines = text.split(/\r\n|\r|\n/);
  const lines: string[] = [];
  for (const raw of rawLines) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length) {
      lines[lines.length - 1] += raw.slice(1);
    } else lines.push(raw);
  }
  const events: ParsedEvent[] = [];
  let current: Record<string, Array<{ value: string; params: Record<string, string> }>> | null = null;
  const pushProp = (name: string, value: string, params: Record<string, string>) => {
    if (!current) return;
    const list = current[name] ?? [];
    list.push({ value, params });
    current[name] = list;
  };
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:VEVENT")) {
      current = {};
      continue;
    }
    if (upper.startsWith("END:VEVENT")) {
      if (current) {
        const parsed = finishParsedEvent(current, defaultTz);
        if (parsed) events.push(parsed);
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const segments = head.split(";");
    const name = (segments[0] ?? "").toUpperCase();
    const params: Record<string, string> = {};
    for (const segment of segments.slice(1)) {
      const eq = segment.indexOf("=");
      if (eq > 0) params[segment.slice(0, eq).toUpperCase()] = segment.slice(eq + 1);
    }
    pushProp(name, value, params);
  }
  return events;
}

function firstProp(
  props: Record<string, Array<{ value: string; params: Record<string, string> }>>,
  name: string,
): { value: string; params: Record<string, string> } | null {
  const list = props[name];
  return list && list.length ? list[0]! : null;
}

function finishParsedEvent(
  props: Record<string, Array<{ value: string; params: Record<string, string> }>>,
  defaultTz: string,
): ParsedEvent | null {
  const uidProp = firstProp(props, "UID");
  const startProp = firstProp(props, "DTSTART");
  if (!startProp) return null;
  const start = parseIcsDateTime(startProp.value.trim(), startProp.params, defaultTz);
  if (!start) return null;
  let endMs: number;
  const endProp = firstProp(props, "DTEND");
  const durationProp = firstProp(props, "DURATION");
  if (endProp) {
    const end = parseIcsDateTime(endProp.value.trim(), endProp.params, defaultTz);
    endMs = end ? end.ms : start.ms;
  } else if (durationProp) {
    const duration = parseIcsDurationMs(durationProp.value);
    endMs = start.ms + (duration ?? 0);
  } else {
    endMs = start.ms + (start.allDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000);
  }
  const collectDates = (name: string): number[] => {
    const out: number[] = [];
    for (const prop of props[name] ?? []) {
      for (const piece of prop.value.split(",")) {
        const parsed = parseIcsDateTime(piece.trim(), prop.params, start.tzid || defaultTz);
        if (parsed) out.push(parsed.ms);
      }
    }
    return out;
  };
  const recurrenceProp = firstProp(props, "RECURRENCE-ID");
  const recurrence = recurrenceProp ? parseIcsDateTime(recurrenceProp.value.trim(), recurrenceProp.params, start.tzid || defaultTz) : null;
  const rruleProp = firstProp(props, "RRULE");
  let rrule: string | null = null;
  if (rruleProp) {
    try {
      parseRRule(rruleProp.value.trim());
      rrule = rruleProp.value.trim();
    } catch {
      rrule = null;
    }
  }
  const statusProp = firstProp(props, "STATUS");
  return {
    uid: uidProp ? uidProp.value.trim() : "",
    title: icsUnescape(firstProp(props, "SUMMARY")?.value ?? "").trim() || "（无标题）",
    description: firstProp(props, "DESCRIPTION") ? icsUnescape(firstProp(props, "DESCRIPTION")!.value) : null,
    location: firstProp(props, "LOCATION") ? icsUnescape(firstProp(props, "LOCATION")!.value) : null,
    startsAt: start.ms,
    endsAt: endMs,
    tzid: start.allDay ? "" : start.tzid,
    allDay: start.allDay,
    rrule,
    exdates: collectDates("EXDATE"),
    rdates: collectDates("RDATE"),
    recurrenceId: recurrence ? recurrence.ms : null,
    status: statusProp && statusProp.value.trim().toUpperCase() === "CANCELLED" ? "cancelled" : "confirmed",
  };
}

function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const bytes = encoder.encode(ch).length;
    if (currentBytes + bytes > limit) {
      parts.push(current);
      current = ch;
      currentBytes = bytes;
      limit = 74;
    } else {
      current += ch;
      currentBytes += bytes;
    }
  }
  if (current) parts.push(current);
  return parts.join("\r\n ");
}

function formatIcsDateTime(ms: number, tzid: string, allDay: boolean): string {
  if (allDay) {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return ";VALUE=DATE:" + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  if (tzid && tzid !== "UTC" && validTimezone(tzid)) {
    const p = utcToLocalParts(ms, tzid);
    return ";TZID=" + tzid + ":" + p.y + pad(p.mo) + pad(p.d) + "T" + pad(p.h) + pad(p.mi) + pad(p.s);
  }
  const d = new Date(ms);
  return ":" + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "Z";
}

export function generateIcs(calendars: CalendarRow[], events: EventRow[], now: number): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//HiveMos//Calendar 1.0//CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  const stamp = formatIcsDateTime(now, "UTC", false).slice(1);
  for (const cal of calendars) {
    lines.push("X-WR-CALNAME:" + icsEscape(cal.name));
    for (const ev of events) {
      if (ev.calendar_id !== cal.id) continue;
      lines.push("BEGIN:VEVENT");
      lines.push("UID:" + ev.uid);
      lines.push("DTSTAMP:" + stamp);
      lines.push("DTSTART" + formatIcsDateTime(ev.starts_at, ev.tzid, ev.all_day === 1));
      lines.push("DTEND" + formatIcsDateTime(ev.ends_at, ev.tzid, ev.all_day === 1));
      if (ev.recurrence_id != null) {
        lines.push("RECURRENCE-ID" + formatIcsDateTime(ev.recurrence_id, ev.tzid, ev.all_day === 1));
      }
      if (ev.rrule) lines.push("RRULE:" + ev.rrule);
      const exdates = parseMsList(ev.exdates);
      if (exdates.length) {
        const head = formatIcsDateTime(exdates[0]!, ev.tzid, ev.all_day === 1);
        const paramPart = head.slice(0, head.indexOf(":"));
        const values = exdates.map((ms) => {
          const formatted = formatIcsDateTime(ms, ev.tzid, ev.all_day === 1);
          return formatted.slice(formatted.indexOf(":") + 1);
        });
        lines.push("EXDATE" + paramPart + ":" + values.join(","));
      }
      const rdates = parseMsList(ev.rdates);
      if (rdates.length) {
        const head = formatIcsDateTime(rdates[0]!, ev.tzid, ev.all_day === 1);
        const paramPart = head.slice(0, head.indexOf(":"));
        const values = rdates.map((ms) => {
          const formatted = formatIcsDateTime(ms, ev.tzid, ev.all_day === 1);
          return formatted.slice(formatted.indexOf(":") + 1);
        });
        lines.push("RDATE" + paramPart + ":" + values.join(","));
      }
      lines.push("SUMMARY:" + icsEscape(ev.title));
      if (ev.description) lines.push("DESCRIPTION:" + icsEscape(ev.description));
      if (ev.location) lines.push("LOCATION:" + icsEscape(ev.location));
      if (ev.status === "cancelled") lines.push("STATUS:CANCELLED");
      lines.push("END:VEVENT");
    }
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// Parsed-event persistence shared by mirror sync and import.

async function parsedHash(cal: CalendarRow, parsed: ParsedEvent): Promise<string> {
  return contentHash({
    calendarId: cal.id,
    uid: parsed.uid,
    title: parsed.title,
    description: parsed.description,
    location: parsed.location,
    startsAt: parsed.startsAt,
    endsAt: parsed.endsAt,
    tzid: parsed.tzid,
    allDay: parsed.allDay,
    rrule: parsed.rrule,
    status: parsed.status,
  });
}

async function insertParsed(
  db: D1Database,
  cal: CalendarRow,
  parsed: ParsedEvent,
  source: string,
  actor: string,
  now: number,
  recurrenceOf: string | null,
  uidOverride?: string,
): Promise<string> {
  const id = newId("evt_");
  const hash = await parsedHash(cal, parsed);
  await prepare(
    db,
    `INSERT INTO events (id, calendar_id, uid, title, description, location, starts_at, ends_at, tzid, all_day, rrule, exdates, rdates, recurrence_of, recurrence_id, status, etag, source, created_by, external_id, content_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    [
      id, cal.id, uidOverride ?? (parsed.uid || id + "@hivemos"), parsed.title, parsed.description, parsed.location,
      parsed.startsAt, parsed.endsAt, parsed.tzid, parsed.allDay ? 1 : 0, parsed.rrule,
      JSON.stringify(parsed.exdates), JSON.stringify(parsed.rdates), recurrenceOf, parsed.recurrenceId,
      parsed.status, source, actor, parsed.uid || null, hash, now, now,
    ],
  ).run();
  await audit(db, { eventId: id, calendarId: cal.id, actor, action: "create", diff: { title: parsed.title, via: source } }, now);
  return id;
}

async function applyParsed(
  db: D1Database,
  row: EventRow,
  cal: CalendarRow,
  parsed: ParsedEvent,
  actor: string,
  now: number,
): Promise<void> {
  const hash = await parsedHash(cal, parsed);
  await prepare(
    db,
    `UPDATE events SET title = ?, description = ?, location = ?, starts_at = ?, ends_at = ?, tzid = ?, all_day = ?, rrule = ?, exdates = ?, rdates = ?, status = ?, etag = etag + 1, content_hash = ?, deleted_at = NULL, updated_at = ? WHERE id = ?`,
    [
      parsed.title, parsed.description, parsed.location, parsed.startsAt, parsed.endsAt, parsed.tzid,
      parsed.allDay ? 1 : 0, parsed.rrule, JSON.stringify(parsed.exdates), JSON.stringify(parsed.rdates),
      parsed.status, hash, now, row.id,
    ],
  ).run();
  await audit(db, { eventId: row.id, calendarId: cal.id, actor, action: "update", diff: { title: parsed.title, via: row.source } }, now);
}

function parsedKey(parsed: ParsedEvent): string {
  return parsed.uid + "|" + (parsed.recurrenceId == null ? "master" : String(parsed.recurrenceId));
}

function rowKey(row: EventRow): string {
  return row.uid + "|" + (row.recurrence_id == null ? "master" : String(row.recurrence_id));
}

// ---------------------------------------------------------------------------
// Mirror sync: pull the source ICS, reconcile by UID, never touch other data
// on failure.

export interface SyncReport {
  ok: boolean;
  unchanged?: boolean;
  added: number;
  updated: number;
  deleted: number;
  error?: string;
}

export async function syncMirror(db: D1Database, cal: CalendarRow, now: number): Promise<SyncReport> {
  const report: SyncReport = { ok: false, added: 0, updated: 0, deleted: 0 };
  if (cal.kind !== "mirror" || !cal.source_url) {
    report.error = "不是订阅日历";
    return report;
  }
  try {
    const headers: Record<string, string> = { "user-agent": "HiveMos/0.1 calendar-sync", accept: "text/calendar, text/plain, */*" };
    if (cal.source_etag) headers["if-none-match"] = cal.source_etag;
    if (cal.source_last_modified) headers["if-modified-since"] = cal.source_last_modified;
    const response = await fetch(cal.source_url, { headers, redirect: "follow" });
    if (response.status === 304) {
      await prepare(db, "UPDATE calendars SET last_sync_at = ?, sync_status = 'ok', sync_error = NULL WHERE id = ?", [now, cal.id]).run();
      report.ok = true;
      report.unchanged = true;
      return report;
    }
    if (!response.ok) throw new Error("HTTP " + response.status);
    const text = await response.text();
    if (text.length > 8 * 1024 * 1024) throw new Error("订阅内容过大");
    const parsed = parseIcs(text, cal.timezone);
    const existing = rowsOf(await prepare(db, "SELECT * FROM events WHERE calendar_id = ?", [cal.id]).all<EventRow>());
    const byKey = new Map<string, EventRow>();
    const masterIdByUid = new Map<string, string>();
    for (const row of existing) {
      byKey.set(rowKey(row), row);
      if (row.recurrence_id == null && row.deleted_at == null) masterIdByUid.set(row.uid, row.id);
    }
    const seen = new Set<string>();
    const masters = parsed.filter((item) => item.recurrenceId == null);
    const exceptions = parsed.filter((item) => item.recurrenceId != null);
    for (const item of masters) {
      const key = parsedKey(item);
      seen.add(key);
      const row = byKey.get(key);
      if (!row) {
        const id = await insertParsed(db, cal, item, "mirror", "mirror-sync", now, null);
        masterIdByUid.set(item.uid, id);
        report.added++;
      } else {
        masterIdByUid.set(item.uid, row.id);
        const hash = await parsedHash(cal, item);
        if (row.content_hash !== hash || row.deleted_at != null) {
          await applyParsed(db, row, cal, item, "mirror-sync", now);
          report.updated++;
        }
      }
    }
    for (const item of exceptions) {
      const key = parsedKey(item);
      seen.add(key);
      const masterId = masterIdByUid.get(item.uid) ?? null;
      if (!masterId) continue;
      const row = byKey.get(key);
      if (!row) {
        await insertParsed(db, cal, item, "mirror", "mirror-sync", now, masterId);
        report.added++;
      } else {
        const hash = await parsedHash(cal, item);
        if (row.content_hash !== hash || row.deleted_at != null) {
          await applyParsed(db, row, cal, item, "mirror-sync", now);
          report.updated++;
        }
      }
    }
    for (const row of existing) {
      if (row.deleted_at != null) continue;
      if (!seen.has(rowKey(row))) {
        await prepare(db, "UPDATE events SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, row.id]).run();
        await audit(db, { eventId: row.id, calendarId: cal.id, actor: "mirror-sync", action: "delete", diff: { via: "mirror" } }, now);
        report.deleted++;
      }
    }
    const changed = report.added + report.updated + report.deleted > 0;
    await prepare(
      db,
      "UPDATE calendars SET source_etag = ?, source_last_modified = ?, last_sync_at = ?, sync_status = 'ok', sync_error = NULL, ctag = ctag + ? WHERE id = ?",
      [response.headers.get("etag"), response.headers.get("last-modified"), now, changed ? 1 : 0, cal.id],
    ).run();
    report.ok = true;
    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : "同步失败";
    await prepare(db, "UPDATE calendars SET last_sync_at = ?, sync_status = 'error', sync_error = ? WHERE id = ?", [
      now, message.slice(0, 200), cal.id,
    ]).run();
    report.error = message;
    return report;
  }
}

export async function syncDueMirrors(db: D1Database, now: number): Promise<void> {
  const listed = await prepare(
    db,
    "SELECT * FROM calendars WHERE kind = 'mirror' AND (last_sync_at IS NULL OR last_sync_at < ?)",
    [now - 60 * 60 * 1000],
  ).all<CalendarRow>();
  for (const cal of rowsOf(listed)) {
    try {
      await syncMirror(db, cal, now);
    } catch {
      // One bad source must not stop the sweep.
    }
  }
}

// ---------------------------------------------------------------------------
// ICS import: UID first, fingerprint second. Suspected duplicates are
// reported back and skipped unless the caller insists.

export interface ImportReport {
  calendar_id: string;
  created: number;
  updated: number;
  duplicates: Array<{ uid: string; title: string; start: string }>;
  total: number;
}

export async function importIcs(
  db: D1Database,
  options: { icsText: string; calendarId?: string | null; newCalendarName?: string | null; includeDuplicates?: boolean; actor: string },
  now: number,
): Promise<ImportReport> {
  let cal: CalendarRow | null = null;
  if (options.calendarId) {
    cal = await getCalendar(db, options.calendarId);
    if (!cal) throw new CalError(404, "日历不存在");
    if (cal.kind === "mirror") throw new CalError(400, "不能导入到订阅日历");
  } else if (options.newCalendarName) {
    cal = await createCalendar(db, { name: options.newCalendarName, kind: "imported" }, options.actor, now);
  } else {
    cal = await defaultCalendar(db);
    if (!cal) throw new CalError(400, "还没有可用的日历");
  }
  const parsed = parseIcs(options.icsText, cal.timezone);
  const report: ImportReport = { calendar_id: cal.id, created: 0, updated: 0, duplicates: [], total: parsed.length };
  const masterIdByUid = new Map<string, string>();
  const existingMasters = rowsOf(
    await prepare(db, "SELECT * FROM events WHERE calendar_id = ? AND recurrence_of IS NULL", [cal.id]).all<EventRow>(),
  );
  for (const row of existingMasters) masterIdByUid.set(row.uid, row.id);

  const handleOne = async (item: ParsedEvent, recurrenceOf: string | null): Promise<void> => {
    const existing = await prepare(
      db,
      "SELECT * FROM events WHERE calendar_id = ? AND uid = ? AND recurrence_id IS ?",
      [cal!.id, item.uid, item.recurrenceId],
    ).first<EventRow>();
    if (existing) {
      const hash = await parsedHash(cal!, item);
      if (existing.content_hash !== hash || existing.deleted_at != null) {
        await applyParsed(db, existing, cal!, item, options.actor, now);
        report.updated++;
      }
      if (item.recurrenceId == null) masterIdByUid.set(item.uid, existing.id);
      return;
    }
    if (item.recurrenceId == null) {
      const fingerprint = await prepare(
        db,
        `SELECT id FROM events WHERE calendar_id = ? AND deleted_at IS NULL AND recurrence_of IS NULL
         AND title = ? AND starts_at = ? AND ends_at = ? AND COALESCE(location, '') = ?`,
        [cal!.id, item.title, item.startsAt, item.endsAt, item.location ?? ""],
      ).first<{ id: string }>();
      if (fingerprint) {
        if (!options.includeDuplicates) {
          report.duplicates.push({ uid: item.uid, title: item.title, start: toIso(item.startsAt) });
          return;
        }
        const id = await insertParsed(db, cal!, item, "import", options.actor, now, null, item.uid + "@dup." + newId("imp_"));
        masterIdByUid.set(item.uid, id);
        report.created++;
        return;
      }
    }
    const id = await insertParsed(db, cal!, item, "import", options.actor, now, recurrenceOf);
    if (item.recurrenceId == null) masterIdByUid.set(item.uid, id);
    report.created++;
  };

  for (const item of parsed.filter((entry) => entry.recurrenceId == null)) await handleOne(item, null);
  for (const item of parsed.filter((entry) => entry.recurrenceId != null)) {
    await handleOne(item, masterIdByUid.get(item.uid) ?? null);
  }
  if (report.created + report.updated > 0) await bumpCtag(db, cal.id, now);
  return report;
}

// ---------------------------------------------------------------------------
// Feed tokens: one revocable token per device; the plaintext is shown once
// at creation and only its hash is stored.

export interface FeedRow {
  id: string;
  name: string;
  token_hash: string;
  calendar_id: string | null;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

export function feedPublic(row: FeedRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    calendar_id: row.calendar_id,
    last_used_at: row.last_used_at,
    revoked: row.revoked_at != null,
    created_at: row.created_at,
  };
}

export async function createFeedToken(
  db: D1Database,
  input: { name?: unknown; calendar_id?: unknown },
  now: number,
): Promise<{ row: FeedRow; token: string }> {
  const name = readName(input.name, "设备名称");
  let calendarId: string | null = null;
  if (typeof input.calendar_id === "string" && input.calendar_id) {
    const cal = await getCalendar(db, input.calendar_id);
    if (!cal) throw new CalError(404, "日历不存在");
    calendarId = cal.id;
  }
  const token = randomToken();
  const id = newId("cft_");
  await prepare(db, "INSERT INTO calendar_feed_tokens (id, name, token_hash, calendar_id, created_at) VALUES (?, ?, ?, ?, ?)", [
    id, name, await sha256Hex(token), calendarId, now,
  ]).run();
  const row = await prepare(db, "SELECT * FROM calendar_feed_tokens WHERE id = ?", [id]).first<FeedRow>();
  if (!row) throw new CalError(500, "创建订阅令牌失败");
  return { row, token };
}

export async function listFeedTokens(db: D1Database): Promise<FeedRow[]> {
  const listed = await prepare(db, "SELECT * FROM calendar_feed_tokens ORDER BY created_at DESC").all<FeedRow>();
  return rowsOf(listed);
}

export async function revokeFeedToken(db: D1Database, id: string, now: number): Promise<void> {
  const row = await prepare(db, "SELECT id FROM calendar_feed_tokens WHERE id = ?", [id]).first<{ id: string }>();
  if (!row) throw new CalError(404, "订阅令牌不存在");
  await prepare(db, "UPDATE calendar_feed_tokens SET revoked_at = ? WHERE id = ?", [now, id]).run();
}

export async function resolveFeedToken(db: D1Database, token: string, now: number): Promise<FeedRow | null> {
  const row = await prepare(db, "SELECT * FROM calendar_feed_tokens WHERE token_hash = ?", [await sha256Hex(token)]).first<FeedRow>();
  if (!row || row.revoked_at != null) return null;
  if (row.last_used_at == null || now - row.last_used_at >= 60_000) {
    await prepare(db, "UPDATE calendar_feed_tokens SET last_used_at = ? WHERE id = ?", [now, row.id]).run();
  }
  return row;
}

// Events for the subscription feed: masters (with their series rules intact,
// clients expand) plus exception rows, in a generous window.
export async function feedEvents(db: D1Database, calendarIds: string[], now: number): Promise<EventRow[]> {
  if (!calendarIds.length) return [];
  const marks = calendarIds.map(() => "?").join(", ");
  const fromMs = now - 366 * 24 * 60 * 60 * 1000;
  const toMs = now + 548 * 24 * 60 * 60 * 1000;
  const listed = await prepare(
    db,
    `SELECT * FROM events WHERE deleted_at IS NULL AND calendar_id IN (${marks})
     AND (recurrence_of IS NOT NULL OR ends_at >= ? OR rrule IS NOT NULL) AND starts_at <= ?`,
    [...calendarIds, fromMs, toMs],
  ).all<EventRow>();
  return rowsOf(listed);
}
