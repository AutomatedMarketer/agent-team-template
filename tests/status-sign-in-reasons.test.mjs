import test from 'node:test'
import assert from 'node:assert/strict'
import { collectClaudeLimits, reasonWithOrigin } from '../scripts/lib/status/claude-limits.mjs'
import { claudePlan } from '../scripts/lib/status/plans.mjs'
import { checkUsage } from '../scripts/lib/status/safe.mjs'
import { MAX_STRING_LENGTH } from '../scripts/lib/status/schema.mjs'
import { makeFakeHome, fakeClaudeToken, fakeRefreshToken, fetchStub, execStub, captureConsole } from './helpers/fake-home.mjs'

/* The first live run on the Mac Mini (2026-10-08) said "saved reading too old". The plan came
   through ("Max 20x"), so a sign-in WAS found - but it held no usable key, the live call was never
   made, and the reason shown was the last fallback's, which pointed nowhere useful. These tests
   pin the reasons that would have told the owner what happened: that the sign-in held no key, and
   where it came from - the Keychain, or the file because the Keychain gave nothing or gave
   something unreadable. Reasons only; a value is never printed or written. */

const NOW = Date.parse('2026-10-08T12:00:00Z')
const HOUR = 3600_000

const oauth = (overrides = {}) => ({
  claudeAiOauth: {
    accessToken: fakeClaudeToken(),
    refreshToken: fakeRefreshToken(),
    expiresAt: NOW + 5 * HOUR,
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    ...overrides
  }
})
const noKey = () => {
  const signIn = oauth()
  delete signIn.claudeAiOauth.accessToken
  return signIn
}
const oldSaved = { cachedUsageUtilization: { fetchedAtMs: NOW - 9 * HOUR, utilization: { five_hour: { utilization: 5 } } } }

const depsFor = (fake, extra = {}) => ({
  home: fake.home,
  env: {},
  platform: 'linux',
  now: NOW,
  fetch: fetchStub(() => ({ status: 200, body: { limits: [{ kind: 'session', percent: 3 }] } })),
  exec: execStub(() => new Error('no keychain here')),
  ...extra
})

const keychainAnswers = (text) => execStub(() => text)
const keychainSilent = () => execStub(() => new Error('The specified item could not be found in the keychain.'))

test('THE MAC MINI CASE: a sign-in with a plan but no key says so, instead of "saved reading too old"', async () => {
  const fake = await makeFakeHome({ '.claude/.credentials.json': noKey(), '.claude.json': oldSaved })
  try {
    const deps = depsFor(fake, { platform: 'darwin', exec: keychainSilent() })
    const { limits, account } = await collectClaudeLimits(deps)
    assert.deepEqual(limits, { status: 'unavailable', why: 'sign-in found but holds no key (file, no Keychain answer)' })
    assert.equal(deps.fetch.calls.length, 0, 'there was no key to send')
    assert.deepEqual(claudePlan(account), { status: 'found', name: 'Max 20x' }, 'the plan still comes through')
  } finally {
    await fake.cleanup()
  }
})

test('no key in the Keychain\'s sign-in says (Keychain)', async () => {
  const fake = await makeFakeHome()
  try {
    const { limits } = await collectClaudeLimits(depsFor(fake, { platform: 'darwin', exec: keychainAnswers(JSON.stringify(noKey())) }))
    assert.deepEqual(limits, { status: 'unavailable', why: 'sign-in found but holds no key (Keychain)' })
  } finally {
    await fake.cleanup()
  }
})

test('no key in the file off a Mac says (file)', async () => {
  const fake = await makeFakeHome({ '.claude/.credentials.json': noKey() })
  try {
    for (const blank of [undefined, '', 42, null]) {
      const signIn = oauth({ accessToken: blank })
      await fake.write('.claude/.credentials.json', signIn)
      const { limits } = await collectClaudeLimits(depsFor(fake))
      assert.deepEqual(limits, { status: 'unavailable', why: 'sign-in found but holds no key (file)' })
    }
  } finally {
    await fake.cleanup()
  }
})

test('an unreadable Keychain answer and a keyless file says the Keychain was unreadable', async () => {
  const fake = await makeFakeHome({ '.claude/.credentials.json': noKey() })
  try {
    const { limits } = await collectClaudeLimits(depsFor(fake, { platform: 'darwin', exec: keychainAnswers('not json, not hex\n') }))
    assert.deepEqual(limits, { status: 'unavailable', why: 'sign-in found but holds no key (file, Keychain unreadable)' })
  } finally {
    await fake.cleanup()
  }
})

test('on a Mac, every live reason says where the sign-in came from', async () => {
  const fake = await makeFakeHome({ '.claude/.credentials.json': oauth({ expiresAt: NOW - HOUR }) })
  try {
    const expired = await collectClaudeLimits(depsFor(fake, { platform: 'darwin', exec: keychainSilent() }))
    assert.deepEqual(expired.limits, { status: 'unavailable', why: 'sign-in expired (file, no Keychain answer)' })

    const refused = await collectClaudeLimits(depsFor(fake, {
      platform: 'darwin',
      exec: keychainAnswers(JSON.stringify(oauth())),
      fetch: fetchStub(() => ({ status: 401, body: {} }))
    }))
    assert.deepEqual(refused.limits, { status: 'unavailable', why: 'live answer refused (Keychain)' })
  } finally {
    await fake.cleanup()
  }
})

test('off a Mac the other reasons are unchanged - there was no Keychain to compare with', async () => {
  const fake = await makeFakeHome({ '.claude/.credentials.json': oauth({ expiresAt: NOW - HOUR }) })
  try {
    const { limits } = await collectClaudeLimits(depsFor(fake))
    assert.deepEqual(limits, { status: 'unavailable', why: 'sign-in expired' })
  } finally {
    await fake.cleanup()
  }
})

// `security -w` prints the item as hex when it holds bytes it will not print as text. Whether
// Claude Code's item does is not verified; reading it costs nothing and cannot misread JSON,
// which never consists of hex digits alone.
test('a Keychain answer printed as hex is decoded and used', async () => {
  const fake = await makeFakeHome()
  try {
    const hex = Buffer.from(JSON.stringify(oauth()), 'utf8').toString('hex')
    const deps = depsFor(fake, { platform: 'darwin', exec: keychainAnswers(`${hex}\n`) })
    const { printed, result } = await captureConsole(() => collectClaudeLimits(deps))
    assert.equal(result.limits.source, 'unofficial-live')
    assert.equal(deps.fetch.calls[0].init.headers.Authorization, `Bearer ${fakeClaudeToken()}`)
    assert.deepEqual(printed, [])
  } finally {
    await fake.cleanup()
  }
})

test('on a Mac with no sign-in anywhere, the log says the Keychain gave nothing and there was no file', async () => {
  const fake = await makeFakeHome()
  try {
    const { limits, tried } = await collectClaudeLimits(depsFor(fake, { platform: 'darwin', exec: keychainSilent() }))
    assert.deepEqual(limits, { status: 'not found' })
    assert.deepEqual(tried.find((entry) => entry.source === 'live'), { source: 'live', status: 'not found', why: 'no sign-in (no Keychain answer, no file)' })
  } finally {
    await fake.cleanup()
  }
})

test('a reason with its origin never grows past what the gate allows', () => {
  const reasons = [
    'sign-in found but holds no key',
    'sign-in expired',
    'live call failed',
    'live answer refused',
    'live answer not understood',
    'the live answer had no numbers in it',
    'NODE_OPTIONS changes certificates or loads code',
    'node was started with certificate, code or debug options'
  ]
  for (const why of reasons) {
    for (const origin of ['Keychain', 'file', 'file, no Keychain answer', 'file, Keychain unreadable']) {
      const text = reasonWithOrigin(why, origin)
      assert.ok(text.length <= MAX_STRING_LENGTH, `"${text}" is too long`)
      assert.ok(text.startsWith(why))
      const doc = {
        schema: 'agent-status/usage/v1',
        takenAt: '2026-10-08T12:00:00Z',
        computer: 'Test PC',
        claude: { plan: { status: 'not found' }, limits: { status: 'unavailable', why: text }, activity: { status: 'not found' } },
        codex: { plan: { status: 'not found' }, limits: { status: 'not found' } }
      }
      assert.deepEqual(checkUsage(doc, { username: 'fakeperson', home: '/Users/fakeperson', hostname: 'fake-host-77' }), [])
    }
  }
  // The full origin when it fits, the short one when it does not.
  assert.equal(reasonWithOrigin('sign-in expired', 'file, no Keychain answer'), 'sign-in expired (file, no Keychain answer)')
  assert.equal(reasonWithOrigin('the live answer had no numbers in it', 'file, no Keychain answer'), 'the live answer had no numbers in it (file)')
})

test('a reason never carries the token, whatever the sign-in held', async () => {
  const fake = await makeFakeHome({ '.claude/.credentials.json': oauth({ accessToken: { nested: fakeClaudeToken() } }) })
  try {
    const { limits } = await collectClaudeLimits(depsFor(fake, { platform: 'darwin', exec: keychainSilent() }))
    assert.ok(!JSON.stringify(limits).includes(fakeClaudeToken()))
    assert.equal(limits.why, 'sign-in found but holds no key (file, no Keychain answer)')
  } finally {
    await fake.cleanup()
  }
})
