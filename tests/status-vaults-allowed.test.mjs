import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ALLOWED_VAULTS,
  readAllowedVaults,
  readVaultsYml,
  findNamedVaults,
  collectVaults
} from '../scripts/lib/status/vaults.mjs'
import { team, obsidianHome, recordingFs, allowText, ALLOWED_FILE } from './helpers/obsidian-home.mjs'
import { FAKE_USERNAME, FAKE_HOSTNAME } from './helpers/fake-home.mjs'

/* Who decides which vaults are read. Not the team repo: others, and cloud routines, can push to it, and a
   pusher could otherwise name any vault on the Mac and ask for its titles. The decision is a file on the
   computer itself, outside both the code checkout and the data clone, that names the vaults that may be read
   and the most each may show. The team repo's vaults.yml can only choose among those and ask for less. */

const NONE = { status: 'none', vaults: [], hidden: 0, more: 0, ignored: 0, lowered: 0 }
const names = (found) => found.vaults.map((vault) => [vault.name, vault.level])

/* ---------- the file ---------------------------------------------------------------------------------------------- */

test('the allowlist is allowed-vaults.yml in the collector\'s state folder, and the tests spell it the same', () => {
  assert.deepEqual(ALLOWED_VAULTS, { file: 'allowed-vaults.yml', maxBytes: 64 * 1024 })
  assert.equal(ALLOWED_FILE, ALLOWED_VAULTS.file)
})

test('allowlist: a name, and the most it may show - "shape" unless it says exactly "titles"; the same name twice gets the lower', async () => {
  const state = await team({
    [ALLOWED_FILE]: [
      'vaults:',
      '  - name: Second Brain',
      '    level: titles',
      '  - name: Ideas',
      '  - name: Work',
      '    level: Titles',
      '  - name: Journal',
      '    level: titles',
      '  - name: journal',
      '  - name: Archive',
      '    level: titles',
      '  - name: ARCHIVE',
      '    level: titles',
      '  - name: Notes',
      '  - name: notes',
      '    level: titles',
      ''
    ].join('\n')
  })
  try {
    const read = await readAllowedVaults(state.dir)
    assert.equal(read.state, 'ok')
    assert.deepEqual([...read.allowed], [['second brain', 'titles'], ['ideas', 'shape'], ['work', 'shape'], ['journal', 'shape'], ['archive', 'titles'], ['notes', 'shape']])
  } finally {
    await state.cleanup()
  }
})

test('an allowlist written on Windows - with line endings of its own and a byte order mark - is read the same', async () => {
  const mark = String.fromCharCode(0xfeff)
  const lines = ['vaults:', '  - name: Second Brain', '    level: titles', '  - name: Ideas', '']
  for (const text of [lines.join('\r\n'), mark + lines.join('\r\n'), mark + lines.join('\n')]) {
    const state = await team({ [ALLOWED_FILE]: text })
    try {
      assert.deepEqual([...(await readAllowedVaults(state.dir)).allowed], [['second brain', 'titles'], ['ideas', 'shape']])
    } finally {
      await state.cleanup()
    }
  }
})

test('allowlist: a name the board would refuse allows nothing, and an entry that is not a name is ignored', async () => {
  const state = await team({
    [ALLOWED_FILE]: ['vaults:', '  - name: notes@home', `  - name: Notes of ${FAKE_USERNAME}`, '  - Just a word', '  - 7', '  - level: titles', '  - name: Ideas', ''].join('\n')
  })
  try {
    const read = await readAllowedVaults(state.dir, { username: FAKE_USERNAME, hostname: FAKE_HOSTNAME })
    assert.deepEqual([...read.allowed], [['ideas', 'shape']])
  } finally {
    await state.cleanup()
  }
})

test('allowlist: no folder, no file, a file that is a link, too big or a folder - missing or broken, and nothing is allowed', async () => {
  const absent = await team({})
  const folder = await team({})
  const big = await team({ [ALLOWED_FILE]: `vaults:\n  - name: Ideas\n# ${'x'.repeat(ALLOWED_VAULTS.maxBytes)}\n` })
  const link = await team({ 'target.yml': 'vaults:\n  - name: Ideas\n' })
  try {
    assert.deepEqual(await readAllowedVaults(undefined), { state: 'missing', allowed: new Map() })
    assert.deepEqual(await readAllowedVaults(join(absent.dir, 'not-there')), { state: 'missing', allowed: new Map() })
    assert.deepEqual(await readAllowedVaults(absent.dir), { state: 'missing', allowed: new Map() })
    await mkdir(join(folder.dir, ALLOWED_FILE))
    assert.deepEqual(await readAllowedVaults(folder.dir), { state: 'broken', allowed: new Map() })
    assert.deepEqual(await readAllowedVaults(big.dir), { state: 'broken', allowed: new Map() })
    try {
      await symlink(join(link.dir, 'target.yml'), join(link.dir, ALLOWED_FILE))
      assert.deepEqual(await readAllowedVaults(link.dir), { state: 'broken', allowed: new Map() })
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
    }
  } finally {
    await Promise.all([absent, folder, big, link].map((one) => one.cleanup()))
  }
})

/* ---------- no allowlist, nothing is read -------------------------------------------------------------------------- */

test('no allowlist on the computer: nothing is read, whatever the team repo says - not vaults.yml, not Obsidian\'s list, not a vault', async () => {
  const home = await obsidianHome('darwin', { 'Second Brain': { files: { 'a.md': '# a' } } }, { allow: null })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Second Brain\n    level: titles\n' })
  const fs = recordingFs()
  try {
    const found = await findNamedVaults({ ...home.depsFor(), fs }, dir.dir)
    assert.deepEqual(found, { ...NONE, allowlist: 'missing' })
    assert.ok(fs.touched.length > 0)
    assert.ok(fs.touched.every((path) => path.endsWith(ALLOWED_FILE)), `something else was read: ${JSON.stringify(fs.touched)}`)
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('an allowlist that allows nothing reads nothing either, and says so', async () => {
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Second Brain\n' })
  try {
    for (const text of ['vaults: []\n', '# nothing yet\nvaults: []\n', 'vaults: Second Brain\n', '']) {
      const home = await obsidianHome('darwin', { 'Second Brain': {} }, { allow: text })
      const fs = recordingFs()
      try {
        assert.deepEqual(await findNamedVaults({ ...home.depsFor(), fs }, dir.dir), { ...NONE, allowlist: 'empty' }, JSON.stringify(text))
        assert.ok(fs.touched.every((path) => path.endsWith(ALLOWED_FILE)), JSON.stringify(fs.touched))
      } finally {
        await home.cleanup()
      }
    }
  } finally {
    await dir.cleanup()
  }
})

test('a broken allowlist makes the part unavailable and reads nothing else: it is not read as "allow everything"', async () => {
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Second Brain\n' })
  const home = await obsidianHome('darwin', { 'Second Brain': {} }, { allow: null })
  await mkdir(join(home.stateDir, ALLOWED_FILE))
  const fs = recordingFs()
  try {
    const found = await findNamedVaults({ ...home.depsFor(), fs }, dir.dir)
    assert.equal(found.status, 'unavailable')
    assert.deepEqual(found.vaults, [])
    assert.ok(fs.touched.every((path) => path.endsWith(ALLOWED_FILE)))
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('with no state folder at all there is no allowlist, so nothing is read', async () => {
  const home = await obsidianHome('darwin', { Ideas: {} })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Ideas\n' })
  try {
    assert.deepEqual(await findNamedVaults(home.depsFor({ stateDir: undefined }), dir.dir), { ...NONE, allowlist: 'missing' })
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('an allowlist in the data folder - the team repo - is never read: only the one in the state folder counts', async () => {
  const home = await obsidianHome('darwin', { 'Second Brain': {} }, { allow: null })
  const dir = await team({
    'vaults.yml': 'vaults:\n  - name: Second Brain\n    level: titles\n',
    [ALLOWED_FILE]: allowText(['Second Brain']),
    '.agent-team/status/allowed-vaults.yml': allowText(['Second Brain'])
  })
  const fs = recordingFs()
  try {
    const found = await findNamedVaults({ ...home.depsFor(), fs }, dir.dir)
    assert.deepEqual(found, { ...NONE, allowlist: 'missing' })
    assert.ok(!fs.touched.some((path) => path.startsWith(dir.dir)), 'something in the team repo\'s folder was read')
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

/* ---------- the team repo can only narrow --------------------------------------------------------------------------- */

test('a vault the team repo names that the computer does not allow is ignored: not opened, not mentioned, counted', async () => {
  const home = await obsidianHome('darwin', {
    'Second Brain': { files: { 'a.md': '# a' } },
    'Therapy Sessions': { files: { 'Dr Lee.md': 'private' } }
  }, { allow: allowText(['Second Brain']) })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Therapy Sessions\n    level: titles\n  - name: Second Brain\n' })
  const fs = recordingFs()
  try {
    const found = await findNamedVaults({ ...home.depsFor(), fs }, dir.dir)
    assert.equal(found.status, 'found')
    assert.deepEqual(names(found), [['Second Brain', 'shape']])
    assert.equal(found.ignored, 1)
    assert.equal(found.hidden, 0, 'an ignored vault is not a hidden one: it was never allowed')
    assert.ok(!fs.touched.some((path) => path.includes('Therapy')), 'the vault that is not allowed was touched')
    assert.ok(!JSON.stringify(found).includes('Therapy'), 'the vault that is not allowed was mentioned')
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('if only vaults the computer does not allow are named, nothing is found - not an error', async () => {
  const home = await obsidianHome('darwin', { 'Therapy Sessions': {} }, { allow: allowText(['Second Brain']) })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Therapy Sessions\n    level: titles\n' })
  try {
    assert.deepEqual(await findNamedVaults(home.depsFor(), dir.dir), { ...NONE, ignored: 1, allowlist: 'ok' })
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('titles asked for by the team repo on a vault the computer allows only as dots is dots, and counted', async () => {
  const home = await obsidianHome('darwin', { 'Second Brain': {}, Ideas: {} }, { allow: 'vaults:\n  - name: Second Brain\n  - name: Ideas\n    level: titles\n' })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Second Brain\n    level: titles\n  - name: Ideas\n    level: titles\n' })
  try {
    const found = await findNamedVaults(home.depsFor(), dir.dir)
    assert.deepEqual(names(found), [['Second Brain', 'shape'], ['Ideas', 'titles']])
    assert.equal(found.lowered, 1)
    assert.equal(found.ignored, 0)
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('the team repo lowering a level is honoured: allowed titles, asked for dots - by saying shape, or by saying nothing', async () => {
  const home = await obsidianHome('darwin', { 'Second Brain': {}, Ideas: {}, Work: {} }, { allow: allowText(['Second Brain', 'Ideas', 'Work']) })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Second Brain\n    level: shape\n  - name: Ideas\n  - name: Work\n    level: titles\n' })
  try {
    const found = await findNamedVaults(home.depsFor(), dir.dir)
    assert.deepEqual(names(found), [['Second Brain', 'shape'], ['Ideas', 'shape'], ['Work', 'titles']])
    assert.equal(found.lowered, 0, 'asking for less than is allowed is not a refusal')
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('the team repo can drop a vault the computer allows: one it does not name is not read', async () => {
  const home = await obsidianHome('darwin', { A: {}, B: {}, C: {} }, { allow: allowText(['A', 'B', 'C']) })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: B\n' })
  const fs = recordingFs()
  try {
    const found = await findNamedVaults({ ...home.depsFor(), fs }, dir.dir)
    assert.deepEqual(names(found), [['B', 'shape']])
    assert.ok(!fs.touched.some((path) => path.endsWith(`${join('Vaults', 'A')}`) || path.endsWith(`${join('Vaults', 'C')}`)))
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('the team repo cannot name a vault by another spelling to get past the list: case is ignored, nothing else', async () => {
  const home = await obsidianHome('darwin', { 'Second Brain': {}, 'Second Brain 2': {} }, { allow: allowText(['SECOND brain']) })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: second BRAIN\n    level: titles\n  - name: Second Brain 2\n  - name: Second-Brain\n  - name: Second Brain \n' })
  try {
    const found = await findNamedVaults(home.depsFor(), dir.dir)
    assert.deepEqual(names(found), [['Second Brain', 'titles']])
    assert.equal(found.ignored, 2)
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('three vaults are read at most, counted after the ones the computer does not allow: junk in front does not push a real vault out', async () => {
  const home = await obsidianHome('darwin', { A: {}, B: {}, C: {}, D: {} }, { allow: allowText(['A', 'B', 'C', 'D']) })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Junk\n  - name: A\n  - name: B\n  - name: C\n  - name: D\n' })
  try {
    const found = await findNamedVaults(home.depsFor(), dir.dir)
    assert.deepEqual(names(found), [['A', 'shape'], ['B', 'shape'], ['C', 'shape']])
    assert.equal(found.more, 1)
    assert.equal(found.ignored, 1)
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('readVaultsYml with an allowlist filters and lowers before it counts; without one it does neither', async () => {
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: A\n    level: titles\n  - name: B\n    level: titles\n  - name: C\n' })
  try {
    const plain = await readVaultsYml(dir.dir)
    assert.deepEqual(plain.entries, [{ name: 'A', level: 'titles' }, { name: 'B', level: 'titles' }, { name: 'C', level: 'shape' }])
    const narrowed = await readVaultsYml(dir.dir, {}, undefined, new Map([['a', 'titles'], ['b', 'shape']]))
    assert.deepEqual(narrowed.entries, [{ name: 'A', level: 'titles' }, { name: 'B', level: 'shape' }])
    assert.equal(narrowed.ignored, 1)
    assert.equal(narrowed.lowered, 1)
  } finally {
    await dir.cleanup()
  }
})

/* ---------- what the log says ------------------------------------------------------------------------------------ */

test('collectVaults says, in the log only and by count, what the allowlist did - never a name', async () => {
  const home = await obsidianHome('darwin', { 'Second Brain': { files: { 'a.md': '' } }, 'Therapy Sessions': {}, Ideas: {} }, {
    allow: 'vaults:\n  - name: Second Brain\n  - name: Ideas\n    level: titles\n'
  })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Therapy Sessions\n    level: titles\n  - name: Second Brain\n    level: titles\n  - name: Ideas\n' })
  try {
    const trail = []
    const doc = await collectVaults(home.depsFor({ now: Date.UTC(2026, 9, 10, 12), dataDir: dir.dir }), 'Mac Mini', trail)
    assert.deepEqual(doc.vaults.items.map((item) => [item.name, item.level]), [['Second Brain', 'shape'], ['Ideas', 'shape']])
    assert.deepEqual(trail, [
      '1 vault named in vaults.yml is not in this computer\'s allowlist, so it was ignored.',
      '1 vault asked for titles in vaults.yml but this computer\'s allowlist allows only dots, so it is shown as dots.'
    ])
    for (const line of trail) assert.ok(!/Therapy|Second|Ideas/.test(line), 'a line named a vault')
    assert.ok(!JSON.stringify(doc).includes('Therapy'))
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('collectVaults without an allowlist: "not found", and a log line that says why', async () => {
  const home = await obsidianHome('darwin', { Ideas: {} }, { allow: null })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Ideas\n    level: titles\n' })
  try {
    const trail = []
    const doc = await collectVaults(home.depsFor({ now: Date.UTC(2026, 9, 10, 12), dataDir: dir.dir }), 'Mac Mini', trail)
    assert.deepEqual(doc.vaults, { status: 'not found' })
    assert.deepEqual(trail, ['No allowlist on this computer (allowed-vaults.yml in the state folder), so no vault is read, whatever vaults.yml says.'])
    await home.setAllowed('vaults: []\n')
    const empty = []
    await collectVaults(home.depsFor({ now: Date.UTC(2026, 9, 10, 12), dataDir: dir.dir }), 'Mac Mini', empty)
    assert.deepEqual(empty, ['The allowlist on this computer (allowed-vaults.yml in the state folder) names no vault, so none is read.'])
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('collectVaults: the lines are plural when they should be, and a broken allowlist is unavailable', async () => {
  const home = await obsidianHome('darwin', { A: {}, B: {} }, { allow: allowText(['A'], 'shape') })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: A\n    level: titles\n  - name: X\n  - name: Y\n' })
  try {
    const trail = []
    await collectVaults(home.depsFor({ now: Date.UTC(2026, 9, 10, 12), dataDir: dir.dir }), 'Mac Mini', trail)
    assert.deepEqual(trail, [
      '2 vaults named in vaults.yml are not in this computer\'s allowlist, so they were ignored.',
      '1 vault asked for titles in vaults.yml but this computer\'s allowlist allows only dots, so it is shown as dots.'
    ])
    await writeFile(join(home.stateDir, ALLOWED_FILE), 'x'.repeat(ALLOWED_VAULTS.maxBytes + 1))
    const doc = await collectVaults(home.depsFor({ now: Date.UTC(2026, 9, 10, 12), dataDir: dir.dir }), 'Mac Mini', [])
    assert.deepEqual(doc.vaults, { status: 'unavailable', why: 'could not be read' })
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})
