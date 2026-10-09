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
import { HAVE_SQLITE, makeStateDb } from './hermes-home.mjs'

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
      projects: {
        [`/Users/${FAKE_USERNAME}/secret-client`]: {
          allowedTools: [],
          // A project's own server: counted, never named - its name and path are the client's.
          mcpServers: { 'client-db': { type: 'stdio', command: `/Users/${FAKE_USERNAME}/secret-client/bin/db`, env: { DB_PASSWORD: fakeRefreshToken() } } }
        }
      },
      cachedUsageUtilization: { fetchedAtMs: now - HOUR, utilization: { five_hour: { utilization: 5 }, owner: FAKE_EMAIL } },
      // Your own servers: every kind of secret a server entry can hold, under names that are fine
      // and names that are not.
      mcpServers: {
        crm: { type: 'http', url: `https://mcp.example.com/crm?key=${fakeClaudeToken()}`, headers: { Authorization: `Bearer ${fakeClaudeToken()}` } },
        github: { type: 'stdio', command: 'npx', args: ['-y', '@example/github-server', '--token', fakeClaudeToken()], env: { GITHUB_TOKEN: fakeRefreshToken() } },
        [FAKE_EMAIL]: { type: 'http', url: 'https://mcp.example.com/mine' },
        [`${FAKE_USERNAME}-tools`]: { command: `/Users/${FAKE_USERNAME}/bin/tools` },
        [fakeClaudeToken().slice(0, 40)]: { url: 'https://mcp.example.com/t' }
      },
      claudeAiMcpEverConnected: ['claude.ai Gmail', `claude.ai ${FAKE_EMAIL}`]
    },
    '.claude/mcp-needs-auth-cache.json': { 'plugin:marketing:supermetrics': { timestamp: now - HOUR } },
    '.claude/settings.json': {
      enabledPlugins: { 'marketing@claude-plugins': true, 'switched-off@claude-plugins': false },
      env: { ANTHROPIC_API_KEY: fakeClaudeToken() }
    },
    '.claude/plugins/cache/marketing/.mcp.json': {
      mcpServers: { supermetrics: { type: 'http', url: `https://mcp.example.com/sm?token=${fakeClaudeToken()}`, headers: { 'X-Owner': FAKE_EMAIL } } }
    },
    '.claude/plugins/cache/switched-off/.mcp.json': { mcpServers: { 'never-shown': { command: 'npx' } } },
    '.codex/config.toml': [
      'model = "gpt-5"',
      `[projects.'/Users/${FAKE_USERNAME}/secret-client']`,
      'trust_level = "trusted"',
      '[mcp_servers.docs]',
      `command = "/Users/${FAKE_USERNAME}/bin/docs"`,
      `args = ["--token", "${fakeClaudeToken()}"]`,
      'env_vars = ["DOCS_SECRET"]',
      `url = "https://mcp.example.com/docs?owner=${FAKE_EMAIL}"`,
      '[mcp_servers.docs.env]',
      `TOKEN = "${fakeRefreshToken()}"`,
      `[mcp_servers."${FAKE_USERNAME}-notes"]`,
      'command = "notes"',
      '[plugins."github@openai-curated"]',
      'enabled = true',
      '[plugins."canva@openai-curated"]',
      'enabled = false',
      `[hooks.state.'C:\\Users\\${FAKE_USERNAME}\\secret-client']`,
      'enabled = true',
      'notes = """',
      `[plugins."hidden-in-a-string@${FAKE_EMAIL}"]`,
      '"""'
    ].join('\n'),
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
  // Where the plugin is installed is recorded with its full path - which holds the username.
  await fake.write('.claude/plugins/installed_plugins.json', {
    version: 2,
    plugins: {
      'marketing@claude-plugins': [{ scope: 'user', installPath: join(fake.home, '.claude', 'plugins', 'cache', 'marketing'), version: '1.0.0' }],
      'switched-off@claude-plugins': [{ scope: 'user', installPath: join(fake.home, '.claude', 'plugins', 'cache', 'switched-off'), version: '1.0.0' }]
    }
  })
  await hostileHermes(fake, now)
  return fake
}

// Hermes's home, holding everything the Hermes card must never carry: sign-ins, keys, what Hermes
// remembers and was told, the gateway's command line (with the username in it), chat ids, session
// titles and folders, logs. What may come out is the version, counts, times, states, and profile
// and model names that pass the name rule.
const lines = (...items) => `${items.join('\n')}\n`

async function hostileHermes(fake, now) {
  const at = (relative, content) => fake.write(`.hermes/${relative}`, content)
  await at('hermes-agent/pyproject.toml', lines('[project]', 'name = "hermes-agent"', 'version = "0.21.3"'))
  await at('.update_check', { ts: now / 1000 - HOUR / 1000, behind: 12389, rev: null, ver: '0.21.3', head: 'f88c6fc46e', target: 'abc' })
  await at('.env', lines(`OPENROUTER_API_KEY=${fakeClaudeToken()}`, `TELEGRAM_TOKEN=${fakeRefreshToken()}`))
  await at('auth.json', { providers: { anthropic: { access_token: fakeClaudeToken(), email: FAKE_EMAIL } } })
  await at('SOUL.md', lines('soul-secret-words: I work for secret-client.'))
  await at('USER.md', lines(`user-secret-words: ${FAKE_EMAIL}`))
  await at('memories/MEMORY.md', lines('memory-secret-words about secret-client'))
  await at('logs/agent.log', lines(`log-secret-words ${fakeClaudeToken()} /Users/${FAKE_USERNAME}/secret-client`))
  await at('config.yaml', lines(
    'model:',
    '  default: openrouter/anthropic/claude-opus-5-5',
    '  provider: openrouter',
    `  base_url: https://mcp.example.com/v1?key=${fakeClaudeToken()}`,
    'secrets:',
    `  openrouter: ${fakeClaudeToken()}`,
    'providers:',
    '  custom:',
    `    api_key: ${fakeRefreshToken()}`,
    `    default: ${FAKE_EMAIL}`
  ))
  await at('gateway_state.json', {
    pid: 4242,
    argv: [`/Users/${FAKE_USERNAME}/.hermes/hermes-agent/venv/bin/python`, '-m', 'hermes', 'gateway', '--token', fakeClaudeToken()],
    gateway_state: 'running',
    updated_at: new Date(now - 30_000).toISOString().replace('Z', '+00:00'),
    platforms: { telegram: { chat_id: 'telegram-chat-77', owner: FAKE_EMAIL } }
  })
  await at('cron/ticker_heartbeat', String((now - 20_000) / 1000))
  await at('skills/research/SKILL.md', lines(`skill-secret-words ${fakeClaudeToken()}`))
  // A profile the board may name, and one named after the person, which it may not.
  await at('profiles/donna/config.yaml', lines('model:', '  default: gpt-5.1', '  provider: openai', `  base_url: https://mcp.example.com/donna?key=${fakeRefreshToken()}`))
  await at('profiles/donna/SOUL.md', lines('soul-secret-words for donna'))
  await at(`profiles/${FAKE_USERNAME}/config.yaml`, lines('model: x'))
  // Scheduled jobs: each carries its prompt, where it delivers, and the text of its last error, none of
  // which the jobs part may write. One job has a good name, one fails, one is named after an email.
  const jobBaggage = (tag) => ({
    prompt: `prompt-secret-words ${tag} for ${FAKE_EMAIL} with ${fakeClaudeToken()} in /Users/${FAKE_USERNAME}/secret-client`,
    deliver: `telegram:telegram-chat-77-${tag}`,
    origin: { platform: 'telegram', chat_id: 'telegram-chat-77', user: FAKE_EMAIL },
    last_error: `error-secret-words Bearer ${fakeClaudeToken()} at /Users/${FAKE_USERNAME}/secret-client/run.py`,
    last_delivery_error: `delivery-secret-words ${fakeRefreshToken()}`,
    next_run_at: new Date(now + HOUR).toISOString().replace('Z', '+00:00')
  })
  await at('cron/jobs.json', {
    jobs: [
      { id: 'brief1', name: 'Morning brief', enabled: true, schedule: { kind: 'cron', expr: '30 6 * * *', timezone: 'America/New_York' }, last_run_at: new Date(now - 13 * HOUR).toISOString().replace('Z', '+00:00'), last_status: 'ok', ...jobBaggage('one') },
      { id: 'review1', name: 'Weekly review', enabled: true, schedule: { kind: 'cron', expr: '0 9 * * 1', timezone: 'America/New_York' }, last_run_at: new Date(now - 2 * HOUR).toISOString().replace('Z', '+00:00'), last_status: 'error', ...jobBaggage('two') },
      { id: 'mail1', name: FAKE_EMAIL, enabled: true, schedule: { kind: 'cron', expr: '0 7 * * *' }, last_status: 'ok', ...jobBaggage('three') }
    ]
  })
  await at('profiles/donna/cron/jobs.json', { jobs: [{ id: 'donna1', name: 'Donna brief', enabled: true, schedule: { kind: 'cron', expr: '15 8 * * *' }, last_status: 'error', ...jobBaggage('four') }] })
  if (HAVE_SQLITE) {
    await makeStateDb(join(fake.home, '.hermes', 'state.db'), [
      { id: FAKE_UUID, source: 'telegram', user_id: FAKE_EMAIL, chat_id: 'telegram-chat-77', started_at: (now - HOUR) / 1000, last_activity_at: (now - 600_000) / 1000, title: 'secret-client roadmap', cwd: `/Users/${FAKE_USERNAME}/secret-client`, billing_base_url: 'https://mcp.example.com/bill' },
      { id: 'cron-1', source: 'cron', started_at: (now - 2 * HOUR) / 1000, title: 'secret-client nightly' }
    ])
  }
}

// A Mac's LaunchAgents folder in `fake`, for a run on platform darwin: a plist holds the program and its
// arguments, environment settings with keys, folders with the username, sockets and more, and the logs
// hold whatever the job printed. Returns what mac-programs.mjs needs to answer for plutil and launchctl.
export async function hostileMac(fake, now) {
  const home = `/Users/${FAKE_USERNAME}`
  const logs = {
    out: await fake.write('Library/Logs/secret-client.out.log', `plist-secret-words ${fakeClaudeToken()} ${home}/secret-client`),
    err: await fake.write('Library/Logs/secret-client.err.log', `plist-secret-words ${FAKE_EMAIL}`)
  }
  await setMtime(logs.out, now - HOUR)
  await setMtime(logs.err, now - 2 * HOUR)
  const baggage = {
    ProgramArguments: [`${home}/bin/run`, '--token', fakeClaudeToken(), `--owner=${FAKE_EMAIL}`],
    EnvironmentVariables: { ANTHROPIC_API_KEY: fakeClaudeToken(), DB_PASSWORD: fakeRefreshToken(), OWNER: FAKE_EMAIL, NOTE: 'env-secret-words' },
    WorkingDirectory: `${home}/secret-client`,
    UserName: FAKE_USERNAME,
    Sockets: { Listeners: { SockServiceName: 'secret-client-port' } },
    WatchPaths: [`${home}/secret-client/inbox`]
  }
  const plists = {
    'local.donna.story-belt-daily.plist': { ...baggage, Label: 'local.donna.story-belt-daily', StartCalendarInterval: { Hour: 6, Minute: 15 }, StandardOutPath: logs.out, StandardErrorPath: logs.err },
    'local.donna.blog-watch.plist': { ...baggage, Label: 'local.donna.blog-watch', StartInterval: 900 },
    'local.donna.security-changelog.plist': { ...baggage, Label: 'local.donna.security-changelog', RunAtLoad: true, KeepAlive: false },
    [`local.${FAKE_USERNAME}.private.plist`]: { ...baggage, Label: `local.${FAKE_USERNAME}.private`, RunAtLoad: true },
    [`local.${FAKE_EMAIL}.plist`]: { ...baggage, Label: `local.${FAKE_EMAIL}`, RunAtLoad: true }
  }
  for (const name of Object.keys(plists)) await fake.write(`Library/LaunchAgents/${name}`, `<plist/> plist-secret-words ${home}`)
  const launchctl = ['PID\tStatus\tLabel', '-\t0\tlocal.donna.story-belt-daily', '-\t78\tlocal.donna.blog-watch', '4242\t0\tlocal.donna.security-changelog'].join('\n')
  return { plists, launchctl }
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
  'secret-client',
  // What a server entry holds besides its name: address, command, arguments, settings.
  'mcp.example.com',
  'https://',
  'npx',
  '--token',
  'GITHUB_TOKEN',
  'DOCS_SECRET',
  'client-db',
  'never-shown',
  'switched-off',
  'hidden-in-a-string',
  'trust_level',
  'oat01',
  // What Hermes keeps beside the counts, times and names the card shows.
  'soul-secret-words',
  'user-secret-words',
  'memory-secret-words',
  'log-secret-words',
  'skill-secret-words',
  'OPENROUTER_API_KEY',
  'TELEGRAM_TOKEN',
  'telegram-chat-77',
  'hermes-agent',
  'venv',
  'f88c6fc46e',
  'roadmap',
  'nightly',
  // What a scheduled job and a LaunchAgent keep beside the name, schedule and result the wall shows.
  'prompt-secret-words',
  'error-secret-words',
  'delivery-secret-words',
  'plist-secret-words',
  'env-secret-words',
  'DB_PASSWORD',
  'ANTHROPIC_API_KEY',
  'ProgramArguments',
  'EnvironmentVariables',
  'run.py',
  '--owner'
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
