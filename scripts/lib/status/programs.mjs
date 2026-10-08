// Finding and running other programs - `claude mcp list` and a few `--version`s - without letting
// whatever happens to be on this computer choose what runs.
//
// The rules, each tested in tests/status-programs.test.mjs:
//   - A program is looked up by our own search, never by the shell: only absolute PATH entries
//     ("." and relative entries are skipped), then the folders installers use (~/.local/bin,
//     ~/.claude/local, and Homebrew's on a Mac - a LaunchAgent's PATH often has none of them).
//   - A program inside the --clone folder is refused: that folder holds whatever the team repo
//     holds, so anyone who can push could choose it.
//   - On Windows only a real .exe runs. A .cmd or .bat needs a shell, and a shell is a second
//     program reading our arguments.
//   - It always runs by absolute path, from an empty folder the collector owns, with a time
//     limit and an output cap. When either is hit, the program and everything it started are
//     stopped: on a Mac or Linux the whole process group, on Windows the whole process tree.
//
// This module never imports child_process. The runner is built in machine.mjs around the real
// spawn, so every program the collector runs goes through deps.exec - which the tests replace.

import { stat, access, lstat, rm, mkdir, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, isAbsolute, delimiter } from 'node:path'
import { isInsideFolder } from './commit.mjs'

export const PROGRAM_OUTPUT_CAP = 256 * 1024
export const VERSION_TIMEOUT_MS = 10_000
export const EMPTY_FOLDER_NAME = 'empty-cwd'

const PROGRAM_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function pathValue(env = {}) {
  if (typeof env.PATH === 'string') return env.PATH
  if (typeof env.Path === 'string') return env.Path
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH')
  return key && typeof env[key] === 'string' ? env[key] : ''
}

function knownFoldersFor({ home, platform }) {
  const folders = [join(home, '.local', 'bin'), join(home, '.claude', 'local')]
  if (platform === 'darwin') folders.push('/opt/homebrew/bin', '/usr/local/bin')
  return folders
}

// Absolute PATH entries in order, then the known folders, each once. `knownFolders`, when a
// caller hands it over, replaces the known folders - tests use it so a real Homebrew folder is
// never looked in.
export function programFolders({ env = {}, home, platform, knownFolders }) {
  const fromPath = pathValue(env).split(delimiter).map((entry) => entry.trim()).filter((entry) => entry && isAbsolute(entry))
  const known = Array.isArray(knownFolders) ? knownFolders : knownFoldersFor({ home, platform })
  return [...new Set([...fromPath, ...known])]
}

async function isRunnableFile(path, platform) {
  try {
    if (!(await stat(path)).isFile()) return false
    if (platform !== 'win32') await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// Returns { state: 'found', path } with an absolute path, { state: 'not found' }, or
// { state: 'refused' } when the only copies found were inside --clone or need a shell. A caller
// shows "refused" as "could not check", never as "not found": the program is there.
export async function findProgram(name, deps) {
  if (typeof name !== 'string' || !PROGRAM_NAME.test(name)) throw new Error('not a program name')
  const windows = deps.platform === 'win32'
  let refused = false
  for (const folder of programFolders(deps)) {
    const candidates = windows ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name]
    for (const file of candidates) {
      const path = join(folder, file)
      if (!(await isRunnableFile(path, deps.platform))) continue
      if (windows && !file.endsWith('.exe')) {
        refused = true
        continue
      }
      if (deps.clone !== undefined && (await isInsideFolder(path, deps.clone))) {
        refused = true
        continue
      }
      return { state: 'found', path }
    }
  }
  return { state: refused ? 'refused' : 'not found' }
}

// An error that says what happened and nothing else: no path, no output, no argument.
function failure(code, extra = {}) {
  const error = new Error(`the program did not finish (${code})`)
  error.code = code
  Object.assign(error, extra)
  return error
}

// The runner machine.mjs hands to every source as deps.exec(file, args, options). It answers
// { stdout, code } and rejects with a code: ETIMEDOUT, ECAP (too much output), EXIT (a failing
// exit, unless acceptAnyExit), ESPAWN, or ENOTABSOLUTE.
export function createRunner({ spawn, platform, env }) {
  const ownGroup = platform !== 'win32'
  const systemRoot = env?.SystemRoot || env?.SYSTEMROOT || 'C:\\Windows'

  return (file, args = [], options = {}) => new Promise((resolve, reject) => {
    if (typeof file !== 'string' || !isAbsolute(file)) {
      reject(failure('ENOTABSOLUTE', { message: 'a program must be given as an absolute path' }))
      return
    }
    const { cwd, timeout = VERSION_TIMEOUT_MS, maxOutput = PROGRAM_OUTPUT_CAP, acceptAnyExit = false } = options
    let child
    try {
      child = spawn(file, args, {
        cwd,
        env: options.env ?? env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so a timeout can stop everything it started.
        detached: ownGroup,
        windowsHide: true,
        shell: false
      })
    } catch {
      reject(failure('ESPAWN'))
      return
    }

    const stopEverything = () => {
      if (!child.pid) return
      if (ownGroup) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // The group is already gone.
        }
      } else {
        try {
          spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
        } catch {
          // Nothing more can be done from here; the child itself is still killed below.
        }
      }
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }

    const chunks = []
    let size = 0
    let settled = false
    const settle = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        stopEverything()
        reject(error)
        return
      }
      // A finished program can still have left something running in its group.
      if (ownGroup) stopEverything()
      resolve(value)
    }
    const timer = setTimeout(() => settle(failure('ETIMEDOUT')), timeout)

    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > maxOutput) settle(failure('ECAP'))
      else chunks.push(chunk)
    })
    // Read and dropped: an error stream can name paths, and nothing here prints it.
    child.stderr.on('data', () => {})
    child.on('error', () => settle(failure('ESPAWN')))
    child.on('close', (code) => {
      const stdout = Buffer.concat(chunks).toString('utf8')
      if (code === 0 || acceptAnyExit) settle(null, { stdout, code })
      else settle(failure('EXIT', { exitCode: code }))
    })
  })
}

// The folder every program runs from: <state-dir>/empty-cwd, emptied before each run. A program
// started in a project folder would read that project's own settings and servers. Whatever is at
// that name - a leftover file, or a link someone put there - is removed (rm never follows a link)
// and a real, empty folder made in its place.
export async function emptyFolder(stateDir) {
  const folder = join(stateDir, EMPTY_FOLDER_NAME)
  await mkdir(stateDir, { recursive: true })
  await rm(folder, { recursive: true, force: true })
  await mkdir(folder)
  if ((await lstat(folder)).isSymbolicLink() || (await readdir(folder)).length) throw new Error('the empty folder is not empty')
  return folder
}
