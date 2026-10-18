import test from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { mailboxWorld, CLAUDE_FILE, ALLOWLIST, T0 } from './helpers/mailbox-world.mjs'
import { runTick } from '../scripts/lib/mailbox/tick.mjs'
import { checkMailbox } from '../scripts/lib/status/safe.mjs'
import { buildCodexArgv, codexEnv, codexHomeOf } from '../scripts/lib/mailbox/codex.mjs'
import { CODEX_PROOF_FILE, keepCodexProof } from '../scripts/lib/mailbox/proof.mjs'
import { rm } from 'node:fs/promises'

/* Codex as the second worker, inside one tick: it runs ONLY a job this computer's allowlist gives it, only when the order asked for
   Codex, only when Codex is found, new enough, signed in with ChatGPT, its sandbox starts and its self-test passed for this very file
   - and then exactly as a Claude run is handled after it ends (the .git guard, the changed-files check, the push). A computer whose
   allowlist gives no job to Codex never looks for Codex at all, and its status file is what it always was. */

const STATUS = '.agent-team/status/mailbox/mac-mini.json'
const CODEX_FILE = '/fake/bin/codex'
const CODEX_JOBS = '\n  - slug: morning-intel\n    minutes: 20\n  - slug: task-sweep\n    minutes: 30\n    worker: codex'
const statusIn = async (w) => JSON.parse(await w.inOrigin.file(STATUS))
const entryFor = (status, id) => status.orders.find((order) => order.id === id)
const exists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function withWorld(options, fn) {
  const w = await mailboxWorld({ allowlist: ALLOWLIST({ jobs: CODEX_JOBS }), ...options })
  try {
    if (options.codexProof !== false) await keepCodexProof({ stateDir: w.places.stateDir, codeDir: w.places.codeDir, version: [0, 160, 0], file: CODEX_FILE, now: () => T0 })
    return await fn(w)
  } finally {
    await w.cleanup()
  }
}

// What the tick is handed for a computer with Codex: the world's Claude, and a Codex that answers its checks.
function codexWorld(w, { version = 'codex-cli 0.160.0', versions = null, login = 'Logged in using ChatGPT', probe = 'SANDBOX_OK', env = {}, script = null } = {}) {
  const asked = []
  let versionAt = 0
  const exec = async (file, args, options) => {
    if (file !== CODEX_FILE) return w.exec(file, args, options)
    asked.push({ args, options })
    if (args[0] === '--version') return { stdout: `${versions ? versions[Math.min(versionAt++, versions.length - 1)] : version}\n`, code: 0 }
    if (args[0] === 'login') return { stdout: '', stderr: `${login}\n`, code: login.startsWith('Not') ? 1 : 0 }
    if (args[0] === 'sandbox') return { stdout: `${probe}\n`, code: 0 }
    throw new Error('an unexpected program')
  }
  const finds = []
  const find = async (name) => {
    finds.push(name)
    return { state: 'found', path: name === 'codex' ? CODEX_FILE : CLAUDE_FILE }
  }
  const codexRuns = []
  const claudeScript = w.claude.script
  w.claude.script = async (cwd, args, call) => {
    if (call.file !== CODEX_FILE) return (claudeScript ?? (async () => []))(cwd, args, call)
    codexRuns.push(call)
    return (script ?? sweep(w))(cwd, args, call)
  }
  return { ctx: (change = {}) => w.ctx({ exec, find, env: { HOME: w.root, PATH: '/usr/bin', ...env }, ...change }), asked, finds, codexRuns }
}

const item = (n, type, extra) => [
  { type: 'item.started', item: { id: `item_${n}`, type, status: 'in_progress', ...extra } },
  { type: 'item.completed', item: { id: `item_${n}`, type, status: 'completed', ...extra } }
]
const DONE = { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }

// A good task sweep, done the way Codex does it: commands and a file change, then the turn completes.
function sweep(w, { extra = [] } = {}) {
  return async (cwd, args) => {
    const info = w.facts(args.at(-1))
    await w.writeAt(cwd, info.outputPath, '# Task sweep\n\nNothing to work today.\n')
    await w.writeLog(cwd, w.logOf(info, { agent: 'orchestrator' }))
    return [
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.started' },
      ...item(1, 'command_execution', { command: 'cat workflows/task-sweep.yml', aggregated_output: 'x', exit_code: 0 }),
      ...item(2, 'file_change', { changes: [{ path: info.outputPath, kind: 'add' }] }),
      ...extra,
      { type: 'item.completed', item: { id: 'item_9', type: 'agent_message', text: 'Wrote the digest.' } },
      DONE
    ]
  }
}

test('a Codex job ordered for Codex runs with Codex - its file, its fixed arguments, its own home and small environment - and lands like any run', () => withWorld({}, async (w) => {
  const c = codexWorld(w)
  const sent = w.send({ action: 'run', workflow: 'task-sweep', worker: 'codex' })
  const result = await runTick(c.ctx())
  assert.equal(result.orders.ok, 1, JSON.stringify(entryFor(await statusIn(w), sent.id)))
  assert.equal(c.codexRuns.length, 1)
  const [run] = c.codexRuns
  const prompt = run.args.at(-1)
  assert.deepEqual(run.args, buildCodexArgv({ prompt, workDir: w.places.workDir }))
  assert.equal(run.options.cwd, w.places.workDir)
  assert.deepEqual(run.options.env, codexEnv({ HOME: w.root, PATH: '/usr/bin' }, process.platform, codexHomeOf(w.places.stateDir)))
  assert.equal(run.options.shell, false)
  // The prompt is the job's own, with the note for Codex (it has a shell, inside the work copy, with no network) and not the one for Claude.
  assert.match(prompt, /The job is `task-sweep`/)
  assert.match(prompt, /You are running as Codex/)
  assert.doesNotMatch(prompt, /You have no shell: do not try to run commands/)
  assert.equal(await w.inOrigin.file('inbox/2026-10-12/task-sweep.md'), '# Task sweep\n\nNothing to work today.\n')
  const status = await statusIn(w)
  assert.deepEqual(status.allows, { actions: ['task', 'move', 'approve', 'pause', 'run', 'arm', 'skill', 'agent'], jobs: ['morning-intel', 'task-sweep'], workers: ['claude', 'codex'], codexJobs: ['task-sweep'] })
  assert.equal(entryFor(status, sent.id).state, 'ok')
  assert.equal(entryFor(status, sent.id).steps, 2, 'one command and one file change')
  assert.deepEqual(checkMailbox(status, { hostname: 'nunos-mac', username: 'nunotavares', home: w.root }), [])
  // The settings Codex ran with are the pinned ones, written into its own home.
  assert.equal(await readFile(join(codexHomeOf(w.places.stateDir), 'config.toml'), 'utf8'), await readFile(join(w.places.codeDir, '.agent-team', 'mailbox', 'codex-config.toml'), 'utf8'))
}))

test('an order that does not ask for the job\'s worker is refused as worker-not-allowed, and neither worker starts', () => withWorld({}, async (w) => {
  const c = codexWorld(w)
  w.claude.script = w.claude.good
  const plain = w.send({ action: 'run', workflow: 'task-sweep' })
  await runTick(c.ctx({ force: true }))
  const asClaude = w.send({ action: 'run', workflow: 'task-sweep', worker: 'claude' })
  await runTick(c.ctx({ force: true }))
  const codexForClaudeJob = w.send({ action: 'run', workflow: 'morning-intel', worker: 'codex' })
  await runTick(c.ctx({ force: true }))
  const status = await statusIn(w)
  for (const sent of [plain, asClaude, codexForClaudeJob]) assert.deepEqual([entryFor(status, sent.id).state, entryFor(status, sent.id).why], ['refused', 'worker-not-allowed'])
  assert.equal(c.codexRuns.length, 0)
  assert.equal(w.claude.calls.filter((call) => call.file === CLAUDE_FILE).length, 0)
}))

test('a Claude job on a Codex computer still runs with Claude, exactly as before', () => withWorld({}, async (w) => {
  w.claude.script = w.claude.good
  const c = codexWorld(w)
  const sent = w.send({ action: 'run', workflow: 'morning-intel' })
  const result = await runTick(c.ctx())
  assert.equal(result.orders.ok, 1, JSON.stringify(entryFor(await statusIn(w), sent.id)))
  assert.equal(c.codexRuns.length, 0)
  assert.equal(w.claude.calls[0].file, CLAUDE_FILE)
}))

for (const [label, change, word] of [
  ['signed in with an API key', { login: 'Logged in using an API key - sk-***' }, 'codex-wrong-login'],
  ['not signed in', { login: 'Not logged in' }, 'codex-not-logged-in'],
  ['too old', { version: 'codex-cli 0.155.0-alpha.16' }, 'codex-too-old'],
  ['whose sandbox does not start', { probe: 'windows sandbox failed' }, 'codex-no-sandbox'],
  ['with an OpenAI key in the environment', { env: { OPENAI_API_KEY: 'sk-not-real' } }, 'codex-key-in-environment']
]) {
  test(`a Codex ${label}: the Codex job is refused as not-ready and the log names ${word}; Claude jobs are untouched`, () => withWorld({}, async (w) => {
    w.claude.script = w.claude.good
    const c = codexWorld(w, change)
    const codexOrder = w.send({ action: 'run', workflow: 'task-sweep', worker: 'codex' })
    const logs = []
    await runTick(c.ctx({ log: (line) => logs.push(line) }))
    const status = await statusIn(w)
    assert.deepEqual([entryFor(status, codexOrder.id).state, entryFor(status, codexOrder.id).why], ['refused', 'not-ready'])
    assert.equal(c.codexRuns.length, 0)
    assert.ok(logs.some((line) => line.includes('Codex') && line.includes(word)), logs.join('\n'))
    assert.ok(!logs.join('\n').includes('sk-not-real'))
    assert.deepEqual(status.allows.workers, ['claude'])
    const claudeOrder = w.send({ action: 'run', workflow: 'morning-intel' })
    await runTick(c.ctx({ force: true }))
    assert.equal(entryFor(await statusIn(w), claudeOrder.id).state, 'ok')
  }))
}

test('no Codex self-test for this version: the Codex job is refused as not-ready, and the log says to run --codex-selftest', () => withWorld({ codexProof: false }, async (w) => {
  const c = codexWorld(w)
  const sent = w.send({ action: 'run', workflow: 'task-sweep', worker: 'codex' })
  const logs = []
  await runTick(c.ctx({ log: (line) => logs.push(line) }))
  assert.deepEqual([entryFor(await statusIn(w), sent.id).state, entryFor(await statusIn(w), sent.id).why], ['refused', 'not-ready'])
  assert.ok(logs.some((line) => line.includes('codex-selftest-needed')), logs.join('\n'))
  assert.equal(c.codexRuns.length, 0)
  assert.deepEqual((await statusIn(w)).allows.workers, ['claude'])
}))

test('Codex changed after the daily check: the version asked just before the run is not the tested one, so it never starts', () => withWorld({}, async (w) => {
  const c = codexWorld(w, { versions: ['codex-cli 0.160.0', 'codex-cli 0.161.0'] })
  const sent = w.send({ action: 'run', workflow: 'task-sweep', worker: 'codex' })
  const logs = []
  await runTick(c.ctx({ log: (line) => logs.push(line) }))
  assert.deepEqual([entryFor(await statusIn(w), sent.id).state, entryFor(await statusIn(w), sent.id).why], ['refused', 'not-ready'])
  assert.equal(c.codexRuns.length, 0)
  assert.ok(logs.some((line) => line.includes('0.161.0') && line.includes('--codex-selftest')), logs.join('\n'))
}))

test('a Codex run that uses an MCP tool fails as tool-refused, one whose turn fails is codex-failed, and nothing is pushed either time', () => withWorld({}, async (w) => {
  const mcp = codexWorld(w, { script: sweep(w, { extra: [{ type: 'item.started', item: { id: 'item_5', type: 'mcp_tool_call', server: 'evil', tool: 'x', status: 'in_progress' } }] }) })
  const first = w.send({ action: 'run', workflow: 'task-sweep', worker: 'codex' })
  await runTick(mcp.ctx())
  assert.deepEqual([entryFor(await statusIn(w), first.id).state, entryFor(await statusIn(w), first.id).why], ['failed', 'tool-refused'])
  const failing = async (cwd, args) => [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.started' }, { type: 'turn.failed', error: { message: 'x' } }]
  const second = codexWorld(w, { script: failing })
  const sent = w.send({ action: 'run', workflow: 'task-sweep', worker: 'codex' })
  await runTick(second.ctx({ force: true }))
  assert.deepEqual([entryFor(await statusIn(w), sent.id).state, entryFor(await statusIn(w), sent.id).why], ['failed', 'codex-failed'])
  assert.equal(await w.inOrigin.file('inbox/2026-10-12/task-sweep.md'), null)
}))

test('a job that needs the web is never Codex\'s: marked worker: codex it is not offered, and an order for it is job-not-allowed', () => withWorld({ allowlist: ALLOWLIST({ jobs: '\n  - slug: morning-intel\n    minutes: 20\n    worker: codex\n  - slug: task-sweep\n    minutes: 30' }) }, async (w) => {
  const c = codexWorld(w)
  const sent = w.send({ action: 'run', workflow: 'morning-intel', worker: 'codex' })
  await runTick(c.ctx())
  const status = await statusIn(w)
  assert.deepEqual(status.allows.jobs, ['task-sweep'])
  assert.deepEqual([entryFor(status, sent.id).state, entryFor(status, sent.id).why], ['refused', 'job-not-allowed'])
  assert.equal(c.codexRuns.length, 0)
}))

test('a computer whose allowlist gives no job to Codex never looks for Codex, and its status file has no worker keys', () => withWorld({ allowlist: ALLOWLIST(), codexProof: false }, async (w) => {
  w.claude.script = w.claude.good
  const c = codexWorld(w)
  const sent = w.send({ action: 'run', workflow: 'morning-intel' })
  await runTick(c.ctx())
  assert.equal(entryFor(await statusIn(w), sent.id).state, 'ok')
  assert.ok(!c.finds.includes('codex'), 'Codex is never looked for')
  assert.equal(c.asked.length, 0, 'nor asked anything')
  assert.deepEqual(Object.keys((await statusIn(w)).allows), ['actions', 'jobs'])
  assert.ok(!(await exists(codexHomeOf(w.places.stateDir))), 'and no Codex home is made')
  assert.ok(!(await exists(join(w.places.stateDir, 'codex-preflight.json'))))
  assert.ok(!(await readdir(w.places.stateDir)).includes(CODEX_PROOF_FILE))
}))

test('a good Codex check is remembered for the day, like Claude\'s; a key in the environment is looked at on every tick', () => withWorld({}, async (w) => {
  const c = codexWorld(w)
  await runTick(c.ctx({ force: true }))
  const first = c.asked.filter((call) => call.args[0] === 'login').length
  await runTick(c.ctx({ force: true }))
  assert.equal(c.asked.filter((call) => call.args[0] === 'login').length, first, 'not asked again the same day')
  const keyed = codexWorld(w, { env: { CODEX_API_KEY: 'k' } })
  const sent = w.send({ action: 'run', workflow: 'task-sweep', worker: 'codex' })
  await runTick(keyed.ctx({ force: true }))
  assert.equal(entryFor(await statusIn(w), sent.id).why, 'not-ready')
  await rm(join(w.places.stateDir, 'codex-preflight.json'), { force: true })
}))
