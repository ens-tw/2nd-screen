// Claims: who is working a ticket (or one member of it) right now. Machine-local state, never on the
// board: a claim is one file per ticket under the checkout's git common dir, so every worktree of the
// checkout sees the same claims, and it is created with an exclusive open, so two claims can never take
// the same ticket. A claimed ticket is a derived hold (`claim`): `next` and `claim --next` skip it, and
// the stop code leaves it out — the claims are what to wait for. Closing the ticket makes its claim a
// leftover that `check` warns about; `release` (or `claim --next`) removes it.
//
// A claim names three things, each for its own job: `to`, the label of whoever works it (a name the
// session hands out, e.g. worker-3 — self-reported, never verified); `by`, the session that took it
// (where the runner has a session id); and `branch`, where the work lands — the part git can check,
// so a claim with no recent commit there reads as stale.
import { hostname } from 'node:os';
import { mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { Board, Claim, Ctx, Problem } from './types.mts';
import { byId, cacheDir, claimKey, isLive, membersOf } from './lib.mts';

export { claimKey } from './lib.mts';

/** Where the claims live: TICKET_BOARD_CLAIMS_DIR, else `<git common dir>/ticket-board/claims` (shared by
 *  every worktree of the checkout, never tracked), else — no git — `claims/` in the engine's cache. */
export function claimsDir(root: string): string {
  const env = process.env.TICKET_BOARD_CLAIMS_DIR;
  if (env) return resolve(root, env);
  const r = spawnSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return join(resolve(root, r.stdout.trim()), 'ticket-board', 'claims');
  return join(cacheDir(root), 'claims');
}

/** One file per claim. `@` is never left bare by encodeURIComponent, so it separates ticket and member. */
const fileOf = (dir: string, ticket: string, member?: string): string =>
  join(dir, `${encodeURIComponent(ticket)}${member === undefined ? '' : `@${encodeURIComponent(member)}`}.json`);

const CLAIM_KEYS = ['ticket', 'member', 'to', 'by', 'branch', 'host', 'at'];
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

function parseClaim(text: string): Claim | undefined {
  let o: unknown;
  try { o = JSON.parse(text); } catch { return undefined; }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return undefined;
  const c = o as Record<string, unknown>;
  if (Object.keys(c).some((k) => !CLAIM_KEYS.includes(k))) return undefined;
  if (!nonEmpty(c.ticket) || !nonEmpty(c.to) || !nonEmpty(c.host) || !nonEmpty(c.at) || Number.isNaN(Date.parse(c.at))) return undefined;
  for (const k of ['member', 'by', 'branch']) if (c[k] !== undefined && !nonEmpty(c[k])) return undefined;
  return c as Claim;
}

/** Every claim on this machine, keyed by `claimKey`; `bad` = files that do not read as a claim. Reads
 *  only — never writes. */
export function readClaims(root: string): { claims: Map<string, Claim>; bad: string[] } {
  const dir = claimsDir(root);
  const claims = new Map<string, Claim>();
  const bad: string[] = [];
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return { claims, bad }; }
  for (const n of names) {
    let text = '';
    try { text = readFileSync(join(dir, n), 'utf8'); } catch { /* vanished: released meanwhile */ continue; }
    const c = parseClaim(text);
    if (!c || fileOf(dir, c.ticket, c.member) !== join(dir, n)) { bad.push(join(dir, n)); continue; }
    claims.set(claimKey(c.ticket, c.member), c);
  }
  return { claims, bad };
}

/** A new claim, stamped with this machine and the time. */
export const newClaim = (o: { ticket: string; member?: string; to: string; by?: string; branch?: string }, now: number): Claim => ({
  ticket: o.ticket, ...(o.member !== undefined ? { member: o.member } : {}), to: o.to,
  ...(o.by ? { by: o.by } : {}), ...(o.branch ? { branch: o.branch } : {}), host: hostname(), at: new Date(now).toISOString(),
});

/** Take a claim: an exclusive create, so of two sessions taking the same ticket at once exactly one wins.
 *  Returns null when taken, else the claim that already holds it (unreadable = a stub naming no one). */
export function takeClaim(root: string, c: Claim): Claim | null {
  const dir = claimsDir(root);
  mkdirSync(dir, { recursive: true });
  const path = fileOf(dir, c.ticket, c.member);
  let fd: number;
  try { fd = openSync(path, 'wx'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    let held: Claim | undefined;
    try { held = parseClaim(readFileSync(path, 'utf8')); } catch { /* released meanwhile */ }
    return held ?? { ticket: c.ticket, ...(c.member !== undefined ? { member: c.member } : {}), to: '(unreadable claim file)', host: '?', at: new Date(0).toISOString() };
  }
  try { writeSync(fd, `${JSON.stringify(c, null, 2)}\n`); } finally { closeSync(fd); }
  return null;
}

/** Remove a claim's file; false when there was none. */
export function dropClaim(root: string, ticket: string, member?: string): boolean {
  try { unlinkSync(fileOf(claimsDir(root), ticket, member)); return true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

/** The claims whose work is over — the ticket is closed, paused or gone, or the member is met or no longer
 *  reported. `claim --next` clears these; `check` warns about them. */
export function leftoverClaims(b: Board, cx: Ctx, claims: ReadonlyMap<string, Claim>): { claim: Claim; why: string }[] {
  const ids = byId(b);
  return [...claims.values()].flatMap((c) => {
    const t = ids.get(c.ticket);
    if (!t) return [{ claim: c, why: `${c.ticket} is not on the board` }];
    if (!isLive(t)) return [{ claim: c, why: `${c.ticket} is ${t.status}` }];
    if (c.member === undefined) return [];
    const ms = membersOf(t.id, b, cx);
    if (!ms) return [{ claim: c, why: `${c.ticket} reports no members` }];
    return ms.unmet.some((m) => m.id === c.member) ? [] : [{ claim: c, why: `member ${c.member} is met or no longer reported` }];
  });
}

/** When a claim last showed life: the later of when it was taken and its branch's last commit. */
export function lastActive(c: Claim, cx: Ctx): { ms: number; branch: 'none' | 'missing' | 'found' } {
  const taken = Date.parse(c.at);
  if (!c.branch) return { ms: taken, branch: 'none' };
  if (!cx.io.hasGit) return { ms: taken, branch: 'missing' };
  const r = cx.io.git('log', '-1', '--format=%ct', `refs/heads/${c.branch}`, '--');
  if (!r.ok || !r.out) return { ms: taken, branch: 'missing' };
  return { ms: Math.max(taken, Number(r.out) * 1000), branch: 'found' };
}

const releaseCmd = (c: Claim) => `node tickets/engine/cli.mjs release ${c.ticket}${c.member !== undefined ? ` --member ${JSON.stringify(c.member)}` : ''} --to ${JSON.stringify(c.to)}`;

/** `check`'s claim warnings — machine-local state, so never an error (the exit code stays a function of
 *  the commit):
 *    claim-leftover    — a claim whose work is over (the ticket closed, paused or gone; the member met)
 *    claim-stale       — no sign of life for config.claimStaleHours: no commit on its branch since then
 *    claim-branch      — its branch does not exist here
 *    claim-unreadable  — a file in the claims folder that does not read as a claim */
export function claimProblems(b: Board, cx: Ctx, read: { claims: ReadonlyMap<string, Claim>; bad: string[] }, now: number): Problem[] {
  const out: Problem[] = [];
  const leftover = new Set<Claim>();
  for (const { claim: c, why } of leftoverClaims(b, cx, read.claims)) {
    leftover.add(c);
    out.push({ level: 'warning', id: c.ticket, message: `claim-leftover: ${claimKey(c.ticket, c.member)} is still claimed by ${c.to} but ${why} — ${releaseCmd(c)}` });
  }
  const limit = cx.config.claimStaleHours * 3_600_000;
  for (const c of read.claims.values()) {
    if (leftover.has(c)) continue;
    const a = lastActive(c, cx);
    if (a.branch === 'missing') out.push({ level: 'warning', id: c.ticket, message: `claim-branch: ${claimKey(c.ticket, c.member)} is claimed by ${c.to} on branch ${c.branch}, which does not exist here — create it, or ${releaseCmd(c)}` });
    if (now - a.ms > limit) {
      const hours = Math.floor((now - a.ms) / 3_600_000);
      out.push({ level: 'warning', id: c.ticket, message: `claim-stale: ${claimKey(c.ticket, c.member)} is claimed by ${c.to}${c.by ? ` (session ${c.by})` : ''} with no sign of life for ${hours} h (${a.branch === 'found' ? `no commit on ${c.branch}` : 'claimed'} since ${new Date(a.ms).toISOString()}) — find out whether its worker is still alive, else ${releaseCmd(c)}` });
    }
  }
  for (const f of read.bad) out.push({ level: 'warning', message: `claim-unreadable: ${f} does not read as a claim — remove it` });
  return out;
}
