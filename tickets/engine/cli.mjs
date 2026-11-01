#!/usr/bin/env node
// ticket-board — the single entry point. Plain JavaScript on purpose: an old Node gets a clear
// message here instead of a syntax error from the TypeScript modules it would otherwise load.
//
//   node tickets/engine/cli.mjs help        (a repo's pinned copy)
//   node <skill>/engine/cli.mjs init        (the skill's copy: init / upgrade / migrate)
if (!process.features?.typescript) {
  process.stderr.write(`ticket-board needs Node >= 22.18 (built-in TypeScript type stripping); this is ${process.version}.\n`);
  process.exit(2);
}
// A reader that stops early (`… | head -1`) closes the pipe: that is not an error, exit quietly.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e) => {
    if (e.code === 'EPIPE') process.exit(process.exitCode ?? 0);
    throw e;
  });
}
const { main } = await import('./main.mts');
process.exitCode = await main(process.argv.slice(2), import.meta.url);
