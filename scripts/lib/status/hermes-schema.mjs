// The shape of the Hermes snapshot - what the Hermes card and the #hermes page show - written by
// the collector and read by the dashboard.
//
// The constants are the shared contract: tests/fixtures/hermes-parity.json holds the same values,
// byte for byte, in agent-cockpit too, and tests/status-hermes-contract.test.mjs fails if this file
// drifts from it. The shape at the bottom is what safe.mjs enforces before anything is written.
// Counts, times, states and names only: what Hermes remembers, what it was told, who it talks to,
// its settings and its sign-ins have no key here, so they cannot reach a file.
//
// The file never says whether Hermes is alive. The board works that out from the times in it, by
// the alive rule below, and the collector uses the same rule to decide whether to write Hermes's
// heartbeat. A yes/no flag would be a second answer that could disagree with the first.

import { computerSlug } from './schema.mjs'

export const HERMES_SCHEMA = 'agent-status/hermes/v1'
export const HERMES_FOLDER = '.agent-team/status/hermes'
// What the board holds itself to when it reads these files.
export const HERMES_STALE_AFTER_HOURS = 8
export const HERMES_MAX_FILES_READ = 5
export const HERMES_MAX_FILE_BYTES = 65536

export const HERMES_CAPS = { profiles: 12 }
// The Hermes home itself is the profile Hermes calls "default". It is always listed first.
export const DEFAULT_PROFILE = 'default'
export const SESSION_DAYS = 7
export const UPDATE_CHECK_MAX_AGE_DAYS = 7

// gateway_state.json's own words, as Hermes writes them, with the words the board shows. Any other
// value is written as "unknown".
export const GATEWAY_STATES = {
  starting: 'Starting',
  running: 'Running',
  degraded: 'Running with problems',
  stopped: 'Stopped',
  startup_failed: 'Failed to start',
  unknown: 'Unknown'
}

export const ALIVE = {
  rule: 'Alive when the gateway is found, its state is running and its beatAt is within withinSeconds of takenAt; or when any listed profile\'s scheduler beatAt is within withinSeconds of takenAt. Within means the difference either way. The board works this out itself; a file with any yes/no flag for it is refused.',
  withinSeconds: 300,
  gatewayStates: ['running'],
  words: { running: 'Running', down: 'Down at last check', stale: 'Not checked for {hours} h' }
}

export const HEARTBEAT = {
  path: 'runs/heartbeat/hermes.json',
  runtime: 'hermes',
  at: 'the newest beatAt that proves the alive rule',
  writtenOnlyWhenAlive: true,
  staleAfterMinutes: { default: 30, min: 5, max: 1440, hermes: 200 }
}

export const HERMES_WORDS = {
  install: {
    version: 'Hermes {version}',
    noVersion: 'Hermes, version not known',
    updateAvailable: '{label} - update available',
    upToDate: '{label} - up to date',
    'not found': 'Hermes not found',
    unavailable: 'Hermes could not be read'
  },
  model: { both: '{model} via {provider}', modelOnly: '{model}', none: 'Model not known' },
  sessions: { 'not found': 'No sessions recorded', unavailable: 'Not available ({why})' }
}

// Hermes's own rule for a profile id (hermes_cli/profiles.py, _PROFILE_ID_RE): lowercase letters,
// numbers, - and _, starting with a letter or number, up to 64. The connection-name rule applies on
// top (safe.mjs, checkProfileName), so a name the board would refuse is never written. A model is
// shown by its last segment after the last slash, held to the connection-name rule (safe.mjs,
// modelShown).
export const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function hermesPath(label) {
  const slug = computerSlug(label)
  return slug ? `${HERMES_FOLDER}/${slug}.json` : null
}

// The alive rule, worked out from the file alone - the same function the collector uses to decide
// whether to write the heartbeat. Returns { alive, at }: `at` is the newest time that proved it.
export function aliveFrom(doc) {
  const taken = Date.parse(doc?.takenAt)
  if (!Number.isFinite(taken)) return { alive: false, at: null }
  const proofs = []
  const near = (iso) => {
    const at = typeof iso === 'string' ? Date.parse(iso) : NaN
    return Number.isFinite(at) && Math.abs(at - taken) <= ALIVE.withinSeconds * 1000
  }
  const gateway = doc.gateway
  if (gateway?.status === 'found' && ALIVE.gatewayStates.includes(gateway.state) && near(gateway.beatAt)) proofs.push(gateway.beatAt)
  if (doc.profiles?.status === 'found' && Array.isArray(doc.profiles.items)) {
    for (const item of doc.profiles.items) {
      if (item?.scheduler?.status === 'found' && near(item.scheduler.beatAt)) proofs.push(item.scheduler.beatAt)
    }
  }
  if (!proofs.length) return { alive: false, at: null }
  const at = proofs.reduce((newest, time) => (Date.parse(time) > Date.parse(newest) ? time : newest))
  return { alive: true, at }
}

// --- the shape safe.mjs walks ----------------------------------------------------------------------

const count = { type: 'count' }
const iso = { type: 'iso' }
const block = (found, foundRequired) => ({ type: 'block', found, foundRequired })

const profileShape = {
  type: 'object',
  keys: {
    name: { type: 'profileName' },
    model: { type: 'connName' },
    provider: { type: 'connName' },
    skills: block({ count }, ['count']),
    sessions: block({ days: { type: 'const', value: SESSION_DAYS }, conversations: count, scheduled: count, lastActiveAt: iso }, ['days', 'conversations', 'scheduled']),
    scheduler: block({ beatAt: iso }, ['beatAt'])
  },
  required: ['name', 'skills', 'sessions', 'scheduler'],
  // "x via provider" needs an x.
  rule: (item) => (item.provider !== undefined && item.model === undefined ? [['provider', 'is only allowed with a model']] : [])
}

export const HERMES_SHAPE = {
  type: 'object',
  keys: {
    schema: { type: 'const', value: HERMES_SCHEMA },
    takenAt: iso,
    computer: { type: 'text' },
    install: block({ version: { type: 'version' }, updateAvailable: { type: 'boolean' } }, []),
    gateway: block({ state: { type: 'enum', values: Object.keys(GATEWAY_STATES) }, beatAt: iso }, ['state']),
    profiles: block({
      items: { type: 'array', of: profileShape, min: 0, max: HERMES_CAPS.profiles, unique: ['name'] },
      hidden: count,
      more: count
    }, ['items', 'hidden', 'more'])
  },
  required: ['schema', 'takenAt', 'computer', 'install', 'gateway', 'profiles']
}

// The heartbeat the collector writes for Hermes when, and only when, the alive rule holds.
export const HEARTBEAT_SHAPE = {
  type: 'object',
  keys: { runtime: { type: 'const', value: HEARTBEAT.runtime }, at: iso },
  required: ['runtime', 'at']
}
