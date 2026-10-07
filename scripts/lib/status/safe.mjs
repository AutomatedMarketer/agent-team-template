// The fail-closed gate. Every usage file, receipt and console line passes through here before it
// leaves the process, and anything that does not pass stops the run with nothing written.
//
// Why it is this strict: the collector reads files that hold sign-in tokens, account emails and
// folder names that contain the person's username, then writes into a repo that gets pushed.
// The sources are written to return only safe fields, but "written to" is a promise. This is the
// check that does not trust the promise. A problem names the field, never the value - the value
// is the thing that might be the secret.

import { USAGE_SHAPE, STATUSES, MAX_STRING_LENGTH, computerSlug } from './schema.mjs'

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
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
        problems.push(`${path}: is not a percentage between 0 and 100`)
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
    case 'array':
      if (!Array.isArray(value)) {
        problems.push(`${path}: is not a list`)
        return
      }
      if (value.length < (shape.min ?? 0)) problems.push(`${path}: has too few entries`)
      if (value.length > shape.max) problems.push(`${path}: has more than ${shape.max} entries`)
      value.slice(0, shape.max).forEach((item, index) => walk(item, shape.of, `${path}[${index}]`, identity, problems))
      return
    case 'object':
      walkObject(value, shape.keys, shape.required ?? [], path, identity, problems)
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

export function checkComputerLabel(label, identity) {
  if (typeof label !== 'string' || !label.trim()) return ['computer: is empty']
  const problems = stringProblems(label, 'computer', identity)
  if (CONTROL_CHARACTER.test(label)) problems.push('computer: contains a control character')
  if (!computerSlug(label)) problems.push('computer: has no letters or numbers to name a file after')
  const hostSlug = computerSlug(identity?.hostname ?? '')
  if (hostSlug && computerSlug(label) === hostSlug) problems.push('computer: is the computer name')
  return problems
}
