// One tick of the runner: ask the board, check each order, claim it, do it, check what changed, push it, and say so.
//
// The order of things is the plan's, and each step is a promise the tests hold:
//   1. the folders do not overlap, there is no PAUSE file, and no other tick is running (a lock)
//   2. the Mac's allowlist and secrets are readable; the claim store is open
//   3. once a day: Claude is found, new enough, logged in with the owner's own login; no key is set; origin is the team repo
//   4. orders the runner lost track of part way are settled by READING the team repo, never run again
//   5. at the board's pace, one GET for the pending orders
//   6. each order, oldest first: verified (signature first), then its fields, then the Mac's own allowlist and day limits,
//      then claimed - on disk, durably, before anything is done - and only then done, by the runner's own code (cards) or
//      by Claude (a run), with every changed path checked before a commit
//   7. a change goes back in one commit with the order's trailer and the status file, by a lease push; if the team repo moved
//      meanwhile it is put back on top (cards again; a run's files when nothing they touch has changed) at most three times;
//      Claude is never run again for it
//   8. the status file is rebuilt from the claims and pushed when it changed (or once in a while to show it is alive)
//
// Everything outside is handed in (`ctx`) so the tests run the whole thing against a real git remote with a fake board, a
// fake Claude and a clock of their own:
//   places { stateDir, codeDir, workDir, envFile }     now() -> ms      platform, env, home, identity, timeZone
//   fetch (the board)   git(args, cwd) -> { stdout }   exec, find (finding and asking Claude)   spawn, kill (running it)
//   originAccepted(url) -> boolean (default: the allowlisted repo on GitHub)   log(line)   force (ignore the board's pace)
//   fs (optional: the file system the claims and counts are written through)
//
// What a tick leaves behind for the owner: last-tick.json in the state folder (when, what it did - counts and codes, never
// a word anyone typed), and one line through ctx.log.

import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { releaseLock, takeLock } from '../status/commit.mjs'
import { isoSeconds } from '../status/util.mjs'
import { mailboxPath } from '../status/mailbox-schema.mjs'
import { ACTIONS } from './contract.mjs'
import { verifyEnvelope } from './envelope.mjs'
import { validatePayload } from './validate.mjs'
import { checkPlaces } from './places.mjs'
import { readMailboxEnv } from './keys.mjs'
import { CEILINGS, addCount, readAllowedOrders, readCounts, decide, runnableJobs, dayOf } from './allow.mjs'
import { CLAIMS_STORE, claimExists, claimOrder, openStore, writeClaimFile } from './claims.mjs'
import { pollBoard } from './board.mjs'
import { applyCard, readRepoFile, todayIn } from './cards.mjs'
import { JOBS, knownJobs, planRun, runPrompt } from './jobs.mjs'
import { MINIMUM_VERSION, atLeast, buildArgv, claudeEnv, followToFile, localProblems, originMatches, preflight, runClaude, toolsFor, versionOfFile } from './claude.mjs'
import { proofHolds, proofKept } from './proof.mjs'
import { checkChanges, finishRunLogs } from './diffcheck.mjs'
import { gitUnchanged, remakeWorkCopy, snapshotGit } from './gitguard.mjs'
import { commitPaths, landedCommit, pinnedGit, pushCommits, readOrigin, resetWorkCopy } from './workcopy.mjs'
import { buildMailbox, readMailboxStatus, writeMailboxStatus } from './status.mjs'
import { ordersFromClaims, reconcile } from './ledger.mjs'

export const STATUS_REFRESH_MS = 6 * 3600_000
export const PACE_SLACK_MS = 30_000
export const MOST_ORDERS_PER_TICK = 5
const MOST_PUSH_ATTEMPTS = 3
const DEFAULT_PACE_SECONDS = 300

// Why an authentic order that fails one of the contract's checks is refused, in the status file's words.
const REFUSAL_FOR = { expired: 'expired', 'wrong-repo': 'wrong-repo', 'wrong-runner': 'wrong-runner' }

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const exists = async (path) => {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

// A small JSON file written whole (a new file, then moved into place) for the owner alone. Best effort: a tick is not
// failed because its own note could not be kept.
async function keepJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  } catch {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

function actionOf(entry) {
  try {
    const action = JSON.parse(entry.body)?.payload?.action
    return ACTIONS.includes(action) ? action : undefined
  } catch {
    return undefined
  }
}

/* ---------- the tick ----------------------------------------------------------------------------------------------- */

export async function runTick(ctx) {
  const { places } = ctx
  const log = ctx.log ?? (() => {})
  const orders = { seen: 0, skipped: 0, claimed: 0, ok: 0, refused: 0, failed: 0 }
  const lastPath = join(places.stateDir, 'last-tick.json')

  const end = async (state, why, extra = {}) => {
    const previous = (await readJson(lastPath)) ?? {}
    const record = {
      schema: 'agent-mailbox-tick/v1',
      at: isoSeconds(ctx.now()),
      state,
      ...(why ? { why } : {}),
      polledAt: extra.polledAt ?? previous.polledAt ?? null,
      pollSeconds: extra.pollSeconds ?? previous.pollSeconds ?? null,
      board: extra.board ?? previous.board ?? null,
      orders
    }
    await mkdir(places.stateDir, { recursive: true }).catch(() => {})
    await keepJson(lastPath, record)
    log(`mailbox tick: ${state}${why ? ` (${why})` : ''} - ${orders.claimed} claimed, ${orders.ok} done, ${orders.refused} refused, ${orders.failed} failed`)
    return { state, ...(why ? { why } : {}), orders }
  }

  const where = await checkPlaces(places)
  if (!where.ok) return end('not-ready', `places-${where.why}`)
  await mkdir(places.stateDir, { recursive: true })
  if (await exists(join(places.stateDir, 'PAUSE'))) return end('paused')
  const lock = await takeLock(places.stateDir, ctx.now())
  if (lock === null) return { state: 'busy', orders }
  // A signal that stops the runner releases this lock itself (signals.mjs), so it is told which one is held.
  if (ctx.live) ctx.live.lock = lock
  try {
    return await locked(ctx, { orders, end, log })
  } finally {
    if (ctx.live) ctx.live.lock = null
    await releaseLock(lock)
  }
}

async function locked(ctx, { orders, end, log }) {
  const { places } = ctx

  const allowed = await readAllowedOrders(places.stateDir, ctx.identity)
  if (allowed.state === 'missing') return end('unavailable', 'no-allowlist')
  if (allowed.state === 'broken') return end('unavailable', `allowlist-${allowed.why}`)
  const secrets = await readMailboxEnv(places.envFile, { platform: ctx.platform })
  if (secrets.state === 'missing') return end('unavailable', 'keys-missing')
  if (secrets.state === 'broken') return end('unavailable', `keys-${secrets.why}`)
  const store = await openStore(places.stateDir, ctx.now(), { fs: ctx.fs })
  if (!store.ok) return end('stopped', 'store')

  const hooks = join(places.stateDir, 'empty-hooks')
  await rm(hooks, { recursive: true, force: true })
  await mkdir(hooks)
  const emptyCwd = join(places.stateDir, 'empty-cwd')
  await rm(emptyCwd, { recursive: true, force: true })
  await mkdir(emptyCwd)

  const s = {
    ctx, orders, log, allow: allowed.allow, keys: secrets.secrets, key: secrets.key, claimsSince: store.since, hooks,
    git: pinnedGit(ctx.git, hooks),
    originAccepted: ctx.originAccepted ?? ((url) => originMatches(url, allowed.allow.repo)),
    runnable: runnableJobs(allowed.allow, knownJobs()),
    claudeReady: false, claudePath: null, notReady: [], emptyCwd
  }

  const checked = await dailyCheck(s, emptyCwd)
  if (checked.problems.includes('key-in-environment')) return end('not-ready', 'key-in-environment')
  if (checked.problems.includes('origin-mismatch')) return end('not-ready', 'origin-mismatch')
  s.claudeReady = checked.ok
  s.claudePath = checked.claudePath
  s.notReady = checked.problems
  // No run until the walls around Claude were proven on this Mac (--selftest) for this Claude Code and these settings. This is a first look,
  // against the version the daily check remembered, so a tick with no proof does not even claim a run. It is not the last word: Claude Code
  // can update itself after the daily check, so the version is asked again just before each run (versionToRun), and the proof must be for the very file that
  // would start; this first look cannot say which file that is, so it only asks for a proof of this version at all.
  if (checked.ok && !(await proofKept({ stateDir: places.stateDir, codeDir: places.codeDir, version: checked.version })).holds) {
    s.claudeReady = false
    s.notReady = [...s.notReady, 'selftest-needed']
  }

  // The clone's own config is written again before git is first run in it, then orders lost track of are settled by reading.
  const level = await resetWorkCopy({ git: ctx.git, work: places.workDir, emptyHooks: hooks, originAccepted: s.originAccepted })
  if (!level.ok && level.why !== 'unreachable') return end('not-ready', `work-${level.why}`)
  await reconcile({
    stateDir: places.stateDir,
    now: ctx.now(),
    landed: (id) => landedCommit({ git: ctx.git, work: places.workDir, emptyHooks: hooks, id }),
    fs: ctx.fs
  })
  // With the team repo out of reach nothing can be pushed, so nothing is asked for either; the lost orders above were
  // marked "not yet checked" and are looked at again when it is back.
  if (!level.ok) return end('not-ready', 'work-unreachable')

  // The board's pace: the last answer's pollSeconds, less a little slack for the scheduler's own timing.
  const last = await readJson(join(places.stateDir, 'last-tick.json'))
  const due = Date.parse(last?.polledAt ?? '') + (last?.pollSeconds ?? DEFAULT_PACE_SECONDS) * 1000 - PACE_SLACK_MS
  let polled = {}
  let state = 'waiting'
  if (ctx.force || !Number.isFinite(due) || ctx.now() >= due) {
    const answer = await pollBoard({ allow: s.allow, key: s.key, fetch: ctx.fetch })
    if (!answer.ok) {
      await syncStatus(s)
      return end('board-failed', answer.why, { board: answer.why })
    }
    polled = { polledAt: isoSeconds(ctx.now()), pollSeconds: answer.pollSeconds, board: 'ok' }
    state = 'done'
    const stopped = await handleAll(s, answer.orders)
    if (stopped) {
      await syncStatus(s)
      return end('stopped', stopped, polled)
    }
  }
  await syncStatus(s)
  return end(state, undefined, polled)
}

/* ---------- the daily check ----------------------------------------------------------------------------------------- */

// Claude's version and login are asked once a day, and only a good answer is remembered: a problem is looked at again on
// the next tick, so fixing it takes effect at once. A key in the environment and the work copy's origin cost nothing and
// can change at any time, so those two are checked on every tick.
async function dailyCheck(s, emptyCwd) {
  const { ctx } = s
  const path = join(ctx.places.stateDir, 'preflight.json')
  const today = dayOf(ctx.now())
  const cached = await readJson(path)
  // A good answer is believed only if it is still good by today's floor: the runner's code may have been moved to a newer one.
  if (cached?.day === today && cached.ok === true && Array.isArray(cached.version) && atLeast(cached.version, MINIMUM_VERSION)) {
    const found = await ctx.find('claude')
    const problems = await localProblems({ env: ctx.env, origin: () => readOrigin(ctx.places.workDir), originAccepted: s.originAccepted })
    if (found.state === 'found') return { ok: problems.length === 0, version: cached.version, problems, claudePath: found.path }
  }
  const result = await preflight({
    find: ctx.find,
    exec: ctx.exec,
    origin: () => readOrigin(ctx.places.workDir),
    originAccepted: s.originAccepted,
    emptyDir: emptyCwd,
    env: ctx.env,
    platform: ctx.platform
  })
  if (result.ok) await keepJson(path, { day: today, ok: true, version: result.version })
  else await rm(path, { force: true })
  return { ...result, claudePath: (await ctx.find('claude')).path ?? null }
}

/* ---------- the orders ---------------------------------------------------------------------------------------------- */

// Returns a reason to stop the tick, or null.
async function handleAll(s, entries) {
  let runs = 0
  for (const entry of entries) {
    s.orders.seen += 1
    if (s.orders.claimed >= MOST_ORDERS_PER_TICK) {
      s.orders.skipped += 1
      continue
    }
    const result = await handleOrder(s, entry)
    if (result.stop) return result.stop
    if (result.skipped) s.orders.skipped += 1
    if (result.ran) runs += 1
    if (runs >= 1) break
  }
  return null
}

async function handleOrder(s, entry) {
  const { ctx, allow } = s
  const { stateDir } = ctx.places
  const verdict = verifyEnvelope(entry, { keys: s.keys, now: ctx.now(), repo: allow.repo, runner: allow.runner, claimsSince: s.claimsSince })
  // Nobody who cannot sign is recorded, and an order that is not yet good is left for later.
  if (!verdict.authentic || verdict.verdict === 'issued-in-future') return { skipped: true }
  const id = verdict.ok ? verdict.order.id : verdict.id
  if (id === undefined) return { skipped: true }
  if (await claimExists(stateDir, id, { fs: ctx.fs })) return { skipped: true }

  let action = verdict.ok ? undefined : actionOf(entry)
  let fields
  let refusal = verdict.ok ? null : (REFUSAL_FOR[verdict.verdict] ?? 'not-valid')
  let minutes
  if (refusal === null) {
    const payload = validatePayload(verdict.order.payload)
    if (!payload.ok) {
      action = actionOf(entry)
      refusal = 'not-valid'
    } else {
      action = payload.action
      fields = payload.fields
      const counts = await readCounts(stateDir, ctx.now(), ctx.fs)
      const decision = decide(allow, counts, action, fields, s.runnable)
      if (!decision.ok) refusal = decision.why
      else if (action === 'run' && !s.claudeReady) {
        refusal = 'not-ready'
        // The status file gives only the fixed word; the owner's own log says which check it was.
        s.log(`mailbox: a run was refused as not ready (${s.notReady.join(', ') || 'unknown'})`)
      }
      else minutes = decision.minutes
    }
  }

  if (refusal !== null) {
    const counts = await readCounts(stateDir, ctx.now(), ctx.fs)
    if (counts.broken) return { stop: 'counts-damaged' }
    if (counts.refused >= CEILINGS.refused) return { skipped: true }
    if ((await addCount(stateDir, ctx.now(), 'refused', ctx.fs)) === null) return { stop: 'counts-damaged' }
    const claimed = await claimOrder(stateDir, id, entry, ctx.now(), { action, fs: ctx.fs })
    if (claimed.state === 'seen') return { skipped: true }
    if (claimed.state === 'failed') return { stop: 'claim-failed' }
    s.orders.claimed += 1
    await settle(s, id, action, { state: 'refused', why: refusal })
    return {}
  }

  if ((await addCount(stateDir, ctx.now(), 'orders', ctx.fs)) === null) return { stop: 'counts-damaged' }
  const claimed = await claimOrder(stateDir, id, entry, ctx.now(), { action, fs: ctx.fs })
  if (claimed.state === 'seen') return { skipped: true }
  if (claimed.state === 'failed') return { stop: 'claim-failed' }
  s.orders.claimed += 1
  if (action === 'run') await addCount(stateDir, ctx.now(), 'runs', ctx.fs)
  await execute(s, { id, action, fields, minutes })
  return { ran: action === 'run' }
}

// The final word of an order, written to its claim and counted. `change` is { state, why?, commit?, startedAt?, files? }.
async function settle(s, id, action, change) {
  const { ctx } = s
  // Stopped by a signal: whatever happened to the order since, nobody knows how it ended, so no final word is written. The claim keeps its
  // receipt and the next tick settles it by reading (signals.mjs).
  if (ctx.live?.stopping) throw new Error('the runner was stopped by a signal')
  const now = isoSeconds(ctx.now())
  const record = {
    id,
    action: action ?? null,
    state: change.state,
    at: now,
    startedAt: change.startedAt ?? null,
    finishedAt: change.state === 'ok' || change.state === 'failed' ? now : null,
    commit: change.commit ?? null,
    why: change.why ?? null,
    landed: null,
    ...(change.files ? { files: change.files } : {})
  }
  // A final word that cannot be written stops everything, as a crash would: the claim then has none, and the next tick settles it.
  if (!(await writeClaimFile(ctx.places.stateDir, id, 'final.json', record, { fs: ctx.fs })).ok) throw new Error('the final word of an order could not be written')
  if (change.state === 'ok') s.orders.ok += 1
  else if (change.state === 'refused') s.orders.refused += 1
  else if (change.state === 'failed') s.orders.failed += 1
}

/* ---------- doing one order ----------------------------------------------------------------------------------------- */

async function execute(s, { id, action, fields, minutes }) {
  const { ctx } = s
  const { workDir } = ctx.places
  const startedMs = ctx.now()
  const fail = (why) => settle(s, id, action, { state: 'failed', why, startedAt: action === 'run' ? isoSeconds(startedMs) : null })
  const level = () => resetWorkCopy({ git: ctx.git, work: workDir, emptyHooks: s.hooks, originAccepted: s.originAccepted })

  let reset = await level()
  if (!reset.ok) {
    if (reset.why === 'unreachable') return fail('push-failed')
    return settle(s, id, action, { state: 'refused', why: 'not-ready' })
  }

  if (action === 'run') return executeRun(s, { id, action, fields, minutes, startedMs, reset, fail, level })

  // A card action: the runner's own code, with no model - and it can be done again exactly, on top of a newer main.
  const redo = async () => {
    const done = await applyCard({ root: workDir, action, fields, now: ctx.now(), timeZone: ctx.timeZone, git: s.git })
    if (!done.ok) return { ok: false, state: done.state, why: done.why }
    const checked = await checkChanges({ root: workDir, git: s.git, action, fields, date: todayIn(ctx.now(), ctx.timeZone) })
    if (!checked.ok) return { ok: false, state: 'failed', why: checked.why }
    return { ok: true, files: checked.files.map((file) => file.path) }
  }
  const first = await redo()
  if (!first.ok) return settle(s, id, action, { state: first.state, why: first.why })
  return publish(s, { id, action, head: reset.head, files: first.files, redo, level, fail, startedAt: null })
}

// The Claude Code that would start now, and whether it is the one the self-test passed for, with the settings it passed for.
//
// The name Claude Code is found by (~/.local/bin/claude) is a link into a folder of versions (https://code.claude.com/docs/en/setup#auto-updates),
// and an update - by its own background check if it was ever started without the switch, or by the owner using it by hand - moves that link.
// So the link is followed to the real file ONCE, here; the version is asked of that file, from an empty folder and with the small environment
// (so it reads no team repo, and does not update itself); and that same file is what starts. The name is never looked up a second time, so a
// link swapped between the check and the start changes nothing: the file that was checked is the file that runs. The self-test proof is for
// that same file (its real path, and its version): a different file that happens to say the same version was never tested.
// { ok: true, file } or { ok: false, why, words }.
async function versionToRun(s) {
  const { ctx } = s
  const file = await followToFile(s.claudePath, ctx.realpath ?? realpath)
  if (file === null) return { ok: false, why: 'claude-missing', words: 'The Claude Code program could not be found, so no job was started.' }
  const version = await versionOfFile(file, { exec: ctx.exec, emptyDir: s.emptyCwd, env: ctx.env, platform: ctx.platform })
  if (version === null) return { ok: false, why: 'selftest-needed', words: 'Claude Code did not say which version it is, so it needs a new self-test.' }
  const proof = await proofHolds({ stateDir: ctx.places.stateDir, codeDir: ctx.places.codeDir, version, file })
  return proof.holds ? { ok: true, file } : { ok: false, why: 'selftest-needed', words: `Claude Code ${version.join('.')} is not the version the self-test passed for, so it needs a new self-test.` }
}

async function executeRun(s, { id, action, fields, minutes, startedMs, reset, fail, level }) {
  const { ctx } = s
  const { workDir, stateDir, codeDir } = ctx.places
  const planned = await planRun({ root: workDir, slug: fields.workflow, now: startedMs, timeZone: ctx.timeZone, git: s.git })
  if (!planned.ok) return planned.state === 'refused' ? settle(s, id, action, { state: 'refused', why: planned.why }) : fail('change-refused')
  const { plan } = planned
  const startedAt = isoSeconds(startedMs)

  // The board hears that it has started before Claude does.
  await writeClaimFile(stateDir, id, 'receipt.json', { id, state: 'running', at: startedAt, startedAt, action }, { fs: ctx.fs })
  await syncStatus(s)
  reset = await level()
  if (!reset.ok) return fail('push-failed')

  const claimDir = join(stateDir, CLAIMS_STORE.folder, `${id}.claim`)
  const prompt = await runPrompt(plan, { codeDir })
  // The last thing before Claude starts: which version is it now? Not the one the daily check saw.
  const fit = await versionToRun(s)
  if (!fit.ok) {
    s.log(`mailbox: a run was refused as not ready (${fit.why}): ${fit.words}`)
    return settle(s, id, action, { state: 'refused', why: 'not-ready' })
  }
  // What git reads as configuration, as it is now: compared again when Claude is done, before git is run in this folder (gitguard.mjs).
  const before = await snapshotGit(workDir)
  if (!before.ok) return fail('change-refused')
  const ran = await runClaude({
    file: fit.file,
    argv: buildArgv({ prompt, model: plan.model, codeDir, web: plan.web }),
    cwd: workDir,
    env: claudeEnv(ctx.env, ctx.platform),
    tools: toolsFor(plan.web),
    timeoutMs: minutes * 60_000,
    transcriptPath: join(claimDir, 'transcript.jsonl'),
    stderrPath: join(claimDir, 'stderr.txt'),
    spawn: ctx.spawn,
    kill: ctx.kill,
    platform: ctx.platform,
    live: ctx.live
  })
  // Before anything else, and whether or not the run went well: git must not run in a folder where Claude changed what git reads. The order fails
  // with a fixed reason, the folder is thrown away and made again from the team repo's address the runner wrote itself, and nothing in it is trusted.
  if (!(await gitUnchanged(workDir, before))) {
    s.log('mailbox: a run changed the git settings of the work copy, so the order failed and the work copy was made again')
    await remakeWorkCopy({ git: ctx.git, work: workDir, emptyHooks: s.hooks, before })
    return fail('change-refused')
  }
  if (!ran.ok) return fail(ran.why)

  const checked = await checkChanges({ root: workDir, git: s.git, action, fields, plan })
  if (!checked.ok) return fail(checked.why)
  await finishRunLogs({ root: workDir, paths: checked.logs, finishedAt: ctx.now() })
  const again = await checkChanges({ root: workDir, git: s.git, action, fields, plan })
  if (!again.ok) return fail(again.why)

  // What goes back: each changed file's final text, and for a changed one the text it was changed from, so that after a
  // race the change is put back only where nobody else has touched.
  const saved = []
  for (const file of again.files) {
    const now = await readRepoFile(workDir, file.path, s.git)
    const was = file.status === 'modified' ? (await s.git(['show', `HEAD:${file.path}`], workDir)).stdout : null
    if (now.state !== 'ok') return fail('change-refused')
    saved.push({ ...file, text: now.text, was })
  }
  const redo = async () => {
    for (const file of saved) {
      const current = await readRepoFile(workDir, file.path, s.git)
      const untouched = file.status === 'modified' ? current.state === 'ok' && current.text === file.was : current.state === 'missing'
      if (!untouched) return { ok: false, state: 'failed', why: 'push-failed' }
    }
    for (const file of saved) {
      await mkdir(join(workDir, ...file.path.split('/').slice(0, -1)), { recursive: true })
      await writeFile(join(workDir, ...file.path.split('/')), file.text)
    }
    const rechecked = await checkChanges({ root: workDir, git: s.git, action, fields, plan })
    return rechecked.ok ? { ok: true, files: rechecked.files.map((file) => file.path) } : { ok: false, state: 'failed', why: rechecked.why }
  }
  return publish(s, { id, action, head: reset.head, files: again.files.map((file) => file.path), redo, level, fail, startedAt })
}

/* ---------- putting a change back ----------------------------------------------------------------------------------- */

// Commit the files and the status file in one commit with the order's trailer, and push it with a lease. If the team repo
// moved, bring the clone level, put the change back and try again - three times at most. Then the order is done.
async function publish(s, o) {
  const { ctx } = s
  const { workDir } = ctx.places
  const statusPath = mailboxPath(s.allow.runner)
  for (let attempt = 1; attempt <= MOST_PUSH_ATTEMPTS; attempt += 1) {
    await writeMailboxStatus({ root: workDir, doc: await statusDoc(s), identity: ctx.identity, git: s.git })
    const commit = await commitPaths({
      git: ctx.git,
      work: workDir,
      emptyHooks: s.hooks,
      paths: o.files,
      maybe: [statusPath],
      message: `Mailbox order ${o.id.slice(0, 8)}: ${o.action}`,
      trailer: `Mailbox-Order: ${o.id}`
    })
    const pushed = await pushCommits({ git: ctx.git, work: workDir, emptyHooks: s.hooks, commit, expected: o.head, count: 1 })
    if (pushed.ok) return settleLanded(s, o, commit)
    // The team repo could not be asked whether the push landed after git said it failed. It may have: a dropped connection or
    // git's own time limit can come after the server moved main. Doing the order again could apply it twice, so it is neither
    // failed (which invites a resend) nor redone: it is left as outcome unknown, and a later tick settles it by reading.
    // Neither "the team repo cannot be asked" nor "main is still where it was" proves the push did not land: git may have been killed by its time
    // limit while the server was still applying it. So both are outcome unknown (the claim says so durably first), and the clone is brought level
    // before anything else is done in it.
    if (pushed.why === 'unreachable' || pushed.why === 'unsure') {
      await settle(s, o.id, o.action, { state: 'unknown', startedAt: o.startedAt })
      await o.level()
      return
    }
    if (pushed.why !== 'moved') break
    // Before anything is done a second time, ask the team repo whether this very order is already on main.
    const there = await landedCommit({ git: ctx.git, work: workDir, emptyHooks: s.hooks, id: o.id })
    if (there.state === 'found') return settleLanded(s, o, there.commit)
    if (there.state === 'unknown') return settle(s, o.id, o.action, { state: 'unknown', startedAt: o.startedAt })
    if (attempt === MOST_PUSH_ATTEMPTS) break
    const reset = await o.level()
    if (!reset.ok) break
    o.head = reset.head
    const redone = await o.redo()
    if (!redone.ok) return settle(s, o.id, o.action, { state: redone.state, why: redone.why, startedAt: o.startedAt })
    o.files = redone.files
  }
  // Nothing of it left this Mac. The clone is brought level again before anything else is done in it, and Claude is not run again.
  await o.fail('push-failed')
}

// The order is on main: say so, with the hashes of the files as they are in the work copy (which is where the commit was made).
async function settleLanded(s, o, commit) {
  const { workDir } = s.ctx.places
  const files = []
  for (const path of [...o.files, mailboxPath(s.allow.runner)]) {
    const read = await readRepoFile(workDir, path, s.git)
    files.push({ path, sha256: sha256(read.text ?? '') })
  }
  await settle(s, o.id, o.action, { state: 'ok', commit: commit.slice(0, 12), startedAt: o.startedAt, files })
}

/* ---------- the status file ----------------------------------------------------------------------------------------- */

async function statusDoc(s) {
  const { ctx, allow } = s
  const takenAt = ctx.now()
  return buildMailbox({
    computer: allow.computer,
    runner: allow.runner,
    takenAt,
    allows: { actions: allow.actions, jobs: s.runnable },
    orders: await ordersFromClaims({ stateDir: ctx.places.stateDir, takenAt, fs: ctx.fs })
  })
}

const withoutTime = (doc) => JSON.stringify({ ...doc, takenAt: null })

// Bring the status file in the team repo level with the claims: pushed when it differs from what is there, and once in a
// while when it does not - so the board can tell a runner that is idle from one that is gone. Best effort: if the team
// repo cannot be reached the next tick does it.
async function syncStatus(s) {
  const { ctx } = s
  const { workDir } = ctx.places
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const reset = await resetWorkCopy({ git: ctx.git, work: workDir, emptyHooks: s.hooks, originAccepted: s.originAccepted })
    if (!reset.ok) return
    const doc = await statusDoc(s)
    const existing = await readMailboxStatus({ root: workDir, runner: s.allow.runner, identity: ctx.identity })
    if (existing && withoutTime(existing) === withoutTime(doc) && ctx.now() - Date.parse(existing.takenAt) < STATUS_REFRESH_MS) return
    await writeMailboxStatus({ root: workDir, doc, identity: ctx.identity, git: s.git })
    const commit = await commitPaths({ git: ctx.git, work: workDir, emptyHooks: s.hooks, paths: [mailboxPath(s.allow.runner)], message: 'Mailbox status' })
    const pushed = await pushCommits({ git: ctx.git, work: workDir, emptyHooks: s.hooks, commit, expected: reset.head, count: 1 })
    if (pushed.ok || pushed.why !== 'moved') return
  }
}
