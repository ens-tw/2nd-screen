// The engine's VERSION: a semver plus a sha256 over the engine's own files. A repo pins a COPY of the
// engine in tickets/engine; `check` fails when that copy no longer hashes to its VERSION (a hand edit —
// change the skill's engine upstream, then `upgrade`).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The files that make up an engine: its .mjs/.mts modules (VERSION and strays like .DS_Store excluded). */
export const engineFiles = (dir: string): string[] =>
  readdirSync(dir).filter((f) => /\.(mjs|mts)$/.test(f) && statSync(join(dir, f)).isFile()).sort();

/** sha256 over the engine files (name and content, line endings normalised). */
export function engineHash(dir: string): string {
  const h = createHash('sha256');
  for (const f of engineFiles(dir)) {
    h.update(`${f}\0`);
    h.update(readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n'));
    h.update('\0');
  }
  return h.digest('hex');
}

export type Version = { semver: string; sha: string };

export function readVersion(dir: string): Version | undefined {
  const p = join(dir, 'VERSION');
  if (!existsSync(p)) return undefined;
  const text = readFileSync(p, 'utf8');
  const semver = /^\s*(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/m.exec(text)?.[1];
  const sha = /sha256:([0-9a-f]{64})/.exec(text)?.[1];
  return semver && sha ? { semver, sha } : undefined;
}

export const showVersion = (v: Version | undefined): string => (v ? `${v.semver} (sha256:${v.sha.slice(0, 12)})` : 'unversioned');

export const sameVersion = (a: Version | undefined, b: Version | undefined): boolean =>
  !!a && !!b && a.semver === b.semver && a.sha === b.sha;

/** Rewrite dir/VERSION with the current hash (maintainers only, in the skill's copy). */
export function stampVersion(dir: string, semver?: string): Version {
  const v = { semver: semver ?? readVersion(dir)?.semver ?? '0.1.0', sha: engineHash(dir) };
  writeFileSync(join(dir, 'VERSION'), `${v.semver}\nsha256:${v.sha}\n`);
  return v;
}
