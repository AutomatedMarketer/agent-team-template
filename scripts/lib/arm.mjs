import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Two lists that have never met: what workflows/*.yml declares, and what the routines API says
// actually exists. Comparing them is the whole point of this file.
//
// This repo carries NINE workflow files declaring a schedule, against one real routine. Every board
// reading those files reported nine jobs running, each with a next-run time, because a file that
// says `schedule:` looks exactly like a job that runs. Nobody lied; nothing checked.
//
// (It was written as "ten" here for a while, which is its own small version of the same disease.
// A file that says a number nobody counted is the thing this module exists to catch.)
//
// A job is in one of FOUR states, and the two middle ones are the bugs:
//
//   armed       the file says run it, and a routine exists
//   declared    the file says run it, and NOTHING rings          - a wish
//   unapproved  a routine RINGS, and the file says it is off     - spend nobody approved
//   off         deliberately not armed, and nothing rings
//
// `unapproved` was missing for a while, and its absence was the same bug pointing the other way:
// a routine firing every morning, matched to a file saying `armed: false`, appeared in no list at
// all. The read-back said "0 jobs armed, spending 0 runs a week" while runs were being spent
// daily. A board that can only see over-claiming is half a check.
//
// `armed:` defaults to false. A workflow that has never been through /arm is off, not running,
// which is the safe direction and means nothing arms itself by existing.

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const SNAPSHOT = '.agent-team/routines.json'

export const ARM_STATES = ['armed', 'declared', 'unapproved', 'off']

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

// Names are compared case- and spacing-insensitively because one side is typed into a yaml file by
// a person and the other is typed into a web form by the same person on a different day.
function nameKey(value) {
  return textOf(value).toLowerCase().replace(/\s+/g, ' ')
}

export function isArmed(workflow) {
  return workflow?.data?.trigger?.armed === true
}

export function reasonFor(workflow) {
  return textOf(workflow?.data?.trigger?.reason)
}

// The snapshot is how the truth reaches anything that cannot call the routines API — which is
// everything except a Claude Code session. The dashboard is a web app reading GitHub; it has no
// way to ask the API what is scheduled.
//
// It carries the moment it was taken, and every reader is expected to say so. A stale snapshot
// must read as stale. A snapshot presented as live is the same class of lie as a declared job.
// How stale is too stale to be worth trusting. A day: routines fire on schedules measured in
// hours, so a snapshot older than this has almost certainly missed something.
export const SNAPSHOT_STALE_AFTER_HOURS = 24

export function readSnapshot(source, now = Date.now()) {
  if (source === null || source === undefined) {
    return { takenAt: null, routines: [], missing: true, reason: 'no snapshot has been taken yet' }
  }

  let parsed
  try {
    parsed = JSON.parse(source)
  } catch {
    // Corrupt is NOT the same as absent. Returning an empty routine list for an unreadable file
    // asserts "nothing is scheduled", which is a claim about somebody's account that a broken
    // file cannot support - the exact class of lie this module exists to catch.
    return { takenAt: null, routines: [], missing: true, unreadable: true, reason: 'the snapshot file could not be read' }
  }

  const routines = Array.isArray(parsed?.routines) ? parsed.routines : null
  if (!routines) {
    return { takenAt: null, routines: [], missing: true, unreadable: true, reason: 'the snapshot has no routines list' }
  }

  const takenAt = textOf(parsed?.takenAt) || null
  const takenMs = takenAt ? Date.parse(takenAt) : NaN
  if (!takenAt || Number.isNaN(takenMs)) {
    // Written without a stamp. It may be perfectly accurate, and there is no way to know - so it
    // is served, and it is served as unusable-as-evidence rather than as current.
    return { takenAt: null, routines, missing: true, unstamped: true, reason: 'the snapshot does not say when it was taken' }
  }

  const ageHours = (now - takenMs) / 3600_000
  return {
    takenAt,
    routines,
    ageHours,
    stale: ageHours > SNAPSHOT_STALE_AFTER_HOURS,
    reason: ageHours > SNAPSHOT_STALE_AFTER_HOURS
      ? `the snapshot is ${Math.round(ageHours)} hours old`
      : null
  }
}

export async function loadRoutineSnapshot(root = repoRoot, now = Date.now()) {
  let source = null
  try {
    source = await readFile(path.join(root, SNAPSHOT), 'utf8')
  } catch {
    source = null
  }
  return readSnapshot(source, now)
}

export function routineFor(workflow, routines) {
  const wanted = nameKey(workflow?.data?.name) || nameKey(workflow?.slug)
  if (!wanted) return null
  return (routines ?? []).find((routine) => nameKey(routine?.name) === wanted) ?? null
}

export function armState(workflow, routines) {
  const ringing = Boolean(routineFor(workflow, routines))
  if (!isArmed(workflow)) return ringing ? 'unapproved' : 'off'
  return ringing ? 'armed' : 'declared'
}

// Returns human-readable problems, the same contract as validateWorkflow and validateLedger.
export function validateArming(workflow) {
  const problems = []
  const trigger = workflow?.data?.trigger
  const name = textOf(workflow?.data?.name) || workflow?.slug || 'a workflow'

  const armed = trigger?.armed
  if (armed !== undefined && typeof armed !== 'boolean') {
    problems.push(`${name}: trigger.armed must be true or false`)
  }

  // Nothing is deleted here, ever. A job that is off keeps its file and gains a reason, so that
  // six weeks later the silence is a decision somebody made rather than something that looks
  // exactly like a mistake.
  if (armed !== true && !reasonFor(workflow)) {
    problems.push(
      `${name}: is not armed and carries no reason - say what would have to change for it to be worth a run`
    )
  }

  // You cannot arm what has no time attached. An armed job with no schedule is a routine nobody
  // could have created, which means the flag is describing something that does not exist.
  if (armed === true && textOf(trigger?.schedule) === '') {
    problems.push(`${name}: is armed but declares no schedule - there is nothing for a routine to fire on`)
  }

  return problems
}

export function reconcile(workflows, routines) {
  const buckets = { armed: [], declared: [], unapproved: [], off: [], orphans: [], problems: [] }
  const list = Array.isArray(workflows) ? workflows.filter(Boolean) : []
  const alarms = Array.isArray(routines) ? routines.filter(Boolean) : []
  const claimed = new Set()

  // Two workflow files with one name both matched the same routine and both reported `armed` -
  // one alarm clock, two jobs claiming it. Caught here rather than downstream, where it looks
  // like twice as much running as there is.
  const seenNames = new Map()
  for (const workflow of list) {
    const key = nameKey(workflow?.data?.name) || nameKey(workflow?.slug)
    if (key) seenNames.set(key, (seenNames.get(key) ?? 0) + 1)
  }
  for (const [key, count] of seenNames) {
    if (count > 1) {
      buckets.problems.push(`${key}: ${count} workflow files share this name, so a routine cannot be matched to one of them`)
    }
  }

  // And two routines with one name: the second silently vanished - not armed, not an orphan,
  // nowhere. Two alarm clocks for one job is a double fire and a double spend, and it is exactly
  // what /arm's own "confirm before you arm again" rule exists to prevent.
  const seenRoutines = new Map()
  for (const routine of alarms) {
    const key = nameKey(routine?.name)
    if (key) seenRoutines.set(key, (seenRoutines.get(key) ?? 0) + 1)
  }
  for (const [key, count] of seenRoutines) {
    if (count > 1) {
      buckets.problems.push(`${key}: ${count} routines share this name - they will all fire, and the spend is multiplied`)
    }
  }

  for (const workflow of list) {
    for (const problem of validateArming(workflow)) buckets.problems.push(problem)

    const routine = routineFor(workflow, alarms)
    if (routine) claimed.add(nameKey(routine.name))

    const state = armState(workflow, alarms)
    const row = {
      slug: workflow?.slug ?? null,
      name: textOf(workflow?.data?.name) || workflow?.slug || '(unnamed)',
      path: workflow?.path ?? null,
      schedule: textOf(workflow?.data?.trigger?.schedule) || null,
      reason: reasonFor(workflow) || null,
      // Carried on `armed` because that is the routine the file approved, and on `unapproved`
      // because naming the thing that is spending money is the entire point of that state.
      routineId: state === 'armed' || state === 'unapproved' ? (routine?.id ?? null) : null
    }
    buckets[state].push(row)

    if (state === 'unapproved') {
      buckets.problems.push(
        `${row.name}: a routine is firing for this and the file says armed: false - it is spending runs nobody approved. Either arm it in the file or remove the routine at claude.ai/code/routines`
      )
    }
  }

  // A routine pointing at this repo with no workflow behind it. Reported, never adopted: somebody
  // armed something that has since been renamed or removed, and quietly claiming it belongs to a
  // file it does not match would be inventing a connection.
  for (const routine of alarms) {
    if (claimed.has(nameKey(routine?.name))) continue
    buckets.orphans.push({ id: routine?.id ?? null, name: textOf(routine?.name) || '(unnamed)' })
  }

  return buckets
}
