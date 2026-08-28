import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isArmed,
  armState,
  routineFor,
  validateArming,
  reconcile
} from '../scripts/lib/arm.mjs'
import { loadWorkflows } from '../scripts/lib/workflows.mjs'

/* This file exists because of a specific number. The repo once carried ten workflow files
   declaring a schedule and one real routine, and every board reading those files reported ten jobs
   running, each with a next-run time. Nobody lied. Nothing checked.

   So the tests below are almost all about the middle state - declared - which is the one that
   looks like progress and costs nothing to create. */

const workflow = (slug, trigger, name = slug) => ({
  slug,
  path: `workflows/${slug}.yml`,
  data: { name, owner: 'research', steps: ['do-something'], trigger, output: `inbox/{date}/${slug}.md` }
})

const routine = (name, id = `trig_${name}`) => ({ id, name })

/* ---------- the three states ---------------------------------------------------------------- */

test('armed means the file says run it AND a routine exists', () => {
  const morning = workflow('morning-intel', { schedule: 'daily 06:30', armed: true }, 'Morning Intel')
  assert.equal(armState(morning, [routine('Morning Intel')]), 'armed')
})

test('declared means the file says run it and nothing rings - the whole bug in one word', () => {
  const morning = workflow('morning-intel', { schedule: 'daily 06:30', armed: true }, 'Morning Intel')
  assert.equal(armState(morning, []), 'declared')
})

test('off means deliberately not armed', () => {
  const morning = workflow('morning-intel', { schedule: 'daily 06:30', armed: false, reason: 'no run cap yet' })
  assert.equal(armState(morning, []), 'off')
})

test('a workflow that has never been through /arm is off, not running', () => {
  const untouched = workflow('gone-cold', { schedule: 'daily 09:00' })
  assert.equal(isArmed(untouched), false)
  assert.equal(armState(untouched, []), 'off', 'nothing arms itself by existing')
})

test('an existing routine does not arm a job the file has not approved', () => {
  const untouched = workflow('morning-intel', { schedule: 'daily 06:30' }, 'Morning Intel')
  assert.equal(
    armState(untouched, [routine('Morning Intel')]),
    'off',
    'the file is the record of what was approved - a routine somebody made elsewhere does not change that'
  )
})

/* ---------- matching ------------------------------------------------------------------------- */

test('names match across the spacing and casing a person types on two different days', () => {
  const morning = workflow('morning-intel', { schedule: 'daily 06:30', armed: true }, 'Morning Intel')
  assert.ok(routineFor(morning, [routine('morning   intel')]))
  assert.ok(routineFor(morning, [routine('MORNING INTEL')]))
})

test('a near-miss name is not a match', () => {
  const morning = workflow('morning-intel', { schedule: 'daily 06:30', armed: true }, 'Morning Intel')
  assert.equal(routineFor(morning, [routine('Morning Brief')]), null)
})

/* ---------- what is refused ------------------------------------------------------------------ */

test('a job left off with no reason is refused - silence looks exactly like a mistake later', () => {
  const problems = validateArming(workflow('gone-cold', { schedule: 'daily 09:00', armed: false }))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /no reason/)
})

test('a job that has never been armed also needs its reason', () => {
  const problems = validateArming(workflow('gone-cold', { schedule: 'daily 09:00' }))
  assert.ok(problems.some((problem) => /no reason/.test(problem)))
})

test('an armed job with no schedule is refused - there is nothing for a routine to fire on', () => {
  const problems = validateArming(workflow('gone-cold', { armed: true, fire: true }))
  assert.ok(problems.some((problem) => /declares no schedule/.test(problem)))
})

test('armed must be a boolean, not a string that looks like one', () => {
  const problems = validateArming(workflow('gone-cold', { schedule: 'daily 09:00', armed: 'yes' }))
  assert.ok(problems.some((problem) => /must be true or false/.test(problem)))
})

test('an armed job with a schedule and a routine is sound', () => {
  assert.deepEqual(validateArming(workflow('morning-intel', { schedule: 'daily 06:30', armed: true })), [])
})

/* ---------- reconciling ---------------------------------------------------------------------- */

test('the three lists come back separated, and declared is countable', () => {
  const workflows = [
    workflow('morning-intel', { schedule: 'daily 06:30', armed: true }, 'Morning Intel'),
    workflow('inbox-triage', { schedule: 'daily 08:00', armed: true }, 'Inbox Triage'),
    workflow('gone-cold', { schedule: 'weekly mon 09:00', armed: false, reason: 'no run cap yet' }, 'Gone Cold')
  ]
  const result = reconcile(workflows, [routine('Morning Intel')])

  assert.deepEqual(result.armed.map((w) => w.slug), ['morning-intel'])
  assert.deepEqual(result.declared.map((w) => w.slug), ['inbox-triage'])
  assert.deepEqual(result.off.map((w) => w.slug), ['gone-cold'])
  assert.deepEqual(result.problems, [])
})

test('an armed job carries the routine id; nothing else does', () => {
  const workflows = [
    workflow('morning-intel', { schedule: 'daily 06:30', armed: true }, 'Morning Intel'),
    workflow('inbox-triage', { schedule: 'daily 08:00', armed: true }, 'Inbox Triage')
  ]
  const result = reconcile(workflows, [routine('Morning Intel', 'trig_abc')])
  assert.equal(result.armed[0].routineId, 'trig_abc')
  assert.equal(result.declared[0].routineId, null, 'a declared job has no routine, so it can carry no id')
})

test('a job left off carries its reason into the result', () => {
  const result = reconcile([workflow('gone-cold', { schedule: 'daily 09:00', armed: false, reason: 'nobody reads it' })], [])
  assert.equal(result.off[0].reason, 'nobody reads it')
})

test('a routine with no workflow behind it is an orphan, reported and never adopted', () => {
  const result = reconcile([], [routine('Something Somebody Armed', 'trig_xyz')])
  assert.equal(result.orphans.length, 1)
  assert.equal(result.orphans[0].id, 'trig_xyz')
  assert.equal(result.armed.length, 0, 'an orphan is never quietly attached to a file it does not match')
})

test('reconciling reports arming problems rather than silently sorting past them', () => {
  const result = reconcile([workflow('gone-cold', { schedule: 'daily 09:00', armed: false })], [])
  assert.ok(result.problems.length > 0)
  assert.match(result.problems[0], /no reason/)
})

test('an empty routine list makes everything armed into declared, and says so', () => {
  const workflows = [
    workflow('a', { schedule: 'daily 06:30', armed: true }, 'A'),
    workflow('b', { schedule: 'daily 07:30', armed: true }, 'B'),
    workflow('c', { schedule: 'daily 08:30', armed: true }, 'C')
  ]
  const result = reconcile(workflows, [])
  assert.equal(result.declared.length, 3)
  assert.equal(result.armed.length, 0)
})

/* ---------- the real repo -------------------------------------------------------------------- */

test('every shipped workflow states its arming honestly', async () => {
  const workflows = await loadWorkflows()
  assert.ok(workflows.length > 0)

  const problems = workflows.flatMap((workflow) => validateArming(workflow))
  assert.deepEqual(
    problems,
    [],
    'every shipped job is either armed with a schedule, or off with a written reason - there is no third option'
  )
})

test('nothing ships armed - a fresh clone rings no alarm clocks', async () => {
  const workflows = await loadWorkflows()
  const armed = workflows.filter(isArmed).map((workflow) => workflow.slug)
  assert.deepEqual(
    armed,
    [],
    `a template that arrives armed spends a student's runs before they have agreed to anything, got ${armed}`
  )
})
