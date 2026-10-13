// A whole world for the runner's tick, all of it fake except git and the file system: a team repo (a bare repo and the
// runner's clone of it, with the real template's workflows and agents), a state folder with an allowlist and a secrets file,
// a board that answers with the orders it is given, a Claude that writes the files its script tells it to, and a clock that
// only moves when a test moves it. Nothing here touches the network, the real Claude, or any folder of the person running
// the tests.

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { repoRoot } from './repo.mjs'
import { git } from './git.mjs'
import { signBody } from '../../scripts/lib/mailbox/envelope.mjs'
import { openStore } from '../../scripts/lib/mailbox/claims.mjs'

export const SECRET = ['signing', 'secret', 'one', 'made', 'for', 'this', 'test', '9876543210'].join('-')
export const FAKE_API_KEY = ['sk', 'ant', 'test', 'not', 'real', '0123456789012345'].join('-')
export const KEY = ['poll', 'key', 'made', 'for', 'this', 'test', 'only', '0123456789'].join('-')
export const REPO = 'ExampleOwner/example-team'
export const T0 = Date.parse('2026-10-12T14:05:41.000Z')
export const CARD = '---\nstatus: todo\nfor: sales\n---\n\n# Call the supplier\n\nAsk about the lead time.\n'
export const PROPOSALS = 'proposals:\n  - task: Writing the newsletter\n    item: agent:content\n    why: its description names newsletters directly\n  - task: Sorting the inbox\n    item: agent:email\ngaps:\n'
const real = (relative) => readFileSync(join(repoRoot, ...relative.split('/')), 'utf8')

export const ALLOWLIST = (change = {}) => {
  const fields = {
    board: 'https://board.example.com',
    repo: REPO,
    runner: 'mac-mini',
    computer: 'Mac Mini',
    actions: '[task, move, approve, pause, run, arm, skill, agent]',
    jobs: '\n  - slug: morning-intel\n    minutes: 20\n  - slug: task-sweep\n    minutes: 30',
    per_day: '\n  orders: 40\n  runs: 6',
    ...change
  }
  return `board: ${fields.board}\nrepo: ${fields.repo}\nrunner: ${fields.runner}\ncomputer: ${fields.computer}\nactions: ${fields.actions}\njobs:${fields.jobs}\nper_day:${fields.per_day}\n`
}

const SEED = {
  'README.md': '# Team\n',
  'tasks/README.md': '# tasks\n',
  'tasks/2026-08-18-call-supplier.md': CARD,
  'tasks/2026-08-19-other-card.md': '---\nstatus: todo\n---\n\n# Other card\n\nAsk the other thing.\n',
  'workflows/morning-intel.yml': real('workflows/morning-intel.yml'),
  'workflows/task-sweep.yml': real('workflows/task-sweep.yml'),
  '.claude/agents/research.md': real('.claude/agents/research.md'),
  '.claude/agents/orchestrator.md': real('.claude/agents/orchestrator.md'),
  'proposals.yml': PROPOSALS,
  'inbox/.gitkeep': ''
}

const iso = (ms) => new Date(ms).toISOString()
const line = (value) => `${JSON.stringify(value)}\n`

// `storeAgo`: how long before the clock starts the runner's claims folder was made. An order issued before that is refused (the
// contract's "claims since" rule), so a world where orders are issued a minute ago needs a runner that was set up earlier.
export async function mailboxWorld({ files = {}, allowlist = ALLOWLIST(), clockAt = T0, storeAgo = 3600_000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mailbox-world-'))
  const place = (...parts) => join(root, ...parts)
  const places = { stateDir: place('state'), codeDir: repoRoot, workDir: place('work'), envFile: place('config', 'env') }
  const originDir = place('origin.git')
  const seedDir = place('seed')
  const otherDir = place('other')
  await mkdir(places.stateDir, { recursive: true })
  await mkdir(dirname(places.envFile), { recursive: true })
  await writeFile(join(places.stateDir, 'allowed-orders.yml'), allowlist)
  if (storeAgo !== null) await openStore(places.stateDir, clockAt - storeAgo)
  await writeFile(places.envFile, `MAILBOX_KEY=${KEY}\nMAILBOX_SECRET_k1=${SECRET}\n`)
  if (process.platform !== 'win32') await chmod(places.envFile, 0o600)

  await git(['init', '-q', '--bare', '-b', 'main', originDir], root)
  await git(['clone', '-q', originDir, seedDir], root)
  for (const [key, value] of [['user.email', 'seed@example.com'], ['user.name', 'Seed'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) await git(['config', key, value], seedDir)
  for (const [name, text] of Object.entries({ ...SEED, ...files })) {
    await mkdir(dirname(join(seedDir, ...name.split('/'))), { recursive: true })
    await writeFile(join(seedDir, ...name.split('/')), text)
  }
  await git(['add', '-A'], seedDir)
  await git(['commit', '-q', '-m', 'seed'], seedDir)
  await git(['push', '-q', 'origin', 'HEAD:refs/heads/main'], seedDir)
  await git(['clone', '-q', originDir, places.workDir], root)
  // Cloned the way the runner's own work is: a Windows line-ending setting must not make the other pusher's files look changed.
  await git(['clone', '-q', '-c', 'core.autocrlf=false', originDir, otherDir], root)
  for (const [key, value] of [['user.email', 'other@example.com'], ['user.name', 'Other'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) await git(['config', key, value], otherDir)

  const clock = { at: clockAt, now: () => clock.at, advance: (ms) => { clock.at += ms } }

  /* ---- the board ---- */
  const board = { orders: [], pollSeconds: 300, status: 200, down: false, polls: 0, headers: [] }
  const fetch = async (url, options) => {
    board.polls += 1
    board.headers.push({ url, ...options })
    if (board.down) throw new Error('connect ECONNREFUSED')
    if (board.status !== 200) return new Response('{}', { status: board.status })
    return new Response(JSON.stringify({ v: 1, pollSeconds: board.pollSeconds, orders: board.orders }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  /* ---- orders ---- */
  let nextId = 1
  const idOf = (n) => String(n).padStart(32, '0')
  const order = (payload, change = {}) => {
    const id = change.id ?? idOf(nextId++)
    const body = JSON.stringify({
      v: 1,
      id,
      repo: REPO,
      runner: 'mac-mini',
      issuedAt: iso(clock.at - 60_000),
      expiresAt: iso(clock.at + 14 * 60_000),
      payload: { source: 'agent-cockpit', ...payload },
      ...change.body
    })
    return { id, envelope: { kid: 'k1', body, sig: signBody(body, SECRET) } }
  }
  const send = (payload, change) => {
    const made = order(payload, change)
    board.orders.push(made.envelope)
    return made
  }

  /* ---- Claude ---- */
  const claude = { calls: [], script: null }
  const spawn = (file, args, options) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 4242
    child.kill = () => true
    const call = { file, args, options }
    claude.calls.push(call)
    setImmediate(async () => {
      try {
        const events = await (claude.script ?? (async () => []))(options.cwd, args, call)
        for (const event of events) child.stdout.write(line(event))
        child.stdout.end()
        child.stderr.end()
        let waiting = 2
        const done = () => { waiting -= 1; if (waiting === 0) child.emit('close', 0, null) }
        child.stdout.once('end', done)
        child.stderr.once('end', done)
        child.stdout.resume()
        child.stderr.resume()
      } catch (error) {
        child.emit('error', error)
      }
    })
    return child
  }
  const kill = () => {}
  const INIT = { type: 'system', subtype: 'init', tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'], mcp_servers: [] }
  const RESULT = { type: 'result', subtype: 'success', is_error: false, num_turns: 4, result: 'Wrote the files.', permission_denials: [] }
  const tool = (name) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input: {} }] } })

  /* ---- a good morning-intel run, as a real Claude would do it from the prompt it is given ---- */
  const writeAt = async (cwd, relative, text) => {
    await mkdir(dirname(join(cwd, ...relative.split('/'))), { recursive: true })
    await writeFile(join(cwd, ...relative.split('/')), text)
  }
  const facts = (prompt) => ({
    startedAt: /this run started at (\S+)/.exec(prompt)[1],
    stamps: /where <stamp> is one of ([0-9TZ:, -]+?) \(/.exec(prompt)[1].split(', '),
    outputPath: /nowhere else: `([^`]+)`/.exec(prompt)[1],
    model: /^- model: (\w+)$/m.exec(prompt)[1],
    owner: /owned by the agent `([a-z-]+)`/.exec(prompt)[1],
    workflow: /The job is `([a-z-]+)`/.exec(prompt)[1]
  })
  const logOf = (info, change = {}) => {
    const stamp = change.stamp ?? info.stamps[0]
    const agent = change.agent ?? info.owner
    return {
      schema: 'run-log/v1', run_id: `${stamp}-${agent}-${info.workflow}`, agent, workflow: info.workflow, model: info.model, trigger: 'manual',
      started_at: info.startedAt, finished_at: info.startedAt, status: 'ok',
      summary: 'Ran the job once from the Mac mailbox and wrote its output; nothing was sent or published.',
      artifacts: [info.outputPath], evidence: ['Wrote 2 files'], next_action: null, session_id: null, session_url: null, ...change.entry
    }
  }
  const writeLog = (cwd, entry) => writeAt(cwd, `runs/${entry.run_id.slice(0, 7)}/${entry.run_id}.json`, `${JSON.stringify(entry, null, 2)}\n`)
  claude.good = async (cwd, args) => {
    const info = facts(args[1])
    await writeAt(cwd, info.outputPath, `# ${info.workflow} - ${info.outputPath}\n\nAll quiet.\n`)
    await writeLog(cwd, logOf(info))
    return [INIT, tool('Read'), tool('WebSearch'), tool('Write'), RESULT]
  }

  /* ---- what the tick is handed ---- */
  const logs = []
  const exec = async (file, args) => {
    if (args[0] === '--version') return { stdout: '2.1.290 (Claude Code)\n', code: 0 }
    if (args[0] === 'auth') return { stdout: JSON.stringify({ authMethod: 'claude.ai', loggedIn: true }), code: 0 }
    throw new Error('an unexpected program')
  }
  const ctx = (change = {}) => ({
    places,
    now: clock.now,
    platform: process.platform,
    env: { HOME: root, PATH: '/usr/bin' },
    home: root,
    identity: { hostname: 'nunos-mac', username: 'nunotavares', home: root },
    timeZone: 'UTC',
    fetch,
    git,
    exec,
    find: async () => ({ state: 'found', path: '/fake/bin/claude' }),
    spawn,
    kill,
    originAccepted: () => true,
    log: (text) => logs.push(text),
    force: false,
    ...change
  })

  /* ---- looking at what happened ---- */
  const inOrigin = {
    head: async () => (await git(['rev-parse', 'refs/heads/main'], originDir)).stdout.trim(),
    log: async () => (await git(['log', '--format=%s', 'refs/heads/main'], originDir)).stdout.trim().split('\n'),
    file: async (path) => {
      try {
        return (await git(['show', `refs/heads/main:${path}`], originDir)).stdout
      } catch {
        return null
      }
    },
    commits: async () => Number((await git(['rev-list', '--count', 'refs/heads/main'], originDir)).stdout.trim()),
    message: async (rev = 'refs/heads/main') => (await git(['log', '-1', '--format=%B', rev], originDir)).stdout
  }
  const claimFile = async (id, name) => {
    try {
      return JSON.parse(await readFile(join(places.stateDir, 'claims', `${id}.claim`, name), 'utf8'))
    } catch {
      return null
    }
  }
  const otherPush = async (name, text = 'x\n') => {
    await git(['pull', '-q', '--rebase', 'origin', 'main'], otherDir)
    await mkdir(dirname(join(otherDir, ...name.split('/'))), { recursive: true })
    await writeFile(join(otherDir, ...name.split('/')), text)
    await git(['add', '-A'], otherDir)
    await git(['commit', '-q', '-m', `other: ${name}`], otherDir)
    await git(['push', '-q', 'origin', 'HEAD:refs/heads/main'], otherDir)
    return (await git(['rev-parse', 'HEAD'], otherDir)).stdout.trim()
  }

  return {
    root, places, originDir, clock, board, send, order, idOf, claude, claudeSpawn: spawn, INIT, RESULT, tool, facts, logOf, writeLog, writeAt,
    ctx, logs, inOrigin, claimFile, otherPush, exec,
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}
