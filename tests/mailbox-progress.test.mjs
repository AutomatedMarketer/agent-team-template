import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mailboxWorld, T0 } from './helpers/mailbox-world.mjs'
import { runTick } from '../scripts/lib/mailbox/tick.mjs'
import { createLive, signalHandler } from '../scripts/lib/mailbox/signals.mjs'
import { releaseLock } from '../scripts/lib/status/commit.mjs'
import { entryFromRecords } from '../scripts/lib/mailbox/ledger.mjs'
import { runClaude } from '../scripts/lib/mailbox/claude.mjs'
import { PROGRESS, createProgress, settleLeftovers } from '../scripts/lib/mailbox/progress.mjs'
import { checkMailbox } from '../scripts/lib/status/safe.mjs'
import { MAILBOX_SHAPE } from '../scripts/lib/status/mailbox-schema.mjs'

/* Live progress of a run. While Claude works, the runner keeps one small file in its state folder (progress/<order id>.json) that says only HOW FAR it is:
   a phase, how many tool calls and which tools, when it started and when it last did something. Never a word Claude wrote or read - the same rule as
   last-tick.json. The board reads it (the student board from the state folder; the website from the status file, which gains `steps` when a run ends). */

const ID = '0123456789abcdef0123456789abcdef'
// Built from pieces so this file is not itself a thing a secret scanner stops on.
const SECRET = ['sk', 'ant', 'SECRET-progress-must-never-carry-this-9876543210'].join('-')
const iso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z')

async function withState(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mailbox-progress-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const fileOf = (dir) => join(dir, PROGRESS.folder, `${ID}.json`)
const read = async (dir) => JSON.parse(await readFile(fileOf(dir), 'utf8'))

function clock(start = T0) {
  const state = { at: start }
  return { now: () => state.at, move: (ms) => { state.at += ms } }
}

/* ---------- runClaude tells the caller how far it is -------------------------------------------------------------- */

const line = (event) => `${JSON.stringify(event)}\n`
const INIT = { type: 'system', subtype: 'init', tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'], mcp_servers: [] }
const RESULT = { type: 'result', subtype: 'success', is_error: false, result: `I read ${SECRET} and it says hello`, permission_denials: [] }
// A tool call whose INPUT is secret-looking text, and an assistant sentence, and a tool result that echoes a file: none of it may leave runClaude.
const call = (name, input = {}) => ({ type: 'assistant', message: { content: [{ type: 'text', text: `Thinking about ${SECRET}` }, { type: 'tool_use', name, input }] } })
const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', content: `file contents: ${SECRET}` }] } }

async function runWith(lines, change = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mailbox-progress-run-'))
  try {
    const spawn = () => {
      const child = new EventEmitter()
      child.pid = 4242
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      setImmediate(() => {
        for (const text of lines) child.stdout.write(typeof text === 'string' ? text : line(text))
        child.stdout.end()
        child.stderr.end()
        setImmediate(() => child.emit('close', 0, null))
      })
      return child
    }
    const events = []
    const result = await runClaude({
      file: '/fake/bin/claude', argv: ['-p', 'x'], cwd: dir, env: {}, timeoutMs: 5000,
      transcriptPath: join(dir, 'transcript.jsonl'), stderrPath: join(dir, 'stderr.txt'), spawn, platform: 'linux',
      onEvent: (event) => events.push(event), ...change
    })
    return { events, result }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('runClaude reports started, each tool call by name, and finishing - and nothing else', async () => {
  const { events, result } = await runWith([INIT, call('Read', { file_path: `/tmp/${SECRET}` }), toolResult, call('Edit', { old_string: SECRET }), call('Read'), RESULT])
  assert.equal(result.ok, true)
  assert.deepEqual(events, [{ type: 'started' }, { type: 'tool', name: 'Read' }, { type: 'tool', name: 'Edit' }, { type: 'tool', name: 'Read' }, { type: 'finishing' }])
  assert.ok(!JSON.stringify(events).includes('SECRET'), 'no text of what Claude wrote, read or was given leaves the stream reader')
})

test('a tool outside the list is not reported as a call, a line that is not JSON is skipped, and an onEvent that throws does not stop the run', async () => {
  const refused = await runWith([INIT, call('Read'), call('Bash', { command: SECRET }), RESULT])
  assert.equal(refused.result.why, 'tool-refused')
  assert.deepEqual(refused.events.filter((event) => event.type === 'tool'), [{ type: 'tool', name: 'Read' }])
  const messy = await runWith([INIT, 'this is not json\n', '{"type": "assistant", "message": \n', '\n', call('Grep'), RESULT])
  assert.equal(messy.result.ok, true)
  assert.deepEqual(messy.events.map((event) => event.type), ['started', 'tool', 'finishing'])
  const throwing = await runWith([INIT, call('Read'), RESULT], { onEvent: () => { throw new Error(SECRET) } })
  assert.equal(throwing.result.ok, true, 'progress is best effort: it can never fail a run')
})

test('with no onEvent, runClaude answers exactly as it did before', async () => {
  const withIt = await runWith([INIT, call('Read'), call('Edit'), RESULT])
  const without = await runWith([INIT, call('Read'), call('Edit'), RESULT], { onEvent: undefined })
  assert.deepEqual(without.result, withIt.result)
  assert.deepEqual(without.result.calls, { Read: 1, Edit: 1 })
})

/* ---------- the progress file ------------------------------------------------------------------------------------- */

test('the file says phase, step count, calls by tool, last tool, start and last-event times - and is private', () => withState(async (dir) => {
  const c = clock()
  const progress = createProgress({ stateDir: dir, id: ID, now: c.now })
  progress.onEvent({ type: 'started' })
  await progress.settled()
  assert.deepEqual(await read(dir), { schema: PROGRESS.schema, id: ID, phase: 'started', startedAt: iso(T0), lastEventAt: iso(T0), steps: 0, calls: {}, lastTool: null, final: false })
  c.move(2500)
  progress.onEvent({ type: 'tool', name: 'Read' })
  progress.onEvent({ type: 'tool', name: 'Read' })
  progress.onEvent({ type: 'tool', name: 'Edit' })
  await progress.settled()
  assert.deepEqual(await read(dir), { schema: PROGRESS.schema, id: ID, phase: 'working', startedAt: iso(T0), lastEventAt: iso(T0 + 2500), steps: 3, calls: { Read: 2, Edit: 1 }, lastTool: 'Edit', final: false })
  c.move(3000)
  progress.onEvent({ type: 'finishing' })
  await progress.finish({ ok: true })
  const done = await read(dir)
  assert.equal(done.phase, 'finishing')
  assert.equal(done.final, true)
  assert.equal(done.outcome, 'ok')
  assert.equal(done.steps, 3)
  if (process.platform !== 'win32') {
    assert.equal((await stat(fileOf(dir))).mode & 0o777, 0o600)
    assert.equal((await stat(join(dir, PROGRESS.folder))).mode & 0o777, 0o700)
  }
  assert.deepEqual((await readdir(join(dir, PROGRESS.folder))), [`${ID}.json`], 'no half-written file is left behind')
}))

test('it is written at most once every 2 seconds, the first event at once, and the last state always on finish', () => withState(async (dir) => {
  const c = clock()
  const progress = createProgress({ stateDir: dir, id: ID, now: c.now })
  progress.onEvent({ type: 'started' })
  await progress.settled()
  const writes = []
  const seen = async () => {
    await progress.settled()
    const body = await read(dir)
    if (body.steps !== (writes.at(-1) ?? 0)) writes.push(body.steps)
  }
  for (let n = 1; n <= 10; n += 1) {
    c.move(100)
    progress.onEvent({ type: 'tool', name: 'Grep' })
    await seen()
  }
  assert.deepEqual(writes, [], 'a second of events inside the window wrote nothing more')
  c.move(2000)
  progress.onEvent({ type: 'tool', name: 'Grep' })
  await seen()
  assert.deepEqual(writes, [11], 'once the window is over the next event writes everything so far')
  c.move(10)
  progress.onEvent({ type: 'tool', name: 'Grep' })
  await progress.finish({ ok: false })
  const last = await read(dir)
  assert.equal(last.steps, 12, 'the end always writes the true count')
  assert.equal(last.outcome, 'failed')
}))

test('no text ever reaches the file: an event carrying text, or a name that is text, is cut down to the fixed fields', () => withState(async (dir) => {
  const c = clock()
  const progress = createProgress({ stateDir: dir, id: ID, now: c.now })
  progress.onEvent({ type: 'started', text: SECRET })
  progress.onEvent({ type: 'tool', name: 'Read', input: { file_path: SECRET }, text: SECRET })
  progress.onEvent({ type: 'tool', name: `Read ${SECRET}` })
  progress.onEvent({ type: 'tool', name: 7 })
  progress.onEvent({ type: 'something-else', name: 'Edit', text: SECRET })
  progress.onEvent(null)
  progress.onEvent('a string')
  c.move(5000)
  await progress.finish({ ok: true })
  const text = await readFile(fileOf(dir), 'utf8')
  assert.ok(!text.includes('SECRET'))
  const body = JSON.parse(text)
  assert.deepEqual(body.calls, { Read: 1, unknown: 2 }, 'a name that is not a tool name is counted as unknown, not kept')
  assert.equal(body.steps, 3)
  assert.deepEqual(Object.keys(body).sort(), ['calls', 'final', 'id', 'lastEventAt', 'lastTool', 'outcome', 'phase', 'schema', 'startedAt', 'steps'])
}))

test('the file has a size cap: a hundred different tool names cannot make it big', () => withState(async (dir) => {
  const c = clock()
  const progress = createProgress({ stateDir: dir, id: ID, now: c.now })
  for (let n = 0; n < 100; n += 1) progress.onEvent({ type: 'tool', name: `Tool${n}` })
  c.move(5000)
  await progress.finish({ ok: true })
  const text = await readFile(fileOf(dir), 'utf8')
  assert.ok(Buffer.byteLength(text) <= PROGRESS.maxBytes, `${Buffer.byteLength(text)} bytes`)
  const body = JSON.parse(text)
  assert.ok(Object.keys(body.calls).length <= PROGRESS.maxTools + 1)
  assert.equal(body.steps, 100, 'the total is still true')
}))

test('an order id that is not 32 hex characters is refused: no path can be built from it', () => withState(async (dir) => {
  for (const bad of ['../x', '..\\x', 'a/b', '', ID.toUpperCase(), `${ID}0`, ID.slice(1), null, undefined, 7, `${ID}.json`, 'con']) {
    assert.throws(() => createProgress({ stateDir: dir, id: bad, now: Date.now }), TypeError, String(bad))
  }
  assert.deepEqual(await readdir(dir), [], 'nothing was made')
}))

test('a progress folder that is a link, or a file, is not written through', () => withState(async (dir) => {
  await writeFile(join(dir, PROGRESS.folder), 'a file where the folder should be')
  const progress = createProgress({ stateDir: dir, id: ID, now: Date.now })
  progress.onEvent({ type: 'started' })
  await progress.finish({ ok: true })
  assert.equal(await readFile(join(dir, PROGRESS.folder), 'utf8'), 'a file where the folder should be')
}))

/* ---------- a run that is cut short ------------------------------------------------------------------------------- */

test('a file left by a run that never finished is marked stale by the next tick, and old finished ones are removed', () => withState(async (dir) => {
  const c = clock()
  // A crash: the file stays as the last write left it (not final).
  const progress = createProgress({ stateDir: dir, id: ID, now: c.now })
  progress.onEvent({ type: 'started' })
  c.move(3000)
  progress.onEvent({ type: 'tool', name: 'Read' })
  await progress.settled()
  assert.equal((await read(dir)).final, false)

  const finishedId = 'f'.repeat(32)
  const old = createProgress({ stateDir: dir, id: finishedId, now: c.now })
  old.onEvent({ type: 'started' })
  await old.finish({ ok: true })
  const long = new Date((c.now() - (PROGRESS.keepSeconds + 60) * 1000))
  await utimes(join(dir, PROGRESS.folder, `${finishedId}.json`), long, long)
  await writeFile(join(dir, PROGRESS.folder, 'notes.txt'), 'x')
  await writeFile(join(dir, PROGRESS.folder, `${'e'.repeat(32)}.json`), 'not json')

  c.move(60_000)
  await settleLeftovers({ stateDir: dir, now: c.now() })
  const left = await read(dir)
  assert.equal(left.final, true)
  assert.equal(left.outcome, 'stale')
  assert.equal(left.steps, 1, 'what it had counted is kept')
  assert.equal(left.lastEventAt, iso(T0 + 3000), 'and when it was last heard from')
  assert.deepEqual((await readdir(join(dir, PROGRESS.folder))).sort(), [`${ID}.json`], 'the old one, the broken one and the stranger are gone')
}))

/* ---------- inside a tick ----------------------------------------------------------------------------------------- */

const progressOf = async (w, id) => JSON.parse(await readFile(join(w.places.stateDir, PROGRESS.folder, `${id}.json`), 'utf8'))

test('a run order leaves a final progress file with the true counts, and no text of the run is in it', async () => {
  const w = await mailboxWorld()
  try {
    const good = w.claude.good
    // The good run, with a secret-looking sentence and tool input added to its stream.
    w.claude.script = async (cwd, args, call) => {
      const events = await good(cwd, args, call)
      return [events[0], { type: 'assistant', message: { content: [{ type: 'text', text: SECRET }] } }, ...events.slice(1)]
    }
    const sent = w.send({ action: 'run', workflow: 'morning-intel' })
    const result = await runTick(w.ctx())
    assert.equal(result.state, 'done')
    const raw = await readFile(join(w.places.stateDir, PROGRESS.folder, `${sent.id}.json`), 'utf8')
    assert.ok(!raw.includes('SECRET'))
    const body = JSON.parse(raw)
    assert.equal(body.final, true)
    assert.equal(body.outcome, 'ok')
    assert.equal(body.phase, 'finishing')
    assert.equal(body.id, sent.id)
    const calls = (await w.claimFile(sent.id, 'final.json')).steps
    assert.equal(body.steps, calls, 'the file and the final word agree')
    assert.ok(calls > 0)
    assert.deepEqual(Object.values(body.calls).reduce((sum, count) => sum + count, 0), calls)
  } finally {
    await w.cleanup()
  }
})

test('a run that fails leaves a final progress file that says failed, and a Claude that crashes mid-run still leaves one', async () => {
  const w = await mailboxWorld()
  try {
    w.claude.script = async () => {
      throw new Error(`the program fell over with ${SECRET}`)
    }
    const sent = w.send({ action: 'run', workflow: 'morning-intel' })
    await runTick(w.ctx())
    const body = await progressOf(w, sent.id)
    assert.equal(body.final, true)
    assert.equal(body.outcome, 'failed')
    assert.ok(!JSON.stringify(body).includes('SECRET'))
  } finally {
    await w.cleanup()
  }
})

test('orders that are not runs write no progress file', async () => {
  const w = await mailboxWorld()
  try {
    w.send({ action: 'task', title: 'Chase the invoice', details: 'Ask.', for: 'research', model: 'sonnet' })
    await runTick(w.ctx())
    await assert.rejects(readdir(join(w.places.stateDir, PROGRESS.folder)))
  } finally {
    await w.cleanup()
  }
})

test('the status file gains steps for a run that ended, and only for that: a card order has the same entry as before', async () => {
  const w = await mailboxWorld()
  try {
    w.claude.script = w.claude.good
    const run = w.send({ action: 'run', workflow: 'morning-intel' })
    const card = w.send({ action: 'task', title: 'Chase the invoice', details: 'Ask.', for: 'research', model: 'sonnet' })
    await runTick(w.ctx())
    await runTick(w.ctx({ force: true }))
    const status = JSON.parse(await w.inOrigin.file('.agent-team/status/mailbox/mac-mini.json'))
    assert.deepEqual(checkMailbox(status, {}), [])
    const entry = (id) => status.orders.find((one) => one.id === id)
    assert.equal(entry(run.id).state, 'ok')
    assert.equal(entry(run.id).steps, (await w.claimFile(run.id, 'final.json')).steps)
    assert.ok(Number.isInteger(entry(run.id).steps) && entry(run.id).steps > 0)
    assert.ok(!('steps' in entry(card.id)), 'a card order has no steps key at all')
    assert.deepEqual(Object.keys(entry(card.id)), ['id', 'action', 'state', 'at', 'startedAt', 'finishedAt', 'commit', 'why', 'landed'], 'its keys are exactly the old ones, in the old order')
  } finally {
    await w.cleanup()
  }
})

test('a failed run says how many steps it took too', async () => {
  const w = await mailboxWorld()
  try {
    w.claude.script = async () => [w.INIT, w.tool('Read'), w.tool('Read'), { ...w.RESULT, is_error: true, subtype: 'error_during_execution' }]
    const sent = w.send({ action: 'run', workflow: 'morning-intel' })
    await runTick(w.ctx())
    const final = await w.claimFile(sent.id, 'final.json')
    assert.equal(final.state, 'failed')
    assert.equal(final.steps, 2)
    const status = JSON.parse(await w.inOrigin.file('.agent-team/status/mailbox/mac-mini.json'))
    assert.equal(status.orders.find((one) => one.id === sent.id).steps, 2)
    assert.deepEqual(checkMailbox(status, {}), [])
  } finally {
    await w.cleanup()
  }
})

/* ---------- the status contract ----------------------------------------------------------------------------------- */

test('steps is an optional whole number on an order that ended (ok or failed), and nowhere else', () => {
  const base = { id: ID, action: 'run', at: '2026-10-12T14:06:00Z', startedAt: '2026-10-12T14:05:00Z', finishedAt: '2026-10-12T14:06:00Z', commit: '3b717814fb34', why: null, landed: null }
  const file = (order) => ({ schema: 'agent-mailbox/v1', takenAt: '2026-10-12T14:12:00Z', computer: 'Mac Mini', runner: 'mac-mini', allows: { actions: ['run'], jobs: ['morning-intel'] }, orders: [order] })
  const problems = (order) => checkMailbox(file(order), {})
  assert.deepEqual(problems({ ...base, state: 'ok' }), [], 'without steps it is the old shape')
  assert.deepEqual(problems({ ...base, state: 'ok', steps: 14 }), [])
  assert.deepEqual(problems({ ...base, state: 'ok', steps: 0 }), [])
  assert.deepEqual(problems({ ...base, state: 'failed', commit: null, why: 'timed-out', finishedAt: '2026-10-12T14:06:00Z', steps: 80 }), [])
  for (const bad of [-1, 1.5, '14', null, 100001, NaN]) assert.ok(problems({ ...base, state: 'ok', steps: bad }).length > 0, String(bad))
  assert.ok(problems({ ...base, state: 'running', commit: null, finishedAt: null, steps: 3 }).length > 0, 'not while it is still running')
  assert.ok(problems({ ...base, state: 'claimed', startedAt: null, commit: null, finishedAt: null, steps: 3 }).length > 0)
  assert.ok(problems({ ...base, state: 'refused', commit: null, finishedAt: null, startedAt: null, why: 'expired', steps: 3 }).length > 0)
  assert.ok(MAILBOX_SHAPE.keys.orders.of.keys.steps, 'it is in the shape')
})


test('a signal that stops the runner mid-run marks the progress file final at once: the process may exit before anything else runs', async () => {
  const w = await mailboxWorld()
  try {
    const sent = w.send({ action: 'run', workflow: 'morning-intel' })
    const live = createLive()
    const handle = signalHandler(live, { kill: () => {}, release: releaseLock, exit: () => {} })
    let seenRightAfter = null
    w.claude.script = async () => {
      await handle('SIGTERM')
      seenRightAfter = await progressOf(w, sent.id)
      return []
    }
    await assert.rejects(runTick(w.ctx({ live })), /stopped by a signal/)
    assert.equal(seenRightAfter.final, true)
    assert.equal(seenRightAfter.outcome, 'failed')
  } finally {
    await w.cleanup()
  }
})

test('the next tick marks a progress file left by a dead runner stale, before it does anything else', async () => {
  const w = await mailboxWorld()
  try {
    await mkdir(join(w.places.stateDir, PROGRESS.folder), { recursive: true })
    const left = createProgress({ stateDir: w.places.stateDir, id: ID, now: w.clock.now })
    left.onEvent({ type: 'tool', name: 'Read' })
    await left.settled()
    await runTick(w.ctx())
    const body = await progressOf(w, ID)
    assert.equal(body.final, true)
    assert.equal(body.outcome, 'stale')
    assert.equal(body.steps, 1)
  } finally {
    await w.cleanup()
  }
})

test('the ledger keeps steps only for an order that ended', () => {
  const receipt = { action: 'run', at: iso(T0) }
  const final = (state) => ({ state, at: iso(T0), startedAt: iso(T0), finishedAt: iso(T0), commit: null, why: null, landed: null, steps: 5 })
  for (const state of ['ok', 'failed']) assert.equal(entryFromRecords(ID, receipt, final(state)).steps, 5)
  for (const state of ['refused', 'unknown']) assert.ok(!('steps' in entryFromRecords(ID, receipt, final(state))), state)
  for (const bad of [-1, 1.5, '5', null, 100001]) assert.ok(!('steps' in entryFromRecords(ID, receipt, { ...final('ok'), steps: bad })), String(bad))
})

