// Board writes: `close`, `block` and `update` rewrite one ticket's entry in tickets/board.mts and nothing
// else. The entry is found by scanning the source (strings, template literals and comments skipped). Only the
// properties that change are rewritten, in place, so the rest keeps its text: a constant, a `${…}` template,
// the layout. An entry the scan cannot take apart is replaced whole with a one-line literal. The board is then
// imported again: unless every other ticket reads exactly as before and the edited one exactly as intended,
// the original text is put back.

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Ctx, Ticket } from './types.mts';
import { boardProblems } from './validate.mts';
import { capProblems } from './checks.mts';
import { claimsDir } from './claims.mts';

type Tok = { t: 'str' | 'tpl' | 'id' | 'p'; v: string; s: number; e: number };

/** The end of the string or template literal that opens at src[i], past any `${…}` in it (strings, templates
 *  and braces nested in the expression included); -1 when it never closes. */
function skipQuoted(src: string, i: number): number {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === q) return j + 1;
    if (q === '`' && c === '$' && src[j + 1] === '{') {
      j += 2;
      let depth = 1;
      while (j < src.length && depth) {
        const d = src[j];
        if (d === "'" || d === '"' || d === '`') { const e = skipQuoted(src, j); if (e < 0) return -1; j = e; continue; }
        if (d === '{') depth++;
        else if (d === '}') depth--;
        j++;
      }
      if (depth) return -1;
      continue;
    }
    j++;
  }
  return -1;
}

function tokens(src: string): Tok[] | string {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); i = n < 0 ? src.length : n; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); if (n < 0) return 'an unclosed /* comment'; i = n + 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1, v = '';
      for (; j < src.length && src[j] !== c; j++) {
        if (c === '`' && src[j] === '$' && src[j + 1] === '{') break;
        if (src[j] === '\\') { v += src[j + 1]; j++; } else v += src[j];
      }
      if (j < src.length && src[j] !== c) {
        const e = skipQuoted(src, i);
        if (e < 0) return 'an unclosed template literal';
        out.push({ t: 'tpl', v: '', s: i, e });
        i = e;
        continue;
      }
      if (j >= src.length) return 'an unclosed string';
      out.push({ t: 'str', v, s: i, e: j + 1 });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) { let j = i; while (j < src.length && /[\w$]/.test(src[j])) j++; out.push({ t: 'id', v: src.slice(i, j), s: i, e: j }); i = j; continue; }
    if (/\s/.test(c)) { i++; continue; }
    out.push({ t: 'p', v: c, s: i, e: i + 1 });
    i++;
  }
  return out;
}

/** Where ticket `id`'s object literal sits in the board source: [start, end) — or why it cannot be found. */
export function locateEntry(src: string, id: string): { start: number; end: number } | string {
  const ts = tokens(src);
  if (typeof ts === 'string') return `cannot read tickets/board.mts: ${ts}`;
  const ex = ts.findIndex((x, k) => x.t === 'id' && x.v === 'export' && ts[k + 1]?.t === 'id' && ts[k + 1].v === 'default');
  if (ex < 0) return 'tickets/board.mts has no export default';
  const open = ts.findIndex((x, k) => k > ex && x.t === 'p' && x.v === '[');
  if (open < 0) return 'tickets/board.mts: export default is not an array literal';
  const found: { start: number; end: number }[] = [];
  let depth = 0, objStart = -1, objTok = -1;
  for (let k = open; k < ts.length; k++) {
    const x = ts[k];
    if (x.t !== 'p') continue;
    if (x.v === '[' || x.v === '{' || x.v === '(') {
      depth++;
      if (x.v === '{' && depth === 2) { objStart = x.s; objTok = k; }
    } else if (x.v === ']' || x.v === '}' || x.v === ')') {
      if (x.v === '}' && depth === 2 && objStart >= 0) {
        let d = 0;
        for (let q = objTok + 1; q < k; q++) {
          const y = ts[q];
          if (y.t === 'p' && '[{('.includes(y.v)) d++;
          else if (y.t === 'p' && ']})'.includes(y.v)) d--;
          else if (d === 0 && (y.t === 'id' || y.t === 'str') && y.v === 'id' && ts[q + 1]?.v === ':' && ts[q + 2]?.t === 'str') {
            if (ts[q + 2].v === id) found.push({ start: objStart, end: x.e });
            break;
          }
        }
        objStart = -1;
      }
      depth--;
      if (depth === 0) break;
    }
  }
  if (!found.length) return `no entry with id '${id}' written as an object literal in tickets/board.mts`;
  if (found.length > 1) return `id '${id}' appears in ${found.length} entries of tickets/board.mts`;
  return found[0];
}

const ORDER = ['id', 'title', 'why', 'status', 'commit', 'reason', 'until', 'refs', 'group', 'authorizations', 'touches', 'after', 'next', 'wip', 'hazard', 'window', 'blockers', 'doneWhen'];
const rank = (k: string) => (ORDER.indexOf(k) < 0 ? 99 : ORDER.indexOf(k));

const str = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : str(k));

/** A TypeScript literal for a board value, on one line. */
export function literal(v: unknown, top = false): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return str(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map((x) => literal(x)).join(', ')}]`;
  if (typeof v === 'object') {
    const ks = Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined);
    if (top) ks.sort((a, b) => rank(a) - rank(b));
    return ks.length ? `{ ${ks.map((k) => `${key(k)}: ${literal((v as Record<string, unknown>)[k])}`).join(', ')} }` : '{}';
  }
  throw new Error(`cannot write a ${typeof v} into the board`);
}

const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

type Prop = { key: string; ks: number; vs: number; ve: number; comma: number };

/** The entry's top-level properties: the key, where it starts, its value's span and the comma after it (-1 for
 *  none) — or null when the entry holds something only a whole rewrite can replace (a spread, a shorthand or
 *  computed key, a key twice). */
function properties(src: string, at: { start: number; end: number }): Prop[] | null {
  const ts = tokens(src.slice(at.start, at.end));
  if (typeof ts === 'string' || ts[0]?.v !== '{' || ts[ts.length - 1]?.v !== '}') return null;
  const off = at.start, props: Prop[] = [];
  let k = 1;
  while (k < ts.length - 1) {
    const kt = ts[k];
    if (!(kt.t === 'id' || kt.t === 'str') || ts[k + 1]?.v !== ':' || ts[k + 1].t !== 'p') return null;
    let q = k + 2, depth = 0;
    for (; q < ts.length - 1; q++) {
      const y = ts[q];
      if (y.t !== 'p') continue;
      if ('[{('.includes(y.v)) depth++;
      else if (']})'.includes(y.v)) depth--;
      else if (y.v === ',' && depth === 0) break;
    }
    if (q === k + 2) return null;
    props.push({ key: kt.v, ks: kt.s + off, vs: ts[k + 2].s + off, ve: ts[q - 1].e + off, comma: q < ts.length - 1 ? ts[q].s + off : -1 });
    k = q + 1;
  }
  return new Set(props.map((x) => x.key)).size === props.length ? props : null;
}

/** The entry with only the properties that differ from `old` rewritten, in place; null when it cannot be done. */
function editEntry(src: string, at: { start: number; end: number }, old: Record<string, unknown>, next: Record<string, unknown>): string | null {
  const props = properties(src, at);
  if (!props || !props.length) return null;
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lineStart = (i: number) => src.lastIndexOf('\n', i - 1) + 1;
  const lineEnd = (nl: number) => (src[nl - 1] === '\r' ? nl - 1 : nl);
  const ownLine = (p: Prop) => src.slice(lineStart(p.ks), p.ks).trim() === '';
  const multi = ownLine(props[0]);
  const indent = multi ? src.slice(lineStart(props[0].ks), props[0].ks) : '';
  const edits: { s: number; e: number; text: string; insert?: number }[] = [];
  const kept: Prop[] = [];
  props.forEach((p, n) => {
    const v = next[p.key];
    if (v === undefined) {
      if (p.comma >= 0) {
        const nl = src.indexOf('\n', p.comma);
        if (ownLine(p) && nl >= 0 && src.slice(p.comma + 1, nl).trim() === '') edits.push({ s: lineStart(p.ks), e: nl + 1, text: '' });
        else edits.push({ s: p.ks, e: p.comma + 1 + (src.slice(p.comma + 1).match(/^[ \t]*/)?.[0].length ?? 0), text: '' });
      } else if (ownLine(p)) edits.push({ s: lineEnd(lineStart(p.ks) - 1), e: p.ve, text: '' });
      else edits.push({ s: n ? props[n - 1].comma : p.ks, e: p.ve, text: '' });
      return;
    }
    kept.push(p);
    if (canon(v) !== canon(old[p.key])) edits.push({ s: p.vs, e: p.ve, text: literal(v) });
  });
  if (!kept.length) return null;
  const added = Object.keys(next).filter((k) => next[k] !== undefined && !props.some((p) => p.key === k)).sort((a, b) => rank(a) - rank(b));
  for (const k of added) {
    const before = kept.filter((p) => rank(p.key) <= rank(k));
    const a = before.length ? before[before.length - 1] : kept[kept.length - 1];
    const item = `${key(k)}: ${literal(next[k])}`;
    if (a.comma >= 0) {
      const nl = src.indexOf('\n', a.comma);
      const rest = nl >= 0 ? src.slice(a.comma + 1, lineEnd(nl)).trim() : null;
      if (multi && rest !== null && (rest === '' || rest.startsWith('//'))) edits.push({ s: lineEnd(nl), e: lineEnd(nl), text: `${eol}${indent}${item},`, insert: rank(k) });
      else edits.push({ s: a.comma + 1, e: a.comma + 1, text: ` ${item},`, insert: rank(k) });
    } else edits.push({ s: a.ve, e: a.ve, text: multi ? `,${eol}${indent}${item}` : `, ${item}`, insert: rank(k) });
  }
  // From the end back, so each edit's offsets still hold; at one offset a deletion goes first, then the
  // insertions in ORDER (applied in reverse, so they read in order).
  edits.sort((x, y) => y.s - x.s || (x.insert === undefined ? -1 : y.insert === undefined ? 1 : y.insert - x.insert));
  const cuts = edits.filter((x) => x.insert === undefined).sort((x, y) => x.s - y.s);
  for (let n = 1; n < cuts.length; n++) if (cuts[n].s < cuts[n - 1].e) return null;
  let out = src;
  for (const x of edits) out = out.slice(0, x.s) + x.text + out.slice(x.e);
  return out;
}

/** Whether the entry holds something a one-line literal would freeze into its value: a template, or a name
 *  (a constant, a spread, a shorthand or computed key). */
function freezes(src: string, at: { start: number; end: number }): boolean {
  const ts = tokens(src.slice(at.start, at.end));
  if (typeof ts === 'string') return true;
  return ts.some((x, k) => x.t === 'tpl' || (x.t === 'id' && ts[k + 1]?.v !== ':' && !['true', 'false', 'null', 'undefined'].includes(x.v)));
}

const replace = (path: string, text: string) => { writeFileSync(`${path}.tmp`, text); renameSync(`${path}.tmp`, path); };
let loads = 0;

/** One writer at a time across every worktree of the checkout: an exclusive create beside the claims. A
 *  lock older than a minute is a crashed writer's and is taken over. */
function lock(root: string): (() => void) | string {
  const dir = dirname(claimsDir(root));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'board.lock');
  for (let tries = 0; tries < 100; tries++) {
    try { closeSync(openSync(path, 'wx')); return () => rmSync(path, { force: true }); } catch {
      try { if (Date.now() - statSync(path).mtimeMs > 60_000) { rmSync(path, { force: true }); continue; } } catch { continue; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  return `another write to tickets/board.mts holds ${path}: try again`;
}

/** Replace ticket `id` in tickets/board.mts with `next`: validated first, read back after, reverted on any
 *  difference. Returns an error message, or null when written. */
export async function writeTicket(root: string, id: string, next: Ticket, cx: Ctx): Promise<string | null> {
  const unlock = lock(root);
  if (typeof unlock === 'string') return unlock;
  try { return await writeLocked(root, id, next, cx); } finally { unlock(); }
}

async function writeLocked(root: string, id: string, next: Ticket, cx: Ctx): Promise<string | null> {
  const path = join(root, 'tickets', 'board.mts');
  const before = readFileSync(path, 'utf8');
  let raw: unknown;
  try { raw = (await import(`${pathToFileURL(path).href}?read=${Date.now()}`)).default; } catch (e) { return `tickets/board.mts does not load: ${(e as Error).message}`; }
  if (!Array.isArray(raw)) return 'tickets/board.mts: export default is not an array';
  const at = locateEntry(before, id);
  if (typeof at === 'string') return at;
  const intended = raw.map((t) => ((t as { id?: string }).id === id ? next : t));
  const problems = [...boardProblems(intended, cx), ...capProblems([next], cx)];
  if (problems.length) return `the edit would not validate: ${problems.map((p) => `${p.id ? `${p.id}: ` : ''}${p.message}`).join('; ')}`;
  if (readFileSync(path, 'utf8') !== before) return 'tickets/board.mts changed while it was being edited (by hand?): left unchanged — run the command again';
  const old = raw.find((t) => (t as { id?: string }).id === id) as Record<string, unknown>;
  const edited = editEntry(before, at, old, next as unknown as Record<string, unknown>);
  const whole = freezes(before, at) ? null : before.slice(0, at.start) + literal(next, true) + before.slice(at.end);
  if (edited === null && whole === null) return `${id}'s entry cannot be rewritten in place, and a one-line rewrite would freeze its constants, templates or spreads: left unchanged — edit it by hand`;
  let back: unknown;
  for (const text of [edited, whole]) {
    if (text === null) continue;
    replace(path, text);
    try { back = (await import(`${pathToFileURL(path).href}?write=${Date.now()}-${++loads}`)).default; } catch (e) { back = e; }
    if (Array.isArray(back) && back.length === intended.length && back.every((t, k) => canon(t) === canon(intended[k]))) return null;
  }
  replace(path, before);
  return `tickets/board.mts did not read back as intended${back instanceof Error ? ` (${back.message})` : ''}: left unchanged — edit it by hand`;
}
