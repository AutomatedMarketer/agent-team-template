import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm, readFile, writeFile, mkdir, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { repoRoot } from './helpers/repo.mjs'
import {
  CODEX_CONFIG_FILE,
  CODEX_PROFILE,
  CODEX_MINIMUM_VERSION,
  CODEX_VERSION_NEEDS,
  CODEX_ITEMS,
  WORKERS,
  codexFolders,
  codexHomeOf,
  buildCodexArgv,
  codexEnv,
  unsafeCodexEnv,
  writeCodexHome,
  sandboxProbeArgv,
  runCodex,
  codexPreflight,
  loginWord
} from '../scripts/lib/mailbox/codex.mjs'
import { atLeast } from '../scripts/lib/mailbox/claude.mjs'

/* Codex runs only a job the computer's own allowlist gives it (worker: codex), on a login of its own, in Codex's sandbox:
   read and write inside the work copy, read what programs need to start, nothing else, no network, no connectors, no MCP
   servers, no hooks, no AGENTS.md, no skills - and never with the owner's ~/.codex. Every test here uses a fake Codex: the
   real one is only run by the tests at the end, and only when it is on this computer (and never with a login). */

const PROMPT = 'You are running one job of my agent team.'
const WORK = join(tmpdir(), 'agent-mailbox-work')
const line = (value) => `${JSON.stringify(value)}\n`

/* ---------- where it is found, which version, what it is started with ---------------------------------------------------- */

test('Codex is looked for in fixed folders only, never PATH: the installer\'s link, Homebrew, the old npm place; on Windows the installer\'s folder and npm\'s native program', () => {
  assert.deepEqual(codexFolders('/Users/nuno', 'darwin'), [join('/Users/nuno', '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'])
  assert.deepEqual(codexFolders(undefined, 'darwin'), ['/opt/homebrew/bin', '/usr/local/bin'])
  const home = 'C:\\Users\\nuno'
  assert.deepEqual(codexFolders(home, 'win32'), [
    win32.join(home, 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin'),
    win32.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin'),
    win32.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-arm64', 'vendor', 'aarch64-pc-windows-msvc', 'bin')
  ])
  assert.deepEqual(codexFolders(undefined, 'win32'), [])
})

test('the floor is the version every flag, key and sandbox check was verified on, and the workers are claude and codex', () => {
  assert.deepEqual([...CODEX_MINIMUM_VERSION], [0, 160, 0])
  for (const needed of Object.values(CODEX_VERSION_NEEDS)) assert.ok(atLeast(CODEX_MINIMUM_VERSION, needed))
  assert.deepEqual([...WORKERS], ['claude', 'codex'])
})

test('the Codex home is next to the state folder, never inside it and never ~/.codex', () => {
  assert.equal(codexHomeOf(join('/Users/n', '.local', 'state', 'agent-mailbox')), join('/Users/n', '.local', 'state', 'agent-mailbox-codex'))
  if (process.platform === 'win32') assert.equal(codexHomeOf(win32.join('C:\\Users\\n\\AppData\\Local', 'Agent Board', 'state')), 'C:\\Users\\n\\AppData\\Local\\Agent Board\\agent-mailbox-codex')
})

test('the argument list is fixed: exec, JSON events, strict settings, nothing kept, no rules files, the work copy, and the prompt after --', () => {
  assert.deepEqual(buildCodexArgv({ prompt: PROMPT, workDir: WORK }), [
    'exec', '--json', '--strict-config', '--ephemeral', '--ignore-rules', '--skip-git-repo-check', '-C', WORK, '--', PROMPT
  ])
  const argv = buildCodexArgv({ prompt: PROMPT, workDir: WORK })
  for (const flag of ['--sandbox', '-s', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--add-dir', '--search', '--full-auto', '--yolo', '--ignore-user-config', '-c', '--config', '--enable', '-p', '--profile', '--oss']) {
    assert.ok(!argv.slice(0, -1).includes(flag), `${flag} is never passed`)
  }
  for (const prompt of ['', ' ', '--version', '-x', 7, null, undefined]) assert.throws(() => buildCodexArgv({ prompt, workDir: WORK }), TypeError, String(prompt))
  assert.throws(() => buildCodexArgv({ prompt: PROMPT, workDir: 'relative/work' }), TypeError)
})

test('the environment is a handful of names and CODEX_HOME, never a key; the keys that change the account are named, never their values', () => {
  const env = { HOME: '/Users/n', PATH: '/usr/bin', USER: 'n', LANG: 'en_US.UTF-8', TMPDIR: '/tmp/x', OPENAI_API_KEY: 'sk-secret', CODEX_API_KEY: 'k', ANTHROPIC_API_KEY: 'a', GITHUB_TOKEN: 'g', CODEX_HOME: '/Users/n/.codex', SSH_AUTH_SOCK: '/s' }
  assert.deepEqual(codexEnv(env, 'darwin', '/Users/n/.local/state/agent-mailbox-codex'), {
    HOME: '/Users/n', PATH: '/usr/bin', USER: 'n', LANG: 'en_US.UTF-8', TMPDIR: '/tmp/x', CODEX_HOME: '/Users/n/.local/state/agent-mailbox-codex'
  })
  const windows = codexEnv({ ...env, USERPROFILE: 'C:\\Users\\n', APPDATA: 'a', LOCALAPPDATA: 'l', SystemRoot: 'C:\\Windows', TEMP: 't', TMP: 't', Path: 'p' }, 'win32', 'C:\\h')
  assert.equal(windows.CODEX_HOME, 'C:\\h')
  assert.equal(windows.NoDefaultCurrentDirectoryInExePath, '1')
  assert.equal(windows.SystemRoot, 'C:\\Windows')
  for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK']) assert.ok(!(name in windows), name)
  assert.throws(() => codexEnv(env, 'darwin', 'relative'), TypeError)
  assert.deepEqual(unsafeCodexEnv(env), ['OPENAI_API_KEY', 'CODEX_API_KEY'])
  assert.deepEqual(unsafeCodexEnv({ OPENAI_BASE_URL: 'https://x', CODEX_ACCESS_TOKEN: 't', OPENAI_API_KEY: '' }), ['OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN'])
  assert.deepEqual(unsafeCodexEnv({}), [])
})

/* ---------- the settings file: the walls themselves ----------------------------------------------------------------------- */

const pinned = () => readFile(join(repoRoot, ...CODEX_CONFIG_FILE.split('/')), 'utf8')
const lineOf = (text, key) => text.split('\n').find((row) => row.trim().startsWith(`${key} =`) || row.trim().startsWith(`"${key}" =`))?.trim()

test('the settings file confines commands to the work copy with no network, through a permission profile and never sandbox_mode', async () => {
  const text = await pinned()
  const live = text.split('\n').filter((row) => !row.trim().startsWith('#')).join('\n')
  assert.equal(CODEX_PROFILE, 'mailbox-work')
  assert.equal(lineOf(live, 'default_permissions'), 'default_permissions = "mailbox-work"')
  assert.ok(!/^\s*sandbox_mode\s*=/m.test(live), 'sandbox_mode would switch the profile off')
  assert.ok(!/sandbox_workspace_write/.test(live))
  const profile = live.slice(live.indexOf('[permissions.mailbox-work]'))
  assert.match(profile, /^extends = ":workspace"$/m)
  assert.match(profile, /^":root" = "deny"$/m)
  assert.match(profile, /^":minimal" = "read"$/m)
  assert.match(profile, /^":tmpdir" = "deny"$/m)
  assert.match(profile, /^":slash_tmp" = "deny"$/m)
  assert.match(profile, /\[permissions\.mailbox-work\.network\]\nenabled = false/)
  assert.ok(!/"write"/.test(profile), 'nothing outside the work copy is made writable')
  assert.ok(!/\.network\.domains|network_proxy|allow_local_binding|unix_sockets/.test(live))
})

test('the settings file never asks, never searches the web, reads no AGENTS.md and no skills, and keeps the login a ChatGPT one in its own file', async () => {
  const live = (await pinned()).split('\n').filter((row) => !row.trim().startsWith('#')).join('\n')
  assert.equal(lineOf(live, 'approval_policy'), 'approval_policy = "never"')
  assert.equal(lineOf(live, 'web_search'), 'web_search = "disabled"')
  assert.equal(lineOf(live, 'project_doc_max_bytes'), 'project_doc_max_bytes = 0')
  assert.equal(lineOf(live, 'skills.max_context_tokens'), 'skills.max_context_tokens = 1')
  assert.equal(lineOf(live, 'cli_auth_credentials_store'), 'cli_auth_credentials_store = "file"')
  assert.equal(lineOf(live, 'forced_login_method'), 'forced_login_method = "chatgpt"')
  assert.equal(lineOf(live, 'agents.enabled'), 'agents.enabled = false')
  assert.equal(lineOf(live, 'check_for_update_on_startup'), 'check_for_update_on_startup = false')
  assert.match(live, /\[windows\]\nsandbox = "mxc"/)
})

test('the settings file switches off connectors, plugins, hooks, MCP installs, sub-agents, the browser and the computer, and names no server or command', async () => {
  const live = (await pinned()).split('\n').filter((row) => !row.trim().startsWith('#')).join('\n')
  const features = live.slice(live.indexOf('[features]'), live.indexOf('[windows]'))
  for (const name of ['apps', 'plugins', 'remote_plugin', 'hooks', 'skill_mcp_dependency_install', 'tool_suggest', 'multi_agent', 'memories', 'browser_use', 'browser_use_external', 'in_app_browser', 'computer_use', 'image_generation', 'view_image', 'daemon_auto_start', 'in_app_updates']) {
    assert.match(features, new RegExp(`^${name} = false$`, 'm'), name)
  }
  assert.ok(!/= true/.test(features), 'no feature is switched on')
  for (const word of ['mcp_servers', '[hooks', 'notify', 'otel', 'model_provider', 'openai_base_url', 'marketplaces', 'projects.', 'trust_level', 'shell_environment_policy', 'writable_roots', 'developer_instructions']) {
    assert.ok(!live.includes(word), `${word} is not in the settings`)
  }
})

test('the Codex home is written by the runner: a private folder with config.toml copied from the pinned file, never a link', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-home-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateDir = join(root, 'state')
  await mkdir(stateDir)
  const made = await writeCodexHome({ stateDir, codeDir: repoRoot })
  assert.deepEqual(made, { ok: true, home: codexHomeOf(stateDir) })
  assert.equal(await readFile(join(made.home, 'config.toml'), 'utf8'), await pinned())
  if (process.platform !== 'win32') {
    assert.equal((await stat(made.home)).mode & 0o777, 0o700)
    assert.equal((await stat(join(made.home, 'config.toml'))).mode & 0o777, 0o600)
  }
  // Written again before every start: an edit there does not survive.
  await writeFile(join(made.home, 'config.toml'), 'sandbox_mode = "danger-full-access"\n')
  await writeCodexHome({ stateDir, codeDir: repoRoot })
  assert.equal(await readFile(join(made.home, 'config.toml'), 'utf8'), await pinned())
  // A Codex home that is a link is never written through.
  const other = join(root, 'other')
  const linked = join(root, 'linked', 'state')
  await mkdir(other)
  await mkdir(join(root, 'linked'))
  await mkdir(linked)
  try {
    await symlink(other, codexHomeOf(linked), 'junction')
  } catch {
    t.diagnostic('this computer cannot make a link here; the link half is not proven')
    return
  }
  assert.deepEqual(await writeCodexHome({ stateDir: linked, codeDir: repoRoot }), { ok: false, home: codexHomeOf(linked) })
  await assert.rejects(readFile(join(other, 'config.toml')))
})

/* ---------- running it ------------------------------------------------------------------------------------------------ */

function fakeSpawn(script, { code = 0, hang = false } = {}) {
  const calls = []
  const spawn = (file, args, options) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 5151
    calls.push({ file, args, options })
    setImmediate(async () => {
      for (const event of script) child.stdout.write(typeof event === 'string' ? event : line(event))
      if (hang) return
      child.stdout.end()
      child.stderr.end()
      child.emit('exit', code)
      child.emit('close', code)
    })
    child.closeNow = (signalCode) => {
      child.stdout.end()
      child.stderr.end()
      child.emit('exit', null, signalCode)
      child.emit('close', null, signalCode)
    }
    spawn.last = child
    return child
  }
  spawn.calls = calls
  return spawn
}

const started = { type: 'thread.started', thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53' }
const turn = { type: 'turn.started' }
const done = { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } }
const item = (kind, type, extra = {}) => ({ type: kind, item: { id: `item_${Math.random().toString(16).slice(2, 8)}`, type, ...extra } })
const shell = (id, extra = {}) => [
  { type: 'item.started', item: { id, type: 'command_execution', command: 'bash -lc ls', aggregated_output: '', exit_code: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id, type: 'command_execution', command: 'bash -lc ls', aggregated_output: 'SECRET-OUTPUT', exit_code: 0, status: 'completed', ...extra } }
]

async function run(t, script, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-run-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const spawn = fakeSpawn(script, options)
  const kills = []
  const events = []
  const result = await runCodex({
    file: '/fake/bin/codex',
    argv: buildCodexArgv({ prompt: PROMPT, workDir: WORK }),
    cwd: WORK,
    env: { HOME: '/x', CODEX_HOME: '/h' },
    timeoutMs: options.timeoutMs ?? 5_000,
    killAfterMs: 20,
    closeWaitMs: 50,
    transcriptPath: join(root, 'transcript.jsonl'),
    stderrPath: join(root, 'stderr.txt'),
    spawn,
    kill: (pid, signal) => {
      kills.push([pid, signal])
      if (options.hang) spawn.last.closeNow(signal)
    },
    platform: 'darwin',
    onEvent: (event) => events.push(event)
  })
  return { result, spawn, kills, events, transcript: await readFile(join(root, 'transcript.jsonl'), 'utf8') }
}

test('a run that completes its turn and exits 0 is ok; it is started by the absolute file, with no shell, stdin closed, the work copy as its folder', async (t) => {
  const script = [started, turn, ...shell('item_1'), item('item.completed', 'file_change', { changes: [{ path: 'inbox/x.md', kind: 'add' }], status: 'completed' }), item('item.completed', 'agent_message', { text: 'Done.' }), done]
  const { result, spawn, events, transcript } = await run(t, script)
  assert.equal(result.ok, true)
  assert.deepEqual(result.calls, { Shell: 1, Edit: 1 })
  assert.equal(result.exitCode, 0)
  const { file, args, options } = spawn.calls[0]
  assert.equal(file, '/fake/bin/codex')
  assert.deepEqual(args, buildCodexArgv({ prompt: PROMPT, workDir: WORK }))
  assert.equal(options.shell, false)
  assert.equal(options.cwd, WORK)
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(options.detached, true)
  assert.equal(transcript, script.map(line).join(''))
  // Progress hears fixed words and tool names only: never a command, a path or anything Codex wrote.
  assert.deepEqual(events, [{ type: 'started' }, { type: 'tool', name: 'Shell' }, { type: 'tool', name: 'Edit' }, { type: 'finishing' }])
  assert.ok(!JSON.stringify(events).includes('SECRET-OUTPUT') && !JSON.stringify(events).includes('ls'))
})

test('an item seen started, updated and completed is one call, counted once', async (t) => {
  const id = 'item_7'
  const { result } = await run(t, [started, turn, ...shell(id), { type: 'item.updated', item: { id, type: 'command_execution', command: 'x', aggregated_output: '', exit_code: null, status: 'in_progress' } }, item('item.started', 'todo_list', { items: [] }), done])
  assert.equal(result.ok, true)
  assert.deepEqual(result.calls, { Shell: 1, Plan: 1 })
})

test('only these items may appear: messages, reasoning, commands, file changes, a plan and notices', () => {
  assert.deepEqual(Object.keys(CODEX_ITEMS).sort(), ['agent_message', 'command_execution', 'error', 'file_change', 'reasoning', 'todo_list'])
  assert.equal(CODEX_ITEMS.command_execution, 'Shell')
  assert.equal(CODEX_ITEMS.file_change, 'Edit')
  assert.equal(CODEX_ITEMS.todo_list, 'Plan')
})

for (const [type, name] of [['mcp_tool_call', 'an MCP tool'], ['web_search', 'a web search'], ['collab_tool_call', 'a sub-agent'], ['image_generation', 'an item no version was checked with']]) {
  test(`${name} stops the run at once, the whole tree, as tool-refused`, async (t) => {
    const { result, kills } = await run(t, [started, turn, item('item.started', type, { server: 'evil', tool: 'x' })], { hang: true })
    assert.equal(result.ok, false)
    assert.equal(result.why, 'tool-refused')
    assert.equal(result.tool, type)
    assert.deepEqual(kills[0], [5151, 'SIGKILL'])
  })
}

test('an event type nobody checked stops the run as tool-refused; a line that is not JSON is only kept', async (t) => {
  const first = await run(t, [started, turn, { type: 'session.configured', model: 'x' }], { hang: true })
  assert.equal(first.result.why, 'tool-refused')
  assert.equal(first.result.tool, 'unknown')
  const second = await run(t, ['Reading additional input from stdin...\n', started, turn, done])
  assert.equal(second.result.ok, true)
})

test('a failed turn, no completed turn, or a failing exit is codex-failed; a notice (error event) alone is not', async (t) => {
  assert.equal((await run(t, [started, turn, { type: 'turn.failed', error: { message: 'boom' } }])).result.why, 'codex-failed')
  assert.equal((await run(t, [started, turn])).result.why, 'codex-failed')
  assert.equal((await run(t, [started, turn, done], { code: 1 })).result.why, 'codex-failed')
  const notice = await run(t, [started, turn, { type: 'error', message: 'Reconnecting... 1/5' }, item('item.completed', 'error', { message: 'Exceeded skills context budget.' }), done])
  assert.equal(notice.result.ok, true)
  assert.deepEqual(notice.result.calls, {})
})

test('a run past its time is asked to stop, then killed, and is timed-out', async (t) => {
  const { result, kills } = await run(t, [started, turn], { hang: true, timeoutMs: 30 })
  assert.equal(result.why, 'timed-out')
  assert.deepEqual(kills[0], [5151, 'SIGTERM'])
})

test('a line longer than the cap stops the run as codex-failed', async (t) => {
  const { result } = await run(t, [started, 'x'.repeat(4 * 1024 * 1024 + 10)], { hang: true })
  assert.equal(result.why, 'codex-failed')
})

/* ---------- the check before any Codex job ------------------------------------------------------------------------------- */

const LOGINS = { chatgpt: { code: 0, stderr: 'Logged in using ChatGPT\n' }, apiKey: { code: 0, stderr: 'Logged in using an API key - sk-proj-***ABCDE\n' }, none: { code: 1, stderr: 'Not logged in\n' } }

function fakeExec({ version = 'codex-cli 0.160.0\n', login = LOGINS.chatgpt, probe = 'SANDBOX_OK\n' } = {}) {
  const calls = []
  const exec = async (file, args, options) => {
    calls.push({ file, args, options })
    if (args[0] === '--version') {
      if (version instanceof Error) throw version
      return { stdout: version, code: 0 }
    }
    if (args[0] === 'login') return { stdout: '', stderr: login.stderr, code: login.code }
    if (args[0] === 'sandbox') {
      if (probe instanceof Error) throw probe
      return { stdout: probe, code: 0 }
    }
    throw new Error('an unexpected program')
  }
  exec.calls = calls
  return exec
}

async function check(t, change = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-check-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateDir = join(root, 'state')
  const emptyDir = join(root, 'empty')
  await mkdir(stateDir)
  await mkdir(emptyDir)
  const exec = change.exec ?? fakeExec(change)
  const result = await codexPreflight({
    find: change.find ?? (async () => ({ state: 'found', path: '/fake/bin/codex' })),
    exec,
    stateDir,
    codeDir: repoRoot,
    emptyDir,
    env: change.env ?? { HOME: root, PATH: '/usr/bin' },
    platform: change.platform ?? 'darwin'
  })
  return { result, exec, stateDir }
}

test('a Codex that is found, new enough, signed in with ChatGPT and whose sandbox starts is ready; every question is asked in the Codex home, with the small environment', async (t) => {
  const { result, exec, stateDir } = await check(t)
  assert.deepEqual(result, { ok: true, version: [0, 160, 0], problems: [] })
  for (const call of exec.calls) {
    assert.equal(call.file, '/fake/bin/codex')
    assert.equal(call.options.env.CODEX_HOME, codexHomeOf(stateDir))
    assert.deepEqual(Object.keys(call.options.env).sort(), ['CODEX_HOME', 'HOME', 'PATH'])
  }
  assert.deepEqual(exec.calls.map((call) => call.args[0]), ['--version', 'login', 'sandbox'])
  assert.deepEqual(exec.calls[1].args, ['login', 'status'])
  assert.equal(exec.calls[1].options.stderr, true, 'the login line is read from the error stream, where Codex prints it')
  assert.deepEqual(exec.calls[2].args, sandboxProbeArgv({ dir: exec.calls[2].args[4], platform: 'darwin' }))
  const written = await readFile(join(codexHomeOf(stateDir), 'config.toml'), 'utf8')
  assert.ok(written.startsWith(await readFile(join(repoRoot, ...CODEX_CONFIG_FILE.split('/')), 'utf8')), 'the pinned settings, then the folders Codex must not trust')
  assert.match(written, /trust_level = "untrusted"/)
  assert.doesNotMatch(written, /trust_level = "trusted"/)
})

test('the sandbox probe starts the plainest command through Codex\'s own sandbox, with the runner\'s profile', () => {
  assert.deepEqual(sandboxProbeArgv({ dir: '/p', platform: 'darwin' }), ['sandbox', '-P', 'mailbox-work', '-C', '/p', '--', '/bin/echo', 'SANDBOX_OK'])
  const windows = sandboxProbeArgv({ dir: 'C:\\p', platform: 'win32', systemRoot: 'C:\\Windows' })
  assert.deepEqual(windows, ['sandbox', '-P', 'mailbox-work', '-C', 'C:\\p', '--', win32.join('C:\\Windows', 'System32', 'cmd.exe'), '/d', '/c', 'echo SANDBOX_OK'])
})

test('each problem is named in a word, all of them at once, and an API key in the environment is one of them', async (t) => {
  assert.deepEqual((await check(t, { env: { HOME: '/x', OPENAI_API_KEY: 'sk-x' } })).result.problems, ['codex-key-in-environment'])
  assert.deepEqual((await check(t, { find: async () => ({ state: 'not found' }) })).result.problems, ['codex-missing'])
  assert.deepEqual((await check(t, { version: 'no idea\n' })).result.problems, ['codex-version-unknown'])
  assert.deepEqual((await check(t, { version: new Error('EXIT') })).result.problems, ['codex-version-unknown'])
  assert.deepEqual((await check(t, { version: 'codex-cli 0.155.0-alpha.16\n' })).result.problems, ['codex-too-old'])
  assert.deepEqual((await check(t, { login: LOGINS.apiKey })).result.problems, ['codex-wrong-login'])
  assert.deepEqual((await check(t, { login: LOGINS.none })).result.problems, ['codex-not-logged-in'])
  assert.deepEqual((await check(t, { probe: new Error('EXIT') })).result.problems, ['codex-no-sandbox'])
  assert.deepEqual((await check(t, { probe: 'windows sandbox failed\n' })).result.problems, ['codex-no-sandbox'])
  assert.deepEqual((await check(t, { env: { OPENAI_API_KEY: 'k' }, version: 'codex-cli 0.150.0', login: LOGINS.none, probe: new Error('x') })).result.problems, ['codex-key-in-environment', 'codex-too-old', 'codex-not-logged-in', 'codex-no-sandbox'])
})

test('the login word comes from the exact line Codex prints, never from a key it shows', () => {
  assert.equal(loginWord(LOGINS.chatgpt), null)
  assert.equal(loginWord(LOGINS.apiKey), 'codex-wrong-login')
  assert.equal(loginWord(LOGINS.none), 'codex-not-logged-in')
  assert.equal(loginWord({ code: 0, stderr: 'Logged in using ChatGPT, or so it says\n' }), 'codex-wrong-login')
  assert.equal(loginWord({ code: 1, stderr: 'Logged in using ChatGPT\n' }), 'codex-not-logged-in')
  assert.equal(loginWord(null), 'codex-not-logged-in')
})

test('the runner\'s program starter keeps the error stream only when asked, for a program that prints its one line there', async () => {
  const { spawn } = await import('node:child_process')
  const { createRunner } = await import('../scripts/lib/status/programs.mjs')
  const exec = createRunner({ spawn, platform: process.platform, env: process.env })
  const script = ['-e', 'console.error("Logged in using ChatGPT"); process.exit(1)']
  const kept = await exec(process.execPath, script, { stderr: true, acceptAnyExit: true })
  assert.equal(kept.code, 1)
  assert.equal(loginWord(kept), 'codex-not-logged-in')
  assert.match(kept.stderr, /^Logged in using ChatGPT\r?\n$/)
  const dropped = await exec(process.execPath, script, { acceptAnyExit: true })
  assert.ok(!Object.hasOwn(dropped, 'stderr'), 'nobody asked, so the error stream is not kept')
  const good = await exec(process.execPath, ['-e', 'console.error("Logged in using ChatGPT")'], { stderr: true, acceptAnyExit: true })
  assert.equal(loginWord(good), null)
})

/* ---------- the T14 review: what Codex would read or follow in the work copy ---------------------------------------------- */

test('a work copy is refused for Codex when it has .codex or .agents at its top, or a link or a hard-linked file anywhere outside .git', async (t) => {
  const { codexRepoProblem } = await import('../scripts/lib/mailbox/codex.mjs')
  const { link } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'codex-repo-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const work = join(root, 'work')
  await mkdir(join(work, '.git', 'objects'), { recursive: true })
  await mkdir(join(work, 'tasks'), { recursive: true })
  await writeFile(join(work, 'tasks', 'card.md'), 'x\n')
  await writeFile(join(root, 'secret.txt'), 'secret\n')
  assert.equal(await codexRepoProblem(work), null)
  // git keeps hard links of its own objects for a clone from a folder: inside .git they are not looked at.
  await link(join(root, 'secret.txt'), join(work, '.git', 'objects', 'pack-linked'))
  assert.equal(await codexRepoProblem(work), null)
  for (const name of ['.codex', '.agents']) {
    await mkdir(join(work, name))
    assert.equal(await codexRepoProblem(work), 'codex-settings', name)
    await rm(join(work, name), { recursive: true })
  }
  await writeFile(join(work, '.codex'), 'a file, not a folder\n')
  assert.equal(await codexRepoProblem(work), 'codex-settings', 'a .codex that is a file')
  await rm(join(work, '.codex'))
  await link(join(root, 'secret.txt'), join(work, 'tasks', 'hard.md'))
  assert.equal(await codexRepoProblem(work), 'link', 'a pre-made hard link reads through Codex\'s sandbox, so it is refused')
  await rm(join(work, 'tasks', 'hard.md'))
  assert.equal(await codexRepoProblem(work), null)
  try {
    await symlink(join(root, 'secret.txt'), join(work, 'tasks', 'soft.md'))
  } catch {
    t.diagnostic('this computer cannot make a symbolic link without rights; the junction half below still runs')
  }
  if (await stat(join(work, 'tasks', 'soft.md')).then(() => true, () => false)) {
    assert.equal(await codexRepoProblem(work), 'link')
    await rm(join(work, 'tasks', 'soft.md'))
  }
  await mkdir(join(root, 'elsewhere'))
  await symlink(join(root, 'elsewhere'), join(work, 'tasks', 'junction'), 'junction')
  assert.equal(await codexRepoProblem(work), 'link')
})

test('the check before any Codex job probes the sandbox in the real work copy when there is one, and names it untrusted for Codex', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-check-work-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stateDir = join(root, 'state')
  const work = join(root, 'work')
  await mkdir(stateDir)
  await mkdir(work)
  const exec = fakeExec()
  const { codexTrustKey } = await import('../scripts/lib/mailbox/codex.mjs')
  const result = await codexPreflight({ find: async () => ({ state: 'found', path: '/fake/bin/codex' }), exec, stateDir, codeDir: repoRoot, emptyDir: root, env: { HOME: root }, platform: 'darwin', workDir: work })
  assert.equal(result.ok, true)
  const probe = exec.calls.find((call) => call.args[0] === 'sandbox')
  assert.equal(probe.args[4], work)
  assert.ok((await readFile(join(codexHomeOf(stateDir), 'config.toml'), 'utf8')).includes(`[projects.${JSON.stringify(codexTrustKey(work))}]\ntrust_level = "untrusted"`))
})
