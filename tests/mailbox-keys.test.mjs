import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENV_FILE, readMailboxEnv } from '../scripts/lib/mailbox/keys.mjs'

/* The Mac holds two kinds of secret and nothing else of the board's: the key that lets it ask for orders, and one
   signing secret per key id, which proves an order is the board's. They live in one file outside both clones, for
   the owner only. The fake secrets here are made at run time, so no real-looking token sits in this file. */

const KEY = ['poll', 'key', 'made', 'for', 'this', 'test', 'only', '0123456789'].join('-')
const SECRET_ONE = ['signing', 'secret', 'one', 'made', 'for', 'this', 'test', '9876543210'].join('-')
const SECRET_TWO = ['signing', 'secret', 'two', 'made', 'for', 'this', 'test', '5555555555'].join('-')
const GOOD = `MAILBOX_KEY=${KEY}\nMAILBOX_SECRET_k1=${SECRET_ONE}\nMAILBOX_SECRET_k2=${SECRET_TWO}\n`

const REGULAR = 0o100600
// A file system with one file in it, as lstat sees it. A test chooses the kind of file, its mode and its owner,
// which a real temporary file on Windows could not show.
function fakeFs({ text = GOOD, mode = REGULAR, uid = 501, size = Buffer.byteLength(text), kind = 'file', failRead = false, failStat = null } = {}) {
  return {
    reads: 0,
    async lstat() {
      if (failStat) throw Object.assign(new Error('C:\\Users\\someone\\secret path'), { code: failStat })
      return {
        mode,
        uid,
        size,
        isSymbolicLink: () => kind === 'link',
        isFile: () => kind === 'file',
        isDirectory: () => kind === 'folder'
      }
    },
    async readFile() {
      this.reads += 1
      if (failRead) throw new Error('C:\\Users\\someone\\secret path')
      return text
    }
  }
}

const read = (options, extra = {}) => readMailboxEnv('/home/someone/.config/agent-mailbox/env', { platform: 'darwin', uid: 501, fs: fakeFs(options), ...extra })

test('a file that is not for the owner alone, or is somebody else\'s, or is a link, a folder or too big, is never even opened', async () => {
  for (const options of [{ mode: 0o100644 }, { uid: 0 }, { kind: 'link' }, { kind: 'folder' }, { size: ENV_FILE.maxBytes + 1 }]) {
    const fs = fakeFs(options)
    const found = await readMailboxEnv('/home/someone/.config/agent-mailbox/env', { platform: 'darwin', uid: 501, fs })
    assert.equal(found.state, 'broken')
    assert.equal(fs.reads, 0, JSON.stringify(options))
  }
  const fs = fakeFs()
  await readMailboxEnv('/home/someone/.config/agent-mailbox/env', { platform: 'darwin', uid: 501, fs })
  assert.equal(fs.reads, 1)
})

test('the secrets file is ~/.config/agent-mailbox/env, small, and read by the runner itself - not by a shell', () => {
  assert.deepEqual(ENV_FILE, { name: 'env', maxBytes: 8 * 1024 })
})

test('a good file gives the key and each signing secret by key id', async () => {
  const found = await read()
  assert.equal(found.state, 'ok')
  assert.equal(found.key, KEY)
  assert.deepEqual([...found.secrets], [['k1', SECRET_ONE], ['k2', SECRET_TWO]])
})

test('comments, blank lines, Windows line endings, a byte order mark and quotes around a value are all fine', async () => {
  const mark = String.fromCharCode(0xfeff)
  const text = `${mark}MAILBOX_KEY="${KEY}"\r\n# the board\r\n\r\n  # indented comment\r\nMAILBOX_SECRET_k1='${SECRET_ONE}'\r\nMAILBOX_SECRET_k2=${SECRET_TWO}   \r\n`
  const found = await read({ text })
  assert.equal(found.state, 'ok')
  assert.equal(found.key, KEY)
  assert.deepEqual([...found.secrets], [['k1', SECRET_ONE], ['k2', SECRET_TWO]])
})

test('only one pair of quotes goes, and only when both ends have the same one', async () => {
  const odd = await read({ text: `MAILBOX_KEY="${KEY}\nMAILBOX_SECRET_k1=${SECRET_ONE}\n` })
  assert.equal(odd.state, 'ok')
  assert.equal(odd.key, `"${KEY}`, 'an unmatched quote is part of the value')
  const mixed = await read({ text: `MAILBOX_KEY="${KEY}'\nMAILBOX_SECRET_k1=${SECRET_ONE}\n` })
  assert.equal(mixed.key, `"${KEY}'`)
  const twice = await read({ text: `MAILBOX_KEY=""${KEY}""\nMAILBOX_SECRET_k1=${SECRET_ONE}\n` })
  assert.equal(twice.key, `"${KEY}"`)
})

test('a key that happens to start and end with the same letter is not touched - only quote marks are taken off', async () => {
  const same = `x${'ab'.repeat(20)}x`
  const found = await read({ text: `MAILBOX_KEY=${same}\nMAILBOX_SECRET_k1=${SECRET_ONE}\n` })
  assert.equal(found.key, same)
  const digits = await read({ text: `MAILBOX_KEY=${KEY}\nMAILBOX_SECRET_k1=${same}\n` })
  assert.equal(digits.secrets.get('k1'), same)
})

test('no file: missing. A folder, a link, a file that is too big or one that cannot be read: broken, and the reason is a word', async () => {
  assert.deepEqual(await read({ failStat: 'ENOENT' }), { state: 'missing' })
  assert.deepEqual(await read({ failStat: 'ENOTDIR' }), { state: 'missing' })
  assert.deepEqual(await read({ failStat: 'EACCES' }), { state: 'broken', why: 'unreadable' })
  assert.deepEqual(await read({ kind: 'folder' }), { state: 'broken', why: 'not-file' })
  assert.deepEqual(await read({ kind: 'link' }), { state: 'broken', why: 'link' })
  assert.deepEqual(await read({ size: ENV_FILE.maxBytes + 1 }), { state: 'broken', why: 'size' })
  assert.equal((await read({ size: ENV_FILE.maxBytes })).state, 'ok')
  assert.deepEqual(await read({ failRead: true }), { state: 'broken', why: 'unreadable' })
})

test('on a Mac or Linux the file must be for its owner only: any right for the group or others breaks it', async () => {
  for (const mode of [0o100600, 0o100400, 0o100200]) assert.equal((await read({ mode })).state, 'ok', mode.toString(8))
  for (const mode of [0o100644, 0o100640, 0o100604, 0o100660, 0o100606, 0o100601, 0o100610, 0o100666, 0o100777]) {
    assert.deepEqual(await read({ mode }), { state: 'broken', why: 'mode' }, mode.toString(8))
  }
})

test('the file must belong to the person running the runner', async () => {
  assert.deepEqual(await read({ uid: 0 }), { state: 'broken', why: 'owner' })
  assert.deepEqual(await read({ uid: 502 }), { state: 'broken', why: 'owner' })
  assert.equal((await read({ uid: 0 }, { uid: 0 })).state, 'ok', 'root running it, root\'s file')
  assert.equal((await read({ uid: 7 }, { uid: undefined })).state, 'ok', 'a system with no owner to compare with')
})

test('on Windows there are no such modes or owners to read, so neither is checked (and the setup there is marked not tested)', async () => {
  assert.equal((await read({ mode: 0o100666, uid: 0 }, { platform: 'win32' })).state, 'ok')
})

const BAD = [
  ['spaces around the equals sign', `MAILBOX_KEY = ${KEY}\nMAILBOX_SECRET_k1=${SECRET_ONE}\n`, 'line'],
  ['a line of plain words', `${GOOD}this is my key\n`, 'line'],
  ['a name with no value sign', `${GOOD}MAILBOX_KEY\n`, 'line'],
  ['a value with no name', `${GOOD}=${KEY}\n`, 'line'],
  ['export in front', `export MAILBOX_KEY=${KEY}\nMAILBOX_SECRET_k1=${SECRET_ONE}\n`, 'line'],
  ['a name nobody knows', `${GOOD}MAILBOX_KEEY=${KEY}\n`, 'name'],
  ['a name in small letters', `${GOOD}mailbox_key=${KEY}\n`, 'name'],
  ['a key id in capitals', `${GOOD}MAILBOX_SECRET_K3=${SECRET_ONE}\n`, 'name'],
  ['a key id that is empty', `${GOOD}MAILBOX_SECRET_=${SECRET_ONE}\n`, 'name'],
  ['a key id of 17 characters', `${GOOD}MAILBOX_SECRET_${'a'.repeat(17)}=${SECRET_ONE}\n`, 'name'],
  ['a key id with an underscore', `${GOOD}MAILBOX_SECRET_k_3=${SECRET_ONE}\n`, 'name'],
  ['a key id like a prototype', `${GOOD}MAILBOX_SECRET___proto__=${SECRET_ONE}\n`, 'name'],
  ['the key twice', `${GOOD}MAILBOX_KEY=${KEY}\n`, 'duplicate'],
  ['a secret twice', `${GOOD}MAILBOX_SECRET_k1=${SECRET_TWO}\n`, 'duplicate'],
  ['a key that is too short', `MAILBOX_KEY=${'a'.repeat(31)}\nMAILBOX_SECRET_k1=${SECRET_ONE}\n`, 'key-shape'],
  ['a key with a space in it', `MAILBOX_KEY=${'a'.repeat(20)} ${'b'.repeat(20)}\nMAILBOX_SECRET_k1=${SECRET_ONE}\n`, 'key-shape'],
  ['a key that is empty', `MAILBOX_KEY=\nMAILBOX_SECRET_k1=${SECRET_ONE}\n`, 'key-shape'],
  ['a secret that is too short', `MAILBOX_KEY=${KEY}\nMAILBOX_SECRET_k1=${'a'.repeat(31)}\n`, 'secret-shape'],
  ['a secret with an accented letter', `MAILBOX_KEY=${KEY}\nMAILBOX_SECRET_k1=${'caf\u00e9'.repeat(10)}\n`, 'secret-shape'],
  ['a secret that is empty', `MAILBOX_KEY=${KEY}\nMAILBOX_SECRET_k1=\n`, 'secret-shape'],
  ['no key', `MAILBOX_SECRET_k1=${SECRET_ONE}\n`, 'no-key'],
  ['no secret', `MAILBOX_KEY=${KEY}\n`, 'no-secret'],
  ['an empty file', '', 'no-key'],
  ['only comments', '# nothing yet\n', 'no-key'],
  ['the key reused as a signing secret', `MAILBOX_KEY=${KEY}\nMAILBOX_SECRET_k1=${KEY}\n`, 'same-secret']
]

for (const [name, text, why] of BAD) {
  test(`broken, the runner will not poll: ${name}`, async () => {
    assert.deepEqual(await read({ text }), { state: 'broken', why })
  })
}

test('a refusal names the problem and never repeats a line of the file', async () => {
  const hostile = ['not', 'a', 'key', 'but', 'looks', 'like', 'one', 'abcdefghijklmnopqrstuvwxyz'].join('-')
  for (const text of [`${hostile}\n`, `${GOOD}MAILBOX_NOPE=${hostile}\n`, `MAILBOX_KEY=${hostile} ${hostile}\nMAILBOX_SECRET_k1=${SECRET_ONE}\n`, `${GOOD}MAILBOX_KEY=${hostile}\n`]) {
    const found = await read({ text })
    assert.equal(found.state, 'broken')
    assert.ok(!JSON.stringify(found).includes(hostile), text)
    assert.ok(!JSON.stringify(found).includes(KEY))
  }
})

test('a file system error never gets out: it would carry a path, and a path carries the user name', async () => {
  const found = await read({ failStat: 'EACCES' })
  assert.ok(!JSON.stringify(found).includes('someone'))
  const unreadable = await read({ failRead: true })
  assert.ok(!JSON.stringify(unreadable).includes('someone'))
})

test('a real file on this computer reads the same way (modes are only set where this system has them)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mailbox-keys-'))
  try {
    const file = join(dir, 'env')
    await writeFile(file, GOOD)
    if (process.platform !== 'win32') await chmod(file, 0o600)
    const found = await readMailboxEnv(file)
    assert.equal(found.state, 'ok')
    assert.equal(found.key, KEY)
    assert.deepEqual(await readMailboxEnv(join(dir, 'nothing')), { state: 'missing' })
    await mkdir(join(dir, 'folder'))
    assert.deepEqual(await readMailboxEnv(join(dir, 'folder')), { state: 'broken', why: 'not-file' })
    try {
      await symlink(file, join(dir, 'linked'))
      assert.deepEqual(await readMailboxEnv(join(dir, 'linked')), { state: 'broken', why: 'link' })
    } catch (error) {
      if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error
    }
    if (process.platform !== 'win32') {
      await chmod(file, 0o644)
      assert.deepEqual(await readMailboxEnv(file), { state: 'broken', why: 'mode' })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
