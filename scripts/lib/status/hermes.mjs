// The Hermes part: what the Hermes card shows, read from Hermes's own files. Hermes is NEVER run -
// `hermes --version` is not read-only (run once on the Windows PC, it tried to finish an update and
// rewrote a file) - and this module never calls deps.exec.
//
// Where Hermes lives is worked out the way Hermes works it out (hermes_constants.py): HERMES_HOME,
// else %LOCALAPPDATA%\hermes on Windows, else ~/.hermes. That folder is the profile Hermes calls
// "default"; every other profile is a folder in <root>/profiles/.
//
// What is read, and the only things kept from each:
//   hermes-agent/pyproject.toml, hermes-agent/hermes_cli/__init__.py   the version line
//   .update_check                     ts, ver and behind -> "update available", true or false
//   gateway_state.json                gateway_state and updated_at (never pid, argv or platforms)
//   per profile:
//     config.yaml                     model.default and model.provider (never base_url, never any
//                                     other key; only the lines of the top-level model block)
//     skills/**/SKILL.md              counted, never opened
//     state.db (and state.db-wal)     copied into a private folder; the copy is asked one fixed
//                                     question - how many top-level sessions in
//                                     the last 7 days, by kind, and when the newest was active
//     cron/ticker_heartbeat           the time in it
// Checked to exist, never opened: the files that make a folder a profile (config.yaml, .env,
// SOUL.md, profile.yaml, auth.json, state.db) and a profile's tombstone in profiles/.deleted/.
// Never touched: memories, SOUL.md and USER.md contents, .env, auth.json, logs, sessions and
// chat content, and anything else in the home.

import { readFile, readdir, lstat, stat, mkdir, mkdtemp, copyFile, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, isAbsolute, dirname, basename } from 'node:path'
import {
  HERMES_SCHEMA,
  HERMES_CAPS,
  DEFAULT_PROFILE,
  SESSION_DAYS,
  UPDATE_CHECK_MAX_AGE_DAYS,
  GATEWAY_STATES
} from './hermes-schema.mjs'
import { VERSION_PATTERN, MAX_VERSION_LENGTH } from './connections-schema.mjs'
import { checkProfileName, modelShown, isConnectionName } from './safe.mjs'
import { isoSeconds, toIsoTime, isPlainObject } from './util.mjs'
import { openReadOnly, SqliteMissing } from './sqlite.mjs'

const NOT_FOUND = { status: 'not found' }
const UNREADABLE = { status: 'unavailable', why: 'could not be read' }
const DAY_MS = 86400_000
// Before 2000, or more than a day ahead of the check, a time is a broken clock or a hand edit.
const EARLIEST_BELIEVABLE_MS = Date.parse('2000-01-01T00:00:00Z')
// Folders and files visited while counting skills, at most - a skills folder is a few hundred.
export const MAX_SKILL_ENTRIES = 50_000
// The biggest state.db (with its -wal) the collector will copy to count sessions in.
export const MAX_SESSION_DB_BYTES = 200 * 1024 * 1024
// Each private copy is a folder named like this in the state folder, deleted when the count is done.
export const COPY_PREFIX = 'hermes-db-'
// A copy lives for seconds. One older than this was left by a run that crashed; a younger one may
// belong to another run reading it right now (a run by hand beside the scheduled one).
export const LEFTOVER_AFTER_MS = 3600_000

// Run at the start of every run: removes the private copies a crashed run left behind. Only
// folders named COPY_PREFIX..., only directly in the state folder, only real folders - a link with
// that name is left alone, so nothing is ever followed out of the state folder - and only when
// older than LEFTOVER_AFTER_MS. Nothing it finds is opened; failures are ignored.
export async function removeLeftoverCopies(stateDir, now = Date.now()) {
  if (typeof stateDir !== 'string' || !stateDir) return
  let entries
  try {
    entries = await readdir(stateDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.name.startsWith(COPY_PREFIX) || entry.isSymbolicLink() || !entry.isDirectory()) continue
    const path = join(stateDir, entry.name)
    try {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || now - info.mtimeMs < LEFTOVER_AFTER_MS) continue
      await rm(path, { recursive: true, force: true })
    } catch {
      // Left for the next run.
    }
  }
}

// --- where Hermes lives ---------------------------------------------------------------------------------

export function hermesRoot({ home, env = {}, platform }) {
  let set = typeof env.HERMES_HOME === 'string' ? env.HERMES_HOME.trim() : ''
  if (set === '~' || set.startsWith('~/') || set.startsWith('~\\')) set = join(home, set.slice(1))
  if (set && isAbsolute(set)) {
    // HERMES_HOME=<root>/profiles/<name> runs one profile; the profiles all live under <root>.
    return basename(dirname(set)) === 'profiles' ? dirname(dirname(set)) : set
  }
  if (platform === 'win32') {
    const local = typeof env.LOCALAPPDATA === 'string' && isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : join(home, 'AppData', 'Local')
    return join(local, 'hermes')
  }
  return join(home, '.hermes')
}

// --- small file helpers: every error is a state word, never a message (messages carry paths) -------------

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

// 'folder', 'missing', or 'other' (a file, or something that could not be looked at).
async function folderState(path) {
  try {
    return (await stat(path)).isDirectory() ? 'folder' : 'other'
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'missing' : 'other'
  }
}

// Reads a small file whole, or says why not. A file bigger than `maxBytes` is not one Hermes wrote
// for this purpose, and is not read at all.
async function readSmall(path, maxBytes) {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > maxBytes) return { state: 'broken' }
    return { state: 'ok', text: await readFile(path, 'utf8') }
  } catch (error) {
    return { state: error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'missing' : 'broken' }
  }
}

async function readSmallJson(path, maxBytes) {
  const read = await readSmall(path, maxBytes)
  if (read.state !== 'ok') return read
  try {
    return { state: 'ok', value: JSON.parse(read.text) }
  } catch {
    return { state: 'broken' }
  }
}

// Hermes writes times as ISO with an offset and microseconds, as a naive ISO it reads as UTC, or
// (older files) as seconds since 1970. Any of those becomes ISO in UTC to the second; anything
// else, or a time nobody could believe, is null.
function hermesTime(raw, now) {
  let value = raw
  if (typeof value === 'string' && /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value.trim())) value = `${value.trim()}Z`
  const time = toIsoTime(value)
  if (!time) return null
  const ms = Date.parse(time)
  return ms >= EARLIEST_BELIEVABLE_MS && ms <= now + DAY_MS ? time : null
}

function cleanVersion(raw) {
  if (typeof raw !== 'string') return null
  const match = /\d+(?:\.\d+){1,3}/.exec(raw)
  if (!match || match[0].length > MAX_VERSION_LENGTH || !VERSION_PATTERN.test(match[0])) return null
  return match[0]
}

// --- install ---------------------------------------------------------------------------------------------

// The version line under [project] in hermes-agent/pyproject.toml, or __version__ in
// hermes-agent/hermes_cli/__init__.py. Only that one line is matched; the rest is never looked at.
export async function hermesVersionAt(root) {
  const agent = join(root, 'hermes-agent')
  const pyproject = await readSmall(join(agent, 'pyproject.toml'), 256 * 1024)
  if (pyproject.state === 'ok') {
    let section = null
    for (const line of pyproject.text.split(/\r?\n/)) {
      const header = /^\s*\[([^\]]+)\]\s*$/.exec(line)
      if (header) {
        section = header[1].trim()
        continue
      }
      const version = section === 'project' ? /^\s*version\s*=\s*["']([^"']*)["']/.exec(line) : null
      const found = version ? cleanVersion(version[1]) : null
      if (found) return found
    }
  }
  const init = await readSmall(join(agent, 'hermes_cli', '__init__.py'), 256 * 1024)
  if (init.state === 'ok') {
    const version = /^__version__\s*=\s*["']([^"']*)["']/m.exec(init.text)
    const found = version ? cleanVersion(version[1]) : null
    if (found) return found
  }
  return null
}

// Hermes's own update check (hermes_cli/banner.py) leaves { ts, behind, ver, ... } in .update_check.
// It is believed only when it is recent and was made for the version installed - the same test
// Hermes applies before trusting it. true = behind, false = up to date, undefined = cannot say.
async function updateAvailable(root, version, now) {
  if (!version) return undefined
  const read = await readSmallJson(join(root, '.update_check'), 64 * 1024)
  if (read.state !== 'ok' || !isPlainObject(read.value)) return undefined
  const { ts, ver, behind } = read.value
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return undefined
  const age = now - ts * 1000
  if (age < -DAY_MS || age > UPDATE_CHECK_MAX_AGE_DAYS * DAY_MS) return undefined
  if (cleanVersion(ver) !== version || ver.trim() !== version) return undefined
  if (!Number.isSafeInteger(behind) || behind < 0) return undefined
  return behind > 0
}

async function readInstall(root, now) {
  const version = await hermesVersionAt(root)
  const install = { status: 'found' }
  if (version) install.version = version
  const update = await updateAvailable(root, version, now)
  if (update !== undefined) install.updateAvailable = update
  return install
}

// --- gateway ---------------------------------------------------------------------------------------------

async function readGateway(root, now) {
  const read = await readSmallJson(join(root, 'gateway_state.json'), 256 * 1024)
  if (read.state === 'missing') return { ...NOT_FOUND }
  if (read.state !== 'ok' || !isPlainObject(read.value)) return { ...UNREADABLE }
  const raw = read.value.gateway_state
  const state = typeof raw === 'string' && Object.hasOwn(GATEWAY_STATES, raw) ? raw : 'unknown'
  const beatAt = hermesTime(read.value.updated_at, now)
  return beatAt ? { status: 'found', state, beatAt } : { status: 'found', state }
}

// --- profiles --------------------------------------------------------------------------------------------

// The files that make a folder under profiles/ a profile (hermes_constants.py,
// _PROFILE_IDENTITY_MARKERS). Each is only checked to exist.
const IDENTITY_MARKERS = ['config.yaml', '.env', 'SOUL.md', 'profile.yaml', 'auth.json', 'state.db']

async function hasIdentity(dir) {
  for (const marker of IDENTITY_MARKERS) if (await exists(join(dir, marker))) return true
  return false
}

// The default profile (the home itself) first, then every named profile Hermes would list, A to Z.
// A name the board would refuse is counted in hidden and never kept.
async function profileFolders(root, identity) {
  const profilesDir = join(root, 'profiles')
  let entries = []
  try {
    entries = await readdir(profilesDir, { withFileTypes: true })
  } catch {
    entries = []
  }
  const named = []
  let hidden = 0
  for (const entry of entries) {
    // Dot folders are Hermes's own (.deleted holds tombstones), never profiles.
    if (entry.name.startsWith('.')) continue
    const dir = join(profilesDir, entry.name)
    // A link to a folder somewhere else is not followed; it is counted, not named.
    if (entry.isSymbolicLink()) {
      hidden += 1
      continue
    }
    if (!entry.isDirectory()) continue
    if (await exists(join(profilesDir, '.deleted', entry.name))) continue
    if (!(await hasIdentity(dir))) continue
    if (entry.name === DEFAULT_PROFILE || checkProfileName(entry.name, 'name', identity).length) {
      hidden += 1
      continue
    }
    named.push({ name: entry.name, dir })
  }
  named.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const all = [{ name: DEFAULT_PROFILE, dir: root }, ...named]
  return { folders: all.slice(0, HERMES_CAPS.profiles), hidden, more: Math.max(0, all.length - HERMES_CAPS.profiles) }
}

// --- model: two keys of one block of config.yaml, and nothing else ------------------------------------------

// One YAML value on one line: a plain word, or a quoted one with no escapes. Anything fancier
// (flow maps, block scalars, anchors, tags, escapes) is null - not a guess.
function lineValue(rest) {
  const text = rest.trim()
  if (!text || text.startsWith('#')) return null
  if (text[0] === '"') {
    const quoted = /^"([^"\\]*)"\s*(#.*)?$/.exec(text)
    return quoted ? quoted[1] : null
  }
  if (text[0] === "'") {
    const quoted = /^'((?:[^']|'')*)'\s*(#.*)?$/.exec(text)
    return quoted ? quoted[1].replaceAll("''", "'") : null
  }
  if (/^[{[|>&*!%@`]/.test(text)) return null
  const plain = text.replace(/\s+#.*$/, '').trim()
  return plain && !['~', 'null', 'Null', 'NULL'].includes(plain) ? plain : null
}

// The top-level `model:` of config.yaml, as { default, provider } where present. Two forms:
//   model: some-model                 (plain)
//   model:                            (block)
//     default: provider/some-model
//     provider: openrouter
// Only the block's own first-level lines named default or provider are matched. base_url and
// every other key - in the block or anywhere in the file - is never kept, and the line text of
// the rest of the file is only looked at to see where the block ends.
export function modelFromConfig(text) {
  const lines = String(text).split(/\r?\n/)
  let found = {}
  for (let index = 0; index < lines.length; index += 1) {
    const top = /^model\s*:(.*)$/.exec(lines[index])
    if (!top) continue
    const rest = top[1].trim()
    if (rest && !rest.startsWith('#')) {
      const value = lineValue(rest)
      found = value ? { default: value } : {}
      continue
    }
    found = {}
    let childIndent = null
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next]
      if (!line.trim() || /^\s*#/.test(line)) continue
      const indent = /^ */.exec(line)[0].length
      if (indent === 0) break
      if (childIndent === null) childIndent = indent
      if (indent !== childIndent) continue
      const key = /^ *(default|provider)\s*:(.*)$/.exec(line)
      if (!key) continue
      const value = lineValue(key[2])
      if (value) found[key[1]] = value
      else delete found[key[1]]
    }
  }
  return found
}

async function readModel(dir, identity) {
  const read = await readSmall(join(dir, 'config.yaml'), 1024 * 1024)
  if (read.state !== 'ok') return {}
  const raw = modelFromConfig(read.text)
  const model = modelShown(raw.default, identity)
  if (!model) return {}
  return typeof raw.provider === 'string' && isConnectionName(raw.provider, identity) ? { model, provider: raw.provider } : { model }
}

// --- skills ------------------------------------------------------------------------------------------------

// Every file named SKILL.md under skills/, at any depth. Names are listed, nothing is opened, and a
// link is never followed.
async function countSkills(dir) {
  const skills = join(dir, 'skills')
  const state = await folderState(skills)
  if (state === 'missing') return { ...NOT_FOUND }
  if (state !== 'folder') return { ...UNREADABLE }
  let count = 0
  let visited = 0
  const queue = [skills]
  while (queue.length) {
    const current = queue.shift()
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return { ...UNREADABLE }
    }
    for (const entry of entries) {
      visited += 1
      if (visited > MAX_SKILL_ENTRIES) return { status: 'unavailable', why: 'too many files to count' }
      if (entry.isDirectory()) queue.push(join(current, entry.name))
      else if (entry.isFile() && entry.name === 'SKILL.md') count += 1
    }
  }
  return { status: 'found', count }
}

// --- the scheduler's beat ----------------------------------------------------------------------------------

// cron/ticker_heartbeat holds one number: the seconds since 1970 when the scheduler last ticked
// (cron/jobs.py, record_ticker_heartbeat). Anything else in it is not read as a time.
async function schedulerBeat(dir, now) {
  const read = await readSmall(join(dir, 'cron', 'ticker_heartbeat'), 64)
  if (read.state === 'missing') return { ...NOT_FOUND }
  if (read.state !== 'ok') return { ...UNREADABLE }
  const seconds = /^\s*(\d{1,12}(?:\.\d+)?)\s*$/.exec(read.text)
  const beatAt = seconds ? hermesTime(Number(seconds[1]), now) : null
  return beatAt ? { status: 'found', beatAt } : { ...UNREADABLE }
}

// --- sessions: one fixed question, asked of a private copy ------------------------------------------------------------------

const LAST_ACTIVE_COLUMNS = ['last_activity_at', 'ended_at', 'started_at']

// The one question asked of state.db's sessions table. It is made from fixed words only: the
// table's own column list decides which of these fixed forms is used, and no name read from the
// file is ever put into it. null when the table lacks the two columns every form needs.
//   conversations: top-level sessions started in the window, from anywhere but cron, delegate, subagent
//   scheduled:     top-level sessions started in the window by cron
//   last_active:   the newest activity of any top-level session
export function sessionsQuery(columns) {
  if (!columns.has('source') || !columns.has('started_at')) return null
  const last = LAST_ACTIVE_COLUMNS.filter((column) => columns.has(column))
  const lastActive = last.length > 1 ? `COALESCE(${last.join(', ')})` : last[0]
  const topLevel = columns.has('parent_session_id') ? ' WHERE parent_session_id IS NULL' : ''
  return [
    'SELECT',
    "COALESCE(SUM(CASE WHEN started_at >= ? AND source NOT IN ('cron', 'delegate', 'subagent') THEN 1 ELSE 0 END), 0) AS conversations,",
    "COALESCE(SUM(CASE WHEN started_at >= ? AND source = 'cron' THEN 1 ELSE 0 END), 0) AS scheduled,",
    `MAX(${lastActive}) AS last_active`,
    `FROM sessions${topLevel}`
  ].join(' ')
}

const wholeCount = (value) => {
  const number = typeof value === 'bigint' ? Number(value) : value
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

// The size of a file, 'missing' when it is not there, or null when it is not a plain file or could
// not be looked at.
async function fileSize(path) {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : null
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'missing' : null
  }
}

// Asks one database file the one question. `path` is always the private copy.
async function askSessions(path, deps) {
  const open = deps.openSqlite ?? openReadOnly
  let db
  try {
    db = await open(path)
  } catch (error) {
    if (error instanceof SqliteMissing || error?.name === 'SqliteMissing') return { status: 'unavailable', why: 'needs a newer Node' }
    return { ...UNREADABLE }
  }
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((row) => row?.name).filter((name) => typeof name === 'string'))
    const sql = sessionsQuery(columns)
    if (!sql) return { status: 'unavailable', why: 'not a layout this collector knows' }
    const since = deps.now / 1000 - SESSION_DAYS * 86400
    const row = db.prepare(sql).get(since, since)
    const conversations = wholeCount(row?.conversations)
    const scheduled = wholeCount(row?.scheduled)
    if (conversations === null || scheduled === null) return { ...UNREADABLE }
    const sessions = { status: 'found', days: SESSION_DAYS, conversations, scheduled }
    const lastActive = typeof row.last_active === 'number' ? hermesTime(row.last_active, deps.now) : null
    if (lastActive) sessions.lastActiveAt = lastActive
    return sessions
  } catch {
    return { ...UNREADABLE }
  } finally {
    try {
      db.close()
    } catch {
      // The copy is deleted next either way.
    }
  }
}

// Hermes keeps state.db in WAL mode, and SQLite makes state.db-wal and state.db-shm beside a WAL
// database for ANY connection to it - a read-only one included - and can leave them there. So
// Hermes's own file is never opened. state.db, and state.db-wal when there is one (it holds the
// newest sessions until Hermes checkpoints), are copied into a fresh private folder under the
// collector's state folder; state.db-shm, which is only shared memory between running connections,
// is never copied. The copy is asked, then the whole folder is deleted, whatever happened.
// Above MAX_SESSION_DB_BYTES nothing is copied at all.
async function readSessions(dir, deps) {
  const path = join(dir, 'state.db')
  const size = await fileSize(path)
  if (size === 'missing') return { ...NOT_FOUND }
  if (size === null || !deps.stateDir) return { ...UNREADABLE }
  const walSize = await fileSize(`${path}-wal`)
  if (walSize === null) return { ...UNREADABLE }
  const limit = deps.sessionDbMaxBytes ?? MAX_SESSION_DB_BYTES
  if (size + (walSize === 'missing' ? 0 : walSize) > limit) return { status: 'unavailable', why: 'database too big' }
  let folder = null
  try {
    await mkdir(deps.stateDir, { recursive: true })
    folder = await mkdtemp(join(deps.stateDir, COPY_PREFIX))
    const copy = join(folder, 'state.db')
    await copyFile(path, copy, constants.COPYFILE_EXCL)
    if (walSize !== 'missing') {
      try {
        await copyFile(`${path}-wal`, `${copy}-wal`, constants.COPYFILE_EXCL)
      } catch (error) {
        // Hermes checkpointed and removed it between the look and the copy: state.db has it all.
        if (error?.code !== 'ENOENT') throw error
      }
    }
    return await askSessions(copy, deps)
  } catch {
    return { ...UNREADABLE }
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true }).catch(() => {})
  }
}

// --- the part ------------------------------------------------------------------------------------------------

async function safely(read) {
  try {
    return await read()
  } catch {
    return { ...UNREADABLE }
  }
}

async function readProfile({ name, dir }, deps) {
  const identity = deps.identity
  const model = await safely(() => readModel(dir, identity))
  const item = { name }
  if (model.model) item.model = model.model
  if (model.model && model.provider) item.provider = model.provider
  item.skills = await safely(() => countSkills(dir))
  item.sessions = await safely(() => readSessions(dir, deps))
  item.scheduler = await safely(() => schedulerBeat(dir, deps.now))
  return item
}

async function readProfiles(root, deps) {
  const { folders, hidden, more } = await profileFolders(root, deps.identity)
  const items = []
  for (const folder of folders) items.push(await readProfile(folder, deps))
  return { status: 'found', items, hidden, more }
}

export async function collectHermes(deps, computer) {
  const doc = {
    schema: HERMES_SCHEMA,
    takenAt: isoSeconds(deps.now),
    computer,
    install: { ...NOT_FOUND },
    gateway: { ...NOT_FOUND },
    profiles: { ...NOT_FOUND }
  }
  const root = hermesRoot(deps)
  const state = await folderState(root)
  // No Hermes here: everything says not found, and nothing else is invented.
  if (state === 'missing') return doc
  if (state !== 'folder') return { ...doc, install: { ...UNREADABLE }, gateway: { ...UNREADABLE }, profiles: { ...UNREADABLE } }
  doc.install = await safely(() => readInstall(root, deps.now))
  doc.gateway = await safely(() => readGateway(root, deps.now))
  doc.profiles = await safely(() => readProfiles(root, deps))
  return doc
}
