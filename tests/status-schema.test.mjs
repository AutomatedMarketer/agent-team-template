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
  windowLabel,
  computerSlug,
  usagePath
} from '../scripts/lib/status/schema.mjs'

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
})

test('usage parity: statuses, sources and window labels match', () => {
  assert.deepEqual(STATUSES, fixture.statuses)
  assert.deepEqual(SOURCES, fixture.sources)
  assert.deepEqual(WINDOW_LABELS, fixture.windows)
})

test('the two repos hold the same usage contract, byte for byte', (t) => {
  const sibling = join(repoRoot, '..', 'agent-cockpit', 'tests', 'fixtures', 'usage-parity.json')
  if (!existsSync(sibling)) {
    t.skip('agent-cockpit is not checked out beside this repo')
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
