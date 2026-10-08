// The shape of the connections snapshot - what the Connections wall shows - written by the
// collector and read by the dashboard.
//
// The constants are the shared contract: tests/fixtures/connections-parity.json holds the same
// values, byte for byte, in agent-cockpit too, and tests/status-connections-contract.test.mjs
// fails if this file drifts from it. The shape at the bottom is what safe.mjs enforces before
// anything is written. Names only: a server's address, command, arguments, settings and
// environment have no key here, so they cannot reach a file.

import { computerSlug, STATUSES } from './schema.mjs'

export const CONNECTIONS_SCHEMA = 'agent-status/connections/v1'
export const CONNECTIONS_FOLDER = '.agent-team/status/connections'
// What the board holds itself to when it reads these files.
export const CONNECTIONS_STALE_AFTER_HOURS = 8
export const CONNECTIONS_MAX_FILES_READ = 5
export const CONNECTIONS_MAX_FILE_BYTES = 65536
export const MAX_COMPUTERS_SHOWN = 3

export const CAPS = { claudeServers: 100, codexServers: 50, codexPlugins: 60, tools: 12 }

// The tools on the wall, in the order shown (decision D3).
export const TOOL_NAMES = ['Claude Code', 'Codex', 'Hermes', 'Node.js', 'Git', 'GitHub CLI', 'Claude app', 'ChatGPT app', 'Tailscale']

// Every enum carries the words the board shows for it: states are said in words, never by
// colour alone.
export const TOOL_STATES = { found: 'Found', 'not found': 'Not found', 'could not check': 'Could not check' }
export const VERSION_PATTERN = /^\d+(\.\d+){1,3}$/
export const MAX_VERSION_LENGTH = 32
export const SERVER_SCOPES = { user: 'Your server', plugin: 'Plugin server', 'claude.ai': 'claude.ai connector', other: 'Other' }
export const TRANSPORTS = { local: 'Local program', web: 'Web service', unknown: 'Not known' }
export const SERVER_STATES = {
  connected: 'Connected',
  'needs sign-in': 'Needs sign-in',
  failed: 'Failed',
  'waiting for approval': 'Waiting for approval',
  'not checked': 'Not checked',
  'seen before': 'Seen before',
  unknown: 'Unknown'
}
export const LIVE_STATES = {
  checked: 'Checked live',
  'timed out': 'Live check took too long',
  'could not run': 'Live check could not run',
  'could not read': 'Live check answer not understood',
  'program not found': 'Claude Code not found'
}
export const CODEX_STATES = { found: 'Found', 'turned off': 'Turned off' }

// The connection-name rule, shared with the board. The same characters as the computer label,
// and the same refusals, with one change: a long run is measured between separators, not between
// spaces, so `plugin:marketing:supermetrics` (29 characters, no space) is a name while a
// 40-character token is not. The identity checks (username, computer name, home folder) are the
// collector's alone - the board does not know whose computer it was.
export const CONNECTION_NAME = {
  characters: /^[\p{L}\p{N} .,'’()+&:_-]+$/u,
  maxLength: 60,
  never: ['@', '/', '\\', 'eyJ', 'sk-', 'bearer'],
  uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/,
  segmentSeparators: ':._- ',
  maxSegmentLength: 23
}

export function connectionsPath(label) {
  const slug = computerSlug(label)
  return slug ? `${CONNECTIONS_FOLDER}/${slug}.json` : null
}

// --- the shape safe.mjs walks ----------------------------------------------------------------------

const name = { type: 'connName' }
const count = { type: 'count' }
const enumOf = (values) => ({ type: 'enum', values: Object.keys(values) })

const toolShape = {
  type: 'object',
  keys: { name: { type: 'enum', values: TOOL_NAMES }, state: enumOf(TOOL_STATES), version: { type: 'version' } },
  required: ['name', 'state'],
  // A version is only ever a reading of a tool that was found.
  rule: (tool) => (tool.version !== undefined && tool.state !== 'found' ? [['version', 'is only allowed when the tool was found']] : [])
}

const claudeServerShape = {
  type: 'object',
  keys: { name, scope: enumOf(SERVER_SCOPES), transport: enumOf(TRANSPORTS), state: enumOf(SERVER_STATES) },
  required: ['name', 'scope', 'transport', 'state']
}

const codexServerShape = {
  type: 'object',
  keys: { name, enabled: { type: 'boolean' } },
  required: ['name']
}

const codexPluginShape = {
  type: 'object',
  keys: { name, from: name, enabled: { type: 'boolean' } },
  required: ['name', 'from']
}

export const CONNECTIONS_SHAPE = {
  type: 'object',
  keys: {
    schema: { type: 'const', value: CONNECTIONS_SCHEMA },
    takenAt: { type: 'iso' },
    computer: { type: 'text' },
    tools: { type: 'array', of: toolShape, min: 0, max: CAPS.tools, unique: ['name'] },
    claude: {
      type: 'block',
      found: {
        live: enumOf(LIVE_STATES),
        servers: { type: 'array', of: claudeServerShape, min: 0, max: CAPS.claudeServers, unique: ['name'] },
        projectServers: count,
        hidden: count,
        more: count
      },
      foundRequired: ['live', 'servers', 'projectServers', 'hidden', 'more']
    },
    codex: {
      type: 'block',
      found: {
        servers: { type: 'array', of: codexServerShape, min: 0, max: CAPS.codexServers, unique: ['name'] },
        plugins: { type: 'array', of: codexPluginShape, min: 0, max: CAPS.codexPlugins, unique: ['name', 'from'] },
        hidden: count,
        more: count
      },
      foundRequired: ['servers', 'plugins', 'hidden', 'more']
    }
  },
  required: ['schema', 'takenAt', 'computer', 'tools', 'claude', 'codex']
}

// Statuses are the usage contract's own, so the board reads both files with one set of words.
export { STATUSES }
