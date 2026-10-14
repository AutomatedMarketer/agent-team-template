// The work copy: the Mac's own clone of the team repo, which the runner changes and pushes from.
//
// Other people and cloud routines push to that repo, and Claude writes into the clone during a run, so nothing in the
// clone is trusted. Before every order it is brought level with the team repo's main and everything else is thrown away:
// changes, untracked files, ignored files, commits that were never pushed. Its .git/config is written again from scratch
// before git is first run in it, so a setting planted there (an alias, a filter, a push address, a program to run for
// the file monitor or the pager) never gets a chance to act. And git runs with its hooks switched off and a few settings
// fixed on every command, whatever the clone says.
//
// Changes go back by a push that names its commit and its branch, carries a lease on the commit the clone was based on,
// and sends nothing else - no tags, no other branch, no submodule. Git's messages are never passed on: they can carry the
// remote address, and an address can carry a token.

import { readFile, lstat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const BRANCH = 'main'
const AUTHOR_NAME = 'Agent mailbox'
const AUTHOR_EMAIL = 'agent-mailbox@users.noreply.github.com'
const FULL_HASH = /^[0-9a-f]{40,64}$/
const ORDER_ID = /^[0-9a-f]{32}$/
const REPO_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/
const TRAILER = /^[A-Za-z][A-Za-z-]*: \S[^\n]*$/

/* ---------- git as the runner runs it ------------------------------------------------------------------------------ */

// Settings given to every git command. They beat anything in the clone's config, the user's config and the system's.
export const PINS = (emptyHooks) => [
  `core.hooksPath=${emptyHooks}`,
  'core.fsmonitor=false',
  'core.untrackedCache=false',
  // Files are checked out and committed as they are stored: a Windows setting must not change a card's bytes.
  'core.autocrlf=false',
  'core.safecrlf=false',
  'core.editor=true',
  'core.pager=cat',
  'diff.external=',
  'commit.gpgsign=false',
  'tag.gpgsign=false',
  'gc.auto=0',
  'maintenance.auto=false',
  'advice.detachedHead=false'
]

export const pinnedGit = (git, emptyHooks) => (args, cwd) => git([...PINS(emptyHooks).flatMap((pin) => ['-c', pin]), ...args], cwd)

/* ---------- the config the clone is given -------------------------------------------------------------------------- */

const oneLine = (value) => typeof value === 'string' && value !== '' && !/[\r\n]/.test(value)

// A value as git's config file spells it: plain when it can be, in quotes with the backslash and the quote escaped when it
// has a character that means something in that file (a Windows path has backslashes).
const configValue = (value) => (/[\\"\s;#]/.test(value) ? `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : value)
const readConfigValue = (raw) => (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1).replace(/\\(["\\])/g, '$1') : raw)

// The whole of .git/config: where the clone came from and which branch follows what, and nothing else.
export function configText({ url, emptyHooks }) {
  if (!oneLine(url) || !oneLine(emptyHooks)) throw new TypeError('workcopy: an address and a hooks folder are one line each')
  return [
    '[core]',
    '\trepositoryformatversion = 0',
    '\tfilemode = true',
    '\tbare = false',
    '\tlogallrefupdates = true',
    `\thooksPath = ${configValue(emptyHooks)}`,
    '[remote "origin"]',
    `\turl = ${configValue(url)}`,
    '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    `[branch "${BRANCH}"]`,
    '\tremote = origin',
    `\tmerge = refs/heads/${BRANCH}`,
    ''
  ].join('\n')
}

// The clone's origin address as its config file says it - read as text, not by running git (a config can name a program
// to run). Exactly one origin section with exactly one address, or null.
export async function originUrl(work) {
  return (await originFacts(work))?.url ?? null
}

// Where fetches and pushes of the clone go, as its config file says: { fetch, push } - push being the push address if
// there is one and the fetch address if not - or null when the config cannot be read, has no origin, or has two.
export async function readOrigin(work) {
  const facts = await originFacts(work)
  return facts === null || facts.url === null || facts.pushUrls.length > 1 ? null : { fetch: facts.url, push: facts.pushUrls[0] ?? facts.url }
}

async function originFacts(work) {
  let text
  try {
    text = await readFile(join(work, '.git', 'config'), 'utf8')
  } catch {
    return null
  }
  const urls = []
  const pushUrls = []
  let inOrigin = false
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[(.*)\]\s*$/.exec(line)
    if (section) {
      inOrigin = /^remote\s+"origin"$/.test(section[1].trim())
      continue
    }
    if (!inOrigin) continue
    const url = /^\s*url\s*=\s*(\S.*?)\s*$/i.exec(line)
    const push = /^\s*pushurl\s*=\s*(\S.*?)\s*$/i.exec(line)
    if (url) urls.push(readConfigValue(url[1]))
    if (push) pushUrls.push(readConfigValue(push[1]))
  }
  return { url: urls.length === 1 ? urls[0] : null, pushUrls }
}

/* ---------- bringing the clone level ------------------------------------------------------------------------------- */

// { ok: true, head } with the team repo's main as the clone now has it, or { ok: false, why }:
//   not-a-clone       the folder is not a git clone of its own
//   origin-mismatch   its origin is not the team repo (originAccepted says what that is); nothing was changed
//   unreachable       the team repo could not be fetched
export async function resetWorkCopy({ git, work, emptyHooks, originAccepted }) {
  try {
    if (!(await lstat(join(work, '.git'))).isDirectory()) return { ok: false, why: 'not-a-clone' }
  } catch {
    return { ok: false, why: 'not-a-clone' }
  }
  const url = await originUrl(work)
  if (url === null || !originAccepted(url)) return { ok: false, why: url === null ? 'not-a-clone' : 'origin-mismatch' }
  await writeFile(join(work, '.git', 'config'), configText({ url, emptyHooks }))
  const run = pinnedGit(git, emptyHooks)
  try {
    await run(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', 'origin', BRANCH], work)
  } catch {
    return { ok: false, why: 'unreachable' }
  }
  await run(['checkout', '--quiet', '--force', '-B', BRANCH, `refs/remotes/origin/${BRANCH}`], work)
  await run(['clean', '--quiet', '-ffdx'], work)
  return { ok: true, head: (await run(['rev-parse', 'HEAD'], work)).stdout.trim() }
}

/* ---------- committing and pushing --------------------------------------------------------------------------------- */

// The named paths and nothing else, in one commit by the runner. Anything already staged is refused, not carried along (it
// would show among the staged files after the add, and the staged files must be exactly the named ones).
// Returns the commit's full hash.
// `paths` must all be in the commit. `maybe` are paths that go in only if they changed (the status file, which already
// says what a run's change commit would say when the board was told the run had started).
export async function commitPaths({ git, work, emptyHooks, paths, maybe = [], message, trailer }) {
  const plain = (list) => Array.isArray(list) && list.every((path) => typeof path === 'string' && !path.startsWith('-') && REPO_PATH.test(path) && !path.split('/').includes('..'))
  if (!plain(paths) || !plain(maybe) || (paths.length === 0 && maybe.length === 0)) throw new TypeError('workcopy: the paths are plain repo paths')
  if (typeof message !== 'string' || !message.trim()) throw new TypeError('workcopy: a commit has a message')
  if (trailer !== undefined && (typeof trailer !== 'string' || !TRAILER.test(trailer))) throw new TypeError('workcopy: a trailer is one "Name: value" line')
  const run = pinnedGit(git, emptyHooks)
  const staged = async () => (await run(['diff', '--cached', '--name-only', '-z'], work)).stdout.split('\0').filter(Boolean)
  await run(['add', '--', ...paths, ...maybe], work)
  const added = await staged()
  if (added.length === 0) throw new Error('workcopy: nothing to commit')
  if (!paths.every((path) => added.includes(path)) || !added.every((path) => paths.includes(path) || maybe.includes(path))) throw new Error('workcopy: what is staged is not the named paths')
  const full = trailer === undefined ? message : `${message}\n\n${trailer}`
  await run(['-c', `user.name=${AUTHOR_NAME}`, '-c', `user.email=${AUTHOR_EMAIL}`, 'commit', '--quiet', '--no-verify', '-m', full], work)
  return (await run(['rev-parse', 'HEAD'], work)).stdout.trim()
}

// Push `commit` (one commit or two on top of `expected`, the commit the clone was based on) to main, and only if main is
// still exactly `expected`. { ok: true } or { ok: false, why }:
//   not-the-commits   what is to go is not exactly `count` commits on top of `expected`: nothing was sent
//   moved             the team repo's main is no longer `expected`, and `commit` is not in it: someone else pushed
//   unreachable       the team repo could not be reached to say whether the push landed - the push may have, so the
//                     caller must treat the outcome as unknown, never as "nothing was sent"
//   unsure            git reported a failure and main is still `expected` - but that does not say the push was refused: git may have been
//                     killed (its 120 s limit) while the server was still applying it, and main moves a moment later. The caller must treat the
//                     outcome as unknown, never as "nothing was sent". (A server that really refuses - branch protection, push protection - reads
//                     the same: unknown now, and "not landed" when the next tick reads the team repo. That is true, and it is all that is known.)
// { ok: true, landed: true } is a push that reported a failure (git's own 120 s limit, or a connection dropped after the
// server had already moved main) and yet is on main: `commit` is the team repo's tip or an ancestor of it. It is a success,
// because doing the work again would apply it twice.
export async function pushCommits({ git, work, emptyHooks, commit, expected, count }) {
  if (typeof commit !== 'string' || !FULL_HASH.test(commit) || typeof expected !== 'string' || !FULL_HASH.test(expected)) throw new TypeError('workcopy: a push names full commits')
  if (count !== 1 && count !== 2) throw new TypeError('workcopy: a push is one commit or two')
  const run = pinnedGit(git, emptyHooks)
  try {
    await run(['merge-base', '--is-ancestor', expected, commit], work)
    const ahead = Number((await run(['rev-list', '--count', `${expected}..${commit}`], work)).stdout.trim())
    if (ahead !== count) return { ok: false, why: 'not-the-commits' }
  } catch {
    return { ok: false, why: 'not-the-commits' }
  }
  try {
    await run([
      'push', '--quiet',
      // Global push.followTags / push.recurseSubmodules would add tags or a submodule's commits to this push.
      '--no-follow-tags', '--recurse-submodules=no',
      `--force-with-lease=refs/heads/${BRANCH}:${expected}`,
      'origin', `${commit}:refs/heads/${BRANCH}`
    ], work)
    return { ok: true }
  } catch {
    // A failed report is not a failed push: the server may have taken the commit and the answer been lost. So first ask the
    // team repo itself where main is, then whether our commit is in it. Asked of the team repo, not of this clone.
    let tip
    try {
      tip = (await run(['ls-remote', 'origin', `refs/heads/${BRANCH}`], work)).stdout.split('\t')[0].trim()
    } catch {
      return { ok: false, why: 'unreachable' }
    }
    if (tip === expected) return { ok: false, why: 'unsure' }
    try {
      await run(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', 'origin', BRANCH], work)
    } catch {
      return { ok: false, why: 'unreachable' }
    }
    try {
      await run(['merge-base', '--is-ancestor', commit, `refs/remotes/origin/${BRANCH}`], work)
      return { ok: true, landed: true }
    } catch {
      return { ok: false, why: 'moved' }
    }
  }
}

// Whether an order's change is on the team repo's main: the commit with its trailer on a line of its own.
//   { state: 'found', commit } | { state: 'not-found' } | { state: 'unknown' }  (the team repo could not be fetched)
// Read only: nothing is changed here but what the clone knows of the team repo.
export async function landedCommit({ git, work, emptyHooks, id }) {
  if (typeof id !== 'string' || !ORDER_ID.test(id)) throw new TypeError('workcopy: an order id is 32 hex characters')
  const run = pinnedGit(git, emptyHooks)
  try {
    await run(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', 'origin', BRANCH], work)
  } catch {
    return { state: 'unknown' }
  }
  const found = (await run(['log', '-n', '1', '--format=%H', `--grep=^Mailbox-Order: ${id}$`, `refs/remotes/origin/${BRANCH}`], work)).stdout.trim()
  return found ? { state: 'found', commit: found } : { state: 'not-found' }
}
