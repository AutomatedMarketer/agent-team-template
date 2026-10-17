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

// What icacls prints for several files: one block per file, separated by a blank line, then a summary. -> a list of lists of entries, summary left out.
export function accessBlocks(output) {
  return String(output).split(/\r?\n\s*\r?\n/).map(accessEntries).filter((entries) => entries.length > 0)
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
      const lists = [accessEntries((await exec(icacls, [state], options)).stdout)]
      const names = await fs.readdir(state)
      if (names.length > 0) lists.push(...accessBlocks((await exec(icacls, [win32.join(state, '*')], options)).stdout))
      // A secrets file deeper than the top of the folder is looked at on its own.
      if (win32.dirname(places.envFile).toLowerCase() !== state.toLowerCase() && (await exists(fs, places.envFile))) lists.push(accessEntries((await exec(icacls, [places.envFile], options)).stdout))
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

async function exists(fs, path) {
  try {
    await fs.lstat(path)
    return true
  } catch {
    return false
  }
}
