// The jobs part: every scheduled job on this computer, one row each - by name, schedule, and how
// its last run went. Nothing else. The Readiness wall turns each row into a light.
//
// LaunchAgents (a Mac). What is read, and the only things kept from each:
//   ~/Library/LaunchAgents/*.plist    the user's own folder only - never /Library. Each file is
//                                     turned into JSON by /usr/bin/plutil and held in memory:
//                                     Label, StartCalendarInterval, StartInterval, KeepAlive,
//                                     RunAtLoad, Disabled. Of StandardOutPath and
//                                     StandardErrorPath, only the two paths, to look at them.
//   /bin/launchctl list               one table: which labels are loaded, whether each has a
//                                     process, and its last exit status. Rows for labels no plist
//                                     here names are dropped.
//   the two log files                 their modified time, by stat. They are never opened, so what
//                                     a job printed cannot be read, and their paths are not kept.
//   XPC_SERVICE_NAME                  the label launchd gave this collector's own job, to mark
//                                     that row `self`.
// Never read and never kept: the program and its arguments (ProgramArguments, Program), the
// environment (EnvironmentVariables), every folder (WorkingDirectory and the rest), and every other
// key a plist can have. The plist is dropped as soon as those few values are taken from it.
//
// Both programs run through deps.exec: absolute path, from the empty folder the collector owns, with
// a time limit and an output cap (programs.mjs). A failure of either is a state word, never a message.
//
// Hermes (any computer it is on). Hermes is NEVER run - this half starts no program at all. Where it
// lives is worked out the way hermes.mjs works it out, and every profile's folder is visited the same
// way (the default profile first, then the others A to Z):
//   <profile>/cron/jobs.json          up to 1 MB, parsed in memory. From each job, only: id, name,
//                                     enabled, schedule.kind, schedule.expr, schedule.minutes,
//                                     schedule.timezone, last_run_at, last_status. last_status
//                                     becomes ok, error or unknown and nothing more.
//                                     Also looked at, and not kept: the prompt, the skills and the
//                                     script - only to tell whether the name is a copy of the first
//                                     50 characters of one of them, as Hermes makes when nobody names
//                                     a job. A copied name is written as "Unnamed job". Nothing of
//                                     what they say, not a hash of it, is written.
//   <profile>/config.yaml             the one top-level `timezone:` line, and no other line: it is
//                                     the zone Hermes reads that profile's cron expressions in
//                                     (hermes_time.py), so the times are only judged when it is the
//                                     computer's own.
// Never kept: the prompt, the script, where the job delivers or came from, its model, skills and
// settings, and last_error and every other word of error text. Those are in the same file and are
// dropped the moment the few values above are taken (the prompt, skills and script after the name
// check above).

import { readdir, stat } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { JOBS_SCHEMA, JOBS_CAPS, JOBS_MAX_FILE_BYTES, UNNAMED_JOB } from './jobs-schema.mjs'
import { cadenceFromCalendar, cadenceFromInterval, cadenceFromCron, dueTimes, canonicalZone } from './cadence.mjs'
import { checkLabel, checkConnectionName, isKnownTimezone } from './safe.mjs'
import { emptyFolder, VERSION_TIMEOUT_MS } from './programs.mjs'
import { hermesRoot, profileFolders, readSmall, readSmallJson, hermesTime, folderState, lineValue } from './hermes.mjs'
import { isoSeconds, isPlainObject } from './util.mjs'

const LAUNCHCTL = '/bin/launchctl'
const PLUTIL = '/usr/bin/plutil'
const NOT_FOUND = { status: 'not found' }
const UNREADABLE = { status: 'unavailable', why: 'could not be read' }
const DAY_MS = 86400_000
// Before 2000, or more than a day ahead of the check, a file time is a broken clock, not a report.
const EARLIEST_BELIEVABLE_MS = Date.parse('2000-01-01T00:00:00Z')
// Plists read at most; a user's LaunchAgents folder is a few dozen, and each is a program run.
export const MAX_PLISTS_READ = 200
const LAUNCHCTL_OUTPUT_CAP = 512 * 1024
const PLIST_OUTPUT_CAP = 256 * 1024

// --- launchctl list ---------------------------------------------------------------------------------------

const ROW = /^(-|\d+)\s+(-?\d+|-)\s+(\S+)\s*$/

// The table launchctl prints: a header, then "PID Status Label" per job. A dash for the process
// means none is running; a dash for the status means no exit yet. Returns a Map of label to
// { running, status }, or null when the text is not a table at all (it has no header).
export function parseLaunchctlList(text) {
  if (typeof text !== 'string') return null
  const lines = text.split(/\r?\n/)
  if (!/^PID\s+Status\s+Label\s*$/.test(lines[0] ?? '')) return null
  const rows = new Map()
  for (const line of lines.slice(1)) {
    const match = ROW.exec(line.trim())
    if (!match || rows.has(match[3])) continue
    rows.set(match[3], { running: match[1] !== '-', status: match[2] === '-' ? null : Number(match[2]) })
  }
  return rows
}

// --- one plist --------------------------------------------------------------------------------------------

// The few values kept from a plist, and nothing more. null when it is not an object with a label.
function keysOf(plist) {
  if (!isPlainObject(plist) || typeof plist.Label !== 'string') return null
  return {
    label: plist.Label,
    calendar: plist.StartCalendarInterval,
    interval: plist.StartInterval,
    keepAlive: plist.KeepAlive,
    runAtLoad: plist.RunAtLoad,
    disabled: plist.Disabled,
    logs: [plist.StandardOutPath, plist.StandardErrorPath]
  }
}

// How the job is scheduled. A calendar or an interval says it; with neither, a job that is kept
// alive, or runs at load, is an always-on service. KeepAlive as anything but plain true ("restart
// it if it fails", "while the network is up") is a condition this does not judge. Both a calendar and
// an interval at once is two schedules, which is not one this can write down.
function cadenceOf(keys) {
  const hasCalendar = keys.calendar !== undefined
  const hasInterval = keys.interval !== undefined
  if (hasCalendar && hasInterval) return { kind: 'unknown' }
  if (hasCalendar) return cadenceFromCalendar(keys.calendar)
  if (hasInterval) return cadenceFromInterval(keys.interval)
  if (keys.keepAlive === true) return { kind: 'always' }
  if (keys.keepAlive === undefined || keys.keepAlive === false) return keys.runAtLoad === true ? { kind: 'always' } : { kind: 'unknown' }
  return { kind: 'unknown' }
}

// The newest modified time of the log files, as an ISO time, or undefined. Only stat is used: the
// contents of a log are whatever the job printed.
async function newestLogTime(paths, fs, now) {
  let newest = null
  for (const path of paths) {
    if (typeof path !== 'string' || !isAbsolute(path)) continue
    try {
      const info = await fs.stat(path)
      if (!info.isFile()) continue
      const at = Math.floor(info.mtimeMs / 1000) * 1000
      if (at < EARLIEST_BELIEVABLE_MS || at > now + DAY_MS) continue
      if (newest === null || at > newest) newest = at
    } catch {
      // A log that is not there is not a time.
    }
  }
  return newest === null ? undefined : isoSeconds(newest)
}

const exitStatus = (status) => (Number.isInteger(status) && status >= -255 && status <= 255 ? status : undefined)

// --- the block --------------------------------------------------------------------------------------------

// Runs one of the two programs and returns its output, or null when it did not answer.
async function ask(deps, cwd, file, args, maxOutput) {
  try {
    const { stdout } = await deps.exec(file, args, { cwd, timeout: VERSION_TIMEOUT_MS, maxOutput })
    return typeof stdout === 'string' ? stdout : null
  } catch {
    return null
  }
}

// deps: { home, platform, now, env, identity, stateDir, exec, fs? }. `zone` is the computer's
// timezone, or null when this runtime does not know it - then no due times are written.
export async function collectLaunchd(deps, zone) {
  if (deps.platform !== 'darwin') return { ...NOT_FOUND }
  const fs = deps.fs ?? { readdir, stat }
  const folder = join(deps.home, 'Library', 'LaunchAgents')
  let entries
  try {
    entries = await fs.readdir(folder, { withFileTypes: true })
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? { ...NOT_FOUND } : { ...UNREADABLE }
  }
  const files = entries
    .filter((entry) => !entry.name.startsWith('.') && entry.name.endsWith('.plist') && (entry.isFile() || entry.isSymbolicLink()))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (!files.length) return { status: 'found', items: [], hidden: 0, more: 0 }

  if (typeof deps.exec !== 'function' || !deps.stateDir) return { ...UNREADABLE }
  let cwd
  try {
    cwd = await emptyFolder(deps.stateDir)
  } catch {
    return { ...UNREADABLE }
  }
  const table = parseLaunchctlList(await ask(deps, cwd, LAUNCHCTL, ['list'], LAUNCHCTL_OUTPUT_CAP))
  if (!table) return { ...UNREADABLE }

  const identity = deps.identity
  const items = []
  const seen = new Set()
  let hidden = 0
  for (const file of files.slice(0, MAX_PLISTS_READ)) {
    let keys = null
    const text = await ask(deps, cwd, PLUTIL, ['-convert', 'json', '-o', '-', join(folder, file)], PLIST_OUTPUT_CAP)
    try {
      keys = text === null ? null : keysOf(JSON.parse(text))
    } catch {
      keys = null
    }
    // Unreadable, no label, a label the board would refuse, or one seen already: dropped and counted.
    if (!keys || checkLabel(keys.label, 'label', identity).length || seen.has(keys.label)) {
      hidden += 1
      continue
    }
    seen.add(keys.label)

    const listed = table.get(keys.label)
    const state = !listed ? 'not loaded' : listed.running ? 'running' : 'loaded'
    const cadence = cadenceOf(keys)
    // Disabled in the plist counts only when the job is not loaded: a loaded job is on.
    const disabled = keys.disabled === true && state === 'not loaded'
    const item = { label: keys.label, cadence, state }
    const lastExit = listed ? exitStatus(listed.status) : undefined
    if (lastExit !== undefined) item.lastExit = lastExit
    const lastReportAt = await newestLogTime(keys.logs, fs, deps.now)
    if (lastReportAt) item.lastReportAt = lastReportAt
    if (!disabled && zone) Object.assign(item, dueTimes(cadence, zone, deps.now))
    if (typeof deps.env?.XPC_SERVICE_NAME === 'string' && deps.env.XPC_SERVICE_NAME === keys.label) item.self = true
    if (disabled) item.disabled = true
    items.push(item)
  }
  items.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
  const unread = Math.max(0, files.length - MAX_PLISTS_READ)
  return {
    status: 'found',
    items: items.slice(0, JOBS_CAPS.launchd),
    hidden,
    more: unread + Math.max(0, items.length - JOBS_CAPS.launchd)
  }
}

// --- Hermes ---------------------------------------------------------------------------------------------------------

// A jobs file bigger than this is not one Hermes wrote for this purpose, and is not read.
export const HERMES_JOBS_FILE_BYTES = 1024 * 1024
// The words Hermes itself writes into last_status when a run ends (cron/jobs.py, _record_run_outcome,
// and cron/scheduler.py): "ok" when the run succeeded and its output was delivered; "error" when it
// failed; "delivery_failed" when it ran but its output could not be delivered; "blocked_config" when
// it was stopped before it ran for a setting that is wrong; "interrupted" when a shutdown cut it off.
// Only "ok" is a good run. Any other word - including no word - is unknown, never a guess.
export const HERMES_RESULT_WORDS = {
  ok: ['ok'],
  error: ['error', 'delivery_failed', 'blocked_config', 'interrupted']
}
// A job that runs once is not on a schedule the wall can keep checking. Hermes writes "once"
// (cron/jobs.py, parse_schedule); "at" is the name the plan used.
const ONE_SHOT_KINDS = ['at', 'once']

function resultOf(raw) {
  if (typeof raw !== 'string') return 'unknown'
  const word = raw.trim().toLowerCase()
  for (const [result, words] of Object.entries(HERMES_RESULT_WORDS)) if (words.includes(word)) return result
  return 'unknown'
}

// The zone Hermes reads this profile's cron expressions in: the top-level `timezone:` line of its
// config.yaml, when that names a real zone (hermes_time.py; an unreal one makes Hermes fall back to
// the computer's own time, as no line at all does). Only that one line is looked at. A zone set in
// Hermes's own environment (HERMES_TIMEZONE) is not visible from here.
async function configuredZone(dir) {
  const read = await readSmall(join(dir, 'config.yaml'), 1024 * 1024)
  if (read.state !== 'ok') return null
  for (const line of read.text.split(/\r?\n/)) {
    const match = /^timezone\s*:(.*)$/.exec(line)
    if (match) return canonicalZone(lineValue(match[1]))
  }
  return null
}

// The cadence of one job's schedule: a cron expression read in the computer's own zone, an interval
// of N minutes, or nothing the wall can use. A cron expression is a time on a wall clock, so it is only
// kept when every zone it could be read in - the job's own, if it names one, and the profile's
// configured one - is the computer's; an interval has no wall clock and needs no zone.
function scheduleOf(schedule, zone, profileZone) {
  const unknown = { cadence: { kind: 'unknown' } }
  if (!isPlainObject(schedule)) return unknown
  if (ONE_SHOT_KINDS.includes(schedule.kind)) return { ...unknown, oneShot: true }
  if (schedule.kind === 'interval') {
    return { cadence: cadenceFromInterval(typeof schedule.minutes === 'number' ? schedule.minutes * 60 : NaN) }
  }
  if (schedule.kind !== 'cron') return unknown
  const readIn = []
  const given = schedule.timezone
  if (given !== undefined && given !== null && given !== '') readIn.push(canonicalZone(given) ?? 'not a zone')
  if (profileZone) readIn.push(profileZone)
  if (readIn.some((named) => named !== zone)) return unknown
  return { cadence: cadenceFromCron(schedule.expr) }
}

// Hermes names a job that has no name after the first 50 characters of what it runs: its prompt,
// else its first skill, else its script (cron/jobs.py, create_job and _normalize_job_record; Python
// counts characters, not UTF-16 units, and strips the text before and after). Such a name IS the
// prompt, and a prompt can say anything. So a name equal to any of those, from the text as it is or
// stripped, is a copy, and is not published.
const firstFifty = (text) => Array.from(text).slice(0, 50).join('').trim()

function copiedFromWhatItRuns(name, row) {
  const wanted = name.trim()
  if (!wanted) return false
  const skills = [row.skill, ...(Array.isArray(row.skills) ? row.skills : typeof row.skills === 'string' ? [row.skills] : [])]
  for (const source of [row.prompt, row.script, ...skills]) {
    if (source === undefined || source === null) continue
    const text = String(source)
    if (firstFifty(text) === wanted || firstFifty(text.trim()) === wanted) return true
  }
  return false
}

// What the job is called on the wall, or null when its name is one the board would refuse. A record
// with no name, or a name Hermes copied from what the job runs, is shown as unnamed; the id, which the
// board already has, says which job it is.
function shownName(row, identity) {
  const given = row.name
  if (given === undefined || given === null || given === '') return UNNAMED_JOB
  if (typeof given !== 'string') return null
  if (copiedFromWhatItRuns(given, row)) return UNNAMED_JOB
  return checkConnectionName(given, 'name', identity).length ? null : given
}

// One job of the file as an item, or null when its id or name is one the board would refuse.
function hermesItem(profile, row, deps, zone, profileZone) {
  if (!isPlainObject(row) || typeof row.id !== 'string' || checkLabel(row.id, 'id', deps.identity).length) return null
  const name = shownName(row, deps.identity)
  if (name === null) return null
  const { cadence, oneShot } = scheduleOf(row.schedule, zone, profileZone)
  // Hermes reads a record with no `enabled` key as on, and anything else by whether it is truthy
  // (cron/jobs.py, is_job_runnable); a job that runs once is written as off.
  const enabled = (row.enabled === undefined ? true : Boolean(row.enabled)) && !oneShot
  const item = { profile, id: row.id, name, enabled, cadence }
  const lastRunAt = hermesTime(row.last_run_at, deps.now)
  if (lastRunAt) item.lastRunAt = lastRunAt
  item.lastResult = resultOf(row.last_status)
  if (enabled && zone) Object.assign(item, dueTimes(cadence, zone, deps.now))
  return item
}

const byNameThenId = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// deps: { home, env, platform, now, identity }. `zone` is the computer's timezone, or null.
export async function collectHermesJobs(deps, zone) {
  const root = hermesRoot(deps)
  const state = await folderState(root)
  if (state === 'missing') return { ...NOT_FOUND }
  if (state !== 'folder') return { ...UNREADABLE }
  const { folders, hidden: refusedProfiles, more: skippedProfiles } = await profileFolders(root, deps.identity)
  let hidden = refusedProfiles
  const items = []
  for (const { name: profile, dir } of folders) {
    const read = await readSmallJson(join(dir, 'cron', 'jobs.json'), HERMES_JOBS_FILE_BYTES)
    if (read.state === 'missing') continue
    // Hermes writes { jobs: [...] }; a bare list is read too. A file that cannot be read, or has no
    // list of jobs in it, counts as one thing not shown.
    const rows = read.state !== 'ok' ? null : Array.isArray(read.value) ? read.value : isPlainObject(read.value) && Array.isArray(read.value.jobs) ? read.value.jobs : null
    if (!rows) {
      hidden += 1
      continue
    }
    const profileZone = await configuredZone(dir)
    const seen = new Set()
    const kept = []
    for (const row of rows) {
      const item = hermesItem(profile, row, deps, zone, profileZone)
      // Dropped and counted: a name or id the board would refuse, a row that is not a job, an id seen already.
      if (!item || seen.has(item.id)) {
        hidden += 1
        continue
      }
      seen.add(item.id)
      kept.push(item)
    }
    items.push(...kept.sort(byNameThenId))
  }
  // A profile past the cap is counted once; its jobs are not read.
  return { status: 'found', items: items.slice(0, JOBS_CAPS.hermes), hidden, more: skippedProfiles + Math.max(0, items.length - JOBS_CAPS.hermes) }
}

// --- the whole part ---------------------------------------------------------------------------------------------------

// The computer's timezone as the gate will accept it, or null when this runtime does not know it. An
// alias is written the way the runtime spells it (Asia/Kolkata as Asia/Calcutta).
export function machineZone(deps) {
  const named = canonicalZone(deps?.timezone)
  return named && isKnownTimezone(named) ? named : null
}

async function safely(read) {
  try {
    return await read()
  } catch {
    return { ...UNREADABLE }
  }
}

// The file must stay under what the board reads. Past that, the schedules with the most slots are
// given up first - the job stays on the wall, its schedule unknown and no due times - until it fits.
export function fitToFile(doc) {
  const size = () => Buffer.byteLength(`${JSON.stringify(doc, null, 2)}\n`)
  const rows = ['launchd', 'hermes'].flatMap((block) => (doc[block]?.status === 'found' ? doc[block].items : []))
  while (size() > JOBS_MAX_FILE_BYTES) {
    let biggest = null
    for (const row of rows) {
      if (row.cadence.kind === 'slots' && (!biggest || row.cadence.slots.length > biggest.cadence.slots.length)) biggest = row
    }
    if (!biggest) break
    biggest.cadence = { kind: 'unknown' }
    delete biggest.dueAt
    delete biggest.dueBeforeAt
  }
  return doc
}

// The jobs file for one computer. Not a Mac: launchd is not found. No Hermes: hermes is not found.
// Without a timezone this runtime knows, the file says UTC, still lists every schedule, and has no due times.
export async function collectJobs(deps, computer) {
  const zone = machineZone(deps)
  const launchd = await safely(() => collectLaunchd(deps, zone))
  const hermes = await safely(() => collectHermesJobs(deps, zone))
  return fitToFile({ schema: JOBS_SCHEMA, takenAt: isoSeconds(deps.now), computer, timezone: zone ?? 'UTC', launchd, hermes })
}
