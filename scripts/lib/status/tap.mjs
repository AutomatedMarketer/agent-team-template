// The status line tap: the OFFICIAL Claude plan-limit reading.
//
// Claude Code runs a status line command after every reply and hands it a JSON description of
// the session on stdin. For Pro and Max that JSON carries `rate_limits.five_hour` and
// `rate_limits.seven_day` - the same percentages the /usage screen shows, published in Claude
// Code's own docs (code.claude.com/docs/en/statusline). Nothing else reads them: they exist only
// inside an interactive session. So scripts/usage-tap.mjs runs as (or in front of) the status
// line, keeps those two readings in a small file in this person's state folder, and the
// collector picks the file up later.
//
// The same stdin also carries the working folder, session ids, the transcript path, the model
// and the cost. None of it is kept: the file is built from two numbers and two times, and passes
// the same fail-closed gate as the usage snapshot before it is written.
//
// This module owns the file format both ways - the tap writes it, the collector reads it - so the
// two can never disagree about where it is or what it holds.

import { join, dirname } from 'node:path'
import { mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { isPlainObject, isoSeconds, toIsoTime, cleanPercent, readJson } from './util.mjs'
import { checkAgainst } from './safe.mjs'

export const TAP_SCHEMA = 'agent-status/claude-statusline/v1'
// An unchanged reading is rewritten at most once a minute. The status line runs after every reply,
// so without this a busy session would rewrite the same two numbers many times a minute.
export const REWRITE_AFTER_MS = 60_000
// Status line JSON is a few kilobytes. Anything far bigger is not what Claude Code sends.
const STDIN_LIMIT = 1_000_000

// Only these two. `spend_limit` (behind a Claude apps gateway) is a dollar budget, not a plan
// window, and is deliberately not read.
const STATUS_LINE_WINDOWS = [
  ['five_hour', 'five_hour', '5h'],
  ['seven_day', 'weekly_all', 'wk']
]
const TAP_KINDS = STATUS_LINE_WINDOWS.map(([, kind]) => kind)

// Per user and per computer, outside every repo. XDG_STATE_HOME is ignored on purpose: the tap
// runs inside Claude Code with the terminal's environment, the collector may run from launchd
// with a thinner one, and both must land on the same file.
export function tapFilePath({ home, env = {}, platform }) {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    return join(base, 'agent-status', 'claude-statusline.json')
  }
  return join(home, '.local', 'state', 'agent-status', 'claude-statusline.json')
}

// resets_at is Unix epoch seconds in the docs. Anything else is not understood.
function resetTime(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null
  return toIsoTime(raw)
}

// Returns the windows found, possibly none. A window it does not fully understand is left out:
// the other one is still a true reading, and a guess would not be.
export function readingFromStatusLine(input) {
  const limits = isPlainObject(input) && isPlainObject(input.rate_limits) ? input.rate_limits : null
  if (!limits) return []
  const windows = []
  for (const [field, kind] of STATUS_LINE_WINDOWS) {
    const raw = limits[field]
    if (!isPlainObject(raw)) continue
    const usedPercent = cleanPercent(raw.used_percentage)
    if (usedPercent === null) continue
    const window = { kind, usedPercent }
    if (raw.resets_at !== undefined && raw.resets_at !== null) {
      const resetsAt = resetTime(raw.resets_at)
      if (!resetsAt) continue
      window.resetsAt = resetsAt
    }
    windows.push(window)
  }
  return windows
}

export function shortLine(windows) {
  return windows
    .map((window) => {
      const label = STATUS_LINE_WINDOWS.find(([, kind]) => kind === window.kind)?.[2]
      return label ? `${label} ${Math.round(window.usedPercent)}%` : null
    })
    .filter(Boolean)
    .join(' · ')
}

// --- the file, held to the same gate as the snapshot -----------------------------------------------

const TAP_WINDOW_SHAPE = {
  type: 'object',
  keys: {
    kind: { type: 'enum', values: TAP_KINDS },
    usedPercent: { type: 'percent' },
    resetsAt: { type: 'iso' }
  },
  required: ['kind', 'usedPercent']
}

export const TAP_SHAPE = {
  type: 'object',
  keys: {
    schema: { type: 'const', value: TAP_SCHEMA },
    capturedAt: { type: 'iso' },
    windows: { type: 'array', of: TAP_WINDOW_SHAPE, min: 1, max: STATUS_LINE_WINDOWS.length }
  },
  required: ['schema', 'capturedAt', 'windows']
}

const sameWindows = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// Returns true when it wrote. Never throws: a status line that errors goes blank, and the person
// loses the line they had for the sake of a meter.
async function saveReading(path, windows, now) {
  try {
    const earlier = await readJson(path)
    if (earlier.state === 'ok' && isPlainObject(earlier.value) && sameWindows(earlier.value.windows, windows)) {
      const age = now - Date.parse(earlier.value.capturedAt)
      if (age >= 0 && age < REWRITE_AFTER_MS) return false
    }
    const doc = { schema: TAP_SCHEMA, capturedAt: isoSeconds(now), windows }
    if (checkAgainst(doc, TAP_SHAPE, {}).length) return false
    await mkdir(dirname(path), { recursive: true })
    // Written beside the target and renamed over it, so the collector - or a second Claude Code
    // window running its own status line - never reads half a file. Claude Code cancels a status
    // line that is still running when the next update comes; a rename is all or nothing.
    const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(doc)}\n`)
      await rename(temporary, path)
    } catch {
      await rm(temporary, { force: true }).catch(() => {})
      return false
    }
    return true
  } catch {
    return false
  }
}

// --- the command line -----------------------------------------------------------------------------

// `--then <command>` runs an earlier status line after the tap. `--then64 <base64url>` is the same
// command encoded: the installer writes that form because a status line command is parsed by
// /bin/sh on a Mac and by Git Bash or PowerShell on Windows, and those quote differently - an
// earlier command holding quotes (jq one-liners do) would arrive mangled in at least one of them.
// Anything else on the command line is ignored, never an error.
export function earlierCommand(argv = []) {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === '--then' && argv[index + 1]) return argv[index + 1]
    if (argv[index] === '--then64' && /^[A-Za-z0-9_-]+$/.test(argv[index + 1])) {
      const decoded = Buffer.from(argv[index + 1], 'base64url').toString('utf8')
      return decoded || null
    }
  }
  return null
}

// The shell the earlier command was written for. Claude Code runs status lines with /bin/sh on a
// Mac or Linux, and on Windows with Git Bash when it is installed (then SHELL names its bash.exe
// in the environment Claude Code passes down) or PowerShell when it is not.
export function shellFor(platform, env = {}, exists = () => false) {
  if (platform === 'win32') {
    const bash = env.SHELL
    if (typeof bash === 'string' && /bash(\.exe)?$/i.test(bash) && exists(bash)) return [bash, ['-c']]
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command']]
  }
  return ['/bin/sh', ['-c']]
}

// deps: { input, argv, home, env, platform, now, runThen? }
// Returns { stdout, wrote }. The caller prints stdout as it is and nothing else.
export async function runTap({ input, argv = [], home, env = {}, platform, now, runThen }) {
  let windows = []
  try {
    if (typeof input === 'string' && input.length <= STDIN_LIMIT) windows = readingFromStatusLine(JSON.parse(input))
  } catch {
    windows = []
  }
  const command = earlierCommand(argv)
  const saving = windows.length ? saveReading(tapFilePath({ home, env, platform }), windows, now) : Promise.resolve(false)
  let stdout
  if (command && typeof runThen === 'function') {
    // The earlier line, exactly as it printed it. If it fails, the bar is left empty rather than
    // filled with an error message that may name a folder.
    stdout = await Promise.resolve()
      .then(() => runThen(command, input ?? ''))
      .then((text) => (typeof text === 'string' ? text : ''))
      .catch(() => '')
  } else {
    const line = shortLine(windows)
    stdout = line ? `${line}\n` : ''
  }
  const wrote = await saving
  return { stdout, wrote }
}
