import test from 'node:test'
import assert from 'node:assert/strict'
import { readSmallFile } from '../scripts/lib/mailbox/small-file.mjs'

/* Every file the runner reads on its own say-so - the allowlist, the secrets, a claim, the day's counts - is read
   through this: a plain file of a small size, or a word for why not. Never a file system message, which would
   carry a path, and a path carries the user name. */

function fakeFs({ kind = 'file', size = 10, text = 'hello', failStat = null, failRead = false } = {}) {
  return {
    reads: 0,
    async lstat() {
      if (failStat) throw Object.assign(new Error('a message with a path in it'), { code: failStat })
      return { size, mode: 0o100600, isSymbolicLink: () => kind === 'link', isFile: () => kind === 'file', isDirectory: () => kind === 'folder' }
    },
    async readFile() {
      this.reads += 1
      if (failRead) throw new Error('a message with a path in it')
      return text
    }
  }
}

test('a plain small file is read whole, and what lstat said about it comes with it', async () => {
  const found = await readSmallFile('/x/file', 100, fakeFs())
  assert.equal(found.state, 'ok')
  assert.equal(found.text, 'hello')
  assert.equal(found.info.size, 10)
})

test('no file, or no folder to hold it: missing - any other trouble looking is broken, not missing', async () => {
  assert.deepEqual(await readSmallFile('/x/file', 100, fakeFs({ failStat: 'ENOENT' })), { state: 'missing' })
  assert.deepEqual(await readSmallFile('/x/file', 100, fakeFs({ failStat: 'ENOTDIR' })), { state: 'missing' })
  assert.deepEqual(await readSmallFile('/x/file', 100, fakeFs({ failStat: 'EACCES' })), { state: 'broken', reason: 'unreadable', info: null })
  assert.deepEqual(await readSmallFile('/x/file', 100, fakeFs({ failStat: 'EIO' })), { state: 'broken', reason: 'unreadable', info: null })
})

test('a link, a folder and a file too big are broken, each for its own reason, and are not opened', async () => {
  for (const [options, reason] of [[{ kind: 'link' }, 'link'], [{ kind: 'folder' }, 'not-file'], [{ kind: 'other' }, 'not-file'], [{ size: 101 }, 'size']]) {
    const fs = fakeFs(options)
    const found = await readSmallFile('/x/file', 100, fs)
    assert.equal(found.state, 'broken', reason)
    assert.equal(found.reason, reason)
    assert.equal(fs.reads, 0)
  }
  assert.equal((await readSmallFile('/x/file', 100, fakeFs({ size: 100 }))).state, 'ok', 'exactly the limit is fine')
})

test('a file that cannot be read is broken, with a word and no message', async () => {
  const found = await readSmallFile('/x/file', 100, fakeFs({ failRead: true }))
  assert.equal(found.state, 'broken')
  assert.equal(found.reason, 'unreadable')
  assert.ok(!JSON.stringify(found).includes('path'))
})

test('a caller can refuse a file by what lstat says - before it is read - and the word it gives is the reason', async () => {
  const fs = fakeFs()
  const found = await readSmallFile('/x/file', 100, fs, (info) => (info.mode & 0o077 ? null : 'only-for-me'))
  assert.equal(found.state, 'broken')
  assert.equal(found.reason, 'only-for-me')
  assert.equal(fs.reads, 0)
  const fine = fakeFs()
  assert.equal((await readSmallFile('/x/file', 100, fine, () => null)).state, 'ok')
  assert.equal(fine.reads, 1)
  // It is not asked about a file that is not there, a link or one that is too big: those are broken already.
  let asked = 0
  for (const options of [{ failStat: 'ENOENT' }, { kind: 'link' }, { kind: 'folder' }, { size: 101 }]) {
    await readSmallFile('/x/file', 100, fakeFs(options), () => {
      asked += 1
      return null
    })
  }
  assert.equal(asked, 0)
})
