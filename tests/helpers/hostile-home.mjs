// The hostile home used by the leak tests: every kind of thing that must never leave the machine,
// plus a fake server that echoes the token and email back. Shared so the usage file, the console
// and the receipts are all checked against the same home.

import { readdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCollector } from '../../scripts/lib/status/run.mjs'
import {
  makeFakeHome,
  fakeClaudeToken,
  fakeRefreshToken,
  fakeIdToken,
  fetchStub,
  execStub,
  setMtime,
  FAKE_EMAIL,
  FAKE_UUID,
  FAKE_USERNAME,
  FAKE_HOSTNAME
} from './fake-home.mjs'

export const NOW = Date.parse('2026-10-07T20:00:00Z')
const HOUR = 3600_000

export const PROJECT = `-Users-${FAKE_USERNAME}-secret-client`

// The answer the live address gives, plus everything a hostile or careless server could echo back.
export function echoingAnswer(token) {
  return {
    limits: [
      { kind: 'session', percent: 18, resets_at: '2026-10-07T21:40:00Z' },
      { kind: 'weekly_all', percent: 49, resets_at: '2026-10-09T22:00:00Z' },
      { kind: 'weekly_scoped', percent: 2, resets_at: '2026-10-09T22:00:00Z', scope: { model: { display_name: 'Fable' } } }
    ],
    echoedAuthorization: `Bearer ${token}`,
    account: { email: FAKE_EMAIL, uuid: FAKE_UUID, home: `/Users/${FAKE_USERNAME}` },
    error: { message: `token ${token} for ${FAKE_EMAIL}` }
  }
}

// A home that holds every kind of thing that must never leave it.
// `now` is fixed for in-process runs, which are handed the same clock. A spawned real CLI reads the
// real clock, so it must be given Date.now() - or the fake login "expires" once the date moves on.
export async function hostileHome({ now = NOW } = {}) {
  const fake = await makeFakeHome({
    '.claude/.credentials.json': {
      claudeAiOauth: {
        accessToken: fakeClaudeToken(),
        refreshToken: fakeRefreshToken(),
        expiresAt: now + 5 * HOUR,
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x'
      },
      mcpOAuth: { 'secret-client-crm': { accessToken: fakeClaudeToken(), clientId: FAKE_UUID } }
    },
    '.claude.json': {
      oauthAccount: { emailAddress: FAKE_EMAIL, accountUuid: FAKE_UUID, displayName: 'Fake Person' },
      projects: { [`/Users/${FAKE_USERNAME}/secret-client`]: { allowedTools: [] } },
      cachedUsageUtilization: { fetchedAtMs: now - HOUR, utilization: { five_hour: { utilization: 5 }, owner: FAKE_EMAIL } }
    },
    '.codex/auth.json': {
      OPENAI_API_KEY: null,
      tokens: {
        id_token: fakeIdToken({ email: FAKE_EMAIL, 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', user_id: FAKE_UUID } }),
        access_token: fakeIdToken({ sub: FAKE_UUID }),
        refresh_token: fakeRefreshToken()
      }
    }
  })
  const log = await fake.write(`.claude/projects/${PROJECT}/${FAKE_UUID}.jsonl`, [
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(now - HOUR).toISOString(),
      sessionId: FAKE_UUID,
      requestId: 'req_1',
      cwd: `/Users/${FAKE_USERNAME}/secret-client`,
      message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'text', text: FAKE_EMAIL }], usage: { input_tokens: 1, output_tokens: 2 } }
    }),
    JSON.stringify({ type: 'user', cwd: `C:\\Users\\${FAKE_USERNAME}\\secret-client`, message: { content: fakeClaudeToken() } })
  ].join('\n'))
  await setMtime(log, now - HOUR)
  const date = new Date(now - HOUR)
  const pad = (n) => String(n).padStart(2, '0')
  const codexLog = await fake.write(
    `.codex/sessions/${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}/rollout-2026-10-07T19-00-00-${FAKE_UUID}.jsonl`,
    [
      JSON.stringify({ timestamp: new Date(now - HOUR).toISOString(), type: 'turn_context', payload: { cwd: `/Users/${FAKE_USERNAME}/secret-client` } }),
      JSON.stringify({
        timestamp: new Date(now - HOUR).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: { limit_id: FAKE_EMAIL, primary: { used_percent: 3, window_minutes: 10080, resets_at: Math.floor((now + 48 * HOUR) / 1000) }, secondary: null }
        }
      })
    ].join('\n')
  )
  await setMtime(codexLog, now - HOUR)
  return fake
}

export const FORBIDDEN = () => [
  fakeClaudeToken(),
  fakeRefreshToken(),
  FAKE_EMAIL,
  FAKE_UUID,
  FAKE_USERNAME,
  FAKE_HOSTNAME,
  '/Users/',
  'C:\\',
  'eyJ',
  'Bearer',
  'secret-client'
]

export function depsFor(fake, extra = {}) {
  return {
    home: fake.home,
    env: {},
    platform: 'linux',
    now: NOW,
    timezone: 'America/New_York',
    fetch: fetchStub(() => ({ status: 200, body: echoingAnswer(fakeClaudeToken()) })),
    exec: execStub(() => new Error('no keychain')),
    identity: fake.identity,
    ...extra
  }
}

export async function runIn(fake, args, extra = {}, target = null) {
  target = target ?? await mkdtemp(join(tmpdir(), 'agent-status-repo-'))
  const stdout = []
  const stderr = []
  const code = await runCollector({
    argv: args,
    deps: depsFor(fake, extra),
    repoRoot: target,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line)
  })
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), target }
}

export async function filesUnder(dir) {
  const found = []
  async function walk(current) {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const next = join(current, entry.name)
      if (entry.isDirectory()) await walk(next)
      else found.push(next)
    }
  }
  await walk(dir)
  return found
}
