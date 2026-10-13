// The status file the runner writes for the board: .agent-team/status/mailbox/<runner>.json, one per computer, pushed in
// the same commit as each order's change and on its own when an order is refused or fails. Its shape is the shared
// contract's (mailbox-schema.mjs); this builds it, keeps the newest twenty orders, and writes it through the safety gate
// every status file passes - a file that does not pass is never written. An order has one entry, found by its id.

import { join } from 'node:path'
import { isoSeconds } from '../status/util.mjs'
import { writeSnapshot } from '../status/write.mjs'
import { checkMailbox, GateError } from '../status/safe.mjs'
import { MAILBOX_SCHEMA, MAILBOX_MAX_ORDERS, MAILBOX_MAX_FILE_BYTES, mailboxPath } from '../status/mailbox-schema.mjs'
import { readSmallFile } from './small-file.mjs'

// The orders with `entry` added, or put in the place of the one with its id. The list given is not changed.
export const upsertOrder = (orders, entry) => [...orders.filter((order) => order.id !== entry.id), entry]

// Newest first by the time of the last word on each; two at the same second keep a fixed order, by id.
const byNewest = (a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? 1 : -1)

export function buildMailbox({ computer, runner, takenAt, allows, orders }) {
  return {
    schema: MAILBOX_SCHEMA,
    takenAt: isoSeconds(takenAt),
    computer,
    runner,
    allows: { actions: [...allows.actions], jobs: [...allows.jobs].sort() },
    orders: [...orders].sort(byNewest).slice(0, MAILBOX_MAX_ORDERS)
  }
}

// The file already in the work copy, to build on - or null when there is none, it cannot be read, it is not this
// runner's, or it would not pass the gate. Nothing that is not a good file is carried forward.
export async function readMailboxStatus({ root, runner, identity = {} }) {
  const relative = mailboxPath(runner)
  if (relative === null) return null
  const found = await readSmallFile(join(root, ...relative.split('/')), MAILBOX_MAX_FILE_BYTES)
  if (found.state !== 'ok') return null
  let doc
  try {
    doc = JSON.parse(found.text)
  } catch {
    return null
  }
  return doc?.runner === runner && checkMailbox(doc, identity).length === 0 ? doc : null
}

// Check, then write. Returns the file's path in the work copy. Throws GateError, and writes nothing, for a file that
// does not pass, or throws for a place that is, or goes through, a link. (The gate bounds the file - twenty entries of
// short fixed words - so it can never come near the size the board reads up to.)
export async function writeMailboxStatus({ root, doc, identity, git }) {
  const problems = checkMailbox(doc, identity)
  if (problems.length) throw new GateError(problems)
  const relative = mailboxPath(doc.runner)
  const text = `${JSON.stringify(doc, null, 2)}\n`
  await writeSnapshot(root, relative, text, { git })
  return relative
}
