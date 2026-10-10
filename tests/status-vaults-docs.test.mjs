import test from 'node:test'
import assert from 'node:assert/strict'
import { read, exists } from './helpers/repo.mjs'
import { parseSimpleYaml } from '../scripts/lib/yaml-lite.mjs'
import {
  VAULTS_CAPS,
  VAULTS_SCHEMA,
  VAULTS_FOLDER,
  VAULTS_STALE_AFTER_DAYS,
  VAULTS_MAX_FILE_BYTES,
  NOTE_MAX_BYTES,
  VAULT_BYTES_BUDGET,
  REWRITE_AFTER_HOURS,
  MAX_TAGS_PER_NOTE,
  TITLE_RULE
} from '../scripts/lib/status/vaults-schema.mjs'
import { WALK_LIMITS, VAULTS_YML } from '../scripts/lib/status/vaults.mjs'

/* The memory graph collector's paperwork: the status README (the file, what is read, the two levels, the title
   rule, the caps, when it is written, what is never written, what moving the pin adds, what is not verified),
   the vaults.yml starter the owner edits by asking Claude, and the paragraph in the main README. Each is held to
   the code: the words are the contract's and the numbers are the code's. */

const flat = (text) => text.replace(/\s+/g, ' ')
const section = (text, heading) => {
  const start = text.indexOf(heading)
  assert.ok(start >= 0, `no section ${heading}`)
  const next = text.indexOf('\n## ', start + heading.length)
  return text.slice(start, next < 0 ? undefined : next)
}
const kb = (bytes) => `${bytes / 1024} KB`
const thousands = (number) => number.toLocaleString('en-US')

test('the status README lists the vaults file with its schema, folder and contract, and says there are five parts', async () => {
  const doc = await read('.agent-team/status/README.md')
  for (const phrase of [
    '**vaults**',
    '.agent-team/status/vaults/<computer>.json',
    VAULTS_SCHEMA,
    VAULTS_FOLDER,
    '--only usage,connections,hermes,jobs,vaults',
    '--only vaults --dry-run',
    'tests/fixtures/vaults-parity.json',
    'scripts/lib/status/vaults-schema.mjs',
    '[`vaults.yml`](../../vaults.yml)'
  ]) {
    assert.ok(doc.includes(phrase), `the status README does not mention ${phrase}`)
  }
  assert.ok(await exists('vaults.yml'), 'the README links to a vaults.yml that is not there')
})

test('the vaults section says which vaults are opened, where Obsidian keeps its list on each system, and what is read from a note', async () => {
  const doc = flat(section(await read('.agent-team/status/README.md'), '## The vaults file'))
  assert.match(doc, /Only a vault you name in .*vaults\.yml.* is ever opened/)
  assert.match(doc, /not listed, not counted and not mentioned/)
  for (const phrase of [
    '~/Library/Application Support/obsidian/obsidian.json',
    '%APPDATA%\\obsidian\\obsidian.json',
    '~/.config/obsidian/obsidian.json',
    'only when a vault is named',
    'never a link',
    '.obsidian',
    '.trash',
    'node_modules',
    '`date` and `created`',
    '`tags`, `tag`, `project` and `people`',
    'Two vaults with one folder name'
  ]) {
    assert.ok(doc.includes(phrase), `the vaults section does not mention ${phrase}`)
  }
  assert.match(doc, /What a note says is never kept, at either level/i)
  assert.match(doc, /place is used to open the vault and is never kept/)
  assert.match(doc, /holds the username/)
})

test('the vaults section gives the numbers the code uses', async () => {
  const doc = flat(section(await read('.agent-team/status/README.md'), '## The vaults file'))
  assert.match(doc, new RegExp(`${VAULTS_CAPS.vaults} vaults,? ${VAULTS_CAPS.notes} notes,? ${thousands(VAULTS_CAPS.lines)} lines and ${VAULTS_CAPS.hubs} hubs`))
  assert.match(doc, new RegExp(`${kb(NOTE_MAX_BYTES)}`))
  assert.match(doc, new RegExp(`${kb(VAULT_BYTES_BUDGET)} for a vault`))
  assert.match(doc, new RegExp(`under ${kb(VAULTS_MAX_FILE_BYTES)}`))
  assert.match(doc, new RegExp(`${WALK_LIMITS.depth} folders deep and ${thousands(WALK_LIMITS.entries)} entries`))
  assert.match(doc, new RegExp(`${REWRITE_AFTER_HOURS} hours old`))
  assert.match(doc, new RegExp(`stale\\s+after ${VAULTS_STALE_AFTER_DAYS} days`))
  assert.match(doc, new RegExp(`up to ${VAULTS_YML.maxBytes / 1024} KB`))
  assert.match(doc, /first eight tags/)
  assert.equal(MAX_TAGS_PER_NOTE, 8)
  assert.match(doc, /Three vaults at most/)
  assert.equal(VAULTS_CAPS.vaults, 3)
})

test('the vaults section explains the two levels, the title rule and what was left out', async () => {
  const doc = flat(section(await read('.agent-team/status/README.md'), '## The vaults file'))
  assert.match(doc, /`level: shape` \(the default\)/)
  assert.match(doc, /`level: titles`/)
  assert.match(doc, /Only the exact word `titles` turns it on/)
  assert.match(doc, new RegExp(`${TITLE_RULE.maxLength} characters at most`))
  assert.match(doc, new RegExp(`stretch of ${TITLE_RULE.maxSegmentLength + 1} characters`))
  for (const fragment of ['`@`', '`/`', '`\\`', '`eyj`', '`sk-`', '`bearer`']) assert.ok(doc.includes(fragment), `the title rule leaves out ${fragment}`)
  assert.match(doc, /owner's username, computer name or home folder/)
  assert.match(doc, /counted in `untitled`/)
  for (const word of ['`hidden`', '`more`', '`moreLines`', '`lonely`']) assert.ok(doc.includes(word), `the vaults section does not explain ${word}`)
  assert.match(doc, /tag lines go\s+first, then day lines, then mentions, then links/)
  assert.match(doc, /a hub left with fewer than two lines goes with them/)
  assert.match(doc, /the hubs go first, then the last notes, a tenth at a time/)
})

test('the vaults section says when the file is written, and why', async () => {
  const doc = flat(section(await read('.agent-team/status/README.md'), '## The vaults file'))
  assert.match(doc, /is \*\*not rewritten\*\* until that one is 24 hours old/)
  assert.match(doc, /about 2 MB a day/)
  assert.match(doc, /If nothing is named, \*\*no file is written at all\*\*/)
  assert.match(doc, /replaced once by one that says `not found`/)
  assert.match(doc, /`could not be read`/)
  assert.match(doc, /`refused by the safety check`/)
  assert.match(doc, /a vaults file the safety check refuses is written as unavailable and the other files are still written/)
})

test('the vaults section shows how to name a vault, and that the board never writes vaults.yml', async () => {
  const doc = flat(section(await read('.agent-team/status/README.md'), '## The vaults file'))
  assert.match(doc, /### How to name a vault/)
  assert.match(doc, /add my Second Brain vault to the memory graph/)
  assert.match(doc, /show titles for my Ideas vault/)
  assert.match(doc, /never writes `vaults\.yml`/)
  assert.match(doc, /npm run collect:status -- --only vaults/) // spawn-scan: not a run
})

test('the never-written list covers a note\'s text, the dot folders, unnamed vaults and the vault\'s place', async () => {
  const doc = flat(section(await read('.agent-team/status/README.md'), '## What is never written'))
  const vaults = doc.slice(doc.indexOf('from vaults:'))
  assert.ok(vaults.length > 20, 'no "from vaults" item')
  for (const phrase of ['what a note says', 'its text', 'its headings', 'frontmatter', 'its path', '.obsidian', '.trash', 'never opened', 'a vault you did not name', "the vault's place", 'Obsidian\'s ids', 'at the `shape` level, any title']) {
    assert.ok(vaults.includes(phrase), `the never-written list leaves out ${phrase}`)
  }
})

test('the receipts paragraph names the vaults sources, as a status and a count', async () => {
  const doc = flat(section(await read('.agent-team/status/README.md'), '## Receipts'))
  assert.match(doc, /for vaults: its status and how many vaults were listed/)
})

test('the Mac schedule note says what moving the pin to the memory-graph version adds, what it costs, and how to keep it out', async () => {
  const doc = await read('.agent-team/status/README.md')
  const start = doc.indexOf('### What changes when you move the pin to the memory-graph version')
  assert.ok(start > 0)
  const note = flat(doc.slice(start, doc.indexOf('\n### ', start + 1)))
  assert.match(note, /adds one more part/)
  assert.match(note, /\*\*vaults\*\*/)
  assert.match(note, /from the data clone/)
  assert.match(note, /If nothing is named there, that is all it does/)
  assert.match(note, /opens neither Obsidian's list nor any vault, and writes no file/)
  assert.match(note, /up to 600 `\.md` notes in memory/)
  assert.match(note, /runs no program, and keeps no note text/)
  // The cost, as measured: time and files read, with the honest caveat that the Mac has not run it.
  assert.match(note, /measured on the build PC/)
  assert.match(note, /the Mac has not run it yet/)
  assert.match(note, /602 files read/)
  assert.match(note, /1,802 files read/)
  assert.match(note, /`usage,connections,hermes,jobs` leaves out only the vaults part/)
  assert.match(note, /vaults: \[\]/)
})

test('what is not verified about the memory graph is said, not assumed', async () => {
  const doc = await read('.agent-team/status/README.md')
  const unverified = flat(doc.slice(doc.lastIndexOf('### Not verified yet')))
  for (const phrase of ['the memory graph on the Mac', 'obsidian.json', 'Documents, Desktop or iCloud Drive', 'counted in `hidden`', 'the numbers above are from the build PC']) {
    assert.ok(unverified.includes(phrase), `the not-verified list leaves out ${phrase}`)
  }
})

test('the main README tells a reader the memory graph exists, what it never publishes, and where to read how it works', async () => {
  const readme = await read('README.md')
  const graph = section(readme, '## The memory graph')
  assert.match(graph, /only the vaults you name/i)
  assert.match(graph, /vaults\.yml/)
  assert.match(graph, /numbers and anonymous dots only/)
  assert.match(graph, /titles/)
  assert.match(graph, /never publishes what a note says/)
  assert.match(graph, /\.agent-team\/status\/README\.md#the-vaults-file/)
})

test('the vaults.yml starter names nothing, shows the two levels, says what each shares, and has no inline comments', async () => {
  const text = await read('vaults.yml')
  assert.deepEqual(parseSimpleYaml(text), { vaults: [] })
  assert.match(text, /^vaults: \[\]$/m)
  assert.match(text, /Only a vault named here is ever opened/)
  assert.match(text, /shape\s+\(the default\)/)
  assert.match(text, /^#\s+titles\s/m)
  assert.match(text, /Only the exact word titles turns titles on/)
  assert.match(text, new RegExp(`At most ${VAULTS_CAPS.vaults} vaults are read, and from each up to ${VAULTS_CAPS.notes} notes`))
  assert.match(text, new RegExp(`over ${NOTE_MAX_BYTES / 1024} KB`))
  assert.match(text, /It never writes it, so you change it by asking Claude/)
  // The collector's reader does not strip a comment after a value, so a line that is not a comment holds none.
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    assert.ok(!line.includes('#'), `an inline comment: ${line}`)
  }
  assert.ok(Buffer.byteLength(text) < VAULTS_YML.maxBytes)
})

test('the commented examples in the starter are what they say: uncommented, they name two vaults at two levels', async () => {
  const text = await read('vaults.yml')
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.startsWith('# vaults:'))
  assert.ok(start > 0, 'no example')
  const example = []
  for (const line of lines.slice(start)) {
    if (!line.startsWith('#')) break
    example.push(line.replace(/^# ?/, ''))
  }
  assert.deepEqual(parseSimpleYaml(example.join('\n')), { vaults: [{ name: 'Second Brain' }, { name: 'Ideas', level: 'titles' }] })
})
