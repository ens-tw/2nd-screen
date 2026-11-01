// Optional Jev judgments. The engine NEVER calls Jev or the network: `jev blocker` / `jev done` print a
// System One request, the jev-decide skill's runner sends it (`--raw`, and only on the user's ack — a
// call is paid), and `jev route` turns the answers into a verdict with the thresholds in config.jev.
// Routing reads only the answers and the config, so it is deterministic and tested from fixtures.
//
//   blocker — one Choice (what the text waits on) + two Nouls (a time with no source; a step a listed
//             tool can drive, written as a person's), per blocker or per --ask text
//   done    — one Choice (supports / contradicts / says_nothing), docs.typesafe.ai citation_check
//
// The answers carry `meta` (the runner copies it from the request, never sends it): which ticket,
// which texts and how they were written, so a route needs nothing else.
import { createHash } from 'node:crypto';
import type { Blocker, Ctx, DoneWhen, Resolved, Ticket } from './types.mts';
import { describeDone } from './lib.mts';

/** How a text is written on the board: a blocker kind, or `window` for a ticket window. */
export type Written = 'owner' | 'go' | 'external' | 'window';
export const WRITTEN: readonly Written[] = ['owner', 'go', 'external', 'window'];

export type BlockerItem = { slot: string; written: Written | null; fp: string; text: string };
export type BlockerMeta = { tool: 'ticket-board'; check: 'blocker'; ticket: string; items: BlockerItem[] };
export type DoneMeta = { tool: 'ticket-board'; check: 'done'; ticket: string; done: string; evidence: string };
export type JevRequest = { meta: BlockerMeta | DoneMeta; state: unknown; questions: Record<string, unknown> };

type ChoiceAnswer = { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number };
type NoulAnswer = { type: 'noul'; noul: number };
export type Answers<M> = { meta: M; model?: string; answers: Record<string, ChoiceAnswer | NoulAnswer> };

/** What a blocker text can wait on. Every option says what it means; the board's kinds map onto them. */
export const KINDS: Record<string, string> = {
  'owner-decision': 'Only the owner can settle it: a choice between options, a goal or priority, a risk or cost to accept, or a fact only the owner knows.',
  'owner-hands': "Needs the owner's own hands or presence: a physical device to plug in or press, a login or signature only the owner can give — something no entry in `tools` or `resources` can do.",
  go: "A hazardous step — it wipes, burns, spends real money, publishes, or sends a live order beyond what is already authorized — that is otherwise ready and waits only on the owner's explicit yes.",
  external: 'Waits on a third party outside the project — a broker, exchange, vendor, supplier or reviewer — to do something: open an account, ship, reply, approve.',
  'clock-window': 'Waits only for a time to come: trading or market hours, an acceptance window, a scheduled event, a date. Nobody has to act; the work resumes when the clock reaches it.',
  'hosted-resource-bringup': "Needs a machine, VM, device or service listed in `resources` to be started, unlocked or logged into — a bring-up the agent does itself, following that resource's `bringUp`.",
  'agent-can-do': 'Nothing has to be waited for: the agent can do the step now with `tools` — drive a GUI, run a script, read a document, capture traffic.',
  none: 'The text names no obstacle at all: nothing stops the work.',
};

/** The Jev kinds each written form stands for. */
export const READS_AS: Record<Written, string[]> = {
  owner: ['owner-decision', 'owner-hands'],
  go: ['go'],
  external: ['external'],
  window: ['clock-window'],
};

/** What a text Jev reads as `kind` should be on the board. */
export const SHOULD_BE: Record<string, string> = {
  'owner-decision': 'an owner blocker (a decision only the owner can make)',
  'owner-hands': "an owner blocker (the owner's own hands)",
  go: "a go blocker (a hazardous step waiting only on the owner's yes)",
  external: 'an external blocker {who, what, recheck}',
  'clock-window': 'no blocker — a window on the ticket, with its evidenced hours in refs',
  'hosted-resource-bringup': "no blocker — the agent's own bring-up; add the resource's path to refs",
  'agent-can-do': "no blocker — the agent's own step; make it the ticket's next",
  none: 'nothing blocks it — drop the blocker',
};

/** Always available to an agent, whatever config.jev.tools adds. */
export const BASE_TOOLS = ["a shell on this machine: run the repo's scripts and tools, read and edit files, use git"];

/** A blocker as one line of text — what the board says it waits on. */
export const blockerText = (bl: Blocker): string =>
  bl.kind === 'external' ? `${bl.who}: ${bl.what}${bl.recheck ? ` (recheck ${bl.recheck})` : ''}` : bl.ask;

/** A text's fingerprint: answers saved for one text never judge a text edited since. */
export const fingerprint = (text: string): string => createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);

/** Rough input tokens: ~4 ASCII characters per token, ~1 token per other character (CJK). */
export function tokens(s: string): number {
  let ascii = 0, other = 0;
  for (const ch of s) (ch.charCodeAt(0) < 128 ? ascii++ : other++);
  return Math.ceil(ascii / 4) + other;
}

const ticketState = (t: Ticket) => ({
  id: t.id, title: t.title, why: t.why, status: t.status,
  ...(t.status === 'open' || t.status === 'blocked' ? { next: t.next } : {}),
  refs: t.refs ?? [],
});

/** The blocker check: per text, one Choice over KINDS and two Nouls, over one shared state. */
export function blockerRequest(t: Ticket, cx: Ctx, texts: { slot: string; written: Written | null; text: string }[]): JevRequest {
  const items: BlockerItem[] = texts.map((x) => ({ ...x, fp: fingerprint(x.text) }));
  const questions: Record<string, unknown> = {};
  for (const { slot } of items) {
    const ask = `\`asks.${slot}\``;
    questions[`${slot}.kind`] = {
      type: 'choice',
      instructions: `${ask} says what stops work on \`ticket\`. What does it actually wait on?`,
      criteria: KINDS,
    };
    questions[`${slot}.time_unsourced`] = {
      type: 'noul',
      instructions: `Does ${ask} rely on a specific time, date or window — a clock time, trading hours, an opening date — without a source for that time, either in the text or in \`ticket.refs\` (a published calendar, an exchange or broker notice, a document, an opening someone observed)?`,
      criteria: { true: 'It relies on a time and no source for it is given.', false: 'Every time it relies on has a source, or it relies on no time at all.' },
    };
    questions[`${slot}.tool_step_as_human`] = {
      type: 'noul',
      instructions: `Does ${ask} give a person — the owner, an operator, a human, someone — a step that an entry in \`tools\`, or a resource's \`bringUp\` in \`resources\`, could carry out?`,
      criteria: { true: 'A listed tool or bring-up could do the step it gives to a person.', false: 'The step it gives to a person really needs one, or it gives no step to a person.' },
    };
  }
  return {
    meta: { tool: 'ticket-board', check: 'blocker', ticket: t.id, items },
    state: {
      ticket: ticketState(t),
      asks: Object.fromEntries(items.map((i) => [i.slot, i.text])),
      resources: Object.entries(cx.config.resources).map(([name, r]) => ({
        name, paths: r.paths, ...(r.on ? { on: r.on } : {}), ...(r.policy ? { policy: r.policy } : {}), ...(r.bringUp ? { bringUp: r.bringUp } : {}),
      })),
      tools: [...BASE_TOOLS, ...cx.config.jev.tools],
    },
    questions,
  };
}

/** The done check (citation_check): does the evidence support the ticket's done condition? */
export function doneRequest(t: Ticket, cx: Ctx, evidence: { source: string; text: string }): JevRequest {
  const done = describeDone((t as { doneWhen: DoneWhen }).doneWhen, cx);
  return {
    meta: { tool: 'ticket-board', check: 'done', ticket: t.id, done, evidence: evidence.source },
    state: { ticket: { id: t.id, title: t.title, why: t.why }, done_when: done, evidence },
    questions: {
      relation: {
        type: 'choice',
        instructions: 'How does `evidence.text` relate to the claim that `done_when` is now met for `ticket`?',
        criteria: {
          supports: 'The evidence states that the condition is met, or directly implies it.',
          contradicts: 'The evidence states that the condition is not met, or implies it is false.',
          says_nothing: 'The evidence does not address whether the condition is met, either way.',
        },
      },
    },
  };
}

// ── answers ──────────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isChoice = (a: unknown): a is ChoiceAnswer => isObj(a) && typeof a.choice === 'string' && typeof a.confidence === 'number' && isObj(a.probabilities);
const isNoul = (a: unknown): a is NoulAnswer => isObj(a) && typeof a.noul === 'number';

/** Check an answers file (the runner's --raw output) for `check`. A string = what is wrong. */
export function parseAnswers(raw: unknown, check: 'blocker' | 'done'): Answers<any> | string {
  if (!isObj(raw) || !isObj(raw.meta) || !isObj(raw.answers)) return 'not a jev answers file — expected {meta, answers} as jev_decide.mts --raw prints it';
  const m = raw.meta;
  if (m.tool !== 'ticket-board' || m.check !== check) return `answers for ${m.tool ?? '?'} ${m.check ?? '?'}, not ticket-board ${check}`;
  if (typeof m.ticket !== 'string') return 'meta.ticket is missing';
  const a = raw.answers;
  if (check === 'done') {
    if (!isChoice(a.relation)) return 'answers.relation is not a choice answer';
    return raw as Answers<DoneMeta>;
  }
  if (!Array.isArray(m.items) || !m.items.length) return 'meta.items is missing';
  for (const it of m.items) {
    if (!isObj(it) || typeof it.slot !== 'string' || typeof it.fp !== 'string' || typeof it.text !== 'string') return 'meta.items: each needs slot, fp and text';
    if (it.written !== null && !WRITTEN.includes(it.written)) return `meta.items: written "${it.written}" is not ${WRITTEN.join(', ')} or null`;
    if (!isChoice(a[`${it.slot}.kind`]) || !(a[`${it.slot}.kind`].choice in KINDS)) return `answers["${it.slot}.kind"] is not a choice over the blocker kinds`;
    for (const q of ['time_unsourced', 'tool_step_as_human']) if (!isNoul(a[`${it.slot}.${q}`])) return `answers["${it.slot}.${q}"] is not a noul answer`;
  }
  return raw as Answers<BlockerMeta>;
}

// ── routing ──────────────────────────────────────────────────────────────────────────────────────

export type Thresholds = Pick<Resolved['jev'], 'accept' | 'flag' | 'clear'>;
const f2 = (n: number) => n.toFixed(2);

export type BlockerVerdict = {
  slot: string; written: Written | null; text: string; fp: string;
  /** ok = Jev reads it as written (or, unwritten, reads it clearly); rewrite = a confident finding
   *  says the text is wrong; unsure = the mid band — the agent re-reads it and decides. */
  verdict: 'ok' | 'rewrite' | 'unsure';
  reads: string; confidence: number; timeUnsourced: number; toolStepAsHuman: number;
  reasons: string[];
};

/** One text's verdict, in a fixed order: confident findings first (a Noul flag, a kind other than the
 *  one written), then the mid band (a low-confidence kind, a Noul between clear and flag), else ok.
 *  `written` overrides the item's own — `check` judges a saved text as the board now writes it. */
export function routeBlockerItem(it: BlockerItem, answers: Answers<BlockerMeta>['answers'], th: Thresholds, written: Written | null = it.written): BlockerVerdict {
  const kind = answers[`${it.slot}.kind`] as ChoiceAnswer;
  const time = (answers[`${it.slot}.time_unsourced`] as NoulAnswer).noul;
  const tool = (answers[`${it.slot}.tool_step_as_human`] as NoulAnswer).noul;
  const base = { slot: it.slot, written, text: it.text, fp: it.fp, reads: kind.choice, confidence: kind.confidence, timeUnsourced: time, toolStepAsHuman: tool };
  const found: string[] = [];
  if (time > th.flag) found.push(`a time with no source (${f2(time)}): cite where it comes from in refs, or make finding it the ticket's next — a guessed time is not a window`);
  if (tool > th.flag) found.push(`a step a listed tool can drive is written as a person's (${f2(tool)}): it is the agent's step`);
  if (written && kind.confidence >= th.accept && !READS_AS[written].includes(kind.choice)) {
    found.push(`written as ${written}, Jev reads ${kind.choice} (${f2(kind.confidence)}): ${SHOULD_BE[kind.choice]}`);
  }
  if (found.length) return { ...base, verdict: 'rewrite', reasons: found };
  const unsure: string[] = [];
  if (kind.confidence < th.accept) unsure.push(`kind ${kind.choice} at confidence ${f2(kind.confidence)}, below ${th.accept}`);
  const mid = (p: number) => p >= th.clear && p <= th.flag;
  if (mid(time)) unsure.push(`time without a source at ${f2(time)}, between ${th.clear} and ${th.flag}`);
  if (mid(tool)) unsure.push(`tool step written as a person's at ${f2(tool)}, between ${th.clear} and ${th.flag}`);
  if (unsure.length) return { ...base, verdict: 'unsure', reasons: [...unsure, 'the mid band is yours: re-read the text and decide'] };
  return { ...base, verdict: 'ok', reasons: written ? [] : [`reads as ${kind.choice}: write it as ${SHOULD_BE[kind.choice]}`] };
}

export const routeBlocker = (a: Answers<BlockerMeta>, th: Thresholds): BlockerVerdict[] =>
  a.meta.items.map((it) => routeBlockerItem(it, a.answers, th));

export type DoneVerdict = {
  verdict: 'close' | 'not-met' | 'no-evidence' | 'unsure';
  relation: string; confidence: number; reason: string;
};

/** citation_check: at or above `accept` the verdict stands; below it, the agent reads the evidence. */
export function routeDone(a: Answers<DoneMeta>, th: Thresholds): DoneVerdict {
  const r = a.answers.relation as ChoiceAnswer;
  const base = { relation: r.choice, confidence: r.confidence };
  if (r.confidence < th.accept) return { ...base, verdict: 'unsure', reason: `${r.choice} at confidence ${f2(r.confidence)}, below ${th.accept} — the mid band is yours: read the evidence and decide` };
  if (r.choice === 'supports') return { ...base, verdict: 'close', reason: "the evidence supports it — close it: status 'done' with the commit" };
  if (r.choice === 'contradicts') return { ...base, verdict: 'not-met', reason: 'the evidence says it is not met — keep it open' };
  return { ...base, verdict: 'no-evidence', reason: 'the evidence does not address it — find evidence that does, or keep it open' };
}

/** Where `jev route blocker --save` keeps a ticket's answers, and `check` looks for them. */
export const answersPath = (id: string) => `tickets/jev/${id}.blocker.json`;
