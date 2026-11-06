// Pro review: Jev judges the board's tickets in one pass. The engine NEVER calls Jev or the network:
// `review` builds a compact dossier per ticket from what the repo already holds (the board, git, the
// checks, the probe log `next` keeps) and one multi-question request per ticket; the jev-decide skill's
// runner sends them (`--raw --ack` — a review is paid, so only on the user's request or ack); `review
// route` turns the answers into ranked recommendations with the thresholds in config.jev.review.
// Routing reads only the answers (whose `meta` carries what it needs) and the config, so it is
// deterministic and tested from fixtures.
//
// The question set came out of a measured run on one board (stockapi, 2026-10-13; references/pro-review.md):
//   maturity — four atomic Nouls code combines with weights, never one composite Score (Jev's composite
//     ranked like an LLM baseline but put the cut-points a level too high): spec_clear, done_checkable,
//     next_evidenced, refs_present
//   per hand-written hold (blockers b0…, the window) — Choice <slot>.blocker_kind over the blocker kinds,
//     compared with how the board writes it; Score <slot>.blocker_validity
//   resource_reliability, dependency_risk (Scores); next_vague, stale, until_met, evidence_insufficient,
//     done_verifiable, contradiction (Nouls) — contradiction is phrased explicitly because both models
//     missed cross-field contradictions when only asked about readiness
//   done_supported (Choice) — closed tickets, with --status all; it stands only at the Choice threshold
//   duplicate pairs (--dupes, candidates found in code): Score duplicate + Nouls same_goal/refs/done
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type {
  Board, Ctx, Hold, MaturityPart, Problem, Probe, ResolvedReview, ReviewEvidence, Status, Ticket,
} from './types.mts';
import type { NextJson } from './main.mts';
import { authorizationsOf, byId, cacheDir, clearsAt, dependents, describeDone, describeHold, doneKind, holdsOf, isClock, isLive, memberSummary, membersOf, needs, refPath, stands } from './lib.mts';
import { metOf } from './checks.mts';
import { BASE_TOOLS, KINDS, READS_AS, SHOULD_BE, tokens, type Written } from './jev.mts';
import { isRecurring, isoLocal, today } from './windows.mts';

// ── the probe log ────────────────────────────────────────────────────────────────────────────────

/** Machine-local (init git-ignores tickets/.cache/). Never read by `check` or the view. Where it lives:
 *  probeLogPath — TICKET_BOARD_CACHE_DIR moves it out of the repo. */
export const PROBE_LOG = 'tickets/.cache/probes.jsonl';

export { cacheDir } from './lib.mts';
export const probeLogPath = (root: string): string => join(cacheDir(root), 'probes.jsonl');

/** This machine's name in the probe log. */
export const thisBox = (): string => hostname().split('.')[0];
/** How many recent probe results a dossier summarises per resource. */
export const PROBE_WINDOW = 10;
const PROBE_LOG_MAX_BYTES = 400_000;
const PROBE_LOG_KEEP_LINES = 2000;

/** One probe result. `ok` = usable; `here` = this machine hosts it (down = an agent bring-up). */
export type ProbeRecord = { ts: string; box: string; resource: string; ok: boolean; here: boolean };

/** `next` appends what each probe found, one JSON line per resource. Never throws: the log is a
 *  convenience, and `next` must work on a read-only checkout. Trimmed to its last lines past a size. */
export function appendProbeLog(root: string, probes: ReadonlyMap<string, Probe>, now: number, box: string = thisBox()): void {
  if (!probes.size) return;
  try {
    const path = probeLogPath(root);
    mkdirSync(dirname(path), { recursive: true });
    const ts = isoLocal(now);
    appendFileSync(path, [...probes].map(([resource, p]) => `${JSON.stringify({ ts, box, resource, ok: p.usable, here: p.here || p.usable })}\n`).join(''));
    if (statSync(path).size > PROBE_LOG_MAX_BYTES) {
      writeFileSync(path, `${readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(-PROBE_LOG_KEEP_LINES).join('\n')}\n`);
    }
  } catch { /* skipped */ }
}

export function readProbeLog(root: string): ProbeRecord[] {
  let text = '';
  try { text = readFileSync(probeLogPath(root), 'utf8'); } catch { return []; }
  return text.split('\n').flatMap((l): ProbeRecord[] => {
    if (!l.trim()) return [];
    try {
      const r = JSON.parse(l);
      if (typeof r?.ts !== 'string' || typeof r.resource !== 'string' || typeof r.ok !== 'boolean') return [];
      return [{ ts: r.ts, box: typeof r.box === 'string' ? r.box : '?', resource: r.resource, ok: r.ok, here: r.here === true || r.ok }];
    } catch { return []; }
  });
}

const probeState = (r: ProbeRecord) => (r.ok ? 'ok' : r.here ? 'down' : 'absent');

/** What `next` would treat as reachable here, by the latest logged probe of each resource. */
export function loggedReachable(records: ProbeRecord[]): Set<string> {
  const last = new Map<string, ProbeRecord>();
  for (const r of records) last.set(r.resource, r);
  return new Set([...last].filter(([, r]) => r.ok || r.here).map(([n]) => n));
}

/** The latest logged probe of each resource on `box`, as a probe result with its time — what `next
 *  --no-probe` reports instead of probing. A resource never logged on `box` is missing (unknown). */
export function lastProbes(records: ProbeRecord[], box: string): Map<string, Probe & { ts: string }> {
  const out = new Map<string, Probe & { ts: string }>();
  for (const r of records) if (r.box === box) out.set(r.resource, { here: r.here, usable: r.ok, ts: r.ts });
  return out;
}

export type ProbeFacts = { resource: string; of: number; down: number; latest: 'ok' | 'down' | 'absent' | null };

/** The last PROBE_WINDOW results for a resource: a line for the dossier and the counts routing uses.
 *  `down` counts results where this machine hosts it and it was not usable. */
export function probeSummary(records: ProbeRecord[], resource: string, n: number = PROBE_WINDOW): { summary: string; facts: ProbeFacts } {
  const mine = records.filter((r) => r.resource === resource);
  if (!mine.length) return { summary: `never probed on this machine — \`next\` logs every probe it runs (${PROBE_LOG})`, facts: { resource, of: 0, down: 0, latest: null } };
  const last = mine.slice(-n);
  const down = last.filter((r) => !r.ok && r.here).length;
  const absent = last.filter((r) => !r.here).length;
  const latest = last[last.length - 1];
  return {
    summary: `last ${last.length} of ${mine.length} probes, oldest first: ${last.map(probeState).join(' ')} — ${down} down${absent ? `, ${absent} absent (not hosted on that machine)` : ''}; latest ${latest.ts} on ${latest.box}: ${probeState(latest)}`,
    facts: { resource, of: last.length, down, latest: probeState(latest) },
  };
}

// ── selection ────────────────────────────────────────────────────────────────────────────────────

export const LIVE_STATUSES: readonly Status[] = ['open', 'paused'];

/** `--status live` (default) = open and paused; `all` adds done and dropped. `--ids` picks
 *  exactly those tickets, any status, unless `--status` is given too (then both must hold). */
export function selectTickets(board: Board, opts: { ids?: string[]; status?: string }): Ticket[] | string {
  const ids = opts.ids;
  if (ids) {
    const unknown = ids.filter((id) => !board.some((t) => t.id === id));
    if (unknown.length) return `no ticket ${unknown.join(', ')} on the board`;
  }
  const byStatus = (t: Ticket) => (opts.status === 'all' ? true : LIVE_STATUSES.includes(t.status));
  return board.filter((t) => (ids ? ids.includes(t.id) && (opts.status === undefined || byStatus(t)) : byStatus(t)));
}

// ── evidence helpers ─────────────────────────────────────────────────────────────────────────────

const CAP = { line: 300, head: 3, symbolLines: 30, stat: 25, refCommits: 3, folderCommits: 5, folderFiles: 6, sources: 3, evidence: 40, excerpt: 600, comments: 10, named: 5 };
const clip = (s: string, n: number = CAP.line) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lines = (s: string) => s.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
const LOG_FMT = ['--format=%h %ad %s', '--date=short'];

/** git with paths printed as they are (CJK file names unquoted). */
const git = (cx: Ctx, ...args: string[]) => cx.io.git('-c', 'core.quotepath=off', ...args);

/** An ERE that finds a ticket id as a whole token. */
const idPattern = (id: string) => `(^|[^A-Za-z0-9-])${esc(id)}([^0-9A-Za-z]|$)`;

/** An ERE for a calendar day in the forms people write it: 2026-10-17, 10-17, 10/17, 2026/10/17. */
export function dayPattern(day: string): string {
  const [y, m, d] = day.split('-');
  const part = (s: string) => (s.startsWith('0') ? `0?${s.slice(1)}` : s);
  return `(^|[^0-9])(${y}[-/.])?${part(m)}[-/.]${part(d)}([^0-9]|$)`;
}

/** An ERE for a wall-clock time: 09:00, 9:00. */
const timePattern = (hm: string) => {
  const [h, m] = hm.split(':');
  return `(^|[^0-9])${h.startsWith('0') ? `0?${h.slice(1)}` : h}[:：]${m}([^0-9]|$)`;
};

/** Where a date or time a ticket relies on comes from: lines in its refs that carry it, then commits
 *  whose message names both the ticket and it. Empty = no source found. */
export function sourcesOf(pattern: string, t: Ticket, cx: Ctx): string[] {
  const paths = (t.refs ?? []).map(refPath).filter((p) => cx.io.exists(p));
  const inRefs = paths.length
    ? lines(git(cx, 'grep', '--untracked', '-n', '-I', '-E', '-e', pattern, '--', ...paths).out).slice(0, CAP.sources).map((l) => clip(l, 200))
    : [];
  const inLog = lines(git(cx, 'log', '-E', '-i', `--grep=${idPattern(t.id)}`, `--grep=${pattern}`, '--all-match', '-n', String(CAP.sources), ...LOG_FMT).out)
    .map((l) => clip(`commit ${l}`, 200));
  return [...inRefs, ...inLog];
}

/** Tokens in prose that look like code: backticked spans, paths, file names, identifiers. */
export function identifiers(text: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => { const x = s.trim().replace(/^[`'"(]+|[`'".,;:)]+$/g, ''); if (x.length >= 3) out.add(x); };
  // each kind consumes what it matched, so a path's parts are not read again as words
  const take = (s: string, re: RegExp, group = 0) => s.replace(re, (...m) => { add(m[group]); return ' '; });
  let rest = take(text, /`([^`]+)`/g, 1);
  rest = take(rest, /[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+/g);
  rest = take(rest, /\b[\w-]{2,}\.[A-Za-z][A-Za-z0-9]{0,5}\b/g);
  take(rest, /\b(?:[a-z]+[A-Z]\w*|[A-Z][a-z0-9]+[A-Z]\w*|[A-Za-z]\w*_\w+|[A-Z]{2,}[A-Z0-9_]*)\b/g);
  return [...out];
}

const stringsIn = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(stringsIn) : v && typeof v === 'object' ? Object.values(v).flatMap(stringsIn) : [];

/** What the done commit's message should mention: the ticket id, and the done condition's names —
 *  its test file and name, answer doc, an extension kind's API names, a judgment's code-like words. */
export function doneSymbols(t: Ticket): string[] {
  const out = new Set<string>([t.id]);
  if (t.status === 'dropped') return [...out];
  const d = t.doneWhen as Record<string, unknown>;
  const add = (s: string) => { if (s.trim().length >= 3) out.add(s.trim()); };
  if (d.kind === 'judgment') for (const s of identifiers(String(d.when ?? ''))) add(s);
  else for (const [k, v] of Object.entries(d)) {
    if (k === 'kind') continue;
    for (const s of stringsIn(v)) { add(s); if (s.includes('/')) add(s.split('/').pop()!); }
  }
  return [...out].slice(0, 20);
}

const isDir = (cx: Ctx, p: string) => { try { return statSync(join(cx.root, p)).isDirectory(); } catch { return false; } };

/** A ref with its recent history: a file's last commits; a folder's last commits with the files each
 *  touched (so a file added next to the one cited is seen) and how many files it tracks. */
function refEntry(ref: string, cx: Ctx) {
  const p = refPath(ref);
  if (!cx.io.exists(p)) return { ref, exists: false };
  if (!isDir(cx, p)) {
    return { ref, exists: true, kind: 'file', last_commits: lines(git(cx, 'log', '-n', String(CAP.refCommits), ...LOG_FMT, '--', p).out).map((l) => clip(l, 160)) };
  }
  const prefix = p.endsWith('/') ? p : `${p}/`;
  const commits: string[] = [];
  let cur = '';
  let files: string[] = [];
  const flush = () => { if (cur) commits.push(clip(`${cur}${files.length ? ` [${files.slice(0, CAP.folderFiles).join(', ')}${files.length > CAP.folderFiles ? `, +${files.length - CAP.folderFiles}` : ''}]` : ''}`, 260)); };
  for (const l of git(cx, 'log', '-n', String(CAP.folderCommits), '--format=@@%h %ad %s', '--date=short', '--name-only', '--', p).out.split('\n')) {
    if (l.startsWith('@@')) { flush(); cur = l.slice(2); files = []; } else if (l.trim()) files.push(l.startsWith(prefix) ? l.slice(prefix.length) : l);
  }
  flush();
  const tracked = lines(git(cx, 'ls-files', '--', p).out).length;
  return { ref, exists: true, kind: 'folder', tracked_files: tracked, last_commits: commits };
}

/** A done commit: subject, date, the first lines, every message line naming the done condition, and
 *  the files it changed (`git show --stat`) — never just the head of the message. */
function doneCommit(t: Ticket & { status: 'done' }, cx: Ctx) {
  if (!git(cx, 'cat-file', '-e', `${t.commit}^{commit}`).ok) return { hash: t.commit, exists: false };
  const [hash, date, subject] = git(cx, 'show', '-s', '--format=%h%n%ad%n%s', '--date=short', t.commit).out.split('\n');
  const body = lines(git(cx, 'show', '-s', '--format=%B', t.commit).out);
  const syms = doneSymbols(t);
  const head = body.slice(0, CAP.head).map((l) => clip(l));
  const naming = body.slice(CAP.head).filter((l) => syms.some((s) => l.includes(s))).slice(0, CAP.symbolLines).map((l) => clip(l));
  const stat = lines(git(cx, 'show', '--stat=160', '--format=', t.commit).out).map((l) => l.trim());
  const statCapped = stat.length > CAP.stat ? [...stat.slice(0, CAP.stat - 1), `… ${stat.length - CAP.stat} more`, stat[stat.length - 1]] : stat;
  return { hash, exists: true, date, subject, head, lines_naming_done: naming, symbols: syms, message_lines: body.length, stat: statCapped };
}

/** A dropped ticket: the commit that wrote its reason, commits whose message names it and a drop, the
 *  commits that added or moved its entry (`git log -S "id: '<id>'"`), and whatever the reason names as
 *  its replacement — a resource in config.resources or another ticket. */
function dropEntry(t: Ticket & { status: 'dropped' }, board: Board, cx: Ctx) {
  const found = new Map<string, string>();
  const add = (ls: string[], how: string) => { for (const l of ls) if (!found.has(l)) found.set(l, how); };
  const snip = t.reason.slice(0, 60);
  add(lines(git(cx, 'log', '--reverse', '-S', snip, ...LOG_FMT).out).slice(0, 1), 'wrote the drop reason');
  add(lines(git(cx, 'log', '-E', '-i', `--grep=${idPattern(t.id)}`, '--grep=drop', '--all-match', '-n', '3', ...LOG_FMT).out), 'its message names the ticket and a drop');
  for (const q of [`id: '${t.id}'`, `id: "${t.id}"`, `"id": "${t.id}"`]) {
    const ls = lines(git(cx, 'log', '-S', q, '-n', '3', ...LOG_FMT).out);
    if (ls.length) { add(ls, 'added or moved its entry'); break; }
  }
  const resources = Object.entries(cx.config.resources)
    .filter(([n]) => new RegExp(`(^|[^\\w-])${esc(n)}([^\\w-]|$)`).test(t.reason))
    .map(([n, r]) => ({ resource: n, paths: r.paths, ...(r.on ? { on: r.on } : {}), ...(r.policy ? { policy: r.policy } : {}), ...(r.bringUp ? { bringUp: r.bringUp } : {}) }));
  const src = cx.config.ids.source.replace(/^\^/, '').replace(/\$$/, '');
  const ids = byId(board);
  const tickets = [...new Set([...t.reason.matchAll(new RegExp(`(?<![A-Za-z0-9])(?:${src})(?![A-Za-z0-9])`, 'g'))].map((m) => m[0]))]
    .filter((id) => id !== t.id && ids.has(id)).map((id) => ({ id, title: ids.get(id)!.title, status: ids.get(id)!.status }));
  return {
    commits: [...found].map(([line, found_by]) => ({ commit: clip(line, 200), found_by })),
    superseded_by: resources.length || tickets.length ? { resources, tickets } : 'the reason names no resource or ticket that replaced it',
  };
}

/** Inside the repo: never an absolute path or one that climbs out (a dossier may be sent to a paid API). */
const inRepo = (p: string) => !isAbsolute(p) && !p.startsWith('~') && !p.split(/[\\/]/).includes('..');

/** The repo files a judgment done condition names (VERSION, a capture, a doc): last commit + excerpt. */
function namedEvidence(t: Ticket, cx: Ctx) {
  if (t.status === 'dropped' || t.doneWhen.kind !== 'judgment') return [];
  const paths: string[] = [];
  for (const tok of identifiers(String((t.doneWhen as { when: string }).when)).filter(inRepo).slice(0, 12)) {
    const hits = cx.io.exists(tok) ? [tok] : !tok.includes('/') && /^[\w.-]+$/.test(tok) ? lines(git(cx, 'ls-files', '--', tok, `*/${tok}`).out).slice(0, 3) : [];
    for (const h of hits) if (!paths.includes(h)) paths.push(h);
  }
  return paths.slice(0, CAP.named).map((p) => {
    const last = lines(git(cx, 'log', '-n', '1', ...LOG_FMT, '--', p).out)[0] ?? 'no commit';
    if (isDir(cx, p)) return { path: p, last_commit: last, files: lines(git(cx, 'ls-files', '--', p).out).slice(0, 10) };
    return { path: p, last_commit: last, excerpt: clip(cx.io.read(p).trim(), CAP.excerpt) };
  });
}

/** Comment lines in tickets/board.mts that name the ticket (a window's source often sits there). */
function boardComments(t: Ticket, cx: Ctx): string[] {
  const re = new RegExp(idPattern(t.id));
  return cx.io.read('tickets/board.mts').split('\n')
    .filter((l) => /^\s*\/\//.test(l) && re.test(l)).map((l) => clip(l.replace(/^\s*\/\/\s?/, ''), 200)).slice(0, CAP.comments);
}

function repoEvidence(t: Ticket, cx: Ctx): ReviewEvidence[] {
  return cx.config.extensions.flatMap((e, i): ReviewEvidence[] => {
    if (!e.reviewEvidence) return [];
    let got: unknown;
    try { got = e.reviewEvidence(t, cx); } catch (x) { return [{ what: `extensions[${i}].reviewEvidence threw`, lines: [clip((x as Error).message)] }]; }
    if (!Array.isArray(got)) return [{ what: `extensions[${i}].reviewEvidence returned no list`, lines: [] }];
    return got.map((g) => ({
      what: clip(String((g as ReviewEvidence)?.what ?? '?'), 120),
      lines: (Array.isArray((g as ReviewEvidence)?.lines) ? (g as ReviewEvidence).lines : []).map((l) => clip(String(l))).slice(0, CAP.evidence),
    }));
  });
}

// ── the dossier ──────────────────────────────────────────────────────────────────────────────────

export type Facts = Record<string, { observed?: string[]; missing?: string[] }>;

/** Everything a dossier is built from, computed once per `review`. */
export type ReviewInput = {
  board: Board;
  cx: Ctx;
  now: number;
  /** `next --json` as it stands with the logged reachability (review itself never probes). */
  next: NextJson;
  /** `check`'s findings, board-wide. */
  problems: Problem[];
  probes: ProbeRecord[];
  /** What the agent observed itself (`--facts`), kept apart from the engine's evidence. */
  facts?: Facts;
  /** dependents(board), computed on first use. */
  dependents?: Map<string, string[]>;
};

export type Slot = { slot: string; written: Written };

function todayLine(now: number): string {
  const wd = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(now);
  return `${today(now)} (${wd}), ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
}

/** Which part of `next` names the ticket. */
function inNext(t: Ticket, n: NextJson): string {
  if (t.status === 'paused') return 'outside the queue (paused)';
  if (t.status === 'done' || t.status === 'dropped') return `closed (${t.status})`;
  if (n.next?.id === t.id) return 'next (the topmost ticket workable here)';
  if (n.then.includes(t.id)) return `then (workable, #${n.then.indexOf(t.id) + 2} in line)`;
  const c = n.clock.find((x) => x.id === t.id);
  if (c) return `clock (window closed; opens ${c.opens})`;
  if (n.owner.some((x) => x.id === t.id)) return 'owner ask';
  if (n.go.some((x) => x.id === t.id)) return 'owner go';
  if (n.external.some((x) => x.id === t.id)) return 'external';
  if (n.elsewhere.some((x) => x.id === t.id)) return 'elsewhere (needs a resource this machine cannot reach)';
  return 'held only by other tickets';
}

/** The days and times a hand-written hold carries, each with where it comes from. */
function holdDates(h: Hold, t: Ticket, cx: Ctx) {
  const days: { field: string; day: string }[] = [];
  if (h.kind === 'owner' || h.kind === 'go') days.push({ field: 'since', day: h.since });
  if (h.kind === 'external' && h.recheck) days.push({ field: 'recheck', day: h.recheck });
  if (h.kind === 'window' && !isRecurring(h)) days.push({ field: 'opens', day: h.opens.slice(0, 10) });
  const out: { field: string; value: string; sources: string[] }[] = days.map(({ field, day }) => ({ field, value: day, sources: sourcesOf(dayPattern(day), t, cx) }));
  if (h.kind === 'window' && isRecurring(h)) for (const field of ['from', 'to'] as const) out.push({ field, value: h[field], sources: sourcesOf(timePattern(h[field]), t, cx) });
  return out;
}

/** The dossier for one ticket: the state of a review request (also written out for the agent). */
export function dossier(t: Ticket, inp: ReviewInput): { state: Record<string, unknown>; slots: Slot[]; resources: ProbeFacts[]; deps: boolean; doneMet: boolean | null } {
  const { board, cx, now } = inp;
  const reachable = loggedReachable(inp.probes);
  const live = isLive(t);
  const blockers: readonly Hold[] = isLive(t) ? t.blockers ?? [] : [];
  const slots: Slot[] = [];
  let windowSlot = false;
  const holds = holdsOf(t.id, board, cx).map((h) => {
    const bi = blockers.indexOf(h);
    let slot: string | undefined;
    if (bi >= 0) slot = `b${bi}`;
    else if (h.kind === 'window' && !windowSlot) { windowSlot = true; slot = 'window'; }
    if (slot) slots.push({ slot, written: h.kind as Written });
    const at = clearsAt(h, now);
    const dates = slot ? holdDates(h, t, cx) : [];
    return {
      ...(slot ? { slot } : {}), hold: describeHold(h), kind: h.kind, stands_now: stands(h, board, reachable, now), clock: isClock(h, now),
      ...(at ? { clears_at: at.iso } : {}), ...(dates.length ? { dates } : {}),
    };
  });

  let met: { met: boolean; why?: string } | undefined;
  let metErr: string | undefined;
  try { met = metOf(t, cx); } catch (e) { metErr = (e as Error).message; }
  let nowLine: string | undefined;
  try { nowLine = t.status !== 'dropped' ? doneKind(t.doneWhen.kind, cx)?.now?.(t.doneWhen as never, t, cx) : undefined; } catch (e) { nowLine = `now threw: ${(e as Error).message}`; }
  const findings = inp.problems.filter((p) => p.id === t.id).map((p) => `${p.level}: ${p.message}`);
  const count = (lvl: string) => inp.problems.filter((p) => p.level === lvl).length;

  const resourceFacts: ProbeFacts[] = [];
  const resources = t.status === 'done' || t.status === 'dropped' ? [] : needs(t, cx).map((n) => {
    const r = cx.config.resources[n.needs];
    const s = probeSummary(inp.probes, n.needs);
    resourceFacts.push(s.facts);
    return { resource: n.needs, via: n.via, ...(r.on ? { on: r.on } : {}), ...(r.policy ? { policy: r.policy } : {}), ...(r.bringUp ? { bringUp: r.bringUp } : {}), probes: s.summary };
  });
  const ids = byId(board);
  const after = (live ? (t as { after?: string[] }).after ?? [] : []).map((a) => ({ id: a, status: ids.get(a)?.status ?? 'a group' }));
  inp.dependents ??= dependents(board, cx);
  const deps = (inp.dependents.get(t.id) ?? []).map((d) => ({
    id: d, status: ids.get(d)?.status,
    via: holdsOf(d, board, cx).find((h) => h.kind === 'ticket' && h.id === t.id)?.via,
  }));
  const named = namedEvidence(t, cx);
  const extra = repoEvidence(t, cx);
  const comments = boardComments(t, cx);
  const notes = inp.facts?.[t.id];
  // A ticket with members is worked member by member: its next is generated, and a hand-written one is
  // overridden (check warns), so the dossier says so instead of judging a stale or missing line.
  const ms = membersOf(t.id, board, cx);

  const state: Record<string, unknown> = {
    ...(t.authorizations?.length ? { authorizations: authorizationsOf(t, cx) } : {}),
    today: todayLine(now),
    ticket: ms && live ? { ...t, next: 'work its members one by one — the topmost workable member first (done_condition.members)' } : t,
    position: { priority: `${board.indexOf(t) + 1} of ${board.length} (array order = priority)`, in_next: inNext(t, inp.next), board_stop_code: inp.next.stop?.code ?? null },
    holds,
    done_condition: t.status === 'dropped' ? null : {
      describe: describeDone(t.doneWhen, cx),
      ...(nowLine ? { now: nowLine } : {}),
      ...(ms ? { members: memberSummary(ms, board) } : {}),
      check_met: metErr ? `the check threw: ${metErr}` : met ?? 'not mechanically checkable (a judgment, or a kind the engine cannot check)',
    },
    ...(named.length ? { named_evidence: named } : {}),
    check_findings: findings.length ? findings : 'none',
    board_check: `${count('error')} error(s), ${count('warning')} warning(s) board-wide`,
    refs: (t.refs ?? []).map((r) => refEntry(r, cx)),
    ...(t.status === 'done' ? { done_commit: doneCommit(t, cx) } : {}),
    ...(t.status === 'dropped' ? { drop: dropEntry(t, board, cx) } : {}),
    ...(resources.length ? { resources_needed: resources } : {}),
    ...(after.length ? { after } : {}),
    ...(deps.length ? { dependents: deps } : {}),
    ...(extra.length ? { repo_evidence: extra } : {}),
    ...(comments.length ? { board_comments: comments } : {}),
    ...(notes ? { agent_notes: { observed: notes.observed ?? [], missing: notes.missing ?? [] } } : {}),
    tools: [...BASE_TOOLS, ...cx.config.jev.tools],
  };
  tighten(state);
  return { state, slots, resources: resourceFacts, deps: after.length > 0 || deps.length > 0, doneMet: met ? met.met : null };
}

/** A request carries at most 32k tokens of state plus its longest question; keep a dossier well under. */
export const STATE_TOKEN_BUDGET = 24_000;

function tighten(state: Record<string, any>): void {
  if (tokens(JSON.stringify(state)) <= STATE_TOKEN_BUDGET) return;
  const dc = state.done_commit;
  if (dc?.lines_naming_done) { dc.lines_naming_done = dc.lines_naming_done.slice(0, 10); dc.stat = dc.stat.slice(-6); }
  for (const r of state.refs ?? []) if (r.last_commits) r.last_commits = r.last_commits.slice(0, 1);
  for (const e of state.repo_evidence ?? []) e.lines = e.lines.slice(0, 10);
  for (const n of state.named_evidence ?? []) if (n.excerpt) n.excerpt = clip(n.excerpt, 200);
}

// ── questions ────────────────────────────────────────────────────────────────────────────────────

export type Question = { type: 'choice' | 'noul' | 'score'; instructions: string; criteria: unknown };

/** The type each question asks, by its id with any slot prefix (`b0.`, `window.`) removed. */
export const QUESTION_TYPES: Record<string, Question['type']> = {
  spec_clear: 'noul', done_checkable: 'noul', next_evidenced: 'noul', refs_present: 'noul',
  blocker_kind: 'choice', blocker_validity: 'score', resource_reliability: 'score', dependency_risk: 'score',
  next_vague: 'noul', stale: 'noul', until_met: 'noul', evidence_insufficient: 'noul', done_verifiable: 'noul', contradiction: 'noul',
  done_supported: 'choice', duplicate: 'score', same_goal: 'noul', same_refs: 'noul', same_done: 'noul',
};
export const MATURITY_PARTS: readonly MaturityPart[] = ['spec_clear', 'done_checkable', 'next_evidenced', 'refs_present'];
export const baseId = (id: string) => id.slice(id.lastIndexOf('.') + 1);

const noul = (instructions: string, yes: string, no: string): Question => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });

/** The blocker kinds, with `resources` read as this state's `resources_needed`. */
const REVIEW_KINDS = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.replace(/`resources`/g, '`resources_needed`')]));

const VALIDITY_LEVELS = [
  'Not real: the state shows the hold has cleared or never applied; nothing it names stops the work now.',
  "Real but mistyped: something does stop the work, but the board writes it as the wrong kind — a clock written as a third party, an agent's own step written as someone else's, a decision written as a wait.",
  'Real and correctly typed, but under-specified: no recheck date, no source for a date or time it relies on (its `dates[].sources` is empty), or vague about who must do what.',
  'Real, correctly typed and specified: it says who or what, carries a recheck date or an evidenced window, and refs or commits back its dates.',
];
const RELIABILITY_LEVELS = [
  'Unavailable: not here or not usable, and no bring-up an agent can do.',
  'Fragile: reachable only through a bring-up whose result is unconfirmed, or the probes report it down or failing often.',
  'Usable with a caveat: the probes say usable, but a precondition must still be confirmed before use (a login, a policy limit).',
  'Dependable: the probes say usable with no caveat, and a documented bring-up exists if it goes down.',
];
const DEPENDENCY_LEVELS = [
  'None: nothing it waits on is open, and nothing waits on it.',
  'Low: dependencies exist but are done or nearly done; dependents could proceed without it.',
  'Moderate: a live dependency, or dependents waiting on it, with a clear path to clear it.',
  'High: the chain is stuck on an owner or third-party gate, or forms a cycle; dependents are stalled.',
];
export const LEVEL_NAMES: Record<string, string[]> = {
  blocker_validity: ['not real', 'mistyped', 'under-specified', 'specified'],
  resource_reliability: ['unavailable', 'fragile', 'usable with a caveat', 'dependable'],
  dependency_risk: ['none', 'low', 'moderate', 'high'],
  duplicate: ['different', 'related, needs review', 'same'],
};

function nextEvidenced(status: Status): Question {
  if (status === 'paused') return noul('`ticket` is paused until `ticket.until`. Is that decision backed by evidence in the state — a ref, a commit or a doc that records why it was parked and what resumes it?', 'A ref, commit or doc records why it is parked and what resumes it.', 'The pause is only asserted: nothing in the state records it.');
  if (status === 'done') return noul('Is closing `ticket` backed by evidence in the state — the done commit (`done_commit`: its message lines and the files it changed), or a ref that records the result?', 'The done commit or a ref shows the work that closed it.', 'The closing is only asserted: nothing in the state shows the work.');
  if (status === 'dropped') return noul('Is dropping `ticket` backed by evidence in the state — the commit that dropped it (`drop.commits`) and, when `ticket.reason` names a replacement, that replacement (`drop.superseded_by`)?', 'A commit records the drop, and any replacement the reason names exists.', 'The drop is only asserted: no commit records it, or the replacement it names is missing.');
  return noul('Is `ticket.next` backed by evidence in the state — a ref, a commit, a capture or a doc that shows the step is the right one and can be taken (its tool or script exists, its input is at hand)?', 'Named refs, commits or captures stand behind the next step.', 'The next step is only asserted: nothing in the state stands behind it.');
}

/** The questions for one ticket, chosen by its status and data. Every instruction carries the whole
 *  question (ids are for code). */
export function ticketQuestions(t: Ticket, x: { slots: Slot[]; resources: boolean; deps: boolean }): Record<string, Question> {
  const q: Record<string, Question> = {};
  const live = isLive(t);
  const closed = t.status === 'done' || t.status === 'dropped';
  q.spec_clear = noul('Do `ticket.title` and `ticket.why` say clearly what the ticket is to achieve and why — clearly enough that two people reading them would agree on the goal?', 'The goal and the reason are clear.', 'The goal is vague, or the title and why disagree about it, or it bundles goals that should be separate tickets.');
  if (t.status !== 'dropped') q.done_checkable = noul('Does the done condition (`done_condition.describe`) say concretely which state of the repo counts as done — a named test, an answer marker in a doc, a level, an artifact or an observable result — rather than a vague aim?', 'It names a concrete, checkable state.', 'It is a vague aim: nobody could say exactly when it is met.');
  q.next_evidenced = nextEvidenced(t.status);
  if (t.status !== 'dropped') q.refs_present = noul('Does `ticket` name the refs needed to act on it or judge it — the doc that records its plan or answer, the tool its next step runs, the source behind a date or window it relies on — and do they exist (`refs[].exists`)?', 'The refs it needs are named and exist.', 'A ref it needs is not named, or a named one is missing.');
  for (const { slot, written } of x.slots) {
    const which = `the hold in \`holds\` whose \`slot\` is "${slot}"`;
    q[`${slot}.blocker_kind`] = { type: 'choice', instructions: `Read ${which} — what the board says stands between \`ticket\` and work — together with \`ticket.next\`, \`tools\` and \`resources_needed\`. What does it actually wait on?`, criteria: REVIEW_KINDS };
    q[`${slot}.blocker_validity`] = { type: 'score', instructions: `Is ${which} still real, and is it written as the right kind${written === 'window' ? ' (a window: a clock, with its hours evidenced)' : ''}? Its \`dates\` list every day or time it carries, each with the \`sources\` found for it in the refs and in commit messages naming the ticket (empty = none found).`, criteria: VALIDITY_LEVELS };
  }
  if (x.resources && !closed) q.resource_reliability = { type: 'score', instructions: "How dependable are the resources in `resources_needed` for `ticket`'s work? Judge from each one's `probes` (its recent probe history on this machine), `policy` and `bringUp`.", criteria: RELIABILITY_LEVELS };
  if (x.deps && !closed) q.dependency_risk = { type: 'score', instructions: "How much risk do `ticket`'s dependencies carry — the tickets it waits on (`after`, ticket holds in `holds`) and the tickets that wait on it (`dependents`)?", criteria: DEPENDENCY_LEVELS };
  if (live) q.next_vague = noul('Is `ticket.next` too vague for an agent to act on now — no concrete action, script, target, or order of steps?', 'An agent could not start from it without first working out what to do.', 'It names a concrete action an agent can start.');
  if (live) q.stale = noul('Has `ticket` made no progress for more than about two weeks? Judge from the dates of the commits listed in `refs` and the dates in `holds`, against `today`.', 'Nothing in the state shows work on it in the last two weeks.', 'Commits or other dated evidence show recent work on it.');
  if (t.status === 'paused') {
    q.stale = noul('`ticket` is paused. Has it sat parked for more than about two weeks with nothing in the state — the dates of the commits in `refs`, `ticket.until` — suggesting it will resume? Judge against `today`.', 'It has sat parked for weeks with no sign it will resume.', 'It was parked recently, or the state shows it will resume.');
    q.until_met = noul('`ticket` is paused until `ticket.until`. Does the state show that this has now happened — the decision was made, the event occurred, the thing it waits for exists?', 'The state shows what it waits for has happened.', 'Nothing in the state shows it has happened.');
  }
  q.evidence_insufficient = noul('Does the state lack evidence needed to judge `ticket`\'s status and readiness — for example the doc that records its answer, the capture or commit behind its next step or its closing, or the source of a date or window it relies on? `agent_notes.missing`, when present, names evidence an agent looked for and did not find.', 'Something needed to judge it is missing from the state.', 'The state holds what is needed to judge it.');
  if (t.status !== 'dropped') q.done_verifiable = noul('Can `ticket`\'s done condition (`done_condition`) be verified mechanically — a test, an answer marker, a registry level — or by named evidence such as a commit, a capture or a doc?', 'A mechanical check or named evidence verifies it.', "Only someone's unanchored judgment can say it is met.");
  q.contradiction = noul('Do any two of `ticket`\'s fields contradict each other, or the state? Compare every pair. For example: a blocker says the ticket waits on someone else to do X while `ticket.next` has the agent doing X itself; a number, count or level in `ticket.next` or `ticket.why` disagrees with `done_condition.now` or `done_condition.check_met`; the title names work the done condition does not cover; the status disagrees with `done_condition.check_met`. A difference in wording or detail is not a contradiction.', 'Two fields (or a field and the state) say incompatible things: one says A where the other says not-A.', 'Every field agrees with the others and with the state.');
  if (t.status === 'done') q.done_supported = { type: 'choice', instructions: 'Judge only from `done_commit` — its message lines (`head`, `lines_naming_done`) and the files it changed (`stat`). How does it relate to the claim that `done_condition.describe` is met for `ticket`?', criteria: { supports: 'It states that the condition is met, or directly implies it.', contradicts: 'It states that the condition is not met, or implies it is false.', says_nothing: 'It does not address whether the condition is met, either way.' } };
  return q;
}

// ── requests ─────────────────────────────────────────────────────────────────────────────────────

export type TicketMeta = {
  tool: 'ticket-board'; check: 'review'; kind: 'ticket';
  ticket: string; status: Status; priority: number; ids: string[];
  /** The hand-written holds asked about, and how the board writes each. */
  holds: Slot[];
  /** Deterministic facts routing uses as they are: the done condition per `check`, the probe log. */
  facts: { done_met: boolean | null; resources: ProbeFacts[] };
};
export type PairMeta = {
  tool: 'ticket-board'; check: 'review'; kind: 'pair';
  pair: [string, string]; ids: string[]; shared_refs: string[]; shared_words: string[];
};
export type ReviewRequest = { meta: TicketMeta | PairMeta; state: Record<string, unknown>; questions: Record<string, Question> };

export function ticketRequest(t: Ticket, inp: ReviewInput): ReviewRequest {
  const d = dossier(t, inp);
  const questions = ticketQuestions(t, { slots: d.slots, resources: d.resources.length > 0, deps: d.deps });
  return {
    meta: {
      tool: 'ticket-board', check: 'review', kind: 'ticket', ticket: t.id, status: t.status, priority: inp.board.indexOf(t) + 1,
      ids: Object.keys(questions), holds: d.slots, facts: { done_met: d.doneMet, resources: d.resources },
    },
    state: d.state,
    questions,
  };
}

// ── duplicate candidates ─────────────────────────────────────────────────────────────────────────

export const MAX_PAIRS = 20;
const STOP_WORDS = new Set(('the and for with from into onto that this then than when what its not all any via per one two new '
  + 'first next only also each more both after before over under out off are was were has have had can will must should does did '
  + 'done make use using add fix get set run').split(' '));
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** A title's keywords: lower-cased words of 3+ letters minus stop words and numbers; a CJK run as its
 *  character bigrams (so 複委託 and 委託單 share 委託). */
export function titleWords(title: string): Set<string> {
  const out = new Set<string>();
  for (const tok of title.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (!tok) continue;
    if (CJK.test(tok)) { const ch = [...tok]; for (let i = 0; i + 1 < ch.length; i++) out.add(ch[i] + ch[i + 1]); continue; }
    if (tok.length < 3 || /^\d+$/.test(tok) || STOP_WORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

export type Pair = { a: string; b: string; shared_refs: string[]; shared_words: string[] };

/** Candidate duplicates among the selected tickets (never dropped ones; at least one of each pair
 *  live): two or more shared title keywords, or a shared ref plus a keyword, or two shared refs. A ref
 *  most tickets cite (a hub doc) does not count. Strongest overlap first, at most `max`. */
export function dupePairs(selected: Ticket[], max: number = MAX_PAIRS): Pair[] {
  const pool = selected.filter((t) => t.status !== 'dropped');
  const refs = new Map(pool.map((t) => [t.id, new Set((t.refs ?? []).map(refPath))]));
  const uses = new Map<string, number>();
  for (const s of refs.values()) for (const r of s) uses.set(r, (uses.get(r) ?? 0) + 1);
  const hub = Math.max(3, Math.ceil(pool.length * 0.2));
  const words = new Map(pool.map((t) => [t.id, titleWords(t.title)]));
  const out: (Pair & { score: number; i: number })[] = [];
  pool.forEach((a, i) => pool.slice(i + 1).forEach((b) => {
    if (!LIVE_STATUSES.includes(a.status) && !LIVE_STATUSES.includes(b.status)) return;
    const sr = [...refs.get(a.id)!].filter((r) => refs.get(b.id)!.has(r) && uses.get(r)! <= hub);
    const sw = [...words.get(a.id)!].filter((w) => words.get(b.id)!.has(w));
    if (sw.length >= 2 || (sr.length >= 1 && sw.length >= 1) || sr.length >= 2) out.push({ a: a.id, b: b.id, shared_refs: sr, shared_words: sw, score: 2 * sr.length + sw.length, i });
  }));
  return out.sort((x, y) => y.score - x.score || x.i - y.i).slice(0, max).map(({ a, b, shared_refs, shared_words }) => ({ a, b, shared_refs, shared_words }));
}

function pairSide(t: Ticket, cx: Ctx) {
  return {
    id: t.id, title: t.title, why: t.why, status: t.status,
    ...(isLive(t) ? { next: t.next } : {}),
    ...(t.status === 'paused' ? { until: t.until } : {}),
    done_condition: t.status === 'dropped' ? null : describeDone(t.doneWhen, cx),
    refs: t.refs ?? [],
  };
}

export function pairRequest(p: Pair, inp: ReviewInput): ReviewRequest {
  const ids = byId(inp.board);
  const questions: Record<string, Question> = {
    duplicate: { type: 'score', instructions: '`a` and `b` are two tickets on one work board that were paired because they share refs or title words (`overlap`). Are they the same work?', criteria: ['Different: they aim at different results; the overlap is incidental.', 'Related, needs review: they overlap in part — one covers part of the other, or they share a step — but neither replaces the other.', 'Same: they aim at the same result; finishing one would finish the other.'] },
    same_goal: noul('Do `a` and `b` aim at the same result (compare their titles and why)?', 'They aim at the same result.', 'They aim at different results.'),
    same_refs: noul('Do `a` and `b` rely on the same evidence and tools — the same docs, captures or scripts in their refs?', 'They rely on the same evidence and tools.', 'They rely on different evidence or tools.'),
    same_done: noul("Would meeting `a`'s done condition also meet `b`'s, and the other way round?", 'Either done condition meets the other.', 'Their done conditions can be met separately.'),
  };
  return {
    meta: { tool: 'ticket-board', check: 'review', kind: 'pair', pair: [p.a, p.b], ids: Object.keys(questions), shared_refs: p.shared_refs, shared_words: p.shared_words },
    state: {
      today: todayLine(inp.now), a: pairSide(ids.get(p.a)!, inp.cx), b: pairSide(ids.get(p.b)!, inp.cx),
      overlap: { shared_refs: p.shared_refs, shared_title_words: p.shared_words }, tools: [...BASE_TOOLS, ...inp.cx.config.jev.tools],
    },
    questions,
  };
}

/** Jev's input price (jev-1.13, docs.typesafe.ai/models.md, 2026-10; output tokens are free) — the
 *  jev-decide runner's `--estimate` is authoritative. */
export const USD_PER_MTOK = 0.042;

/** Rough input tokens of a request as the runner sends it ({state, model, questions}). */
export const requestTokens = (r: ReviewRequest): number => tokens(JSON.stringify({ state: r.state, model: 'jev-latest', questions: r.questions }));

// ── answers ──────────────────────────────────────────────────────────────────────────────────────

type ChoiceA = { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number };
type NoulA = { type: 'noul'; noul: number };
type ScoreA = { type: 'score'; score: number; confidence: number; probabilities?: Record<string, number>; legend?: unknown };
type Answer = ChoiceA | NoulA | ScoreA;
export type ReviewAnswers = { meta: TicketMeta | PairMeta; model?: string; answers: Record<string, Answer>; usage?: { input_tokens?: number; output_tokens?: number } };

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const SHAPE: Record<Question['type'], (a: unknown) => boolean> = {
  choice: (a) => isObj(a) && typeof a.choice === 'string' && typeof a.confidence === 'number' && isObj(a.probabilities),
  noul: (a) => isObj(a) && typeof a.noul === 'number',
  score: (a) => isObj(a) && typeof a.score === 'number' && typeof a.confidence === 'number',
};
/** `blocked`: answers saved before 0.12.0. */
const STATUSES = ['open', 'blocked', 'paused', 'done', 'dropped'];

/** Is this the answers to a review request (the runner's --raw output)? A string = what is wrong. */
export function parseReviewAnswers(raw: unknown): ReviewAnswers | string {
  if (!isObj(raw) || !isObj(raw.meta) || !isObj(raw.answers)) return 'not a jev answers file — expected {meta, answers} as jev_decide.mts --raw prints it';
  const m = raw.meta;
  if (m.tool !== 'ticket-board' || m.check !== 'review') return `answers for ${m.tool ?? '?'} ${m.check ?? '?'}, not ticket-board review`;
  if (!Array.isArray(m.ids) || !m.ids.length || !m.ids.every((x: unknown) => typeof x === 'string')) return 'meta.ids is missing';
  if (m.kind === 'ticket') {
    if (typeof m.ticket !== 'string' || !STATUSES.includes(m.status) || typeof m.priority !== 'number') return 'meta: a ticket review needs ticket, status and priority';
    if (!Array.isArray(m.holds) || !m.holds.every((h: unknown) => isObj(h) && typeof h.slot === 'string' && h.written in READS_AS)) return 'meta.holds: each needs slot and written (owner, go, external or window)';
    if (!isObj(m.facts) || !Array.isArray(m.facts.resources)) return 'meta.facts is missing';
  } else if (m.kind === 'pair') {
    if (!Array.isArray(m.pair) || m.pair.length !== 2 || !m.pair.every((x: unknown) => typeof x === 'string')) return 'meta.pair: two ticket ids';
  } else return `meta.kind "${m.kind}" is not ticket or pair`;
  for (const id of m.ids as string[]) {
    const type = QUESTION_TYPES[baseId(id)];
    if (!type) return `meta.ids: "${id}" is not a review question`;
    if (!SHAPE[type](raw.answers[id])) return `answers["${id}"] is not a ${type} answer`;
  }
  return raw as ReviewAnswers;
}

/** A Score's level: the most probable one (ties: the lower), else the rounded score. */
export function scoreLevel(a: ScoreA): number {
  const p = a.probabilities;
  if (isObj(p) && Object.keys(p).length) {
    return Number(Object.entries(p).sort((x, y) => y[1] - x[1] || Number(x[0]) - Number(y[0]))[0][0]);
  }
  return Math.round(a.score);
}

// ── routing ──────────────────────────────────────────────────────────────────────────────────────

export type Action =
  | 'fix-contradiction' | 'reclassify-blocker' | 'close-paused' | 'reopen-paused' | 'bring-up-resource'
  | 'clarify-or-split' | 'gather-evidence' | 'merge-duplicate' | 'drop-or-keep' | 'unblock-chain';

/** Who decides each action, and how it ranks. Dropping a ticket — a merge drops one — and changing
 *  direction are the owner's; the rest is ordinary board work for the agent. */
export const ACTIONS: Record<Action, { decides: 'agent' | 'owner'; severity: number; what: string }> = {
  'fix-contradiction': { decides: 'agent', severity: 4, what: 'fix a contradiction' },
  'reclassify-blocker': { decides: 'agent', severity: 4, what: 'reclassify a blocker' },
  'close-paused': { decides: 'agent', severity: 3, what: 'close a paused ticket' },
  'reopen-paused': { decides: 'agent', severity: 3, what: 'reopen a paused ticket' },
  'bring-up-resource': { decides: 'agent', severity: 3, what: 're-probe or bring up a resource' },
  'clarify-or-split': { decides: 'agent', severity: 2, what: 'clarify or split the ticket' },
  'gather-evidence': { decides: 'agent', severity: 2, what: 'gather the evidence named as missing' },
  'merge-duplicate': { decides: 'owner', severity: 2, what: 'merge a duplicate (one ticket is dropped)' },
  'drop-or-keep': { decides: 'owner', severity: 1, what: 'drop it or keep it' },
  'unblock-chain': { decides: 'owner', severity: 1, what: 'unstick a stalled chain' },
};

export type Recommendation = { action: Action; decides: 'agent' | 'owner'; what: string; reasons: string[]; from: string[]; strength: number };
export type Judge = { question: string; value: string; why: string };
export type TicketRoute = {
  kind: 'ticket'; ticket: string; status: Status; priority: number;
  /** The weighted mean of the maturity Nouls (0–1); null when none was asked. */
  maturity: number | null; components: Partial<Record<MaturityPart, number>>;
  recommendations: Recommendation[]; judge: Judge[];
};
export type PairRoute = {
  kind: 'pair'; pair: [string, string]; level: number; reads: string; confidence: number;
  same: { goal?: number; refs?: number; done?: number };
  recommendations: Recommendation[]; judge: Judge[];
};

/** A Noul's finding: which reading is the problem, what to do, and why. */
const NOUL_FINDINGS: Record<string, { when: boolean; action: Action | ((s: Status) => Action); why: string | ((s: Status) => string) }> = {
  spec_clear: { when: false, action: 'clarify-or-split', why: 'the goal is not clear from title and why — rewrite them, or split the ticket if it holds two goals' },
  done_checkable: { when: false, action: 'clarify-or-split', why: 'the done condition is a vague aim — make it a test, an answer marker or a level the engine checks' },
  done_verifiable: { when: false, action: 'clarify-or-split', why: 'only unanchored judgment could say it is met — anchor it to a check or to named evidence' },
  next_vague: { when: true, action: 'clarify-or-split', why: '`next` is not an action an agent can start — write the ONE concrete next action' },
  next_evidenced: {
    when: false, action: 'gather-evidence',
    why: (s) => s === 'paused' ? 'nothing records why it is parked or what resumes it — add the ref or commit that does'
      : s === 'done' ? 'nothing shows the work that closed it — name the commit or ref that does, or re-check it'
        : s === 'dropped' ? 'nothing records the drop or its replacement — name the commit, and what replaced it'
          : 'nothing in the repo stands behind the next step — add the ref, commit or capture that does, or find out first',
  },
  refs_present: { when: false, action: 'gather-evidence', why: 'it does not name the refs it needs (the plan or answer doc, the tool, the source of its dates) — add them' },
  evidence_insufficient: { when: true, action: 'gather-evidence', why: 'the state lacks evidence needed to judge it — find it (never guess); the dossier shows what is there' },
  contradiction: { when: true, action: 'fix-contradiction', why: 'two of its fields say incompatible things — find the pair and make them agree' },
  stale: { when: true, action: 'drop-or-keep', why: (s) => (s === 'paused' ? 'parked for weeks with no sign it resumes — keep it parked (say what resumes it) or drop it' : 'no progress for about two weeks — keep it (and say what resumes it) or drop it') },
  until_met: { when: true, action: 'reopen-paused', why: 'what it was paused until appears to have happened — reopen it with a next' },
};

const f2 = (n: number) => n.toFixed(2);

class Recs {
  m = new Map<Action, Recommendation>();
  judge: Judge[] = [];
  add(action: Action, reason: string, from: string, strength: number) {
    const r = this.m.get(action);
    if (r) { r.reasons.push(reason); r.from.push(from); r.strength = Math.max(r.strength, strength); return; }
    this.m.set(action, { action, decides: ACTIONS[action].decides, what: ACTIONS[action].what, reasons: [reason], from: [from], strength: Math.round(strength * 100) / 100 });
  }
  /** Most severe first, then the most confident. */
  list(): Recommendation[] {
    return [...this.m.values()].sort((x, y) => ACTIONS[y.action].severity - ACTIONS[x.action].severity || y.strength - x.strength);
  }
}

/** One ticket's answers → its maturity, ranked recommendations and the mid band left to the agent. */
export function routeTicket(a: ReviewAnswers, th: ResolvedReview): TicketRoute {
  const m = a.meta as TicketMeta;
  const ans = a.answers;
  const r = new Recs();
  const mid = (p: number) => p >= th.clear && p <= th.flag;

  for (const id of m.ids) {
    const q = baseId(id);
    if (QUESTION_TYPES[q] !== 'noul' || !NOUL_FINDINGS[q]) continue;
    const p = (ans[id] as NoulA).noul;
    if (mid(p)) { r.judge.push({ question: id, value: f2(p), why: `in the mid band (${th.clear}–${th.flag}): read the dossier and decide yourself` }); continue; }
    const f = NOUL_FINDINGS[q];
    if ((p > th.flag) !== f.when) continue;
    const action = typeof f.action === 'function' ? f.action(m.status) : f.action;
    const why = typeof f.why === 'function' ? f.why(m.status) : f.why;
    r.add(action, `${id} ${f2(p)}: ${why}`, id, Math.abs(p - 0.5) * 2);
  }

  for (const { slot, written } of m.holds) {
    const k = ans[`${slot}.blocker_kind`] as ChoiceA | undefined;
    const v = ans[`${slot}.blocker_validity`] as ScoreA | undefined;
    let kindSure = false, mismatch = false;
    if (k) {
      if (k.confidence >= th.accept) {
        kindSure = true;
        if (!READS_AS[written].includes(k.choice)) {
          mismatch = true;
          r.add('reclassify-blocker', `${slot}.blocker_kind: written as ${written}, reads ${k.choice} (${f2(k.confidence)}) — ${SHOULD_BE[k.choice]}`, `${slot}.blocker_kind`, k.confidence);
        }
      } else r.judge.push({ question: `${slot}.blocker_kind`, value: `${k.choice} at ${f2(k.confidence)}`, why: `below ${th.accept}: re-read the hold and decide what it waits on` });
    }
    if (v) {
      const lvl = scoreLevel(v);
      const name = LEVEL_NAMES.blocker_validity[lvl] ?? String(lvl);
      if (v.confidence < th.confidence) r.judge.push({ question: `${slot}.blocker_validity`, value: `${name} at ${f2(v.confidence)}`, why: `below ${th.confidence}: re-read the hold and decide whether it is real and specified` });
      else if (lvl === 0) r.add('reclassify-blocker', `${slot}.blocker_validity ${name} (${f2(v.confidence)}): the hold no longer stands — remove it, and make the step it held the ticket's next`, `${slot}.blocker_validity`, v.confidence);
      else if (lvl === 1 && kindSure && !mismatch) r.judge.push({ question: `${slot}.blocker_validity`, value: `${name} at ${f2(v.confidence)}`, why: `but ${slot}.blocker_kind confirms the written kind — decide yourself` });
      else if (lvl === 1) r.add('reclassify-blocker', `${slot}.blocker_validity ${name} (${f2(v.confidence)}): real, but written as the wrong kind — rewrite it as what it waits on`, `${slot}.blocker_validity`, v.confidence);
      else if (lvl === 2) r.add('gather-evidence', `${slot}.blocker_validity ${name} (${f2(v.confidence)}): give it a recheck day, the source of the date or time it relies on, or who must do what`, `${slot}.blocker_validity`, v.confidence);
    }
  }

  const rel = ans.resource_reliability as ScoreA | undefined;
  if (rel && m.ids.includes('resource_reliability')) {
    const lvl = scoreLevel(rel);
    const name = LEVEL_NAMES.resource_reliability[lvl] ?? String(lvl);
    if (rel.confidence < th.confidence) r.judge.push({ question: 'resource_reliability', value: `${name} at ${f2(rel.confidence)}`, why: `below ${th.confidence}: read the probe history and decide` });
    else if (lvl <= 1) r.add('bring-up-resource', `resource_reliability ${name} (${f2(rel.confidence)}): re-probe it (next), then bring it up per its bringUp — or move the work to a box that has it`, 'resource_reliability', rel.confidence);
  }
  for (const p of m.facts.resources) {
    if (p.latest === 'down') r.add('bring-up-resource', `probe log: ${p.resource} is hosted here but was down at the latest probe — bring it up per its bringUp (an agent step)`, 'probes.jsonl', 1);
    else if (p.latest === 'ok' && p.down >= 2 && p.down * 2 >= p.of) r.add('bring-up-resource', `probe log: ${p.resource} was down in ${p.down} of its last ${p.of} probes — re-probe it before leaning on it`, 'probes.jsonl', 1);
  }

  const dep = ans.dependency_risk as ScoreA | undefined;
  if (dep && m.ids.includes('dependency_risk')) {
    const lvl = scoreLevel(dep);
    const name = LEVEL_NAMES.dependency_risk[lvl] ?? String(lvl);
    if (dep.confidence < th.confidence) r.judge.push({ question: 'dependency_risk', value: `${name} at ${f2(dep.confidence)}`, why: `below ${th.confidence}: read its after and dependents and decide` });
    else if (lvl >= 3) r.add('unblock-chain', `dependency_risk ${name} (${f2(dep.confidence)}): dependents are stalled behind an owner or third-party gate — bring the chain to the owner (priority is theirs)`, 'dependency_risk', dep.confidence);
  }

  const ds = ans.done_supported as ChoiceA | undefined;
  if (ds && m.ids.includes('done_supported')) {
    if (ds.confidence < th.accept) r.judge.push({ question: 'done_supported', value: `${ds.choice} at ${f2(ds.confidence)}`, why: `below ${th.accept}: read the done commit and decide` });
    else if (ds.choice === 'contradicts') r.add('gather-evidence', `done_supported contradicts (${f2(ds.confidence)}): the done commit says the condition is not met — re-check it; reopen the ticket if it is not`, 'done_supported', ds.confidence);
    else if (ds.choice === 'says_nothing') r.add('gather-evidence', `done_supported says_nothing (${f2(ds.confidence)}): the done commit does not show the condition met — name the commit that does, or re-check it`, 'done_supported', ds.confidence);
  }

  if (m.status === 'paused' && m.facts.done_met === true) r.add('close-paused', 'check: its done condition is met — close it (status done + the commit)', 'check', 1);

  const parts = MATURITY_PARTS.filter((k) => m.ids.includes(k));
  const components = Object.fromEntries(parts.map((k) => [k, (ans[k] as NoulA).noul])) as Partial<Record<MaturityPart, number>>;
  const wsum = parts.reduce((s, k) => s + th.weights[k], 0);
  const maturity = parts.length && wsum > 0 ? Math.round((parts.reduce((s, k) => s + th.weights[k] * components[k]!, 0) / wsum) * 100) / 100 : null;
  return { kind: 'ticket', ticket: m.ticket, status: m.status, priority: m.priority, maturity, components, recommendations: r.list(), judge: r.judge };
}

/** A candidate pair's answers → merge (the owner's: one ticket is dropped), the agent's to judge, or nothing. */
export function routePair(a: ReviewAnswers, th: ResolvedReview): PairRoute {
  const m = a.meta as PairMeta;
  const s = a.answers.duplicate as ScoreA;
  const lvl = scoreLevel(s);
  const reads = LEVEL_NAMES.duplicate[lvl] ?? String(lvl);
  const n = (id: string) => (a.answers[id] as NoulA | undefined)?.noul;
  const same = { goal: n('same_goal'), refs: n('same_refs'), done: n('same_done') };
  const r = new Recs();
  const label = `${m.pair[0]} + ${m.pair[1]}`;
  if (s.confidence < th.confidence) r.judge.push({ question: 'duplicate', value: `${reads} at ${f2(s.confidence)}`, why: `below ${th.confidence}: read both tickets and decide` });
  else if (lvl >= 2 && same.done !== undefined && same.done < th.clear) r.judge.push({ question: 'duplicate', value: `${reads} at ${f2(s.confidence)}`, why: `but same_done is ${f2(same.done)}: their done conditions can be met separately — read both and decide` });
  else if (lvl >= 2) r.add('merge-duplicate', `${label}: duplicate ${reads} (${f2(s.confidence)}; same_goal ${same.goal === undefined ? '?' : f2(same.goal)}, same_done ${same.done === undefined ? '?' : f2(same.done)}) — keep one, drop the other with "duplicate of …"`, 'duplicate', s.confidence);
  else if (lvl === 1) r.judge.push({ question: 'duplicate', value: `${reads} at ${f2(s.confidence)}`, why: 'they overlap in part: read both; link them with after, or split the shared step into its own ticket' });
  return { kind: 'pair', pair: m.pair, level: lvl, reads, confidence: s.confidence, same, recommendations: r.list(), judge: r.judge };
}

export type Review = { tickets: TicketRoute[]; pairs: PairRoute[] };

/** Route every answer; tickets with something to do first (most severe, then least mature, then board
 *  order), then those with only a mid band, then the clean ones. */
export function routeReview(list: ReviewAnswers[], th: ResolvedReview): Review {
  const tickets = list.filter((a) => a.meta.kind === 'ticket').map((a) => routeTicket(a, th));
  const pairs = list.filter((a) => a.meta.kind === 'pair').map((a) => routePair(a, th));
  const sev = (t: TicketRoute) => Math.max(0, ...t.recommendations.map((x) => ACTIONS[x.action].severity));
  const tier = (t: TicketRoute) => (t.recommendations.length ? 0 : t.judge.length ? 1 : 2);
  tickets.sort((x, y) => tier(x) - tier(y) || sev(y) - sev(x) || (x.maturity ?? 2) - (y.maturity ?? 2) || x.priority - y.priority);
  pairs.sort((x, y) => (y.recommendations.length - x.recommendations.length) || y.level - x.level || y.confidence - x.confidence);
  return { tickets, pairs };
}

export function reviewText(rv: Review, th: ResolvedReview): string[] {
  const all = [...rv.tickets, ...rv.pairs];
  const recs = all.flatMap((x) => x.recommendations);
  const owner = recs.filter((x) => x.decides === 'owner').length;
  const judges = all.reduce((s, x) => s + x.judge.length, 0);
  const L = [
    `review: ${rv.tickets.length} ticket(s)${rv.pairs.length ? `, ${rv.pairs.length} candidate pair(s)` : ''} — ${recs.length} recommendation(s) (${recs.length - owner} agent, ${owner} owner decides), ${judges} for the agent to judge`,
    `thresholds (config.jev.review): choice ≥ ${th.accept} · noul mid band ${th.clear}–${th.flag} · score confidence ≥ ${th.confidence}`,
  ];
  const tag = (x: Recommendation) => (x.decides === 'owner' ? 'owner decides' : 'agent');
  for (const t of rv.tickets) {
    if (!t.recommendations.length && !t.judge.length) continue;
    L.push('', `${t.ticket} [${t.status}]${t.maturity === null ? '' : ` maturity ${f2(t.maturity)}`}`);
    t.recommendations.forEach((x, i) => {
      L.push(`  ${i + 1}. ${x.action} (${tag(x)}) — ${x.what}`);
      for (const why of x.reasons) L.push(`       · ${why}`);
    });
    for (const j of t.judge) L.push(`  agent judges: ${j.question} ${j.value} — ${j.why}`);
  }
  const clean = rv.tickets.filter((t) => !t.recommendations.length && !t.judge.length);
  if (clean.length) L.push('', `nothing to do: ${clean.map((t) => t.ticket).join(', ')}`);
  for (const p of rv.pairs) {
    if (!p.recommendations.length && !p.judge.length) continue;
    L.push('', `${p.pair[0]} + ${p.pair[1]}: duplicate reads ${p.reads} (${f2(p.confidence)})`);
    p.recommendations.forEach((x, i) => { L.push(`  ${i + 1}. ${x.action} (${tag(x)}) — ${x.what}`); for (const why of x.reasons) L.push(`       · ${why}`); });
    for (const j of p.judge) L.push(`  agent judges: ${j.question} ${j.value} — ${j.why}`);
  }
  return L;
}

/** What `review route --save` keeps in tickets/review/<date>.json: the answers (legends stripped),
 *  the routed scores and recommendations, the thresholds and what the calls cost. */
export function reviewRecord(list: ReviewAnswers[], rv: Review, th: ResolvedReview, date: string, engine: string | undefined) {
  const strip = (ans: Record<string, Answer>) => Object.fromEntries(Object.entries(ans).map(([k, v]) => { const { legend: _l, ...rest } = v as ScoreA; return [k, rest]; }));
  const key = (a: ReviewAnswers) => (a.meta.kind === 'ticket' ? a.meta.ticket : a.meta.pair.join('+'));
  const answersOf = new Map(list.map((a) => [key(a), { model: a.model ?? null, answers: strip(a.answers) }]));
  const input = list.reduce((s, a) => s + (a.usage?.input_tokens ?? 0), 0);
  return {
    date, engine: engine ?? null, thresholds: th,
    usage: { requests: list.length, input_tokens: input, usd: Math.round((input / 1e6) * USD_PER_MTOK * 1e6) / 1e6 },
    tickets: rv.tickets.map((t) => ({ ...t, ...answersOf.get(t.ticket) })),
    pairs: rv.pairs.map((p) => ({ ...p, ...answersOf.get(p.pair.join('+')) })),
  };
}

/** Where `review route --save` writes, and `review` writes its requests by default. */
export const reviewPath = (date: string) => `tickets/review/${date}.json`;
export const REVIEW_CACHE = 'tickets/.cache/review';
