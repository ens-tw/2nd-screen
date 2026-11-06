// `init` and `upgrade` (run from the skill's copy of the engine) and `stamp` (maintainers).
//
// A repo holds a pinned COPY of the engine at tickets/engine: the board check is part of the commit's
// state, so it must not depend on a skill path on this machine, and a skill update must not turn a
// repo red before the repo opts in. `upgrade` moves the pin; `check` catches a hand-edited copy.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { engineFiles, engineHash, readVersion, sameVersion, showVersion, stampVersion } from './version.mts';
import { makeIo } from './lib.mts';

export type Outcome = { code: number; lines: string[] };

export const DEFAULT_IDS = '^[A-Z][A-Z0-9]*-\\d+$';
const RUN = 'node tickets/engine/cli.mjs';

/** Copy the engine's files (modules + VERSION) from `from` into `to`, removing stale modules. */
export function copyEngine(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const f of engineFiles(to)) rmSync(join(to, f));
  for (const f of [...engineFiles(from), 'VERSION']) copyFileSync(join(from, f), join(to, f));
}

/** The skill's own engine must match its VERSION before it is copied anywhere. */
function selfCheck(engineDir: string): string | undefined {
  const v = readVersion(engineDir);
  if (!v) return `${engineDir}/VERSION is missing — this engine is not releasable`;
  if (v.sha !== engineHash(engineDir)) return `${engineDir} does not hash to its VERSION — a maintainer must stamp it (node ${join(engineDir, 'cli.mjs')} stamp) before it is copied into a repo`;
  return undefined;
}

/** Parse `--ids`: a regex source, with or without surrounding slashes. */
export function parseIds(src: string | undefined): RegExp {
  const s = (src ?? DEFAULT_IDS).trim();
  const m = /^\/(.*)\/([a-z]*)$/.exec(s);
  return m ? new RegExp(m[1], m[2]) : new RegExp(s);
}

function detectMain(root: string): string {
  const io = makeIo(root);
  if (!io.hasGit) return 'main';
  for (const b of ['main', 'master']) if (io.git('rev-parse', '--verify', '--quiet', `refs/heads/${b}`).ok) return b;
  const head = io.git('symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD');
  if (head.ok && head.out) return head.out.replace(/^refs\/remotes\/origin\//, '');
  return io.git('branch', '--show-current').out || 'main';
}

function detectTests(root: string): 'node-test' | 'ctest' {
  try {
    if (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))?.scripts?.test) return 'node-test';
  } catch { /* no package.json */ }
  const io = makeIo(root);
  const cmake = io.hasGit ? io.git('ls-files', '--', '*CMakeLists.txt').out : '';
  return cmake || existsSync(join(root, 'CMakeLists.txt')) ? 'ctest' : 'node-test';
}

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function configSkeleton(o: { ids: RegExp; main: string; tests: string }): string {
  return `// Ticket board configuration. Format and options: the ticket-board skill, references/board-format.md.
import type { Config } from './engine/types.mts';
// import { probes } from './engine/lib.mts';

export default {
  ids: ${o.ids.toString()},
  main: ${q(o.main)},
  tests: ${q(o.tests)},
  // groups: { A: 'Track A — what it is for' },          // key order = the view's order
  // boxes: ['mac', 'pi'],                               // where an agent may run (next --on <box>)
  // resources: {                                        // key order = scarcity order
  //   bench: { on: 'pi', paths: ['docs/bench.md'], bringUp: 'how an agent brings it up', probe: probes.path('/dev/ttyAMA0') },
  // },
  // authorizations: {                                  // shared standing grants; tickets name them in authorizations
  //   flash: { what: 'Flash the test device', ask: 'Authorize flash writes?', since: '2026-11-04' },
  // },                                                 // add grant: { source: 'AGENTS.md', quote: 'exact owner grant' } only after it is given
} satisfies Config;
`;
}

export const BOARD_SKELETON = `// The ticket board — the ONLY place work status lives. Array order is priority order.
//
//   ${RUN} next     what can an agent do here, right now?        (JSON; --text for a terminal)
//   ${RUN} list     every ticket with its derived state
//   ${RUN} check    the board against the tree — run it before committing tickets/
//   ${RUN} view     a throwaway HTML page of the board: _output/board-status.html (git-ignored)
//
// Read the board through those commands, never by grepping this file: the holds they derive, whether a
// window is open and which members are unmet are computed, and are nowhere in here.
// Edit a ticket in place when its state changes. Findings go into the doc the ticket refs, the story
// of the work into the commit message — never a dated "what this session did" note here.
import type { Board } from './engine/types.mts';

export default [
  // { id: 'T-1', title: '…', why: '…', status: 'open', next: '…', doneWhen: { kind: 'judgment', when: '…' } },
] satisfies Board;
`;

/** Machine-local files under tickets/ (`next`'s probe log, `review`'s requests) stay out of git. */
export const CACHE_IGNORE = 'tickets/.cache/';
/** Generated pages for people (the status page `view` and `next` write) stay out of git. */
export const OUTPUT_IGNORE = '_output/';

const IGNORES: { entry: string; probe: string; why: string }[] = [
  { entry: CACHE_IGNORE, probe: `${CACHE_IGNORE}probes.jsonl`, why: 'machine-local: the probe log next keeps, review requests' },
  { entry: OUTPUT_IGNORE, probe: `${OUTPUT_IGNORE}board-status.html`, why: 'generated for people: the status page view and next write' },
];

/** Add tickets/.cache/ and _output/ to .gitignore, each unless git already ignores it (a broader rule,
 *  a global excludes file). One report line per entry added. */
export function ensureIgnored(root: string): string[] {
  const io = makeIo(root);
  const p = join(root, '.gitignore');
  const lines: string[] = [];
  for (const { entry, probe, why } of IGNORES) {
    if (io.hasGit && io.git('check-ignore', '-q', '--no-index', probe).ok) continue;
    const text = existsSync(p) ? readFileSync(p, 'utf8') : '';
    if (new RegExp(`^/?${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/$/, '')}/?\\s*$`, 'm').test(text)) continue;
    writeFileSync(p, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${entry}\n`);
    lines.push(`.gitignore: ${entry} added (${why})`);
  }
  return lines;
}

/** Set a repo up: engine copy, config + board skeletons, the AGENTS.md Work queue section. No view doc:
 *  the board is read through the CLI, and `view` renders a page to the git-ignored _output/. */
export function init(root: string, engineDir: string, opts: { ids?: string } = {}): Outcome {
  const bad = selfCheck(engineDir);
  if (bad) return { code: 2, lines: [bad] };
  let ids: RegExp;
  try { ids = parseIds(opts.ids); } catch (e) { return { code: 2, lines: [`--ids: not a regular expression: ${(e as Error).message}`] }; }
  const lines: string[] = [];
  const at = (p: string) => join(root, p);
  mkdirSync(at('tickets'), { recursive: true });

  const pinned = readVersion(at('tickets/engine'));
  const mine = readVersion(engineDir);
  if (!existsSync(at('tickets/engine'))) { copyEngine(engineDir, at('tickets/engine')); lines.push(`tickets/engine: pinned engine ${showVersion(mine)}`); }
  else if (sameVersion(pinned, mine)) lines.push(`tickets/engine: already pins ${showVersion(mine)}`);
  else lines.push(`tickets/engine: kept (pins ${showVersion(pinned)}; this skill has ${showVersion(mine)} — upgrade moves the pin)`);

  if (!existsSync(at('tickets/config.mts'))) {
    writeFileSync(at('tickets/config.mts'), configSkeleton({ ids, main: detectMain(root), tests: detectTests(root) }));
    lines.push('tickets/config.mts: written — check ids, main and tests');
  } else lines.push(`tickets/config.mts: kept${opts.ids ? ' (--ids applies only to a new config; edit it instead)' : ''}`);

  if (!existsSync(at('tickets/board.mts'))) { writeFileSync(at('tickets/board.mts'), BOARD_SKELETON); lines.push('tickets/board.mts: written (empty)'); }
  else lines.push('tickets/board.mts: kept');

  lines.push(...ensureIgnored(root));

  const agents = at('AGENTS.md');
  const section = workQueueSection();
  if (!existsSync(agents)) { writeFileSync(agents, `# AGENTS.md\n\n${section}`); lines.push('AGENTS.md: written with a Work queue section'); }
  else if (/Work queue:/.test(readFileSync(agents, 'utf8'))) lines.push('AGENTS.md: has a Work queue line — kept (point it at the board if it names something else)');
  else { writeFileSync(agents, placeWorkQueue(readFileSync(agents, 'utf8'), section)); lines.push('AGENTS.md: Work queue section added'); }
  return { code: 0, lines };
}

/** A heading that looks like references / sources — the Work queue section goes before it. */
const REFS_HEADING = /^##\s+(?:\d+[.)]?\s*)?(?:references?|sources?|see also|links|further reading|bibliography|credits|acknowledg)/i;

export function workQueueSection(): string {
  return `## Work queue

Work queue: \`${RUN} next\` — the item to work now; \`${RUN} list\` — every ticket with its state (JSON; \`--text\` for a terminal, \`view\` for a page).
Read the board through these, never by grepping tickets/board.mts; edit tickets/board.mts by hand and run \`${RUN} check\` before committing anything under \`tickets/\`.
`;
}

/** The Work queue section, before the first references/sources-like `## ` heading, else at the end. */
export function placeWorkQueue(text: string, section: string): string {
  const lines = text.replace(/\s*$/, '').split('\n');
  const at = lines.findIndex((l) => REFS_HEADING.test(l));
  if (at < 0) return `${lines.join('\n')}\n\n${section}`;
  lines.splice(at, 0, ...section.replace(/\n$/, '').split('\n'), '');
  return `${lines.join('\n')}\n`;
}

/** Replace the repo's engine copy with the skill's. */
export function upgrade(root: string, engineDir: string): Outcome {
  const bad = selfCheck(engineDir);
  if (bad) return { code: 2, lines: [bad] };
  const repo = join(root, 'tickets', 'engine');
  if (!existsSync(join(root, 'tickets', 'config.mts'))) return { code: 2, lines: [`no tickets/config.mts under ${root} — set the repo up with init first`] };
  const before = readVersion(repo);
  const mine = readVersion(engineDir);
  const handEdited = before && existsSync(repo) && engineHash(repo) !== before.sha;
  const ignored = ensureIgnored(root);
  if (sameVersion(before, mine) && !handEdited) return { code: 0, lines: [`tickets/engine: already pins ${showVersion(mine)}`, ...ignored] };
  copyEngine(engineDir, repo);
  return {
    code: 0,
    lines: [
      `tickets/engine: ${showVersion(before)}${handEdited ? ' (hand-edited)' : ''} → ${showVersion(mine)}`,
      ...ignored,
      `next: ${RUN} check --text, then commit tickets/engine${ignored.length ? ' and .gitignore' : ''} — and read references/migration.md (Upgrading): 0.5.0 drops the committed view (write is gone; delete the markers block) and prints JSON by default`,
    ],
  };
}

/** Maintainers: rewrite the skill engine's VERSION after changing it. Refused in a repo's copy. */
export function stamp(engineDir: string, semver?: string): Outcome {
  if (existsSync(join(dirname(engineDir), 'board.mts')) || existsSync(join(dirname(engineDir), 'config.mts'))) {
    return { code: 2, lines: ['this is a repo\'s pinned copy — change the skill\'s engine and upgrade instead'] };
  }
  if (semver !== undefined && !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(semver)) return { code: 2, lines: [`--semver: "${semver}" is not a semver`] };
  const v = stampVersion(engineDir, semver);
  return { code: 0, lines: [`${join(engineDir, 'VERSION')}: ${showVersion(v)}`] };
}
