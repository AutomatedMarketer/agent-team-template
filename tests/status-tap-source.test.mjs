import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { collectClaudeLimits } from '../scripts/lib/status/claude-limits.mjs'
import { readTapReading, TAP_SCHEMA, TAP_MAX_AGE_HOURS, TAP_FRESH_MINUTES } from '../scripts/lib/status/tap.mjs'
import { collectUsage } from '../scripts/lib/status/run.mjs'
import { checkUsage } from '../scripts/lib/status/safe.mjs'
import { CLAUDE_LIMIT_SOURCES } from '../scripts/lib/status/schema.mjs'
import { makeFakeHome, fakeClaudeToken, fakeRefreshToken, fetchStub, execStub, FAKE_EMAIL, FAKE_UUID, FAKE_USERNAME } from './helpers/fake-home.mjs'
import { hostileHome, FORBIDDEN, runIn, filesUnder } from './helpers/hostile-home.mjs'

/* Where the Claude meter's numbers come from, in order:
     1. the status line tap - the official reading Claude Code hands its status line, saved on this
        computer by scripts/usage-tap.mjs, if it is under 6 hours old and not every window in it
        has reset since;
     2. the live call to the undocumented address (the sign-in token, Keychain or file);
     3. the reading Claude Code saved in ~/.claude.json;
     4. unavailable, with the most useful reason.
   The tap is written to the contract as `claude-code-statusline`, its own name, so the dashboard can
   label it official - unlike `claude-code-saved` (the ~/.claude.json reading) and `unofficial-live`. */

test('the contract names the tap reading claude-code-statusline, before the saved copy', () => {
  assert.deepEqual(CLAUDE_LIMIT_SOURCES, ['unofficial-live', 'claude-code-statusline', 'claude-code-saved'])
})

const NOW = Date.parse('2026-10-08T12:00:00Z')
const HOUR = 3600_000
const TAP_PATH = '.local/state/agent-status/claude-statusline.json'

const tapDoc = (capturedAtMs, windows) => ({
  schema: TAP_SCHEMA,
  capturedAt: new Date(capturedAtMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  windows: windows ?? [
    { kind: 'five_hour', usedPercent: 18, resetsAt: '2026-10-08T14:30:00Z' },
    { kind: 'weekly_all', usedPercent: 49, resetsAt: '2026-10-11T22:00:00Z' }
  ]
})

const credentials = (overrides = {}) => ({
  claudeAiOauth: {
    accessToken: fakeClaudeToken(),
    refreshToken: fakeRefreshToken(),
    expiresAt: NOW + 5 * HOUR,
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_20x',
    ...overrides
  }
})

const liveAnswer = () => ({ limits: [{ kind: 'session', percent: 30, resets_at: '2026-10-08T14:30:00Z' }] })

const depsFor = (fake, extra = {}) => ({
  home: fake.home,
  env: {},
  platform: 'linux',
  now: NOW,
  fetch: fetchStub(() => ({ status: 200, body: liveAnswer() })),
  exec: execStub(() => new Error('no keychain here')),
  ...extra
})

// --- reading the tap file ---------------------------------------------------------------------------

test('a fresh tap reading is found, as claude-code-statusline, read at the time it was captured', async () => {
  const fake = await makeFakeHome({ [TAP_PATH]: tapDoc(NOW - HOUR) })
  try {
    assert.deepEqual(await readTapReading(depsFor(fake)), {
      status: 'found',
      source: 'claude-code-statusline',
      readAt: '2026-10-08T11:00:00Z',
      windows: [
        { kind: 'five_hour', usedPercent: 18, resetsAt: '2026-10-08T14:30:00Z' },
        { kind: 'weekly_all', usedPercent: 49, resetsAt: '2026-10-11T22:00:00Z' }
      ]
    })
  } finally {
    await fake.cleanup()
  }
})

test('no tap file is "not found" - most people have not installed it, and that is fine', async () => {
  const fake = await makeFakeHome()
  try {
    assert.deepEqual(await readTapReading(depsFor(fake)), { status: 'not found' })
  } finally {
    await fake.cleanup()
  }
})

test(`a tap reading over ${TAP_MAX_AGE_HOURS} hours old is too old`, async () => {
  const fake = await makeFakeHome({ [TAP_PATH]: tapDoc(NOW - TAP_MAX_AGE_HOURS * HOUR - 1000) })
  try {
    assert.deepEqual(await readTapReading(depsFor(fake)), { status: 'unavailable', why: 'status line reading too old' })
  } finally {
    await fake.cleanup()
  }
})

test('a tap reading from the future is not trusted', async () => {
  const fake = await makeFakeHome({ [TAP_PATH]: tapDoc(NOW + HOUR) })
  try {
    assert.deepEqual(await readTapReading(depsFor(fake)), { status: 'unavailable', why: 'status line reading not trusted' })
  } finally {
    await fake.cleanup()
  }
})

test('a tap reading whose windows have all reset since is not used', async () => {
  const fake = await makeFakeHome({
    [TAP_PATH]: tapDoc(NOW - 2 * HOUR, [
      { kind: 'five_hour', usedPercent: 90, resetsAt: '2026-10-08T11:00:00Z' },
      { kind: 'weekly_all', usedPercent: 99, resetsAt: '2026-10-08T11:30:00Z' }
    ])
  })
  try {
    assert.deepEqual(await readTapReading(depsFor(fake)), { status: 'unavailable', why: 'status line reading is from before the reset' })
  } finally {
    await fake.cleanup()
  }
})

// The dashboard already shows a window whose reset time has passed as "reset since this reading",
// with no percentage. So one reset window does not throw the other, still-true one away.
test('a tap reading with one window reset since is still used, and keeps both windows', async () => {
  const windows = [
    { kind: 'five_hour', usedPercent: 90, resetsAt: '2026-10-08T11:00:00Z' },
    { kind: 'weekly_all', usedPercent: 49, resetsAt: '2026-10-11T22:00:00Z' }
  ]
  const fake = await makeFakeHome({ [TAP_PATH]: tapDoc(NOW - 2 * HOUR, windows) })
  try {
    const reading = await readTapReading(depsFor(fake))
    assert.equal(reading.status, 'found')
    assert.deepEqual(reading.windows, windows)
  } finally {
    await fake.cleanup()
  }
})

test('a tap file that is not exactly the format is not understood, and nothing in it travels', async () => {
  const hostile = [
    '{ broken',
    JSON.stringify([]),
    JSON.stringify({ ...tapDoc(NOW - HOUR), owner: FAKE_EMAIL }),
    JSON.stringify({ ...tapDoc(NOW - HOUR), schema: 'something/else' }),
    JSON.stringify(tapDoc(NOW - HOUR, [{ kind: FAKE_EMAIL, usedPercent: 3 }])),
    JSON.stringify(tapDoc(NOW - HOUR, [{ kind: 'weekly_model', model: FAKE_USERNAME, usedPercent: 3 }])),
    JSON.stringify(tapDoc(NOW - HOUR, [{ kind: 'five_hour', usedPercent: 3, cwd: `/Users/${FAKE_USERNAME}` }])),
    JSON.stringify(tapDoc(NOW - HOUR, [{ kind: 'five_hour', usedPercent: '3' }])),
    JSON.stringify(tapDoc(NOW - HOUR, [{ kind: 'five_hour', usedPercent: 3, resetsAt: fakeClaudeToken() }])),
    JSON.stringify(tapDoc(NOW - HOUR, [])),
    JSON.stringify({ ...tapDoc(NOW - HOUR), capturedAt: 'yesterday' })
  ]
  for (const text of hostile) {
    const fake = await makeFakeHome({ [TAP_PATH]: text })
    try {
      const reading = await readTapReading(depsFor(fake))
      assert.deepEqual(reading, { status: 'unavailable', why: 'status line reading not understood' })
    } finally {
      await fake.cleanup()
    }
  }
})

test('on Windows the tap file is read from LOCALAPPDATA', async () => {
  const fake = await makeFakeHome({ 'AppData/Local/agent-status/claude-statusline.json': tapDoc(NOW - HOUR) })
  try {
    const reading = await readTapReading(depsFor(fake, { platform: 'win32' }))
    assert.equal(reading.status, 'found')
  } finally {
    await fake.cleanup()
  }
})

// --- the order ----------------------------------------------------------------------------------------

// The decided order: the tap wins outright only while it is under 30 minutes old - the status line
// only updates while Claude Code is in use, so an older tap reading may be behind what the live
// call would say. Then the live call. Then the tap again, up to 6 hours. Then ~/.claude.json.
test(`a tap reading under ${TAP_FRESH_MINUTES} minutes old wins, and the token is never sent`, async () => {
  const fake = await makeFakeHome({
    [TAP_PATH]: tapDoc(NOW - (TAP_FRESH_MINUTES - 1) * 60_000),
    '.claude/.credentials.json': credentials(),
    '.claude.json': { cachedUsageUtilization: { fetchedAtMs: NOW - 60_000, utilization: { five_hour: { utilization: 77 } } } }
  })
  try {
    const deps = depsFor(fake)
    const { limits, account } = await collectClaudeLimits(deps)
    assert.equal(deps.fetch.calls.length, 0, 'the official reading was there, so the token should have stayed home')
    assert.equal(limits.source, 'claude-code-statusline')
    assert.equal(limits.windows[0].usedPercent, 18)
    // The plan still comes from the sign-in.
    assert.deepEqual(account, { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' })
  } finally {
    await fake.cleanup()
  }
})

test(`a tap reading over ${TAP_FRESH_MINUTES} minutes old lets the live call go first`, async () => {
  const fake = await makeFakeHome({ [TAP_PATH]: tapDoc(NOW - (TAP_FRESH_MINUTES + 1) * 60_000), '.claude/.credentials.json': credentials() })
  try {
    const deps = depsFor(fake)
    const { limits, tried } = await collectClaudeLimits(deps)
    assert.equal(deps.fetch.calls.length, 1)
    assert.equal(limits.source, 'unofficial-live')
    assert.deepEqual(tried[0], { source: 'status line', status: 'found', why: 'over 30 minutes old, so the live call went first' })
  } finally {
    await fake.cleanup()
  }
})

test('when the live call fails, a tap reading up to 6 hours old is used before ~/.claude.json', async () => {
  const fake = await makeFakeHome({
    [TAP_PATH]: tapDoc(NOW - 2 * HOUR),
    '.claude/.credentials.json': credentials(),
    '.claude.json': { cachedUsageUtilization: { fetchedAtMs: NOW - 60_000, utilization: { five_hour: { utilization: 77 } } } }
  })
  try {
    const { limits, tried } = await collectClaudeLimits(depsFor(fake, { fetch: fetchStub(() => ({ status: 401, body: {} })) }))
    assert.equal(limits.source, 'claude-code-statusline')
    assert.equal(limits.readAt, '2026-10-08T10:00:00Z')
    assert.deepEqual(tried.map((entry) => entry.source), ['status line', 'live'])
  } finally {
    await fake.cleanup()
  }
})

test('with no sign-in to try, a tap reading up to 6 hours old is used', async () => {
  const fake = await makeFakeHome({ [TAP_PATH]: tapDoc(NOW - 2 * HOUR) })
  try {
    const deps = depsFor(fake)
    const { limits } = await collectClaudeLimits(deps)
    assert.equal(limits.source, 'claude-code-statusline')
    assert.equal(deps.fetch.calls.length, 0)
  } finally {
    await fake.cleanup()
  }
})

test('a stale tap reading falls through to the live call', async () => {
  const fake = await makeFakeHome({ [TAP_PATH]: tapDoc(NOW - 7 * HOUR), '.claude/.credentials.json': credentials() })
  try {
    const deps = depsFor(fake)
    const { limits } = await collectClaudeLimits(deps)
    assert.equal(deps.fetch.calls.length, 1)
    assert.equal(limits.source, 'unofficial-live')
  } finally {
    await fake.cleanup()
  }
})

test('tap, then live, then the saved reading in ~/.claude.json', async () => {
  const fake = await makeFakeHome({
    [TAP_PATH]: tapDoc(NOW - 7 * HOUR),
    '.claude/.credentials.json': credentials(),
    '.claude.json': { cachedUsageUtilization: { fetchedAtMs: NOW - HOUR, utilization: { five_hour: { utilization: 77 } } } }
  })
  try {
    const { limits } = await collectClaudeLimits(depsFor(fake, { fetch: fetchStub(() => ({ status: 401, body: {} })) }))
    assert.equal(limits.source, 'claude-code-saved')
    assert.equal(limits.windows[0].usedPercent, 77)
    assert.equal(limits.readAt, '2026-10-08T11:00:00Z')
  } finally {
    await fake.cleanup()
  }
})

test('when nothing works and there was no sign-in to try, the tap reason is the one shown', async () => {
  const fake = await makeFakeHome({
    [TAP_PATH]: tapDoc(NOW - 7 * HOUR),
    '.claude.json': { cachedUsageUtilization: { fetchedAtMs: NOW - 7 * HOUR, utilization: { five_hour: { utilization: 77 } } } }
  })
  try {
    const { limits } = await collectClaudeLimits(depsFor(fake))
    assert.deepEqual(limits, { status: 'unavailable', why: 'status line reading too old' })
  } finally {
    await fake.cleanup()
  }
})

test('when nothing works after a live try, the live reason is still the one shown', async () => {
  const fake = await makeFakeHome({ [TAP_PATH]: tapDoc(NOW - 7 * HOUR), '.claude/.credentials.json': credentials() })
  try {
    const { limits } = await collectClaudeLimits(depsFor(fake, { fetch: fetchStub(() => ({ status: 401, body: {} })) }))
    assert.deepEqual(limits, { status: 'unavailable', why: 'live answer refused' })
  } finally {
    await fake.cleanup()
  }
})

test('every source tried is listed, by status and reason only', async () => {
  const fake = await makeFakeHome({ [TAP_PATH]: tapDoc(NOW - 7 * HOUR), '.claude/.credentials.json': credentials() })
  try {
    const { tried } = await collectClaudeLimits(depsFor(fake, { fetch: fetchStub(() => ({ status: 401, body: {} })) }))
    assert.deepEqual(tried, [
      { source: 'status line', status: 'unavailable', why: 'status line reading too old' },
      { source: 'live', status: 'unavailable', why: 'live answer refused' },
      { source: 'saved', status: 'not found' }
    ])
  } finally {
    await fake.cleanup()
  }
})

// --- end to end ----------------------------------------------------------------------------------------

test('the snapshot names the tap as claude-code-statusline, and its log line says it came from the status line', async () => {
  const fake = await makeFakeHome({ [TAP_PATH]: tapDoc(Date.parse('2026-10-07T19:45:00Z'), [
    { kind: 'five_hour', usedPercent: 18, resetsAt: '2026-10-07T21:40:00Z' },
    { kind: 'weekly_all', usedPercent: 49, resetsAt: '2026-10-09T22:00:00Z' }
  ]) })
  try {
    const result = await runIn(fake, ['--computer', 'Test PC', '--dry-run'])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /- Claude limits found \(claude-code-statusline\)/)
    assert.match(result.stdout, /status line: found/)
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('LEAK TEST: a hostile tap file next to the hostile home leaks nothing into the file or the log', async () => {
  const fake = await hostileHome()
  try {
    await fake.write(TAP_PATH, {
      ...tapDoc(Date.parse('2026-10-07T19:45:00Z')),
      owner: FAKE_EMAIL,
      session_id: FAKE_UUID,
      cwd: `/Users/${FAKE_USERNAME}/secret-client`,
      token: fakeClaudeToken()
    })
    const written = await runIn(fake, ['--computer', 'Test PC'])
    assert.equal(written.code, 0, written.stderr)
    const [file] = await filesUnder(written.target)
    const outputs = [written.stdout, written.stderr, await readFile(file, 'utf8')]
    for (const output of outputs) {
      for (const needle of FORBIDDEN()) assert.ok(!output.includes(needle), `an output contained a forbidden string (${needle.slice(0, 6)}...)`)
    }
    // The hostile file was refused, and the live reading used instead.
    const doc = JSON.parse(outputs[2])
    assert.equal(doc.claude.limits.source, 'unofficial-live')
    assert.match(written.stdout, /status line: unavailable \(status line reading not understood\)/)
    await rm(written.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('a snapshot built from the tap passes the gate', async () => {
  const fake = await makeFakeHome({ [TAP_PATH]: tapDoc(NOW - HOUR) })
  try {
    const doc = await collectUsage({ ...depsFor(fake), timezone: 'UTC', identity: fake.identity }, 'Test PC')
    assert.equal(doc.claude.limits.source, 'claude-code-statusline')
    assert.deepEqual(checkUsage(doc, fake.identity), [])
  } finally {
    await fake.cleanup()
  }
})
