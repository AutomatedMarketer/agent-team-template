import test from 'node:test'
import assert from 'node:assert/strict'
import * as realFs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { repoRoot } from './helpers/repo.mjs'
import { CLAIMS_STORE, openStore, claimOrder, claimExists, listClaims, writeClaimFile, readClaimFile } from '../scripts/lib/mailbox/claims.mjs'
import { verifyEnvelope } from '../scripts/lib/mailbox/envelope.mjs'

/* A claim is the Mac's record that it has seen an order. It is what stops one signed order running twice, so the
   contract (tests/fixtures/mailbox-parity.json, `claims`) makes three rules about it, and each is held here:
     1. a claim is kept at least as long as the same signed order could still pass every other check - this code
        keeps them for ever and has no way to remove one;
     2. the store records when it was first made, and an order issued before that moment is refused - so a claim
        folder that was wiped, lost or is brand new can never run again an order that is still alive in the queue;
     3. a claim is on disk, durably, before anything else happens: no file edited, no model run, no commit. */

const fixture = JSON.parse(readFileSync(join(repoRoot, 'tests', 'fixtures', 'mailbox-parity.json'), 'utf8'))
const ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
const OTHER_ID = '11111111111111111111111111111111'
const T0 = Date.parse('2026-10-12T14:04:00.000Z')
const ENVELOPE = { kid: 'k1', body: '{"v":1}', sig: 'x'.repeat(43) }

async function folder() {
  const dir = await mkdtemp(join(tmpdir(), 'mailbox-claims-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// A file system that does what the real one does and writes down what was asked of it, in order. A directory is
// not opened for real (Windows cannot), but the request to make it durable is seen. `fail(op, name)` may return an
// error code to fail that one step.
function watched({ fail = () => null, platform = 'linux' } = {}) {
  const log = []
  const failing = (op, path) => {
    const code = fail(op, basename(path))
    if (code) throw Object.assign(new Error(`a message with a path in it: ${path}`), { code })
  }
  const fs = {
    ...realFs,
    async lstat(path) {
      failing('lstat', path)
      return realFs.lstat(path)
    },
    async mkdir(path, options) {
      log.push(['mkdir', basename(path), options])
      failing('mkdir', path)
      return realFs.mkdir(path, options)
    },
    async rename(from, to) {
      log.push(['rename', basename(to)])
      failing('rename', to)
      return realFs.rename(from, to)
    },
    async open(path, flags, mode) {
      const name = basename(path)
      if (flags === 'r') {
        log.push(['open-folder', name])
        failing('open-folder', path)
        return { async sync() { log.push(['sync-folder', name]); failing('sync-folder', path) }, async close() { log.push(['close-folder', name]) } }
      }
      log.push(['open', name, flags, mode])
      failing('open', path)
      const handle = await realFs.open(path, flags, mode)
      return {
        async writeFile(text) { log.push(['write', name]); failing('write', path); return handle.writeFile(text) },
        async sync() { log.push(['sync', name]); failing('sync', path); return handle.sync() },
        async close() { log.push(['close', name]); return handle.close() }
      }
    }
  }
  return { fs, log, platform }
}

const ops = (log) => log.map(([op, name]) => `${op} ${name.replace(/\.\d+\.tmp$/, '.tmp')}`)

/* ---------- the store: when it was first made ---------------------------------------------------------------------- */

test('the first time the store is opened it is made, and the moment is recorded inside it, once, in the contract\'s time form', async () => {
  const state = await folder()
  try {
    const first = await openStore(state.dir, T0)
    assert.deepEqual(first, { ok: true, since: T0, created: true })
    const record = JSON.parse(await readFile(join(state.dir, 'claims', CLAIMS_STORE.record), 'utf8'))
    assert.deepEqual(record, { claimsSince: '2026-10-12T14:04:00.000Z' })
    assert.match(record.claimsSince, new RegExp(fixture.body.timeShape))
  } finally {
    await state.cleanup()
  }
})

test('opened again - an hour, a day, a year later - it gives back the same moment and writes nothing', async () => {
  const state = await folder()
  try {
    await openStore(state.dir, T0)
    const { fs, log } = watched()
    for (const later of [T0 + 3600_000, T0 + 86400_000, T0 + 366 * 86400_000]) {
      assert.deepEqual(await openStore(state.dir, later, { fs, platform: 'linux' }), { ok: true, since: T0, created: false })
    }
    assert.deepEqual(log.filter(([op]) => ['open', 'rename', 'mkdir', 'write'].includes(op)), [])
  } finally {
    await state.cleanup()
  }
})

test('a store that is wiped starts again from the moment it was found wiped - an order issued before that is refused', async () => {
  const state = await folder()
  const good = fixture.orders.find((order) => order.verdict === 'ok')
  const issued = Date.parse(JSON.parse(good.envelope.body).issuedAt)
  const expectation = { keys: fixture.test.keys, repo: fixture.test.repo, runner: fixture.test.runner, now: Date.parse(fixture.test.now) }
  try {
    const first = await openStore(state.dir, Date.parse(fixture.test.claimsSince))
    assert.equal(verifyEnvelope(good.envelope, { ...expectation, claimsSince: first.since }).verdict, 'ok', 'with the store as it was, the order is good')
    const id = JSON.parse(good.envelope.body).id
    assert.equal((await claimOrder(state.dir, id, good.envelope, issued + 60_000)).state, 'claimed')
    assert.equal((await claimOrder(state.dir, id, good.envelope, issued + 61_000)).state, 'seen', 'a second look at it runs nothing')

    // The claims are lost (a new disk, a cleaned-up folder, a restore from before) while the order is still alive.
    await rm(join(state.dir, 'claims'), { recursive: true })
    const second = await openStore(state.dir, issued + 4 * 60_000)
    assert.deepEqual(second, { ok: true, since: issued + 4 * 60_000, created: true })
    assert.equal(verifyEnvelope(good.envelope, { ...expectation, claimsSince: second.since }).verdict, 'before-claims')
  } finally {
    await state.cleanup()
  }
})

test('the claims wiped but the record kept is not a case the record can help with - so the record is inside the claims, where "wiping the claims" takes it too', async () => {
  const state = await folder()
  try {
    await openStore(state.dir, T0)
    await claimOrder(state.dir, ID, ENVELOPE, T0)
    // Every way of emptying the folder with a glob leaves nothing the store could mistake for its past.
    for (const name of await readdir(join(state.dir, 'claims'))) await rm(join(state.dir, 'claims', name), { recursive: true })
    assert.deepEqual(await openStore(state.dir, T0 + 5 * 60_000), { ok: true, since: T0 + 5 * 60_000, created: true })
  } finally {
    await state.cleanup()
  }
})

test('a store with claims in it but no record of when it began is not one to trust: it begins now, and the old claims still count as seen', async () => {
  const state = await folder()
  try {
    await openStore(state.dir, T0)
    await claimOrder(state.dir, ID, ENVELOPE, T0)
    await rm(join(state.dir, 'claims', CLAIMS_STORE.record))
    assert.deepEqual(await openStore(state.dir, T0 + 600_000), { ok: true, since: T0 + 600_000, created: true })
    assert.equal((await claimOrder(state.dir, ID, ENVELOPE, T0 + 600_000)).state, 'seen')
  } finally {
    await state.cleanup()
  }
})

test('a record that is not a record - damaged, another shape, not a real moment - is replaced by now, never believed', async () => {
  const state = await folder()
  try {
    await openStore(state.dir, T0)
    const file = join(state.dir, 'claims', CLAIMS_STORE.record)
    const bad = [
      '',
      'not json',
      '[]',
      'null',
      '"2026-10-12T14:04:00.000Z"',
      '{}',
      '{"claimsSince":null}',
      '{"claimsSince":1760277840000}',
      '{"claimsSince":"2026-10-12T14:04:00Z"}',
      '{"claimsSince":"2026-02-30T14:04:00.000Z"}',
      '{"claimsSince":"yesterday"}',
      '{"claimsSince":"2026-10-12T14:04:00.000Z","more":1}',
      '{"since":"2026-10-12T14:04:00.000Z"}'
    ]
    let now = T0
    for (const text of bad) {
      now += 60_000
      await writeFile(file, text)
      assert.deepEqual(await openStore(state.dir, now), { ok: true, since: now, created: true }, text)
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { claimsSince: new Date(now).toISOString() }, text)
    }
  } finally {
    await state.cleanup()
  }
})

test('a record that is far bigger than a record can be is not read, however well it begins', async () => {
  const state = await folder()
  try {
    await openStore(state.dir, T0)
    const file = join(state.dir, 'claims', CLAIMS_STORE.record)
    await writeFile(file, `{"claimsSince":"2026-10-12T14:04:00.000Z"}${' '.repeat(1000)}`)
    assert.deepEqual(await openStore(state.dir, T0 + 60_000), { ok: true, since: T0 + 60_000, created: true })
  } finally {
    await state.cleanup()
  }
})

test('a record dated in the future is believed as written: it only ever refuses more', async () => {
  const state = await folder()
  try {
    await mkdir(join(state.dir, 'claims'))
    await writeFile(join(state.dir, 'claims', CLAIMS_STORE.record), '{"claimsSince":"2026-10-12T20:00:00.000Z"}')
    assert.deepEqual(await openStore(state.dir, T0), { ok: true, since: Date.parse('2026-10-12T20:00:00.000Z'), created: false })
  } finally {
    await state.cleanup()
  }
})

test('the store folder must be a real folder: a file or a link where it should be means no store, and nothing is claimed or run', async () => {
  const asFile = await folder()
  const target = await folder()
  const linked = await folder()
  try {
    await writeFile(join(asFile.dir, 'claims'), 'x')
    assert.deepEqual(await openStore(asFile.dir, T0), { ok: false, why: 'store' })
    try {
      await symlink(target.dir, join(linked.dir, 'claims'), 'junction')
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return
      throw error
    }
    assert.deepEqual(await openStore(linked.dir, T0), { ok: false, why: 'store' })
    assert.deepEqual(await readdir(target.dir), [], 'nothing was written through the link')
  } finally {
    await Promise.all([asFile.cleanup(), target.cleanup(), linked.cleanup()])
  }
})

test('a store that cannot be made, or whose record cannot be written, is no store - the answer says so without a path in it', async () => {
  for (const op of ['lstat', 'mkdir', 'open', 'write', 'sync', 'rename', 'open-folder', 'sync-folder']) {
    const state = await folder()
    try {
      const { fs, platform } = watched({ fail: (what) => (what === op ? 'ENOSPC' : null) })
      const result = await openStore(state.dir, T0, { fs, platform })
      assert.deepEqual(result, { ok: false, why: 'store' }, op)
      assert.ok(!JSON.stringify(result).includes(state.dir), op)
    } finally {
      await state.cleanup()
    }
  }
})

test('a store that was found without a usable record and then could not be written is not used, whatever the claims in it say', async () => {
  const state = await folder()
  try {
    await openStore(state.dir, T0)
    await rm(join(state.dir, 'claims', CLAIMS_STORE.record))
    const { fs, platform } = watched({ fail: (op) => (op === 'rename' ? 'EIO' : null) })
    assert.deepEqual(await openStore(state.dir, T0 + 60_000, { fs, platform }), { ok: false, why: 'store' })
  } finally {
    await state.cleanup()
  }
})

/* ---------- a claim ------------------------------------------------------------------------------------------------ */

test('a first claim is made; the same order again is seen, and a different order is a claim of its own', async () => {
  const state = await folder()
  try {
    await openStore(state.dir, T0)
    const first = await claimOrder(state.dir, ID, ENVELOPE, T0)
    assert.equal(first.state, 'claimed')
    assert.equal(first.dir, join(state.dir, 'claims', `${ID}.claim`))
    assert.deepEqual(await claimOrder(state.dir, ID, ENVELOPE, T0 + 1000), { state: 'seen' })
    assert.deepEqual(await claimOrder(state.dir, ID, { ...ENVELOPE, kid: 'k2' }, T0 + 2000), { state: 'seen' }, 'whatever the envelope says')
    assert.equal((await claimOrder(state.dir, OTHER_ID, ENVELOPE, T0)).state, 'claimed')
    assert.deepEqual((await readdir(join(state.dir, 'claims'))).sort(), [`${ID}.claim`, `${OTHER_ID}.claim`, CLAIMS_STORE.record].sort())
  } finally {
    await state.cleanup()
  }
})

test('a claim holds the order as it came and a receipt that it was claimed - the first words in the folder, before anything else', async () => {
  const state = await folder()
  try {
    await openStore(state.dir, T0)
    await claimOrder(state.dir, ID, ENVELOPE, T0)
    const claim = join(state.dir, 'claims', `${ID}.claim`)
    assert.deepEqual((await readdir(claim)).sort(), ['order.json', 'receipt.json'])
    assert.deepEqual(JSON.parse(await readFile(join(claim, 'order.json'), 'utf8')), { id: ID, claimedAt: '2026-10-12T14:04:00.000Z', envelope: ENVELOPE })
    assert.deepEqual(JSON.parse(await readFile(join(claim, 'receipt.json'), 'utf8')), { id: ID, state: 'claimed', at: '2026-10-12T14:04:00.000Z' })
  } finally {
    await state.cleanup()
  }
})

test('two askers at once for the same order: exactly one gets the claim', async () => {
  const state = await folder()
  try {
    await openStore(state.dir, T0)
    const answers = await Promise.all(Array.from({ length: 8 }, () => claimOrder(state.dir, ID, ENVELOPE, T0)))
    assert.equal(answers.filter((answer) => answer.state === 'claimed').length, 1)
    assert.equal(answers.filter((answer) => answer.state === 'seen').length, 7)
  } finally {
    await state.cleanup()
  }
})

test('DURABLE: the claim folder is made first, each file is written, flushed to disk and closed before it is moved into place, and the folders are flushed - all before the answer', async () => {
  const state = await folder()
  const { fs, log, platform } = watched()
  try {
    await openStore(state.dir, T0)
    log.length = 0
    const answer = await claimOrder(state.dir, ID, ENVELOPE, T0, { fs, platform })
    assert.equal(answer.state, 'claimed')
    assert.deepEqual(ops(log), [
      `mkdir ${ID}.claim`,
      'open order.json.tmp', 'write order.json.tmp', 'sync order.json.tmp', 'close order.json.tmp', 'rename order.json', `open-folder ${ID}.claim`, `sync-folder ${ID}.claim`, `close-folder ${ID}.claim`,
      'open receipt.json.tmp', 'write receipt.json.tmp', 'sync receipt.json.tmp', 'close receipt.json.tmp', 'rename receipt.json', `open-folder ${ID}.claim`, `sync-folder ${ID}.claim`, `close-folder ${ID}.claim`,
      'open-folder claims', 'sync-folder claims', 'close-folder claims'
    ])
    assert.deepEqual(log[0][2], { mode: 0o700 }, 'a folder for the owner only')
    assert.deepEqual(log[1].slice(2), ['w', 0o600], 'files for the owner only')
  } finally {
    await state.cleanup()
  }
})

test('DURABLE: the record of when the store began is written the same careful way, before any claim', async () => {
  const state = await folder()
  const { fs, log, platform } = watched()
  try {
    await openStore(state.dir, T0, { fs, platform })
    assert.deepEqual(log[0], ['mkdir', 'claims', { recursive: true, mode: 0o700 }], 'a folder for the owner only')
    assert.deepEqual(ops(log), [
      'mkdir claims',
      `open ${CLAIMS_STORE.record}.tmp`, `write ${CLAIMS_STORE.record}.tmp`, `sync ${CLAIMS_STORE.record}.tmp`, `close ${CLAIMS_STORE.record}.tmp`, `rename ${CLAIMS_STORE.record}`,
      'open-folder claims', 'sync-folder claims', 'close-folder claims'
    ])
  } finally {
    await state.cleanup()
  }
})

test('on Windows a folder cannot be opened to be flushed, so that step is left out - the files are still flushed before they are moved', async () => {
  const state = await folder()
  const { fs, log } = watched()
  try {
    await openStore(state.dir, T0, { fs, platform: 'win32' })
    await claimOrder(state.dir, ID, ENVELOPE, T0, { fs, platform: 'win32' })
    assert.ok(!ops(log).some((line) => line.startsWith('open-folder') || line.startsWith('sync-folder')))
    assert.equal(ops(log).filter((line) => line.startsWith('sync ')).length, 3)
  } finally {
    await state.cleanup()
  }
})

test('A CLAIM THAT CANNOT BE WRITTEN IS NOT A CLAIM: at every step that can fail the answer is "failed", so the caller does nothing', async () => {
  const steps = ['mkdir', 'open', 'write', 'sync', 'rename', 'open-folder', 'sync-folder']
  for (const op of steps) {
    for (const code of ['ENOSPC', 'EACCES', 'EIO']) {
      const state = await folder()
      try {
        await openStore(state.dir, T0)
        // Fail the first time this step is asked of a claim (not the store: it is already made).
        let asked = 0
        const { fs, platform } = watched({ fail: (what) => (what === op && (asked += 1) === 1 ? code : null) })
        const answer = await claimOrder(state.dir, ID, ENVELOPE, T0, { fs, platform })
        assert.deepEqual(answer, { state: 'failed' }, `${op} ${code}`)
        assert.ok(!JSON.stringify(answer).includes(state.dir))
      } finally {
        await state.cleanup()
      }
    }
  }
})

test('after a claim that half-happened the order is seen: it is never claimed a second time and never run - nothing is cleaned up behind it', async () => {
  const state = await folder()
  try {
    await openStore(state.dir, T0)
    const { fs, platform } = watched({ fail: (op, name) => (op === 'rename' && name === 'receipt.json' ? 'EIO' : null) })
    assert.deepEqual(await claimOrder(state.dir, ID, ENVELOPE, T0, { fs, platform }), { state: 'failed' })
    assert.ok((await readdir(join(state.dir, 'claims'))).includes(`${ID}.claim`), 'the folder is still there')
    assert.deepEqual(await claimOrder(state.dir, ID, ENVELOPE, T0 + 1000), { state: 'seen' })
  } finally {
    await state.cleanup()
  }
})

test('a claim folder that exists as a file or a link where the claim would go is seen too, not overwritten or followed', async () => {
  const state = await folder()
  const target = await folder()
  try {
    await openStore(state.dir, T0)
    await writeFile(join(state.dir, 'claims', `${ID}.claim`), 'in the way')
    assert.deepEqual(await claimOrder(state.dir, ID, ENVELOPE, T0), { state: 'seen' })
    try {
      await symlink(target.dir, join(state.dir, 'claims', `${OTHER_ID}.claim`), 'junction')
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return
      throw error
    }
    assert.deepEqual(await claimOrder(state.dir, OTHER_ID, ENVELOPE, T0), { state: 'seen' })
    assert.deepEqual(await readdir(target.dir), [])
  } finally {
    await Promise.all([state.cleanup(), target.cleanup()])
  }
})

test('only an id shaped like one becomes a folder name: anything else is a mistake in the caller and throws', async () => {
  const state = await folder()
  try {
    for (const bad of ['', 'abc', '../../etc', `${ID}/x`, `${ID.toUpperCase()}`, `${ID}0`, 7, null, undefined, {}, [ID]]) {
      await assert.rejects(claimOrder(state.dir, bad, ENVELOPE, T0), TypeError, String(bad))
      await assert.rejects(writeClaimFile(state.dir, bad, 'final.json', {}, {}), TypeError, String(bad))
      await assert.rejects(readClaimFile(state.dir, bad, 'final.json'), TypeError, String(bad))
    }
  } finally {
    await state.cleanup()
  }
})

/* ---------- what is written into a claim afterwards ---------------------------------------------------------------- */

test('the receipt and the final word are written into the claim, durably, and read back; no other name is allowed', async () => {
  const state = await folder()
  try {
    await openStore(state.dir, T0)
    await claimOrder(state.dir, ID, ENVELOPE, T0)
    const { fs, log, platform } = watched()
    assert.deepEqual(await writeClaimFile(state.dir, ID, 'final.json', { id: ID, outcome: 'ok' }, { fs, platform }), { ok: true })
    assert.deepEqual(ops(log), ['open final.json.tmp', 'write final.json.tmp', 'sync final.json.tmp', 'close final.json.tmp', 'rename final.json', `open-folder ${ID}.claim`, `sync-folder ${ID}.claim`, `close-folder ${ID}.claim`])
    assert.deepEqual(await readClaimFile(state.dir, ID, 'final.json'), { state: 'ok', value: { id: ID, outcome: 'ok' } })
    assert.deepEqual(await writeClaimFile(state.dir, ID, 'receipt.json', { id: ID, state: 'running' }), { ok: true })
    assert.deepEqual((await readClaimFile(state.dir, ID, 'receipt.json')).value, { id: ID, state: 'running' })
    for (const name of ['order.json', '../x.json', 'final.json.tmp', '', 'FINAL.JSON']) {
      await assert.rejects(writeClaimFile(state.dir, ID, name, {}), TypeError, name)
      await assert.rejects(readClaimFile(state.dir, ID, name), TypeError, name)
    }
  } finally {
    await state.cleanup()
  }
})

test('a claim file bigger than a claim file can be reads as broken, not as a record', async () => {
  const state = await folder()
  try {
    await openStore(state.dir, T0)
    await claimOrder(state.dir, ID, ENVELOPE, T0)
    await writeFile(join(state.dir, 'claims', `${ID}.claim`, 'final.json'), JSON.stringify({ pad: 'x'.repeat(70 * 1024) }))
    assert.deepEqual(await readClaimFile(state.dir, ID, 'final.json'), { state: 'broken' })
  } finally {
    await state.cleanup()
  }
})

test('nothing is written into a claim that is a link, whatever it points at', async () => {
  const state = await folder()
  const target = await folder()
  try {
    await openStore(state.dir, T0)
    try {
      await symlink(target.dir, join(state.dir, 'claims', `${ID}.claim`), 'junction')
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return
      throw error
    }
    assert.deepEqual(await writeClaimFile(state.dir, ID, 'final.json', {}), { ok: false })
    assert.deepEqual(await readdir(target.dir), [])
  } finally {
    await Promise.all([state.cleanup(), target.cleanup()])
  }
})

test('nothing is written into a claim that is not there, and a file that is not there or not JSON reads as missing or broken', async () => {
  const state = await folder()
  try {
    await openStore(state.dir, T0)
    assert.deepEqual(await writeClaimFile(state.dir, ID, 'final.json', {}), { ok: false })
    assert.deepEqual(await readdir(join(state.dir, 'claims')), [CLAIMS_STORE.record])
    assert.deepEqual(await readClaimFile(state.dir, ID, 'final.json'), { state: 'missing' })
    await claimOrder(state.dir, ID, ENVELOPE, T0)
    assert.deepEqual(await readClaimFile(state.dir, ID, 'final.json'), { state: 'missing' })
    await writeFile(join(state.dir, 'claims', `${ID}.claim`, 'final.json'), 'not json')
    assert.deepEqual(await readClaimFile(state.dir, ID, 'final.json'), { state: 'broken' })
  } finally {
    await state.cleanup()
  }
})

test('a write into a claim that fails says so; if it failed before the file was moved into place the earlier word is still there whole', async () => {
  const state = await folder()
  try {
    await openStore(state.dir, T0)
    await claimOrder(state.dir, ID, ENVELOPE, T0)
    for (const op of ['open', 'write', 'sync', 'rename']) {
      const { fs, platform } = watched({ fail: (what) => (what === op ? 'EIO' : null) })
      assert.deepEqual(await writeClaimFile(state.dir, ID, 'receipt.json', { id: ID, state: 'running' }, { fs, platform }), { ok: false }, op)
      assert.equal((await readClaimFile(state.dir, ID, 'receipt.json')).value.state, 'claimed', op)
    }
    // Once it is in place but the folder could not be flushed, the caller is told it is not safely written.
    for (const op of ['open-folder', 'sync-folder']) {
      const { fs, platform } = watched({ fail: (what) => (what === op ? 'EIO' : null) })
      assert.deepEqual(await writeClaimFile(state.dir, ID, 'receipt.json', { id: ID, state: 'running' }, { fs, platform }), { ok: false }, op)
    }
  } finally {
    await state.cleanup()
  }
})

/* ---------- rule 1: kept ------------------------------------------------------------------------------------------- */

test('KEPT: this code has no way to remove a claim, a claim folder or the record - not after an hour, and not ever', () => {
  const source = readFileSync(join(repoRoot, 'scripts', 'lib', 'mailbox', 'claims.mjs'), 'utf8')
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
  assert.ok(!/\b(?:rm|rmdir|unlink|rmSync|rmdirSync|unlinkSync|truncate)\s*\(/.test(code), 'something here deletes')
  assert.ok(!/\bforce\s*:/.test(code))
})

/* ---------- what the claims say about their orders ----------------------------------------------------------------- */

test('a claim may be told what its order was for: the receipt keeps the action, and without one it has none', async () => {
  const state = await folder()
  try {
    await openStore(state.dir, T0)
    await claimOrder(state.dir, ID, ENVELOPE, T0, { action: 'run' })
    await claimOrder(state.dir, OTHER_ID, ENVELOPE, T0)
    assert.deepEqual((await readClaimFile(state.dir, ID, 'receipt.json')).value, { id: ID, state: 'claimed', at: '2026-10-12T14:04:00.000Z', action: 'run' })
    assert.deepEqual((await readClaimFile(state.dir, OTHER_ID, 'receipt.json')).value, { id: OTHER_ID, state: 'claimed', at: '2026-10-12T14:04:00.000Z' })
    assert.equal(JSON.parse(await readFile(join(state.dir, 'claims', `${ID}.claim`, 'order.json'), 'utf8')).action, 'run')
    for (const action of ['shell', '', 7, null, {}, ['run']]) {
      const fresh = '22222222222222222222222222222222'
      await assert.rejects(claimOrder(state.dir, fresh, ENVELOPE, T0, { action }), TypeError, String(action))
      assert.equal(await claimExists(state.dir, fresh), false, 'nothing was made for a mistake')
    }
  } finally {
    await state.cleanup()
  }
})

test('whether a claim exists is asked without making one; anything in its place counts, and a place that cannot be looked at counts too', async () => {
  const state = await folder()
  try {
    assert.equal(await claimExists(state.dir, ID), false, 'no store yet')
    await openStore(state.dir, T0)
    assert.equal(await claimExists(state.dir, ID), false)
    assert.equal(await claimExists(state.dir, ID), false, 'asking again still made nothing')
    assert.deepEqual(await readdir(join(state.dir, 'claims')), [CLAIMS_STORE.record])
    await claimOrder(state.dir, ID, ENVELOPE, T0)
    assert.equal(await claimExists(state.dir, ID), true)
    await writeFile(join(state.dir, 'claims', `${OTHER_ID}.claim`), 'in the way')
    assert.equal(await claimExists(state.dir, OTHER_ID), true)
    const refusing = { async lstat() { throw Object.assign(new Error('a message with a path in it'), { code: 'EACCES' }) } }
    assert.equal(await claimExists(state.dir, '33333333333333333333333333333333', { fs: refusing }), true)
    for (const bad of ['', 'abc', '../x', 7, undefined, [ID]]) await assert.rejects(claimExists(state.dir, bad), TypeError, String(bad))
  } finally {
    await state.cleanup()
  }
})

test('the claims are listed newest first, as many as asked for, and only claims are listed - not the record, not stray files', async () => {
  const state = await folder()
  try {
    await openStore(state.dir, T0)
    const ids = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32), 'd'.repeat(32)]
    const { utimes } = await import('node:fs/promises')
    for (const [at, id] of ids.entries()) {
      await claimOrder(state.dir, id, ENVELOPE, T0 + at)
      await utimes(join(state.dir, 'claims', `${id}.claim`), new Date(T0 + 1000 * at), new Date(T0 + 1000 * at))
    }
    await writeFile(join(state.dir, 'claims', 'stray.txt'), 'x')
    await writeFile(join(state.dir, 'claims', `${'e'.repeat(32)}.tmp`), 'x')
    await mkdir(join(state.dir, 'claims', 'not-an-id.claim'))
    assert.deepEqual(await listClaims(state.dir, 10), [...ids].reverse())
    assert.deepEqual(await listClaims(state.dir, 2), ['d'.repeat(32), 'c'.repeat(32)])
    assert.deepEqual(await listClaims(state.dir, 0), [])
    assert.deepEqual(await listClaims(join(state.dir, 'nowhere'), 10), [])
    for (const bad of [-1, 1.5, '2', undefined, NaN]) await assert.rejects(listClaims(state.dir, bad), TypeError, String(bad))
  } finally {
    await state.cleanup()
  }
})

test('two claims made at the same moment are listed in a fixed order', async () => {
  const state = await folder()
  try {
    await openStore(state.dir, T0)
    const { utimes } = await import('node:fs/promises')
    for (const id of ['b'.repeat(32), 'a'.repeat(32)]) {
      await claimOrder(state.dir, id, ENVELOPE, T0)
      await utimes(join(state.dir, 'claims', `${id}.claim`), new Date(T0), new Date(T0))
    }
    assert.deepEqual(await listClaims(state.dir, 10), ['a'.repeat(32), 'b'.repeat(32)])
  } finally {
    await state.cleanup()
  }
})

test('a claims folder that is a file is not "no claim": nothing is claimed in it, and the question is answered as free so the claim itself fails and says so', async () => {
  const state = await folder()
  try {
    await openStore(state.dir, T0)
    await rm(join(state.dir, 'claims'), { recursive: true, force: true })
    await writeFile(join(state.dir, 'claims'), 'not a folder')
    assert.equal(await claimExists(state.dir, ID), false)
    assert.deepEqual(await claimOrder(state.dir, ID, ENVELOPE, T0), { state: 'failed' })
  } finally {
    await state.cleanup()
  }
})

test('only folders named like a claim are listed: a file with a claim\'s name is not a claim', async () => {
  const state = await folder()
  try {
    await openStore(state.dir, T0)
    await claimOrder(state.dir, ID, ENVELOPE, T0)
    await writeFile(join(state.dir, 'claims', `${OTHER_ID}.claim`), 'a file')
    await mkdir(join(state.dir, 'claims', 'not-a-claim'))
    assert.deepEqual(await listClaims(state.dir, 10), [ID])
  } finally {
    await state.cleanup()
  }
})

test('a place that is not there is free, and a place that cannot be looked at is taken - whichever way this system says "not there"', async () => {
  const saying = (code) => ({ lstat: async () => { throw Object.assign(new Error('a message with a path in it'), { code }) } })
  for (const code of ['ENOENT', 'ENOTDIR']) assert.equal(await claimExists('/state', ID, { fs: saying(code) }), false, code)
  for (const code of ['EACCES', 'EIO', 'ELOOP', undefined]) assert.equal(await claimExists('/state', ID, { fs: saying(code) }), true, String(code))
})
