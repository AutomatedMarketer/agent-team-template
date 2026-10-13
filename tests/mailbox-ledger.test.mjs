import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, utimes, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, claimOrder, writeClaimFile, readClaimFile } from '../scripts/lib/mailbox/claims.mjs'
import { entryFromRecords, ordersFromClaims, unsettledClaims, reconcile } from '../scripts/lib/mailbox/ledger.mjs'
import { checkMailbox } from '../scripts/lib/status/safe.mjs'
import { buildMailbox } from '../scripts/lib/mailbox/status.mjs'

/* The status file is built from the claims, not from what the runner remembers: a claim is on disk before anything is
   done and its records are written as the order goes, so after a crash, a failed push or a week offline the next tick
   rebuilds exactly the same picture. An order the runner lost track of part way is settled once, by reading the team
   repo - "is a commit with this order's trailer on main?" - and is never run again. */

const T0 = Date.parse('2026-10-12T14:04:00.000Z')
const TAKEN = Date.parse('2026-10-12T15:00:00.000Z')
const ENVELOPE = { kid: 'k1', body: '{}', sig: 'x'.repeat(43) }
const idOf = (n) => String(n).padStart(32, '0')

async function folder() {
  const dir = await mkdtemp(join(tmpdir(), 'mailbox-ledger-'))
  await openStore(dir, T0)
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const FINAL = (change = {}) => ({ id: idOf(1), action: 'task', state: 'ok', at: '2026-10-12T14:06:00Z', startedAt: null, finishedAt: '2026-10-12T14:06:00Z', commit: '3b717814fb34', why: null, landed: null, ...change })

/* ---------- one entry from the records of one claim --------------------------------------------------------------- */

test('a claim that has only its receipt is "claimed", with its time in whole seconds', () => {
  const receipt = { id: idOf(1), state: 'claimed', at: '2026-10-12T14:04:00.789Z', action: 'move' }
  assert.deepEqual(entryFromRecords(idOf(1), receipt, null), { id: idOf(1), action: 'move', state: 'claimed', at: '2026-10-12T14:04:00Z', startedAt: null, finishedAt: null, commit: null, why: null, landed: null })
})

test('a receipt that says running is "running", with when it began', () => {
  const receipt = { id: idOf(1), state: 'running', at: '2026-10-12T14:05:30.100Z', startedAt: '2026-10-12T14:05:30.100Z', action: 'run' }
  assert.deepEqual(entryFromRecords(idOf(1), receipt, null), { id: idOf(1), action: 'run', state: 'running', at: '2026-10-12T14:05:30Z', startedAt: '2026-10-12T14:05:30Z', finishedAt: null, commit: null, why: null, landed: null })
})

test('the final word wins over the receipt, in every state, as the final record has it', () => {
  const receipt = { id: idOf(1), state: 'running', at: '2026-10-12T14:05:30Z', startedAt: '2026-10-12T14:05:30Z', action: 'task' }
  for (const final of [
    FINAL(),
    FINAL({ state: 'refused', why: 'job-not-allowed', commit: null, finishedAt: null }),
    FINAL({ state: 'failed', why: 'push-failed', commit: null, startedAt: '2026-10-12T14:05:30Z' }),
    FINAL({ state: 'unknown', why: null, landed: true, finishedAt: null }),
    FINAL({ state: 'unknown', why: null, landed: false, commit: null, finishedAt: null }),
    FINAL({ state: 'unknown', why: null, landed: null, commit: null, finishedAt: null })
  ]) {
    const entry = entryFromRecords(idOf(1), receipt, final)
    assert.deepEqual(entry, { id: idOf(1), action: 'task', state: final.state, at: final.at, startedAt: final.startedAt, finishedAt: final.finishedAt, commit: final.commit, why: final.why, landed: final.landed })
  }
})

test('the id is the claim\'s own, whatever a record says; and the action comes from the final word first, then the receipt', () => {
  const receipt = { id: idOf(1), state: 'claimed', at: '2026-10-12T14:04:00Z', action: 'move' }
  assert.equal(entryFromRecords(idOf(1), receipt, FINAL({ id: idOf(9) })).id, idOf(1))
  assert.equal(entryFromRecords(idOf(1), receipt, FINAL({ action: 'run' })).action, 'run')
  assert.equal(entryFromRecords(idOf(1), receipt, FINAL({ action: undefined })).action, 'move')
})

test('a claim that cannot say what its order was for, or whose records are not records, has no entry - it is never guessed at', () => {
  const receipt = { id: idOf(1), state: 'claimed', at: '2026-10-12T14:04:00Z', action: 'task' }
  assert.equal(entryFromRecords(idOf(1), null, null), null)
  assert.equal(entryFromRecords(idOf(1), { ...receipt, action: undefined }, null), null)
  assert.equal(entryFromRecords(idOf(1), { ...receipt, action: 'shell' }, null), null)
  assert.equal(entryFromRecords(idOf(1), { ...receipt, at: 'yesterday' }, null), null)
  assert.equal(entryFromRecords(idOf(1), { ...receipt, at: undefined }, null), null)
  assert.equal(entryFromRecords(idOf(1), receipt, FINAL({ at: 'soon' })), null)
  assert.equal(entryFromRecords(idOf(1), receipt, 'not a record'), null)
  assert.equal(entryFromRecords(idOf(1), receipt, []), null)
  assert.equal(entryFromRecords(idOf(1), 'not a record', null), null)
})

test('a time is read only from text: a number is not a time, however much Date.parse would make of it', () => {
  const receipt = { id: idOf(1), state: 'claimed', at: '2026-10-12T14:04:00Z', action: 'task' }
  for (const at of [5, 1760278320000, true, {}, ['2026-10-12T14:04:00Z']]) {
    assert.equal(entryFromRecords(idOf(1), { ...receipt, at }, null), null, JSON.stringify(at))
    assert.equal(entryFromRecords(idOf(1), receipt, FINAL({ at })), null, JSON.stringify(at))
  }
  // And a start that is not a time is only "no start", not a reason to drop the entry.
  const running = { ...receipt, state: 'running', startedAt: 5 }
  assert.equal(entryFromRecords(idOf(1), running, null).startedAt, null)
})

test('two entries from the same second are in a fixed order, by id, whichever claim was written first', async () => {
  const state = await folder()
  try {
    for (const at of [3, 1, 2]) {
      await claimOrder(state.dir, idOf(at), ENVELOPE, T0 + at * 1000, { action: 'task' })
      await writeClaimFile(state.dir, idOf(at), 'final.json', FINAL({ id: idOf(at) }))
    }
    assert.deepEqual((await ordersFromClaims({ stateDir: state.dir, takenAt: TAKEN })).map((entry) => entry.id), [idOf(1), idOf(2), idOf(3)])
  } finally {
    await state.cleanup()
  }
})

/* ---------- the entries of the newest claims ----------------------------------------------------------------------- */

test('the entries are those of the newest claims, newest first, and pass the gate as a file', async () => {
  const state = await folder()
  try {
    for (let at = 1; at <= 25; at += 1) {
      await claimOrder(state.dir, idOf(at), ENVELOPE, T0 + at * 1000, { action: 'task' })
      await writeClaimFile(state.dir, idOf(at), 'final.json', FINAL({ id: idOf(at), at: `2026-10-12T14:${String(10 + at).padStart(2, '0')}:00Z`, finishedAt: `2026-10-12T14:${String(10 + at).padStart(2, '0')}:00Z` }))
      await utimes(join(state.dir, 'claims', `${idOf(at)}.claim`), new Date(T0 + at * 1000), new Date(T0 + at * 1000))
    }
    const entries = await ordersFromClaims({ stateDir: state.dir, takenAt: TAKEN })
    assert.equal(entries.length, 20)
    assert.equal(entries[0].id, idOf(25))
    assert.equal(entries.at(-1).id, idOf(6))
    const doc = buildMailbox({ computer: 'Mac Mini', runner: 'mac-mini', takenAt: TAKEN, allows: { actions: ['task'], jobs: [] }, orders: entries })
    assert.deepEqual(checkMailbox(doc, {}), [])
    assert.equal((await ordersFromClaims({ stateDir: state.dir, takenAt: TAKEN, limit: 3 })).length, 3)
  } finally {
    await state.cleanup()
  }
})

test('a claim whose records would not pass the gate is left out, and the others are not held back by it', async () => {
  const state = await folder()
  try {
    await claimOrder(state.dir, idOf(1), ENVELOPE, T0, { action: 'task' })
    await claimOrder(state.dir, idOf(2), ENVELOPE, T0 + 1000, { action: 'task' })
    await claimOrder(state.dir, idOf(3), ENVELOPE, T0 + 2000, { action: 'task' })
    await claimOrder(state.dir, idOf(4), ENVELOPE, T0 + 3000, { action: 'task' })
    await writeClaimFile(state.dir, idOf(1), 'final.json', FINAL({ id: idOf(1), why: 'a sentence an attacker wrote' }))
    await writeClaimFile(state.dir, idOf(2), 'final.json', FINAL({ id: idOf(2), commit: 'not a commit' }))
    await writeClaimFile(state.dir, idOf(3), 'final.json', FINAL({ id: idOf(3), at: '2026-10-12T16:00:00Z', finishedAt: '2026-10-12T16:00:00Z' }))
    const entries = await ordersFromClaims({ stateDir: state.dir, takenAt: TAKEN })
    assert.deepEqual(entries.map((entry) => entry.id), [idOf(4)], 'a time after the file is made is left out too')
  } finally {
    await state.cleanup()
  }
})

test('no claims, and no store at all, give no entries', async () => {
  const state = await folder()
  try {
    assert.deepEqual(await ordersFromClaims({ stateDir: state.dir, takenAt: TAKEN }), [])
    assert.deepEqual(await ordersFromClaims({ stateDir: join(state.dir, 'nowhere'), takenAt: TAKEN }), [])
  } finally {
    await state.cleanup()
  }
})

/* ---------- orders the runner lost track of ------------------------------------------------------------------------ */

test('a claim with no final word is unsettled; so is one marked unknown that was never checked; a settled one is not', async () => {
  const state = await folder()
  try {
    for (let at = 1; at <= 5; at += 1) await claimOrder(state.dir, idOf(at), ENVELOPE, T0 + at * 1000, { action: 'task' })
    await writeClaimFile(state.dir, idOf(2), 'final.json', FINAL({ id: idOf(2) }))
    await writeClaimFile(state.dir, idOf(3), 'final.json', FINAL({ id: idOf(3), state: 'unknown', why: null, landed: null, commit: null, finishedAt: null }))
    await writeClaimFile(state.dir, idOf(4), 'final.json', FINAL({ id: idOf(4), state: 'unknown', why: null, landed: false, commit: null, finishedAt: null }))
    await writeClaimFile(state.dir, idOf(5), 'final.json', FINAL({ id: idOf(5), state: 'refused', why: 'expired', commit: null, finishedAt: null }))
    const unsettled = await unsettledClaims({ stateDir: state.dir })
    assert.deepEqual(unsettled.map((claim) => claim.id).sort(), [idOf(1), idOf(3)])
    assert.equal(unsettled.find((claim) => claim.id === idOf(1)).receipt.state, 'claimed')
    assert.equal(unsettled.find((claim) => claim.id === idOf(1)).final, null)
  } finally {
    await state.cleanup()
  }
})

test('a claim whose receipt was lost is unsettled too - and will be settled with no action, so it has no entry', async () => {
  const state = await folder()
  try {
    await claimOrder(state.dir, idOf(1), ENVELOPE, T0, { action: 'task' })
    await rm(join(state.dir, 'claims', `${idOf(1)}.claim`, 'receipt.json'))
    const unsettled = await unsettledClaims({ stateDir: state.dir })
    assert.deepEqual(unsettled.map((claim) => [claim.id, claim.receipt]), [[idOf(1), null]])
    await reconcile({ stateDir: state.dir, now: TAKEN, landed: async () => ({ state: 'not-found' }) })
    assert.equal((await readClaimFile(state.dir, idOf(1), 'final.json')).value.action, null)
    assert.deepEqual(await ordersFromClaims({ stateDir: state.dir, takenAt: TAKEN }), [])
  } finally {
    await state.cleanup()
  }
})

test('SETTLED BY READING: an unknown order is looked for on the team repo - found, not found, or could not be checked - and never run again', async () => {
  const state = await folder()
  try {
    for (let at = 1; at <= 3; at += 1) await claimOrder(state.dir, idOf(at), ENVELOPE, T0 + at * 1000, { action: 'run' })
    await writeClaimFile(state.dir, idOf(1), 'receipt.json', { id: idOf(1), state: 'running', at: '2026-10-12T14:05:01Z', startedAt: '2026-10-12T14:05:01Z', action: 'run' })
    const asked = []
    const landed = async (id) => {
      asked.push(id)
      return { [idOf(1)]: { state: 'found', commit: 'a'.repeat(40) }, [idOf(2)]: { state: 'not-found' }, [idOf(3)]: { state: 'unknown' } }[id]
    }
    const result = await reconcile({ stateDir: state.dir, now: TAKEN, landed })
    assert.deepEqual(result, { settled: 2, unchecked: 1 })
    assert.deepEqual(asked.sort(), [idOf(1), idOf(2), idOf(3)])
    const finals = Object.fromEntries(await Promise.all([1, 2, 3].map(async (at) => [at, (await readClaimFile(state.dir, idOf(at), 'final.json')).value])))
    assert.deepEqual(finals[1], { id: idOf(1), action: 'run', state: 'unknown', at: '2026-10-12T15:00:00Z', startedAt: '2026-10-12T14:05:01Z', finishedAt: null, commit: 'aaaaaaaaaaaa', why: null, landed: true })
    assert.deepEqual(finals[2], { id: idOf(2), action: 'run', state: 'unknown', at: '2026-10-12T15:00:00Z', startedAt: null, finishedAt: null, commit: null, why: null, landed: false })
    assert.deepEqual(finals[3], { id: idOf(3), action: 'run', state: 'unknown', at: '2026-10-12T15:00:00Z', startedAt: null, finishedAt: null, commit: null, why: null, landed: null })
    const doc = buildMailbox({ computer: 'Mac Mini', runner: 'mac-mini', takenAt: TAKEN, allows: { actions: ['run'], jobs: [] }, orders: await ordersFromClaims({ stateDir: state.dir, takenAt: TAKEN }) })
    assert.deepEqual(checkMailbox(doc, {}), [])
    assert.deepEqual(doc.orders.map((order) => [order.id, order.state, order.landed]).sort(), [[idOf(1), 'unknown', true], [idOf(2), 'unknown', false], [idOf(3), 'unknown', null]])
  } finally {
    await state.cleanup()
  }
})

test('one that could not be checked is checked again next time, and one that was settled is not asked about again', async () => {
  const state = await folder()
  try {
    await claimOrder(state.dir, idOf(1), ENVELOPE, T0, { action: 'task' })
    await claimOrder(state.dir, idOf(2), ENVELOPE, T0 + 1000, { action: 'task' })
    assert.deepEqual(await reconcile({ stateDir: state.dir, now: TAKEN, landed: async (id) => (id === idOf(1) ? { state: 'unknown' } : { state: 'not-found' }) }), { settled: 1, unchecked: 1 })
    const asked = []
    const second = await reconcile({ stateDir: state.dir, now: TAKEN + 60_000, landed: async (id) => { asked.push(id); return { state: 'found', commit: 'b'.repeat(40) } } })
    assert.deepEqual(second, { settled: 1, unchecked: 0 })
    assert.deepEqual(asked, [idOf(1)])
    assert.equal((await readClaimFile(state.dir, idOf(1), 'final.json')).value.landed, true)
    assert.equal((await readClaimFile(state.dir, idOf(2), 'final.json')).value.landed, false)
  } finally {
    await state.cleanup()
  }
})

test('a claim still unchecked and still unknown is left as it is, not written again', async () => {
  const state = await folder()
  try {
    await claimOrder(state.dir, idOf(1), ENVELOPE, T0, { action: 'task' })
    await reconcile({ stateDir: state.dir, now: TAKEN, landed: async () => ({ state: 'unknown' }) })
    const path = join(state.dir, 'claims', `${idOf(1)}.claim`, 'final.json')
    const before = await readFile(path, 'utf8')
    await reconcile({ stateDir: state.dir, now: TAKEN + 600_000, landed: async () => ({ state: 'unknown' }) })
    assert.equal(await readFile(path, 'utf8'), before)
  } finally {
    await state.cleanup()
  }
})

test('nothing to settle is nothing done; a final word that cannot be written is counted, not hidden', async () => {
  const state = await folder()
  try {
    assert.deepEqual(await reconcile({ stateDir: state.dir, now: TAKEN, landed: async () => { throw new Error('asked') } }), { settled: 0, unchecked: 0 })
    await claimOrder(state.dir, idOf(1), ENVELOPE, T0, { action: 'task' })
    const result = await reconcile({ stateDir: state.dir, now: TAKEN, landed: async () => ({ state: 'not-found' }), fs: { ...(await import('node:fs/promises')), async open() { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }) } } })
    assert.deepEqual(result, { settled: 0, unchecked: 1 })
  } finally {
    await state.cleanup()
  }
})

test('a landed commit is kept as its first twelve characters, and anything else the check says is not believed', async () => {
  const state = await folder()
  try {
    await claimOrder(state.dir, idOf(1), ENVELOPE, T0, { action: 'task' })
    for (const bad of [{ state: 'found', commit: 'not a hash' }, { state: 'found' }, { state: 'found', commit: 'abc' }, { state: 'other' }, null, undefined]) {
      const result = await reconcile({ stateDir: state.dir, now: TAKEN, landed: async () => bad })
      assert.deepEqual(result, { settled: 0, unchecked: 1 }, JSON.stringify(bad))
    }
    assert.equal((await readClaimFile(state.dir, idOf(1), 'final.json')).value.landed, null)
  } finally {
    await state.cleanup()
  }
})
