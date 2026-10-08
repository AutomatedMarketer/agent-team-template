import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, readFile, rm } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { collectTools, versionFrom, hermesHome, TOOL_CHECKS } from '../scripts/lib/status/tools.mjs'
import { collectConnections } from '../scripts/lib/status/connections.mjs'
import { TOOL_NAMES } from '../scripts/lib/status/connections-schema.mjs'
import { checkConnections } from '../scripts/lib/status/safe.mjs'
import { makeFakeHome, execStub, fakeClaudeToken, FAKE_EMAIL, FAKE_USERNAME } from './helpers/fake-home.mjs'
import { depsFor, runIn } from './helpers/hostile-home.mjs'

/* The Installed tools row: Claude Code, Codex, Hermes, Node.js, Git, GitHub CLI, the Claude and
   ChatGPT apps, and Tailscale (decision D3). A version is a number and nothing else - the banner
   around it can hold a path or an account. Programs are found by the collector's own lookup and
   run through deps.exec; Hermes is never run at all, because `hermes --version` is not read-only
   (it tried to finish an update when a planner ran it), so its version comes from its files. */

const exe = (platform) => (platform === 'win32' ? '.exe' : '')

async function addPrograms(fake, names, platform = 'linux') {
  const paths = {}
  for (const name of names) {
    paths[name] = await fake.write(`.local/bin/${name}${exe(platform)}`, '#!/bin/sh\n')
    await chmod(paths[name], 0o755)
  }
  return paths
}

const BANNERS = {
  claude: '2.1.293 (Claude Code)\n',
  codex: `codex-cli 0.154.0 (signed in as ${FAKE_EMAIL}, /Users/${FAKE_USERNAME}/.codex)\n`,
  git: 'git version 2.47.1.windows.1\n',
  gh: 'gh version 2.63.0 (2024-11-27)\nhttps://github.com/cli/cli/releases/tag/v2.63.0\n',
  tailscale: '1.76.6\n  tailscale commit: abcdef\n  go version: go1.23.1\n',
  hermes: '0.99.0\n'
}

const answerByName = (overrides = {}) => (file) => {
  const name = basename(file).replace(/\.exe$/, '')
  const answer = overrides[name] ?? BANNERS[name]
  return answer ?? new Error('no such program')
}

test('the checks are the contract\'s tools, in its order', () => {
  assert.deepEqual(TOOL_CHECKS.map((check) => check.name), TOOL_NAMES)
})

test('a version is the first number with one to three dots, and nothing around it', () => {
  assert.equal(versionFrom(BANNERS.claude), '2.1.293')
  assert.equal(versionFrom(BANNERS.codex), '0.154.0')
  assert.equal(versionFrom(BANNERS.git), '2.47.1')
  assert.equal(versionFrom(BANNERS.gh), '2.63.0')
  assert.equal(versionFrom(BANNERS.tailscale), '1.76.6')
  assert.equal(versionFrom('v24.9.0'), '24.9.0')
  assert.equal(versionFrom('1.2.3.4.5'), '1.2.3.4')
  assert.equal(versionFrom('no number here'), null)
  assert.equal(versionFrom('build 2024'), null)
  assert.equal(versionFrom(`${'9'.repeat(40)}.1`), null)
  assert.equal(versionFrom(undefined), null)
})

test('an empty computer: programs not found, Node.js from the collector itself, apps could not be checked', async () => {
  const fake = await makeFakeHome()
  try {
    const exec = execStub(answerByName())
    const tools = await collectTools({ ...depsFor(fake), stateDir: join(fake.root, 'state'), exec, nodeVersion: 'v24.9.0' })
    assert.deepEqual(tools, [
      { name: 'Claude Code', state: 'not found' },
      { name: 'Codex', state: 'not found' },
      { name: 'Hermes', state: 'not found' },
      { name: 'Node.js', state: 'found', version: '24.9.0' },
      { name: 'Git', state: 'not found' },
      { name: 'GitHub CLI', state: 'not found' },
      { name: 'Claude app', state: 'could not check' },
      { name: 'ChatGPT app', state: 'could not check' },
      { name: 'Tailscale', state: 'not found' }
    ])
    assert.equal(exec.calls.length, 0, 'nothing was found, so nothing should have run')
  } finally {
    await fake.cleanup()
  }
})

test('found programs run by absolute path, with --version, from the empty folder, for ten seconds at most', async () => {
  const fake = await makeFakeHome()
  try {
    const paths = await addPrograms(fake, ['claude', 'codex', 'git', 'gh', 'tailscale'])
    const stateDir = join(fake.root, 'state')
    const exec = execStub(answerByName())
    const tools = await collectTools({ ...depsFor(fake), stateDir, exec, nodeVersion: 'v24.9.0' })
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
    assert.deepEqual(byName['Claude Code'], { name: 'Claude Code', state: 'found', version: '2.1.293' })
    assert.deepEqual(byName.Codex, { name: 'Codex', state: 'found', version: '0.154.0' })
    assert.deepEqual(byName.Git, { name: 'Git', state: 'found', version: '2.47.1' })
    assert.deepEqual(byName['GitHub CLI'], { name: 'GitHub CLI', state: 'found', version: '2.63.0' })
    assert.deepEqual(byName.Tailscale, { name: 'Tailscale', state: 'found', version: '1.76.6' })
    assert.deepEqual(exec.calls.map((call) => [call.file, call.args]), [
      [paths.claude, ['--version']],
      [paths.codex, ['--version']],
      [paths.git, ['--version']],
      [paths.gh, ['--version']],
      [paths.tailscale, ['version']]
    ])
    for (const call of exec.calls) {
      assert.equal(call.options.cwd, join(stateDir, 'empty-cwd'))
      assert.equal(call.options.timeout, 10_000)
      assert.ok(call.options.maxOutput <= 64 * 1024)
    }
    assert.deepEqual(checkConnections({ schema: 'agent-status/connections/v1', takenAt: '2026-10-07T20:00:00Z', computer: 'Test PC', tools, claude: { status: 'not found' }, codex: { status: 'not found' } }, fake.identity), [])
  } finally {
    await fake.cleanup()
  }
})

test('a program that fails or will not say its version is never "not found"', async () => {
  const fake = await makeFakeHome()
  try {
    await addPrograms(fake, ['claude', 'codex', 'gh'])
    const exec = execStub(answerByName({ claude: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), codex: 'codex-cli (no number)\n' }))
    const tools = await collectTools({ ...depsFor(fake), stateDir: join(fake.root, 'state'), exec, nodeVersion: 'v24.9.0' })
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
    assert.deepEqual(byName['Claude Code'], { name: 'Claude Code', state: 'could not check' })
    // It ran, so it is there; it just did not give a number.
    assert.deepEqual(byName.Codex, { name: 'Codex', state: 'found' })
  } finally {
    await fake.cleanup()
  }
})

test('a program found only inside --clone is "could not check", and never run', async () => {
  const fake = await makeFakeHome()
  try {
    const clone = join(fake.home, '.local')
    await addPrograms(fake, ['git'])
    const exec = execStub(answerByName())
    const tools = await collectTools({ ...depsFor(fake), stateDir: join(fake.root, 'state'), exec, clone, nodeVersion: 'v24.9.0' })
    assert.deepEqual(tools.find((tool) => tool.name === 'Git'), { name: 'Git', state: 'could not check' })
    assert.equal(exec.calls.length, 0)
  } finally {
    await fake.cleanup()
  }
})

// --- Hermes: files only ---------------------------------------------------------------------------------

test('Hermes\'s folder is found the way Hermes finds it', () => {
  assert.equal(hermesHome({ home: '/h', env: { HERMES_HOME: '/custom/hermes' }, platform: 'darwin' }), '/custom/hermes')
  assert.equal(hermesHome({ home: '/h', env: {}, platform: 'darwin' }), join('/h', '.hermes'))
  assert.equal(hermesHome({ home: '/h', env: {}, platform: 'linux' }), join('/h', '.hermes'))
  assert.equal(hermesHome({ home: 'C:\\h', env: { LOCALAPPDATA: 'C:\\h\\AppData\\Local' }, platform: 'win32' }), join('C:\\h\\AppData\\Local', 'hermes'))
  assert.equal(hermesHome({ home: 'C:\\h', env: {}, platform: 'win32' }), join('C:\\h', 'AppData', 'Local', 'hermes'))
  // The tools row and the Hermes card read the same folder: HERMES_HOME set to one profile means its root.
  assert.equal(hermesHome({ home: '/h', env: { HERMES_HOME: '/srv/hermes/profiles/coder' }, platform: 'linux' }), '/srv/hermes')
  // A relative HERMES_HOME is not a place anybody chose on purpose.
  assert.equal(hermesHome({ home: '/h', env: { HERMES_HOME: 'relative' }, platform: 'linux' }), join('/h', '.hermes'))
})

test('Hermes\'s version comes from pyproject.toml, or from hermes_cli, and hermes is never run', async () => {
  const pyproject = ['[build-system]', 'requires = ["setuptools"]', '', '[project]', 'name = "hermes-agent"', 'version = "0.21.3"', 'description = "x"'].join('\n')
  const cases = [
    [{ '.hermes/hermes-agent/pyproject.toml': pyproject }, { name: 'Hermes', state: 'found', version: '0.21.3' }],
    [{ '.hermes/hermes-agent/hermes_cli/__init__.py': '"""Hermes."""\n__version__ = "0.22.0"\n' }, { name: 'Hermes', state: 'found', version: '0.22.0' }],
    [{ '.hermes/config.yaml': 'model:\n  default: x\n' }, { name: 'Hermes', state: 'could not check' }],
    // A version line outside [project] (a tool's own version) is not Hermes's.
    [{ '.hermes/hermes-agent/pyproject.toml': '[tool.black]\nversion = "9.9.9"\n' }, { name: 'Hermes', state: 'could not check' }],
    [{}, { name: 'Hermes', state: 'not found' }]
  ]
  for (const [files, expected] of cases) {
    const fake = await makeFakeHome(files)
    try {
      await addPrograms(fake, ['hermes'])
      const exec = execStub(answerByName())
      const tools = await collectTools({ ...depsFor(fake), stateDir: join(fake.root, 'state'), exec, nodeVersion: 'v24.9.0' })
      assert.deepEqual(tools.find((tool) => tool.name === 'Hermes'), expected)
      assert.equal(exec.calls.some((call) => /hermes/i.test(call.file) || call.args.some((arg) => /hermes/i.test(arg))), false, 'hermes was run')
    } finally {
      await fake.cleanup()
    }
  }
})

test('the Hermes version reader keeps the number, never the line around it', async () => {
  const fake = await makeFakeHome({ '.hermes/hermes-agent/pyproject.toml': `[project]\nversion = "0.21.3+${FAKE_USERNAME}.${fakeClaudeToken()}"\n` })
  try {
    const tools = await collectTools({ ...depsFor(fake), stateDir: join(fake.root, 'state'), exec: execStub(answerByName()), nodeVersion: 'v24.9.0' })
    assert.deepEqual(tools.find((tool) => tool.name === 'Hermes'), { name: 'Hermes', state: 'found', version: '0.21.3' })
  } finally {
    await fake.cleanup()
  }
})

// --- the apps ------------------------------------------------------------------------------------------------

test('on a Mac, an app\'s version comes from its Info.plist through /usr/bin/plutil', async () => {
  const fake = await makeFakeHome()
  try {
    const apps = join(fake.root, 'Applications')
    await fake.write('../../Applications/Claude.app/Contents/Info.plist', '<plist/>')
    await fake.write('../../Applications/Tailscale.app/Contents/Info.plist', '<plist/>')
    await addPrograms(fake, ['tailscale'])
    const exec = execStub((file, args) => (file === '/usr/bin/plutil' ? (args.at(-1).includes('Claude.app') ? '1.0.211\n' : '1.76.6\n') : new Error('no')))
    const deps = { ...depsFor(fake), platform: 'darwin', knownFolders: [join(fake.home, '.local', 'bin')], appsFolder: apps, stateDir: join(fake.root, 'state'), exec, nodeVersion: 'v24.9.0' }
    const tools = await collectTools(deps)
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
    assert.deepEqual(byName['Claude app'], { name: 'Claude app', state: 'found', version: '1.0.211' })
    assert.deepEqual(byName['ChatGPT app'], { name: 'ChatGPT app', state: 'not found' })
    // The app wins over the command-line tool, so the menu-bar app is never launched as a CLI.
    assert.deepEqual(byName.Tailscale, { name: 'Tailscale', state: 'found', version: '1.76.6' })
    const plutil = exec.calls.filter((call) => call.file === '/usr/bin/plutil')
    assert.equal(plutil.length, 2)
    for (const call of plutil) {
      assert.deepEqual(call.args.slice(0, 5), ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-'])
      assert.match(call.args[5], /\.app[\\/]Contents[\\/]Info\.plist$/)
    }
    assert.equal(exec.calls.some((call) => basename(call.file) === 'tailscale'), false)
  } finally {
    await fake.cleanup()
  }
})

test('on Windows the apps say "could not check", and only .exe programs are found', async () => {
  const fake = await makeFakeHome()
  try {
    await addPrograms(fake, ['git'], 'win32')
    await fake.write('.local/bin/codex.cmd', '@echo off\r\n')
    const exec = execStub(answerByName())
    const tools = await collectTools({ ...depsFor(fake), platform: 'win32', env: {}, stateDir: join(fake.root, 'state'), exec, nodeVersion: 'v24.9.0' })
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
    assert.equal(byName['Claude app'].state, 'could not check')
    assert.equal(byName['ChatGPT app'].state, 'could not check')
    assert.deepEqual(byName.Git, { name: 'Git', state: 'found', version: '2.47.1' })
    assert.deepEqual(byName.Codex, { name: 'Codex', state: 'could not check' })
  } finally {
    await fake.cleanup()
  }
})

test('LEAK TEST: banners with accounts and folders leave only the numbers in the file and the log', async () => {
  const fake = await makeFakeHome()
  try {
    await addPrograms(fake, ['codex', 'claude'])
    const exec = execStub(answerByName({ claude: `2.1.293 (Claude Code) token ${fakeClaudeToken()}\n` }))
    const result = await runIn(fake, ['--computer', 'Test PC', '--only', 'connections'], { exec })
    assert.equal(result.code, 0, result.stderr)
    const text = await readFile(join(result.target, '.agent-team', 'status', 'connections', 'test-pc.json'), 'utf8')
    for (const output of [text, result.stdout, result.stderr]) {
      for (const needle of [FAKE_EMAIL, FAKE_USERNAME, '/Users/', fakeClaudeToken(), 'signed in']) assert.ok(!output.includes(needle), `leaked ${needle.slice(0, 6)}...`)
    }
    const doc = JSON.parse(text)
    assert.deepEqual(doc.tools.find((tool) => tool.name === 'Codex'), { name: 'Codex', state: 'found', version: '0.154.0' })
    assert.match(result.stdout, /- Tools: /)
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('the connections file carries the tools, after the live check has run', async () => {
  const fake = await makeFakeHome({ '.claude.json': { mcpServers: {} } })
  try {
    await addPrograms(fake, ['claude'])
    const order = []
    const exec = execStub((file, args) => {
      order.push(args.join(' '))
      return args[0] === 'mcp' ? 'No MCP servers configured.\n' : BANNERS.claude
    })
    const doc = await collectConnections({ ...depsFor(fake), stateDir: join(fake.root, 'state'), exec, nodeVersion: 'v24.9.0' }, 'Test PC')
    assert.deepEqual(order, ['mcp list', '--version'], 'the version check ran before or during the live check, sharing its folder')
    assert.equal(doc.tools.length, TOOL_NAMES.length)
    assert.equal(doc.claude.live, 'checked')
  } finally {
    await fake.cleanup()
  }
})
