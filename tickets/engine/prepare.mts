// prepare — make as many tickets actionable as possible before a long run.
//
// A run finishes every ticket it can reach: workable now, or waiting only on tickets it will finish
// itself (an umbrella only once every unmet member is reachable). The rest wait on gates: an owner's
// decision or step, a go, an authorization not granted, a third party, another machine, a pause — or the
// clock, which nobody is asked for. For each gate, `blocks` is exact necessity: the tickets reachable
// with every gate settled but not with every gate except this one. The plan is a suggested order of asks,
// greedy by tickets gained per ask; a pause comes after every real blocker, since it was decided on.
// Equal gains go to the cheaper asks (a hands-on step before a decision), then to the tickets highest on
// the board. An ask that takes days (an owner errand, a third party) is listed apart to be asked first:
// its wait starts only when it is asked, whatever it frees.
import type { Board, Ctx, Hold, OwnerAs, Probe, Ticket } from './types.mts';
import { clearsAt, daysSince, holdsOf, isClock, isLive, membersOf, resourceBringUps, scopeOf, stands, stopOf, workable } from './lib.mts';

export type GateKind = 'authorization' | 'owner' | 'go' | 'external' | 'resource' | 'paused' | 'clock';

export type Gate = {
  key: string;
  kind: GateKind;
  /** How it reads to the owner. */
  label: string;
  /** What clearing it takes, in the board's words. */
  ask: string;
  since: string | null;
  days: number | null;
  /** A clock: when it clears by itself. */
  opens?: string | null;
  /** An owner ask's `as`: what settling it takes. */
  as?: OwnerAs;
  /** It takes days to come back (an owner errand, a third party): ask it before anything else. */
  lead: boolean;
  /** The tickets it holds directly (a member's gate counts for its ticket). */
  tickets: string[];
  /** The tickets that cannot become actionable while it stands. */
  blocks: string[];
  /** The tickets it alone makes actionable. */
  frees: string[];
};

/** One step of the suggested order: asks settled together, and what they bring within reach. */
export type Step = {
  asks: Gate[];
  brings: string[];
  /** Of `brings`, those that also wait for a clock to open. */
  afterClock: string[];
  /** Within reach once this step and every earlier one are settled, clocks opened included. */
  actionableAfter: number;
};

export type PrepareJson = {
  /** Tickets a run starting now can finish: workable, or waiting only on tickets it finishes itself. */
  actionable: { count: number; ids: string[] };
  /** Live and paused tickets in scope: the most `actionable` can reach. */
  of: number;
  workable: string[];
  /** Claimed by another worker: in progress, counted as actionable, never offered here. */
  claimed: string[];
  /** Resources this machine hosts but that are down: agent steps, already counted as actionable. */
  bringUp: { resource: string; waiting: string[]; note?: string; bringUp?: string }[];
  /** Every askable gate, the one keeping the most tickets out of reach first. */
  blockers: Gate[];
  /** The blockers that take days to come back (`lead`): ask them first, whatever they free. */
  startFirst: Gate[];
  /** Gates only the clock clears, with when. */
  clock: Gate[];
  plan: Step[];
  /** Tickets no ask and no clock brings within reach (a cycle, a ticket out of scope). */
  unreachable: string[];
  /** Open tickets in scope with no `touches` field: nobody has assessed what they change, so a fan-out
   *  schedules them freely and checks nothing at merge. Assess them before fanning out (0.15.1). */
  touchesUnassessed: string[];
  stop: null | { code: string; until?: string };
};

export const LABEL: Record<GateKind, string> = {
  authorization: 'authorization', owner: 'owner decision or step', go: 'go', external: 'third party',
  resource: 'resource', paused: 'paused (resume?)', clock: 'clock',
};

const OWNER_LABEL: Record<OwnerAs, string> = { hands: 'owner hands-on step', decision: 'owner decision', errand: 'owner errand (takes days)' };

/** What settling a gate costs the owner, in rank only: it breaks ties between equal gains, never more. */
const COST: Record<string, number> = { hands: 1, go: 1, authorization: 1, resource: 1, decision: 2, owner: 2, paused: 2, errand: 3, external: 3 };

type G = Omit<Gate, 'tickets' | 'blocks' | 'frees'>;
const g = (key: string, kind: GateKind, ask: string, since: string | null, now: number, opens?: string | null, as?: OwnerAs): G =>
  ({ key, kind, label: as ? OWNER_LABEL[as] : LABEL[kind], ask, since, days: since ? daysSince(since, now) : null, ...(opens !== undefined ? { opens } : {}), ...(as ? { as } : {}), lead: as === 'errand' || (kind === 'external') });

function gateOf(h: Hold, cx: Ctx, now: number): G | null {
  if (isClock(h, now)) return g(`clock:${JSON.stringify(h)}`, 'clock', h.kind === 'external' ? `${h.who}: ${h.what} (recheck ${h.recheck})` : (h as { what: string }).what, null, now, clearsAt(h, now)?.iso ?? null);
  switch (h.kind) {
    case 'authorization': return g(`authorization:${h.needs}`, 'authorization', `${h.ask} (authorization ${h.needs})`, h.since, now);
    case 'owner': return g(`owner:${h.ask}`, 'owner', h.ask, h.since, now, undefined, h.as);
    case 'go': return g(`go:${h.ask}`, 'go', h.ask, h.since, now);
    case 'external': return g(`external:${h.who}:${h.what}`, 'external', `${h.who}: ${h.what}`, null, now);
    case 'resource': {
      const on = cx.config.resources[h.needs]?.on;
      const boxes = on === undefined ? [] : Array.isArray(on) ? on : [on];
      return g(`resource:${h.needs}`, 'resource', `needs ${h.needs}${boxes.length ? ` (run on ${boxes.join(' or ')})` : ''}`, null, now);
    }
    default: return null;   // ticket holds are the dependencies; a claim is someone's work in progress
  }
}

/** A ticket as the run sees it: its gates and the tickets it waits on, every unmet member's merged in. */
type Node = { gates: Set<string>; deps: Set<string> };

export function prepareReport(board: Board, cx: Ctx, reachable: ReadonlySet<string>, probes: Map<string, Probe> | undefined, now: number, group?: string): PrepareJson {
  const ids = board.map((t) => t.id);
  const order = (s: Iterable<string>) => { const set = new Set(s); return ids.filter((id) => set.has(id)); };
  // A paused ticket is weighed as if resumed: the holds it derives (authorizations, resources) plus the
  // pause. Its after, window and blockers are set when it is resumed, so they cannot count here.
  const asOpen = board.map((t) => (t.status === 'paused' ? ({ ...t, status: 'open', next: '' } as unknown as Ticket) : t));
  const scope = group !== undefined ? scopeOf(group, asOpen, cx) : undefined;
  const mine = (id: string) => !scope || scope.has(id);
  const status = new Map(board.map((t) => [t.id, t.status]));
  const gates = new Map<string, G & { holds: Set<string> }>();
  const nodes = new Map<string, Node>();
  const claimed = new Set<string>();

  for (const t of board) {
    if (!((isLive(t) || t.status === 'paused') && mine(t.id))) continue;
    const n: Node = { gates: new Set(), deps: new Set() };
    const add = (hs: Hold[]) => {
      for (const h of hs) {
        if (h.kind === 'claim') { claimed.add(t.id); continue; }
        if (!stands(h, asOpen, reachable, now)) continue;
        if (h.kind === 'ticket') { n.deps.add(h.id); continue; }
        const gate = gateOf(h, cx, now);
        if (!gate) continue;
        n.gates.add(gate.key);
        if (!gates.has(gate.key)) gates.set(gate.key, { ...gate, holds: new Set() });
        gates.get(gate.key)!.holds.add(t.id);
      }
    };
    add(holdsOf(t.id, asOpen, cx));
    for (const m of membersOf(t.id, asOpen, cx)?.unmet ?? []) add(m.holds);   // finished only with every member
    if (t.status === 'paused') {
      const key = `paused:${t.id}`;
      n.gates.add(key);
      gates.set(key, { ...g(key, 'paused', `resume ${t.id} (${t.title}); paused until: ${t.until}`, null, now), holds: new Set([t.id]) });
    }
    nodes.set(t.id, n);
  }

  // Within reach once `cleared` are settled: a fixed point — every gate cleared and every ticket waited on
  // within reach or done.
  const reach = (cleared: ReadonlySet<string>): Set<string> => {
    const ok = new Set<string>();
    for (let grew = true; grew;) {
      grew = false;
      for (const [id, n] of nodes) {
        if (ok.has(id)) continue;
        if ([...n.gates].every((k) => cleared.has(k)) && [...n.deps].every((d) => ok.has(d) || status.get(d) === 'done')) { ok.add(id); grew = true; }
      }
    }
    return ok;
  };

  const all = new Set(gates.keys());
  const clocks = new Set([...all].filter((k) => gates.get(k)!.kind === 'clock'));
  const base = reach(new Set());
  const ever = reach(all);
  const full = new Map<string, Gate>([...gates].map(([k, { holds, ...rest }]) => {
    const without = reach(new Set([...all].filter((x) => x !== k)));
    return [k, { ...rest, tickets: order(holds), blocks: order([...ever].filter((id) => !without.has(id))), frees: order([...reach(new Set([k]))].filter((id) => !base.has(id))) }];
  }));
  const rank = (a: Gate, b: Gate) => b.blocks.length - a.blocks.length || b.frees.length - a.frees.length || (b.days ?? -1) - (a.days ?? -1);

  // The asks still missing for each out-of-reach ticket, its prerequisites' included.
  const memo = new Map<string, Set<string> | null>();
  const need = (id: string, path: ReadonlySet<string> = new Set()): Set<string> | null => {
    if (status.get(id) === 'done') return new Set();
    if (memo.has(id)) return memo.get(id)!;
    const n = nodes.get(id);
    if (!n || path.has(id)) return null;   // out of scope, or an AND cycle: never within reach
    const out = new Set(n.gates);
    const p = new Set([...path, id]);
    for (const d of n.deps) { const dn = need(d, p); if (!dn) { memo.set(id, null); return null; } dn.forEach((x) => out.add(x)); }
    memo.set(id, out);
    return out;
  };

  // Suggested order, clocks taken as opened: real blockers first, then pauses. Candidates: each
  // out-of-reach ticket's missing asks, each single ask, and each ask with every missing set containing it.
  // Highest tickets per ask wins, then the larger gain, then the cheaper asks (COST), then the step
  // bringing the ticket highest on the board, then the gate blocking the most.
  const pos = new Map(ids.map((id, i) => [id, i]));
  const costOf = (s: string[]) => s.reduce((n, k) => { const x = full.get(k)!; return n + (COST[x.as ?? x.kind] ?? 2); }, 0);
  const plan: Step[] = [];
  const cleared = new Set<string>(clocks);
  let within = reach(cleared);
  for (const phase of [(k: string) => full.get(k)!.kind !== 'paused', () => true]) {
    for (;;) {
      const missingOf: string[][] = [];
      for (const id of nodes.keys()) {
        if (within.has(id)) continue;
        const m = [...(need(id) ?? [])].filter((k) => !cleared.has(k));
        if (m.length && m.every(phase)) missingOf.push(m);
      }
      const sets = [...missingOf];
      for (const k of new Set(missingOf.flat())) {
        sets.push([k]);
        sets.push([...new Set(missingOf.filter((m) => m.includes(k)).flat())]);
      }
      type Cand = { asks: string[]; after: Set<string>; gain: number; score: number; cost: number; first: number; top: number };
      const better = (a: Cand, b: Cand | null) => !b || a.score > b.score || (a.score === b.score && (a.gain > b.gain || (a.gain === b.gain
        && (a.cost < b.cost || (a.cost === b.cost && (a.first < b.first || (a.first === b.first && a.top > b.top)))))));
      let best: Cand | null = null;
      const seen = new Set<string>();
      for (const s of sets) {
        const sig = [...s].sort().join('|');
        if (seen.has(sig)) continue;
        seen.add(sig);
        const after = reach(new Set([...cleared, ...s]));
        const gain = after.size - within.size;
        if (gain <= 0) continue;
        const first = Math.min(...[...after].filter((id) => !within.has(id)).map((id) => pos.get(id)!));
        const c: Cand = { asks: s, after, gain, score: gain / s.length, cost: costOf(s), first, top: Math.max(...s.map((k) => full.get(k)!.blocks.length)) };
        if (better(c, best)) best = c;
      }
      if (!best) break;
      best.asks.forEach((k) => cleared.add(k));
      const brings = order([...best.after].filter((id) => !within.has(id)));
      const noClock = reach(new Set([...cleared].filter((k) => !clocks.has(k))));
      within = best.after;
      plan.push({ asks: best.asks.map((k) => full.get(k)!).sort(rank), brings, afterClock: brings.filter((id) => !noClock.has(id)), actionableAfter: within.size });
    }
  }

  const blockers = [...full.values()].filter((x) => x.kind !== 'clock' && x.blocks.length).sort(rank);
  return {
    actionable: { count: base.size, ids: order(base) },
    of: nodes.size,
    workable: workable(board, reachable, cx, now).map((u) => u.ticket.id).filter(mine),
    claimed: order(claimed),
    bringUp: probes ? resourceBringUps(board, probes, cx).flatMap((r) => { const waiting = r.waiting.filter(mine); return waiting.length ? [{ ...r, waiting }] : []; }) : [],
    blockers,
    startFirst: blockers.filter((x) => x.lead),
    clock: [...full.values()].filter((x) => x.kind === 'clock').sort(rank),
    plan,
    unreachable: order([...nodes.keys()].filter((id) => !within.has(id))),
    touchesUnassessed: board.filter((t) => t.status === 'open' && t.touches === undefined && mine(t.id)).map((t) => t.id),
    stop: stopOf(board, reachable, cx, now, scope),
  };
}

const few = (ids: string[], n = 6) => (ids.length > n ? `${ids.slice(0, n).join(', ')} … +${ids.length - n}` : ids.join(', '));

export function prepareText(j: PrepareJson): string[] {
  const L: string[] = [];
  L.push(`actionable now: ${j.actionable.count} of ${j.of} tickets${j.actionable.count ? ` (${few(j.actionable.ids, 12)})` : ''}`);
  if (j.claimed.length) L.push(`  claimed by other workers: ${j.claimed.join(', ')}`);
  for (const r of j.bringUp) L.push(`  agent bring-up first: ${r.resource} [${r.waiting.join(', ')}]${r.bringUp ? ` — ${r.bringUp}` : ''}`);
  if (j.startFirst.length) {
    L.push('', 'start these first — they take days to come back:');
    for (const b of j.startFirst) L.push(`  [${b.label}${b.days !== null ? `, ${b.days} d` : ''}] ${b.ask}`, `      blocks ${few(b.blocks)}`);
  }
  if (j.blockers.length) {
    L.push('', 'what blocks the most tickets:');
    const w = String(j.blockers[0].blocks.length).length;
    for (const b of j.blockers) {
      const extra = [b.frees.length !== b.blocks.length ? `alone frees ${b.frees.length}` : '', b.days !== null ? `waiting ${b.days} d` : ''].filter(Boolean).join(', ');
      L.push(`  ${String(b.blocks.length).padStart(w)}  ${b.label.padEnd(26)} ${b.ask}`);
      L.push(`  ${' '.repeat(w)}  ${''.padEnd(26)} ${few(b.blocks)}${extra ? `  (${extra})` : ''}`);
    }
  }
  if (j.plan.length) {
    L.push('', 'suggested order — each step the asks adding the most tickets per ask:');
    j.plan.forEach((s, i) => {
      const clock = s.afterClock.length ? `, ${s.afterClock.length} once a clock opens` : '';
      L.push(`  ${i + 1}. +${s.brings.length} → ${s.actionableAfter} of ${j.of}  (${few(s.brings)}${clock})${s.asks.length > 1 ? `  — ${s.asks.length} asks, needed together` : ''}`);
      for (const a of s.asks) L.push(`     [${a.label}${a.days !== null ? `, ${a.days} d` : ''}] ${a.ask}`);
    });
  } else L.push('', 'no ask brings another ticket within reach');
  if (j.clock.length) {
    L.push('', 'the clock clears (no ask):');
    for (const c of j.clock) L.push(`  ${c.ask}${c.opens ? ` — opens ${c.opens}` : ''}: holds ${few(c.blocks)}`);
  }
  if (j.unreachable.length) L.push('', `out of reach whatever is settled (a cycle, or outside the group): ${j.unreachable.join(', ')}`);
  if (j.touchesUnassessed.length) L.push('', `touches never assessed — a fan-out schedules these freely and checks nothing at merge; write touches ([] = changes no repo file) before fanning out: ${few(j.touchesUnassessed, 12)}`);
  return L;
}
