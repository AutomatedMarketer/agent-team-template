// Is this an order the board really sent, for this Mac, and still in date? The checks the Mac makes, in the
// contract's order (tests/fixtures/mailbox-parity.json, `checks`), stopping at the first that fails:
//   the envelope has exactly kid, body and sig as text, and the body is not too big -> malformed
//   the key id is shaped like one and names a key this Mac holds                      -> unknown-key
//   the signature is shaped like one and matches the exact body text                  -> bad-signature
// and only then is the body parsed:
//   exactly the contract's keys, real times, shaped repo and runner, a payload object -> malformed
//   version, repo, runner, then the times, then the id          -> bad-version, wrong-repo, wrong-runner,
//                                                                  issued-in-future, expired, bad-life, bad-id
//
// A refusal is { ok: false, verdict, authentic }. `authentic` is true once the signature matched: before that
// nothing can be trusted, not even the order's id, so the caller makes no record of it - someone who cannot
// sign must not be able to fill the status file. For an authentic order refused by the checks that follow
// parsing, `id` is given back when it is shaped like an id, so the Mac can claim it and say why it was refused.
// Nothing in a refusal repeats a word of the order, the key or the signature.

import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  ORDER_VERSION,
  SECRET_SHAPE,
  SIG_SHAPE,
  KID_SHAPE,
  ENVELOPE_KEYS,
  MAX_BODY_BYTES,
  BODY_KEYS,
  ID_SHAPE,
  REPO_SHAPE,
  RUNNER_SHAPE,
  TIME_SHAPE,
  LIFE
} from './contract.mjs'

// The secret as the bytes the signature is made with: its text as UTF-8, trimmed at its two ends. The board
// trims the same way, so a line break the owner's paste left on the end changes nothing.
export const keyBytes = (secret) => Buffer.from(secret.trim(), 'utf8')

export function signBody(body, secret) {
  return createHmac('sha256', keyBytes(secret)).update(Buffer.from(body, 'utf8')).digest('base64url')
}

// An instant written the one way the board writes it (Date.prototype.toISOString), or NaN. WHY both the shape
// and the round trip: Date.parse forgives 2026-02-30 (it reads March the 2nd) and 24:00:00, and neither is a
// time the board wrote - the round trip catches what the shape cannot, a day that is not on the calendar - and
// the shape catches what survives a round trip in another form: the six-digit years (+010000) that toISOString
// writes past the year 9999. A missing millisecond part or a zone offset is stopped by both.
export function parseInstant(value) {
  if (typeof value !== 'string' || !TIME_SHAPE.test(value)) return Number.NaN
  const ms = Date.parse(value)
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : Number.NaN
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const hasExactly = (object, keys) => {
  const own = Object.keys(object)
  return own.length === keys.length && keys.every((key) => Object.hasOwn(object, key))
}

// The secret held under a key id: its own property of `keys` (an object or a Map), as text of the right shape.
function secretFor(keys, kid) {
  const secret = keys instanceof Map ? keys.get(kid) : isPlainObject(keys) && Object.hasOwn(keys, kid) ? keys[kid] : undefined
  return typeof secret === 'string' && SECRET_SHAPE.test(secret.trim()) ? secret : null
}

// entry: one element of the board's answer. ctx: { keys, now, repo, runner } - `keys` maps a key id to its
// secret, `repo` is the repo of the work copy and `runner` this Mac's label.
export function verifyEnvelope(entry, { keys, now, repo, runner }) {
  const untrusted = (verdict) => ({ ok: false, verdict, authentic: false })
  if (!isPlainObject(entry) || !hasExactly(entry, ENVELOPE_KEYS)) return untrusted('malformed')
  const { kid, body, sig } = entry
  if (typeof kid !== 'string' || typeof body !== 'string' || typeof sig !== 'string') return untrusted('malformed')
  // A body this big is not an order, and is not worth hashing.
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return untrusted('malformed')
  const secret = KID_SHAPE.test(kid) ? secretFor(keys, kid) : null
  if (secret === null) return untrusted('unknown-key')
  if (!SIG_SHAPE.test(sig)) return untrusted('bad-signature')
  // Both are 43 ASCII characters by now, so the lengths match and the compare takes the same time whatever the
  // signature says. (timingSafeEqual throws on different lengths; the shape check above is what prevents that.)
  if (!timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(signBody(body, secret), 'utf8'))) return untrusted('bad-signature')

  // Signed. Only now is the body read.
  const authentic = (verdict, id) => ({ ok: false, verdict, authentic: true, ...(id === undefined ? {} : { id }) })
  let order
  try {
    order = JSON.parse(body)
  } catch {
    return authentic('malformed')
  }
  if (!isPlainObject(order) || !hasExactly(order, BODY_KEYS)) return authentic('malformed')
  const issued = parseInstant(order.issuedAt)
  const expires = parseInstant(order.expiresAt)
  if (Number.isNaN(issued) || Number.isNaN(expires) || !isPlainObject(order.payload)) return authentic('malformed')
  if (typeof order.repo !== 'string' || !REPO_SHAPE.test(order.repo)) return authentic('malformed')
  if (typeof order.runner !== 'string' || !RUNNER_SHAPE.test(order.runner)) return authentic('malformed')

  // The order is whole. Its id is given back with a refusal only if it is shaped like one: it becomes a folder.
  const id = typeof order.id === 'string' && ID_SHAPE.test(order.id) ? order.id : undefined
  if (order.v !== ORDER_VERSION) return authentic('bad-version', id)
  if (order.repo !== repo) return authentic('wrong-repo', id)
  if (order.runner !== runner) return authentic('wrong-runner', id)
  if (issued > now + LIFE.futureSkewSeconds * 1000) return authentic('issued-in-future', id)
  if (expires <= now) return authentic('expired', id)
  const life = expires - issued
  if (life <= 0 || life > LIFE.maxSeconds * 1000) return authentic('bad-life', id)
  if (id === undefined) return authentic('bad-id')
  return { ok: true, verdict: 'ok', authentic: true, order }
}
