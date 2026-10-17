// The vaults part: the memory graph - each Obsidian vault the owner names, as dots and lines.
//
// Which vaults - the computer decides, the team repo can only narrow. The team repo is pushed to by other
// people and by cloud routines, so what it says cannot be what lets a vault leave this computer: a pusher
// could name any vault on the Mac and ask for its titles. The same principle as the pinned code checkout.
// So there are two files:
//   allowed-vaults.yml  in the collector's state folder - outside both the code checkout and the data
//                       clone, and the collector refuses a state folder inside the clone. Written by the
//                       person at this computer. It names each vault that may be read and the most that may
//                       leave: `shape` (the default - counts and anonymous dots and lines) or `titles` (also
//                       each note's title, its top folder, its day and its tags). No file: nothing is read.
//   vaults.yml          in the team repo (the collector reads the data clone's copy). It names the vaults to
//                       draw. It can drop a vault, or ask for less than the allowlist allows; it cannot add
//                       a vault the allowlist does not name, and it cannot raise a level. A vault nobody
//                       named is never opened: not listed, not counted, not mentioned. The board never
//                       writes vaults.yml; the owner asks Claude, as with jobs.yml.
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
import {
  VAULTS_CAPS,
  VAULTS_SCHEMA,
  VAULTS_WHY,
  VAULTS_MAX_FILE_BYTES,
  REWRITE_AFTER_HOURS,
  NOTE_MAX_BYTES,
  VAULT_BYTES_BUDGET,
  EDGE_KINDS,
  MIN_HUB_NOTES,
  MAX_TAGS_PER_NOTE
} from './vaults-schema.mjs'
import { checkConnectionName, isNoteTitle, isRealDay } from './safe.mjs'
import { isoSeconds } from './util.mjs'

export const VAULTS_YML = { file: 'vaults.yml', maxBytes: 64 * 1024 }
export const ALLOWED_VAULTS = { file: 'allowed-vaults.yml', maxBytes: 64 * 1024 }
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

// The level a file asks for: `shape` unless it is exactly the word `titles` - a typo, a capital or a list keeps
// the vault at the level that shares less.
const levelOf = (value) => (value === 'titles' ? 'titles' : 'shape')
const nameOf = (item) => (item !== null && typeof item === 'object' && !Array.isArray(item) && typeof item.name === 'string' ? item.name : null)

// The allowlist: `vaults:` and, for each, a `name:` and the most it may show (`level:`, `shape` unless it says
// exactly `titles`). { state, allowed } - `allowed` maps a name (without regard to case) to its most. 'missing'
// is no file, or no folder: nothing is allowed. 'ok' with nothing in `allowed` is `vaults: []`: the person said
// so, in so many words. 'broken' is anything else that is not an allowlist - a link, a folder, a file that is
// too big, empty, a comment, a typo for the key, `vaults` that is not a list, a list with no usable name: also
// nothing is allowed - never "everything" - and the part says unavailable. The YAML reader forgives almost any
// text and gives back nothing for it, which must not be taken for "nothing is allowed". A name the board would
// refuse allows nothing; a name listed twice gets the lower of its levels.
export async function readAllowedVaults(stateDir, identity = {}, fs = realFs) {
  const none = { allowed: new Map() }
  if (typeof stateDir !== 'string') return { state: 'missing', ...none }
  const file = await readSmall(fs, join(stateDir, ALLOWED_VAULTS.file), ALLOWED_VAULTS.maxBytes)
  if (file.state !== 'ok') return { state: file.state, ...none }
  let doc
  // WHY this catch stays although nothing can reach it today: parseSimpleYaml hands back {} for any text it cannot
  // use and does not throw (40,000 random files tried), so a file that is not an allowlist is caught by the check
  // below, not here. The catch is for the day the reader is swapped for a strict one: a file it refuses must be
  // "broken" - unavailable, nothing read - and not an error that stops the run. Nothing tests it, because
  // nothing can make it run.
  try {
    doc = parseSimpleYaml(file.text)
  } catch {
    return { state: 'broken', ...none }
  }
  if (!Array.isArray(doc?.vaults)) return { state: 'broken', ...none }
  const allowed = new Map()
  for (const item of doc.vaults) {
    const name = nameOf(item)
    if (name === null || checkConnectionName(name, 'name', identity).length) continue
    const key = normal(name)
    const level = levelOf(item.level)
    allowed.set(key, allowed.get(key) === 'shape' || level === 'shape' ? 'shape' : 'titles')
  }
  if (doc.vaults.length && !allowed.size) return { state: 'broken', ...none }
  return { state: 'ok', allowed }
}

// vaults.yml: `vaults:` and, for each, a `name:` and optionally a `level:` (see levelOf). An entry that cannot
// be used (no name, a name the board would refuse, a bare word) is counted in `hidden` and never guessed at; the
// same vault twice is one; three are read and the rest counted in `more`.
//
// With `allowed` (readAllowedVaults) it can only narrow: a vault the allowlist does not name is dropped and
// counted in `ignored` (before the three are counted, so junk in front does not push a real vault out), and a
// level above the allowlist's most is brought down to it and counted in `lowered`. Without it, it filters nothing.
export async function readVaultsYml(dataDir, identity = {}, fs = realFs, allowed = null) {
  const none = { entries: [], hidden: 0, more: 0, ignored: 0, lowered: 0 }
  const file = await readSmall(fs, join(dataDir, VAULTS_YML.file), VAULTS_YML.maxBytes)
  if (file.state !== 'ok') return { state: file.state, ...none }
  let doc
  // WHY this catch stays although nothing can reach it today: see readAllowedVaults - the reader does not throw.
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
  let ignored = 0
  let lowered = 0
  for (const item of listed) {
    const name = nameOf(item)
    if (name === null || checkConnectionName(name, 'name', identity).length) {
      hidden += 1
      continue
    }
    const key = normal(name)
    if (seen.has(key)) continue
    seen.add(key)
    let level = levelOf(item.level)
    let wasLowered = false
    if (allowed) {
      const most = allowed.get(key)
      if (most === undefined) {
        ignored += 1
        continue
      }
      if (level === 'titles' && most === 'shape') {
        level = 'shape'
        wasLowered = true
      }
    }
    if (entries.length >= VAULTS_CAPS.vaults) {
      more += 1
      continue
    }
    entries.push({ name, level })
    if (wasLowered) lowered += 1
  }
  return { state: 'ok', entries, hidden, more, ignored, lowered }
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

// The vaults that may be read, were named and are here, ready to open: { name, level, path }. `deps.stateDir`
// is the folder the allowlist is in. `status` is
//   none         nothing is allowed (no allowlist, or one that names nothing - `allowlist` says which), nothing
//                allowed is named, or nothing named is on this computer (Obsidian is not here, or the vault is
//                on another computer) - the ordinary answer. Nothing is allowed: not so much as vaults.yml is
//                read. Nothing is named: Obsidian's list is not opened at all
//   unavailable  the allowlist, vaults.yml or Obsidian's list could not be read
//   found        one or more, with `hidden` counting what was named and is here but cannot be opened (two
//                vaults with one folder name, a place that is gone, a file, a link, a name the board would
//                refuse) and `more` what was named past the cap
// `ignored` counts what vaults.yml named that the allowlist does not, and `lowered` what it asked to show with
// titles where the allowlist allows only dots (see readVaultsYml).
export async function findNamedVaults(deps, dataDir) {
  const fs = fsOf(deps)
  const identity = deps.identity ?? {}
  const outcome = (status, fields = {}) => ({ status, vaults: [], hidden: 0, more: 0, ignored: 0, lowered: 0, allowlist: 'ok', ...fields })
  const permitted = await readAllowedVaults(deps.stateDir, identity, fs)
  if (permitted.state === 'broken') return outcome('unavailable', { allowlist: 'broken' })
  if (permitted.state === 'missing') return outcome('none', { allowlist: 'missing' })
  if (!permitted.allowed.size) return outcome('none', { allowlist: 'empty' })
  const config = await readVaultsYml(dataDir, identity, fs, permitted.allowed)
  if (config.state === 'broken') return outcome('unavailable')
  const counted = { more: config.more, ignored: config.ignored, lowered: config.lowered }
  if (!config.entries.length) return outcome('none', { ...counted, hidden: config.hidden })
  const listed = await listObsidianVaults(deps)
  if (listed.state === 'broken') return outcome('unavailable')

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
  if (!found.length && !hidden) return outcome('none', counted)
  return outcome('found', { ...counted, vaults: found, hidden })
}

// ---- finding the links in a note's text -------------------------------------------------------------------
//
// What a link is, and what it reaches, follows Obsidian (tests/fixtures/vaults-parity.json, "resolution",
// holds the table the board mirrors for the team repo):
//   [[Note]], [[Note|alias]], [[Note#Heading]], [[Note^block]], ![[Note]]   a "link" (an embed of a note is one)
//   [text](path/Note.md)                                                    a "mention"
// Code is not text: a fenced block or an inline code span is left out first. A line is a pair of notes and
// a kind - however often, and whichever way round, it is written, it is one line.

// An opening fence is three or more backticks or tildes at the start of a line (up to three spaces in).
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/
// Backticks of one length around some text on one line: the same number must close it.
const INLINE_CODE = /(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g
const WIKILINK = /!?\[\[([^[\]\n]*)\]\]/g
// "](" and a destination: <angle brackets> (spaces allowed), or a run without spaces or brackets, then
// an optional title in quotes.
const MARKDOWN_LINK = /\]\(\s*(?:<([^<>\n]*)>|([^\s()<>]*))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g

function withoutCode(text) {
  const kept = []
  let fence = null
  for (const line of text.split('\n')) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line)
      if (close && close[1][0] === fence.character && close[1].length >= fence.length) fence = null
      kept.push('')
      continue
    }
    const open = FENCE_OPEN.exec(line)
    // A backtick fence's description cannot hold a backtick; if it does, this is inline code, not a fence.
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { character: open[1][0], length: open[1].length }
      kept.push('')
      continue
    }
    kept.push(line)
  }
  return kept.join('\n').replace(INLINE_CODE, ' ')
}

// The note a wikilink names: before the alias (also when a table escapes the bar), the heading and the block.
function wikiTarget(inside) {
  return inside.split(/\\?\|/, 1)[0].split('#', 1)[0].split('^', 1)[0].trim()
}

// The path a markdown link goes to, or null if it is an address, not a note, or not written as a note's path.
function markdownTarget(destination) {
  let target = destination.trim().split('#', 1)[0].split('?', 1)[0]
  try {
    target = decodeURIComponent(target)
  } catch {
    // Not valid percent-encoding: it is the path as written.
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) return null
  return /\.md$/i.test(target) ? target : null
}

// Every link in the text, in the order written: [{ kind: 'link' | 'mention', target }].
export function extractLinks(text) {
  const clean = withoutCode(text)
  const found = []
  for (const match of clean.matchAll(WIKILINK)) {
    const target = wikiTarget(match[1])
    if (target) found.push({ at: match.index, kind: 'link', target })
  }
  for (const match of clean.matchAll(MARKDOWN_LINK)) {
    const target = markdownTarget(match[1] ?? match[2] ?? '')
    if (target) found.push({ at: match.index, kind: 'mention', target })
  }
  return found.sort((first, second) => first.at - second.at).map(({ kind, target }) => ({ kind, target }))
}

// ---- which note a link reaches -----------------------------------------------------------------------------

const keyOf = (path) => path.normalize('NFC').toLowerCase()
const withoutExtension = (value) => value.replace(/\.md$/i, '')

// The order of the dots: by path without regard to case, then by the path itself. Code units, not the
// locale, so every computer gives the same order.
function byPath(first, second) {
  const a = keyOf(first)
  const b = keyOf(second)
  if (a !== b) return a < b ? -1 : 1
  return first < second ? -1 : first > second ? 1 : 0
}

export const noteOrder = (paths) => [...paths].sort(byPath)

// Two notes with one name: the one with the fewest folders, then the shortest path, then the first in order.
function closest(first, second) {
  return first.depth - second.depth || first.path.length - second.path.length || byPath(first.path, second.path)
}
const closestOf = (entries) => entries.reduce((best, entry) => (closest(entry, best) < 0 ? entry : best))

function makeResolver(paths) {
  const byFull = new Map()
  const byName = new Map()
  const add = (map, key, entry) => {
    const list = map.get(key)
    if (list) list.push(entry)
    else map.set(key, [entry])
  }
  for (const path of paths) {
    const full = withoutExtension(keyOf(path))
    const entry = { path, full, depth: path.split('/').length }
    add(byFull, full, entry)
    add(byName, full.slice(full.lastIndexOf('/') + 1), entry)
  }
  return {
    // [[Name]] or [[Folder/Name]]: a bare name is any note of that name, wherever it is; a name with folders
    // in it must be the whole path from the root or the end of a longer one. The closest wins (see `closest`),
    // so a full path is always preferred to the same words at the end of a deeper path.
    byName(target) {
      const name = withoutExtension(keyOf(target)).trim()
      const sameName = byName.get(name.slice(name.lastIndexOf('/') + 1)) ?? []
      const reached = name.includes('/') ? sameName.filter((entry) => entry.full === name || entry.full.endsWith(`/${name}`)) : sameName
      return reached.length ? closestOf(reached).path : null
    },
    // [x](path/Note.md): from the folder of the note it is written in, or from the root if it starts with a slash.
    byPath(from, target) {
      const segments = []
      const start = target.startsWith('/') ? [] : from.split('/').slice(0, -1)
      for (const part of [...start, ...target.split('/')]) {
        if (part === '' || part === '.') continue
        if (part === '..') {
          if (!segments.length) return null
          segments.pop()
          continue
        }
        segments.push(part)
      }
      const exact = byFull.get(withoutExtension(keyOf(segments.join('/'))))
      return exact ? closestOf(exact).path : null
    }
  }
}

// ---- what a note says about itself: its day and its tags --------------------------------------------------
//
// Only the frontmatter at the very top of a note is read, and only for `date`, `created` (the day) and
// `tags`, `tag`, `project`, `people` (the tags). Everything else in it - a title, a key, a password somebody
// pasted - is never looked at, and nothing read here is kept except a day and the tags that pass the title rule.

const FRONTMATTER_MAX = 32 * 1024
const FRONTMATTER = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/
const TAG_KEYS = new Set(['tags', 'tag', 'project', 'people'])
const DAY_KEYS = ['date', 'created']

function frontmatterLines(text) {
  const head = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).slice(0, FRONTMATTER_MAX).replace(/\r\n?/g, '\n')
  const match = FRONTMATTER.exec(head)
  return match ? match[1].split('\n') : []
}

// One value as Obsidian writes it: quotes, a leading hash, or a link, taken off.
function cleanValue(raw) {
  let value = raw.trim().replace(/^(["'])(.*)\1$/, '$2').trim()
  const link = /^\[\[([^\]|]*)(?:\|[^\]]*)?\]\]$/.exec(value)
  if (link) value = link[1].trim()
  return value.replace(/^#/, '').trim()
}

// What follows `key:` on the same line: a [list, of, values], one link, or values separated by commas.
function inlineValues(raw) {
  let inner = raw.trim()
  if (/^\[\[[^\]]*\]\]$/.test(inner)) return [cleanValue(inner)]
  if (inner.startsWith('[') && inner.endsWith(']')) inner = inner.slice(1, -1)
  return inner.split(',').map(cleanValue).filter(Boolean)
}

// { key (lower case): [values] } in the order the keys first appear.
function readProperties(lines) {
  const properties = new Map()
  let current = null
  for (const line of lines) {
    const pair = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (pair) {
      current = pair[1].toLowerCase()
      if (!properties.has(current)) properties.set(current, [])
      if (pair[2].trim()) properties.get(current).push(...inlineValues(pair[2]))
      continue
    }
    const item = /^[ \t]*-[ \t]+(.*)$/.exec(line)
    if (item && current) {
      const value = cleanValue(item[1])
      if (value) properties.get(current).push(value)
    }
  }
  return properties
}

const DAY_PREFIX = /^(\d{4}-\d{2}-\d{2})(?!\d)/

function dayOf(name, properties) {
  const candidates = [name, ...DAY_KEYS.flatMap((key) => properties.get(key)?.slice(0, 1) ?? [])]
  for (const candidate of candidates) {
    const match = DAY_PREFIX.exec(candidate)
    if (match && isRealDay(match[1])) return match[1]
  }
  return undefined
}

function tagsOf(properties, identity) {
  const found = []
  const seen = new Set()
  for (const [key, values] of properties) {
    if (!TAG_KEYS.has(key)) continue
    for (const value of values) {
      const lower = value.toLowerCase()
      if (seen.has(lower) || !isNoteTitle(value, identity)) continue
      seen.add(lower)
      found.push(value)
    }
  }
  return found.slice(0, MAX_TAGS_PER_NOTE)
}

// ---- from notes to dots and lines --------------------------------------------------------------------------

const KIND_NUMBER = Object.fromEntries(EDGE_KINDS.map((kind, number) => [kind, number]))
const byLine = (first, second) => first[2] - second[2] || first[0] - second[0] || first[1] - second[1]

// What the shape of a vault may hold of its own size, besides the caps in the contract.
const DEFAULT_LIMITS = { ...VAULTS_CAPS, bytes: VAULT_BYTES_BUDGET }

// Days first, in order; then tags by name without regard to case. Each is a hub only if two or more of the
// first `count` notes share it.
function makeHubs(info, count) {
  const days = new Map()
  const tags = new Map()
  for (let note = 0; note < count; note += 1) {
    const { day, tags: noteTags } = info[note]
    if (day !== undefined) {
      if (!days.has(day)) days.set(day, [])
      days.get(day).push(note)
    }
    for (const tag of noteTags) {
      const key = tag.toLowerCase()
      if (!tags.has(key)) tags.set(key, { label: tag, members: [] })
      tags.get(key).members.push(note)
    }
  }
  const hubs = []
  for (const day of [...days.keys()].sort()) {
    if (days.get(day).length >= MIN_HUB_NOTES) hubs.push({ kind: 'day', label: day, members: days.get(day) })
  }
  for (const key of [...tags.keys()].sort()) {
    const { label, members } = tags.get(key)
    if (members.length >= MIN_HUB_NOTES) hubs.push({ kind: 'tag', label, members })
  }
  return hubs
}

// The dots and lines for the first `count` notes. Lines are cut to `lineCap` from the end, so tags go first,
// then days, then mentions, then links; a hub left with fewer than two lines goes with them and the hubs
// after it are renumbered.
function compose({ links, info, count, withHubs, hubCap, lineCap }) {
  let hubs = withHubs ? makeHubs(info, count).slice(0, hubCap) : []
  let edges = links.filter((line) => line[1] < count)
  hubs.forEach((hub, index) => {
    for (const member of hub.members) edges.push([member, count + index, KIND_NUMBER[hub.kind]])
  })
  edges.sort(byLine)
  edges = edges.slice(0, lineCap)
  const spokes = hubs.map(() => 0)
  for (const [, to, kind] of edges) {
    if (kind >= KIND_NUMBER.day) spokes[to - count] += 1
  }
  if (spokes.some((spoke) => spoke < MIN_HUB_NOTES)) {
    const renumbered = []
    let next = 0
    spokes.forEach((spoke, index) => {
      renumbered[index] = spoke >= MIN_HUB_NOTES ? next++ : -1
    })
    edges = edges.filter(([, to, kind]) => kind < KIND_NUMBER.day || renumbered[to - count] >= 0)
      .map(([from, to, kind]) => (kind < KIND_NUMBER.day ? [from, to, kind] : [from, count + renumbered[to - count], kind]))
    hubs = hubs.filter((hub, index) => renumbered[index] >= 0)
  }
  return { hubs, edges }
}

// A vault as it is published, from its notes: [{ path, text }] with paths from the vault's root, '/' between
// folders. `knownPaths` are all the paths in the vault, read or not, so a name is looked up among them all (a
// link to a note that was not read draws nothing, and is not made to a look-alike). `hidden` and `more` are
// what the walk left out, to be added to.
export function buildVaultItem({ name, level, notes, knownPaths, hidden = 0, more = 0 }, identity = {}, limits = {}) {
  const caps = { ...DEFAULT_LIMITS, ...limits }
  const titles = level === 'titles'
  const ordered = noteOrder(notes.map((entry) => entry.path))
  const textOf = new Map(notes.map((entry) => [entry.path, entry.text]))
  const distinct = [...new Set(ordered)]
  const keptPaths = distinct.slice(0, caps.notes)
  const keptCount = keptPaths.length
  const baseMore = more + (distinct.length - keptCount)

  const resolver = makeResolver([...new Set([...(knownPaths ?? []), ...ordered])])
  const indexByPath = new Map(keptPaths.map((path, index) => [path, index]))
  const seen = new Set()
  const links = []
  const info = keptPaths.map((path, from) => {
    const text = textOf.get(path)
    for (const link of extractLinks(text)) {
      const reached = link.kind === 'link' ? resolver.byName(link.target) : resolver.byPath(path, link.target)
      const to = reached === null ? undefined : indexByPath.get(reached)
      if (to === undefined || to === from) continue
      const line = [Math.min(from, to), Math.max(from, to), KIND_NUMBER[link.kind]]
      const key = line.join(',')
      if (seen.has(key)) continue
      seen.add(key)
      links.push(line)
    }
    if (!titles) return { tags: [] }
    const file = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
    const properties = readProperties(frontmatterLines(text))
    const folder = path.includes('/') ? path.slice(0, path.indexOf('/')) : undefined
    return {
      title: isNoteTitle(file, identity) ? file : undefined,
      folder: folder !== undefined && isNoteTitle(folder, identity) ? folder : undefined,
      day: dayOf(file, properties),
      tags: tagsOf(properties, identity)
    }
  })

  // Every line the first notes make, before any cap: what `moreLines` is counted against.
  const whole = compose({ links, info, count: keptCount, withHubs: titles, hubCap: Infinity, lineCap: Infinity }).edges.length

  const make = (count, withHubs) => {
    const { hubs, edges } = compose({ links, info, count, withHubs: withHubs && titles, hubCap: caps.hubs, lineCap: caps.lines })
    const linked = new Set()
    for (const [from, to, kind] of edges) {
      if (kind < KIND_NUMBER.day) {
        linked.add(from)
        linked.add(to)
      }
    }
    const item = { name, level, notes: count, lines: edges.length, lonely: count - linked.size, hidden, more: baseMore + (keptCount - count), moreLines: whole - edges.length }
    if (!titles) return { ...item, edges }
    const nodes = info.slice(0, count).map(({ title, folder, day }) => ({
      ...(title !== undefined && { title }),
      ...(folder !== undefined && { folder }),
      ...(day !== undefined && { day })
    }))
    return {
      ...item,
      untitled: nodes.filter((node) => node.title === undefined).length,
      edges,
      nodes,
      hubs: hubs.map(({ kind, label }) => ({ kind, label }))
    }
  }

  // Over the vault's share of the file: the hubs go first, then the last notes, a tenth at a time.
  let count = keptCount
  let item = make(count, true)
  if (vaultBytes(item) > caps.bytes && titles) item = make(count, false)
  while (vaultBytes(item) > caps.bytes && count > 0) {
    count -= Math.max(1, Math.floor(count / 10))
    item = make(count, false)
  }
  return item
}

// ---- the text of the file ---------------------------------------------------------------------------------
//
// The usual two-space JSON, except that a line, a dot and a hub are each a row of their own, so a vault of
// 600 dots and 2,000 lines is rows, not a wall of one-number lines. The size of a vault is counted with the
// same writer, so the budget is what the file really holds.

const ONE_ROW_EACH = new Set(['edges', 'nodes', 'hubs'])

function write(value, depth, key) {
  const inner = '  '.repeat(depth + 1)
  const outer = '  '.repeat(depth)
  if (Array.isArray(value)) {
    if (!value.length) return '[]'
    const rows = value.map((entry) => inner + (ONE_ROW_EACH.has(key) ? JSON.stringify(entry) : write(entry, depth + 1)))
    return `[\n${rows.join(',\n')}\n${outer}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
    if (!entries.length) return '{}'
    return `{\n${entries.map(([name, entry]) => `${inner}${JSON.stringify(name)}: ${write(entry, depth + 1, name)}`).join(',\n')}\n${outer}}`
  }
  return JSON.stringify(value)
}

export const stringifyVaults = (doc) => `${write(doc, 0)}\n`

// What a vault takes in the file: its rows, the indent before them and the comma and line after.
export const vaultBytes = (item) => 8 + Buffer.byteLength(write(item, 3))

// ---- reading a vault off the disk -------------------------------------------------------------------------

// A vault is walked this deep and this many entries wide, then no further.
export const WALK_LIMITS = { depth: 20, entries: 20000 }
const READ_BATCH = 16

// Every note's path (from the vault root, '/' between folders) and how many things were left out: a link
// (never followed - a link is how a loop, or the rest of the disk, gets in), a folder too deep or unreadable,
// or a walk that hit its limit. Dot folders and files (.obsidian, .trash, .git), node_modules and anything
// that is not a .md file are not notes and are not counted. null: the vault's folder could not be listed.
async function walkVault(fs, root, limits) {
  const paths = []
  let hidden = 0
  let visited = 0
  let stopped = false
  async function visit(directory, parents, depth) {
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      if (depth === 0) return false
      hidden += 1
      return true
    }
    for (const entry of entries) {
      if (stopped) return true
      visited += 1
      if (visited > limits.entries) {
        stopped = true
        hidden += 1
        return true
      }
      const { name } = entry
      if (name.startsWith('.') || name === 'node_modules') continue
      if (entry.isSymbolicLink()) {
        hidden += 1
        continue
      }
      if (entry.isDirectory()) {
        if (depth + 1 > limits.depth) {
          hidden += 1
          continue
        }
        await visit(join(directory, name), [...parents, name], depth + 1)
      } else if (entry.isFile() && /\.md$/i.test(name)) {
        paths.push([...parents, name].join('/'))
      }
    }
    return true
  }
  const listed = await visit(root, [], 0)
  return listed ? { paths, hidden } : null
}

// A note's text, in memory, or null if it is a link, too big, or cannot be read. The reason is never kept:
// an error from the file system carries a full path.
async function readNote(fs, root, path) {
  const place = join(root, ...path.split('/'))
  try {
    const info = await fs.lstat(place)
    if (!info.isFile() || info.size > NOTE_MAX_BYTES) return null
    return { path, text: await fs.readFile(place, 'utf8') }
  } catch {
    return null
  }
}

// One named vault, as the item the file holds - or null if its folder cannot be listed.
export async function readVault(vault, deps) {
  const fs = fsOf(deps)
  const walked = await walkVault(fs, vault.path, { ...WALK_LIMITS, ...deps.walkLimits })
  if (walked === null) return null
  const ordered = noteOrder(walked.paths)
  const toRead = ordered.slice(0, VAULTS_CAPS.notes)
  const notes = []
  let hidden = walked.hidden
  for (let start = 0; start < toRead.length; start += READ_BATCH) {
    const batch = await Promise.all(toRead.slice(start, start + READ_BATCH).map((path) => readNote(fs, vault.path, path)))
    for (const read of batch) {
      if (read === null) hidden += 1
      else notes.push(read)
    }
  }
  return buildVaultItem(
    { name: vault.name, level: vault.level, notes, knownPaths: ordered, hidden, more: ordered.length - toRead.length },
    deps.identity ?? {}
  )
}

// What the allowlist did, for the log only: counts and fixed words, never a vault's name. `trail` is the list the
// run keeps apart from the snapshot, so nothing in it can reach a file.
function allowlistLines(named) {
  const lines = []
  if (named.allowlist === 'missing') lines.push(`No allowlist on this computer (${ALLOWED_VAULTS.file} in the state folder), so no vault is read, whatever vaults.yml says.`)
  if (named.allowlist === 'empty') lines.push(`The allowlist on this computer (${ALLOWED_VAULTS.file} in the state folder) names no vault, so none is read.`)
  if (named.allowlist === 'broken') lines.push(`The allowlist on this computer (${ALLOWED_VAULTS.file} in the state folder) could not be read, so nothing is read.`)
  const vaults = (count) => `${count} vault${count === 1 ? '' : 's'}`
  if (named.ignored) {
    lines.push(`${vaults(named.ignored)} named in vaults.yml ${named.ignored === 1 ? 'is' : 'are'} not in this computer's allowlist, so ${named.ignored === 1 ? 'it was' : 'they were'} ignored.`)
  }
  if (named.lowered) {
    lines.push(`${vaults(named.lowered)} asked for titles in vaults.yml but this computer's allowlist allows only dots, so ${named.lowered === 1 ? 'it is' : 'they are'} shown as dots.`)
  }
  return lines
}

// The whole vaults file: the vaults this computer allows, the team repo named and that are on this computer,
// read, or a word for why not. `deps.dataDir` is the folder holding vaults.yml (the team repo, or the
// collector's clone of it); `deps.stateDir` the one holding the allowlist.
export async function collectVaults(deps, computer, trail = []) {
  const envelope = (vaults) => ({ schema: VAULTS_SCHEMA, takenAt: isoSeconds(deps.now), computer, vaults })
  if (typeof deps.dataDir !== 'string') return envelope({ status: 'unavailable', why: VAULTS_WHY.unreadable })
  const named = await findNamedVaults(deps, deps.dataDir)
  trail.push(...allowlistLines(named))
  if (named.status === 'unavailable') return envelope({ status: 'unavailable', why: VAULTS_WHY.unreadable })
  if (named.status === 'none') return envelope({ status: 'not found' })
  const items = []
  let hidden = named.hidden
  for (const vault of named.vaults) {
    let item = null
    try {
      item = await readVault(vault, deps)
    } catch {
      item = null
    }
    if (item === null) hidden += 1
    else items.push(item)
  }
  return envelope({ status: 'found', items, hidden, more: named.more })
}

// ---- when the file need not be written -------------------------------------------------------------------------
//
// A file that says the same as the one already there is not rewritten, until that one is a day old. A vault changes
// slowly, and a 256 KB file written at every three-hourly run is about 2 MB a day of new blobs in the team repo
// before git compresses them: this keeps it to one write a day for a vault that did not change, and one for each
// change. A team that has named no vault gets no file at all.

const graphOf = (doc) => JSON.stringify([doc?.schema, doc?.computer, doc?.vaults])

// Why the file at `relativePath` (in the data folder) is left as it is, or null if it should be written:
//   'nothing named'  there is nothing to draw and no earlier file to replace
//   'unchanged'      the earlier file says the same and is under REWRITE_AFTER_HOURS old
// An earlier file that is a link, too big, not JSON, from the future or without a time is no earlier file.
export async function whyLeaveVaultsAlone(deps, relativePath, doc) {
  if (typeof deps.dataDir !== 'string') return null
  // The earlier file is where the snapshot goes: the data folder, or the --out folder (deps.priorDir) when there is one.
  const read = await readSmall(fsOf(deps), join(deps.priorDir ?? deps.dataDir, ...relativePath.split('/')), VAULTS_MAX_FILE_BYTES)
  if (read.state === 'missing') return doc.vaults?.status === 'not found' ? 'nothing named' : null
  if (read.state !== 'ok') return null
  let earlier
  try {
    earlier = JSON.parse(read.text)
  } catch {
    return null
  }
  const age = deps.now - Date.parse(earlier?.takenAt)
  if (!(age >= 0 && age < REWRITE_AFTER_HOURS * 3600_000)) return null
  return graphOf(earlier) === graphOf(doc) ? 'unchanged' : null
}
