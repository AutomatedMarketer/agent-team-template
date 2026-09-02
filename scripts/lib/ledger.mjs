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

// The fields a task really has. Anything else typed into a row is READ BY NOTHING, and until
// this existed it was dropped in silence: `hours: 20` on a task validated clean while the total
// stayed at the 3.3 hours derived from times_per_week x minutes_each. The reader sees a number
// that does not include what they typed and is told nothing.
//
// 15_YOUR_LEDGER.md says there are "two rules if you do it this way, both enforced in code", and
// names `hours` as one of them - "a number you typed straight in is a number nobody derived".
// One of the two was enforced. This is the other.
// `who` is on this list although no code reads it: every row of ledger.example.yml carries it
// and its comment block documents it, so a student who copies the example must not be refused.
// It is read by the person looking at their own week, which is a use.
export const TASK_FIELDS = [
  'task', 'words', 'who', 'times_per_week', 'minutes_each', 'confirmed', 'hands_off',
  'parked_because'
]

export const LEDGER_FIELDS = ['owner_type', 'hourly_value', 'currency', 'tasks']

// A short code such as USD, GBP or EUR. Not validated against a list: the number is theirs and so
// is the label, and a list would be wrong the first time somebody wrote "CHF" or "R$". The only
// claims are that it is short and carries no whitespace, so it cannot be a sentence typed into the
// wrong field.
const CURRENCY_SHAPE = /^\S{1,8}$/

export function isCurrencyCode(value) {
  return typeof value === 'string' && CURRENCY_SHAPE.test(value.trim())
}

// null when the ledger did not say. Callers print the number bare in that case and say so,
// rather than guessing a symbol - the dashboard printed "$" for every student in every country
// for months before anyone asked what currency they used.
export function currencyOf(ledger) {
  const value = ledger?.currency
  return isCurrencyCode(value) ? value.trim() : null
}

// The one place money is turned into words. check-ledger, check-proposals and the course check
// all print through this, so a student in Manchester and the lesson's sample block cannot drift
// apart. Bare when no currency was recorded, never a symbol.
export function formatMoney(value, currency) {
  const number = Math.round(value).toLocaleString('en-US')
  return currency ? `${number} ${currency} a week` : `${number} a week`
}

// Numbers this file WORKS OUT. Typing one is not a spelling mistake, it is a misunderstanding of
// where the number comes from, so it gets its own sentence rather than the generic one.
const DERIVED_FIELDS = new Map([
  ['hours', 'times_per_week and minutes_each'],
  ['hours_per_week', 'times_per_week and minutes_each'],
  ['hoursperweek', 'times_per_week and minutes_each'],
  ['cost', 'the hours and your hourly_value'],
  ['cost_per_week', 'the hours and your hourly_value'],
  ['costperweek', 'the hours and your hourly_value'],
  ['value', 'the hours and your hourly_value']
])

export function unknownFieldProblem(field) {
  const derivedFrom = DERIVED_FIELDS.get(field.toLowerCase())
  if (derivedFrom) {
    return `\`${field}\` is worked out from ${derivedFrom}, never typed. Nothing reads the number you wrote, so the total will not match it. Remove it`
  }
  return `\`${field}\` is not a field this file has, so nothing reads it and anything you put there is lost. Check it against ledger.example.yml, or remove it`
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

// The lesson's Ready row means "you named who acts on the output"; Parked means "nobody acts on
// the result yet". classify() can only see that hands_off is non-empty, so an honest "Nobody."
// lands in candidate and becomes buildable - the condition Rule 5 exists to catch. A walkthrough
// persona wrote exactly that and the ledger called it ready to hand over.
//
// The first attempt here tried to decide whether an answer MEANT nobody, with a list of exception
// words that suppressed the flag. It made both kinds of error, six and five of them found in one
// pass: "Nobody. It is my core work, but I would love it faster" was silently cleared because
// `but` appeared anywhere in the string, and "None of my staff - my VA handles it" was flagged
// though it names somebody. No pattern separates "No one acts on it" from "No one, my assistant
// does" without knowing that Sarah and my VA are people.
//
// So the claim is smaller and exactly true instead: this answer BEGINS WITH A NEGATIVE. That is
// checkable, and it is all the reader needs - the row is printed back with their own sentence and
// they settle it. Flagging "Nobody but me" is not a false positive under that claim; it is a row
// worth glancing at, and glancing is the whole cost.
const BEGINS_NEGATIVE = /^\s*(nobody|no[- ]?one|none|nothing|n\/a|not me)\b/i

export function beginsWithNegative(handsOff) {
  return BEGINS_NEGATIVE.test(typeof handsOff === 'string' ? handsOff : '')
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
    currency: currencyOf(ledger),
    candidates: buckets.candidate,
    notes: buckets.note,
    parked: buckets.parked,
    // Ready rows whose answer begins with a negative. The reader settles it: only they know
    // whether "None of my staff" ends in somebody's name.
    readyStartingWithNo: buckets.candidate.filter((task) => beginsWithNegative(task?.hands_off))
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

  const currency = ledger?.currency
  // Absent is allowed even beside a rate - every ledger written before this field existed is in
  // that state, and a check that turned them all red would stop the installer finishing. Present
  // but not a code is a mistake worth naming.
  if (currency !== undefined && currency !== null && !isCurrencyCode(currency)) {
    problems.push('currency must be a short code such as USD, GBP or EUR, or left out entirely')
  }

  for (const field of Object.keys(ledger ?? {})) {
    if (!LEDGER_FIELDS.includes(field)) problems.push(unknownFieldProblem(field))
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
    // A row cannot both name who acts on the output and say why nobody does. The field was
    // added for the parked bucket and nothing bound it there, so a self-contradicting row passed
    // and printed its park reason under "Ready".
    const parkedBecause = typeof task?.parked_because === 'string' ? task.parked_because.trim() : ''
    const handsOffText = typeof task?.hands_off === 'string' ? task.hands_off.trim() : ''
    if (parkedBecause && handsOffText && !isUnfilled(handsOffText)) {
      at('says who acts on the output and also says why it is parked - it cannot be both, so pick one')
    }

    for (const field of Object.keys(task ?? {})) {
      if (!TASK_FIELDS.includes(field)) at(unknownFieldProblem(field))
    }

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
