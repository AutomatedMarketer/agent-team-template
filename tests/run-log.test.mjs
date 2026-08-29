import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fromRoot, read } from './helpers/repo.mjs'
import { validateRunLog, runIdFor, monthFolderFor, SCHEMA_ID } from '../scripts/lib/run-log.mjs'

const fixture = async (name) => JSON.parse(await readFile(fromRoot('tests/fixtures/runs', name), 'utf8'))

test('a well-formed scheduled run validates', async () => {
  const entry = await fixture('valid-schedule.json')
  assert.deepEqual(validateRunLog(entry, { filename: `${entry.run_id}.json` }), [])
})

test('a pinned model id is rejected', async () => {
  const entry = await fixture('invalid-pinned-model.json')
  const problems = validateRunLog(entry, { filename: `${entry.run_id}.json` })
  assert.ok(problems.some((problem) => /alias/i.test(problem)), problems.join('; '))
})

test('an arrow-chain summary is rejected', async () => {
  const entry = await fixture('invalid-arrow-summary.json')
  const problems = validateRunLog(entry, { filename: `${entry.run_id}.json` })
  assert.ok(problems.some((problem) => /arrow/i.test(problem)), problems.join('; '))
})

test('the filename must equal run_id.json', async () => {
  const entry = await fixture('valid-schedule.json')
  const problems = validateRunLog(entry, { filename: 'something-else.json' })
  assert.ok(problems.some((problem) => /filename/i.test(problem)), problems.join('; '))
})

test('a missing run_id does not produce an "undefined.json" filename complaint', async () => {
  const { run_id, ...entry } = await fixture('valid-schedule.json')
  const problems = validateRunLog(entry, { filename: `${run_id}.json` })
  assert.ok(problems.some((problem) => /run_id/.test(problem)), problems.join('; '))
  assert.ok(
    !problems.some((problem) => problem.includes('undefined')),
    `no problem should name "undefined": ${problems.join('; ')}`
  )
})

test('a scheduled run without a session link is rejected', async () => {
  const entry = { ...(await fixture('valid-schedule.json')), session_id: null, session_url: null }
  const problems = validateRunLog(entry, { filename: `${entry.run_id}.json` })
  assert.ok(problems.some((problem) => /session/i.test(problem)), problems.join('; '))
})

test('a manual local run may have no session link', async () => {
  const entry = {
    ...(await fixture('valid-schedule.json')),
    trigger: 'manual',
    session_id: null,
    session_url: null
  }
  assert.deepEqual(validateRunLog(entry, { filename: `${entry.run_id}.json` }), [])
})

test('run ids and month folders have no colon in them', () => {
  const date = new Date(Date.UTC(2026, 7, 7, 6, 0, 0))
  assert.equal(runIdFor('research', date), '2026-08-07T0600Z-research')
  assert.equal(monthFolderFor(date), 'runs/2026-08')
  assert.doesNotMatch(runIdFor('research', date), /:/)
})

test('runs/README.md documents the schema id and every field', async () => {
  const doc = await read('runs/README.md')
  assert.match(doc, new RegExp(SCHEMA_ID.replace('/', '\\/')))
  for (const field of [
    'run_id',
    'agent',
    'model',
    'trigger',
    'started_at',
    'finished_at',
    'status',
    'summary',
    'artifacts',
    'evidence',
    'next_action',
    'session_id',
    'session_url'
  ]) {
    assert.match(doc, new RegExp(`\`${field}\``), `runs/README.md never documents ${field}`)
  }
})
