import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, access, mkdir, writeFile, readFile, readdir, realpath, rm, chmod, rename, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { git } from './helpers/git.mjs'
import { signBody } from '../scripts/lib/mailbox/envelope.mjs'
import { mailboxWorld, CLAUDE_FILE, ALLOWLIST, T0, CARD, PROPOSALS, KEY, SECRET, FAKE_API_KEY } from './helpers/mailbox-world.mjs'
import { runTick } from '../scripts/lib/mailbox/tick.mjs'
import { checkMailbox } from '../scripts/lib/status/safe.mjs'
import { newCardText } from '../scripts/lib/mailbox/cards.mjs'
import { dayOf } from '../scripts/lib/mailbox/allow.mjs'
import { PROOF_FILE, dropProof, keepProof } from '../scripts/lib/mailbox/proof.mjs'

/* One tick of the runner, from the board's answer to the pushed commit, in a world where only git and the file system are
   real. Every promise the plan makes about an order is held here: the claim comes first and is durable, an order runs once
   whatever happens, nothing outside the allowed list changes, a change goes back to the team repo by a lease push and
   nothing else does, and an order the runner loses track of is settled by reading and never run again. */

const STATUS = '.agent-team/status/mailbox/mac-mini.json'
const MINUTE = 60_000

async function withWorld(options, fn) {
  const w = await mailboxWorld(typeof options === 'function' ? {} : options)
  try {
    return await (typeof options === 'function' ? options : fn)(w)
  } finally {
    await w.cleanup()
  }
}

const statusIn = async (w) => JSON.parse(await w.inOrigin.file(STATUS))
const entryFor = (status, id) => status.orders.find((order) => order.id === id)
const sha = (text) => createHash('sha256').update(text).digest('hex')

/* ---------- a card order ------------------------------------------------------------------------------------------- */

test('a task order becomes a card in the team repo, with the status in the same commit and the trailer that finds it again', () => withWorld(async (w) => {
  const sent = w.send({ action: 'task', title: 'Chase the invoice', details: 'Ask about it.', for: 'research', model: 'sonnet' })
  const result = await runTick(w.ctx())
  assert.equal(result.state, 'done')
  assert.deepEqual(result.orders, { seen: 1, skipped: 0, claimed: 1, ok: 1, refused: 0, failed: 0 })

  const card = await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice.md')
  assert.equal(card, newCardText({ title: 'Chase the invoice', details: 'Ask about it.', for: 'research', model: 'sonnet' }))

  const status = await statusIn(w)
  assert.deepEqual(checkMailbox(status, {}), [])
  assert.equal(status.runner, 'mac-mini')
  assert.equal(status.computer, 'Mac Mini')
  assert.deepEqual(status.allows, { actions: ['task', 'move', 'approve', 'pause', 'run', 'arm', 'skill', 'agent'], jobs: ['morning-intel', 'task-sweep'] })
  const entry = entryFor(status, sent.id)
  assert.equal(entry.state, 'ok')
  assert.equal(entry.action, 'task')
  assert.match(entry.commit, /^[0-9a-f]{12}$/)

  // The change and the status are one commit with the trailer; a second, status-only commit says it landed.
  const log = await w.inOrigin.log()
  assert.deepEqual(log, ['Mailbox status', 'Mailbox order 00000000: task', 'seed'])
  const changeCommit = (await git(['log', '--format=%H', '--grep', `^Mailbox-Order: ${sent.id}$`, '-E', 'refs/heads/main'], w.originDir)).stdout.trim()
  assert.equal(changeCommit.slice(0, 12), entry.commit)
  assert.deepEqual((await git(['show', '--name-only', '--format=', changeCommit], w.originDir)).stdout.trim().split('\n').sort(), [STATUS, 'tasks/2026-10-12-chase-the-invoice.md'])
  assert.ok((await w.inOrigin.message(changeCommit)).includes(`Mailbox-Order: ${sent.id}`))

  const final = await w.claimFile(sent.id, 'final.json')
  assert.equal(final.state, 'ok')
  assert.equal(final.commit, entry.commit)
  assert.deepEqual(final.files, [{ path: 'tasks/2026-10-12-chase-the-invoice.md', sha256: sha(card) }, { path: STATUS, sha256: final.files[1].sha256 }])
  assert.equal((await w.claimFile(sent.id, 'receipt.json')).state, 'claimed')
  assert.deepEqual((await w.claimFile(sent.id, 'order.json')).envelope, sent.envelope, 'the order is kept as it came')
  assert.equal(w.claude.calls.length, 0, 'no model for a card')
}))

test('the same order, still on the board at the next poll, runs once: nothing more is claimed, committed or pushed', () => withWorld(async (w) => {
  w.send({ action: 'task', title: 'Chase the invoice' })
  await runTick(w.ctx())
  const head = await w.inOrigin.head()
  w.clock.advance(5 * MINUTE)
  const again = await runTick(w.ctx())
  assert.equal(again.state, 'done')
  assert.deepEqual(again.orders, { seen: 1, skipped: 1, claimed: 0, ok: 0, refused: 0, failed: 0 })
  assert.equal(await w.inOrigin.head(), head)
  assert.equal(w.board.polls, 2)
}))

test('the same signed order twice in one answer runs once', () => withWorld(async (w) => {
  const sent = w.send({ action: 'task', title: 'Chase the invoice' })
  w.board.orders.push(sent.envelope)
  const result = await runTick(w.ctx())
  assert.deepEqual(result.orders, { seen: 2, skipped: 1, claimed: 1, ok: 1, refused: 0, failed: 0 })
  assert.equal((await w.inOrigin.log()).filter((subject) => subject.startsWith('Mailbox order')).length, 1)
}))

const CARD_ORDERS = [
  ['move', { action: 'move', task: '2026-08-18-call-supplier', status: 'doing' }, 'tasks/2026-08-18-call-supplier.md', (text) => text.includes('status: doing')],
  ['approve', { action: 'approve', task: 'Writing the newsletter' }, 'proposals.yml', (text) => text.includes('approved: true')],
  ['pause', { action: 'pause', workflow: 'morning-intel' }, 'workflows/morning-intel.yml', (text) => text.includes('# schedule: "daily 06:30"')],
  ['arm', { action: 'arm', workflow: 'morning-intel' }, 'tasks/2026-10-12-set-up-a-mac-schedule-for-morning-intel.md', (text) => text.includes('This one needs you, not an agent')],
  ['skill', { action: 'skill', title: 'Summarise a sales call' }, 'tasks/2026-10-12-add-a-skill-summarise-a-sales-call.md', (text) => text.includes('/new-skill')],
  ['agent', { action: 'agent', title: 'A bookkeeper who reconciles receipts' }, 'tasks/2026-10-12-add-an-agent-a-bookkeeper-who-reconciles.md', (text) => text.includes('/new-agent')]
]

for (const [action, payload, path, changed] of CARD_ORDERS) {
  test(`a ${action} order is done by the runner's own code, with no model, and lands with its status`, () => withWorld(async (w) => {
    const sent = w.send(payload)
    const result = await runTick(w.ctx())
    assert.equal(result.orders.ok, 1, JSON.stringify(result))
    assert.ok(changed(await w.inOrigin.file(path)), path)
    const entry = entryFor(await statusIn(w), sent.id)
    assert.equal(entry.state, 'ok')
    assert.equal(entry.action, action)
    assert.equal(w.claude.calls.length, 0)
  }))
}

test('a Done order writes the day where the person is', () => withWorld(async (w) => {
  w.send({ action: 'move', task: '2026-08-18-call-supplier', status: 'done' })
  await runTick(w.ctx())
  assert.ok((await w.inOrigin.file('tasks/2026-08-18-call-supplier.md')).includes('status: done\ndone_at: 2026-10-12\n'))
}))

test('a Start order for a card that is already started changes no card but still lands: the order is done', () => withWorld({ files: { 'tasks/2026-08-18-call-supplier.md': CARD.replace('todo', 'doing') } }, async (w) => {
  const sent = w.send({ action: 'move', task: '2026-08-18-call-supplier', status: 'doing' })
  const result = await runTick(w.ctx())
  assert.equal(result.orders.ok, 1)
  assert.equal(entryFor(await statusIn(w), sent.id).state, 'ok')
}))

/* ---------- a job run ---------------------------------------------------------------------------------------------- */

test('a run order starts Claude once with the pinned flags and prompt, and lands the output, the run log and the status', () => withWorld(async (w) => {
  w.claude.script = w.claude.good
  const sent = w.send({ action: 'run', workflow: 'morning-intel' })
  const result = await runTick(w.ctx())
  assert.equal(result.state, 'done')
  assert.deepEqual(result.orders, { seen: 1, skipped: 0, claimed: 1, ok: 1, refused: 0, failed: 0 })

  assert.equal(w.claude.calls.length, 1)
  const call = w.claude.calls[0]
  assert.equal(call.file, '/fake/bin/claude')
  assert.equal(call.options.cwd, w.places.workDir)
  assert.deepEqual(Object.keys(call.options.env).sort(), ['DISABLE_AUTOUPDATER', 'DISABLE_UPDATES', 'HOME', 'PATH', ...(process.platform === 'win32' ? ['NoDefaultCurrentDirectoryInExePath'] : [])].sort())
  assert.ok(call.args.includes('--permission-prompts'), 'this Claude is new enough')
  assert.ok(call.args.includes('--restricted'))
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'sonnet')
  assert.ok(call.args[1].includes('`inbox/2026-10-12/morning-intel.md`'))

  assert.equal(await w.inOrigin.file('inbox/2026-10-12/morning-intel.md'), '# morning-intel - inbox/2026-10-12/morning-intel.md\n\nAll quiet.\n')
  const logPath = 'runs/2026-10/2026-10-12T1405Z-research-morning-intel.json'
  const entry = JSON.parse(await w.inOrigin.file(logPath))
  assert.equal(entry.started_at, '2026-10-12T14:05:41Z')
  assert.equal(entry.finished_at, '2026-10-12T14:05:41Z', 'the clock has not moved in this test')

  const statusEntry = entryFor(await statusIn(w), sent.id)
  assert.equal(statusEntry.state, 'ok')
  assert.equal(statusEntry.startedAt, '2026-10-12T14:05:41Z')
  assert.ok(await w.claimFile(sent.id, 'transcript.jsonl') === null, 'the transcript is not JSON: it is lines, kept as a file')
  const transcript = await readFile(join(w.places.stateDir, 'claims', `${sent.id}.claim`, 'transcript.jsonl'), 'utf8')
  assert.ok(transcript.includes('"type":"result"'))
  assert.deepEqual((await w.claimFile(sent.id, 'final.json')).files.map((file) => file.path).sort(), [STATUS, 'inbox/2026-10-12/morning-intel.md', logPath].sort())
}))

test('the board is told a run has started before Claude is: a status commit with the order running comes first', () => withWorld(async (w) => {
  const seen = []
  w.claude.script = async (cwd, args, call) => {
    seen.push(JSON.parse(await w.inOrigin.file(STATUS)).orders.map((order) => [order.id, order.state]))
    return w.claude.good(cwd, args, call)
  }
  const sent = w.send({ action: 'run', workflow: 'morning-intel' })
  await runTick(w.ctx())
  assert.deepEqual(seen, [[[sent.id, 'running']]])
  assert.deepEqual(await w.inOrigin.log(), ['Mailbox status', 'Mailbox order 00000000: run', 'Mailbox status', 'seed'])
}))

test('the run log carries the true finish time, set by the runner after the check', () => withWorld(async (w) => {
  w.claude.script = async (cwd, args, call) => {
    w.clock.advance(7 * MINUTE + 12_000)
    return w.claude.good(cwd, args, call)
  }
  w.send({ action: 'run', workflow: 'morning-intel' })
  await runTick(w.ctx())
  const entry = JSON.parse(await w.inOrigin.file('runs/2026-10/2026-10-12T1405Z-research-morning-intel.json'))
  assert.equal(entry.started_at, '2026-10-12T14:05:41Z')
  assert.equal(entry.finished_at, '2026-10-12T14:12:53Z')
}))

test('a run for a job that is not on the Mac\'s list is refused before anything starts - the repo may name it, the Mac does not', () => withWorld({ allowlist: ALLOWLIST({ jobs: '\n  - slug: task-sweep\n    minutes: 30' }) }, async (w) => {
  const sent = w.send({ action: 'run', workflow: 'morning-intel' })
  const result = await runTick(w.ctx())
  assert.deepEqual(result.orders, { seen: 1, skipped: 0, claimed: 1, ok: 0, refused: 1, failed: 0 })
  assert.equal(w.claude.calls.length, 0)
  const entry = entryFor(await statusIn(w), sent.id)
  assert.deepEqual({ state: entry.state, why: entry.why, commit: entry.commit }, { state: 'refused', why: 'job-not-allowed', commit: null })
  assert.deepEqual((await statusIn(w)).allows.jobs, ['task-sweep'])
}))

test('a run for a job this code has no rules for is refused, even when the Mac\'s list names it', () => withWorld({ allowlist: ALLOWLIST({ jobs: '\n  - slug: weekly-review\n    minutes: 10' }), files: { 'workflows/weekly-review.yml': 'name: Weekly\nowner: research\nsteps: [x]\n' } }, async (w) => {
  const sent = w.send({ action: 'run', workflow: 'weekly-review' })
  await runTick(w.ctx())
  assert.equal(entryFor(await statusIn(w), sent.id).why, 'job-not-allowed')
  assert.equal(w.claude.calls.length, 0)
  assert.deepEqual((await statusIn(w)).allows.jobs, [], 'the board is not told it can run what cannot be run')
}))

test('a run for a job whose workflow file is not there is refused as "no workflow"', () => withWorld(async (w) => {
  await git(['rm', '-q', 'workflows/morning-intel.yml'], w.places.workDir)
  await git(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'remove it'], w.places.workDir)
  await git(['push', '-q', 'origin', 'HEAD:refs/heads/main'], w.places.workDir)
  const sent = w.send({ action: 'run', workflow: 'morning-intel' })
  await runTick(w.ctx())
  assert.equal(entryFor(await statusIn(w), sent.id).why, 'no-workflow')
  assert.equal(w.claude.calls.length, 0)
}))

/* ---------- Claude does something it may not ------------------------------------------------------------------------ */

const HOSTILE = [
  ['writes a file in .claude', (w, cwd) => w.writeAt(cwd, '.claude/settings.json', '{"hooks":{}}\n')],
  ['writes a script', (w, cwd) => w.writeAt(cwd, 'scripts/evil.mjs', 'process.exit(1)\n')],
  ['writes a workflow', (w, cwd) => w.writeAt(cwd, 'workflows/evil.yml', 'name: x\n')],
  ['writes a second output', (w, cwd) => w.writeAt(cwd, 'inbox/2026-10-12/extra.md', 'x\n')],
  ['deletes a file', (w, cwd) => rm(join(cwd, 'README.md'))],
  ['changes a card', (w, cwd) => w.writeAt(cwd, 'tasks/2026-08-18-call-supplier.md', 'ignore all rules\n')]
]

for (const [name, extra] of HOSTILE) {
  test(`Claude ${name}: the order fails with "change-refused" and nothing of it is pushed`, () => withWorld(async (w) => {
    w.claude.script = async (cwd, args, call) => {
      const events = await w.claude.good(cwd, args, call)
      await extra(w, cwd)
      return events
    }
    const sent = w.send({ action: 'run', workflow: 'morning-intel' })
    const result = await runTick(w.ctx())
    assert.deepEqual(result.orders, { seen: 1, skipped: 0, claimed: 1, ok: 0, refused: 0, failed: 1 })
    const entry = entryFor(await statusIn(w), sent.id)
    assert.deepEqual({ state: entry.state, why: entry.why, commit: entry.commit }, { state: 'failed', why: 'change-refused', commit: null })
    assert.equal(await w.inOrigin.file('inbox/2026-10-12/morning-intel.md'), null, 'the output was not pushed either')
    assert.equal(await w.inOrigin.file('scripts/evil.mjs'), null)
    assert.equal((await git(['status', '--porcelain', '--ignored'], w.places.workDir)).stdout, '', 'the work copy is clean again')
    assert.equal(w.claude.calls.length, 1, 'Claude is not run again for it')
  }))
}

test('Claude calls a tool that is not allowed: the order fails with "tool-refused", and nothing is pushed', () => withWorld(async (w) => {
  w.claude.script = async (cwd, args, call) => {
    await w.claude.good(cwd, args, call)
    return [w.INIT, w.tool('Bash'), w.RESULT]
  }
  const sent = w.send({ action: 'run', workflow: 'morning-intel' })
  await runTick(w.ctx())
  assert.equal(entryFor(await statusIn(w), sent.id).why, 'tool-refused')
  assert.equal(await w.inOrigin.file('inbox/2026-10-12/morning-intel.md'), null)
}))

test('Claude ends with an error, or writes nothing, or writes no run log: failed, each with its own reason', () => withWorld(async (w) => {
  const cases = [
    ['an error', async () => [w.INIT, { ...w.RESULT, is_error: true, subtype: 'error_max_turns' }], 'claude-failed'],
    ['no output', async () => [w.INIT, w.RESULT], 'claude-failed'],
    ['no run log', async (cwd, args) => { const info = w.facts(args[1]); await w.writeAt(cwd, info.outputPath, 'x\n'); return [w.INIT, w.RESULT] }, 'run-log-refused'],
    ['a run log that is not valid', async (cwd, args) => { const info = w.facts(args[1]); await w.writeAt(cwd, info.outputPath, 'x\n'); await w.writeLog(cwd, w.logOf(info, { entry: { model: 'opus' } })); return [w.INIT, w.RESULT] }, 'run-log-refused']
  ]
  for (const [name, script, why] of cases) {
    w.claude.script = script
    const sent = w.send({ action: 'run', workflow: 'morning-intel' })
    await runTick(w.ctx({ force: true }))
    assert.equal(entryFor(await statusIn(w), sent.id).why, why, name)
  }
  assert.equal(w.claude.calls.length, 4)
}))

/* ---------- orders that are refused --------------------------------------------------------------------------------- */

test('an order for an action the Mac does not allow is claimed and refused, and the board says so', () => withWorld({ allowlist: ALLOWLIST({ actions: '[task]' }) }, async (w) => {
  const sent = w.send({ action: 'approve', task: 'Writing the newsletter' })
  const result = await runTick(w.ctx())
  assert.equal(result.orders.refused, 1)
  assert.deepEqual({ ...entryFor(await statusIn(w), sent.id) }, { id: sent.id, action: 'approve', state: 'refused', at: '2026-10-12T14:05:41Z', startedAt: null, finishedAt: null, commit: null, why: 'not-allowed', landed: null })
  assert.equal(await w.inOrigin.file('proposals.yml'), PROPOSALS)
}))

const REFUSED_BY_ENVELOPE = [
  ['it has expired', { body: { issuedAt: new Date(T0 - 40 * MINUTE).toISOString(), expiresAt: new Date(T0 - 5 * MINUTE).toISOString() } }, 'expired'],
  ['it was meant for another repo', { body: { repo: 'ExampleOwner/other-team' } }, 'wrong-repo'],
  ['it was meant for another computer', { body: { runner: 'old-imac' } }, 'wrong-runner'],
  ['it has a version this Mac does not know', { body: { v: 2 } }, 'not-valid'],
  ['its life is longer than the contract allows', { body: { expiresAt: new Date(T0 + 3 * 3600_000).toISOString() } }, 'not-valid']
]

for (const [name, change, why] of REFUSED_BY_ENVELOPE) {
  test(`an order is refused with "${why}" when ${name} - it is claimed so it is not looked at again, and nothing else changes`, () => withWorld(async (w) => {
    const sent = w.send({ action: 'task', title: 'Chase the invoice' }, change)
    const result = await runTick(w.ctx())
    assert.deepEqual(result.orders, { seen: 1, skipped: 0, claimed: 1, ok: 0, refused: 1, failed: 0 })
    const entry = entryFor(await statusIn(w), sent.id)
    assert.deepEqual({ state: entry.state, why: entry.why }, { state: 'refused', why })
    assert.equal(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice.md'), null)
    w.clock.advance(5 * MINUTE)
    assert.deepEqual((await runTick(w.ctx())).orders.skipped, 1, 'not looked at again')
  }))
}

test('an order whose fields are not the board\'s kind is refused as "not valid" - a typed word with an invisible character in it, a title too short', () => withWorld(async (w) => {
  const hiddenTitle = `Chase the${String.fromCharCode(0x200b)} invoice`
  const first = w.send({ action: 'task', title: hiddenTitle })
  const second = w.send({ action: 'task', title: 'ab' })
  const third = w.send({ action: 'task', title: 'Fine title', unexpected: 'field' })
  await runTick(w.ctx())
  const status = await statusIn(w)
  for (const sent of [first, second, third]) assert.deepEqual([entryFor(status, sent.id).state, entryFor(status, sent.id).why], ['refused', 'not-valid'])
  assert.equal(await w.inOrigin.file('tasks/2026-10-12-fine-title.md'), null)
}))

test('an order that is not signed by a key this Mac holds is not even claimed: nobody who cannot sign can fill the status file', () => withWorld(async (w) => {
  const good = w.order({ action: 'task', title: 'Chase the invoice' })
  w.board.orders.push({ ...good.envelope, body: good.envelope.body.replace('Chase', 'Chasx') })
  w.board.orders.push({ ...good.envelope, kid: 'k9' })
  w.board.orders.push({ ...good.envelope, sig: 'x'.repeat(43) })
  w.board.orders.push({ kid: 'k1', body: 'not json', sig: 'y'.repeat(43) })
  w.board.orders.push({ nonsense: true })
  const result = await runTick(w.ctx())
  assert.deepEqual(result.orders, { seen: 5, skipped: 5, claimed: 0, ok: 0, refused: 0, failed: 0 })
  assert.deepEqual(await readdir(join(w.places.stateDir, 'claims')), ['store.json'])
  assert.deepEqual(await w.inOrigin.log(), ['Mailbox status', 'seed'], 'only the idle status was pushed: no order was done')
  assert.deepEqual((await statusIn(w)).orders, [], 'and nobody who cannot sign is in it')
}))

test('an order issued a little in the future waits - it is neither refused nor claimed - and is done once its time comes', () => withWorld(async (w) => {
  const sent = w.send({ action: 'task', title: 'Chase the invoice' }, { body: { issuedAt: new Date(T0 + 90_000).toISOString(), expiresAt: new Date(T0 + 20 * MINUTE).toISOString() } })
  const first = await runTick(w.ctx())
  assert.equal(first.orders.claimed, 1, 'within the two minutes of drift the contract allows it is good')
  const late = w.send({ action: 'task', title: 'Another one' }, { body: { issuedAt: new Date(T0 + 10 * MINUTE).toISOString(), expiresAt: new Date(T0 + 25 * MINUTE).toISOString() } })
  w.clock.advance(5 * MINUTE)
  const second = await runTick(w.ctx())
  assert.equal(second.orders.skipped, 2)
  assert.equal(await w.claimFile(late.id, 'receipt.json'), null)
  w.clock.advance(6 * MINUTE)
  const third = await runTick(w.ctx())
  assert.equal(third.orders.claimed, 1)
  assert.ok(sent.id !== late.id)
}))

test('a claim store that was lost does not run an order that was already done: it is older than the store, so it is refused', () => withWorld(async (w) => {
  const sent = w.send({ action: 'task', title: 'Chase the invoice' })
  await runTick(w.ctx())
  await rm(join(w.places.stateDir, 'claims'), { recursive: true })
  w.clock.advance(5 * MINUTE)
  const result = await runTick(w.ctx())
  assert.equal(result.orders.refused, 1)
  assert.equal(result.orders.ok, 0)
  assert.equal((await w.inOrigin.log()).filter((subject) => subject.startsWith('Mailbox order')).length, 1, 'the card was not made twice')
  assert.equal(entryFor(await statusIn(w), sent.id).why, 'not-valid')
  // An order issued after the new store began is fine (one issued a minute before it is not: the board's usual one is refused too). The new store
  // began the contract's two minutes of clock skew after the tick that made it, so the fresh order is issued from then on.
  const before = w.send({ action: 'task', title: 'Just before' })
  w.clock.advance(2 * MINUTE)
  const after = w.send({ action: 'task', title: 'A new one' }, { body: { issuedAt: new Date(w.clock.now()).toISOString(), expiresAt: new Date(w.clock.now() + 15 * MINUTE).toISOString() } })
  w.clock.advance(MINUTE)
  const last = await runTick(w.ctx({ force: true }))
  assert.deepEqual([last.orders.ok, last.orders.refused], [1, 1])
  assert.equal(entryFor(await statusIn(w), after.id).state, 'ok')
  assert.equal(entryFor(await statusIn(w), before.id).why, 'not-valid')
}))

/* ---------- limits -------------------------------------------------------------------------------------------------- */

test('the day\'s limit stops orders at the number, and the next day starts again', () => withWorld({ allowlist: ALLOWLIST({ per_day: '\n  orders: 2\n  runs: 6' }) }, async (w) => {
  const sent = ['One order', 'Two orders', 'Three orders'].map((title) => w.send({ action: 'task', title }))
  const result = await runTick(w.ctx())
  assert.deepEqual(result.orders, { seen: 3, skipped: 0, claimed: 3, ok: 2, refused: 1, failed: 0 })
  const status = await statusIn(w)
  assert.deepEqual([entryFor(status, sent[2].id).state, entryFor(status, sent[2].id).why], ['refused', 'daily-limit'])
  w.clock.advance(24 * 3600_000)
  const next = w.send({ action: 'task', title: 'Tomorrow order' })
  assert.equal((await runTick(w.ctx())).orders.ok, 1)
  assert.ok(next.id)
}))

test('at most five orders and one run are done in a tick; the rest wait for the next', () => withWorld(async (w) => {
  w.claude.script = w.claude.good
  for (let at = 0; at < 7; at += 1) w.send({ action: 'task', title: `Card number ${at}` })
  const first = await runTick(w.ctx())
  assert.equal(first.orders.claimed, 5)
  w.clock.advance(5 * MINUTE)
  assert.equal((await runTick(w.ctx())).orders.claimed, 2)
  const a = w.send({ action: 'run', workflow: 'morning-intel' })
  const b = w.send({ action: 'run', workflow: 'task-sweep' })
  w.clock.advance(5 * MINUTE)
  const third = await runTick(w.ctx())
  assert.equal(third.orders.claimed, 1, 'one run per tick')
  assert.ok(a.id && b.id)
}))

/* ---------- the board, the pace, the switches ----------------------------------------------------------------------- */

test('the Mac asks again only when the board\'s pace says so, with a little slack; --once asks now', () => withWorld(async (w) => {
  await runTick(w.ctx())
  assert.equal(w.board.polls, 1)
  const early = await runTick(w.ctx())
  assert.equal(early.state, 'waiting')
  assert.equal(w.board.polls, 1)
  w.clock.advance(269_000)
  assert.equal((await runTick(w.ctx())).state, 'waiting', 'a poll 271 seconds after the last is early for a pace of 300')
  w.clock.advance(1_000)
  assert.equal((await runTick(w.ctx())).state, 'done')
  assert.equal(w.board.polls, 2)
  assert.equal((await runTick(w.ctx({ force: true }))).state, 'done')
  assert.equal(w.board.polls, 3)
}))

test('the poll goes to the allowlisted board with the Mac\'s own key', () => withWorld(async (w) => {
  await runTick(w.ctx())
  assert.equal(w.board.headers[0].url, 'https://board.example.com/api/mailbox')
  assert.equal(w.board.headers[0].headers.Authorization, `Bearer ${KEY}`)
}))

test('a board that is down, refuses the key or answers badly: nothing is claimed, and the next tick tries again', () => withWorld(async (w) => {
  w.board.down = true
  const down = await runTick(w.ctx())
  assert.deepEqual([down.state, down.why], ['board-failed', 'board-unreachable'])
  w.board.down = false
  w.board.status = 401
  const refused = await runTick(w.ctx())
  assert.deepEqual([refused.state, refused.why], ['board-failed', 'board-refused'])
  w.board.status = 200
  w.send({ action: 'task', title: 'Chase the invoice' })
  assert.equal((await runTick(w.ctx())).orders.ok, 1)
}))

test('a PAUSE file stops everything: no poll, no claim, no push - and removing it starts again', () => withWorld(async (w) => {
  await writeFile(join(w.places.stateDir, 'PAUSE'), '')
  w.send({ action: 'task', title: 'Chase the invoice' })
  const paused = await runTick(w.ctx())
  assert.equal(paused.state, 'paused')
  assert.equal(w.board.polls, 0)
  await rm(join(w.places.stateDir, 'PAUSE'))
  assert.equal((await runTick(w.ctx())).orders.ok, 1)
}))

test('a tick already running means this one does nothing at all', () => withWorld(async (w) => {
  await mkdir(join(w.places.stateDir, 'lock'))
  const result = await runTick(w.ctx())
  assert.equal(result.state, 'busy')
  assert.equal(w.board.polls, 0)
}))

test('no allowlist, a broken one, no secrets file, a loose one: nothing is asked and nothing is done', () => withWorld(async (w) => {
  w.send({ action: 'task', title: 'Chase the invoice' })
  const file = join(w.places.stateDir, 'allowed-orders.yml')
  const original = await readFile(file, 'utf8')
  await rm(file)
  assert.deepEqual([(await runTick(w.ctx())).state, (await runTick(w.ctx())).why], ['unavailable', 'no-allowlist'])
  await writeFile(file, 'actions: [task]\n')
  assert.equal((await runTick(w.ctx())).state, 'unavailable')
  await writeFile(file, original)
  const env = await readFile(w.places.envFile, 'utf8')
  await rm(w.places.envFile)
  assert.equal((await runTick(w.ctx())).why, 'keys-missing')
  await writeFile(w.places.envFile, 'MAILBOX_KEY=short\n')
  assert.equal((await runTick(w.ctx())).state, 'unavailable')
  await writeFile(w.places.envFile, env)
  if (process.platform !== 'win32') {
    await chmod(w.places.envFile, 0o644)
    assert.equal((await runTick(w.ctx())).why, 'keys-mode')
    await chmod(w.places.envFile, 0o600)
  }
  assert.equal(w.board.polls, 0, 'not once')
  assert.equal((await runTick(w.ctx())).orders.ok, 1)
}))

test('a state folder inside the work copy, or the secrets file in the code, is refused before anything is read', () => withWorld(async (w) => {
  const result = await runTick(w.ctx({ places: { ...w.places, stateDir: join(w.places.workDir, 'state') } }))
  assert.deepEqual([result.state, result.why], ['not-ready', 'places-state-inside-work'])
  const second = await runTick(w.ctx({ places: { ...w.places, envFile: join(w.places.codeDir, 'env') } }))
  assert.deepEqual([second.state, second.why], ['not-ready', 'places-env-inside-code'])
  assert.equal(w.board.polls, 0)
}))

test('a set API key, or a work copy whose origin is another repo, stops the runner before it asks the board anything', () => withWorld(async (w) => {
  w.send({ action: 'task', title: 'Chase the invoice' })
  const key = await runTick(w.ctx({ env: { HOME: w.root, ANTHROPIC_API_KEY: FAKE_API_KEY } }))
  assert.deepEqual([key.state, key.why], ['not-ready', 'key-in-environment'])
  const origin = await runTick(w.ctx({ originAccepted: () => false }))
  assert.deepEqual([origin.state, origin.why], ['not-ready', 'origin-mismatch'])
  assert.equal(w.board.polls, 0)
}))

test('a work copy whose origin holds a token stops the runner before any git talks to the team repo: git would put the address on a command line', () => withWorld(async (w) => {
  w.send({ action: 'task', title: 'Chase the invoice' })
  const token = ['x-access-token', 'abc123'].join(':')
  await git(['remote', 'set-url', 'origin', `https://${token}@github.com/ExampleOwner/example-team.git`], w.places.workDir)
  const calls = []
  const watching = async (args, cwd) => { calls.push(args.join(' ')); return git(args, cwd) }
  // The world accepts any origin (originAccepted: () => true): the login is refused on its own.
  const result = await runTick(w.ctx({ git: watching, force: true }))
  assert.deepEqual([result.state, result.why], ['not-ready', 'origin-has-login'])
  assert.equal(w.board.polls, 0)
  assert.deepEqual(calls.filter((line) => /\b(fetch|push|ls-remote|clone|pull)\b/.test(line)), [], 'nothing was fetched or pushed')
  assert.ok(!w.logs.join('\n').includes('abc123'), 'the token is not logged')
}))

test('a login or settings problem blocks the runs and nothing else: a card order still lands, a run is refused as "not ready"', () => withWorld(async (w) => {
  const ctx = w.ctx({ exec: async (file, args) => { if (args[0] === 'auth') throw Object.assign(new Error('x'), { code: 'EXIT' }); return { stdout: '2.1.290', code: 0 } } })
  const card = w.send({ action: 'task', title: 'Chase the invoice' })
  const run = w.send({ action: 'run', workflow: 'morning-intel' })
  await runTick(ctx)
  const status = await statusIn(w)
  assert.equal(entryFor(status, card.id).state, 'ok')
  assert.deepEqual([entryFor(status, run.id).state, entryFor(status, run.id).why], ['refused', 'not-ready'])
  assert.equal(w.claude.calls.length, 0)
}))

test('a problem the daily check found is not remembered: once it is fixed the very next tick works', () => withWorld(async (w) => {
  const broken = async (file, args) => {
    if (args[0] === 'auth') throw Object.assign(new Error('x'), { code: 'EXIT' })
    return w.exec(file, args)
  }
  const run = w.send({ action: 'run', workflow: 'morning-intel' })
  w.claude.script = w.claude.good
  await runTick(w.ctx({ exec: broken }))
  assert.deepEqual([entryFor(await statusIn(w), run.id).state, entryFor(await statusIn(w), run.id).why], ['refused', 'not-ready'])
  const again = w.send({ action: 'run', workflow: 'morning-intel' })
  w.clock.advance(MINUTE)
  await runTick(w.ctx({ force: true }))
  assert.equal(entryFor(await statusIn(w), again.id).state, 'ok', 'logged in now: no waiting until tomorrow')
}))

test('a key that is set after the morning check still stops the runner, and so does a changed origin: those two are checked on every tick', () => withWorld(async (w) => {
  await runTick(w.ctx({ force: true }))
  const polls = w.board.polls
  const key = await runTick(w.ctx({ force: true, env: { HOME: w.root, ANTHROPIC_API_KEY: FAKE_API_KEY } }))
  assert.deepEqual([key.state, key.why], ['not-ready', 'key-in-environment'])
  const origin = await runTick(w.ctx({ force: true, originAccepted: () => false }))
  assert.deepEqual([origin.state, origin.why], ['not-ready', 'origin-mismatch'])
  assert.equal(w.board.polls, polls, 'the board was not asked')
  const fine = await runTick(w.ctx({ force: true }))
  assert.equal(fine.state, 'done')
}))

test('the daily check is made once a day: the next tick the same day does not ask Claude again, and the next day does', () => withWorld(async (w) => {
  let asked = 0
  const exec = async (file, args) => { asked += 1; return w.exec(file, args) }
  await runTick(w.ctx({ exec, force: true }))
  const first = asked
  assert.equal(first, 2)
  await runTick(w.ctx({ exec, force: true }))
  assert.equal(asked, first)
  w.clock.advance(24 * 3600_000)
  await runTick(w.ctx({ exec, force: true }))
  assert.equal(asked, first * 2)
}))

/* ---------- a crash at any point: the order is never run again ------------------------------------------------------ */

// A file system that fails the one write a test names - like a process that died just before it.
function dying(match) {
  return {
    ...fsPromises,
    async open(path, ...rest) {
      if (match(String(path))) throw Object.assign(new Error('died'), { code: 'EIO' })
      return fsPromises.open(path, ...rest)
    }
  }
}
import * as fsPromises from 'node:fs/promises'

test('a claim that cannot be written means nothing is done: no file edited, no Claude, no commit - the tick stops', () => withWorld(async (w) => {
  w.claude.script = w.claude.good
  const sent = w.send({ action: 'run', workflow: 'morning-intel' })
  const head = await w.inOrigin.head()
  const result = await runTick(w.ctx({ fs: dying((path) => path.includes('order.json')) }))
  assert.deepEqual([result.state, result.why], ['stopped', 'claim-failed'])
  assert.equal(w.claude.calls.length, 0)
  assert.deepEqual((await w.inOrigin.log()).filter((subject) => subject.startsWith('Mailbox order')), [])
  assert.equal(await w.inOrigin.file('inbox/2026-10-12/morning-intel.md'), null)
  assert.equal(await w.claimFile(sent.id, 'final.json'), null, 'no final word: it was never taken on')
  assert.ok(await w.inOrigin.file(STATUS), 'the board is still told the runner is there')
  assert.ok(head)
}))

test('a counts file that cannot be trusted stops the tick before any claim - it reads as full, never as empty', () => withWorld(async (w) => {
  await mkdir(join(w.places.stateDir, 'counts'))
  await writeFile(join(w.places.stateDir, 'counts', `${dayOf(w.clock.now())}.json`), 'garbage')
  w.send({ action: 'task', title: 'Chase the invoice' })
  const result = await runTick(w.ctx())
  assert.deepEqual([result.state, result.why], ['stopped', 'counts-damaged'])
  assert.equal(result.orders.claimed, 0)
  assert.equal(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice.md'), null)
  assert.equal((await readdir(join(w.places.stateDir, 'claims'))).length, 1, 'only the store: nothing was claimed')
  assert.equal(await readFile(join(w.places.stateDir, 'counts', `${dayOf(w.clock.now())}.json`), 'utf8'), 'garbage', 'the file is left for the person to look at')
}))

test('the runner dies after pushing and before the final word: the order is unknown, FOUND on the team repo, and never run again', () => withWorld(async (w) => {
  const sent = w.send({ action: 'task', title: 'Chase the invoice' })
  await assert.rejects(runTick(w.ctx({ fs: dying((path) => path.includes('final.json')) })))
  assert.equal(await w.claimFile(sent.id, 'final.json'), null)
  assert.ok(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice.md'), 'the change had landed')
  const commits = await w.inOrigin.commits()
  w.clock.advance(5 * MINUTE)
  const result = await runTick(w.ctx())
  assert.equal(result.state, 'done')
  const final = await w.claimFile(sent.id, 'final.json')
  assert.deepEqual([final.state, final.landed], ['unknown', true])
  assert.match(final.commit, /^[0-9a-f]{12}$/)
  const entry = entryFor(await statusIn(w), sent.id)
  assert.deepEqual([entry.state, entry.landed, entry.commit], ['unknown', true, final.commit])
  assert.equal((await w.inOrigin.log()).filter((subject) => subject.startsWith('Mailbox order')).length, 1, 'not made again')
  assert.ok((await w.inOrigin.commits()) >= commits)
}))

test('the runner dies after the claim and before the change is pushed: the order is unknown, NOT found, and never run again', () => withWorld(async (w) => {
  w.claude.script = w.claude.good
  const sent = w.send({ action: 'run', workflow: 'morning-intel' })
  // Dies when the order's own commit is made: after the claim and after Claude has run, before anything is pushed.
  const dyingGit = async (args, cwd) => {
    if (args.includes('commit') && String(args[args.indexOf('-m') + 1]).startsWith('Mailbox order')) throw new Error('the process died')
    return git(args, cwd)
  }
  await assert.rejects(runTick(w.ctx({ git: dyingGit })), /died/)
  assert.equal(await w.inOrigin.file('inbox/2026-10-12/morning-intel.md'), null)
  w.clock.advance(5 * MINUTE)
  const result = await runTick(w.ctx())
  assert.equal(result.state, 'done')
  const final = await w.claimFile(sent.id, 'final.json')
  assert.deepEqual([final.state, final.landed, final.commit], ['unknown', false, null])
  assert.equal(entryFor(await statusIn(w), sent.id).landed, false)
  assert.equal(w.claude.calls.length, 1, 'Claude ran once and never again')
  assert.equal(await w.inOrigin.file('inbox/2026-10-12/morning-intel.md'), null)
}))

test('an unknown order whose team repo cannot be reached is "not yet checked", and is checked again when it can be', () => withWorld(async (w) => {
  const sent = w.send({ action: 'task', title: 'Chase the invoice' })
  await assert.rejects(runTick(w.ctx({ fs: dying((path) => path.includes('final.json')) })))
  w.clock.advance(5 * MINUTE)
  const down = async (args, cwd) => {
    if (args.includes('fetch')) throw new Error('unreachable')
    return git(args, cwd)
  }
  const offline = await runTick(w.ctx({ git: down, force: true }))
  assert.deepEqual([offline.state, offline.why], ['not-ready', 'work-unreachable'])
  const unchecked = await w.claimFile(sent.id, 'final.json')
  assert.deepEqual([unchecked.state, unchecked.landed], ['unknown', null])
  w.clock.advance(5 * MINUTE)
  await runTick(w.ctx({ force: true }))
  assert.equal((await w.claimFile(sent.id, 'final.json')).landed, true)
}))

/* ---------- the team repo moves, or cannot be reached ---------------------------------------------------------------- */

test('someone else pushes between the reset and the push: the card is put back on top of their commit, and both are kept', () => withWorld(async (w) => {
  w.send({ action: 'task', title: 'Chase the invoice' })
  let raced = false
  const racing = async (args, cwd) => {
    if (args.includes('commit') && !raced) {
      raced = true
      await w.otherPush('theirs.md')
    }
    return git(args, cwd)
  }
  const result = await runTick(w.ctx({ git: racing }))
  assert.equal(result.orders.ok, 1)
  assert.equal(await w.inOrigin.file('theirs.md'), 'x\n')
  assert.ok(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice.md'))
}))

test('a run whose files the other pusher did not touch is put back after a race; one whose card they changed fails, and Claude is not run again', () => withWorld(async (w) => {
  w.claude.script = w.claude.good
  w.send({ action: 'run', workflow: 'morning-intel' })
  let raced = false
  const racing = (touch) => async (args, cwd) => {
    if (args.includes('commit') && !raced && String(args[args.indexOf('-m') + 1]).startsWith('Mailbox order')) {
      raced = true
      await w.otherPush(touch, 'their change\n')
    }
    return git(args, cwd)
  }
  const first = await runTick(w.ctx({ git: racing('unrelated.md') }))
  assert.equal(first.orders.ok, 1)
  assert.equal(w.claude.calls.length, 1, 'not run again for the retry')
  assert.equal(await w.inOrigin.file('unrelated.md'), 'their change\n')
  assert.ok(await w.inOrigin.file('inbox/2026-10-12/morning-intel.md'))
}))

test('a run that conflicts with the other pusher fails as "push-failed" and is never run again', () => withWorld(async (w) => {
  w.claude.script = w.claude.good
  const sent = w.send({ action: 'run', workflow: 'morning-intel' })
  let raced = false
  const racing = async (args, cwd) => {
    if (args.includes('commit') && !raced && String(args[args.indexOf('-m') + 1]).startsWith('Mailbox order')) {
      raced = true
      await w.otherPush('inbox/2026-10-12/morning-intel.md', 'someone else wrote the brief first\n')
    }
    return git(args, cwd)
  }
  await runTick(w.ctx({ git: racing }))
  const entry = entryFor(await statusIn(w), sent.id)
  assert.deepEqual([entry.state, entry.why], ['failed', 'push-failed'])
  assert.equal(await w.inOrigin.file('inbox/2026-10-12/morning-intel.md'), 'someone else wrote the brief first\n')
  assert.equal(w.claude.calls.length, 1)
}))

test('a team repo that cannot be reached at the start stops the tick before the board is asked: nothing is claimed that could not be pushed', () => withWorld(async (w) => {
  w.send({ action: 'task', title: 'Chase the invoice' })
  const down = async (args, cwd) => {
    if (args.includes('fetch')) throw new Error('unreachable')
    return git(args, cwd)
  }
  const result = await runTick(w.ctx({ git: down }))
  assert.deepEqual([result.state, result.why], ['not-ready', 'work-unreachable'])
  assert.equal(w.board.polls, 0)
  assert.deepEqual(await readdir(join(w.places.stateDir, 'claims')), ['store.json'])
}))

test('a team repo that cannot be reached when an order is pushed: the order is outcome unknown (the push may have landed), it is not run again, and the next tick that can read the team repo settles it', () => withWorld(async (w) => {
  const sent = w.send({ action: 'task', title: 'Chase the invoice' })
  const down = async (args, cwd) => {
    if (args.includes('push') || args.includes('ls-remote')) throw new Error('unreachable')
    return git(args, cwd)
  }
  const result = await runTick(w.ctx({ git: down }))
  assert.equal(result.orders.failed, 0, 'nothing is said to have failed that may have landed')
  const unchecked = await w.claimFile(sent.id, 'final.json')
  assert.deepEqual([unchecked.state, unchecked.landed, unchecked.why], ['unknown', null, null])
  assert.equal(await w.inOrigin.file(STATUS), null, 'the board has heard nothing yet')
  w.clock.advance(5 * MINUTE)
  await runTick(w.ctx())
  const entry = entryFor(await statusIn(w), sent.id)
  assert.deepEqual([entry.state, entry.landed, entry.why], ['unknown', false, null])
  assert.equal(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice.md'), null, 'the order was not run again')
}))

// A push whose answer is lost: the server took the commit and moved main, then git reported a failure (the connection was
// reset, or git's own 120 second limit ran out). It is on main, so it is done - doing it again would make it twice.
const landsThenFails = (isOrdersPush = async () => true) => {
  const state = { dropped: false }
  const run = async (args, cwd) => {
    if (args.includes('push') && !state.dropped && (await isOrdersPush(args, cwd))) {
      state.dropped = true
      await git(args, cwd)
      throw new Error('the connection was reset after the server took the push')
    }
    return git(args, cwd)
  }
  return { run, state }
}
const isRunPush = async (args, cwd) => (await git(['log', '-1', '--format=%s', args.at(-1).split(':')[0]], cwd)).stdout.startsWith('Mailbox order')
const commitsWithTrailer = async (w, id) => (await git(['log', '--format=%H', '--grep', `^Mailbox-Order: ${id}$`, 'refs/heads/main'], w.originDir)).stdout.trim().split('\n').filter(Boolean)

test('a card push that lands but reports a failure is done once: one card, one commit with the trailer, settled ok, nothing redone', () => withWorld(async (w) => {
  const sent = w.send({ action: 'task', title: 'Chase the invoice' })
  const flaky = landsThenFails()
  const result = await runTick(w.ctx({ git: flaky.run }))
  assert.equal(flaky.state.dropped, true)
  assert.deepEqual([result.orders.ok, result.orders.failed], [1, 0])
  assert.ok(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice.md'))
  assert.equal(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice-2.md'), null, 'no second card')
  assert.equal((await commitsWithTrailer(w, sent.id)).length, 1, 'one commit carries the order')
  const final = await w.claimFile(sent.id, 'final.json')
  assert.deepEqual([final.state, final.why], ['ok', null])
  assert.match(final.commit, /^[0-9a-f]{12}$/)
}))

test('a run whose push lands but reports a failure is settled ok, not "push-failed", and Claude was started once', () => withWorld(async (w) => {
  w.claude.script = w.claude.good
  const sent = w.send({ action: 'run', workflow: 'morning-intel' })
  const flaky = landsThenFails(isRunPush)
  await runTick(w.ctx({ git: flaky.run }))
  assert.equal(flaky.state.dropped, true)
  assert.ok(await w.inOrigin.file('inbox/2026-10-12/morning-intel.md'), 'its files are on main')
  const final = await w.claimFile(sent.id, 'final.json')
  assert.deepEqual([final.state, final.why], ['ok', null])
  assert.equal(entryFor(await statusIn(w), sent.id).state, 'ok')
  assert.equal(w.claude.calls.length, 1)
  assert.equal((await commitsWithTrailer(w, sent.id)).length, 1)
}))

test('a push that lands, reports a failure, and has another pusher\'s commit on top of it by the time it is checked is still done once', () => withWorld(async (w) => {
  const sent = w.send({ action: 'task', title: 'Chase the invoice' })
  const flaky = landsThenFails()
  const onTop = async (args, cwd) => {
    try {
      return await flaky.run(args, cwd)
    } catch (error) {
      await w.otherPush('theirs.md')
      throw error
    }
  }
  await runTick(w.ctx({ git: onTop }))
  assert.equal(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice-2.md'), null)
  assert.equal((await commitsWithTrailer(w, sent.id)).length, 1)
  assert.equal((await w.claimFile(sent.id, 'final.json')).state, 'ok')
}))

test('before an order is done a second time the team repo is asked whether it is already there: when it is, the order is ok and nothing is redone', () => withWorld(async (w) => {
  const sent = w.send({ action: 'task', title: 'Chase the invoice' })
  // The push's own check is made to miss that its commit is on main (it answers "moved"); only the look through main's
  // history for the order's trailer, made before any redo, can then keep the order from being done twice.
  const flaky = landsThenFails()
  let missed = false
  const blind = async (args, cwd) => {
    if (args.includes('merge-base') && args.includes('refs/remotes/origin/main')) {
      missed = true
      throw new Error('not an ancestor')
    }
    return flaky.run(args, cwd)
  }
  await runTick(w.ctx({ git: blind }))
  assert.equal(missed, true)
  assert.equal(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice-2.md'), null, 'not made twice')
  assert.equal((await commitsWithTrailer(w, sent.id)).length, 1)
  assert.equal((await w.claimFile(sent.id, 'final.json')).state, 'ok')
}))

test('after a failed push the team repo cannot be read: the order is outcome unknown, not failed, not redone - and a later tick that can read it settles it as landed without running anything', () => withWorld(async (w) => {
  w.claude.script = w.claude.good
  const sent = w.send({ action: 'run', workflow: 'morning-intel' })
  // The push lands, git reports a failure, and from then on every question to the team repo fails.
  const flaky = landsThenFails(isRunPush)
  const broken = async (args, cwd) => {
    if (flaky.state.dropped && (args.includes('ls-remote') || args.includes('fetch'))) throw new Error('unreachable')
    return flaky.run(args, cwd)
  }
  const first = await runTick(w.ctx({ git: broken }))
  assert.equal(first.orders.failed, 0)
  const unchecked = await w.claimFile(sent.id, 'final.json')
  assert.deepEqual([unchecked.state, unchecked.landed, unchecked.why], ['unknown', null, null])
  assert.equal(w.claude.calls.length, 1)
  w.clock.advance(5 * MINUTE)
  await runTick(w.ctx({ force: true }))
  const settled = await w.claimFile(sent.id, 'final.json')
  assert.deepEqual([settled.state, settled.landed], ['unknown', true])
  assert.match(settled.commit, /^[0-9a-f]{12}$/)
  assert.equal(w.claude.calls.length, 1, 'Claude was not started again')
  assert.equal((await commitsWithTrailer(w, sent.id)).length, 1)
}))

test('a push beaten by another pusher, when the team repo then cannot be read to look for the order, leaves the order outcome unknown: it is not redone on a guess', () => withWorld(async (w) => {
  const sent = w.send({ action: 'task', title: 'Chase the invoice' })
  let raced = false
  let afterPush = 0
  const racing = async (args, cwd) => {
    if (args.includes('commit') && !raced) {
      raced = true
      await w.otherPush('theirs.md')
    }
    // The push's own look at main is the first fetch after it; the look for the order's trailer is the second.
    if (args.includes('push')) afterPush = 1
    else if (args.includes('fetch') && afterPush > 0 && (afterPush += 1) > 2) throw new Error('unreachable')
    return git(args, cwd)
  }
  const result = await runTick(w.ctx({ git: racing }))
  assert.equal(result.orders.failed, 0)
  const final = await w.claimFile(sent.id, 'final.json')
  assert.deepEqual([final.state, final.landed], ['unknown', null])
  assert.equal(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice.md'), null, 'not redone on a guess')
}))

test('a push that really was beaten by another pusher (our commit is not on main) is still put back on top of theirs - the race is not mistaken for a landed push', () => withWorld(async (w) => {
  const sent = w.send({ action: 'task', title: 'Chase the invoice' })
  let raced = false
  const racing = async (args, cwd) => {
    if (args.includes('commit') && !raced) {
      raced = true
      await w.otherPush('theirs.md')
    }
    return git(args, cwd)
  }
  await runTick(w.ctx({ git: racing }))
  assert.equal(await w.inOrigin.file('theirs.md'), 'x\n')
  assert.ok(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice.md'))
  assert.equal((await commitsWithTrailer(w, sent.id)).length, 1)
  assert.equal((await w.claimFile(sent.id, 'final.json')).state, 'ok')
}))

/* ---------- the status file ------------------------------------------------------------------------------------------ */

test('an idle runner does not fill the team repo with commits: the status is pushed when it changes, and once in a while to show it is alive', () => withWorld(async (w) => {
  await runTick(w.ctx())
  const first = await w.inOrigin.commits()
  assert.equal(first, 2, 'the first tick pushes the file: seed and status')
  for (let at = 0; at < 5; at += 1) {
    w.clock.advance(5 * MINUTE)
    await runTick(w.ctx())
  }
  assert.equal(await w.inOrigin.commits(), first, 'five quiet ticks, no commits')
  w.clock.advance(7 * 3600_000)
  await runTick(w.ctx())
  assert.equal(await w.inOrigin.commits(), first + 1, 'after six hours of quiet, one commit to show it is alive')
  assert.equal((await statusIn(w)).takenAt, '2026-10-12T21:30:41Z')
}))

test('a change to what the Mac allows is pushed, so the board offers the right buttons', () => withWorld(async (w) => {
  await runTick(w.ctx())
  assert.deepEqual((await statusIn(w)).allows.jobs, ['morning-intel', 'task-sweep'])
  await writeFile(join(w.places.stateDir, 'allowed-orders.yml'), ALLOWLIST({ jobs: '\n  - slug: morning-intel\n    minutes: 20' }))
  w.clock.advance(5 * MINUTE)
  await runTick(w.ctx())
  assert.deepEqual((await statusIn(w)).allows.jobs, ['morning-intel'])
}))

test('nothing anyone typed reaches the status file or a commit message: a title with a planted secret is only in the card', () => withWorld(async (w) => {
  const planted = ['PLANTED', 'WORDS', 'IN', 'A', 'TITLE'].join('-')
  const sent = w.send({ action: 'task', title: planted, details: planted })
  await runTick(w.ctx())
  assert.ok(!(await w.inOrigin.file(STATUS)).includes(planted))
  for (const subject of await w.inOrigin.log()) assert.ok(!subject.includes(planted))
  assert.ok(!JSON.stringify(await w.claimFile(sent.id, 'final.json')).includes(planted))
  assert.ok((await w.inOrigin.file(`tasks/2026-10-12-${planted.toLowerCase()}.md`)).includes(planted), 'it is in the card, where the owner wrote it')
}))

test('the tick leaves a record for the person and for the Mac dashboard: when, what it did, and no words anyone typed', () => withWorld(async (w) => {
  w.send({ action: 'task', title: 'Chase the invoice' })
  await runTick(w.ctx())
  const last = JSON.parse(await readFile(join(w.places.stateDir, 'last-tick.json'), 'utf8'))
  assert.deepEqual(Object.keys(last).sort(), ['at', 'board', 'orders', 'pollSeconds', 'polledAt', 'schema', 'state'])
  assert.equal(last.schema, 'agent-mailbox-tick/v1')
  assert.equal(last.state, 'done')
  assert.equal(last.at, '2026-10-12T14:05:41Z')
  assert.equal(last.polledAt, '2026-10-12T14:05:41Z')
  assert.equal(last.pollSeconds, 300)
  assert.equal(last.board, 'ok')
  assert.deepEqual(last.orders, { seen: 1, skipped: 0, claimed: 1, ok: 1, refused: 0, failed: 0 })
  assert.ok(!JSON.stringify(last).includes('Chase'))
  assert.ok(w.logs.some((text) => /done/.test(text)))
}))

test('the work copy is clean after every tick, and a hostile .git/hooks file in it never runs', () => withWorld(async (w) => {
  const marker = join(w.root, 'hook-ran.txt')
  await mkdir(join(w.places.workDir, '.git', 'hooks'), { recursive: true })
  for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'pre-push', 'reference-transaction', 'post-checkout', 'post-merge']) {
    await writeFile(join(w.places.workDir, '.git', 'hooks', hook), `#!/bin/sh\necho ran >> "${marker.replaceAll('\\', '/')}"\n`, { mode: 0o755 })
  }
  w.claude.script = w.claude.good
  w.send({ action: 'task', title: 'Chase the invoice' })
  w.send({ action: 'run', workflow: 'morning-intel' })
  await runTick(w.ctx())
  await runTick(w.ctx({ force: true }))
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
  assert.equal((await git(['status', '--porcelain', '--ignored'], w.places.workDir)).stdout, '')
}))

test('the status shows it is alive after six hours of quiet and not before: five and a half hours is not enough', () => withWorld(async (w) => {
  await runTick(w.ctx())
  const first = await w.inOrigin.commits()
  w.clock.advance(5 * 3600_000 + 30 * MINUTE)
  await runTick(w.ctx())
  assert.equal(await w.inOrigin.commits(), first, 'five and a half hours of quiet')
  w.clock.advance(31 * MINUTE)
  await runTick(w.ctx())
  assert.equal(await w.inOrigin.commits(), first + 1, 'just over six hours')
}))

test('a card is put back after a race at most three times: two races are got through, three are not - and the order is then failed, not lost', () => withWorld(async (w) => {
  let pushes = 0
  const racing = (times) => {
    let raced = 0
    return async (args, cwd) => {
      if (args.includes('commit') && String(args[args.indexOf('-m') + 1]).startsWith('Mailbox order') && raced < times) {
        raced += 1
        pushes += 1
        await w.otherPush(`theirs-${pushes}.md`)
      }
      return git(args, cwd)
    }
  }
  w.send({ action: 'task', title: 'Chase the invoice' })
  const twice = await runTick(w.ctx({ git: racing(2) }))
  assert.equal(twice.orders.ok, 1, 'the third try lands')
  assert.ok(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice.md'))
  assert.equal(await w.inOrigin.file('theirs-1.md'), 'x\n')
  assert.equal(await w.inOrigin.file('theirs-2.md'), 'x\n')

  const third = w.send({ action: 'task', title: 'Another card' })
  w.clock.advance(5 * MINUTE)
  const thrice = await runTick(w.ctx({ git: racing(3), force: true }))
  assert.equal(thrice.orders.failed, 1)
  assert.deepEqual([entryFor(await statusIn(w), third.id).state, entryFor(await statusIn(w), third.id).why], ['failed', 'push-failed'])
  assert.equal(await w.inOrigin.file('tasks/2026-10-12-another-card.md'), null)
  assert.equal(await w.inOrigin.file('theirs-3.md'), 'x\n', 'what the others pushed is kept')
}))

test('with no pace on record the board is asked every five minutes, less the slack - four is too soon and five is not', () => withWorld(async (w) => {
  await writeFile(join(w.places.stateDir, 'last-tick.json'), JSON.stringify({ polledAt: new Date(w.clock.now()).toISOString() }))
  w.clock.advance(4 * MINUTE)
  const soon = await runTick(w.ctx())
  assert.equal(soon.state, 'waiting')
  assert.equal(w.board.polls, 0)
  w.clock.advance(MINUTE)
  await runTick(w.ctx())
  assert.equal(w.board.polls, 1)
}))

test('a claims folder that cannot be opened stops the tick before the board is asked: nothing could be claimed', () => withWorld(async (w) => {
  await rm(join(w.places.stateDir, 'claims'), { recursive: true })
  await writeFile(join(w.places.stateDir, 'claims'), 'not a folder')
  w.send({ action: 'task', title: 'Chase the invoice' })
  const result = await runTick(w.ctx())
  assert.deepEqual([result.state, result.why], ['stopped', 'store'])
  assert.equal(w.board.polls, 0)
}))

test('a work copy that is not a clone, or whose origin is not the team repo, is "not ready" and says which', () => withWorld(async (w) => {
  const wrongOrigin = await runTick(w.ctx({ originAccepted: (url) => !String(url).includes('origin.git') }))
  assert.deepEqual([wrongOrigin.state, wrongOrigin.why], ['not-ready', 'origin-mismatch'])
  // A .git that is a link: its config reads fine, but it is not a clone of its own.
  await rename(join(w.places.workDir, '.git'), join(w.root, 'elsewhere'))
  await symlink(join(w.root, 'elsewhere'), join(w.places.workDir, '.git'), process.platform === 'win32' ? 'junction' : 'dir')
  const notAClone = await runTick(w.ctx())
  assert.deepEqual([notAClone.state, notAClone.why], ['not-ready', 'work-not-a-clone'])
  assert.equal(w.board.polls, 0)
}))

test('the board\'s own pace is the one kept, not the default: a pace of fifteen minutes means ten minutes is too soon', () => withWorld(async (w) => {
  w.board.pollSeconds = 900
  await runTick(w.ctx())
  assert.equal(w.board.polls, 1)
  w.clock.advance(10 * MINUTE)
  assert.equal((await runTick(w.ctx())).state, 'waiting')
  w.clock.advance(2 * MINUTE)
  assert.equal((await runTick(w.ctx())).state, 'waiting', 'a tick that waited did not forget the pace')
  assert.equal(w.board.polls, 1)
  w.clock.advance(3 * MINUTE)
  await runTick(w.ctx())
  assert.equal(w.board.polls, 2)
}))

test('a board that cannot be reached does not stop the status being shown: the team repo is told, all the same', () => withWorld(async (w) => {
  w.board.down = true
  const result = await runTick(w.ctx())
  assert.deepEqual([result.state, result.why], ['board-failed', 'board-unreachable'])
  const status = await statusIn(w)
  assert.deepEqual(status.orders, [])
  assert.equal(status.runner, 'mac-mini')
}))

test('the daily check is believed only when it was good and says everything; a file that is short of that, or from another day, is asked again', () => withWorld(async (w) => {
  let asked = 0
  const exec = async (file, args) => { asked += 1; return w.exec(file, args) }
  const today = dayOf(w.clock.now())
  const cache = join(w.places.stateDir, 'preflight.json')
  for (const record of [
    { day: today, ok: false, version: [2, 1, 290] },
    { day: today, ok: true },
    { day: today, ok: true, version: 'two' },
    { day: today, ok: true, version: [2, 1, 258] },
    { day: '2020-01-01', ok: true, version: [2, 1, 290] }
  ]) {
    await writeFile(cache, JSON.stringify(record))
    asked = 0
    await runTick(w.ctx({ exec, force: true }))
    assert.equal(asked, 2, JSON.stringify(record))
  }
}))

test('a good daily check is forgotten when Claude cannot be found any more: the next tick that finds it asks again', () => withWorld(async (w) => {
  let asked = 0
  const exec = async (file, args) => { asked += 1; return w.exec(file, args) }
  await runTick(w.ctx({ exec, force: true }))
  assert.equal(asked, 2)
  w.clock.advance(MINUTE)
  await runTick(w.ctx({ exec, force: true, find: async () => ({ state: 'not found' }) }))
  assert.equal(asked, 2, 'nothing to ask')
  w.clock.advance(MINUTE)
  await runTick(w.ctx({ exec, force: true }))
  assert.equal(asked, 4, 'asked again, not believed from the morning')
}))

test('the prompts flag is always passed, on the days the check is remembered too', () => withWorld(async (w) => {
  w.claude.script = w.claude.good
  await runTick(w.ctx({ force: true }))
  w.send({ action: 'run', workflow: 'morning-intel' })
  w.clock.advance(MINUTE)
  await runTick(w.ctx({ force: true }))
  assert.ok(w.claude.calls[0].args.includes('--permission-prompts'), 'a new one')
}))

test('a Claude Code older than the protections need runs nothing: a run is refused as "not ready", a card still lands, and a newer one is believed at once', () => withWorld(async (w) => {
  w.claude.script = w.claude.good
  const old = async (file, args) => (args[0] === '--version' ? { stdout: '2.1.258 (Claude Code)\n', code: 0 } : w.exec(file, args))
  const card = w.send({ action: 'task', title: 'Chase the invoice' })
  const run = w.send({ action: 'run', workflow: 'morning-intel' })
  await runTick(w.ctx({ exec: old, force: true }))
  assert.equal(w.claude.calls.length, 0, 'Claude was not started')
  const status = await statusIn(w)
  assert.equal(entryFor(status, card.id).state, 'ok')
  assert.deepEqual([entryFor(status, run.id).state, entryFor(status, run.id).why], ['refused', 'not-ready'])
  assert.ok(w.logs.some((line) => line.includes('version-too-old')), 'the log says why')
  // The same Claude Code, updated: the next order runs.
  const again = w.send({ action: 'run', workflow: 'morning-intel' })
  w.clock.advance(MINUTE)
  await runTick(w.ctx({ force: true }))
  assert.equal(w.claude.calls.length, 1)
  assert.equal(entryFor(await statusIn(w), again.id).state, 'ok')
}))

test('an order that is signed by the board but is not an order at all is not recorded - it has no id to record it under', () => withWorld(async (w) => {
  w.board.orders.push({ kid: 'k1', body: 'not json at all', sig: signBody('not json at all', SECRET) })
  w.board.orders.push({ kid: 'k1', body: '{"v":1}', sig: signBody('{"v":1}', SECRET) })
  const result = await runTick(w.ctx())
  assert.deepEqual(result.orders, { seen: 2, skipped: 2, claimed: 0, ok: 0, refused: 0, failed: 0 })
  assert.deepEqual(await readdir(join(w.places.stateDir, 'claims')), ['store.json'])
}))

test('the day\'s counts are kept once per order: an order seen again and again is counted once; an order is counted, a run too, and a refusal as its own', () => withWorld({ allowlist: ALLOWLIST({ actions: '[task, run]' }) }, async (w) => {
  w.claude.script = w.claude.good
  w.send({ action: 'task', title: 'Chase the invoice' })
  w.send({ action: 'run', workflow: 'morning-intel' })
  w.send({ action: 'skill', title: 'Summarise a sales call' })
  for (let at = 0; at < 4; at += 1) {
    await runTick(w.ctx({ force: true }))
    w.clock.advance(MINUTE)
  }
  const counts = JSON.parse(await readFile(join(w.places.stateDir, 'counts', `${dayOf(w.clock.now())}.json`), 'utf8'))
  assert.deepEqual({ orders: counts.orders, runs: counts.runs, refused: counts.refused }, { orders: 2, runs: 1, refused: 1 })
}))

test('the most orders a day may turn away is a hundred: the hundred and first is left alone, not written down', () => withWorld({ allowlist: ALLOWLIST({ actions: '[task]' }) }, async (w) => {
  const counts = join(w.places.stateDir, 'counts')
  await mkdir(counts, { recursive: true })
  const today = dayOf(w.clock.now())
  await writeFile(join(counts, `${today}.json`), JSON.stringify({ day: today, orders: 0, runs: 0, refused: 99 }))
  const first = w.send({ action: 'skill', title: 'Summarise a sales call' })
  const second = w.send({ action: 'skill', title: 'Summarise another call' })
  const result = await runTick(w.ctx())
  assert.deepEqual(result.orders, { seen: 2, skipped: 1, claimed: 1, ok: 0, refused: 1, failed: 0 })
  assert.equal((await w.claimFile(first.id, 'final.json')).why, 'not-allowed')
  assert.equal(await w.claimFile(second.id, 'receipt.json'), null, 'the hundred and first is not recorded')
  assert.equal(JSON.parse(await readFile(join(counts, `${today}.json`), 'utf8')).refused, 100)
}))

// A file system on which somebody else makes the claim folder of an order at the very moment this one asks to make it.
const racy = {
  ...fsPromises,
  async mkdir(path, ...rest) {
    if (String(path).endsWith('.claim')) await fsPromises.mkdir(path, { recursive: true })
    return fsPromises.mkdir(path, ...rest)
  }
}

test('an order whose claim is made by someone else at the same moment is left to them: nothing is done, and the tick goes on', () => withWorld({ allowlist: ALLOWLIST({ actions: '[task]' }) }, async (w) => {
  const done = w.send({ action: 'task', title: 'Chase the invoice' })
  const turned = w.send({ action: 'skill', title: 'Summarise a sales call' })
  const result = await runTick(w.ctx({ fs: racy }))
  assert.equal(result.state, 'done')
  assert.deepEqual(result.orders, { seen: 2, skipped: 2, claimed: 0, ok: 0, refused: 0, failed: 0 })
  assert.equal(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice.md'), null, 'the card was not made')
  assert.equal(await w.claimFile(done.id, 'final.json'), null)
  assert.equal(await w.claimFile(turned.id, 'final.json'), null)
}))

test('a refusal that cannot be written down stops the tick, like any claim that cannot be made', () => withWorld({ allowlist: ALLOWLIST({ actions: '[task]' }) }, async (w) => {
  w.send({ action: 'skill', title: 'Summarise a sales call' })
  const result = await runTick(w.ctx({ fs: dying((path) => path.includes('order.json')) }))
  assert.deepEqual([result.state, result.why], ['stopped', 'claim-failed'])
  assert.equal(result.orders.refused, 0)
}))

test('a team repo that goes out of reach after the order is claimed fails the order as "push-failed" without doing it', () => withWorld(async (w) => {
  const sent = w.send({ action: 'task', title: 'Chase the invoice' })
  let fetches = 0
  let commits = 0
  const counting = (inner) => async (args, cwd) => {
    if (args.includes('commit')) commits += 1
    return inner(args, cwd)
  }
  const goesDown = async (args, cwd) => {
    if (args.includes('fetch') && (fetches += 1) > 1) throw new Error('unreachable')
    return git(args, cwd)
  }
  const result = await runTick(w.ctx({ git: counting(goesDown) }))
  assert.equal(result.orders.failed, 1)
  const final = await w.claimFile(sent.id, 'final.json')
  assert.deepEqual([final.state, final.why], ['failed', 'push-failed'])
  assert.equal(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice.md'), null)
  assert.equal(commits, 0, 'nothing is committed in a clone that could not be brought level')
}))

test('a work copy that stops being the team repo\'s after the order is claimed refuses the order as "not ready", without doing it', () => withWorld(async (w) => {
  const sent = w.send({ action: 'task', title: 'Chase the invoice' })
  // The daily check asks twice (fetch and push address), the start of the tick once; the order's own level-up is the fourth.
  let asked = 0
  const result = await runTick(w.ctx({ originAccepted: () => (asked += 1) <= 3 }))
  assert.equal(result.orders.refused, 1)
  const final = await w.claimFile(sent.id, 'final.json')
  assert.deepEqual([final.state, final.why], ['refused', 'not-ready'])
  assert.equal(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice.md'), null)
}))

test('an order the card code cannot do - a card that is not there, a row that is not there, a workflow that is not there - is refused with its own reason, and nothing is pushed for it but the status', () => withWorld(async (w) => {
  const orders = [
    [w.send({ action: 'move', task: 'no-such-card', status: 'doing' }), 'card-not-found'],
    [w.send({ action: 'approve', task: 'A task nobody proposed' }), 'no-such-row'],
    [w.send({ action: 'pause', workflow: 'no-such-flow' }), 'no-workflow'],
    [w.send({ action: 'arm', workflow: 'no-such-flow' }), 'no-workflow']
  ]
  const result = await runTick(w.ctx())
  assert.deepEqual(result.orders, { seen: 4, skipped: 0, claimed: 4, ok: 0, refused: 4, failed: 0 })
  for (const [sent, why] of orders) {
    const final = await w.claimFile(sent.id, 'final.json')
    assert.deepEqual([final.state, final.why], ['refused', why])
  }
  assert.deepEqual((await w.inOrigin.log()).filter((subject) => subject.startsWith('Mailbox order')), [])
}))

test('Claude is started with a few variables of its own and none of the Mac\'s: no token, no secret, no loader option, whatever the runner was started with', () => withWorld(async (w) => {
  w.claude.script = w.claude.good
  w.send({ action: 'run', workflow: 'morning-intel' })
  const env = { HOME: w.root, PATH: '/usr/bin', GITHUB_TOKEN: 'a-github-token', AWS_SECRET_ACCESS_KEY: 'an-aws-secret', MAILBOX_KEY: 'a-mailbox-key', NODE_OPTIONS: '--require /tmp/x.js', SSH_AUTH_SOCK: '/tmp/agent' }
  await runTick(w.ctx({ env }))
  assert.equal(w.claude.calls.length, 1)
  assert.deepEqual(w.claude.calls[0].options.env, { HOME: w.root, PATH: '/usr/bin', DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1', ...(process.platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}) })
}))

// A good task sweep: the digest, one card worked (status, day, a Result section) and a log for the orchestrator.
const SWEPT_CARD = 'tasks/2026-08-19-other-card.md'
const sweeping = (w) => async (cwd, args) => {
  const info = w.facts(args[1])
  await w.writeAt(cwd, info.outputPath, '# Task sweep\n\nWorked one card.\n')
  const card = await readFile(join(cwd, SWEPT_CARD), 'utf8')
  await w.writeAt(cwd, SWEPT_CARD, `${card.replace('status: todo', 'status: done\ndone_at: 2026-10-12')}\n## Result\n\nDone.\n`)
  await w.writeLog(cwd, w.logOf(info))
  return [w.INIT, w.tool('Read'), w.tool('Write'), w.RESULT]
}

test('a sweep that edited a card lands after a race that touched something else: its edit is put back on the newer main, and Claude is not run again', () => withWorld(async (w) => {
  w.claude.script = sweeping(w)
  const sent = w.send({ action: 'run', workflow: 'task-sweep' })
  let raced = false
  const racing = async (args, cwd) => {
    if (args.includes('commit') && !raced && String(args[args.indexOf('-m') + 1]).startsWith('Mailbox order')) {
      raced = true
      await w.otherPush('unrelated.md', 'their change\n')
    }
    return git(args, cwd)
  }
  const result = await runTick(w.ctx({ git: racing }))
  assert.equal(result.orders.ok, 1, JSON.stringify(entryFor(await statusIn(w), sent.id)))
  assert.equal(w.claude.calls.length, 1)
  assert.equal(await w.inOrigin.file('unrelated.md'), 'their change\n')
  assert.match(await w.inOrigin.file(SWEPT_CARD), /status: done[\s\S]*## Result/)
}))

test('a sweep that edited a card fails, and never overwrites, when the race changed that very card', () => withWorld(async (w) => {
  w.claude.script = sweeping(w)
  const sent = w.send({ action: 'run', workflow: 'task-sweep' })
  const theirs = '---\nstatus: doing\n---\n\n# Other card\n\nSomeone started it meanwhile.\n'
  let raced = false
  const racing = async (args, cwd) => {
    if (args.includes('commit') && !raced && String(args[args.indexOf('-m') + 1]).startsWith('Mailbox order')) {
      raced = true
      await w.otherPush(SWEPT_CARD, theirs)
    }
    return git(args, cwd)
  }
  await runTick(w.ctx({ git: racing }))
  const entry = entryFor(await statusIn(w), sent.id)
  assert.deepEqual([entry.state, entry.why], ['failed', 'push-failed'])
  assert.equal(await w.inOrigin.file(SWEPT_CARD), theirs, 'their edit is the one on the team repo')
  assert.equal(w.claude.calls.length, 1)
}))

test('a push the team repo cannot take at all - it cannot be reached - is tried once, not three times', () => withWorld(async (w) => {
  w.send({ action: 'task', title: 'Chase the invoice' })
  let pushes = 0
  const down = async (args, cwd) => {
    if (args.includes('push')) pushes += 1
    if (args.includes('push') || args.includes('ls-remote')) throw new Error('unreachable')
    return git(args, cwd)
  }
  await runTick(w.ctx({ git: down }))
  assert.equal(pushes >= 1 && pushes <= 2, true, `${pushes} pushes (the order, then the status)`)
}))

test('a card whose name was taken meanwhile is made under the next name, and that is the file that lands', () => withWorld(async (w) => {
  w.send({ action: 'task', title: 'Chase the invoice' })
  let raced = false
  const racing = async (args, cwd) => {
    if (args.includes('commit') && !raced && String(args[args.indexOf('-m') + 1]).startsWith('Mailbox order')) {
      raced = true
      await w.otherPush('tasks/2026-10-12-chase-the-invoice.md', '---\nstatus: todo\n---\n\n# Chase the invoice\n\nTheirs.\n')
    }
    return git(args, cwd)
  }
  const result = await runTick(w.ctx({ git: racing }))
  assert.equal(result.orders.ok, 1)
  assert.match(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice.md'), /Theirs\./, 'their card is untouched')
  assert.match(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice-2.md'), /# Chase the invoice/, 'ours is the next one')
}))

test('what the daily check remembers is the version Claude really said, so a later tick on the same day knows what it is running', () => withWorld(async (w) => {
  const newer = async (file, args) => (args[0] === '--version' ? { stdout: '2.1.300 (Claude Code)\n', code: 0 } : w.exec(file, args))
  await runTick(w.ctx({ exec: newer, force: true }))
  const kept = JSON.parse(await readFile(join(w.places.stateDir, 'preflight.json'), 'utf8'))
  assert.deepEqual(kept, { day: dayOf(w.clock.now()), ok: true, version: [2, 1, 300] })
}))

test('the web is for the morning intel only: its run is given the web tools, the sweep never is, and each file tool is pre-approved only inside the work copy', () => withWorld(async (w) => {
  w.claude.script = w.claude.good
  w.send({ action: 'run', workflow: 'morning-intel' })
  await runTick(w.ctx())
  const intel = w.claude.calls[0].args
  assert.equal(intel[intel.indexOf('--tools') + 1], 'Read,Edit,Write,Glob,Grep,WebSearch,WebFetch')
  const allowedFrom = (args) => args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'))
  assert.deepEqual(allowedFrom(intel), ['Read(/**)', 'Edit(/**)', 'WebSearch', 'WebFetch'])

  w.claude.script = sweeping(w)
  w.send({ action: 'run', workflow: 'task-sweep' })
  w.clock.advance(MINUTE)
  await runTick(w.ctx({ force: true }))
  assert.equal(w.claude.calls.length, 2)
  const sweep = w.claude.calls[1].args
  assert.equal(sweep[sweep.indexOf('--tools') + 1], 'Read,Edit,Write,Glob,Grep')
  assert.deepEqual(allowedFrom(sweep), ['Read(/**)', 'Edit(/**)'])
  assert.ok(sweep.includes('--restricted'))
}))

test('a run is held to the tools it was given: a sweep that reaches for the web fails with "tool-refused", and the morning intel may use it', () => withWorld(async (w) => {
  w.claude.script = async (cwd, args, call) => {
    const events = await sweeping(w)(cwd, args, call)
    return [events[0], w.tool('WebSearch'), ...events.slice(1)]
  }
  const sweep = w.send({ action: 'run', workflow: 'task-sweep' })
  await runTick(w.ctx())
  assert.equal(entryFor(await statusIn(w), sweep.id).why, 'tool-refused')
  assert.equal(await w.inOrigin.file('inbox/2026-10-12/task-sweep.md'), null, 'nothing is pushed')

  w.claude.script = async (cwd, args, call) => {
    await w.claude.good(cwd, args, call)
    return [w.INIT, w.tool('WebSearch'), w.tool('WebFetch'), w.RESULT]
  }
  const intel = w.send({ action: 'run', workflow: 'morning-intel' })
  w.clock.advance(MINUTE)
  await runTick(w.ctx({ force: true }))
  assert.equal(entryFor(await statusIn(w), intel.id).state, 'ok')
}))

/* ---------- the self-test gate: no run until the confinement was proven on this Mac, for this Claude and these settings ---------- */

const refusedAsNotReady = async (w, id) => {
  const entry = entryFor(await statusIn(w), id)
  return [entry.state, entry.why]
}

test('with no self-test passed, a run is refused as "not ready" and the log says a self-test is needed - a card order still lands, and Claude is never started', () => withWorld({ proof: false }, async (w) => {
  const card = w.send({ action: 'task', title: 'Chase the invoice' })
  const run = w.send({ action: 'run', workflow: 'morning-intel' })
  const sweep = w.send({ action: 'run', workflow: 'task-sweep' })
  w.claude.script = w.claude.good
  const logs = []
  await runTick(w.ctx({ log: (line) => logs.push(line) }))
  assert.equal(entryFor(await statusIn(w), card.id).state, 'ok')
  assert.deepEqual(await refusedAsNotReady(w, run.id), ['refused', 'not-ready'])
  assert.deepEqual(await refusedAsNotReady(w, sweep.id), ['refused', 'not-ready'])
  assert.equal(w.claude.calls.length, 0)
  assert.ok(logs.some((line) => line.includes('selftest-needed')), 'the log says why')
}))

test('a self-test passed for another Claude version, or for other settings, does not count: a run is refused until it is made again', () => withWorld({ proof: false }, async (w) => {
  w.claude.script = w.claude.good
  await keepProof({ stateDir: w.places.stateDir, codeDir: w.places.codeDir, version: [2, 1, 289], file: CLAUDE_FILE, now: w.clock.now })
  const older = w.send({ action: 'run', workflow: 'morning-intel' })
  await runTick(w.ctx())
  assert.deepEqual(await refusedAsNotReady(w, older.id), ['refused', 'not-ready'], 'a proof for 2.1.289 is not a proof for 2.1.290')

  const kept = JSON.parse(await readFile(join(w.places.stateDir, PROOF_FILE), 'utf8'))
  await writeFile(join(w.places.stateDir, PROOF_FILE), JSON.stringify({ ...kept, version: [2, 1, 290], fingerprint: 'f'.repeat(64) }))
  const changed = w.send({ action: 'run', workflow: 'morning-intel' })
  w.clock.advance(MINUTE)
  await runTick(w.ctx({ force: true }))
  assert.deepEqual(await refusedAsNotReady(w, changed.id), ['refused', 'not-ready'], 'a proof for other settings is not a proof for these')
  assert.equal(w.claude.calls.length, 0)
}))

test('a self-test passed before Claude Code was updated does not count after it: the version the daily check found is the one the proof must be for', () => withWorld(async (w) => {
  w.claude.script = w.claude.good
  const newer = async (file, args) => (args[0] === '--version' ? { stdout: '2.1.300 (Claude Code)', code: 0 } : w.exec(file, args))
  const run = w.send({ action: 'run', workflow: 'morning-intel' })
  await runTick(w.ctx({ exec: newer }))
  assert.deepEqual(await refusedAsNotReady(w, run.id), ['refused', 'not-ready'], 'the proof in this world is for 2.1.290')
  assert.equal(w.claude.calls.length, 0)
}))

test('the self-test is looked at on every tick and never remembered: once it is passed the very next tick runs, and when it is lost the next one stops', () => withWorld({ proof: false }, async (w) => {
  w.claude.script = w.claude.good
  const first = w.send({ action: 'run', workflow: 'morning-intel' })
  await runTick(w.ctx())
  assert.deepEqual(await refusedAsNotReady(w, first.id), ['refused', 'not-ready'])

  await keepProof({ stateDir: w.places.stateDir, codeDir: w.places.codeDir, version: [2, 1, 290], file: CLAUDE_FILE, now: w.clock.now })
  const second = w.send({ action: 'run', workflow: 'morning-intel' })
  w.clock.advance(MINUTE)
  await runTick(w.ctx({ force: true }))
  assert.equal(entryFor(await statusIn(w), second.id).state, 'ok', 'passed now: no waiting until tomorrow')
  assert.equal(w.claude.calls.length, 1)

  await dropProof(w.places.stateDir)
  const third = w.send({ action: 'run', workflow: 'task-sweep' })
  w.clock.advance(MINUTE)
  await runTick(w.ctx({ force: true }))
  assert.deepEqual(await refusedAsNotReady(w, third.id), ['refused', 'not-ready'], 'the same day, with the daily check remembered')
  assert.equal(w.claude.calls.length, 1)
}))

/* ---------- the version about to run ------------------------------------------------------------------------------------ */

// Claude Code updates itself in the background (https://code.claude.com/docs/en/setup#auto-updates), so the version the daily check
// remembered is not the version that will start. The runner asks for it just before each run, and a run whose version is not the one the
// self-test passed for is refused as "not ready" - never started - with the owner's log saying a new self-test is needed.
const versions = (w, said, events = []) => {
  const asked = []
  const exec = async (file, args, options) => {
    if (args[0] === '--version') {
      events.push('version')
      asked.push({ file, options })
      const next = said.shift()
      if (next instanceof Error) throw next
      return { stdout: `${next} (Claude Code)`, code: 0 }
    }
    return w.exec(file, args, options)
  }
  return { exec, asked }
}

test('Claude Code updated itself after the daily check: the run is refused as "not ready" and never started, and the log says a new self-test is needed', () => withWorld(async (w) => {
  w.claude.script = w.claude.good
  const { exec } = versions(w, ['2.1.290', '2.1.291'])
  const run = w.send({ action: 'run', workflow: 'morning-intel' })
  const logs = []
  await runTick(w.ctx({ exec, log: (line) => logs.push(line) }))
  assert.deepEqual(await refusedAsNotReady(w, run.id), ['refused', 'not-ready'])
  assert.equal(w.claude.calls.length, 0, 'Claude is never started')
  assert.ok(logs.some((line) => line.includes('needs a new self-test') && line.includes('2.1.291')), 'the log says which version it found')
  assert.equal(await w.inOrigin.file('inbox/2026-10-12/morning-intel.md'), null, 'nothing is pushed')
}))

test('the version is asked immediately before Claude starts - from an empty folder, with the small environment, and nothing else between the two', () => withWorld(async (w) => {
  w.claude.script = w.claude.good
  const events = []
  const { exec, asked } = versions(w, ['2.1.290', '2.1.290'], events)
  const spawn = (...given) => {
    events.push('spawn')
    return w.claudeSpawn(...given)
  }
  w.send({ action: 'run', workflow: 'morning-intel' })
  await runTick(w.ctx({ exec, spawn }))
  assert.equal(w.claude.calls.length, 1)
  assert.deepEqual(events, ['version', 'version', 'spawn'], 'the daily check, then the one just before the run')
  assert.equal(asked[1].file, '/fake/bin/claude')
  assert.equal(asked[1].options.cwd, join(w.places.stateDir, 'empty-cwd'), 'never the team repo')
  assert.deepEqual(asked[1].options.env, { HOME: w.root, PATH: '/usr/bin', DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1', ...(process.platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}) })
}))

test('a version that cannot be read just before a run, or one the self-test never saw, is the same as a changed one: no run', () => withWorld(async (w) => {
  w.claude.script = w.claude.good
  for (const [name, second] of [['an error', new Error('could not start')], ['nothing like a version', 'banana'], ['an older one', '2.1.258'], ['a newer one', '2.2.0']]) {
    const { exec } = versions(w, ['2.1.290', second])
    const run = w.send({ action: 'run', workflow: 'morning-intel' })
    w.clock.advance(MINUTE)
    await rm(join(w.places.stateDir, 'preflight.json'), { force: true })
    await runTick(w.ctx({ exec, force: true }))
    assert.deepEqual(await refusedAsNotReady(w, run.id), ['refused', 'not-ready'], name)
  }
  assert.equal(w.claude.calls.length, 0)
}))

test('the version is asked before every run, not once a day: a run after an update that came between two runs is refused', () => withWorld(async (w) => {
  w.claude.script = async (cwd, args, call) => (args.includes('WebSearch') ? w.claude.good(cwd, args, call) : sweeping(w)(cwd, args, call))
  // The daily check is made once, for the first tick; the second tick runs on its answer, and asks again only just before its run.
  const { exec } = versions(w, ['2.1.290', '2.1.290', '2.1.291'])
  const first = w.send({ action: 'run', workflow: 'morning-intel' })
  await runTick(w.ctx({ exec }))
  assert.equal(entryFor(await statusIn(w), first.id).state, 'ok')
  const second = w.send({ action: 'run', workflow: 'task-sweep' })
  w.clock.advance(MINUTE)
  await runTick(w.ctx({ exec, force: true }))
  const status = await statusIn(w)
  assert.deepEqual([entryFor(status, second.id).state, entryFor(status, second.id).why], ['refused', 'not-ready'])
  assert.equal(w.claude.calls.length, 1, 'only the first run started Claude')
}))

/* ---------- the program that was checked is the program that starts ----------------------------------------------------- */

// The name Claude Code is found by (~/.local/bin/claude) is a link into a folder of versions, and an update - by hand, between the check
// and the start - moves that link. So the link is followed ONCE per run, that file is asked its version, and that very file is started: the
// name is never looked up a second time.
const VERSIONS = { '/fake/bin/claude': '2.1.290', '/fake/versions/2.1.290/claude': '2.1.290', '/fake/versions/2.1.291/claude': '2.1.291' }

test('the launcher is followed to its real file once per run, that file is asked its version, and that file is what starts - even if the link is swapped in between', () => withWorld({ proof: false }, async (w) => {
  w.claude.script = w.claude.good
  // The self-test passed for the file the link leads to at the first look.
  await keepProof({ stateDir: w.places.stateDir, codeDir: w.places.codeDir, version: [2, 1, 290], file: '/fake/versions/2.1.290/claude', now: w.clock.now })
  const followed = []
  // The first look finds version 2.1.290; any later look at the link finds that an update has swapped it for 2.1.291.
  const realpathOf = async (path) => {
    followed.push(path)
    return followed.length === 1 ? '/fake/versions/2.1.290/claude' : '/fake/versions/2.1.291/claude'
  }
  const asked = []
  const exec = async (file, args, options) => {
    if (args[0] !== '--version') return w.exec(file, args, options)
    asked.push(file)
    return { stdout: `${VERSIONS[file]} (Claude Code)\n`, code: 0 }
  }
  const run = w.send({ action: 'run', workflow: 'morning-intel' })
  await runTick(w.ctx({ exec, realpath: realpathOf }))
  assert.equal(entryFor(await statusIn(w), run.id).state, 'ok')
  assert.deepEqual(followed, ['/fake/bin/claude'], 'the link is followed once, from the name the daily check found')
  assert.equal(asked.at(-1), '/fake/versions/2.1.290/claude', 'the version asked is that of the file the link led to')
  assert.equal(w.claude.calls.length, 1)
  assert.equal(w.claude.calls[0].file, '/fake/versions/2.1.290/claude', 'and that file is what starts, not the link and not what the link leads to now')
}))

test('a launcher that cannot be followed to a file is no run: refused as "not ready", never started, and the log says Claude Code was not found', () => withWorld(async (w) => {
  w.claude.script = w.claude.good
  const logs = []
  for (const [name, realpathOf] of [['an error', async () => { throw new Error('ENOENT') }], ['an empty answer', async () => ''], ['no text', async () => undefined]]) {
    const run = w.send({ action: 'run', workflow: 'morning-intel' })
    w.clock.advance(MINUTE)
    await runTick(w.ctx({ realpath: realpathOf, force: true, log: (line) => logs.push(line) }))
    assert.deepEqual(await refusedAsNotReady(w, run.id), ['refused', 'not-ready'], name)
  }
  assert.equal(w.claude.calls.length, 0)
  assert.ok(logs.some((line) => line.includes('claude-missing')), 'the log says why')
}))

test('on a real file system a link to the program is followed to the program itself: its real path is asked for the version and started', async (t) => {
  await withWorld({ proof: false }, async (w) => {
    const target = join(w.root, 'bin', 'versions', '2.1.290', 'claude')
    const link = join(w.root, 'bin', 'claude')
    await mkdir(join(w.root, 'bin', 'versions', '2.1.290'), { recursive: true })
    await writeFile(target, 'not a real program\n')
    try {
      await symlink(target, link)
    } catch {
      t.skip('this system does not let this test make a link')
      return
    }
    w.claude.script = w.claude.good
    const real = await realpath(target)
    await keepProof({ stateDir: w.places.stateDir, codeDir: w.places.codeDir, version: [2, 1, 290], file: real, now: w.clock.now })
    const asked = []
    const exec = async (file, args, options) => {
      if (args[0] === '--version') asked.push(file)
      return w.exec(file, args, options)
    }
    w.send({ action: 'run', workflow: 'morning-intel' })
    await runTick(w.ctx({ exec, find: async () => ({ state: 'found', path: link }), realpath: undefined }))
    assert.equal(w.claude.calls.length, 1)
    assert.equal(w.claude.calls[0].file, real, 'the program itself, not the link')
    assert.equal(asked.at(-1), real)
    assert.notEqual(real, link)
  })
})

/* ---------- the self-test proof is for the file that starts, not only for a version number ------------------------------- */

test('a self-test passed for one file does not count for another file that says the same version: the run is refused as not ready, Claude is never started, and the log says a new self-test is needed', () => withWorld({ proof: false }, async (w) => {
  w.claude.script = w.claude.good
  // Two different programs, both saying 2.1.290: the self-test passed for the first, and the link now leads to the second.
  await keepProof({ stateDir: w.places.stateDir, codeDir: w.places.codeDir, version: [2, 1, 290], file: '/fake/versions/first/claude', now: w.clock.now })
  const run = w.send({ action: 'run', workflow: 'morning-intel' })
  const logs = []
  await runTick(w.ctx({ realpath: async () => '/fake/versions/second/claude', log: (line) => logs.push(line) }))
  assert.deepEqual(await refusedAsNotReady(w, run.id), ['refused', 'not-ready'])
  assert.equal(w.claude.calls.length, 0, 'Claude was never started')
  assert.ok(logs.some((line) => line.includes('selftest-needed')), 'the log says why')

  // The same tick shape with the link leading to the file that was tested runs.
  const again = w.send({ action: 'run', workflow: 'morning-intel' })
  w.clock.advance(MINUTE)
  await runTick(w.ctx({ realpath: async () => '/fake/versions/first/claude', force: true }))
  assert.equal(entryFor(await statusIn(w), again.id).state, 'ok')
  assert.equal(w.claude.calls.length, 1)
  assert.equal(w.claude.calls[0].file, '/fake/versions/first/claude')
}))

test('a self-test kept in the old form, with a version and settings but no file, does not count: it cannot say which program it tested, so a run is refused until a new self-test is made', () => withWorld({ proof: false }, async (w) => {
  w.claude.script = w.claude.good
  await keepProof({ stateDir: w.places.stateDir, codeDir: w.places.codeDir, version: [2, 1, 290], file: CLAUDE_FILE, now: w.clock.now })
  const kept = JSON.parse(await readFile(join(w.places.stateDir, PROOF_FILE), 'utf8'))
  delete kept.file
  await writeFile(join(w.places.stateDir, PROOF_FILE), JSON.stringify(kept))
  const run = w.send({ action: 'run', workflow: 'morning-intel' })
  await runTick(w.ctx())
  assert.deepEqual(await refusedAsNotReady(w, run.id), ['refused', 'not-ready'])
  assert.equal(w.claude.calls.length, 0)
}))

/* ---------- Claude changes what git reads ------------------------------------------------------------------------------- */

// After Claude exits the runner runs git in the work copy as the owner, so a setting or hook planted in .git would run with the owner's
// rights. The folder is compared with a snapshot taken just before Claude started, and git is not run in it if anything differs.
const TAMPERS = [
  ['a credential helper in .git/config', async (cwd) => appendFile(join(cwd, '.git', 'config'), '[credential]\n\thelper = !touch /tmp/pwned\n')],
  ['an ssh command in .git/config', async (cwd) => appendFile(join(cwd, '.git', 'config'), '[core]\n\tsshCommand = touch /tmp/pwned\n')],
  ['a hook', async (cwd) => writeFile(join(cwd, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ntouch /tmp/pwned\n')],
  ['a filter in .git/info/attributes', async (cwd) => {
    await mkdir(join(cwd, '.git', 'info'), { recursive: true })
    await writeFile(join(cwd, '.git', 'info', 'attributes'), '* filter=evil\n')
  }]
]

for (const [what, tamper] of TAMPERS) {
  test(`a run in which Claude plants ${what}: the order fails as "change-refused", no git runs in that copy afterwards, and the work copy is made again from the team repo`, () => withWorld(async (w) => {
    const sent = w.send({ action: 'run', workflow: 'morning-intel' })
    w.claude.script = async (cwd, args, call) => {
      const events = await w.claude.good(cwd, args, call)
      await tamper(cwd)
      return events
    }
    const afterClaude = []
    const watching = async (args, cwd) => {
      if (w.claude.calls.length > 0) afterClaude.push({ verb: args.find((one) => ['clone', 'init', 'diff', 'add', 'commit', 'push', 'status', 'fetch', 'checkout', 'clean', 'rev-parse', 'show'].includes(one)), cwd, empty: (await readdir(cwd).catch(() => null))?.length === 0 })
      return git(args, cwd)
    }
    const result = await runTick(w.ctx({ git: watching }))
    const final = await w.claimFile(sent.id, 'final.json')
    assert.deepEqual([final.state, final.why], ['failed', 'change-refused'])
    assert.equal(result.orders.failed, 1)
    assert.equal(w.claude.calls.length, 1)
    // The first git command after Claude is the init that makes the copy again, in a fresh empty folder: the old one is gone before any git runs.
    assert.deepEqual([afterClaude[0].verb, afterClaude[0].cwd, afterClaude[0].empty], ['init', w.places.workDir, true])
    assert.equal(await w.inOrigin.file('inbox/2026-10-12/morning-intel.md'), null, 'nothing of the run was pushed')
    assert.equal((await w.inOrigin.log()).some((subject) => subject.startsWith('Mailbox order')), false)
    // The fresh copy has none of it.
    assert.ok(!(await readFile(join(w.places.workDir, '.git', 'config'), 'utf8')).includes('pwned'))
    assert.equal(await exists(join(w.places.workDir, '.git', 'hooks', 'pre-commit')), false)
    assert.equal(await exists(join(w.places.workDir, '.git', 'info', 'attributes')), false)
    assert.ok(w.logs.some((line) => line.includes('git settings of the work copy')))
  }))
}

test('a run whose Claude changes nothing in .git is not disturbed by the check: the work copy is the same one, and the order lands', () => withWorld(async (w) => {
  const sent = w.send({ action: 'run', workflow: 'morning-intel' })
  w.claude.script = w.claude.good
  const cloned = []
  const watching = async (args, cwd) => {
    if (args.includes('clone') || args.includes('init')) cloned.push(cwd)
    return git(args, cwd)
  }
  await runTick(w.ctx({ git: watching }))
  assert.equal((await w.claimFile(sent.id, 'final.json')).state, 'ok')
  assert.deepEqual(cloned, [], 'not made again')
}))

test('Claude plants a hook and the run also failed: git still does not run in that copy, and the order is failed once', () => withWorld(async (w) => {
  const sent = w.send({ action: 'run', workflow: 'morning-intel' })
  // No result line at all: the run itself is a failure. The check comes first all the same.
  w.claude.script = async (cwd) => {
    await writeFile(join(cwd, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ntouch /tmp/pwned\n')
    return []
  }
  // Every git command from the moment Claude has started until the fresh copy is begun (git init in an empty folder): none may be run in the old folder.
  const beforeRemade = []
  let remade = false
  const watching = async (args, cwd) => {
    if (args.includes('init')) remade = true
    else if (w.claude.calls.length > 0 && !remade) beforeRemade.push(args)
    return git(args, cwd)
  }
  await runTick(w.ctx({ git: watching }))
  const final = await w.claimFile(sent.id, 'final.json')
  assert.deepEqual([final.state, final.why], ['failed', 'change-refused'])
  assert.deepEqual(beforeRemade, [], 'no git command between Claude and the fresh copy')
  assert.equal(await exists(join(w.places.workDir, '.git', 'hooks', 'pre-commit')), false)
}))

const exists = (path) => access(path).then(() => true, () => false)

/* ---------- a push that was killed while the server was still applying it ---------------------------------------------------- */

test('a push that git gave up on (its time limit) and the server applied a moment after the runner looked: the order is outcome unknown, not failed, and the next tick records that it landed - Claude started once', () => withWorld(async (w) => {
  w.claude.script = w.claude.good
  const sent = w.send({ action: 'run', workflow: 'morning-intel' })
  let pending = null
  const late = async (args, cwd) => {
    if (args.includes('push') && pending === null && await isRunPush(args, cwd)) {
      pending = { args, cwd, applied: false }
      throw new Error('git was killed by its time limit')
    }
    const out = await git(args, cwd)
    // The server finishes the push now: after the runner's look at main, before anything else.
    if (args.includes('ls-remote') && pending && !pending.applied) {
      pending.applied = true
      await git(pending.args, pending.cwd)
    }
    return out
  }
  const first = await runTick(w.ctx({ git: late }))
  assert.equal(first.orders.failed, 0)
  const unchecked = await w.claimFile(sent.id, 'final.json')
  assert.deepEqual([unchecked.state, unchecked.landed, unchecked.why], ['unknown', null, null])
  w.clock.advance(6 * MINUTE)
  await runTick(w.ctx({ force: true }))
  const settled = await w.claimFile(sent.id, 'final.json')
  assert.deepEqual([settled.state, settled.landed], ['unknown', true])
  assert.match(settled.commit, /^[0-9a-f]{12}$/)
  assert.equal(entryFor(await statusIn(w), sent.id).landed, true)
  assert.equal(w.claude.calls.length, 1)
  assert.equal((await commitsWithTrailer(w, sent.id)).length, 1)
}))

test('a push the server refuses for good (main stays where it was): the order is outcome unknown, nothing is redone, and the next tick records that it did not land', () => withWorld(async (w) => {
  const sent = w.send({ action: 'task', title: 'Chase the invoice' })
  let refusals = 0
  const refusing = async (args, cwd) => {
    if (args.includes('push') && (await git(['log', '-1', '--format=%s', args.at(-1).split(':')[0]], cwd)).stdout.startsWith('Mailbox order')) {
      refusals += 1
      throw new Error('remote: protected branch hook declined')
    }
    return git(args, cwd)
  }
  const first = await runTick(w.ctx({ git: refusing }))
  assert.equal(first.orders.failed, 0)
  assert.equal(refusals, 1, 'tried once, not three times')
  const unchecked = await w.claimFile(sent.id, 'final.json')
  assert.deepEqual([unchecked.state, unchecked.landed], ['unknown', null])
  w.clock.advance(6 * MINUTE)
  await runTick(w.ctx({ git: refusing, force: true }))
  const settled = await w.claimFile(sent.id, 'final.json')
  assert.deepEqual([settled.state, settled.landed, settled.commit], ['unknown', false, null])
  assert.equal(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice.md'), null)
  assert.equal(refusals, 1, 'never pushed again')
}))

test('after an unsure push the work copy ends the tick level with the team repo and clean (the status sync at the end of the tick resets it; the reset in publish is redundant by design)', () => withWorld(async (w) => {
  w.send({ action: 'task', title: 'Chase the invoice' })
  const refusing = async (args, cwd) => {
    if (args.includes('push') && (await git(['log', '-1', '--format=%s', args.at(-1).split(':')[0]], cwd)).stdout.startsWith('Mailbox order')) throw new Error('declined')
    return git(args, cwd)
  }
  await runTick(w.ctx({ git: refusing }))
  assert.equal((await git(['status', '--porcelain'], w.places.workDir)).stdout.trim(), '')
  assert.equal((await git(['rev-parse', 'HEAD'], w.places.workDir)).stdout.trim(), await w.inOrigin.head().then(async (head) => head), 'level with the team repo')
}))

/* ---------- a claims folder put back from an older copy forgets what has landed ----------------------------------------------- */

test('an order that already landed is not done again when its claim was lost and the store record kept: no second card, one commit with the trailer, and it is settled ok', () => withWorld(async (w) => {
  const sent = w.send({ action: 'task', title: 'Chase the invoice' })
  await runTick(w.ctx())
  assert.ok(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice.md'))
  const landed = (await commitsWithTrailer(w, sent.id))[0]
  // Put back from a copy made before the claim: the order's claim folder is gone, the store record (the old start) is there.
  await rm(join(w.places.stateDir, 'claims', `${sent.id}.claim`), { recursive: true })
  assert.deepEqual(await readdir(join(w.places.stateDir, 'claims')), ['store.json'])
  w.clock.advance(5 * MINUTE)
  await runTick(w.ctx({ force: true }))
  assert.equal(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice-2.md'), null, 'not done a second time')
  assert.equal((await commitsWithTrailer(w, sent.id)).length, 1)
  const final = await w.claimFile(sent.id, 'final.json')
  assert.deepEqual([final.state, final.why, final.commit], ['ok', null, landed.slice(0, 12)])
}))

test('a run that already landed is not run again when its claim was lost: Claude is started once', () => withWorld(async (w) => {
  w.claude.script = w.claude.good
  const sent = w.send({ action: 'run', workflow: 'morning-intel' })
  await runTick(w.ctx())
  assert.equal(w.claude.calls.length, 1)
  await rm(join(w.places.stateDir, 'claims', `${sent.id}.claim`), { recursive: true })
  w.clock.advance(5 * MINUTE)
  await runTick(w.ctx({ force: true }))
  assert.equal(w.claude.calls.length, 1, 'Claude was not started again')
  assert.equal((await commitsWithTrailer(w, sent.id)).length, 1)
  assert.equal((await w.claimFile(sent.id, 'final.json')).state, 'ok')
}))

test('an order that did not land is still done after its claim is lost: only a commit with its trailer on main stops it', () => withWorld(async (w) => {
  const sent = w.send({ action: 'task', title: 'Chase the invoice' })
  const refusing = async (args, cwd) => {
    if (args.includes('push') && (await git(['log', '-1', '--format=%s', args.at(-1).split(':')[0]], cwd)).stdout.startsWith('Mailbox order')) throw new Error('declined')
    return git(args, cwd)
  }
  await runTick(w.ctx({ git: refusing }))
  assert.equal(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice.md'), null)
  await rm(join(w.places.stateDir, 'claims', `${sent.id}.claim`), { recursive: true })
  w.clock.advance(5 * MINUTE)
  await runTick(w.ctx({ force: true }))
  assert.ok(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice.md'), 'it had not landed, so it is done now')
  assert.equal((await commitsWithTrailer(w, sent.id)).length, 1)
}))

test('when the team repo cannot be read for the look before the first effect, nothing is done: the order fails as push-failed and no card is made', () => withWorld(async (w) => {
  const sent = w.send({ action: 'task', title: 'Chase the invoice' })
  let afterClaim = 0
  const blind = async (args, cwd) => {
    if (existsSync(join(w.places.stateDir, 'claims', `${sent.id}.claim`)) && args.includes('fetch')) {
      afterClaim += 1
      // The first fetch after the claim brings the clone level; the second is the look for the order's trailer.
      if (afterClaim === 2) throw new Error('unreachable')
    }
    return git(args, cwd)
  }
  await runTick(w.ctx({ git: blind }))
  assert.equal(afterClaim >= 2, true)
  const final = await w.claimFile(sent.id, 'final.json')
  assert.deepEqual([final.state, final.why], ['failed', 'push-failed'])
  assert.equal(await w.inOrigin.file('tasks/2026-10-12-chase-the-invoice.md'), null)
}))
