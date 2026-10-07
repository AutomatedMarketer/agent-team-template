// The collector run: read every source, put them in one file, pass the gate, write.
//
// Every input is handed in through `deps` - home folder, environment, clock, network, Keychain,
// identity - so the tests can run the whole thing against a fake home with a fake network, and
// the leak test exercises exactly the code that runs on the real machine.

import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import {
  USAGE_SCHEMA,
  DEFAULT_COMPUTER,
  usagePath,
  RECEIPT_SCHEMA,
  RECEIPT_SHAPE,
  FINAL_SCHEMA,
  FINAL_SHAPE
} from './schema.mjs'
import { checkUsage, checkLine, checkComputerLabel, checkAgainst } from './safe.mjs'
import { isoSeconds } from './util.mjs'
import { writeSnapshot, assertNoLinks, LinkedPath } from './write.mjs'
import { collectClaudeLimits } from './claude-limits.mjs'
import { collectClaudeActivity } from './claude-activity.mjs'
import { collectCodexLimits } from './codex-limits.mjs'
import { claudePlan, collectCodexPlan } from './plans.mjs'
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
  return {
    claudePlan: doc.claude.plan.status,
    claudeLimits: doc.claude.limits.status,
    claudeActivity: doc.claude.activity.status,
    codexPlan: doc.codex.plan.status,
    codexLimits: doc.codex.limits.status
  }
}

const USAGE_TEXT = [
  'Usage: node scripts/collect-status.mjs [--computer "Mac Mini"] [--only usage] [--dry-run]',
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
  'Refused: part of the path the snapshot goes to (.agent-team/status/usage) is a link to somewhere else.',
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
  if (values.only !== undefined && values.only !== 'usage') {
    complain('Only --only usage exists so far. Connections and Hermes come in later phases.')
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

  if (values.commit) return commitRun({ values, computer, deps, repoRoot, say, complain })

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

  try {
    await writeSnapshot(repoRoot, relativePath, text)
  } catch (error) {
    if (!(error instanceof LinkedPath)) throw error
    LINK_REFUSAL.forEach(complain)
    return 1
  }
  say(`Usage snapshot for ${computer}. Wrote ${relativePath}`)
  summarize(doc).forEach(say)
  return 0
}

// The unattended path: lock, claim, catch the clone up, collect, gate, write, receipt, commit,
// push, final record, unlock. Every exit after the claim leaves a final record saying why.
async function commitRun({ values, computer, deps, repoRoot, say, complain }) {
  const identity = deps.identity ?? {}
  const stateDir = values['state-dir'] ?? join(deps.home, '.local', 'state', 'agent-status-collector')
  const mode = values.clone !== undefined ? 'clone' : 'working-copy'
  const target = mode === 'clone' ? values.clone : repoRoot
  const relativePath = usagePath(computer)

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
          reason = await prepareClone({ git: deps.git, cloneDir: target, relativePath })
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
        await assertNoLinks(target, relativePath, { git: deps.git })
      } catch (error) {
        if (!(error instanceof LinkedPath)) throw error
        LINK_REFUSAL.forEach(complain)
        await finish('failed')
        return 1
      }

      const doc = await collectUsage(deps, computer)
      const problems = checkUsage(doc, identity)
      if (problems.length) {
        complain(`Nothing written. The safety check refused: ${problems.join('; ')}`)
        await finish('refused by the safety check')
        return 1
      }
      const text = `${JSON.stringify(doc, null, 2)}\n`
      const write = () => writeSnapshot(target, relativePath, text, { git: deps.git })
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
        file: relativePath,
        sha256: createHash('sha256').update(text).digest('hex'),
        sources: sourceStatuses(doc)
      }
      const receiptProblems = checkAgainst(receipt, RECEIPT_SHAPE, identity)
      if (receiptProblems.length) {
        complain(`The receipt was refused by the safety check: ${receiptProblems.join('; ')}`)
        await finish('refused by the safety check')
        return 1
      }
      await writeRecord(claim, 'receipt.json', receipt)
      say(`Usage snapshot for ${computer}. Wrote ${relativePath}`)
      summarize(doc).forEach(say)

      let result
      try {
        result = await commitAndPush({
          git: deps.git,
          dir: target,
          relativePath,
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
      if (mode === 'clone') {
        complain('The push was refused twice. The dedicated clone holds the commit; the next run catches up.')
      } else {
        complain('The push was refused - the remote has commits this copy does not.')
        complain('The snapshot is committed here and your working copy was left as it is. Pull, then push when ready.')
      }
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
