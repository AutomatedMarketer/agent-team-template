// Claims: the Mac's record that it has seen an order. This is what stops one signed order running twice, so it
// holds to the three rules the contract makes about it (tests/fixtures/mailbox-parity.json, `claims`):
//
//   1. KEPT. A claim is kept at least CLAIMS.keepSeconds (contract.mjs) after its order's issuedAt - as long as the
//      same signed order could still pass every other check. Keeping them for ever is fine, and that is what this
//      does: nothing in this file removes a claim, a claim folder or the record below. (A claim older than that
//      can be deleted by hand; the order it was for has long expired.)
//   2. NEVER OLDER THAN THE STORE. When the store is first made, the moment is recorded inside it, once
//      (claims/store.json), and never changed. Every order issued before that moment is refused (verdict
//      before-claims, envelope.mjs). So a claim folder that was wiped, lost, restored from before, or is brand new
//      cannot run again an order that is still alive in the board's queue. The record is inside the folder on
//      purpose: whatever empties the folder takes it too, and the store then begins again from now. A store with no
//      usable record is not one to trust, so it is given a new record dated now - later than the truth, which only
//      ever refuses more - and the claims already in it still count as seen.
//   3. ON DISK BEFORE ANYTHING ELSE. A claim is made in one step that cannot half-happen (a new folder, which
//      exists or does not), its files are written under a temporary name, flushed to disk, moved into place and the
//      folder flushed, and only then does the caller get its answer. Nothing is edited, run, committed or pushed
//      before that answer says "claimed". If any step fails the answer is "failed", the caller does nothing, and
//      the folder - however much of it was written - stays: the order counts as seen and is never claimed again.
//
//      Windows cannot open a folder to flush it, so that one step is left out there (the files are still flushed
//      before they are moved).
//
// An answer never carries a path or a system message: a path carries the user name.

import * as realFs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ACTIONS, ID_SHAPE } from './contract.mjs'
import { parseInstant } from './envelope.mjs'
import { readSmallFile } from './small-file.mjs'

export const CLAIMS_STORE = Object.freeze({ folder: 'claims', record: 'store.json' })
// The two words a claim gets after it is made. (order.json is written once, with the claim, and never again.)
const CLAIM_FILES = ['receipt.json', 'final.json']
const RECORD_MAX_BYTES = 512
const CLAIM_FILE_MAX_BYTES = 64 * 1024
const NOT_A_STORE = Object.freeze({ ok: false, why: 'store' })

const asJson = (value) => `${JSON.stringify(value, null, 2)}\n`

function assertId(id) {
  if (typeof id !== 'string' || !ID_SHAPE.test(id)) throw new TypeError('claims: that is not an order id')
}

function assertClaimFile(name) {
  if (!CLAIM_FILES.includes(name)) throw new TypeError('claims: that is not a file a claim gets after it is made')
}

// Make a folder's contents survive a crash. A folder entry (a new file's name) is not on disk until the folder is.
async function flushFolder(fs, folder, platform) {
  if (platform === 'win32') return
  const handle = await fs.open(folder, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

// The file is written under another name, flushed, closed, moved into place, and the folder flushed - so it is
// there whole or not at all, and once this returns it is on disk.
async function writeDurably(fs, path, text, platform) {
  const temporary = `${path}.${process.pid}.tmp`
  const handle = await fs.open(temporary, 'w', 0o600)
  try {
    await handle.writeFile(text)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporary, path)
  await flushFolder(fs, dirname(path), platform)
}

// When the record says the store began: a moment in the contract's time form, in a record with that one key and
// no other. Anything else is not a record.
function recordedSince(text) {
  let record
  try {
    record = JSON.parse(text)
  } catch {
    return null
  }
  // (A list, a word or a number has no claimsSince, so it comes to nothing below; a record has only that one key.)
  if (record === null || typeof record !== 'object' || Object.keys(record).length !== 1) return null
  const since = parseInstant(record.claimsSince)
  return Number.isNaN(since) ? null : since
}

// { ok: true, since, created } - `since` is when the store began (milliseconds), `created` says this call wrote the
// record. Or { ok: false, why: 'store' }: the folder is a file or a link, or could not be made or written - and
// then nothing is claimed or run.
export async function openStore(stateDir, now, { fs = realFs, platform = process.platform } = {}) {
  const folder = join(stateDir, CLAIMS_STORE.folder)
  let info = null
  try {
    info = await fs.lstat(folder)
  } catch (error) {
    if (error?.code !== 'ENOENT') return NOT_A_STORE
  }
  // lstat does not follow a link: a link where the store should be is not a store, and nothing is written through it.
  if (info !== null && !info.isDirectory()) return NOT_A_STORE
  try {
    if (info === null) await fs.mkdir(folder, { recursive: true, mode: 0o700 })
    const found = await readSmallFile(join(folder, CLAIMS_STORE.record), RECORD_MAX_BYTES, fs)
    const since = found.state === 'ok' ? recordedSince(found.text) : null
    if (since !== null) return { ok: true, since, created: false }
    const stamp = new Date(now).toISOString()
    await writeDurably(fs, join(folder, CLAIMS_STORE.record), asJson({ claimsSince: stamp }), platform)
    return { ok: true, since: Date.parse(stamp), created: true }
  } catch {
    return NOT_A_STORE
  }
}

// { state: 'claimed', dir } - this order is the Mac's to deal with, and the claim is on disk
// { state: 'seen' }        - there already is a claim (or something where one would go): do nothing, ever
// { state: 'failed' }      - the claim could not be made whole: do nothing; the order counts as seen from now on
// The store must have been opened (openStore) first. `envelope` is the order as it came, kept in the claim.
// `action`, when given, is what the order is for (one of the contract's actions): it is kept in the claim so the status
// file can say it without anyone reading the order again.
export async function claimOrder(stateDir, id, envelope, now, { action, fs = realFs, platform = process.platform } = {}) {
  assertId(id)
  if (action !== undefined && !ACTIONS.includes(action)) throw new TypeError('claims: that is not an action')
  const claims = join(stateDir, CLAIMS_STORE.folder)
  const dir = join(claims, `${id}.claim`)
  try {
    await fs.mkdir(dir, { mode: 0o700 })
  } catch (error) {
    return error?.code === 'EEXIST' ? { state: 'seen' } : { state: 'failed' }
  }
  try {
    const at = new Date(now).toISOString()
    const kept = action === undefined ? {} : { action }
    await writeDurably(fs, join(dir, 'order.json'), asJson({ id, claimedAt: at, ...kept, envelope }), platform)
    await writeDurably(fs, join(dir, 'receipt.json'), asJson({ id, state: 'claimed', at, ...kept }), platform)
    await flushFolder(fs, claims, platform)
  } catch {
    return { state: 'failed' }
  }
  return { state: 'claimed', dir }
}

// Whether there already is a claim for this order, or anything where one would go - asked without making one. A place
// that cannot be looked at counts as taken: nothing is done on an order whose claim cannot be ruled out.
export async function claimExists(stateDir, id, { fs = realFs } = {}) {
  assertId(id)
  try {
    await fs.lstat(join(stateDir, CLAIMS_STORE.folder, `${id}.claim`))
    return true
  } catch (error) {
    return !(error?.code === 'ENOENT' || error?.code === 'ENOTDIR')
  }
}

const CLAIM_NAME = /^([0-9a-f]{32})\.claim$/

// The ids of the newest `limit` claims, newest first by when each claim's folder was last written to (two at the same
// moment in order of id). Only claims are listed. None if there is no store.
export async function listClaims(stateDir, limit, { fs = realFs } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('claims: a limit is a whole number')
  let names
  try {
    names = await fs.readdir(join(stateDir, CLAIMS_STORE.folder))
  } catch {
    return []
  }
  const found = []
  for (const name of names) {
    const id = CLAIM_NAME.exec(name)?.[1]
    if (id === undefined) continue
    try {
      const info = await fs.lstat(join(stateDir, CLAIMS_STORE.folder, name))
      if (info.isDirectory()) found.push({ id, when: info.mtimeMs })
    } catch {
      // Gone since it was listed.
    }
  }
  return found.sort((a, b) => b.when - a.when || (a.id < b.id ? -1 : 1)).slice(0, limit).map((claim) => claim.id)
}

// Replace the receipt, or write the final word, of a claim that exists. { ok: true } or { ok: false }.
export async function writeClaimFile(stateDir, id, name, record, { fs = realFs, platform = process.platform } = {}) {
  assertId(id)
  assertClaimFile(name)
  const dir = join(stateDir, CLAIMS_STORE.folder, `${id}.claim`)
  try {
    const info = await fs.lstat(dir)
    if (!info.isDirectory()) return { ok: false }
    await writeDurably(fs, join(dir, name), asJson(record), platform)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

// { state: 'ok', value } | { state: 'missing' } | { state: 'broken' }
export async function readClaimFile(stateDir, id, name, { fs = realFs } = {}) {
  assertId(id)
  assertClaimFile(name)
  const found = await readSmallFile(join(stateDir, CLAIMS_STORE.folder, `${id}.claim`, name), CLAIM_FILE_MAX_BYTES, fs)
  if (found.state !== 'ok') return { state: found.state }
  try {
    return { state: 'ok', value: JSON.parse(found.text) }
  } catch {
    return { state: 'broken' }
  }
}
