// Run-time validation of tickets/config.mts and tickets/board.mts — the source of truth for their
// shape, since many repos that keep a board have no type checker. Every problem names the ticket and
// the field. Prose caps are not checked here (they are `check` findings), so a migrated draft can
// load while its prose still needs trimming.
import type { Ctx, Problem, Ticket } from './types.mts';
import { authorizationNamesProblems, blockerProblems, doneKind, evalMembers, touchesProblems } from './members.mts';
import { isDay, windowProblems } from './windows.mts';

const STATUSES = ['open', 'paused', 'done', 'dropped'] as const;
/** Read as `open` (status-blocked-deprecated); not offered in messages. */
const LEGACY_BLOCKED = 'blocked';
const COMMON_REQ = ['id', 'title', 'why', 'status'];
const COMMON_OPT = ['refs', 'group', 'authorizations'];
const LIVE_OPT = ['wip', 'window', 'hazard', 'after', 'blockers', 'touches'];
const BY_STATUS: Record<string, { req: string[]; opt: string[] }> = {
  open: { req: ['doneWhen', 'next'], opt: LIVE_OPT },
  paused: { req: ['doneWhen', 'until'], opt: ['wip'] },
  done: { req: ['doneWhen', 'commit'], opt: [] },
  dropped: { req: ['reason'], opt: [] },
};
const PROSE = ['title', 'why', 'next', 'until', 'reason', 'hazard', 'wip', 'commit', 'group'];
const BUILTIN_DONE: Record<string, string[]> = { test: ['file', 'name'], answer: ['doc'], judgment: ['when'] };
const CONFIG_KEYS = ['ids', 'doc', 'main', 'groups', 'boxes', 'resources', 'authorizations', 'tests', 'caps', 'extensions', 'jev', 'claimStaleHours'];
const JEV_KEYS = ['tools', 'accept', 'flag', 'clear', 'review'];
const REVIEW_KEYS = ['accept', 'clear', 'flag', 'confidence', 'weights'];
const MATURITY_PARTS = ['spec_clear', 'done_checkable', 'next_evidenced', 'refs_present'];
const RESOURCE_KEYS = ['on', 'paths', 'policy', 'bringUp', 'probe'];
const HOOKS = ['doneKinds', 'holds', 'check', 'nextLines', 'reviewEvidence', 'coverage'];
const CAP_KEYS = ['title', 'why', 'next', 'until', 'reason', 'ask', 'what', 'when', 'name', 'window', 'hazard', 'policy', 'bringUp'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const fn = (v: unknown) => typeof v === 'function';

/** Problems with tickets/config.mts's default export (messages). Empty = it can be used. */
export function configProblems(raw: unknown): string[] {
  if (!isObj(raw)) return ['tickets/config.mts must `export default { ids: /…/, … } satisfies Config`'];
  const out: string[] = [];
  for (const k of Object.keys(raw)) if (!CONFIG_KEYS.includes(k)) out.push(`config: unknown key "${k}" (allowed: ${CONFIG_KEYS.join(', ')})`);
  if (!(raw.ids instanceof RegExp)) out.push('config.ids: must be a RegExp, e.g. /^T-\\d+$/');
  for (const k of ['doc', 'main']) if (raw[k] !== undefined && !nonEmpty(raw[k])) out.push(`config.${k}: must be a non-empty string`);
  if (raw.groups !== undefined) {
    if (!isObj(raw.groups)) out.push('config.groups: must be { key: label }');
    else for (const [k, v] of Object.entries(raw.groups)) if (!nonEmpty(v)) out.push(`config.groups.${k}: the label must be a non-empty string`);
  }
  const boxes = raw.boxes;
  if (raw.authorizations !== undefined) {
    if (!isObj(raw.authorizations)) out.push('config.authorizations: must be { name: { what, ask, since, grant? } }');
    else for (const [name, a] of Object.entries(raw.authorizations)) {
      const at = `config.authorizations.${name}`;
      if (!nonEmpty(name) || !isObj(a)) { out.push(`${at}: must have a non-empty name and an object definition`); continue; }
      for (const k of Object.keys(a)) if (!['what', 'ask', 'since', 'grant'].includes(k)) out.push(`${at}: unknown key "${k}"`);
      for (const k of ['what', 'ask']) if (!nonEmpty(a[k]) || a[k].length > 200) out.push(`${at}.${k}: must be a non-empty string of at most 200 characters`);
      if (!isDay(a.since)) out.push(`${at}.since: must be a calendar day (YYYY-MM-DD)`);
      if (a.grant !== undefined) {
        if (!isObj(a.grant)) out.push(`${at}.grant: must be { source, quote }`);
        else {
          for (const k of Object.keys(a.grant)) if (!['source', 'quote'].includes(k)) out.push(`${at}.grant: unknown key "${k}"`);
          for (const k of ['source', 'quote']) if (!nonEmpty(a.grant[k])) out.push(`${at}.grant.${k}: a non-empty string is required`);
          if (nonEmpty(a.grant.source) && (/^(?:\/|[A-Za-z]:[\\/])/.test(a.grant.source) || a.grant.source.split(/[\\/]/).includes('..'))) out.push(`${at}.grant.source: must be a repo-relative path without ..`);
        }
      }
    }
  }
  if (boxes !== undefined && (!Array.isArray(boxes) || !boxes.every(nonEmpty) || new Set(boxes).size !== boxes.length)) out.push('config.boxes: must be a list of distinct names');
  if (raw.resources !== undefined) {
    if (!isObj(raw.resources)) out.push('config.resources: must be { name: { paths, on?, policy?, bringUp?, probe? } }');
    else for (const [n, r] of Object.entries(raw.resources)) {
      if (!isObj(r)) { out.push(`config.resources.${n}: must be an object`); continue; }
      for (const k of Object.keys(r)) if (!RESOURCE_KEYS.includes(k)) out.push(`config.resources.${n}: unknown key "${k}" (allowed: ${RESOURCE_KEYS.join(', ')})`);
      if (!Array.isArray(r.paths) || !r.paths.length || !r.paths.every(nonEmpty)) out.push(`config.resources.${n}.paths: must be a non-empty list of repo paths (say where its docs and tools live)`);
      const on = r.on === undefined ? [] : Array.isArray(r.on) ? r.on : [r.on];
      if (!on.every(nonEmpty)) out.push(`config.resources.${n}.on: must be a box name or a list of them`);
      else if (Array.isArray(boxes) && boxes.length) for (const b of on) if (!boxes.includes(b)) out.push(`config.resources.${n}.on: "${b}" is not in config.boxes`);
      for (const k of ['policy', 'bringUp']) if (r[k] !== undefined && !nonEmpty(r[k])) out.push(`config.resources.${n}.${k}: must be a non-empty string`);
      if (r.probe !== undefined && !fn(r.probe)) out.push(`config.resources.${n}.probe: must be a function returning { here, usable, note? }`);
    }
  }
  if (raw.claimStaleHours !== undefined && !(typeof raw.claimStaleHours === 'number' && Number.isFinite(raw.claimStaleHours) && raw.claimStaleHours > 0)) out.push('config.claimStaleHours: must be a positive number of hours');
  if (raw.tests !== undefined && raw.tests !== 'node-test' && raw.tests !== 'ctest' && !fn(raw.tests)) out.push(`config.tests: must be 'node-test', 'ctest' or a function (d, io) => { met, why? }`);
  if (raw.caps !== undefined) {
    if (!isObj(raw.caps)) out.push('config.caps: must be { field: number }');
    else for (const [k, v] of Object.entries(raw.caps)) {
      if (!CAP_KEYS.includes(k)) out.push(`config.caps: unknown field "${k}" (allowed: ${CAP_KEYS.join(', ')})`);
      else if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) out.push(`config.caps.${k}: must be a positive integer`);
    }
  }
  if (raw.extensions !== undefined) {
    if (!Array.isArray(raw.extensions)) out.push('config.extensions: must be a list');
    else raw.extensions.forEach((e, i) => {
      if (!isObj(e)) { out.push(`config.extensions[${i}]: must be an object`); return; }
      for (const k of Object.keys(e)) if (!HOOKS.includes(k)) out.push(`config.extensions[${i}]: unknown hook "${k}" — the hooks are exactly ${HOOKS.join(', ')}`);
      for (const k of ['holds', 'check', 'nextLines', 'reviewEvidence', 'coverage']) if (e[k] !== undefined && !fn(e[k])) out.push(`config.extensions[${i}].${k}: must be a function`);
      if (e.doneKinds !== undefined) {
        if (!isObj(e.doneKinds)) out.push(`config.extensions[${i}].doneKinds: must be { kind: { validate, met, describe, now? } }`);
        else for (const [kind, dk] of Object.entries(e.doneKinds)) {
          if (kind in BUILTIN_DONE) out.push(`config.extensions[${i}].doneKinds.${kind}: shadows a built-in kind`);
          if (!isObj(dk) || !fn(dk.validate) || !fn(dk.met) || !fn(dk.describe) || (dk.now !== undefined && !fn(dk.now))) {
            out.push(`config.extensions[${i}].doneKinds.${kind}: must have validate, met and describe functions (now optional)`);
          }
        }
      }
    });
  }
  if (raw.jev !== undefined) {
    const j = raw.jev;
    if (!isObj(j)) out.push('config.jev: must be { tools?, accept?, flag?, clear?, review? }');
    else {
      for (const k of Object.keys(j)) if (!JEV_KEYS.includes(k)) out.push(`config.jev: unknown key "${k}" (allowed: ${JEV_KEYS.join(', ')})`);
      if (j.tools !== undefined && (!Array.isArray(j.tools) || !j.tools.every(nonEmpty))) out.push('config.jev.tools: must be a list of what an agent can drive here');
      const p = (v: unknown) => typeof v === 'number' && v > 0 && v < 1;
      for (const k of ['accept', 'flag', 'clear']) if (j[k] !== undefined && !p(j[k])) out.push(`config.jev.${k}: must be a number between 0 and 1`);
      if (p(j.clear) && p(j.flag) && (j.clear as number) >= (j.flag as number)) out.push('config.jev: clear must be below flag (the mid band lies between them)');
      else if (p(j.clear) && j.flag === undefined && (j.clear as number) >= 0.7) out.push('config.jev.clear: must be below flag (default 0.7)');
      else if (p(j.flag) && j.clear === undefined && (j.flag as number) <= 0.3) out.push('config.jev.flag: must be above clear (default 0.3)');
      if (j.review !== undefined) out.push(...reviewProblems(j.review));
    }
  }
  return out;
}

/** config.jev.review: thresholds between 0 and 1 (clear below flag), weights ≥ 0 with one above 0. */
function reviewProblems(r: unknown): string[] {
  if (!isObj(r)) return ['config.jev.review: must be { accept?, clear?, flag?, confidence?, weights? }'];
  const out: string[] = [];
  for (const k of Object.keys(r)) if (!REVIEW_KEYS.includes(k)) out.push(`config.jev.review: unknown key "${k}" (allowed: ${REVIEW_KEYS.join(', ')})`);
  const p = (v: unknown) => typeof v === 'number' && v > 0 && v < 1;
  for (const k of ['accept', 'clear', 'flag', 'confidence']) if (r[k] !== undefined && !p(r[k])) out.push(`config.jev.review.${k}: must be a number between 0 and 1`);
  const clear = p(r.clear) ? (r.clear as number) : 0.3, flag = p(r.flag) ? (r.flag as number) : 0.7;
  if ((p(r.clear) || p(r.flag)) && clear >= flag) out.push(`config.jev.review: clear (${clear}) must be below flag (${flag}) — the mid band lies between them`);
  if (r.weights !== undefined) {
    if (!isObj(r.weights)) out.push(`config.jev.review.weights: must be { ${MATURITY_PARTS.join(', ')} } (numbers ≥ 0)`);
    else {
      for (const [k, v] of Object.entries(r.weights)) {
        if (!MATURITY_PARTS.includes(k)) out.push(`config.jev.review.weights: unknown part "${k}" (allowed: ${MATURITY_PARTS.join(', ')})`);
        else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) out.push(`config.jev.review.weights.${k}: must be a number ≥ 0`);
      }
      const merged = MATURITY_PARTS.map((k) => (r.weights as Record<string, unknown>)[k] ?? 1);
      if (merged.every((v) => v === 0)) out.push('config.jev.review.weights: at least one weight must be above 0');
    }
  }
  return out;
}

/** Shape problems of the board (errors). Assumes a valid config. */
export function boardProblems(raw: unknown, cx: Ctx): Problem[] {
  const out: Problem[] = [];
  if (!Array.isArray(raw)) return [{ level: 'error', message: 'tickets/board.mts must `export default [ … ] satisfies Board` — an array, in priority order' }];
  const groups = cx.config.groups;
  const ids = new Set<string>();
  const seen = new Set<string>();
  for (const t of raw) if (isObj(t) && typeof t.id === 'string') { if (ids.has(t.id)) seen.add(t.id); ids.add(t.id); }
  for (const id of seen) out.push({ level: 'error', id, message: `id "${id}" is used by more than one ticket` });
  for (const g of Object.keys(groups)) if (ids.has(g)) out.push({ level: 'error', id: g, message: `"${g}" is both a ticket id and a group key — an after target would be ambiguous` });

  raw.forEach((t, i) => {
    const err = (message: string, id = isObj(t) && typeof t.id === 'string' ? t.id : `#${i + 1}`) => out.push({ level: 'error', id, message });
    if (!isObj(t)) { err('a ticket must be an object'); return; }
    if (typeof t.id !== 'string' || !t.id) { err('id: a non-empty string is required'); return; }
    if (!cx.config.ids.test(t.id)) err(`id "${t.id}" does not match config.ids ${cx.config.ids}`);
    const status = t.status === LEGACY_BLOCKED ? 'open' : t.status;
    if (typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status)) {
      err(`status: ${JSON.stringify(t.status)} is not one of ${STATUSES.join(', ')}`);
      return;
    }
    if (t.status === LEGACY_BLOCKED && t.blockers === undefined) err(`blockers: required for status blocked (read as open since 0.12.0 — write status: 'open')`);
    const spec = BY_STATUS[status];
    const allowed = [...COMMON_REQ, ...COMMON_OPT, ...spec.req, ...spec.opt];
    const done = t.doneWhen !== undefined ? doneProblems(t.doneWhen, cx) : [];
    // A ticket whose done condition reports members may leave `next` out: `next` prints its members.
    const optional = (k: string) => k === 'next' && t.doneWhen !== undefined && !done.length && evalMembers(t as Ticket, cx) !== undefined;
    for (const k of Object.keys(t)) if (!allowed.includes(k)) err(`field "${k}" is not allowed for status ${status} (allowed: ${allowed.join(', ')})`);
    for (const k of [...COMMON_REQ, ...spec.req]) if (t[k] === undefined && !optional(k)) err(`${k}: required for status ${status}`);
    for (const k of PROSE) if (t[k] !== undefined && !nonEmpty(t[k])) err(`${k}: must be a non-empty string`);
    if (t.refs !== undefined && (!Array.isArray(t.refs) || !t.refs.every(nonEmpty))) err('refs: must be a list of repo paths');
    if (t.touches !== undefined) for (const m of touchesProblems(t.touches)) err(`touches: ${m}`);
    for (const m of authorizationNamesProblems(t.authorizations, cx)) err(`authorizations: ${m}`);
    if (t.group !== undefined && nonEmpty(t.group) && !Object.prototype.hasOwnProperty.call(groups, t.group)) {
      err(`group "${t.group}" is not a key of config.groups${Object.keys(groups).length ? ` (${Object.keys(groups).join(', ')})` : ' (none configured)'}`);
    }
    for (const m of done) err(`doneWhen${m}`);
    if (t.blockers !== undefined) {
      if (!Array.isArray(t.blockers) || !t.blockers.length) err('blockers: list at least one blocker (owner / go / external), or leave the field out');
      else t.blockers.forEach((b, j) => { for (const m of blockerProblems(b)) err(`blockers[${j}]${m}`); });
    }
    if (t.window !== undefined) for (const m of windowProblems(t.window)) err(`window: ${m}`);
    for (const [path, s] of strings(t)) {
      if (!s.includes('<!--')) continue;
      err(/<!--\s*answer:/.test(s)
        ? `${path}: carries an answer marker (<!-- answer: … -->) — the marker belongs in the answer doc; on the board it vanishes from the view, and a doc holding the view would answer the ticket by itself`
        : `${path}: carries an HTML comment (<!-- … -->) — it vanishes from the generated view; write plain text`);
    }
    if (t.after !== undefined) {
      if (!Array.isArray(t.after) || !t.after.length || !t.after.every(nonEmpty)) err('after: must be a non-empty list of ticket ids or group keys');
      else {
        if (new Set(t.after).size !== t.after.length) err('after: a target is listed twice');
        for (const a of t.after as string[]) {
          if (a === t.id) err('after: a ticket cannot wait on itself');
          else if (!ids.has(a) && !Object.prototype.hasOwnProperty.call(groups, a)) err(`after: "${a}" is neither a ticket id nor a group key`);
        }
      }
    }
  });
  return out;
}

/** The board as the engine reads it: a ticket written as `status: 'blocked'` (before 0.12.0) becomes
 *  `open` with the same fields, and its id is listed for the deprecation warning. Run after boardProblems
 *  finds no error. */
export function normalizeBoard(raw: readonly unknown[]): { board: Ticket[]; legacyBlocked: string[] } {
  const legacyBlocked: string[] = [];
  const board = raw.map((t) => {
    if (!isObj(t) || t.status !== LEGACY_BLOCKED) return t as Ticket;
    legacyBlocked.push(t.id as string);
    return { ...t, status: 'open' } as Ticket;
  });
  return { board, legacyBlocked };
}

/** Every string inside a ticket, with its path (`next`, `blockers[0].ask`, `doneWhen.when`). */
function strings(v: unknown, path = ''): [string, string][] {
  if (typeof v === 'string') return [[path, v]];
  if (Array.isArray(v)) return v.flatMap((x, i) => strings(x, `${path}[${i}]`));
  if (isObj(v)) return Object.entries(v).flatMap(([k, x]) => strings(x, path ? `${path}.${k}` : k));
  return [];
}

/** Problems of one doneWhen, each starting with `: ` or `.field: `. */
function doneProblems(d: unknown, cx: Ctx): string[] {
  if (!isObj(d) || typeof d.kind !== 'string') return [': must be { kind, … } (test / answer / judgment, or an extension kind)'];
  const fields = BUILTIN_DONE[d.kind];
  if (fields) {
    const out: string[] = [];
    for (const k of Object.keys(d)) if (k !== 'kind' && !fields.includes(k)) out.push(`: field "${k}" is not allowed for kind ${d.kind} (allowed: ${fields.join(', ')})`);
    for (const k of fields) if (!nonEmpty(d[k])) out.push(`.${k}: a non-empty string is required for kind ${d.kind}`);
    return out;
  }
  const ext = doneKind(d.kind, cx);
  if (!ext) return [`.kind: "${d.kind}" is not a known kind (test, answer, judgment${extKinds(cx)})`];
  try { return ext.validate(d as never, cx).map((m) => `: ${m}`); } catch (e) { return [`: the ${d.kind} validator threw: ${(e as Error).message}`]; }
}

const extKinds = (cx: Ctx) => cx.config.extensions.flatMap((e) => Object.keys(e.doneKinds ?? {})).map((k) => `, ${k}`).join('');
