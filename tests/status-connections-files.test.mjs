import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { claudeServersFromFiles, codexFromConfig, codexTables, transportOf } from '../scripts/lib/status/connections.mjs'
import { checkConnections } from '../scripts/lib/status/safe.mjs'
import { CAPS } from '../scripts/lib/status/connections-schema.mjs'
import { makeFakeHome, fakeClaudeToken, FAKE_USERNAME, FAKE_EMAIL } from './helpers/fake-home.mjs'
import { hostileHome, FORBIDDEN, depsFor, runIn } from './helpers/hostile-home.mjs'

/* Which servers and plugins this computer has, read from Claude Code's and Codex's own files.
   Those files hold far more than names: addresses with keys in them, commands with tokens in
   their arguments, environment settings, headers, project folders. Only the name, where it came
   from and whether it runs locally or on the web are kept - and the web/local answer comes from
   which keys an entry has, never from what is in them. */

const CONNECTIONS = ['.agent-team', 'status', 'connections', 'test-pc.json']

test('LEAK TEST: the connections file and the log carry names only, from the hostile home', async () => {
  const fake = await hostileHome()
  try {
    const result = await runIn(fake, ['--computer', 'Test PC', '--only', 'connections'])
    assert.equal(result.code, 0, result.stderr)
    const text = await readFile(join(result.target, ...CONNECTIONS), 'utf8')
    const dry = await runIn(fake, ['--computer', 'Test PC', '--dry-run'])
    assert.equal(dry.code, 0, dry.stderr)
    for (const output of [text, result.stdout, result.stderr, dry.stdout, dry.stderr]) {
      for (const needle of FORBIDDEN()) assert.ok(!output.includes(needle), `an output contained a forbidden string (${needle.slice(0, 6)}...)`)
    }
    // It did work: the leak test is not passing because nothing was read.
    const doc = JSON.parse(text)
    assert.deepEqual(doc.claude.servers, [
      { name: 'crm', scope: 'user', transport: 'web', state: 'not checked' },
      { name: 'github', scope: 'user', transport: 'local', state: 'not checked' },
      { name: 'plugin:marketing:supermetrics', scope: 'plugin', transport: 'web', state: 'needs sign-in' },
      { name: 'claude.ai Gmail', scope: 'claude.ai', transport: 'web', state: 'seen before' }
    ])
    assert.equal(doc.claude.projectServers, 1)
    assert.equal(doc.claude.hidden, 4, 'the email, username and token names, and the claude.ai one with an email')
    assert.equal(doc.claude.more, 0)
    assert.deepEqual(doc.codex, {
      status: 'found',
      servers: [{ name: 'docs' }],
      plugins: [{ name: 'canva', from: 'openai-curated', enabled: false }, { name: 'github', from: 'openai-curated', enabled: true }],
      hidden: 1,
      more: 0
    })
    assert.deepEqual(checkConnections(doc, fake.identity), [])
    await rm(result.target, { recursive: true, force: true })
    await rm(dry.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('a home with neither app is "not found" for both, with no invented empty lists', async () => {
  const fake = await makeFakeHome()
  try {
    assert.deepEqual(await claudeServersFromFiles(depsFor(fake)), { status: 'not found' })
    assert.deepEqual(await codexFromConfig(depsFor(fake)), { status: 'not found' })
  } finally {
    await fake.cleanup()
  }
})

test('a broken file is "unavailable", and says nothing more', async () => {
  const fake = await makeFakeHome({ '.claude.json': '{ not json', '.codex/config.toml': 'x' })
  try {
    assert.deepEqual(await claudeServersFromFiles(depsFor(fake)), { status: 'unavailable', why: 'could not be read' })
    // Codex's file is read as lines; a file with no tables is simply a Codex with nothing set up.
    assert.deepEqual(await codexFromConfig(depsFor(fake)), { status: 'found', servers: [], plugins: [], hidden: 0, more: 0 })
  } finally {
    await fake.cleanup()
  }
})

test('CLAUDE_CONFIG_DIR and CODEX_HOME are honoured', async () => {
  const fake = await makeFakeHome({
    'elsewhere/claude/.claude.json': { mcpServers: { moved: { type: 'stdio', command: 'x' } } },
    'elsewhere/codex/config.toml': '[mcp_servers.moved-too]\ncommand = "x"\n'
  })
  try {
    const deps = depsFor(fake, { env: { CLAUDE_CONFIG_DIR: join(fake.home, 'elsewhere', 'claude'), CODEX_HOME: join(fake.home, 'elsewhere', 'codex') } })
    assert.deepEqual((await claudeServersFromFiles(deps)).servers.map((server) => server.name), ['moved'])
    assert.deepEqual((await codexFromConfig(deps)).servers, [{ name: 'moved-too' }])
  } finally {
    await fake.cleanup()
  }
})

test('local or web comes from which keys an entry has, never from their values', () => {
  assert.equal(transportOf({ type: 'stdio', command: 'https://looks-like-web' }), 'local')
  assert.equal(transportOf({ type: 'http', url: 'x' }), 'web')
  assert.equal(transportOf({ type: 'sse' }), 'web')
  assert.equal(transportOf({ type: 'ws' }), 'web')
  assert.equal(transportOf({ type: 'streamable-http' }), 'web')
  assert.equal(transportOf({ command: 'x' }), 'local')
  assert.equal(transportOf({ url: 'x' }), 'web')
  assert.equal(transportOf({ type: 'something-new' }), 'unknown')
  assert.equal(transportOf({}), 'unknown')
  assert.equal(transportOf('not an entry'), 'unknown')
})

test('plugin servers: every place a plugin keeps them, named plugin:<plugin>:<server>', async () => {
  const fake = await makeFakeHome()
  try {
    const cache = (name) => join(fake.home, '.claude', 'plugins', 'cache', name)
    await fake.write('.claude/plugins/cache/wrapped/.mcp.json', { mcpServers: { one: { type: 'http', url: 'x' } } })
    await fake.write('.claude/plugins/cache/bare/.mcp.json', { two: { command: 'x' } })
    await fake.write('.claude/plugins/cache/inline/.claude-plugin/plugin.json', { name: 'inline', mcpServers: { three: { type: 'http', url: 'x' } } })
    await fake.write('.claude/plugins/cache/pointer/.claude-plugin/plugin.json', { name: 'pointer', mcpServers: './servers.json' })
    await fake.write('.claude/plugins/cache/pointer/servers.json', { mcpServers: { four: { command: 'x' } } })
    await fake.write('.claude/plugins/cache/escape/.claude-plugin/plugin.json', { name: 'escape', mcpServers: '../wrapped/.mcp.json' })
    await fake.write('.claude/plugins/cache/absolute/.claude-plugin/plugin.json', { name: 'absolute', mcpServers: join(cache('wrapped'), '.mcp.json') })
    await fake.write('.claude/plugins/cache/for-a-project/.mcp.json', { five: { command: 'x' } })
    const plugins = ['wrapped', 'bare', 'inline', 'pointer', 'escape', 'absolute', 'for-a-project']
    await fake.write('.claude/settings.json', { enabledPlugins: Object.fromEntries(plugins.map((name) => [`${name}@market`, true])) })
    await fake.write('.claude/plugins/installed_plugins.json', {
      version: 2,
      plugins: Object.fromEntries(plugins.map((name) => [`${name}@market`, [
        name === 'for-a-project'
          ? { scope: 'project', projectPath: join(fake.home, 'work'), installPath: cache(name) }
          : { scope: 'user', installPath: cache(name) }
      ]]))
    })
    const found = await claudeServersFromFiles(depsFor(fake))
    assert.deepEqual(found.servers.map((server) => [server.name, server.transport]), [
      ['plugin:bare:two', 'local'],
      ['plugin:inline:three', 'web'],
      ['plugin:pointer:four', 'local'],
      ['plugin:wrapped:one', 'web']
    ])
    // A pointer that leaves the plugin's folder is not followed; a project's plugin is not named.
    assert.equal(found.servers.some((server) => /escape|absolute|five/.test(server.name)), false)
  } finally {
    await fake.cleanup()
  }
})

test('servers are sorted by where they come from, then by name, each name once', async () => {
  const fake = await makeFakeHome({
    '.claude.json': {
      mcpServers: { zeta: { command: 'x' }, alpha: { url: 'x' } },
      claudeAiMcpEverConnected: ['claude.ai Notion', 'claude.ai Gmail', 'claude.ai Gmail']
    }
  })
  try {
    const found = await claudeServersFromFiles(depsFor(fake))
    assert.deepEqual(found.servers.map((server) => server.name), ['alpha', 'zeta', 'claude.ai Gmail', 'claude.ai Notion'])
  } finally {
    await fake.cleanup()
  }
})

test('past the cap, the rest are counted in "more", never written', async () => {
  const many = Object.fromEntries(Array.from({ length: CAPS.claudeServers + 5 }, (_, index) => [`server ${String(index).padStart(3, '0')}`, { command: 'x' }]))
  const codex = [
    ...Array.from({ length: CAPS.codexServers + 2 }, (_, index) => `[mcp_servers.s${index}]`),
    ...Array.from({ length: CAPS.codexPlugins + 3 }, (_, index) => `[plugins."p${index}@m"]`)
  ].join('\n')
  const fake = await makeFakeHome({ '.claude.json': { mcpServers: many }, '.codex/config.toml': codex })
  try {
    const claude = await claudeServersFromFiles(depsFor(fake))
    assert.equal(claude.servers.length, CAPS.claudeServers)
    assert.equal(claude.more, 5)
    const found = await codexFromConfig(depsFor(fake))
    assert.equal(found.servers.length, CAPS.codexServers)
    assert.equal(found.plugins.length, CAPS.codexPlugins)
    assert.equal(found.more, 5)
  } finally {
    await fake.cleanup()
  }
})

test('Codex: table headers and "enabled" only; sub-tables, hooks and strings are never read as servers', () => {
  const text = [
    'model = "x"',
    '[mcp_servers.plain]',
    'command = "npx"',
    'enabled = false # switched off',
    '[mcp_servers.plain.env]',
    'enabled = true',
    '[mcp_servers."with space"]',
    "[mcp_servers.'literal-name']",
    '[ mcp_servers . spaced ]',
    '[mcp_servers]',
    '[[mcp_servers.array]]',
    '[plugins."tool@market"]',
    'enabled = true',
    '[plugins."two@at@signs"]',
    '[plugins.bare-no-market]',
    '[hooks.state."x"]',
    'enabled = false',
    "notes = '''",
    '[mcp_servers.inside-literal-string]',
    "'''",
    'other = """ [mcp_servers.one-line-string] """',
    '[mcp_servers.after]',
    '[mcp_servers."esc\\"aped"]'
  ].join('\n')
  const tables = codexTables(text)
  assert.deepEqual(tables.servers, [
    { name: 'plain', enabled: false },
    { name: 'with space' },
    { name: 'literal-name' },
    { name: 'spaced' },
    { name: 'after' }
  ])
  assert.deepEqual(tables.plugins, [{ key: 'tool@market', enabled: true }, { key: 'two@at@signs' }, { key: 'bare-no-market' }])
})

test('Codex: a plugin key without exactly one @ is hidden, and names are held to the rule', async () => {
  const fake = await makeFakeHome({
    '.codex/config.toml': [
      '[plugins."two@at@signs"]',
      '[plugins.bare-no-market]',
      `[plugins."fine@${FAKE_USERNAME}-market"]`,
      '[plugins."ok@market"]',
      `[mcp_servers."${'x'.repeat(30)}"]`,
      '[mcp_servers.good]'
    ].join('\n')
  })
  try {
    const found = await codexFromConfig(depsFor(fake))
    assert.deepEqual(found.plugins, [{ name: 'ok', from: 'market' }])
    assert.deepEqual(found.servers, [{ name: 'good' }])
    assert.equal(found.hidden, 4)
  } finally {
    await fake.cleanup()
  }
})

test('a broken or odd ~/.claude.json shape gives what it can, and never throws', async () => {
  for (const doc of [
    { mcpServers: 'not an object', claudeAiMcpEverConnected: 'nope', projects: [] },
    { mcpServers: { ok: null }, claudeAiMcpEverConnected: [42, null, 'claude.ai Fine'], projects: { a: null, b: { mcpServers: 'x' } } },
    []
  ]) {
    const fake = await makeFakeHome({ '.claude.json': doc })
    try {
      const found = await claudeServersFromFiles(depsFor(fake))
      assert.equal(found.status, 'found')
      assert.equal(found.projectServers, 0)
      for (const server of found.servers) assert.ok(['ok', 'claude.ai Fine'].includes(server.name))
    } finally {
      await fake.cleanup()
    }
  }
})

test('a fake token as a key is hidden, not written, and not shown in the log', async () => {
  const fake = await makeFakeHome({ '.claude.json': { mcpServers: { [fakeClaudeToken()]: { command: 'x' }, [FAKE_EMAIL]: { url: 'x' } } } })
  try {
    const result = await runIn(fake, ['--computer', 'Test PC', '--only', 'connections'])
    assert.equal(result.code, 0, result.stderr)
    const text = await readFile(join(result.target, ...CONNECTIONS), 'utf8')
    assert.equal(JSON.parse(text).claude.hidden, 2)
    for (const output of [text, result.stdout, result.stderr]) {
      assert.ok(!output.includes(fakeClaudeToken()) && !output.includes(FAKE_EMAIL))
    }
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})
