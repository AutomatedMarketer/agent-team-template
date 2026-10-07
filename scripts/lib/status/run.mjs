// The collector run: read every source, put them in one file, pass the gate, write.
//
// Every input is handed in through `deps` - home folder, environment, clock, network, Keychain,
// identity - so the tests can run the whole thing against a fake home with a fake network, and
// the leak test exercises exactly the code that runs on the real machine.

import { mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { USAGE_SCHEMA, DEFAULT_COMPUTER, usagePath } from './schema.mjs'
import { checkUsage, checkLine, checkComputerLabel } from './safe.mjs'
import { isoSeconds } from './util.mjs'
import { collectClaudeLimits } from './claude-limits.mjs'
import { collectClaudeActivity } from './claude-activity.mjs'
import { collectCodexLimits } from './codex-limits.mjs'
import { claudePlan, collectCodexPlan } from './plans.mjs'

const DEFAULT_SOURCES = {
  claudeLimits: collectClaudeLimits,
  claudeActivity: collectClaudeActivity,
  codexLimits: collectCodexLimits,
  codexPlan: collectCodexPlan
}

// A source that throws is "unavailable". The error itself is dropped: fs and network errors carry
// full paths and addresses, and a full path carries the username.
async function safely(read, deps) {
  try {
    return await read(deps)
  } catch {
    return { status: 'unavailable', why: 'could not be read' }
  }
}

export async function collectUsage(deps, computer) {
  const sources = { ...DEFAULT_SOURCES, ...deps.sources }
  const [claude, activity, codexLimits, codexPlan] = await Promise.all([
    safely(sources.claudeLimits, deps),
    safely(sources.claudeActivity, deps),
    safely(sources.codexLimits, deps),
    safely(sources.codexPlan, deps)
  ])
  // claudeLimits answers { limits, account }; a thrown source answered a bare status instead.
  const limits = claude?.limits ?? claude
  const account = claude?.limits ? claude.account : null
  return {
    schema: USAGE_SCHEMA,
    takenAt: isoSeconds(deps.now),
    computer,
    claude: { plan: claudePlan(account), limits, activity },
    codex: { plan: codexPlan, limits: codexLimits }
  }
}

const SUMMARY_ROWS = [
  ['Claude plan', (doc) => doc.claude.plan],
  ['Claude limits', (doc) => doc.claude.limits],
  ['Claude activity', (doc) => doc.claude.activity],
  ['Codex plan', (doc) => doc.codex.plan],
  ['Codex limits', (doc) => doc.codex.limits]
]

// Statuses and sources only - never a value. This is what a scheduled run's log shows.
export function summarize(doc) {
  return SUMMARY_ROWS.map(([label, pick]) => {
    const block = pick(doc)
    const detail = block.status === 'found'
      ? block.source ? ` (${block.source})` : block.estimate ? ' (estimate)' : ''
      : block.why ? ` (${block.why})` : ''
    return `- ${label} ${block.status}${detail}`
  })
}

export function sourceStatuses(doc) {
  return Object.fromEntries(SUMMARY_ROWS.map(([label, pick]) => [label, pick(doc).status]))
}

const USAGE_TEXT = [
  'Usage: node scripts/collect-status.mjs [--computer "Mac Mini"] [--only usage] [--dry-run]',
  '                                       [--commit] [--clone <dir>] [--state-dir <dir>]'
]

const OPTIONS = {
  computer: { type: 'string' },
  only: { type: 'string' },
  commit: { type: 'boolean' },
  clone: { type: 'string' },
  'state-dir': { type: 'string' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean' }
}

// Everything printed goes through the line gate first. A refused line is replaced, not shown.
function gatedPrinter(print, identity) {
  return (line) => print(checkLine(line, identity).length ? '(a line was withheld by the safety check)' : line)
}

async function writeAtomically(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temporary, text)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

// args: { argv, deps, repoRoot, out, err }
// Returns the exit code. Exit 2 = refused before reading anything, 1 = refused or failed after.
export async function runCollector({ argv, deps, repoRoot, out, err }) {
  const identity = deps.identity ?? {}
  const say = gatedPrinter(out, identity)
  const complain = gatedPrinter(err, identity)

  let values
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }))
  } catch {
    // The parser's message quotes the offending argument back; it is not repeated here.
    complain('That option is not one this collector knows.')
    USAGE_TEXT.forEach(complain)
    return 2
  }
  if (values.help) {
    USAGE_TEXT.forEach(say)
    return 0
  }
  if (values.only !== undefined && values.only !== 'usage') {
    complain('Only --only usage exists so far. Connections and Hermes come in later phases.')
    return 2
  }
  if (values.commit || values.clone || values['state-dir']) {
    complain('--commit, --clone and --state-dir are not built yet.')
    return 2
  }
  if (values['dry-run'] && values.commit) {
    complain('--dry-run writes nothing, so it cannot also --commit.')
    return 2
  }

  const computer = values.computer ?? DEFAULT_COMPUTER
  const labelProblems = checkComputerLabel(computer, identity)
  if (labelProblems.length) {
    complain(`Refused before reading anything. ${labelProblems.join('; ')}.`)
    complain('Give a plain label such as --computer "Mac Mini". It is never the computer\'s own name.')
    return 2
  }

  const doc = await collectUsage(deps, computer)
  const problems = checkUsage(doc, identity)
  if (problems.length) {
    complain(`Nothing written. The safety check refused: ${problems.join('; ')}`)
    return 1
  }

  const relativePath = usagePath(computer)
  const text = `${JSON.stringify(doc, null, 2)}\n`

  if (values['dry-run']) {
    say(text.trimEnd())
    say(`Dry run for ${computer}. Nothing written. It would go to ${relativePath}`)
    summarize(doc).forEach(say)
    return 0
  }

  await writeAtomically(join(repoRoot, ...relativePath.split('/')), text)
  say(`Usage snapshot for ${computer}. Wrote ${relativePath}`)
  summarize(doc).forEach(say)
  return 0
}
