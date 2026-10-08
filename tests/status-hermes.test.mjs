import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  hermesRoot,
  collectHermes,
  modelFromConfig,
  sessionsQuery
} from '../scripts/lib/status/hermes.mjs'
import { SqliteMissing } from '../scripts/lib/status/sqlite.mjs'
import { checkHermes } from '../scripts/lib/status/safe.mjs'
import { makeFakeHome, execStub, FAKE_USERNAME } from './helpers/fake-home.mjs'
import { HAVE_SQLITE, NO_SQLITE_SKIP, SESSION_COLUMNS, makeStateDb, recordingOpener, writeHermes } from './helpers/hermes-home.mjs'

/* The Hermes part: what is on the Hermes card, read from Hermes's own files and never by running
   Hermes. `hermes --version` is not read-only - run once, it tried to finish an update and rewrote
   a file - so nothing here may start a program at all. Times come from the real clock: a test pinned
   to a date would start failing once that date had passed. */

const NOW = Date.now()
const DAY = 86400_000
const deps = (fake, extra = {}) => ({ home: fake.home, env: {}, platform: 'linux', now: NOW, identity: fake.identity, exec: execStub(() => new Error('no program may run')), ...extra })
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

// --- where Hermes lives -------------------------------------------------------------------------------

test('Hermes\'s home is found the way Hermes finds it', () => {
  assert.equal(hermesRoot({ home: '/h', env: { HERMES_HOME: '/custom/hermes' }, platform: 'darwin' }), '/custom/hermes')
  assert.equal(hermesRoot({ home: '/h', env: {}, platform: 'darwin' }), join('/h', '.hermes'))
  assert.equal(hermesRoot({ home: '/h', env: {}, platform: 'linux' }), join('/h', '.hermes'))
  assert.equal(hermesRoot({ home: 'C:\\h', env: { LOCALAPPDATA: 'C:\\h\\AppData\\Local' }, platform: 'win32' }), join('C:\\h\\AppData\\Local', 'hermes'))
  assert.equal(hermesRoot({ home: 'C:\\h', env: {}, platform: 'win32' }), join('C:\\h', 'AppData', 'Local', 'hermes'))
  // HERMES_HOME pointing at one profile (<root>/profiles/<name>) runs that profile; the root is two up.
  assert.equal(hermesRoot({ home: '/h', env: { HERMES_HOME: '/srv/hermes/profiles/coder' }, platform: 'linux' }), '/srv/hermes')
  assert.equal(hermesRoot({ home: '/h', env: { HERMES_HOME: '~/elsewhere' }, platform: 'linux' }), join('/h', 'elsewhere'))
  // A relative HERMES_HOME is not a place anybody chose on purpose.
  assert.equal(hermesRoot({ home: '/h', env: { HERMES_HOME: 'relative' }, platform: 'linux' }), join('/h', '.hermes'))
  assert.equal(hermesRoot({ home: '/h', env: { HERMES_HOME: '  ' }, platform: 'linux' }), join('/h', '.hermes'))
})

test('no Hermes at all: install, gateway and profiles are not found, and nothing else is written', async () => {
  const fake = await makeFakeHome()
  try {
    const d = deps(fake)
    const doc = await collectHermes(d, 'Test PC')
    assert.deepEqual(doc, {
      schema: 'agent-status/hermes/v1',
      takenAt: iso(NOW),
      computer: 'Test PC',
      install: { status: 'not found' },
      gateway: { status: 'not found' },
      profiles: { status: 'not found' }
    })
    assert.deepEqual(checkHermes(doc, fake.identity), [])
    assert.equal(d.exec.calls.length, 0)
  } finally {
    await fake.cleanup()
  }
})

test('Hermes is never run: the exec seam is not called once, whatever is in the home', async () => {
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now: NOW, profiles: { donna: { 'config.yaml': 'model: gpt-5.1\n' } } })
    await fake.write('.hermes/bin/hermes', '#!/bin/sh\necho ran\n')
    const d = deps(fake)
    const doc = await collectHermes(d, 'Test PC')
    assert.equal(doc.install.status, 'found')
    assert.equal(d.exec.calls.length, 0, 'the Hermes part started a program')
  } finally {
    await fake.cleanup()
  }
})

// --- install: version and update ----------------------------------------------------------------------

test('the version comes from pyproject.toml or hermes_cli, and "update available" only from a fresh .update_check for that version', async () => {
  const cases = [
    [{ ts: NOW / 1000 - 3600, behind: 12389, ver: '0.21.3' }, { status: 'found', version: '0.21.3', updateAvailable: true }],
    [{ ts: NOW / 1000 - 3600, behind: 0, ver: '0.21.3' }, { status: 'found', version: '0.21.3', updateAvailable: false }],
    // Eight days old: too old to say.
    [{ ts: NOW / 1000 - 8 * 86400, behind: 5, ver: '0.21.3' }, { status: 'found', version: '0.21.3' }],
    // Made for another version: Hermes itself would not trust it either.
    [{ ts: NOW / 1000 - 3600, behind: 5, ver: '0.20.0' }, { status: 'found', version: '0.21.3' }],
    // The check failed (behind null), or the file is not JSON.
    [{ ts: NOW / 1000 - 3600, behind: null, ver: '0.21.3' }, { status: 'found', version: '0.21.3' }],
    ['not json', { status: 'found', version: '0.21.3' }],
    [{ ts: 'yesterday', behind: 5, ver: '0.21.3' }, { status: 'found', version: '0.21.3' }]
  ]
  for (const [check, expected] of cases) {
    const fake = await makeFakeHome()
    try {
      await writeHermes(fake, { now: NOW })
      await fake.write('.hermes/.update_check', check)
      const doc = await collectHermes(deps(fake), 'Test PC')
      assert.deepEqual(doc.install, expected, JSON.stringify(check))
    } finally {
      await fake.cleanup()
    }
  }
  const fake = await makeFakeHome()
  try {
    await fake.write('.hermes/hermes-agent/hermes_cli/__init__.py', '"""Hermes."""\n__version__ = "0.22.0"\n')
    assert.deepEqual((await collectHermes(deps(fake), 'Test PC')).install, { status: 'found', version: '0.22.0' })
    await fake.write('.hermes/hermes-agent/pyproject.toml', '[project]\nversion = "unknown"\n')
    await fake.write('.hermes/hermes-agent/hermes_cli/__init__.py', '__version__ = "not a version"\n')
    assert.deepEqual((await collectHermes(deps(fake), 'Test PC')).install, { status: 'found' }, 'found, with no version invented')
  } finally {
    await fake.cleanup()
  }
})

// --- gateway --------------------------------------------------------------------------------------------

test('the gateway: its state and when it last stamped the file, and nothing else from it', async () => {
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now: NOW, gateway: null })
    const write = (content) => fake.write('.hermes/gateway_state.json', content)
    const gateway = async () => (await collectHermes(deps(fake), 'Test PC')).gateway
    assert.deepEqual(await gateway(), { status: 'not found' })
    const stamp = new Date(NOW - 42_000)
    await write({ pid: 4242, argv: [`/Users/${FAKE_USERNAME}/.hermes/venv/bin/python`, '--token', 'x'], gateway_state: 'running', updated_at: `${stamp.toISOString().slice(0, 19)}.123456+00:00`, platforms: { telegram: { chat_id: 'x' } } })
    assert.deepEqual(await gateway(), { status: 'found', state: 'running', beatAt: iso(Math.floor(stamp.getTime() / 1000) * 1000) })
    // An old epoch-seconds stamp, a naive time (Hermes reads it as UTC), and a state Hermes does not write.
    await write({ gateway_state: 'startup_failed', updated_at: Math.floor(NOW / 1000) - 600 })
    assert.deepEqual(await gateway(), { status: 'found', state: 'startup_failed', beatAt: iso(Math.floor(NOW / 1000) * 1000 - 600_000) })
    await write({ gateway_state: 'draining', updated_at: '2026-10-08T14:59:12' })
    assert.deepEqual(await gateway(), { status: 'found', state: 'unknown', beatAt: '2026-10-08T14:59:12Z' })
    // A time that cannot be believed is left out, not guessed.
    await write({ gateway_state: 'running', updated_at: 0 })
    assert.deepEqual(await gateway(), { status: 'found', state: 'running' })
    await write({ gateway_state: 'running', updated_at: iso(NOW + 3 * DAY) })
    assert.deepEqual(await gateway(), { status: 'found', state: 'running' })
    await write({ updated_at: 'soon' })
    assert.deepEqual(await gateway(), { status: 'found', state: 'unknown' })
    await write('{ half a file')
    assert.deepEqual(await gateway(), { status: 'unavailable', why: 'could not be read' })
    await write([])
    assert.deepEqual(await gateway(), { status: 'unavailable', why: 'could not be read' })
  } finally {
    await fake.cleanup()
  }
})

// --- profiles -------------------------------------------------------------------------------------------

test('profiles: the home is "default" and comes first, then the rest A to Z, twelve at most', async () => {
  const fake = await makeFakeHome()
  try {
    const names = ['zeta', 'alpha', 'mike', 'bravo', 'kilo', 'echo', 'golf', 'hotel', 'india', 'juliet', 'lima', 'charlie', 'delta']
    await writeHermes(fake, { now: NOW, profiles: Object.fromEntries(names.map((name) => [name, { 'config.yaml': 'model: x\n' }])) })
    const doc = await collectHermes(deps(fake), 'Test PC')
    assert.equal(doc.profiles.status, 'found')
    assert.deepEqual(doc.profiles.items.map((item) => item.name), ['default', 'alpha', 'bravo', 'charlie', 'delta', 'echo', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'])
    assert.equal(doc.profiles.more, 2)
    assert.equal(doc.profiles.hidden, 0)
    assert.deepEqual(checkHermes(doc, fake.identity), [])
  } finally {
    await fake.cleanup()
  }
})

test('profiles: only folders Hermes would list; names the board would refuse are hidden, never written', async () => {
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, {
      now: NOW,
      profiles: {
        donna: { 'SOUL.md': 'private' },
        coder: { '.env': 'KEY=private' },
        // No file that makes it a profile: a folder left behind by a cron tick or a cache.
        ghost: { 'logs/x.log': 'x' },
        // Deleted: Hermes leaves a tombstone beside the folder.
        gone: { 'config.yaml': 'model: x\n' },
        // Names that fail: a capital letter, the username, a long run.
        Work: { 'config.yaml': 'model: x\n' },
        [FAKE_USERNAME]: { 'config.yaml': 'model: x\n' },
        abcdefghijklmnopqrstuvwxyz: { 'config.yaml': 'model: x\n' }
      }
    })
    await fake.write('.hermes/profiles/.deleted/gone', 'deleted\n')
    await fake.write('.hermes/profiles/notes.txt', 'a file, not a folder')
    const doc = await collectHermes(deps(fake), 'Test PC')
    assert.deepEqual(doc.profiles.items.map((item) => item.name), ['default', 'coder', 'donna'])
    assert.equal(doc.profiles.hidden, 3)
    assert.equal(doc.profiles.more, 0)
    assert.ok(!JSON.stringify(doc).includes(FAKE_USERNAME))
    assert.deepEqual(checkHermes(doc, fake.identity), [])
  } finally {
    await fake.cleanup()
  }
})

// --- model: model.default and model.provider, and no other line --------------------------------------------

test('the model: the block form and the plain form, and never base_url or any other key', () => {
  const cases = [
    ['model:\n  default: anthropic/claude-opus-5-5\n  provider: openrouter\n  base_url: https://x.example.com/v1?key=k\n', { default: 'anthropic/claude-opus-5-5', provider: 'openrouter' }],
    ['model:\n  base_url: "https://x.example.com"\n  provider: "anthropic"   # chosen in setup\n  default: \'claude-opus-5-5\'\n', { default: 'claude-opus-5-5', provider: 'anthropic' }],
    ['model: gpt-5.1   # the plain form\nprovider: should-not-be-read\n', { default: 'gpt-5.1' }],
    ['model: "openrouter/anthropic/claude-sonnet-4.5"\n', { default: 'openrouter/anthropic/claude-sonnet-4.5' }],
    // Children of children belong to something else.
    ['model:\n  options:\n    default: nested-not-this\n  default: this-one\n', { default: 'this-one' }],
    // Only a model: at the start of a line is the top-level key.
    ['auxiliary:\n  model: aux-model\n  provider: aux\nmodel:\n  provider: anthropic\n', { provider: 'anthropic' }],
    // A key after the block is not part of it.
    ['model:\n  default: m1\nsecrets:\n  default: sk-not-this\n', { default: 'm1' }],
    // Forms this reader does not follow: nothing, rather than a guess.
    ['model: {default: x, provider: y}\n', {}],
    ['model: |\n  default: x\n', {}],
    ['model:\n  default: "escaped \\" quote"\n', {}],
    ['model: ~\n', {}],
    ['model:\n', {}],
    ['', {}],
    ['providers:\n  anthropic:\n    api_key: k\n', {}],
    ['model:\r\n  default: windows-line-endings\r\n  provider: anthropic\r\n', { default: 'windows-line-endings', provider: 'anthropic' }],
    // The last one wins, as in Hermes's own YAML reader.
    ['model:\n  default: first\n  default: second\n', { default: 'second' }]
  ]
  for (const [text, expected] of cases) assert.deepEqual(modelFromConfig(text), expected, JSON.stringify(text))
})

test('the model on the card: the last segment, with its provider, and nothing that fails the name rule', async () => {
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, {
      now: NOW,
      profiles: {
        alpha: { 'config.yaml': 'model:\n  default: openrouter/anthropic/claude-sonnet-4.5\n  provider: openrouter\n' },
        bravo: { 'config.yaml': 'model:\n  provider: anthropic\n' },
        charlie: { 'config.yaml': 'model:\n  default: custom/sk-live-model\n  provider: custom\n' },
        delta: { 'config.yaml': 'model:\n  default: gpt-5.1\n  provider: https://api.example.com\n' },
        echo: { 'config.yaml': `model:\n  default: ${FAKE_USERNAME}-model\n` },
        foxtrot: { 'config.yaml': 'model: |\n  odd\n' }
      }
    })
    const doc = await collectHermes(deps(fake), 'Test PC')
    const byName = Object.fromEntries(doc.profiles.items.map((item) => [item.name, item]))
    const pick = (item) => ({ model: item.model, provider: item.provider })
    assert.deepEqual(pick(byName.default), { model: 'claude-opus-5-5', provider: 'anthropic' })
    assert.deepEqual(pick(byName.alpha), { model: 'claude-sonnet-4.5', provider: 'openrouter' })
    // A provider without a model is not written: "via anthropic" says nothing.
    assert.deepEqual(pick(byName.bravo), { model: undefined, provider: undefined })
    assert.deepEqual(pick(byName.charlie), { model: undefined, provider: undefined })
    assert.deepEqual(pick(byName.delta), { model: 'gpt-5.1', provider: undefined })
    assert.deepEqual(pick(byName.echo), { model: undefined, provider: undefined })
    assert.deepEqual(pick(byName.foxtrot), { model: undefined, provider: undefined })
    assert.deepEqual(checkHermes(doc, fake.identity), [])
  } finally {
    await fake.cleanup()
  }
})

// --- skills ---------------------------------------------------------------------------------------------

test('skills: every SKILL.md at any depth is counted, and no skill file is read', async () => {
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, {
      now: NOW,
      profiles: {
        alpha: { 'config.yaml': 'model: x\n', 'skills/a/b/c/d/SKILL.md': 'x', 'skills/a/SKILL.md': 'x', 'skills/a/SKILL.txt': 'not this one', 'skills/README.md': 'x' },
        bravo: { 'config.yaml': 'model: x\n' },
        charlie: { 'config.yaml': 'model: x\n', 'skills/.keep': '' }
      }
    })
    const doc = await collectHermes(deps(fake), 'Test PC')
    const skills = Object.fromEntries(doc.profiles.items.map((item) => [item.name, item.skills]))
    assert.deepEqual(skills, {
      default: { status: 'found', count: 2 },
      alpha: { status: 'found', count: 2 },
      bravo: { status: 'not found' },
      charlie: { status: 'found', count: 0 }
    })
  } finally {
    await fake.cleanup()
  }
})

// --- the scheduler's beat -----------------------------------------------------------------------------------

test('the scheduler beat: the time in cron/ticker_heartbeat, and only a time', async () => {
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, {
      now: NOW,
      profiles: {
        alpha: { 'config.yaml': 'model: x\n', 'cron/ticker_heartbeat': '1789851263.7487671' },
        bravo: { 'config.yaml': 'model: x\n', 'cron/ticker_heartbeat': '{"pid": 1, "argv": ["x"]}' },
        charlie: { 'config.yaml': 'model: x\n' },
        delta: { 'config.yaml': 'model: x\n', 'cron/ticker_heartbeat': String(NOW / 1000 + 5 * 86400) }
      }
    })
    const doc = await collectHermes(deps(fake), 'Test PC')
    const beats = Object.fromEntries(doc.profiles.items.map((item) => [item.name, item.scheduler]))
    assert.deepEqual(beats.alpha, { status: 'found', beatAt: '2026-09-19T20:54:23Z' })
    assert.deepEqual(beats.bravo, { status: 'unavailable', why: 'could not be read' })
    assert.deepEqual(beats.charlie, { status: 'not found' })
    assert.deepEqual(beats.delta, { status: 'unavailable', why: 'could not be read' }, 'a beat days in the future is not believed')
    assert.equal(beats.default.status, 'found')
  } finally {
    await fake.cleanup()
  }
})

// --- sessions: one fixed, read-only question to state.db --------------------------------------------------

const hoursAgo = (hours) => (NOW - hours * 3600_000) / 1000

function sessionRows() {
  return [
    // Counted as conversations: anything not cron, delegate or subagent, top-level, in the last 7 days.
    { id: 'a', source: 'cli', started_at: hoursAgo(2), last_activity_at: hoursAgo(1), title: 'secret-client plan', cwd: '/Users/x/secret-client', user_id: 'u' },
    { id: 'b', source: 'telegram', started_at: hoursAgo(30), ended_at: hoursAgo(29), chat_id: 'c' },
    { id: 'c', source: 'slack', started_at: hoursAgo(6 * 24) },
    // Scheduled runs.
    { id: 'd', source: 'cron', started_at: hoursAgo(3), ended_at: hoursAgo(2.5) },
    { id: 'e', source: 'cron', started_at: hoursAgo(27) },
    // Not counted: delegated and subagent sessions, child sessions, and anything older than 7 days.
    { id: 'f', source: 'delegate', started_at: hoursAgo(1) },
    { id: 'g', source: 'subagent', started_at: hoursAgo(1) },
    { id: 'h', source: 'cli', parent_session_id: 'a', started_at: hoursAgo(1), last_activity_at: hoursAgo(0.1) },
    { id: 'i', source: 'cli', started_at: hoursAgo(8 * 24) },
    { id: 'j', source: 'cron', started_at: hoursAgo(9 * 24) }
  ]
}

test('sessions: conversations and scheduled runs in the last 7 days, and when it was last active', { skip: !HAVE_SQLITE && NO_SQLITE_SKIP }, async () => {
  const fake = await makeFakeHome()
  try {
    const root = await writeHermes(fake, { now: NOW })
    const db = await makeStateDb(join(root, 'state.db'), sessionRows())
    const before = createHash('sha256').update(await readFile(db)).digest('hex')
    const open = recordingOpener()
    const doc = await collectHermes(deps(fake, { openSqlite: open }), 'Test PC')
    assert.deepEqual(doc.profiles.items[0].sessions, { status: 'found', days: 7, conversations: 3, scheduled: 2, lastActiveAt: iso(Math.floor(hoursAgo(1)) * 1000) })
    // Exactly two statements, both questions: the column check, and the one fixed count.
    assert.equal(open.statements.length, 2)
    assert.equal(open.statements[0], 'PRAGMA table_info(sessions)')
    assert.match(open.statements[1], /^SELECT /)
    for (const sql of open.statements) {
      assert.doesNotMatch(sql, /\b(insert|update|delete|drop|create|alter|attach|replace|vacuum)\b/i)
      assert.doesNotMatch(sql, /\b(title|cwd|user_id|chat_id|git_repo_root|billing_base_url|model)\b/)
    }
    // The file is exactly as it was.
    assert.equal(createHash('sha256').update(await readFile(db)).digest('hex'), before)
    assert.ok(!JSON.stringify(doc).includes('secret-client'))
  } finally {
    await fake.cleanup()
  }
})

test('sessions: the real opener reads the same answer, and leaves the file as it was', { skip: !HAVE_SQLITE && NO_SQLITE_SKIP }, async () => {
  const fake = await makeFakeHome()
  try {
    const root = await writeHermes(fake, { now: NOW })
    const db = await makeStateDb(join(root, 'state.db'), sessionRows())
    const before = createHash('sha256').update(await readFile(db)).digest('hex')
    const doc = await collectHermes(deps(fake), 'Test PC')
    assert.equal(doc.profiles.items[0].sessions.conversations, 3)
    assert.equal(doc.profiles.items[0].sessions.scheduled, 2)
    assert.equal(createHash('sha256').update(await readFile(db)).digest('hex'), before)
  } finally {
    await fake.cleanup()
  }
})

test('sessions: an older table without the optional columns still answers', { skip: !HAVE_SQLITE && NO_SQLITE_SKIP }, async () => {
  const fake = await makeFakeHome()
  try {
    const root = await writeHermes(fake, { now: NOW })
    const columns = SESSION_COLUMNS.filter((column) => !/^(parent_session_id|last_activity_at|ended_at) /.test(column))
    const rows = sessionRows().map(({ parent_session_id: _p, last_activity_at: _l, ended_at: _e, ...row }) => row)
    await makeStateDb(join(root, 'state.db'), rows, { columns })
    const doc = await collectHermes(deps(fake), 'Test PC')
    // With no parent column the child session counts too; with no activity column the newest start is it.
    assert.deepEqual(doc.profiles.items[0].sessions, { status: 'found', days: 7, conversations: 4, scheduled: 2, lastActiveAt: iso(Math.floor(hoursAgo(1)) * 1000) })
  } finally {
    await fake.cleanup()
  }
})

test('sessions: a layout it does not know, no state.db, or a file that is not a database, is never a zero', { skip: !HAVE_SQLITE && NO_SQLITE_SKIP }, async () => {
  const fake = await makeFakeHome()
  try {
    const root = await writeHermes(fake, {
      now: NOW,
      profiles: {
        alpha: { 'config.yaml': 'model: x\n' },
        bravo: { 'config.yaml': 'model: x\n', 'state.db': 'this is not a database' },
        charlie: { 'config.yaml': 'model: x\n' }
      }
    })
    await makeStateDb(join(root, 'state.db'), [{ id: 'a', when_it_was: 1 }], { columns: ['id TEXT', 'when_it_was REAL'] })
    await makeStateDb(join(root, 'profiles', 'charlie', 'state.db'), [{ id: 'a', source: 'cli' }], { columns: ['id TEXT', 'source TEXT'] })
    const doc = await collectHermes(deps(fake), 'Test PC')
    const sessions = Object.fromEntries(doc.profiles.items.map((item) => [item.name, item.sessions]))
    assert.deepEqual(sessions, {
      default: { status: 'unavailable', why: 'not a layout this collector knows' },
      alpha: { status: 'not found' },
      bravo: { status: 'unavailable', why: 'could not be read' },
      charlie: { status: 'unavailable', why: 'not a layout this collector knows' }
    })
    assert.deepEqual(checkHermes(doc, fake.identity), [])
  } finally {
    await fake.cleanup()
  }
})

test('sessions: with no node:sqlite the card says it needs a newer Node, never 0', async () => {
  const fake = await makeFakeHome()
  try {
    const root = await writeHermes(fake, { now: NOW })
    await fake.write('.hermes/state.db', 'pretend database')
    const doc = await collectHermes(deps(fake, { openSqlite: async () => { throw new SqliteMissing() } }), 'Test PC')
    assert.deepEqual(doc.profiles.items[0].sessions, { status: 'unavailable', why: 'needs a newer Node' })
    assert.ok(root)
  } finally {
    await fake.cleanup()
  }
})

test('the session question is built from fixed words only, whatever the columns are called', () => {
  const all = new Set(['id', 'source', 'started_at', 'ended_at', 'last_activity_at', 'parent_session_id', 'title'])
  const sql = sessionsQuery(all)
  assert.match(sql, /COALESCE\(last_activity_at, ended_at, started_at\)/)
  assert.match(sql, /WHERE parent_session_id IS NULL/)
  assert.match(sql, /source NOT IN \('cron', 'delegate', 'subagent'\)/)
  assert.match(sql, /source = 'cron'/)
  assert.equal(sessionsQuery(new Set(['source'])), null)
  assert.equal(sessionsQuery(new Set(['started_at'])), null)
  // A column with a hostile name is never put into the question.
  const hostile = sessionsQuery(new Set(['source', 'started_at', 'x); DROP TABLE sessions; --']))
  assert.ok(!hostile.includes('DROP'))
})
