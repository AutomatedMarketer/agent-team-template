// The collector run: read every source, put each part in its own file, pass the gate, write.
//
// Every input is handed in through `deps` - home folder, environment, clock, network, Keychain,
// programs, identity - so the tests can run the whole thing against a fake home with a fake
// network, and the leak test exercises exactly the code that runs on the real machine.
//
// A run collects one or more parts (schema.mjs, PARTS): usage, connections. They travel together:
// every part passes the gate before anything is written, and in commit mode every file goes into
// one commit.

import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import {
  USAGE_SCHEMA,
  DEFAULT_COMPUTER,
  PARTS,
  LATER_PARTS,
  usagePath,
  RECEIPT_SCHEMA,
  RECEIPT_SHAPE,
  FINAL_SCHEMA,
  FINAL_SHAPE
} from './schema.mjs'
import { connectionsPath, LIVE_STATES } from './connections-schema.mjs'
import { checkUsage, checkConnections, checkLine, checkComputerLabel, checkAgainst } from './safe.mjs'
import { isoSeconds } from './util.mjs'
import { writeSnapshot, assertNoLinks, LinkedPath } from './write.mjs'
import { collectClaudeLimits } from './claude-limits.mjs'
import { collectClaudeActivity } from './claude-activity.mjs'
import { collectCodexLimits } from './codex-limits.mjs'
import { claudePlan, collectCodexPlan } from './plans.mjs'
import { collectConnections } from './connections.mjs'
import {
  takeLock,
  releaseLock,
  openClaim,
  claimStamp,
  slotStamp,
  writeRecord,
  prepareClone,
  commitAndPush,
  isInsideFolder,
  RemoteUnreachable,
  SNAPSHOT_SUBJECT
} from './commit.mjs'

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

// `trail`, when given, collects which Claude limit sources were tried and what each said - for the
// log only. It is a separate list so nothing in it can reach the snapshot by accident.
export async function collectUsage(deps, computer, trail = null) {
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
  if (Array.isArray(trail) && Array.isArray(claude?.tried)) trail.push(...claude.tried)
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

// Statuses and sources only - never a value. This is what a scheduled run's log shows. Under the
// Claude limits row it lists every source tried, in order, so a fallback or a failure shows each
// reason, not only the last.
export function summarize(doc, trail = []) {
  return SUMMARY_ROWS.flatMap(([label, pick]) => {
    const block = pick(doc)
    const detail = block.status === 'found'
      ? block.source ? ` (${block.source})` : block.estimate ? ' (estimate)' : ''
      : block.why ? ` (${block.why})` : ''
    const row = `- ${label} ${block.status}${detail}`
    if (label !== 'Claude limits') return [row]
    return [row, ...trail.map((entry) => `  - ${entry.source}: ${entry.status}${entry.why ? ` (${entry.why})` : ''}`)]
  })
}

export function sourceStatuses(doc) {
  return {
    claudePlan: doc.claude.plan.status,
    claudeLimits: doc.claude.limits.status,
    claudeActivity: doc.claude.activity.status,
    codexPlan: doc.codex.plan.status,
    codexLimits: doc.codex.limits.status
  }
}

const blockDetail = (block) => `${block.status}${block.why ? ` (${block.why})` : ''}`

// Counts and statuses only - never a server name, which is the person's own words.
export function summarizeConnections(doc) {
  const states = {}
  for (const tool of doc.tools) states[tool.state] = (states[tool.state] ?? 0) + 1
  const tools = Object.entries(states).map(([state, count]) => `${count} ${state}`).join(', ') || 'none listed'
  const claude = doc.claude.status === 'found'
    ? `found: ${doc.claude.servers.length} named, ${doc.claude.projectServers} project servers counted, ${doc.claude.hidden} hidden, ${doc.claude.more} more (${LIVE_STATES[doc.claude.live]})`
    : blockDetail(doc.claude)
  const codex = doc.codex.status === 'found'
    ? `found: ${doc.codex.servers.length} servers, ${doc.codex.plugins.length} plugins, ${doc.codex.hidden} hidden, ${doc.codex.more} more`
    : blockDetail(doc.codex)
  return [`- Tools: ${tools}`, `- Claude servers ${claude}`, `- Codex ${codex}`]
}

export function connectionStatuses(doc) {
  return { claude: doc.claude.status, codex: doc.codex.status, tools: doc.tools.filter((tool) => tool.state === 'found').length }
}

// Each part: where it goes, how it is collected, the gate it passes, and what the log says.
const PART_TABLE = {
  usage: {
    title: 'Usage',
    path: usagePath,
    collect: (deps, computer, trail) => collectUsage(deps, computer, trail),
    check: checkUsage,
    summarize: (doc, trail) => summarize(doc, trail),
    statuses: sourceStatuses
  },
  connections: {
    title: 'Connections',
    path: connectionsPath,
    collect: (deps, computer) => (deps.sources?.connections ?? collectConnections)(deps, computer),
    check: checkConnections,
    summarize: (doc) => summarizeConnections(doc),
    statuses: connectionStatuses
  }
}

if (JSON.stringify(Object.keys(PART_TABLE)) !== JSON.stringify(PARTS)) {
  throw new Error('run.mjs: the part table does not match PARTS')
}

// --only takes a comma-separated list. Returns { parts } in the contract's order, or { refusal }.
// What was typed is never repeated back: it is free text, and could be anything.
export function partsFrom(only) {
  if (only === undefined) return { parts: [...PARTS] }
  const asked = only.split(',').map((part) => part.trim())
  if (asked.some((part) => !part)) return { refusal: '--only needs part names separated by commas, with nothing empty between them.' }
  const later = asked.find((part) => Object.hasOwn(LATER_PARTS, part))
  if (later) return { refusal: LATER_PARTS[later] }
  if (asked.some((part) => !PARTS.includes(part))) return { refusal: `--only takes ${PARTS.join(', ')}, or several of them separated by commas.` }
  return { parts: PARTS.filter((part) => asked.includes(part)) }
}

// Collects every part asked for, then holds every one to the gate. Returns { snapshots } when all
// passed, or { problems } naming each refused field with its part - nothing is written either way.
async function collectParts(parts, deps, computer, identity) {
  const snapshots = []
  for (const part of parts) {
    const entry = PART_TABLE[part]
    const trail = []
    const doc = await entry.collect(deps, computer, trail)
    snapshots.push({ part, entry, trail, doc, relativePath: entry.path(computer), text: `${JSON.stringify(doc, null, 2)}\n` })
  }
  const problems = snapshots.flatMap(({ part, entry, doc }) => entry.check(doc, identity).map((problem) => `${part}: ${problem}`))
  return problems.length ? { problems } : { snapshots }
}

function report(snapshots, say) {
  for (const { entry, doc, trail } of snapshots) {
    say(`${entry.title}:`)
    entry.summarize(doc, trail).forEach(say)
  }
}

const USAGE_TEXT = [
  'Usage: node scripts/collect-status.mjs [--computer "Mac Mini"] [--only usage,connections] [--dry-run]',
  '                                       [--commit [--clone <dir>] [--state-dir <dir>]]'
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

const LINK_REFUSAL = [
  'Refused: part of the path a snapshot goes to (.agent-team/status/...) is a link to somewhere else.',
  'Nothing was written. A link there would send the file outside this folder. Replace it with a real folder.'
]

const OUTCOME_LINES = {
  pushed: { code: 0, line: 'Committed and pushed.' },
  'retried and pushed': {
    code: 0,
    line: 'The first push was refused, so the clone caught up with the remote, rewrote the snapshot and retried. Pushed.'
  },
  'nothing to commit': { code: 0, line: 'Nothing changed since the last snapshot, so nothing was committed.' }
}

// Every path is checked before any file is written, so a link in one part's folder stops them all.
async function assertNoLinksAll(target, relativePaths, options) {
  for (const relativePath of relativePaths) await assertNoLinks(target, relativePath, options)
}

async function writeAll(target, snapshots, options) {
  await assertNoLinksAll(target, snapshots.map(({ relativePath }) => relativePath), options)
  for (const { relativePath, text } of snapshots) await writeSnapshot(target, relativePath, text, options)
}

// args: { argv, deps, repoRoot, out, err }
// Returns the exit code. 2 = refused before reading anything, 1 = refused or failed after.
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
  const { parts, refusal } = partsFrom(values.only)
  if (refusal) {
    complain(refusal)
    return 2
  }
  if (values['dry-run'] && values.commit) {
    complain('--dry-run writes nothing, so it cannot also --commit.')
    return 2
  }
  if (!values.commit && (values.clone !== undefined || values['state-dir'] !== undefined)) {
    complain('--clone and --state-dir only mean something with --commit.')
    return 2
  }

  const computer = values.computer ?? DEFAULT_COMPUTER
  const labelProblems = checkComputerLabel(computer, identity)
  if (labelProblems.length) {
    complain(`Refused before reading anything. ${labelProblems.join('; ')}.`)
    complain('Give a plain label such as --computer "Mac Mini". It is never the computer\'s own name.')
    return 2
  }

  // The data clone is reset to the remote every run. Code inside it would be code chosen by
  // whoever last pushed to the team repo, run with this person's Keychain. Refused before anything.
  if (values.clone !== undefined && (await isInsideFolder(repoRoot, values.clone))) {
    complain('Refused: the collector\'s own code is inside the --clone folder.')
    complain('That folder is reset to whatever the team repo holds, so anyone who can push could choose the code that runs here.')
    complain('Run the collector from a separate code checkout, pinned to a commit you have read. The status README shows how.')
    return 2
  }

  if (values.commit) return commitRun({ values, parts, computer, deps, repoRoot, say, complain })

  // Checked before anything is read, and again by every write.
  try {
    if (!values['dry-run']) await assertNoLinksAll(repoRoot, parts.map((part) => PART_TABLE[part].path(computer)), { git: deps.git })
  } catch (error) {
    if (!(error instanceof LinkedPath)) throw error
    LINK_REFUSAL.forEach(complain)
    return 1
  }

  const collected = await collectParts(parts, deps, computer, identity)
  if (collected.problems) {
    complain(`Nothing written. The safety check refused: ${collected.problems.join('; ')}`)
    return 1
  }
  const { snapshots } = collected

  if (values['dry-run']) {
    for (const { text, relativePath } of snapshots) {
      say(text.trimEnd())
      say(`Dry run for ${computer}. Nothing written. It would go to ${relativePath}`)
    }
    report(snapshots, say)
    return 0
  }

  try {
    await writeAll(repoRoot, snapshots, { git: deps.git })
  } catch (error) {
    if (!(error instanceof LinkedPath)) throw error
    LINK_REFUSAL.forEach(complain)
    return 1
  }
  for (const { relativePath } of snapshots) say(`Snapshot for ${computer}. Wrote ${relativePath}`)
  report(snapshots, say)
  return 0
}

// The data clone holds whatever the team repo holds. Git there must not run hooks: a relative
// core.hooksPath in someone's global settings points inside the repo, and then a pushed script is
// code run on this computer. Every git command in clone mode looks for hooks in an empty folder
// the collector owns instead.
async function withoutHooks(git, stateDir) {
  const hooks = join(stateDir, 'no-hooks')
  await rm(hooks, { recursive: true, force: true })
  await mkdir(hooks, { recursive: true })
  return (args, cwd) => git(['-c', `core.hooksPath=${hooks}`, ...args], cwd)
}

// The unattended path: lock, claim, catch the clone up, collect, gate, write, receipt, commit,
// push, final record, unlock. Every exit after the claim leaves a final record saying why.
async function commitRun({ values, parts, computer, deps, repoRoot, say, complain }) {
  const identity = deps.identity ?? {}
  const stateDir = values['state-dir'] ?? join(deps.home, '.local', 'state', 'agent-status-collector')
  const mode = values.clone !== undefined ? 'clone' : 'working-copy'
  const target = mode === 'clone' ? values.clone : repoRoot
  const relativePaths = parts.map((part) => PART_TABLE[part].path(computer))
  const git = mode === 'clone' ? await withoutHooks(deps.git, stateDir) : deps.git

  const lock = await takeLock(stateDir, deps.now)
  if (!lock) {
    say('Another collector run is still running. This one skipped.')
    return 0
  }
  try {
    // The dedicated clone is the scheduled job, which runs once per three-hour slot however many
    // times launchd wakes it. A run by hand in a working copy is its own occurrence.
    const claim = await openClaim(stateDir, mode === 'clone' ? slotStamp(deps.now) : claimStamp(deps.now))
    if (!claim) {
      say(mode === 'clone'
        ? 'This three-hour slot was already claimed by an earlier run. Skipped, not repeated.'
        : 'This occurrence was already claimed by an earlier run. Skipped, not repeated.')
      return 0
    }

    let finished = false
    const finish = async (outcome, commit) => {
      finished = true
      const record = { schema: FINAL_SCHEMA, finishedAt: isoSeconds(Date.now()), outcome }
      if (commit) record.commit = commit
      if (checkAgainst(record, FINAL_SHAPE, identity).length === 0) await writeRecord(claim, 'final.json', record)
    }

    // Every exit after the claim leaves a final record, including one nobody planned for: a claim
    // with no outcome is one the task policy says not to replay blindly. The error itself is not
    // shown - it can carry a folder path.
    try {
      if (mode === 'clone') {
        let reason
        try {
          reason = await prepareClone({ git, cloneDir: target, relativePaths })
        } catch (error) {
          if (error instanceof RemoteUnreachable) {
            complain('Could not reach the team repo to bring the dedicated clone up to date, so nothing was collected or written.')
            complain('Check the network and that this computer can still pull from the team repo. The next run tries again.')
          } else {
            complain('Getting the dedicated clone ready failed, so nothing was collected or written.')
            complain('Nothing git printed is shown, because git messages can include the remote address.')
          }
          await finish('failed')
          return 1
        }
        if (reason) {
          complain(`Refused: that folder is not a dedicated clone - ${reason}. Nothing was changed in it.`)
          await finish('not a dedicated clone')
          return 2
        }
      }

      // Checked before anything is read, and again by every write.
      try {
        await assertNoLinksAll(target, relativePaths, { git })
      } catch (error) {
        if (!(error instanceof LinkedPath)) throw error
        LINK_REFUSAL.forEach(complain)
        await finish('failed')
        return 1
      }

      const collected = await collectParts(parts, deps, computer, identity)
      if (collected.problems) {
        complain(`Nothing written. The safety check refused: ${collected.problems.join('; ')}`)
        await finish('refused by the safety check')
        return 1
      }
      const { snapshots } = collected
      const write = () => writeAll(target, snapshots, { git })
      try {
        await write()
      } catch (error) {
        if (!(error instanceof LinkedPath)) throw error
        LINK_REFUSAL.forEach(complain)
        await finish('failed')
        return 1
      }

      const receipt = {
        schema: RECEIPT_SCHEMA,
        claimedAt: isoSeconds(deps.now),
        computer,
        parts,
        files: snapshots.map(({ relativePath, text }) => ({ file: relativePath, sha256: createHash('sha256').update(text).digest('hex') })),
        sources: Object.fromEntries(snapshots.map(({ part, entry, doc }) => [part, entry.statuses(doc)]))
      }
      const receiptProblems = checkAgainst(receipt, RECEIPT_SHAPE, identity)
      if (receiptProblems.length) {
        complain(`The receipt was refused by the safety check: ${receiptProblems.join('; ')}`)
        await finish('refused by the safety check')
        return 1
      }
      await writeRecord(claim, 'receipt.json', receipt)
      for (const { relativePath } of snapshots) say(`Snapshot for ${computer}. Wrote ${relativePath}`)
      report(snapshots, say)

      let result
      try {
        result = await commitAndPush({
          git,
          dir: target,
          relativePaths,
          message: `${SNAPSHOT_SUBJECT}${computer}`,
          mode,
          rewrite: write
        })
      } catch {
        complain('The commit failed. Nothing git printed is shown, because git messages can include the remote address.')
        complain('Check that git has a name and email set in that folder, and that the folder is a clone.')
        await finish('failed')
        return 1
      }
      await finish(result.outcome, result.commit)
      if (result.outcome === 'committed, not pushed') {
        say(`The snapshot is committed here but was not pushed, because ${result.why}.`)
        say('Nothing else was changed. Push it yourself when you are ready.')
        return 0
      }
      if (OUTCOME_LINES[result.outcome]) {
        say(OUTCOME_LINES[result.outcome].line)
        return OUTCOME_LINES[result.outcome].code
      }
      // Only the dedicated clone gets here: in a working copy a refused push is "committed, not
      // pushed", with its reason, above.
      complain('The push was refused twice. The dedicated clone holds the commit; the next run catches up.')
      return 1
    } catch {
      complain('The run stopped: the snapshot could not be written, or a step after it failed.')
      complain('The error is not shown, because it can include a folder path. The claim records the run as failed.')
      if (!finished) await finish('failed')
      return 1
    }
  } finally {
    await releaseLock(lock)
  }
}
