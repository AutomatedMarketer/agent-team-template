// Commit mode: getting the snapshot into the repo the dashboard reads, unattended.
//
// Two places it can commit from, and they are treated differently on purpose:
//   - a person's own working copy: commit only the snapshot file, whatever else is staged. Push
//     only when that push would carry the snapshot alone to the default branch; otherwise, or if
//     the push is refused, stop and say so. Nothing of theirs is ever reset or pushed.
//   - the collector's dedicated clone (--clone): a folder nobody works in. It is brought level
//     with the remote before writing, and a refused push is fetched, reset, rewritten and retried
//     once. A folder with anybody else's changes in it is refused as "not a dedicated clone".
//     It holds data only: the code that runs is a separate checkout, pinned by hand.
//
// Nothing git prints is ever passed on: git messages can carry the remote address, and a remote
// address can carry a token.

import { mkdir, rm, stat, realpath, writeFile } from 'node:fs/promises'
import { resolve, join, dirname, basename, relative, isAbsolute } from 'node:path'
import { isoSeconds } from './util.mjs'

export const LOCK_STALE_MS = 3600_000

// Every collector commit starts with this, which is how a dedicated clone tells its own unpushed
// commits from anybody else's.
export const SNAPSHOT_SUBJECT = 'Usage snapshot from '

// A run by hand is named after its own second: a person asking twice wants two readings.
export function claimStamp(now) {
  // Colons are not allowed in Windows file names.
  return isoSeconds(now).replaceAll(':', '-')
}

// The schedule runs every three hours, New York time. A scheduled run is named after the slot it
// belongs to - the New York date and the hour the slot starts - so a run on waking and a manual
// kickstart in the same slot find the same claim, and only the first one runs. On the night the
// clocks go back the 00:00 slot is four hours long; on the night they go forward it is two.
export const SCHEDULE_ZONE = 'America/New_York'
export const SLOT_HOURS = 3

const slotParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: SCHEDULE_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23'
})

export function slotStamp(now) {
  const parts = Object.fromEntries(slotParts.formatToParts(new Date(now)).map((part) => [part.type, part.value]))
  const start = Math.floor(Number(parts.hour) / SLOT_HOURS) * SLOT_HOURS
  return `${parts.year}-${parts.month}-${parts.day}T${String(start).padStart(2, '0')}-00-new-york`
}

// One run at a time. The lock is a folder because making a folder either succeeds or fails in one
// step on every system. A lock older than an hour is from a run that crashed, and is taken over.
export async function takeLock(stateDir, now) {
  const lock = join(stateDir, 'lock')
  await mkdir(stateDir, { recursive: true })
  try {
    await mkdir(lock)
    return lock
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  let age = 0
  try {
    age = now - (await stat(lock)).mtimeMs
  } catch {
    age = 0
  }
  if (age <= LOCK_STALE_MS) return null
  await rm(lock, { recursive: true, force: true })
  try {
    await mkdir(lock)
    return lock
  } catch {
    return null
  }
}

export async function releaseLock(lock) {
  if (lock) await rm(lock, { recursive: true, force: true })
}

// The claim is made before anything else happens, and its name is the occurrence (a slot or a
// second, above). If it already exists this occurrence has been run, whatever the outcome was,
// and is not run again.
export async function openClaim(stateDir, name) {
  const claims = join(stateDir, 'claims')
  await mkdir(claims, { recursive: true })
  const claim = join(claims, `${name}.claim`)
  try {
    await mkdir(claim)
    return claim
  } catch (error) {
    if (error?.code === 'EEXIST') return null
    throw error
  }
}

export async function writeRecord(claim, name, record) {
  await writeFile(join(claim, name), `${JSON.stringify(record, null, 2)}\n`)
}

async function sameFolder(a, b) {
  try {
    const [left, right] = await Promise.all([realpath(resolve(a)), realpath(resolve(b))])
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
  } catch {
    return false
  }
}

// The real path of a folder, following links. A path that does not exist yet is resolved as far
// as it does exist, with the rest added back on.
async function realFolder(path) {
  const full = resolve(path)
  try {
    return await realpath(full)
  } catch {
    const parent = dirname(full)
    return parent === full ? full : join(await realFolder(parent), basename(full))
  }
}

// True when `inner` is `outer` or anywhere inside it, after following links. Case is ignored on
// Windows and macOS, whose usual file systems ignore it too - "same folder" is the safe answer.
export async function isInsideFolder(inner, outer) {
  let [child, parent] = await Promise.all([realFolder(inner), realFolder(outer)])
  if (process.platform === 'win32' || process.platform === 'darwin') {
    child = child.toLowerCase()
    parent = parent.toLowerCase()
  }
  const between = relative(parent, child)
  return between === '' || (!between.startsWith('..') && !isAbsolute(between))
}

// Returns null when the folder is fit to be used, or a short reason when it is not. The
// collector's own code never lives in this folder (run.mjs refuses that before it gets here):
// this folder is reset to whatever the remote holds, and the remote is not who chooses the code.
export async function prepareClone({ git, cloneDir, relativePath }) {
  let top
  try {
    top = (await git(['rev-parse', '--show-toplevel'], cloneDir)).stdout.trim()
  } catch {
    return 'it is not a git clone'
  }
  if (!(await sameFolder(top, cloneDir))) return 'it is a folder inside a clone, not the clone itself'
  const status = (await git(['status', '--porcelain', '--untracked-files=all'], cloneDir)).stdout
  const others = status.split('\n').filter((line) => line.trim() && line.slice(3).trim() !== relativePath)
  if (others.length) return 'it has changes in it that the collector did not make'
  // A clean folder can still hold somebody's work in commits never pushed. Resetting would lose
  // them, so only the collector's own unpushed snapshots are allowed to be there.
  let ahead
  try {
    ahead = (await git(['log', '@{u}..HEAD', '--format=%s'], cloneDir)).stdout
  } catch {
    return 'it has no remote branch to follow'
  }
  if (ahead.split('\n').some((subject) => subject.trim() && !subject.startsWith(SNAPSHOT_SUBJECT))) {
    return 'it has unpushed commits the collector did not make'
  }
  try {
    await git(['fetch', '--quiet'], cloneDir)
  } catch {
    // Git's own message is dropped: it names the remote address, which can carry a token.
    throw new RemoteUnreachable()
  }
  await git(['reset', '--hard', '--quiet', '@{u}'], cloneDir)
  return null
}

// The folder is fine; the team repo could not be reached (network, remote gone, key revoked).
// That is a failed run, not a reason to call the folder somebody else's.
export class RemoteUnreachable extends Error {
  constructor() {
    super('the team repo could not be reached')
    this.name = 'RemoteUnreachable'
  }
}

// The branch the remote calls its default (the one the dashboard reads), or main if it never said.
async function defaultBranch(run) {
  try {
    const ref = (await run(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).stdout.trim()
    const name = ref.replace(/^refs\/remotes\/origin\//, '')
    if (name && name !== ref) return name
  } catch {
    // No origin/HEAD recorded in this copy.
  }
  return 'main'
}

async function currentBranch(run) {
  try {
    return (await run(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() || null
  } catch {
    return null
  }
}

// What this copy last saw on origin's <target>, as a commit id, or null if it never fetched it.
async function lastSeenOnOrigin(run, target) {
  try {
    return (await run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${target}^{commit}`])).stdout.trim() || null
  } catch {
    return null
  }
}

async function isAncestor(run, older, newer) {
  try {
    await run(['merge-base', '--is-ancestor', older, newer])
    return true
  } catch {
    return false
  }
}

async function commitsBetween(run, older, newer) {
  try {
    const count = Number((await run(['rev-list', '--count', `${older}..${newer}`])).stdout.trim())
    return Number.isSafeInteger(count) ? count : null
  } catch {
    return null
  }
}

const OTHER_WORK = (target) => `this copy has other commits that are not on origin's ${target} yet, and a push would send them too`
const BEHIND = (target) => `this copy is behind origin's ${target}; pull, then take the snapshot again`
const MOVED = 'the team repo has changed since this copy last fetched it, or pushes from here go to a different repo; fetch or pull, then take the snapshot again'

// Whether `commit` is exactly one commit on top of `expected`: a fast-forward that carries the
// snapshot and nothing else. Returns null when it is, or the reason it is not.
async function onlyTheSnapshot(run, target, expected, commit) {
  if (!(await isAncestor(run, expected, commit))) return BEHIND(target)
  if ((await commitsBetween(run, expected, commit)) !== 1) return OTHER_WORK(target)
  return null
}

// In a person's own copy a push is only safe when it carries the snapshot alone, to the branch
// the dashboard reads. Checked BEFORE the snapshot is committed, and again on the snapshot's own
// commit just before the push. Returns the branch to push to, or a plain reason not to push.
// The person's own branch name is never repeated: it could be anything, including their name.
async function workingCopyPushTarget(run) {
  let remotes = []
  try {
    remotes = (await run(['remote'])).stdout.split('\n').map((name) => name.trim())
  } catch {
    remotes = []
  }
  if (!remotes.includes('origin')) {
    return { why: 'this copy has no remote called origin, so there is no team repo to push to' }
  }
  const target = await defaultBranch(run)
  const branch = await currentBranch(run)
  if (!branch) return { why: 'this copy is not on a branch' }
  if (branch !== target) return { why: `you are not on ${target}, the branch the dashboard reads` }
  const expected = await lastSeenOnOrigin(run, target)
  if (!expected) return { why: `this copy has never fetched origin's ${target}, so it cannot tell what a push would send` }
  if (!(await isAncestor(run, expected, 'HEAD'))) return { why: BEHIND(target) }
  if ((await commitsBetween(run, expected, 'HEAD')) !== 0) return { why: OTHER_WORK(target) }
  return { branch: target }
}

// mode: 'working-copy' | 'clone'. rewrite() puts the snapshot file back after a reset.
//
// Every check above is made against what this copy last fetched from origin, but the push goes to
// the real remote - which may have moved since (a commit taken off with a force push), or may be
// a different repo altogether (remote.origin.pushurl, url.<x>.pushInsteadOf). So every push:
//   - names the exact commit and branch, never HEAD and never a bare `git push`;
//   - is a fast-forward of exactly one commit on top of what was checked (`expected`);
//   - carries a lease on `expected`, so it lands only if the remote's branch is still exactly
//     that commit. A lease is a force push in git's terms, which is why the fast-forward check
//     comes first: together they mean "add this one commit, or do nothing".
export async function commitAndPush({ git, dir, relativePath, message, mode, rewrite }) {
  const run = (args) => git(args, dir)
  const succeeds = async (args) => {
    try {
      await run(args)
      return true
    } catch {
      return false
    }
  }
  const commitOwnFile = async () => {
    await run(['add', '--', relativePath])
    if (await succeeds(['diff', '--cached', '--quiet', '--', relativePath])) return null
    // --only with a path commits that path alone; anything else staged stays staged.
    await run(['commit', '--quiet', '--only', '-m', message, '--', relativePath])
    return (await run(['rev-parse', 'HEAD'])).stdout.trim()
  }

  let target
  if (mode === 'clone') {
    // prepareClone has already required a branch that follows the remote.
    const branch = await currentBranch(run)
    if (!branch) throw new Error('the dedicated clone is not on a branch')
    target = { branch }
  } else {
    target = await workingCopyPushTarget(run)
  }

  // Returns 'pushed', or the reason it did not push.
  const pushOnly = async (commit) => {
    const expected = await lastSeenOnOrigin(run, target.branch)
    if (!expected) return `this copy has never fetched origin's ${target.branch}`
    const why = await onlyTheSnapshot(run, target.branch, expected, commit)
    if (why) return why
    const pushed = await succeeds([
      'push',
      '--quiet',
      `--force-with-lease=refs/heads/${target.branch}:${expected}`,
      'origin',
      `${commit}:refs/heads/${target.branch}`
    ])
    return pushed ? 'pushed' : MOVED
  }

  let commit = await commitOwnFile()
  if (!commit) return { outcome: 'nothing to commit' }
  if (target.why) return { outcome: 'committed, not pushed', commit, why: target.why }
  let result = await pushOnly(commit)
  if (result === 'pushed') return { outcome: 'pushed', commit }
  if (mode !== 'clone') return { outcome: 'committed, not pushed', commit, why: result }

  // The dedicated clone holds nothing but snapshots, so catching up is always safe: the newer
  // snapshot is rewritten on top and pushed once more. Once - a second refusal waits for the next run.
  await run(['fetch', '--quiet'])
  await run(['reset', '--hard', '--quiet', '@{u}'])
  await rewrite()
  commit = await commitOwnFile()
  if (!commit) return { outcome: 'nothing to commit' }
  result = await pushOnly(commit)
  if (result === 'pushed') return { outcome: 'retried and pushed', commit }
  return { outcome: 'committed, push refused', commit }
}
