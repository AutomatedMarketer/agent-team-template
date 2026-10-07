import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { collectCodexLimits, codexWindows, TAIL_BYTES } from '../scripts/lib/status/codex-limits.mjs'
import { claudePlan, codexPlanName, collectCodexPlan } from '../scripts/lib/status/plans.mjs'
import { makeFakeHome, setMtime, fakeIdToken, FAKE_EMAIL, FAKE_UUID } from './helpers/fake-home.mjs'

const NOW = Date.parse('2026-10-07T20:00:00Z')
const DAY = 86400_000

const reading = (at, rateLimits) => JSON.stringify({
  timestamp: new Date(at).toISOString(),
  type: 'event_msg',
  payload: { type: 'token_count', info: { total: 1 }, rate_limits: rateLimits }
})

const weekly = (percent, resetsAtSeconds = Math.floor((NOW + 3 * DAY) / 1000)) => ({
  limit_id: 'codex',
  primary: { used_percent: percent, window_minutes: 10080, resets_at: resetsAtSeconds },
  secondary: null,
  plan_type: null
})

const other = (at) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'response_item', payload: { cwd: '/Users/fakeperson/secret-client' } })

const dayFolder = (at) => {
  const date = new Date(at)
  const pad = (n) => String(n).padStart(2, '0')
  return `.codex/sessions/${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`
}

const deps = (fake, extra = {}) => ({ home: fake.home, env: {}, now: NOW, ...extra })

async function writeLog(fake, at, name, lines) {
  const path = await fake.write(`${dayFolder(at)}/${name}`, lines.join('\n') + '\n')
  await setMtime(path, at)
  return path
}

// --- the window mapping -----------------------------------------------------------------------------

test('codex windows: 300 minutes is the 5-hour window and 10080 is the weekly one', () => {
  const windows = codexWindows({
    primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1791406800 },
    secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1791800000 }
  }, NOW)
  assert.deepEqual(windows, [
    { kind: 'five_hour', usedPercent: 12.5, resetsAt: new Date(1791406800 * 1000).toISOString().replace('.000Z', 'Z') },
    { kind: 'weekly', usedPercent: 40, resetsAt: new Date(1791800000 * 1000).toISOString().replace('.000Z', 'Z') }
  ])
})

test('codex windows: an older build that says "resets in" is counted from the reading time', () => {
  const windows = codexWindows({ primary: { used_percent: 3, window_minutes: 10080, resets_in_seconds: 3600 } }, NOW)
  assert.deepEqual(windows, [{ kind: 'weekly', usedPercent: 3, resetsAt: '2026-10-07T21:00:00Z' }])
})

test('codex windows: an off-by-one-minute window still maps, an unknown length is skipped', () => {
  assert.deepEqual(codexWindows({ primary: { used_percent: 1, window_minutes: 10079 } }, NOW), [{ kind: 'weekly', usedPercent: 1 }])
  assert.equal(codexWindows({ primary: { used_percent: 1, window_minutes: 60 } }, NOW), null)
})

test('codex windows: a broken percentage spoils the reading', () => {
  assert.equal(codexWindows({ primary: { used_percent: 'x', window_minutes: 10080 } }, NOW), null)
  assert.equal(codexWindows(null, NOW), null)
})

// --- choosing the file --------------------------------------------------------------------------------

test('the newest reading in the newest log wins, read from the tail of the file', async () => {
  const fake = await makeFakeHome()
  try {
    await writeLog(fake, NOW - 2 * DAY, 'rollout-older.jsonl', [reading(NOW - 2 * DAY, weekly(80))])
    await writeLog(fake, NOW - 3600_000, 'rollout-newer.jsonl', [
      reading(NOW - 7200_000, weekly(10)),
      reading(NOW - 3600_000, weekly(11)),
      other(NOW - 3000_000)
    ])
    const limits = await collectCodexLimits(deps(fake))
    assert.equal(limits.status, 'found')
    assert.equal(limits.source, 'codex-session-log')
    assert.equal(limits.readAt, '2026-10-07T19:00:00Z')
    assert.deepEqual(limits.windows.map((window) => [window.kind, window.usedPercent]), [['weekly', 11]])
  } finally {
    await fake.cleanup()
  }
})

test('a log whose readings are all empty falls back to an older log', async () => {
  const fake = await makeFakeHome()
  try {
    await writeLog(fake, NOW - DAY, 'rollout-a.jsonl', [reading(NOW - DAY, weekly(33))])
    await writeLog(fake, NOW - 60_000, 'rollout-b.jsonl', [
      reading(NOW - 60_000, { primary: null, secondary: null }),
      reading(NOW - 50_000, null),
      other(NOW - 40_000)
    ])
    const limits = await collectCodexLimits(deps(fake))
    assert.equal(limits.status, 'found')
    assert.equal(limits.windows[0].usedPercent, 33)
  } finally {
    await fake.cleanup()
  }
})

test('only the last 256 KB of a big log is read', async () => {
  const fake = await makeFakeHome()
  try {
    // The early reading sits beyond the tail, so it must not be found; only the late one may be.
    const padding = Array.from({ length: Math.ceil((TAIL_BYTES * 1.5) / 120) }, () => other(NOW - 5000))
    await writeLog(fake, NOW - 1000, 'rollout-big.jsonl', [reading(NOW - 9000, weekly(90)), ...padding])
    assert.deepEqual(await collectCodexLimits(deps(fake)), { status: 'not found' })
    await writeLog(fake, NOW - 1000, 'rollout-big.jsonl', [reading(NOW - 9000, weekly(90)), ...padding, reading(NOW - 1000, weekly(7))])
    assert.equal((await collectCodexLimits(deps(fake))).windows[0].usedPercent, 7)
  } finally {
    await fake.cleanup()
  }
})

test('a reading older than seven days is not used', async () => {
  const fake = await makeFakeHome()
  try {
    await writeLog(fake, NOW - 9 * DAY, 'rollout-old.jsonl', [reading(NOW - 9 * DAY, weekly(50))])
    assert.deepEqual(await collectCodexLimits(deps(fake)), { status: 'not found' })
  } finally {
    await fake.cleanup()
  }
})

test('the newest reading in a shape nobody knows is unavailable, not a fall back to an old one', async () => {
  const fake = await makeFakeHome()
  try {
    await writeLog(fake, NOW - DAY, 'rollout-a.jsonl', [reading(NOW - DAY, weekly(33))])
    await writeLog(fake, NOW - 60_000, 'rollout-b.jsonl', [reading(NOW - 60_000, { primary: { used_percent: 5, window_minutes: 42 } })])
    assert.deepEqual(await collectCodexLimits(deps(fake)), { status: 'unavailable', why: 'reading not understood' })
  } finally {
    await fake.cleanup()
  }
})

test('no Codex folder is "not found", and bad lines are skipped rather than fatal', async () => {
  const fake = await makeFakeHome()
  try {
    assert.deepEqual(await collectCodexLimits(deps(fake)), { status: 'not found' })
    await writeLog(fake, NOW - 60_000, 'rollout-x.jsonl', ['{not json', reading(NOW - 60_000, weekly(4)), '{"half":'])
    assert.equal((await collectCodexLimits(deps(fake))).windows[0].usedPercent, 4)
  } finally {
    await fake.cleanup()
  }
})

test('CODEX_HOME is honoured', async () => {
  const fake = await makeFakeHome()
  try {
    const at = NOW - 60_000
    const path = await fake.write(`${dayFolder(at).replace('.codex', 'other-codex')}/rollout-z.jsonl`, reading(at, weekly(21)) + '\n')
    await setMtime(path, at)
    const limits = await collectCodexLimits(deps(fake, { env: { CODEX_HOME: join(fake.home, 'other-codex') } }))
    assert.equal(limits.windows[0].usedPercent, 21)
  } finally {
    await fake.cleanup()
  }
})

// --- plan names ------------------------------------------------------------------------------------------

test('claude plan names come from the two plain sign-in fields', () => {
  assert.deepEqual(claudePlan({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }), { status: 'found', name: 'Max 20x' })
  assert.deepEqual(claudePlan({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' }), { status: 'found', name: 'Max 5x' })
  assert.deepEqual(claudePlan({ subscriptionType: 'max', rateLimitTier: null }), { status: 'found', name: 'Max' })
  assert.deepEqual(claudePlan({ subscriptionType: 'pro', rateLimitTier: 'default_claude_ai' }), { status: 'found', name: 'Pro' })
  assert.deepEqual(claudePlan({ subscriptionType: 'team', rateLimitTier: null }), { status: 'found', name: 'Team' })
  assert.deepEqual(claudePlan({ subscriptionType: 'enterprise', rateLimitTier: null }), { status: 'found', name: 'Enterprise' })
})

test('an unknown claude plan is "not recognised", never echoed back', () => {
  const plan = claudePlan({ subscriptionType: FAKE_EMAIL, rateLimitTier: 'x' })
  assert.deepEqual(plan, { status: 'unavailable', why: 'plan not recognised' })
  assert.deepEqual(claudePlan(null), { status: 'not found' })
  assert.deepEqual(claudePlan({ subscriptionType: null, rateLimitTier: null }), { status: 'not found' })
})

test('codex plan words map to names, and unknown ones are not recognised', () => {
  assert.deepEqual(codexPlanName('pro'), { status: 'found', name: 'Pro' })
  assert.deepEqual(codexPlanName('plus'), { status: 'found', name: 'Plus' })
  assert.deepEqual(codexPlanName('business'), { status: 'found', name: 'Business' })
  assert.deepEqual(codexPlanName('quantum'), { status: 'unavailable', why: 'plan not recognised' })
})

test('the codex plan is read from the id token in memory, and only the plan word survives', async () => {
  const idToken = fakeIdToken({
    email: FAKE_EMAIL,
    name: 'Fake Person',
    'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_user_id: FAKE_UUID }
  })
  const fake = await makeFakeHome({ '.codex/auth.json': { tokens: { id_token: idToken, access_token: 'a', refresh_token: 'r' } } })
  try {
    const plan = await collectCodexPlan(deps(fake))
    assert.deepEqual(plan, { status: 'found', name: 'Pro' })
  } finally {
    await fake.cleanup()
  }
})

test('codex plan: no file is not found, an api-key setup is not found, junk is unavailable', async () => {
  const fake = await makeFakeHome()
  try {
    assert.deepEqual(await collectCodexPlan(deps(fake)), { status: 'not found' })
    await fake.write('.codex/auth.json', { OPENAI_API_KEY: 'k' })
    assert.deepEqual(await collectCodexPlan(deps(fake)), { status: 'not found' })
    await fake.write('.codex/auth.json', { tokens: { id_token: 'not-a-jwt' } })
    assert.deepEqual(await collectCodexPlan(deps(fake)), { status: 'unavailable', why: 'sign-in not understood' })
    await fake.write('.codex/auth.json', '{oops')
    assert.deepEqual(await collectCodexPlan(deps(fake)), { status: 'unavailable', why: 'sign-in not understood' })
  } finally {
    await fake.cleanup()
  }
})
