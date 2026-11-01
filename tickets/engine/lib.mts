// Pure board logic: derived holds, what is workable here, who or what is waited on, and the stop
// code when nothing is. Ported from stockapi's tickets/lib.ts and generalised.
//
// Only blockers (owner / go / external) and a ticket's window and `after` are written by hand. The
// other holds are derived, so they cannot be forgotten or drift:
//   resource — one of the ticket's refs lies under a resource's paths (config.resources)
//   ticket   — an `after` target (a group = its non-dropped members) is not done yet, or an extension says so
//
// A ticket whose done condition reports members (members.mts) is worked member by member: each unmet
// member carries holds of the same kinds, resolved below, and is weighed like a ticket of its own for
// what is workable and for the stop code.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  Blocker, Board, Caps, Config, CoverageUnit, Ctx, Day, DoneWhen, Hold, Io, Member, Probe, Resolved, ResolvedReview, Stop, Ticket, Window,
} from './types.mts';
import { dayStart, describeWindow, isOpen, isoLocal, nextOpen, today } from './windows.mts';
import { doneKind, evalMembers } from './members.mts';

export { doneKind } from './members.mts';

/** Prose caps: a ticket says what, why and the ONE next action; the story goes in the commit. */
export const CAPS: Caps = {
  title: 80, why: 200, next: 240, until: 200, reason: 200, ask: 200, what: 200, when: 200,
  name: 120, window: 120, hazard: 200, policy: 200, bringUp: 200,
};

/** Jev thresholds. Starting points from TypeSafe's cookbooks, to tune on a repo's own answers:
 *  accept 0.8 = citation_check's AUTO_ACCEPT for a Choice; flag 0.7 = classifying_rag_passages' Noul
 *  cut-off; clear 0.3 = its mirror (a Noul's confidence is |2p − 1|, so both edges sit at 0.4). */
export const JEV_DEFAULTS = { tools: [] as string[], accept: 0.8, flag: 0.7, clear: 0.3 };

/** `review route` thresholds — starting points calibrated on one board (stockapi, 2026-10-13: Jev's
 *  Choice confidence ≥ 0.8 agreed with an LLM baseline 14 of 15 times, a Noul outside 0.3–0.7 69 of 70;
 *  a Score agreed within one level every time, so it stands from confidence 0.6). Equal maturity
 *  weights: nothing has calibrated them yet. */
export const REVIEW_DEFAULTS: ResolvedReview = {
  accept: 0.8, clear: 0.3, flag: 0.7, confidence: 0.6,
  weights: { spec_clear: 1, done_checkable: 1, next_evidenced: 1, refs_present: 1 },
};

const defined = <T extends object>(o: T | undefined): Partial<T> =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([, x]) => x !== undefined)) as Partial<T>;

export function resolveConfig(c: Config): Resolved {
  const { review, ...jev } = c.jev ?? {};
  return {
    ids: c.ids,
    doc: c.doc ?? 'docs/tickets.md',
    docGiven: c.doc !== undefined,
    main: c.main ?? 'main',
    groups: c.groups ?? {},
    boxes: c.boxes ?? [],
    resources: c.resources ?? {},
    tests: c.tests,
    caps: { ...CAPS, ...(c.caps ?? {}) },
    extensions: c.extensions ?? [],
    jev: {
      ...JEV_DEFAULTS, ...defined(jev),
      review: { ...REVIEW_DEFAULTS, ...defined(review), weights: { ...REVIEW_DEFAULTS.weights, ...defined(review?.weights) } },
    },
    claimStaleHours: c.claimStaleHours ?? 4,
  };
}

/** Read access to the repo at `root`. */
export function makeIo(root: string): Io {
  const abs = (p: string) => (isAbsolute(p) ? p : join(root, p));
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
  };
  return {
    root,
    hasGit: git('rev-parse', '--is-inside-work-tree').ok,
    exists: (p) => existsSync(abs(p)),
    read: (p) => { try { return readFileSync(abs(p), 'utf8'); } catch { return ''; } },
    git,
  };
}

export const makeCtx = (root: string, config: Config): Ctx => ({ root, config: resolveConfig(config), io: makeIo(root) });

/** The engine's machine-local cache: `tickets/.cache/` in the repo (git-ignored), or
 *  TICKET_BOARD_CACHE_DIR — a folder outside the checkout, for a reader that must not write into it (a
 *  relative path is taken from the repo root). It holds probes.jsonl and review/<date>/. */
export const cacheDir = (root: string): string => {
  const env = process.env.TICKET_BOARD_CACHE_DIR;
  return env ? resolve(root, env) : join(root, 'tickets', '.cache');
};

/** Where generated pages for people go: `_output/` at the repo root — visible and conventional, unlike
 *  the engine's cache — git-ignored by `init` / `upgrade`; or TICKET_BOARD_OUTPUT_DIR (a relative path is
 *  taken from the repo root). */
export const outputDir = (root: string): string => {
  const env = process.env.TICKET_BOARD_OUTPUT_DIR;
  return env ? resolve(root, env) : join(root, '_output');
};

/** The status page — a disposable HTML snapshot for a person, which `view` and every probing `next`
 *  (re)write. Git-ignored, never committed, never read by an agent. */
export const statusPagePath = (root: string): string => join(outputDir(root), 'board-status.html');

export const isLive = (t: Ticket): boolean => t.status === 'open' || t.status === 'blocked';
export const isClosed = (t: Ticket): boolean => t.status === 'done' || t.status === 'dropped';
export const byId = (b: Board): Map<string, Ticket> => new Map(b.map((t) => [t.id, t]));
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** How a claim is keyed (Ctx.claims): the ticket, or `<ticket> › <member>`. */
export const claimKey = (ticket: string, member?: string): string => (member === undefined ? ticket : `${ticket} › ${member}`);

/** The claim hold on a ticket or member, when this machine has one (cx.claims). */
const claimHold = (cx: Ctx, ticket: string, member?: string): Hold[] => {
  const c = cx.claims?.get(claimKey(ticket, member));
  if (!c) return [];
  const { ticket: _t, member: _m, ...rest } = c;
  return [{ kind: 'claim', ...rest }];
};

/** A ref without its `#anchor` / ` §x` suffix. */
export const refPath = (ref: string): string => ref.split(/#| §/)[0];

/** Resources a list of refs needs: one of them lies under the resource's paths
 *  (a path ending in `/` is a folder prefix, anything else must match exactly). */
function refNeeds(refs: readonly string[], cx: Ctx): { needs: string; via: string }[] {
  const under = (p: string, q: string) => (q.endsWith('/') ? p.startsWith(q) : p === q);
  return Object.entries(cx.config.resources).flatMap(([name, r]) => {
    const ref = refs.find((x) => r.paths.some((q) => under(refPath(x), q)));
    return ref ? [{ needs: name, via: ref }] : [];
  });
}

/** Resources a ticket needs: one of its refs lies under the resource's paths. */
export const needs = (t: Ticket, cx: Ctx): { needs: string; via: string }[] => refNeeds(t.refs ?? [], cx);

/** The ticket holds `after` derives: each target ticket that is not done; a group target = each of
 *  its members that is neither done nor dropped. */
function afterHolds(t: Ticket, b: Board, cx: Ctx): Hold[] {
  if (!isLive(t)) return [];
  const ids = byId(b);
  return ((t as { after?: string[] }).after ?? []).flatMap((target): Hold[] => {
    const u = ids.get(target);
    if (u) return u.status === 'done' ? [] : [{ kind: 'ticket', id: target, via: 'after' }];
    if (own(cx.config.groups, target)) {
      return b.filter((m) => m.group === target && m.id !== t.id && !isClosed(m))
        .map((m): Hold => ({ kind: 'ticket', id: m.id, via: `after ${target}` }));
    }
    return [];
  });
}

/** Everything that stands between a live ticket and work: its blockers and window, then the derived
 *  holds. The window is listed whatever the clock says (the view must not change as time passes);
 *  whether a hold stops work right now is `stands`'s call. Paused and closed tickets have none. */
export function holdsOf(id: string, b: Board, cx: Ctx): Hold[] {
  const t = byId(b).get(id);
  if (!t || !isLive(t)) return [];
  const blockers: Hold[] = t.status === 'blocked' ? [...t.blockers] : [];
  const win: Hold[] = t.status === 'open' || t.status === 'blocked' ? (t.window ? [{ kind: 'window', ...t.window }] : []) : [];
  const all: Hold[] = [
    ...claimHold(cx, t.id),
    ...blockers,
    ...win,
    ...needs(t, cx).map((n): Hold => ({ kind: 'resource', ...n })),
    ...afterHolds(t, b, cx),
    ...cx.config.extensions.flatMap((e) => e.holds?.(t, b, cx) ?? []),
  ];
  const seen = new Set<string>();
  return all.filter((h) => {
    if (h.kind !== 'ticket') return true;
    if (seen.has(h.id)) return false;
    seen.add(h.id);
    return true;
  });
}

// ── members ─────────────────────────────────────────────────────────────────────────────────────
// An unmet member's holds: its own (owner / go / external, a window, a resource, a ticket), a resource
// for each of its refs under a resource's paths, and the ticket that covers it — another open, blocked
// or paused ticket whose done condition reports the same member id and is more specific (fewer members;
// on a tie, earlier on the board). An umbrella's member that a specific ticket carries so waits on that
// ticket instead of being offered twice, and the strict order rules out a cycle.

/** A member with its holds resolved. */
export type MemberAt = Member & { holds: Hold[]; refs: string[] };

/** A ticket's members as the board sees them: how many, how many met, the unmet ones resolved (in the
 *  order reported), and one line per member left out for its shape (`check` reports those). */
export type MembersAt = { all: number; met: number; unmet: MemberAt[]; invalid: string[] };

const coverCache = new WeakMap<Ctx, WeakMap<Board, Map<string, { id: string; rank: [number, number] }[]>>>();
const memberCache = new WeakMap<Ctx, WeakMap<Board, Map<string, MembersAt | null>>>();
const cached = <V>(store: WeakMap<Ctx, WeakMap<Board, V>>, cx: Ctx, b: Board, make: () => V): V => {
  let per = store.get(cx);
  if (!per) store.set(cx, (per = new WeakMap()));
  if (!per.has(b)) per.set(b, make());
  return per.get(b)!;
};

/** Member id → the open, blocked or paused tickets whose done condition reports it, with how specific
 *  each is (member count, board position). */
const coverMap = (b: Board, cx: Ctx) => cached(coverCache, cx, b, () => {
  const out = new Map<string, { id: string; rank: [number, number] }[]>();
  b.forEach((t, i) => {
    if (!(isLive(t) || t.status === 'paused')) return;
    const ev = evalMembers(t, cx);
    if (!ev) return;
    for (const m of ev.members) out.set(m.id, [...(out.get(m.id) ?? []), { id: t.id, rank: [ev.members.length, i] }]);
  });
  return out;
});

const ahead = (x: [number, number], y: [number, number]) => x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]);

/** The open, blocked or paused tickets whose done condition reports member `id`. */
export const reportersOf = (id: string, b: Board, cx: Ctx): string[] => (coverMap(b, cx).get(id) ?? []).map((c) => c.id);

/** A ticket's members, or undefined when its done condition reports none. Paused, done and dropped
 *  tickets report theirs too (`show`), but only an open or blocked ticket is worked by them. */
export function membersOf(id: string, b: Board, cx: Ctx): MembersAt | undefined {
  const per = cached(memberCache, cx, b, () => new Map<string, MembersAt | null>());
  if (per.has(id)) return per.get(id) ?? undefined;
  const i = b.findIndex((t) => t.id === id);
  const ev = i < 0 ? undefined : evalMembers(b[i], cx);
  let out: MembersAt | null = null;
  if (ev) {
    const rank: [number, number] = [ev.members.length, i];
    const covers = coverMap(b, cx);
    const unmet = ev.members.filter((m) => !m.met).map((m): MemberAt => {
      const refs = m.refs ?? [];
      const cover = (covers.get(m.id) ?? []).filter((c) => c.id !== id && ahead(c.rank, rank)).sort((x, y) => (ahead(x.rank, y.rank) ? -1 : 1))[0];
      const all: Hold[] = [
        ...claimHold(cx, id, m.id),
        ...(m.holds ?? []),
        ...refNeeds(refs, cx).map((n): Hold => ({ kind: 'resource', ...n })),
        ...(cover ? [{ kind: 'ticket', id: cover.id, via: 'covering ticket' } as Hold] : []),
      ];
      const seen = new Set<string>();
      const holds = all.filter((h) => {
        const key = h.kind === 'ticket' ? `t:${h.id}` : h.kind === 'resource' ? `r:${h.needs}` : '';
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return { ...m, refs, holds };
    });
    out = { all: ev.members.length, met: ev.members.length - unmet.length, unmet, invalid: ev.problems };
  }
  per.set(id, out);
  return out ?? undefined;
}

/** The unmet members of the live tickets, each with its ticket — what the clock, owner, external and
 *  elsewhere lists walk. */
const liveMembers = (b: Board, cx: Ctx): { t: Ticket; m: MemberAt }[] =>
  b.flatMap((t) => (isLive(t) ? (membersOf(t.id, b, cx)?.unmet ?? []).map((m) => ({ t, m })) : []));

/** What holds a member, as one label: the first of its holds that stands, in this order — a claim, the
 *  ticket that covers it, the owner, a go, a third party, a resource, a window. '' = none stands. */
export function memberLabel(m: MemberAt, stand: (h: Hold) => boolean = () => true): string {
  const hs = m.holds.filter(stand);
  for (const k of ['claim', 'ticket', 'owner', 'go', 'external', 'resource', 'window'] as const) {
    const h = hs.find((x) => x.kind === k);
    if (!h) continue;
    if (h.kind === 'claim') return 'claimed';
    if (h.kind === 'ticket') return `in ${h.id}`;
    if (h.kind === 'external') return `external (${h.who})`;
    if (h.kind === 'resource') return `needs ${h.needs}`;
    if (h.kind === 'window') return `window (${h.what})`;
    return h.kind;
  }
  return '';
}

/** A ticket's members in one line — how many are not met and, by what holds them, how many of each:
 *  `12 of 120 not met: 4 workable · 3 external (broker) · 2 window (market hours) · 2 needs vm`. Generated,
 *  never hand-written. Without `live` every hold counts (the view and `show`: no clock, no probe); with
 *  it, only the holds that stand here now (`next`). */
export function memberSummary(ms: MembersAt, b: Board, live?: { reachable: ReadonlySet<string>; now: number }): string {
  const left = ms.invalid.length ? ` (${ms.invalid.length} left out for their shape — check)` : '';
  if (!ms.unmet.length) return `all ${ms.all} met${left}`;
  const free = live ? 'workable now' : 'workable';
  const stand = live ? (h: Hold) => stands(h, b, live.reachable, live.now) : () => true;
  const counts = new Map<string, number>();
  for (const m of ms.unmet) { const l = memberLabel(m, stand) || free; counts.set(l, (counts.get(l) ?? 0) + 1); }
  const parts = [...counts].sort(([a, x], [c, y]) => Number(c === free) - Number(a === free) || y - x || a.localeCompare(c));
  return `${ms.unmet.length} of ${ms.all} not met: ${parts.map(([l, n]) => `${n} ${l}`).join(' · ')}${left}`;
}

/** Does this hold stop work right now, given the resources reachable from here and the clock?
 *  An external blocker stops being a hold on its `recheck` day: an agent re-checks then. */
export function stands(h: Hold, b: Board, reachable: ReadonlySet<string>, now: number = Date.now()): boolean {
  switch (h.kind) {
    case 'owner': case 'go': case 'claim': return true;
    case 'external': return !(h.recheck && h.recheck <= today(now));
    case 'window': return !isOpen(h, now);
    case 'resource': return !reachable.has(h.needs);
    case 'ticket': return byId(b).get(h.id)?.status !== 'done';
    default: return true;
  }
}

/** A hold only the clock clears: a window that has not opened, or an external blocker whose
 *  recheck day is still ahead. Never a human gate. */
export function isClock(h: Hold, now: number = Date.now()): boolean {
  if (h.kind === 'window') return !isOpen(h, now);
  if (h.kind === 'external') return !!h.recheck && h.recheck > today(now);
  return false;
}

/** When a clock hold clears. */
export function clearsAt(h: Hold, now: number = Date.now()): { ms: number; iso: string } | undefined {
  if (h.kind === 'window') return nextOpen(h, now);
  if (h.kind === 'external' && h.recheck) { const ms = dayStart(h.recheck); return { ms, iso: isoLocal(ms) }; }
  return undefined;
}

const boxesOf = (on: string | string[] | undefined): string[] => (on === undefined ? [] : Array.isArray(on) ? on : [on]);

/** Resources usable on a declared box (`next --on <box>`). */
export const onBox = (box: string, cx: Ctx): Set<string> =>
  new Set(Object.entries(cx.config.resources).filter(([, r]) => boxesOf(r.on).includes(box)).map(([n]) => n));

/** Every box a resource or the config names. */
export const knownBoxes = (cx: Ctx): string[] =>
  [...new Set([...cx.config.boxes, ...Object.values(cx.config.resources).flatMap((r) => boxesOf(r.on))])];

/** Run every resource's probe from here — `next`'s default when no `--on` is given. A probe that
 *  throws counts as absent. Probes never run in `check` or in the view. */
export function probeAll(cx: Ctx): Map<string, Probe> {
  return new Map(Object.entries(cx.config.resources).map(([n, r]): [string, Probe] => {
    if (!r.probe) return [n, { here: false, usable: false }];
    try { return [n, r.probe()]; } catch (e) { return [n, { here: false, usable: false, note: `probe threw: ${(e as Error).message}` }]; }
  }));
}

/** The resources a probe run found usable right now. */
export const usableOf = (probes: ReadonlyMap<string, Probe>): Set<string> =>
  new Set([...probes].filter(([, p]) => p.usable).map(([n]) => n));

/** The resources an agent can reach from here: usable now, OR hosted here so the agent brings them
 *  up itself. A hosted-but-down resource is never a hold — its bring-up is an agent step. */
export const reachableOf = (probes: ReadonlyMap<string, Probe>): Set<string> =>
  new Set([...probes].filter(([, p]) => p.usable || p.here).map(([n]) => n));

/** One unit of work `next` can offer: a ticket, and for a ticket with members the members workable
 *  now, best first (the first is the item). */
export type Work = { ticket: Ticket; members?: MemberAt[] };

/** What is workable right now. A ticket with unmet members is workable when its own holds do not stand
 *  and the holds of at least one unmet member do not either; one whose members are all met is offered
 *  as itself (`check` reports it stale). Work on a resource reachable here comes first, scarcest
 *  resource first (config.resources key order) — for a member, the resources it needs count too; then
 *  the rest; within each, board (priority) order, and a ticket's members in the order reported. */
export function workable(b: Board, reachable: ReadonlySet<string>, cx: Ctx, now: number = Date.now()): Work[] {
  const order = Object.keys(cx.config.resources);
  const rank = (names: string[]) => Math.min(...names.filter((n) => reachable.has(n)).map((n) => order.indexOf(n)), order.length);
  const out: { w: Work; r: number; i: number }[] = [];
  b.forEach((t, i) => {
    if (!isLive(t) || holdsOf(t.id, b, cx).some((h) => stands(h, b, reachable, now))) return;
    const own = needs(t, cx).map((n) => n.needs);
    const unmet = membersOf(t.id, b, cx)?.unmet ?? [];
    if (!unmet.length) { out.push({ w: { ticket: t }, r: rank(own), i }); return; }
    const free = unmet.flatMap((m, j) => (m.holds.some((h) => stands(h, b, reachable, now)) ? []
      : [{ m, j, r: rank([...own, ...m.holds.flatMap((h) => (h.kind === 'resource' ? [h.needs] : []))]) }]))
      .sort((x, y) => x.r - y.r || x.j - y.j);
    if (free.length) out.push({ w: { ticket: t, members: free.map((f) => f.m) }, r: free[0].r, i });
  });
  return out.sort((x, y) => x.r - y.r || x.i - y.i).map(({ w }) => w);
}

/** `--group <key>`'s scope: the group's tickets and, transitively, every ticket they or their unmet
 *  members wait on — so a dependency outside the group is offered before the work that waits on it,
 *  and a group held only by such a dependency is never a stop. */
export function scopeOf(group: string, b: Board, cx: Ctx): Set<string> {
  const scope = new Set(b.filter((t) => t.group === group).map((t) => t.id));
  // A Set's iteration visits what is added during it: the closure in one pass.
  for (const id of scope) {
    const hs = [...holdsOf(id, b, cx), ...(membersOf(id, b, cx)?.unmet ?? []).flatMap((m) => m.holds)];
    for (const h of hs) if (h.kind === 'ticket') scope.add(h.id);
  }
  return scope;
}

/** Tickets workable right now, in `workable`'s order. */
export const actionable = (b: Board, reachable: ReadonlySet<string>, cx: Ctx, now: number = Date.now()): Ticket[] =>
  workable(b, reachable, cx, now).map((w) => w.ticket);

/** Live tickets whose window is closed now, soonest-open first — and, given `cx`, the closed windows of
 *  their unmet members (`member` names one). For `next` only. */
export function windowGates(b: Board, now: number = Date.now(), cx?: Ctx): { id: string; member?: string; what: string; opens: string; rule: string }[] {
  const gate = (id: string, w: Window, member?: string) => {
    if (isOpen(w, now)) return [];
    const n = nextOpen(w, now);
    return [{ id, ...(member ? { member } : {}), what: w.what, opens: n?.iso ?? 'never within a year — check the rule', rule: describeWindow(w), ms: n?.ms ?? Infinity }];
  };
  return [
    ...b.flatMap((t) => (t.status === 'open' || t.status === 'blocked') && t.window ? gate(t.id, t.window) : []),
    ...(cx ? liveMembers(b, cx).flatMap(({ t, m }) => m.holds.flatMap((h) => (h.kind === 'window' ? gate(t.id, h, m.id) : []))) : []),
  ].sort((x, y) => x.ms - y.ms).map(({ ms: _, ...g }) => g);
}

/** Resources this machine hosts but cannot use right now while tickets wait on them — an AGENT
 *  bring-up step, never a human ask. */
export function resourceBringUps(b: Board, probes: ReadonlyMap<string, Probe>, cx: Ctx):
  { resource: string; waiting: string[]; note?: string; bringUp?: string }[] {
  const deps = dependents(b, cx);
  return [...probes].flatMap(([name, p]) => {
    const waiting = deps.get(name) ?? [];
    return p.here && !p.usable && waiting.length ? [{ resource: name, waiting, note: p.note, bringUp: cx.config.resources[name]?.bringUp }] : [];
  });
}

/** Whole local days from `day` to `now`. For the CLI only — the view must not change daily. */
export const daysSince = (day: Day, now: number = Date.now()): number =>
  Math.round((dayStart(today(now)) - dayStart(day)) / 86_400_000);

/** Blockers of `kind` on blocked tickets, and — given `cx` — on the unmet members of live tickets. */
const blockersOf = <K extends Blocker['kind']>(b: Board, kind: K, cx?: Ctx): { id: string; member?: string; bl: Extract<Blocker, { kind: K }> }[] => [
  ...b.flatMap((t) => (t.status !== 'blocked' ? [] : t.blockers.flatMap((bl: Blocker) => (bl.kind === kind ? [{ id: t.id, bl: bl as Extract<Blocker, { kind: K }> }] : [])))),
  ...(cx ? liveMembers(b, cx).flatMap(({ t, m }) => m.holds.flatMap((h) => (h.kind === kind ? [{ id: t.id, member: m.id, bl: h as Extract<Blocker, { kind: K }> }] : []))) : []),
];

/** Owner asks (`owner`) or owner go asks (`go`) on blocked tickets — and, given `cx`, on members —
 *  longest wait first. */
export function waits(b: Board, kind: 'owner' | 'go', now: number = Date.now(), cx?: Ctx): { id: string; member?: string; ask: string; since: Day; days: number }[] {
  return blockersOf(b, kind, cx).map(({ id, member, bl }) => ({ id, ...(member ? { member } : {}), ask: bl.ask, since: bl.since, days: daysSince(bl.since, now) }))
    .sort((x, y) => x.since.localeCompare(y.since));
}

/** External blockers — and, given `cx`, members' external holds; `due` = the recheck day has come
 *  (the ticket or member is workable: re-check). */
export function externals(b: Board, now: number = Date.now(), cx?: Ctx): { id: string; member?: string; who: string; what: string; recheck: Day | null; due: boolean }[] {
  return blockersOf(b, 'external', cx).map(({ id, member, bl }) => ({ id, ...(member ? { member } : {}), who: bl.who, what: bl.what, recheck: bl.recheck ?? null, due: !!bl.recheck && bl.recheck <= today(now) }))
    .sort((x, y) => (x.recheck ?? '9999').localeCompare(y.recheck ?? '9999'));
}

/** Live tickets — and members — held by a resource this machine cannot reach: work for another box. */
export function elsewhere(b: Board, reachable: ReadonlySet<string>, cx: Ctx): { id: string; member?: string; needs: string[] }[] {
  const far = (hs: Hold[]) => hs.flatMap((h) => (h.kind === 'resource' && !reachable.has(h.needs) ? [h.needs] : []));
  return [
    ...b.flatMap((t) => { const n = far(holdsOf(t.id, b, cx)); return n.length ? [{ id: t.id, needs: n }] : []; }),
    ...liveMembers(b, cx).flatMap(({ t, m }) => { const n = far(m.holds); return n.length ? [{ id: t.id, member: m.id, needs: n }] : []; }),
  ];
}

/** The board's whole surface aggregated: `of` units in all, `met` of them at target, `unmet` the rest,
 *  and `byCarrier` the unmet count per responsible ticket (an unmet unit with no carrier under
 *  `uncovered`). Insertion order of `byCarrier` follows the order the carriers are first seen. */
export type Coverage = { of: number; met: number; unmet: number; byCarrier: Record<string, number> };

/** What the `coverage` hooks report, read once and never thrown out of: `units` = the units that
 *  validate, deduped by id (the first wins); the rest is what `check` reports — `threw` (a hook that
 *  threw: nothing it would report is counted), `invalid` (a unit left out for its shape, or a hook that
 *  returns no list; one line each) and `duplicates` (an id reported more than once, within a hook or
 *  across hooks, with every place it came from). */
export type CoverageEval = {
  units: CoverageUnit[];
  threw: string[];
  invalid: string[];
  duplicates: { id: string; at: string[] }[];
};

const UNIT_KEYS = ['id', 'met', 'carrier', 'note'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Shape problems of one reported unit, each starting with `: ` or `.field: `. */
function unitShape(u: unknown): string[] {
  if (!isObj(u)) return [': must be { id, met, carrier?, note? }'];
  const out: string[] = [];
  for (const k of Object.keys(u)) if (!UNIT_KEYS.includes(k)) out.push(`: field "${k}" is not allowed (allowed: ${UNIT_KEYS.join(', ')})`);
  if (!nonEmpty(u.id)) out.push('.id: a non-empty string is required');
  if (typeof u.met !== 'boolean') out.push('.met: must be true or false');
  for (const k of ['carrier', 'note']) if (u[k] !== undefined && !nonEmpty(u[k])) out.push(`.${k}: must be a non-empty string`);
  return out;
}

/** Every `coverage` hook, called once each with its throw caught (`CoverageEval`). */
export function evalCoverage(cx: Ctx): CoverageEval {
  const out: CoverageEval = { units: [], threw: [], invalid: [], duplicates: [] };
  const places = new Map<string, string[]>();
  cx.config.extensions.forEach((e, i) => {
    if (!e.coverage) return;
    const hook = `config.extensions[${i}].coverage`;
    let raw: unknown;
    try { raw = e.coverage(cx); } catch (x) { out.threw.push(`${hook} threw: ${x instanceof Error ? x.message : String(x)}`); return; }
    if (!Array.isArray(raw)) { out.invalid.push(`${hook}: must return a list of { id, met, carrier?, note? }`); return; }
    raw.forEach((u, j) => {
      const at = `${hook}[${j}]`;
      const p = unitShape(u);
      if (p.length) { out.invalid.push(`${at}${isObj(u) && nonEmpty(u.id) ? ` (${u.id})` : ''}${p.join('; ')}`); return; }
      const unit = u as CoverageUnit;
      const seen = places.get(unit.id);
      if (seen) { seen.push(at); return; }
      places.set(unit.id, [at]);
      out.units.push(unit);
    });
  });
  out.duplicates = [...places].filter(([, at]) => at.length > 1).map(([id, at]) => ({ id, at }));
  return out;
}

/** Counts over validated, deduped units. */
export function tallyCoverage(units: readonly CoverageUnit[]): Coverage {
  const byCarrier: Record<string, number> = {};
  let met = 0;
  for (const u of units) {
    if (u.met) { met += 1; continue; }
    const key = u.carrier ?? 'uncovered';
    byCarrier[key] = (byCarrier[key] ?? 0) + 1;
  }
  return { of: units.length, met, unmet: units.length - met, byCarrier };
}

/** The board's whole surface counted: every `coverage` hook's units that validate, deduped by id (the
 *  first wins; `check` reports the duplicate, the invalid unit and the hook that threw). A board whose
 *  extensions provide no `coverage` hook reports an empty surface — `{ of: 0, met: 0, unmet: 0, byCarrier: {} }`. */
export const coverageOf = (cx: Ctx): Coverage => tallyCoverage(evalCoverage(cx).units);

/** The reverse of the holds: for each ticket or resource, the live tickets waiting on it — directly,
 *  or through one of their members — in priority order. Derived, never stored — a stored reverse link
 *  would drift from the forward one. */
export function dependents(b: Board, cx: Ctx): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const t of b) {
    const member = isLive(t) ? (membersOf(t.id, b, cx)?.unmet ?? []).flatMap((m) => m.holds) : [];
    for (const h of [...holdsOf(t.id, b, cx), ...member]) {
      const on = h.kind === 'ticket' ? h.id : h.kind === 'resource' ? h.needs : undefined;
      if (on && on !== t.id && !(out.get(on) ?? []).includes(t.id)) out.set(on, [...(out.get(on) ?? []), t.id]);
    }
  }
  return out;
}

/** Cycles among ticket holds (each reported once, as the path that closes it). */
export function cycles(b: Board, cx: Ctx): string[][] {
  const edges = new Map(b.map((t) => [t.id, holdsOf(t.id, b, cx).flatMap((h) => (h.kind === 'ticket' ? [h.id] : []))]));
  const state = new Map<string, 1 | 2>();
  const found = new Map<string, string[]>();
  const visit = (id: string, path: string[]) => {
    state.set(id, 1);
    for (const next of edges.get(id) ?? []) {
      if (state.get(next) === 1) {
        const loop = [...path.slice(path.indexOf(next)), next];
        found.set([...new Set(loop)].sort().join(' '), loop);
      } else if (!state.has(next)) visit(next, [...path, next]);
    }
    state.set(id, 2);
  };
  for (const t of b) if (!state.has(t.id)) visit(t.id, [t.id]);
  return [...found.values()];
}

/** A doneWhen in a few words, for the view and `next`. */
export function describeDone(d: DoneWhen, cx: Ctx): string {
  switch (d.kind) {
    case 'test': return `test "${(d as { name: string }).name}" in ${(d as { file: string }).file}`;
    case 'answer': return `answer marked in ${(d as { doc: string }).doc}`;
    case 'judgment': return `(judgment) ${(d as { when: string }).when}`;
    default: return doneKind(d.kind, cx)?.describe(d as never) ?? d.kind;
  }
}

/** One hold in a few words. */
export function describeHold(h: Hold): string {
  switch (h.kind) {
    case 'owner': return `owner, since ${h.since} — ${h.ask}`;
    case 'go': return `owner go needed, since ${h.since} — ${h.ask}`;
    case 'external': return `external: ${h.who} — ${h.what}${h.recheck ? ` (recheck ${h.recheck})` : ''}`;
    case 'window': return `in-window only — ${describeWindow(h)}`;
    case 'resource': return `needs ${h.needs} (← ${h.via})`;
    case 'ticket': return `waits on ${h.id} (← ${h.via})`;
    case 'claim': return `claimed by ${h.to}${h.branch ? ` on ${h.branch}` : ''} since ${h.at} (${h.host}${h.by ? `, session ${h.by}` : ''})`;
    default: return JSON.stringify(h);
  }
}

/** Holds in a few words; consecutive ticket holds from the same source read as one. */
export function describeHolds(hs: Hold[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < hs.length; i++) {
    const h = hs[i];
    if (h.kind !== 'ticket') { out.push(describeHold(h)); continue; }
    const ids = [h.id];
    while (i + 1 < hs.length && hs[i + 1].kind === 'ticket' && (hs[i + 1] as { via: string }).via === h.via) ids.push((hs[++i] as { id: string }).id);
    out.push(`waits on ${ids.join(', ')} (← ${h.via})`);
  }
  return out;
}

/** Why nothing is workable here — the long-run stop code — or null when something is.
 *  Each live ticket is weighed by what holds it now; a ticket with unmet members counts once per
 *  member, held by its own holds plus that member's. Only those held by something other than another
 *  ticket are classified (one that merely waits on other tickets follows them); paused tickets are
 *  outside. A clock (a window, a future recheck) is never a blocker, only a schedule, so it is left
 *  out when judging what a ticket or member waits on. In order:
 *    no live ticket left                                          → queue-empty
 *    every ticket waits on an owner go, apart from clocks         → needs-authorization
 *    some ticket waits only on a clock                            → clock-gated, until the soonest
 *    anything else                                                → needs-human
 *  A resource this machine hosts never reaches here: it is reachable, so its hold does not stand.
 *  Claimed work is in progress, not waiting: a claimed ticket or member is left out of the weighing, and
 *  so is a ticket whose every unit waits only on in-progress tickets. With nothing else left that is
 *  queue-empty — for this session; `next` lists the claims, which are what to wait for. */
export function stopOf(b: Board, reachable: ReadonlySet<string>, cx: Ctx, now: number = Date.now(), scope?: ReadonlySet<string>): Stop | null {
  const inScope = (t: Ticket) => !scope || scope.has(t.id);
  if (actionable(b, reachable, cx, now).some(inScope)) return null;
  const live = b.filter(isLive).filter(inScope);
  if (!live.length) return { code: 'queue-empty' };
  const standing = (hs: Hold[]) => hs.filter((h) => stands(h, b, reachable, now));
  const units = live.map((t) => {
    const own = standing(holdsOf(t.id, b, cx));
    const unmet = membersOf(t.id, b, cx)?.unmet ?? [];
    return { id: t.id, held: unmet.length ? unmet.map((m) => [...own, ...standing(m.holds)]) : [own] };
  });
  const busy = new Set<string>();
  const passive = (hs: Hold[]) => hs.some((h) => h.kind === 'claim') || (hs.length > 0 && hs.every((h) => h.kind === 'ticket' && busy.has(h.id)));
  for (let grew = cx.claims?.size ? true : false; grew;) {
    grew = false;
    for (const u of units) if (!busy.has(u.id) && u.held.every(passive)) { busy.add(u.id); grew = true; }
  }
  const held = units.flatMap((u) => u.held.filter((hs) => !passive(hs)));
  if (!held.length) return { code: 'queue-empty' };
  const classified = held.filter((hs) => hs.some((h) => h.kind !== 'ticket'));
  if (!classified.length) return { code: 'needs-human' };
  const gates = (hs: Hold[]) => hs.filter((h) => h.kind !== 'ticket' && !isClock(h, now));
  if (classified.every((hs) => { const g = gates(hs); return g.length > 0 && g.every((h) => h.kind === 'go'); })) {
    return { code: 'needs-authorization' };
  }
  let soonest: { ms: number; iso: string } | undefined;
  for (const hs of classified) {
    if (!hs.every((h) => isClock(h, now))) continue;
    // all of a ticket's clock holds must clear: the latest of them
    const times = hs.map((h) => clearsAt(h, now) ?? { ms: Infinity, iso: '' });
    const at = times.reduce((a, c) => (c.ms > a.ms ? c : a));
    if (at.ms !== Infinity && (!soonest || at.ms < soonest.ms)) soonest = at;
  }
  if (soonest) return { code: 'clock-gated', until: soonest.iso };
  return { code: 'needs-human' };
}

/** Probe helpers for config.resources. A probe must never change state. */
export const probes = {
  /** Usable when the path exists (`~/` = home; relative = the repo root, where the CLI runs). */
  path: (p: string) => (): Probe => {
    const abs = p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
    return existsSync(abs) ? { here: true, usable: true } : { here: false, usable: false, note: `${p} not found` };
  },
  /** Usable when the command exits 0. Not found / timed out = not here. Any other exit = not here,
   *  unless `hosted: true` (this machine has it, it is just down: an agent bring-up step). */
  cmd: (argv: string[], opts: { timeoutMs?: number; hosted?: boolean } = {}) => (): Probe => {
    const r = spawnSync(argv[0], argv.slice(1), { stdio: 'ignore', timeout: opts.timeoutMs ?? 5000 });
    if (r.error) return { here: false, usable: false, note: `${argv[0]}: ${(r.error as NodeJS.ErrnoException).code ?? r.error.message}` };
    if (r.status === 0) return { here: true, usable: true };
    return { here: !!opts.hosted, usable: false, note: `${argv.join(' ')} exited ${r.status ?? r.signal}` };
  },
};
