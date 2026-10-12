import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './helpers/repo.mjs'
import { verifyEnvelope, signBody } from '../scripts/lib/mailbox/envelope.mjs'
import * as contract from '../scripts/lib/mailbox/contract.mjs'

/* tests/fixtures/mailbox-parity.json is the Mac mailbox's contract, the same bytes in agent-cockpit (copied
   from there, never written here). The board signs and checks orders by it; this side checks them by it
   again. Each section of the runner is held to its part of the fixture in this one file. */

const fixturePath = join(repoRoot, 'tests', 'fixtures', 'mailbox-parity.json')
const raw = readFileSync(fixturePath)
const fixture = JSON.parse(raw.toString('utf8'))
const NOW = Date.parse(fixture.test.now)
const expectation = { keys: fixture.test.keys, repo: fixture.test.repo, runner: fixture.test.runner, now: NOW }

// A shape as the fixture writes it, compiled, so a slash written plainly and an escaped one compare equal.
const shape = (source) => new RegExp(source).source

test('mailbox parity: the contract file is ASCII with LF line ends, so its bytes survive any editor or checkout', () => {
  assert.ok([...raw].every((byte) => byte === 0x0a || (byte >= 0x20 && byte <= 0x7e)), 'a byte outside printable ASCII')
  assert.ok(!raw.includes(0x0d), 'a carriage return')
})

test('mailbox parity: the shared contract file is the same bytes the board holds', (t) => {
  const sibling = join(repoRoot, '..', 'agent-cockpit', 'tests', 'fixtures', 'mailbox-parity.json')
  if (!existsSync(sibling)) {
    t.skip('SKIPPED, not passed: agent-cockpit has no tests/fixtures/mailbox-parity.json beside this repo, so the two copies could not be compared. The tests below still hold this side to this copy.')
    return
  }
  assert.equal(readFileSync(sibling, 'utf8'), raw.toString('utf8'), 'the shared mailbox contract has been edited on one side only')
})

test('mailbox parity: this side\'s numbers, shapes and lists are the contract\'s', () => {
  assert.equal(contract.ORDER_VERSION, fixture.version)
  assert.equal(contract.SECRET_SHAPE.source, shape(fixture.signing.secretShape))
  assert.equal(contract.SIG_SHAPE.source, shape(fixture.signing.sigShape))
  assert.equal(contract.KID_SHAPE.source, shape(fixture.signing.kidShape))
  assert.deepEqual(contract.ENVELOPE_KEYS, fixture.envelope.keys)
  assert.equal(contract.MAX_BODY_BYTES, fixture.envelope.maxBodyBytes)
  assert.deepEqual(contract.BODY_KEYS, fixture.body.keys)
  assert.equal(contract.ID_SHAPE.source, shape(fixture.body.idShape))
  assert.equal(contract.REPO_SHAPE.source, shape(fixture.body.repoShape))
  assert.equal(contract.RUNNER_SHAPE.source, shape(fixture.body.runnerShape))
  assert.equal(contract.TIME_SHAPE.source, shape(fixture.body.timeShape))
  for (const key of ['minSeconds', 'pollsCovered', 'plusSeconds', 'maxSeconds', 'futureSkewSeconds']) assert.equal(contract.LIFE[key], fixture.life[key], `life.${key}`)
  assert.equal(contract.API_PATH, fixture.api.path)
  assert.equal(contract.KEY_SHAPE.source, shape(fixture.api.keyShape))
  assert.deepEqual({ ...contract.POLL_SECONDS }, fixture.api.pollSeconds)
  assert.equal(contract.MAX_ORDERS, fixture.api.maxOrders)
  assert.deepEqual(contract.ANSWER_KEYS, fixture.api.responseKeys)
  assert.deepEqual(contract.ACTIONS, fixture.actions)
  assert.equal(contract.PAYLOAD_SOURCE, fixture.payload.source)
})

test('mailbox parity: the runner signs each good order\'s body to the exact signature in the contract', () => {
  const good = fixture.orders.filter((order) => order.verdict === 'ok')
  assert.ok(good.length >= 3)
  for (const { name, envelope } of good) assert.equal(signBody(envelope.body, fixture.test.keys[envelope.kid]), envelope.sig, name)
})

test('mailbox parity: every order in the contract gets the contract\'s verdict, checked in the contract\'s order', () => {
  const verdicts = new Set(fixture.checks.map((check) => check.verdict))
  for (const { name, envelope, verdict } of fixture.orders) {
    assert.ok(verdicts.has(verdict), `${name}: ${verdict} is not a verdict the contract lists`)
    const result = verifyEnvelope(envelope, expectation)
    assert.equal(result.verdict, verdict, name)
    assert.equal(result.ok, verdict === 'ok', name)
    if (verdict === 'ok') {
      assert.deepEqual(result.order, JSON.parse(envelope.body), `${name}: the order given back is not the body that was signed`)
    } else {
      assert.equal(result.order, undefined, `${name}: a refused order was given back`)
    }
  }
  // Each verdict the contract names is reached by at least one case.
  for (const verdict of verdicts) assert.ok(fixture.orders.some((order) => order.verdict === verdict), `no case reaches ${verdict}`)
})

test('mailbox parity: a body is never parsed before its signature matches', () => {
  const original = JSON.parse
  let parsed = 0
  JSON.parse = (...args) => {
    parsed += 1
    return original(...args)
  }
  try {
    for (const { envelope, verdict } of fixture.orders) {
      parsed = 0
      verifyEnvelope(envelope, expectation)
      if (['bad-signature', 'unknown-key'].includes(verdict)) assert.equal(parsed, 0, `${verdict}: the body was parsed`)
    }
  } finally {
    JSON.parse = original
  }
})

test('mailbox parity: only an order that was signed is called authentic, and a refused one gives back its id only when it is shaped like one', () => {
  for (const { name, envelope, verdict } of fixture.orders) {
    const result = verifyEnvelope(envelope, expectation)
    if (['unknown-key', 'bad-signature'].includes(verdict)) assert.equal(result.authentic, false, name)
    // 'malformed' is both before the signature (a wrong envelope) and after it (a wrong body): it says nothing here.
    else if (verdict !== 'malformed') assert.equal(result.authentic, true, name)
    if (result.id !== undefined) {
      assert.ok(result.authentic, `${name}: an id from an order nobody signed`)
      assert.match(result.id, new RegExp(fixture.body.idShape), name)
    }
  }
})
