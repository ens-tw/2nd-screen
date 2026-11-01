// `migrate --from-markdown <doc>`: draft a board from a hand-written ticket list, plus a report of
// everything the draft could not decide. The draft is a starting point for an agent, never the board:
// it maps what the markdown states mechanically and lists the rest.
//
//   - [ ] **B-2 · Title.** body …            → open   (next = title until refined)
//   - [x] **B-1 · Title** — 2026-08-28; …    → done   (the closing note → report; commit candidates from git log)
//   - ~~**C-4 · Title.**~~ Dropped: why      → dropped
//   ## / ### headings                        → group candidates
//   Smoke: … (a sub-bullet or inline)        → doneWhen judgment
//   Status: … / Blocked on: …                → report (Blocked on: ids → candidate `after`, the rest → candidate blockers)
//   a dated sub-bullet or sentence           → report: move it into the referenced doc first
//   "Needs X" / "gated on Y" / "after X", ranges "M0–M2" → candidate `after`
//   ⚠ … (to the sentence end)                → hazard; "⚠ Gated on M0." is a dependency, not a hazard
//   [links](./x.md), `repo/paths`            → refs (missing ones listed, not added)
import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import type { Board, Ctx, Problem } from './types.mts';
import { capProblems } from './checks.mts';
import { boardProblems } from './validate.mts';

export const DRAFT_MARK = '// ticket-board migrate draft';
export const DEFAULT_ID_SRC = '[A-Z][A-Z0-9]*-\\d+';

type Raw = {
  id: string; title: string; mark: 'open' | 'done' | 'dropped'; rest: string; body: string[];
  subs: string[]; heading?: string; line: number;
};

export type DraftTicket = {
  id: string; title: string; why: string; refs: string[]; group?: string;
  status: 'open' | 'done' | 'dropped';
  next?: string; when?: string; hazard?: string; after?: string[]; commit?: string; reason?: string;
  notes: Record<string, string>;
};

export type CommitCandidate = { hash: string; subject: string; why: string };

type Note = { id: string; text: string };
export type Parsed = {
  tickets: DraftTicket[];
  groups: [string, string][];
  report: {
    dated: Note[];
    closing: Note[];
    status: Note[];
    blockers: Note[];
    other: Note[];
    after: { id: string; targets: string[]; from: string }[];
    unresolved: { id: string; token: string; from: string }[];
    hazards: { id: string; text: string; kept: boolean }[];
    missing: { id: string; ref: string }[];
    commits: { id: string; candidates: CommitCandidate[] }[];
    placeholders: { id: string; field: string }[];
    outside: string[];
  };
};

export type MigrateEnv = {
  /** Repo-relative path of the markdown source (links resolve against its folder). */
  doc: string;
  /** Does a repo-relative path exist? */
  exists(path: string): boolean;
  /** `git log --all --oneline` lines (newest first) whose message names the id. */
  gitLog(id: string): string[];
  /** The id pattern (no anchors). */
  idSrc?: string;
};

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripMd = (s: string) => s.replace(/\*\*|__/g, '').trim();
/** Prose for a board field: a link keeps its text (the path went to refs). */
const plain = (s: string) => s.replace(/\[([^\]]*)\]\([^)\s]+\)/g, '$1').trim();
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const DATE_EARLY = /^[^:]{0,48}?\b\d{4}-\d{2}-\d{2}\b/;
const TODO = (what: string) => `TODO — ${what}`;
/** A closed row's lead-in: `— 2026-08-28;`, `Done 2026-09-06/07:`, `Dropped 2026-08-17 —`. */
const LEAD = /^\s*[—–-]*\s*(?:(?:Done|Dropped|Closed)\b\s*)?(?:\d{4}-\d{2}-\d{2}(?:(?:\/|\.\.|–)\d{2}(?:-\d{2})?)*)?\s*[;:,.—–-]?\s*/i;

/** Labelled clauses a hand-written ticket carries, inline or as sub-bullets. */
const LABEL = /(?:^|(?<=[.;!?)]\s))\**(Smoke|Status|Blocked on|Blocked by|Risk|Open sub-item|Open)\**(?:\s*\(([^)]{0,40})\))?\s*\**:\**\s*/g;
type Clause = { label?: string; qual?: string; text: string };
function clauses(text: string): Clause[] {
  const out: Clause[] = [];
  let cur: Clause = { text: '' };
  let last = 0;
  for (const m of text.matchAll(LABEL)) {
    cur.text = text.slice(last, m.index).trim();
    out.push(cur);
    cur = { label: m[1].toLowerCase(), qual: m[2], text: '' };
    last = (m.index ?? 0) + m[0].length;
  }
  cur.text = text.slice(last).trim();
  out.push(cur);
  return out.filter((c) => c.label || c.text);
}

/** ⚠ marks run to the end of their sentence. One that only states a dependency is not a hazard. */
const HAZARD = /⚠️?\s*([^]*?(?:[.!?](?=\s|$)|$))/gu;
const DEPENDENCY = /^(?:gated on|needs|after|blocked on|blocked by|requires|waits on)\b/i;
function takeHazards(text: string): { rest: string; hazards: string[]; deps: string[] } {
  const hazards: string[] = [], deps: string[] = [];
  const rest = text.replace(HAZARD, (_m, h: string) => {
    const t = h.trim();
    if (t) (DEPENDENCY.test(t) ? deps : hazards).push(t);
    return ' ';
  });
  return { rest: collapse(rest), hazards, deps };
}

/** Strip ^/$ anchors (and surrounding slashes) from an id regex source, for matching inside prose. */
export const inlineIdSrc = (src: string): string => src.replace(/^\/|\/[a-z]*$/g, '').replace(/^\^/, '').replace(/\$$/, '');

function slug(s: string): string {
  return stripMd(s).toLowerCase().replace(/[`'"]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'group';
}

/** `M0`…`M2`, `B-2`…`B-4`: the ids or keys a range spans (as written when it is not a range). */
function expand(a: string, b: string): string[] {
  const ma = /^(.*?)(\d+)$/.exec(a), mb = /^(.*?)(\d+)$/.exec(b);
  if (!ma || !mb || ma[1] !== mb[1] || +mb[2] <= +ma[2] || +mb[2] - +ma[2] > 50) return [a, b];
  return Array.from({ length: +mb[2] - +ma[2] + 1 }, (_, i) => `${ma[1]}${+ma[2] + i}`);
}

/** Commit candidates for a done ticket, best first: the work commit a closing commit names
 *  (`<id> done in <hash>`), then subjects that close it (`<id> done`, `<id>: … done`, 完成,
 *  `closes <id>`), then every other commit naming it, newest first. */
export function rankCommits(id: string, log: string[]): CommitCandidate[] {
  const idRe = `(?<![A-Za-z0-9-])${reEsc(id)}(?![0-9A-Za-z])`;
  const entries = log.map((l) => { const i = l.indexOf(' '); return i < 0 ? { hash: l, subject: '' } : { hash: l.slice(0, i), subject: l.slice(i + 1) }; });
  const same = (x: string, y: string) => x.startsWith(y) || y.startsWith(x);
  const out: CommitCandidate[] = [];
  const add = (c: CommitCandidate) => { if (!out.some((o) => same(o.hash, c.hash))) out.push(c); };
  const named = new RegExp(`${idRe}.*?\\bdone in ([0-9a-f]{7,40})\\b`, 'i');
  const closes = new RegExp([
    `${idRe}(?:\\s*(?:,|and|&|/)\\s*[A-Za-z][\\w.-]*)*\\s*[:—–-]?\\s*(?:is\\s+)?(?:done|closed)\\b`,
    `\\bclos(?:e|es|ed)\\s+${idRe}`,
    `${idRe}\\s*:.*\\bdone\\b`,
    `${idRe}.*完成`,
  ].join('|'), 'i');
  for (const e of entries) {
    const m = named.exec(e.subject);
    if (m) add({ hash: m[1], subject: entries.find((x) => same(x.hash, m[1]))?.subject ?? '', why: `the work commit named by ${e.hash}` });
  }
  for (const e of entries) if (closes.test(e.subject)) add({ ...e, why: 'its subject closes the ticket' });
  for (const e of entries) add({ ...e, why: 'names the ticket' });
  return out;
}

/** Parse the hand-written list. */
export function parseMarkdown(md: string, env: MigrateEnv): Parsed {
  const idSrc = env.idSrc ?? DEFAULT_ID_SRC;
  // named groups: a user's id pattern may carry its own capture groups
  const head = new RegExp(`^\\*\\*\\s*(?<id>${idSrc})\\s*[·:—–-]\\s*(?<title>.+?)\\*\\*\\s*(?<rest>.*)$`);
  const raws: Raw[] = [];
  const outside: string[] = [];
  const idAnywhere = new RegExp(`\\b(${idSrc})\\b`, 'g');
  let heading: string | undefined;
  let cur: Raw | undefined;
  let inSub = false;
  md.split(/\r?\n/).forEach((line, n) => {
    const h = /^#{2,3}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { heading = stripMd(h[1]); cur = undefined; return; }
    const top = /^ {0,1}[-*]\s+(.*)$/.exec(line);
    if (top) {
      let rest = top[1];
      let mark: Raw['mark'] | undefined;
      const box = /^\[( |x|X)\]\s+(.*)$/.exec(rest);
      if (box) { mark = box[1] === ' ' ? 'open' : 'done'; rest = box[2]; }
      const strike = /^~~(.*?)~~\s*(.*)$/.exec(rest);
      if (strike) { mark = 'dropped'; rest = `${strike[1]} ${strike[2] ? `\u0000${strike[2]}` : ''}`.trim(); }
      const m = head.exec(rest.split('\u0000')[0].trim())?.groups;
      if (mark && m) {
        const after = rest.includes('\u0000') ? rest.split('\u0000')[1] : m.rest;
        cur = { id: m.id, title: m.title.trim().replace(/[.。]\s*$/, ''), mark, rest: mark === 'dropped' ? after : '', body: mark === 'dropped' ? [] : [m.rest], subs: [], heading, line: n + 1 };
        raws.push(cur);
        inSub = false;
        return;
      }
      cur = undefined;
      if ((line.match(idAnywhere) ?? []).length) outside.push(collapse(line));
      return;
    }
    if (cur) {
      const sub = /^\s{2,}[-*]\s+(.*)$/.exec(line);
      if (sub) { cur.subs.push(sub[1]); inSub = true; return; }
      if (/^\s+\S/.test(line)) {
        if (inSub) cur.subs[cur.subs.length - 1] += ` ${line.trim()}`;
        else if (cur.mark === 'dropped') cur.rest += ` ${line.trim()}`;
        else cur.body.push(line.trim());
        return;
      }
      if (line.trim() === '') return;
      cur = undefined;
    }
    if ((line.match(idAnywhere) ?? []).length) outside.push(collapse(line));
  });

  // Groups: one per heading that holds tickets; key = the shared id prefix, else a slug.
  const groups: [string, string][] = [];
  const keyOf = new Map<string, string>();
  const ids = new Set(raws.map((r) => r.id));
  for (const hd of [...new Set(raws.map((r) => r.heading).filter((x): x is string => !!x))]) {
    const prefixes = new Set(raws.filter((r) => r.heading === hd).map((r) => r.id.replace(/[-_.]?\d+[a-z]?$/i, '')));
    const taken = (k: string) => ids.has(k) || groups.some(([g]) => g === k);
    const prefix = prefixes.size === 1 ? [...prefixes][0] : '';
    const base = prefix && !taken(prefix) ? prefix : slug(hd);
    let k = base, i = 2;
    while (taken(k)) k = `${base}-g${i++}`;
    groups.push([k, hd]);
    keyOf.set(hd, k);
  }
  const groupKeys = groups.map(([k]) => k);
  const known = (x: string) => ids.has(x) || groupKeys.includes(x);

  const report: Parsed['report'] = {
    dated: [], closing: [], status: [], blockers: [], other: [], after: [], unresolved: [], hazards: [], missing: [],
    commits: [], placeholders: [], outside,
  };
  const token = `(?:${idSrc}|${[...groupKeys].sort((a, b) => b.length - a.length).map(reEsc).join('|') || '(?!)'})`;
  const SEP = '(?:,|and|&|/|or|–|—|\\.\\.|-)';
  const listSrc = `${token}\\b(?:\\s*${SEP}\\s*${token}\\b)*`;
  const needRe = new RegExp(`\\b(?:[Nn]eeds|[Gg]ated on|[Aa]fter|[Bb]locked on|[Bb]locked by)\\s+(?<list>${listSrc})`, 'g');
  const tokRe = new RegExp(`(?<a>${token})\\s*(?:–|—|\\.\\.|-)\\s*(?<b>${token})\\b|(?<t>${token})\\b`, 'g');
  const tokensOf = (s: string) => [...s.matchAll(tokRe)].flatMap((m) => (m.groups?.t ? [m.groups.t] : expand(m.groups!.a, m.groups!.b)));

  const docDir = posix.dirname(env.doc);
  const refsIn = (text: string, id: string, refs: string[]) => {
    const add = (r: string) => { if (!refs.includes(r)) refs.push(r); };
    const miss = (r: string) => { if (!report.missing.some((x) => x.id === id && x.ref === r)) report.missing.push({ id, ref: r }); };
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const href = m[1];
      if (/^[a-z]+:/i.test(href) || href.startsWith('#')) continue;
      const [p, anchor] = href.split('#');
      const rel = posix.normalize(posix.join(docDir, p)).replace(/^\.\//, '');
      if (rel.startsWith('../')) continue;
      if (env.exists(rel)) add(anchor ? `${rel}#${anchor}` : rel); else miss(rel);
    }
    for (const m of text.matchAll(/`([^`\s]+)`/g)) {
      const tok = m[1];
      if (tok.startsWith('/') || tok.startsWith('-') || tok.startsWith('~') || tok.includes('://') || !/^[\w.\-/]+$/.test(tok)) continue;
      if (!tok.includes('/') && !/\.[A-Za-z][A-Za-z0-9]{0,5}$/.test(tok)) continue;
      const clean = tok.replace(/^\.\//, '');
      const viaDoc = posix.normalize(posix.join(docDir, clean));
      if (env.exists(clean)) add(clean);
      else if (!viaDoc.startsWith('../') && env.exists(viaDoc)) add(viaDoc);
      else miss(clean);
    }
  };

  const tickets = raws.map((r): DraftTicket => {
    const t: DraftTicket = { id: r.id, title: r.title, why: '', refs: [], status: r.mark, notes: {} };
    if (r.heading) t.group = keyOf.get(r.heading);
    const closed = r.mark !== 'open';
    // The body (inline clauses included) and every sub-bullet, split into labelled clauses.
    const body = collapse(r.body.join(' ')).replace(closed ? LEAD : /^\s*[—–-]+\s*/, '');
    const parts = clauses(body);
    const smokes: Clause[] = [];
    const hazards: string[] = [], deps: string[] = [];
    let desc = '';
    const closingBits: string[] = [];
    const take = (c: Clause, fromSub: boolean) => {
      const hz = takeHazards(c.text);
      hazards.push(...hz.hazards);
      deps.push(...hz.deps);
      const text = hz.rest;
      switch (c.label) {
        case 'smoke': smokes.push({ ...c, text }); return;
        case 'status': if (text) report.status.push({ id: r.id, text }); return;
        case 'blocked on': case 'blocked by': {
          const toks = tokensOf(text);
          const restText = collapse(text.replace(tokRe, ' ').replace(/\b(?:and|or)\b/g, ' ').replace(/[;,.&/–—-]+/g, ' '));
          if (toks.length) deps.push(`blocked on ${toks.join(', ')}`);
          if (/[A-Za-z㐀-鿿]{2}/.test(restText)) report.blockers.push({ id: r.id, text });
          return;
        }
        case undefined:
          if (!text) return;
          if (closed) closingBits.push(text);
          else if (fromSub) {
            if (DATE_EARLY.test(stripMd(text))) report.dated.push({ id: r.id, text });
            else report.other.push({ id: r.id, text });
          } else {
            // a dated sentence in the description is narrative: it goes to the docs, not into why
            for (const s of text.split(/(?<=[.!?])\s+(?=\S)/)) (DATE.test(s) ? report.dated.push({ id: r.id, text: s }) : (desc = `${desc} ${s}`.trim()));
          }
          return;
        default: report.other.push({ id: r.id, text: `${c.label[0].toUpperCase()}${c.label.slice(1)}${c.qual ? ` (${c.qual})` : ''}: ${text}` });
      }
    };
    for (const c of parts) take(c, false);
    for (const s of r.subs) {
      const sc = clauses(collapse(s));
      if (sc.length === 1 && !sc[0].label && DATE_EARLY.test(stripMd(sc[0].text))) { report.dated.push({ id: r.id, text: sc[0].text }); continue; }
      for (const c of sc) take(c, true);
    }
    const smoke = smokes.map((c) => (smokes.length > 1 && c.qual ? `(${c.qual}) ${c.text}` : c.text)).join(' ').trim();
    const prose = [r.title, body, ...r.subs.filter((s) => !DATE_EARLY.test(stripMd(collapse(s))))].join(' ');
    refsIn(prose, r.id, t.refs);

    if (r.mark === 'dropped') {
      t.reason = plain(collapse(r.rest).replace(LEAD, '')) || TODO('why it was dropped');
      if (t.reason.startsWith('TODO')) report.placeholders.push({ id: r.id, field: 'reason' });
      t.why = plain(closingBits.join(' ')) || t.reason;
      for (const h of hazards) report.hazards.push({ id: r.id, text: h, kept: false });
      return t;
    }
    if (r.mark === 'done') {
      // a closed row rarely keeps its smoke; a done judgment is never checked, so its title (the finished state) serves
      t.when = smoke ? plain(smoke) : r.title;
      if (!smoke) t.notes.when = 'migrate: no Smoke line — the title';
      // a done row's note is closing narrative: its evidence belongs in the docs it names
      if (closingBits.length) report.closing.push({ id: r.id, text: closingBits.join(' ') });
      t.why = TODO('why it existed (its closing note is in the migration report)');
      report.placeholders.push({ id: r.id, field: 'why' });
      const candidates = rankCommits(r.id, env.gitLog(r.id));
      report.commits.push({ id: r.id, candidates });
      t.commit = candidates[0]?.hash ?? 'TODO';
      if (!candidates.length) report.placeholders.push({ id: r.id, field: 'commit' });
      t.notes.commit = candidates.length ? `migrate: best of ${candidates.length} candidate(s) (${candidates[0].why}) — verify against the report` : 'migrate: no commit names it — set it by hand';
      for (const h of hazards) report.hazards.push({ id: r.id, text: h, kept: false });
      return t;
    }
    t.when = smoke ? plain(smoke) : TODO('state what proves it is done');
    if (!smoke) report.placeholders.push({ id: r.id, field: 'doneWhen.when' });
    t.why = plain(desc) || TODO('say why this ticket exists');
    if (!desc) report.placeholders.push({ id: r.id, field: 'why' });
    t.next = r.title;
    t.notes.next = 'migrate: the title — rewrite as the ONE next action';
    if (hazards.length) { t.hazard = plain(hazards.join(' ')); for (const h of hazards) report.hazards.push({ id: r.id, text: h, kept: true }); }
    const targets: string[] = [];
    for (const m of `${r.title} ${desc} ${deps.join('. ')}`.matchAll(needRe)) {
      const list = tokensOf(m.groups?.list ?? '');
      for (const tok of list) {
        if (tok === r.id) continue;
        if (known(tok)) { if (!targets.includes(tok)) targets.push(tok); }
        else report.unresolved.push({ id: r.id, token: tok, from: collapse(m[0]) });
      }
      if (list.length) report.after.push({ id: r.id, targets: list.filter((x) => x !== r.id && known(x)), from: collapse(m[0]) });
    }
    if (targets.length) { t.after = targets; t.notes.after = 'migrate: from the prose — confirm'; }
    return t;
  });
  return { tickets, groups, report };
}

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
const list = (xs: string[]) => `[${xs.map(q).join(', ')}]`;

/** The draft board as TypeScript source. */
export function draftSource(p: Parsed, from: string, typesImport: string): string {
  const out = [
    `${DRAFT_MARK} — generated from ${from}; NOT the board yet.`,
    '// Refine it (the ticket-board skill, references/migration.md), then move it to tickets/board.mts.',
    `import type { Board } from '${typesImport}';`,
    '',
    'export default [',
  ];
  let lastGroup: string | undefined | null = null;
  const labels = new Map(p.groups);
  for (const t of p.tickets) {
    if (t.group !== lastGroup) { out.push(`  // ── ${t.group ? `${labels.get(t.group)} (group ${t.group})` : 'no group'} ──`); lastGroup = t.group; }
    const f = (k: string, v: string, note?: string) => out.push(`    ${k}: ${v},${note ? ` // ${note}` : ''}`);
    out.push('  {');
    f('id', q(t.id));
    f('title', q(t.title));
    f('why', q(t.why));
    if (t.refs.length) f('refs', list(t.refs));
    if (t.group) f('group', q(t.group));
    f('status', q(t.status));
    if (t.status === 'dropped') f('reason', q(t.reason ?? ''));
    else {
      f('doneWhen', `{ kind: 'judgment', when: ${q(t.when ?? '')} }`, t.notes.when ?? 'migrate: from Smoke — make it a test/answer where a check fits');
      if (t.status === 'done') f('commit', q(t.commit ?? 'TODO'), t.notes.commit);
      else {
        f('next', q(t.next ?? ''), t.notes.next);
        if (t.hazard) f('hazard', q(t.hazard));
        if (t.after) f('after', list(t.after), t.notes.after);
      }
    }
    out.push('  },');
  }
  out.push('] satisfies Board;', '');
  return out.join('\n');
}

const counts = (p: Parsed) => ['open', 'done', 'dropped'].map((s) => `${p.tickets.filter((t) => t.status === s).length} ${s}`).join(' · ');
const short = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);
const notes = (title: string, intro: string, xs: Note[]) => (xs.length ? [`## ${title}`, '', intro, '', ...xs.map((x) => `- ${x.id}: ${short(x.text)}`), ''] : []);

/** The migration report (Markdown). `problems` = the draft's validation errors; `caps` = prose over cap. */
export function reportText(p: Parsed, o: { from: string; out: string; problems: Problem[]; caps: Problem[]; config: string }): string {
  const r = p.report;
  const L: string[] = [`# Migration report: ${o.from} → ${o.out}`, '', `${p.tickets.length} tickets: ${counts(p)}${p.groups.length ? ` · groups ${p.groups.map(([k]) => k).join(', ')}` : ''}.`, ''];
  L.push('## Draft validation', '');
  if (!o.problems.length) L.push(`The draft loads and validates (against ${o.config}).`, '');
  else L.push(`The draft does NOT validate (against ${o.config}) — fix exactly these:`, '', ...o.problems.map((x) => `- ${x.id ? `${x.id}: ` : ''}${x.message}`), '');
  if (p.groups.length) {
    L.push('## Suggested config.groups', '', 'Add to tickets/config.mts (key order = the view\'s order; rename keys freely, then fix each ticket\'s group):', '', '```ts', `groups: { ${p.groups.map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : q(k)}: ${q(v)}`).join(', ')} },`, '```', '');
  }
  L.push('## Refine before it becomes the board', '');
  L.push('- every `next` is the title — rewrite each as the ONE next action;');
  L.push('- every `doneWhen` is a judgment from its Smoke line — use `test` or `answer` wherever a check can decide it;');
  L.push('- read each ticket\'s prose: blockers (owner / go / external) and windows are not inferred — add them by hand (candidates below).');
  for (const c of o.caps) L.push(`- over cap: ${c.id}: ${c.message.replace(/ — put the detail.*$/, '')} — move the detail into the doc it refs`);
  const byField = new Map<string, string[]>();
  for (const x of r.placeholders) byField.set(x.field, [...(byField.get(x.field) ?? []), x.id]);
  for (const [field, ids] of byField) L.push(`- placeholder ${field} (TODO): ${ids.join(', ')}`);
  L.push('');
  L.push(...notes('Closing notes of done tickets — evidence belongs in the docs', 'Not in the draft. Each says where the evidence lives; make sure that doc (or the commit) holds it, and ref it from the ticket:', r.closing));
  L.push(...notes('Dated notes — move into the referenced docs first', 'Not in the draft. Check each fact is already in the doc the ticket refs (or put it there), then delete it from the list:', r.dated));
  L.push(...notes('Status lines — what was true when written', 'Not in the draft. Fold what still holds into `why` / `next` or the ref\'d doc:', r.status));
  L.push(...notes('Blocked on — candidate blockers', 'Decide each: `owner` (a decision, fact or hands-on step only the owner gives), `go` (an explicit go for a hazardous step), `external` (a third party), a `window` (a clock), or `after` (another ticket):', r.blockers));
  L.push(...notes('Other notes — not placed', 'Fold each into `why`, a ref\'d doc, or drop it:', r.other));
  if (r.after.length || r.unresolved.length) {
    L.push('## Candidate `after` (from the prose — confirm each)', '');
    for (const a of r.after) if (a.targets.length) L.push(`- ${a.id}: after ${a.targets.join(', ')} ← "${a.from}"`);
    for (const u of r.unresolved) L.push(`- ${u.id}: "${u.token}" is neither a ticket nor a group ← "${u.from}"`);
    L.push('');
  }
  if (r.outside.length) L.push('## Prose outside the tickets that names ids', '', 'Translate dependency notes into `after`, then drop them from the doc:', '', ...r.outside.map((x) => `- ${short(x, 200)}`), '');
  if (r.hazards.length) L.push('## Hazards (⚠)', '', ...r.hazards.map((h) => `- ${h.id}: ${h.text}${h.kept ? '' : ' — NOT kept (the ticket is closed)'}`), '', 'A hazard that needs the owner\'s explicit go also gets a `go` blocker.', '');
  if (r.missing.length) L.push('## Refs not found (not added)', '', ...r.missing.map((m) => `- ${m.id}: \`${m.ref}\``), '');
  if (r.commits.length) {
    L.push('## Done tickets — commit candidates, best first (the draft takes the first; verify each)', '');
    for (const c of r.commits) {
      L.push(c.candidates.length
        ? `- ${c.id}: ${c.candidates.slice(0, 3).map((x) => `\`${x.hash}\` ${x.subject ? `"${short(x.subject, 80)}"` : '(subject not in the log)'} — ${x.why}`).join(' · ')}${c.candidates.length > 3 ? ` · +${c.candidates.length - 3} more` : ''}`
        : `- ${c.id}: none found — set commit by hand`);
    }
    L.push('');
  }
  L.push('## Next', '');
  L.push(`1. Refine ${o.out} as listed above; move it to tickets/board.mts${p.groups.length ? ' and add the groups to tickets/config.mts' : ''}.`);
  L.push(`1. Delete the hand-written list from ${o.from} (keep any lasting intro text, or the whole doc if that is all it held): the board is the record now, read through the CLI — no view is committed.`);
  L.push('1. `node tickets/engine/cli.mjs check --text` must pass; `node tickets/engine/cli.mjs view` renders a page to look it over.');
  return L.join('\n');
}

/** Validate a loaded draft against a context; schema errors and prose over cap. */
export function draftProblems(raw: unknown, cx: Ctx): { problems: Problem[]; caps: Problem[] } {
  const problems = boardProblems(raw, cx);
  return { problems, caps: problems.length ? [] : capProblems(raw as Board, cx) };
}

export const isDraft = (text: string) => text.startsWith(DRAFT_MARK);
export const existsAt = (root: string) => (p: string) => existsSync(posix.join(root, p));
