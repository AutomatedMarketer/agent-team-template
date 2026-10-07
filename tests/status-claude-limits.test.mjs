import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  collectClaudeLimits,
  parseClaudeUsage,
  USAGE_URL,
  USER_AGENT,
  KEYCHAIN_COMMAND
} from '../scripts/lib/status/claude-limits.mjs'
import { probe } from '../.claude/skills/surplus-burn/usage-probe.mjs'
import {
  makeFakeHome,
  fakeClaudeToken,
  fakeRefreshToken,
  fetchStub,
  execStub,
  captureConsole,
  FAKE_EMAIL,
  FAKE_UUID
} from './helpers/fake-home.mjs'

const NOW = Date.parse('2026-10-07T20:00:00Z')
const HOUR = 3600_000

const credentials = (overrides = {}) => ({
  claudeAiOauth: {
    accessToken: fakeClaudeToken(),
    refreshToken: fakeRefreshToken(),
    expiresAt: NOW + 5 * HOUR,
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    ...overrides
  },
  mcpOAuth: { someServer: { accessToken: fakeClaudeToken() } }
})

// The answer shape seen on 2026-10-07: a limits list, plus older flat fields and codenamed ones.
const newAnswer = () => ({
  five_hour: { utilization: 18, resets_at: '2026-10-07T21:40:00.099908+00:00' },
  seven_day: { utilization: 49, resets_at: '2026-10-09T22:00:00+00:00' },
  fable_weekly: { utilization: 2 },
  iguana_necktie: { utilization: 77 },
  limits: [
    { kind: 'session', percent: 18, resets_at: '2026-10-07T21:40:00.099908+00:00' },
    { kind: 'weekly_all', percent: 49, resets_at: '2026-10-09T22:00:00+00:00' },
    { kind: 'weekly_scoped', percent: 2, resets_at: '2026-10-09T22:00:00+00:00', scope: { model: { display_name: 'Fable' } } },
    { kind: 'weekly_scoped', percent: 55, scope: null },
    { kind: 'mystery_codename', percent: 99 }
  ]
})

const savedReading = (fetchedAtMs, utilization = newAnswer()) => ({
  oauthAccount: { emailAddress: FAKE_EMAIL, accountUuid: FAKE_UUID, displayName: 'Fake Person' },
  cachedUsageUtilization: { fetchedAtMs, utilization }
})

const depsFor = (fake, extra = {}) => ({
  home: fake.home,
  env: {},
  platform: 'linux',
  now: NOW,
  fetch: fetchStub(() => ({ status: 200, body: newAnswer() })),
  exec: execStub(() => new Error('no keychain here')),
  ...extra
})

// --- the parser -----------------------------------------------------------------------------------

test('parser: the limits list becomes three windows, codenames and unscoped entries ignored', () => {
  assert.deepEqual(parseClaudeUsage(newAnswer()), [
    { kind: 'five_hour', usedPercent: 18, resetsAt: '2026-10-07T21:40:00Z' },
    { kind: 'weekly_all', usedPercent: 49, resetsAt: '2026-10-09T22:00:00Z' },
    { kind: 'weekly_model', model: 'Fable', usedPercent: 2, resetsAt: '2026-10-09T22:00:00Z' }
  ])
})

test('parser: the older flat shape still reads, with seconds-since-epoch reset times', () => {
  const windows = parseClaudeUsage({
    five_hour: { utilization: 12.34, resets_at: 1791406800 },
    seven_day: { utilization: 40, resets_at: '2026-10-09T22:00:00Z' },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 3 },
    seven_day_oauth_apps: { utilization: 50 }
  })
  assert.deepEqual(windows, [
    { kind: 'five_hour', usedPercent: 12.3, resetsAt: new Date(1791406800 * 1000).toISOString().replace('.000Z', 'Z') },
    { kind: 'weekly_all', usedPercent: 40, resetsAt: '2026-10-09T22:00:00Z' },
    { kind: 'weekly_model', model: 'Sonnet', usedPercent: 3 }
  ])
})

test('parser: an answer it does not recognise is no reading at all, never a partial one', () => {
  assert.equal(parseClaudeUsage({ something: 'else' }), null)
  assert.equal(parseClaudeUsage({ limits: [{ kind: 'mystery', percent: 3 }] }), null)
  assert.equal(parseClaudeUsage(null), null)
  assert.equal(parseClaudeUsage([]), null)
  assert.equal(parseClaudeUsage('five_hour'), null)
})

test('parser: one recognised window with a broken number spoils the whole reading', () => {
  const answer = newAnswer()
  answer.limits[1].percent = 'lots'
  assert.equal(parseClaudeUsage(answer), null)
  const negative = newAnswer()
  negative.limits[0].percent = -4
  assert.equal(parseClaudeUsage(negative), null)
  const badTime = newAnswer()
  badTime.limits[0].resets_at = 'soon'
  assert.equal(parseClaudeUsage(badTime), null)
})

test('parser: a model name that is not a plain model name spoils the reading', () => {
  for (const hostile of [FAKE_EMAIL, fakeClaudeToken(), '../../etc', 'x'.repeat(40), '']) {
    const answer = newAnswer()
    answer.limits[2].scope.model.display_name = hostile
    assert.equal(parseClaudeUsage(answer), null, `accepted a model name it should not have`)
  }
})

test('parser: a percentage over 100 is shown as 100, not as a broken meter', () => {
  const answer = newAnswer()
  answer.limits[0].percent = 104
  assert.equal(parseClaudeUsage(answer)[0].usedPercent, 100)
})

// --- the live call --------------------------------------------------------------------------------

test('the token goes to the usage address only, with an honest user agent', async () => {
  const fake = await makeFakeHome({ '.claude/.credentials.json': credentials() })
  try {
    const deps = depsFor(fake)
    const { limits, account } = await collectClaudeLimits(deps)
    assert.equal(deps.fetch.calls.length, 1)
    const [{ url, init }] = deps.fetch.calls
    assert.equal(url, USAGE_URL)
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage')
    assert.equal(init.headers.Authorization, `Bearer ${fakeClaudeToken()}`)
    assert.equal(init.headers['anthropic-beta'], 'oauth-2025-04-20')
    assert.equal(init.headers['User-Agent'], USER_AGENT)
    assert.equal(USER_AGENT, 'agent-team-collector/1')
    assert.equal(init.redirect, 'error', 'a redirect could carry the token somewhere else')
    assert.ok(init.signal, 'the call has a timeout')
    assert.equal(limits.status, 'found')
    assert.equal(limits.source, 'unofficial-live')
    assert.equal(limits.readAt, '2026-10-07T20:00:00Z')
    assert.equal(limits.windows.length, 3)
    assert.deepEqual(account, { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' })
    const everything = JSON.stringify({ limits, account })
    assert.ok(!everything.includes(fakeClaudeToken()))
    assert.ok(!everything.includes(fakeRefreshToken()))
  } finally {
    await fake.cleanup()
  }
})

test('an expired token is never sent, and the saved reading is tried instead', async () => {
  const fake = await makeFakeHome({
    '.claude/.credentials.json': credentials({ expiresAt: NOW - HOUR }),
    '.claude.json': savedReading(NOW - HOUR)
  })
  try {
    const deps = depsFor(fake)
    const { limits } = await collectClaudeLimits(deps)
    assert.equal(deps.fetch.calls.length, 0, 'an expired token was sent')
    assert.equal(limits.status, 'found')
    assert.equal(limits.source, 'claude-code-saved')
    assert.equal(limits.readAt, '2026-10-07T19:00:00Z')
  } finally {
    await fake.cleanup()
  }
})

test('an expired token with no saved reading is unavailable, and says why', async () => {
  const fake = await makeFakeHome({ '.claude/.credentials.json': credentials({ expiresAt: NOW - HOUR }) })
  try {
    const deps = depsFor(fake)
    const { limits } = await collectClaudeLimits(deps)
    assert.equal(deps.fetch.calls.length, 0)
    assert.deepEqual(limits, { status: 'unavailable', why: 'sign-in expired' })
  } finally {
    await fake.cleanup()
  }
})

// Found on the first real dry run: the shell it ran in had NODE_TLS_REJECT_UNAUTHORIZED=0, so
// the token went out over a connection whose certificate nobody checked. Anything between this
// machine and the address could have read it. With checks off, the token is not sent at all.
test('with certificate checks switched off, the token is never sent', async () => {
  const fake = await makeFakeHome({
    '.claude/.credentials.json': credentials(),
    '.claude.json': savedReading(NOW - HOUR)
  })
  try {
    const deps = depsFor(fake, { env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } })
    const { limits } = await collectClaudeLimits(deps)
    assert.equal(deps.fetch.calls.length, 0, 'the token was sent with certificate checks off')
    assert.equal(limits.source, 'claude-code-saved')

    await fake.write('.claude.json', {})
    const alone = await collectClaudeLimits(depsFor(fake, { env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } }))
    assert.deepEqual(alone.limits, { status: 'unavailable', why: 'certificate checks are switched off' })

    const on = depsFor(fake, { env: { NODE_TLS_REJECT_UNAUTHORIZED: '1' } })
    await collectClaudeLimits(on)
    assert.equal(on.fetch.calls.length, 1)
  } finally {
    await fake.cleanup()
  }
})

test('a refused live call falls back to the saved reading, then to unavailable', async () => {
  const fake = await makeFakeHome({
    '.claude/.credentials.json': credentials(),
    '.claude.json': savedReading(NOW - 2 * HOUR)
  })
  try {
    const refused = depsFor(fake, { fetch: fetchStub(() => ({ status: 403, body: { error: FAKE_EMAIL } })) })
    assert.equal((await collectClaudeLimits(refused)).limits.source, 'claude-code-saved')

    await fake.write('.claude.json', savedReading(NOW - 7 * HOUR))
    const stale = await collectClaudeLimits(depsFor(fake, { fetch: fetchStub(() => ({ status: 403, body: {} })) }))
    assert.deepEqual(stale.limits, { status: 'unavailable', why: 'live answer refused' })

    const failed = await collectClaudeLimits(depsFor(fake, { fetch: fetchStub(() => new Error(`ECONNRESET ${fake.home}`)) }))
    assert.deepEqual(failed.limits, { status: 'unavailable', why: 'live call failed' })
  } finally {
    await fake.cleanup()
  }
})

test('a live answer in an unknown shape is unavailable, and the saved reading is tried', async () => {
  const fake = await makeFakeHome({ '.claude/.credentials.json': credentials() })
  try {
    const deps = depsFor(fake, { fetch: fetchStub(() => ({ status: 200, body: { totally: 'new' } })) })
    assert.deepEqual((await collectClaudeLimits(deps)).limits, { status: 'unavailable', why: 'live answer not understood' })
    const notJson = depsFor(fake, { fetch: fetchStub(() => ({ status: 200, body: '<html>' })) })
    assert.deepEqual((await collectClaudeLimits(notJson)).limits, { status: 'unavailable', why: 'live answer not understood' })
  } finally {
    await fake.cleanup()
  }
})

test('a saved reading older than six hours, or from the future, is not used', async () => {
  const fake = await makeFakeHome({ '.claude.json': savedReading(NOW - 6.5 * HOUR) })
  try {
    assert.deepEqual((await collectClaudeLimits(depsFor(fake))).limits, { status: 'unavailable', why: 'saved reading too old' })
    await fake.write('.claude.json', savedReading(NOW + HOUR))
    assert.deepEqual((await collectClaudeLimits(depsFor(fake))).limits, { status: 'unavailable', why: 'saved reading not trusted' })
    await fake.write('.claude.json', savedReading(NOW - HOUR, { nope: true }))
    assert.deepEqual((await collectClaudeLimits(depsFor(fake))).limits, { status: 'unavailable', why: 'saved reading not understood' })
  } finally {
    await fake.cleanup()
  }
})

test('nothing on the machine is "not found", with no call made and no number invented', async () => {
  const fake = await makeFakeHome()
  try {
    const deps = depsFor(fake)
    const { limits, account } = await collectClaudeLimits(deps)
    assert.deepEqual(limits, { status: 'not found' })
    assert.equal(account, null)
    assert.equal(deps.fetch.calls.length, 0)
  } finally {
    await fake.cleanup()
  }
})

test('a credentials file that cannot be read is unavailable, not a crash', async () => {
  const fake = await makeFakeHome({ '.claude/.credentials.json': '{ not json' })
  try {
    const { limits } = await collectClaudeLimits(depsFor(fake))
    assert.deepEqual(limits, { status: 'unavailable', why: 'credentials not understood' })
  } finally {
    await fake.cleanup()
  }
})

test('CLAUDE_CONFIG_DIR is honoured for both the credentials and the saved reading', async () => {
  const fake = await makeFakeHome({
    'elsewhere/.credentials.json': credentials({ expiresAt: NOW - HOUR }),
    'elsewhere/.claude.json': savedReading(NOW - HOUR)
  })
  try {
    const deps = depsFor(fake, { env: { CLAUDE_CONFIG_DIR: join(fake.home, 'elsewhere') } })
    const { limits, account } = await collectClaudeLimits(deps)
    assert.equal(limits.source, 'claude-code-saved')
    assert.equal(account.subscriptionType, 'max')
  } finally {
    await fake.cleanup()
  }
})

// --- the Mac Keychain ----------------------------------------------------------------------------

test('on a Mac the Keychain is asked first, with exactly these arguments, and nothing is printed', async () => {
  const fake = await makeFakeHome()
  try {
    const exec = execStub(() => JSON.stringify(credentials()) + '\n')
    const deps = depsFor(fake, { platform: 'darwin', exec })
    const { printed, result } = await captureConsole(() => collectClaudeLimits(deps))
    assert.deepEqual(KEYCHAIN_COMMAND, ['security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']])
    assert.equal(exec.calls.length, 1)
    assert.equal(exec.calls[0].file, 'security')
    assert.deepEqual(exec.calls[0].args, ['find-generic-password', '-s', 'Claude Code-credentials', '-w'])
    assert.equal(result.limits.source, 'unofficial-live')
    assert.equal(deps.fetch.calls[0].init.headers.Authorization, `Bearer ${fakeClaudeToken()}`)
    assert.deepEqual(printed, [], 'the Keychain answer or the token was printed')
  } finally {
    await fake.cleanup()
  }
})

test('on a Mac with no Keychain entry, the credentials file is the fallback', async () => {
  const fake = await makeFakeHome({ '.claude/.credentials.json': credentials() })
  try {
    const deps = depsFor(fake, { platform: 'darwin', exec: execStub(() => new Error('item not found')) })
    const { limits } = await collectClaudeLimits(deps)
    assert.equal(limits.source, 'unofficial-live')
  } finally {
    await fake.cleanup()
  }
})

test('off a Mac the Keychain is never asked', async () => {
  const fake = await makeFakeHome({ '.claude/.credentials.json': credentials() })
  try {
    const deps = depsFor(fake, { platform: 'win32' })
    await collectClaudeLimits(deps)
    assert.equal(deps.exec.calls.length, 0)
  } finally {
    await fake.cleanup()
  }
})

// --- the surplus-burn probe ------------------------------------------------------------------------

test('usage-probe prints the parsed windows only, never the raw answer', async () => {
  const fake = await makeFakeHome({ '.claude/.credentials.json': credentials() })
  try {
    const raw = { ...newAnswer(), account: { email: FAKE_EMAIL, uuid: FAKE_UUID }, echoed: fakeClaudeToken() }
    const deps = depsFor(fake, { fetch: fetchStub(() => ({ status: 200, body: raw })), identity: fake.identity })
    const { printed } = await captureConsole(() => probe(deps))
    const output = printed.join('\n')
    const parsed = JSON.parse(output)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.status, 'found')
    assert.deepEqual(parsed.windows.map((window) => window.kind), ['five_hour', 'weekly_all', 'weekly_model'])
    for (const leak of [FAKE_EMAIL, FAKE_UUID, fakeClaudeToken(), 'iguana', 'echoed', 'account']) {
      assert.ok(!output.includes(leak), `the probe printed ${leak.slice(0, 8)}...`)
    }
  } finally {
    await fake.cleanup()
  }
})

test('usage-probe with nothing to read says so plainly', async () => {
  const fake = await makeFakeHome()
  try {
    const { printed } = await captureConsole(() => probe({ ...depsFor(fake), identity: fake.identity }))
    assert.deepEqual(JSON.parse(printed.join('\n')), { ok: false, status: 'not found' })
  } finally {
    await fake.cleanup()
  }
})
