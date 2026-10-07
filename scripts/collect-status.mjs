// Writes this computer's usage snapshot - plan limits, plan names and an activity estimate for
// Claude and Codex - into .agent-team/status/usage/<computer>.json, for the dashboard to read.
//
// Run it: npm run collect:status -- --computer "Mac Mini"
//         npm run collect:status -- --dry-run          (prints the file, writes nothing)
//
// Every value passes the safety check in scripts/lib/status/safe.mjs before anything is written
// or printed. If it refuses, nothing is written and the exit code is not zero. The format, the
// sources and the Mac schedule are documented in .agent-team/status/README.md.

import { fileURLToPath } from 'node:url'
import { runCollector } from './lib/status/run.mjs'
import { machineDeps } from './lib/status/machine.mjs'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))

try {
  process.exitCode = await runCollector({
    argv: process.argv.slice(2),
    deps: machineDeps(),
    repoRoot,
    out: (line) => console.log(line),
    err: (line) => console.error(line)
  })
} catch {
  // Deliberately no error message: an unexpected error can carry a path or a value.
  console.error('The collector stopped on an unexpected error. Nothing was printed from it on purpose.')
  process.exitCode = 1
}
