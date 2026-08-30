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

async function armingOutput(extraWorkflow, options = {}) {
  const scratch = await mkdtemp(join(tmpdir(), 'arming-summary-'))
  for (const dir of ['scripts', 'workflows', '.agent-team']) {
    if (options.dropSnapshot && dir === '.agent-team') continue
    await cp(join(root, dir), join(scratch, dir), { recursive: true }).catch(() => {})
  }
  if (extraWorkflow) {
    await writeFile(join(scratch, 'workflows', 'scratch-job.yml'), extraWorkflow)
  }
  // proposals.yml is not one of the copied directories, so a scratch repo has none unless a test
  // asks for one. That is itself a case worth running: no proposals file means approval is
  // UNKNOWN, not granted.
  if (options.proposals !== undefined) {
    await writeFile(join(scratch, 'proposals.yml'), options.proposals)
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

test('a scheduled job with no reason is still refused - the exemption is jobs with no clock', async () => {
  const { validateArming } = await import('../scripts/lib/arm.mjs')
  const scheduled = { slug: 'x', data: { name: 'X', trigger: { schedule: 'daily 06:00' } } }
  assert.equal(validateArming(scheduled).length, 1,
    'the clockless exemption must not let ordinary scheduled jobs through without a reason')
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

/* The webhook exemption was added to `arm.mjs` and the REPORTER was not touched. So one run
   printed both "1 job off with no reason written down - counted here, credited nowhere" and
   "Every job is either armed, or off with a reason somebody wrote down." Two contradictory
   sentences about the same job, in the same output, from the command whose whole purpose is
   catching a claim its own detail contradicts. Twice now. */

const WEBHOOK = [
  'name: Answer a question',
  'owner: customer-service',
  'steps: [answer-question]',
  'trigger:',
  '  webhook: true',
  'output: inbox/answers.md',
  ''
].join('\n')

/* Lesson 10 tells the student to write `webhook: true` + `armed: true`, then quotes what
   check:arming will say about it. It quoted the "fired by webhook - no clock" line, which is
   emitted only for webhook rows in the OFF bucket - and a webhook whose routine exists with
   `armed: true` is in the ARMED bucket, so that line never printed for the configuration the
   lesson prescribes. These two pin the states apart so the lesson's quote stays checkable. */

test('an armed webhook with a live routine lands in armed, not off', async () => {
  const { reconcile } = await import('../scripts/lib/arm.mjs')
  const result = reconcile(
    [{ slug: 'answer-a-question', data: { name: 'Answer a question', trigger: { webhook: true, armed: true } } }],
    [{ id: 'r1', name: 'Answer a question' }],
    { routinesKnown: true }
  )
  assert.equal(result.armed.length, 1, 'the working webhook configuration is not reported as armed')
  assert.equal(result.off.length, 0, 'a live webhook was filed as off, where the no-clock line lives')
  assert.deepEqual(result.problems, [], 'the configuration the lesson prescribes was flagged as a problem')
})

test('an unarmed webhook with no routine is the one that is off', async () => {
  const { reconcile } = await import('../scripts/lib/arm.mjs')
  const result = reconcile(
    [{ slug: 'answer-a-question', data: { name: 'Answer a question', trigger: { webhook: true, armed: false } } }],
    [],
    { routinesKnown: true }
  )
  assert.equal(result.off.length, 1, 'the off-webhook state the no-clock line describes is gone')
  assert.equal(result.armed.length, 0)
})

test('a webhook job is not shamed for a reason it was never asked for', async () => {
  const run = await armingOutput(WEBHOOK)
  await rm(run.scratch, { recursive: true, force: true })
  assert.ok(!/no reason written down/.test(run.stdout),
    'the exempt webhook job was counted among the ones missing a reason')
})

test('the closing sentence stays true when a webhook job is present', async () => {
  const run = await armingOutput(WEBHOOK)
  await rm(run.scratch, { recursive: true, force: true })
  if (/Every job is either armed, or off with a reason/.test(run.stdout)) {
    assert.ok(!/no reason written down/.test(run.stdout),
      'it claims every job has a reason in the same breath as counting one that does not')
  }
  assert.match(run.stdout, /webhook/i,
    'a webhook job is reported as nothing at all - it is neither armed, nor off, nor named')
})

/* With no usable snapshot, the command says "whether anything rings is UNKNOWN" - and then, four
   lines later, "Every job is either armed, or off with a reason somebody wrote down." It asserts
   the job IS armed immediately after saying it cannot know. Same output, same job, opposite
   claims. Third time this file has contradicted itself; the closing line is unconditional and
   the branch above it is not.

   It also let the D3.1 exit test - "check:arming exits clean for everyone" - pass vacuously on a
   repo where nothing is known to ring. */

test('with no snapshot, the closing line does not claim to know what it just said it cannot', async () => {
  const armed = [
    'name: Wishful',
    'owner: research',
    'steps: [scan-market]',
    'trigger:',
    '  schedule: "daily 06:30"',
    '  armed: true',
    'output: inbox/x.md',
    ''
  ].join(String.fromCharCode(10))

  const run = await armingOutput(armed, { dropSnapshot: true })
  await rm(run.scratch, { recursive: true, force: true })

  assert.match(run.stdout, /UNKNOWN/, 'the fixture should have produced an unknown state')
  assert.ok(!/Every job is either armed, or off with a reason/.test(run.stdout),
    'it claimed every job is armed or off, in the same output as saying it cannot tell which')
})

/* ---------- the approval gate, through the real script ---------------------------------------

   arm.test.mjs proves the function. This proves the WIRING, which is where the lesson-14 bug
   actually lived: a guard whose predicate was right and whose plumbing matched nothing, printing
   nothing, reading exactly like a clean repo. */

const ARMED_UNAPPROVED = [
  'name: Scratch Job',
  'owner: research',
  'steps: [scan-market]',
  'trigger:',
  '  schedule: "daily 06:00"',
  '  armed: true',
  'output: inbox/scratch.md',
  ''
].join('\n')

test('check:arming refuses an armed job that proposals.yml does not approve', async () => {
  const result = await armingOutput(ARMED_UNAPPROVED, { proposals: 'proposals:\n\ngaps:\n' })
  await rm(result.scratch, { recursive: true, force: true })
  assert.notEqual(result.code, 0, `an unapproved armed job must not exit clean:\n${result.stdout}`)
  assert.match(result.stdout, /Scratch Job: is armed, but nothing in proposals\.yml approves it/)
})

test('check:arming accepts the same job once its owner is approved', async () => {
  const approved = [
    'proposals:',
    '  - task: Keeping an eye on the market',
    '    item: agent:research',
    '    why: "it is the agent that does the looking up"',
    '    words: "I read the trade press every morning"',
    '    number: "1 hour a week"',
    ''
  ].join('\n')
  const result = await armingOutput(ARMED_UNAPPROVED, { proposals: approved })
  await rm(result.scratch, { recursive: true, force: true })
  assert.doesNotMatch(result.stdout, /nothing in proposals\.yml approves it/,
    `approving agent:research should have covered a job it owns:\n${result.stdout}`)
})

test('with no proposals.yml at all, approval is reported UNKNOWN rather than assumed', async () => {
  const result = await armingOutput(ARMED_UNAPPROVED)
  await rm(result.scratch, { recursive: true, force: true })
  assert.match(result.stdout, /whether they were approved is UNKNOWN/,
    `an absent file is not evidence of approval:\n${result.stdout}`)
  assert.doesNotMatch(result.stdout, /nothing in proposals\.yml approves it/,
    'a missing file must not be reported as a refusal - those are different claims')
})

/* A dashboard button is clockless for exactly the reason a webhook is, and the exemption named
   only webhooks. workflows.mjs accepts "at least one of: schedule, fire, webhook", so a button-only
   job is a LEGAL file that the arming check then failed twice - once for carrying no reason, once
   for being "armed but declares no schedule". A validator rejecting what its own sibling accepts
   is a defect whether or not anyone has tripped on it; every course example pairs `fire` with a
   `schedule`, which is the only reason no reader has. */
test('a dashboard-button job is not demanded a reason for being off - it is not off', async () => {
  const { validateArming } = await import('../scripts/lib/arm.mjs')
  const button = { slug: 'b', data: { name: 'Run it now', trigger: { fire: true } } }
  assert.deepEqual(validateArming(button), [],
    'a button job has no schedule to be off from, and being asked for a reason is nonsense')
})

/* Both clockless kinds can be armed, and getting this wrong once is why the comment in arm.mjs
   is long. A dashboard button looked like it had no routine behind it. It has one:
   12_COCKPIT.md's FIRE_TRIGGERS maps each slug to "its routine's trigger link", copied from
   claude.ai/code, and agent-cockpit fires that URL. Exempting only webhooks meant a student who
   wired a button exactly as Lesson 12 says got "1 job armed - a routine exists" and "is armed but
   declares no schedule" in one run about one job. */
test('an armed clockless job is allowed no schedule - its routine is real', async () => {
  const { validateArming } = await import('../scripts/lib/arm.mjs')
  for (const trigger of [{ webhook: true, armed: true }, { fire: true, armed: true }]) {
    assert.deepEqual(validateArming({ slug: 'j', data: { name: 'Job', trigger } }), [],
      `an armed ${trigger.fire ? 'button' : 'webhook'} job has a routine - demanding a schedule denies it`)
  }
})

// The rule still has to refuse the thing it was written for.
test('an armed job with no clock at all is still refused', async () => {
  const { validateArming } = await import('../scripts/lib/arm.mjs')
  const nothing = { slug: 'n', data: { name: 'Nothing', trigger: { armed: true } } }
  assert.ok(validateArming(nothing).some((problem) => /declares no schedule/.test(problem)),
    'no schedule, no webhook, no button - nothing could have created that routine')
})

/* The two halves have to agree about the same job. When the webhook exemption went into arm.mjs
   and this reporter was not touched, one run printed both "1 job off with no reason written down"
   and "Every job is either armed, or off with a reason somebody wrote down" - two contradictory
   sentences about one job, from the command whose whole purpose is catching that. The button case
   was the same trap set again. */
test('the reporter and the validator agree about a clockless job', async () => {
  const { reconcile, validateArming } = await import('../scripts/lib/arm.mjs')
  for (const trigger of [{ webhook: true }, { fire: true }]) {
    const workflow = { slug: 'j', path: 'workflows/j.yml', data: { name: 'Job', trigger } }
    assert.deepEqual(validateArming(workflow), [], 'the validator must not ask this job for a reason')
    const result = reconcile([workflow], [], { routinesKnown: true })
    assert.deepEqual(result.problems, [], 'the reporter must not raise a problem the validator does not')
    const [row] = result.off
    assert.ok(
      (row.webhook === true || row.fire === true) && !row.schedule,
      'the row must carry enough for the reporter to count it apart from jobs that owe a reason'
    )
  }
})

/* Exiting 0 with no snapshot is deliberate - a fresh clone has not run /routines yet. But three
   checklist boxes in Lesson 17 LOOK ticked by that run and were never judged: without a snapshot
   nothing is ever CALLED declared, so "declared is empty" is empty because nothing was compared.
   A student ticks the box believing it was checked. The command has to say so itself. */
test('with no snapshot, check:arming names the boxes it could not judge', async () => {
  const { stdout } = await run(process.execPath, ['scripts/check-arming.mjs'], { cwd: root })
  assert.match(stdout, /could not judge/i, 'a clean exit with no data must not read as a clean check')
  for (const box of ['declared is empty', 'unapproved is empty', 'exits without complaining']) {
    assert.ok(stdout.includes(box), `the unjudgeable box "${box}" is not named in the output`)
  }
})
