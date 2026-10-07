// The command line: the real machine's dependencies, the run, and the exit code.
//
// scripts/collect-status.mjs calls main() with nothing replaced, which is the only way it runs
// for real. Tests spawn tests/helpers/collector-cli.mjs instead, which calls main() with the
// Keychain command, the network and the platform replaced - a spawned process on a Mac would
// otherwise read the real login Keychain, whatever HOME says. Those three are the only things a
// caller can replace: the gate, the identity it checks against and the sources always come from
// this machine.

import { fileURLToPath } from 'node:url'
import { runCollector } from './run.mjs'
import { machineDeps } from './machine.mjs'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

const SEAMS = ['exec', 'fetch', 'platform']

export function seamsFrom(replace = {}) {
  const picked = {}
  for (const name of SEAMS) {
    if (replace[name] !== undefined) picked[name] = replace[name]
  }
  return picked
}

export async function main({ argv = process.argv.slice(2), replace = {} } = {}) {
  try {
    return await runCollector({
      argv,
      deps: machineDeps(seamsFrom(replace)),
      repoRoot,
      out: (line) => console.log(line),
      err: (line) => console.error(line)
    })
  } catch {
    // Deliberately no error message: an unexpected error can carry a path or a value.
    console.error('The collector stopped on an unexpected error. Nothing was printed from it on purpose.')
    return 1
  }
}
