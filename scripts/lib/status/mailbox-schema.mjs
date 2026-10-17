// The shape of the mailbox status file - what the Mac runner tells the board about the orders it has been sent -
// written by the runner and read by the dashboard.
//
// The constants are the shared contract: tests/fixtures/mailbox-parity.json (its `status` section) holds the same values,
// byte for byte, in agent-cockpit too, and tests/mailbox-status.test.mjs fails if this file drifts from it. The shape at
// the bottom is what safe.mjs enforces before anything is written.
//
// Ids, codes, times and short commits only. An order is matched by its id: the title someone typed, the card's name, a
// path, an error message and a log line have no key here, so they cannot reach the file. A reason is one of a fixed list,
// never a sentence. All times are whole seconds in UTC and none is later than takenAt.

import { ACTIONS } from '../mailbox/contract.mjs'

export const MAILBOX_SCHEMA = 'agent-mailbox/v1'
export const MAILBOX_FOLDER = '.agent-team/status/mailbox'
export const MAILBOX_MAX_FILE_BYTES = 65536
export const MAILBOX_MAX_FILES_READ = 5
export const MAILBOX_MAX_COMPUTERS_SHOWN = 3
export const MAILBOX_MAX_ORDERS = 20
export const MAILBOX_MAX_JOBS = 40

export const MAILBOX_STATES = ['claimed', 'running', 'ok', 'refused', 'failed', 'unknown']
export const MAILBOX_ID = /^[0-9a-f]{32}$/
export const MAILBOX_COMMIT = /^[0-9a-f]{12}$/
export const MAILBOX_RUNNER = /^[a-z0-9-]{1,32}$/
export const MAILBOX_JOB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

// Why an order was turned away before it began, and why one that began did not land. Fixed words: the board turns each
// into a sentence of its own.
export const MAILBOX_REASONS = {
  refused: ['expired', 'wrong-repo', 'wrong-runner', 'not-allowed', 'job-not-allowed', 'daily-limit', 'not-valid', 'card-not-found', 'no-such-row', 'several-rows', 'no-workflow', 'not-ready'],
  failed: ['change-refused', 'tool-refused', 'claude-failed', 'timed-out', 'run-log-refused', 'push-failed']
}

export const MAILBOX_KEYS = {
  file: ['schema', 'takenAt', 'computer', 'runner', 'allows', 'orders'],
  allows: ['actions', 'jobs'],
  order: ['id', 'action', 'state', 'at', 'startedAt', 'finishedAt', 'commit', 'why', 'landed'],
  // Allowed and never required: a run that ended says how many tool calls it made. A file from a runner that does not know the key has none, and is as valid as ever.
  orderOptional: ['steps']
}

export const MAILBOX_MAX_STEPS = 100000

export function mailboxPath(runner) {
  return typeof runner === 'string' && MAILBOX_RUNNER.test(runner) ? `${MAILBOX_FOLDER}/${runner}.json` : null
}

// --- the shape safe.mjs walks ----------------------------------------------------------------------

const second = { type: 'second' }
const nullable = (of) => ({ type: 'nullable', of })
const enumOf = (values) => ({ type: 'enum', values })

// What each state says about the other keys. A key that is not mentioned is free.
function stateProblems(order) {
  const extra = Object.hasOwn(order, 'steps') && order.state !== 'ok' && order.state !== 'failed' ? [['steps', `must be absent when the order is ${order.state}`]] : []
  return [...extra, ...stateRules(order)]
}

function stateRules(order) {
  const none = (...keys) => keys.filter((key) => order[key] !== null).map((key) => [key, `must be null when the order is ${order.state}`])
  const some = (...keys) => keys.filter((key) => order[key] === null).map((key) => [key, `must be set when the order is ${order.state}`])
  switch (order.state) {
    case 'claimed':
      return none('startedAt', 'finishedAt', 'commit', 'why', 'landed')
    case 'running':
      return [...some('startedAt'), ...none('finishedAt', 'commit', 'why', 'landed')]
    case 'ok':
      return [...some('commit', 'finishedAt'), ...none('why', 'landed')]
    case 'refused':
      return [...none('commit', 'landed'), ...(MAILBOX_REASONS.refused.includes(order.why) ? [] : [['why', 'is not a reason for an order that was refused']])]
    case 'failed':
      return [...none('commit', 'landed'), ...(MAILBOX_REASONS.failed.includes(order.why) ? [] : [['why', 'is not a reason for an order that failed']])]
    case 'unknown':
      return [...none('why'), ...(order.landed === true ? some('commit') : none('commit'))]
    default:
      return []
  }
}

const orderShape = {
  type: 'object',
  keys: {
    id: { type: 'pattern', pattern: MAILBOX_ID },
    action: enumOf(ACTIONS),
    state: enumOf(MAILBOX_STATES),
    at: second,
    startedAt: nullable(second),
    finishedAt: nullable(second),
    commit: nullable({ type: 'pattern', pattern: MAILBOX_COMMIT }),
    why: nullable(enumOf([...MAILBOX_REASONS.refused, ...MAILBOX_REASONS.failed])),
    landed: nullable({ type: 'boolean' }),
    steps: { type: 'int', min: 0, max: MAILBOX_MAX_STEPS }
  },
  required: MAILBOX_KEYS.order,
  rule: stateProblems
}

// No time is later than the moment the file was made: a time in the future is a clock gone wrong, or a made-up one.
function timesNotAfterTakenAt(file) {
  const taken = Date.parse(file?.takenAt)
  if (!Number.isFinite(taken) || !Array.isArray(file.orders)) return []
  const problems = []
  file.orders.forEach((order, index) => {
    for (const key of ['at', 'startedAt', 'finishedAt']) {
      if (typeof order?.[key] === 'string' && Date.parse(order[key]) > taken) problems.push([`orders[${index}].${key}`, 'is later than takenAt'])
    }
  })
  return problems
}

export const MAILBOX_SHAPE = {
  type: 'object',
  keys: {
    schema: { type: 'const', value: MAILBOX_SCHEMA },
    takenAt: second,
    computer: { type: 'text' },
    runner: { type: 'slug', pattern: MAILBOX_RUNNER },
    allows: {
      type: 'object',
      keys: {
        actions: { type: 'array', of: enumOf(ACTIONS), min: 0, max: ACTIONS.length, unique: [] },
        jobs: { type: 'array', of: { type: 'slug', pattern: MAILBOX_JOB }, min: 0, max: MAILBOX_MAX_JOBS, unique: [] }
      },
      required: MAILBOX_KEYS.allows
    },
    orders: { type: 'array', of: orderShape, min: 0, max: MAILBOX_MAX_ORDERS, unique: ['id'] }
  },
  required: MAILBOX_KEYS.file,
  rule: timesNotAfterTakenAt
}
