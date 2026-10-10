import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { repoRoot } from './helpers/repo.mjs'
import {
  VAULTS_SCHEMA,
  VAULTS_FOLDER,
  VAULTS_STALE_AFTER_DAYS,
  VAULTS_MAX_FILES_READ,
  VAULTS_MAX_FILE_BYTES,
  VAULTS_CAPS,
  NOTE_MAX_BYTES,
  VAULT_BYTES_BUDGET,
  REWRITE_AFTER_HOURS,
  LEVELS,
  EDGE_KINDS,
  HUB_KINDS,
  MIN_HUB_NOTES,
  MAX_TAGS_PER_NOTE,
  VAULTS_WHY,
  TITLE_RULE,
  VAULTS_SHAPE,
  vaultsPath
} from '../scripts/lib/status/vaults-schema.mjs'
import { MAX_COMPUTERS_SHOWN } from '../scripts/lib/status/connections-schema.mjs'
import { COMPUTER_SLUG, STATUSES } from '../scripts/lib/status/schema.mjs'
import { checkVaults, checkNoteTitle, checkConnectionName } from '../scripts/lib/status/safe.mjs'
import { fakeClaudeToken, FAKE_EMAIL } from './helpers/fake-home.mjs'

/* tests/fixtures/vaults-parity.json is the shared contract for the memory graph - the same bytes in
   agent-team-template and agent-cockpit. The collector writes the file and the board reads it, with
   no import path between them, so each side mirrors the contract by hand and checks its own copy
   against the fixture. These hold the collector's side: every constant, the title rule with the
   examples both sides must agree on, the vault-name rule, and the gate on the whole file, which must
   accept the sample and refuse each way a file can be wrong - above all, any key that could carry a
   note's contents, a path, or a title the owner did not opt in to. */

const fixturePath = join(repoRoot, 'tests', 'fixtures', 'vaults-parity.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const identity = { username: 'fakeperson', home: '/Users/fakeperson', hostname: 'fake-host-77' }
const clone = (value) => structuredClone(value)

test('vaults parity: schema, folder, file name and the board\'s reading limits match', () => {
  assert.equal(VAULTS_SCHEMA, fixture.schema)
  assert.equal(VAULTS_FOLDER, fixture.folder)
  assert.equal(COMPUTER_SLUG.source, fixture.computerSlug)
  assert.equal(VAULTS_STALE_AFTER_DAYS, fixture.staleAfterDays)
  assert.equal(VAULTS_STALE_AFTER_DAYS, 7)
  assert.equal(VAULTS_MAX_FILES_READ, fixture.maxFilesRead)
  assert.equal(VAULTS_MAX_FILE_BYTES, fixture.maxFileBytes)
  assert.equal(VAULTS_MAX_FILE_BYTES, 256 * 1024)
  assert.equal(MAX_COMPUTERS_SHOWN, fixture.maxComputersShown)
  assert.deepEqual(STATUSES, fixture.statuses)
  assert.equal(vaultsPath('Mac Mini'), `${fixture.folder}/mac-mini.json`)
  assert.equal(vaultsPath('???'), null)
})

test('vaults parity: caps, budgets, levels, kinds and the two reasons match', () => {
  assert.deepEqual(VAULTS_CAPS, fixture.caps)
  assert.deepEqual(VAULTS_CAPS, { vaults: 3, notes: 600, lines: 2000, hubs: 200 })
  assert.equal(NOTE_MAX_BYTES, fixture.noteMaxBytes)
  assert.equal(VAULT_BYTES_BUDGET, fixture.vaultBytesBudget)
  assert.ok(VAULTS_CAPS.vaults * VAULT_BYTES_BUDGET < VAULTS_MAX_FILE_BYTES, 'three vaults at their budget must fit the file limit')
  assert.equal(REWRITE_AFTER_HOURS, fixture.rewriteAfterHours)
  assert.equal(REWRITE_AFTER_HOURS, 24)
  assert.deepEqual(LEVELS, fixture.levels)
  assert.deepEqual(LEVELS, ['shape', 'titles'])
  assert.deepEqual(EDGE_KINDS, fixture.edgeKinds)
  assert.deepEqual(EDGE_KINDS, ['link', 'mention', 'day', 'tag'])
  assert.deepEqual(HUB_KINDS, fixture.hubKinds)
  assert.equal(MIN_HUB_NOTES, fixture.minHubNotes)
  assert.equal(MAX_TAGS_PER_NOTE, fixture.maxTagsPerNote)
  assert.deepEqual(VAULTS_WHY, fixture.whyCodes)
  assert.deepEqual(VAULTS_WHY, { unreadable: 'could not be read', refused: 'refused by the safety check' })
})

test('vaults parity: the title rule is written the same way on this side', () => {
  const rule = fixture.titleRule
  assert.equal(TITLE_RULE.maxLength, rule.maxLength)
  assert.deepEqual(TITLE_RULE.never, rule.never)
  assert.equal(TITLE_RULE.neverIgnoresCase, rule.neverIgnoresCase)
  assert.equal(TITLE_RULE.uuid.source, rule.uuid)
  assert.equal(TITLE_RULE.maxSegmentLength, rule.maxSegmentLength)
  assert.equal(TITLE_RULE.separatorCharacters, rule.separatorCharacters)
  assert.equal(TITLE_RULE.separatorsAlsoWhitespace, rule.separatorsAlsoWhitespace)
  assert.equal(TITLE_RULE.controlCharacters.source, rule.controlCharacters)
  assert.equal(TITLE_RULE.invisibleCharacters.source, rule.invisibleCharacters)
})

test('vaults parity: the sample is accepted by the gate', () => {
  assert.deepEqual(checkVaults(fixture.sample, identity), [])
})

test('vaults parity: the contract lists every key a file, a block, a vault, a node and a hub may have - and no other', () => {
  const keysOf = (shape) => Object.keys(shape.keys).sort()
  const allowed = fixture.allowedKeys
  const vault = VAULTS_SHAPE.keys.vaults.found.items.of
  assert.deepEqual([...allowed.file].sort(), keysOf(VAULTS_SHAPE))
  assert.deepEqual([...allowed.blockFound].sort(), ['hidden', 'items', 'more', 'status'])
  assert.deepEqual([...allowed.blockNotFound].sort(), ['status', 'why'])
  assert.deepEqual(Object.keys(VAULTS_SHAPE.keys.vaults.found).sort(), ['hidden', 'items', 'more'])
  assert.deepEqual([...allowed.vault].sort(), keysOf(vault))
  assert.deepEqual([...allowed.node].sort(), keysOf(vault.keys.nodes.of))
  const hubs = vault.keys.hubs.of.variants
  for (const kind of HUB_KINDS) assert.deepEqual([...allowed.hub].sort(), keysOf(hubs[kind]), kind)
  assert.deepEqual([...fixture.requiredKeys.file].sort(), [...VAULTS_SHAPE.required].sort())
  assert.deepEqual([...fixture.requiredKeys.vault].sort(), [...vault.required].sort())
  assert.deepEqual([...fixture.requiredKeys.hub].sort(), [...hubs.day.required].sort())
})

test('vaults parity: this file is the same bytes the board holds', (t) => {
  const sibling = fileURLToPath(new URL('../../agent-cockpit/tests/fixtures/vaults-parity.json', import.meta.url))
  if (!existsSync(sibling)) {
    t.skip('agent-cockpit has no tests/fixtures/vaults-parity.json beside this repo, so the two copies were not compared')
    return
  }
  assert.equal(readFileSync(sibling, 'utf8'), readFileSync(fixturePath, 'utf8'), 'the shared vaults contract has been edited on one side only')
})

// --- the title rule ---------------------------------------------------------------------------------------

test('titles: every accept example passes and every refuse example is refused, whatever the reason', () => {
  for (const title of [...fixture.titleRule.accept, ...fixture.titleRule.acceptEdge.map((entry) => entry.title)]) {
    assert.deepEqual(checkNoteTitle(title, 'title', identity), [], `refused ${JSON.stringify(title)}`)
  }
  for (const { title, why } of fixture.titleRule.refuse) {
    assert.notDeepEqual(checkNoteTitle(title, 'title', identity), [], `accepted ${JSON.stringify(title)} (${why})`)
  }
})

test('titles: each reason is named in its own words', () => {
  const says = (title) => checkNoteTitle(title, 'title', identity).join(' | ')
  assert.match(says(''), /is empty/)
  assert.match(says(' a'), /starts or ends with a space/)
  assert.match(says('a@b'), /contains an at sign/)
  assert.match(says('a/b'), /contains a slash/)
  assert.match(says('a\\b'), /contains a backslash/)
  assert.match(says('my eyJ'), /looks like a signed token/)
  assert.match(says('my sk-'), /looks like a key/)
  assert.match(says('my Bearer'), /looks like an authorization header/)
  assert.match(says('0f0e0d0c-1111-2222-3333'), /looks like an id/)
  assert.match(says('a'.repeat(24)), /24 or more characters without a separator/)
  assert.match(says('a'.repeat(81)), /longer than 80 characters/)
  assert.match(says('a\tb'), /contains a control character/)
  assert.match(says('fakeperson'), /contains the username/)
  assert.match(says('fake-host-77'), /contains the computer name/)
})

test('titles: only text is a title, and a problem never repeats it', () => {
  for (const value of [undefined, null, 7, {}, [], true]) assert.notDeepEqual(checkNoteTitle(value, 'title', identity), [])
  const secret = `notes for ${fakeClaudeToken()}`
  const problems = checkNoteTitle(secret, 'title', identity)
  assert.notDeepEqual(problems, [])
  for (const problem of problems) assert.ok(!problem.includes('ant-oat') && !problem.includes(secret), problem)
})

test('titles: the owner\'s username, computer name and home folder are refused, in any case, inside a longer title', () => {
  for (const title of ['Notes for FakePerson', 'fakeperson plan', 'On fake-host-77', 'FAKE-HOST-77 backup', 'Stuff in /Users/fakeperson']) {
    assert.notDeepEqual(checkNoteTitle(title, 'title', identity), [], title)
  }
  // Two letters is not an identity: it would refuse most titles.
  assert.deepEqual(checkNoteTitle('Ma plan', 'title', { username: 'ma' }), [])
})

test('titles: the limits are exact - 80 characters pass, 81 do not; 23 between separators pass, 24 do not', () => {
  const eighty = 'abcdefgh '.repeat(9).trim()
  assert.equal(eighty.length, 80)
  assert.deepEqual(checkNoteTitle(eighty, 'title', identity), [])
  assert.notDeepEqual(checkNoteTitle(`${eighty}x`, 'title', identity), [])
  assert.deepEqual(checkNoteTitle(`${'a'.repeat(23)} ${'b'.repeat(23)}`, 'title', identity), [])
  assert.notDeepEqual(checkNoteTitle('a'.repeat(24), 'title', identity), [])
  // Every separator character splits a run, and a stretch is counted between them.
  for (const separator of [...fixture.titleRule.separatorCharacters, ' ']) {
    assert.deepEqual(checkNoteTitle(`${'a'.repeat(20)}${separator}${'b'.repeat(20)}`, 'title', identity), [], JSON.stringify(separator))
  }
  assert.notDeepEqual(checkNoteTitle(`${'a'.repeat(12)}${'b'.repeat(12)}`, 'title', identity), [])
})

test('titles: a vault is named under the connection-name rule', () => {
  for (const name of fixture.names.vaultAccept) assert.deepEqual(checkConnectionName(name, 'name', identity), [], name)
  for (const { name, why } of fixture.names.vaultRefuse) assert.notDeepEqual(checkConnectionName(name, 'name', identity), [], `${JSON.stringify(name)} (${why})`)
})

// --- the gate ----------------------------------------------------------------------------------------------

const refused = (change, pattern) => {
  const doc = clone(fixture.sample)
  change(doc)
  const problems = checkVaults(doc, identity)
  assert.notDeepEqual(problems, [], 'the gate accepted a file it should have refused')
  if (pattern) assert.ok(problems.some((problem) => pattern.test(problem)), `no problem matched ${pattern}: ${problems.join(' | ')}`)
  return problems
}
const accepted = (change) => {
  const doc = clone(fixture.sample)
  change?.(doc)
  assert.deepEqual(checkVaults(doc, identity), [])
}
const shapeVault = (doc) => doc.vaults.items[0]
const titlesVault = (doc) => doc.vaults.items[1]

test('gate: a block that found nothing carries a status and, at most, one of the two fixed reasons', () => {
  accepted((doc) => { doc.vaults = { status: 'not found' } })
  accepted((doc) => { doc.vaults = { status: 'unavailable', why: VAULTS_WHY.unreadable } })
  accepted((doc) => { doc.vaults = { status: 'unavailable', why: VAULTS_WHY.refused } })
  refused((doc) => { doc.vaults = { status: 'not found', items: [] } }, /items: is not an allowed key/)
  refused((doc) => { doc.vaults = { status: 'maybe' } }, /status: is not one of the allowed values/)
  refused((doc) => { doc.vaults = { status: 'found' } }, /missing/)
})

test('gate: the free text of a block cannot carry a message', () => {
  refused((doc) => { doc.vaults = { status: 'unavailable', why: `Error opening /Users/fakeperson/Vaults/Secret: ${fakeClaudeToken()}` } })
  refused((doc) => { doc.vaults = { status: 'not found', why: FAKE_EMAIL } })
})

test('gate: no key outside the contract anywhere - a note\'s text, a path, a heading, an excerpt cannot be added', () => {
  for (const [where, change] of [
    ['the file', (doc) => { doc.path = 'x' }],
    ['the block', (doc) => { doc.vaults.path = 'x' }],
    ['a vault', (doc) => { shapeVault(doc).path = 'x' }],
    ['a vault', (doc) => { shapeVault(doc).contents = 'a private paragraph' }],
    ['a vault', (doc) => { shapeVault(doc).location = 'x' }],
    ['a node', (doc) => { titlesVault(doc).nodes[0].excerpt = 'private' }],
    ['a node', (doc) => { titlesVault(doc).nodes[0].path = 'Plans/Weekly plan.md' }],
    ['a node', (doc) => { titlesVault(doc).nodes[0].heading = 'private' }],
    ['a hub', (doc) => { titlesVault(doc).hubs[0].notes = [0, 1] }]
  ]) {
    refused(change, /is not an allowed key/)
    assert.ok(where)
  }
})

test('gate: a title is held to the title rule wherever it appears, and a problem never repeats it', () => {
  const bad = [
    `Dr Smith ${FAKE_EMAIL}`, fakeClaudeToken(), 'Bearer abc123', 'eyJhbGciOiJIUzI1NiJ9', 'x'.repeat(81),
    'path/in/title', 'Notes by fakeperson', '0f0e0d0c-1111-2222-3333-444455556666', 'a'.repeat(24), '', ' padded'
  ]
  for (const title of bad) {
    for (const change of [
      (doc) => { titlesVault(doc).nodes[0].title = title },
      (doc) => { titlesVault(doc).nodes[0].folder = title },
      (doc) => { titlesVault(doc).hubs[1].label = title }
    ]) {
      const problems = refused(change)
      for (const problem of problems) assert.ok(!problem.includes('Smith') && !problem.includes('abc123'), problem)
    }
  }
})

test('gate: a vault name is held to the connection-name rule', () => {
  for (const name of ['notes@home', 'my/notes', 'Desk-helper', 'x'.repeat(61), '', fakeClaudeToken()]) {
    refused((doc) => { shapeVault(doc).name = name }, /name:/)
  }
  refused((doc) => { shapeVault(doc).name = 'Notes of fakeperson' }, /name:/)
})

test('gate: the two levels carry what they should and nothing else', () => {
  // shape: counts and edges only.
  refused((doc) => { shapeVault(doc).nodes = [{}, {}, {}, {}, {}, {}] }, /nodes: is only allowed at the titles level/)
  refused((doc) => { shapeVault(doc).hubs = [{ kind: 'day', label: '2026-10-09' }] }, /hubs: is only allowed at the titles level/)
  refused((doc) => { shapeVault(doc).untitled = 0 }, /untitled: is only allowed at the titles level/)
  refused((doc) => { shapeVault(doc).edges.push([0, 6, 2]) }, /kind|hub|titles/)
  refused((doc) => { shapeVault(doc).edges.push([4, 5, 3]) }, /kind|hub|titles/)
  // titles: a node for every dot, and a count of the anonymous ones.
  refused((doc) => { delete titlesVault(doc).nodes }, /nodes: is missing/)
  refused((doc) => { delete titlesVault(doc).untitled }, /untitled: is missing/)
  refused((doc) => { titlesVault(doc).nodes.pop() }, /nodes: does not have one entry per note/)
  refused((doc) => { titlesVault(doc).untitled = 0 }, /untitled: is not the number of nodes with no title/)
  refused((doc) => { shapeVault(doc).level = 'contents' }, /level: is not one of the allowed values/)
})

test('gate: the numbers add up - notes, lines, lonely - or the file is refused', () => {
  refused((doc) => { shapeVault(doc).lines = 4 }, /lines: is not the number of edges/)
  refused((doc) => { shapeVault(doc).lonely = 7 }, /lonely: is more than the notes/)
  refused((doc) => { shapeVault(doc).notes = -1 }, /notes:/)
  refused((doc) => { shapeVault(doc).notes = 601 }, /notes:/)
  refused((doc) => { shapeVault(doc).hidden = -1 }, /hidden:/)
  refused((doc) => { shapeVault(doc).more = 1.5 }, /more:/)
  refused((doc) => { shapeVault(doc).moreLines = 'many' }, /moreLines:/)
  for (const key of ['name', 'level', 'notes', 'lines', 'lonely', 'hidden', 'more', 'moreLines', 'edges']) {
    refused((doc) => { delete shapeVault(doc)[key] }, new RegExp(`${key}: is missing`))
  }
})

test('gate: every edge joins two dots by a named kind, once', () => {
  refused((doc) => { shapeVault(doc).edges.push([0, 99, 0]); shapeVault(doc).lines += 1 }, /edges\[5\]/)
  refused((doc) => { shapeVault(doc).edges.push([0, 1, 4]); shapeVault(doc).lines += 1 }, /edges\[5\]/)
  refused((doc) => { shapeVault(doc).edges.push([-1, 1, 0]); shapeVault(doc).lines += 1 }, /edges\[5\]/)
  refused((doc) => { shapeVault(doc).edges.push([0, 1, 0, 0]); shapeVault(doc).lines += 1 }, /edges\[5\]/)
  refused((doc) => { shapeVault(doc).edges.push([0, 1]); shapeVault(doc).lines += 1 }, /edges\[5\]/)
  refused((doc) => { shapeVault(doc).edges.push(['0', '1', '0']); shapeVault(doc).lines += 1 }, /edges\[5\]/)
  refused((doc) => { shapeVault(doc).edges.push([1, 1, 0]); shapeVault(doc).lines += 1 }, /edges\[5\]: has no direction|from is not below to/)
  refused((doc) => { shapeVault(doc).edges.push([3, 1, 0]); shapeVault(doc).lines += 1 }, /from is not below to/)
  refused((doc) => { shapeVault(doc).edges.push([0, 1, 0]); shapeVault(doc).lines += 1 }, /names the same entry twice/)
})

test('gate: a hub is a dot after the notes, joined only to notes, of the right kind, by at least two', () => {
  accepted((doc) => { titlesVault(doc).hubs.push({ kind: 'tag', label: 'extra' }); titlesVault(doc).edges.push([0, 7, 3], [4, 7, 3]); titlesVault(doc).lines += 2 })
  refused((doc) => { titlesVault(doc).edges[2] = [0, 6, 2] }, /edges\[2\]: is not the kind of the hub it goes to/)
  refused((doc) => { titlesVault(doc).edges[4] = [2, 5, 3] }, /edges\[4\]: is not the kind of the hub it goes to/)
  refused((doc) => { titlesVault(doc).edges.push([5, 6, 2]); titlesVault(doc).lines += 1 }, /hub|note/)
  refused((doc) => { titlesVault(doc).edges.push([1, 9, 2]); titlesVault(doc).lines += 1 }, /edges\[6\]/)
  refused((doc) => { titlesVault(doc).edges = titlesVault(doc).edges.filter((edge) => edge[1] !== 6 || edge[0] !== 3); titlesVault(doc).lines -= 1 }, /fewer than 2 notes/)
  refused((doc) => { titlesVault(doc).hubs[0].kind = 'month' }, /kind: is not one of the allowed values/)
  refused((doc) => { titlesVault(doc).hubs[0].label = 'yesterday' }, /label: is not a calendar day/)
  refused((doc) => { titlesVault(doc).hubs.push({ kind: 'day', label: '2026-10-09' }) }, /names the same entry twice/)
  refused((doc) => { titlesVault(doc).nodes[0].day = '2026-02-31' }, /day: is not a calendar day/)
})

test('gate: the caps hold - three vaults, 600 notes, 2,000 lines, 200 hubs, no vault twice', () => {
  refused((doc) => { doc.vaults.items.push({ ...clone(shapeVault(doc)), name: 'Third' }, { ...clone(shapeVault(doc)), name: 'Fourth' }) }, /items: has more than 3 entries/)
  refused((doc) => { doc.vaults.items[1].name = doc.vaults.items[0].name }, /names the same entry twice/)
  refused((doc) => {
    const vault = shapeVault(doc)
    vault.notes = 600
    vault.edges = Array.from({ length: 2001 }, (_, index) => [0, 1 + (index % 599), 0])
    vault.lines = 2001
  }, /edges: has more than 2000 entries/)
  refused((doc) => {
    const vault = titlesVault(doc)
    vault.hubs = Array.from({ length: 201 }, (_, index) => ({ kind: 'tag', label: `tag ${index}` }))
  }, /hubs: has more than 200 entries/)
  refused((doc) => {
    const vault = titlesVault(doc)
    vault.notes = 601
    vault.nodes = Array.from({ length: 601 }, () => ({}))
  }, /notes:|nodes: has more than 600 entries/)
})

test('gate: a file that is not this contract is refused as a whole', () => {
  refused((doc) => { doc.schema = 'agent-status/vaults/v2' }, /schema:/)
  refused((doc) => { doc.takenAt = 'yesterday' }, /takenAt:/)
  refused((doc) => { doc.computer = FAKE_EMAIL }, /computer:/)
  for (const key of ['schema', 'takenAt', 'computer', 'vaults']) refused((doc) => { delete doc[key] }, new RegExp(`${key}: is missing`))
  assert.notDeepEqual(checkVaults(null, identity), [])
  assert.notDeepEqual(checkVaults([], identity), [])
  assert.notDeepEqual(checkVaults('text', identity), [])
})

test('gate: no problem it reports ever contains the text it refused', () => {
  const doc = clone(fixture.sample)
  doc.computer = 'private-computer@example.test'
  titlesVault(doc).nodes[0].title = 'a private paragraph about Dr Smith and a diagnosis ' + fakeClaudeToken()
  titlesVault(doc).nodes[1].folder = FAKE_EMAIL
  shapeVault(doc).secretKey = 'value'
  shapeVault(doc)[fakeClaudeToken()] = 'value'
  for (const problem of checkVaults(doc, identity)) {
    for (const forbidden of ['Smith', 'diagnosis', 'example.test', 'ant-oat', FAKE_EMAIL]) assert.ok(!problem.includes(forbidden), problem)
  }
})
