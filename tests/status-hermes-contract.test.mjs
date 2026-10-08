import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './helpers/repo.mjs'
import {
  HERMES_SCHEMA,
  HERMES_FOLDER,
  HERMES_STALE_AFTER_HOURS,
  HERMES_MAX_FILES_READ,
  HERMES_MAX_FILE_BYTES,
  HERMES_CAPS,
  DEFAULT_PROFILE,
  SESSION_DAYS,
  UPDATE_CHECK_MAX_AGE_DAYS,
  GATEWAY_STATES,
  ALIVE,
  HEARTBEAT,
  PROFILE_NAME,
  HERMES_WORDS,
  hermesPath,
  aliveFrom
} from '../scripts/lib/status/hermes-schema.mjs'
import { MAX_COMPUTERS_SHOWN } from '../scripts/lib/status/connections-schema.mjs'
import { COMPUTER_SLUG, STATUSES } from '../scripts/lib/status/schema.mjs'
import { checkHermes, checkConnectionName, checkProfileName, modelShown } from '../scripts/lib/status/safe.mjs'

/* tests/fixtures/hermes-parity.json is the shared contract for the Hermes card - the same bytes in
   agent-team-template and agent-cockpit. The collector writes the file and the board reads it, with
   no import path between them, so each side mirrors the contract by hand and checks its own copy
   against the fixture. These hold the collector's side: every constant, the alive rule (which the
   board works out itself - a yes/no flag in the file is refused), the heartbeat settings, the name
   rules with the examples both sides must agree on, and the gate on the whole file. */

const fixturePath = join(repoRoot, 'tests', 'fixtures', 'hermes-parity.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const identity = { username: 'fakeperson', home: '/Users/fakeperson', hostname: 'fake-host-77' }
const clone = (value) => structuredClone(value)

test('hermes parity: schema, folder, file name and the board\'s reading limits match', () => {
  assert.equal(HERMES_SCHEMA, fixture.schema)
  assert.equal(HERMES_FOLDER, fixture.folder)
  assert.equal(COMPUTER_SLUG.source, fixture.computerSlug)
  assert.equal(HERMES_STALE_AFTER_HOURS, fixture.staleAfterHours)
  assert.equal(HERMES_MAX_FILES_READ, fixture.maxFilesRead)
  assert.equal(HERMES_MAX_FILE_BYTES, fixture.maxFileBytes)
  assert.equal(MAX_COMPUTERS_SHOWN, fixture.maxComputersShown)
  assert.deepEqual(STATUSES, fixture.statuses)
  assert.equal(hermesPath('Mac Mini'), `${fixture.folder}/mac-mini.json`)
})

test('hermes parity: caps, default profile, day counts, gateway states and words match', () => {
  assert.deepEqual(HERMES_CAPS, fixture.caps)
  assert.equal(HERMES_CAPS.profiles, 12)
  assert.equal(DEFAULT_PROFILE, fixture.defaultProfile)
  assert.equal(SESSION_DAYS, fixture.sessionDays)
  assert.equal(UPDATE_CHECK_MAX_AGE_DAYS, fixture.updateCheckMaxAgeDays)
  assert.deepEqual(GATEWAY_STATES, fixture.gatewayStates)
  assert.deepEqual(Object.keys(GATEWAY_STATES), ['starting', 'running', 'degraded', 'stopped', 'startup_failed', 'unknown'])
  assert.deepEqual(HERMES_WORDS, fixture.words)
})

test('hermes parity: the alive rule and the heartbeat settings match', () => {
  assert.deepEqual(ALIVE, fixture.alive)
  assert.equal(ALIVE.withinSeconds, 300)
  assert.deepEqual(ALIVE.gatewayStates, ['running'])
  assert.deepEqual(ALIVE.words, { running: 'Running', down: 'Down at last check', stale: 'Not checked for {hours} h' })
  assert.deepEqual(HEARTBEAT, fixture.heartbeat)
  assert.equal(HEARTBEAT.path, 'runs/heartbeat/hermes.json')
  assert.deepEqual(HEARTBEAT.staleAfterMinutes, { default: 30, min: 5, max: 1440, hermes: 200 })
})

test('hermes parity: the profile-name rule is written the same way on this side', () => {
  assert.equal(PROFILE_NAME.source, fixture.names.profile)
})

// --- the name rules -------------------------------------------------------------------------------------

test('profile names: every accept example passes and every refuse example is refused', () => {
  for (const name of fixture.names.profileAccept) {
    assert.deepEqual(checkProfileName(name, 'name', identity), [], `refused ${JSON.stringify(name)}`)
  }
  for (const { name, why } of fixture.names.profileRefuse) {
    assert.ok(checkProfileName(name, 'name', identity).length > 0, `accepted ${JSON.stringify(name)} (${why})`)
  }
  // This computer's username is refused as a profile name too.
  assert.ok(checkProfileName('fakeperson', 'name', identity).length > 0)
})

test('model names: the last segment after the slash is shown, and only when it passes the name rule', () => {
  for (const { raw, shown } of fixture.names.modelAccept) {
    assert.equal(modelShown(raw, identity), shown, `${raw}`)
  }
  for (const { raw, why } of fixture.names.modelRefuse) {
    assert.equal(modelShown(raw, identity), null, `${JSON.stringify(raw)} was shown (${why})`)
  }
})

test('provider names: held to the connection-name rule as they are', () => {
  for (const name of fixture.names.providerAccept) assert.deepEqual(checkConnectionName(name, 'provider', identity), [], name)
  for (const { name, why } of fixture.names.providerRefuse) {
    assert.ok(checkConnectionName(name, 'provider', identity).length > 0, `accepted ${JSON.stringify(name)} (${why})`)
  }
})

// --- the alive rule ---------------------------------------------------------------------------------------

test('the alive rule: every example in the contract gives the answer it says', () => {
  assert.ok(fixture.aliveExamples.length >= 6)
  for (const example of fixture.aliveExamples) {
    const doc = clone(fixture.sample)
    doc.takenAt = example.takenAt
    doc.gateway = example.gateway
    doc.profiles.items = doc.profiles.items.map((item, index) => ({
      ...item,
      scheduler: example.schedulerBeats[index] ? { status: 'found', beatAt: example.schedulerBeats[index] } : { status: 'not found' }
    }))
    assert.deepEqual(checkHermes(doc, identity), [], `${example.why}: the example doc is not a valid file`)
    assert.deepEqual(aliveFrom(doc), { alive: example.alive, at: example.at }, example.why)
  }
})

test('the alive rule: a file that is not found anywhere is not alive', () => {
  const doc = { schema: fixture.schema, takenAt: fixture.sample.takenAt, computer: 'Mac Mini', install: { status: 'not found' }, gateway: { status: 'not found' }, profiles: { status: 'not found' } }
  assert.deepEqual(checkHermes(doc, identity), [])
  assert.deepEqual(aliveFrom(doc), { alive: false, at: null })
})

// --- the gate on the whole file --------------------------------------------------------------------------

const accepted = (doc) => assert.deepEqual(checkHermes(doc, identity), [])
function refused(change, pattern) {
  const doc = clone(fixture.sample)
  change(doc)
  const problems = checkHermes(doc, identity)
  assert.ok(problems.some((problem) => pattern.test(problem)), `not refused for ${pattern}: ${problems.join(' | ') || 'no problems'}`)
}

test('the gate accepts the sample', () => {
  accepted(fixture.sample)
})

test('the gate refuses a yes/no flag for alive, wherever it is planted', () => {
  refused((doc) => { doc.alive = true }, /^alive: is not an allowed key/)
  refused((doc) => { doc.gateway.alive = true }, /gateway\.alive: is not an allowed key/)
  refused((doc) => { doc.gateway.running = true }, /gateway\.running: is not an allowed key/)
  refused((doc) => { doc.profiles.items[0].alive = true }, /profiles\.items\[0\]\.alive: is not an allowed key/)
})

test('the gate refuses what Hermes keeps beside the fields read', () => {
  refused((doc) => { doc.gateway.argv = ['hermes', 'gateway'] }, /gateway\.argv: is not an allowed key/)
  refused((doc) => { doc.gateway.pid = 123 }, /gateway\.pid: is not an allowed key/)
  refused((doc) => { doc.profiles.items[0].baseUrl = 'x' }, /profiles\.items\[0\]\.baseUrl: is not an allowed key/)
  refused((doc) => { doc.profiles.items[0].sessions.titles = [] }, /sessions\.titles: is not an allowed key/)
  refused((doc) => { doc.profiles.items[0].sessions.cwd = 'x' }, /sessions\.cwd: is not an allowed key/)
  refused((doc) => { doc.install.behind = 3 }, /install\.behind: is not an allowed key/)
})

test('gate types: states, times, counts, versions and names are held to their exact form', () => {
  refused((doc) => { doc.gateway.state = 'Running' }, /gateway\.state: is not one of the allowed values/)
  refused((doc) => { doc.gateway.state = 'draining' }, /gateway\.state: is not one of the allowed values/)
  refused((doc) => { doc.gateway.beatAt = '2026-10-08T14:59:12+00:00' }, /gateway\.beatAt: is not an ISO time/)
  refused((doc) => { doc.install.version = '0.21.3 (git)' }, /install\.version: is not a version number/)
  refused((doc) => { doc.install.updateAvailable = 'yes' }, /install\.updateAvailable: is not true or false/)
  refused((doc) => { doc.profiles.items[0].skills.count = -1 }, /skills\.count: is not a whole number/)
  refused((doc) => { doc.profiles.items[0].sessions.conversations = 1.5 }, /sessions\.conversations: is not a whole number/)
  refused((doc) => { doc.profiles.items[0].sessions.days = 30 }, /sessions\.days: is not 7/)
  refused((doc) => { doc.profiles.items[0].scheduler.beatAt = 'yesterday' }, /scheduler\.beatAt: is not an ISO time/)
  for (const { name } of fixture.names.profileRefuse) {
    refused((doc) => { doc.profiles.items[1].name = name }, /profiles\.items\[1\]\.name/)
  }
  for (const { name } of fixture.names.providerRefuse) {
    refused((doc) => { doc.profiles.items[0].provider = name }, /profiles\.items\[0\]\.provider/)
  }
  refused((doc) => { doc.profiles.items[0].model = 'anthropic/claude' }, /profiles\.items\[0\]\.model: contains a slash/)
})

test('a provider is only written with a model; a block that found nothing carries nothing else', () => {
  refused((doc) => { delete doc.profiles.items[0].model }, /profiles\.items\[0\]\.provider: is only allowed with a model/)
  refused((doc) => { doc.gateway = { status: 'not found', state: 'running' } }, /gateway\.state: is not an allowed key/)
  refused((doc) => { doc.profiles.items[0].sessions = { status: 'unavailable', why: 'needs a newer Node', conversations: 0 } }, /sessions\.conversations: is not an allowed key/)
  refused((doc) => { delete doc.profiles.items[0].scheduler }, /scheduler: is missing/)
  refused((doc) => { delete doc.profiles.hidden }, /profiles\.hidden: is missing/)
  refused((doc) => { doc.extra = 1 }, /^extra: is not an allowed key/)
  refused((doc) => { doc.schema = 'agent-status/hermes/v2' }, /schema: is not agent-status\/hermes\/v1/)
  const noModel = clone(fixture.sample)
  delete noModel.profiles.items[0].model
  delete noModel.profiles.items[0].provider
  accepted(noModel)
})

test('profiles: at most twelve, each name once', () => {
  const item = (name) => ({ name, skills: { status: 'not found' }, sessions: { status: 'not found' }, scheduler: { status: 'not found' } })
  const ok = clone(fixture.sample)
  ok.profiles.items = [item('default'), ...Array.from({ length: fixture.caps.profiles - 1 }, (_, index) => item(`p${index}`))]
  accepted(ok)
  refused((doc) => { doc.profiles.items = [item('default'), ...Array.from({ length: fixture.caps.profiles }, (_, index) => item(`p${index}`))] }, /profiles\.items: has more than 12/)
  refused((doc) => { doc.profiles.items.push(clone(doc.profiles.items[1])) }, /profiles\.items: names the same entry twice/)
})

// --- the board's expected shape follows from the sample ----------------------------------------------------
//
// The board builds its card from the sample and must produce expectedShape exactly. This rebuilds
// expectedShape from the sample and the contract's words alone, so the fixture cannot hold a shape
// that the sample, the alive rule and the words do not explain.

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, key) => String(values[key]))

function installFrom(install, words) {
  if (install.status !== 'found') return { status: install.status, version: null, updateAvailable: null, label: words.install[install.status] }
  const base = install.version ? fill(words.install.version, install) : words.install.noVersion
  const label = install.updateAvailable === true ? fill(words.install.updateAvailable, { label: base })
    : install.updateAvailable === false ? fill(words.install.upToDate, { label: base }) : base
  return { status: 'found', version: install.version ?? null, updateAvailable: install.updateAvailable ?? null, label }
}

function profileFrom(item, words) {
  const model = item.model ?? null
  const provider = item.provider ?? null
  const modelLabel = model && provider ? fill(words.model.both, { model, provider }) : model ? fill(words.model.modelOnly, { model }) : words.model.none
  const sessions = item.sessions.status === 'found'
    ? { status: 'found', days: item.sessions.days, conversations: item.sessions.conversations, scheduled: item.sessions.scheduled, lastActiveAt: item.sessions.lastActiveAt ?? null }
    : { status: item.sessions.status, label: fill(words.sessions[item.sessions.status], { why: item.sessions.why ?? '' }) }
  return {
    name: item.name,
    model,
    provider,
    modelLabel,
    skills: item.skills.status === 'found' ? item.skills.count : null,
    sessions,
    schedulerBeatAt: item.scheduler.status === 'found' ? item.scheduler.beatAt : null
  }
}

function expectedFrom(sample, contract, now) {
  const ageMs = Date.parse(now) - Date.parse(sample.takenAt)
  const stale = ageMs > contract.staleAfterHours * 3600_000
  const { alive } = aliveFrom(sample)
  const state = stale ? 'stale' : alive ? 'running' : 'down'
  return {
    computer: sample.computer,
    takenAt: sample.takenAt,
    freshness: stale ? 'stale' : 'fresh',
    alive: state,
    aliveLabel: fill(contract.alive.words[state], { hours: Math.floor(ageMs / 3600_000) }),
    install: installFrom(sample.install, contract.words),
    gateway: sample.gateway.status === 'found'
      ? { status: 'found', state: sample.gateway.state, stateLabel: contract.gatewayStates[sample.gateway.state], beatAt: sample.gateway.beatAt ?? null }
      : { status: sample.gateway.status, state: null, stateLabel: null, beatAt: null },
    profiles: sample.profiles.status === 'found'
      ? { status: 'found', items: sample.profiles.items.map((item) => profileFrom(item, contract.words)), hidden: sample.profiles.hidden, more: sample.profiles.more }
      : { status: sample.profiles.status, items: [], hidden: 0, more: 0 }
  }
}

test('expectedShape is exactly what the sample, the alive rule and the contract\'s words make', () => {
  assert.equal(fixture.expectedShape.computers.length, 1)
  assert.deepEqual(fixture.expectedShape.computers[0], expectedFrom(fixture.sample, fixture, fixture.expectedShape.now))
  assert.equal(fixture.expectedShape.computers[0].aliveLabel, 'Running')
  assert.equal(fixture.expectedShape.computers[0].install.label, 'Hermes 0.21.3 - update available')
  assert.equal(fixture.expectedShape.computers[0].profiles.items[0].name, 'default', 'the default profile comes first')
})

test('the other two words: Down at last check, and Not checked for N h', () => {
  for (const example of fixture.wordExamples) {
    const doc = clone(fixture.sample)
    doc.takenAt = example.takenAt
    if (example.down) {
      doc.gateway = { status: 'found', state: 'stopped', beatAt: example.takenAt }
      doc.profiles.items = doc.profiles.items.map((item) => ({ ...item, scheduler: { status: 'not found' } }))
    }
    const shape = expectedFrom(doc, fixture, example.now)
    assert.equal(shape.aliveLabel, example.aliveLabel, example.why)
    assert.equal(shape.freshness, example.freshness, example.why)
  }
  assert.ok(fixture.wordExamples.some((example) => example.aliveLabel === 'Down at last check'))
  assert.ok(fixture.wordExamples.some((example) => example.aliveLabel === 'Not checked for 9 h'))
})

test('the two repos hold the same Hermes contract, byte for byte', (t) => {
  const sibling = join(repoRoot, '..', 'agent-cockpit', 'tests', 'fixtures', 'hermes-parity.json')
  if (!existsSync(sibling)) {
    t.skip('NOT CHECKED: agent-cockpit has no tests/fixtures/hermes-parity.json beside this repo, so the two copies of the Hermes contract could not be compared. The tests above still check this copy against the collector.')
    return
  }
  assert.equal(readFileSync(sibling, 'utf8'), readFileSync(fixturePath, 'utf8'), 'the shared Hermes contract has been edited on one side only')
})
