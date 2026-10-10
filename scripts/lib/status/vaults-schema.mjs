// The shape of the vaults snapshot - the memory graph: each Obsidian vault the owner names in
// vaults.yml, as dots and lines - written by the collector and read by the dashboard.
//
// The constants are the shared contract: tests/fixtures/vaults-parity.json holds the same values,
// byte for byte, in agent-cockpit too, and tests/status-vaults-contract.test.mjs fails if this file
// drifts from it. The shape at the bottom is what safe.mjs enforces before anything is written.
//
// A vault is published at one of two levels, chosen by the owner for each vault in vaults.yml:
//   shape   (the default)  the vault's name, counts, and anonymous dots (numbers) joined by lines
//                          (pairs of numbers). No title, folder, tag, date, content or path.
//   titles  (opt-in)       the same, plus each note's title, its top folder and its day, and a hub
//                          dot for each day or tag that two or more notes share - every one held to
//                          the title rule (TITLE_RULE), and a note whose title fails it is an
//                          anonymous dot.
// A note's contents are read in memory to find its links, its day and its tags, and are never kept
// at either level: nothing a note says has a key here, so it cannot reach a file. Neither does the
// vault's location on the computer, which holds the username.

import { computerSlug } from './schema.mjs'

export const VAULTS_SCHEMA = 'agent-status/vaults/v1'
export const VAULTS_FOLDER = '.agent-team/status/vaults'
// What the board holds itself to when it reads these files. A vault changes slowly and the file is
// rewritten at most once a day (REWRITE_AFTER_HOURS), so it goes stale after days, not hours.
export const VAULTS_STALE_AFTER_DAYS = 7
export const VAULTS_MAX_FILES_READ = 5
export const VAULTS_MAX_FILE_BYTES = 256 * 1024

// Three vaults, and for each at most this many notes, lines and hubs.
export const VAULTS_CAPS = { vaults: 3, notes: 600, lines: 2000, hubs: 200 }
// A note bigger than this is not read at all: it is counted as hidden.
export const NOTE_MAX_BYTES = 256 * 1024
// A vault's share of the file. Three of them fit VAULTS_MAX_FILE_BYTES with room for the rest.
export const VAULT_BYTES_BUDGET = 80 * 1024
// A file whose graph has not changed is not rewritten, until it is this old: then the time on it is
// freshened, so the board does not call a quiet vault stale.
export const REWRITE_AFTER_HOURS = 24

export const LEVELS = ['shape', 'titles']
// The order is the contract: an edge's kind is its index here.
export const EDGE_KINDS = ['link', 'mention', 'day', 'tag']
export const HUB_KINDS = ['day', 'tag']
// A day or a tag is a hub only when this many notes share it; one note on its own is a node's day or
// tag, not a dot to draw lines to.
export const MIN_HUB_NOTES = 2
export const MAX_TAGS_PER_NOTE = 8

// The two fixed reasons the block can give for being unavailable. Never a message.
export const VAULTS_WHY = { unreadable: 'could not be read', refused: 'refused by the safety check' }

// What a title (and a top folder, a tag, a hub label) must be to be published. The board holds the
// same rule from tests/fixtures/vaults-parity.json. The only part it cannot hold is the last: only
// the collector knows the owner's username, computer name and home folder.
export const TITLE_RULE = {
  maxLength: 80,
  // Compared without regard to case: an at sign, either slash, the start of a signed token or a key,
  // an authorization header.
  never: ['@', '/', '\\', 'eyj', 'sk-', 'bearer'],
  neverIgnoresCase: true,
  uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/,
  // 24 or more characters without a separator is long enough to be a token.
  maxSegmentLength: 23,
  separatorCharacters: ':._-,;()[]{}\'’"!?#+&*=%|~',
  separatorsAlsoWhitespace: true,
  controlCharacters: /[\u0000-\u001f\u007f-\u009f]/,
  // Characters that take no room, or reorder text, so a title can say one thing and show another.
  invisibleCharacters: /[\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/,
}

export function vaultsPath(label) {
  const slug = computerSlug(label)
  return slug ? `${VAULTS_FOLDER}/${slug}.json` : null
}

// --- the shape safe.mjs walks ----------------------------------------------------------------------

const count = { type: 'count' }
const int = ({ min, max }) => ({ type: 'int', min, max })
const enumOf = (values) => ({ type: 'enum', values })
const noteTitle = { type: 'noteTitle' }

// A dot is a note (below `notes`) or a hub (from `notes`), so the highest number is one under both caps.
const dotNumber = int({ min: 0, max: VAULTS_CAPS.notes + VAULTS_CAPS.hubs - 1 })
const edgeShape = { type: 'tuple', of: [dotNumber, dotNumber, int({ min: 0, max: EDGE_KINDS.length - 1 })] }

const nodeShape = {
  type: 'object',
  keys: { title: noteTitle, folder: noteTitle, day: { type: 'day' } },
  required: []
}

const hubShape = {
  type: 'variant',
  on: 'kind',
  variants: {
    day: { type: 'object', keys: { kind: { type: 'const', value: 'day' }, label: { type: 'day' } }, required: ['kind', 'label'] },
    tag: { type: 'object', keys: { kind: { type: 'const', value: 'tag' }, label: noteTitle }, required: ['kind', 'label'] }
  }
}

if (JSON.stringify(Object.keys(hubShape.variants)) !== JSON.stringify(HUB_KINDS)) {
  throw new Error('vaults-schema.mjs: the hub variants do not match HUB_KINDS')
}

// What the numbers and the lists must say about each other. A problem names the key, never a value.
function vaultProblems(vault) {
  const problems = []
  const titles = vault.level === 'titles'
  if (!titles) {
    for (const key of ['nodes', 'hubs', 'untitled']) {
      if (vault[key] !== undefined) problems.push([key, 'is only allowed at the titles level'])
    }
  } else {
    if (vault.nodes === undefined) problems.push(['nodes', 'is missing'])
    else if (Array.isArray(vault.nodes) && vault.nodes.length !== vault.notes) problems.push(['nodes', 'does not have one entry per note'])
    if (vault.untitled === undefined) problems.push(['untitled', 'is missing'])
    else if (Array.isArray(vault.nodes) && vault.untitled !== vault.nodes.filter((node) => node && typeof node === 'object' && node.title === undefined).length) {
      problems.push(['untitled', 'is not the number of nodes with no title'])
    }
  }
  if (!Array.isArray(vault.edges)) return problems
  if (vault.lines !== vault.edges.length) problems.push(['lines', 'is not the number of edges'])
  if (Number.isInteger(vault.lonely) && Number.isInteger(vault.notes) && vault.lonely > vault.notes) problems.push(['lonely', 'is more than the notes'])

  const hubs = Array.isArray(vault.hubs) ? vault.hubs : []
  const spokes = hubs.map(() => 0)
  vault.edges.forEach((edge, index) => {
    if (!Array.isArray(edge) || edge.length !== 3 || !edge.every(Number.isSafeInteger)) return
    const [from, to, kind] = edge
    const key = `edges[${index}]`
    if (from >= to) problems.push([key, 'from is not below to'])
    if (kind < 2) {
      if (Number.isInteger(vault.notes) && to >= vault.notes) problems.push([key, 'a link or a mention joins two notes'])
      return
    }
    const hub = Number.isInteger(vault.notes) ? hubs[to - vault.notes] : undefined
    if (!titles) problems.push([key, 'a day or tag line needs a hub, and hubs are only at the titles level'])
    else if (!hub || to < vault.notes || from >= vault.notes) problems.push([key, 'a day or tag line goes from a note to a hub'])
    else if (hub.kind !== EDGE_KINDS[kind]) problems.push([key, 'is not the kind of the hub it goes to'])
    else spokes[to - vault.notes] += 1
  })
  hubs.forEach((hub, index) => {
    if (spokes[index] < MIN_HUB_NOTES) problems.push([`hubs[${index}]`, `has fewer than ${MIN_HUB_NOTES} notes`])
  })
  return problems
}

const vaultShape = {
  type: 'object',
  keys: {
    name: { type: 'connName' },
    level: enumOf(LEVELS),
    notes: int({ min: 0, max: VAULTS_CAPS.notes }),
    lines: int({ min: 0, max: VAULTS_CAPS.lines }),
    lonely: count,
    hidden: count,
    more: count,
    moreLines: count,
    untitled: count,
    edges: { type: 'array', of: edgeShape, min: 0, max: VAULTS_CAPS.lines, unique: [] },
    nodes: { type: 'array', of: nodeShape, min: 0, max: VAULTS_CAPS.notes },
    hubs: { type: 'array', of: hubShape, min: 0, max: VAULTS_CAPS.hubs, unique: ['kind', 'label'] }
  },
  required: ['name', 'level', 'notes', 'lines', 'lonely', 'hidden', 'more', 'moreLines', 'edges'],
  rule: vaultProblems
}

export const VAULTS_SHAPE = {
  type: 'object',
  keys: {
    schema: { type: 'const', value: VAULTS_SCHEMA },
    takenAt: { type: 'iso' },
    computer: { type: 'text' },
    vaults: {
      type: 'block',
      found: { items: { type: 'array', of: vaultShape, min: 0, max: VAULTS_CAPS.vaults, unique: ['name'] }, hidden: count, more: count },
      foundRequired: ['items', 'hidden', 'more']
    }
  },
  required: ['schema', 'takenAt', 'computer', 'vaults']
}
