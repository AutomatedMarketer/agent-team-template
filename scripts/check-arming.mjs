// Reads workflows/ and .agent-team/routines.json, and says which of your jobs actually ring.
//
// Run it: npm run check:arming
//
// A workflow file saying `schedule: "daily 06:30"` makes nothing happen at 06:30. A routine is the
// thing that rings. This is the one command that compares the two, and it is the only way to see
// the two states that cost you something:
//
//   declared    the file says run it, and NOTHING rings          - a wish
//   unapproved  a routine RINGS, and the file says it is off     - spend nobody approved
//
// Until this existed, validateArming was imported by exactly one file: its own test. A rule only
// the test suite can run is a rule students never see.

import { loadWorkflows } from './lib/workflows.mjs'
import { loadRoutineSnapshot, reconcile } from './lib/arm.mjs'

const workflows = await loadWorkflows()
const snapshot = await loadRoutineSnapshot()

// Said before anything else, because every line below is only as true as this file is. A snapshot
// presented as live is the same class of lie as a job claiming a schedule nothing fires.
if (snapshot.missing) {
  console.log(`No usable snapshot of your routines - ${snapshot.reason}.`)
  console.log('Run /routines first. Until then this can only report what your FILES claim,')
  console.log('and a file claiming a schedule is exactly what this command exists to check.\n')
} else if (snapshot.stale) {
  console.log(`Careful: ${snapshot.reason}. Run /routines again before trusting the lists below.\n`)
} else {
  console.log(`Routines as of ${new Date(snapshot.takenAt).toLocaleString()}.\n`)
}

// When the snapshot cannot be trusted, the routines are NOT known - so nothing is called armed,
// declared or unapproved, because none of those can be told apart without evidence. Saying "I
// cannot tell" is the whole job here.
const routinesKnown = !snapshot.missing && !snapshot.stale
const result = reconcile(workflows, snapshot.routines, { routinesKnown })
const plural = (list, word) => `${list.length} ${word}${list.length === 1 ? '' : 's'}`

if (routinesKnown) {
  console.log(`  ${plural(result.armed, 'job')} armed - the file says run it and a routine exists`)
  console.log(`  ${plural(result.declared, 'job')} declared - the file says run it and nothing rings`)
  console.log(`  ${plural(result.unapproved, 'job')} unapproved - something rings that the file never approved`)
} else {
  console.log(`  ${plural(result.unknown, 'job')} the file says should run - whether anything rings is UNKNOWN`)
}
console.log(`  ${plural(result.off, 'job')} off, with a written reason`)

for (const [heading, rows] of [
  ['The file says these should run - nothing here can tell you whether they do', result.unknown],
  ['Armed', result.armed],
  ['DECLARED - these are wishes, not jobs', result.declared],
  ['UNAPPROVED - these are spending runs nobody agreed to', result.unapproved],
  ['Off', result.off]
]) {
  if (!rows.length) continue
  console.log(`\n${heading}:`)
  for (const row of rows) {
    console.log(`  ${row.name}${row.schedule ? ` - ${row.schedule}` : ''}`)
    if (row.reason) console.log(`      ${row.reason}`)
  }
}

if (result.orphans.length) {
  console.log('\nRoutines with no workflow file behind them:')
  for (const orphan of result.orphans) console.log(`  ${orphan.name}`)
  console.log('  Reported, not adopted. Something was renamed or removed after it was armed.')
}

if (result.problems.length) {
  console.error(`\n${result.problems.length} thing${result.problems.length === 1 ? '' : 's'} to fix:\n`)
  for (const problem of result.problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log('\nEvery job is either armed, or off with a reason somebody wrote down.')
