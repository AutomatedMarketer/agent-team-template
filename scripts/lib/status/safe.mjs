// The fail-closed gate. Every usage file, receipt and console line passes through here before it
// leaves the process, and anything that does not pass stops the run with nothing written.
//
// Why it is this strict: the collector reads files that hold sign-in tokens, account emails and
// folder names that contain the person's username, then writes into a repo that gets pushed.
// The sources are written to return only safe fields, but "written to" is a promise. This is the
// check that does not trust the promise. A problem names the field, never the value - the value
// is the thing that might be the secret.

import { USAGE_SHAPE, STATUSES, MAX_STRING_LENGTH, MAX_PERCENT, computerSlug } from './schema.mjs'
import { CONNECTIONS_SHAPE, CONNECTION_NAME, VERSION_PATTERN, MAX_VERSION_LENGTH } from './connections-schema.mjs'

export class GateError extends Error {
  constructor(problems) {
    super(`Nothing written. The safety check refused: ${problems.join('; ')}`)
    this.name = 'GateError'
    this.problems = problems
  }
}

// Fragments that never appear in anything this collector writes. `@` is every email, `/` and `\`
// are every path, `eyJ` is the start of every JWT, `sk-` is the start of Anthropic and OpenAI keys.
const NEVER = [
  { test: (value) => value.includes('@'), says: 'contains an at sign' },
  { test: (value) => value.includes('/'), says: 'contains a slash', slash: true },
  { test: (value) => value.includes('\\'), says: 'contains a backslash' },
  { test: (value) => value.includes('eyJ'), says: 'looks like a signed token' },
  { test: (value) => value.includes('sk-'), says: 'looks like a key' },
  { test: (value) => /bearer/i.test(value), says: 'looks like an authorization header' }
]

// Identity strings shorter than three characters are skipped: a two-letter account name would
// otherwise refuse "Max 20x" for containing "ma", and refuse everything forever.
function needlesOf(identity = {}) {
  const found = []
  const add = (value, says) => {
    if (typeof value !== 'string') return
    const needle = value.trim().toLowerCase()
    if (needle.length >= 3) found.push({ needle, says })
  }
  add(identity.username, 'contains the username')
  if (typeof identity.hostname === 'string') {
    add(identity.hostname, 'contains the computer name')
    add(identity.hostname.split('.')[0], 'contains the computer name')
  }
  if (typeof identity.home === 'string') {
    add(identity.home, 'contains the home folder')
    add(identity.home.replaceAll('\\', '/'), 'contains the home folder')
    add(identity.home.replaceAll('/', '\\'), 'contains the home folder')
  }
  return found
}

function stringProblems(value, path, identity, { allowSlash = false, exactForm = false } = {}) {
  if (typeof value !== 'string') return [`${path}: is not text`]
  const problems = []
  // A value held to an exact pattern (a 64-character hash) has its length set by the pattern.
  if (!exactForm && value.length > MAX_STRING_LENGTH) problems.push(`${path}: is longer than ${MAX_STRING_LENGTH} characters`)
  for (const rule of NEVER) {
    if (allowSlash && rule.slash) continue
    if (rule.test(value)) problems.push(`${path}: ${rule.says}`)
  }
  const lower = value.toLowerCase()
  for (const { needle, says } of needlesOf(identity)) {
    if (lower.includes(needle)) problems.push(`${path}: ${says}`)
  }
  return problems
}

// A key name is shown in a problem only when it is plainly a key name. An unexpected key could
// itself be the leak - a token used as a property name - so anything odd is described, not shown.
function keyLabel(key, identity) {
  if (/^[A-Za-z0-9_]{1,40}$/.test(key) && stringProblems(key, 'key', identity).length === 0) return key
  return '(a key that cannot be shown)'
}

const join = (path, key) => (path ? `${path}.${key}` : key)

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/

function isRealIsoTime(value) {
  if (typeof value !== 'string' || !ISO_TIME.test(value)) return false
  const ms = Date.parse(value)
  // Date.parse rolls 2026-02-31 over into March; a real time survives the round trip.
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19)
}

function isRealDay(value) {
  if (typeof value !== 'string' || !CALENDAR_DAY.test(value)) return false
  const ms = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value
}

let knownZones = null
export function isKnownTimezone(value) {
  if (!knownZones) {
    knownZones = new Set(['UTC'])
    try {
      for (const zone of Intl.supportedValuesOf('timeZone')) knownZones.add(zone)
    } catch {
      // An old runtime without the list falls back to UTC only - fail closed, not open.
    }
  }
  return knownZones.has(value)
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function walk(value, shape, path, identity, problems) {
  switch (shape.type) {
    case 'const':
      if (value !== shape.value) problems.push(`${path}: is not ${shape.value}`)
      return
    case 'text':
      problems.push(...stringProblems(value, path, identity))
      return
    case 'enum':
      if (typeof value !== 'string' || !shape.values.includes(value)) {
        problems.push(`${path}: is not one of the allowed values`)
      }
      return
    case 'percent':
      // Over 100 is over the limit and is written as it is; only past the ceiling is refused.
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_PERCENT) {
        problems.push(`${path}: is not a percentage between 0 and ${MAX_PERCENT}`)
      }
      return
    case 'count':
      if (!Number.isSafeInteger(value) || value < 0) problems.push(`${path}: is not a whole number of zero or more`)
      return
    case 'iso':
      if (!isRealIsoTime(value)) problems.push(`${path}: is not an ISO time in UTC`)
      return
    case 'day':
      if (!isRealDay(value)) problems.push(`${path}: is not a calendar day`)
      return
    case 'timezone':
      // A timezone name is the one string allowed a slash ("America/New_York"), so it is held to a
      // closed list instead - "Users/somebody" has a slash too and is not on it.
      problems.push(...stringProblems(value, path, identity, { allowSlash: true }))
      if (typeof value === 'string' && !isKnownTimezone(value)) problems.push(`${path}: is not a known timezone`)
      return
    case 'pattern':
      // Paths and hashes in receipts: held to an exact form, so the slash in a repo-relative path is
      // allowed and nothing else is.
      if (typeof value !== 'string' || !shape.pattern.test(value)) problems.push(`${path}: is not in the expected form`)
      else problems.push(...stringProblems(value, path, identity, { allowSlash: true, exactForm: true }))
      return
    case 'true':
      if (value !== true) problems.push(`${path}: must be true`)
      return
    case 'boolean':
      if (typeof value !== 'boolean') problems.push(`${path}: is not true or false`)
      return
    case 'version':
      // Digits and dots only: a version banner ("2.1.293 (Claude Code)") can carry a path or a name.
      if (typeof value !== 'string' || value.length > MAX_VERSION_LENGTH || !VERSION_PATTERN.test(value)) {
        problems.push(`${path}: is not a version number`)
      }
      return
    case 'connName':
      problems.push(...checkConnectionName(value, path, identity))
      return
    case 'array':
      if (!Array.isArray(value)) {
        problems.push(`${path}: is not a list`)
        return
      }
      if (value.length < (shape.min ?? 0)) problems.push(`${path}: has too few entries`)
      if (value.length > shape.max) problems.push(`${path}: has more than ${shape.max} entries`)
      value.slice(0, shape.max).forEach((item, index) => walk(item, shape.of, `${path}[${index}]`, identity, problems))
      if (shape.unique) {
        // The same name twice is a reading nobody can trust, and the board would show it twice.
        const seen = new Set()
        // An empty list of fields means the entries are plain values, compared whole.
        for (const item of value) {
          if (shape.unique.length && !isPlainObject(item)) continue
          const key = JSON.stringify(shape.unique.length ? shape.unique.map((field) => item[field]) : item)
          if (seen.has(key)) {
            problems.push(`${path}: names the same entry twice`)
            break
          }
          seen.add(key)
        }
      }
      return
    case 'object':
      walkObject(value, shape.keys, shape.required ?? [], path, identity, problems)
      if (shape.rule && isPlainObject(value)) {
        for (const [key, says] of shape.rule(value)) problems.push(`${join(path, key)}: ${says}`)
      }
      if (shape.modelWindow && isPlainObject(value)) {
        if (value.kind === 'weekly_model' && value.model === undefined) {
          problems.push(`${join(path, 'model')}: is missing for a model window`)
        }
        if (value.kind !== 'weekly_model' && value.model !== undefined) {
          problems.push(`${join(path, 'model')}: is only allowed on a model window`)
        }
      }
      return
    case 'block':
      walkBlock(value, shape, path, identity, problems)
      return
    default:
      problems.push(`${path}: has no rule`)
  }
}

function walkObject(value, keys, required, path, identity, problems) {
  if (!isPlainObject(value)) {
    problems.push(`${path || 'the file'}: is not an object`)
    return
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(keys, key)) problems.push(`${join(path, keyLabel(key, identity))}: is not an allowed key`)
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) problems.push(`${join(path, key)}: is missing`)
  }
  for (const [key, shape] of Object.entries(keys)) {
    if (Object.hasOwn(value, key)) walk(value[key], shape, join(path, key), identity, problems)
  }
}

// A block with nothing found carries its status and, at most, a reason. That is what keeps an
// invented zero out: a percentage can only arrive inside a block that says it found one.
function walkBlock(value, shape, path, identity, problems) {
  if (!isPlainObject(value)) {
    problems.push(`${path}: is not an object`)
    return
  }
  if (!STATUSES.includes(value.status)) {
    problems.push(`${join(path, 'status')}: is not one of the allowed values`)
    return
  }
  const textShape = { type: 'text' }
  if (value.status === 'found') {
    walkObject(value, { status: { type: 'enum', values: STATUSES }, ...shape.found }, shape.foundRequired, path, identity, problems)
  } else {
    walkObject(value, { status: { type: 'enum', values: STATUSES }, why: textShape }, [], path, identity, problems)
  }
}

export function checkUsage(doc, identity) {
  const problems = []
  walk(doc, USAGE_SHAPE, '', identity, problems)
  return problems
}

export function checkConnections(doc, identity) {
  const problems = []
  walk(doc, CONNECTIONS_SHAPE, '', identity, problems)
  return problems
}

export function checkAgainst(doc, shape, identity) {
  const problems = []
  walk(doc, shape, '', identity, problems)
  return problems
}

export function assertSafeUsage(doc, identity) {
  const problems = checkUsage(doc, identity)
  if (problems.length) throw new GateError(problems)
  return doc
}

export function assertSafe(doc, shape, identity) {
  const problems = checkAgainst(doc, shape, identity)
  if (problems.length) throw new GateError(problems)
  return doc
}

// Console lines are allowed a forward slash, because they name the repo-relative file they wrote.
// They are not allowed anything that reaches outside the repo: a drive letter, another person's
// home folder, or this person's.
export function checkLine(text, identity) {
  if (typeof text !== 'string') return ['line: is not text']
  const problems = stringProblems(text, 'line', identity, { allowSlash: true })
    .filter((problem) => !problem.endsWith(`longer than ${MAX_STRING_LENGTH} characters`))
  if (/[A-Za-z]:[\\/]/.test(text)) problems.push('line: names a drive')
  if (/\/(Users|home)\//i.test(text)) problems.push('line: names a home folder')
  return problems
}

export function assertSafeLine(text, identity) {
  const problems = checkLine(text, identity)
  if (problems.length) throw new GateError(problems)
  return text
}

// The label is the only free text a person gives the collector, and it ends up in the file name
// and inside the file. It is checked before any source is read, and it may not be the hostname -
// the hostname is often the person's name. It also lands in commit messages and console lines,
// so no control character: a newline could forge a log line, an escape could repaint a terminal.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/
// Characters that reorder text or break lines without looking like it: right-to-left overrides
// and isolates, the direction marks, and the Unicode line and paragraph separators.
const DIRECTION_OR_LINE_CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/

// The board's own name rule (agent-cockpit api/state.js, NAME_CHARACTERS and NOT_A_NAME). A label
// it would refuse shows up on the dashboard as no name at all, so the collector refuses it first.
// tests/status-safe.test.mjs compares these with the board's when agent-cockpit is beside this repo.
export const LABEL_CHARACTERS = /^[\p{L}\p{N} .,'’()+&:_-]+$/u
const LOOKS_LIKE_AN_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i
const LONG_UNBROKEN_RUN = /\S{24,}/

export function checkComputerLabel(label, identity) {
  if (typeof label !== 'string' || !label.trim()) return ['computer: is empty']
  const problems = stringProblems(label, 'computer', identity)
  if (CONTROL_CHARACTER.test(label)) problems.push('computer: contains a control character')
  if (DIRECTION_OR_LINE_CONTROL.test(label)) problems.push('computer: contains a direction or line control character')
  if (!LABEL_CHARACTERS.test(label.trim())) {
    problems.push("computer: has a character the dashboard does not show (letters, numbers, spaces and . , ' ’ ( ) + & : _ - only)")
  }
  if (LONG_UNBROKEN_RUN.test(label)) problems.push('computer: has 24 or more characters without a space')
  if (LOOKS_LIKE_AN_ID.test(label)) problems.push('computer: looks like an id')
  if (!computerSlug(label)) problems.push('computer: has no letters or numbers to name a file after')
  const hostSlug = computerSlug(identity?.hostname ?? '')
  if (hostSlug && computerSlug(label) === hostSlug) problems.push('computer: is the computer name')
  return problems
}

// The connection-name rule (connections-schema.mjs, CONNECTION_NAME; the board holds the same rule
// from tests/fixtures/connections-parity.json). A server name is whatever someone typed into a
// config file, so it is held to the board's characters, the gate's refusals, no id, and no stretch
// of 24 or more characters between separators - long enough to be a token. Like every gate
// problem, it names the field and never the value.
// Each character is matched one at a time, so no character in the list is ever read as a range.
const isSeparator = (character) => CONNECTION_NAME.segmentSeparators.includes(character)
const longestSegment = (value) => {
  let longest = 0
  let current = 0
  for (const character of value) {
    current = isSeparator(character) ? 0 : current + 1
    longest = Math.max(longest, current)
  }
  return longest
}

export function checkConnectionName(value, path, identity) {
  if (typeof value !== 'string') return [`${path}: is not text`]
  if (!value) return [`${path}: is empty`]
  const problems = stringProblems(value, path, identity)
  if (value !== value.trim()) problems.push(`${path}: starts or ends with a space`)
  if (!CONNECTION_NAME.characters.test(value)) problems.push(`${path}: has a character the dashboard does not show`)
  if (CONNECTION_NAME.uuid.test(value.toLowerCase())) problems.push(`${path}: looks like an id`)
  if (longestSegment(value) > CONNECTION_NAME.maxSegmentLength) {
    problems.push(`${path}: has ${CONNECTION_NAME.maxSegmentLength + 1} or more characters without a separator`)
  }
  return problems
}

export const isConnectionName = (value, identity) => checkConnectionName(value, 'name', identity).length === 0
