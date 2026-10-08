// The Installed tools row on the Connections wall (decision D3): whether each tool is on this
// computer, and its version. A version is a number and nothing else - the banner a program prints
// around it can hold a folder or an account, and none of it is kept.
//
//   - Programs (claude, codex, git, gh, tailscale) are found by programs.mjs and run through
//     deps.exec: absolute path, the empty folder, ten seconds, a small output cap.
//   - Node.js is the collector's own Node.
//   - Hermes is NEVER run. `hermes --version` is not read-only - when a planner ran it on the
//     Windows PC it tried to finish an interrupted update and rewrote a file. Its version is read
//     from its own files instead: hermes-agent/pyproject.toml ([project] version), or
//     hermes-agent/hermes_cli/__init__.py (__version__).
//   - The Claude and ChatGPT apps (and Tailscale, when its app is there) on a Mac: the app's
//     Info.plist, read by /usr/bin/plutil. On Windows and Linux the apps "could not check".

import { readFile, stat } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { TOOL_NAMES, VERSION_PATTERN, MAX_VERSION_LENGTH } from './connections-schema.mjs'
import { findProgram, emptyFolder, VERSION_TIMEOUT_MS } from './programs.mjs'

export const VERSION_OUTPUT_CAP = 16 * 1024
const PLUTIL = '/usr/bin/plutil'

// The first number with one to three dots in it, if it is a believable version; otherwise null.
export function versionFrom(text) {
  if (typeof text !== 'string') return null
  const match = /\d+(?:\.\d+){1,3}/.exec(text)
  if (!match || match[0].length > MAX_VERSION_LENGTH || !VERSION_PATTERN.test(match[0])) return null
  return match[0]
}

const exists = async (path) => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// Hermes's own rule: HERMES_HOME, else %LOCALAPPDATA%\hermes on Windows, else ~/.hermes.
export function hermesHome({ home, env = {}, platform }) {
  if (typeof env.HERMES_HOME === 'string' && isAbsolute(env.HERMES_HOME)) return env.HERMES_HOME
  if (platform === 'win32') {
    const local = typeof env.LOCALAPPDATA === 'string' && isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : join(home, 'AppData', 'Local')
    return join(local, 'hermes')
  }
  return join(home, '.hermes')
}

// The version line under [project] in pyproject.toml, or __version__ in hermes_cli/__init__.py.
// Only that one line is matched; the rest of each file is never looked at.
async function hermesVersion(deps) {
  const root = hermesHome(deps)
  if (!(await exists(root))) return { state: 'not found' }
  const agent = join(root, 'hermes-agent')
  try {
    let section = null
    for (const line of (await readFile(join(agent, 'pyproject.toml'), 'utf8')).split(/\r?\n/)) {
      const header = /^\s*\[([^\]]+)\]\s*$/.exec(line)
      if (header) {
        section = header[1].trim()
        continue
      }
      const version = section === 'project' ? /^\s*version\s*=\s*["']([^"']*)["']/.exec(line) : null
      if (version) {
        const found = versionFrom(version[1])
        if (found) return { state: 'found', version: found }
      }
    }
  } catch {
    // No pyproject.toml; try the package itself.
  }
  try {
    const text = await readFile(join(agent, 'hermes_cli', '__init__.py'), 'utf8')
    const version = /^__version__\s*=\s*["']([^"']*)["']/m.exec(text)
    const found = version ? versionFrom(version[1]) : null
    if (found) return { state: 'found', version: found }
  } catch {
    // Neither file: Hermes's folder is here, but not a version anybody can read.
  }
  return { state: 'could not check' }
}

// Runs one program and keeps the number from what it prints. Each run starts in a freshly emptied
// folder. A program that is there but would not answer is "could not check", never "not found".
async function runForVersion(deps, path, args) {
  let cwd
  try {
    cwd = await emptyFolder(deps.stateDir)
  } catch {
    return { state: 'could not check' }
  }
  try {
    const { stdout } = await deps.exec(path, args, { cwd, timeout: VERSION_TIMEOUT_MS, maxOutput: VERSION_OUTPUT_CAP })
    const version = versionFrom(String(stdout ?? ''))
    return version ? { state: 'found', version } : { state: 'found' }
  } catch {
    return { state: 'could not check' }
  }
}

async function programVersion(deps, name, args) {
  if (typeof deps.exec !== 'function' || !deps.stateDir) return { state: 'could not check' }
  let program
  try {
    program = await findProgram(name, deps)
  } catch {
    return { state: 'could not check' }
  }
  if (program.state === 'not found') return { state: 'not found' }
  if (program.state !== 'found') return { state: 'could not check' }
  return runForVersion(deps, program.path, args)
}

// A Mac app's Info.plist, through /usr/bin/plutil. Returns null when the app is not there, so a
// caller can try something else.
async function macAppVersion(deps, app) {
  const plist = join(deps.appsFolder ?? '/Applications', `${app}.app`, 'Contents', 'Info.plist')
  if (!(await exists(plist))) return null
  if (typeof deps.exec !== 'function' || !deps.stateDir) return { state: 'could not check' }
  return runForVersion(deps, PLUTIL, ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist])
}

async function appVersion(deps, app) {
  if (deps.platform !== 'darwin') return { state: 'could not check' }
  return (await macAppVersion(deps, app)) ?? { state: 'not found' }
}

export const TOOL_CHECKS = [
  { name: 'Claude Code', check: (deps) => programVersion(deps, 'claude', ['--version']) },
  { name: 'Codex', check: (deps) => programVersion(deps, 'codex', ['--version']) },
  { name: 'Hermes', check: (deps) => hermesVersion(deps) },
  {
    name: 'Node.js',
    check: async (deps) => {
      const version = versionFrom(String(deps.nodeVersion ?? process.versions.node))
      return version ? { state: 'found', version } : { state: 'found' }
    }
  },
  { name: 'Git', check: (deps) => programVersion(deps, 'git', ['--version']) },
  { name: 'GitHub CLI', check: (deps) => programVersion(deps, 'gh', ['--version']) },
  { name: 'Claude app', check: (deps) => appVersion(deps, 'Claude') },
  { name: 'ChatGPT app', check: (deps) => appVersion(deps, 'ChatGPT') },
  {
    name: 'Tailscale',
    // On a Mac the app is read first: its own binary inside the app is the menu-bar app, which a
    // --version call could open.
    check: async (deps) => (deps.platform === 'darwin' ? await macAppVersion(deps, 'Tailscale') : null) ?? programVersion(deps, 'tailscale', ['version'])
  }
]

if (JSON.stringify(TOOL_CHECKS.map((check) => check.name)) !== JSON.stringify(TOOL_NAMES)) {
  throw new Error('tools.mjs: the checks do not match TOOL_NAMES')
}

// One after another, never at the same time: each run empties the folder the next one runs in.
export async function collectTools(deps) {
  const tools = []
  for (const { name, check } of TOOL_CHECKS) {
    let result
    try {
      result = await check(deps)
    } catch {
      result = { state: 'could not check' }
    }
    tools.push(result.version ? { name, state: result.state, version: result.version } : { name, state: result.state })
  }
  return tools
}
