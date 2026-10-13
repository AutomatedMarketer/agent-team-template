// The changed-file check: after an action, and before anything is committed, every changed path in the work copy is held
// to what that action may touch. The lists are fixed in this code - per card action, and per job in jobs.mjs - and
// nothing the team repo says can widen them. A path that is not on the list fails the order, and so does a deletion, a
// link, a submodule, a file made executable, a file or a set of files that is too big, and an edit that is not the edit
// asked for. Nothing is pushed after a failure; the work copy is reset before the next order.
//
// It reads the work copy through git (`git(args, cwd)`, injected): what changed against HEAD in the index, in the work
// tree, and what is new and untracked, with the file modes git itself records - so a link git holds as one is seen even
// where this system checked it out as a plain file. A run log is checked with the validator in the runner's own pinned
// code (scripts/lib/run-log.mjs), so no code from the team repo is run for it.
//
// Not seen here: anything inside .git itself. Git does not list its own folder, so the runner pins hooks and config
// (the work copy's git settings are rewritten, and hooks are switched off on every command) instead of looking for them.
//
// An answer is
//   { ok: true, files: [{ path, status }], logs: [path] }       status is 'added' or 'modified'; logs are the run logs
//   { ok: false, why, problems: [{ code, path }] }               why is 'change-refused', 'run-log-refused' or 'claude-failed'
// The problems name paths of this repo and are for the owner's local log: they never go into the status file.

import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSimpleYaml } from '../yaml-lite.mjs'
import { AGENT_SLUGS, validateRunLog } from '../run-log.mjs'
import { isoSeconds } from '../status/util.mjs'
import { writeSnapshot } from '../status/write.mjs'
import { ACTIONS } from './contract.mjs'
import { JOBS } from './jobs.mjs'
import { frontmatterOf, needsYouCard, readRepoFile, slugOf } from './cards.mjs'
import { TASK_STATUSES } from './validate.mjs'

export const CHANGE_LIMITS = Object.freeze({ files: 20, fileBytes: 256 * 1024, totalBytes: 2 * 1024 * 1024 })
const NEW_CARD_BYTES = 16 * 1024
const RESULT_BYTES = 8 * 1024
const LOG_BYTES = 64 * 1024

const SEGMENT = /^[A-Za-z0-9._-]+$/
const REAL_DAY = /^\d{4}-\d{2}-\d{2}$/
const RUN_LOG_PATH = /^runs\/(\d{4}-\d{2})\/([A-Za-z0-9._-]+)\.json$/
const SWEEP_CARD_PATH = /^tasks\/([A-Za-z0-9][A-Za-z0-9._-]*)\.md$/
const AGENT_OUTPUT_PATH = /^agents\/([a-z-]+)\/output\/([A-Za-z0-9][A-Za-z0-9._-]*\.md)$/
const STAMP_OF_RUN_ID = /^(\d{4}-\d{2}-\d{2}T\d{4}Z)-/

/* ---------- what changed, from git ---------------------------------------------------------------------------------- */

// `git diff --raw -z` is ":<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0" for each file.
function parseRaw(stdout) {
  const parts = stdout.split('\0')
  const found = []
  for (let at = 0; at < parts.length; at += 1) {
    const meta = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(parts[at])
    if (meta && parts[at + 1] !== undefined) {
      found.push({ oldMode: meta[1], newMode: meta[2], letter: meta[3], path: parts[at + 1] })
      at += 1
    }
  }
  return found
}

async function listChanges(root, git) {
  const run = async (args) => (await git(['-c', 'core.quotepath=off', ...args], root)).stdout
  const staged = parseRaw(await run(['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', 'HEAD']))
  const unstaged = parseRaw(await run(['diff', '--raw', '-z', '--no-renames', '--no-abbrev']))
  // Without --exclude-standard: a file the repo's .gitignore hides is still a file this run made, and the .gitignore is
  // something other people push. Nothing hidden is committed (only named paths are), but nothing hidden is waved through.
  const untracked = (await run(['ls-files', '--others', '-z'])).split('\0').filter(Boolean)
  const byPath = new Map()
  const note = (path, change) => {
    const entry = byPath.get(path) ?? { path, status: 'modified', modes: [], deleted: false, odd: false }
    entry.modes.push(...[change.newMode].filter(Boolean))
    if (change.letter === 'D') entry.deleted = true
    if (change.letter === 'A') entry.status = 'added'
    if (!['A', 'M', 'D'].includes(change.letter ?? 'A')) entry.odd = true
    byPath.set(path, entry)
  }
  for (const change of staged) note(change.path, change)
  for (const change of unstaged) note(change.path, change)
  for (const path of untracked) note(path, { letter: 'A', newMode: null })
  return [...byPath.values()]
}

// Problems every changed file has, whatever the action: where it is, what kind of thing it is, how big.
async function generalProblems(root, entries) {
  const problems = []
  let total = 0
  if (entries.length > CHANGE_LIMITS.files) problems.push({ code: 'too-many-files', path: '' })
  for (const entry of entries) {
    const { path } = entry
    const segments = path.split('/')
    if (!segments.every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..')) problems.push({ code: 'path-shape', path })
    if (entry.deleted) {
      problems.push({ code: 'deleted', path })
      continue
    }
    if (entry.odd) problems.push({ code: 'type-change', path })
    for (const mode of entry.modes) {
      if (mode === '120000') problems.push({ code: 'link', path })
      else if (mode === '160000') problems.push({ code: 'submodule', path })
      else if (mode === '100755') problems.push({ code: 'executable', path })
      else if (mode !== '100644') problems.push({ code: 'mode', path })
    }
    let info
    try {
      info = await lstat(join(root, ...segments))
    } catch {
      problems.push({ code: 'missing', path })
      continue
    }
    if (info.isSymbolicLink()) problems.push({ code: 'link', path })
    else if (!info.isFile()) problems.push({ code: 'not-file', path })
    else {
      if (process.platform !== 'win32' && info.mode & 0o111) problems.push({ code: 'executable', path })
      if (info.size > CHANGE_LIMITS.fileBytes) problems.push({ code: 'too-big', path })
      total += info.size
    }
  }
  if (total > CHANGE_LIMITS.totalBytes) problems.push({ code: 'too-big-together', path: '' })
  return problems
}

/* ---------- edits that are only the edit asked for ----------------------------------------------------------------- */

const lines = (text) => text.split('\n').map((line) => line.replace(/\r$/, ''))
const sameList = (a, b) => a.length === b.length && a.every((line, at) => line === b[at])
const isStatusLine = (line) => line.startsWith('status:')
const isDoneLine = (line) => line.startsWith('done_at:')
const isRealDay = (value) => REAL_DAY.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)
const statusOf = (line) => line.slice('status:'.length).trim()
const dayOf = (line) => line.slice('done_at:'.length).trim()

// The frontmatter lines of a card, and what follows them; null for a card that has none.
function splitCard(text) {
  const frontmatter = frontmatterOf(text)
  if (frontmatter === null) return null
  return { lead: text.slice(0, frontmatter.from), lines: lines(text.slice(frontmatter.from, frontmatter.end)), rest: text.slice(frontmatter.end) }
}

// Both ways a card's frontmatter may change: the status lines hold a status, the done_at lines a real day, and every
// other line is as it was, in the same order. `wanted`, when given, is the one status the edit was asked to make.
function frontmatterChangeIsOnlyStatus(before, after, wanted) {
  if (before.lead !== after.lead) return false
  const keep = (list) => list.filter((line) => !isStatusLine(line) && !isDoneLine(line))
  if (!sameList(keep(before.lines), keep(after.lines))) return false
  const statuses = after.lines.filter(isStatusLine).map(statusOf)
  if (!statuses.length || !statuses.every((status) => TASK_STATUSES.includes(status))) return false
  if (wanted !== undefined && !statuses.every((status) => status === wanted)) return false
  const days = after.lines.filter(isDoneLine).map(dayOf)
  if (!days.every(isRealDay)) return false
  if (wanted !== 'done' && wanted !== undefined) return sameList(after.lines.filter(isDoneLine), before.lines.filter(isDoneLine))
  return wanted !== 'done' || days.length > 0
}

// Start and Done: the status (and the day) and nothing else - not one byte of the body.
function startOrDoneIsOnlyThat(oldText, newText, status) {
  const before = splitCard(oldText)
  const after = splitCard(newText)
  if (before === null) {
    // A card with no frontmatter gets one in front of everything it had.
    if (!newText.endsWith(oldText)) return false
    const lead = newText.slice(0, newText.length - oldText.length)
    const made = /^---\nstatus: (todo|doing|done)\n(?:done_at: (\d{4}-\d{2}-\d{2})\n)?---\n$/.exec(lead)
    return made !== null && made[1] === status && (status === 'done' ? made[2] !== undefined && isRealDay(made[2]) : made[2] === undefined)
  }
  if (after === null || before.rest !== after.rest) return false
  return frontmatterChangeIsOnlyStatus(before, after, status)
}

// The sweep: the same for the frontmatter, and the body may only grow, by a Result section at the end.
function sweepEditIsOnlyThat(oldText, newText) {
  const before = splitCard(oldText)
  const after = splitCard(newText)
  if (before === null || after === null) return false
  if (!after.rest.startsWith(before.rest)) return false
  const added = after.rest.slice(before.rest.length)
  if (added !== '' && (added.length > RESULT_BYTES || !/^\n*## Result\n/.test(added))) return false
  return frontmatterChangeIsOnlyStatus(before, after, undefined)
}

// Pause: some `schedule:` lines are commented out, each keeping its words and its indent, and no line is anything else.
function pauseIsOnlyThat(oldText, newText) {
  const before = lines(oldText)
  const after = lines(newText)
  if (before.length !== after.length) return false
  let changed = 0
  for (let at = 0; at < before.length; at += 1) {
    if (before[at] === after[at]) continue
    const schedule = /^([ \t]+)(schedule:.*)$/.exec(before[at])
    if (!schedule || after[at] !== `${schedule[1]}# ${schedule[2]}`) return false
    changed += 1
  }
  return changed > 0
}

// Approve: one `approved: true` line added to a row, or an `approved:` line of a row set to true - and the file, read the
// way the board reads it, differs only in the one row whose task is the one asked for.
function approveIsOnlyThat(oldText, newText, task) {
  const before = lines(oldText)
  const after = lines(newText)
  const approvedLine = /^(\s+-\s+|\s+)approved:.*$/
  if (after.length === before.length + 1) {
    let at = 0
    while (at < before.length && before[at] === after[at]) at += 1
    if (!sameList(before.slice(at), after.slice(at + 1)) || !/^[ \t]+approved: true$/.test(after[at])) return false
  } else if (after.length === before.length) {
    let changed = 0
    for (let at = 0; at < before.length; at += 1) {
      if (before[at] === after[at]) continue
      const prefix = approvedLine.exec(before[at])?.[1]
      if (prefix === undefined || after[at] !== `${prefix}approved: true`) return false
      changed += 1
    }
    if (!changed) return false
  } else {
    return false
  }
  const was = parseSimpleYaml(oldText)
  const now = parseSimpleYaml(newText)
  const rows = Array.isArray(was.proposals) ? was.proposals : []
  const targets = rows.flatMap((row, at) => (row !== null && typeof row === 'object' && row.task === task ? [at] : []))
  if (targets.length !== 1) return false
  const expected = structuredClone(was)
  expected.proposals[targets[0]].approved = true
  return JSON.stringify(now) === JSON.stringify(expected)
}

/* ---------- the actions -------------------------------------------------------------------------------------------- */

async function oldTextOf(root, git, path) {
  try {
    return (await git(['show', `HEAD:${path}`], root)).stdout
  } catch {
    return null
  }
}

const refuse = (code, path) => ({ code, path })

// The card actions: what each may add or change, and how.
async function cardProblems({ root, git, action, fields, date }, entries) {
  const problems = []
  const only = entries.filter((entry) => !entry.deleted)
  if (['task', 'arm', 'skill', 'agent'].includes(action)) {
    // The card is named by the day and by the heading it was given, with -2, -3 when the name was taken.
    const heading = action === 'task' ? fields.title : needsYouCard(action, fields).heading
    const name = new RegExp(`^tasks/${date ?? '\\d{4}-\\d{2}-\\d{2}'}-${slugOf(heading)}(?:-\\d+)?\\.md$`)
    const cards = only.filter((entry) => entry.status === 'added' && name.test(entry.path))
    const others = only.filter((entry) => !cards.includes(entry))
    if (others.length) return others.map((entry) => refuse('path-not-allowed', entry.path))
    if (cards.length !== 1) return [refuse(cards.length ? 'more-than-one-card' : 'no-card', cards[0]?.path ?? '')]
    const text = await readRepoFile(root, cards[0].path, git)
    const head = /^---\nstatus: todo\n(?:for: [a-z0-9-]+\n)?(?:model: (?:opus|sonnet|haiku)\n)?---\n\n# /
    if (text.state !== 'ok' || text.text.length > NEW_CARD_BYTES || !head.test(text.text) || !text.text.includes(`\n---\n\n# ${heading}\n`)) return [refuse('not-a-todo-card', cards[0].path)]
    return problems
  }
  if (only.length > 1) return only.map((entry) => refuse('more-than-one-file', entry.path))
  if (only.length === 0) return problems
  const [{ path, status }] = only
  const wanted = { move: `tasks/${fields.task}.md`, pause: `workflows/${fields.workflow}.yml`, approve: 'proposals.yml' }[action]
  if (status !== 'modified' || path !== wanted) return [refuse('not-the-file', path)]
  const before = await oldTextOf(root, git, path)
  const after = await readRepoFile(root, path, git)
  if (before === null || after.state !== 'ok') return [refuse('unreadable', path)]
  const fine =
    action === 'move' ? startOrDoneIsOnlyThat(before, after.text, fields.status)
    : action === 'pause' ? pauseIsOnlyThat(before, after.text)
    : approveIsOnlyThat(before, after.text, fields.task)
  return fine ? problems : [refuse('not-the-edit-asked-for', path)]
}

// One run log: parsed, checked by the validator, and checked to be this run's - this job, a stamp it was given, manual,
// no session, the model that ran, the time it started.
async function logProblems(root, git, path, plan, seenStamps) {
  const found = await readRepoFile(root, path, git)
  if (found.state !== 'ok' || found.text.length > LOG_BYTES) return [refuse('log-unreadable', path)]
  let entry
  try {
    entry = JSON.parse(found.text)
  } catch {
    return [refuse('log-not-json', path)]
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [refuse('log-not-an-object', path)]
  const [, month, name] = RUN_LOG_PATH.exec(path)
  const problems = validateRunLog(entry, { filename: `${name}.json` }).map(() => refuse('log-invalid', path))
  if (problems.length) return problems
  const stamp = STAMP_OF_RUN_ID.exec(entry.run_id)?.[1]
  const checks = [
    [stamp !== undefined && plan.stamps.includes(stamp), 'log-stamp'],
    [stamp !== undefined && !seenStamps.has(stamp), 'log-stamp-twice'],
    [stamp !== undefined && stamp.slice(0, 7) === month, 'log-month'],
    [entry.run_id === `${stamp}-${entry.agent}-${plan.slug}`, 'log-run-id'],
    [entry.workflow === plan.slug, 'log-workflow'],
    [entry.trigger === 'manual', 'log-trigger'],
    [(entry.session_id ?? null) === null && (entry.session_url ?? null) === null, 'log-session'],
    [entry.model === plan.model, 'log-model'],
    [entry.started_at === plan.startedAt, 'log-started'],
    [plan.slug !== 'morning-intel' || entry.agent === plan.owner, 'log-agent']
  ]
  if (stamp !== undefined) seenStamps.add(stamp)
  return checks.filter(([good]) => !good).map(([, code]) => refuse(code, path))
}

// A job run: its output, its run logs, and for the sweep its cards and its specialists' outputs.
async function runProblems({ root, git, plan }, entries) {
  const sweep = plan.slug === 'task-sweep'
  const problems = []
  const logs = []
  let hasOutput = false
  for (const entry of entries.filter((one) => !one.deleted)) {
    const { path, status } = entry
    if (path === plan.outputPath) {
      hasOutput = true
    } else if (RUN_LOG_PATH.test(path) && status === 'added') {
      logs.push(path)
    } else if (sweep && SWEEP_CARD_PATH.test(path) && status === 'modified' && path !== 'tasks/README.md') {
      const before = await oldTextOf(root, git, path)
      const after = await readRepoFile(root, path, git)
      if (before === null || after.state !== 'ok' || !sweepEditIsOnlyThat(before, after.text)) problems.push(refuse('card-edit', path))
    } else if (sweep && status === 'added' && AGENT_OUTPUT_PATH.test(path) && AGENT_SLUGS.includes(AGENT_OUTPUT_PATH.exec(path)[1])) {
      // A new draft in a specialist's output folder.
    } else {
      problems.push(refuse('path-not-allowed', path))
    }
  }
  return { problems, logs, hasOutput }
}

/* ---------- the check ---------------------------------------------------------------------------------------------- */

// action, fields: the order's. plan: for a run, the plan jobs.mjs made. date: the day cards are named for (optional).
export async function checkChanges({ root, git, action, fields, plan, date }) {
  if (typeof action !== 'string' || !ACTIONS.includes(action)) throw new TypeError('diffcheck: that is not an action')
  const isRun = action === 'run'
  if (isRun && (!plan || typeof plan.slug !== 'string' || !Object.hasOwn(JOBS, plan.slug) || fields?.workflow !== plan.slug)) throw new TypeError('diffcheck: a run needs the plan of a job with rules')
  const entries = await listChanges(root, git)
  const problems = await generalProblems(root, entries)

  let logs = []
  let missingOutput = false
  if (isRun) {
    const run = await runProblems({ root, git, plan }, entries)
    problems.push(...run.problems)
    logs = run.logs.sort()
    missingOutput = !run.hasOutput
    const seen = new Set()
    const logFaults = []
    if (!problems.length && !missingOutput) {
      for (const path of logs) logFaults.push(...(await logProblems(root, git, path, plan, seen)))
      // (More logs than the job has stamps cannot pass the stamp checks above, so only too few needs counting.)
      if (logs.length < plan.logs.min) logFaults.push(refuse('log-count', ''))
      if (logFaults.length) return { ok: false, why: 'run-log-refused', problems: logFaults }
    }
  } else if (!problems.length) {
    problems.push(...(await cardProblems({ root, git, action, fields, date }, entries)))
  }
  if (problems.length) return { ok: false, why: 'change-refused', problems }
  if (missingOutput) return { ok: false, why: 'claude-failed', problems: [refuse('no-output', plan.outputPath)] }
  const files = entries.filter((entry) => !entry.deleted).map(({ path, status }) => ({ path, status })).sort((a, b) => (a.path < b.path ? -1 : 1))
  return { ok: true, files, logs }
}

/* ---------- the true finish time ----------------------------------------------------------------------------------- */

// Claude has no clock, so it writes its run logs with finished_at equal to started_at. After the check passes, the
// runner sets the true finish time in each log - never before the start - and nothing else in the file changes.
export async function finishRunLogs({ root, paths, finishedAt }) {
  for (const path of paths) {
    const found = await readRepoFile(root, path)
    if (found.state !== 'ok') throw new Error('diffcheck: a run log could not be read')
    const entry = JSON.parse(found.text)
    entry.finished_at = isoSeconds(Math.max(finishedAt, Date.parse(entry.started_at)))
    await writeSnapshot(root, path, `${JSON.stringify(entry, null, 2)}\n`)
  }
}
