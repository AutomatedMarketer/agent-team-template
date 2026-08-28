import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, cp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

/* `check-arming` printed:

       10 jobs off, with a written reason
       ...
       - Monday Brief: is not armed and carries no reason

   Ten, with a written reason - and four lines below, one of those ten named as having none. A
   summary line asserting something its own detail contradicts is the exact defect this script
   exists to find, printed by the script itself. The count has to exclude what it cannot credit. */

async function armingOutput(extraWorkflow) {
  const scratch = await mkdtemp(join(tmpdir(), 'arming-summary-'))
  for (const dir of ['scripts', 'workflows', '.agent-team']) {
    await cp(join(root, dir), join(scratch, dir), { recursive: true }).catch(() => {})
  }
  if (extraWorkflow) {
    await writeFile(join(scratch, 'workflows', 'scratch-job.yml'), extraWorkflow)
  }
  // The summary goes to stdout and the fix list goes to stderr. Reading only one of them is how
  // you convince yourself a contradiction between the two does not exist.
  try {
    const { stdout, stderr } = await run(process.execPath, ['scripts/check-arming.mjs'], { cwd: scratch })
    return { stdout: [stdout, stderr].join(String.fromCharCode(10)), code: 0, scratch }
  } catch (error) {
    return { stdout: [error.stdout ?? '', error.stderr ?? ''].join(String.fromCharCode(10)), code: error.code ?? 1, scratch }
  }
}

const REASONLESS = [
  'name: Reasonless',
  'owner: research',
  'steps: [scan-market]',
  'trigger:',
  '  schedule: "daily 06:00"',
  'output: inbox/reasonless.md',
  ''
].join('\n')

test('the summary never credits a written reason to a job that has none', async () => {
  const clean = await armingOutput(null)
  await rm(clean.scratch, { recursive: true, force: true })
  const baseline = /^\s*(\d+) jobs? off, with a written reason/m.exec(clean.stdout)
  assert.ok(baseline, `no summary line in a clean repo:\n${clean.stdout}`)

  const dirty = await armingOutput(REASONLESS)
  await rm(dirty.scratch, { recursive: true, force: true })

  assert.match(dirty.stdout, /is not armed and carries no reason/,
    'the fixture should have produced a reasonless job')

  const credited = /^\s*(\d+) jobs? off, with a written reason/m.exec(dirty.stdout)
  assert.ok(credited, `no summary line with a reasonless job present:\n${dirty.stdout}`)
  assert.equal(credited[1], baseline[1],
    `adding a job with NO reason moved the "with a written reason" count from ${baseline[1]} to ${credited[1]}`)

  assert.match(dirty.stdout, /no reason/i,
    'the reasonless job is credited nowhere and counted nowhere - it is simply missing from the totals')
})

test('a job with no reason still fails the check', async () => {
  const dirty = await armingOutput(REASONLESS)
  await rm(dirty.scratch, { recursive: true, force: true })
  assert.notEqual(dirty.code, 0, 'a reasonless job must not exit clean')
})

/* Lesson 10 builds a webhook: a routine with NO schedule, fired by an inbound request. `/arm`
   cannot create it - `arm/SKILL.md` passes `schedule:` on every create, and `validateArming`
   rejects `armed: true` with no schedule outright. So the one routine in the whole course a
   student genuinely has to make by hand is also the one the arming model has no room for.

   The result: their webhook workflow is demanded a `reason:` for being "off" when it is not off
   at all, it is live and waiting - and Lesson 17 teaches them that an unmatched routine means
   "somebody armed something that has since been renamed or removed. Report it, do not adopt it."
   The course manufactures the exact artifact it teaches them to treat as a fault. */

test('a webhook job is not demanded a reason for being off - it is not off', async () => {
  const { validateArming } = await import('../scripts/lib/arm.mjs')
  const webhook = {
    slug: 'answer-a-question',
    data: { name: 'Answer a question', trigger: { webhook: true } }
  }
  assert.deepEqual(validateArming(webhook), [],
    'a webhook job has no schedule to be off from, and being asked for a reason is nonsense')
})

test('a scheduled job with no reason is still refused - the exemption is webhooks only', async () => {
  const { validateArming } = await import('../scripts/lib/arm.mjs')
  const scheduled = { slug: 'x', data: { name: 'X', trigger: { schedule: 'daily 06:00' } } }
  assert.equal(validateArming(scheduled).length, 1,
    'the webhook exemption must not let ordinary scheduled jobs through without a reason')
})

test('a webhook routine is recognised, not reported as an orphan somebody should delete', async () => {
  const { reconcile } = await import('../scripts/lib/arm.mjs')
  const result = reconcile(
    [{ slug: 'answer-a-question', data: { name: 'Answer a question', trigger: { webhook: true } } }],
    [{ id: 'r1', name: 'Answer a question' }],
    { routinesKnown: true }
  )
  assert.deepEqual(result.orphans, [],
    'the webhook routine the course tells them to build was reported as something to report and not adopt')
})
