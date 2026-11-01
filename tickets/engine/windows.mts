// Clock windows: is a window open now, and when does it next open? Pure Intl, no dependencies.
//
// The generated view prints a window's RULE, never a computed time (the view must not change with
// the clock); `next` prints the computed next-open time so whoever resumes a run can schedule it.
import type { Day, RecurringWindow, Weekday, Window } from './types.mts';

export const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export const isRecurring = (w: Window): w is RecurringWindow => 'tz' in w;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Is `s` a real calendar day `YYYY-MM-DD`? */
export function isDay(s: unknown): s is Day {
  if (typeof s !== 'string') return false;
  const m = DAY.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function validTz(tz: unknown): boolean {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const formats = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formats.set(tz, f);
  }
  return f;
}

/** Wall-clock fields of instant `ms` in `tz`. */
function parts(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const p: Record<string, number> = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}

/** The wall clock of `ms` in `tz`, read as if it were UTC. */
const wallUtc = (ms: number, tz: string): number => {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
};

/** The zone's offset from UTC at instant `ms`, in ms (east positive). */
export const offsetAt = (ms: number, tz: string): number => {
  const t = Math.floor(ms / 1000) * 1000;
  return wallUtc(t, tz) - t;
};

/** The instant at wall clock y-mo-d h:mi in `tz`. A time inside a DST gap moves forward by the gap;
 *  a time that occurs twice (DST ends) takes its first occurrence. Day/hour overflow is normalised. */
export function zoned(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offs = new Set([offsetAt(guess - 86_400_000, tz), offsetAt(guess, tz), offsetAt(guess + 86_400_000, tz)]);
  const hits = [...offs].map((o) => guess - o).filter((c) => wallUtc(c, tz) === guess).sort((a, b) => a - b);
  return hits.length ? hits[0] : guess - offsetAt(guess - 86_400_000, tz);
}

/** `ms` as an ISO 8601 instant in `tz`'s wall clock, with its offset: 2026-10-13T09:00:00+08:00. */
export function isoIn(ms: number, tz: string): string {
  const p = parts(ms, tz);
  const off = Math.round(offsetAt(ms, tz) / 60_000);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** `ms` as an ISO instant in this machine's local zone. */
export function isoLocal(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** Today on this machine, `YYYY-MM-DD`. */
export function today(now: number = Date.now()): Day {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` as Day;
}

/** Local midnight starting `day` on this machine. */
export function dayStart(day: Day): number {
  const m = DAY.exec(day)!;
  return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
}

const dayAllowed = (w: RecurringWindow, wd: number): boolean => {
  if (w.days === 'daily') return true;
  if (w.days === 'mon-fri') return wd >= 1 && wd <= 5;
  return w.days.includes(WEEKDAYS[wd]);
};

const hm = (s: string): [number, number] => {
  if (s === '24:00') return [24, 0];
  const m = HM.exec(s)!;
  return [+m[1], +m[2]];
};

/** The occurrence of a recurring window that OPENS on the calendar day y-mo-d (in its zone). */
function occurrence(w: RecurringWindow, y: number, mo: number, d: number): { start: number; end: number } | undefined {
  const date = new Date(Date.UTC(y, mo - 1, d));
  const Y = date.getUTCFullYear(), M = date.getUTCMonth() + 1, D = date.getUTCDate();
  if (!dayAllowed(w, date.getUTCDay())) return undefined;
  if (w.skip?.includes(`${Y}-${pad(M)}-${pad(D)}` as Day)) return undefined;
  const [fh, fm] = hm(w.from), [th, tm] = hm(w.to);
  const overnight = th * 60 + tm <= fh * 60 + fm;
  return { start: zoned(Y, M, D, fh, fm, w.tz), end: zoned(Y, M, D + (overnight ? 1 : 0), th, tm, w.tz) };
}

/** Is the window open at `now`? A one-shot window stays open once it has opened. */
export function isOpen(w: Window, now: number = Date.now()): boolean {
  if (!isRecurring(w)) return now >= Date.parse(w.opens);
  const p = parts(now, w.tz);
  for (const k of [-1, 0]) {
    const o = occurrence(w, p.y, p.mo, p.d + k);
    if (o && o.start <= now && now < o.end) return true;
  }
  return false;
}

/** When a closed window next opens: the instant, and the ISO text (a one-shot window keeps the text
 *  it was written with). Undefined when it is open now, or never opens again within a year. */
export function nextOpen(w: Window, now: number = Date.now()): { ms: number; iso: string } | undefined {
  if (!isRecurring(w)) {
    const ms = Date.parse(w.opens);
    return now < ms ? { ms, iso: w.opens } : undefined;
  }
  if (isOpen(w, now)) return undefined;
  const p = parts(now, w.tz);
  for (let k = -1; k <= 400; k++) {
    const o = occurrence(w, p.y, p.mo, p.d + k);
    if (o && o.start > now) return { ms: o.start, iso: isoIn(o.start, w.tz) };
  }
  return undefined;
}

const DAY_NAMES: Record<Weekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

/** The window's rule in a few words — time-independent, for the view. */
export function describeWindow(w: Window): string {
  if (!isRecurring(w)) return `${w.what}, opens ${w.opens}`;
  const days = w.days === 'daily' ? 'daily' : w.days === 'mon-fri' ? 'Mon–Fri' : w.days.map((d) => DAY_NAMES[d] ?? d).join(', ');
  const skip = w.skip?.length ? `, not on ${w.skip.join(', ')}` : '';
  return `${w.what} — ${days} ${w.from}–${w.to} ${w.tz}${skip}`;
}

/** Shape problems of a window (messages, relative to the window). */
export function windowProblems(w: unknown): string[] {
  if (typeof w !== 'object' || w === null || Array.isArray(w)) return ['must be { what, opens } or { what, tz, days, from, to, skip? }'];
  const o = w as Record<string, unknown>;
  const out: string[] = [];
  const str = (k: string) => typeof o[k] === 'string' && (o[k] as string).trim() !== '';
  if (!str('what')) out.push('what: a non-empty string is required');
  if ('tz' in o) {
    for (const k of Object.keys(o)) if (!['what', 'tz', 'days', 'from', 'to', 'skip'].includes(k)) out.push(`field "${k}" is not allowed in a recurring window (allowed: what, tz, days, from, to, skip)`);
    if (!validTz(o.tz)) out.push(`tz: ${JSON.stringify(o.tz)} is not an IANA time zone (e.g. Asia/Taipei)`);
    const days = o.days;
    if (days !== 'mon-fri' && days !== 'daily') {
      if (!Array.isArray(days) || days.length === 0) out.push(`days: must be 'mon-fri', 'daily' or a non-empty list of ${WEEKDAYS.join('/')}`);
      else {
        for (const d of days) if (!WEEKDAYS.includes(d as Weekday)) out.push(`days: ${JSON.stringify(d)} is not one of ${WEEKDAYS.join(', ')}`);
        if (new Set(days).size !== days.length) out.push('days: a day is listed twice');
      }
    }
    if (typeof o.from !== 'string' || !HM.test(o.from)) out.push(`from: ${JSON.stringify(o.from)} is not a 24 h HH:MM time`);
    if (typeof o.to !== 'string' || !(HM.test(o.to) || o.to === '24:00')) out.push(`to: ${JSON.stringify(o.to)} is not a 24 h HH:MM time (24:00 allowed)`);
    if (o.from === o.to) out.push('from and to are equal — the window would never close or never open');
    if (o.skip !== undefined) {
      if (!Array.isArray(o.skip)) out.push('skip: must be a list of YYYY-MM-DD days');
      else for (const d of o.skip) if (!isDay(d)) out.push(`skip: ${JSON.stringify(d)} is not a calendar day (YYYY-MM-DD)`);
    }
  } else {
    for (const k of Object.keys(o)) if (!['what', 'opens'].includes(k)) out.push(`field "${k}" is not allowed in a one-shot window (allowed: what, opens; a recurring window needs tz)`);
    if (typeof o.opens !== 'string' || !ISO_WITH_OFFSET.test(o.opens) || Number.isNaN(Date.parse(o.opens))) {
      out.push(`opens: ${JSON.stringify(o.opens)} is not an ISO 8601 instant with its offset (e.g. 2026-10-13T09:00:00+08:00)`);
    }
  }
  return out;
}
