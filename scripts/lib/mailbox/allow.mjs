// What this computer will do, decided on this computer.
//
// Not the board and not the team repo: the board stores and signs, the team repo is pushed to by other people and by
// cloud routines, and a signed order only proves who asked - not that the person at this Mac agreed to it. So the
// allowlist is a file in the runner's state folder (outside the code checkout and the work copy), written by the
// person at the Mac:
//
//   board: https://your-board.example.com        the only address the runner will ever ask
//   repo: YourName/your-team-repo                orders for another repo are refused
//   runner: mac-mini                             orders for another computer are refused
//   computer: Mac Mini                           the name the board shows for this computer
//   actions: [task, move, approve, pause, run, arm, skill, agent]
//   jobs:                                        the jobs a run order may start, and the most minutes each gets
//     - slug: morning-intel
//       minutes: 20
//     - slug: task-sweep                         a job may name its worker: claude (the same as naming none) or codex.
//       minutes: 30                              Codex runs ONLY a job named here as worker: codex (codex.mjs)
//       worker: codex
//   per_day:                                     the most it will do in one New York day
//     orders: 40
//     runs: 6
//
// No file: nothing runs. A file that is a link, a folder, too big or not an allowlist is "broken" (unavailable) -
// never "everything". The YAML reader forgives almost any text and gives back nothing for it, which must not be
// taken for "nothing is allowed" or for "everything is": so every line is checked for its shape here first, an
// unknown or repeated key breaks the file, and every value is checked again after the reader has had it. Nothing is
// repaired and nothing is clamped: a number above a ceiling in this code is a mistake to be told about.
//
// A refusal names the part that is wrong (`why`) and never repeats what was written there.

import * as realFs from 'node:fs/promises'
import { join } from 'node:path'
import { parseSimpleYaml } from '../yaml-lite.mjs'
import { checkComputerLabel } from '../status/safe.mjs'
import { SCHEDULE_ZONE } from '../status/commit.mjs'
import { ACTIONS, REPO_SHAPE, RUNNER_SHAPE } from './contract.mjs'
import { isSlug } from './validate.mjs'
import { readSmallFile } from './small-file.mjs'

export const ALLOWED_ORDERS = Object.freeze({ file: 'allowed-orders.yml', maxBytes: 16 * 1024 })

// The most this code will ever do, whatever the file says. `refused` is how many orders a day may be turned away
// and written down: a board that signs a flood of orders the Mac does not want must not fill the disk.
export const CEILINGS = Object.freeze({ orders: 40, runs: 6, refused: 100, minutes: 30, jobs: 40 })

const TOP_KEYS = new Set(['board', 'repo', 'runner', 'computer', 'actions', 'jobs', 'per_day'])
const NESTED_KEYS = new Set(['slug', 'minutes', 'worker', 'orders', 'runs'])
const WORKERS = ['claude', 'codex']
const TOP_LINE = /^([a-z_]+):(?:[ \t].*)?$/
const NESTED_LINE = /^[ \t]+([a-z_]+):(?:[ \t].*)?$/
const DASH_LINE = /^[ \t]+-[ \t]+(\S.*)$/
const DASH_PAIR = /^([a-z_]+):(?:[ \t]|$)/

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff)
const broken = (why) => ({ state: 'broken', allow: null, why })

// Every line is a key, a list item or a `key: value` inside one - and only the keys this file has. The reader
// would skip a line that is none of these without a word.
function lineProblem(text) {
  const seen = new Set()
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const top = TOP_LINE.exec(line)
    if (top) {
      if (!TOP_KEYS.has(top[1]) || seen.has(top[1])) return 'key'
      seen.add(top[1])
      continue
    }
    const nested = NESTED_LINE.exec(line)
    if (nested) {
      if (!NESTED_KEYS.has(nested[1])) return 'line'
      continue
    }
    const dash = DASH_LINE.exec(line)
    if (!dash) return 'line'
    const pair = DASH_PAIR.exec(dash[1])
    if (pair && !NESTED_KEYS.has(pair[1])) return 'line'
  }
  return null
}

// A map with these keys and no others. (A list, a word or a number can never have exactly these keys.)
const hasExactly = (value, keys) => value != null && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const wholeNumber = (value, min, max) => Number.isInteger(value) && value >= min && value <= max

// https, a name made of letters and a dot or more, and nothing after it: no user, port, path, query or fragment.
// The text is checked as written first because the URL reader quietly drops an empty query and an empty fragment.
const BOARD_AS_WRITTEN = /^https:\/\/[^/?#@:%\s\\]+\/?$/i
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const HOST_ENDING = /^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/

function boardOrigin(value) {
  if (typeof value !== 'string' || !BOARD_AS_WRITTEN.test(value)) return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const labels = url.hostname.split('.')
  if (labels.length < 2 || !labels.every((label) => HOST_LABEL.test(label)) || !HOST_ENDING.test(labels.at(-1))) return null
  return url.origin
}

// { jobs: slug -> minutes, workers: slug -> worker } (a job that names no worker is not in workers: it is Claude's), or null.
function readJobs(list) {
  if (!Array.isArray(list) || list.length > CEILINGS.jobs) return null
  const jobs = new Map()
  const named = new Map()
  const explicit = new Set()
  for (const item of list) {
    const shaped = hasExactly(item, ['slug', 'minutes']) || (hasExactly(item, ['slug', 'minutes', 'worker']) && WORKERS.includes(item.worker))
    if (!shaped || !isSlug(item.slug) || !wholeNumber(item.minutes, 1, CEILINGS.minutes)) return null
    // The same job twice gets the shorter time: when two lines disagree, the one that allows less is the one believed.
    jobs.set(item.slug, Math.min(jobs.get(item.slug) ?? Infinity, item.minutes))
    // And Claude, unless every line of it says codex: Claude has no shell at all, so it is the one that allows less.
    const said = item.worker ?? 'claude'
    named.set(item.slug, named.has(item.slug) && named.get(item.slug) !== said ? 'claude' : said)
    if (Object.hasOwn(item, 'worker')) explicit.add(item.slug)
  }
  const workers = new Map([...named].filter(([slug]) => explicit.has(slug)))
  return { jobs, workers }
}

function parseAllowed(source, identity) {
  const text = source.replace(BYTE_ORDER_MARK, '').replaceAll('\r\n', '\n')
  const lineWrong = lineProblem(text)
  if (lineWrong) return broken(lineWrong)
  const doc = parseSimpleYaml(text)
  // A nested line before any key it belongs to is read as a key of its own.
  if (Object.keys(doc).some((key) => !TOP_KEYS.has(key))) return broken('key')

  const board = boardOrigin(doc.board)
  if (board === null) return broken('board')
  if (typeof doc.repo !== 'string' || !REPO_SHAPE.test(doc.repo)) return broken('repo')
  if (typeof doc.runner !== 'string' || !RUNNER_SHAPE.test(doc.runner)) return broken('runner')
  if (typeof doc.computer !== 'string' || checkComputerLabel(doc.computer, identity).length) return broken('computer')
  if (!Array.isArray(doc.actions) || !doc.actions.every((action) => ACTIONS.includes(action))) return broken('actions')
  const read = readJobs(doc.jobs)
  if (read === null) return broken('jobs')
  const { jobs, workers } = read
  const perDay = doc.per_day
  if (!hasExactly(perDay, ['orders', 'runs']) || !wholeNumber(perDay.orders, 0, CEILINGS.orders) || !wholeNumber(perDay.runs, 0, CEILINGS.runs)) return broken('per_day')

  return {
    state: 'ok',
    allow: {
      board,
      repo: doc.repo,
      runner: doc.runner,
      computer: doc.computer,
      actions: [...new Set(doc.actions)],
      jobs,
      workers,
      perDay: { orders: perDay.orders, runs: perDay.runs }
    }
  }
}

// { state: 'ok', allow } | { state: 'missing', allow: null } | { state: 'broken', allow: null, why }
// `why` is the part that is wrong - a key of the file, or 'file' (not a plain small file) or 'line' (a line of no
// shape this file has) - never a value.
export async function readAllowedOrders(stateDir, identity = {}, fs = realFs) {
  if (typeof stateDir !== 'string') return { state: 'missing', allow: null }
  const file = await readSmallFile(join(stateDir, ALLOWED_ORDERS.file), ALLOWED_ORDERS.maxBytes, fs)
  if (file.state === 'missing') return { state: 'missing', allow: null }
  if (file.state !== 'ok') return broken('file')
  return parseAllowed(file.text, identity)
}

// The jobs a run order may start: named in the allowlist AND ones this code has rules for (what each may change,
// diffcheck.mjs). The board is told this list, so it offers Run only for jobs that will run.
export function runnableJobs(allow, knownJobs) {
  return [...allow.jobs.keys()].filter((slug) => knownJobs.includes(slug)).sort()
}

/* ---------- the day, and what has been done in it ------------------------------------------------------------------ */

const dayParts = new Intl.DateTimeFormat('en-CA', { timeZone: SCHEDULE_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })

// The day a limit counts in: a New York day, like the collector's schedule, so "today" means the same to the person.
export function dayOf(now) {
  const parts = Object.fromEntries(dayParts.formatToParts(new Date(now)).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

const COUNT_KINDS = ['orders', 'runs', 'refused']
const COUNT_MAX = 10_000
const zeroCounts = (day) => ({ day, orders: 0, runs: 0, refused: 0 })
// A count that cannot be trusted reads as full. A damaged file must not hand out a fresh day, and the file is left
// as it is for the person to look at.
const fullCounts = (day) => ({ day, orders: CEILINGS.orders, runs: CEILINGS.runs, refused: CEILINGS.refused, broken: true })

// What has been counted today: orders taken on (a refusal is not one), runs of Claude started, and orders turned away.
export async function readCounts(stateDir, now, fs = realFs) {
  const day = dayOf(now)
  const folder = join(stateDir, 'counts')
  let info
  try {
    info = await fs.lstat(folder)
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? zeroCounts(day) : fullCounts(day)
  }
  if (!info.isDirectory()) return fullCounts(day)
  const file = await readSmallFile(join(folder, `${day}.json`), 1024, fs)
  if (file.state === 'missing') return zeroCounts(day)
  if (file.state !== 'ok') return fullCounts(day)
  let counted
  try {
    counted = JSON.parse(file.text)
  } catch {
    return fullCounts(day)
  }
  if (!hasExactly(counted, ['day', 'orders', 'runs', 'refused']) || counted.day !== day) return fullCounts(day)
  if (!COUNT_KINDS.every((kind) => wholeNumber(counted[kind], 0, COUNT_MAX))) return fullCounts(day)
  return { day, orders: counted.orders, runs: counted.runs, refused: counted.refused }
}

// One more of `kind`, written whole (a new file, then moved into place) and for the owner only. Returns the new
// counts, or null when today's counts cannot be trusted - nothing is written then. The runner holds the lock, so
// nothing else is adding at the same time.
export async function addCount(stateDir, now, kind, fs = realFs) {
  if (!COUNT_KINDS.includes(kind)) throw new TypeError('addCount: that is not a thing that is counted')
  const counts = await readCounts(stateDir, now, fs)
  if (counts.broken) return null
  const next = { day: counts.day, orders: counts.orders, runs: counts.runs, refused: counts.refused }
  next[kind] += 1
  const folder = join(stateDir, 'counts')
  await fs.mkdir(folder, { recursive: true })
  const file = join(folder, `${counts.day}.json`)
  const temporary = `${file}.${process.pid}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temporary, file)
  return next
}

/* ---------- may this order be done --------------------------------------------------------------------------------- */

// { ok: true } (and for a run `minutes`, its time limit, and `worker`, who does it) or { ok: false, why } with a reason from the
// contract's refused list. The action is checked first, then the job, then the worker, then the day. Only a run needs its job on the
// list: pausing a schedule or asking for one is a card or one line of a workflow file, not a start of Claude.
// The worker (the contract's payload.worker): the order's (claude when left out) must be the job's in this allowlist (claude when it
// names none). So Codex runs only a job this computer gave it, and only when the order asked for Codex.
export function decide(allow, counts, action, fields, runnable) {
  if (!allow.actions.includes(action)) return { ok: false, why: 'not-allowed' }
  const job = fields?.workflow
  if (action === 'run' && (!runnable.includes(job) || !allow.jobs.has(job))) return { ok: false, why: 'job-not-allowed' }
  const worker = action === 'run' ? (allow.workers?.get(job) ?? 'claude') : null
  if (action === 'run' && (fields?.worker ?? 'claude') !== worker) return { ok: false, why: 'worker-not-allowed' }
  if (counts.orders >= allow.perDay.orders) return { ok: false, why: 'daily-limit' }
  if (action !== 'run') return { ok: true }
  if (counts.runs >= allow.perDay.runs) return { ok: false, why: 'daily-limit' }
  return { ok: true, minutes: allow.jobs.get(job), worker }
}
