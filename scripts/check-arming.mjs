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
import { loadRoutineSnapshot, reconcile, armedWithoutApproval, isArmed } from './lib/arm.mjs'
import { loadProposals } from './lib/proposals.mjs'
import { notInUseAgents } from './lib/knowledge.mjs'

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
// Split, because the line used to say "10 jobs off, with a written reason" while one of those ten
// was named four lines below as having none. A total that credits what it cannot evidence is the
// exact fault this command exists to find, and it was printing it.
// A webhook job has no clock, so it was never asked for a reason and must not be counted among
// the ones that owe one. The exemption went into arm.mjs and this reporter was not touched, so a
// single run printed both "1 job off with no reason written down" and "Every job is either armed,
// or off with a reason somebody wrote down" - two contradictory sentences about the same job, in
// the command whose whole purpose is catching a claim its own detail contradicts.
// A dashboard button is clockless for the same reason a webhook is, and was left out of this
// for a while - so a button-only job appeared in the 'off' total while arm.mjs refused to ask
// it for a reason. Both sides now use the same rule.
const isClocklessRow = (row) => (row.webhook === true || row.fire === true) && !row.schedule
const offClockless = result.off.filter(isClocklessRow)
const offWithReason = result.off.filter((row) => !isClocklessRow(row) && row.reason)
const offWithNone = result.off.filter((row) => !isClocklessRow(row) && !row.reason)
console.log(`  ${plural(offWithReason, 'job')} off, with a written reason`)
if (offClockless.length) {
  console.log(`  ${plural(offClockless, 'job')} with no clock - fired by webhook or a dashboard button, so nothing to be off from`)
}
if (offWithNone.length) {
  console.log(`  ${plural(offWithNone, 'job')} off with no reason written down - counted here, credited nowhere`)
}

for (const [heading, rows] of [
  ['The file says these should run - nothing here can tell you whether they do', result.unknown],
  ['Armed', result.armed],
  ['DECLARED - these are wishes, not jobs', result.declared],
  ['UNAPPROVED - these are spending runs nobody agreed to', result.unapproved],
  // Off and the webhook rows are listed apart because they are COUNTED apart, twenty lines up.
  // Printing `result.off` whole put a webhook row into a list of ten under a summary line that
  // said nine - the same total-disagrees-with-the-detail fault the comment above describes,
  // left behind when that fix corrected the counts and did not touch the listing.
  ['Off', result.off.filter((row) => !isClocklessRow(row))],
  ['No clock - fired by webhook or a dashboard button, so nothing to be off from', offClockless]
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

// APPROVAL, checked rather than trusted. The /arm skill says never to arm anything the ledger did
// not ask for; nothing enforced it, on the single step in the chain that spends money.
//
// A missing proposals.yml is NOT a failure here - somebody may not have reached lesson 16 yet -
// but it is not silence either. Saying "I cannot tell" is the same discipline the snapshot gets a
// few lines up, and for the same reason: an absent file is not evidence of approval.
// `result.armed` is the wrong predicate here and was wrong on the first attempt: without a
// snapshot nothing is CALLED armed, everything lands in `unknown`, and the message was suppressed
// in exactly the state a fresh repo is in. Approval is a fact about the FILE - it does not depend
// on knowing what rings - so both branches below read the file, the same way armedWithoutApproval
// does. Caught by an end-to-end test rather than by the unit tests, which never touch the wiring.
const armedInFiles = workflows.filter((row) => isArmed(row))
const proposals = await loadProposals().catch(() => null)
if (proposals === null) {
  if (armedInFiles.length) {
    console.log('')
    console.log(`${plural(armedInFiles, 'job')} armed, and no proposals.yml - whether they were approved is UNKNOWN. Run /match.`)
  }
} else {
  for (const problem of armedWithoutApproval(workflows, proposals)) result.problems.push(problem)
}

if (result.problems.length) {
  console.error(`\n${result.problems.length} thing${result.problems.length === 1 ? '' : 's'} to fix:\n`)
  for (const problem of result.problems) console.error(`  - ${problem}`)
  process.exit(1)
}

// Unconditional once, which meant it asserted every job was armed or off four lines after the
// command had said it could not tell which. Same output, same job, opposite claims - and it let
// "check:arming exits clean for everyone" pass vacuously on a repo where nothing is known to
// ring. With no snapshot there is nothing to be clean about, and saying so is the only ending
// this command has earned.
// A workflow owned by an agent the owner has switched off validates clean - validateWorkflow asks
// whether the agent EXISTS, not whether it is in use - and then never runs. Two of the nine
// shipped workflows are owned by sales and customer-service, which are exactly the two that
// usually do not apply to someone who works for the business rather than owning it. So this is
// not a hypothetical about files people write by hand; it is the state a fresh clone is already
// in the moment they answer those two knowledge files honestly.
// The map used to live here as a second copy. It is now in knowledge.mjs, which the catalogue
// reads too, so this guard and the matcher cannot disagree about which agents are switched off.
const offAgents = [...(await notInUseAgents(process.cwd()))]
// loadWorkflows returns { slug, path, data } - the owner is on `data`, not the row. Writing
// row.owner instead gave every workflow an owner of undefined, so this guard matched nothing and
// printed nothing, which reads exactly like a clean repo. Caught by testing it against a repo
// that should have failed it.
const orphanedByOwner = workflows.filter((row) => offAgents.includes(row?.data?.owner))
if (orphanedByOwner.length) {
  console.log('\nOwned by an agent you are not using - these cannot run as written:')
  for (const row of orphanedByOwner) {
    console.log(`  ${row.data.name} - owner: ${row.data.owner}`)
  }
  console.log('  Give each one a different owner, or leave it off deliberately. The workflow')
  console.log('  validator only checks the owner exists, so it will not tell you this.')
}

if (routinesKnown) {
  console.log(offClockless.length
    ? '\nEvery job is either armed, fired by webhook or a dashboard button, or off with a reason somebody wrote down.'
    : '\nEvery job is either armed, or off with a reason somebody wrote down.')
} else {
  console.log('\nEverything above is what your FILES claim. Run /routines and commit the result\n' +
    'before you believe any of it.')
  // Exiting 0 here is deliberate: a fresh clone has not reached /routines yet, and failing would
  // make the first run of this command look like a broken repo. But a clean exit is not evidence,
  // and the lesson's checklist has boxes this run LOOKS to have ticked and did not judge at all.
  // Without a snapshot nothing is ever called `declared`, so "declared is empty" is empty because
  // nothing was compared. Naming the boxes is the difference between a check that is honest in
  // its prose and one a reader can act on.
  console.log('\nThis run could not judge:')
  console.log('  - "declared is empty" - nothing was CALLED declared, because nothing was compared')
  console.log('  - "unapproved is empty" - no routine was visible to compare against')
  console.log('  - "check:arming exits without complaining" - it exited without DATA, not without problems')
  console.log('Those three cannot be ticked from this run. Run /routines, then run this again.')
}
