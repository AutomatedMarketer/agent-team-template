import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveTask,
  summarize,
  validateLedger,
  classify,
  MAX_HOURS_IN_A_WEEK
} from '../scripts/lib/ledger.mjs'

/* The ledger is the one file the whole team gets derived from. Every rule below is a rule that
   stops a wrong system being built out of a wrong number, so each one has a test. */

const chasing = {
  task: 'Chasing invoices',
  words: 'I lose half of Friday chasing people who owe me',
  who: 'me',
  times_per_week: 1,
  minutes_each: 180,
  confirmed: 'twice',
  hands_off: 'I approve every chase before it sends'
}

const outreach = {
  task: 'Follow-up emails',
  words: 'Every prospect email takes me the best part of an hour',
  who: 'me',
  times_per_week: 5,
  minutes_each: 45,
  confirmed: 'twice',
  hands_off: 'They sit in drafts and I send them'
}

const ledgerOf = (tasks, extra = {}) => ({
  owner_type: 'business',
  hourly_value: 150,
  tasks,
  ...extra
})

/* ---------- deriveTask ------------------------------------------------------------------- */

test('hours per week is frequency times duration, not duration alone', () => {
  assert.equal(deriveTask(chasing, 150).hoursPerWeek, 3)
  assert.equal(deriveTask(outreach, 150).hoursPerWeek, 3.75)
})

test('cost per week is hours times the rate the owner gave', () => {
  assert.equal(deriveTask(chasing, 150).costPerWeek, 450)
  assert.equal(deriveTask(outreach, 150).costPerWeek, 562.5)
})

test('with no rate, hours are still counted and cost is null rather than zero', () => {
  // The employee case. Zero would read as "this costs nothing", which is a different claim
  // and a false one. Absent means absent.
  const derived = deriveTask(chasing, null)
  assert.equal(derived.hoursPerWeek, 3)
  assert.equal(derived.costPerWeek, null)
})

/* ---------- classify: rules 4 and 5 --------------------------------------------------------
   Rule 4 - twice, or it is not a pattern.
   Rule 5 - decision-readiness: if nobody can act on the output, it does not get built. */

test('a task named twice with a named handoff is a candidate', () => {
  assert.equal(classify(chasing), 'candidate')
})

test('a task named only once is a note, never a candidate', () => {
  assert.equal(classify({ ...chasing, confirmed: 'once' }), 'note')
})

test('a task with no answer about who acts on the output is parked, not built', () => {
  assert.equal(classify({ ...chasing, hands_off: '' }), 'parked')
  assert.equal(classify({ ...chasing, hands_off: undefined }), 'parked')
})

/* ---------- summarize ---------------------------------------------------------------------- */

test('totals add up across tasks', () => {
  const summary = summarize(ledgerOf([chasing, outreach]))
  assert.equal(summary.hoursPerWeek, 6.75)
  assert.equal(summary.costPerWeek, 1012.5)
})

test('only candidates are offered for building; notes and parked are kept and counted', () => {
  const summary = summarize(ledgerOf([
    chasing,
    { ...outreach, confirmed: 'once' },
    { ...outreach, task: 'Weekly report', hands_off: '' }
  ]))
  assert.deepEqual(summary.candidates.map((task) => task.task), ['Chasing invoices'])
  assert.deepEqual(summary.notes.map((task) => task.task), ['Follow-up emails'])
  assert.deepEqual(summary.parked.map((task) => task.task), ['Weekly report'])
})

test('an unpriced ledger reports hours and says so, instead of inventing a rate', () => {
  const summary = summarize(ledgerOf([chasing], { hourly_value: null }))
  assert.equal(summary.hoursPerWeek, 3)
  assert.equal(summary.costPerWeek, null)
  assert.equal(summary.unpriced, true)
})

test('an empty ledger totals zero rather than throwing', () => {
  const summary = summarize(ledgerOf([]))
  assert.equal(summary.hoursPerWeek, 0)
  assert.deepEqual(summary.candidates, [])
})

/* ---------- validateLedger ------------------------------------------------------------------
   Same contract as validateSelection in tiles.mjs: human-readable problems, empty means sound. */

test('a sound ledger has no problems', () => {
  assert.deepEqual(validateLedger(ledgerOf([chasing, outreach])), [])
})

test('a task with no verbatim quote is refused - rule 2, no citation no proposal', () => {
  const problems = validateLedger(ledgerOf([{ ...chasing, words: '' }]))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /own words/i)
})

test('a short quote is accepted - we can check that words are absent, never that they are true', () => {
  assert.deepEqual(validateLedger(ledgerOf([{ ...chasing, words: 'x' }])), [])
})

test('an unfilled template is refused rather than costed', () => {
  const problems = validateLedger(ledgerOf([{ ...chasing, words: '<!-- fill: their exact words -->' }]))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /not been filled in/i)
})

test('owner_type must be one of the three', () => {
  const problems = validateLedger(ledgerOf([chasing], { owner_type: 'freelancer' }))
  assert.match(problems.join(' '), /owner_type/)
})

test('a missing number is a problem, because a task without one cannot be ranked', () => {
  assert.match(validateLedger(ledgerOf([{ ...chasing, minutes_each: undefined }])).join(' '), /minutes_each/)
  assert.match(validateLedger(ledgerOf([{ ...chasing, times_per_week: undefined }])).join(' '), /times_per_week/)
})

test('zero and negative durations are refused', () => {
  assert.match(validateLedger(ledgerOf([{ ...chasing, minutes_each: 0 }])).join(' '), /minutes_each/)
  assert.match(validateLedger(ledgerOf([{ ...chasing, times_per_week: -2 }])).join(' '), /times_per_week/)
})

test('a rate that is not a positive number is refused', () => {
  assert.match(validateLedger(ledgerOf([chasing], { hourly_value: 'lots' })).join(' '), /hourly_value/)
  assert.match(validateLedger(ledgerOf([chasing], { hourly_value: -5 })).join(' '), /hourly_value/)
})

test('no rate at all is fine - that is the employee case, not an error', () => {
  assert.deepEqual(validateLedger(ledgerOf([chasing], { hourly_value: null })), [])
})

test('confirmed must be once or twice, so rule 4 cannot be fudged', () => {
  assert.match(validateLedger(ledgerOf([{ ...chasing, confirmed: 'maybe' }])).join(' '), /confirmed/)
})

test('a week that does not fit inside a week is caught', () => {
  // 7 days x 24 hours = 168. A ledger claiming more has a units mistake in it, and costing it
  // would produce a confident, wrong, very large number.
  const impossible = { ...chasing, times_per_week: 7, minutes_each: 24 * 60 + 1 }
  assert.match(validateLedger(ledgerOf([impossible])).join(' '), new RegExp(String(MAX_HOURS_IN_A_WEEK)))
})

test('tasks must be a list, and saying so beats throwing', () => {
  assert.match(validateLedger({ owner_type: 'business', tasks: 'chasing invoices' }).join(' '), /list/)
})

test('every problem names the task it came from, so a long ledger is fixable', () => {
  const problems = validateLedger(ledgerOf([chasing, { ...outreach, minutes_each: 0 }]))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /Follow-up emails/)
})

/* ---------- the example file ----------------------------------------------------------------
   The shipped example is what a student reads to learn the shape. If it stops parsing with the
   repo's own parser, or stops validating, the lesson teaches something that does not work. */

test('the shipped example parses with the repo parser and validates clean', async () => {
  const { readFile } = await import('node:fs/promises')
  const { parseSimpleYaml } = await import('../scripts/lib/yaml-lite.mjs')
  const url = new URL('../ledger.example.yml', import.meta.url)

  const example = parseSimpleYaml(await readFile(url, 'utf8'))

  assert.deepEqual(validateLedger(example), [])
  assert.equal(example.owner_type, 'business')
  assert.ok(Array.isArray(example.tasks) && example.tasks.length >= 3)

  // Every task keeps its quote through the parse. A quote lost to the parser is rule 2 broken
  // silently, which is the worst way for it to break.
  for (const task of example.tasks) {
    assert.equal(typeof task.words, 'string')
    assert.ok(task.words.trim().length > 0, `${task.task} lost its quote in parsing`)
  }

  // The example is deliberately built to demonstrate all three outcomes, because a student who
  // only ever sees candidates will not believe parked and note are real.
  const summary = summarize(example)
  assert.ok(summary.candidates.length > 0, 'the example should show at least one candidate')
  assert.ok(summary.parked.length > 0, 'the example should show what parked looks like')
  assert.ok(summary.notes.length > 0, 'the example should show what a note looks like')
  assert.ok(summary.hoursPerWeek > 0 && summary.costPerWeek > 0)
})

test('a task with no name is refused - an unnameable proposal cannot be approved', () => {
  const problems = validateLedger(ledgerOf([{ ...chasing, task: '' }]))
  assert.ok(problems.length > 0)
  assert.ok(problems.some((problem) => /needs a name/.test(problem)))
})

test('a whitespace-only task name is refused too', () => {
  const problems = validateLedger(ledgerOf([{ ...chasing, task: '   ' }]))
  assert.ok(problems.some((problem) => /needs a name/.test(problem)))
})
