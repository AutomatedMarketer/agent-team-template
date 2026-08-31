import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fromRoot, read } from './helpers/repo.mjs'
import { validateRunLog, runIdFor, monthFolderFor, isMonthFolder, runLogFiles, SCHEMA_ID } from '../scripts/lib/run-log.mjs'

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

/* ---------- a field nothing reads ---------------------------------------------------------------
   A run log is written by an agent at the end of a run, and nobody re-reads it. The dashboard,
   the weekly review and the quality count all read this file rather than the session, so a name
   the schema does not know is silently lost work.

   `session_link` for `session_url` is the one that costs something visible: the run appears on
   the board with no transcript to open, which is the single link the board exists to give you.
   This is the same defect as the ledger's `hours:` - a value accepted, read by nothing - one
   file along, and it was recorded as such by the walkthrough before it was fixed. */

test('a field the schema does not know is refused, not ignored', async () => {
  const entry = await fixture('valid-schedule.json')
  const problems = validateRunLog({ ...entry, wibble: 1 }, { filename: `${entry.run_id}.json` })
  assert.ok(
    problems.some((problem) => problem.includes('"wibble"')),
    `an invented field passed clean: ${problems.join('; ') || 'no problems at all'}`
  )
})

test('a near miss is told which field it meant', async () => {
  const entry = await fixture('valid-schedule.json')
  for (const [wrong, right] of [
    ['session_link', 'session_url'],
    ['workflow_slug', 'workflow'],
    ['output', 'artifacts'],
    ['next_steps', 'next_action']
  ]) {
    const problems = validateRunLog({ ...entry, [wrong]: 'x' }, { filename: `${entry.run_id}.json` })
    const named = problems.find((problem) => problem.includes(`"${wrong}"`))
    assert.ok(named, `${wrong} was accepted`)
    assert.ok(
      named.includes(right),
      `"${wrong}" was refused without saying it meant ${right}, which sends someone hunting ` +
        `through the schema for a word they already had: ${named}`
    )
  }
})

test('the check does not fire on any field the schema really has', async () => {
  const entry = await fixture('valid-schedule.json')
  assert.deepEqual(
    validateRunLog(entry, { filename: `${entry.run_id}.json` }),
    [],
    'a valid run log gained a problem - the allowlist is missing a real field'
  )
})

/* `runs/` holds a month folder per month AND `runs/heartbeat/`, which holds a completely different
   kind of file - one liveness ping per runtime, `{ "runtime": ..., "at": ... }`, read by the
   cockpit's Connections rail and pointed at from runtimes.yml.

   The validator walked every directory under runs/, so a correctly written heartbeat was read as a
   run log and reported sixteen problems. It fired the moment a student registered a runtime, which
   Lesson 12 walks them through, against the very command onboard phase 12 and /audit tell them to
   run. It never fired in this repo because the shipped runs/heartbeat/ holds only a README. */

test('a heartbeat folder is not mistaken for a month of runs', () => {
  assert.equal(isMonthFolder('heartbeat'), false, 'runs/heartbeat/ would be validated as run logs')
  assert.equal(isMonthFolder('2026-08'), true, 'a real month folder was skipped')
})

test('only a real month is a month', () => {
  for (const name of ['2026-08', '1999-01', '2026-12']) {
    assert.equal(isMonthFolder(name), true, `${name} should be a month folder`)
  }
  for (const name of [
    'heartbeat',
    'archive',
    '2026-13',
    '2026-00',
    '2026-8',
    '2026-08-07',
    'runs',
    '',
    undefined
  ]) {
    assert.equal(isMonthFolder(name), false, `${name} was treated as a month folder`)
  }
})

test('the file walk skips the heartbeat folder against a real directory', async () => {
  const { mkdtemp, mkdir, writeFile, readdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const runs = join(await mkdtemp(join(tmpdir(), 'runs-')), 'runs')
  await mkdir(join(runs, '2026-08'), { recursive: true })
  await mkdir(join(runs, 'heartbeat'), { recursive: true })
  await writeFile(join(runs, '2026-08', '2026-08-07T0600Z-research.json'), '{}')
  await writeFile(join(runs, 'heartbeat', 'hermes.json'), '{"runtime":"hermes","at":"x"}')
  await writeFile(join(runs, 'README.md'), '# runs')

  assert.deepEqual(
    await runLogFiles(runs, { readdir }),
    ['runs/2026-08/2026-08-07T0600Z-research.json'],
    'the walk picked up something that is not a run log - a heartbeat validates as sixteen problems'
  )
})

/* The same bug had a second home. `scripts/check-verdicts.mjs` kept its own recursive sweep of
   runs/ to collect run ids, which descended into runs/heartbeat/ exactly like the walk above used
   to. It survives a heartbeat today only because a heartbeat has no `run_id` and so filters out -
   an accident of what heartbeats currently hold, not a guard, and precisely how the first one hid.

   This is a source-shape guard rather than a behavioural one, and that is worth saying out loud:
   check-verdicts reads verdicts from the repo root but runs/ from the working directory, so it
   cannot be pointed at a temp repo - with no verdicts in the real repo it exits before the sweep
   is ever reached. The walk itself IS covered behaviourally, by the temp-directory test above.
   What this adds is that check-verdicts keeps using that walk instead of growing another one. */

test('check-verdicts does not keep its own sweep of runs/', async () => {
  const source = await read('scripts/check-verdicts.mjs')

  assert.ok(
    /runLogFiles\(\s*'runs'/.test(source),
    'check-verdicts no longer collects run ids through the shared month-aware walk'
  )
  assert.ok(
    !/listOrNull\(\s*'runs'/.test(source),
    'check-verdicts has grown back its own recursive sweep of runs/, which reads heartbeats as runs'
  )
})
