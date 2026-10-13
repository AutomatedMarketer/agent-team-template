// Whether Claude changed anything git reads as configuration, while it ran in the work copy.
//
// After Claude exits, the runner runs git in that folder (diff, add, commit, push) as the owner. Claude has the file tools there
// (Edit(/**)), so a setting it planted in .git would be run with the owner's rights: credential.helper, core.sshCommand, an
// url.<x>.insteadOf, a filter driver named in .git/info/attributes, a hook. Today the only thing that stops it is Claude Code's own
// rule that writes to a few paths are never approved without a person, and are DENIED in dontAsk mode: .git is the first on the
// list (https://code.claude.com/docs/en/permission-modes#protected-paths, read 2026-10-13). That is a rule of a program updated
// every few days and not ours, so the runner checks it for itself:
//   - the self-test asks Claude to write inside .git and passes only if that is refused (selftest.mjs, step 10);
//   - a snapshot of everything below that git reads as configuration is taken just before Claude starts and compared just after it
//     returns, BEFORE any git command is run in that folder. Any difference fails the order, no git is run in that copy, and the copy
//     is thrown away and made again from the team repo (remakeWorkCopy).
//
// What git reads, from its documentation (git-config, githooks, gitattributes, gitrepository-layout): config, config.worktree,
// commondir, HEAD, shallow, info/ (attributes, exclude, sparse-checkout), hooks/, objects/info/ (alternates). .git must itself still be a
// folder: a plain file there is a pointer to some other folder (gitdir:).

import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, readlink, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BRANCH, originUrl, pinnedGit } from './workcopy.mjs'

const SINGLE_FILES = ['config', 'config.worktree', 'commondir', 'HEAD', 'shallow']
const FOLDERS = ['info', 'hooks', 'objects/info']

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

// One line per thing: its name, what kind of thing it is, and a hash of what it holds. A thing that is not there has a line too, so
// a file that appears is a difference as much as one that changes.
async function describe(path, relative, lines) {
  let info
  try {
    info = await lstat(path)
  } catch {
    lines.push(`${relative}\tabsent`)
    return
  }
  if (info.isSymbolicLink()) lines.push(`${relative}\tlink\t${sha256(await readlink(path).catch(() => ''))}`)
  else if (info.isDirectory()) {
    lines.push(`${relative}\tfolder`)
    for (const name of (await readdir(path)).sort()) await describe(join(path, name), `${relative}/${name}`, lines)
  } else if (info.isFile()) lines.push(`${relative}\tfile\t${sha256(await readFile(path))}`)
  else lines.push(`${relative}\tother`)
}

// { ok: true, fingerprint, address } or { ok: false }. `address` is the team repo's address as .git/config says it now, which the runner has just
// written itself: where to make the copy again from, if it comes to that.
export async function snapshotGit(work) {
  const git = join(work, '.git')
  try {
    if (!(await lstat(git)).isDirectory()) return { ok: false }
    const lines = []
    for (const name of SINGLE_FILES) await describe(join(git, name), name, lines)
    for (const folder of FOLDERS) await describe(join(git, ...folder.split('/')), folder, lines)
    return { ok: true, fingerprint: sha256(lines.join('\n')), address: await originUrl(work) }
  } catch {
    return { ok: false }
  }
}

// Whether nothing git reads has changed since `before`. Anything that cannot be read now counts as a change.
export async function gitUnchanged(work, before) {
  if (before?.ok !== true) return false
  const now = await snapshotGit(work)
  return now.ok && now.fingerprint === before.fingerprint
}

// Throw the work copy away and clone the team repo again into the same place, with the address the runner itself wrote into .git/config
// before Claude started (never the one in the folder now). No git command is run in the old folder. { ok: true } or { ok: false }; when it
// is false the folder is simply not there, and the next tick says "not a clone" until the owner makes one (the guide's step 4).
export async function remakeWorkCopy({ git, work, emptyHooks, before }) {
  await rm(work, { recursive: true, force: true })
  if (typeof before?.address !== 'string' || before.address === '') return { ok: false }
  try {
    await pinnedGit(git, emptyHooks)(['clone', '--quiet', '--no-tags', '--branch', BRANCH, '--', before.address, work], dirname(work))
    return { ok: true }
  } catch {
    await rm(work, { recursive: true, force: true }).catch(() => {})
    return { ok: false }
  }
}
