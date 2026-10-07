import test from 'node:test'
import assert from 'node:assert/strict'
import { collectClaudeActivity, ESTIMATE_DAYS } from '../scripts/lib/status/claude-activity.mjs'
import { checkUsage } from '../scripts/lib/status/safe.mjs'
import { makeFakeHome, setMtime, FAKE_UUID } from './helpers/fake-home.mjs'

const NOW = Date.parse('2026-10-07T20:00:00Z')
const DAY = 86400_000
const PROJECT = '-Users-fakeperson-secret-client'
const SESSION = FAKE_UUID

const assistant = ({ at, id, request, model = 'claude-opus-5-5', session = SESSION, usage = {} }) => JSON.stringify({
  type: 'assistant',
  timestamp: new Date(at).toISOString(),
  sessionId: session,
  requestId: request,
  cwd: '/Users/fakeperson/secret-client',
  message: {
    id,
    model,
    content: [{ type: 'text', text: 'secret-client roadmap' }],
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 40,
      ...usage
    }
  }
})

const userLine = (at) => JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(), cwd: '/Users/fakeperson/secret-client', message: { content: 'hi' } })

async function fixture() {
  const fake = await makeFakeHome()
  const main = await fake.write(`.claude/projects/${PROJECT}/${SESSION}.jsonl`, [
    // The same reply logged twice while it streamed - one reply, not two.
    assistant({ at: NOW - 3600_000, id: 'msg_1', request: 'req_1' }),
    assistant({ at: NOW - 3600_000, id: 'msg_1', request: 'req_1' }),
    assistant({ at: NOW - 1800_000, id: 'msg_2', request: 'req_2', model: 'claude-sonnet-4-6' }),
    // 02:00 UTC on the 7th is the evening of the 6th in New York.
    assistant({ at: Date.parse('2026-10-07T02:00:00Z'), id: 'msg_3', request: 'req_3', session: 'other-session' }),
    userLine(NOW - 1000),
    '{this line is broken',
    '',
    assistant({ at: NOW - 20 * DAY, id: 'msg_old', request: 'req_old' }),
    assistant({ at: NOW - 600_000, id: 'msg_s', request: 'req_s', model: '<synthetic>' }),
    assistant({ at: NOW - 500_000, id: 'msg_bad', request: 'req_bad', usage: { output_tokens: 'many' } })
  ].join('\n'))
  await setMtime(main, NOW - 1000)
  const sub = await fake.write(`.claude/projects/${PROJECT}/${SESSION}/subagents/agent-a1.jsonl`, [
    assistant({ at: NOW - 900_000, id: 'msg_4', request: 'req_4', model: 'claude-haiku-4-5' })
  ].join('\n'))
  await setMtime(sub, NOW - 900_000)
  // A file nobody has touched for three weeks is not opened at all.
  const stale = await fake.write(`.claude/projects/${PROJECT}/old.jsonl`, assistant({ at: NOW - 3600_000, id: 'msg_x', request: 'req_x' }))
  await setMtime(stale, NOW - 21 * DAY)
  return fake
}

const deps = (fake, extra = {}) => ({ home: fake.home, env: {}, now: NOW, timezone: 'America/New_York', ...extra })

test('the estimate dedupes streamed replies, includes subagents and buckets by local day', async () => {
  const fake = await fixture()
  try {
    const activity = await collectClaudeActivity(deps(fake))
    assert.equal(activity.status, 'found')
    assert.equal(activity.estimate, true)
    assert.equal(activity.timezone, 'America/New_York')
    assert.deepEqual(activity.days.map((day) => day.day), ['2026-10-06', '2026-10-07'])

    const [yesterday, today] = activity.days
    assert.equal(yesterday.replies, 1)
    assert.equal(yesterday.sessions, 1)

    // msg_1 once, msg_2, msg_4 from the subagent, msg_bad with its broken count read as 0.
    assert.equal(today.replies, 4)
    assert.equal(today.sessions, 1, 'a subagent belongs to the session that started it')
    assert.deepEqual(today.byModel, { opus: 2, sonnet: 1, haiku: 1, other: 0 })
    assert.deepEqual(today.tokens, { input: 40, output: 60, cacheRead: 1200, cacheWrite: 160 })
  } finally {
    await fake.cleanup()
  }
})

test('the estimate holds only counts - no project, folder, session id or text', async () => {
  const fake = await fixture()
  try {
    const text = JSON.stringify(await collectClaudeActivity(deps(fake)))
    for (const leak of ['secret-client', 'fakeperson', FAKE_UUID, 'roadmap', 'msg_', 'req_', 'Users']) {
      assert.ok(!text.includes(leak), `the estimate carried ${leak}`)
    }
  } finally {
    await fake.cleanup()
  }
})

test('the estimate passes the gate as part of a usage file', async () => {
  const fake = await fixture()
  try {
    const activity = await collectClaudeActivity(deps(fake))
    const doc = {
      schema: 'agent-status/usage/v1',
      takenAt: '2026-10-07T20:00:00Z',
      computer: 'Test PC',
      claude: { plan: { status: 'not found' }, limits: { status: 'not found' }, activity },
      codex: { plan: { status: 'not found' }, limits: { status: 'not found' } }
    }
    assert.deepEqual(checkUsage(doc, fake.identity), [])
  } finally {
    await fake.cleanup()
  }
})

test('nothing older than the fifteen-day cut is counted', async () => {
  assert.equal(ESTIMATE_DAYS, 15)
  const fake = await makeFakeHome()
  try {
    const path = await fake.write(`.claude/projects/${PROJECT}/a.jsonl`, [
      assistant({ at: NOW - 16 * DAY, id: 'm1', request: 'r1' }),
      assistant({ at: NOW - 14 * DAY, id: 'm2', request: 'r2' })
    ].join('\n'))
    await setMtime(path, NOW - 1000)
    const activity = await collectClaudeActivity(deps(fake, { timezone: 'UTC' }))
    assert.deepEqual(activity.days.map((day) => day.day), ['2026-09-23'])
  } finally {
    await fake.cleanup()
  }
})

test('no projects folder is "not found"; a quiet fortnight is found with no days', async () => {
  const fake = await makeFakeHome()
  try {
    assert.deepEqual(await collectClaudeActivity(deps(fake)), { status: 'not found' })
    await fake.write(`.claude/projects/${PROJECT}/empty.jsonl`, '')
    assert.deepEqual(await collectClaudeActivity(deps(fake)), { status: 'found', estimate: true, timezone: 'America/New_York', days: [] })
  } finally {
    await fake.cleanup()
  }
})

test('an unknown timezone falls back to UTC rather than writing it', async () => {
  const fake = await fixture()
  try {
    const activity = await collectClaudeActivity(deps(fake, { timezone: 'Users/fakeperson' }))
    assert.equal(activity.timezone, 'UTC')
  } finally {
    await fake.cleanup()
  }
})
