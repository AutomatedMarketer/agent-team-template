// What the board and the Mac runner agree on, in one place: the order's shape, the signature, the limits.
// The board holds the same values from tests/fixtures/mailbox-parity.json - the same bytes in
// agent-cockpit - and tests/mailbox-contract.test.mjs fails if this file drifts from it. The fixture is the
// contract; nothing here is invented on this side.
//
// An order the board queues is { kid, body, sig }:
//   kid   which secret signed it ("k1"), so a secret can be rotated while orders signed by the old one
//         are still in flight
//   body  the order as JSON TEXT, signed as text so neither side has to rebuild the exact JSON
//   sig   HMAC-SHA256 of that exact text under the secret's own UTF-8 bytes, base64url, 43 characters
// and the body holds exactly { v, id, repo, runner, issuedAt, expiresAt, payload }.

export const ORDER_VERSION = 1
// The secret is its own bytes, trimmed of spaces and line breaks at its two ends: never decoded from base64.
export const SECRET_SHAPE = /^[\x21-\x7e]{32,256}$/
export const SIG_SHAPE = /^[A-Za-z0-9_-]{43}$/
export const KID_SHAPE = /^[a-z0-9-]{1,16}$/
export const ENVELOPE_KEYS = ['kid', 'body', 'sig']
export const MAX_BODY_BYTES = 16384
export const BODY_KEYS = ['v', 'id', 'repo', 'runner', 'issuedAt', 'expiresAt', 'payload']
export const ID_SHAPE = /^[0-9a-f]{32}$/
export const REPO_SHAPE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/
export const RUNNER_SHAPE = /^[a-z0-9-]{1,32}$/
// Both times are written by Date.prototype.toISOString, milliseconds included.
export const TIME_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
// An order is good while issuedAt <= now + futureSkewSeconds and now < expiresAt, with
// 0 < expiresAt - issuedAt <= maxSeconds. (The board sets the life; the Mac only holds it to these.)
export const LIFE = Object.freeze({ minSeconds: 900, pollsCovered: 3, plusSeconds: 120, maxSeconds: 3600, futureSkewSeconds: 120 })

// GET /api/mailbox: the Mac's own key, and how fast the board asks it to poll.
export const API_PATH = '/api/mailbox'
export const KEY_SHAPE = /^[\x21-\x7e]{32,256}$/
export const POLL_SECONDS = Object.freeze({ min: 60, max: 3600, default: 600 })
export const MAX_ORDERS = 20
export const ANSWER_KEYS = ['v', 'pollSeconds', 'orders']

export const ACTIONS = ['run', 'pause', 'task', 'arm', 'approve', 'move', 'skill', 'agent']
export const PAYLOAD_SOURCE = 'agent-cockpit'
