// Asking the board for this Mac's pending orders: one GET to one address, and nothing else is ever asked.
//
//   GET <board>/api/mailbox      Authorization: Bearer <MAILBOX_KEY>
//
// The address is the allowlist's board (https, a name, no path - allow.mjs) and the path the contract's; the answer
// cannot send the Mac anywhere else, because a redirect is not followed. The key goes to that one address and is never
// repeated in anything this returns. There is a time limit on the whole exchange, answers have a size limit, and an
// answer is read for its shape only: it is { v, pollSeconds, orders }, and every order in it is still checked on its own
// (envelope.mjs) before anything happens.
//
// Returns { ok: true, orders, pollSeconds } or { ok: false, why }, why being a word:
//   board-refused      the board answered 401 or 403: the key is not one it accepts
//   board-unreachable  no answer in time, an error, a redirect, or the board is not in mailbox mode
//   board-bad-answer   an answer that is not the contract's: not JSON, a key too many or too few, too big, a pace out of range

import { API_PATH, KEY_SHAPE, ANSWER_KEYS, MAX_ORDERS, POLL_SECONDS } from './contract.mjs'

export const POLL_TIMEOUT_MS = 15_000
export const ANSWER_MAX_BYTES = 512 * 1024

const UNREACHABLE = { ok: false, why: 'board-unreachable' }
const BAD = { ok: false, why: 'board-bad-answer' }

// The body, read up to the limit: past it the rest is not read.
async function readLimited(response) {
  if (!response.body) return null
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > ANSWER_MAX_BYTES) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function pollBoard({ allow, key, fetch, timeoutMs = POLL_TIMEOUT_MS }) {
  if (typeof allow?.board !== 'string' || !/^https:\/\/[^/?#\s]+$/.test(allow.board)) throw new TypeError('board: the board is an https address with no path')
  if (typeof key !== 'string' || !KEY_SHAPE.test(key)) throw new TypeError('board: the key is not a key')
  const timer = AbortSignal.timeout(timeoutMs)
  // The limit is on the whole exchange - the answer and its body - and is held here as well as by the signal, so a body that
  // stalls part way is cut off too.
  const expired = new Promise((resolve) => timer.addEventListener('abort', () => resolve(UNREACHABLE), { once: true }))
  return Promise.race([exchange({ allow, key, fetch, timer }).catch(() => UNREACHABLE), expired])
}

async function exchange({ allow, key, fetch, timer }) {
  let response
  try {
    response = await fetch(`${allow.board}${API_PATH}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      redirect: 'manual',
      cache: 'no-store',
      credentials: 'omit',
      signal: timer
    })
  } catch {
    return UNREACHABLE
  }
  if (response.status === 401 || response.status === 403) return { ok: false, why: 'board-refused' }
  if (response.status !== 200) return UNREACHABLE
  let text
  try {
    text = await readLimited(response)
  } catch {
    return UNREACHABLE
  }
  if (text === null) return BAD
  let answer
  try {
    answer = JSON.parse(text)
  } catch {
    return BAD
  }
  if (answer === null || typeof answer !== 'object') return BAD
  const keys = Object.keys(answer)
  if (keys.length !== ANSWER_KEYS.length || !ANSWER_KEYS.every((name) => Object.hasOwn(answer, name))) return BAD
  if (answer.v !== 1) return BAD
  if (!Number.isInteger(answer.pollSeconds) || answer.pollSeconds < POLL_SECONDS.min || answer.pollSeconds > POLL_SECONDS.max) return BAD
  if (!Array.isArray(answer.orders) || answer.orders.length > MAX_ORDERS) return BAD
  if (!answer.orders.every((order) => order !== null && typeof order === 'object' && !Array.isArray(order))) return BAD
  return { ok: true, orders: answer.orders, pollSeconds: answer.pollSeconds }
}
