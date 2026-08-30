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

import { readFile } from 'node:fs/promises'
import { loadWorkflows } from './lib/workflows.mjs'
import { loadRoutineSnapshot, reconcile } from './lib/arm.mjs'
import { notInUse } from './lib/knowledge.mjs'

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
const isWebhookRow = (row) => row.webhook === true && !row.schedule
const offWebhook = result.off.filter(isWebhookRow)
const offWithReason = result.off.filter((row) => !isWebhookRow(row) && row.reason)
const offWithNone = result.off.filter((row) => !isWebhookRow(row) && !row.reason)
console.log(`  ${plural(offWithReason, 'job')} off, with a written reason`)
if (offWebhook.length) {
  console.log(`  ${plural(offWebhook, 'job')} fired by webhook - no clock, so nothing to be off from`)
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
  ['Off', result.off.filter((row) => !isWebhookRow(row))],
  ['Fired by webhook - no clock, so nothing to be off from', offWebhook]
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
const KNOWLEDGE = {
  sales: 'agents/sales/knowledge/offer-sheet.md',
  'customer-service': 'agents/customer-service/knowledge/faq.md'
}
const readOrNull = async (path) => readFile(path, 'utf8').catch(() => null)
const offAgents = []
for (const [slug, path] of Object.entries(KNOWLEDGE)) {
  if (notInUse(await readOrNull(path))) offAgents.push(slug)
}
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
  console.log(offWebhook.length
    ? '\nEvery job is either armed, fired by webhook, or off with a reason somebody wrote down.'
    : '\nEvery job is either armed, or off with a reason somebody wrote down.')
} else {
  console.log('\nEverything above is what your FILES claim. Run /routines and commit the result\n' +
    'before you believe any of it.')
}
