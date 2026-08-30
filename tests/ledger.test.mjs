import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, rm, mkdtemp } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
import assert from 'node:assert/strict'
import {
  deriveTask,
  summarize,
  validateLedger,
  classify,
  MAX_HOURS_IN_A_WEEK,
  beginsWithNegative
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

/* parked_because was added so a considered "nobody, and here is why" had somewhere to live.
   Nothing bound it to the parked bucket, so a row could name who acts on the output AND say
   why nobody does - and print its park reason under "Ready". */
test('a row cannot both name a handover and say why it is parked', () => {
  const contradictory = { ...chasing, hands_off: 'Priya reads it', parked_because: 'nobody acts on it' }
  const problems = validateLedger(ledgerOf([contradictory]))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /it cannot be both/i)
})

test('parked_because alone, with no handover, is sound', () => {
  const parked = { ...chasing, hands_off: '', parked_because: 'the upload IS the submission' }
  assert.deepEqual(validateLedger(ledgerOf([parked])), [])
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

test('two tasks with the same name are refused - the numbers get crossed otherwise', () => {
  const problems = validateLedger(ledgerOf([chasing, { ...chasing, minutes_each: 600 }]))
  assert.ok(problems.some((problem) => /named 2 times/.test(problem)))
})

/* classify() can only see that hands_off is non-empty, so an honest "Nobody." lands in candidate
   and becomes buildable - the condition Rule 5 exists to catch.

   The claim under test is deliberately small: the answer BEGINS WITH A NEGATIVE. An earlier
   version tried to decide whether an answer MEANT nobody, with exception words that suppressed
   the flag, and made both kinds of error - "Nobody. It is my core work, but I would love it
   faster" cleared because `but` appeared anywhere, "None of my staff - my VA handles it" flagged
   though it names somebody. Nothing separates "No one acts on it" from "No one, my assistant
   does" without knowing which of those is a person.

   Every alternative in the pattern has a case here, so none can be deleted while the suite is
   green - the previous version had five of seven exception words and two of five negatives inert
   under mutation. */
test('an answer beginning with a negative is flagged, whatever follows it', () => {
  for (const answer of [
    'Nobody.', 'nobody yet', 'No one acts on it.', 'No-one.', 'none', 'Nothing automated.',
    'N/A', 'Not me - it is the work itself.',
    // the six that the exception list used to clear, every one of them meaning nobody
    'Nobody, unless you count the filing cabinet.',
    'Nobody, besides the shredder.',
    'Nobody. It is my core work, but I would love it to be faster.',
    'Nobody. I do it myself and nothing else depends on it.',
    'Nobody acts on it - it is the work itself, and nothing else uses it.',
    'No one. Everything else in the week waits on it.',
    // and the five it used to flag, which still flag - correctly, under this claim
    'None of my staff - my VA handles it.',
    'Nothing automated; Sarah reviews it and sends it.'
  ]) {
    assert.equal(beginsWithNegative(answer), true, `"${answer}" begins with a negative`)
  }

  for (const answer of [
    'I read the draft and send it.',
    'My bookkeeper reviews it and files it.',
    'Sarah acts on it; nobody else needs to.',
    'The ops team picks it up, and none of it waits on me.',
    ''
  ]) {
    assert.equal(beginsWithNegative(answer), false, `"${answer}" does not begin with a negative`)
  }
  assert.equal(beginsWithNegative(undefined), false, 'a missing answer is already parked by classify')
})

test('summarize surfaces ready rows whose answer begins with a negative', () => {
  const ledger = {
    owner_type: 'business',
    tasks: [
      { task: 'Real work', words: 'x', times_per_week: 1, minutes_each: 60,
        confirmed: 'twice', hands_off: 'Nobody. This is the work itself.' },
      { task: 'Handed over', words: 'y', times_per_week: 1, minutes_each: 60,
        confirmed: 'twice', hands_off: 'I read the draft and send it.' }
    ]
  }
  const summary = summarize(ledger)
  assert.equal(summary.candidates.length, 2, 'both stay candidates - this flags, it does not reclassify')
  assert.deepEqual(summary.readyStartingWithNo.map((task) => task.task), ['Real work'])
})

/* A task is parked by an EMPTY hands_off, so the reason for parking had nowhere to live - the
   example file resorted to a YAML comment, which nothing reads. An employee persona hit this on
   its first task: "nobody acts on the output" was the true answer, the flag correctly refused to
   let it count as Ready, and the only way to act on the flag was to delete the answer.

   Lesson 17 already makes the argument for the other file: an unexplained silence is
   indistinguishable from a mistake, and you re-litigate a decision you already made. Optional -
   a parked task without one still parks. */
test('a parked task can say why, and saying why does not unpark it', () => {
  const parked = {
    task: 'Portal uploads',
    words: 'four portals, four ways to fail',
    times_per_week: 3,
    minutes_each: 25,
    confirmed: 'twice',
    parked_because: 'There is no output to hand off - the upload IS the submission.'
  }
  const summary = summarize(ledgerOf([parked]))
  assert.equal(summary.parked.length, 1, 'an absent hands_off still parks it')
  assert.equal(summary.candidates.length, 0)
  assert.equal(summary.parked[0].parked_because, parked.parked_because)
  assert.deepEqual(validateLedger(ledgerOf([parked])), [], 'the field must not be rejected')
})

/* The USER-VISIBLE half of parked_because had no test: the data model was proven, the printed
   line was not, and a verifier deleted the console.log with the suite still green.

   Two things this test must not do, both learned the hard way:

   1. It must not write a ledger.yml into the repo. The first version did, and skipped itself
      whenever one already existed - which is every student repo past Lesson 15, including the
      one this course tells them to build. A skipped test is not a passing one and
      readme.test.mjs asserts the pass count, so it reproduced the Lesson 15 defect in a worse
      form: it fired on the repos that had done the work. The fixture lives in a temp dir and
      the real binary is pointed at it.

   2. It must not just grep stdout for the reason. Moving the print out of the per-task loop and
      dumping every reason at the top of the report passed that check while the parked row
      displayed with no reason - the exact defect. The reason has to be ON the line under its
      task. */
test('the parked reason is printed under the task it belongs to', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-parked-'))
  try {
    await writeFile(join(dir, 'ledger.yml'), [
      'owner_type: job',
      'tasks:',
      '  - task: Chasing subcontractor quotes',
      '    words: "the same six subbies, every morning"',
      '    who: me',
      '    times_per_week: 5',
      '    minutes_each: 45',
      '    confirmed: twice',
      '    hands_off: "Priya the estimator - she is the one waiting."',
      '  - task: Portal uploads',
      '    words: "four portals, four ways to fail"',
      '    who: me',
      '    times_per_week: 3',
      '    minutes_each: 25',
      '    confirmed: twice',
      '    parked_because: "ZZ-MARKER the upload IS the submission"',
      ''
    ].join('\n'))

    const { stdout } = await run(process.execPath, ['scripts/check-ledger.mjs', dir], { cwd: repoRoot })
    const lines = stdout.split('\n').map((line) => line.trimEnd())

    const parkedHeading = lines.findIndex((line) => line.startsWith('Parked:'))
    assert.ok(parkedHeading !== -1, 'the task with no handover should be parked')

    const taskRow = lines.findIndex((line, i) => i > parkedHeading && line.includes('Portal uploads'))
    assert.ok(taskRow !== -1, 'the parked task should be listed under Parked')

    assert.match(
      lines[taskRow + 1] ?? '',
      /ZZ-MARKER the upload IS the submission/,
      'the reason must sit directly under its own task row - printing it anywhere else leaves the parked row bare, which is the defect'
    )

    // and the task that WAS handed off must not acquire a reason it never had
    const readyRow = lines.findIndex((line) => line.includes('Chasing subcontractor quotes'))
    assert.doesNotMatch(lines[readyRow + 1] ?? '', /ZZ-MARKER/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
