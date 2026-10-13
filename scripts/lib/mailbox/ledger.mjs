// What the claims say about the orders, for the status file - and settling the orders the runner lost track of.
//
// The status file is built from the claims, not from what the runner remembers. A claim is on disk before anything is
// done, and its records are written as the order goes: `receipt.json` (claimed, then running) and, at the end,
// `final.json` (ok, refused, failed or unknown). So after a crash, a push that failed or a week offline, the next tick
// builds exactly the same picture, and a status that did not get pushed is simply pushed next time.
//
// An order whose claim has a receipt and no final word is one the runner stopped in the middle of: it may or may not have
// landed. It is settled once, by READING the team repo - is there a commit with this order's trailer on main? - and is
// never run again. If the team repo could not be reached the order stays "unknown, not yet checked" and is looked at
// again next time.

import { isoSeconds } from '../status/util.mjs'
import { checkMailbox } from '../status/safe.mjs'
import { MAILBOX_SCHEMA, MAILBOX_MAX_ORDERS } from '../status/mailbox-schema.mjs'
import { ACTIONS } from './contract.mjs'
import { listClaims, readClaimFile, writeClaimFile } from './claims.mjs'

const SCAN_FOR_STATUS = 60
const SCAN_FOR_UNSETTLED = 200

// A time as whole seconds in UTC, or null when it is not a time (isoSeconds gives null for a date that is not one). A number
// is not a time here: Date.parse would take 5 for a year.
function whole(value) {
  return typeof value === 'string' ? isoSeconds(Date.parse(value)) : null
}

// One status entry from a claim's records, or null when they do not say enough: a claim that cannot say what its order
// was for is never guessed at. The entry is not yet checked by the gate (see ordersFromClaims).
export function entryFromRecords(id, receipt, final) {
  const action = [final?.action, receipt?.action].find((one) => ACTIONS.includes(one))
  if (action === undefined) return null
  if (final !== null) {
    const at = whole(final.at)
    if (at === null) return null
    return { id, action, state: final.state, at, startedAt: whole(final.startedAt), finishedAt: whole(final.finishedAt), commit: final.commit ?? null, why: final.why ?? null, landed: final.landed ?? null }
  }
  const at = whole(receipt.at)
  if (at === null) return null
  const running = receipt.state === 'running'
  return { id, action, state: running ? 'running' : 'claimed', at, startedAt: running ? whole(receipt.startedAt) : null, finishedAt: null, commit: null, why: null, landed: null }
}

// Whether one entry, on its own, would pass the gate in a file made at `takenAt`.
function passesGate(entry, takenAt) {
  const file = { schema: MAILBOX_SCHEMA, takenAt: isoSeconds(takenAt), computer: 'Mac', runner: 'mac', allows: { actions: [], jobs: [] }, orders: [entry] }
  return checkMailbox(file, {}).length === 0
}

const readRecord = async (stateDir, id, name, fs) => {
  const found = await readClaimFile(stateDir, id, name, { fs })
  return found.state === 'ok' ? found.value : null
}

// The entries of the newest claims, newest first, at most `limit`: only those that pass the gate. One that does not is
// left out, and the others are not held back by it.
export async function ordersFromClaims({ stateDir, takenAt, limit = MAILBOX_MAX_ORDERS, fs }) {
  const entries = []
  for (const id of await listClaims(stateDir, SCAN_FOR_STATUS, { fs })) {
    const entry = entryFromRecords(id, await readRecord(stateDir, id, 'receipt.json', fs), await readRecord(stateDir, id, 'final.json', fs))
    if (entry !== null && passesGate(entry, takenAt)) entries.push(entry)
  }
  return entries.sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? 1 : -1)).slice(0, limit)
}

// The claims with no final word, and those marked unknown that were never checked. { id, receipt, final }.
export async function unsettledClaims({ stateDir, scan = SCAN_FOR_UNSETTLED, fs }) {
  const unsettled = []
  for (const id of await listClaims(stateDir, scan, { fs })) {
    const final = await readRecord(stateDir, id, 'final.json', fs)
    if (final !== null && !(final.state === 'unknown' && final.landed === null)) continue
    unsettled.push({ id, receipt: await readRecord(stateDir, id, 'receipt.json', fs), final })
  }
  return unsettled
}

// Settle what was lost track of. `landed(id)` reads the team repo: { state: 'found', commit } (a full hash),
// { state: 'not-found' } or { state: 'unknown' }. Each claim gets a final word of state unknown with `landed` true,
// false or - when the team repo could not be checked - null. Returns how many got a definite answer and how many are
// still unchecked (including any whose final word could not be written).
export async function reconcile({ stateDir, now, landed, fs }) {
  let settled = 0
  let unchecked = 0
  for (const claim of await unsettledClaims({ stateDir, fs })) {
    const result = await landed(claim.id)
    const found = result?.state === 'found' && /^[0-9a-f]{40,64}$/.test(result.commit ?? '')
    const definite = found || result?.state === 'not-found'
    // Still unknown and already marked so: nothing new to write.
    if (!definite && claim.final !== null) {
      unchecked += 1
      continue
    }
    const record = {
      id: claim.id,
      action: [claim.final?.action, claim.receipt?.action].find((one) => ACTIONS.includes(one)) ?? null,
      state: 'unknown',
      at: isoSeconds(now),
      startedAt: whole(claim.receipt?.startedAt),
      finishedAt: null,
      commit: found ? result.commit.slice(0, 12) : null,
      why: null,
      landed: found ? true : definite ? false : null
    }
    const written = await writeClaimFile(stateDir, claim.id, 'final.json', record, { fs })
    if (written.ok && definite) settled += 1
    else unchecked += 1
  }
  return { settled, unchecked }
}
