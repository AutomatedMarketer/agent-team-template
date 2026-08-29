import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseSimpleYaml } from './yaml-lite.mjs'

// The ledger is where the owner's week is written down: what they do, how often, how long it
// takes, and who acts on the result. Every agent and workflow this team ends up running is
// derived from it, which is why so much of this file is refusal.
//
// The rule underneath all of it: a wrong ledger is obvious to the person who lives that week.
// A wrong list of agents is not. So the numbers get checked first, by them, and nothing is
// proposed until they are right.

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const LEDGER = 'ledger.yml'

const OWNER_TYPES = ['business', 'job', 'both']
const CONFIRMATIONS = ['once', 'twice']
const MINUTES_IN_AN_HOUR = 60

// Seven days of twenty-four hours. A ledger claiming more than this has a units mistake in it,
// and the whole point of costing a week is that the number survives being read aloud.
export const MAX_HOURS_IN_A_WEEK = 168

export async function loadLedger(root = repoRoot) {
  return parseSimpleYaml(await readFile(path.join(root, LEDGER), 'utf8'))
}

// Same marker the rest of the repo uses for a template nobody filled in.
export function isUnfilled(value) {
  return typeof value === 'string' && /<!--\s*fill:/.test(value)
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function hoursFor(task) {
  return (Number(task?.times_per_week) * Number(task?.minutes_each)) / MINUTES_IN_AN_HOUR
}

// Cost is null, never 0, when no rate was given. An employee often cannot answer what an hour
// of their time is worth and should not be made to guess; zero would read as "this is free",
// which is a different claim and a false one.
export function deriveTask(task, hourlyValue) {
  const hoursPerWeek = hoursFor(task)
  const costPerWeek = isPositiveNumber(hourlyValue) ? hoursPerWeek * hourlyValue : null
  return { hoursPerWeek, costPerWeek }
}

// Two of the six anti-deviation rules live here, in code, because both are easy to wave through
// in conversation and expensive to get wrong.
//
//   Rule 4 - twice, or it is not a pattern. Something said once is a note. A rule built from a
//            single mention is usually wrong and makes the team worse while looking like progress.
//   Rule 5 - decision-readiness. If nobody can say who acts on the output, automating it produces
//            work that technically runs and nobody adopts.
export function classify(task) {
  if (task?.confirmed !== 'twice') return 'note'
  const handsOff = typeof task?.hands_off === 'string' ? task.hands_off.trim() : ''
  if (!handsOff || isUnfilled(handsOff)) return 'parked'
  return 'candidate'
}

// An answer that starts by saying nobody acts on it IS the parked condition - Rule 5 in words -
// but classify() can only see that the field is non-empty, so it lands in `candidate` and becomes
// buildable. A walkthrough persona answered "Nobody. This is the actual work I am paid for" and
// the ledger called it ready to hand over.
//
// This FLAGS rather than reclassifies, because the leading word is not decisive: "Nobody but me"
// and "Nobody else - I send it" both name someone. Only a negative with no exception after it is
// worth raising, and it is raised for the reader to settle rather than settled for them.
//
// A phrasing check, and stated as one: it catches the ways people write this, not every way it
// could be written. "That job dies with me" says the same thing and is not caught.
const NOBODY = /^\s*(nobody|no[- ]one|none|nothing|n\/a)\b/i
const EXCEPTION = /\b(but|except|other than|besides|apart from|unless|else)\b/i

export function saysNobodyActs(handsOff) {
  const text = typeof handsOff === 'string' ? handsOff.trim() : ''
  if (!text || !NOBODY.test(text)) return false
  return !EXCEPTION.test(text)
}

export function summarize(ledger) {
  const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : []
  const hourlyValue = ledger?.hourly_value
  const priced = isPositiveNumber(hourlyValue)

  const buckets = { candidate: [], note: [], parked: [] }
  let hoursPerWeek = 0

  for (const task of tasks) {
    const { hoursPerWeek: hours } = deriveTask(task, hourlyValue)
    if (Number.isFinite(hours)) hoursPerWeek += hours
    buckets[classify(task)].push(task)
  }

  return {
    hoursPerWeek,
    costPerWeek: priced ? hoursPerWeek * hourlyValue : null,
    unpriced: !priced,
    candidates: buckets.candidate,
    notes: buckets.note,
    parked: buckets.parked,
    // Ready rows whose own answer says nobody acts. The lesson's rule parks those; the reader
    // decides, because only they know whether "nobody" meant nobody.
    readyButNobody: buckets.candidate.filter((task) => saysNobodyActs(task?.hands_off))
  }
}

// Returns human-readable problems, the same contract as validateSelection in tiles.mjs.
// Empty means the ledger is sound enough to derive from. Every problem names its task, because
// a list of twenty tasks and an unattributed complaint is not something anyone can act on.
export function validateLedger(ledger) {
  const problems = []

  if (!OWNER_TYPES.includes(ledger?.owner_type)) {
    problems.push(`owner_type must be one of ${OWNER_TYPES.join(', ')}`)
  }

  const hourlyValue = ledger?.hourly_value
  // Absent is fine and expected - it is the employee case. Present but nonsense is not.
  if (hourlyValue !== undefined && hourlyValue !== null && !isPositiveNumber(hourlyValue)) {
    problems.push('hourly_value must be a positive number, or left out entirely')
  }

  const tasks = ledger?.tasks
  if (!Array.isArray(tasks)) {
    problems.push('tasks must be a list, even if empty')
    return problems
  }

  for (const [index, task] of tasks.entries()) {
    const name = typeof task?.task === 'string' && task.task.trim() ? task.task.trim() : `task ${index + 1}`
    const at = (problem) => problems.push(`${name}: ${problem}`)

    if (isUnfilled(task?.task) || isUnfilled(task?.words)) {
      at('has not been filled in yet')
      continue
    }

    // An unnamed task produces an unnameable proposal - a blank row in proposals.md that cites
    // a quote and a number and nothing anyone can act on. The template marker is not the only
    // way a task arrives empty; a plain empty string is the commoner one.
    if (typeof task?.task !== 'string' || !task.task.trim()) {
      at('needs a name - a proposal with no task name cannot be discussed or approved')
      continue
    }

    // Rule 2, at its source. A task with no quote cannot produce a proposal that cites one,
    // so it is refused here rather than three steps downstream.
    const words = typeof task?.words === 'string' ? task.words.trim() : ''
    if (!words) at("needs the owner's own words about it, quoted, not a summary")

    for (const field of ['times_per_week', 'minutes_each']) {
      if (!isPositiveNumber(task?.[field])) {
        at(`${field} must be a positive number`)
      }
    }

    if (!CONFIRMATIONS.includes(task?.confirmed)) {
      at(`confirmed must be ${CONFIRMATIONS.join(' or ')}`)
    }

    const hours = hoursFor(task)
    if (Number.isFinite(hours) && hours > MAX_HOURS_IN_A_WEEK) {
      at(`comes to ${Math.round(hours)} hours a week, and a week only holds ${MAX_HOURS_IN_A_WEEK}`)
    }
  }

  // Everything downstream keys on the task name: the shortlist map, the answered set, the quote
  // lookup. Two rows with the same name means one silently wins the map, another silently wins
  // the .find(), and a proposal ends up quoting one row while costing the other. A ten-hour task
  // disappeared this way with nothing reporting it.
  const names = new Map()
  for (const task of tasks) {
    const name = typeof task?.task === 'string' ? task.task.trim() : ''
    if (!name) continue
    names.set(name, (names.get(name) ?? 0) + 1)
  }
  for (const [name, count] of names) {
    if (count > 1) {
      problems.push(`${name}: named ${count} times - every task needs its own name, or the numbers get crossed`)
    }
  }

  const total = tasks.reduce((sum, task) => {
    const hours = hoursFor(task)
    return Number.isFinite(hours) ? sum + hours : sum
  }, 0)
  if (total > MAX_HOURS_IN_A_WEEK) {
    problems.push(`the ledger totals ${Math.round(total)} hours a week, and a week only holds ${MAX_HOURS_IN_A_WEEK}`)
  }

  return problems
}
