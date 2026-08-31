// Reads quality/verdicts/ and says whether each one is backed by something that exists.
//
// Run it: npm run check:verdicts
//
// A verdict is you, saying what you did with a piece your team made. It is the only file here
// written by you about the team, and the acceptance rate is computed from nothing else. It was
// also the only artifact in this repo with no checker at all: runs/ has validate:runs, ledger.yml
// has check:ledger, proposals.yml has check:proposals, workflows/ has check:arming.
//
// The failure that motivated this: a verdict whose value is not one of the three is not counted
// as a bad week. It is not counted at all - it leaves both halves of shipped/(shipped+edited+
// rejected) - so the rate goes UP. A silent drop reads as approval.

import { readdir, readFile } from 'node:fs/promises'
import { loadVerdicts, validateVerdict, acceptance } from './lib/verdicts.mjs'
import { runLogFiles } from './lib/run-log.mjs'

const files = await loadVerdicts()

if (files.length === 0) {
  console.log('No verdicts filed yet.')
  console.log('')
  console.log('That is not a failure - it is the state of every repo before the first week of real')
  console.log('work. It does mean your acceptance rate is UNCOMPUTABLE rather than 0%, and those')
  console.log('are different claims. Say what you did with a piece: /capture-verdict')
  process.exit(0)
}

// Injected rather than assumed. An empty list would fail every cross-check, so a directory that
// cannot be read is left out of `known` entirely and that comparison is skipped.
const listOrNull = async (dir, map = (x) => x) => {
  try {
    return (await readdir(dir, { recursive: true })).flatMap((entry) => map(String(entry).split('\\').join('/')))
  } catch {
    return null
  }
}

// `runs/` holds month folders AND `runs/heartbeat/`, which is a different shape of file
// entirely. Sweeping every .json under runs/ is the same assumption that had validate:runs
// reporting sixteen problems against a correctly written heartbeat, so this walks with the
// SAME function rather than keeping a second copy of the sweep. Today a heartbeat happens to
// survive this harmlessly - it has no run_id, so it filters out - but that is an accident of
// what heartbeats currently contain, not a guard, and it is exactly how the first one hid.
const runFiles = await runLogFiles('runs', { readdir }).catch(() => null)
const runIds = runFiles === null
  ? null
  : (await Promise.all(runFiles.map(async (file) => {
      try {
        return JSON.parse(await readFile(file, 'utf8'))?.run_id ?? null
      } catch {
        // A malformed run log is validate:runs' problem, not this script's. Skipping it here
        // means a verdict citing it reports "no run log", which is the honest reading.
        return null
      }
    }))).filter(Boolean)

const artifacts = await listOrNull('agents', (entry) =>
  entry.includes('/output/') && entry.endsWith('.md') ? [`agents/${entry}`] : []
)
const rubrics = await listOrNull('shared/standards/rubrics', (entry) =>
  entry.endsWith('.md') ? [entry.slice(0, -3)] : []
)

const known = {}
if (runIds) known.runIds = runIds
if (artifacts) known.artifacts = artifacts
if (rubrics) known.rubrics = rubrics

const problems = files.flatMap((file) => validateVerdict(file, known))
const rate = acceptance(files)

console.log(`${files.length} verdict${files.length === 1 ? '' : 's'} filed.`)
console.log(
  `  ${rate.shipped} shipped, ${rate.edited} edited, ${rate.rejected} rejected` +
    (rate.uncountable ? ` - and ${rate.uncountable} that no bucket can hold` : '')
)
if (rate.rate === null) {
  console.log('  Acceptance rate: UNCOMPUTABLE - nothing here can be counted.')
} else {
  console.log(`  Acceptance rate: ${Math.round(rate.rate * 100)}% of ${rate.counted} counted.`)
}

if (problems.length) {
  console.error(`\n${problems.length} thing${problems.length === 1 ? '' : 's'} to fix:\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nA verdict nothing can check is a verdict the weekly review will drop without')
  console.error('telling you, and a dropped verdict raises your acceptance rate instead of lowering it.')
  process.exit(1)
}

console.log('\nEvery verdict names a piece that exists and a value the review can count.')
