// Puts the status line tap in front of the person's own status line, in their Claude Code
// settings.json - and takes it out again, exactly.
//
// This is the one script in the collector that edits a file outside the team repo, so it holds
// itself to four rules: only the `statusLine` key changes; the file is backed up before any
// change; running it twice is the same as once (it never wraps itself); and --remove puts back
// exactly what was there. The earlier status line is carried inside the new command itself
// (--then64, see tap.mjs), so there is no second record that could drift from it.

import { join, dirname, basename } from 'node:path'
import { readFile, writeFile, rename, rm, copyFile, realpath, stat, chmod } from 'node:fs/promises'
import { isPlainObject } from './util.mjs'
import { tapCopyRoot, collectTapFiles, copyDirFor, ensureCopy, copyDirOf, removeCopy } from './tap-copy.mjs'

export const TAP_SCRIPT_NAME = 'usage-tap.mjs'

export function settingsPathFor({ home, env = {} }) {
  return join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json')
}

// Which shell will run the command. Claude Code uses /bin/sh on a Mac or Linux; on Windows it uses
// Git Bash when it is installed and PowerShell when it is not. The two quote differently, and
// PowerShell only runs a quoted path with the call operator `&`.
export function dialectFor(platform, env = {}, exists = () => false) {
  if (platform !== 'win32') return 'sh'
  const candidates = [
    env.CLAUDE_CODE_GIT_BASH_PATH,
    typeof env.SHELL === 'string' && /bash(\.exe)?$/i.test(env.SHELL) ? env.SHELL : null,
    join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
  ]
  return candidates.some((candidate) => typeof candidate === 'string' && candidate && exists(candidate)) ? 'sh' : 'powershell'
}

// Forward slashes everywhere: Git Bash treats a backslash as an escape and drops it.
const forward = (path) => path.replaceAll('\\', '/')
const QUOTE = {
  sh: (text) => `'${text.replaceAll("'", "'\\''")}'`,
  powershell: (text) => `'${text.replaceAll("'", "''")}'`
}

export function tapCommand({ nodePath, tapPath, dialect, earlier = null }) {
  const quote = QUOTE[dialect] ?? QUOTE.sh
  let command = `${quote(forward(nodePath))} ${quote(forward(tapPath))}`
  if (dialect === 'powershell') command = `& ${command}`
  if (earlier) command += ` --then64 ${Buffer.from(earlier, 'utf8').toString('base64url')}`
  return command
}

// Exactly the form tapCommand writes: an optional call operator, two quoted paths (the second
// ending in usage-tap.mjs), an optional --then64. Anything else that mentions the tap was written
// by hand, and is left alone.
const QUOTED = String.raw`'(?:[^']|'\\''|'')*'`
const OUR_FORM = new RegExp(String.raw`^(&? ?)${QUOTED} '((?:[^']|'\\''|'')*/${TAP_SCRIPT_NAME.replace('.', '\\.')})'(?: --then64 ([A-Za-z0-9_-]+))?$`)

const mentionsTap = (statusLine) => isPlainObject(statusLine) && typeof statusLine.command === 'string' && statusLine.command.includes(TAP_SCRIPT_NAME)
const isOurs = (statusLine) => mentionsTap(statusLine) && OUR_FORM.test(statusLine.command)

export function earlierFrom(command) {
  const encoded = OUR_FORM.exec(command ?? '')?.[3]
  return encoded ? Buffer.from(encoded, 'base64url').toString('utf8') : null
}

// The tap path inside one of our commands, unquoted, so --remove and an update can find the copy.
export function tapPathFrom(command) {
  const match = OUR_FORM.exec(command ?? '')
  if (!match) return null
  return match[1] === '& ' ? match[2].replaceAll("''", "'") : match[2].replaceAll("'\\''", "'")
}

const refuse = (why) => ({ action: 'refuse', why })
const HAND_WIRED = 'your status line already runs usage-tap.mjs in a form this installer did not write, so it is left alone. Edit it by hand, or put back your own status line first'

// settings: the parsed settings.json, or null when there is none.
export function planInstall({ settings, nodePath, tapPath, dialect }) {
  const before = isPlainObject(settings) ? settings : {}
  const current = before.statusLine
  let earlier = null
  let base = { type: 'command' }
  if (current !== undefined) {
    if (mentionsTap(current) && !isOurs(current)) return refuse(HAND_WIRED)
    if (isOurs(current)) {
      earlier = earlierFrom(current.command)
      base = current
    } else if (isPlainObject(current) && current.type === 'command' && typeof current.command === 'string' && current.command.trim()) {
      earlier = current.command
      base = current
    } else {
      return refuse('your status line is not a command, so there is nothing the tap could run after it')
    }
  }
  const statusLine = { ...base, type: 'command', command: tapCommand({ nodePath, tapPath, dialect, earlier }) }
  if (isOurs(current) && JSON.stringify(statusLine) === JSON.stringify(current)) return { action: 'unchanged', why: 'the usage tap is already installed' }
  // Spreading keeps every key where it was; a new statusLine goes at the end.
  return { action: isOurs(current) ? 'update' : 'install', earlier, before: current ?? null, next: { ...before, statusLine } }
}

export function planRemove({ settings }) {
  const current = isPlainObject(settings) ? settings.statusLine : undefined
  if (mentionsTap(current) && !isOurs(current)) return refuse(HAND_WIRED)
  if (!isOurs(current)) return { action: 'unchanged', why: 'the usage tap is not installed' }
  const earlier = earlierFrom(current.command)
  const next = { ...settings }
  if (earlier) next.statusLine = { ...current, command: earlier }
  else delete next.statusLine
  return { action: 'remove', earlier, before: current, next }
}

// The person's own indentation, and their trailing newline, are kept.
function serialise(value, originalText) {
  const indent = /^\{\s*\n([ \t]+)"/.exec(originalText ?? '')?.[1] ?? '  '
  const ending = originalText === null || originalText === undefined || originalText.endsWith('\n') ? '\n' : ''
  return `${JSON.stringify(value, null, indent)}${ending}`
}

const stampOf = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-')

// deps: { home, env, platform, nodePath, sourceTap, now, exists, remove?, dryRun? }
// `sourceTap` is scripts/usage-tap.mjs in the repo the installer runs from. It is never what the
// status line runs: it is copied first (tap-copy.mjs) and the status line runs the copy.
// Returns the plan plus { path, backup, copy, repairedCopy }. Never throws for a file problem it can name.
export async function installTap(deps) {
  const path = settingsPathFor(deps)
  let originalText = null
  try {
    originalText = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') return { ...refuse('settings.json could not be read'), path }
  }
  let settings = null
  if (originalText !== null) {
    try {
      settings = JSON.parse(originalText)
    } catch {
      return { ...refuse('settings.json is not plain JSON (a comment or a stray comma?), so it was not touched'), path }
    }
    if (!isPlainObject(settings)) return { ...refuse('settings.json does not hold a settings object, so it was not touched'), path }
  }

  const copyRoot = tapCopyRoot(deps)
  const currentCopy = copyDirOf(copyRoot, tapPathFrom(settings?.statusLine?.command))

  if (deps.remove) {
    const plan = planRemove({ settings })
    if (deps.dryRun || plan.action !== 'remove') return { ...plan, path, backup: null }
    const written = await writeSettings(path, plan, originalText, deps)
    await removeCopy(copyRoot, currentCopy)
    return { ...plan, ...written, removedCopy: currentCopy }
  }

  let files
  try {
    files = await collectTapFiles(deps.sourceTap)
  } catch (error) {
    return { ...refuse(`the tap could not be copied: ${error.message}`), path }
  }
  const copy = copyDirFor(copyRoot, files)
  const plan = planInstall({ settings, nodePath: deps.nodePath, tapPath: join(copy, TAP_SCRIPT_NAME), dialect: dialectFor(deps.platform, deps.env, deps.exists) })
  if (deps.dryRun || plan.action === 'refuse') return { ...plan, path, backup: null, copy }

  // The copy first, checked, so the status line never points at a folder that is not there yet.
  const { repaired } = await ensureCopy(copyRoot, files)
  if (plan.action === 'unchanged') return { ...plan, path, backup: null, copy, repairedCopy: repaired }
  const written = await writeSettings(path, plan, originalText, deps)
  if (currentCopy && currentCopy !== copy) await removeCopy(copyRoot, currentCopy)
  return { ...plan, ...written, copy, repairedCopy: repaired }
}

async function writeSettings(path, plan, originalText, deps) {
  // The backup first. If that fails, nothing is changed.
  let backup = null
  if (originalText !== null) {
    backup = `${path}.before-usage-tap-${stampOf(deps.now)}.bak`
    await copyFile(path, backup)
  }
  // Written beside the file and renamed over it, so Claude Code never reads half a settings file.
  // Beside the REAL file: when settings.json is a link (a dotfiles repo), renaming over the link
  // would replace it with a plain file. And with the file's own permissions: a settings file the
  // person made private (0600) must not come back readable by everyone.
  const target = originalText === null ? path : await realpath(path)
  const mode = originalText === null ? null : (await stat(target)).mode & 0o777
  const temporary = join(dirname(target), `.${basename(target)}.usage-tap-${process.pid}.tmp`)
  try {
    await writeFile(temporary, serialise(plan.next, originalText), mode === null ? undefined : { mode })
    // writeFile's mode passes through the umask; chmod sets exactly the original.
    if (mode !== null) await chmod(temporary, mode)
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return { path, backup, folder: dirname(path) }
}
