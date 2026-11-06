// `check`: the board against the tree. Deterministic — it reads only the repo's files and git state,
// so one commit gives one answer on every machine. Findings that depend on the clock are warnings,
// never errors; probes never run here. Schema validation (validate.mts) runs before these.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Board, Claim, Ctx, Io, Met, Problem, TestDone, Ticket } from './types.mts';
import { relative } from 'node:path';
import { authorizationOf, byId, cycles, doneKind, evalCoverage, isLive, membersOf, refPath, reportersOf, statusPagePath } from './lib.mts';
import { evalMembers } from './members.mts';
import { hasMarkers } from './render.mts';
import { isRecurring, today } from './windows.mts';
import { engineHash, readVersion, sameVersion, showVersion } from './version.mts';
import { answersPath, blockerText, fingerprint, parseAnswers, routeBlockerItem } from './jev.mts';
import { claimProblems } from './claims.mts';

export type CheckOptions = {
  /** The clock, for the warnings that depend on it. */
  now?: number;
  /** The engine running this check (a skill copy is compared with the repo's pin). */
  engineDir?: string;
  /** Skill installs to compare with the repo's pinned engine (a differing one is a note). */
  skillDirs?: string[];
  /** This machine's claims (claims.mts readClaims), for the claim warnings — machine-local, so warnings
   *  only. Left out, no claim is looked at. */
  claims?: { claims: ReadonlyMap<string, Claim>; bad: string[] };
};

const err = (message: string, id?: string): Problem => ({ level: 'error', id, message });
const warn = (message: string, id?: string): Problem => ({ level: 'warning', id, message });
const note = (message: string, id?: string): Problem => ({ level: 'note', id, message });
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Short prose keeps narrative off the board: the story of the work goes in the commit message. */
export function capProblems(b: Board, cx: Ctx): Problem[] {
  const caps = cx.config.caps;
  const out: Problem[] = [];
  for (const t of b) {
    const fields: [keyof typeof caps, string, string][] = [['title', 'title', t.title], ['why', 'why', t.why]];
    if (isLive(t)) {
      fields.push(['next', 'next', t.next]);
      if (t.window) fields.push(['window', 'window.what', t.window.what]);
      if (t.hazard) fields.push(['hazard', 'hazard', t.hazard]);
    }
    if (t.status === 'paused') fields.push(['until', 'until', t.until]);
    if (t.status === 'dropped') fields.push(['reason', 'reason', t.reason]);
    if (isLive(t)) (t.blockers ?? []).forEach((bl, i) => {
      if (bl.kind === 'external') fields.push(['what', `blockers[${i}].what`, bl.what]);
      else fields.push(['ask', `blockers[${i}].ask`, bl.ask]);
    });
    if (t.status !== 'dropped') {
      const d = t.doneWhen as { kind: string; when?: string; name?: string };
      if (d.kind === 'judgment' && d.when) fields.push(['when', 'doneWhen.when', d.when]);
      if (d.kind === 'test' && d.name) fields.push(['name', 'doneWhen.name', d.name]);
    }
    for (const [cap, label, v] of fields) {
      if (typeof v === 'string' && v.length > caps[cap]) out.push(err(`${label} is ${v.length} chars (cap ${caps[cap]}) — put the detail in a doc and link it via refs`, t.id));
    }
  }
  for (const [name, r] of Object.entries(cx.config.resources)) {
    for (const k of ['policy', 'bringUp'] as const) {
      const v = r[k];
      if (v !== undefined && v.length > caps[k]) out.push(err(`resource ${name}.${k} is ${v.length} chars (cap ${caps[k]})`));
    }
  }
  return out;
}

/** Every ref is a path that exists (an `#anchor` / ` §x` suffix is ignored). */
export function refProblems(b: Board, cx: Ctx): Problem[] {
  return b.flatMap((t) => (t.refs ?? []).flatMap((r) => (cx.io.exists(refPath(r)) ? [] : [err(`ref ${r} does not exist`, t.id)])));
}

/** Every resource path exists. */
export function resourceProblems(cx: Ctx): Problem[] {
  return Object.entries(cx.config.resources).flatMap(([name, r]) =>
    r.paths.flatMap((p) => (cx.io.exists(p) ? [] : [err(`resource ${name}: path ${p} does not exist`)])));
}

/** Does the glob-free or simple-glob token `pat` (from a test script) cover `file`? */
function covers(pat: string, file: string): boolean {
  const clean = (s: string) => s.replace(/^['"]|['"]$/g, '').replace(/^\.\//, '');
  const p = clean(pat), f = clean(file);
  if (!p.includes('*')) return p === f;
  const glob = (x: string) => (x === '**/' ? '(?:.*/)?' : x === '**' ? '.*' : x === '*' ? '[^/]*' : esc(x));
  const re = new RegExp(`^${p.split(/(\*\*\/?|\*)/).map(glob).join('')}$`);
  return re.test(f);
}

/** `node-test`: the file has `test('<name>'` (any quote) AND package.json's scripts.test runs it. */
export function nodeTestRule(d: TestDone, io: Io): Met {
  const there = new RegExp(`\\btest\\(\\s*(['"\`])${esc(d.name)}\\1`).test(io.read(d.file));
  let script = '';
  try { script = String(JSON.parse(io.read('package.json') || '{}')?.scripts?.test ?? ''); } catch { /* unreadable */ }
  const runs = script.includes(d.file) || script.split(/\s+/).some((tok) => covers(tok, d.file));
  if (!io.exists(d.file)) return { met: false, why: `${d.file} does not exist` };
  if (!there) return { met: false, why: `no test "${d.name}" in ${d.file}` };
  return runs ? { met: true, why: `test "${d.name}" in ${d.file} runs in the test script` } : { met: false, why: `${d.file} is not run by package.json scripts.test` };
}

/** `ctest`: the file exists AND a git-tracked CMakeLists.txt has `add_test(NAME <name>` and names the
 *  file (its basename, or the basename without extension). Undefined without git. */
export function ctestRule(d: TestDone, io: Io): Met | undefined {
  if (!io.exists(d.file)) return { met: false, why: `${d.file} does not exist` };
  if (!io.hasGit) return undefined;
  const lists = io.git('ls-files', '--', '*CMakeLists.txt').out.split('\n').filter(Boolean);
  const base = basename(d.file), stem = base.replace(/\.[^.]+$/, '');
  const re = new RegExp(`add_test\\s*\\(\\s*NAME\\s+"?${esc(d.name)}"?(?=[\\s)])`);
  for (const l of lists) {
    const s = io.read(l);
    if (re.test(s) && (s.includes(base) || s.includes(stem))) return { met: true, why: `add_test(NAME ${d.name}) in ${l} names ${base}` };
  }
  return { met: false, why: `no tracked CMakeLists.txt has add_test(NAME ${d.name}) naming ${base}` };
}

/** Is a ticket's done condition met? Undefined = not checkable (judgment, ctest without git, or an
 *  extension kind that says so). */
export function metOf(t: Ticket, cx: Ctx): Met | undefined {
  if (t.status === 'dropped') return undefined;
  const d = t.doneWhen as { kind: string; [k: string]: unknown };
  switch (d.kind) {
    case 'judgment': return undefined;
    case 'answer': {
      const doc = d.doc as string;
      const there = cx.io.read(doc).includes(`<!-- answer: ${t.id} -->`);
      return { met: there, why: there ? `${doc} carries the answer marker` : `no <!-- answer: ${t.id} --> in ${doc}` };
    }
    case 'test': {
      const rule = cx.config.tests;
      if (!rule) return undefined;
      if (rule === 'node-test') return nodeTestRule(d as TestDone, cx.io);
      if (rule === 'ctest') return ctestRule(d as TestDone, cx.io);
      return rule(d as TestDone, cx.io);
    }
    default: return doneKind(d.kind, cx)?.met(d as never, t, cx);
  }
}

/** Status agrees with the done condition: open but met = stale (close it); done but not met = drift. */
export function doneStateProblems(b: Board, cx: Ctx): Problem[] {
  const out: Problem[] = [];
  if (!cx.config.tests && b.some((t) => t.status !== 'dropped' && t.doneWhen.kind === 'test')) {
    out.push(err("config.tests is not set — say how a test doneWhen is found ('node-test', 'ctest' or a function)"));
  }
  if (cx.config.tests === 'ctest' && !cx.io.hasGit && b.some((t) => t.status !== 'dropped' && t.doneWhen.kind === 'test')) {
    out.push(note('no git checkout — test doneWhen conditions (ctest) were not checked'));
  }
  for (const t of b) {
    let m: Met | undefined;
    try { m = metOf(t, cx); } catch (e) { out.push(err(`the done check threw: ${(e as Error).message}`, t.id)); continue; }
    if (!m) continue;
    const why = m.why ? ` (${m.why})` : '';
    if (t.status === 'done' && !m.met) out.push(err(`is done but its done condition is not met${why} — drift, reopen it or fix the regression`, t.id));
    if (t.status !== 'done' && t.status !== 'dropped' && m.met) out.push(err(`is ${t.status} but its done condition is met${why} — stale, close it (status 'done' + the commit)`, t.id));
  }
  return out;
}

/** Members (a done kind that reports them): a member left out for its shape, a member ref that does not
 *  exist, a member waiting on a ticket that is not on the board, is dropped or is its own, and `met`
 *  disagreeing with the members are errors. Two warnings keep an umbrella honest:
 *    next-overridden-by-members — a hand-written `next` on a live ticket with members: `next`, `show` and
 *      the view print the generated summary instead, so the line can only go stale; drop it.
 *    member-uncovered — unmet members of a live ticket with no hold at all, that no other open
 *      or paused ticket's done condition names: nothing records what stands between them and work. Any
 *      hold counts, a window too — the finding reads no clock and no probe, so it stays one answer per
 *      commit. */
export function memberProblems(b: Board, cx: Ctx): Problem[] {
  const out: Problem[] = [];
  const ids = byId(b);
  for (const t of b) {
    const ev = evalMembers(t, cx);
    if (!ev) continue;
    for (const p of ev.problems) out.push(err(`member-invalid: ${p} — left out of next, show and the view`, t.id));
    const unmet = ev.members.filter((m) => !m.met);
    if (ev.members.length && ev.met === (unmet.length > 0)) {
      out.push(err(`its done kind says ${ev.met ? 'met' : 'not met'} but reports ${unmet.length} of ${ev.members.length} members not met — met must be true exactly when every member is`, t.id));
    }
    for (const m of ev.members) {
      for (const r of m.refs ?? []) if (!cx.io.exists(refPath(r))) out.push(err(`member ${m.id}: ref ${r} does not exist`, t.id));
      for (const h of m.holds ?? []) {
        if (h.kind !== 'ticket') continue;
        const u = ids.get(h.id);
        if (!u) out.push(err(`member ${m.id} waits on ${h.id}, which is not on the board`, t.id));
        else if (u.id === t.id) out.push(err(`member ${m.id} waits on its own ticket — name the ticket that carries it`, t.id));
        else if (u.status === 'dropped') out.push(err(`member ${m.id} waits on ${h.id}, which is dropped — remove the hold or name what replaced it`, t.id));
      }
    }
    if (!isLive(t)) continue;
    if ((t as { next?: string }).next !== undefined) {
      out.push(warn('next-overridden-by-members: next, show and the view print its members (the topmost workable one and a generated summary), never this hand-written next — drop it; an extension\'s nextLines is for repo-specific extras', t.id));
    }
    const loose = (membersOf(t.id, b, cx)?.unmet ?? []).filter((m) => !m.holds.length && reportersOf(m.id, b, cx).every((id) => id === t.id)).map((m) => m.id);
    if (loose.length) {
      out.push(warn(`member-uncovered: ${loose.length} unmet member(s) with no hold and no ticket of their own: ${loose.join(', ')} — record what holds each where its data lives, or open a ticket that names it; until then next offers them under ${t.id}`, t.id));
    }
  }
  return out;
}

/** Coverage (the `coverage` hooks: the board's whole surface) — the ground rule that the board matches
 *  the tree, for units no single done condition covers. Every finding is an error:
 *    coverage-hook-threw — a hook threw; nothing it would report is counted.
 *    coverage-invalid — a unit that does not validate ({ id, met, carrier?, note? }), or a hook that
 *      returns no list; left out of the count.
 *    coverage-duplicate — an id reported more than once, within a hook or across hooks; the count keeps
 *      the first.
 *    coverage-uncovered — unmet units with no carrier: nothing on the board says who raises them.
 *    coverage-carrier — unmet units whose carrier is not on the board, or is done or dropped (a live
 *      carrier is open or paused); one finding per carrier. */
export function coverageProblems(b: Board, cx: Ctx): Problem[] {
  const ev = evalCoverage(cx);
  const out: Problem[] = [
    ...ev.threw.map((m) => err(`coverage-hook-threw: ${m}`)),
    ...ev.invalid.map((m) => err(`coverage-invalid: ${m} — left out of the coverage count`)),
    ...ev.duplicates.map((d) => err(`coverage-duplicate: unit ${d.id} is reported ${d.at.length} times (${d.at.join(', ')}) — report each unit once; coverage counts the first`)),
  ];
  const unmet = ev.units.filter((u) => !u.met);
  const loose = unmet.filter((u) => u.carrier === undefined).map((u) => u.id);
  if (loose.length) {
    out.push(err(`coverage-uncovered: ${loose.length} unmet unit(s) no ticket carries: ${loose.join(', ')} — the board no longer matches the tree: open a ticket for each and set it as the unit's carrier where its data lives (or name the live ticket that already carries it)`));
  }
  const carried = new Map<string, string[]>();
  for (const u of unmet) if (u.carrier !== undefined) carried.set(u.carrier, [...(carried.get(u.carrier) ?? []), u.id]);
  const ids = byId(b);
  for (const [carrier, units] of carried) {
    const t = ids.get(carrier);
    const state = !t ? 'not on the board' : t.status === 'done' || t.status === 'dropped' ? t.status : undefined;
    if (!state) continue;
    const fix = t?.status === 'dropped' ? 'name' : `${t ? 're' : ''}open it or name`;
    const what = units.length === 1 ? `unit ${units[0]} is` : `${units.length} unmet units (${units.join(', ')}) are`;
    out.push(err(`coverage-carrier: ${what} carried by ${carrier}, which is ${state} — ${fix} the live ticket that carries ${units.length === 1 ? 'it' : 'them'}`));
  }
  return out;
}

/** wip branches exist and are not merged yet; done commits exist. Skipped without git. */
export function gitProblems(b: Board, cx: Ctx): Problem[] {
  const wips = b.filter((t) => t.status !== 'done' && t.status !== 'dropped' && (t as { wip?: string }).wip);
  const dones = b.filter((t) => t.status === 'done');
  if (!wips.length && !dones.length) return [];
  if (!cx.io.hasGit) return [note('no git checkout — wip branches and done commits were not checked')];
  const git = cx.io.git;
  const has = (ref: string) => git('rev-parse', '--verify', '--quiet', ref).ok;
  const out: Problem[] = [];
  const mainRef = [`refs/heads/${cx.config.main}`, `refs/remotes/origin/${cx.config.main}`].find(has);
  for (const t of wips) {
    const wip = (t as { wip: string }).wip;
    const ref = [`refs/heads/${wip}`, `refs/remotes/origin/${wip}`].find(has);
    if (!ref) { out.push(err(`wip branch ${wip} exists neither here nor on origin — fetch, or clear wip`, t.id)); continue; }
    if (!mainRef) out.push(warn(`main branch ${cx.config.main} not found — cannot tell whether wip ${wip} is merged (config.main)`, t.id));
    else if (git('merge-base', '--is-ancestor', ref, mainRef).ok) out.push(err(`wip branch ${wip} is already in ${cx.config.main} — clear wip`, t.id));
  }
  for (const t of dones) {
    if (t.status !== 'done') continue;
    if (!git('cat-file', '-e', `${t.commit}^{commit}`).ok) out.push(err(`commit ${t.commit} is not in this repository`, t.id));
  }
  return out;
}

/** Clock-dependent findings — warnings only, so one commit still checks the same everywhere. */
export function clockProblems(b: Board, now: number = Date.now()): Problem[] {
  const out: Problem[] = [];
  const day = today(now);
  for (const t of b) {
    if (isLive(t)) for (const bl of t.blockers ?? []) {
      if ((bl.kind === 'owner' || bl.kind === 'go') && bl.since > day) out.push(warn(`${bl.kind} blocker since ${bl.since} is in the future — the day it was first asked`, t.id));
      if (bl.kind === 'external' && bl.recheck && bl.recheck <= day) out.push(warn(`recheck day ${bl.recheck} for ${bl.who} has come — re-check, then update or remove the blocker`, t.id));
    }
    if (isLive(t) && t.window && !isRecurring(t.window)) {
      const opened = Date.parse(t.window.opens);
      if (now - opened > 86_400_000) out.push(warn(`window opened ${t.window.opens}, more than 24 h ago — it is workable; drop the window or set the next one`, t.id));
    }
  }
  return out;
}

/** `after` never targets a dropped ticket, never a group holding a paused member (both would wait
 *  forever — a paused ticket does not close on its own), and never closes a cycle. */
export function afterProblems(b: Board, cx: Ctx): Problem[] {
  const ids = byId(b);
  const out: Problem[] = [];
  for (const t of b) {
    if (!isLive(t)) continue;
    for (const a of (t as { after?: string[] }).after ?? []) {
      if (ids.get(a)?.status === 'dropped') out.push(err(`after ${a}, which is dropped — remove it or name what replaced it`, t.id));
      if (ids.has(a) || !Object.prototype.hasOwnProperty.call(cx.config.groups, a)) continue;
      const stuck = b.filter((m) => m.group === a && m.id !== t.id && m.status === 'paused').map((m) => m.id);
      if (stuck.length) out.push(err(`after ${a}, a group with paused member(s) ${stuck.join(', ')} — it would wait forever; move paused/archived tickets to their own group, or name the live tickets instead`, t.id));
    }
  }
  for (const c of cycles(b, cx)) out.push(err(`after cycle: ${c.join(' → ')} — every ticket in it waits forever`, c[0]));
  return out;
}

/** `jev-blocker-mismatch`: Jev answers saved for a live ticket's blockers (`jev route blocker --save`) say a
 *  blocker does not read as written, or sit in the mid band. Only when an answers file exists, and only
 *  for a blocker whose text is still the one judged (its fingerprint) — a warning, never an error: the
 *  exit code stays a function of the commit, and the answers file never decides anything by itself. */
export function jevProblems(b: Board, cx: Ctx): Problem[] {
  const out: Problem[] = [];
  for (const t of b) {
    if (!isLive(t) || !t.blockers) continue;
    const path = answersPath(t.id);
    const text = cx.io.read(path);
    if (!text) continue;
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { out.push(note(`${path} is not JSON — ignored`, t.id)); continue; }
    const a = parseAnswers(raw, 'blocker');
    if (typeof a === 'string') { out.push(note(`${path}: ${a} — ignored`, t.id)); continue; }
    if (a.meta.ticket !== t.id) { out.push(note(`${path} holds answers for ${a.meta.ticket} — ignored`, t.id)); continue; }
    t.blockers.forEach((bl, j) => {
      const fp = fingerprint(blockerText(bl));
      const item = a.meta.items.find((i: { fp: string }) => i.fp === fp);
      if (!item) return;
      const v = routeBlockerItem(item, a.answers, cx.config.jev, bl.kind);
      if (v.verdict !== 'ok') out.push(warn(`jev-blocker-mismatch: blockers[${j}] (${bl.kind}) — ${v.verdict}: ${v.reasons.join('; ')}`, t.id));
    });
  }
  return out;
}

export function extensionProblems(b: Board, cx: Ctx): Problem[] {
  return cx.config.extensions.flatMap((e, i) => {
    try { return e.check?.(b, cx) ?? []; } catch (x) { return [err(`config.extensions[${i}].check threw: ${(x as Error).message}`)]; }
  });
}

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** The repo's engine copy hashes to its VERSION; a skill install with another version is a note. */
export function engineProblems(cx: Ctx, opts: CheckOptions = {}): Problem[] {
  const repo = join(cx.root, 'tickets', 'engine');
  const pinned = readVersion(repo);
  if (!existsSync(repo)) return [err('tickets/engine is missing — the repo pins a copy of the engine: node <skill>/engine/cli.mjs upgrade')];
  if (!pinned) return [err('tickets/engine/VERSION is missing or unreadable — restore it with node <skill>/engine/cli.mjs upgrade')];
  const out: Problem[] = [];
  if (engineHash(repo) !== pinned.sha) {
    out.push(err(`tickets/engine was edited by hand (its files no longer hash to VERSION ${showVersion(pinned)}) — change the skill's engine upstream, then upgrade`));
  }
  const seen = new Set([real(repo)]);
  const candidates = [...(opts.engineDir ? [opts.engineDir] : []), ...(opts.skillDirs ?? []).map((d) => join(d, 'engine'))];
  for (const dir of candidates) {
    if (!existsSync(join(dir, 'VERSION')) || seen.has(real(dir))) continue;
    seen.add(real(dir));
    const v = readVersion(dir);
    if (v && !sameVersion(v, pinned)) out.push(note(`the skill at ${dir} has engine ${showVersion(v)}; this repo pins ${showVersion(pinned)} — node ${join(dir, 'cli.mjs')} upgrade moves the pin`));
  }
  return out;
}

/** Since 0.5.0 there is no committed view — the status page (`view`) is a git-ignored snapshot — so
 *  two leftovers of the old Markdown view are warnings until removed: the generated block still in the
 *  doc (`view-doc-leftover`), and the `doc` key in the config (`config-doc-deprecated`, accepted and
 *  ignored); and the status page's own path must stay out of git (`status-page-tracked`: tracked, or
 *  not ignored). Warnings, never errors: an upgraded repo stays green until it cleans up. */
export function viewDocProblems(cx: Ctx): Problem[] {
  const out: Problem[] = [];
  if (cx.config.docGiven) out.push(warn(`config-doc-deprecated: config.doc is ignored since 0.5.0 — there is no committed view (view renders a git-ignored _output/board-status.html); remove the key`));
  const doc = cx.config.doc;
  const path = join(cx.root, doc);
  if (existsSync(path) && hasMarkers(readFileSync(path, 'utf8'))) {
    out.push(warn(`view-doc-leftover: ${doc} still holds the generated view block (the ticket-board markers) — delete the block, or the doc if that is all it holds; read the board with next / list / show, or view for a page`));
  }
  const page = relative(cx.root, statusPagePath(cx.root));
  if (cx.io.hasGit && !page.startsWith('..') && !page.startsWith('/')) {
    const tracked = cx.io.git('ls-files', '--', page).out !== '';
    if (tracked || !cx.io.git('check-ignore', '-q', '--no-index', page).ok) {
      const dir = page.includes('/') ? `${page.slice(0, page.lastIndexOf('/'))}/` : page;
      out.push(warn(`status-page-tracked: ${tracked ? `${page} is tracked by git` : `${dir} is not git-ignored`} — the status page is a disposable snapshot and must never be committed: ${tracked ? `git rm --cached ${page}, then ` : ''}ignore ${dir} (init and upgrade add _output/ to .gitignore)`));
    }
  }
  return out;
}

/** Every check, in a stable order. The board must already validate. */
/** `status-blocked-deprecated`: a board written before 0.12.0 still says `status: 'blocked'`. Load reads
 *  it as `open` with the same blockers, so this stays a warning until the board is edited. */
export function legacyStatusProblems(cx: Ctx): Problem[] {
  return (cx.legacyBlocked ?? []).map((id) => warn(`status-blocked-deprecated: status 'blocked' is read as 'open' since 0.12.0 — whether a ticket is held comes from its holds; write status: 'open' and keep the blockers`, id));
}

export function runChecks(b: Board, cx: Ctx, opts: CheckOptions = {}): Problem[] {
  return [
    ...authorizationProblems(cx),
    ...capProblems(b, cx),
    ...refProblems(b, cx),
    ...resourceProblems(cx),
    ...doneStateProblems(b, cx),
    ...memberProblems(b, cx),
    ...coverageProblems(b, cx),
    ...gitProblems(b, cx),
    ...clockProblems(b, opts.now ?? Date.now()),
    ...afterProblems(b, cx),
    ...extensionProblems(b, cx),
    ...jevProblems(b, cx),
    ...engineProblems(cx, opts),
    ...viewDocProblems(cx),
    ...legacyStatusProblems(cx),
    ...(opts.claims ? claimProblems(b, cx, opts.claims, opts.now ?? Date.now()) : []),
  ];
}

export function authorizationProblems(cx: Ctx): Problem[] {
  return Object.entries(cx.config.authorizations).flatMap(([name, a]) =>
    authorizationOf(name, cx).state === 'invalid'
      ? [err(`authorization-grant: ${name}: source ${a.grant!.source} must exist, be tracked in a git repo, and contain the exact grant quote`)] : []);
}
