import test from 'node:test'
import assert from 'node:assert/strict'
import { pollBoard, POLL_TIMEOUT_MS, ANSWER_MAX_BYTES } from '../scripts/lib/mailbox/board.mjs'

/* The Mac asks the board for its pending orders: one GET to one address, with the Mac's own key, and nothing else is ever
   asked. The answer is not trusted either - it is read for its shape only, and every order in it is checked on its own
   (envelope.mjs) before anything happens. */

const KEY = ['poll', 'key', 'made', 'for', 'this', 'test', 'only', '0123456789'].join('-')
const BOARD = 'https://board.example.com'
const ALLOW = { board: BOARD }
const GOOD = { v: 1, pollSeconds: 300, orders: [{ kid: 'k1', body: '{}', sig: 'x'.repeat(43) }] }

function json(body, init = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, ...init })
}

// A fetch that records what it was asked and answers with what it is given.
function fakeFetch(answer) {
  const calls = []
  const fetch = async (url, options) => {
    calls.push({ url, options })
    return typeof answer === 'function' ? answer(url, options) : answer
  }
  return { fetch, calls }
}

test('one GET to the board\'s orders address, with the key as a bearer and no cookie, no redirect followed and a time limit', async () => {
  const { fetch, calls } = fakeFetch(() => json(GOOD))
  const result = await pollBoard({ allow: ALLOW, key: KEY, fetch })
  assert.deepEqual(result, { ok: true, orders: GOOD.orders, pollSeconds: 300 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://board.example.com/api/mailbox')
  assert.equal(calls[0].options.method, 'GET')
  assert.deepEqual(calls[0].options.headers, { Authorization: `Bearer ${KEY}`, Accept: 'application/json' })
  assert.equal(calls[0].options.redirect, 'manual')
  assert.equal(calls[0].options.cache, 'no-store')
  assert.equal(calls[0].options.credentials, 'omit')
  assert.ok(calls[0].options.signal instanceof AbortSignal)
  assert.equal(POLL_TIMEOUT_MS, 15_000)
})

test('the key goes to the board and nowhere else - not into the answer this gives back, whatever the board says', async () => {
  const echo = fakeFetch(() => json({ ...GOOD, echo: KEY }))
  const result = await pollBoard({ allow: ALLOW, key: KEY, fetch: echo.fetch })
  assert.equal(result.ok, false)
  assert.ok(!JSON.stringify(result).includes(KEY))
  const refused = await pollBoard({ allow: ALLOW, key: KEY, fetch: fakeFetch(() => json({ error: KEY }, { status: 401 })).fetch })
  assert.ok(!JSON.stringify(refused).includes(KEY))
})

test('the address is built from the allowlist\'s board and nothing the board or a caller adds; a board that is not https is a mistake that throws', async () => {
  for (const board of ['http://board.example.com', 'ftp://board.example.com', 'board.example.com', 'https://board.example.com/api', 'https://board.example.com?x=1', '', undefined, 7]) {
    const { fetch, calls } = fakeFetch(() => json(GOOD))
    await assert.rejects(pollBoard({ allow: { board }, key: KEY, fetch }), TypeError, String(board))
    assert.equal(calls.length, 0)
  }
})

test('a key that is not a key, or no key, is a mistake that throws before anything is asked', async () => {
  for (const key of ['', 'short', undefined, null, 7, `${KEY} with a space`, `${KEY}\n`]) {
    const { fetch, calls } = fakeFetch(() => json(GOOD))
    await assert.rejects(pollBoard({ allow: ALLOW, key, fetch }), TypeError, String(key))
    assert.equal(calls.length, 0)
  }
})

const REFUSALS = [
  ['the key is wrong', () => json({ error: 'no' }, { status: 401 }), 'board-refused'],
  ['the key is not allowed', () => json({ error: 'no' }, { status: 403 }), 'board-refused'],
  ['the board is not in mailbox mode', () => json({ error: 'no' }, { status: 503 }), 'board-unreachable'],
  ['the board has an error', () => json({}, { status: 500 }), 'board-unreachable'],
  ['the board redirects to somewhere else', () => new Response(null, { status: 302, headers: { location: 'https://evil.example/api/mailbox' } }), 'board-unreachable'],
  ['the answer is not JSON', () => new Response('<html>hello</html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'board-bad-answer'],
  ['the answer says it is JSON and is not', () => json('not json'), 'board-bad-answer'],
  ['the answer is a list', () => json([]), 'board-bad-answer'],
  ['the answer has another version', () => json({ ...GOOD, v: 2 }), 'board-bad-answer'],
  ['the answer has no version', () => json({ pollSeconds: 300, orders: [] }), 'board-bad-answer'],
  ['the answer has a key it should not', () => json({ ...GOOD, extra: true }), 'board-bad-answer'],
  ['the answer has no orders', () => json({ v: 1, pollSeconds: 300 }), 'board-bad-answer'],
  ['the orders are not a list', () => json({ ...GOOD, orders: {} }), 'board-bad-answer'],
  ['there are more than twenty orders', () => json({ ...GOOD, orders: Array.from({ length: 21 }, () => GOOD.orders[0]) }), 'board-bad-answer'],
  ['an order is not an object', () => json({ ...GOOD, orders: [7] }), 'board-bad-answer'],
  ['the pace is not a number', () => json({ ...GOOD, pollSeconds: '300' }), 'board-bad-answer'],
  ['the pace is faster than a minute', () => json({ ...GOOD, pollSeconds: 59 }), 'board-bad-answer'],
  ['the pace is slower than an hour', () => json({ ...GOOD, pollSeconds: 3601 }), 'board-bad-answer'],
  ['the pace is not whole', () => json({ ...GOOD, pollSeconds: 300.5 }), 'board-bad-answer'],
  ['the answer is far too big', () => json(`{"v":1,"pollSeconds":300,"orders":[],"x":"${'y'.repeat(ANSWER_MAX_BYTES)}"}`), 'board-bad-answer']
]

for (const [name, answer, why] of REFUSALS) {
  test(`not trusted, nothing happens: ${name}`, async () => {
    const result = await pollBoard({ allow: ALLOW, key: KEY, fetch: fakeFetch(answer).fetch })
    assert.deepEqual(result, { ok: false, why })
  })
}

test('twenty orders and a pace of exactly a minute or an hour are good', async () => {
  for (const pollSeconds of [60, 3600]) {
    const result = await pollBoard({ allow: ALLOW, key: KEY, fetch: fakeFetch(() => json({ ...GOOD, pollSeconds, orders: Array.from({ length: 20 }, () => GOOD.orders[0]) })).fetch })
    assert.equal(result.ok, true)
    assert.equal(result.orders.length, 20)
    assert.equal(result.pollSeconds, pollSeconds)
  }
  assert.deepEqual(await pollBoard({ allow: ALLOW, key: KEY, fetch: fakeFetch(() => json({ ...GOOD, orders: [] })).fetch }), { ok: true, orders: [], pollSeconds: 300 })
})

test('an answer is read up to its limit and no further, however the board sends it', async () => {
  const chunks = new ReadableStream({
    start(controller) {
      const piece = new TextEncoder().encode('x'.repeat(65536))
      for (let at = 0; at < 20; at += 1) controller.enqueue(piece)
      controller.close()
    }
  })
  const result = await pollBoard({ allow: ALLOW, key: KEY, fetch: fakeFetch(() => new Response(chunks, { status: 200, headers: { 'content-type': 'application/json' } })).fetch })
  assert.deepEqual(result, { ok: false, why: 'board-bad-answer' })
  assert.equal(ANSWER_MAX_BYTES, 512 * 1024)
})

test('a board that cannot be reached, that errors, or that takes too long is "unreachable" with no message', async () => {
  const down = await pollBoard({ allow: ALLOW, key: KEY, fetch: async () => { throw new Error(`connect ECONNREFUSED ${BOARD} with ${KEY}`) } })
  assert.deepEqual(down, { ok: false, why: 'board-unreachable' })
  const slow = await pollBoard({ allow: ALLOW, key: KEY, timeoutMs: 30, fetch: (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))) })
  assert.deepEqual(slow, { ok: false, why: 'board-unreachable' })
})

test('a board that answers and then stalls while the answer is read is cut off by the same limit', async () => {
  const stalled = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"v":1,')) } })
  const result = await pollBoard({ allow: ALLOW, key: KEY, timeoutMs: 40, fetch: fakeFetch(() => new Response(stalled, { status: 200, headers: { 'content-type': 'application/json' } })).fetch })
  assert.deepEqual(result, { ok: false, why: 'board-unreachable' })
})

const padded = (bytes) => {
  const base = '{"v":1,"pollSeconds":300,"orders":[]}'
  return base + ' '.repeat(bytes - base.length)
}

test('an answer of exactly the size limit is read, and one byte more is not - however valid it is', async () => {
  const exact = await pollBoard({ allow: ALLOW, key: KEY, fetch: fakeFetch(() => json(padded(ANSWER_MAX_BYTES))).fetch })
  assert.deepEqual(exact, { ok: true, orders: [], pollSeconds: 300 })
  const over = await pollBoard({ allow: ALLOW, key: KEY, fetch: fakeFetch(() => json(padded(ANSWER_MAX_BYTES + 1))).fetch })
  assert.deepEqual(over, { ok: false, why: 'board-bad-answer' })
})

test('reading stops at the size limit: an answer that never ends is not read to its end', async () => {
  let pulled = 0
  const endless = new ReadableStream({
    pull(controller) {
      pulled += 1
      controller.enqueue(new Uint8Array(65536).fill(32))
    }
  })
  const result = await pollBoard({ allow: ALLOW, key: KEY, timeoutMs: 3000, fetch: fakeFetch(() => new Response(endless, { status: 200, headers: { 'content-type': 'application/json' } })).fetch })
  assert.deepEqual(result, { ok: false, why: 'board-bad-answer' })
  assert.ok(pulled <= ANSWER_MAX_BYTES / 65536 + 4, `${pulled} pieces were pulled`)
})

test('a body that fails part way is "unreachable", and an answer with no body at all is a bad answer', async () => {
  const breaking = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"v":'))
      controller.error(new Error('connection reset'))
    }
  })
  const broken = await pollBoard({ allow: ALLOW, key: KEY, fetch: fakeFetch(() => new Response(breaking, { status: 200 })).fetch })
  assert.deepEqual(broken, { ok: false, why: 'board-unreachable' })
  const empty = await pollBoard({ allow: ALLOW, key: KEY, fetch: fakeFetch(() => new Response(null, { status: 200 })).fetch })
  assert.deepEqual(empty, { ok: false, why: 'board-bad-answer' })
})
