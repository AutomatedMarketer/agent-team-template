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
import { checkUsage } from '../scripts/lib/status/safe.mjs'
import { MAX_WINDOWS, MAX_PERCENT } from '../scripts/lib/status/schema.mjs'
import { machineDeps } from '../scripts/lib/status/machine.mjs'
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

// Over the limit is a real reading - extra usage, or a plan that lets you run past it. Clipping it
// to 100 would hide by how much. Only a number past the contract's ceiling is not believable.
test('parser: a percentage over 100 is kept as it is, never clipped', () => {
  const answer = newAnswer()
  answer.limits[0].percent = 112
  assert.equal(parseClaudeUsage(answer)[0].usedPercent, 112)
  const ceiling = newAnswer()
  ceiling.limits[0].percent = MAX_PERCENT
  assert.equal(parseClaudeUsage(ceiling)[0].usedPercent, MAX_PERCENT)
  const beyond = newAnswer()
  beyond.limits[0].percent = MAX_PERCENT + 1
  assert.equal(parseClaudeUsage(beyond), null)
})

test('a live reading of 112% is written, not refused', async () => {
  const fake = await makeFakeHome({ '.claude/.credentials.json': credentials() })
  try {
    const answer = { limits: [{ kind: 'session', percent: 112, resets_at: '2026-10-07T21:40:00Z' }] }
    const { limits } = await collectClaudeLimits(depsFor(fake, { fetch: fetchStub(() => ({ status: 200, body: answer })) }))
    assert.deepEqual(limits.windows, [{ kind: 'five_hour', usedPercent: 112, resetsAt: '2026-10-07T21:40:00Z' }])
    const doc = {
      schema: 'agent-status/usage/v1',
      takenAt: '2026-10-07T20:00:00Z',
      computer: 'Test PC',
      claude: { plan: { status: 'not found' }, limits, activity: { status: 'not found' } },
      codex: { plan: { status: 'not found' }, limits: { status: 'not found' } }
    }
    assert.deepEqual(checkUsage(doc, { username: 'fakeperson', home: fake.home, hostname: 'fake-host-77' }), [])
  } finally {
    await fake.cleanup()
  }
})

// The address sometimes answers a window with no number at all (utilization: null) - a window
// that exists but has nothing to report yet. That window is left out; it is never a zero, and it
// does not cost the other windows their reading.
test('parser: a window with no number is left out, and the rest of the reading is kept', () => {
  const listed = newAnswer()
  listed.limits[0].percent = null
  assert.deepEqual(parseClaudeUsage(listed).map((window) => window.kind), ['weekly_all', 'weekly_model'])
  const flat = parseClaudeUsage({ five_hour: { utilization: null, resets_at: null }, seven_day: { utilization: 49, resets_at: null } })
  assert.deepEqual(flat, [{ kind: 'weekly_all', usedPercent: 49 }])
  assert.ok(!JSON.stringify(flat).includes('"usedPercent":0'))
})

// "Not understood" would send someone looking for a changed format. An answer in the known shape
// whose windows all say null is understood perfectly - it just has no numbers yet - and the reason
// says so. The parser tells the two apart: null for not understood, an empty list for no numbers.
const noNumbers = () => ({
  limits: [
    { kind: 'session', percent: null },
    { kind: 'weekly_all', utilization: null }
  ],
  five_hour: { utilization: null }
})

test('parser: when no window has a number, it says "no numbers", not "not understood"', () => {
  assert.deepEqual(parseClaudeUsage(noNumbers()), [])
  assert.equal(parseClaudeUsage({ something: 'else' }), null)
})

test('a live answer with no numbers in it is unavailable, and says exactly that', async () => {
  const fake = await makeFakeHome({ '.claude/.credentials.json': credentials() })
  try {
    const deps = depsFor(fake, { fetch: fetchStub(() => ({ status: 200, body: noNumbers() })) })
    const { limits } = await collectClaudeLimits(deps)
    assert.deepEqual(limits, { status: 'unavailable', why: 'the live answer had no numbers in it' })
    await fake.write('.claude.json', savedReading(NOW - HOUR, noNumbers()))
    const both = await collectClaudeLimits(depsFor(fake, { fetch: fetchStub(() => ({ status: 500, body: {} })) }))
    assert.deepEqual(both.limits, { status: 'unavailable', why: 'live answer refused' })
    await fake.write('.claude/.credentials.json', {})
    const savedOnly = await collectClaudeLimits(depsFor(fake))
    assert.deepEqual(savedOnly.limits, { status: 'unavailable', why: 'the saved reading had no numbers in it' })
  } finally {
    await fake.cleanup()
  }
})

test('parser: never more windows than the contract allows', () => {
  const answer = {
    limits: Array.from({ length: MAX_WINDOWS + 3 }, (_, index) => ({
      kind: 'weekly_scoped',
      percent: index,
      scope: { model: { display_name: `Model ${index}` } }
    }))
  }
  const windows = parseClaudeUsage(answer)
  assert.equal(windows.length, MAX_WINDOWS)
  assert.equal(windows[0].model, 'Model 0')
})

test('a live answer with a null window and a null reset time passes the gate as a usage file', async () => {
  const fake = await makeFakeHome({ '.claude/.credentials.json': credentials() })
  try {
    const answer = {
      limits: [
        { kind: 'session', utilization: null, resets_at: null },
        { kind: 'weekly_all', percent: 49, resets_at: null },
        { kind: 'weekly_scoped', percent: 2, scope: { model: { display_name: 'Fable' } } }
      ]
    }
    const deps = depsFor(fake, { fetch: fetchStub(() => ({ status: 200, body: answer })) })
    const { limits } = await collectClaudeLimits(deps)
    assert.equal(limits.source, 'unofficial-live')
    assert.deepEqual(limits.windows, [
      { kind: 'weekly_all', usedPercent: 49 },
      { kind: 'weekly_model', model: 'Fable', usedPercent: 2 }
    ])
    const doc = {
      schema: 'agent-status/usage/v1',
      takenAt: '2026-10-07T20:00:00Z',
      computer: 'Test PC',
      claude: { plan: { status: 'not found' }, limits, activity: { status: 'not found' } },
      codex: { plan: { status: 'not found' }, limits: { status: 'not found' } }
    }
    assert.deepEqual(checkUsage(doc, { username: 'fakeperson', home: fake.home, hostname: 'fake-host-77' }), [])
  } finally {
    await fake.cleanup()
  }
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

// Certificate checks switched off is not the only way to make Node trust a connection it should
// not. Extra trusted certificates, the system's or OpenSSL's certificate store instead of Node's,
// or code loaded into Node before the collector starts can all put something between the token
// and the address. Any of them, and the token stays home. The reason names the setting, never
// its value - the value is a file path.
for (const [label, env, why] of [
  ['extra trusted certificates', { NODE_EXTRA_CA_CERTS: '/Users/fakeperson/corp-proxy.pem' }, 'NODE_EXTRA_CA_CERTS adds certificates'],
  ['the system certificate store', { NODE_OPTIONS: '--use-system-ca' }, 'NODE_OPTIONS changes certificates or loads code'],
  ['the OpenSSL certificate store', { NODE_OPTIONS: '--max-old-space-size=4096 --use-openssl-ca' }, 'NODE_OPTIONS changes certificates or loads code'],
  ['--require', { NODE_OPTIONS: '--require /Users/fakeperson/hook.js' }, 'NODE_OPTIONS changes certificates or loads code'],
  ['--require=', { NODE_OPTIONS: '--require=./hook.js' }, 'NODE_OPTIONS changes certificates or loads code'],
  ['a quoted --require', { NODE_OPTIONS: '"--require" ./hook.js' }, 'NODE_OPTIONS changes certificates or loads code'],
  ['-r', { NODE_OPTIONS: '-r ./hook.js' }, 'NODE_OPTIONS changes certificates or loads code'],
  ['--import', { NODE_OPTIONS: '--import ./hook.mjs' }, 'NODE_OPTIONS changes certificates or loads code'],
  ['--import=', { NODE_OPTIONS: '--import=./hook.mjs' }, 'NODE_OPTIONS changes certificates or loads code'],
  ['--loader', { NODE_OPTIONS: '--loader ./hook.mjs' }, 'NODE_OPTIONS changes certificates or loads code'],
  ['--experimental-loader', { NODE_OPTIONS: '--experimental-loader=./hook.mjs' }, 'NODE_OPTIONS changes certificates or loads code']
]) {
  test(`with ${label}, the token is never sent and the reason names the setting, not its value`, async () => {
    const fake = await makeFakeHome({
      '.claude/.credentials.json': credentials(),
      '.claude.json': savedReading(NOW - HOUR)
    })
    try {
      const deps = depsFor(fake, { env })
      const { limits } = await collectClaudeLimits(deps)
      assert.equal(deps.fetch.calls.length, 0, 'the token was sent')
      assert.equal(limits.source, 'claude-code-saved')

      await fake.write('.claude.json', {})
      const alone = await collectClaudeLimits(depsFor(fake, { env }))
      assert.deepEqual(alone.limits, { status: 'unavailable', why })
    } finally {
      await fake.cleanup()
    }
  })
}

// A debugger attached to this Node can read any variable, the token included. And the same
// options that NODE_OPTIONS can carry can be given on Node's own command line, where they show
// up in process.execArgv instead - which the tests hand in as deps.execArgv.
const ON_COMMAND_LINE = 'node was started with certificate, code or debug options'
for (const [label, extra, why] of [
  ['--inspect in NODE_OPTIONS', { env: { NODE_OPTIONS: '--inspect' } }, 'NODE_OPTIONS opens a debugger'],
  ['--inspect-brk in NODE_OPTIONS', { env: { NODE_OPTIONS: '--inspect-brk=9229' } }, 'NODE_OPTIONS opens a debugger'],
  ['--inspect-port in NODE_OPTIONS', { env: { NODE_OPTIONS: '--inspect-port=0' } }, 'NODE_OPTIONS opens a debugger'],
  ['--inspect-wait in NODE_OPTIONS', { env: { NODE_OPTIONS: '--inspect-wait' } }, 'NODE_OPTIONS opens a debugger'],
  ['NODE_USE_SYSTEM_CA=1', { env: { NODE_USE_SYSTEM_CA: '1' } }, 'NODE_USE_SYSTEM_CA changes certificates'],
  ['--inspect on the command line', { execArgv: ['--inspect'] }, ON_COMMAND_LINE],
  ['--inspect-brk on the command line', { execArgv: ['--inspect-brk=127.0.0.1:9229'] }, ON_COMMAND_LINE],
  ['--require on the command line', { execArgv: ['--require', './hook.js'] }, ON_COMMAND_LINE],
  ['-r on the command line', { execArgv: ['-r', './hook.js'] }, ON_COMMAND_LINE],
  ['--import on the command line', { execArgv: ['--import=./hook.mjs'] }, ON_COMMAND_LINE],
  ['--loader on the command line', { execArgv: ['--loader', './hook.mjs'] }, ON_COMMAND_LINE],
  ['--experimental-loader on the command line', { execArgv: ['--experimental-loader=./hook.mjs'] }, ON_COMMAND_LINE],
  ['--use-system-ca on the command line', { execArgv: ['--use-system-ca'] }, ON_COMMAND_LINE],
  ['--use-openssl-ca on the command line', { execArgv: ['--use-openssl-ca'] }, ON_COMMAND_LINE]
]) {
  test(`with ${label}, the token is never sent`, async () => {
    const fake = await makeFakeHome({ '.claude/.credentials.json': credentials() })
    try {
      const deps = depsFor(fake, extra)
      const { limits } = await collectClaudeLimits(deps)
      assert.equal(deps.fetch.calls.length, 0, 'the token was sent')
      assert.deepEqual(limits, { status: 'unavailable', why })
    } finally {
      await fake.cleanup()
    }
  })
}

test('ordinary NODE_OPTIONS and command-line options do not stop the live call', async () => {
  const fake = await makeFakeHome({ '.claude/.credentials.json': credentials() })
  try {
    const deps = depsFor(fake, {
      env: { NODE_OPTIONS: '--max-old-space-size=4096 --enable-source-maps', NODE_EXTRA_CA_CERTS: '', NODE_USE_SYSTEM_CA: '0' },
      execArgv: ['--max-old-space-size=4096', '--no-warnings']
    })
    const { limits } = await collectClaudeLimits(deps)
    assert.equal(deps.fetch.calls.length, 1)
    assert.equal(limits.source, 'unofficial-live')
  } finally {
    await fake.cleanup()
  }
})

test('on the real machine the guard is handed Node\'s own command-line options', () => {
  assert.equal(machineDeps().execArgv, process.execArgv)
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
    // The full path: a bare name is looked up on PATH, and anything earlier on PATH named
    // 'security' would be handed the sign-in instead.
    assert.deepEqual(KEYCHAIN_COMMAND, ['/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']])
    assert.equal(exec.calls.length, 1)
    assert.equal(exec.calls[0].file, '/usr/bin/security')
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
