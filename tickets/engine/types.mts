// ticket-board — the data model. Type-only: erased at run time. The engine checks the same shapes
// at run time (validate.mts), because many repos that keep a board have no type checker.
//
// A repo's board is `tickets/board.mts`:  export default [ { id: 'T-1', … }, … ] satisfies Board
// An ARRAY, so a duplicated id is caught (an object literal would silently keep the last one), and
// array order is priority order.

/** A calendar day, `YYYY-MM-DD`. */
export type Day = `${number}-${number}-${number}`;

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** A window that opens once: workable from `opens` on. `opens` is an ISO 8601 instant that keeps its
 *  offset (`2026-10-13T09:00:00+08:00`). Past it, the ticket is simply workable. */
export type OneShotWindow = { what: string; opens: string };

/** A window that recurs: open on `days`, `from`–`to` (24 h `HH:MM`, wall clock in the IANA zone `tz`;
 *  `to` at or before `from` = it closes the next day; `to` may be `24:00`). `skip` = days it does not
 *  open (holidays), as days in `tz`. Next-open times are computed, never written by hand. */
export type RecurringWindow = {
  what: string;
  tz: string;
  days: 'mon-fri' | 'daily' | readonly Weekday[];
  from: string;
  to: string;
  skip?: readonly Day[];
};

export type Window = OneShotWindow | RecurringWindow;

export type OwnerAs = 'hands' | 'decision' | 'errand';

/** The only holds written by hand. Everything else that stops a ticket is derived (Hold). */
export type Blocker =
  /** A decision, a fact or a hands-on step only the owner can give. `since` = the day first asked.
   *  `as` says what settling it takes, for `prepare`'s order: `hands` (a step at the bench, minutes),
   *  `decision` (an answer), `errand` (something to get or arrange that takes days: ask it first). */
  | { kind: 'owner'; ask: string; since: Day; as?: OwnerAs }
  /** The owner's explicit go for a hazardous step (it wipes, burns, spends, publishes). */
  | { kind: 'go'; ask: string; since: Day }
  /** A third party (a broker, a vendor, a supplier). From `recheck` on, the ticket is workable again
   *  so an agent re-checks; until then it is a clock, not a person. */
  | { kind: 'external'; who: string; what: string; recheck?: Day };

/** Everything that stands between a ticket and work: its blockers, its window, and the derived holds.
 *  `via` says what a derived hold came from, so a wrong one can be traced. */
export type Hold =
  | Blocker
  | { kind: 'authorization'; needs: string; ask: string; since: Day; via: string }
  | ({ kind: 'window' } & Window)
  /** A ref of the ticket lies under one of the resource's paths. */
  | { kind: 'resource'; needs: string; via: string }
  /** From `after` (a group target expands to its members), or from an extension. */
  | { kind: 'ticket'; id: string; via: string }
  /** Someone has it: a claim on this machine (claims.mts). Never written on the board. */
  | ({ kind: 'claim' } & Omit<Claim, 'ticket' | 'member'>);

/** Who is working a ticket, or one member of it, right now — machine-local, one file per claim
 *  (claims.mts). `to` = the worker's label, handed out by the session (self-reported); `by` = the session
 *  that took it, where the runner has an id; `branch` = where the work lands, which git can check;
 *  `host` and `at` (ISO 8601) = where and when it was taken. */
export type Claim = { ticket: string; member?: string; to: string; by?: string; branch?: string; host: string; at: string };

/** A test named `name` exists in `file`, and `file` is run by the repo's test command. */
export type TestDone = { kind: 'test'; file: string; name: string };
/** `doc` carries `<!-- answer: <ticket id> -->` where the answer is written. */
export type AnswerDone = { kind: 'answer'; doc: string };
/** No check fits; a human decides. Keep these few — the view lists them. */
export type JudgmentDone = { kind: 'judgment'; when: string };
/** A kind a repo adds through an extension (`doneKinds`). */
export type ExtensionDone = { kind: string; [field: string]: unknown };

export type DoneWhen = TestDone | AnswerDone | JudgmentDone | ExtensionDone;

type Base = {
  /** Named standing permissions in config.authorizations; missing grants derive live holds. */
  authorizations?: string[];
  id: string;
  title: string;
  /** Why the ticket exists — the reason survives when the details change. */
  why: string;
  /** Repo paths (optionally `#anchor` or ` §x`) with the evidence or plan. Each must exist. */
  refs?: string[];
  /** A key of config.groups. */
  group?: string;
};

type Live = {
  doneWhen: DoneWhen;
  /** The ONE next action, not a plan. Required, except on a ticket whose done condition reports
   *  members (Member): `next` prints the member it offers and a generated summary instead. */
  next?: string;
  /** A branch holding half-done work that cannot land on main yet. */
  wip?: string;
  /** Workable only inside this window. A clock, never a person. */
  window?: Window;
  /** A hazardous step: `next` prints it every time it offers the ticket. */
  hazard?: string;
  /** Ticket ids or group keys that must be done first (a group: every non-dropped member). */
  after?: string[];
  /** What the work will change: repo paths (a folder ends in `/`) and `@name` for a thing on the machine
   *  only one worker may use (a port, a bench, a browser profile). Paths need not exist yet. Two units
   *  whose touches meet must not run at once; a unit without touches runs alone. */
  touches?: string[];
  /** Hand-written holds only a person or an outside party lifts. */
  blockers?: [Blocker, ...Blocker[]];
};

/** `status` is the lifecycle a person decides; whether an open ticket can be worked now is derived
 *  from its holds (`list`'s `state`). */
export type Ticket = Base & (
  | ({ status: 'open' } & Live)
  /** Parked by a decision; `until` says what resumes it. */
  | { status: 'paused'; doneWhen: DoneWhen; until: string; wip?: string }
  /** `commit` must exist in git — the commit message is the record of the work. */
  | { status: 'done'; doneWhen: DoneWhen; commit: string }
  | { status: 'dropped'; reason: string }
);

export type Status = Ticket['status'];

export type Board = Ticket[];

// ── config (tickets/config.mts) ─────────────────────────────────────────────────────────────────

/** What a probe found. `here` = this machine hosts the resource, so an agent can bring it up itself;
 *  `usable` = work can use it now; `note` = why not yet (what the bring-up has to do). */
export type Probe = { here: boolean; usable: boolean; note?: string };

export type Resource = {
  /** The box(es) an agent must be on for it to be usable (`next --on <box>`). */
  on?: string | string[];
  /** Repo paths (files, or folder prefixes ending in `/`) that belong to it. A ticket whose ref lies
   *  under one of them needs the resource. Each must exist. */
  paths: string[];
  /** When a ticket may lean on it at all. */
  policy?: string;
  /** How an agent brings it up when the machine hosts it but it is down. */
  bringUp?: string;
  /** Is it usable from here, right now? Must never change state. Runs only in `next`. */
  probe?: () => Probe;
};

export type Authorization = {
  what: string;
  ask: string;
  since: Day;
  /** A standing grant, quoted from a tracked repo document. Removing it revokes availability.
   *  Session-only and one-use permissions stay outside this persistent registry. */
  grant?: { source: string; quote: string };
};

export type Caps = {
  title: number; why: number; next: number; until: number; reason: number; ask: number; what: number;
  when: number; name: number; window: number; hazard: number; policy: number; bringUp: number;
};

/** A done condition's verdict. `members` (from an extension done kind's `met`) lists the parts the
 *  condition covers — every one, met or not; `met` must be true exactly when all of them are. A ticket
 *  that reports members is worked member by member (references/extensions.md). */
export type Met = { met: boolean; why?: string; members?: Member[] };

/** One part of a done condition — an API in a ledger, a file in a list — as an extension done kind
 *  reports it. An unmet member says what holds it in the vocabulary a ticket uses, so `next` can offer
 *  the one that is workable now and the view can say what holds the rest. The same id reported by two
 *  tickets is the same part: the more specific ticket (fewer members) covers it, and the other ticket's
 *  member waits on it. */
export type Member = {
  authorizations?: string[];
  /** Unique within the ticket. */
  id: string;
  met: boolean;
  /** What stands between an unmet member and work: a blocker (owner / go / external), a window
   *  ({ kind: 'window', … }), a resource ({ kind: 'resource', needs, via }) or a ticket that must be done
   *  first ({ kind: 'ticket', id, via }). Ignored on a met member. */
  holds?: Hold[];
  /** Repo paths, like a ticket's: a resource whose paths hold one is needed (derived, never written). */
  refs?: string[];
  /** Where it stands, in a few words; `next` and `show` print it under the member. */
  note?: string;
  /** As a ticket's: what working this member will change. */
  touches?: string[];
};

/** Read access to the repo, for test rules and extensions. Paths are repo-relative. */
export type Io = {
  root: string;
  hasGit: boolean;
  exists(path: string): boolean;
  read(path: string): string;
  /** `git -C <root> …`; never throws. */
  git(...args: string[]): { ok: boolean; out: string };
};

export type TestRule = 'node-test' | 'ctest' | ((d: TestDone, io: Io) => Met);

export type Problem = { level: 'error' | 'warning' | 'note'; id?: string; message: string };

export type DoneKind = {
  /** Shape problems of one doneWhen of this kind (messages; empty = fine). */
  validate(d: ExtensionDone, ctx: Ctx): string[];
  /** Is it met? `undefined` = not checkable (treated like judgment). Repo files only, never the clock. */
  met(d: ExtensionDone, t: Ticket, ctx: Ctx): Met | undefined;
  /** A few words for the view and `next`. */
  describe(d: ExtensionDone): string;
  /** Where it stands now, for `next` only. */
  now?(d: ExtensionDone, t: Ticket, ctx: Ctx): string | undefined;
};

/** Repo-specific evidence for a pro-review dossier: a label and a few lines (a git log, a registry row). */
export type ReviewEvidence = { what: string; lines: string[] };

/** One unit of the board's whole surface, as a `coverage` hook reports it: an API, a file, a frame —
 *  something a repo wants counted. `met` = it has reached its target; `carrier` = the ticket responsible
 *  for an unmet unit (so `coverage` can say which ticket the unmet ones sit under); `note` = free text.
 *  The `coverage` command reports the surface directly, so a board need not keep an umbrella ticket whose
 *  only job is to enumerate it. */
export type CoverageUnit = { id: string; met: boolean; carrier?: string; note?: string };

/** The six extension points — exactly these. */
export type Extension = {
  doneKinds?: Record<string, DoneKind>;
  /** Extra derived holds for a live ticket. Deterministic (board + repo files): the view shows them. */
  holds?(t: Ticket, board: Board, ctx: Ctx): Hold[];
  /** Extra `check` problems. Deterministic; a clock-dependent finding is a warning. */
  check?(board: Board, ctx: Ctx): Problem[];
  /** Extra lines under the ticket `next` offers — and, when it offers one of the ticket's members,
   *  that member (its holds resolved). Repo-specific extras only: the member summary is generated. */
  nextLines?(t: Ticket, ctx: Ctx, member?: Member): string[];
  /** Extra evidence for the ticket's `review` dossier (e.g. which commit raised each API it names).
   *  Reads repo files and git only; must not change state. */
  reviewEvidence?(t: Ticket, ctx: Ctx): ReviewEvidence[];
  /** The board's whole surface — every unit, met or not — for the `coverage` command to aggregate.
   *  Deterministic (board + repo files): no clock, no probe. Lets a repo report board-wide coverage
   *  directly instead of through an umbrella ticket. */
  coverage?(ctx: Ctx): CoverageUnit[];
};

/** The maturity Nouls a pro review combines (config.jev.review.weights). */
export type MaturityPart = 'spec_clear' | 'done_checkable' | 'next_evidenced' | 'refs_present';

/** Routing thresholds for `review route`. Defaults are starting points, calibrated on one board
 *  (stockapi, 2026-10-13) — tune them on this repo's own answers; a route reads only stored answers,
 *  so moving one costs no call. */
export type ReviewThresholds = {
  /** A Choice stands at or above this confidence. Default 0.8. */
  accept?: number;
  /** A Noul below this reads false. Default 0.3. */
  clear?: number;
  /** A Noul above this reads true; from `clear` to `flag` is the mid band, back to the agent. Default 0.7. */
  flag?: number;
  /** A Score stands at or above this confidence. Default 0.6. */
  confidence?: number;
  /** How the maturity Nouls combine into one 0–1 maturity (a weighted mean). Default 1 each. */
  weights?: Partial<Record<MaturityPart, number>>;
};

/** Optional Jev judgments (`jev blocker` / `jev done` / `jev route`, `review`). The engine never calls
 *  Jev: it prints requests and routes answers. The thresholds are starting points — tune them on this
 *  repo's own answers. */
export type JevConfig = {
  /** What an agent can drive itself here, sent with every blocker check and every review request (e.g.
   *  'QMP send-key and screendump on the lab VM (tools/vm/qmp.py)'). A shell, files and git are always
   *  assumed. */
  tools?: string[];
  /** A Choice judgment stands at or above this confidence (citation_check's AUTO_ACCEPT). Default 0.8. */
  accept?: number;
  /** A Noul above this raises its flag (classifying_rag_passages). Default 0.7. */
  flag?: number;
  /** A Noul below this clears it; from `clear` to `flag` is the mid band, back to the agent. Default 0.3. */
  clear?: number;
  /** `review route`'s thresholds and maturity weights. */
  review?: ReviewThresholds;
};

export type ResolvedReview = Required<Omit<ReviewThresholds, 'weights'>> & { weights: Record<MaturityPart, number> };

export type Config = {
  /** The id pattern, e.g. /^T-\d+$/. */
  ids: RegExp;
  /** Deprecated since 0.5.0 and ignored (`check` warns): there is no committed view. It names the doc
   *  `check` looks in for a leftover pre-0.5.0 view block (default `docs/tickets.md`). */
  doc?: string;
  /** The main branch (wip branches must not be merged into it). Default `main`. */
  main?: string;
  /** Group key → label. Key order is the view's order. */
  groups?: Record<string, string>;
  /** The machines an agent may run on (`next --on <box>`). */
  boxes?: string[];
  /** External things a ticket can need. Key order = scarcity order: the first-listed goes first. */
  resources?: Record<string, Resource>;
  authorizations?: Record<string, Authorization>;
  /** How a `test` doneWhen is found. */
  tests?: TestRule;
  caps?: Partial<Caps>;
  extensions?: Extension[];
  jev?: JevConfig;
  /** A claim with no sign of life for this long — no commit on its branch, or none named and claimed
   *  that long ago — draws a `claim-stale` warning. Default 4. */
  claimStaleHours?: number;
};

/** A config with its defaults filled in. */
export type Resolved = {
  ids: RegExp;
  /** Where a pre-0.5.0 view block may be left over; `docGiven` = the config still sets the key. */
  doc: string;
  docGiven: boolean;
  main: string;
  groups: Record<string, string>;
  boxes: string[];
  resources: Record<string, Resource>;
  authorizations: Record<string, Authorization>;
  tests?: TestRule;
  caps: Caps;
  extensions: Extension[];
  jev: Required<Omit<JevConfig, 'review'>> & { review: ResolvedReview };
  claimStaleHours: number;
};

/** What derivations, checks and extensions read. `claims` (keyed `<ticket>` or `<ticket> › <member>`)
 *  is set only where machine-local state belongs — next, list, show, the status page, claim — never
 *  for check's errors or a review, which must read the same on every machine. */
export type Ctx = {
  root: string; config: Resolved; io: Io; claims?: ReadonlyMap<string, Claim>;
  /** Tickets the board file still writes as `status: 'blocked'`; load reads them as `open`. */
  legacyBlocked?: readonly string[];
};

/** Why `next` found nothing workable here (the long-run stop codes). */
export type Stop =
  | { code: 'queue-empty' }
  | { code: 'needs-authorization' }
  | { code: 'clock-gated'; until: string }
  | { code: 'needs-human' };
