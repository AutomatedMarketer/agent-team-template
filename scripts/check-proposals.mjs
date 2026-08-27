// Reads proposals.yml and says whether the team it proposes is actually backed by your ledger.
//
// Run it: npm run check:proposals
//
// proposals.yml is the one file here written by a model. /match reads the shortlists the engine
// produced, reads the descriptions, and chooses — because word-counting cannot tell a customer's
// review from a sales-pipeline review, and a person can. This is the check on that judgment.
//
// It re-derives everything from ledger.yml and the catalogue and compares. The skill cannot widen
// its own remit: it may only answer tasks you named twice, only pick from what the engine offered,
// only quote your words character for character, and only use the number your ledger produces.

import { loadLedger } from './lib/ledger.mjs'
import { loadCatalogue } from './lib/catalogue.mjs'
import { loadProposals, validateProposals, summarizeProposals } from './lib/proposals.mjs'

const hours = (value) => `${value.toFixed(1)} hours a week`
const money = (value) => `$${Math.round(value).toLocaleString('en-US')} a week`

async function loadOrExplain(load, missing) {
  try {
    return await load()
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(missing)
      process.exit(1)
    }
    throw error
  }
}

const ledger = await loadOrExplain(loadLedger, 'No ledger.yml yet. Ask for one: /ledger')
const written = await loadOrExplain(loadProposals, 'No proposals.yml yet. Ask for one: /match')
const catalogue = await loadCatalogue()

const problems = validateProposals(written, ledger, catalogue)
if (problems.length) {
  console.error(`These proposals do not hold up (${problems.length}):\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nNothing gets switched on from a proposal that cannot be traced back to your own words.')
  process.exit(1)
}

const summary = summarizeProposals(written, ledger, catalogue)

console.log(
  `${summary.proposed} proposal${summary.proposed === 1 ? '' : 's'}, covering ${hours(summary.hoursPerWeek)}` +
    (summary.unpriced ? '' : ` - ${money(summary.costPerWeek)}`)
)
if (summary.unpriced) {
  console.log('No rate recorded, so this is counted in hours only.')
}
console.log('')

// Printed, not just counted. An owner has to be able to disagree with a specific line, and every
// line here carries the three things that let them check it without trusting anybody.
for (const row of written.proposals ?? []) {
  console.log(`  ${row.task}`)
  console.log(`      -> ${row.item}`)
  console.log(`      you said: "${row.words ?? ''}"`)
  console.log(`      that is:  ${row.number ?? ''}`)
  if (row.why) console.log(`      why this one: ${row.why}`)
  console.log('')
}

if (summary.gaps) {
  console.log(`${summary.gaps} thing${summary.gaps === 1 ? '' : 's'} nothing on the team does yet:`)
  for (const gap of written.gaps ?? []) {
    console.log(`  - ${gap.task}`)
    if (gap.question) console.log(`      ${gap.question}`)
  }
  console.log('')
}
if (summary.parked) console.log(`${summary.parked} parked - nobody named who acts on the output yet`)
if (summary.notes) console.log(`${summary.notes} mentioned once - not a pattern yet`)

console.log('\nEvery line above quotes you, cites your number, and names something that already exists.')
console.log('Disagree with any of them and the answer is to change ledger.yml, not this file.')
