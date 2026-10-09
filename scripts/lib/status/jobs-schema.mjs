// The shape of the jobs snapshot - what the Readiness wall shows, one light per scheduled job -
// written by the collector and read by the dashboard.
//
// The constants are the shared contract: tests/fixtures/jobs-parity.json holds the same values,
// byte for byte, in agent-cockpit too, and tests/status-jobs-contract.test.mjs fails if this file
// drifts from it. The shape at the bottom is what safe.mjs enforces before anything is written.
// Names, times, numbers and states only: a job's arguments, environment settings, folders, prompts,
// error text and logs have no key here, so they cannot reach a file. That includes a Hermes job's own
// name: Hermes copies the first 50 characters of the prompt into the name of a job nobody named and does
// not rename it when the prompt is edited, so a stored name can carry a prompt that exists nowhere else.
// Every Hermes job is published as "Hermes job <id>" (hermesJobName), and the gate refuses any other
// name. The board shows the owner's own name for it, from jobs.yml, when there is one.
//
// The file never says whether a job is on time. It carries when each job should have run
// (dueAt, dueBeforeAt - worked out on the Mac in the job's own timezone, where the schedule is
// known) and when it last reported; the board compares the two. A schedule the Mac cannot read is
// `unknown` and has no due times, and the board says so instead of guessing.

import { computerSlug } from './schema.mjs'

export const JOBS_SCHEMA = 'agent-status/jobs/v1'
export const JOBS_FOLDER = '.agent-team/status/jobs'
// What the board holds itself to when it reads these files.
export const JOBS_STALE_AFTER_HOURS = 8
export const JOBS_MAX_FILES_READ = 5
export const JOBS_MAX_FILE_BYTES = 65536

export const JOBS_CAPS = { launchd: 60, hermes: 40, slots: 48 }

// A job that started a moment ago is still running, not late: the same grace the board gives a
// workflow (RUNNING_GRACE_MINUTES). Due times are the last expected runs at or before the check
// time minus this, found by looking back LOOKBACK_DAYS days.
export const GRACE_MINUTES = 30
export const LOOKBACK_DAYS = 32

export const LAUNCHD_STATES = ['running', 'loaded', 'not loaded']
// The two fixed reasons a block can give for being unavailable (its `why`). Never a message, and never
// anything the file held: `refused` is what the jobs part says when the safety check refused its file.
export const JOBS_WHY = { unreadable: 'could not be read', refused: 'refused by the safety check' }
// What a Hermes job is called in the file: its 12-character id after a fixed word, and nothing it holds.
// Never its stored name (see the header). The same words are in tests/fixtures/jobs-parity.json.
export const hermesJobName = (id) => `Hermes job ${id}`
export const HERMES_RESULTS = ['ok', 'error', 'unknown']
// launchctl's last exit status: a code, or minus the signal that stopped the job.
export const EXIT_CODE = { min: -255, max: 255 }

// How a job is scheduled, in four kinds. A slot is one minute of the hour; the optional hour,
// weekday (0 is Sunday) and day of the month narrow it. A job with a month, a day together with a
// weekday, or more slots than JOBS_CAPS.slots has no readable schedule and is `unknown`.
export const CADENCE = {
  kinds: ['always', 'every', 'slots', 'unknown'],
  everyMinutes: { min: 1, max: 44640 },
  slot: {
    minute: { min: 0, max: 59 },
    hour: { min: 0, max: 23 },
    weekday: { min: 0, max: 6 },
    day: { min: 1, max: 31 }
  },
  slotRule: 'A slot is one minute of the hour. With an hour it is one time of day; without, it is every hour. With a weekday (0 is Sunday) it is that day of the week; with a day (1 to 31) that day of the month; with neither, every day. A slot never has both a weekday and a day. Slots are written in order of day, weekday, hour, then minute, a missing value first.'
}

// A launchd label: letters, numbers and . - _ , starting with a letter or number. The connection-name
// rule applies on top (safe.mjs, checkLabel), so a label the board would refuse is never written.
export const LABEL = { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/ }
// A Hermes job id is exactly what Hermes makes: 12 random lowercase hex characters (cron/jobs.py,
// uuid4().hex[:12]). Nothing else is published - a looser "looks like a label" rule would let an id that
// spells out words through, and the id is written in the file and in the name made from it.
export const HERMES_ID = /^[0-9a-f]{12}$/

export function jobsPath(label) {
  const slug = computerSlug(label)
  return slug ? `${JOBS_FOLDER}/${slug}.json` : null
}

// --- the shape safe.mjs walks ----------------------------------------------------------------------

const count = { type: 'count' }
const iso = { type: 'iso' }
const int = ({ min, max }) => ({ type: 'int', min, max })
const enumOf = (values) => ({ type: 'enum', values })

const slotShape = {
  type: 'object',
  keys: {
    minute: int(CADENCE.slot.minute),
    hour: int(CADENCE.slot.hour),
    weekday: int(CADENCE.slot.weekday),
    day: int(CADENCE.slot.day)
  },
  required: ['minute'],
  rule: (slot) => (slot.weekday !== undefined && slot.day !== undefined ? [['day', 'is not allowed together with a weekday']] : [])
}

const kindOnly = (kind) => ({ type: 'const', value: kind })

// One shape per kind, chosen by `kind`: a kind carries its own keys and no others.
const cadenceShape = {
  type: 'variant',
  on: 'kind',
  variants: {
    always: { type: 'object', keys: { kind: kindOnly('always') }, required: ['kind'] },
    every: { type: 'object', keys: { kind: kindOnly('every'), minutes: int(CADENCE.everyMinutes) }, required: ['kind', 'minutes'] },
    slots: {
      type: 'object',
      keys: { kind: kindOnly('slots'), slots: { type: 'array', of: slotShape, min: 1, max: JOBS_CAPS.slots, unique: [] } },
      required: ['kind', 'slots']
    },
    unknown: { type: 'object', keys: { kind: kindOnly('unknown') }, required: ['kind'] }
  }
}

if (JSON.stringify(Object.keys(cadenceShape.variants)) !== JSON.stringify(CADENCE.kinds)) {
  throw new Error('jobs-schema.mjs: the cadence variants do not match CADENCE.kinds')
}

// What both kinds of job say about their due times. A job with no set times has none to give, a
// switched-off job is not judged, and the older of the two is always the earlier.
function dueProblems(item, switchedOff) {
  const problems = []
  const kind = item.cadence?.kind
  if (item.dueAt !== undefined && kind !== 'slots' && kind !== 'every') problems.push(['dueAt', 'is only allowed for a schedule with set times'])
  else if (item.dueAt !== undefined && switchedOff) problems.push(['dueAt', 'is not allowed on a switched-off job'])
  if (item.dueBeforeAt !== undefined && item.dueAt === undefined) problems.push(['dueBeforeAt', 'is only allowed with dueAt'])
  else if (item.dueBeforeAt !== undefined && !(Date.parse(item.dueBeforeAt) < Date.parse(item.dueAt))) problems.push(['dueBeforeAt', 'is not before dueAt'])
  return problems
}

const launchdItemShape = {
  type: 'object',
  keys: {
    label: { type: 'label' },
    cadence: cadenceShape,
    state: enumOf(LAUNCHD_STATES),
    lastExit: int(EXIT_CODE),
    lastReportAt: iso,
    dueAt: iso,
    dueBeforeAt: iso,
    self: { type: 'true' },
    disabled: { type: 'true' }
  },
  required: ['label', 'cadence', 'state'],
  rule: (item) => [
    ...dueProblems(item, item.disabled === true),
    ...(item.lastExit !== undefined && item.state === 'not loaded' ? [['lastExit', 'is only allowed on a job that is listed']] : [])
  ]
}

const hermesItemShape = {
  type: 'object',
  keys: {
    profile: { type: 'profileName' },
    id: { type: 'pattern', pattern: HERMES_ID },
    name: { type: 'connName' },
    enabled: { type: 'boolean' },
    cadence: cadenceShape,
    lastRunAt: iso,
    lastResult: enumOf(HERMES_RESULTS),
    dueAt: iso,
    dueBeforeAt: iso
  },
  required: ['profile', 'id', 'name', 'enabled', 'cadence', 'lastResult'],
  rule: (item) => [
    ...dueProblems(item, item.enabled === false),
    // The only name a Hermes job may have is the fixed one, so no stored name - whatever it says - can pass.
    ...(item.name !== undefined && typeof item.id === 'string' && item.name !== hermesJobName(item.id) ? [['name', "is not the fixed name made from the job's id"]] : [])
  ]
}

const itemsOf = (itemShape, max, unique) => ({ type: 'array', of: itemShape, min: 0, max, unique })

// Nothing is due later than the check time minus the grace: that is what "most recent expected run
// that has had its grace" means, and a later one would make a job late before it could have run.
function dueAfterGrace(doc) {
  const taken = Date.parse(doc?.takenAt)
  if (!Number.isFinite(taken)) return []
  const latest = taken - GRACE_MINUTES * 60_000
  const problems = []
  for (const block of ['launchd', 'hermes']) {
    const items = doc[block]?.status === 'found' && Array.isArray(doc[block].items) ? doc[block].items : []
    items.forEach((item, index) => {
      for (const key of ['dueAt', 'dueBeforeAt']) {
        if (Date.parse(item?.[key]) > latest) problems.push([`${block}.items[${index}].${key}`, 'is later than the check time minus the grace'])
      }
    })
  }
  return problems
}

export const JOBS_SHAPE = {
  type: 'object',
  keys: {
    schema: { type: 'const', value: JOBS_SCHEMA },
    takenAt: iso,
    computer: { type: 'text' },
    timezone: { type: 'timezone' },
    launchd: {
      type: 'block',
      found: { items: itemsOf(launchdItemShape, JOBS_CAPS.launchd, ['label']), hidden: count, more: count },
      foundRequired: ['items', 'hidden', 'more']
    },
    hermes: {
      type: 'block',
      found: { items: itemsOf(hermesItemShape, JOBS_CAPS.hermes, ['profile', 'id']), hidden: count, more: count },
      foundRequired: ['items', 'hidden', 'more']
    }
  },
  required: ['schema', 'takenAt', 'computer', 'timezone', 'launchd', 'hermes'],
  rule: dueAfterGrace
}
