// What the runner needs on Windows that a Mac gives it for free. Nothing here runs on a Mac or Linux: every function answers "nothing to do" there,
// and the entry file (scripts/mailbox-runner.mjs) only uses them when the platform is win32.
//
// Two jobs, both from the standing rule "never start a program by bare name with a working folder inside a repo" and from there being no file modes:
//
//   windowsGit       git by its ABSOLUTE path, found once on PATH, never a copy inside the work copy or the runner's own code, started from a folder
//                    nobody else writes to (System32) with `-C <folder>` saying where it works. A bare `git` started with the work copy as its working
//                    folder runs a planted git.exe from that folder first, because Windows looks in the current folder before PATH.
//   privatePlaces    the state folder (claims, allowlist, secrets) made readable by the current user only. A Mac does that with file modes (0600/0700),
//                    which Windows ignores; here it is an access list set with icacls by absolute path from System32, as the board's local/start.mjs does
//                    (agent-cockpit, lockToCurrentUser). It then READS the list back and fails closed: if there is not exactly one entry, nothing runs.

import { resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as realFs from 'node:fs/promises'
import { isInsideFolder } from '../status/commit.mjs'

// The runner's own code folder (the repo this file is in). A git program inside it is never used.
export const RUNNER_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)))

const GIT_TIMEOUT_MS = 120_000
const GIT_MAX_BUFFER = 16 * 1024 * 1024
// Set for every program started here: a program it starts by a bare name is not looked for in the current folder first.
const NO_CURRENT_FOLDER = Object.freeze({ NoDefaultCurrentDirectoryInExePath: '1' })

// Windows spells it SystemRoot, SYSTEMROOT or systemroot depending on who copied the environment.
const systemRootOf = (env) => {
  const key = Object.keys(env ?? {}).find((name) => name.toUpperCase() === 'SYSTEMROOT')
  return key !== undefined && typeof env[key] === 'string' && win32.isAbsolute(env[key]) ? env[key] : null
}
const systemFolder = (env) => (systemRootOf(env) === null ? null : win32.join(systemRootOf(env), 'System32'))

// -> async (args, cwd) -> { stdout, stderr }, the same call shape the runner's other git has.
//   run(file, args, options)     the real promisified execFile, or a fake
//   findAll(name, extra)         findEveryProgram with the machine filled in: { paths }
//   avoid                        folders a git program must not be inside (the runner's code)
export function windowsGit({ run, findAll, env, avoid = [], isInside = isInsideFolder }) {
  let found = null
  const resolveGit = () => (found ??= (async () => {
    const every = (await findAll('git', { knownFolders: [] })).paths
    for (const path of every) {
      let inside = false
      for (const folder of avoid) inside ||= await isInside(path, folder)
      if (!inside) return path
    }
    return null
  })())

  return async (args, cwd) => {
    const neutral = systemFolder(env)
    if (neutral === null) throw new Error('git: SystemRoot is not set')
    const file = await resolveGit()
    if (file === null) throw new Error('git: no git program was found on PATH outside the runner\'s own folders')
    // The work copy is the folder other people push to: a git program in it is theirs, not ours.
    if (typeof cwd === 'string' && (await isInside(file, cwd))) throw new Error('git: the git program is inside the folder it was asked to work in')
    return run(file, cwd === undefined ? args : ['-C', cwd, ...args], {
      cwd: neutral,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...NO_CURRENT_FOLDER }
    })
  }
}

// A Windows account name has none of these. They would end a grant at the wrong place or are not a name. Spaces and round brackets are allowed ("John (Work)"):
// the name goes to icacls as one argument in a list, never through a shell.
const SAFE_NAME = /^[^\\/:*?"<>|,;=+[\]\r\n\x00-\x1f]{1,64}$/

// What icacls prints, one access entry per line (`NAME:(flags)`), the path in front of the first. Counted, not interpreted: a line with `:(` and a flag letter.
export function accessEntries(output) {
  return String(output).split(/\r?\n/).filter((line) => /:\([A-Z]/.test(line))
}

// What icacls prints for a folder and everything in it (/T): one object per file or folder, each starting at a line that begins with a path (a drive letter
// or \\), its entries on that line and on the indented lines after it. A file with an empty list prints "No permissions are set. All users have full control."
// and NO entry - and NO blank line before the next file - so objects are told apart by where a path starts, never by blank lines or by counting entries.
// -> a list with one list of entries per object (an empty one for an empty list). The summary line at the end is not an object.
export function accessObjects(output) {
  const objects = []
  for (const line of String(output).split(/\r?\n/)) {
    if (/^(?:[A-Za-z]:\\|\\\\)/.test(line)) objects.push([])
    if (objects.length > 0 && /:\([A-Z]/.test(line)) objects[objects.length - 1].push(line)
  }
  return objects
}

// How many files and folders are inside a folder, all levels (links are counted and not followed).
async function countInside(fs, folder) {
  let count = 0
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    count += 1
    if (entry.isDirectory()) count += await countInside(fs, win32.join(folder, entry.name))
  }
  return count
}

// Whether one entry line is DOMAIN\user (or just user when there is no domain) and no one else: the text in front of ":(" ends with the name, and what is
// in front of the name is a space (the path ends there on the first line) or nothing. Not a substring: "bob" is not "rob".
function entryIsYou(line, name) {
  const who = line.slice(0, line.indexOf(':(')).toLowerCase()
  if (!who.endsWith(name.toLowerCase())) return false
  const before = who.slice(0, who.length - name.length)
  return before === '' || before.endsWith(' ')
}

// -> async (places) -> { ok: true } | { ok: false, why }
//   exec(file, args, options)    the runner's exec (absolute path only, rejects on a failing exit)
// On a Mac or Linux: { ok: true } and nothing is done (file modes do this there).
//
// The state folder, every file directly inside it, and the secrets file must each have exactly one access entry, the current account's. That is READ first,
// on every tick, and nothing is changed when it already holds. Only when it does not: every access list in the folder is reset to what it inherits
// (/reset /T /C - a file that carries its own list, with inheritance off, is not touched by anything else icacls does), then the folder is cut off from its
// parent and given to this account alone, then it is all read back. Anything but one entry each means nothing runs.
export function privatePlaces({ exec, env, user, domain, platform = process.platform, isInside = isInsideFolder, fs = realFs }) {
  return async (places) => {
    if (platform !== 'win32') return { ok: true }
    // The secrets file is covered by the folder lock only if it is inside the folder.
    if (!(await isInside(places.envFile, places.stateDir))) return { ok: false, why: 'secrets-outside-state' }
    const system = systemFolder(env)
    if (system === null) return { ok: false, why: 'no-system-root' }
    if (typeof user !== 'string' || !SAFE_NAME.test(user)) return { ok: false, why: 'no-user' }
    if (domain !== undefined && domain !== '' && (typeof domain !== 'string' || !SAFE_NAME.test(domain))) return { ok: false, why: 'no-user' }
    const icacls = win32.join(system, 'icacls.exe')
    const options = { cwd: system, env: { SystemRoot: systemRootOf(env), ...NO_CURRENT_FOLDER }, timeout: 15_000 }
    const name = domain ? `${domain}${String.fromCharCode(92)}${user}` : user
    // A name with a letter outside ASCII may come back from the console in another code page, so it cannot be compared; the counts still hold.
    const comparable = /^[\x20-\x7e]+$/.test(name)
    const state = places.stateDir

    // null when every access list is exactly the current account's, otherwise the word for what is wrong. Throws when icacls cannot be asked.
    const look = async () => {
      // The whole tree in one question, and the answer must be about every file and folder in it: one object each, no more and no fewer. A tree with one
      // folder-or-file missing from the answer (icacls could not read it, or two were run together) is not private.
      const objects = accessObjects((await exec(icacls, [state, '/T', '/C'], options)).stdout)
      const lists = [...objects]
      if (objects.length !== 1 + (await countInside(fs, state))) return 'others-have-access'
      // The secrets file is always asked about on its own as well.
      if (await exists(fs, places.envFile)) {
        const own = accessObjects((await exec(icacls, [places.envFile], options)).stdout)
        if (own.length !== 1) return 'others-have-access'
        lists.push(...own)
      }
      for (const entries of lists) {
        if (entries.length !== 1) return 'others-have-access'
        if (comparable && !entryIsYou(entries[0], name)) return 'not-you'
      }
      return null
    }

    try {
      await fs.mkdir(state, { recursive: true })
      let problem = null
      try {
        problem = await look()
      } catch {
        problem = 'unreadable'
      }
      if (problem === null) return { ok: true }
      // /reset /T follows a junction or a link into whatever it points at and changes THAT folder's access lists. So before anything is changed the whole
      // tree is walked without following anything, and a single link, junction or the folder itself being one means nothing is touched at all.
      if (await hasLink(fs, state)) return { ok: false, why: 'link-in-state' }
      await exec(icacls, [state, '/reset', '/T', '/C'], options)
      await exec(icacls, [state, '/inheritance:r', '/grant:r', `${name}:(OI)(CI)F`], options)
      problem = await look()
      if (problem !== null) return { ok: false, why: problem }
    } catch {
      return { ok: false, why: 'lock-failed' }
    }
    return { ok: true }
  }
}

// Whether the folder, or anything at any level inside it, is a symbolic link or a junction. lstat and readdir types never follow one. An entry that cannot
// be looked at counts as one: nothing is changed on a tree that was not fully seen.
async function hasLink(fs, folder) {
  try {
    if ((await fs.lstat(folder)).isSymbolicLink()) return true
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const path = win32.join(folder, entry.name)
      if (entry.isSymbolicLink() || (await fs.lstat(path)).isSymbolicLink()) return true
      if (entry.isDirectory() && (await hasLink(fs, path))) return true
    }
    return false
  } catch {
    return true
  }
}

async function exists(fs, path) {
  try {
    await fs.lstat(path)
    return true
  } catch {
    return false
  }
}
