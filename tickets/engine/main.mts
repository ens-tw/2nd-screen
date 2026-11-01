// The ticket-board commands. cli.mjs checks the Node version, then calls main().
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Board, Claim, Ctx, Hold, Problem, Probe, Status, Ticket } from './types.mts';
import {
  daysSince, dependents, describeDone, describeHold, describeHolds, doneKind, elsewhere, evalCoverage, externals, holdsOf, isLive,
  knownBoxes, makeCtx, memberLabel, memberSummary, membersOf, needs, onBox, probeAll, reachableOf, resourceBringUps, stands,
  scopeOf, statusPagePath, stopOf, tallyCoverage, waits, windowGates, workable, type Coverage, type MemberAt, type MembersAt,
} from './lib.mts';
import { configProblems, boardProblems } from './validate.mts';
import { metOf, runChecks } from './checks.mts';
import { renderHtml } from './render.mts';
import { claimKey, dropClaim, leftoverClaims, newClaim, readClaims, takeClaim } from './claims.mts';
import { isOpen, isoLocal, nextOpen, today } from './windows.mts';
import { init, parseIds, stamp, upgrade } from './init.mts';
import { readVersion } from './version.mts';
import { DEFAULT_ID_SRC, draftProblems, draftSource, inlineIdSrc, isDraft, parseMarkdown, reportText } from './migrate.mts';
import {
  WRITTEN, answersPath, blockerRequest, blockerText, doneRequest, parseAnswers, routeBlocker, routeDone, tokens,
  type BlockerVerdict, type Written,
} from './jev.mts';
import {
  MAX_PAIRS, PROBE_LOG, USD_PER_MTOK, appendProbeLog, cacheDir, dupePairs, lastProbes, loggedReachable, pairRequest, parseReviewAnswers,
  readProbeLog, requestTokens, reviewPath, reviewRecord, reviewText, routeReview, selectTickets, thisBox, ticketRequest,
  type Facts, type ReviewAnswers, type ReviewRequest,
} from './review.mts';

export const USAGE = `ticket-board — the work queue as typed data (tickets/board.mts), checked against the tree.

usage: node tickets/engine/cli.mjs <command> [options]     (from anywhere in the repo)

next, list, show, check and coverage print compact JSON — one object, stable field names, for an agent
to read or pipe to jq — unless --text asks for the human-readable form (a terminal, a CI log); --json is
accepted and changes nothing. The human view of the board is the Markdown \`write\` generates.

  next [--group <key>] [--on <box>] [--no-probe] [--text]
                               the topmost ticket workable here — on a ticket whose done condition
                               reports members, its topmost workable member — then agent bring-ups,
                               clock windows, owner asks, go asks and external blockers. --no-probe
                               (or TICKET_BOARD_NO_PROBE=1) runs no probe and writes nothing: resources
                               come from the last logged probe on this machine, else unknown.
                               --group: only that config.groups key's tickets and what they wait on
                               (after, transitively); the stop code and every list weigh only those
  check [--text]               the board against the tree: schema, prose caps, refs, stale/drift,
                               members, wip branches, done commits, the engine copy
  coverage [--text]            the whole surface at a glance, as the config.extensions coverage hooks
                               report it: {of, met, unmet, byCarrier} — byCarrier counts the unmet per
                               responsible ticket (none → "uncovered"). A board-wide coverage number
                               without an umbrella ticket; no hook → {"of":0,…}; a hook that throws →
                               its message on stderr, exit 1. check holds every unmet unit to a live
                               carrier
  view [--out <file>] [--open] (re)write the status page — the board as one self-contained HTML page
                               for a person, never for an agent — and print its path: by default
                               _output/board-status.html (git-ignored); every probing next
                               refreshes it too. An --out in the repo must be git-ignored, so the page
                               is never committed. --open opens it (open / xdg-open)
  list [--status live|all] [--group <key>] [--text]
                               one line per ticket with its derived state: workable or what holds it
                               now, its window, its member summary, its next (live = open, blocked,
                               paused; all adds done and dropped). Probes nothing, writes nothing:
                               resources as last logged on this machine. --group: that group's tickets
  show <id> [--members] [--text]
                               one ticket: its holds, done condition and dependents; --members lists
                               every unmet member with its holds and note
  claim --next --to <name> [--group <key>] [--by <session>] [--branch <b>] [--on <box>] [--no-probe] [--text]
  claim <id> [--member <m>] --to <name> [--by <session>] [--branch <b>] [--text]
                               take the topmost workable ticket (or member) nobody has claimed, or a
                               given one, for <name> — an exclusive create, so two claims never take
                               the same one. next skips a claimed ticket; claims are machine-local,
                               shared by every worktree of the checkout, never on the board. --by =
                               the session taking it, --branch = where the work lands (check reads
                               its last commit). Exit 3 = nothing left to claim (with the stop code)
  release <id> [--member <m>] --to <name> [--force] [--text]
                               give a claim back; --to must be the claim's own (--force: anyone's)
  jev blocker <id> [--ask "<text>" [--as owner|go|external|window]]
                               print a Jev request: what the ticket's blockers (or the text you are
                               about to write) really wait on — never calls Jev itself
  jev done <id> --evidence <file>
                               print a Jev request: does the evidence support a judgment done condition
  jev route blocker|done <answers.json> [--save] [--json]
                               the verdict from the answers (jev_decide.mts --raw output), thresholds
                               in config.jev; --save keeps blocker answers for check (tickets/jev/)
  review [--ids a,b] [--status live|all] [--dupes] [--facts <file>] [--out <dir>]
                               pro review: a dossier and one Jev request per ticket (live = open,
                               blocked, paused), plus candidate duplicate pairs; writes them to <dir>
                               (default tickets/.cache/review/<date>/) with a token and cost estimate
                               — never calls Jev itself
  review route <answers dir|file> [--save] [--json]
                               ranked recommendations from the answers, thresholds in
                               config.jev.review; --save keeps them in tickets/review/<date>.json
  (no command)                 counts and the live tickets, as list --text
  help                         this text
  write                        gone in 0.5.0 (there is no committed view): exits 2 — use view

from the skill's copy (node <skill>/engine/cli.mjs …):
  init [--ids <regex>]                  pin the engine in tickets/engine, write tickets/config.mts and
                                        tickets/board.mts and a Work queue section in AGENTS.md
  upgrade                               replace tickets/engine with this engine
  migrate --from-markdown <doc> [--out <path>] [--ids <regex>]
                                        draft a board from a hand-written list (default
                                        tickets/board.draft.mts) and report what it could not decide
  stamp [--semver <x.y.z>]              maintainers: rewrite this engine's VERSION after changing it

environment: TICKET_BOARD_CACHE_DIR moves the machine-local cache (probes.jsonl, review/) out of
tickets/.cache/ · TICKET_BOARD_OUTPUT_DIR moves the status page out of _output/ · TICKET_BOARD_NO_PROBE=1
= next --no-probe · TICKET_BOARD_CLAIMS_DIR moves the claims out of <git common dir>/ticket-board/claims

exit: 0 ok · 1 check problems, a jev verdict / review that goes back to you, a coverage hook that
threw, or a claim / release refused · 2 usage, config or schema error · 3 next / claim --next: nothing
workable here`;

const OPTIONS = {
  on: { type: 'string' }, json: { type: 'boolean' }, ids: { type: 'string' }, doc: { type: 'string' },
  'from-markdown': { type: 'string' }, out: { type: 'string' }, semver: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  ask: { type: 'string' }, as: { type: 'string' }, evidence: { type: 'string' }, save: { type: 'boolean' },
  status: { type: 'string' }, dupes: { type: 'boolean' }, facts: { type: 'string' },
  'no-probe': { type: 'boolean' }, members: { type: 'boolean' }, text: { type: 'boolean' }, open: { type: 'boolean' },
  next: { type: 'boolean' }, to: { type: 'string' }, by: { type: 'string' }, branch: { type: 'string' }, member: { type: 'string' },
  force: { type: 'boolean' }, group: { type: 'string' },
} as const;
const ALLOWED: Record<string, string[]> = {
  '': [], next: ['on', 'json', 'text', 'no-probe', 'group'], check: ['json', 'text'], coverage: ['json', 'text'], write: [], show: ['members', 'json', 'text'], list: ['status', 'group', 'json', 'text'],
  view: ['out', 'open'], help: [], init: ['ids'], upgrade: [],
  migrate: ['from-markdown', 'out', 'ids'], stamp: ['semver'], jev: ['ask', 'as', 'evidence', 'save', 'json'],
  review: ['ids', 'status', 'dupes', 'facts', 'out', 'save', 'json'],
  claim: ['next', 'to', 'by', 'branch', 'member', 'on', 'no-probe', 'group', 'json', 'text'], release: ['to', 'member', 'force', 'json', 'text'],
};

type Out = { out: (s: string) => void; err: (s: string) => void };
const io: Out = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) };
/** A query command's answer: compact JSON, one object on one line. */
const emit = (o: unknown) => io.out(JSON.stringify(o));

/** The repo root: the git top level, else the working directory. */
export function findRoot(cwd: string = process.cwd()): string {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : cwd;
}

const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

/** Skill installs a repo's pin is compared with (a differing version is a `check` note). */
export function skillDirs(root: string): string[] {
  const env = process.env.TICKET_BOARD_SKILL;
  if (env !== undefined) return env.split(':').filter(Boolean);
  return [
    join(root, '.claude/skills/ticket-board'), join(root, '.agents/skills/ticket-board'),
    join(homedir(), '.claude/skills/ticket-board'), join(homedir(), '.agents/skills/ticket-board'),
    ...pluginSkillDirs(),
  ];
}

/** The skill inside an installed Claude Code plugin (skill-jz ships as the `enstw` plugin): every
 *  installPath in the runner's installed_plugins.json, read as data; no file, no plugins. */
function pluginSkillDirs(): string[] {
  const conf = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  try {
    const data = JSON.parse(readFileSync(join(conf, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, { installPath?: unknown }[]> };
    return Object.values(data.plugins ?? {}).flat().flatMap((e) => typeof e?.installPath === 'string' ? [join(e.installPath, 'ticket-board')] : []);
  } catch { return []; }
}

type Loaded = { cx: Ctx; board: Board; problems: Problem[] };

/** Load and validate tickets/config.mts + tickets/board.mts. A string = a load/config failure. */
export async function load(root: string): Promise<Loaded | string> {
  const cfgPath = join(root, 'tickets', 'config.mts');
  const boardPath = join(root, 'tickets', 'board.mts');
  if (!existsSync(cfgPath)) return `no tickets/config.mts under ${root} — set the repo up with: node <skill>/engine/cli.mjs init`;
  let rawCfg: unknown;
  try { rawCfg = (await import(pathToFileURL(cfgPath).href)).default; } catch (e) { return `tickets/config.mts does not load: ${(e as Error).message}`; }
  const cp = configProblems(rawCfg);
  if (cp.length) return cp.join('\n');
  const cx = makeCtx(root, rawCfg as never);
  if (!existsSync(boardPath)) return 'no tickets/board.mts — init writes an empty one';
  let rawBoard: unknown;
  try { rawBoard = (await import(pathToFileURL(boardPath).href)).default; } catch (e) { return `tickets/board.mts does not load: ${(e as Error).message}`; }
  return { cx, board: rawBoard as Board, problems: boardProblems(rawBoard, cx) };
}

const fmtProblem = (p: Problem) => `${p.level.padEnd(7)} ${p.id ? `${p.id}: ` : ''}${p.message}`;

function printSchema(problems: Problem[], json: boolean): number {
  if (json) emit({ ok: false, errors: problems, warnings: [], notes: [] });
  else { for (const p of problems) io.err(fmtProblem(p)); io.err(`the board does not validate: ${problems.length} error(s) — fix tickets/board.mts`); }
  return 2;
}

/** The one-line human form of `coverage`, e.g. `coverage: 104/120 met · 16 unmet (T-12:9, T-15:5, uncovered:2)`. */
const coverageText = (c: Coverage): string => {
  const by = Object.entries(c.byCarrier).map(([k, n]) => `${k}:${n}`).join(', ');
  return `coverage: ${c.met}/${c.of} met · ${c.unmet} unmet${by ? ` (${by})` : ''}`;
};

const rel = (root: string, p: string) => relative(root, p) || '.';
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** A ticket, or a member under its ticket: `T-12 › PlaceOrder`. */
const at = (x: { id: string; member?: string }) => (x.member ? `${x.id} › ${x.member}` : x.id);

// ── next ─────────────────────────────────────────────────────────────────────────────────────────

/** The member `next` offers, its holds resolved (none stands here now; they say what it relies on). */
export type NextMember = { id: string; note: string | null; refs: string[]; holds: Hold[] };
/** A ticket's members in brief: how many, how many not met, the live summary, and the ids workable now
 *  (best first — the first is `member`). */
export type NextMembers = { of: number; unmet: number; summary: string; workable: string[] };

export type NextJson = {
  next: {
    id: string; title: string; next: string; done: string; refs: string[]; hazard: string | null; wip: string | null; lines: string[];
    /** Only on a ticket whose done condition reports members: the member offered (null when every member
     *  is met — the ticket is stale, close it) and the rest in brief. `next` above is then generated. */
    member?: NextMember | null;
    members?: NextMembers;
  } | null;
  then: string[];
  bringUp: { resource: string; waiting: string[]; note?: string; bringUp?: string }[];
  /** `member` is set on an entry that comes from a member's hold. */
  clock: { id: string; member?: string; what: string; opens: string }[];
  owner: { id: string; member?: string; ask: string; since: string; days: number }[];
  go: { id: string; member?: string; ask: string; since: string; days: number }[];
  external: { id: string; member?: string; who: string; what: string; recheck: string | null; due: boolean }[];
  elsewhere: { id: string; member?: string; needs: string[] }[];
  /** The claims on live work, oldest first: in progress, so never a stop reason — with \`next\` null,
   *  what to wait for. */
  claimed: Claim[];
  stop: null | { code: string; until?: string };
  /** Only with --no-probe: no probe ran; each resource as last logged on this machine, or unknown. */
  probe?: { mode: 'cached'; box: string; resources: Record<string, { state: 'usable' | 'down' | 'absent' | 'unknown'; at: string | null }> };
};

/** Everything `next` reports, for a given set of reachable resources and probes — with `scope`
 *  (`--group`, see scopeOf), only about the tickets in it. */
export function nextReport(board: Board, cx: Ctx, reachable: ReadonlySet<string>, probes: Map<string, Probe> | undefined, now: number, scope?: ReadonlySet<string>) {
  const mine = (id: string) => !scope || scope.has(id);
  const work = workable(board, reachable, cx, now).filter((u) => mine(u.ticket.id));
  const gates = windowGates(board, now, cx).filter((g) => mine(g.id));
  const t = work[0]?.ticket as (Ticket & { status: 'open' | 'blocked' }) | undefined;
  const m = work[0]?.members?.[0];
  const ms = t ? membersOf(t.id, board, cx) : undefined;
  const lines: string[] = [];
  if (t) {
    const dk = doneKind(t.doneWhen.kind, cx);
    const nowLine = dk?.now?.(t.doneWhen as never, t, cx);
    if (nowLine) lines.push(`now: ${nowLine}`);
    if (t.status === 'blocked') for (const bl of t.blockers) {
      if (bl.kind === 'external' && bl.recheck && !stands(bl, board, reachable, now)) lines.push(`recheck: ${bl.who} — ${bl.what} (due since ${bl.recheck}): re-check, then update or remove the blocker`);
    }
    for (const h of m?.holds ?? []) {
      if (h.kind === 'external' && h.recheck && !stands(h, board, reachable, now)) lines.push(`recheck: ${h.who} — ${h.what} (due since ${h.recheck}): re-check, then update or remove the member's hold where its data lives`);
    }
    const used = [...new Set([...needs(t, cx).map((n) => n.needs), ...(m?.holds ?? []).flatMap((h) => (h.kind === 'resource' ? [h.needs] : []))])];
    for (const name of used) {
      const r = cx.config.resources[name];
      if (r.policy) lines.push(`${name}: ${r.policy}`);
      if (r.bringUp) lines.push(`${name} bring-up: ${r.bringUp}`);
    }
    for (const e of cx.config.extensions) lines.push(...(e.nextLines?.(t, cx, m) ?? []));
  }
  // On a ticket with members the action is generated: the member offered, or — every member met — close it.
  const action = (tt: Ticket & { next?: string }): string => {
    if (m) return clip(`member ${m.id}${m.note ? ` — ${m.note}` : ''}`, cx.config.caps.next);
    if (ms) return ms.all ? `all ${ms.all} members are met — close it (check reports it stale)` : 'its done kind reports no members';
    return tt.next ?? '';
  };
  const json: NextJson = {
    next: t ? {
      id: t.id, title: t.title, next: action(t), done: describeDone(t.doneWhen, cx), refs: t.refs ?? [], hazard: t.hazard ?? null, wip: t.wip ?? null, lines,
      ...(ms ? {
        member: m ? { id: m.id, note: m.note ?? null, refs: m.refs, holds: m.holds } : null,
        members: { of: ms.all, unmet: ms.unmet.length, summary: memberSummary(ms, board, { reachable, now }), workable: (work[0].members ?? []).map((x) => x.id) },
      } : {}),
    } : null,
    then: work.slice(1).map((u) => u.ticket.id),
    bringUp: probes ? resourceBringUps(board, probes, cx).flatMap((r) => {
      const waiting = r.waiting.filter(mine);
      return waiting.length ? [{ ...r, waiting }] : [];
    }) : [],
    clock: gates.map(({ id, member, what, opens }) => ({ id, ...(member ? { member } : {}), what, opens })),
    owner: waits(board, 'owner', now, cx).filter((x) => mine(x.id)),
    go: waits(board, 'go', now, cx).filter((x) => mine(x.id)),
    external: externals(board, now, cx).filter((x) => mine(x.id)),
    elsewhere: elsewhere(board, reachable, cx).filter((x) => mine(x.id)),
    claimed: liveClaims(board, cx).filter((c) => mine(c.ticket)),
    stop: stopOf(board, reachable, cx, now, scope),
  };
  return { json, work: work.map((u) => u.ticket), gates };
}

function nextText(board: Board, cx: Ctx, rep: ReturnType<typeof nextReport>, here: string, now: number): string[] {
  const { json } = rep;
  const L: string[] = [];
  const byId = new Map(board.map((t) => [t.id, t]));
  if (json.next) {
    const n = json.next;
    L.push(`next ${here}: ${n.member ? `${n.id} › ${n.member.id} — ` : `${n.id} `}${n.title}`);
    if (n.hazard) L.push(`  ⚠ HAZARD: ${n.hazard}`);
    L.push(`  why:  ${byId.get(n.id)?.why}`, `  do:   ${n.next}`, `  done: ${n.done}`);
    if (n.member?.holds.length) L.push(`  member holds (none stands here now): ${describeHolds(n.member.holds).join('; ')}`);
    if (n.member?.refs.length) L.push(`  member refs: ${n.member.refs.join(', ')}`);
    if (n.members) {
      L.push(`  members: ${n.members.summary}`);
      const more = n.members.workable.slice(1);
      if (more.length) L.push(`  more members workable now: ${more.slice(0, 12).join(', ')}${more.length > 12 ? ` (+${more.length - 12})` : ''} — show ${n.id} --members lists them all`);
    }
    if (n.wip) L.push(`  wip:  continue on branch ${n.wip} (git switch ${n.wip}) — half-done work that cannot land on main yet`);
    if (n.refs.length) L.push(`  refs: ${n.refs.join(', ')}`);
    for (const l of n.lines) L.push(`  ${l}`);
    const unblocks = dependents(board, cx).get(n.id);
    if (unblocks) L.push(`  unblocks: ${unblocks.join(', ')}`);
    if (json.then.length) L.push(`  then: ${json.then.map((id) => (byId.get(id) as { hazard?: string })?.hazard ? `${id} ⚠` : id).join(', ')}`);
  } else {
    const s = json.stop!;
    L.push(`nothing workable ${here} — stop: ${s.code}${s.until ? ` ${s.until}` : ''}${json.claimed.length ? ` (${json.claimed.length} claimed: wait for them before you stop)` : ''}`);
  }
  if (json.claimed.length) {
    L.push('', 'claimed (in progress — wait for these; never a stop reason):');
    for (const c of json.claimed) L.push(`  ${claimKey(c.ticket, c.member)}  ${c.to}${c.branch ? ` on ${c.branch}` : ''} since ${c.at} (${c.host}${c.by ? `, session ${c.by}` : ''})`);
  }
  if (json.bringUp.length) {
    L.push('', 'agent bring-up (this machine hosts it; bring it up yourself — never a human ask):');
    for (const r of json.bringUp) L.push(`  ${r.resource}: ${r.waiting.join(', ')} ${r.waiting.length > 1 ? 'wait' : 'waits'} on it (${r.note ?? 'not usable'}) — ${r.bringUp ?? 'bring it up'}`);
  }
  if (rep.gates.length) {
    L.push('', 'clock-gated (held until the window opens; schedule the resume for it — never an owner ask):');
    for (const g of rep.gates) L.push(`  ${at(g)}  ${g.rule} — next opens ${g.opens}`);
  }
  if (json.owner.length) {
    L.push('', 'waiting on the owner (longest wait first):');
    for (const o of json.owner) L.push(`  ${at(o)}  ${o.days} d, since ${o.since}: ${o.ask}`);
  }
  if (json.go.length) {
    L.push('', 'owner go needed (a hazardous step — one yes/no each):');
    for (const o of json.go) L.push(`  ${at(o)}  ${o.days} d, since ${o.since}: ${o.ask}`);
  }
  if (json.external.length) {
    L.push('', 'external (third parties):');
    for (const x of json.external) {
      const when = x.recheck ? (x.due ? ` — recheck due (${x.recheck}): workable, re-check now` : ` — recheck ${x.recheck} (in ${-daysSince(x.recheck as never, now)} d)`) : ' — no recheck day';
      L.push(`  ${at(x)}  ${x.who}: ${x.what}${when}`);
    }
  }
  if (json.elsewhere.length) {
    L.push('', 'elsewhere (needs a resource this machine cannot reach):');
    for (const e of json.elsewhere) L.push(`  ${at(e)}  ${e.needs.join(', ')}`);
  }
  return L;
}

// ── show ─────────────────────────────────────────────────────────────────────────────────────────

/** A hold in a few words, with when a window next opens (show reads the clock; the view never does). */
function holdNow(h: Hold, now: number): string {
  const s = describeHold(h);
  if (h.kind !== 'window') return s;
  return s + (isOpen(h, now) ? ' (open now)' : ` (next opens ${nextOpen(h, now)?.iso ?? 'never within a year'})`);
}

function showText(t: Ticket, board: Board, cx: Ctx, now: number): string[] {
  const L = [`${t.id} ${t.title}   [${t.status}${t.group ? `, group ${t.group}` : ''}]`, `  why:     ${t.why}`];
  const ms = membersOf(t.id, board, cx);
  if (ms) L.push(`  members: ${memberSummary(ms, board)} — show ${t.id} --members lists them`);
  if (t.status === 'open' || t.status === 'blocked') {
    if (t.hazard) L.push(`  ⚠ HAZARD: ${t.hazard}`);
    if (!ms) L.push(`  next:    ${t.next}`);
    else if (t.next !== undefined) L.push(`  next:    (hand-written, overridden by its members — drop it) ${t.next}`);
    if (t.after) L.push(`  after:   ${t.after.join(', ')}`);
  }
  if (t.status === 'paused') L.push(`  until:   ${t.until}`);
  if (t.status === 'done') L.push(`  commit:  ${t.commit}`);
  if (t.status === 'dropped') L.push(`  reason:  ${t.reason}`);
  if (t.status !== 'dropped') {
    let m;
    try { m = metOf(t, cx); } catch (e) { m = { met: false, why: `the check threw: ${(e as Error).message}` }; }
    L.push(`  done:    ${describeDone(t.doneWhen, cx)}${m ? ` — ${m.met ? 'met' : 'not met'}${m.why ? ` (${m.why})` : ''}` : ''}`);
  }
  if ((t.status === 'open' || t.status === 'blocked' || t.status === 'paused') && t.wip) L.push(`  wip:     ${t.wip}`);
  const hs = holdsOf(t.id, board, cx);
  hs.forEach((h, i) => L.push(`  ${i ? '         ' : 'holds:   '}${holdNow(h, now)}`));
  const deps = dependents(board, cx).get(t.id);
  if (deps) L.push(`  unblocks: ${deps.join(', ')}`);
  if (t.refs?.length) L.push(`  refs:    ${t.refs.join(', ')}`);
  return L;
}

/** `show <id> --json`: the ticket as written, and what the engine derives for it. */
export type ShowJson = {
  id: string; title: string; status: Status; group: string | null;
  /** The entry as written on the board. */
  ticket: Ticket;
  /** What `next` would print as its action: on a ticket with members a generated line (their summary),
   *  else its hand-written next; null unless open or blocked. */
  next: string | null;
  done: { describe: string; met: boolean | null; why: string | null } | null;
  /** Every hold, the derived ones included, as data and in words (a window with when it next opens). */
  holds: { hold: Hold; text: string }[];
  unblocks: string[];
  members: { all: number; met: number; unmet: number; summary: string } | null;
};

export function showJson(t: Ticket, board: Board, cx: Ctx, now: number): ShowJson {
  const ms = membersOf(t.id, board, cx);
  let m;
  try { m = metOf(t, cx); } catch (e) { m = { met: false, why: `the check threw: ${(e as Error).message}` }; }
  return {
    id: t.id, title: t.title, status: t.status, group: t.group ?? null, ticket: t,
    next: isLive(t) ? (ms ? `work its members — ${memberSummary(ms, board)}` : (t as { next?: string }).next ?? null) : null,
    done: t.status === 'dropped' ? null : { describe: describeDone(t.doneWhen, cx), met: m ? m.met : null, why: m?.why ?? null },
    holds: holdsOf(t.id, board, cx).map((h) => ({ hold: h, text: holdNow(h, now) })),
    unblocks: dependents(board, cx).get(t.id) ?? [],
    members: ms ? { all: ms.all, met: ms.met, unmet: ms.unmet.length, summary: memberSummary(ms, board) } : null,
  };
}

// ── list ─────────────────────────────────────────────────────────────────────────────────────────
// One line per ticket with its derived state — what an agent would otherwise grep board.mts for and
// get wrong (the file holds no derived hold, no window state, no member). Probes nothing and writes
// nothing: resources are as last logged on this machine (unknown = unreachable), read-only.

/** A standing hold in a few words, for `list`. */
function holdLabel(h: Hold, now: number): string {
  switch (h.kind) {
    case 'owner': case 'go': return `${h.kind} (since ${h.since})`;
    case 'external': return `external (${h.who}${h.recheck ? `, recheck ${h.recheck}` : ''})`;
    case 'window': return `window (opens ${nextOpen(h, now)?.iso ?? 'never within a year'})`;
    case 'resource': return `needs ${h.needs}`;
    case 'ticket': return `waits on ${h.id}`;
    case 'claim': return `claimed by ${h.to}`;
    default: return JSON.stringify(h);
  }
}

export type ListRow = {
  id: string; status: Status; title: string; group: string | null;
  /** workable = `next` could offer it here now; claimed = someone has it (its only standing hold is a
   *  claim); held = something else in `stops` stands. */
  state: 'workable' | 'claimed' | 'held' | 'paused' | 'done' | 'dropped';
  /** What stops it now: each standing hold (`members` = none of its unmet members is workable here). */
  stops: { kind: string; label: string }[];
  window: { what: string; open: boolean; opens: string | null } | null;
  members: { all: number; met: number; unmet: number; summary: string } | null;
  /** Its action as `next` would print it (the member on a ticket with members); paused: until; done: the
   *  commit; dropped: the reason. Whole here, truncated in the text. */
  next: string;
};

export type ListJson = {
  /** Each resource as last logged on this machine (no probe runs). */
  resources: Record<string, { state: 'usable' | 'down' | 'absent' | 'unknown'; at: string | null }>;
  tickets: ListRow[];
};

export function listJson(board: Board, cx: Ctx, cached: ReadonlyMap<string, Probe & { ts: string }>, now: number, status: 'live' | 'all', group?: string): ListJson {
  const reachable = reachableOf(new Map([...cached].map(([n, { ts: _, ...p }]) => [n, p as Probe])));
  const work = new Map(workable(board, reachable, cx, now).map((w) => [w.ticket.id, w]));
  const stand = (h: Hold) => stands(h, board, reachable, now);
  const shown = board.filter((t) => (status === 'all' || isLive(t) || t.status === 'paused') && (group === undefined || t.group === group));
  const tickets = shown.map((t): ListRow => {
    const ms = membersOf(t.id, board, cx);
    const w = work.get(t.id);
    const first = w?.members?.[0];
    const stops = (isLive(t) ? holdsOf(t.id, board, cx).filter(stand) : []).map((h) => ({ kind: h.kind, label: holdLabel(h, now) }));
    if (isLive(t) && !w && !stops.length && ms?.unmet.length) stops.push({ kind: 'members', label: 'no member workable here now' });
    const win = (t.status === 'open' || t.status === 'blocked') && t.window ? t.window : undefined;
    let next: string;
    if (t.status === 'paused') next = `until: ${t.until}`;
    else if (t.status === 'done') next = `done in ${t.commit}`;
    else if (t.status === 'dropped') next = `dropped: ${t.reason}`;
    else if (first) next = `member ${first.id}${first.note ? ` — ${first.note}` : ''}`;
    else if (ms) next = ms.unmet.length ? 'work its members — none is workable here now' : `all ${ms.all} members are met — close it`;
    else next = t.next ?? '';
    return {
      id: t.id, status: t.status, title: t.title, group: t.group ?? null,
      state: t.status === 'paused' || t.status === 'done' || t.status === 'dropped' ? t.status : w ? 'workable' : stops.length && stops.every((x) => x.kind === 'claim') ? 'claimed' : 'held',
      stops,
      window: win ? { what: win.what, open: isOpen(win, now), opens: isOpen(win, now) ? null : nextOpen(win, now)?.iso ?? null } : null,
      members: ms ? { all: ms.all, met: ms.met, unmet: ms.unmet.length, summary: memberSummary(ms, board, isLive(t) ? { reachable, now } : undefined) } : null,
      next,
    };
  });
  const resources = Object.fromEntries(Object.keys(cx.config.resources).map((n) => {
    const c = cached.get(n);
    return [n, c ? { state: c.usable ? 'usable' : c.here ? 'down' : 'absent', at: c.ts } : { state: 'unknown', at: null }];
  })) as ListJson['resources'];
  return { resources, tickets };
}

function listText(j: ListJson): string[] {
  const L: string[] = [];
  const res = Object.entries(j.resources);
  if (res.length) L.push(`resources (as last logged on this machine; no probe ran): ${res.map(([n, r]) => `${n} ${r.state}${r.at ? ` (${r.at})` : r.state === 'unknown' ? ' — counts as unreachable' : ''}`).join(' · ')}`);
  const w = Math.max(0, ...j.tickets.map((r) => r.id.length));
  for (const r of j.tickets) {
    const state = r.state === 'held' || r.state === 'claimed' ? `${r.state}: ${r.stops.map((s) => s.label).join(' · ')}` : r.state === 'workable' && r.window?.open ? 'workable (window open)' : r.state;
    L.push(`${r.id.padEnd(w)}  ${r.status.padEnd(7)}  ${state}  — ${r.title}${r.members ? ` · members: ${r.members.summary}` : ''} · ${clip(r.next, 100)}`);
  }
  if (!j.tickets.length) L.push('no ticket');
  return L;
}

export type MembersJson = {
  id: string; title: string; status: string; all: number; met: number; unmet: number; summary: string;
  /** Every unmet member, in the order reported: what holds it (`label`, '' = workable), its holds as
   *  data and in words (a window with when it next opens), its note and refs. */
  members: { id: string; label: string; holds: Hold[]; described: string[]; note: string | null; refs: string[] }[];
  /** Members left out for their shape (check reports them). */
  invalid: string[];
};

/** `show <id> --members`: every unmet member with its holds and note, and the met count. */
export function membersJson(t: Ticket, ms: MembersAt, board: Board, now: number): MembersJson {
  return {
    id: t.id, title: t.title, status: t.status, all: ms.all, met: ms.met, unmet: ms.unmet.length, summary: memberSummary(ms, board),
    members: ms.unmet.map((m) => ({ id: m.id, label: memberLabel(m), holds: m.holds, described: m.holds.map((h) => holdNow(h, now)), note: m.note ?? null, refs: m.refs })),
    invalid: ms.invalid,
  };
}

function membersText(j: MembersJson): string[] {
  const L = [`${j.id} ${j.title}   [${j.status}]`, `  members: ${j.met} of ${j.all} met — ${j.summary}`];
  if (j.members.length) L.push('', `not met (${j.unmet}), in the order reported:`);
  for (const m of j.members) {
    L.push(`  ${m.id} — ${m.label || 'workable (nothing holds it)'}`);
    m.described.forEach((d, i) => L.push(`      ${i ? '       ' : 'holds: '}${d}`));
    if (m.note) L.push(`      note:  ${m.note}`);
    if (m.refs.length) L.push(`      refs:  ${m.refs.join(', ')}`);
  }
  if (j.invalid.length) {
    L.push('', 'left out for their shape (check reports them):');
    for (const p of j.invalid) L.push(`  ${p}`);
  }
  return L;
}

// ── jev ──────────────────────────────────────────────────────────────────────────────────────────
// Requests out, verdicts in. The engine never calls Jev: the jev-decide skill's runner does, and only
// on the user's ack (a call is paid).

type JevOpts = { ask?: string; as?: string; evidence?: string; save?: boolean; json?: boolean };

function jevArgsProblem(pos: string[], v: JevOpts): string {
  const sub = pos[1];
  const only = (allowed: string[]) => {
    const extra = (['ask', 'as', 'evidence', 'save', 'json'] as const).filter((k) => v[k] !== undefined && !allowed.includes(k));
    return extra.length ? `jev ${sub} takes no --${extra.join(', --')}` : '';
  };
  if (sub === 'blocker') {
    if (pos.length !== 3) return 'jev blocker takes exactly one ticket id';
    if (v.as !== undefined && v.ask === undefined) return "--as says how --ask's text is written; pass --ask too";
    if (v.as !== undefined && !WRITTEN.includes(v.as as Written)) return `--as must be one of ${WRITTEN.join(', ')}`;
    if (v.ask !== undefined && !v.ask.trim()) return '--ask needs the text';
    return only(['ask', 'as']);
  }
  if (sub === 'done') {
    if (pos.length !== 3) return 'jev done takes exactly one ticket id';
    if (!v.evidence) return 'jev done needs --evidence <file>: the excerpt that shows the condition is met (a log, a test run, a doc)';
    return only(['evidence']);
  }
  if (sub === 'route') {
    if (pos.length !== 4 || !['blocker', 'done'].includes(pos[2])) return 'jev route takes blocker|done and an answers file';
    return only(pos[2] === 'blocker' ? ['save', 'json'] : ['json']);
  }
  return 'jev takes blocker <id>, done <id> or route blocker|done <answers.json>';
}

const jevHint = (sub: string) => `a Jev call is paid — send this only with the user's ack, through the jev-decide skill's runner:
  node <jev-decide>/scripts/jev_decide.mts --raw --ack <request.json> > answers.json
then: node tickets/engine/cli.mjs jev route ${sub} answers.json${sub === 'blocker' ? ' [--save]' : ''}
without an ack or a credential, decide yourself — that is the behaviour without Jev`;

function jevCmd(pos: string[], v: JevOpts, board: Board, cx: Ctx, cwd: string): number {
  const sub = pos[1];
  if (sub === 'route') return jevRoute(pos[2] as 'blocker' | 'done', pos[3], resolve(cwd, pos[3]), v, board, cx);
  const t = board.find((x) => x.id === pos[2]);
  if (!t) { io.err(`no ticket ${pos[2]} on the board`); return 2; }
  if (t.status === 'done' || t.status === 'dropped') { io.err(`${t.id} is ${t.status} — nothing to judge`); return 2; }
  if (sub === 'blocker') {
    let texts: { slot: string; written: Written | null; text: string }[];
    if (v.ask !== undefined) texts = [{ slot: 'ask', written: (v.as as Written | undefined) ?? null, text: v.ask.trim() }];
    else if (t.status === 'blocked') texts = t.blockers.map((bl, j) => ({ slot: `b${j}`, written: bl.kind, text: blockerText(bl) }));
    else { io.err(`${t.id} is ${t.status}: it has no blockers — pass the text you are about to write: --ask "…" [--as ${WRITTEN.join('|')}]`); return 2; }
    io.out(JSON.stringify(blockerRequest(t, cx, texts), null, 2));
    io.err(jevHint('blocker'));
    return 0;
  }
  // done: only for a condition the engine cannot check — Jev never replaces check's rules.
  let m;
  try { m = metOf(t, cx); } catch (e) { io.err(`${t.id}: the done check threw: ${(e as Error).message}`); return 2; }
  if (m !== undefined) { io.err(`${t.id}: "${describeDone(t.doneWhen, cx)}" is checked by the engine — check decides it, not Jev (jev done is for a judgment done condition)`); return 2; }
  const path = resolve(cwd, v.evidence!);
  if (!existsSync(path)) { io.err(`${v.evidence} does not exist`); return 2; }
  const text = readFileSync(path, 'utf8').trim();
  if (!text) { io.err(`${v.evidence} is empty`); return 2; }
  const tok = tokens(text);
  if (tok > 24_000) { io.err(`${v.evidence} is ~${tok} tokens — too much for one request (32k for the state plus a question); pass the excerpt that bears on the condition`); return 2; }
  io.out(JSON.stringify(doneRequest(t, cx, { source: v.evidence!, text }), null, 2));
  io.err(jevHint('done'));
  return 0;
}

function jevRoute(kind: 'blocker' | 'done', shown: string, path: string, v: JevOpts, board: Board, cx: Ctx): number {
  if (!existsSync(path)) { io.err(`${shown} does not exist`); return 2; }
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { io.err(`${shown} is not JSON: ${(e as Error).message}`); return 2; }
  const parsed: { raw: unknown; a: any }[] = [];
  for (const r of Array.isArray(raw) ? raw : [raw]) {
    const a = parseAnswers(r, kind);
    if (typeof a === 'string') { io.err(`${shown}: ${a}`); return 2; }
    parsed.push({ raw: r, a });
  }
  const th = cx.config.jev;
  if (kind === 'done') {
    const res = parsed.map(({ a }) => ({ ticket: a.meta.ticket as string, done: a.meta.done as string, evidence: a.meta.evidence as string, ...routeDone(a, th) }));
    if (v.json) io.out(JSON.stringify(res, null, 2));
    else for (const r of res) io.out(`${r.ticket} done: ${r.verdict} — ${r.relation} at ${r.confidence.toFixed(2)}: ${r.reason}\n  condition: ${r.done}\n  evidence:  ${r.evidence}`);
    return res.every((r) => r.verdict === 'close') ? 0 : 1;
  }
  const res = parsed.map(({ a }) => ({ ticket: a.meta.ticket as string, results: routeBlocker(a, th) }));
  if (v.save) for (const { raw: r, a } of parsed) {
    if (!board.some((t) => t.id === a.meta.ticket)) { io.err(`--save: ${a.meta.ticket} is not on the board`); return 2; }
    const out = join(cx.root, answersPath(a.meta.ticket));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(r, null, 2)}\n`);
    io.err(`saved ${answersPath(a.meta.ticket)} — check warns while a blocker it judged reads otherwise`);
  }
  if (v.json) io.out(JSON.stringify(res, null, 2));
  else for (const { ticket, results } of res) for (const r of results) io.out(blockerLine(ticket, r));
  return res.every((x) => x.results.every((r) => r.verdict === 'ok')) ? 0 : 1;
}

function blockerLine(ticket: string, r: BlockerVerdict): string {
  const what = r.slot === 'ask' ? `ask${r.written ? ` (as ${r.written})` : ''}` : `blockers[${r.slot.slice(1)}] (${r.written})`;
  const L = [
    `${ticket} ${what}: ${r.verdict} — Jev reads ${r.reads} (confidence ${r.confidence.toFixed(2)}; time with no source ${r.timeUnsourced.toFixed(2)}, tool step as a person's ${r.toolStepAsHuman.toFixed(2)})`,
    `  text: ${r.text}`,
  ];
  for (const x of r.reasons) L.push(`  · ${x}`);
  return L.join('\n');
}

// ── review ───────────────────────────────────────────────────────────────────────────────────────
// Pro review: requests out, ranked recommendations in. The engine never calls Jev: the jev-decide
// skill's runner does, and only on the user's request or ack (a review is paid).

type ReviewOpts = { ids?: string; status?: string; dupes?: boolean; facts?: string; out?: string; save?: boolean; json?: boolean };

function reviewArgsProblem(pos: string[], v: ReviewOpts): string {
  const given = (['ids', 'status', 'dupes', 'facts', 'out', 'save', 'json'] as const).filter((k) => v[k] !== undefined);
  if (pos[1] === 'route') {
    if (pos.length !== 3) return 'review route takes one answers file or folder';
    const extra = given.filter((k) => k !== 'save' && k !== 'json');
    return extra.length ? `review route takes no --${extra.join(', --')}` : '';
  }
  if (pos.length !== 1) return `review takes no argument "${pos[1]}" (review route <answers> routes answers)`;
  const extra = given.filter((k) => k === 'save' || k === 'json');
  if (extra.length) return `review takes no --${extra.join(', --')} (those belong to review route)`;
  if (v.status !== undefined && v.status !== 'live' && v.status !== 'all') return '--status must be live (open, blocked, paused) or all';
  if (v.ids !== undefined && !v.ids.split(',').some((x) => x.trim())) return '--ids needs ticket ids, comma-separated';
  return '';
}

/** `--facts <file>`: what the agent observed itself, per ticket — kept apart from the engine's evidence
 *  and from inference. `missing` names evidence it looked for and did not find. */
function readFacts(path: string, shown: string, board: Board): Facts | string {
  if (!existsSync(path)) return `${shown} does not exist`;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return `${shown} is not JSON: ${(e as Error).message}`; }
  const shape = `must be { "<ticket id>": { "observed": ["what you saw yourself, with where"], "missing": ["evidence you looked for and did not find"] } }`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${shown}: ${shape}`;
  for (const [id, f] of Object.entries(raw)) {
    if (!board.some((t) => t.id === id)) return `${shown}: no ticket ${id} on the board`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) return `${shown}.${id}: ${shape}`;
    for (const k of Object.keys(f)) if (k !== 'observed' && k !== 'missing') return `${shown}.${id}: unknown key "${k}" — ${shape}`;
    for (const k of ['observed', 'missing']) {
      const x = (f as Record<string, unknown>)[k];
      if (x !== undefined && (!Array.isArray(x) || !x.every((s) => typeof s === 'string' && s.trim() !== ''))) return `${shown}.${id}.${k}: must be a list of non-empty strings`;
    }
  }
  return raw as Facts;
}

const requestName = (r: ReviewRequest) => (r.meta.kind === 'ticket' ? r.meta.ticket : `pair-${r.meta.pair.join('+')}`).replace(/[^\w.+-]/g, '_');

function reviewBuild(v: ReviewOpts, board: Board, cx: Ctx, root: string, cwd: string, now: number): number {
  const ids = v.ids?.split(',').map((x) => x.trim()).filter(Boolean);
  const sel = selectTickets(board, { ids, status: v.status });
  if (typeof sel === 'string') { io.err(sel); return 2; }
  let facts: Facts | undefined;
  if (v.facts !== undefined) {
    const f = readFacts(resolve(cwd, v.facts), v.facts, board);
    if (typeof f === 'string') { io.err(f); return 2; }
    facts = f;
  }
  if (!sel.length) {
    io.out(`nothing to review: no ${v.status === 'all' ? '' : 'open, blocked or paused '}ticket${ids ? ` among ${ids.join(', ')}` : ' on the board'}`);
    return 0;
  }
  // Review never probes: reachability and reliability come from the log `next` keeps.
  const records = readProbeLog(root);
  const inp = { board, cx, now, next: nextReport(board, cx, loggedReachable(records), undefined, now).json, problems: runChecks(board, cx, { now }), probes: records, facts };
  const tickets = sel.map((t) => ticketRequest(t, inp));
  const pairs = v.dupes ? dupePairs(sel).map((p) => pairRequest(p, inp)) : [];
  const all = [...tickets, ...pairs];

  const out = v.out ? resolve(cwd, v.out) : join(cacheDir(root), 'review', today(now));
  for (const f of ['dossiers', 'requests', 'requests.json', 'summary.json']) rmSync(join(out, f), { recursive: true, force: true });
  mkdirSync(join(out, 'dossiers'), { recursive: true });
  mkdirSync(join(out, 'requests'), { recursive: true });
  for (const r of tickets) writeFileSync(join(out, 'dossiers', `${requestName(r)}.json`), `${JSON.stringify(r.state, null, 1)}\n`);
  for (const r of all) writeFileSync(join(out, 'requests', `${requestName(r)}.json`), `${JSON.stringify(r, null, 1)}\n`);
  writeFileSync(join(out, 'requests.json'), `${JSON.stringify(all, null, 1)}\n`);

  const tok = all.map(requestTokens);
  const sum = tok.reduce((a, b) => a + b, 0);
  const usd = (sum / 1e6) * USD_PER_MTOK;
  const questions = all.reduce((s, r) => s + Object.keys(r.questions).length, 0);
  const byStatus = ['open', 'blocked', 'paused', 'done', 'dropped'].map((s) => [s, sel.filter((t) => t.status === s).length] as const).filter(([, n]) => n);
  const over = all.flatMap((r) => {
    const st = tokens(JSON.stringify(r.state)) + Math.max(...Object.values(r.questions).map((q) => tokens(JSON.stringify(q))));
    return st > 32_000 ? [`⚠ ${requestName(r)}: ~${st} tokens of state plus its longest question, over the 32k a request allows — the runner will refuse it`] : [];
  });
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify({
    date: today(now), tickets: tickets.length, by_status: Object.fromEntries(byStatus), pairs: pairs.length, requests: all.length, questions,
    input_tokens: sum, usd: Math.round(usd * 1e6) / 1e6, usd_per_mtok: USD_PER_MTOK, probe_log_entries: records.length,
  }, null, 2)}\n`);

  const shown = relative(cwd, out) || '.';
  io.out(`review: ${tickets.length} ticket(s) (${byStatus.map(([s, n]) => `${n} ${s}`).join(' · ')})${v.dupes ? `, ${pairs.length} candidate duplicate pair(s)${pairs.length === MAX_PAIRS ? ` (the first ${MAX_PAIRS})` : ''}` : ''} — ${all.length} request(s), ${questions} question(s)`);
  io.out(`estimate: ~${sum} input tokens ≈ US$${usd.toFixed(6)} (Jev input at $${USD_PER_MTOK}/Mtok, output free; the runner's --estimate is authoritative)`);
  io.out(`wrote ${shown}/: dossiers/ (one per ticket), requests/ (one per request), requests.json (all of them), summary.json`);
  if (!records.length && tickets.some((r) => (r.meta as { facts: { resources: unknown[] } }).facts.resources.length)) io.out(`note: no probe log yet (${PROBE_LOG}) — run next first, so resource reliability has a history`);
  for (const l of over) io.out(l);
  io.out('');
  io.out(`A review is a set of paid Jev calls: send it only on the user's request or ack (asking for a review is the ack).`);
  io.out(`  node <jev-decide>/scripts/jev_decide.mts --raw --ack ${shown}/requests.json > ${shown}/answers.json`);
  io.out(`then: node tickets/engine/cli.mjs review route ${shown}/answers.json [--save]`);
  io.out('without an ack: say what it would ask and roughly what it costs, and judge the dossiers yourself');
  return 0;
}

function reviewRoute(shown: string, cwd: string, v: ReviewOpts, board: Board, cx: Ctx, now: number, engineDir: string): number {
  const path = resolve(cwd, shown);
  if (!existsSync(path)) { io.err(`${shown} does not exist`); return 2; }
  const dir = statSync(path).isDirectory();
  const files = dir ? readdirSync(path).filter((f) => f.endsWith('.json')).sort().map((f) => join(path, f)) : [path];
  const byKey = new Map<string, ReviewAnswers>();
  for (const f of files) {
    const where = dir ? relative(cwd, f) : shown;
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { if (dir) continue; io.err(`${where} is not JSON: ${(e as Error).message}`); return 2; }
    for (const r of Array.isArray(raw) ? raw : [raw]) {
      // In a folder, requests and summaries sit beside the answers: only answers count.
      if (dir && !(r && typeof r === 'object' && 'answers' in r)) continue;
      const a = parseReviewAnswers(r);
      if (typeof a === 'string') { io.err(`${where}: ${a}`); return 2; }
      const key = a.meta.kind === 'ticket' ? a.meta.ticket : a.meta.pair.join('+');
      if (byKey.has(key)) io.err(`${where}: a second answer for ${key} — the later one counts`);
      byKey.set(key, a);
    }
  }
  const list = [...byKey.values()];
  if (!list.length) { io.err(`no review answers in ${shown} — send the requests first (jev_decide.mts --raw --ack <dir>/requests.json > <dir>/answers.json)`); return 2; }
  const th = cx.config.jev.review;
  const rv = routeReview(list, th);
  if (v.save) {
    const gone = list.flatMap((a) => (a.meta.kind === 'ticket' ? [a.meta.ticket] : a.meta.pair)).filter((id) => !board.some((t) => t.id === id));
    if (gone.length) { io.err(`--save: ${[...new Set(gone)].join(', ')} not on the board`); return 2; }
    const date = today(now);
    mkdirSync(join(cx.root, 'tickets', 'review'), { recursive: true });
    writeFileSync(join(cx.root, reviewPath(date)), `${JSON.stringify(reviewRecord(list, rv, th, date, readVersion(engineDir)?.semver), null, 2)}\n`);
    io.err(`saved ${reviewPath(date)} — commit it with the ticket changes it leads to; nothing loads it at session start`);
  }
  if (v.json) io.out(JSON.stringify(rv, null, 2));
  else for (const l of reviewText(rv, th)) io.out(l);
  return [...rv.tickets, ...rv.pairs].some((x) => x.recommendations.length || x.judge.length) ? 1 : 0;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────

export async function main(argv: string[], engineUrl: URL): Promise<number> {
  const engineDir = real(dirname(fileURLToPath(engineUrl)));
  let parsed;
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }); } catch (e) {
    io.err(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values: v, positionals: pos } = parsed;
  const cmd = pos[0] ?? '';
  if (v.help || cmd === 'help') { io.out(USAGE); return 0; }
  if (!(cmd in ALLOWED)) { io.err(`unknown command "${cmd}"\n\n${USAGE}`); return 2; }
  const bad = Object.keys(v).filter((k) => v[k as keyof typeof v] !== undefined && !ALLOWED[cmd].includes(k));
  if (bad.length) { io.err(`${cmd || 'the summary'} takes no --${bad.join(', --')}\n\n${USAGE}`); return 2; }
  if (v.text && v.json) { io.err(`--text and --json: pick one (JSON is the default)\n\n${USAGE}`); return 2; }
  // next, list, show, check and coverage answer in JSON unless --text; --json is the default spelled out.
  const json = ['next', 'list', 'show', 'check', 'coverage', 'claim', 'release'].includes(cmd) ? !v.text : !!v.json;
  if (cmd === 'jev' || cmd === 'review') {
    const bad = cmd === 'jev' ? jevArgsProblem(pos, v) : reviewArgsProblem(pos, v);
    if (bad) { io.err(`${bad}\n\n${USAGE}`); return 2; }
  } else if (cmd === 'claim' || cmd === 'release') {
    const bad = claimArgsProblem(cmd, pos, v);
    if (bad) { io.err(`${bad}\n\n${USAGE}`); return 2; }
  } else {
    const wantArgs = cmd === 'show' ? 2 : 1;
    if (pos.length > wantArgs || (cmd === 'show' && pos.length < 2)) { io.err(`${cmd === 'show' ? 'show takes exactly one ticket id' : `unexpected argument "${pos[1]}"`}\n\n${USAGE}`); return 2; }
    if (cmd === 'list' && v.status !== undefined && v.status !== 'live' && v.status !== 'all') { io.err(`--status must be live (open, blocked, paused) or all\n\n${USAGE}`); return 2; }
  }

  const root = findRoot();
  const repoEngine = real(join(root, 'tickets', 'engine'));
  if (cmd === 'stamp') return report(stamp(engineDir, v.semver));
  if (cmd === 'init' || cmd === 'upgrade') {
    if (engineDir === repoEngine) { io.err(`${cmd} runs from the skill's copy of the engine: node <skill>/engine/cli.mjs ${cmd}`); return 2; }
    const o = cmd === 'init' ? init(root, engineDir, { ids: v.ids }) : upgrade(root, engineDir);
    for (const l of o.lines) (o.code ? io.err : io.out)(l);
    if (o.code || cmd === 'upgrade') return o.code;
    io.out(`next: add tickets to tickets/board.mts (or draft them: migrate --from-markdown <doc>), then node tickets/engine/cli.mjs check --text`);
    return 0;
  }
  const cwd = process.cwd();
  process.chdir(root);
  if (cmd === 'migrate') return migrateCmd(root, v['from-markdown'] && resolve(cwd, v['from-markdown']), v.out, v.ids);
  if (cmd === 'write') {
    io.err('write is gone in 0.5.0: no view is committed any more — read the board with next / list / show (JSON), or refresh the git-ignored status page with view; delete the old markers block (references/migration.md, Upgrading to 0.5.0)');
    return 2;
  }

  const loaded = await load(root);
  if (typeof loaded === 'string') { (json && cmd === 'check' ? (s: string) => emit({ ok: false, errors: [{ level: 'error', message: s }], warnings: [], notes: [] }) : io.err)(loaded); return 2; }
  if (loaded.problems.length) return printSchema(loaded.problems, json && cmd === 'check');
  const { cx, board } = loaded;
  const now = Date.now();
  // next, list, show, the status page and claim weigh this machine's claims as holds; check reads them
  // for its warnings only, and a review never — both must answer the same on every machine.
  const cxc: Ctx = { ...cx, claims: readClaims(root).claims };
  if (v.group !== undefined && !Object.prototype.hasOwnProperty.call(cx.config.groups, v.group)) {
    const keys = Object.keys(cx.config.groups);
    io.err(`--group: "${v.group}" is not a key of config.groups${keys.length ? ` (${keys.join(', ')})` : ' (none configured)'}`);
    return 2;
  }
  const scope = v.group !== undefined ? scopeOf(v.group, board, cxc) : undefined;

  if (cmd === 'jev') return jevCmd(pos, v, board, cx, cwd);
  if (cmd === 'review') return pos[1] === 'route' ? reviewRoute(pos[2], cwd, v, board, cx, now, engineDir) : reviewBuild(v, board, cx, root, cwd, now);

  if (cmd === 'check') {
    const problems = runChecks(board, cx, { now, engineDir: engineDir === repoEngine ? undefined : engineDir, skillDirs: skillDirs(root), claims: readClaims(root) });
    const errors = problems.filter((p) => p.level === 'error'), warnings = problems.filter((p) => p.level === 'warning'), notes = problems.filter((p) => p.level === 'note');
    if (json) emit({ ok: !errors.length, errors, warnings, notes });
    else {
      for (const p of problems) (p.level === 'error' ? io.err : io.out)(fmtProblem(p));
      io.out(`check: ${errors.length} error(s), ${warnings.length} warning(s) — ${board.length} tickets`);
    }
    return errors.length ? 1 : 0;
  }

  if (cmd === 'coverage') {
    // A hook that threw makes the count wrong, so no count at all: the messages on stderr, exit 1.
    const ev = evalCoverage(cx);
    if (ev.threw.length) { for (const m of ev.threw) io.err(m); return 1; }
    const c = tallyCoverage(ev.units);
    if (json) emit(c);
    else io.out(coverageText(c));
    return 0;
  }

  if (cmd === 'claim') return claimCmd(pos, v, board, cxc, root, now, engineDir, json, scope);
  if (cmd === 'release') return releaseCmd(pos, v, board, root, json);

  if (cmd === 'next') {
    const here = reachHere(v, board, cxc, root, now, engineDir);
    if (typeof here === 'string') { io.err(here); return 2; }
    const { box, probes, cached, seen, reachable } = here;
    const rep = nextReport(board, cxc, reachable, seen, now, scope);
    const probe: NextJson['probe'] = cached && {
      mode: 'cached', box: thisBox(),
      resources: Object.fromEntries(Object.keys(cxc.config.resources).map((n) => {
        const c = cached.get(n);
        return [n, c ? { state: c.usable ? 'usable' : c.here ? 'down' : 'absent', at: c.ts } : { state: 'unknown', at: null }];
      })),
    };
    if (json) emit(probe ? { ...rep.json, probe } : rep.json);
    else {
      const known = knownBoxes(cxc);
      if (probes && probes.size) io.out(`detected: ${[...probes].map(([r, p]) => `${r} ${p.usable ? 'yes' : p.here ? 'down (agent brings it up)' : 'no'}${p.note ? ` (${p.note})` : ''}`).join(' · ')}${known.length ? `  (override: --on ${known.join('|')})` : ''}`);
      if (probe) {
        const said = Object.entries(probe.resources).map(([r, c]) => `${r} ${c.state === 'usable' ? 'yes' : c.state === 'down' ? 'down (agent brings it up)' : c.state === 'absent' ? 'no' : 'unknown (never probed on this machine — counts as unreachable)'}${c.at ? ` (probed ${c.at})` : ''}`);
        io.out(`cached — --no-probe: no probe ran, nothing written${said.length ? `: ${said.join(' · ')}` : ''}`);
      }
      for (const l of nextText(board, cxc, rep, box ? `on ${box}` : 'here', now)) io.out(l);
    }
    return rep.json.next ? 0 : 3;
  }

  if (cmd === 'show') {
    const t = board.find((x) => x.id === pos[1]);
    if (!t) { io.err(`no ticket ${pos[1]} on the board`); return 2; }
    if (!v.members && json) { emit(showJson(t, board, cxc, now)); return 0; }
    if (v.members) {
      const ms = membersOf(t.id, board, cxc);
      if (!ms) { io.err(`${t.id}: its done condition ${t.status === 'dropped' ? '— none, it is dropped —' : `(${describeDone(t.doneWhen, cxc)})`} reports no members`); return 2; }
      const j = membersJson(t, ms, board, now);
      if (json) emit(j);
      else for (const l of membersText(j)) io.out(l);
      return 0;
    }
    for (const l of showText(t, board, cxc, now)) io.out(l);
    return 0;
  }

  if (cmd === 'list') {
    const j = listJson(board, cxc, lastProbes(readProbeLog(root), thisBox()), now, v.status === 'all' ? 'all' : 'live', v.group);
    if (json) emit(j);
    else for (const l of listText(j)) io.out(l);
    return 0;
  }

  if (cmd === 'view') return viewCmd(board, cxc, cwd, v.out, !!v.open, now, engineDir);

  // no command: counts + the live tickets
  const count = (s: string) => board.filter((t) => t.status === s).length;
  io.out(`board: ${count('open')} open · ${count('blocked')} blocked · ${count('paused')} paused · ${count('done')} done · ${count('dropped')} dropped`);
  for (const l of listText(listJson(board, cxc, lastProbes(readProbeLog(root), thisBox()), now, 'live'))) io.out(l);
  return 0;
}

/** A path made real as far as it exists (a file not written yet sits in a real folder). */
function realish(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) { tail.unshift(basename(head)); head = dirname(head); }
  return join(real(head), ...tail);
}

/** Why the status page may not be written at `path`, or '' — outside the repo is fine; inside it, the
 *  path must be git-ignored and untracked, so the page can never be committed. */
function pageRefusal(cx: Ctx, path: string): string {
  const r = relative(real(cx.root), realish(path));
  if (r.startsWith('..') || isAbsolute(r)) return '';
  if (!r) return 'it is the repo root';
  if (!cx.io.hasGit) return '';
  if (cx.io.git('ls-files', '--', r).out) return `${r} is tracked by git`;
  if (!cx.io.git('check-ignore', '-q', '--no-index', r).ok) return `${r} is in the repo and not git-ignored`;
  return '';
}

/** Write the status page, stamped with the engine version, HEAD (+dirty) and the time. */
function writePage(board: Board, cx: Ctx, path: string, engineDir: string, now: number): void {
  const head = cx.io.hasGit ? cx.io.git('rev-parse', '--short', 'HEAD').out : '';
  // --no-optional-locks: reading the status must not refresh (write) the index.
  const dirty = !!head && cx.io.git('--no-optional-locks', 'status', '--porcelain').out !== '';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderHtml(board, cx, {
    name: basename(cx.root), version: readVersion(engineDir)?.semver ?? 'unversioned',
    from: head ? `${head}${dirty ? '+dirty' : ''}` : 'no commit', generated: isoLocal(now),
  }));
}

/** `view`: (re)write the status page — by default at its fixed, git-ignored path — and print where. */
function viewCmd(board: Board, cx: Ctx, cwd: string, out: string | undefined, open: boolean, now: number, engineDir: string): number {
  const path = out !== undefined ? resolve(cwd, out) : statusPagePath(cx.root);
  const why = pageRefusal(cx, path);
  if (why) {
    io.err(`view: ${why} — the status page must never be committed: write it outside the repo or to a git-ignored path (the default ${rel(cx.root, statusPagePath(cx.root))} is, once _output/ is in .gitignore — init and upgrade add it)`);
    return 2;
  }
  writePage(board, cx, path, engineDir, now);
  io.out(path);
  if (open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined;
    if (!opener) io.err(`--open: no opener on ${process.platform} — open ${path} yourself`);
    else {
      const r = spawnSync(opener, [path], { stdio: 'ignore', timeout: 10_000 });
      if (r.error || r.status !== 0) io.err(`--open: ${opener} did not open it (${r.error ? (r.error as NodeJS.ErrnoException).code ?? r.error.message : `exit ${r.status}`}) — open ${path} yourself`);
    }
  }
  return 0;
}

// ── claim / release ──────────────────────────────────────────────────────────────────────────────
// A claim says who is working a ticket (or member) now, so parallel workers never take the same one.
// Machine-local (claims.mts), never on the board: claiming writes no repo file and needs no commit.

/** The claims on live work, oldest first — leftovers (closed ticket, met member) left out. */
function liveClaims(board: Board, cx: Ctx): Claim[] {
  const all = cx.claims ?? new Map<string, Claim>();
  const over = new Set(leftoverClaims(board, cx, all).map((x) => x.claim));
  return [...all.values()].filter((c) => !over.has(c)).sort((x, y) => x.at.localeCompare(y.at));
}

function claimArgsProblem(cmd: 'claim' | 'release', pos: string[], v: Record<string, unknown>): string {
  const named = (k: string) => v[k] === undefined || (typeof v[k] === 'string' && (v[k] as string).trim() !== '');
  for (const k of ['to', 'by', 'branch', 'member']) if (!named(k)) return `--${k} must not be empty`;
  if (cmd === 'release') {
    if (pos.length !== 2) return 'release takes exactly one ticket id';
    if (v.to === undefined && !v.force) return 'release needs --to <name> — the claim\'s own label (--force releases anyone\'s)';
    return '';
  }
  if (v.to === undefined) return 'claim needs --to <name>: the label of whoever works it (e.g. worker-3)';
  if (v.next) {
    if (pos.length > 1) return 'claim --next takes no ticket id (claim <id> takes one)';
    if (v.member !== undefined) return 'claim --next picks the member itself: drop --member';
    return '';
  }
  if (pos.length !== 2) return 'claim takes one ticket id, or --next for the topmost workable one';
  if (v.on !== undefined || v['no-probe'] || v.group !== undefined) return '--on, --no-probe and --group go with claim --next';
  return '';
}

type ClaimJson = {
  claim: Claim | null;
  /** What the claimed work is — the brief a worker starts from. */
  ticket?: { id: string; title: string; why: string; next: string; done: string; refs: string[]; hazard: string | null; wip: string | null };
  member?: { id: string; note: string | null; refs: string[] } | null;
  /** Holds that stand on a ticket claimed by id (claim <id> takes it anyway; next would not offer it). */
  held?: string[];
  /** Refused: the claim that already has it. */
  heldBy?: Claim;
  /** claim --next found nothing: why, and the claims to wait for. */
  stop?: { code: string; until?: string } | null;
  claimed?: Claim[];
};

function claimBrief(t: Ticket & { status: 'open' | 'blocked' }, m: MemberAt | undefined, cx: Ctx): Pick<ClaimJson, 'ticket' | 'member'> {
  const next = m ? clip(`member ${m.id}${m.note ? ` — ${m.note}` : ''}`, cx.config.caps.next) : t.next ?? '';
  return {
    ticket: { id: t.id, title: t.title, why: t.why, next, done: describeDone(t.doneWhen, cx), refs: t.refs ?? [], hazard: t.hazard ?? null, wip: t.wip ?? null },
    member: m ? { id: m.id, note: m.note ?? null, refs: m.refs } : null,
  };
}

function claimText(j: ClaimJson): string[] {
  if (j.heldBy) return [`already claimed by ${j.heldBy.to}${j.heldBy.branch ? ` on ${j.heldBy.branch}` : ''} since ${j.heldBy.at} (${j.heldBy.host})`];
  if (!j.claim) {
    const L = [`nothing left to claim here — stop: ${j.stop?.code ?? 'none'}${j.stop?.until ? ` ${j.stop.until}` : ''}`];
    for (const c of j.claimed ?? []) L.push(`  claimed: ${claimKey(c.ticket, c.member)}  ${c.to}${c.branch ? ` on ${c.branch}` : ''} since ${c.at}`);
    if (j.claimed?.length) L.push('  wait for these before you stop');
    return L;
  }
  const t = j.ticket!;
  const L = [`claimed ${claimKey(j.claim.ticket, j.claim.member)} for ${j.claim.to}${j.claim.branch ? ` on ${j.claim.branch}` : ''} — ${t.title}`];
  if (t.hazard) L.push(`  ⚠ HAZARD: ${t.hazard}`);
  L.push(`  why:  ${t.why}`, `  do:   ${t.next}`, `  done: ${t.done}`);
  if (t.refs.length) L.push(`  refs: ${t.refs.join(', ')}`);
  if (j.member?.refs.length) L.push(`  member refs: ${j.member.refs.join(', ')}`);
  if (t.wip) L.push(`  wip:  ${t.wip}`);
  for (const h of j.held ?? []) L.push(`  held (claimed anyway): ${h}`);
  return L;
}

function claimCmd(pos: string[], v: Record<string, any>, board: Board, cx: Ctx, root: string, now: number, engineDir: string, json: boolean, scope?: ReadonlySet<string>): number {
  const out = (j: ClaimJson, code: number) => { if (json) emit(j); else for (const l of claimText(j)) (code ? io.err : io.out)(l); return code; };
  const who = { to: v.to as string, by: v.by as string | undefined, branch: v.branch as string | undefined };
  if (v.next) {
    // A leftover's work is over (closed ticket, met member): it holds nothing, so clear it while here.
    for (const { claim: c } of leftoverClaims(board, cx, cx.claims ?? new Map())) dropClaim(root, c.ticket, c.member);
    const here = reachHere(v, board, cx, root, now, engineDir);
    if (typeof here === 'string') { io.err(here); return 2; }
    // Best first, as next offers them; a candidate another worker took meanwhile fails the exclusive
    // create, and the next one is tried.
    for (const w of workable(board, here.reachable, cx, now)) {
      if (scope && !scope.has(w.ticket.id)) continue;
      const t = w.ticket as Ticket & { status: 'open' | 'blocked' };
      for (const m of w.members ?? [undefined]) {
        const c = newClaim({ ticket: t.id, member: m?.id, ...who }, now);
        if (takeClaim(root, c)) continue;
        return out({ claim: c, ...claimBrief(t, m, cx) }, 0);
      }
    }
    return out({ claim: null, stop: stopOf(board, here.reachable, cx, now, scope), claimed: liveClaims(board, cx).filter((c) => !scope || scope.has(c.ticket)) }, 3);
  }
  const t = board.find((x) => x.id === pos[1]);
  if (!t) { io.err(`no ticket ${pos[1]} on the board`); return 2; }
  if (!isLive(t)) { io.err(`${t.id} is ${t.status} — only an open or blocked ticket can be claimed`); return 1; }
  const ms = membersOf(t.id, board, cx);
  let m: MemberAt | undefined;
  if (v.member !== undefined) {
    if (!ms) { io.err(`${t.id} reports no members — claim the ticket itself`); return 2; }
    m = ms.unmet.find((x) => x.id === v.member);
    if (!m) { io.err(`${t.id} has no unmet member ${v.member}`); return 1; }
  }
  const c = newClaim({ ticket: t.id, member: m?.id, ...who }, now);
  const heldBy = takeClaim(root, c);
  if (heldBy) return out({ claim: null, heldBy }, 1);
  const reachable = new Set(Object.keys(cx.config.resources));
  const held = [...holdsOf(t.id, board, cx), ...(m?.holds ?? [])].filter((h) => h.kind !== 'claim' && h.kind !== 'resource' && stands(h, board, reachable, now)).map(describeHold);
  return out({ claim: c, ...claimBrief(t as Ticket & { status: 'open' | 'blocked' }, m, cx), ...(held.length ? { held } : {}) }, 0);
}

function releaseCmd(pos: string[], v: Record<string, any>, board: Board, root: string, json: boolean): number {
  const key = claimKey(pos[1], v.member);
  const c = readClaims(root).claims.get(key);
  if (!c) { io.err(`${key} is not claimed on this machine`); return 1; }
  if (v.to !== undefined && v.to !== c.to && !v.force) { io.err(`${key} is claimed by ${c.to}, not ${v.to} — only its own worker releases it (--force releases anyone's)`); return 1; }
  dropClaim(root, c.ticket, c.member);
  if (json) emit({ released: c });
  else io.out(`released ${key} (was ${c.to}${c.branch ? ` on ${c.branch}` : ''}${board.some((t) => t.id === c.ticket) ? '' : '; the ticket is not on the board'})`);
  return 0;
}

/** What is reachable here, as `next` and `claim --next` see it: probed (and logged, and the status page
 *  refreshed), or — --no-probe — as last logged on this machine, or the resources of --on <box>. A
 *  string = a usage error. */
function reachHere(v: { on?: string; 'no-probe'?: boolean }, board: Board, cx: Ctx, root: string, now: number, engineDir: string):
  { box?: string; probes?: Map<string, Probe>; cached?: Map<string, Probe & { ts: string }>; seen?: Map<string, Probe>; reachable: Set<string> } | string {
  const box = v.on;
  if (box !== undefined) {
    const known = knownBoxes(cx);
    if (!known.includes(box)) return known.length ? `--on must be one of ${known.join(', ')}` : '--on: no boxes configured (config.boxes, resources[].on)';
  }
  // --no-probe (a supervisor reading a checkout it must not touch): no probe runs and nothing is
  // written — each resource as last logged on this machine, read-only; never logged = unknown, which
  // counts as unreachable. --on <box> probes nothing either way.
  const noProbe = !!v['no-probe'] || /^(1|true|yes|on)$/i.test(process.env.TICKET_BOARD_NO_PROBE ?? '');
  let probes: Map<string, Probe> | undefined;
  let cached: Map<string, Probe & { ts: string }> | undefined;
  if (box === undefined && noProbe) cached = lastProbes(readProbeLog(root), thisBox());
  else if (box === undefined) {
    probes = probeAll(cx);
    appendProbeLog(root, probes, now);
    // A probing run writes the cache anyway: it refreshes the status page there too, best effort.
    try { if (!pageRefusal(cx, statusPagePath(root))) writePage(board, cx, statusPagePath(root), engineDir, now); } catch { /* skipped */ }
  }
  const logged = cached && new Map([...cached].map(([n, { ts: _, ...p }]) => [n, p as Probe]));
  const seen = probes ?? logged;
  return { box, probes, cached, seen, reachable: seen ? reachableOf(seen) : onBox(box!, cx) };
}

function report(o: { code: number; lines: string[] }): number {
  for (const l of o.lines) (o.code ? io.err : io.out)(l);
  return o.code;
}

async function migrateCmd(root: string, from: string | undefined, out: string | undefined, ids: string | undefined): Promise<number> {
  if (!from) { io.err(`migrate needs --from-markdown <doc>\n\n${USAGE}`); return 2; }
  const src = from;
  if (!existsSync(src)) { io.err(`${from} does not exist`); return 2; }
  const outRel = out ?? 'tickets/board.draft.mts';
  const outAbs = resolve(root, outRel);
  // Refs resolve against the source doc's folder inside this repo; a doc elsewhere has no repo paths.
  const inside = (p: string) => { const r = relative(real(root), real(p)); return !r.startsWith('..') && !isAbsolute(r); };
  if (!inside(src)) { io.err(`${from} is outside this repo (${root}) — copy it into the repo first, then migrate it from there`); return 2; }
  if (!inside(dirname(outAbs))) { io.err(`--out ${outRel} is outside this repo (${root})`); return 2; }
  // Never the real board (a refined draft moved in keeps the draft header), never a non-draft file.
  const isBoard = real(outAbs) === real(join(root, 'tickets', 'board.mts'));
  if (existsSync(outAbs) && (isBoard || !isDraft(readFileSync(outAbs, 'utf8')))) { io.err(`${outRel} exists and is ${isBoard ? 'the board' : 'not a migrate draft'} — refusing to overwrite it (pick another --out)`); return 2; }

  // The id pattern: --ids, else the repo's config, else a generic one.
  const cfgPath = join(root, 'tickets', 'config.mts');
  let cfg: Record<string, unknown> | undefined;
  if (existsSync(cfgPath)) {
    try { cfg = (await import(pathToFileURL(cfgPath).href)).default; } catch (e) { io.err(`tickets/config.mts does not load: ${(e as Error).message}`); return 2; }
    const cp = configProblems(cfg);
    if (cp.length) { io.err(cp.join('\n')); return 2; }
  }
  let idRe: RegExp;
  try { idRe = ids ? parseIds(ids) : (cfg?.ids as RegExp | undefined) ?? new RegExp(`^${DEFAULT_ID_SRC}$`); } catch (e) { io.err(`--ids: ${(e as Error).message}`); return 2; }
  const docRel = relative(root, src).split('\\').join('/');
  const parsed = parseMarkdown(readFileSync(src, 'utf8'), {
    doc: docRel,
    exists: (p) => existsSync(join(root, p)),
    gitLog: (id) => {
      const r = spawnSync('git', ['-C', root, 'log', '--all', '--oneline', '-E', `--grep=(^|[^A-Za-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9A-Za-z]|$)`], { encoding: 'utf8' });
      return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
    },
    idSrc: inlineIdSrc(idRe.source),
  });
  const typesImport = (() => {
    const r = relative(dirname(outAbs), join(root, 'tickets', 'engine', 'types.mts')).split('\\').join('/');
    return r.startsWith('.') ? r : `./${r}`;
  })();
  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, draftSource(parsed, docRel, typesImport));

  // Validate the draft as written, against the repo's config with the suggested groups merged in.
  const groups = { ...Object.fromEntries(parsed.groups), ...((cfg?.groups as Record<string, string>) ?? {}) };
  const cx = makeCtx(root, { ...(cfg ?? {}), ids: idRe, groups } as never);
  let raw: unknown;
  let problems: Problem[];
  let caps: Problem[] = [];
  try {
    raw = (await import(`${pathToFileURL(outAbs).href}?t=${Date.now()}`)).default;
    ({ problems, caps } = draftProblems(raw, cx));
  } catch (e) { problems = [{ level: 'error', message: `the draft does not load: ${(e as Error).message}` }]; }
  io.out(reportText(parsed, {
    from: docRel, out: rel(root, outAbs), problems, caps,
    config: cfg ? 'tickets/config.mts with the suggested groups' : `a draft config (ids ${idRe}, the suggested groups)`,
  }));
  return problems.length ? 1 : 0;
}

