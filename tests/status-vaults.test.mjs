import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, symlink, rm, mkdtemp } from 'node:fs/promises'
import * as nodeFs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  VAULTS_YML,
  obsidianListPath,
  readVaultsYml,
  listObsidianVaults,
  findNamedVaults
} from '../scripts/lib/status/vaults.mjs'
import { VAULTS_CAPS } from '../scripts/lib/status/vaults-schema.mjs'
import { makeFakeHome, fakeClaudeToken, FAKE_EMAIL, FAKE_USERNAME, FAKE_HOSTNAME } from './helpers/fake-home.mjs'

/* Which vaults get opened. Only those the owner names in vaults.yml, found through Obsidian's own
   list of vaults; an unnamed vault is never read, and neither its name nor its place is kept. */

async function team(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-vaults-team-'))
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, ...name.split('/').slice(0, -1)), { recursive: true })
    await writeFile(join(dir, ...name.split('/')), content)
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// A pretend home with Obsidian's list of vaults in the right place for the platform, and a folder for each.
async function obsidianHome(platform, vaults, { env = {}, raw } = {}) {
  const fake = await makeFakeHome()
  const listPath = obsidianListPath({ home: fake.home, platform, env: { ...env, ...(platform === 'win32' ? { APPDATA: join(fake.home, 'AppData', 'Roaming') } : {}) } })
  const entries = {}
  let index = 0
  for (const [folder, { files = {}, asPath } = {}] of Object.entries(vaults)) {
    const path = asPath ?? join(fake.root, 'Vaults', folder)
    await mkdir(path, { recursive: true }).catch(() => {})
    for (const [file, text] of Object.entries(files)) {
      await mkdir(join(path, ...file.split('/').slice(0, -1)), { recursive: true })
      await writeFile(join(path, ...file.split('/')), text)
    }
    entries[`id${index += 1}`] = { path, ts: 1760000000000, open: index === 1 }
  }
  await mkdir(join(listPath, '..'), { recursive: true })
  await writeFile(listPath, raw ?? JSON.stringify({ vaults: entries }))
  return { ...fake, listPath, depsFor: (extra = {}) => ({ home: fake.home, platform, env: {}, identity: fake.identity, ...extra }) }
}

// A file system that remembers every path it was asked about.
function recordingFs() {
  const touched = []
  const wrap = (name) => (path, ...rest) => {
    touched.push(String(path))
    return nodeFs[name](path, ...rest)
  }
  return { touched, lstat: wrap('lstat'), stat: wrap('stat'), readFile: wrap('readFile'), readdir: wrap('readdir') }
}

/* ---------- where Obsidian keeps its list ----------------------------------------------------- */

test('Obsidian\'s own list of vaults is in a place that depends on the platform', () => {
  const home = join('Users', 'someone')
  assert.equal(obsidianListPath({ home, platform: 'darwin', env: {} }), join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json'))
  assert.equal(obsidianListPath({ home, platform: 'win32', env: { APPDATA: join('C:', 'Roaming') } }), join('C:', 'Roaming', 'obsidian', 'obsidian.json'))
  assert.equal(obsidianListPath({ home, platform: 'win32', env: {} }), join(home, 'AppData', 'Roaming', 'obsidian', 'obsidian.json'))
  assert.equal(obsidianListPath({ home, platform: 'linux', env: {} }), join(home, '.config', 'obsidian', 'obsidian.json'))
  assert.equal(obsidianListPath({ home, platform: 'linux', env: { XDG_CONFIG_HOME: join('x', 'conf') } }), join('x', 'conf', 'obsidian', 'obsidian.json'))
  assert.equal(obsidianListPath({ home, platform: 'freebsd', env: {} }), join(home, '.config', 'obsidian', 'obsidian.json'))
})

test('the list is found on each platform and yields each vault by its folder name, with the place kept in memory only', async () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const home = await obsidianHome(platform, { 'Second Brain': {}, Ideas: {} })
    try {
      const listed = await listObsidianVaults(home.depsFor())
      assert.equal(listed.state, 'ok', platform)
      assert.deepEqual(listed.vaults.map((vault) => vault.name).sort(), ['Ideas', 'Second Brain'], platform)
      for (const vault of listed.vaults) {
        assert.ok(vault.path.includes(vault.name), 'the place is held to open the vault')
        assert.deepEqual(Object.keys(vault).sort(), ['name', 'path'], 'nothing but the name and the place is taken from the list of vaults')
      }
    } finally {
      await home.cleanup()
    }
  }
})

test('a vault\'s name is its last folder, however the platform separates folders, and a trailing separator does not make it empty', async () => {
  const raw = JSON.stringify({ vaults: {
    a: { path: 'C:\\Users\\someone\\Documents\\Obsidian Vault' },
    b: { path: '/Users/someone/Vaults/Second Brain/' },
    c: { path: 'D:\\notes\\' },
    d: { path: '/' },
    e: { path: '' },
    f: { path: 7 },
    g: {},
    h: 'not an object',
    i: { path: '/Users/someone/Ideas' }
  } })
  const home = await obsidianHome('linux', {}, { raw })
  try {
    const listed = await listObsidianVaults(home.depsFor())
    assert.deepEqual(listed.vaults.map((vault) => vault.name).sort(), ['Ideas', 'Obsidian Vault', 'Second Brain', 'notes'])
  } finally {
    await home.cleanup()
  }
})

test('no Obsidian list is "missing" (Obsidian is not on this computer); one that is broken is "broken", and says nothing more', async () => {
  const none = await makeFakeHome()
  try {
    assert.deepEqual(await listObsidianVaults({ home: none.home, platform: 'darwin', env: {}, identity: none.identity }), { state: 'missing', vaults: [] })
  } finally {
    await none.cleanup()
  }
  for (const raw of ['{ not json', '[]', 'null', '"text"', JSON.stringify({ vaults: 'x' }), JSON.stringify({})]) {
    const home = await obsidianHome('darwin', {}, { raw })
    try {
      const listed = await listObsidianVaults(home.depsFor())
      assert.ok(listed.state === 'broken' || (listed.state === 'ok' && listed.vaults.length === 0), `${raw}: ${JSON.stringify(listed)}`)
    } finally {
      await home.cleanup()
    }
  }
  // Bigger than a list of vaults can be: not read at all.
  const huge = await obsidianHome('darwin', {}, { raw: JSON.stringify({ vaults: {}, padding: 'x'.repeat(2 * 1024 * 1024) }) })
  try {
    assert.deepEqual(await listObsidianVaults(huge.depsFor()), { state: 'broken', vaults: [] })
  } finally {
    await huge.cleanup()
  }
})

/* ---------- vaults.yml: which vaults the owner names, and at what level ------------------------ */

test('vaults.yml: the starter file names nothing, and a file that is not there names nothing', async () => {
  const empty = await team({ 'vaults.yml': 'vaults: []\n' })
  const absent = await team({})
  try {
    assert.deepEqual(await readVaultsYml(empty.dir), { state: 'ok', entries: [], hidden: 0, more: 0 })
    assert.deepEqual(await readVaultsYml(absent.dir), { state: 'missing', entries: [], hidden: 0, more: 0 })
  } finally {
    await empty.cleanup()
    await absent.cleanup()
  }
})

test('vaults.yml: a name, and a level that is "shape" unless it says exactly "titles"', async () => {
  const yml = [
    'vaults:',
    '  - name: Second Brain',
    '    level: titles',
    '  - name: Ideas',
    '  - name: Work',
    '    level: shape',
    '  - name: Journal',
    '    level: Titles',
    ''
  ].join('\n')
  const dir = await team({ 'vaults.yml': yml })
  try {
    const read = await readVaultsYml(dir.dir)
    assert.equal(read.state, 'ok')
    // Three are read, in order; the fourth is counted.
    assert.deepEqual(read.entries, [
      { name: 'Second Brain', level: 'titles' },
      { name: 'Ideas', level: 'shape' },
      { name: 'Work', level: 'shape' }
    ])
    assert.equal(read.more, 1)
    assert.equal(VAULTS_CAPS.vaults, 3)
  } finally {
    await dir.cleanup()
  }
})

test('vaults.yml: only the exact word titles turns titles on - a typo, a capital, a number or a list keeps the vault at shape', async () => {
  for (const level of ['title', 'Titles', 'TITLES', 'true', 'yes', '1', 'full', 'contents', '[titles]', '""']) {
    const dir = await team({ 'vaults.yml': `vaults:\n  - name: Ideas\n    level: ${level}\n` })
    try {
      const read = await readVaultsYml(dir.dir)
      assert.deepEqual(read.entries, [{ name: 'Ideas', level: 'shape' }], level)
    } finally {
      await dir.cleanup()
    }
  }
})

test('vaults.yml: an entry that cannot be used is counted, never guessed at; the same vault twice is one', async () => {
  const yml = [
    'vaults:',
    '  - name: Ideas',
    '  - name: ideas',
    '  - name: IDEAS',
    '    level: titles',
    '  - level: titles',
    '  - name: ',
    '  - name: notes@home',
    '  - name: my/notes',
    `  - name: ${fakeClaudeToken()}`,
    `  - name: Notes of ${FAKE_USERNAME}`,
    '  - Just a word',
    '  - 7',
    '  - name: Second Brain',
    ''
  ].join('\n')
  const dir = await team({ 'vaults.yml': yml })
  try {
    const read = await readVaultsYml(dir.dir, { username: FAKE_USERNAME, hostname: FAKE_HOSTNAME })
    assert.deepEqual(read.entries, [{ name: 'Ideas', level: 'shape' }, { name: 'Second Brain', level: 'shape' }])
    // The empty name, the missing name, the at sign, the slash, the key, the username and the two bare entries.
    assert.equal(read.hidden, 8)
  } finally {
    await dir.cleanup()
  }
})

test('vaults.yml: a file that is a link, too big, unreadable or no list is "broken", and names nothing', async () => {
  const link = await team({ 'target.yml': 'vaults:\n  - name: Ideas\n' })
  const big = await team({ 'vaults.yml': `vaults:\n  - name: Ideas\n# ${'x'.repeat(VAULTS_YML.maxBytes)}\n` })
  const folder = await team({})
  const notAList = await team({ 'vaults.yml': 'vaults: Ideas\n' })
  try {
    let linked = true
    try {
      await symlink(join(link.dir, 'target.yml'), join(link.dir, 'vaults.yml'))
    } catch {
      linked = false
    }
    if (linked) assert.deepEqual(await readVaultsYml(link.dir), { state: 'broken', entries: [], hidden: 0, more: 0 })
    assert.deepEqual(await readVaultsYml(big.dir), { state: 'broken', entries: [], hidden: 0, more: 0 })
    await mkdir(join(folder.dir, 'vaults.yml'))
    assert.deepEqual(await readVaultsYml(folder.dir), { state: 'broken', entries: [], hidden: 0, more: 0 })
    assert.deepEqual(await readVaultsYml(notAList.dir), { state: 'ok', entries: [], hidden: 0, more: 0 })
  } finally {
    await Promise.all([link, big, folder, notAList].map((one) => one.cleanup()))
  }
})

/* ---------- finding the vaults that were named -------------------------------------------------- */

test('only the vaults named in vaults.yml are found, at the level named, and the others are not opened, counted or mentioned', async () => {
  const home = await obsidianHome('darwin', { 'Second Brain': { files: { 'a.md': '# a' } }, Ideas: {}, 'Client Secrets': { files: { 'dr smith.md': 'hiv results' } } })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Second Brain\n    level: titles\n  - name: Ideas\n' })
  const fs = recordingFs()
  try {
    const found = await findNamedVaults({ ...home.depsFor(), fs }, dir.dir)
    assert.equal(found.status, 'found')
    assert.deepEqual(found.vaults.map((vault) => [vault.name, vault.level]), [['Second Brain', 'titles'], ['Ideas', 'shape']])
    assert.equal(found.hidden, 0)
    assert.equal(found.more, 0)
    // Not a stat, a read or a listing of the vault nobody named.
    assert.ok(fs.touched.length > 0)
    assert.ok(!fs.touched.some((path) => path.includes('Client Secrets')), 'the unnamed vault was touched')
    assert.ok(!JSON.stringify(found).includes('Client Secrets'), 'the unnamed vault was mentioned')
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('nothing is named: Obsidian\'s list is not even opened', async () => {
  const home = await obsidianHome('linux', { Ideas: {} })
  const none = await team({ 'vaults.yml': 'vaults: []\n' })
  const absent = await team({})
  try {
    for (const dir of [none, absent]) {
      const fs = recordingFs()
      assert.deepEqual(await findNamedVaults({ ...home.depsFor(), fs }, dir.dir), { status: 'none', vaults: [], hidden: 0, more: 0 })
      assert.ok(!fs.touched.some((path) => path.endsWith('obsidian.json')), 'the list of vaults was read with nothing named')
    }
  } finally {
    await Promise.all([home.cleanup(), none.cleanup(), absent.cleanup()])
  }
})

test('a vault named here that is not on this computer is not a problem, and not counted: it is simply elsewhere', async () => {
  const home = await obsidianHome('darwin', { Ideas: {} })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Second Brain\n  - name: Ideas\n' })
  try {
    const found = await findNamedVaults(home.depsFor(), dir.dir)
    assert.equal(found.status, 'found')
    assert.deepEqual(found.vaults.map((vault) => vault.name), ['Ideas'])
    assert.equal(found.hidden, 0)
    const elsewhere = await team({ 'vaults.yml': 'vaults:\n  - name: Second Brain\n' })
    try {
      assert.deepEqual(await findNamedVaults(home.depsFor(), elsewhere.dir), { status: 'none', vaults: [], hidden: 0, more: 0 })
    } finally {
      await elsewhere.cleanup()
    }
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('names are matched without regard to case, and the vault is published under its own folder name', async () => {
  const home = await obsidianHome('darwin', { 'Second Brain': {} })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: second brain\n' })
  try {
    const found = await findNamedVaults(home.depsFor(), dir.dir)
    assert.deepEqual(found.vaults.map((vault) => vault.name), ['Second Brain'])
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('two vaults with the same folder name cannot be told apart, so neither is opened, and it is counted', async () => {
  const home = await obsidianHome('darwin', {})
  const one = join(home.root, 'A', 'Notes')
  const two = join(home.root, 'B', 'Notes')
  await mkdir(one, { recursive: true })
  await mkdir(two, { recursive: true })
  await writeFile(home.listPath, JSON.stringify({ vaults: { x: { path: one }, y: { path: two }, z: { path: join(home.root, 'C', 'Ideas') } } }))
  await mkdir(join(home.root, 'C', 'Ideas'), { recursive: true })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Notes\n  - name: Ideas\n' })
  const fs = recordingFs()
  try {
    const found = await findNamedVaults({ ...home.depsFor(), fs }, dir.dir)
    assert.deepEqual(found.vaults.map((vault) => vault.name), ['Ideas'])
    assert.equal(found.hidden, 1)
    assert.ok(!fs.touched.some((path) => path.includes(`${join('A', 'Notes')}`) || path.includes(`${join('B', 'Notes')}`)), 'an ambiguous vault was opened')
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('a named vault whose folder is gone, is a file, or whose name the board would refuse, is counted and not opened', async () => {
  const home = await obsidianHome('darwin', { Present: {} })
  const gone = join(home.root, 'Vaults', 'Gone')
  const file = join(home.root, 'Vaults', 'AFile')
  const bad = join(home.root, 'Vaults', 'notes@home')
  const own = join(home.root, 'Vaults', `Notes of ${FAKE_USERNAME}`)
  await mkdir(join(home.root, 'Vaults'), { recursive: true })
  await writeFile(file, 'not a folder')
  await mkdir(bad, { recursive: true })
  await mkdir(own, { recursive: true })
  await writeFile(home.listPath, JSON.stringify({ vaults: { a: { path: join(home.root, 'Vaults', 'Present') }, b: { path: gone }, c: { path: file }, e: { path: bad }, f: { path: own } } }))
  const dir = await team({ 'vaults.yml': `vaults:\n  - name: Present\n  - name: Gone\n  - name: AFile\n  - name: notes@home\n  - name: Notes of ${FAKE_USERNAME}\n` })
  const fs = recordingFs()
  try {
    const found = await findNamedVaults({ ...home.depsFor(), fs }, dir.dir)
    assert.deepEqual(found.vaults.map((vault) => vault.name), ['Present'])
    // The folder that is gone, the file, and the two names the board would refuse (counted from vaults.yml,
    // where they never pass the name rule, so their folders are not so much as looked at).
    assert.equal(found.hidden, 4)
    assert.ok(!fs.touched.some((path) => path.includes('notes@home') || path.includes(`Notes of ${FAKE_USERNAME}`)), 'a vault with a refused name was touched')
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('a named vault whose folder is a link is not opened, and is counted', async (t) => {
  const home = await obsidianHome('darwin', { Present: {} })
  const linked = join(home.root, 'Vaults', 'Linked')
  try {
    await symlink(join(home.root, 'Vaults', 'Present'), linked)
  } catch {
    t.skip('this computer will not make a link here')
    await home.cleanup()
    return
  }
  await writeFile(home.listPath, JSON.stringify({ vaults: { a: { path: join(home.root, 'Vaults', 'Present') }, d: { path: linked } } }))
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Present\n  - name: Linked\n' })
  try {
    const found = await findNamedVaults(home.depsFor(), dir.dir)
    assert.deepEqual(found.vaults.map((vault) => vault.name), ['Present'])
    assert.equal(found.hidden, 1)
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('a list of vaults that is broken makes the part unavailable; a missing one means Obsidian is not here', async () => {
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Ideas\n' })
  const broken = await obsidianHome('darwin', {}, { raw: '{ not json' })
  const absent = await makeFakeHome()
  try {
    assert.deepEqual(await findNamedVaults(broken.depsFor(), dir.dir), { status: 'unavailable', vaults: [], hidden: 0, more: 0 })
    assert.deepEqual(await findNamedVaults({ home: absent.home, platform: 'darwin', env: {}, identity: absent.identity }, dir.dir), { status: 'none', vaults: [], hidden: 0, more: 0 })
  } finally {
    await Promise.all([broken.cleanup(), absent.cleanup(), dir.cleanup()])
  }
})

test('a vaults.yml that is broken makes the part unavailable, whatever Obsidian holds', async () => {
  const home = await obsidianHome('darwin', { Ideas: {} })
  const dir = await team({})
  await mkdir(join(dir.dir, 'vaults.yml'))
  try {
    assert.deepEqual(await findNamedVaults(home.depsFor(), dir.dir), { status: 'unavailable', vaults: [], hidden: 0, more: 0 })
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('the vault\'s place and nothing else of Obsidian\'s list is held: no id, no time, no "open" flag', async () => {
  const home = await obsidianHome('darwin', { Ideas: {} })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Ideas\n' })
  try {
    const found = await findNamedVaults(home.depsFor(), dir.dir)
    assert.deepEqual(Object.keys(found.vaults[0]).sort(), ['level', 'name', 'path'])
    assert.ok(FAKE_EMAIL)
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})
