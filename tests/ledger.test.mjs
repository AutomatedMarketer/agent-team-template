import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, rm, mkdtemp } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync, existsSync } from 'node:fs'
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
  beginsWithNegative,
  currencyOf,
  formatMoney
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

/* ---------- currency ---------------------------------------------------------------------- */

// The board printed "$" for every student in every country and never asked. The fix is a field
// the interview asks for once, and one formatter everything prints through.

test('a currency that is not a short code is refused, and the problem names the field', () => {
  assert.match(validateLedger(ledgerOf([chasing], { currency: 'pounds sterling' })).join(' '), /currency/)
  assert.match(validateLedger(ledgerOf([chasing], { currency: 42 })).join(' '), /currency/)
  assert.match(validateLedger(ledgerOf([chasing], { currency: '' })).join(' '), /currency/)
})

test('no currency is allowed even beside a rate - every ledger written before the field existed is in that state', () => {
  assert.deepEqual(validateLedger(ledgerOf([chasing])), [])
  assert.deepEqual(validateLedger(ledgerOf([chasing], { currency: null })), [])
})

test('a currency is carried out of the summary as written, trimmed, and null when absent', () => {
  assert.equal(summarize(ledgerOf([chasing], { currency: ' GBP ' })).currency, 'GBP')
  assert.equal(summarize(ledgerOf([chasing], { currency: 'R$' })).currency, 'R$')
  assert.equal(summarize(ledgerOf([chasing])).currency, null)
  assert.equal(currencyOf({ currency: 'pounds sterling' }), null)
})

test('money is printed with the code after the number, and bare - never with a guessed symbol - when there is none', () => {
  assert.equal(formatMoney(2437.5, 'USD'), '2,438 USD a week')
  assert.equal(formatMoney(950, 'GBP'), '950 GBP a week')
  assert.equal(formatMoney(2437.5, null), '2,438 a week')
  assert.ok(!formatMoney(100, null).includes('$'), 'a missing currency must not fall back to a dollar sign')
})

test('the shipped example ledger names its currency, so the lesson sample shows the field in use', () => {
  const example = readFileSync(join(repoRoot, 'ledger.example.yml'), 'utf8')
  assert.match(example, /^currency: [A-Z]{3}$/m)
})

/* tests/fixtures/currency-parity.json is the shared contract with agent-cockpit - the same bytes in
   both repos, run by both sides. The board mirrors currencyOf() and formatMoney() by hand, because
   there is no import path between a student's repo and a deployed web app. Change one
   implementation alone and that side fails here. The template's formatter says "a week" itself;
   the fixture holds the number-and-code, which is the part the two sides have to agree on. */

const currencyFixturePath = join(repoRoot, 'tests', 'fixtures', 'currency-parity.json')
const currencyFixture = JSON.parse(readFileSync(currencyFixturePath, 'utf8'))

for (const testCase of currencyFixture.codes) {
  test(`currency parity, code: ${testCase.label}`, () => {
    assert.equal(currencyOf(testCase.parsed), testCase.currency)
  })
}

for (const testCase of currencyFixture.money) {
  test(`currency parity, money: ${testCase.label}`, () => {
    assert.equal(formatMoney(testCase.value, testCase.currency), `${testCase.text} a week`)
  })
}

test('the two repos hold the same currency contract, byte for byte', (t) => {
  const sibling = join(repoRoot, '..', 'agent-cockpit', 'tests', 'fixtures', 'currency-parity.json')
  if (!existsSync(sibling)) {
    t.skip('agent-cockpit is not checked out beside this repo')
    return
  }
  assert.equal(
    readFileSync(sibling, 'utf8'),
    readFileSync(currencyFixturePath, 'utf8'),
    'the shared contract has been edited on one side only - that is the drift, one level up'
  )
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

   Three things this test must not do, each learned by shipping it wrong:

   1. It must not write a ledger.yml into the repo. The first version did, and skipped itself
      whenever one already existed - which is every student repo past Lesson 15, including the
      one this course tells them to build. A skipped test is not a passing one and
      readme.test.mjs asserts the pass count, so it reproduced the Lesson 15 defect in a worse
      form: it fired on the repos that had done the work. The fixture lives in a temp dir and
      the real binary is pointed at it.

   2. It must not just grep stdout for the reason. Moving the print out of the per-task loop and
      dumping every reason at the top passed that check while the parked row displayed bare -
      the exact defect. The reason has to be ON the line under its task.

   3. The fixture must cover every bucket the printer has. Three parked tasks - two with
      distinct reasons, one with none - plus a note, and a Ready row whose answer begins with
      a negative so the readyStartingWithNo flag block (a SECOND per-task print loop) is
      reached. The only branch left unexercised is the empty-bucket `continue`, which prints
      nothing by construction.
      With one, "the reason under this row" and "the first
      reason in this bucket" are indistinguishable, and a mutation printing one task's reason
      under every parked row passed green while silently misattributing it and dropping the
      other. And with every parked row carrying a reason, "print mine" and "print the last
      one I saw" are the same program - a sticky carry-forward passed until a reasonless
      row was added. The discriminating case is the one the fixture keeps omitting. */
test('each parked task is printed with its own reason, not the bucket\'s', async () => {
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
      '    hands_off: "Nobody - I just chase them until they answer."',
      '  - task: Portal uploads',
      '    words: "four portals, four ways to fail"',
      '    who: me',
      '    times_per_week: 3',
      '    minutes_each: 25',
      '    confirmed: twice',
      '    parked_because: "MARKER-ONE the upload IS the submission"',
      '  - task: Filing the site photos',
      '    words: "they sit on my phone until someone asks"',
      '    who: me',
      '    times_per_week: 2',
      '    minutes_each: 20',
      '    confirmed: twice',
      '    parked_because: "MARKER-TWO nobody has ever opened the folder"',
      '  - task: Tidying the shared drive',
      '    words: "it just gets messy"',
      '    who: me',
      '    times_per_week: 1',
      '    minutes_each: 30',
      '    confirmed: twice',
      '  - task: Reading the trade press',
      '    words: "I skim it when a job is quiet"',
      '    who: me',
      '    times_per_week: 1',
      '    minutes_each: 15',
      '    confirmed: once',
      ''
    ].join('\n'))

    const { stdout } = await run(process.execPath, ['scripts/check-ledger.mjs', dir], { cwd: repoRoot })
    const lines = stdout.split('\n').map((line) => line.trimEnd())

    const parkedHeading = lines.findIndex((line) => line.startsWith('Parked:'))
    assert.ok(parkedHeading !== -1, 'the tasks with no handover should be parked')

    const rowFor = (task) => {
      const i = lines.findIndex((line, n) => n > parkedHeading && line.includes(task))
      assert.ok(i !== -1, `${task} should be listed under Parked`)
      return i
    }

    // each row carries ITS OWN reason on the line beneath it
    assert.match(lines[rowFor('Portal uploads') + 1] ?? '', /MARKER-ONE/)
    assert.match(lines[rowFor('Filing the site photos') + 1] ?? '', /MARKER-TWO/)

    // and not the other one's - printing the bucket's first reason under every row is the
    // mutation that passed a single-task fixture
    assert.doesNotMatch(lines[rowFor('Portal uploads') + 1] ?? '', /MARKER-TWO/)
    assert.doesNotMatch(lines[rowFor('Filing the site photos') + 1] ?? '', /MARKER-ONE/)

    // A parked task with NO reason must not wear someone else's. This is the case that makes
    // the fixture discriminating: with every parked row carrying a reason, "print mine" and
    // "print the last one I saw" are the same program, and a sticky carry-forward passes. The
    // field is optional by design, so a mix of reasoned and unreasoned parked rows is the
    // normal ledger - and it was the one arrangement the fixture did not contain.
    assert.doesNotMatch(lines[rowFor('Tidying the shared drive') + 1] ?? '', /MARKER-/)

    // The printer has THREE buckets and the fixture exercised two. A note is not parked, so
    // it has no reason of its own - and a leak into Notes is the exact twin of the Ready leak
    // guarded below, which I closed while leaving its sibling open. With Ready, Parked
    // (own / another's / none) and Notes all covered, the print loop has no untested branch
    // left for a mutation to hide in.
    const noteRow = lines.findIndex((line) => line.includes('Reading the trade press'))
    assert.ok(noteRow !== -1, 'the once-only task should be listed as a note')
    assert.doesNotMatch(lines[noteRow + 1] ?? '', /MARKER-/)

    // a Ready task must not acquire a reason it never had
    const readyRow = lines.findIndex((line) => line.includes('Chasing subcontractor quotes'))
    assert.doesNotMatch(lines[readyRow + 1] ?? '', /MARKER-/)

    // The bucket loop is not the only per-task print loop. readyStartingWithNo has its own,
    // and it was unreachable from this fixture while every Ready answer named somebody - so
    // "every branch is covered" was true of the buckets and false of the file. This row's
    // answer begins with a negative, which fires the flag block without parking the task
    // (classify() parks on an EMPTY hands_off, not a negative one), and a park reason must
    // not leak into it either. It is the state Lesson 15's flag exists for, and the state
    // the employee persona actually reached.
    const flagged = lines.findIndex((line) => line.startsWith('Ready, but the answer starts with'))
    assert.ok(flagged !== -1, 'a Ready answer beginning with a negative should be flagged')
    const flaggedRow = lines.findIndex((line, n) => n > flagged && line.includes('Chasing subcontractor'))
    assert.ok(flaggedRow !== -1, 'the flagged task should be named in the flag block')
    assert.doesNotMatch(lines[flaggedRow + 1] ?? '', /MARKER-/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* 15_YOUR_LEDGER.md says there are "two rules if you do it this way, both enforced in code", and
   names `hours` as one of them - "a number you typed straight in is a number nobody derived".
   Only one of the two was enforced. A row carrying `hours: 20` validated clean and the total
   stayed at the 3.3 hours derived from times_per_week x minutes_each, so the reader saw a number
   that did not include what they typed and was told nothing about why. */
const soundTask = {
  task: 'Sorting the inbox',
  words: 'The inbox eats my morning before I get to anything real',
  who: 'me',
  times_per_week: 5,
  minutes_each: 40,
  confirmed: 'twice',
  hands_off: 'Replies wait in my drafts folder. I read each one and send it.'
}
const ledgerWith = (task, extra = {}) => ({ owner_type: 'business', hourly_value: 150, tasks: [task], ...extra })

test('a number the file works out cannot be typed into a row', () => {
  for (const field of ['hours', 'hours_per_week', 'cost', 'cost_per_week', 'value']) {
    const problems = validateLedger(ledgerWith({ ...soundTask, [field]: 20 }))
    assert.equal(problems.length, 1, `${field} was accepted: ${JSON.stringify(problems)}`)
    assert.match(problems[0], /worked out from/, `${field} must say where the number really comes from`)
    assert.match(problems[0], /never typed/, `${field} must say it is never typed`)
  }
})

test('a field nothing reads is refused rather than silently dropped', () => {
  for (const field of ['wibble', 'minutes_eachh', 'notes', 'priority']) {
    const problems = validateLedger(ledgerWith({ ...soundTask, [field]: 'x' }))
    assert.ok(
      problems.some((problem) => problem.includes(`\`${field}\``)),
      `${field} was accepted in silence: ${JSON.stringify(problems)}`
    )
  }
})

test('an unknown field at the top of the file is refused too', () => {
  // This used `currency` as its example of a field the file does not have. It has one now.
  const problems = validateLedger(ledgerWith(soundTask, { timezone: 'Europe/London' }))
  assert.ok(problems.some((problem) => problem.includes('`timezone`')), JSON.stringify(problems))
})

// The other half of the bargain: refusing unknown fields must not refuse the template's own.
test('the ledger the repo ships still validates clean', async () => {
  const { readFile } = await import('node:fs/promises')
  const { parseSimpleYaml } = await import('../scripts/lib/yaml-lite.mjs')
  const { fromRoot } = await import('./helpers/repo.mjs')
  const example = parseSimpleYaml(await readFile(fromRoot('ledger.example.yml'), 'utf8'))
  assert.deepEqual(validateLedger(example), [], 'the shipped example must not trip the new check')
})

/* The field list and the template have to agree, or the check refuses a row the example told the
   student to copy. Pinning it here means adding a field to one without the other fails loudly. */
test('the known-field list covers every field the shipped example uses', async () => {
  const { readFile } = await import('node:fs/promises')
  const { parseSimpleYaml } = await import('../scripts/lib/yaml-lite.mjs')
  const { fromRoot } = await import('./helpers/repo.mjs')
  const { TASK_FIELDS, LEDGER_FIELDS } = await import('../scripts/lib/ledger.mjs')
  const example = parseSimpleYaml(await readFile(fromRoot('ledger.example.yml'), 'utf8'))
  for (const field of new Set(example.tasks.flatMap(Object.keys))) {
    assert.ok(TASK_FIELDS.includes(field), `ledger.example.yml uses "${field}" and TASK_FIELDS does not list it`)
  }
  for (const field of Object.keys(example)) {
    assert.ok(LEDGER_FIELDS.includes(field), `ledger.example.yml uses "${field}" and LEDGER_FIELDS does not list it`)
  }
})

/* ---------- which rows are parked must not drift from the board -------------------------------

   classify() here and isParked() in agent-cockpit's api/state.js decide the same thing twice,
   mirrored by hand because there is no import path between a student's repo and a deployed web
   app. This is the third such mirror in this pair of repos, and both of the other two - arming and
   the switched-off rule - exist as fixtures BECAUSE the two sides had already drifted.

   They drifted here too: the board's first version keyed on `parked_because` having text, which is
   narrower than this rule. The format lets an owner park a row without typing a reason and this
   still calls it parked, so those rows showed on the board as live work.

   tests/fixtures/parked-parity.json is the shared contract - the same bytes in both repos. */

const parkedFixtureUrl = new URL('./fixtures/parked-parity.json', import.meta.url)
const parkedFixture = JSON.parse(readFileSync(parkedFixtureUrl, 'utf8'))

for (const testCase of parkedFixture.cases) {
  test(`parked parity: ${testCase.label}`, () => {
    assert.equal(classify(testCase.row) === 'parked', testCase.parked)
  })
}

test('the two repos hold the same parked contract, byte for byte', (t) => {
  const sibling = fileURLToPath(
    new URL('../../agent-cockpit/tests/fixtures/parked-parity.json', import.meta.url)
  )
  if (!existsSync(sibling)) {
    t.skip('agent-cockpit is not checked out beside this repo')
    return
  }
  assert.equal(
    readFileSync(sibling, 'utf8'),
    readFileSync(parkedFixtureUrl, 'utf8'),
    'the shared contract has been edited on one side only - that is the drift, one level up'
  )
})
