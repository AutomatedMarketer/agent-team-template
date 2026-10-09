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

import { readdir, stat } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { JOBS_CAPS } from './jobs-schema.mjs'
import { cadenceFromCalendar, cadenceFromInterval, dueTimes } from './cadence.mjs'
import { checkLabel } from './safe.mjs'
import { emptyFolder, VERSION_TIMEOUT_MS } from './programs.mjs'
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
