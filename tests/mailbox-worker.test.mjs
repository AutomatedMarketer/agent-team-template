import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoRoot } from './helpers/repo.mjs'
import { ALLOWED_ORDERS, readAllowedOrders, decide } from '../scripts/lib/mailbox/allow.mjs'
import { validatePayload, WORKER_FIELD } from '../scripts/lib/mailbox/validate.mjs'
import { WORKERS } from '../scripts/lib/mailbox/codex.mjs'
import { buildMailbox } from '../scripts/lib/mailbox/status.mjs'
import { checkMailbox } from '../scripts/lib/status/safe.mjs'
import { MAILBOX_KEYS, MAILBOX_REASONS, MAILBOX_WORKER_REASONS, MAILBOX_WORKERS } from '../scripts/lib/status/mailbox-schema.mjs'

/* The second worker, as the shared contract has it (tests/fixtures/mailbox-parity.json: payload.worker and status.workers, both
   new keys, so a board that has not learned them reads every older part exactly as before). Codex runs only a job the computer's
   own allowlist gives it; the order must ask for the same worker, or it is refused with a fixed word. */

const fixture = JSON.parse(readFileSync(join(repoRoot, 'tests', 'fixtures', 'mailbox-parity.json'), 'utf8'))
const worker = fixture.payload.worker
const workers = fixture.status.workers
const IDENTITY = { hostname: 'nunos-mac', username: 'nunotavares', home: '/Users/nunotavares' }

/* ---------- the order's field ---------------------------------------------------------------------------------------- */

test('the worker field is the contract\'s: only on run, claude or codex, claude when left out', () => {
  assert.deepEqual([...WORKER_FIELD.actions], worker.actions)
  assert.deepEqual([...WORKER_FIELD.values], worker.values)
  assert.equal(WORKER_FIELD.default, worker.default)
  assert.deepEqual([...WORKERS], worker.values)
  assert.deepEqual([...MAILBOX_WORKERS], workers.values)
})

test('every worker case in the contract gets the contract\'s verdict, and a good run keeps its worker', () => {
  for (const { name, payload, verdict } of worker.cases) {
    const result = validatePayload({ source: fixture.payload.source, ...payload })
    assert.equal(result.ok ? 'ok' : 'refused', verdict, name)
    if (result.ok && Object.hasOwn(payload, 'worker')) assert.equal(result.fields.worker, payload.worker, name)
    if (result.ok && !Object.hasOwn(payload, 'worker')) assert.ok(!Object.hasOwn(result.fields, 'worker'), name)
  }
})

/* ---------- the computer's allowlist --------------------------------------------------------------------------------- */

const ALLOW = (jobs) => `board: https://board.example.com\nrepo: ExampleOwner/example-team\nrunner: mac-mini\ncomputer: Mac Mini\nactions: [run, task]\njobs:\n${jobs}per_day:\n  orders: 40\n  runs: 6\n`

async function readAllow(text) {
  const dir = await mkdtemp(join(tmpdir(), 'mailbox-worker-'))
  try {
    await writeFile(join(dir, ALLOWED_ORDERS.file), text)
    return await readAllowedOrders(dir, IDENTITY)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a job may name its worker; one that names none is Claude\'s and is not in the list', async () => {
  const found = await readAllow(ALLOW('  - slug: task-sweep\n    minutes: 30\n    worker: codex\n  - slug: morning-intel\n    minutes: 20\n  - slug: weekly-review\n    minutes: 10\n    worker: claude\n'))
  assert.equal(found.state, 'ok')
  assert.deepEqual(found.allow.jobs, new Map([['task-sweep', 30], ['morning-intel', 20], ['weekly-review', 10]]))
  assert.deepEqual(found.allow.workers, new Map([['task-sweep', 'codex'], ['weekly-review', 'claude']]))
})

test('a worker that is not claude or codex breaks the file at jobs, never read as "anything"', async () => {
  for (const bad of ['Codex', 'gpt', '""', '[codex]', 'codex claude', '1']) {
    const found = await readAllow(ALLOW(`  - slug: task-sweep\n    minutes: 30\n    worker: ${bad}\n`))
    assert.deepEqual({ state: found.state, why: found.why }, { state: 'broken', why: 'jobs' }, bad)
  }
})

test('the same job twice with two workers is Claude\'s: when two lines disagree, the one that allows less is believed', async () => {
  const found = await readAllow(ALLOW('  - slug: task-sweep\n    minutes: 30\n    worker: codex\n  - slug: task-sweep\n    minutes: 20\n'))
  assert.equal(found.allow.workers.get('task-sweep') ?? 'claude', 'claude')
  assert.equal(found.allow.jobs.get('task-sweep'), 20)
  const both = await readAllow(ALLOW('  - slug: task-sweep\n    minutes: 30\n    worker: codex\n  - slug: task-sweep\n    minutes: 20\n    worker: codex\n'))
  assert.equal(both.allow.workers.get('task-sweep'), 'codex')
})

test('every allow case in the contract: the order\'s worker must be the job\'s worker, or it is refused as worker-not-allowed', () => {
  const counts = { orders: 0, runs: 0, refused: 0 }
  for (const { name, jobWorker, orderWorker, verdict } of worker.allowCases) {
    const allow = {
      actions: ['run'],
      jobs: new Map([['task-sweep', 30]]),
      workers: jobWorker === null ? new Map() : new Map([['task-sweep', jobWorker]]),
      perDay: { orders: 40, runs: 6 }
    }
    const fields = { workflow: 'task-sweep', ...(orderWorker === null ? {} : { worker: orderWorker }) }
    const decision = decide(allow, counts, 'run', fields, ['task-sweep'])
    assert.equal(decision.ok ? 'ok' : decision.why, verdict, name)
    if (decision.ok) assert.deepEqual(decision, { ok: true, minutes: 30, worker: jobWorker ?? 'claude' }, name)
  }
})

test('a job that is not on the list is still job-not-allowed, whatever worker is asked for; an allowlist with no workers is all Claude', () => {
  const counts = { orders: 0, runs: 0, refused: 0 }
  const allow = { actions: ['run'], jobs: new Map([['task-sweep', 30]]), perDay: { orders: 40, runs: 6 } }
  assert.equal(decide(allow, counts, 'run', { workflow: 'other', worker: 'codex' }, ['task-sweep']).why, 'job-not-allowed')
  assert.deepEqual(decide(allow, counts, 'run', { workflow: 'task-sweep' }, ['task-sweep']), { ok: true, minutes: 30, worker: 'claude' })
  assert.equal(decide(allow, counts, 'run', { workflow: 'task-sweep', worker: 'codex' }, ['task-sweep']).why, 'worker-not-allowed')
})

/* ---------- the status file ------------------------------------------------------------------------------------------ */

const file = (allows, orders = []) => ({ schema: 'agent-mailbox/v1', takenAt: '2026-10-12T14:12:00Z', computer: 'Mac Mini', runner: 'mac-mini', allows, orders })

test('the new status words and keys are the contract\'s, kept apart from the older lists so a board that does not know them reads those unchanged', () => {
  assert.deepEqual(MAILBOX_WORKER_REASONS.refused, Object.keys(workers.reasons.refused))
  assert.deepEqual(MAILBOX_WORKER_REASONS.failed, Object.keys(workers.reasons.failed))
  assert.deepEqual(MAILBOX_KEYS.allowsOptional, workers.allowsOptional)
  for (const word of [...MAILBOX_WORKER_REASONS.refused, ...MAILBOX_WORKER_REASONS.failed]) {
    assert.ok(![...MAILBOX_REASONS.refused, ...MAILBOX_REASONS.failed].includes(word), `${word} is new`)
  }
})

test('the contract\'s sample allows, every accepted one passes the gate, and every refused one is refused', () => {
  assert.deepEqual(checkMailbox(file(workers.sampleAllows), IDENTITY), [])
  for (const { why, allows } of workers.allowsAccept) assert.deepEqual(checkMailbox(file(allows), IDENTITY), [], why)
  for (const { why, allows } of workers.allowsRefuse) assert.notDeepEqual(checkMailbox(file(allows), IDENTITY), [], why)
})

test('an order refused as worker-not-allowed, or failed as codex-failed, passes the gate; neither word fits the other state', () => {
  const base = { id: '22222222222222222222222222222222', action: 'run', at: '2026-10-12T14:11:00Z', commit: null, landed: null }
  const refused = { ...base, state: 'refused', startedAt: null, finishedAt: null, why: 'worker-not-allowed' }
  const failed = { ...base, state: 'failed', startedAt: '2026-10-12T14:10:00Z', finishedAt: '2026-10-12T14:11:00Z', why: 'codex-failed', steps: 3 }
  assert.deepEqual(checkMailbox(file(workers.sampleAllows, [refused]), IDENTITY), [])
  assert.deepEqual(checkMailbox(file(workers.sampleAllows, [failed]), IDENTITY), [])
  assert.notDeepEqual(checkMailbox(file(workers.sampleAllows, [{ ...refused, why: 'codex-failed' }]), IDENTITY), [])
  assert.notDeepEqual(checkMailbox(file(workers.sampleAllows, [{ ...failed, why: 'worker-not-allowed' }]), IDENTITY), [])
})

test('the status file says the workers only when it is given them, both keys together, sorted', () => {
  const plain = buildMailbox({ computer: 'Mac Mini', runner: 'mac-mini', takenAt: Date.parse('2026-10-12T14:12:00Z'), allows: { actions: ['run'], jobs: ['task-sweep'] }, orders: [] })
  assert.deepEqual(Object.keys(plain.allows), ['actions', 'jobs'])
  const withWorkers = buildMailbox({ computer: 'Mac Mini', runner: 'mac-mini', takenAt: Date.parse('2026-10-12T14:12:00Z'), allows: { actions: ['run'], jobs: ['task-sweep', 'morning-intel'], workers: ['codex', 'claude'], codexJobs: ['task-sweep'] }, orders: [] })
  assert.deepEqual(withWorkers.allows, { actions: ['run'], jobs: ['morning-intel', 'task-sweep'], workers: ['claude', 'codex'], codexJobs: ['task-sweep'] })
  assert.deepEqual(checkMailbox(withWorkers, IDENTITY), [])
})
