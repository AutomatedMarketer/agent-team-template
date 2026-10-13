// The two kinds of secret the Mac holds for the board, and nothing else of the board's:
//   MAILBOX_KEY            lets this Mac ask the board for its pending orders. It is sent on every poll.
//   MAILBOX_SECRET_<kid>   one per signing key id: proves an order is the board's. It never leaves this Mac.
// They live in one plain file outside both clones (~/.config/agent-mailbox/env), for the owner only, read by the
// runner itself - never loaded into a shell, so nothing else on the computer inherits them. The Mac never holds the
// board's picture-store key, so it can read orders and cannot write the board's data.
//
//   # lines like these, nothing on the end of a line
//   MAILBOX_KEY=...
//   MAILBOX_SECRET_k1=...
//
// A file that is a link, a folder, too big, readable by anyone else, or not this person's reads as "broken" and is
// not even opened: the runner does not poll. A refusal is a word - 'mode', 'line', 'name' - and never a line of the
// file or a file system message (it would carry a path, and a path carries the user name).

import * as realFs from 'node:fs/promises'
import { readSmallFile } from './small-file.mjs'
import { KEY_SHAPE, SECRET_SHAPE, KID_SHAPE } from './contract.mjs'

export const ENV_FILE = Object.freeze({ name: 'env', maxBytes: 8 * 1024 })

const LINE = /^([A-Za-z0-9_-]+)=(.*)$/
const SECRET_NAME = /^MAILBOX_SECRET_(.+)$/
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff)

// One pair of matching quotes around a value goes, as in a .env file; anything else is part of the value.
function unquoted(raw) {
  const value = raw.trim()
  const quote = value[0]
  // (A value that is one quote mark alone becomes empty, which is no key either way.)
  return (quote === '"' || quote === "'") && value.at(-1) === quote ? value.slice(1, -1) : value
}

function parseEnv(source) {
  const lines = source.replace(BYTE_ORDER_MARK, '').replaceAll('\r\n', '\n').split('\n')
  const seen = new Set()
  let key = null
  const secrets = new Map()
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const parts = LINE.exec(line)
    if (!parts) return { why: 'line' }
    const [, name, raw] = parts
    const kid = SECRET_NAME.exec(name)?.[1]
    if (name !== 'MAILBOX_KEY' && !(kid !== undefined && KID_SHAPE.test(kid))) return { why: 'name' }
    if (seen.has(name)) return { why: 'duplicate' }
    seen.add(name)
    const value = unquoted(raw)
    if (name === 'MAILBOX_KEY') {
      if (!KEY_SHAPE.test(value)) return { why: 'key-shape' }
      key = value
    } else {
      if (!SECRET_SHAPE.test(value)) return { why: 'secret-shape' }
      secrets.set(kid, value)
    }
  }
  if (key === null) return { why: 'no-key' }
  if (!secrets.size) return { why: 'no-secret' }
  // The key travels with every poll and the secret never does. One value for both would put the secret on the wire.
  if ([...secrets.values()].includes(key)) return { why: 'same-secret' }
  return { key, secrets }
}

// { state: 'ok', key, secrets: Map(kid -> secret) } | { state: 'missing' } | { state: 'broken', why }
// On Windows there is no mode or owner to read, so neither is checked there (and that setup is marked not tested).
export async function readMailboxEnv(file, options = {}) {
  const { platform = process.platform, fs = realFs } = options
  const uid = 'uid' in options ? options.uid : process.getuid?.()
  const checked = platform !== 'win32'
  const refuse = (info) => {
    if (!checked) return null
    if ((info.mode & 0o077) !== 0) return 'mode'
    if (uid !== undefined && info.uid !== uid) return 'owner'
    return null
  }
  const found = await readSmallFile(file, ENV_FILE.maxBytes, fs, refuse)
  if (found.state === 'missing') return { state: 'missing' }
  if (found.state !== 'ok') return { state: 'broken', why: found.reason }
  const parsed = parseEnv(found.text)
  if (parsed.why) return { state: 'broken', why: parsed.why }
  return { state: 'ok', key: parsed.key, secrets: parsed.secrets }
}
