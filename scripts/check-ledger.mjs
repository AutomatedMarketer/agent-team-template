// Reads ledger.yml, says whether it is sound, and prints the week back as a number.
//
// Run it: npm run check:ledger
//
// This exists as a script rather than a one-liner in a lesson because students run it on
// Windows as often as Mac, and a node -e incantation with nested quotes does not survive
// PowerShell. It is also the step that catches a units mistake before it gets costed.

import { loadLedger, validateLedger, summarize, deriveTask } from './lib/ledger.mjs'

const hours = (value) => `${value.toFixed(1)} hours a week`
const money = (value) => `$${Math.round(value).toLocaleString('en-US')} a week`

let ledger
try {
  ledger = await loadLedger()
} catch (error) {
  if (error.code === 'ENOENT') {
    console.error('No ledger.yml yet. Ask for one: /ledger')
    process.exit(1)
  }
  throw error
}

const problems = validateLedger(ledger)
if (problems.length) {
  console.error(`Your ledger has ${problems.length} thing${problems.length === 1 ? '' : 's'} to fix:\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nNothing is derived from a ledger until these are fixed.')
  process.exit(1)
}

const summary = summarize(ledger)

console.log(`Your week: ${hours(summary.hoursPerWeek)}${summary.unpriced ? '' : ` - ${money(summary.costPerWeek)}`}`)
if (summary.unpriced) {
  console.log('No rate recorded, so this is counted in hours only.')
}
console.log('')
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`

console.log(`  ${summary.candidates.length} ready to hand over`)
console.log(`  ${summary.parked.length} parked - nobody named who acts on the output yet`)
console.log(`  ${plural(summary.notes.length, 'note')} - mentioned once, not yet a pattern`)

// The list is printed, not just counted, because the owner has to be able to disagree with a
// specific line. A total they cannot see the parts of is a total they cannot correct.
for (const [label, tasks] of [
  ['Ready', summary.candidates],
  ['Parked', summary.parked],
  ['Notes', summary.notes]
]) {
  if (!tasks.length) continue
  console.log(`\n${label}:`)
  for (const task of tasks) {
    const { hoursPerWeek } = deriveTask(task, null)
    console.log(`  ${task.task} - ${hoursPerWeek.toFixed(1)}h`)
    // A parked task is parked by an EMPTY hands_off, so the reason for parking it had nowhere
    // to live - the example file resorted to a YAML comment, which nothing reads. Lesson 17
    // makes the argument for the other file: "an unexplained silence is indistinguishable from
    // a mistake, and you will re-litigate a decision you already made." Same problem, same fix.
    const because = typeof task?.parked_because === 'string' ? task.parked_because.trim() : ''
    if (because) console.log(`      ${because}`)
  }
}

if (summary.readyStartingWithNo.length) {
  console.log('\nReady, but the answer starts with a negative - read these back:')
  for (const task of summary.readyStartingWithNo) {
    console.log(`  ${task.task} - "${String(task.hands_off).trim()}"`)
  }
  console.log('  If nobody really acts on it, the rule is that it gets parked. If somebody does,')
  console.log('  say who - the wording will carry that better than a bucket does.')
}

console.log('\nIs that right? If the number is wrong, the file is wrong - change it and re-run.')
