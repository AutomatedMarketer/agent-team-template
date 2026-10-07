// The Codex plan-limits meter, read from Codex's own session logs.
//
// Codex writes a `rate_limits` reading into ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl as it
// works. The newest non-empty one is the meter. Only the tail of a log is read: logs grow to many
// megabytes and the reading that matters is always near the end. Lines hold working folders and
// conversation text, so nothing but the reading itself is ever kept.

import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isPlainObject, isoSeconds, toIsoTime, cleanPercent } from './util.mjs'

export const TAIL_BYTES = 256 * 1024
export const MAX_AGE_DAYS = 7
const DAY_MS = 86400_000

export function codexHomeDir({ home, env = {} }) {
  return env.CODEX_HOME || join(home, '.codex')
}

// window_minutes is the only thing that says which window a slot is. Older builds were seen one
// minute off, so a minute either way still counts.
function kindFor(minutes) {
  if (!Number.isFinite(minutes)) return null
  if (Math.abs(minutes - 300) <= 1) return 'five_hour'
  if (Math.abs(minutes - 10080) <= 1) return 'weekly'
  return null
}

// Returns the windows, or null when nothing in the reading is understood. A recognised window with
// a broken number spoils the lot - never a partial reading.
export function codexWindows(rateLimits, readAtMs) {
  if (!isPlainObject(rateLimits)) return null
  const windows = []
  for (const slot of [rateLimits.primary, rateLimits.secondary]) {
    if (slot === null || slot === undefined) continue
    if (!isPlainObject(slot)) return null
    const kind = kindFor(slot.window_minutes)
    if (!kind) continue
    const usedPercent = cleanPercent(slot.used_percent)
    if (usedPercent === null) return null
    const window = { kind, usedPercent }
    if (slot.resets_at !== undefined && slot.resets_at !== null) {
      const resetsAt = toIsoTime(slot.resets_at)
      if (!resetsAt) return null
      window.resetsAt = resetsAt
    } else if (Number.isFinite(slot.resets_in_seconds) && Number.isFinite(readAtMs)) {
      window.resetsAt = isoSeconds(readAtMs + slot.resets_in_seconds * 1000)
    }
    windows.push(window)
  }
  if (!windows.length) return null
  const order = ['five_hour', 'weekly']
  windows.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
  return windows
}

const pad = (value) => String(value).padStart(2, '0')

// Codex names its day folders by local date. A day either side is included so a clock near
// midnight, or a laptop that changed timezone, does not hide yesterday's log.
function recentDayFolders(now) {
  const folders = []
  for (let offset = -1; offset <= MAX_AGE_DAYS + 1; offset++) {
    const date = new Date(now - offset * DAY_MS)
    folders.push([String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate())])
  }
  return folders
}

async function recentLogs(sessionsDir, now) {
  const logs = []
  for (const [year, month, day] of recentDayFolders(now)) {
    const dir = join(sessionsDir, year, month, day)
    let names
    try {
      names = await readdir(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!/^rollout-.*\.jsonl$/.test(name)) continue
      try {
        const info = await stat(join(dir, name))
        if (info.isFile() && info.mtimeMs >= now - MAX_AGE_DAYS * DAY_MS) logs.push({ path: join(dir, name), mtimeMs: info.mtimeMs })
      } catch {
        // A log deleted mid-scan is simply not a candidate.
      }
    }
  }
  const unique = new Map(logs.map((log) => [log.path, log]))
  return [...unique.values()].sort((a, b) => b.mtimeMs - a.mtimeMs)
}

async function tailLines(path) {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - TAIL_BYTES)
    const buffer = Buffer.alloc(size - start)
    await handle.read(buffer, 0, buffer.length, start)
    let text = buffer.toString('utf8')
    // Starting mid-file means the first line is a fragment of something longer.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return text.split('\n')
  } finally {
    await handle.close()
  }
}

// The last reading in a log that actually has a window in it. Empty readings (both slots null)
// appear between turns and say nothing.
function lastReading(lines) {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (!line.includes('rate_limits')) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const rateLimits = entry?.payload?.rate_limits
    if (!isPlainObject(rateLimits)) continue
    if ((rateLimits.primary ?? null) === null && (rateLimits.secondary ?? null) === null) continue
    const at = Date.parse(entry.timestamp)
    return { rateLimits, at: Number.isFinite(at) ? at : null }
  }
  return null
}

// deps: { home, env, now (ms) }
export async function collectCodexLimits(deps) {
  const sessionsDir = join(codexHomeDir(deps), 'sessions')
  try {
    await stat(sessionsDir)
  } catch {
    return { status: 'not found' }
  }
  for (const log of await recentLogs(sessionsDir, deps.now)) {
    let lines
    try {
      lines = await tailLines(log.path)
    } catch {
      continue
    }
    const found = lastReading(lines)
    if (!found) continue
    if (found.at === null || found.at > deps.now + 5 * 60_000) return { status: 'unavailable', why: 'reading not trusted' }
    if (found.at < deps.now - MAX_AGE_DAYS * DAY_MS) continue
    const windows = codexWindows(found.rateLimits, found.at)
    // The newest reading is the meter. Falling back to an older one because the newest is in a
    // new shape would show last week's number as this week's.
    if (!windows) return { status: 'unavailable', why: 'reading not understood' }
    return { status: 'found', source: 'codex-session-log', readAt: isoSeconds(found.at), windows }
  }
  return { status: 'not found' }
}
