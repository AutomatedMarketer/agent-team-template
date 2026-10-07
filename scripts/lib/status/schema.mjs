// The shape of the usage snapshot, written by the collector and read by the dashboard.
//
// The constants at the top are the shared contract: tests/fixtures/usage-parity.json holds the
// same values, byte for byte, in agent-cockpit too, and tests/status-schema.test.mjs fails if
// this file drifts from it. The shape below them is what safe.mjs enforces before anything is
// written - a key that is not listed here never reaches a file.

export const USAGE_SCHEMA = 'agent-status/usage/v1'
export const USAGE_FOLDER = '.agent-team/status/usage'
export const COMPUTER_SLUG = /^[a-z0-9-]{1,32}$/
export const DEFAULT_COMPUTER = 'this computer'
export const MAX_STRING_LENGTH = 60
export const STALE_AFTER_HOURS = 8
export const MAX_FILES_READ = 5
export const STATUSES = ['found', 'not found', 'unavailable']
export const SOURCES = ['unofficial-live', 'claude-code-saved', 'codex-session-log']
export const WINDOW_LABELS = {
  five_hour: '5-hour',
  weekly_all: 'Weekly',
  weekly_model: 'Weekly, {model} only',
  weekly: 'Weekly'
}

export const WINDOW_KINDS = Object.keys(WINDOW_LABELS)

export function windowLabel(window) {
  const template = WINDOW_LABELS[window?.kind]
  if (!template) return null
  return template.replace('{model}', window.model ?? '')
}

// The label is what a person typed after --computer; the slug is the file name. Accents are
// folded rather than dropped so "Büro" stays readable, and a label with nothing usable in it
// returns null so the caller refuses it instead of writing ".json".
export function computerSlug(label) {
  if (typeof label !== 'string') return null
  const slug = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '')
  return COMPUTER_SLUG.test(slug) ? slug : null
}

export function usagePath(label) {
  const slug = computerSlug(label)
  return slug ? `${USAGE_FOLDER}/${slug}.json` : null
}

// --- the shape safe.mjs walks ----------------------------------------------------------------
//
// A `block` is anything with a status. When the status is "found" it may carry the keys in
// `found`; otherwise it carries only its status and an optional reason. That one rule is what
// makes "usedPercent without status found" impossible to write - there is no other way in.

const text = { type: 'text' }
const count = { type: 'count' }

const windowShape = {
  type: 'object',
  keys: {
    kind: { type: 'enum', values: WINDOW_KINDS },
    model: text,
    usedPercent: { type: 'percent' },
    resetsAt: { type: 'iso' }
  },
  required: ['kind', 'usedPercent'],
  // Only the model-scoped weekly window names a model, and it always does.
  modelWindow: true
}

const planShape = {
  type: 'block',
  found: { name: text },
  foundRequired: ['name']
}

const limitsShape = (sources) => ({
  type: 'block',
  found: {
    source: { type: 'enum', values: sources },
    readAt: { type: 'iso' },
    windows: { type: 'array', of: windowShape, min: 1, max: 8 }
  },
  foundRequired: ['source', 'readAt', 'windows']
})

const dayShape = {
  type: 'object',
  keys: {
    day: { type: 'day' },
    sessions: count,
    replies: count,
    tokens: {
      type: 'object',
      keys: { input: count, output: count, cacheRead: count, cacheWrite: count },
      required: ['input', 'output', 'cacheRead', 'cacheWrite']
    },
    byModel: {
      type: 'object',
      keys: { opus: count, sonnet: count, haiku: count, other: count },
      required: ['opus', 'sonnet', 'haiku', 'other']
    }
  },
  required: ['day', 'sessions', 'replies', 'tokens', 'byModel']
}

const activityShape = {
  type: 'block',
  found: {
    estimate: { type: 'true' },
    timezone: { type: 'timezone' },
    days: { type: 'array', of: dayShape, min: 0, max: 16 }
  },
  foundRequired: ['estimate', 'timezone', 'days']
}

export const USAGE_SHAPE = {
  type: 'object',
  keys: {
    schema: { type: 'const', value: USAGE_SCHEMA },
    takenAt: { type: 'iso' },
    computer: text,
    claude: {
      type: 'object',
      keys: {
        plan: planShape,
        limits: limitsShape(['unofficial-live', 'claude-code-saved']),
        activity: activityShape
      },
      required: ['plan', 'limits', 'activity']
    },
    codex: {
      type: 'object',
      keys: {
        plan: planShape,
        limits: limitsShape(['codex-session-log'])
      },
      required: ['plan', 'limits']
    }
  },
  required: ['schema', 'takenAt', 'computer', 'claude', 'codex']
}

// --- receipts --------------------------------------------------------------------------------------
//
// A commit run claims its occurrence before it starts and leaves two records in the claim: the
// receipt (what was written - statuses and a hash, never a value) and the final record (what
// happened to it). A claim with a receipt and no final record is an outcome nobody knows, and the
// Mac task policy says not to replay that blindly.

export const RECEIPT_SCHEMA = 'agent-status/receipt/v1'
export const FINAL_SCHEMA = 'agent-status/final/v1'
export const OUTCOMES = [
  'pushed',
  'retried and pushed',
  'committed, push refused',
  'nothing to commit',
  'refused by the safety check',
  'not a dedicated clone',
  'failed'
]

const statusWord = { type: 'enum', values: STATUSES }

export const RECEIPT_SHAPE = {
  type: 'object',
  keys: {
    schema: { type: 'const', value: RECEIPT_SCHEMA },
    claimedAt: { type: 'iso' },
    computer: text,
    file: { type: 'pattern', pattern: /^\.agent-team\/status\/usage\/[a-z0-9-]{1,32}\.json$/ },
    sha256: { type: 'pattern', pattern: /^[0-9a-f]{64}$/ },
    sources: {
      type: 'object',
      keys: { claudePlan: statusWord, claudeLimits: statusWord, claudeActivity: statusWord, codexPlan: statusWord, codexLimits: statusWord },
      required: ['claudePlan', 'claudeLimits', 'claudeActivity', 'codexPlan', 'codexLimits']
    }
  },
  required: ['schema', 'claimedAt', 'computer', 'file', 'sha256', 'sources']
}

export const FINAL_SHAPE = {
  type: 'object',
  keys: {
    schema: { type: 'const', value: FINAL_SCHEMA },
    finishedAt: { type: 'iso' },
    outcome: { type: 'enum', values: OUTCOMES },
    commit: { type: 'pattern', pattern: /^[0-9a-f]{40}$/ }
  },
  required: ['schema', 'finishedAt', 'outcome']
}
