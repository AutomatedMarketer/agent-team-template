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

import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { BRANCH, addressHasLogin, addressProblem, configText, originUrl, pinnedGit, pointsElsewhere } from './workcopy.mjs'

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

// Throw the work copy away and make it again from the team repo, in the same place, with the address the runner itself wrote into
// .git/config before Claude started (never the one in the folder now). No git command is run in the old folder: it is first renamed
// aside (one step, beside it, so on the same disk), then deleted, and git first runs in a fresh, empty folder.
//   { ok: true }               made again.
//   { ok: false, stuck: true } the old folder could not be renamed - on Windows a program whose current folder is inside it (a terminal,
//                              an editor) is enough. Nothing is deleted in place: a delete that stops part way can leave exactly what made
//                              the folder untrusted (a commondir, say) behind. Instead a marker in the state folder (STUCK_FILE) keeps
//                              every tick away from the folder - "not-ready (work-copy-stuck)", no git run in it - until it can be
//                              renamed (unstickWorkCopy); resetWorkCopy also refuses, on its own, a .git that points elsewhere.
//   { ok: false }              if git could not even be started in the fresh folder (or the address is not usable), no folder is left,
//                              and the next tick says "not a clone" until the owner makes one (the guide's step 3, "The work copy"). If the
//                              fresh folder was made and given the runner's config but could not be fetched or checked out, it is kept: it
//                              holds nothing but what the runner wrote, and the next tick's reset fetches into it and heals it.
//
// How it is made: an empty repo (git init), its config written as a file - the very text resetWorkCopy writes before every order - then
// the addresses git will really use are asked of git (addressProblem: a global insteadOf could add a login or point elsewhere), then a
// fetch and a checkout of `origin` by name, as every tick does. What comes out is what a clone gave: main, at the team repo's main,
// everything checked out, with the same credential helper or SSH key a clone would use. This does NOT keep a login in the address
// private: git hands the whole address to the program that talks to the server (git-remote-https) on its command line on every fetch
// and push, however the address was given to git. So an address with a user name, a password or a token in it is refused before
// anything runs (addressHasLogin, here, in resetWorkCopy and in the daily check), and the login stays with git's sign-in helper.
//
// init is told the formats (sha1 objects, files for refs) so a computer whose git makes sha256 or reftable repos by default still gets
// a copy that can fetch the team repo. They are -c settings, not --object-format/--ref-format switches: an older git ignores a setting it
// does not know, where a switch it does not know (--ref-format before git 2.45) is an error. GIT_DEFAULT_HASH and GIT_DEFAULT_REF_FORMAT
// would beat them; the runner's git is never given those (gitEnv).
const INIT_FORMATS = ['-c', 'init.defaultObjectFormat=sha1', '-c', 'init.defaultRefFormat=files']

export const STUCK_FILE = 'work-copy-stuck.json'
const asideName = (work) => `.${basename(work)}.old-${randomBytes(6).toString('hex')}`
const escapeText = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const asidePattern = (work) => new RegExp(`^\\.${escapeText(basename(work))}\\.old-[0-9a-f]{12}$`)

// 'moved' (and the moved folder deleted as far as it goes), 'absent' (there was no folder), or 'stuck' (it could not be renamed).
async function moveAside(work, renameImpl) {
  const aside = join(dirname(work), asideName(work))
  try {
    await renameImpl(work, aside)
  } catch (error) {
    return error?.code === 'ENOENT' ? 'absent' : 'stuck'
  }
  // It is no longer the work copy. A part that cannot be deleted now stays beside it under that name, is never used, and is swept later.
  await rm(aside, { recursive: true, force: true }).catch(() => {})
  return 'moved'
}

// Old folders moved aside and not fully deleted then: removed at the start of each tick. Only the runner's own name pattern, only
// beside the work copy (where moveAside puts them). Each is looked at with lstat: a link or junction is removed as a link, never followed.
export async function sweepAside(work) {
  const pattern = asidePattern(work)
  let names = []
  try {
    names = await readdir(dirname(work))
  } catch {
    return
  }
  for (const name of names.filter((one) => pattern.test(one))) {
    const path = join(dirname(work), name)
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isDirectory()) await unlink(path).catch(() => rmdir(path))
      else await rm(path, { recursive: true, force: true })
    } catch {
      // Tried again at the next tick.
    }
  }
}

export async function workCopyStuck(stateDir) {
  return typeof stateDir === 'string' && (await lstat(join(stateDir, STUCK_FILE)).then(() => true, () => false))
}

// At the start of a tick: { stuck: false } when there is no marker, or when the stuck folder could at last be renamed aside (the marker
// is then removed and the copy made again); { stuck: true } while it still cannot be, and then no git is run in it.
export async function unstickWorkCopy({ git, work, emptyHooks, stateDir, originAccepted, rename: renameImpl = rename }) {
  if (!(await workCopyStuck(stateDir))) return { stuck: false }
  if ((await moveAside(work, renameImpl)) === 'stuck') return { stuck: true }
  let address = null
  try {
    address = JSON.parse(await readFile(join(stateDir, STUCK_FILE), 'utf8'))?.address ?? null
  } catch {
    address = null
  }
  await rm(join(stateDir, STUCK_FILE), { force: true })
  await remakeWorkCopy({ git, work, emptyHooks, before: { ok: true, address }, stateDir, originAccepted, rename: renameImpl })
  return { stuck: false }
}

export async function remakeWorkCopy({ git, work, emptyHooks, before, stateDir, originAccepted, rename: renameImpl = rename }) {
  const run = pinnedGit(git, emptyHooks)
  let made = false
  try {
    if ((await moveAside(work, renameImpl)) === 'stuck') {
      // The runner's own address is kept with the marker, so the copy can be made again once the folder can be moved.
      if (typeof stateDir === 'string') await writeFile(join(stateDir, STUCK_FILE), `${JSON.stringify({ address: typeof before?.address === 'string' ? before.address : null })}\n`)
      return { ok: false, stuck: true }
    }
    if (typeof before?.address !== 'string' || before.address === '' || addressHasLogin(before.address)) return { ok: false }
    const config = configText({ url: before.address, emptyHooks })
    await mkdir(work, { recursive: true })
    await run([...INIT_FORMATS, 'init', '--quiet'], work)
    await writeFile(join(work, '.git', 'config'), config)
    if (await pointsElsewhere(work)) throw new Error('gitguard: the fresh .git points elsewhere')
    made = true
    if ((await addressProblem(run, work, originAccepted)) !== null) return { ok: false }
    await run(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', 'origin', BRANCH], work)
    await run(['checkout', '--quiet', '--force', '-B', BRANCH, `refs/remotes/origin/${BRANCH}`], work)
    return { ok: true }
  } catch {
    // Before the runner's config was in place, nothing is kept: the fresh folder is removed. (The old one is never deleted in place.)
    if (!made) await rm(work, { recursive: true, force: true }).catch(() => {})
    return { ok: false }
  }
}
