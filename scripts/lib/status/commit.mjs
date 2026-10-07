// Commit mode: getting the snapshot into the repo the dashboard reads, unattended.
//
// Two places it can commit from, and they are treated differently on purpose:
//   - a person's own working copy: commit only the snapshot file, whatever else is staged, and if
//     the push is refused, stop and say so. Nothing of theirs is ever reset.
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

export function claimStamp(now) {
  // Colons are not allowed in Windows file names.
  return isoSeconds(now).replaceAll(':', '-')
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

// The claim is made before anything else happens, and its name is the occurrence's time. If it
// already exists this occurrence has been run, whatever the outcome was, and is not run again.
export async function openClaim(stateDir, now) {
  const claims = join(stateDir, 'claims')
  await mkdir(claims, { recursive: true })
  const claim = join(claims, `${claimStamp(now)}.claim`)
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
  await git(['fetch', '--quiet'], cloneDir)
  await git(['reset', '--hard', '--quiet', '@{u}'], cloneDir)
  return null
}

// mode: 'working-copy' | 'clone'. rewrite() puts the snapshot file back after a reset.
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

  let commit = await commitOwnFile()
  if (!commit) return { outcome: 'nothing to commit' }
  if (await succeeds(['push', '--quiet'])) return { outcome: 'pushed', commit }
  if (mode !== 'clone') return { outcome: 'committed, push refused', commit }

  // The dedicated clone holds nothing but snapshots, so catching up is always safe: the newer
  // snapshot is rewritten on top and pushed once more. Once - a second refusal waits for the next run.
  await run(['fetch', '--quiet'])
  await run(['reset', '--hard', '--quiet', '@{u}'])
  await rewrite()
  commit = await commitOwnFile()
  if (!commit) return { outcome: 'nothing to commit' }
  if (await succeeds(['push', '--quiet'])) return { outcome: 'retried and pushed', commit }
  return { outcome: 'committed, push refused', commit }
}
