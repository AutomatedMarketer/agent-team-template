// The Claude plan-limits meter: how much of the 5-hour and weekly windows is used.
//
// Order: the live answer from the address the /usage screen uses, then the reading Claude Code
// saved in ~/.claude.json, then "unavailable". Both are undocumented, which is why the file names
// its source and the board labels it "unofficial".
//
// The sign-in token is read into one variable, sent to one address, and dropped. It is never
// returned, logged or refreshed - refreshing it could sign Claude Code out on this machine.

import { join } from 'node:path'
import { isPlainObject, isoSeconds, toIsoTime, cleanPercent, readJson } from './util.mjs'
import { MAX_WINDOWS } from './schema.mjs'

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const USER_AGENT = 'agent-team-collector/1'
// The full path, never the bare name: a bare name is looked up on PATH, and a program called
// `security` earlier on PATH would be handed the sign-in.
export const KEYCHAIN_COMMAND = ['/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']]
export const SAVED_MAX_AGE_HOURS = 6
const LIVE_TIMEOUT_MS = 10_000

export function claudeConfigDir({ home, env = {} }) {
  return env.CLAUDE_CONFIG_DIR || join(home, '.claude')
}

// Claude Code keeps ~/.claude.json beside the config folder, or inside it when the folder has been
// moved with CLAUDE_CONFIG_DIR.
export function claudeStatePath({ home, env = {} }) {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(home, '.claude.json')
}

const unavailable = (why) => ({ status: 'unavailable', why })

// --- the answer parser ------------------------------------------------------------------------------

// A model name is shown on the board, so it has to look like one: "Fable", "Opus 4". Anything
// else - an email, a path, a token echoed back - spoils the reading rather than being trimmed.
function cleanModel(raw) {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9 .-]{0,23}$/.test(name)) return null
  return name[0].toUpperCase() + name.slice(1)
}

// A window the address lists with no number at all (null or missing) has nothing to report yet.
// It is left out - never shown as 0. A number that is there but is not a percentage is broken.
const NO_NUMBER = Symbol('no number')

function readWindow(raw, kind, model) {
  if (!isPlainObject(raw)) return null
  const rawPercent = raw.percent ?? raw.utilization ?? raw.used_percentage
  if (rawPercent === undefined || rawPercent === null) return NO_NUMBER
  const percent = cleanPercent(rawPercent)
  if (percent === null) return null
  const window = { kind }
  if (model) window.model = model
  window.usedPercent = percent
  if (raw.resets_at !== undefined && raw.resets_at !== null) {
    const resetsAt = toIsoTime(raw.resets_at)
    if (!resetsAt) return null
    window.resetsAt = resetsAt
  }
  return window
}

const BROKEN = Symbol('broken')

// The 2026 shape: limits[] with kind session / weekly_all / weekly_scoped. Unknown kinds are
// codenames for things nobody has explained, so they are skipped. A weekly_scoped entry with no
// model says nothing a person could act on, so it is skipped too.
function fromLimitsList(list, tally) {
  const windows = []
  for (const entry of list) {
    if (!isPlainObject(entry)) continue
    let kind
    let model = null
    if (entry.kind === 'session') kind = 'five_hour'
    else if (entry.kind === 'weekly_all') kind = 'weekly_all'
    else if (entry.kind === 'weekly_scoped') {
      const rawModel = entry.scope?.model?.display_name
      if (rawModel === undefined || rawModel === null) continue
      model = cleanModel(rawModel)
      if (!model) return BROKEN
      kind = 'weekly_model'
    } else continue
    const window = readWindow(entry, kind, model)
    if (window === NO_NUMBER) {
      tally.withoutNumbers += 1
      continue
    }
    if (!window) return BROKEN
    windows.push(window)
  }
  return windows
}

// The older flat shape. Only the fields whose meaning is known are read.
const FLAT_FIELDS = [
  ['five_hour', 'five_hour', null],
  ['seven_day', 'weekly_all', null],
  ['seven_day_opus', 'weekly_model', 'Opus'],
  ['seven_day_sonnet', 'weekly_model', 'Sonnet']
]

function fromFlatFields(answer, tally) {
  const windows = []
  for (const [field, kind, model] of FLAT_FIELDS) {
    if (answer[field] === undefined || answer[field] === null) continue
    const window = readWindow(answer[field], kind, model)
    if (window === NO_NUMBER) {
      tally.withoutNumbers += 1
      continue
    }
    if (!window) return BROKEN
    windows.push(window)
  }
  return windows
}

// Returns the windows; an empty list when every window it recognised had no number; or null when
// the answer is not understood.
// Never a partial reading: one recognised window with a broken number spoils the lot, because a
// meter that silently drops the window you were about to hit is worse than one that says
// "unavailable". A window with no number at all is different - there is nothing to drop. At most
// MAX_WINDOWS are kept, in the order the address gave them: one more and the gate would refuse
// the whole snapshot.
export function parseClaudeUsage(answer) {
  if (!isPlainObject(answer)) return null
  const tally = { withoutNumbers: 0 }
  let windows = []
  if (Array.isArray(answer.limits)) {
    const listed = fromLimitsList(answer.limits, tally)
    if (listed === BROKEN) return null
    windows = listed
  }
  if (windows.length === 0) {
    const flat = fromFlatFields(answer, tally)
    if (flat === BROKEN) return null
    windows = flat
  }
  const seen = new Set()
  const unique = windows.filter((window) => {
    const key = `${window.kind}:${window.model ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (unique.length) return unique.slice(0, MAX_WINDOWS)
  return tally.withoutNumbers > 0 ? [] : null
}

// --- reading the sign-in ------------------------------------------------------------------------------

// The Keychain answer is the credentials JSON itself. It goes straight into JSON.parse and is never
// printed; a failure (no entry, a locked Keychain, no `security` binary) falls back to the file.
async function readKeychain(deps) {
  if (deps.platform !== 'darwin' || typeof deps.exec !== 'function') return null
  try {
    const [file, args] = KEYCHAIN_COMMAND
    const { stdout } = await deps.exec(file, args, { timeout: LIVE_TIMEOUT_MS, encoding: 'utf8' })
    const text = String(stdout ?? '').trim()
    return text || null
  } catch {
    return null
  }
}

async function readCredentials(deps) {
  let parsed = null
  const fromKeychain = await readKeychain(deps)
  if (fromKeychain) {
    try {
      parsed = JSON.parse(fromKeychain)
    } catch {
      parsed = null
    }
  }
  if (!parsed) {
    const file = await readJson(join(claudeConfigDir(deps), '.credentials.json'))
    if (file.state === 'missing') return { status: 'not found' }
    if (file.state === 'broken') return { status: 'unavailable' }
    parsed = file.value
  }
  const oauth = isPlainObject(parsed) ? parsed.claudeAiOauth : null
  // No subscription sign-in at all (an API-key setup) is "not found", not broken.
  if (!isPlainObject(oauth)) return { status: 'not found' }
  return {
    status: 'found',
    token: typeof oauth.accessToken === 'string' && oauth.accessToken ? oauth.accessToken : null,
    expiresAt: Number.isFinite(oauth.expiresAt) ? oauth.expiresAt : null,
    account: {
      subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
      rateLimitTier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : null
    }
  }
}

async function readLive(deps, token) {
  let response
  try {
    response = await deps.fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': USER_AGENT,
        Accept: 'application/json'
      },
      // A redirect would re-send the header to wherever it points. There is no reason to follow one.
      redirect: 'error',
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS)
    })
  } catch {
    return unavailable('live call failed')
  }
  if (!response?.ok) return unavailable('live answer refused')
  let answer
  try {
    answer = JSON.parse(await response.text())
  } catch {
    return unavailable('live answer not understood')
  }
  const windows = parseClaudeUsage(answer)
  if (!windows) return unavailable('live answer not understood')
  if (windows.length === 0) return unavailable('the live answer had no numbers in it')
  return { status: 'found', source: 'unofficial-live', readAt: isoSeconds(deps.now), windows }
}

async function readSaved(deps) {
  const file = await readJson(claudeStatePath(deps))
  if (file.state === 'missing') return { status: 'not found' }
  if (file.state === 'broken') return unavailable('saved reading not understood')
  const saved = isPlainObject(file.value) ? file.value.cachedUsageUtilization : undefined
  if (saved === undefined || saved === null) return { status: 'not found' }
  if (!isPlainObject(saved) || !Number.isFinite(saved.fetchedAtMs)) return unavailable('saved reading not understood')
  const age = deps.now - saved.fetchedAtMs
  if (age < 0) return unavailable('saved reading not trusted')
  if (age > SAVED_MAX_AGE_HOURS * 3600_000) return unavailable('saved reading too old')
  const windows = parseClaudeUsage(saved.utilization)
  if (!windows) return unavailable('saved reading not understood')
  if (windows.length === 0) return unavailable('the saved reading had no numbers in it')
  return { status: 'found', source: 'claude-code-saved', readAt: isoSeconds(saved.fetchedAtMs), windows }
}

// --- whether this Node can be trusted with the token -------------------------------------------

// Settings that let something other than the real address read the token: certificate checks
// off, certificates added or swapped for another store, or code loaded into Node before the
// collector runs. Each matches the option alone or with "=value"; -r is --require's short form.
const CODE_OR_CERTIFICATE_OPTIONS = ['--use-system-ca', '--use-openssl-ca', '--require', '-r', '--import', '--loader', '--experimental-loader']

const matches = (option, flag) => option === flag || option.startsWith(`${flag}=`)
// A debugger attached to this Node can read any variable, the token included. Every inspector
// option starts this way (--inspect, --inspect-brk, --inspect-port, --inspect-wait, ...).
const opensDebugger = (option) => option.startsWith('--inspect')
const changesCodeOrCertificates = (option) => CODE_OR_CERTIFICATE_OPTIONS.some((flag) => matches(option, flag))

const optionsIn = (text) => (typeof text === 'string' ? text.split(/\s+/).map((option) => option.replace(/^["']+|["']+$/g, '')) : [])

// Returns the reason the token must stay home, or null. A meter is not worth the token, so with
// any of these the live call is skipped and the saved reading tried instead. The reason names
// the setting, never its value: the value is usually a file path. `execArgv` is Node's own
// command line (process.execArgv), where the same options can be given instead of NODE_OPTIONS.
export function untrustedConnection(env = {}, execArgv = []) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') return 'certificate checks are switched off'
  if (typeof env.NODE_EXTRA_CA_CERTS === 'string' && env.NODE_EXTRA_CA_CERTS !== '') return 'NODE_EXTRA_CA_CERTS adds certificates'
  if (env.NODE_USE_SYSTEM_CA === '1') return 'NODE_USE_SYSTEM_CA changes certificates'
  const options = optionsIn(env.NODE_OPTIONS)
  if (options.some(changesCodeOrCertificates)) return 'NODE_OPTIONS changes certificates or loads code'
  if (options.some(opensDebugger)) return 'NODE_OPTIONS opens a debugger'
  const commandLine = Array.isArray(execArgv) ? execArgv.map(String) : []
  if (commandLine.some((option) => changesCodeOrCertificates(option) || opensDebugger(option))) {
    return 'node was started with certificate, code or debug options'
  }
  return null
}

// deps: { home, env, execArgv, platform, now (ms), fetch, exec }
// Returns { limits, account }. `account` holds the two plan words from the sign-in, for plans.mjs
// to turn into a name; it is never written as-is.
export async function collectClaudeLimits(deps) {
  const credentials = await readCredentials(deps)
  const account = credentials.status === 'found' ? credentials.account : null

  let live = null
  if (credentials.status === 'found' && credentials.token) {
    const expired = credentials.expiresAt !== null && credentials.expiresAt <= deps.now
    const untrusted = untrustedConnection(deps.env, deps.execArgv)
    if (expired) live = unavailable('sign-in expired')
    else if (untrusted) live = unavailable(untrusted)
    else live = await readLive(deps, credentials.token)
    if (live.status === 'found') return { limits: live, account }
  }

  const saved = await readSaved(deps)
  if (saved.status === 'found') return { limits: saved, account }

  // Neither worked. The live reason is the more useful one to show, because it is what the person
  // can fix; the saved reason only matters when there was no sign-in to try.
  if (live) return { limits: live, account }
  if (saved.status === 'unavailable') return { limits: saved, account }
  if (credentials.status === 'unavailable') return { limits: unavailable('credentials not understood'), account }
  return { limits: { status: 'not found' }, account }
}
