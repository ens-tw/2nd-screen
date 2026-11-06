// Members: the parts of a ticket's done condition — the APIs of a ledger, the files of a list — that an
// extension done kind reports with its verdict (`met` → `members`), each met or not, an unmet one with
// what holds it. A ticket with members is worked member by member: `next` offers its topmost workable
// member, and the view and `show` summarise the rest by what holds them — generated from the data the
// members come from, so no hand-written umbrella line goes stale.
//
// A member's holds are a ticket's holds (owner / go / external, a window, a resource, a ticket), checked
// here with the same rules a board's blockers and windows are. This module reads the done kind's answer
// only; the board-level derivations (resources from refs, the ticket that covers a member, what is
// workable, the stop code, the summary) live in lib.mts.
import type { Ctx, DoneKind, Member, OwnerAs, Ticket } from './types.mts';
import { isDay, windowProblems } from './windows.mts';

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The extension that defines a doneWhen kind, if any. */
export const doneKind = (kind: string, cx: Ctx): DoneKind | undefined => {
  for (const e of cx.config.extensions) if (e.doneKinds && own(e.doneKinds, kind)) return e.doneKinds[kind];
  return undefined;
};

/** Shape problems of one blocker (owner / go / external), each starting with `: ` or `.field: `. */
export const OWNER_AS: readonly OwnerAs[] = ['hands', 'decision', 'errand'];

export function blockerProblems(b: unknown): string[] {
  if (!isObj(b)) return [': must be { kind: owner | go | external, … }'];
  const allowed: Record<string, string[]> = { owner: ['ask', 'since', 'as'], go: ['ask', 'since'], external: ['who', 'what', 'recheck'] };
  const kind = b.kind;
  if (typeof kind !== 'string' || !allowed[kind]) return [`.kind: ${JSON.stringify(kind)} is not owner, go or external`];
  const out: string[] = [];
  for (const k of Object.keys(b)) if (k !== 'kind' && !allowed[kind].includes(k)) out.push(`: field "${k}" is not allowed for a ${kind} blocker (allowed: ${allowed[kind].join(', ')})`);
  if (kind === 'external') {
    for (const k of ['who', 'what']) if (!nonEmpty(b[k])) out.push(`.${k}: a non-empty string is required`);
    if (b.recheck !== undefined && !isDay(b.recheck)) out.push(`.recheck: ${JSON.stringify(b.recheck)} is not a calendar day (YYYY-MM-DD)`);
  } else {
    if (!nonEmpty(b.ask)) out.push('.ask: a non-empty string is required');
    if (!isDay(b.since)) out.push(`.since: ${JSON.stringify(b.since)} is not a calendar day (YYYY-MM-DD) — the day it was first asked`);
    if (kind === 'owner' && b.as !== undefined && !(OWNER_AS as readonly unknown[]).includes(b.as)) out.push(`.as: ${JSON.stringify(b.as)} is not ${OWNER_AS.join(', ')}`);
  }
  return out;
}

const fieldsOf = (h: Record<string, unknown>, allowed: string[], kind: string): string[] =>
  Object.keys(h).filter((k) => k !== 'kind' && !allowed.includes(k)).map((k) => `: field "${k}" is not allowed for a ${kind} hold (allowed: ${allowed.join(', ')})`);

/** Shape problems of one member hold: a blocker, a window, a resource config.resources names, or a
 *  ticket (an id — whether it is on the board is `check`'s). Each starts with `: ` or `.field: `. */
export function holdProblems(h: unknown, cx: Ctx): string[] {
  if (!isObj(h)) return [': must be { kind: owner | go | external | window | resource | ticket, … }'];
  switch (h.kind) {
    case 'owner': case 'go': case 'external': return blockerProblems(h);
    case 'window': {
      const { kind: _, ...w } = h;
      return windowProblems(w).map((m) => `.window: ${m}`);
    }
    case 'resource': {
      const out = fieldsOf(h, ['needs', 'via'], 'resource');
      const names = Object.keys(cx.config.resources);
      if (!nonEmpty(h.needs) || !own(cx.config.resources, h.needs)) out.push(`.needs: ${JSON.stringify(h.needs)} is not a key of config.resources${names.length ? ` (${names.join(', ')})` : ' (none configured)'}`);
      if (!nonEmpty(h.via)) out.push('.via: a non-empty string is required — where the hold comes from');
      return out;
    }
    case 'ticket': {
      const out = fieldsOf(h, ['id', 'via'], 'ticket');
      if (!nonEmpty(h.id)) out.push('.id: a ticket id is required');
      if (!nonEmpty(h.via)) out.push('.via: a non-empty string is required — why it waits on that ticket');
      return out;
    }
    default: return [`.kind: ${JSON.stringify(h.kind)} is not owner, go, external, window, resource or ticket`];
  }
}

export function authorizationNamesProblems(names: unknown, cx: Ctx): string[] {
  if (names === undefined) return [];
  if (!Array.isArray(names) || !names.length || !names.every(nonEmpty)) return ['must be a non-empty list of authorization names'];
  const out = new Set(names).size === names.length ? [] : ['a name is listed twice'];
  for (const n of names) if (!own(cx.config.authorizations, n)) out.push(`"${n}" is not a key of config.authorizations`);
  return out;
}

/** Problems of a `touches` list (ticket or member), each a complete sentence fragment. */
export function touchesProblems(v: unknown): string[] {
  if (!Array.isArray(v)) return ['must be a list of repo paths or @names ([] = the work changes no repo file)'];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !x.trim()) { out.push('every entry must be a non-empty string'); continue; }
    if (x.startsWith('@') ? !/^@[\w.:-]+$/.test(x) : x.startsWith('/') || x.split('/').includes('..')) out.push(`"${x}" is neither a repo path nor an @name`);
  }
  if (new Set(v).size !== v.length) out.push('an entry is listed twice');
  return out;
}

const MEMBER_KEYS = ['id', 'met', 'holds', 'refs', 'note', 'authorizations', 'touches'];

/** Shape problems of one reported member, each starting with `: ` or `.field: `. */
function memberShape(m: unknown, cx: Ctx): string[] {
  if (!isObj(m)) return [': must be { id, met, holds?, refs?, note? }'];
  const out: string[] = [];
  for (const k of Object.keys(m)) if (!MEMBER_KEYS.includes(k)) out.push(`: field "${k}" is not allowed (allowed: ${MEMBER_KEYS.join(', ')})`);
  if (!nonEmpty(m.id)) out.push('.id: a non-empty string is required');
  if (typeof m.met !== 'boolean') out.push('.met: must be true or false');
  if (m.note !== undefined && !nonEmpty(m.note)) out.push('.note: must be a non-empty string');
  for (const p of authorizationNamesProblems(m.authorizations, cx)) out.push(`.authorizations: ${p}`);
  if (m.refs !== undefined && (!Array.isArray(m.refs) || !m.refs.every(nonEmpty))) out.push('.refs: must be a list of repo paths');
  if (m.touches !== undefined) for (const p of touchesProblems(m.touches)) out.push(`.touches: ${p}`);
  if (m.holds !== undefined) {
    if (!Array.isArray(m.holds)) out.push('.holds: must be a list of holds');
    else m.holds.forEach((h, i) => { for (const p of holdProblems(h, cx)) out.push(`.holds[${i}]${p}`); });
  }
  return out;
}

/** What a done kind reports about its members: the verdict it gave, the members that validate (in the
 *  order reported) and, per member left out, its problems in one line — `check` reports those. */
export type Members = { met: boolean; members: Member[]; problems: string[] };

const cache = new WeakMap<Ctx, WeakMap<object, Members | null>>();

/** The members a ticket's done condition reports, or undefined when it reports none: a built-in kind, or
 *  a `met` that returns no `members`, is not checkable, or throws (`check` reports the throw). A member
 *  that does not validate is left out, named in `problems`. Evaluated once per ticket object and
 *  context — a command reads the repo once, and every derivation asks again. */
export function evalMembers(t: Ticket, cx: Ctx): Members | undefined {
  if (t.status === 'dropped' || !isObj(t.doneWhen)) return undefined;
  let per = cache.get(cx);
  if (!per) cache.set(cx, (per = new WeakMap()));
  if (per.has(t)) return per.get(t) ?? undefined;
  let out: Members | null = null;
  const dk = typeof t.doneWhen.kind === 'string' ? doneKind(t.doneWhen.kind, cx) : undefined;
  if (dk) {
    try {
      const v = dk.met(t.doneWhen as never, t, cx) as { met: boolean; members?: unknown } | undefined;
      if (v && v.members !== undefined) {
        out = Array.isArray(v.members) ? checked(!!v.met, v.members, cx) : { met: !!v.met, members: [], problems: ['members: must be a list of { id, met, holds?, refs?, note? }'] };
      }
    } catch { /* the done check threw: check reports it */ }
  }
  per.set(t, out);
  return out ?? undefined;
}

function checked(met: boolean, raw: unknown[], cx: Ctx): Members {
  const members: Member[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  raw.forEach((m, i) => {
    const at = isObj(m) && nonEmpty(m.id) ? `members[${i}] (${m.id})` : `members[${i}]`;
    const p = memberShape(m, cx);
    if (!p.length && seen.has((m as Member).id)) p.push(': the id is reported twice');
    if (p.length) { problems.push(`${at}${p.join('; ')}`); return; }
    seen.add((m as Member).id);
    members.push(m as Member);
  });
  return { met, members, problems };
}
