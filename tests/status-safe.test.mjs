import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkUsage,
  checkLine,
  checkComputerLabel,
  assertSafeUsage,
  checkAgainst,
  GateError
} from '../scripts/lib/status/safe.mjs'
import { RECEIPT_SHAPE, FINAL_SHAPE } from '../scripts/lib/status/schema.mjs'

/* The gate is the whole reason this collector is allowed to run unattended. It reads files that
   hold sign-in tokens, account emails and a person's folder names, and it writes into a repo that
   gets pushed. Every rule below has its own failing case, so loosening one rule shows up here
   as one red test, not as a quiet leak three weeks later. */

// Fake identity for a machine that does not exist. Real identities never appear in this suite.
const identity = { username: 'fakeperson', home: '/Users/fakeperson', hostname: 'fake-host-77' }

function validDoc() {
  return {
    schema: 'agent-status/usage/v1',
    takenAt: '2026-10-07T20:00:00Z',
    computer: 'Mac Mini',
    claude: {
      plan: { status: 'found', name: 'Max 20x' },
      limits: {
        status: 'found',
        source: 'unofficial-live',
        readAt: '2026-10-07T20:00:00Z',
        windows: [
          { kind: 'five_hour', usedPercent: 18, resetsAt: '2026-10-07T21:40:00Z' },
          { kind: 'weekly_all', usedPercent: 49, resetsAt: '2026-10-09T22:00:00Z' },
          { kind: 'weekly_model', model: 'Fable', usedPercent: 2, resetsAt: '2026-10-09T22:00:00Z' }
        ]
      },
      activity: {
        status: 'found',
        estimate: true,
        timezone: 'America/New_York',
        days: [
          {
            day: '2026-10-07',
            sessions: 4,
            replies: 120,
            tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
            byModel: { opus: 100, sonnet: 20, haiku: 0, other: 0 }
          }
        ]
      }
    },
    codex: {
      plan: { status: 'found', name: 'Pro' },
      limits: {
        status: 'found',
        source: 'codex-session-log',
        readAt: '2026-10-07T13:12:41Z',
        windows: [{ kind: 'weekly', usedPercent: 0, resetsAt: '2026-10-14T00:00:00Z' }]
      }
    }
  }
}

const problemsAfter = (change) => {
  const doc = validDoc()
  change(doc)
  return checkUsage(doc, identity)
}

const assertRejected = (change, fieldPattern) => {
  const problems = problemsAfter(change)
  assert.ok(problems.length > 0, 'the gate let it through')
  assert.ok(
    problems.some((problem) => fieldPattern.test(problem)),
    `no problem named the field: ${problems.join(' | ')}`
  )
  return problems
}

test('the plan example passes the gate untouched', () => {
  assert.deepEqual(checkUsage(validDoc(), identity), [])
})

test('every source missing is a valid file, with no numbers in it', () => {
  const doc = {
    schema: 'agent-status/usage/v1',
    takenAt: '2026-10-07T20:00:00Z',
    computer: 'this computer',
    claude: { plan: { status: 'not found' }, limits: { status: 'not found' }, activity: { status: 'not found' } },
    codex: { plan: { status: 'not found' }, limits: { status: 'unavailable', why: 'answer not understood' } }
  }
  assert.deepEqual(checkUsage(doc, identity), [])
})

// --- allowed keys only ------------------------------------------------------------------------

test('rule: an unknown top-level key is refused', () => {
  assertRejected((doc) => { doc.email = 'x' }, /^email: /)
})

test('rule: an unknown nested key is refused, and the message names the path', () => {
  assertRejected((doc) => { doc.claude.limits.windows[0].raw = 'x' }, /claude\.limits\.windows\[0\]\.raw/)
})

test('rule: a required key that is missing is refused', () => {
  assertRejected((doc) => { delete doc.takenAt }, /^takenAt: /)
})

test('rule: the schema name must be the v1 name', () => {
  assertRejected((doc) => { doc.schema = 'agent-status/usage/v2' }, /^schema: /)
})

// --- usedPercent only where something was found -----------------------------------------------

test('rule: usedPercent outside a found block is refused, so no invented zero', () => {
  assertRejected((doc) => { doc.claude.limits.status = 'not found' }, /claude\.limits\.windows/)
})

test('rule: an unavailable block carries only its reason', () => {
  assertRejected((doc) => {
    doc.codex.limits = { status: 'unavailable', why: 'x', windows: [{ kind: 'weekly', usedPercent: 0 }] }
  }, /codex\.limits\.windows/)
})

test('rule: a found block may not carry a reason, and must carry its reading', () => {
  assertRejected((doc) => { doc.claude.plan.why = 'because' }, /claude\.plan\.why/)
  assertRejected((doc) => { delete doc.claude.limits.windows }, /claude\.limits\.windows/)
  assertRejected((doc) => { doc.claude.limits.windows = [] }, /claude\.limits\.windows/)
})

test('rule: status must be one of the three words', () => {
  assertRejected((doc) => { doc.claude.plan.status = 'ok' }, /claude\.plan\.status/)
})

test('rule: a source must be one of the known three, and the right one for its block', () => {
  assertRejected((doc) => { doc.claude.limits.source = 'guess' }, /claude\.limits\.source/)
  assertRejected((doc) => { doc.claude.limits.source = 'codex-session-log' }, /claude\.limits\.source/)
  assertRejected((doc) => { doc.codex.limits.source = 'unofficial-live' }, /codex\.limits\.source/)
})

test('rule: window kinds are the known four, and only the model window names a model', () => {
  assertRejected((doc) => { doc.claude.limits.windows[0].kind = 'monthly' }, /windows\[0\]\.kind/)
  assertRejected((doc) => { doc.claude.limits.windows[0].model = 'Opus' }, /windows\[0\]\.model/)
  assertRejected((doc) => { delete doc.claude.limits.windows[2].model }, /windows\[2\]\.model/)
})

test('rule: activity is always labelled an estimate', () => {
  assertRejected((doc) => { doc.claude.activity.estimate = false }, /claude\.activity\.estimate/)
})

// --- numbers and times --------------------------------------------------------------------------

test('rule: percentages are finite and between 0 and 100', () => {
  assertRejected((doc) => { doc.claude.limits.windows[0].usedPercent = Number.NaN }, /usedPercent/)
  assertRejected((doc) => { doc.claude.limits.windows[0].usedPercent = Infinity }, /usedPercent/)
  assertRejected((doc) => { doc.claude.limits.windows[0].usedPercent = -1 }, /usedPercent/)
  assertRejected((doc) => { doc.claude.limits.windows[0].usedPercent = 101 }, /usedPercent/)
  assertRejected((doc) => { doc.claude.limits.windows[0].usedPercent = '18' }, /usedPercent/)
})

test('rule: counts are whole and not negative', () => {
  assertRejected((doc) => { doc.claude.activity.days[0].replies = 1.5 }, /replies/)
  assertRejected((doc) => { doc.claude.activity.days[0].tokens.input = -3 }, /tokens\.input/)
})

test('rule: times are ISO UTC times and days are calendar days', () => {
  assertRejected((doc) => { doc.takenAt = 'yesterday' }, /^takenAt: /)
  assertRejected((doc) => { doc.takenAt = '2026-13-45T99:00:00Z' }, /^takenAt: /)
  assertRejected((doc) => { doc.claude.limits.readAt = 1770000000 }, /readAt/)
  assertRejected((doc) => { doc.claude.activity.days[0].day = '07/10/2026' }, /\.day: /)
})

test('rule: the timezone must be a real timezone name, not any string with a slash in it', () => {
  assertRejected((doc) => { doc.claude.activity.timezone = 'Users/fakeperson' }, /timezone/)
  assertRejected((doc) => { doc.claude.activity.timezone = 'Mars/Olympus_Mons' }, /timezone/)
})

test('rule: lists have a ceiling', () => {
  assertRejected((doc) => {
    doc.claude.activity.days = Array.from({ length: 40 }, () => doc.claude.activity.days[0])
  }, /claude\.activity\.days/)
})

// --- strings --------------------------------------------------------------------------------------

test('rule: a string over 60 characters is refused', () => {
  assertRejected((doc) => { doc.computer = 'M'.repeat(61) }, /^computer: /)
})

for (const [label, value] of [
  ['an at sign', 'me@example.com'],
  ['a forward slash', 'a/b'],
  ['a backslash', 'a\\b'],
  ['a JWT start', 'eyJhbGciOi'],
  ['a key prefix', 'sk-' + 'abc'],
  ['the word Bearer', 'Bearer abc'],
  ['the username', 'FakePerson box'],
  ['the hostname', 'FAKE-HOST-77'],
  ['the home folder', 'at /Users/fakeperson']
]) {
  test(`rule: a string containing ${label} is refused`, () => {
    assertRejected((doc) => { doc.claude.limits.windows[2].model = value }, /windows\[2\]\.model/)
  })
}

test('the gate names the field and never repeats the value', () => {
  const secret = 'sk-' + 'ant-' + 'x'.repeat(40)
  const problems = problemsAfter((doc) => { doc.claude.plan.name = secret })
  assert.ok(problems.length > 0)
  for (const problem of problems) assert.ok(!problem.includes(secret), 'a problem repeated the value')
  for (const problem of problems) assert.ok(!problem.includes('x'.repeat(10)))
})

test('a document that is not an object at all is refused', () => {
  assert.ok(checkUsage(null, identity).length > 0)
  assert.ok(checkUsage([], identity).length > 0)
  assert.ok(checkUsage('{}', identity).length > 0)
})

test('assertSafeUsage throws a GateError carrying the problems, and passes a good file through', () => {
  assert.doesNotThrow(() => assertSafeUsage(validDoc(), identity))
  const doc = validDoc()
  doc.computer = 'me@example.com'
  assert.throws(() => assertSafeUsage(doc, identity), (error) => {
    assert.ok(error instanceof GateError)
    assert.ok(error.problems.some((problem) => problem.startsWith('computer: ')))
    assert.ok(!error.message.includes('example.com'))
    return true
  })
})

// --- console lines and the computer label ----------------------------------------------------------

test('a console line may name a relative repo path but nothing that identifies the person', () => {
  assert.deepEqual(checkLine('Wrote .agent-team/status/usage/mac-mini.json', identity), [])
  assert.ok(checkLine('token eyJabc', identity).length > 0)
  assert.ok(checkLine('Bearer x', identity).length > 0)
  assert.ok(checkLine('me@example.com', identity).length > 0)
  assert.ok(checkLine('C:\\Users\\someone', identity).length > 0)
  assert.ok(checkLine('/Users/fakeperson/.claude', identity).length > 0)
  assert.ok(checkLine('on fake-host-77', identity).length > 0)
  assert.ok(checkLine('sk-' + 'ant-zzz', identity).length > 0)
})

test('the computer label is checked before anything is read', () => {
  assert.deepEqual(checkComputerLabel('Mac Mini', identity), [])
  assert.deepEqual(checkComputerLabel('this computer', identity), [])
  assert.ok(checkComputerLabel('fake-host-77', identity).length > 0, 'the hostname is never a label')
  assert.ok(checkComputerLabel('me@example.com', identity).length > 0)
  assert.ok(checkComputerLabel('!!!', identity).length > 0, 'a label with no file name is refused')
  assert.ok(checkComputerLabel('', identity).length > 0)
  assert.ok(checkComputerLabel(42, identity).length > 0)
})

test('a short username or hostname does not make every word suspicious', () => {
  // A two-letter account name would otherwise refuse "Max 20x" for containing "ma".
  const tiny = { username: 'ma', home: '/home/ma', hostname: 'pc' }
  const doc = validDoc()
  assert.deepEqual(checkUsage(doc, tiny), [])
})

// --- receipts ------------------------------------------------------------------------------------------


const validReceipt = () => ({
  schema: 'agent-status/receipt/v1',
  claimedAt: '2026-10-07T20:00:00Z',
  computer: 'Mac Mini',
  file: '.agent-team/status/usage/mac-mini.json',
  sha256: 'a'.repeat(64),
  sources: { claudePlan: 'found', claudeLimits: 'found', claudeActivity: 'found', codexPlan: 'not found', codexLimits: 'unavailable' }
})

test('a receipt holds statuses and a hash, and the gate holds it to exactly that', () => {
  assert.deepEqual(checkAgainst(validReceipt(), RECEIPT_SHAPE, identity), [])
  const cases = [
    [(receipt) => { receipt.file = '/Users/fakeperson/repo/.agent-team/status/usage/mac-mini.json' }, /^file: /],
    [(receipt) => { receipt.file = '.agent-team/status/usage/../../secret.json' }, /^file: /],
    [(receipt) => { receipt.sha256 = 'A'.repeat(64) }, /^sha256: /],
    [(receipt) => { receipt.sources.claudeLimits = 18 }, /sources\.claudeLimits/],
    [(receipt) => { receipt.sources.email = 'found' }, /sources\.email/],
    [(receipt) => { receipt.token = 'x' }, /^token: /]
  ]
  for (const [change, field] of cases) {
    const receipt = validReceipt()
    change(receipt)
    const problems = checkAgainst(receipt, RECEIPT_SHAPE, identity)
    assert.ok(problems.some((problem) => field.test(problem)), `not refused: ${field}`)
  }
})

test('a final record names a known outcome and, at most, a commit id', () => {
  const final = { schema: 'agent-status/final/v1', finishedAt: '2026-10-07T20:01:00Z', outcome: 'pushed', commit: 'b'.repeat(40) }
  assert.deepEqual(checkAgainst(final, FINAL_SHAPE, identity), [])
  assert.ok(checkAgainst({ ...final, outcome: 'it went fine' }, FINAL_SHAPE, identity).some((problem) => problem.startsWith('outcome: ')))
  assert.ok(checkAgainst({ ...final, commit: 'HEAD' }, FINAL_SHAPE, identity).some((problem) => problem.startsWith('commit: ')))
  assert.ok(checkAgainst({ ...final, remote: 'x' }, FINAL_SHAPE, identity).some((problem) => problem.startsWith('remote: ')))
})
