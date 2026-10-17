// How far a run has got, kept in one small file while Claude works: progress/<order id>.json in the runner's STATE folder.
//
// WHAT IS IN IT: a phase (started, working, finishing), how many tool calls have been made and how many of each tool, the last tool's name, when the run
// started and when anything last happened, and whether it is over. Counts and fixed words and times - NEVER a word Claude wrote or read, a path, an
// input or an error: this module is only ever handed the event types and tool names claude.mjs reports, builds the file from those fixed fields alone, and
// counts a name that is not a plain tool name as "unknown" without keeping it. (The same rule as last-tick.json: "never a word anyone typed".)
//
// HOW: written at most once every 2 seconds (the first event at once, and the end always), to a temporary name and then moved into place, so a reader sees
// the whole old file or the whole new one. 0600 in a 0700 folder on a Mac; on Windows the state folder is already the current account's alone and a new
// file inherits that (windows.mjs). The file is capped in size. Writing it is best effort: a failure here is never a failure of the run.
//
// ENDING: a run that ends writes the file once more with final: true and an outcome - the order's real end state, the one its final word records (ok,
// failed, or unknown for an order a signal stopped; tick.mjs writes it when the order is settled, not when Claude stops). A run whose runner died leaves the last write, not
// final; the next tick (which holds the lock, so nothing is running) marks it final with the outcome "stale" and removes finished files after a day.

import * as realFs from 'node:fs/promises'
import { join } from 'node:path'
import { isoSeconds } from '../status/util.mjs'
import { ID_SHAPE } from './contract.mjs'
import { MAILBOX_MAX_STEPS } from '../status/mailbox-schema.mjs'

export const PROGRESS = Object.freeze({
  schema: 'agent-mailbox-progress/v1',
  folder: 'progress',
  throttleMs: 2000,
  maxBytes: 4096,
  maxTools: 16,
  keepSeconds: 24 * 60 * 60,
  // One cap for the file and for the status file's steps (mailbox-schema.mjs): they can never disagree about what is too many.
  maxSteps: MAILBOX_MAX_STEPS,
  finishWaitMs: 2000,
  finalTries: 3,
  finalBackoffMs: 100
})

const TOOL_NAME = /^[A-Za-z0-9_*-]{1,64}$/
const PHASES = ['started', 'working', 'finishing']
const OUTCOMES = ['ok', 'failed', 'unknown', 'stale']
const TEMPORARY = /\.tmp$/

// The tool name as it is kept: a plain name, or the word "unknown" (a name that is anything else is counted and thrown away).
const safeName = (name) => (typeof name === 'string' && TOOL_NAME.test(name) ? name : 'unknown')

// The whole file, built from fixed fields only.
function documentOf(s) {
  return {
    schema: PROGRESS.schema,
    id: s.id,
    phase: s.phase,
    startedAt: s.startedAt,
    lastEventAt: s.lastEventAt,
    steps: s.steps,
    calls: s.calls,
    lastTool: s.lastTool,
    final: s.final,
    ...(s.outcome ? { outcome: s.outcome } : {})
  }
}

// One file written whole: to a temporary name in the same folder, then moved into place. The folder is made 0700 if it is not there; a folder that is a
// link, or a file in its place, is not written through. -> true when written.
async function writeDocument(fs, stateDir, id, doc) {
  const text = `${JSON.stringify(doc)}\n`
  if (Buffer.byteLength(text) > PROGRESS.maxBytes) return false
  const folder = join(stateDir, PROGRESS.folder)
  let info = null
  try {
    info = await fs.lstat(folder)
  } catch (error) {
    if (error?.code !== 'ENOENT') return false
  }
  if (info !== null && !info.isDirectory()) return false
  if (info === null) await fs.mkdir(folder, { recursive: true, mode: 0o700 })
  const path = join(folder, `${id}.json`)
  const temporary = `${path}.${process.pid}.tmp`
  await fs.writeFile(temporary, text, { mode: 0o600 })
  await fs.rename(temporary, path)
  return true
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const realTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle) }
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

// -> { onEvent(event), finish({ outcome } | { ok }), settled(), steps() }
//   now()     milliseconds (the runner's clock)
//   timers    { set(fn, ms), clear(handle) }, for the catch-up write and the limit on waiting (a test supplies its own)
//   sleep(ms) the back-off between tries of the final write
// onEvent is synchronous and never throws; the file is written behind it, in order.
export function createProgress({ stateDir, id, now, fs = realFs, timers = realTimers, sleep = realSleep }) {
  if (typeof id !== 'string' || !ID_SHAPE.test(id)) throw new TypeError('progress: an order id is 32 lowercase hex characters')
  if (typeof stateDir !== 'string' || stateDir === '') throw new TypeError('progress: the state folder is a path')
  const started = now()
  const s = { id, phase: 'started', startedAt: isoSeconds(started), lastEventAt: isoSeconds(started), steps: 0, calls: {}, lastTool: null, final: false, outcome: null }
  let queue = Promise.resolve()
  let lastWriteAt = null
  let catchUp = null

  // What is written is the state at the moment the write runs, so events that arrive together are one write. The final write is tried again a couple
  // of times: on Windows a virus scanner or the indexer can hold the file for a moment.
  const write = (tries = 1) => {
    queue = queue.then(async () => {
      for (let attempt = 1; attempt <= tries; attempt += 1) {
        try {
          return await writeDocument(fs, stateDir, id, documentOf(s))
        } catch (error) {
          if (attempt === tries || !RETRY_CODES.has(error?.code)) return false
          await sleep(PROGRESS.finalBackoffMs * attempt)
        }
      }
      return false
    }).catch(() => false)
  }
  const clearCatchUp = () => {
    if (catchUp !== null) timers.clear(catchUp)
    catchUp = null
  }
  // A clock that went back is "write now" (a negative gap), never "wait until it catches up".
  const due = () => lastWriteAt === null || now() - lastWriteAt < 0 || now() - lastWriteAt >= PROGRESS.throttleMs
  const touch = () => {
    s.lastEventAt = isoSeconds(now())
    if (due()) {
      clearCatchUp()
      lastWriteAt = now()
      write()
      return
    }
    // Skipped for now: ONE write at the end of the window, so the file is never left stale because no further event came.
    if (catchUp !== null) return
    catchUp = timers.set(() => {
      catchUp = null
      if (s.final) return
      lastWriteAt = now()
      write()
    }, Math.min(PROGRESS.throttleMs, Math.max(1, PROGRESS.throttleMs - (now() - lastWriteAt))))
    catchUp?.unref?.()
  }

  return {
    onEvent(event) {
      try {
        if (s.final || event === null || typeof event !== 'object') return
        if (event.type === 'started') {
          s.phase = 'started'
          touch()
        } else if (event.type === 'tool') {
          const name = safeName(event.name)
          // Past the cap, a new name is counted under "other": the file cannot grow with what a run does.
          const key = Object.hasOwn(s.calls, name) || Object.keys(s.calls).length < PROGRESS.maxTools ? name : 'other'
          s.calls[key] = (s.calls[key] ?? 0) + 1
          s.steps = Math.min(s.steps + 1, PROGRESS.maxSteps)
          s.lastTool = name
          s.phase = 'working'
          touch()
        } else if (event.type === 'finishing') {
          s.phase = 'finishing'
          touch()
        }
      } catch {
        // Best effort.
      }
    },
    // The order is over: one more write, always, marked final, carrying the order's real end state. The first call wins; later ones only wait. The wait
    // is limited: a disk that hangs delays the order's own final word by about 2 seconds, never more.
    async finish({ outcome, ok } = {}) {
      let limit = null
      try {
        if (!s.final) {
          const end = outcome ?? (ok === true ? 'ok' : 'failed')
          s.final = true
          s.outcome = ['ok', 'failed', 'unknown'].includes(end) ? end : 'failed'
          s.phase = 'finishing'
          s.lastEventAt = isoSeconds(now())
          lastWriteAt = now()
          clearCatchUp()
          write(PROGRESS.finalTries)
        }
        await Promise.race([queue, new Promise((resolve) => {
          limit = timers.set(resolve, PROGRESS.finishWaitMs)
          limit?.unref?.()
        })])
      } catch {
        // Best effort.
      } finally {
        if (limit !== null) timers.clear(limit)
      }
    },
    id,
    settled: () => queue,
    steps: () => s.steps
  }
}

// The state of a file read back, rebuilt from the fields it is allowed to have: anything else in it is dropped.
function cleaned(id, value) {
  if (value === null || typeof value !== 'object' || value.schema !== PROGRESS.schema || value.id !== id) return null
  const whole = (n) => Number.isSafeInteger(n) && n >= 0 && n <= PROGRESS.maxSteps
  const time = (t) => typeof t === 'string' && Number.isFinite(Date.parse(t))
  if (!PHASES.includes(value.phase) || !time(value.startedAt) || !time(value.lastEventAt) || !whole(value.steps) || typeof value.final !== 'boolean') return null
  const calls = {}
  if (value.calls === null || typeof value.calls !== 'object' || Array.isArray(value.calls)) return null
  for (const [name, count] of Object.entries(value.calls).slice(0, PROGRESS.maxTools + 2)) {
    if (TOOL_NAME.test(name) && whole(count)) calls[name] = count
  }
  return {
    schema: PROGRESS.schema, id, phase: value.phase, startedAt: value.startedAt, lastEventAt: value.lastEventAt, steps: value.steps, calls,
    lastTool: value.lastTool === null ? null : safeName(value.lastTool), final: value.final,
    ...(OUTCOMES.includes(value.outcome) ? { outcome: value.outcome } : {})
  }
}

// At the start of a tick, which holds the lock, so no run of this runner is alive: a file that is not final belongs to a run that never finished and is
// marked final, outcome "stale", keeping what it counted and when it was last heard from. A finished file older than a day, a file that is not one of
// ours, and a leftover temporary file are removed. Best effort; never throws.
export async function settleLeftovers({ stateDir, now, fs = realFs }) {
  const folder = join(stateDir, PROGRESS.folder)
  let names = []
  try {
    // A link or junction in place of the folder leads somewhere that is not ours: change nothing there.
    if (!(await fs.lstat(folder)).isDirectory()) return
    names = await fs.readdir(folder)
  } catch {
    return
  }
  for (const name of names) {
    const path = join(folder, name)
    try {
      const info = await fs.lstat(path)
      if (!info.isFile()) continue
      const id = /^([0-9a-f]{32})\.json$/.exec(name)?.[1]
      let doc = null
      if (id !== undefined && info.size <= PROGRESS.maxBytes) {
        try {
          doc = cleaned(id, JSON.parse(await fs.readFile(path, 'utf8')))
        } catch {
          doc = null
        }
      }
      if (doc === null || TEMPORARY.test(name)) {
        await fs.rm(path, { force: true })
      } else if (!doc.final) {
        await writeDocument(fs, stateDir, id, { ...doc, final: true, outcome: 'stale' })
      } else if (now - info.mtimeMs > PROGRESS.keepSeconds * 1000) {
        await fs.rm(path, { force: true })
      }
    } catch {
      // The next tick looks again.
    }
  }
}
