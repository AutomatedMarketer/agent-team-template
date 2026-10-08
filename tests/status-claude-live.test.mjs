import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { parseMcpList, liveCheck, LIVE_LIST_TIMEOUT_MS } from '../scripts/lib/status/claude-live.mjs'
import { collectConnections } from '../scripts/lib/status/connections.mjs'
import { PROGRAM_OUTPUT_CAP } from '../scripts/lib/status/programs.mjs'
import { checkConnections } from '../scripts/lib/status/safe.mjs'
import { makeFakeHome, execStub, fakeClaudeToken, FAKE_EMAIL, FAKE_UUID } from './helpers/fake-home.mjs'
import { hostileHome, FORBIDDEN, depsFor, runIn } from './helpers/hostile-home.mjs'
import { repoRoot } from './helpers/repo.mjs'

/* `claude mcp list` is the only way to know whether a server actually connects. It is also the
   loudest thing the collector does: it starts every local server and prints each server's
   command or address - with whatever tokens are in them. So it runs by absolute path from an
   empty folder, for at most two minutes, and only two things are kept from each line: the name
   (up to the first ": ") and the state (after the last " - "). The real command is never run by
   these tests; its answer is a fixture. */

const ESC = '\u001b'
const sampleOutput = (token = fakeClaudeToken()) => [
  'Checking MCP server health...',
  '',
  `github: npx -y @example/github-server --token ${token} - ${ESC}[32m✓${ESC}[39m Connected`,
  `crm: https://mcp.example.com/crm?key=${token} (HTTP) - ✗ Failed to connect`,
  `plugin:marketing:supermetrics: https://mcp.example.com/sm (HTTP) - ! Needs authentication`,
  `plugin:marketing:ahrefs: https://user:pass@mcp.example.com/a: b - ⚠ Needs authentication`,
  `claude.ai Gmail: https://gmail.mcp.claude.com/mcp - ✓ Connected`,
  `claude.ai Drive: https://drive.example.com - - Pending approval`,
  `team-tools: node server.js - ${ESC}]8;;https://x.example${ESC}\\link${ESC}]8;;${ESC}\\ - Something new`,
  `${FAKE_EMAIL}: https://mcp.example.com - ✓ Connected`,
  `client-db: /Users/fakeperson/bin/db - ✓ Connected`
].join('\n')

test('the parser keeps the name and the state of each line, and nothing else', () => {
  const rows = parseMcpList(sampleOutput())
  assert.deepEqual(rows, [
    { name: 'github', state: 'connected' },
    { name: 'crm', state: 'failed' },
    { name: 'plugin:marketing:supermetrics', state: 'needs sign-in' },
    { name: 'plugin:marketing:ahrefs', state: 'needs sign-in' },
    { name: 'claude.ai Gmail', state: 'connected' },
    { name: 'claude.ai Drive', state: 'waiting for approval' },
    { name: 'team-tools', state: 'unknown' },
    { name: FAKE_EMAIL, state: 'connected' },
    { name: 'client-db', state: 'connected' }
  ])
  const kept = JSON.stringify(rows)
  for (const needle of [fakeClaudeToken(), 'https', 'npx', '--token', 'mcp.example.com', 'pass', ESC]) {
    assert.ok(!kept.includes(needle), `the parser kept ${needle.slice(0, 6)}...`)
  }
})

test('the parser maps each state word, and anything it does not know is "unknown"', () => {
  const state = (word) => parseMcpList(`x: cmd - ${word}`)?.[0]?.state
  assert.equal(state('✓ Connected'), 'connected')
  assert.equal(state('connected'), 'connected')
  assert.equal(state('✗ Failed to connect'), 'failed')
  assert.equal(state('✗ Disconnected'), 'failed')
  assert.equal(state('Error'), 'failed')
  assert.equal(state('Not connected'), 'failed')
  assert.equal(state('! Needs authentication'), 'needs sign-in')
  assert.equal(state('⚠ Needs login'), 'needs sign-in')
  assert.equal(state('Pending approval'), 'waiting for approval')
  assert.equal(state('Awaiting approval'), 'waiting for approval')
  assert.equal(state('🙂 vibing'), 'unknown')
})

test('the parser: no servers is an answer; output it cannot read at all is not', () => {
  assert.deepEqual(parseMcpList('No MCP servers configured. Use `claude mcp add` to add a server.\n'), [])
  assert.equal(parseMcpList(''), null)
  assert.equal(parseMcpList('Error: something went wrong\n'), null)
  assert.equal(parseMcpList('<html>not this</html>'), null)
  // A line with no " - " is not a server line, and is skipped among good ones.
  assert.deepEqual(parseMcpList('Checking MCP server health...\nnote: just a note\ngithub: npx - ✓ Connected'), [{ name: 'github', state: 'connected' }])
})

// --- running it ------------------------------------------------------------------------------------

async function homeWithClaude(files = {}) {
  const fake = await makeFakeHome(files)
  const program = await fake.write('.local/bin/claude', '#!/bin/sh\n')
  const { chmod } = await import('node:fs/promises')
  await chmod(program, 0o755)
  return { fake, program }
}

test('it runs the claude it found, by absolute path, from an emptied folder, for at most two minutes', async () => {
  const { fake, program } = await homeWithClaude()
  try {
    const stateDir = join(fake.root, 'state')
    const exec = execStub(() => ({ stdout: sampleOutput(), code: 1 }))
    const stub = async (file, args, options) => {
      // The folder exists and is empty at the moment the program starts.
      assert.deepEqual(await readdir(options.cwd), [])
      return exec(file, args, options).then(({ stdout }) => stdout)
    }
    const answer = await liveCheck({ ...depsFor(fake), stateDir, exec: stub })
    assert.equal(exec.calls.length, 1)
    const [call] = exec.calls
    assert.equal(call.file, program)
    assert.deepEqual(call.args, ['mcp', 'list'])
    assert.equal(call.options.cwd, join(stateDir, 'empty-cwd'))
    assert.equal(call.options.timeout, LIVE_LIST_TIMEOUT_MS)
    assert.equal(LIVE_LIST_TIMEOUT_MS, 120_000)
    assert.equal(call.options.maxOutput, PROGRAM_OUTPUT_CAP)
    // It exits 0 even when servers fail, and not 0 in some versions: the exit code is not the answer.
    assert.equal(call.options.acceptAnyExit, true)
    assert.equal(answer.live, 'checked')
    assert.equal(answer.rows.length, 9)
  } finally {
    await fake.cleanup()
  }
})

test('when it cannot run, takes too long, floods, or answers nonsense, the file list stands', async () => {
  const cases = [
    [Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), 'timed out'],
    [Object.assign(new Error('x'), { code: 'ECAP' }), 'could not read'],
    [Object.assign(new Error('x'), { code: 'ESPAWN' }), 'could not run'],
    ['Error: not logged in', 'could not read']
  ]
  for (const [answer, live] of cases) {
    const { fake } = await homeWithClaude({ '.claude.json': { mcpServers: { github: { command: 'x' } }, claudeAiMcpEverConnected: ['claude.ai Gmail'] } })
    try {
      const deps = { ...depsFor(fake), stateDir: join(fake.root, 'state'), exec: execStub(() => answer) }
      const doc = await collectConnections(deps, 'Test PC')
      assert.equal(doc.claude.live, live)
      assert.deepEqual(doc.claude.servers, [
        { name: 'github', scope: 'user', transport: 'local', state: 'not checked' },
        { name: 'claude.ai Gmail', scope: 'claude.ai', transport: 'web', state: 'seen before' }
      ])
    } finally {
      await fake.cleanup()
    }
  }
})

test('with no claude program it says so, and runs nothing', async () => {
  const fake = await makeFakeHome({ '.claude.json': { mcpServers: { github: { command: 'x' } } } })
  try {
    const exec = execStub(() => sampleOutput())
    const doc = await collectConnections({ ...depsFor(fake), stateDir: join(fake.root, 'state'), exec }, 'Test PC')
    assert.equal(doc.claude.live, 'program not found')
    assert.equal(exec.calls.length, 0)
  } finally {
    await fake.cleanup()
  }
})

test('a claude inside the --clone folder is never run', async () => {
  const fake = await makeFakeHome({ '.claude.json': { mcpServers: {} } })
  try {
    const clone = join(fake.root, 'clone')
    const { chmod } = await import('node:fs/promises')
    const inside = await fake.write('../../clone/node_modules/.bin/claude', '#!/bin/sh\n')
    await chmod(inside, 0o755)
    const exec = execStub(() => sampleOutput())
    const deps = { ...depsFor(fake), env: { PATH: join(clone, 'node_modules', '.bin') }, stateDir: join(fake.root, 'state'), clone, exec }
    const doc = await collectConnections(deps, 'Test PC')
    assert.equal(doc.claude.live, 'could not run')
    assert.equal(exec.calls.length, 0)
  } finally {
    await fake.cleanup()
  }
})

test('without the Claude files, no server is started (only the version check runs)', async () => {
  const { fake } = await homeWithClaude()
  try {
    const exec = execStub(() => sampleOutput())
    const doc = await collectConnections({ ...depsFor(fake), stateDir: join(fake.root, 'state'), exec }, 'Test PC')
    assert.deepEqual(doc.claude, { status: 'not found' })
    assert.deepEqual(exec.calls.map((call) => call.args), [['--version']])
  } finally {
    await fake.cleanup()
  }
})

test('merge: live states win, live-only servers are added by their prefix, bad names hidden once', async () => {
  const { fake } = await homeWithClaude({
    '.claude.json': {
      mcpServers: { github: { command: 'x' }, crm: { url: 'x' }, quiet: { command: 'x' }, [FAKE_EMAIL]: { url: 'x' } },
      claudeAiMcpEverConnected: ['claude.ai Gmail', 'claude.ai Notion']
    },
    '.claude/mcp-needs-auth-cache.json': { quiet: { timestamp: 1 } }
  })
  try {
    const deps = { ...depsFor(fake), stateDir: join(fake.root, 'state'), exec: execStub(() => sampleOutput()) }
    const doc = await collectConnections(deps, 'Test PC')
    assert.equal(doc.claude.live, 'checked')
    assert.deepEqual(doc.claude.servers, [
      { name: 'crm', scope: 'user', transport: 'web', state: 'failed' },
      { name: 'github', scope: 'user', transport: 'local', state: 'connected' },
      // Not in the live list: it keeps what the files said.
      { name: 'quiet', scope: 'user', transport: 'local', state: 'needs sign-in' },
      { name: 'plugin:marketing:ahrefs', scope: 'plugin', transport: 'unknown', state: 'needs sign-in' },
      { name: 'plugin:marketing:supermetrics', scope: 'plugin', transport: 'unknown', state: 'needs sign-in' },
      { name: 'claude.ai Drive', scope: 'claude.ai', transport: 'web', state: 'waiting for approval' },
      { name: 'claude.ai Gmail', scope: 'claude.ai', transport: 'web', state: 'connected' },
      { name: 'claude.ai Notion', scope: 'claude.ai', transport: 'web', state: 'seen before' }
    ])
    // The email-named server is in both the file and the live list: hidden once, not twice. And a
    // name only the live list has, with no plugin or claude.ai prefix, could be a project's own
    // server - those are counted, never named (decision D2) - so client-db and team-tools are
    // hidden too.
    assert.equal(doc.claude.hidden, 3)
    assert.deepEqual(checkConnections(doc, fake.identity), [])
  } finally {
    await fake.cleanup()
  }
})

test('LEAK TEST: a live answer full of commands, addresses and tokens leaves only names and states', async () => {
  const fake = await hostileHome()
  try {
    const { chmod } = await import('node:fs/promises')
    await chmod(await fake.write('.local/bin/claude', '#!/bin/sh\n'), 0o755)
    const exec = execStub((file, args) => (args[0] === 'mcp' ? sampleOutput() : new Error('no')))
    const result = await runIn(fake, ['--computer', 'Test PC', '--only', 'connections'], { exec })
    assert.equal(result.code, 0, result.stderr)
    const text = await readFile(join(result.target, '.agent-team', 'status', 'connections', 'test-pc.json'), 'utf8')
    for (const output of [text, result.stdout, result.stderr]) {
      for (const needle of [...FORBIDDEN(), 'gmail.mcp.claude.com', 'server.js', 'pass']) {
        assert.ok(!output.includes(needle), `an output contained a forbidden string (${needle.slice(0, 6)}...)`)
      }
    }
    const doc = JSON.parse(text)
    assert.equal(doc.claude.live, 'checked')
    assert.match(result.stdout, /Checked live/)
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

// --- the real command line ------------------------------------------------------------------------------
//
// Spawned through the harness, whose exec refuses every program. A spawned run uses this machine's
// real identity, so the fake username inside a server name is not something its gate can know to
// refuse - the in-process leak tests above check that. This checks the door: the claude it found
// was handed to the harness and never run.

const run = promisify(execFile)

test('SPAWN SAFETY: a spawned collector finds the fake claude and the harness refuses to run it', async () => {
  const fake = await hostileHome({ now: Date.now() })
  const emptyPath = await mkdtemp(join(tmpdir(), 'agent-status-path-'))
  try {
    const { chmod } = await import('node:fs/promises')
    // The spawned run is on this computer's real platform, where Windows looks for claude.exe.
    const name = process.platform === 'win32' ? 'claude.exe' : 'claude'
    await chmod(await fake.write(`.local/bin/${name}`, '#!/bin/sh\n'), 0o755)
    const env = { HOME: fake.home, USERPROFILE: fake.home, PATH: emptyPath }
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
    const result = await run(process.execPath, [join('tests', 'helpers', 'collector-cli.mjs'), '--dry-run', '--only', 'connections', '--computer', 'Script Test'], { cwd: repoRoot, env, encoding: 'utf8' }).catch((error) => error)
    assert.equal(result.code ?? 0, 0, result.stderr)
    assert.match(result.stderr, /TEST HARNESS: refused to run .*claude/)
    assert.match(result.stdout, /Live check could not run/)
    for (const needle of [fakeClaudeToken(), FAKE_EMAIL, FAKE_UUID, 'mcp.example.com', '--token', 'GITHUB_TOKEN', 'Bearer', 'eyJ', 'client-db', 'never-shown']) {
      assert.ok(!result.stdout.includes(needle), `the spawned run printed a forbidden string (${needle.slice(0, 6)}...)`)
    }
    // It ran from the empty folder in the fake home's state folder.
    assert.ok((await stat(join(fake.home, '.local', 'state', 'agent-status-collector', 'empty-cwd'))).isDirectory())
  } finally {
    await rm(emptyPath, { recursive: true, force: true })
    await fake.cleanup()
  }
})
