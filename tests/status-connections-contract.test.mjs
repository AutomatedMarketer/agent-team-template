import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './helpers/repo.mjs'
import {
  CONNECTIONS_SCHEMA,
  CONNECTIONS_FOLDER,
  CONNECTIONS_STALE_AFTER_HOURS,
  CONNECTIONS_MAX_FILES_READ,
  CONNECTIONS_MAX_FILE_BYTES,
  MAX_COMPUTERS_SHOWN,
  CAPS,
  TOOL_NAMES,
  TOOL_STATES,
  VERSION_PATTERN,
  MAX_VERSION_LENGTH,
  SERVER_SCOPES,
  TRANSPORTS,
  SERVER_STATES,
  LIVE_STATES,
  CODEX_STATES,
  CONNECTION_NAME,
  connectionsPath
} from '../scripts/lib/status/connections-schema.mjs'
import { COMPUTER_SLUG, STATUSES, MAX_STRING_LENGTH } from '../scripts/lib/status/schema.mjs'
import { checkConnections, checkConnectionName, LABEL_CHARACTERS } from '../scripts/lib/status/safe.mjs'

/* tests/fixtures/connections-parity.json is the shared contract for the Connections wall - the
   same bytes in agent-team-template and agent-cockpit. The collector writes the file and the
   board reads it, with no import path between them, so each side mirrors the contract by hand
   and checks its own copy against the fixture. These tests hold the collector's side: every
   constant, the connection-name rule (with the examples both sides must agree on), and the gate,
   which must accept the sample and refuse each way a file can be wrong. */

const fixturePath = join(repoRoot, 'tests', 'fixtures', 'connections-parity.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const identity = { username: 'fakeperson', home: '/Users/fakeperson', hostname: 'fake-host-77' }
const clone = (value) => structuredClone(value)

test('connections parity: schema, folder, file name and the board\'s reading limits match', () => {
  assert.equal(CONNECTIONS_SCHEMA, fixture.schema)
  assert.equal(CONNECTIONS_FOLDER, fixture.folder)
  assert.equal(COMPUTER_SLUG.source, fixture.computerSlug)
  assert.equal(CONNECTIONS_STALE_AFTER_HOURS, fixture.staleAfterHours)
  assert.equal(CONNECTIONS_MAX_FILES_READ, fixture.maxFilesRead)
  assert.equal(CONNECTIONS_MAX_FILE_BYTES, fixture.maxFileBytes)
  assert.equal(MAX_COMPUTERS_SHOWN, fixture.maxComputersShown)
  assert.deepEqual(STATUSES, fixture.statuses)
  assert.equal(connectionsPath('Mac Mini'), `${fixture.folder}/mac-mini.json`)
})

test('connections parity: caps, tools, versions and every enum with its words match', () => {
  assert.deepEqual(CAPS, fixture.caps)
  assert.deepEqual(TOOL_NAMES, fixture.tools)
  assert.ok(TOOL_NAMES.length <= CAPS.tools)
  assert.deepEqual(TOOL_STATES, fixture.toolStates)
  assert.equal(VERSION_PATTERN.source, fixture.versionPattern)
  assert.equal(MAX_VERSION_LENGTH, fixture.maxVersionLength)
  assert.deepEqual(SERVER_SCOPES, fixture.scopes)
  assert.deepEqual(TRANSPORTS, fixture.transports)
  assert.deepEqual(SERVER_STATES, fixture.serverStates)
  assert.deepEqual(LIVE_STATES, fixture.liveStates)
  assert.deepEqual(CODEX_STATES, fixture.codexStates)
})

test('connections parity: the connection-name rule is written the same way on this side', () => {
  const rule = fixture.connectionName
  assert.equal(CONNECTION_NAME.characters.source, rule.characters)
  assert.equal(CONNECTION_NAME.characters.flags, rule.flags)
  // The same characters the computer label is held to, so the board needs one character rule.
  assert.equal(CONNECTION_NAME.characters.source, LABEL_CHARACTERS.source)
  assert.equal(CONNECTION_NAME.maxLength, rule.maxLength)
  assert.equal(rule.maxLength, MAX_STRING_LENGTH)
  assert.deepEqual(CONNECTION_NAME.never, rule.never)
  assert.equal(CONNECTION_NAME.uuid.source, rule.uuid)
  assert.equal(CONNECTION_NAME.segmentSeparators, rule.segmentSeparators)
  assert.equal(CONNECTION_NAME.maxSegmentLength, rule.maxSegmentLength)
})

test('connection names: every accept example passes and every refuse example is refused', () => {
  for (const name of fixture.connectionName.accept) {
    assert.deepEqual(checkConnectionName(name, 'name', identity), [], `refused ${JSON.stringify(name)}`)
  }
  for (const { name, why } of fixture.connectionName.refuse) {
    assert.ok(checkConnectionName(name, 'name', identity).length > 0, `accepted ${JSON.stringify(name)} (${why})`)
  }
  // The two the plan names: a plugin server's full name passes, a 40-character token does not.
  assert.ok(fixture.connectionName.accept.includes('plugin:marketing:supermetrics'))
  assert.ok(fixture.connectionName.refuse.some(({ name }) => name.length === 40 && !/[:._\- ]/.test(name)))
})

test('connection names: this computer\'s username, name and home folder are refused too', () => {
  // The board cannot make these checks - it does not know whose computer it was - so the
  // collector makes them before anything is written.
  for (const name of ['fakeperson-tools', 'plugin:fake-host-77:x', 'FAKEPERSON server']) {
    assert.ok(checkConnectionName(name, 'name', identity).length > 0, `accepted ${name}`)
  }
})

test('a refused name is described, never repeated', () => {
  for (const { name } of fixture.connectionName.refuse.filter(({ name }) => name.length > 3)) {
    for (const problem of checkConnectionName(name, 'claude.servers[0].name', identity)) {
      assert.ok(!problem.includes(name.trim()), `the problem repeated the name: ${problem}`)
    }
  }
})

// --- the gate on the whole file ------------------------------------------------------------------

const accepted = (doc) => assert.deepEqual(checkConnections(doc, identity), [])
function refused(change, pattern) {
  const doc = clone(fixture.sample)
  change(doc)
  const problems = checkConnections(doc, identity)
  assert.ok(problems.some((problem) => pattern.test(problem)), `not refused for ${pattern}: ${problems.join(' | ') || 'no problems'}`)
}

test('the gate accepts the sample, and every accept example as a server name', () => {
  accepted(fixture.sample)
  for (const name of fixture.connectionName.accept) {
    const doc = clone(fixture.sample)
    doc.claude.servers = [{ name, scope: 'user', transport: 'local', state: 'connected' }]
    doc.codex.plugins = [{ name, from: name }]
    accepted(doc)
  }
})

test('the gate refuses every refuse example wherever a name goes', () => {
  for (const { name } of fixture.connectionName.refuse) {
    refused((doc) => { doc.claude.servers[0].name = name }, /claude\.servers\[0\]\.name/)
    refused((doc) => { doc.codex.servers[0].name = name }, /codex\.servers\[0\]\.name/)
    refused((doc) => { doc.codex.plugins[0].name = name }, /codex\.plugins\[0\]\.name/)
    refused((doc) => { doc.codex.plugins[0].from = name }, /codex\.plugins\[0\]\.from/)
  }
})

test('gate types: booleans, versions and enums are held to their exact form', () => {
  refused((doc) => { doc.codex.servers[0].enabled = 'yes' }, /codex\.servers\[0\]\.enabled: is not true or false/)
  refused((doc) => { doc.codex.plugins[0].enabled = 0 }, /codex\.plugins\[0\]\.enabled: is not true or false/)
  for (const version of ['v2.1.293', '2', '2.1.3.4.5', '2.1.293 (Claude Code)', '1.2-beta', '', 2.1, `${'1'.repeat(31)}.1`]) {
    refused((doc) => { doc.tools[0].version = version }, /tools\[0\]\.version: is not a version number/)
  }
  refused((doc) => { doc.tools[0].name = 'Docker' }, /tools\[0\]\.name: is not one of the allowed values/)
  refused((doc) => { doc.tools[0].state = 'Found' }, /tools\[0\]\.state: is not one of the allowed values/)
  refused((doc) => { doc.claude.servers[0].scope = 'project' }, /claude\.servers\[0\]\.scope/)
  refused((doc) => { doc.claude.servers[0].transport = 'stdio' }, /claude\.servers\[0\]\.transport/)
  refused((doc) => { doc.claude.servers[0].state = 'Connected' }, /claude\.servers\[0\]\.state/)
  refused((doc) => { doc.claude.live = 'ok' }, /claude\.live/)
})

test('a tool carries a version only when it was found, and each tool appears once', () => {
  refused((doc) => { doc.tools[5].version = '2.63.0' }, /tools\[5\]\.version: is only allowed when the tool was found/)
  refused((doc) => { doc.tools.push({ name: 'Git', state: 'not found' }) }, /tools: names Git twice|tools: names the same entry twice/)
  const noVersion = clone(fixture.sample)
  delete noVersion.tools[0].version
  accepted(noVersion)
})

test('a server name appears once per list, and a plugin once per name and source', () => {
  refused((doc) => { doc.claude.servers.push(clone(doc.claude.servers[0])) }, /claude\.servers: names the same entry twice/)
  refused((doc) => { doc.codex.servers.push({ name: 'playwright' }) }, /codex\.servers: names the same entry twice/)
  refused((doc) => { doc.codex.plugins.push({ name: 'github', from: 'openai-curated' }) }, /codex\.plugins: names the same entry twice/)
  const otherSource = clone(fixture.sample)
  otherSource.codex.plugins.push({ name: 'github', from: 'another-market' })
  accepted(otherSource)
})

test('the caps are the gate\'s, not one more', () => {
  const servers = (count) => Array.from({ length: count }, (_, index) => ({ name: `server ${index}`, scope: 'user', transport: 'local', state: 'not checked' }))
  const named = (count) => Array.from({ length: count }, (_, index) => ({ name: `name ${index}`, from: 'market' }))
  const ok = clone(fixture.sample)
  ok.claude.servers = servers(fixture.caps.claudeServers)
  ok.codex.servers = named(fixture.caps.codexServers).map(({ name }) => ({ name }))
  ok.codex.plugins = named(fixture.caps.codexPlugins)
  accepted(ok)
  refused((doc) => { doc.claude.servers = servers(fixture.caps.claudeServers + 1) }, /claude\.servers: has more than 100/)
  refused((doc) => { doc.codex.servers = named(fixture.caps.codexServers + 1).map(({ name }) => ({ name })) }, /codex\.servers: has more than 50/)
  refused((doc) => { doc.codex.plugins = named(fixture.caps.codexPlugins + 1) }, /codex\.plugins: has more than 60/)
  refused((doc) => {
    doc.tools = Array.from({ length: fixture.caps.tools + 1 }, (_, index) => ({ name: fixture.tools[index % fixture.tools.length], state: 'not found' }))
  }, /tools: has more than 12/)
})

test('counts are whole numbers, and a block that found nothing carries nothing else', () => {
  for (const key of ['projectServers', 'hidden', 'more']) {
    refused((doc) => { doc.claude[key] = -1 }, new RegExp(`claude\\.${key}: is not a whole number`))
    refused((doc) => { doc.claude[key] = 1.5 }, new RegExp(`claude\\.${key}: is not a whole number`))
  }
  refused((doc) => { doc.claude = { status: 'not found', servers: [] } }, /claude\.servers: is not an allowed key/)
  refused((doc) => { doc.codex = { status: 'unavailable', why: 'could not be read', plugins: [] } }, /codex\.plugins: is not an allowed key/)
  const empty = clone(fixture.sample)
  empty.claude = { status: 'not found' }
  empty.codex = { status: 'unavailable', why: 'could not be read' }
  empty.tools = []
  accepted(empty)
  refused((doc) => { delete doc.claude.live }, /claude\.live: is missing/)
  refused((doc) => { doc.claude.servers[0].url = 'x' }, /claude\.servers\[0\]\.url: is not an allowed key/)
  refused((doc) => { doc.claude.servers[0].command = 'x' }, /claude\.servers\[0\]\.command: is not an allowed key/)
  refused((doc) => { doc.extra = 1 }, /extra: is not an allowed key/)
  refused((doc) => { doc.schema = 'agent-status/connections/v2' }, /schema: is not agent-status\/connections\/v1/)
})

// --- the board's expected shape follows from the sample ----------------------------------------------
//
// The board builds its wall from the sample and must produce expectedShape exactly. This rebuilds
// expectedShape from the sample and the label maps alone, so the fixture cannot hold a shape that
// the sample and the words do not explain.

function expectedFrom(sample, contract) {
  const tools = sample.tools.map((tool) => ({ name: tool.name, state: tool.state, label: contract.toolStates[tool.state], version: tool.version ?? null }))
  const servers = sample.claude.servers.map((server) => ({
    name: server.name,
    scope: server.scope,
    scopeLabel: contract.scopes[server.scope],
    transport: server.transport,
    transportLabel: contract.transports[server.transport],
    state: server.state,
    stateLabel: contract.serverStates[server.state]
  }))
  const codexState = (entry) => (entry.enabled === false ? 'turned off' : 'found')
  return {
    computer: sample.computer,
    takenAt: sample.takenAt,
    freshness: Date.parse(contract.expectedShape.now) - Date.parse(sample.takenAt) > contract.staleAfterHours * 3600_000 ? 'stale' : 'fresh',
    tools,
    claude: {
      status: sample.claude.status,
      live: sample.claude.live,
      liveLabel: contract.liveStates[sample.claude.live],
      servers,
      projectServers: sample.claude.projectServers,
      hidden: sample.claude.hidden,
      more: sample.claude.more
    },
    codex: {
      status: sample.codex.status,
      servers: sample.codex.servers.map((entry) => ({ name: entry.name, state: codexState(entry), label: contract.codexStates[codexState(entry)] })),
      plugins: sample.codex.plugins.map((entry) => ({ name: entry.name, from: entry.from, state: codexState(entry), label: contract.codexStates[codexState(entry)] })),
      hidden: sample.codex.hidden,
      more: sample.codex.more
    }
  }
}

test('expectedShape is exactly what the sample and the contract\'s words make', () => {
  assert.equal(fixture.expectedShape.computers.length, 1)
  assert.deepEqual(fixture.expectedShape.computers[0], expectedFrom(fixture.sample, fixture))
  // It uses every state word at least once somewhere a board must show it.
  const words = JSON.stringify(fixture.expectedShape)
  for (const state of ['connected', 'needs sign-in', 'failed', 'waiting for approval', 'seen before']) assert.ok(words.includes(`"${state}"`), state)
})

test('the two repos hold the same connections contract, byte for byte', (t) => {
  const sibling = join(repoRoot, '..', 'agent-cockpit', 'tests', 'fixtures', 'connections-parity.json')
  if (!existsSync(sibling)) {
    t.skip('NOT CHECKED: agent-cockpit has no tests/fixtures/connections-parity.json beside this repo, so the two copies of the connections contract could not be compared. The tests above still check this copy against the collector.')
    return
  }
  assert.equal(readFileSync(sibling, 'utf8'), readFileSync(fixturePath, 'utf8'), 'the shared connections contract has been edited on one side only')
})
