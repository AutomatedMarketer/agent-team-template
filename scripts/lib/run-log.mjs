export const SCHEMA_ID = 'run-log/v1'
export const AGENT_SLUGS = ['research', 'content', 'email', 'customer-service', 'sales', 'security', 'orchestrator', 'editor']
export const MODELS = ['opus', 'sonnet']
export const TRIGGERS = ['schedule', 'webhook', 'manual']
export const STATUSES = ['ok', 'partial', 'blocked', 'failed']
// A graded run records how it scored. The weekly quality review counts acceptance from
// these, so a grade that is not recorded is a grade that never happened.
export const QUALITY_VERDICTS = ['passed', 'flagged']

// Every field this schema reads. A run log is written by an agent at the very end of a run, which
// is the worst moment to lose something quietly: nobody re-reads it, and the dashboard, the weekly
// review and the quality count all read this file rather than the session it came from.
//
// Until this existed an invented field passed clean. `session_link` instead of `session_url`
// validated, and the run appeared on the board with no transcript to open - the one link the
// board exists to give you. Same defect as the ledger's `hours:`, one file along: a number or a
// name that nothing reads, accepted in silence.
export const RUN_LOG_FIELDS = [
  'schema', 'run_id', 'agent', 'workflow', 'quality', 'model', 'trigger', 'status',
  'started_at', 'finished_at', 'summary', 'artifacts', 'evidence', 'next_action',
  'session_id', 'session_url'
]

// Names a writer plausibly reaches for. These get told what they meant, because "not a field"
// on its own sends someone hunting through a schema for a word they already had.
const NEAR_MISSES = new Map([
  ['session_link', 'session_url'],
  ['sessionurl', 'session_url'],
  ['url', 'session_url'],
  ['session', 'session_id'],
  ['workflow_slug', 'workflow'],
  ['output', 'artifacts'],
  ['outputs', 'artifacts'],
  ['files', 'artifacts'],
  ['proof', 'evidence'],
  ['notes', 'summary'],
  ['description', 'summary'],
  ['next', 'next_action'],
  ['next_steps', 'next_action'],
  ['started', 'started_at'],
  ['finished', 'finished_at'],
  ['ended_at', 'finished_at'],
  ['duration', 'started_at and finished_at, which the reader subtracts']
])

export function unknownRunLogField(field) {
  const meant = NEAR_MISSES.get(String(field).toLowerCase())
  if (meant) {
    return `"${field}" is not a field in ${SCHEMA_ID} - you mean ${meant}. Nothing reads "${field}", so what you wrote there is lost`
  }
  return `"${field}" is not a field in ${SCHEMA_ID}, so nothing reads it and whatever you put there is lost. Check it against a run log already in runs/, or remove it`
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{4}Z-[a-z-]+$/

function pad(value) {
  return String(value).padStart(2, '0')
}

export function runIdFor(agentSlug, date) {
  const stamp =
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}Z`
  return `${stamp}-${agentSlug}`
}

export function monthFolderFor(date) {
  return `runs/${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`
}

export function validateRunLog(entry, { filename } = {}) {
  const problems = []
  const expect = (condition, message) => {
    if (!condition) problems.push(message)
  }

  expect(entry.schema === SCHEMA_ID, `schema must be "${SCHEMA_ID}", got "${entry.schema}"`)
  expect(RUN_ID.test(entry.run_id ?? ''), 'run_id must look like 2026-08-07T0600Z-research')
  expect(AGENT_SLUGS.includes(entry.agent), `agent must be one of ${AGENT_SLUGS.join(', ')}`)
  // Optional, but the dashboard's Workflows board matches runs to workflows through it —
  // a workflow run without this field renders as "never run" forever.
  if (entry.workflow !== undefined) {
    expect(
      typeof entry.workflow === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.workflow),
      'workflow, when present, must be the workflow file\'s kebab-case slug'
    )
  }
  if (entry.quality !== undefined) {
    const quality = entry.quality
    if (quality === null || typeof quality !== 'object' || Array.isArray(quality)) {
      problems.push('quality, when present, must be an object')
    } else {
      expect(
        typeof quality.rubric === 'string' && quality.rubric.trim().length > 0,
        'quality.rubric must name the rubric the output was marked against'
      )
      expect(
        Number.isInteger(quality.score) && quality.score >= 0,
        'quality.score must be a whole number of rubric lines met'
      )
      expect(
        Number.isInteger(quality.total) && quality.total > 0,
        'quality.total must be the number of rubric lines marked'
      )
      expect(
        !Number.isInteger(quality.score) ||
          !Number.isInteger(quality.total) ||
          quality.score <= quality.total,
        'quality.score cannot exceed quality.total'
      )
      expect(
        QUALITY_VERDICTS.includes(quality.verdict),
        `quality.verdict must be one of ${QUALITY_VERDICTS.join(', ')}`
      )
      expect(
        typeof quality.retried === 'boolean',
        'quality.retried must say whether the piece was sent back once'
      )
    }
  }

  expect(
    MODELS.includes(entry.model),
    'model must be the alias "opus" or "sonnet" - a pinned id such as claude-opus-5 rots'
  )
  expect(TRIGGERS.includes(entry.trigger), `trigger must be one of ${TRIGGERS.join(', ')}`)
  expect(STATUSES.includes(entry.status), `status must be one of ${STATUSES.join(', ')}`)
  expect(ISO_INSTANT.test(entry.started_at ?? ''), 'started_at must be an ISO instant ending in Z')
  expect(ISO_INSTANT.test(entry.finished_at ?? ''), 'finished_at must be an ISO instant ending in Z')

  expect(
    typeof entry.summary === 'string' && entry.summary.trim().length >= 40,
    'summary must be at least 40 characters - it is the first thing a person reads'
  )
  expect(
    !(entry.summary ?? '').includes('→'),
    'summary must not use arrow chains; write complete sentences'
  )

  expect(Array.isArray(entry.artifacts), 'artifacts must be an array of repo-relative paths')
  expect(Array.isArray(entry.evidence), 'evidence must be an array of things a tool actually returned')
  expect(
    entry.next_action === null || typeof entry.next_action === 'string',
    'next_action must be a string or null'
  )

  if (entry.trigger !== 'manual') {
    expect(
      typeof entry.session_id === 'string' && entry.session_id.length > 0,
      'a schedule or webhook run must record its session_id'
    )
    expect(
      typeof entry.session_url === 'string' && entry.session_url.startsWith('https://claude.ai/code/'),
      'a schedule or webhook run must record a claude.ai/code session_url'
    )
  }

  // Only compare the filename once run_id is itself well-formed. A missing run_id would
  // otherwise report "filename must be undefined.json", which names no fixable problem and
  // buries the real one - the run_id line directly above it.
  if (filename && RUN_ID.test(entry.run_id ?? '')) {
    expect(filename === `${entry.run_id}.json`, `filename must be ${entry.run_id}.json, got ${filename}`)
  }

  for (const artifact of entry.artifacts ?? []) {
    expect(
      typeof artifact === 'string' && !artifact.startsWith('/') && !/^[A-Za-z]:/.test(artifact),
      `artifact "${artifact}" must be a repo-relative path`
    )
  }

  // Last, so a misspelled field never buries the structural problems above it.
  for (const field of Object.keys(entry ?? {})) {
    if (!RUN_LOG_FIELDS.includes(field)) problems.push(unknownRunLogField(field))
  }

  return problems
}
