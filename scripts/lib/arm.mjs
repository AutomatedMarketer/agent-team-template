import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Two lists that have never met: what workflows/*.yml declares, and what the routines API says
// actually exists. Comparing them is the whole point of this file.
//
// This repo once carried ten workflow files declaring a schedule and one real routine. Every board
// reading those files reported ten jobs running, each with a next-run time, because a file that
// says `schedule:` looks exactly like a job that runs. Nobody lied; nothing checked.
//
// So a job is in exactly one of three states, and the middle one is the bug:
//
//   armed     the file says run it, and a routine exists
//   declared  the file says run it, and NOTHING rings
//   off       deliberately not armed, and carrying a written reason
//
// `armed:` defaults to false. A workflow that has never been through /arm is off, not running,
// which is the safe direction and means nothing arms itself by existing.

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const SNAPSHOT = '.agent-team/routines.json'

export const ARM_STATES = ['armed', 'declared', 'off']

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
export async function loadRoutineSnapshot(root = repoRoot) {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, SNAPSHOT), 'utf8'))
    return {
      takenAt: textOf(parsed?.takenAt) || null,
      routines: Array.isArray(parsed?.routines) ? parsed.routines : []
    }
  } catch {
    // No snapshot is not an error: it means /routines has never run here. The caller reports that
    // as unknown, never as "nothing is scheduled" — which would be a claim about the account that
    // an absent file cannot support.
    return { takenAt: null, routines: [], missing: true }
  }
}

export function routineFor(workflow, routines) {
  const wanted = nameKey(workflow?.data?.name) || nameKey(workflow?.slug)
  if (!wanted) return null
  return (routines ?? []).find((routine) => nameKey(routine?.name) === wanted) ?? null
}

export function armState(workflow, routines) {
  if (!isArmed(workflow)) return 'off'
  return routineFor(workflow, routines) ? 'armed' : 'declared'
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
  const buckets = { armed: [], declared: [], off: [], orphans: [], problems: [] }
  const claimed = new Set()

  for (const workflow of workflows ?? []) {
    for (const problem of validateArming(workflow)) buckets.problems.push(problem)

    const routine = routineFor(workflow, routines)
    if (routine) claimed.add(nameKey(routine.name))

    const state = armState(workflow, routines)
    buckets[state].push({
      slug: workflow.slug,
      name: textOf(workflow?.data?.name) || workflow.slug,
      path: workflow.path,
      schedule: textOf(workflow?.data?.trigger?.schedule) || null,
      reason: reasonFor(workflow) || null,
      routineId: state === 'armed' ? (routine?.id ?? null) : null
    })
  }

  // A routine pointing at this repo with no workflow behind it. Reported, never adopted: somebody
  // armed something that has since been renamed or removed, and quietly claiming it belongs to a
  // file it does not match would be inventing a connection.
  for (const routine of routines ?? []) {
    if (claimed.has(nameKey(routine?.name))) continue
    buckets.orphans.push({ id: routine?.id ?? null, name: textOf(routine?.name) || '(unnamed)' })
  }

  return buckets
}
