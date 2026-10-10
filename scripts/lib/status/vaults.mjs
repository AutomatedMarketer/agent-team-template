// The vaults part: the memory graph - each Obsidian vault the owner names, as dots and lines.
//
// Which vaults. Only those named in vaults.yml, in the team repo (the collector reads it from its own
// data clone). The owner names a vault by its folder name and says, for each, how much of it may leave
// this computer: `shape` (the default - counts and anonymous dots and lines) or `titles` (also each
// note's title, its top folder and its day). A vault nobody named is never opened: not listed, not
// counted, not mentioned. The board never writes vaults.yml; the owner asks Claude, as with jobs.yml.
//
// Where the vaults are. Obsidian keeps its own list of them:
//   macOS    ~/Library/Application Support/obsidian/obsidian.json
//   Windows  %APPDATA%\obsidian\obsidian.json
//   Linux    ~/.config/obsidian/obsidian.json (or $XDG_CONFIG_HOME)
// That file is read once, in memory, and only when something is named. From it only each vault's
// folder place is used - to take its last folder as the vault's name, and to open a vault that was
// named. The place is never kept or written: it holds the username. The vault's id, its time and its
// "open" flag are not used at all.
//
// Every read goes through `deps.fs` (the real file system unless a test hands in its own), so a test can
// list every path that was touched and show that an unnamed vault was not one of them.

import * as realFs from 'node:fs/promises'
import { join } from 'node:path'
import { parseSimpleYaml } from '../yaml-lite.mjs'
import { VAULTS_CAPS } from './vaults-schema.mjs'
import { checkConnectionName } from './safe.mjs'

export const VAULTS_YML = { file: 'vaults.yml', maxBytes: 64 * 1024 }
// Obsidian's list of vaults is a few lines per vault; anything this big is not one.
const OBSIDIAN_LIST_MAX_BYTES = 1024 * 1024

const fsOf = (deps) => deps?.fs ?? realFs
const normal = (name) => name.normalize('NFC').trim().toLowerCase()

export function obsidianListPath({ home, platform, env = {} }) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json')
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'obsidian', 'obsidian.json')
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'obsidian', 'obsidian.json')
}

// A small file read whole, or a state word. A link, a folder, a file bigger than `maxBytes` and one that
// cannot be read are all "broken": none of them is a file somebody wrote for this. Never a message,
// because an fs error carries a full path, and a full path carries the username.
async function readSmall(fs, path, maxBytes) {
  try {
    const info = await fs.lstat(path)
    if (!info.isFile() || info.size > maxBytes) return { state: 'broken' }
    return { state: 'ok', text: await fs.readFile(path, 'utf8') }
  } catch (error) {
    return { state: error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'missing' : 'broken' }
  }
}

// vaults.yml: `vaults:` and, for each, a `name:` and optionally a `level:`. The level is `shape` unless it
// is exactly the word `titles` - a typo, a capital or a list keeps the vault at the level that shares
// less. An entry that cannot be used (no name, a name the board would refuse, a bare word) is counted in
// `hidden` and never guessed at; the same vault twice is one; three are read and the rest counted in `more`.
export async function readVaultsYml(dataDir, identity = {}, fs = realFs) {
  const none = { entries: [], hidden: 0, more: 0 }
  const file = await readSmall(fs, join(dataDir, VAULTS_YML.file), VAULTS_YML.maxBytes)
  if (file.state !== 'ok') return { state: file.state, ...none }
  let doc
  try {
    doc = parseSimpleYaml(file.text)
  } catch {
    return { state: 'broken', ...none }
  }
  const listed = Array.isArray(doc?.vaults) ? doc.vaults : []
  const entries = []
  const seen = new Set()
  let hidden = 0
  let more = 0
  for (const item of listed) {
    const name = item !== null && typeof item === 'object' && !Array.isArray(item) && typeof item.name === 'string' ? item.name : null
    if (name === null || checkConnectionName(name, 'name', identity).length) {
      hidden += 1
      continue
    }
    const key = normal(name)
    if (seen.has(key)) continue
    seen.add(key)
    if (entries.length >= VAULTS_CAPS.vaults) {
      more += 1
      continue
    }
    entries.push({ name, level: item.level === 'titles' ? 'titles' : 'shape' })
  }
  return { state: 'ok', entries, hidden, more }
}

// The last folder of a place, whichever way the platform separates them, and not empty.
function folderName(place) {
  if (typeof place !== 'string') return null
  const last = place.split(/[\\/]+/).filter(Boolean).at(-1)
  return last ?? null
}

// Obsidian's list: each vault as { name, path } - the name is its last folder, the path is held to open
// it and goes no further. 'missing' is a computer without Obsidian; 'broken' is a list that is not one.
export async function listObsidianVaults(deps) {
  const read = await readSmall(fsOf(deps), obsidianListPath({ home: deps.home, platform: deps.platform, env: deps.env }), OBSIDIAN_LIST_MAX_BYTES)
  if (read.state !== 'ok') return { state: read.state, vaults: [] }
  let doc
  try {
    doc = JSON.parse(read.text)
  } catch {
    return { state: 'broken', vaults: [] }
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { state: 'broken', vaults: [] }
  const vaults = []
  const given = doc.vaults !== null && typeof doc.vaults === 'object' && !Array.isArray(doc.vaults) ? Object.values(doc.vaults) : []
  for (const entry of given) {
    const name = entry !== null && typeof entry === 'object' ? folderName(entry.path) : null
    if (name !== null) vaults.push({ name, path: entry.path })
  }
  return { state: 'ok', vaults }
}

// The vaults that were named and are here, ready to open: { name, level, path }. `status` is
//   none         nothing is named, or nothing named is on this computer (Obsidian is not here, or the vault is
//                on another computer) - the ordinary answer, and Obsidian's list is not opened at all if
//                nothing is named
//   unavailable  vaults.yml or Obsidian's list could not be read
//   found        one or more, with `hidden` counting what was named and is here but cannot be opened (two
//                vaults with one folder name, a place that is gone, a file, a link, a name the board would
//                refuse) and `more` what was named past the cap
export async function findNamedVaults(deps, dataDir) {
  const fs = fsOf(deps)
  const identity = deps.identity ?? {}
  const config = await readVaultsYml(dataDir, identity, fs)
  if (config.state === 'broken') return { status: 'unavailable', vaults: [], hidden: 0, more: 0 }
  if (!config.entries.length) return { status: 'none', vaults: [], hidden: config.hidden, more: config.more }
  const listed = await listObsidianVaults(deps)
  if (listed.state === 'broken') return { status: 'unavailable', vaults: [], hidden: 0, more: 0 }

  const found = []
  let hidden = config.hidden
  for (const entry of config.entries) {
    const matches = listed.vaults.filter((vault) => normal(vault.name) === normal(entry.name))
    if (!matches.length) continue
    // Two vaults with one folder name cannot be told apart from vaults.yml, and a guess would open one
    // the owner did not mean.
    if (matches.length > 1) {
      hidden += 1
      continue
    }
    const [vault] = matches
    let usable = false
    try {
      const info = await fs.lstat(vault.path)
      usable = info.isDirectory() && !info.isSymbolicLink()
    } catch {
      usable = false
    }
    if (!usable || checkConnectionName(vault.name, 'name', identity).length) {
      hidden += 1
      continue
    }
    found.push({ name: vault.name, level: entry.level, path: vault.path })
  }
  if (!found.length && !hidden) return { status: 'none', vaults: [], hidden: 0, more: config.more }
  return { status: 'found', vaults: found, hidden, more: config.more }
}
