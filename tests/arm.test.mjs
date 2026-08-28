import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isArmed,
  armState,
  routineFor,
  validateArming,
  reconcile,
  readSnapshot,
  SNAPSHOT_STALE_AFTER_HOURS
} from '../scripts/lib/arm.mjs'
import { loadWorkflows } from '../scripts/lib/workflows.mjs'

/* This file exists because of a specific number, and the number is NINE. The repo carries nine
   workflow files declaring a schedule against one real routine, and every board reading those
   files reported nine jobs running, each with a next-run time. Nobody lied. Nothing checked.

   It said "ten" here for a while, which is the same disease in miniature: a number written down
   that nobody counted. Counted now - `ls workflows/*.yml | wc -l` is 9, and has never been more.

   So the tests below are mostly about the two states that cost something - `declared`, which
   looks like progress and costs nothing to create, and `unapproved`, which costs real money
   quietly. */

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

/* The file is the record of what was approved, so a routine somebody made elsewhere does not arm
   the job. But it does not leave it quiet either - it is spending runs nobody agreed to, and for
   a while it was reported as `off` with no problem raised and no mention of the live routine
   anywhere. The read-back said "0 jobs armed, spending 0 runs a week" while an alarm rang daily.
   A check that can only see over-claiming is half a check. */

test('a routine that rings against a file saying off is UNAPPROVED, not quiet', () => {
  const untouched = workflow('morning-intel', { schedule: 'daily 06:30' }, 'Morning Intel')
  assert.equal(armState(untouched, [routine('Morning Intel')]), 'unapproved')
})

test('unapproved spend is reported as a problem and names the routine doing it', () => {
  const untouched = workflow('morning-intel', { schedule: 'daily 06:30', armed: false, reason: 'no run cap yet' }, 'Morning Intel')
  const result = reconcile([untouched], [routine('Morning Intel', 'trig_live')])

  assert.equal(result.off.length, 0, 'it is not quiet - something is firing')
  assert.equal(result.unapproved.length, 1)
  assert.equal(result.unapproved[0].routineId, 'trig_live', 'name the alarm clock that is spending the money')
  assert.ok(result.problems.some((problem) => /nobody approved/.test(problem)))
})

test('the live routine is not also reported as an orphan - it matched a file', () => {
  const untouched = workflow('morning-intel', { schedule: 'daily 06:30', armed: false, reason: 'no run cap yet' }, 'Morning Intel')
  const result = reconcile([untouched], [routine('Morning Intel')])
  assert.deepEqual(result.orphans, [])
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
  // A wish is a problem now: inbox-triage says run it and nothing rings.
  assert.equal(result.problems.length, 1)
  assert.match(result.problems[0], /nothing rings/)
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

/* ---------- duplicates ----------------------------------------------------------------------- */

test('two routines sharing a name are reported - they all fire, and the spend multiplies', () => {
  const morning = workflow('morning-intel', { schedule: 'daily 06:30', armed: true }, 'Morning Intel')
  const result = reconcile([morning], [routine('Morning Intel', 'trig_a'), routine('Morning Intel', 'trig_b')])
  assert.ok(result.problems.some((problem) => /2 routines share this name/.test(problem)))
})

test('two workflow files sharing a name are reported - one alarm cannot belong to both', () => {
  const a = workflow('morning-intel', { schedule: 'daily 06:30', armed: true }, 'Morning Intel')
  const b = workflow('morning-intel-copy', { schedule: 'daily 07:30', armed: true }, 'Morning Intel')
  const result = reconcile([a, b], [routine('Morning Intel')])
  assert.ok(result.problems.some((problem) => /share this name/.test(problem)))
})

/* ---------- surviving mutants ----------------------------------------------------------------- */

/* Both of these were mutation-tested and survived: nothing asserted that a matched routine is
   absent from orphans, and nothing asserted routineId is null on a row with no routine. */

test('a matched routine is claimed, so it never appears as an orphan', () => {
  const morning = workflow('morning-intel', { schedule: 'daily 06:30', armed: true }, 'Morning Intel')
  const result = reconcile([morning], [routine('Morning Intel')])
  assert.equal(result.armed.length, 1)
  assert.deepEqual(result.orphans, [], 'a routine cannot be both matched and unclaimed')
})

test('an off row with no routine behind it carries no routine id', () => {
  const quiet = workflow('gone-cold', { schedule: 'daily 09:00', armed: false, reason: 'nobody reads it' })
  const result = reconcile([quiet], [])
  assert.equal(result.off[0].routineId, null)
})

/* ---------- reconcile survives hostile input --------------------------------------------------- */

test('a null workflow, a null routine and a non-list do not throw', () => {
  assert.doesNotThrow(() => reconcile([null, undefined], [null]))
  assert.doesNotThrow(() => reconcile(null, null))
  assert.doesNotThrow(() => reconcile('not a list', 42))
})

/* ---------- the snapshot ------------------------------------------------------------------------ */

/* A snapshot presented as live is the same class of lie as a job claiming a schedule nothing
   fires. These are the cases where that lie was previously available. */

test('an absent snapshot says nothing is KNOWN, never that nothing is scheduled', () => {
  const snap = readSnapshot(null)
  assert.equal(snap.missing, true)
  assert.deepEqual(snap.routines, [])
  assert.match(snap.reason, /no snapshot/)
})

test('a corrupt snapshot is not the same as an absent one', () => {
  const snap = readSnapshot('{ not json at all')
  assert.equal(snap.unreadable, true)
  assert.equal(snap.missing, true, 'and it must never be read as "nothing is scheduled"')
})

test('a snapshot with no routines list is unreadable, not empty', () => {
  assert.equal(readSnapshot('{"takenAt":"2026-08-27T10:00:00Z"}').unreadable, true)
})

test('a snapshot with no takenAt is served, but never as current', () => {
  const snap = readSnapshot('{"routines":[{"id":"a","name":"A"}]}')
  assert.equal(snap.routines.length, 1, 'the data is still the best available')
  assert.equal(snap.unstamped, true)
  assert.match(snap.reason, /when it was taken/)
})

test('an old snapshot is stale and says how old', () => {
  const now = Date.parse('2026-08-27T12:00:00Z')
  const old = readSnapshot('{"takenAt":"1999-01-01T00:00:00Z","routines":[]}', now)
  assert.equal(old.stale, true)
  assert.match(old.reason, /years ago|months ago/, 'a person cannot read 242426 hours')
})

test('a fresh snapshot is not stale and carries no complaint', () => {
  const now = Date.parse('2026-08-27T12:00:00Z')
  const fresh = readSnapshot(`{"takenAt":"2026-08-27T11:00:00Z","routines":[]}`, now)
  assert.equal(fresh.stale, false)
  assert.equal(fresh.reason, null)
  assert.ok(fresh.ageHours < SNAPSHOT_STALE_AFTER_HOURS)
})

test('a takenAt that is not a date is treated as no stamp at all', () => {
  assert.equal(readSnapshot('{"takenAt":"soon","routines":[]}').unstamped, true)
})

/* ---------- the snapshot cannot be trusted into a claim ---------------------------------------- */

/* An unusable snapshot produced an empty routine list, so every armed job came back `declared` and
   the tool reported nine wishes it had no evidence for — while printing a banner saying it could
   only read the files. It asserted the exact class of thing it exists to catch. */

test('with the routines unknown, nothing is called armed or declared', () => {
  const workflows = [
    workflow('morning-intel', { schedule: 'daily 06:30', armed: true }, 'Morning Intel'),
    workflow('gone-cold', { schedule: 'daily 09:00', armed: false, reason: 'no run cap yet' }, 'Gone Cold')
  ]
  const result = reconcile(workflows, [], { routinesKnown: false })

  assert.deepEqual(result.armed, [])
  assert.deepEqual(result.declared, [], 'nothing rings is a CLAIM, and there is no evidence for it')
  assert.deepEqual(result.unapproved, [])
  assert.deepEqual(result.unknown.map((w) => w.slug), ['morning-intel'])
  assert.deepEqual(result.off.map((w) => w.slug), ['gone-cold'], 'the file still decides this one')
})

test('with the routines unknown, no orphan is asserted either', () => {
  const result = reconcile([], [routine('Something')], { routinesKnown: false })
  assert.deepEqual(result.orphans, [])
})

test('a declared job is a problem, so the check cannot pass with wishes in it', () => {
  const wish = workflow('morning-intel', { schedule: 'daily 06:30', armed: true }, 'Morning Intel')
  const result = reconcile([wish], [])
  assert.equal(result.declared.length, 1)
  assert.ok(result.problems.some((problem) => /nothing rings/.test(problem)))
})

/* ---------- an impossible stamp -------------------------------------------------------------- */

/* Left alone this produced the worst possible answer: ageHours goes negative, the staleness test
   passes, and a file stamped 2099 reads as the most current snapshot imaginable. */

test('a snapshot stamped in the future is refused, not treated as the freshest possible', () => {
  const now = Date.parse('2026-08-27T12:00:00Z')
  const snap = readSnapshot('{"takenAt":"2099-01-01T00:00:00Z","routines":[]}', now)
  assert.equal(snap.impossible, true)
  assert.equal(snap.missing, true, 'it must not be usable as evidence')
  assert.notEqual(snap.stale, false, 'and it must never read as fresh')
  assert.match(snap.reason, /future/)
})

test('an age is rendered in something a person reads', () => {
  const now = Date.parse('2026-08-27T12:00:00Z')
  const ancient = readSnapshot('{"takenAt":"1999-01-01T00:00:00Z","routines":[]}', now)
  assert.doesNotMatch(ancient.reason, /\d{5,} hours/, '242426 hours is noise, not a number')
  assert.match(ancient.reason, /years|months/)
})

/* ---------- mutants that survived, now pinned -------------------------------------------------- */

test('armed must be exactly true - a truthy string does not arm a job', () => {
  assert.equal(isArmed(workflow('x', { schedule: 'daily 06:30', armed: 'yes' })), false)
  assert.equal(isArmed(workflow('x', { schedule: 'daily 06:30', armed: 1 })), false)
  assert.equal(isArmed(workflow('x', { schedule: 'daily 06:30', armed: true })), true)
})

test('a workflow with no name falls back to its slug when matching a routine', () => {
  const unnamed = { slug: 'morning-intel', path: 'workflows/morning-intel.yml', data: { trigger: { armed: true, schedule: 'daily 06:30' } } }
  assert.ok(routineFor(unnamed, [routine('morning-intel')]), 'the slug is the only name it has')
})

test('names match through surrounding whitespace', () => {
  const morning = workflow('morning-intel', { schedule: 'daily 06:30', armed: true }, '  Morning Intel  ')
  assert.ok(routineFor(morning, [routine('Morning Intel')]))
})

test('names match through unicode composition - Cafe and Café are the same name', () => {
  const composed = workflow('cafe', { schedule: 'daily 06:30', armed: true }, 'Café Report')
  assert.ok(
    routineFor(composed, [routine('Café Report')]),
    'a decomposed name would report declared AND leave an orphan for one correctly armed job'
  )
})
