import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  USAGE_SCHEMA,
  USAGE_FOLDER,
  COMPUTER_SLUG,
  DEFAULT_COMPUTER,
  MAX_STRING_LENGTH,
  STALE_AFTER_HOURS,
  MAX_FILES_READ,
  STATUSES,
  SOURCES,
  WINDOW_LABELS,
  MAX_WINDOWS,
  MAX_ACTIVITY_DAYS,
  WINDOW_REQUIRED,
  WINDOW_OPTIONAL,
  CLAUDE_LIMIT_SOURCES,
  CODEX_LIMIT_SOURCES,
  windowLabel,
  computerSlug,
  usagePath
} from '../scripts/lib/status/schema.mjs'
import { checkUsage } from '../scripts/lib/status/safe.mjs'
import { SLOT_HOURS } from '../scripts/lib/status/commit.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/* tests/fixtures/usage-parity.json is the shared contract with agent-cockpit - the same bytes in
   both repos. The collector writes the usage file and the board reads it, with no import path
   between a student's repo and a deployed web app, so each side mirrors the contract by hand and
   checks its own copy against the fixture. Change one side alone and that side fails here. */

const fixturePath = join(repoRoot, 'tests', 'fixtures', 'usage-parity.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))

test('usage parity: the collector writes the schema name the board expects', () => {
  assert.equal(USAGE_SCHEMA, fixture.schema)
})

test('usage parity: the folder, computer slug and default label match', () => {
  assert.equal(USAGE_FOLDER, fixture.folder)
  assert.equal(COMPUTER_SLUG.source, fixture.computerSlug)
  assert.equal(DEFAULT_COMPUTER, fixture.defaultComputer)
})

test('usage parity: the limits both sides enforce match', () => {
  assert.equal(MAX_STRING_LENGTH, fixture.maxStringLength)
  assert.equal(STALE_AFTER_HOURS, fixture.staleAfterHours)
  assert.equal(MAX_FILES_READ, fixture.maxFilesRead)
  assert.equal(MAX_WINDOWS, fixture.maxWindows)
  assert.equal(MAX_ACTIVITY_DAYS, fixture.maxActivityDays)
  assert.deepEqual(WINDOW_REQUIRED, fixture.windowRequired)
  assert.deepEqual(WINDOW_OPTIONAL, fixture.windowOptional)
})

test('usage parity: statuses, sources and window labels match', () => {
  assert.deepEqual(STATUSES, fixture.statuses)
  assert.deepEqual(SOURCES, fixture.sources)
  assert.deepEqual([...CLAUDE_LIMIT_SOURCES, ...CODEX_LIMIT_SOURCES], fixture.sources)
  assert.deepEqual(WINDOW_LABELS, fixture.windows)
})

/* Equal constants prove nothing if the gate does not use them. These feed the gate itself, so a
   literal that drifts from the contract inside the shape fails here even when the exported
   constant is right. */

const identity = { username: 'fakeperson', home: '/Users/fakeperson', hostname: 'fake-host-77' }

const windowOf = (kind) => (kind === 'weekly_model' ? { kind, model: 'Fable', usedPercent: 1 } : { kind, usedPercent: 1 })

function docWith({ claudeWindows = [windowOf('five_hour')], codexWindows = [windowOf('weekly')], days = [], plan = { status: 'not found' } } = {}) {
  return {
    schema: fixture.schema,
    takenAt: '2026-10-07T20:00:00Z',
    computer: 'Mac Mini',
    claude: {
      plan,
      limits: { status: 'found', source: 'unofficial-live', readAt: '2026-10-07T20:00:00Z', windows: claudeWindows },
      activity: { status: 'found', estimate: true, timezone: 'UTC', days }
    },
    codex: {
      plan: { status: 'not found' },
      limits: { status: 'found', source: 'codex-session-log', readAt: '2026-10-07T20:00:00Z', windows: codexWindows }
    }
  }
}

const accepted = (doc) => assert.deepEqual(checkUsage(doc, identity), [])
const refused = (doc, pattern) => {
  const problems = checkUsage(doc, identity)
  assert.ok(problems.some((problem) => pattern.test(problem)), `not refused for ${pattern}: ${problems.join(' | ') || 'no problems'}`)
}

test('usage parity: the gate takes exactly maxWindows windows per block, not one more', () => {
  const many = (count) => Array.from({ length: count }, () => windowOf('weekly_all'))
  accepted(docWith({ claudeWindows: many(fixture.maxWindows), codexWindows: many(fixture.maxWindows) }))
  refused(docWith({ claudeWindows: many(fixture.maxWindows + 1) }), /claude\.limits\.windows: has more than/)
  refused(docWith({ codexWindows: many(fixture.maxWindows + 1) }), /codex\.limits\.windows: has more than/)
})

test('usage parity: a window needs windowRequired, may carry windowOptional, and nothing else', () => {
  accepted(docWith({ claudeWindows: [{ kind: 'five_hour', usedPercent: 3 }] }))
  for (const key of fixture.windowRequired) {
    const window = { kind: 'five_hour', usedPercent: 3 }
    delete window[key]
    refused(docWith({ claudeWindows: [window] }), new RegExp(`windows\\[0\\]\\.${key}: is missing`))
  }
  // Each optional key is accepted where it belongs: a reset time on any window (or none at all -
  // the board says the reset time is unknown), a model on the model window.
  assert.deepEqual([...fixture.windowOptional].sort(), ['model', 'resetsAt'])
  accepted(docWith({ claudeWindows: [{ kind: 'five_hour', usedPercent: 3, resetsAt: '2026-10-07T21:00:00Z' }] }))
  accepted(docWith({ claudeWindows: [{ kind: 'weekly_model', model: 'Fable', usedPercent: 3 }] }))
  refused(docWith({ claudeWindows: [{ kind: 'five_hour', usedPercent: 3, label: '5-hour' }] }), /windows\[0\]\.label: is not an allowed key/)
  refused(docWith({ claudeWindows: [{ kind: 'five_hour', usedPercent: 3, resetsAt: null }] }), /windows\[0\]\.resetsAt/)
})

test('usage parity: the gate takes exactly maxActivityDays days, not one more', () => {
  const day = (index) => ({
    day: new Date(Date.UTC(2026, 8, 1 + index)).toISOString().slice(0, 10),
    sessions: 1,
    replies: 1,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    byModel: { opus: 0, sonnet: 0, haiku: 0, other: 1 }
  })
  const days = (count) => Array.from({ length: count }, (_, index) => day(index))
  accepted(docWith({ days: days(fixture.maxActivityDays) }))
  refused(docWith({ days: days(fixture.maxActivityDays + 1) }), /claude\.activity\.days: has more than/)
})

test('usage parity: the gate accepts every status in the contract, and no other', () => {
  for (const status of fixture.statuses.filter((word) => word !== 'found')) accepted(docWith({ plan: { status } }))
  accepted(docWith({ plan: { status: 'found', name: 'Max 20x' } }))
  refused(docWith({ plan: { status: 'broken' } }), /claude\.plan\.status/)
})

test('usage parity: the gate accepts every source in the contract in its own block, and no other', () => {
  const claudeSources = fixture.sources.filter((source) => source !== 'codex-session-log')
  for (const source of claudeSources) {
    const doc = docWith()
    doc.claude.limits.source = source
    accepted(doc)
  }
  const doc = docWith()
  doc.codex.limits.source = 'codex-session-log'
  accepted(doc)
  const crossed = docWith()
  crossed.claude.limits.source = 'codex-session-log'
  refused(crossed, /claude\.limits\.source/)
  const unknown = docWith()
  unknown.codex.limits.source = 'made-up'
  refused(unknown, /codex\.limits\.source/)
})

// The collector never shows staleness itself - the board does. What the collector side owns is the
// schedule, which must run well inside that window, and the README that tells the Mac owner when
// the banner appears.
test('usage parity: the Mac schedule runs well inside staleAfterHours, and the README says when it trips', async () => {
  assert.ok(SLOT_HOURS * 2 < fixture.staleAfterHours, 'one missed run would already show the stale banner')
  const readme = readFileSync(join(repoRoot, '.agent-team', 'status', 'README.md'), 'utf8')
  assert.match(readme, new RegExp(`stale banner after ${fixture.staleAfterHours} hours`))
})

test('the two repos hold the same usage contract, byte for byte', (t) => {
  const sibling = join(repoRoot, '..', 'agent-cockpit', 'tests', 'fixtures', 'usage-parity.json')
  if (!existsSync(sibling)) {
    t.skip('SKIPPED, not passed: agent-cockpit is not checked out beside this repo, so the two copies of tests/fixtures/usage-parity.json could not be compared. The tests above still check this copy against the collector.')
    return
  }
  assert.equal(
    readFileSync(sibling, 'utf8'),
    readFileSync(fixturePath, 'utf8'),
    'the shared usage contract has been edited on one side only'
  )
})

test('a window label names the model only for the model-scoped weekly window', () => {
  assert.equal(windowLabel({ kind: 'five_hour' }), '5-hour')
  assert.equal(windowLabel({ kind: 'weekly_all' }), 'Weekly')
  assert.equal(windowLabel({ kind: 'weekly' }), 'Weekly')
  assert.equal(windowLabel({ kind: 'weekly_model', model: 'Fable' }), 'Weekly, Fable only')
  assert.equal(windowLabel({ kind: 'something_new' }), null)
})

test('a computer label becomes a file name the board will accept', () => {
  assert.equal(computerSlug('Mac Mini'), 'mac-mini')
  assert.equal(computerSlug(DEFAULT_COMPUTER), 'this-computer')
  assert.equal(computerSlug("  Nuno's   Laptop!! "), 'nuno-s-laptop')
  assert.equal(computerSlug('x'.repeat(80)).length, 32)
  assert.match(computerSlug('Ünïcode Box 2'), COMPUTER_SLUG)
  // A label with nothing usable in it has no file name, and the caller has to refuse it.
  assert.equal(computerSlug('!!!'), null)
  assert.equal(computerSlug(''), null)
})

test('the usage file path is the shared folder plus the slug', () => {
  assert.equal(usagePath('Mac Mini'), '.agent-team/status/usage/mac-mini.json')
  assert.equal(usagePath('!!!'), null)
})
