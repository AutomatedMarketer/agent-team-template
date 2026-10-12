import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { verifyEnvelope, signBody, keyBytes, parseInstant } from '../scripts/lib/mailbox/envelope.mjs'
import { LIFE, MAX_BODY_BYTES } from '../scripts/lib/mailbox/contract.mjs'

/* An order is { kid, body, sig }. The board signs the exact text of `body`; the Mac checks the signature
   BEFORE it parses a byte of it, then the rest of what makes an order this Mac's to run, in the contract's
   order. The board's own vectors are checked in tests/mailbox-contract.test.mjs; these are this side's own,
   with the signature written a second time here from node's crypto so the two cannot drift together. */

const SECRET = 'test-only-secret-0123456789abcdef0123456789abcdef'
const OTHER = 'a-different-test-only-secret-fedcba9876543210fedcba98'
const NOW = Date.parse('2026-10-12T14:00:00.000Z')
const REPO = 'ExampleOwner/example-team'
const RUNNER = 'mac-mini'
const ID = '0123456789abcdef0123456789abcdef'

const iso = (ms) => new Date(ms).toISOString()
const sign = (body, secret = SECRET) => createHmac('sha256', Buffer.from(secret.trim(), 'utf8')).update(body, 'utf8').digest('base64url')

function body(change = {}) {
  const order = {
    v: 1,
    id: ID,
    repo: REPO,
    runner: RUNNER,
    issuedAt: iso(NOW - 60_000),
    expiresAt: iso(NOW + 14 * 60_000),
    payload: { source: 'agent-cockpit', action: 'task', title: 'Mailbox test card' },
    ...change
  }
  for (const key of Object.keys(order)) if (order[key] === undefined) delete order[key]
  return JSON.stringify(order)
}

const entry = (text = body(), kid = 'k1', secret = SECRET) => ({ kid, body: text, sig: sign(text, secret) })
const ctx = (change = {}) => ({ keys: { k1: SECRET }, now: NOW, repo: REPO, runner: RUNNER, ...change })
const verdictOf = (given, context = ctx()) => verifyEnvelope(given, context).verdict

test('the signature is HMAC-SHA256 over the exact body text under the secret\'s own bytes, base64url without padding', () => {
  const text = body()
  assert.equal(signBody(text, SECRET), sign(text))
  assert.match(signBody(text, SECRET), /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(signBody(text, SECRET), signBody(text, OTHER))
  assert.notEqual(signBody(`${text} `, SECRET), signBody(text, SECRET), 'one more space is a different order')
  assert.deepEqual(keyBytes(SECRET), Buffer.from(SECRET, 'utf8'))
  // Never decoded: a secret that happens to be base64 is signed with as it is written.
  assert.notEqual(signBody(text, Buffer.from(SECRET).toString('base64')), signBody(text, SECRET))
})

test('a secret pasted with a line break or spaces at its ends signs the same as without them', () => {
  const text = body()
  for (const padded of [`${SECRET}\n`, `${SECRET}\r\n`, `  ${SECRET} `, `\t${SECRET}`]) {
    assert.equal(signBody(text, padded), signBody(text, SECRET))
    assert.equal(verdictOf(entry(text, 'k1', SECRET), ctx({ keys: { k1: padded } })), 'ok')
  }
  // Inside the secret a space is a different secret.
  assert.notEqual(signBody(text, 'a b'.repeat(12)), signBody(text, 'ab'.repeat(18)))
})

test('a good order passes and comes back parsed, with exactly the contract\'s keys', () => {
  const verdict = verifyEnvelope(entry(), ctx())
  assert.equal(verdict.ok, true)
  assert.equal(verdict.verdict, 'ok')
  assert.equal(verdict.authentic, true)
  assert.deepEqual(Object.keys(verdict.order), ['v', 'id', 'repo', 'runner', 'issuedAt', 'expiresAt', 'payload'])
  assert.equal(verdict.order.id, ID)
  assert.deepEqual(verdict.order.payload, { source: 'agent-cockpit', action: 'task', title: 'Mailbox test card' })
})

test('an order edited by one byte is a bad signature, untrusted, and the body is not parsed', () => {
  const edited = { ...entry(), body: body().replace('Mailbox', 'Mailbax') }
  assert.deepEqual(verifyEnvelope(edited, ctx()), { ok: false, verdict: 'bad-signature', authentic: false })
})

test('parsing never happens before the signature passes', () => {
  let parsed = 0
  const original = JSON.parse
  JSON.parse = (...args) => {
    parsed += 1
    return original(...args)
  }
  try {
    for (const bad of [
      { kid: 'k1', body: '{"v":1,"__proto__":{"x":1}}', sig: 'x'.repeat(43) },
      { kid: 'k1', body: body(), sig: sign(body(), OTHER) },
      { kid: 'k9', body: body(), sig: sign(body()) },
      { kid: 'k1', body: body(), sig: '' },
      { kid: 'k1', body: body(), sig: sign(body()), extra: 1 }
    ]) {
      assert.equal(verifyEnvelope(bad, ctx()).ok, false)
    }
    assert.equal(parsed, 0, 'something was parsed before it was signed')
    assert.equal(verifyEnvelope(entry(), ctx()).ok, true)
    assert.ok(parsed > 0)
  } finally {
    JSON.parse = original
  }
})

test('a key id that is not shaped like one, or names no key this Mac holds, is unknown - however it is signed', () => {
  assert.equal(verdictOf(entry(body(), 'k2')), 'unknown-key')
  for (const kid of ['', 'K1', 'k 1', 'k1\n', 'a'.repeat(17), 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(verdictOf({ kid, body: body(), sig: sign(body()) }), 'unknown-key', JSON.stringify(kid))
  }
  // Held under a name that is not a key id's shape: still not usable.
  assert.equal(verdictOf(entry(body(), 'K 1'), ctx({ keys: { 'K 1': SECRET } })), 'unknown-key')
  // A Map of keys works the same, and two keys are both good: the rotation.
  const both = ctx({ keys: new Map([['k1', SECRET], ['k2', OTHER]]) })
  assert.equal(verdictOf(entry(body(), 'k1'), both), 'ok')
  assert.equal(verdictOf(entry(body(), 'k2', OTHER), both), 'ok')
  assert.equal(verdictOf(entry(body(), 'k2', SECRET), both), 'bad-signature', 'k2 signed with the k1 secret')
})

test('a secret that is not of the right shape is not a key: too short, with a space inside, or not text', () => {
  const text = body()
  for (const secret of ['short', 'a'.repeat(31), 'has a space inside it, which is no secret at all 123', 'accent-é-'.repeat(8), 7, null, '']) {
    assert.equal(verdictOf({ kid: 'k1', body: text, sig: sign(text) }, ctx({ keys: { k1: secret } })), 'unknown-key', String(secret))
  }
})

test('keys are found only as the Mac\'s own, never through the prototype - even when something has put a key there', () => {
  Object.prototype.k7 = SECRET
  try {
    const text = body()
    assert.equal(verdictOf({ kid: 'k7', body: text, sig: sign(text) }), 'unknown-key')
  } finally {
    delete Object.prototype.k7
  }
})

test('an envelope that is not exactly { kid, body, sig } as text is malformed', () => {
  const good = entry()
  const cases = [null, undefined, 'x', 7, [], [good.body], {}, { kid: 'k1' }, { kid: 'k1', body: 7, sig: 'x' }, { kid: 7, body: 'x', sig: 'x' }, { kid: 'k1', body: 'x' },
    { ...good, extra: 1 }, { kid: good.kid, body: JSON.parse(good.body), sig: good.sig }]
  for (const bad of cases) assert.equal(verdictOf(bad), 'malformed', JSON.stringify(bad))
})

test('a body over 16 KB is malformed, and is not even hashed', () => {
  assert.equal(MAX_BODY_BYTES, 16384)
  const big = body({ payload: { source: 'agent-cockpit', action: 'task', title: 'x'.repeat(MAX_BODY_BYTES) } })
  assert.equal(verdictOf({ kid: 'k1', body: big, sig: sign(big) }), 'malformed')
  const justUnder = body({ payload: { source: 'agent-cockpit', action: 'task', title: 'x'.repeat(MAX_BODY_BYTES - 400) } })
  assert.ok(Buffer.byteLength(justUnder) < MAX_BODY_BYTES)
  assert.equal(verdictOf({ kid: 'k1', body: justUnder, sig: sign(justUnder) }), 'ok')
  // The limit is in bytes, not characters.
  const wide = body({ payload: { source: 'agent-cockpit', action: 'task', title: '€'.repeat(6000) } })
  assert.ok(wide.length < MAX_BODY_BYTES && Buffer.byteLength(wide) > MAX_BODY_BYTES)
  assert.equal(verdictOf({ kid: 'k1', body: wide, sig: sign(wide) }), 'malformed')
})

test('a signature that is not 43 URL-safe characters never matches, however close - padding, standard base64 and spaces included', () => {
  const text = body()
  const good = sign(text)
  const standard = createHmac('sha256', Buffer.from(SECRET)).update(text).digest('base64')
  for (const sig of [`${good}=`, ` ${good}`, `${good} `, `${standard}=`, good.slice(1), `${good}A`, good.toUpperCase(), good.replace(/[A-Za-z]/, '*'), 'é'.repeat(43), '+'.repeat(43)]) {
    assert.equal(verdictOf({ kid: 'k1', body: text, sig }), 'bad-signature', sig)
  }
})

test('the signature is compared in constant time', () => {
  const source = readFileSync(new URL('../scripts/lib/mailbox/envelope.mjs', import.meta.url), 'utf8')
  assert.match(source, /timingSafeEqual\(Buffer\.from\(sig/, 'the comparison is not timingSafeEqual')
  assert.ok(!/sig\s*===|===\s*sig|\.sig\s*==/.test(source), 'the signature is compared with an ordinary equality')
})

test('after the signature a body that is not exactly the contract\'s object is malformed - not JSON, not an object, other keys, a missing key', () => {
  const full = JSON.parse(body())
  const without = (key) => JSON.stringify(Object.fromEntries(Object.entries(full).filter(([name]) => name !== key)))
  const cases = ['not json', '{"v":1,"id":"not json', '[]', 'null', '"text"', '7', '{', JSON.stringify({ ...full, extra: 1 }), without('payload'), without('id'), without('v'), without('repo')]
  for (const text of cases) assert.deepEqual(verifyEnvelope(entry(text), ctx()), { ok: false, verdict: 'malformed', authentic: true }, text)
})

test('a signed body whose repo or runner is not shaped like one, or whose payload is not an object, is malformed', () => {
  for (const change of [{ repo: 'ExampleOwner/example-team/../other' }, { repo: 'no-slash' }, { repo: 7 }, { repo: '' }, { runner: 'Mac Mini' }, { runner: '' }, { runner: 'a'.repeat(33) }, { runner: 5 },
    { payload: null }, { payload: 'x' }, { payload: [] }, { payload: 7 }]) {
    assert.equal(verdictOf(entry(body(change))), 'malformed', JSON.stringify(change))
  }
})

test('a version, a repo or a runner that is not this Mac\'s is not an order to run here - and the order\'s id comes back to be recorded', () => {
  assert.deepEqual(verifyEnvelope(entry(body({ v: 2 })), ctx()), { ok: false, verdict: 'bad-version', authentic: true, id: ID })
  assert.deepEqual(verifyEnvelope(entry(body({ v: '1' })), ctx()), { ok: false, verdict: 'bad-version', authentic: true, id: ID })
  assert.deepEqual(verifyEnvelope(entry(body({ repo: 'ExampleOwner/other-team' })), ctx()), { ok: false, verdict: 'wrong-repo', authentic: true, id: ID })
  assert.deepEqual(verifyEnvelope(entry(body({ runner: 'old-imac' })), ctx()), { ok: false, verdict: 'wrong-runner', authentic: true, id: ID })
})

test('the checks run in the contract\'s order: version before repo before runner before times before the id', () => {
  const all = { v: 2, repo: 'ExampleOwner/other-team', runner: 'old-imac', issuedAt: iso(NOW + 3600_000), expiresAt: iso(NOW - 1000), id: 'nope' }
  assert.equal(verdictOf(entry(body(all))), 'bad-version')
  assert.equal(verdictOf(entry(body({ ...all, v: 1 }))), 'wrong-repo')
  assert.equal(verdictOf(entry(body({ ...all, v: 1, repo: REPO }))), 'wrong-runner')
  assert.equal(verdictOf(entry(body({ ...all, v: 1, repo: REPO, runner: RUNNER }))), 'issued-in-future')
  assert.equal(verdictOf(entry(body({ ...all, v: 1, repo: REPO, runner: RUNNER, issuedAt: iso(NOW - 60_000) }))), 'expired')
  assert.equal(verdictOf(entry(body({ ...all, v: 1, repo: REPO, runner: RUNNER, issuedAt: iso(NOW - 60_000), expiresAt: iso(NOW + 2 * 3600_000) }))), 'bad-life')
  assert.equal(verdictOf(entry(body({ ...all, v: 1, repo: REPO, runner: RUNNER, issuedAt: iso(NOW - 60_000), expiresAt: iso(NOW + 60_000) }))), 'bad-id')
})

test('an order that is expired, issued more than two minutes ahead, or lives over an hour is refused, to the second', () => {
  assert.equal(LIFE.futureSkewSeconds, 120)
  assert.equal(LIFE.maxSeconds, 3600)
  const verdict = (change) => verifyEnvelope(entry(body(change)), ctx())
  assert.equal(verdict({ expiresAt: iso(NOW) }).verdict, 'expired', 'expires exactly now')
  assert.equal(verdict({ expiresAt: iso(NOW - 1000) }).verdict, 'expired')
  assert.equal(verdict({ expiresAt: iso(NOW + 1) }).ok, true, 'a millisecond left is still good')
  assert.equal(verdict({ issuedAt: iso(NOW + 120_001), expiresAt: iso(NOW + 20 * 60_000) }).verdict, 'issued-in-future')
  assert.equal(verdict({ issuedAt: iso(NOW + 120_000), expiresAt: iso(NOW + 20 * 60_000) }).ok, true, 'two minutes ahead is clock drift')
  assert.equal(verdict({ issuedAt: iso(NOW - 2 * 3600_000), expiresAt: iso(NOW + 60_000) }).verdict, 'bad-life')
  assert.equal(verdict({ issuedAt: iso(NOW - 59 * 60_000), expiresAt: iso(NOW + 60_000) }).ok, true, 'exactly an hour of life')
  assert.equal(verdict({ issuedAt: iso(NOW - 59 * 60_000), expiresAt: iso(NOW + 60_001) }).verdict, 'bad-life', 'a millisecond over')
  assert.equal(verdict({ issuedAt: iso(NOW + 60_000), expiresAt: iso(NOW + 30_000) }).verdict, 'bad-life', 'ends before it begins')
  assert.equal(verdict({ issuedAt: iso(NOW + 60_000), expiresAt: iso(NOW + 60_000) }).verdict, 'bad-life', 'a life of nothing')
})

test('an id that is not 32 lower-case hex characters is refused last, and never handed back', () => {
  for (const id of ['', 'abc', '0123456789ABCDEF0123456789ABCDEF', '0123456789abcdef0123456789abcde', '0123456789abcdef0123456789abcdef0', '../../../../etc/passwd', '../../claims/0f1e2d3c4b5a6978879', '0123456789abcdef0123456789abcdeg', 7, null]) {
    assert.deepEqual(verifyEnvelope(entry(body({ id })), ctx()), { ok: false, verdict: 'bad-id', authentic: true }, String(id))
  }
})

test('a refused order with a bad id from an earlier check does not hand the bad id back either', () => {
  const verdict = verifyEnvelope(entry(body({ id: '../../x', repo: 'ExampleOwner/other-team' })), ctx())
  assert.deepEqual(verdict, { ok: false, verdict: 'wrong-repo', authentic: true })
})

test('an instant is a real moment written the one way the board writes it - the calendar is checked, not just the shape', () => {
  assert.equal(parseInstant('2026-10-12T14:00:00.000Z'), Date.parse('2026-10-12T14:00:00Z'))
  assert.equal(parseInstant('2024-02-29T00:00:00.000Z'), Date.parse('2024-02-29T00:00:00Z'), 'a leap day is a real day')
  // The date parser forgives these (it counts 2026-02-30 as March the 2nd); an order's time may not be one.
  for (const bad of ['2026-02-30T14:00:00.000Z', '2026-04-31T14:00:00.000Z', '2025-02-29T14:00:00.000Z', '2026-10-12T24:00:00.000Z', '2026-10-12T14:60:00.000Z',
    '+010000-01-01T00:00:00.000Z', '2026-10-12T14:00:00Z', '2026-10-12T14:00:00.123456Z', '2026-10-12T14:00:00.000+02:00', '2026-10-12 14:00:00.000Z', ' 2026-10-12T14:00:00.000Z', '2026-10-12', 'yesterday', '', 12345, null, undefined]) {
    assert.ok(Number.isNaN(parseInstant(bad)), String(bad))
  }
})

test('times that are not instants make the order malformed, whichever of the two it is', () => {
  for (const bad of ['yesterday', '2026-10-12T14:15:00Z', '2026-13-12T14:00:00.000Z', '2026-02-30T14:00:00.000Z', 12345, null, '']) {
    assert.equal(verdictOf(entry(body({ expiresAt: bad }))), 'malformed', String(bad))
    assert.equal(verdictOf(entry(body({ issuedAt: bad }))), 'malformed', String(bad))
  }
})

test('what the checks say never includes a word of the order, the key or the signature', () => {
  const secretText = 'PRIVATE-WORDS-IN-A-TITLE'
  const text = body({ payload: { source: 'agent-cockpit', action: 'task', title: secretText }, repo: 'ExampleOwner/other-team' })
  const verdict = verifyEnvelope(entry(text), ctx())
  assert.ok(!JSON.stringify(verdict).includes(secretText))
  assert.ok(!JSON.stringify(verdict).includes(SECRET))
  assert.ok(!JSON.stringify(verdict).includes(sign(text)))
})

test('the order is not changed by checking it, and the keys are not kept', () => {
  const given = entry()
  const frozen = JSON.stringify(given)
  const keys = { k1: SECRET }
  verifyEnvelope(given, ctx({ keys }))
  assert.equal(JSON.stringify(given), frozen)
  assert.deepEqual(keys, { k1: SECRET })
})
