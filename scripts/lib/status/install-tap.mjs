// Puts the status line tap in front of the person's own status line, in their Claude Code
// settings.json - and takes it out again, exactly.
//
// This is the one script in the collector that edits a file outside the team repo, so it holds
// itself to four rules: only the `statusLine` key changes; the file is backed up before any
// change; running it twice is the same as once (it never wraps itself); and --remove puts back
// exactly what was there. The earlier status line is carried inside the new command itself
// (--then64, see tap.mjs), so there is no second record that could drift from it.

import { join, dirname, basename } from 'node:path'
import { readFile, writeFile, rename, rm, copyFile, realpath, stat, chmod, mkdir } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { isPlainObject } from './util.mjs'
import { tapCopyRoot, collectTapFiles, copyDirFor, ensureCopy, copyDirOf, removeCopy, profileKey } from './tap-copy.mjs'
import { findGitBash } from './tap.mjs'

export const TAP_SCRIPT_NAME = 'usage-tap.mjs'

export function settingsPathFor({ home, env = {} }) {
  return join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json')
}

// Which shell will run the command. Claude Code uses /bin/sh on a Mac or Linux; on Windows it uses
// Git Bash when it is installed and PowerShell when it is not. The two quote differently, and
// PowerShell only runs a quoted path with the call operator `&`.
// The dialect it picks is also written into the command (--then-shell), so the tap runs the
// earlier status line in that same shell without having to guess again.
export function dialectFor(platform, env = {}, exists = () => false) {
  if (platform !== 'win32') return 'sh'
  return findGitBash(env, exists) ? 'sh' : 'powershell'
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
  if (earlier) command += ` --then-shell ${dialect === 'powershell' ? 'powershell' : 'sh'} --then64 ${Buffer.from(earlier, 'utf8').toString('base64url')}`
  return command
}

// Exactly the form tapCommand writes: an optional call operator, two quoted paths (the second
// ending in usage-tap.mjs), an optional --then64. Anything else that mentions the tap was written
// by hand, and is left alone.
const QUOTED = String.raw`'(?:[^']|'\\''|'')*'`
const OUR_FORM = new RegExp(String.raw`^(&? ?)${QUOTED} '((?:[^']|'\\''|'')*/${TAP_SCRIPT_NAME.replace('.', '\\.')})'(?: --then-shell (?:sh|powershell) --then64 ([A-Za-z0-9_-]+))?$`)

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

// A byte-order mark some Windows editors put first. JSON.parse refuses it, so it is set aside to
// read the file and put back on write - nothing but statusLine changes.
const BOM = '﻿'
const withoutBom = (text) => (text?.startsWith(BOM) ? text.slice(1) : text)

// The person's own indentation, trailing newline and byte-order mark are kept.
function serialise(value, originalText) {
  const body = withoutBom(originalText)
  const indent = /^\{\s*\n([ \t]+)"/.exec(body ?? '')?.[1] ?? '  '
  const ending = body === null || body === undefined || body.endsWith('\n') ? '\n' : ''
  const mark = originalText?.startsWith(BOM) ? BOM : ''
  const text = `${JSON.stringify(value, null, indent)}${ending}`
  // Windows line endings stay Windows line endings.
  return `${mark}${body?.includes('\r\n') ? text.replaceAll('\n', '\r\n') : text}`
}

// --- touching only the statusLine text -----------------------------------------------------------
//
// Rewriting the whole file would hand --remove back the same settings in the installer's layout,
// not the person's. So the text is edited in place: install replaces just the `command` string
// inside an existing statusLine, or appends one statusLine member after the last member; --remove
// puts the old command string back, or cuts out exactly the member that was appended. The file has
// already passed JSON.parse, so this small scanner only has to find where things are, not judge
// them; whatever it produces is parsed again and compared with the intended settings, and the
// whole-file layout is the fallback if anything differs.

const isSpace = (char) => char === ' ' || char === '\t' || char === '\n' || char === '\r'
const skipSpace = (text, index) => {
  while (index < text.length && isSpace(text[index])) index += 1
  return index
}

function stringEnd(text, index) {
  for (let at = index + 1; at < text.length; at += 1) {
    if (text[at] === '\\') at += 1
    else if (text[at] === '"') return at + 1
  }
  throw new Error('unterminated string')
}

function valueEnd(text, index) {
  if (text[index] === '"') return stringEnd(text, index)
  if (text[index] === '{' || text[index] === '[') {
    let depth = 0
    for (let at = index; at < text.length; at += 1) {
      const char = text[at]
      if (char === '"') at = stringEnd(text, at) - 1
      else if (char === '{' || char === '[') depth += 1
      else if (char === '}' || char === ']') {
        depth -= 1
        if (depth === 0) return at + 1
      }
    }
    throw new Error('unterminated value')
  }
  let at = index
  while (at < text.length && !isSpace(text[at]) && !',}]'.includes(text[at])) at += 1
  return at
}

// The members of the object whose `{` is at `start`: key, where the key starts, where the value
// starts and ends.
function membersOf(text, start) {
  const members = []
  let at = skipSpace(text, start + 1)
  if (text[at] === '}') return members
  for (;;) {
    const keyStart = at
    const keyEnd = stringEnd(text, at)
    const valueStart = skipSpace(text, skipSpace(text, keyEnd) + 1)
    const end = valueEnd(text, valueStart)
    members.push({ key: JSON.parse(text.slice(keyStart, keyEnd)), keyStart, valueStart, valueEnd: end })
    at = skipSpace(text, end)
    if (text[at] !== ',') return members
    at = skipSpace(text, at + 1)
  }
}

const lastIndexOfKey = (members, key) => members.map((member) => member.key).lastIndexOf(key)

// The new text, or null when only a whole rewrite will do (an empty object, a status line that
// changes more than its command, or a layout the scanner cannot place a member in).
function spliceStatusLine(text, desired) {
  const top = skipSpace(text, text.startsWith(BOM) ? 1 : 0)
  if (text[top] !== '{') return null
  const members = membersOf(text, top)
  const index = lastIndexOfKey(members, 'statusLine')
  if (desired === undefined) {
    if (index < 0) return text
    const member = members[index]
    if (members.length === 1) return null
    // The last member: cut from the end of the one before it, which takes the comma and spacing
    // that install put in front. Otherwise cut up to the next key.
    if (index === members.length - 1) return text.slice(0, members[index - 1].valueEnd) + text.slice(member.valueEnd)
    return text.slice(0, member.keyStart) + text.slice(members[index + 1].keyStart)
  }
  if (index >= 0) {
    const member = members[index]
    const current = JSON.parse(text.slice(member.valueStart, member.valueEnd))
    if (!isPlainObject(current) || JSON.stringify({ ...current, command: desired.command }) !== JSON.stringify(desired)) return null
    const command = membersOf(text, member.valueStart)
    const at = lastIndexOfKey(command, 'command')
    if (at < 0) return null
    return text.slice(0, command[at].valueStart) + JSON.stringify(desired.command) + text.slice(command[at].valueEnd)
  }
  if (members.length === 0) return null
  const last = members[members.length - 1]
  if (!text.slice(top, last.valueEnd).includes('\n')) {
    return `${text.slice(0, last.valueEnd)},"statusLine":${JSON.stringify(desired)}${text.slice(last.valueEnd)}`
  }
  const lineStart = text.lastIndexOf('\n', last.keyStart) + 1
  const indent = text.slice(lineStart, last.keyStart)
  if (!/^[ \t]*$/.test(indent) || indent === '') return null
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const value = JSON.stringify(desired, null, indent).split('\n').join(`${newline}${indent}`)
  return `${text.slice(0, last.valueEnd)},${newline}${indent}"statusLine": ${value}${text.slice(last.valueEnd)}`
}

// The text to write: the in-place edit when it gives exactly the intended settings, else the
// whole file in the person's indentation.
function newSettingsText(next, originalText) {
  if (originalText !== null) {
    try {
      const spliced = spliceStatusLine(originalText, next.statusLine)
      if (spliced !== null && JSON.stringify(JSON.parse(withoutBom(spliced))) === JSON.stringify(next)) return spliced
    } catch {
      // Fall through to the whole-file layout.
    }
  }
  return serialise(next, originalText)
}

const CHANGED_UNDERNEATH = 'settings.json changed while the installer was running (Claude Code may have saved it just then), so nothing was written over it. Run the installer again'

const stampOf = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-')

// A backup never overwrites another: two runs in one second (install, then --remove) would
// otherwise replace the only copy of the original. The name gets -2, -3, ... instead.
async function backUp(path, now) {
  const stem = `${path}.before-usage-tap-${stampOf(now)}`
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const backup = attempt === 1 ? `${stem}.bak` : `${stem}-${attempt}.bak`
    try {
      await copyFile(path, backup, fsConstants.COPYFILE_EXCL)
      return backup
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw new Error('too many backups made in one second')
}

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
      settings = JSON.parse(withoutBom(originalText))
    } catch {
      return { ...refuse('settings.json is not plain JSON (a comment or a stray comma?), so it was not touched'), path }
    }
    if (!isPlainObject(settings)) return { ...refuse('settings.json does not hold a settings object, so it was not touched'), path }
  }

  const copyRoot = tapCopyRoot(deps)
  // This settings file's own copies only: another profile's copy is never updated or deleted here.
  const profile = await profileKey(path, deps.platform)
  const currentCopy = copyDirOf(copyRoot, tapPathFrom(settings?.statusLine?.command), profile)

  if (deps.remove) {
    const plan = planRemove({ settings })
    if (deps.dryRun || plan.action !== 'remove') return { ...plan, path, backup: null }
    const written = await writeSettings(path, plan, originalText, deps)
    if (written.changedUnderneath) return { ...refuse(CHANGED_UNDERNEATH), path, backup: written.backup }
    await removeCopy(copyRoot, currentCopy)
    return { ...plan, ...written, removedCopy: currentCopy }
  }

  let files
  try {
    files = await collectTapFiles(deps.sourceTap)
  } catch (error) {
    return { ...refuse(`the tap could not be copied: ${error.message}`), path }
  }
  const copy = copyDirFor(copyRoot, files, profile)
  const plan = planInstall({ settings, nodePath: deps.nodePath, tapPath: join(copy, TAP_SCRIPT_NAME), dialect: dialectFor(deps.platform, deps.env, deps.exists) })
  if (deps.dryRun || plan.action === 'refuse') return { ...plan, path, backup: null, copy }

  // The copy first, checked, so the status line never points at a folder that is not there yet.
  const { repaired } = await ensureCopy(copyRoot, files, profile)
  if (plan.action === 'unchanged') return { ...plan, path, backup: null, copy, repairedCopy: repaired }
  const written = await writeSettings(path, plan, originalText, deps)
  if (written.changedUnderneath) {
    // The new copy is not pointed at by anything; the one in use stays.
    if (copy !== currentCopy) await removeCopy(copyRoot, copy)
    return { ...refuse(CHANGED_UNDERNEATH), path, backup: written.backup }
  }
  if (currentCopy && currentCopy !== copy) await removeCopy(copyRoot, currentCopy)
  return { ...plan, ...written, copy, repairedCopy: repaired }
}

// What is on disk now, for the last check before the rename: the text, null when there is no
// file, or undefined when it cannot be read (which counts as changed).
const currentText = (path) => readFile(path, 'utf8').catch((error) => (error?.code === 'ENOENT' ? null : undefined))

async function writeSettings(path, plan, originalText, deps) {
  // The backup first. If that fails, nothing is changed.
  let backup = null
  if (originalText !== null) backup = await backUp(path, deps.now)
  // Written beside the file and renamed over it, so Claude Code never reads half a settings file.
  // Beside the REAL file: when settings.json is a link (a dotfiles repo), renaming over the link
  // would replace it with a plain file. And with the file's own permissions: a settings file the
  // person made private (0600) must not come back readable by everyone.
  // No settings file yet, and perhaps no ~/.claude folder either (Claude Code never opened here).
  if (originalText === null) await mkdir(dirname(path), { recursive: true })
  const target = originalText === null ? path : await realpath(path)
  const mode = originalText === null ? null : (await stat(target)).mode & 0o777
  const temporary = join(dirname(target), `.${basename(target)}.usage-tap-${process.pid}.tmp`)
  try {
    await writeFile(temporary, newSettingsText(plan.next, originalText), mode === null ? undefined : { mode })
    // writeFile's mode passes through the umask; chmod sets exactly the original.
    if (mode !== null) await chmod(temporary, mode)
    // A test seam: lets a test play Claude Code saving the file at the worst moment.
    if (typeof deps.beforeWrite === 'function') await deps.beforeWrite()
    // The last check. If the file is not what was read, someone else wrote it in between, and
    // renaming over it would throw their change away. What remains is the moment between this
    // read and the rename - milliseconds - which nothing short of a lock Claude Code does not
    // offer can close; the backup covers it.
    if ((await currentText(path)) !== originalText) {
      await rm(temporary, { force: true }).catch(() => {})
      return { path, backup, changedUnderneath: true }
    }
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return { path, backup, folder: dirname(path) }
}
