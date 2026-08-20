import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseSimpleYaml } from './yaml-lite.mjs'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const WORKFLOW_DIR = 'workflows'

// A workflow is a chain. A skill does one task; a workflow gets a job done, and the whole
// chain costs one scheduled run rather than one per step — which is what keeps a student
// inside the daily routine cap.

// Routines will not fire more often than once an hour. GitHub Actions will. Anything below
// the floor has to be routed to the runner that can honour it, so the floor lives here
// rather than being remembered.
export const MIN_INTERVAL_MINUTES = { routine: 60, 'github-actions': 5 }
export const RUNNERS = Object.keys(MIN_INTERVAL_MINUTES)

// Schedules are written the way a person says them out loud, because a student never writes
// this file by hand and should never have to read cron.
const SCHEDULE_FORMS = [
  { pattern: /^hourly$/, minutes: 60 },
  { pattern: /^daily \d{2}:\d{2}$/, minutes: 1440 },
  { pattern: /^weekdays \d{2}:\d{2}$/, minutes: 1440 },
  { pattern: /^weekly (sun|mon|tue|wed|thu|fri|sat) \d{2}:\d{2}$/, minutes: 10080 },
  { pattern: /^monthly \d{1,2} \d{2}:\d{2}$/, minutes: 43200 },
  { pattern: /^every \d+ (minutes|hours)$/, minutes: null }
]

export const parseWorkflow = parseSimpleYaml

function scheduleMinutes(schedule) {
  const every = /^every (\d+) (minutes|hours)$/.exec(schedule)
  if (every) return Number(every[1]) * (every[2] === 'hours' ? 60 : 1)
  const form = SCHEDULE_FORMS.find((candidate) => candidate.pattern.test(schedule))
  return form ? form.minutes : null
}

export function isValidSchedule(schedule) {
  if (typeof schedule !== 'string') return false
  return SCHEDULE_FORMS.some((form) => form.pattern.test(schedule.trim()))
}

// Returns a list of human-readable problems. Empty means the workflow is sound.
// `known` lets a caller check step and owner names against what the repo actually contains;
// omit it to validate shape only.
export function validateWorkflow(workflow, known = {}) {
  const problems = []
  const { skills, agents } = known

  if (typeof workflow?.name !== 'string' || !workflow.name.trim()) {
    problems.push('name is required and must be a non-empty string')
  }

  if (typeof workflow?.owner !== 'string' || !workflow.owner.trim()) {
    problems.push('owner is required and must name one agent')
  } else if (agents && !agents.includes(workflow.owner)) {
    problems.push(`owner "${workflow.owner}" is not an agent in this repo`)
  }

  const steps = workflow?.steps
  if (!Array.isArray(steps) || steps.length === 0) {
    problems.push('steps is required and must list at least one skill')
  } else {
    steps.forEach((step, index) => {
      if (typeof step !== 'string' || !step.trim()) {
        problems.push(`step ${index + 1} must be a non-empty skill name`)
        return
      }
      if (skills && !skills.includes(step)) {
        problems.push(`step "${step}" is not a skill in this repo`)
      }
    })
    const duplicates = steps.filter((step, index) => steps.indexOf(step) !== index)
    for (const duplicate of new Set(duplicates)) {
      problems.push(`step "${duplicate}" appears more than once`)
    }
  }

  const runner = workflow?.runner ?? 'routine'
  if (!RUNNERS.includes(runner)) {
    problems.push(`runner "${runner}" is not one of: ${RUNNERS.join(', ')}`)
  }

  const trigger = workflow?.trigger
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) {
    problems.push('trigger is required')
  } else {
    if (trigger.schedule === undefined && trigger.fire !== true && trigger.webhook !== true) {
      problems.push('trigger needs at least one of: schedule, fire, webhook')
    }
    if (trigger.schedule !== undefined) {
      if (!isValidSchedule(trigger.schedule)) {
        problems.push(`schedule "${trigger.schedule}" is not a recognised form`)
      } else {
        const minutes = scheduleMinutes(String(trigger.schedule).trim())
        const floor = MIN_INTERVAL_MINUTES[runner] ?? MIN_INTERVAL_MINUTES.routine
        if (minutes !== null && minutes < floor) {
          problems.push(
            `schedule "${trigger.schedule}" runs every ${minutes} minutes, below the ` +
              `${floor}-minute floor for runner "${runner}"`
          )
        }
      }
    }
    if (trigger.fire !== undefined && typeof trigger.fire !== 'boolean') {
      problems.push('trigger.fire must be true or false')
    }
  }

  const output = workflow?.output
  if (typeof output !== 'string' || !output.trim()) {
    problems.push('output is required and must be a path inside the repo')
  } else if (output.startsWith('/') || output.split('/').includes('..')) {
    problems.push(`output "${output}" must stay inside the repo`)
  }

  return problems
}

export async function loadWorkflows() {
  let files = []
  try {
    files = (await readdir(path.join(repoRoot, WORKFLOW_DIR)))
      .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
      .sort()
  } catch {
    return []
  }

  const workflows = []
  for (const file of files) {
    const relative = path.posix.join(WORKFLOW_DIR, file)
    const source = await readFile(path.join(repoRoot, relative), 'utf8')
    workflows.push({
      slug: file.replace(/\.ya?ml$/, ''),
      path: relative,
      data: parseWorkflow(source)
    })
  }
  return workflows
}
