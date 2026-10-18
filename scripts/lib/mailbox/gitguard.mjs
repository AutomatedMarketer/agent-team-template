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
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { BRANCH, addressHasLogin, configText, originUrl, pinnedGit } from './workcopy.mjs'

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
// .git/config before Claude started (never the one in the folder now). No git command is run in the old folder: in one step it is moved
// aside (so it stops being the work copy at once), then deleted, and git first runs in a fresh, empty folder. { ok: true } or { ok: false }.
// When it is false:
//   - if git could not even be started in the fresh folder (or the address is not usable), no folder is left, and the next tick says
//     "not a clone" until the owner makes one (the guide's step 3, "The work copy");
//   - if the fresh folder was made and given the runner's config but the team repo could not be fetched or checked out, that folder is
//     kept: it holds nothing but what the runner wrote, and the next tick's reset (resetWorkCopy) fetches into it and heals it.
//
// How it is made: an empty repo (git init), its config written as a file - the very text resetWorkCopy writes before every order - then
// a fetch and a checkout of `origin` by name, as every tick does. What comes out is what a clone gave: main, at the team repo's main,
// everything checked out, with the same credential helper or SSH key a clone would use. This does NOT keep a login in the address
// private: git hands the whole address to the program that talks to the server (git-remote-https) on its command line on every fetch
// and push, however the address was given to git. So an address with a password or a token in it is refused before anything runs
// (addressHasLogin, here and in resetWorkCopy and the daily check), and the login stays with git's sign-in helper.
//
// init is told the formats (sha1 objects, files for refs) so a computer whose git makes sha256 or reftable repos by default still gets
// a copy that can fetch the team repo. They are -c settings, not --object-format/--ref-format switches: an older git ignores a setting it
// does not know, where a switch it does not know (--ref-format before git 2.45) is an error.
const INIT_FORMATS = ['-c', 'init.defaultObjectFormat=sha1', '-c', 'init.defaultRefFormat=files']
// Files that would send git to another folder's settings (commondir) or add settings of their own (config.worktree). The fresh repo has
// neither unless something put them there (an init template, say): then no git is run in it.
const ELSEWHERE = ['commondir', 'config.worktree']

export async function remakeWorkCopy({ git, work, emptyHooks, before }) {
  const run = pinnedGit(git, emptyHooks)
  const aside = join(dirname(work), `.${basename(work)}.old-${randomBytes(6).toString('hex')}`)
  let made = false
  try {
    await rename(work, aside).catch((error) => {
      if (error?.code !== 'ENOENT') throw error
    })
    // The old folder is no longer the work copy whatever happens here; a part that cannot be deleted now is left beside it, never used.
    await rm(aside, { recursive: true, force: true }).catch(() => {})
    if (typeof before?.address !== 'string' || before.address === '' || addressHasLogin(before.address)) return { ok: false }
    const config = configText({ url: before.address, emptyHooks })
    await mkdir(work, { recursive: true })
    await run([...INIT_FORMATS, 'init', '--quiet'], work)
    await writeFile(join(work, '.git', 'config'), config)
    for (const name of ELSEWHERE) {
      if (await lstat(join(work, '.git', name)).then(() => true, () => false)) throw new Error(`gitguard: a ${name} is in the fresh .git`)
    }
    made = true
    await run(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', 'origin', BRANCH], work)
    await run(['checkout', '--quiet', '--force', '-B', BRANCH, `refs/remotes/origin/${BRANCH}`], work)
    return { ok: true }
  } catch {
    // Before the runner's config was in place (or the old folder could not be moved), nothing is kept: the folder is removed.
    if (!made) await rm(work, { recursive: true, force: true }).catch(() => {})
    return { ok: false }
  }
}
