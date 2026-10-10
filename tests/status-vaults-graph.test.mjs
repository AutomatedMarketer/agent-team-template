import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  extractLinks,
  noteOrder,
  buildVaultItem,
  vaultBytes,
  readVault,
  collectVaults,
  stringifyVaults
} from '../scripts/lib/status/vaults.mjs'
import {
  VAULTS_CAPS,
  VAULTS_SCHEMA,
  VAULTS_WHY,
  VAULTS_MAX_FILE_BYTES,
  VAULT_BYTES_BUDGET,
  NOTE_MAX_BYTES,
  EDGE_KINDS
} from '../scripts/lib/status/vaults-schema.mjs'
import { checkVaults } from '../scripts/lib/status/safe.mjs'
import { fakeClaudeToken, FAKE_USERNAME, FAKE_HOSTNAME } from './helpers/fake-home.mjs'
import { team, obsidianHome, recordingFs, allowText } from './helpers/obsidian-home.mjs'

/* From a vault's notes to its dots and lines. The notes are read in memory to find their links, their
   day and their tags, and nothing a note says is kept: the item that comes out holds numbers, and (only at
   the titles level) titles, top folders, days and tags that passed the title rule. */

const fixture = JSON.parse(readFileSync(new URL('./fixtures/vaults-parity.json', import.meta.url), 'utf8'))
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0)
const note = (path, text = '') => ({ path, text })
const build = (notes, extra = {}, identity = {}, limits) => buildVaultItem({ name: 'Vault', level: 'shape', notes, ...extra }, identity, limits)
const buildTitles = (notes, extra = {}, identity = {}, limits) => build(notes, { level: 'titles', ...extra }, identity, limits)
const IDENTITY = { username: FAKE_USERNAME, hostname: FAKE_HOSTNAME, home: `C:\\Users\\${FAKE_USERNAME}` }

/* ---------- the shared fixture: how links are found, and the sample both halves build ----------- */

test('Obsidian resolution table: every case in the shared fixture gives exactly the lines it lists', () => {
  assert.ok(fixture.resolution.cases.length >= 30, 'the table is the contract with the board; it should stay thorough')
  for (const testCase of fixture.resolution.cases) {
    const notes = testCase.notes.map((path) => note(path, path === testCase.from ? testCase.text : ''))
    const item = build(notes)
    const order = noteOrder(testCase.notes)
    const fromIndex = order.indexOf(testCase.from)
    assert.ok(fromIndex >= 0, testCase.why)
    const lines = item.edges.map(([first, second, kind]) => {
      assert.ok(first === fromIndex || second === fromIndex, `${testCase.why}: a line that does not touch the note it was written in`)
      return { to: order[first === fromIndex ? second : first], kind: EDGE_KINDS[kind] }
    })
    assert.deepEqual(lines, testCase.edges, testCase.why)
  }
})

test('the notes the fixture lists build the fixture\'s sample, line for line and key for key', () => {
  assert.equal(fixture.sampleSources.length, fixture.sample.vaults.items.length)
  for (const source of fixture.sampleSources) {
    const expected = fixture.sample.vaults.items.find((item) => item.name === source.name)
    assert.ok(expected, source.name)
    const item = buildVaultItem({ name: source.name, level: source.level, notes: source.notes, hidden: source.hidden, more: source.more }, {})
    assert.deepEqual(item, expected, source.name)
    assert.equal(JSON.stringify(item), JSON.stringify(expected), `${source.name}: the keys are in a different order`)
  }
})

test('the same notes on disk give the same vault: named, read, and the sample comes out, with a note too big counted as hidden', async () => {
  const vaults = {}
  for (const source of fixture.sampleSources) {
    vaults[source.name] = { files: Object.fromEntries(source.notes.map(({ path, text }) => [path, text])) }
  }
  // The fixture says "Field Notes" had one note withheld: here, one over the size a note may be.
  vaults['Field Notes'].files['Huge.md'] = 'x'.repeat(NOTE_MAX_BYTES + 1)
  const home = await obsidianHome('darwin', vaults)
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Field Notes\n  - name: Ideas\n    level: titles\n' })
  try {
    const doc = await collectVaults(home.depsFor({ now: Date.parse(fixture.sample.takenAt), dataDir: dir.dir }), fixture.sample.computer)
    assert.deepEqual(doc, fixture.sample)
    assert.deepEqual(checkVaults(doc, home.identity), [])
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

/* ---------- finding links in a note's text ------------------------------------------------------ */

test('extractLinks: a wikilink is its note name, without the alias, the heading or the block, whatever the spaces', () => {
  const found = extractLinks('[[A]] [[B|my label]] [[C#Heading]] [[D^abc123]] [[E#Heading|label]] ![[F]] [[G\\|escaped in a table]] [[ H ]] [[I.md]]')
  assert.deepEqual(found, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I.md'].map((target) => ({ kind: 'link', target })))
})

test('extractLinks: a wikilink with nothing to find, or one that runs over a line, is nothing', () => {
  assert.deepEqual(extractLinks('[[]] [[|alias]] [[#Heading]] [[ ]] [[A\nB]] [[unclosed'), [])
})

test('extractLinks: a markdown link to a note is a mention with its path cleaned; an address or another file is nothing', () => {
  const found = extractLinks([
    '[a](B.md)', '[b](<Pasta ideas.md>)', '[c](Pasta%20ideas.md)', '[d](B.md#goals)', '[e](B.md?x=1)', '[f](B.md "a title")',
    '[g](../up/B.md)', '[h](/root/B.md)', '[i](B.MD)',
    '[w](https://example.com/B.md)', '[m](mailto:me@example.com)', '[o](obsidian://open?vault=x)', '[p](//example.com/B.md)', '[q](pic.png)', '[r](B)'
  ].join(' '))
  assert.deepEqual(found, [
    'B.md', 'Pasta ideas.md', 'Pasta ideas.md', 'B.md', 'B.md', 'B.md', '../up/B.md', '/root/B.md', 'B.MD'
  ].map((target) => ({ kind: 'mention', target })))
})

test('extractLinks: a path that is not valid percent-encoding is kept as written, not a crash', () => {
  assert.deepEqual(extractLinks('[a](100%.md)'), [{ kind: 'mention', target: '100%.md' }])
})

test('extractLinks: code is not text - fenced blocks, longer fences, tilde fences and inline code are left out', () => {
  const text = [
    'start [[A]]',
    '```',
    '[[B]]',
    '```',
    'inline `[[C]]` and ``[[D]] with ` inside`` done [[E]]',
    '````',
    '```',
    '[[F]]',
    '```',
    '````',
    '~~~js',
    '[[G]]',
    '~~~',
    '  ```',
    '[[H]]',
    '  ```',
    '[x](I.md)'
  ].join('\n')
  assert.deepEqual(extractLinks(text).map((link) => link.target), ['A', 'E', 'I.md'])
})

test('extractLinks: a fence is closed only by its own kind, and a line of inline code that starts with backticks is not a fence', () => {
  assert.deepEqual(extractLinks(['```', '[[B]]', '~~~', '[[C]]', '```', '[[D]]'].join('\n')).map((link) => link.target), ['D'])
  assert.deepEqual(extractLinks(['``` [[A]] ```', '[[B]]'].join('\n')).map((link) => link.target), ['B'])
})

test('extractLinks: a stray backtick does not hide the lines after it - inline code is on one line', () => {
  assert.deepEqual(extractLinks(['one ` stray', '[[A]]', 'another ` stray'].join('\n')).map((link) => link.target), ['A'])
})

test('extractLinks: a fence that is never closed leaves the rest of the note out', () => {
  assert.deepEqual(extractLinks('[[A]]\n```\n[[B]]\n[[C]]'), [{ kind: 'link', target: 'A' }])
})

test('extractLinks: links come in the order they are written, repeats included (the lines are made unique later)', () => {
  assert.deepEqual(extractLinks('[[B]] [x](A.md) [[B]] [[A]]').map((link) => `${link.kind}:${link.target}`), ['link:B', 'mention:A.md', 'link:B', 'link:A'])
})

test('extractLinks: strange text takes no more than a moment, and gives back nothing it should not', () => {
  const started = Date.now()
  const texts = ['[['.repeat(150000), ']('.repeat(150000), '['.repeat(150000), '`'.repeat(150000), '[[a'.repeat(100000), '[a](' .repeat(100000), '```\n'.repeat(60000), '![['.repeat(100000)]
  for (const text of texts) extractLinks(text)
  assert.ok(Date.now() - started < 5000, 'a note of 300 KB must not make the collector wait')
})

/* ---------- the graph at the shape level ------------------------------------------------------- */

test('shape: counts, anonymous dots and lines, and not one word a note or a folder says', () => {
  const secret = 'PRIVATE-WORDS-ABC'
  const notes = [
    note(`Alpha Project/${secret} title.md`, `Body with ${secret} and [[Beta]]`),
    note('Beta.md', `${secret}`),
    note('Gamma.md', '')
  ]
  const item = build(notes)
  assert.deepEqual(item, { name: 'Vault', level: 'shape', notes: 3, lines: 1, lonely: 1, hidden: 0, more: 0, moreLines: 0, edges: [[0, 1, 0]] })
  const text = JSON.stringify(item)
  for (const word of [secret, 'Alpha', 'Beta', 'Gamma', 'Body']) assert.ok(!text.includes(word), `"${word}" reached the item`)
})

test('shape: a day or a tag in a note makes no hub and no line, and the note is just a dot', () => {
  const item = build([note('2026-10-09 a.md', '---\ntags: [x]\n---\n'), note('2026-10-09 b.md', '---\ntags: [x]\n---\n')])
  assert.equal(item.lines, 0)
  assert.deepEqual(Object.keys(item), ['name', 'level', 'notes', 'lines', 'lonely', 'hidden', 'more', 'moreLines', 'edges'])
  assert.equal(item.lonely, 2)
})

test('lonely: a note nothing links to and that links to nothing - a day or a tag does not count as a link', () => {
  const item = buildTitles([
    note('a.md', '[[b]]'), note('b.md'), note('c.md', '---\ntags: [x]\n---\n'), note('d.md', '---\ntags: [x]\n---\n'), note('e.md', '[x](f.md)'), note('f.md'), note('g.md')
  ])
  // a-b linked, e-f mentioned; c and d only share a tag; g stands alone.
  assert.equal(item.lonely, 3)
  assert.equal(item.notes, 7)
})

test('the same pair is one line per kind, whichever way round it is written and however often', () => {
  const item = build([note('a.md', '[[b]] [[b]] ![[b]] [b](b.md) [b](./b.md)'), note('b.md', '[[a]] [a](a.md)')])
  assert.deepEqual(item.edges, [[0, 1, 0], [0, 1, 1]])
  assert.equal(item.lines, 2)
})

test('every line goes from the lower dot to the higher, and the lines are in a fixed order', () => {
  const notes = ['e', 'a', 'd', 'b', 'c'].map((name, index, all) => note(`${name}.md`, all.map((other) => `[[${other}]] [${other}](${other}.md)`).join(' ')))
  const item = build(notes)
  assert.equal(item.lines, 20)
  for (const [from, to] of item.edges) assert.ok(from < to)
  const sorted = [...item.edges].sort((x, y) => x[2] - y[2] || x[0] - y[0] || x[1] - y[1])
  assert.deepEqual(item.edges, sorted)
})

test('the dots are in a fixed order whatever order the notes were found in, and the item does not depend on it', () => {
  const notes = [note('Zed/Last.md', '[[first]]'), note('first.md', '[[Zed/Last]]'), note('Middle.md', '[[First]]'), note('middle two.md')]
  assert.deepEqual(build([...notes].reverse()), build(notes))
  assert.deepEqual(noteOrder(['b.md', 'a.md', 'A.md', 'Z/c.md', 'z.md']), ['A.md', 'a.md', 'b.md', 'z.md', 'Z/c.md'])
})

test('a name typed one way finds the note stored the other way - the same letters, composed or not', () => {
  const composed = 'Caf' + String.fromCharCode(0xe9)
  const decomposed = 'Cafe' + String.fromCharCode(0x301)
  assert.deepEqual(build([note('a.md', `[[${composed}]]`), note(`${decomposed}.md`)]).edges, [[0, 1, 0]])
  assert.deepEqual(build([note('a.md', `[[${decomposed}]]`), note(`${composed}.md`)]).edges, [[0, 1, 0]])
})

test('what is passed in is not changed, and not kept', () => {
  const notes = [note('a.md', '[[b]]'), note('b.md')]
  const frozen = JSON.stringify(notes)
  build(notes)
  assert.equal(JSON.stringify(notes), frozen)
})

/* ---------- the graph at the titles level ------------------------------------------------------ */

test('titles: a title, a top folder and a day for each dot; a hub for each day and tag two or more notes share', () => {
  const notes = [
    note('Journal/2026-10-09 Standup.md', '---\ntags: [daily, "#team"]\n---\nText'),
    note('Journal/2026-10-09.md', '---\ntags:\n  - daily\n  - Team\n---\n'),
    note('Plans/Roadmap.md', '---\ndate: 2026-10-09T08:30:00Z\nproject: "[[Atlas]]"\npeople: [Ana]\n---\n'),
    note('Plans/Atlas notes.md', '---\nproject: Atlas\npeople: Ana, Bo\n---\n'),
    note('Loose idea.md', '---\ncreated: 2026-13-45\n---\n')
  ]
  const item = buildTitles(notes)
  assert.deepEqual(item.nodes, [
    { title: '2026-10-09 Standup', folder: 'Journal', day: '2026-10-09' },
    { title: '2026-10-09', folder: 'Journal', day: '2026-10-09' },
    { title: 'Loose idea' },
    { title: 'Atlas notes', folder: 'Plans' },
    { title: 'Roadmap', folder: 'Plans', day: '2026-10-09' }
  ])
  assert.deepEqual(item.hubs, [
    { kind: 'day', label: '2026-10-09' },
    { kind: 'tag', label: 'Ana' },
    { kind: 'tag', label: 'Atlas' },
    { kind: 'tag', label: 'daily' },
    { kind: 'tag', label: 'team' }
  ])
  // The hubs are numbered after the notes: 5 is the day, 6 Ana, 7 Atlas, 8 daily, 9 team.
  assert.deepEqual(item.edges, [[0, 5, 2], [1, 5, 2], [4, 5, 2], [0, 8, 3], [0, 9, 3], [1, 8, 3], [1, 9, 3], [3, 6, 3], [3, 7, 3], [4, 6, 3], [4, 7, 3]])
  assert.equal(item.lines, 11)
  assert.equal(item.notes, 5)
  assert.equal(item.lonely, 5, 'a day or a tag is not a link')
  assert.equal(item.untitled, 0)
  assert.deepEqual(Object.keys(item), ['name', 'level', 'notes', 'lines', 'lonely', 'hidden', 'more', 'moreLines', 'untitled', 'edges', 'nodes', 'hubs'])
})

test('titles: a day in the file name wins over one in the note; then date, then created; a day that is not on the calendar is none', () => {
  const item = buildTitles([
    note('2026-10-01 a.md', '---\ndate: 2026-10-05\n---\n'),
    note('b.md', '---\ndate: 2026-10-05\ncreated: 2026-10-06\n---\n'),
    note('c.md', '---\ncreated: "2026-10-06 14:00"\n---\n'),
    note('d.md', '---\ndate: 2026-02-30\n---\n'),
    note('2026-13-01 e.md'),
    note('f.md', 'date: 2026-10-05 in the text, not the frontmatter'),
    note('g.md', '---\ndate: nonsense\n---\n'),
    note('h.md', '---\ndate: [nonsense, 2026-10-07]\n---\n')
  ])
  // The dots are in path order: a, e, b, c, d, f, g, h. Only the first value of a date counts.
  assert.deepEqual(item.nodes.map((node) => node.day), ['2026-10-01', undefined, '2026-10-05', '2026-10-06', undefined, undefined, undefined, undefined])
})

test('titles: only the first eight tags of a note count, each once, however it is written; the hub keeps the first spelling', () => {
  const tags = Array.from({ length: 10 }, (_, index) => `t${index}`)
  const first = note('a.md', `---\ntags: [${tags.join(', ')}, T0]\n---\n`)
  const second = note('b.md', `---\ntags: [${[...tags].reverse().join(', ')}]\nproject: "#T0"\n---\n`)
  const third = note('c.md', '---\ntags: [t0]\n---\n')
  const item = buildTitles([first, second, third])
  // a has t0..t7 (T0 is t0 again; t8 and t9 are past eight); b has t9..t2, its first eight, so its project
  // line comes too late to count. A tag only one note has (t1, t8, t9) is not a hub.
  assert.deepEqual(item.hubs.map((hub) => hub.label), ['t0', 't2', 't3', 't4', 't5', 't6', 't7'])
  assert.equal(item.edges.length, 2 * 6 + 2)
})

test('titles: tag values come in the forms Obsidian writes - a list, a block list, a comma string, quotes, hashes and links', () => {
  const item = buildTitles([
    note('a.md', '---\ntags: [one, "two", \'three\']\n---\n'),
    note('b.md', '---\ntags:\n  - one\n  - "#two"\n- three\n---\n'),
    note('c.md', '---\ntags: one, two, three\n---\n'),
    note('d.md', '---\ntag: [[Four]]\n---\n'),
    note('e.md', '---\nproject: "[[Four|the fourth]]"\nTags: five\n---\n'),
    note('f.md', '---\ntags: five\n---\n')
  ])
  assert.deepEqual(item.hubs.map((hub) => hub.label), ['five', 'Four', 'one', 'three', 'two'])
})

test('titles: only the top of a file is frontmatter - tags written lower in a note, or in a note with no frontmatter, are not read', () => {
  const item = buildTitles([
    note('a.md', 'text\n---\ntags: [x]\n---\n'),
    note('b.md', 'tags: [x]\n'),
    note('c.md', '\n---\ntags: [x]\n---\n'),
    note('d.md', '---\ntags: [x]\n'),
    note('e.md', '---\ntags: [x]\n---\n'),
    note('f.md', `---\n${'padding: 0\n'.repeat(10000)}tags: [x]\n---\n`)
  ])
  // Only e has frontmatter that is read (f's closes after 50 KB: not frontmatter), so x is one note's tag: if any other were read, x would be a hub.
  assert.deepEqual(item.hubs, [])
})

test('titles: frontmatter written with Windows line endings is read the same', () => {
  const item = buildTitles([
    note('a.md', '---\r\ntags: [x]\r\ndate: 2026-10-09\r\n---\r\ntext'),
    note('b.md', '---\r\ntags: [x]\r\ndate: 2026-10-09\r\n---\r\ntext')
  ])
  assert.deepEqual(item.hubs, [{ kind: 'day', label: '2026-10-09' }, { kind: 'tag', label: 'x' }])
})

test('titles: a byte order mark at the start of a note does not hide its frontmatter', () => {
  const mark = String.fromCharCode(0xfeff)
  const item = buildTitles([note('a.md', `${mark}---\ntags: [x]\n---\n`), note('b.md', `${mark}---\ntags: [x]\n---\n`)])
  assert.deepEqual(item.hubs, [{ kind: 'tag', label: 'x' }])
})

test('titles: day hubs come in date order, not the order the notes were met', () => {
  const dated = (day) => `---\ndate: ${day}\n---\n`
  const item = buildTitles([note('a.md', dated('2026-10-10')), note('b.md', dated('2026-10-10')), note('c.md', dated('2026-10-01')), note('d.md', dated('2026-10-01'))])
  assert.deepEqual(item.hubs.map((hub) => hub.label), ['2026-10-01', '2026-10-10'])
})

test('titles: a day or tag one note has is on that dot, not a hub; hubs only join notes', () => {
  const item = buildTitles([note('2026-10-09 a.md', '---\ntags: [solo]\n---\n'), note('2026-10-10 b.md')])
  assert.deepEqual(item.hubs, [])
  assert.deepEqual(item.nodes.map((node) => node.day), ['2026-10-09', '2026-10-10'])
  assert.deepEqual(item.edges, [])
})

test('titles: a title that fails the rule is left out and counted; the folder and the day are judged on their own', () => {
  const rtl = String.fromCharCode(0x202e)
  const zero = String.fromCharCode(0x200b)
  const control = String.fromCharCode(0x07)
  const failing = {
    'sk-live-notes.md': 'looks like a key',
    'Bearer token.md': 'authorization header',
    'mail me@site.md': 'at sign',
    [`Notes of ${FAKE_USERNAME}.md`]: 'the username',
    [`${FAKE_HOSTNAME} plan.md`]: 'the computer name',
    ['ey' + 'JhbGciOiJub25lIn0.md']: 'signed token',
    [`${'abcdefgh '.repeat(10).trim()}.md`]: 'too long',
    [`${'x'.repeat(30)}.md`]: 'a stretch with no separator',
    '0f0e0d0c-1111-2222 id.md': 'an id',
    [`rtl${rtl}.md`]: 'reorders text',
    [`zero${zero}width.md`]: 'invisible',
    [`bell${control}.md`]: 'control character',
    ' padded .md': 'space at the ends'
  }
  const fine = { 'Fine title.md': true, 'Plans/Fine too.md': true }
  const paths = [...Object.keys(failing), ...Object.keys(fine), `${FAKE_USERNAME}/Under the username.md`, 'Folder with sk-key/Fine three.md']
  const item = buildTitles(paths.map((path) => note(path)), {}, IDENTITY)
  const order = noteOrder(paths)
  const nodeOf = (path) => item.nodes[order.indexOf(path)]
  for (const path of Object.keys(failing)) assert.equal(nodeOf(path).title, undefined, failing[path])
  for (const path of Object.keys(fine)) assert.ok(nodeOf(path).title, path)
  assert.equal(item.untitled, Object.keys(failing).length)
  assert.deepEqual(nodeOf(`${FAKE_USERNAME}/Under the username.md`), { title: 'Under the username' }, 'the folder is the username: left out, the title stays')
  assert.deepEqual(nodeOf('Folder with sk-key/Fine three.md'), { title: 'Fine three' }, 'the folder looks like a key: left out')
  assert.deepEqual(checkVaults({ schema: VAULTS_SCHEMA, takenAt: '2026-10-10T12:00:00Z', computer: 'Mac Mini', vaults: { status: 'found', items: [item], hidden: 0, more: 0 } }, IDENTITY), [])
})

test('titles: a tag that fails the rule is not a hub, and neither is one that has a slash (a nested tag)', () => {
  const item = buildTitles([
    note('a.md', `---\ntags: [project/alpha, sk-live-key, ok, "me@home", ${FAKE_USERNAME}]\n---\n`),
    note('b.md', `---\ntags: [project/alpha, sk-live-key, ok, "me@home", ${FAKE_USERNAME}]\n---\n`)
  ], {}, IDENTITY)
  assert.deepEqual(item.hubs, [{ kind: 'tag', label: 'ok' }])
})

test('titles: the first spelling is kept, and a day or tag shared by the same note twice is one spoke', () => {
  const item = buildTitles([
    note('a.md', '---\ntags: [Recipes, recipes, RECIPES]\nproject: recipes\n---\n'),
    note('b.md', '---\ntags: [rEcIpEs]\n---\n')
  ])
  assert.deepEqual(item.hubs, [{ kind: 'tag', label: 'Recipes' }])
  assert.deepEqual(item.edges, [[0, 2, 3], [1, 2, 3]])
})

/* ---------- caps and the order things are dropped ---------------------------------------------- */

test('past the note cap the rest are counted, not drawn, and a line to one of them is not drawn', () => {
  const notes = ['a', 'b', 'c', 'd', 'e'].map((name) => note(`${name}.md`, name === 'a' ? '[[e]] [[b]]' : ''))
  const item = build(notes, { more: 4 }, {}, { notes: 3 })
  assert.equal(item.notes, 3)
  assert.equal(item.more, 6)
  assert.deepEqual(item.edges, [[0, 1, 0]])
  assert.equal(item.moreLines, 0)
})

test('a name is looked up among every note in the vault, so a link to one past the cap is not made to a look-alike', () => {
  const notes = [note('a.md', '[[Plan]]'), note('x/Plan.md')]
  const known = ['a.md', 'x/Plan.md', 'Plan.md']
  assert.deepEqual(build(notes, { knownPaths: known }).edges, [])
  assert.deepEqual(build(notes).edges, [[0, 1, 0]])
})

test('past the line cap the lines go in a set order: tags, then days, then mentions, then links - each from the end', () => {
  const notes = [
    note('a.md', '[[b]] [[c]] [[d]] [d](b.md) [d](c.md) ---'),
    note('b.md', '---\ntags: [x]\ndate: 2026-10-09\n---\n'),
    note('c.md', '---\ntags: [x]\ndate: 2026-10-09\n---\n'),
    note('d.md', '---\ntags: [x]\ndate: 2026-10-09\n---\n')
  ]
  const kinds = (item) => item.edges.map((edge) => EDGE_KINDS[edge[2]])
  const whole = buildTitles(notes)
  assert.equal(whole.lines, 3 + 2 + 3 + 3)
  assert.deepEqual(kinds(whole), ['link', 'link', 'link', 'mention', 'mention', 'day', 'day', 'day', 'tag', 'tag', 'tag'])

  const noTags = buildTitles(notes, {}, {}, { lines: 8 })
  assert.deepEqual(kinds(noTags), ['link', 'link', 'link', 'mention', 'mention', 'day', 'day', 'day'])
  assert.deepEqual(noTags.hubs, [{ kind: 'day', label: '2026-10-09' }], 'the tag hub lost every line, so it is gone')
  assert.equal(noTags.moreLines, 3)

  const noDays = buildTitles(notes, {}, {}, { lines: 5 })
  assert.deepEqual(kinds(noDays), ['link', 'link', 'link', 'mention', 'mention'])
  assert.deepEqual(noDays.hubs, [])
  assert.equal(noDays.moreLines, 6)

  const noMentions = buildTitles(notes, {}, {}, { lines: 3 })
  assert.deepEqual(kinds(noMentions), ['link', 'link', 'link'])
  assert.equal(noMentions.moreLines, 8)

  const someLinks = buildTitles(notes, {}, {}, { lines: 2 })
  assert.deepEqual(someLinks.edges, [[0, 1, 0], [0, 2, 0]])
  assert.equal(someLinks.moreLines, 9)
  assert.equal(someLinks.lines, 2)
})

test('a hub that is cut down to one line by the cap is removed with that line, the hubs after it are renumbered, and both are counted', () => {
  const notes = [
    note('a.md', '---\ntags: [x, y]\n---\n'),
    note('b.md', '---\ntags: [y]\n---\n'),
    note('c.md', '---\ntags: [x]\n---\n'),
    note('d.md', '---\ntags: [y]\n---\n')
  ]
  const whole = buildTitles(notes)
  assert.deepEqual(whole.hubs.map((hub) => hub.label), ['x', 'y'])
  assert.deepEqual(whole.edges, [[0, 4, 3], [0, 5, 3], [1, 5, 3], [2, 4, 3], [3, 5, 3]])
  // Three lines kept leaves x with only a, so x goes with its line; y keeps a and b and is now dot 4.
  const cut = buildTitles(notes, {}, {}, { lines: 3 })
  assert.deepEqual(cut.hubs, [{ kind: 'tag', label: 'y' }])
  assert.deepEqual(cut.edges, [[0, 4, 3], [1, 4, 3]])
  assert.equal(cut.lines, 2)
  assert.equal(cut.moreLines, 3)
  assert.deepEqual(checkVaults({ schema: VAULTS_SCHEMA, takenAt: '2026-10-10T12:00:00Z', computer: 'Mac Mini', vaults: { status: 'found', items: [cut], hidden: 0, more: 0 } }, {}), [])
})

test('a day or a tag only one note has is not a hub, so it does not use up the place of one that is', () => {
  const notes = [
    note('a.md', '---\ndate: 2026-10-01\ntags: [a]\n---\n'),
    note('b.md', '---\ntags: [x]\n---\n'),
    note('c.md', '---\ntags: [x]\n---\n')
  ]
  const item = buildTitles(notes, {}, {}, { hubs: 1 })
  assert.deepEqual(item.hubs, [{ kind: 'tag', label: 'x' }])
})

test('two notes equally close: the first in path order, whatever order the vault listed them in', () => {
  const notes = [note('a.md', '[[Plan]]'), note('Y/Plan.md'), note('Z/Plan.md')]
  assert.deepEqual(build(notes, { knownPaths: ['Z/Plan.md', 'Y/Plan.md', 'a.md'] }).edges, [[0, 1, 0]])
})

test('past the hub cap the hubs are kept days first, then tags A to Z, and the lines to the rest are counted', () => {
  const notes = [
    note('2026-10-09 a.md', '---\ntags: [m, z]\n---\n'),
    note('2026-10-09 b.md', '---\ntags: [m, z]\n---\n')
  ]
  const item = buildTitles(notes, {}, {}, { hubs: 2 })
  assert.deepEqual(item.hubs, [{ kind: 'day', label: '2026-10-09' }, { kind: 'tag', label: 'm' }])
  assert.equal(item.moreLines, 2)
  assert.equal(item.lines, 4)
})

test('the real caps hold: 600 notes, 2,000 lines, 200 hubs, and the numbers add up', () => {
  const count = 650
  const notes = Array.from({ length: count }, (_, index) => {
    const links = [1, 2, 3, 4].map((step) => `[[note ${String((index + step) % count).padStart(4, '0')}]]`).join(' ')
    const tags = `t${index % 300}`
    return note(`note ${String(index).padStart(4, '0')}.md`, `---\ntags: [${tags}]\n---\n${links}`)
  })
  const item = buildTitles(notes, {}, {}, { bytes: Infinity })
  assert.equal(item.notes, VAULTS_CAPS.notes)
  assert.equal(item.more, count - VAULTS_CAPS.notes)
  assert.equal(item.lines, VAULTS_CAPS.lines)
  assert.equal(item.edges.length, VAULTS_CAPS.lines)
  assert.ok(item.hubs.length <= VAULTS_CAPS.hubs)
  assert.ok(item.moreLines > 0)
  assert.deepEqual(checkVaults({ schema: VAULTS_SCHEMA, takenAt: '2026-10-10T12:00:00Z', computer: 'Mac Mini', vaults: { status: 'found', items: [item], hidden: 0, more: 0 } }, {}), [])
})

test('past the budget the hubs go first, then the last notes ten percent at a time, and the budget holds', () => {
  const notes = Array.from({ length: 30 }, (_, index) => {
    const name = `note number ${String(index).padStart(2, '0')}`
    return note(`Folder ${index % 3}/${name}.md`, `---\ntags: [shared, group${index % 2}]\ndate: 2026-10-${String(1 + (index % 4)).padStart(2, '0')}\n---\n[[note number ${String((index + 1) % 30).padStart(2, '0')}]]`)
  })
  const roomy = buildTitles(notes, {}, {}, { bytes: Infinity })
  assert.ok(roomy.hubs.length > 0)
  const full = vaultBytes(roomy)

  const withoutHubs = buildTitles(notes, {}, {}, { bytes: full - 1 })
  assert.equal(withoutHubs.notes, 30)
  assert.equal(withoutHubs.more, 0)
  assert.deepEqual(withoutHubs.hubs, [])
  assert.ok(withoutHubs.edges.every((edge) => edge[2] < 2))
  assert.equal(withoutHubs.moreLines, roomy.lines - withoutHubs.lines)
  assert.ok(vaultBytes(withoutHubs) <= full - 1)

  const tighter = vaultBytes(withoutHubs) - 1
  const fewer = buildTitles(notes, {}, {}, { bytes: tighter })
  assert.equal(fewer.notes, 27, 'a tenth of 30 at a time')
  assert.equal(fewer.more, 3)
  assert.deepEqual(fewer.nodes, withoutHubs.nodes.slice(0, fewer.notes), 'the last notes go, never the first')
  assert.ok(vaultBytes(fewer) <= tighter)
  assert.equal(fewer.moreLines, roomy.lines - fewer.lines)
  assert.ok(fewer.edges.every(([from, to]) => from < fewer.notes && to < fewer.notes))
})

test('the real budget: 600 notes with long titles still make a vault the file has room for, three times over', () => {
  const title = (index) => `${String(index).padStart(3, '0')} ${'abcdefgh '.repeat(8).trim()}`
  const notes = Array.from({ length: VAULTS_CAPS.notes }, (_, index) => note(`Folder ${index % 7}/${title(index)}.md`, `---\ndate: 2026-10-${String(1 + (index % 28)).padStart(2, '0')}\n---\n[[${title((index + 1) % VAULTS_CAPS.notes)}]]`))
  const item = buildTitles(notes)
  assert.ok(vaultBytes(item) <= VAULT_BYTES_BUDGET, `${vaultBytes(item)} bytes`)
  assert.ok(item.notes < VAULTS_CAPS.notes, 'the titles alone are more than the budget')
  assert.equal(item.more, VAULTS_CAPS.notes - item.notes)
  const doc = { schema: VAULTS_SCHEMA, takenAt: '2026-10-10T12:00:00Z', computer: 'Mac Mini', vaults: { status: 'found', items: ['One', 'Two', 'Three'].map((name) => ({ ...item, name })), hidden: 0, more: 0 } }
  assert.deepEqual(checkVaults(doc, {}), [])
  const text = stringifyVaults(doc)
  assert.ok(Buffer.byteLength(text) <= VAULTS_MAX_FILE_BYTES, `${Buffer.byteLength(text)} bytes`)
  assert.ok(Buffer.byteLength(text) < 3 * VAULT_BYTES_BUDGET + 1024)
})

/* ---------- the file's text ------------------------------------------------------------------- */

test('stringifyVaults: the same data as the usual two-space JSON, each line, dot and hub on a row of its own', () => {
  const doc = fixture.sample
  const text = stringifyVaults(doc)
  assert.deepEqual(JSON.parse(text), doc)
  assert.ok(text.endsWith('}\n'))
  assert.equal(stringifyVaults(doc), text)
  assert.ok(/\n {10}\[0,1,0\],\n/.test(text), 'a line is a row of its own')
  assert.ok(/\n {10}\{"title":"Shopping list","folder":"Plans","day":"2026-10-09"\},\n/.test(text), 'a dot is a row of its own')
  assert.ok(/\n {10}\{"kind":"tag","label":"recipes"\}\n/.test(text), 'a hub is a row of its own')
  assert.deepEqual(checkVaults(JSON.parse(text), {}), [])
})

test('stringifyVaults: a block with nothing to list is written the way every other part\'s file is', () => {
  for (const vaults of [{ status: 'not found' }, { status: 'unavailable', why: VAULTS_WHY.unreadable }, { status: 'found', items: [], hidden: 0, more: 0 }]) {
    const doc = { schema: VAULTS_SCHEMA, takenAt: '2026-10-10T12:00:00Z', computer: 'Mac Mini', vaults }
    assert.equal(stringifyVaults(doc), `${JSON.stringify(doc, null, 2)}\n`)
  }
})

test('vaultBytes is what the vault takes in the file: the file is the envelope and the vaults, to the byte', () => {
  const item = buildVaultItem({ name: 'Ideas', level: 'titles', notes: fixture.sampleSources[1].notes }, {})
  const bare = { schema: VAULTS_SCHEMA, takenAt: '2026-10-10T12:00:00Z', computer: 'Mac Mini', vaults: { status: 'found', items: [], hidden: 0, more: 0 } }
  const withIt = { ...bare, vaults: { ...bare.vaults, items: [item] } }
  const grown = Buffer.byteLength(stringifyVaults(withIt)) - Buffer.byteLength(stringifyVaults(bare))
  // The empty list is "[]" and the full one adds its rows and a newline and indent around them.
  assert.ok(Math.abs(grown - vaultBytes(item)) <= 6, `${grown} against ${vaultBytes(item)}`)
})

/* ---------- reading a vault off the disk ------------------------------------------------------- */

const SECRET = fakeClaudeToken()
const PRIVATE = 'PRIVATE-PROSE-4f2c9d'
const HUNTER = 'hunter2-not-a-real-password'

function hostileFiles() {
  return {
    'Plans/Weekly plan.md': `---\ntitle: ${SECRET}\napi_key: ${SECRET}\npassword: ${HUNTER}\ntags: [${SECRET}, planning]\n---\n${PRIVATE} see [[Garden]] and [[Bearer abc]] and [[${SECRET}]] and [x](../Plans/Garden.md)`,
    'Plans/Garden.md': `${PRIVATE} tomatoes. ${SECRET}\n[[Weekly plan]]`,
    'Plans/Shopping.md': `---\ntags: [planning]\n---\n${PRIVATE}`,
    'sk-live-notes.md': `${PRIVATE} ${SECRET}`,
    [`${FAKE_USERNAME}/Under the username.md`]: `${PRIVATE}`,
    [`Notes of ${FAKE_USERNAME}.md`]: `${PRIVATE}`,
    'Big note.md': `${PRIVATE} ${'x'.repeat(300 * 1024)}`,
    '.obsidian/app.json': JSON.stringify({ token: SECRET }),
    '.obsidian/notes.md': `${PRIVATE} ${SECRET}`,
    '.trash/Deleted.md': `${PRIVATE} ${SECRET}`,
    '.git/info.md': `${PRIVATE}`,
    'node_modules/pkg/readme.md': `${PRIVATE}`,
    '.hidden note.md': `${PRIVATE}`,
    'image.png': `${PRIVATE}`,
    'canvas.canvas': `${PRIVATE}`
  }
}

async function named(home, dir, extra = {}) {
  return collectVaults(home.depsFor({ now: NOW, dataDir: dir.dir, ...extra }), 'Mac Mini')
}

function assertNothingPrivate(text, home, label = 'the output') {
  const forbidden = {
    'a note\'s words': PRIVATE,
    'a secret': SECRET,
    'a password': HUNTER,
    'the key name': 'api_key',
    'the username': FAKE_USERNAME,
    'the computer name': FAKE_HOSTNAME,
    'the home folder': home.home,
    'the vault\'s place': home.root,
    'an authorization header': 'Bearer',
    'a key start': 'sk-'
  }
  for (const [what, needle] of Object.entries(forbidden)) assert.ok(!text.includes(needle), `${what} reached ${label}`)
}

test('hostile vault at shape: no title, folder, tag, date, word, path or secret reaches the output - dots and lines only', async () => {
  const home = await obsidianHome('darwin', { Hostile: { files: hostileFiles() } })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Hostile\n' })
  try {
    const doc = await named(home, dir)
    assert.equal(doc.vaults.status, 'found')
    const [item] = doc.vaults.items
    assert.equal(item.level, 'shape')
    assert.deepEqual(Object.keys(item), ['name', 'level', 'notes', 'lines', 'lonely', 'hidden', 'more', 'moreLines', 'edges'])
    // Six notes count: the one in the username's folder, "Notes of <username>", Garden, Shopping, Weekly plan and
    // sk-live-notes. Big note is withheld (hidden); the dot folders, node_modules, the image and the canvas are
    // not part of the vault's notes at all. Weekly plan and Garden link both ways (one line), and Weekly plan
    // also has a markdown link to Garden.
    assert.deepEqual(item, { name: 'Hostile', level: 'shape', notes: 6, lines: 2, lonely: 4, hidden: 1, more: 0, moreLines: 0, edges: [[2, 4, 0], [2, 4, 1]] })
    assert.equal(item.lines, item.edges.length)
    assertNothingPrivate(JSON.stringify(doc), home)
    assertNothingPrivate(stringifyVaults(doc), home, 'the file text')
    assert.deepEqual(checkVaults(doc, home.identity), [])
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('hostile vault at titles: only titles, folders, days and tags that passed the rule reach the output', async () => {
  const home = await obsidianHome('darwin', { Hostile: { files: hostileFiles() } })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Hostile\n    level: titles\n' })
  try {
    const doc = await named(home, dir)
    const [item] = doc.vaults.items
    assert.equal(item.level, 'titles')
    assert.deepEqual(item.nodes, [
      { title: 'Under the username' },
      {},
      { title: 'Garden', folder: 'Plans' },
      { title: 'Shopping', folder: 'Plans' },
      { title: 'Weekly plan', folder: 'Plans' },
      {}
    ])
    assert.equal(item.untitled, 2, 'the name with the username, and the key-like name')
    assert.deepEqual(item.hubs, [{ kind: 'tag', label: 'planning' }], 'the tag that looks like a key is not a hub')
    assert.deepEqual(item.edges, [[2, 4, 0], [2, 4, 1], [3, 6, 3], [4, 6, 3]])
    assertNothingPrivate(JSON.stringify(doc), home)
    assertNothingPrivate(stringifyVaults(doc), home, 'the file text')
    assert.deepEqual(checkVaults(doc, home.identity), [])
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('the level is per vault: one named at titles shows titles, the one beside it stays dots and lines', async () => {
  const files = { 'Alpha note.md': '[[Beta note]]', 'Beta note.md': '' }
  const home = await obsidianHome('darwin', { Open: { files }, Closed: { files } })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Open\n    level: titles\n  - name: Closed\n' })
  try {
    const doc = await named(home, dir)
    const byName = Object.fromEntries(doc.vaults.items.map((item) => [item.name, item]))
    assert.deepEqual(byName.Open.nodes.map((node) => node.title), ['Alpha note', 'Beta note'])
    assert.equal(byName.Closed.nodes, undefined)
    assert.ok(!JSON.stringify(byName.Closed).includes('Alpha'))
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('what is read: the named vault\'s notes, once each; never inside the dot folders, node_modules or other files, and never another vault', async () => {
  const home = await obsidianHome('darwin', {
    Named: { files: hostileFiles() },
    Unnamed: { files: { 'Private.md': PRIVATE, 'Sub/Deeper.md': PRIVATE } }
  })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Named\n' })
  const fs = recordingFs()
  try {
    const doc = await named(home, dir, { fs })
    assert.equal(doc.vaults.status, 'found')
    assert.ok(!fs.touched.some((path) => path.includes('Unnamed')), 'an unnamed vault was touched')
    for (const part of ['.obsidian', '.trash', '.git', 'node_modules', '.hidden', 'image.png', 'canvas']) {
      assert.ok(!fs.touched.some((path) => path.includes(part)), `${part} was touched`)
    }
    const reads = fs.calls.filter(([operation]) => operation === 'readFile').map(([, path]) => path)
    assert.equal(new Set(reads).size, reads.length, 'a file was read twice')
    const noteReads = reads.filter((path) => path.endsWith('.md'))
    assert.equal(noteReads.length, 6, 'the six notes, and not the one that is too big')
    assert.ok(!noteReads.some((path) => path.includes('Big note')), 'a note over the size was read')
    for (const read of reads) assert.ok(read.endsWith('.md') || read.endsWith('.json') || read.endsWith('.yml'), read)
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('nothing named: only vaults.yml is read - not Obsidian\'s list, not a vault', async () => {
  const home = await obsidianHome('darwin', { Vault: { files: { 'Private.md': PRIVATE } } })
  const dir = await team({ 'vaults.yml': 'vaults: []\n' })
  const fs = recordingFs()
  try {
    const doc = await named(home, dir, { fs })
    assert.deepEqual(doc, { schema: VAULTS_SCHEMA, takenAt: '2026-10-10T12:00:00Z', computer: 'Mac Mini', vaults: { status: 'not found' } })
    assert.ok(fs.touched.every((path) => path.endsWith('vaults.yml')), JSON.stringify(fs.touched))
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('the part says what happened: not found, unavailable (with one of two fixed reasons), or found', async () => {
  const home = await obsidianHome('darwin', { Vault: { files: { 'A.md': '' } } })
  try {
    const elsewhere = await team({ 'vaults.yml': 'vaults:\n  - name: On another computer\n' })
    const broken = await team({})
    await mkdir(join(broken.dir, 'vaults.yml'))
    const absent = await team({})
    const found = await team({ 'vaults.yml': 'vaults:\n  - name: Vault\n' })
    try {
      assert.deepEqual((await named(home, elsewhere)).vaults, { status: 'not found' })
      assert.deepEqual((await named(home, absent)).vaults, { status: 'not found' })
      assert.deepEqual((await named(home, broken)).vaults, { status: 'unavailable', why: VAULTS_WHY.unreadable })
      const doc = await named(home, found)
      assert.deepEqual(Object.keys(doc), ['schema', 'takenAt', 'computer', 'vaults'])
      assert.equal(doc.schema, VAULTS_SCHEMA)
      assert.equal(doc.takenAt, '2026-10-10T12:00:00Z')
      assert.equal(doc.computer, 'Mac Mini')
      assert.deepEqual(Object.keys(doc.vaults), ['status', 'items', 'hidden', 'more'])
      for (const result of [elsewhere, broken, absent, found]) assert.deepEqual(checkVaults(await named(home, result), home.identity), [])
    } finally {
      await Promise.all([elsewhere.cleanup(), broken.cleanup(), absent.cleanup(), found.cleanup()])
    }
  } finally {
    await home.cleanup()
  }
})

test('a broken Obsidian list makes the part unavailable and says nothing of what it held', async () => {
  const home = await obsidianHome('darwin', {}, { raw: `{ not json ${PRIVATE}`, allow: allowText(['Vault']) })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Vault\n' })
  try {
    const doc = await named(home, dir)
    assert.deepEqual(doc.vaults, { status: 'unavailable', why: VAULTS_WHY.unreadable })
    assert.ok(!JSON.stringify(doc).includes(PRIVATE))
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('a vault that cannot be read is counted and the other is still written', async () => {
  const home = await obsidianHome('darwin', { Good: { files: { 'A.md': '[[B]]', 'B.md': '' } }, Bad: { files: { 'C.md': '' } } })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Good\n  - name: Bad\n' })
  const fs = recordingFs({ failOn: [['readdir', `${join('Vaults', 'Bad')}`]] })
  try {
    const doc = await named(home, dir, { fs })
    assert.deepEqual(doc.vaults.items.map((item) => item.name), ['Good'])
    assert.equal(doc.vaults.hidden, 1)
    assert.equal(doc.vaults.items[0].notes, 2)
    assert.ok(!JSON.stringify(doc).includes('locked'), 'an error message reached the output')
    assert.ok(!JSON.stringify(doc).includes(home.root), 'a path reached the output')
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('a note that cannot be read is counted and the rest of the vault is still drawn; the error is not kept', async () => {
  const home = await obsidianHome('darwin', { Vault: { files: { 'A.md': '[[B]]', 'B.md': '', 'Locked.md': PRIVATE } } })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Vault\n' })
  const fs = recordingFs({ failOn: [['readFile', 'Locked.md']] })
  try {
    const doc = await named(home, dir, { fs })
    const [item] = doc.vaults.items
    assert.equal(item.notes, 2)
    assert.equal(item.hidden, 1)
    assert.deepEqual(item.edges, [[0, 1, 0]])
    assert.ok(!JSON.stringify(doc).includes('Locked') && !JSON.stringify(doc).includes('locked'))
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('a folder that is a link is never followed, and a link back to the vault is no loop', async () => {
  const home = await obsidianHome('darwin', { Vault: { files: { 'Real.md': '[[Elsewhere]]', 'Sub/Inner.md': '' } } })
  const root = home.places.Vault
  const outside = join(home.root, 'Outside folder')
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'Elsewhere.md'), PRIVATE)
  await symlink(root, join(root, 'Loop'), 'junction')
  await symlink(outside, join(root, 'Out'), 'junction')
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Vault\n    level: titles\n' })
  const fs = recordingFs()
  try {
    const doc = await named(home, dir, { fs })
    const [item] = doc.vaults.items
    assert.deepEqual(item.nodes.map((node) => node.title), ['Real', 'Inner'])
    assert.equal(item.hidden, 2, 'the two folders that were links')
    assert.deepEqual(item.edges, [], 'a link to a note in a folder that is a link goes nowhere')
    assert.ok(!fs.touched.some((path) => path.includes('Outside folder') || path.endsWith('Elsewhere.md')), 'a link was followed')
    assert.ok(!JSON.stringify(doc).includes(PRIVATE))
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('a note that is a link is not read, and is counted', async (t) => {
  const home = await obsidianHome('darwin', { Vault: { files: { 'Real.md': '[[Linked note]]' } } })
  const outside = join(home.root, 'Outside folder')
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'Elsewhere.md'), PRIVATE)
  try {
    await symlink(join(outside, 'Elsewhere.md'), join(home.places.Vault, 'Linked note.md'))
  } catch {
    t.skip('this computer will not make a link here')
    await home.cleanup()
    return
  }
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Vault\n    level: titles\n' })
  const fs = recordingFs()
  try {
    const doc = await named(home, dir, { fs })
    const [item] = doc.vaults.items
    assert.deepEqual(item.nodes.map((node) => node.title), ['Real'])
    assert.equal(item.hidden, 1)
    assert.deepEqual(item.edges, [])
    assert.ok(!fs.touched.some((path) => path.includes('Outside folder')), 'a link was followed')
    assert.ok(!JSON.stringify(doc).includes(PRIVATE))
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('a folder nested too deep is counted, not walked', async () => {
  const deep = Array.from({ length: 30 }, (_, index) => `d${index}`).join('/')
  const home = await obsidianHome('darwin', { Vault: { files: { 'Top.md': '', [`${deep}/Bottom.md`]: PRIVATE } } })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Vault\n' })
  try {
    const doc = await named(home, dir)
    const [item] = doc.vaults.items
    assert.equal(item.notes, 1)
    assert.ok(item.hidden >= 1)
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('a vault with more entries than the walk will visit is cut short and counted, and does not hang', async () => {
  const files = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`n${String(index).padStart(2, '0')}.md`, '']))
  const home = await obsidianHome('darwin', { Vault: { files } })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Vault\n' })
  try {
    const doc = await named(home, dir, { walkLimits: { entries: 25 } })
    const [item] = doc.vaults.items
    assert.ok(item.notes <= 25)
    assert.ok(item.hidden >= 1)
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('past 600 notes only 600 are read, the rest are counted, and the cost is the same for a bigger vault', async () => {
  const files = Object.fromEntries(Array.from({ length: 640 }, (_, index) => [`Folder ${index % 8}/n${String(index).padStart(3, '0')}.md`, index % 5 === 0 ? `[[n${String((index + 1) % 640).padStart(3, '0')}]]` : '']))
  const home = await obsidianHome('darwin', { Vault: { files } })
  const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Vault\n' })
  const fs = recordingFs()
  try {
    const doc = await named(home, dir, { fs })
    const [item] = doc.vaults.items
    assert.equal(item.notes, VAULTS_CAPS.notes)
    assert.equal(item.more, 40)
    const noteReads = fs.calls.filter(([operation, path]) => operation === 'readFile' && path.endsWith('.md'))
    assert.equal(noteReads.length, VAULTS_CAPS.notes, 'a note past the cap was read')
  } finally {
    await Promise.all([home.cleanup(), dir.cleanup()])
  }
})

test('the same vault gives the same file however the notes were made, and on every platform', async () => {
  const files = { 'B/two.md': '[[one]]', 'A/one.md': '[[two]] [x](../B/two.md)', 'three.md': '---\ntags: [x]\n---\n', 'four.md': '---\ntags: [x]\n---\n' }
  const reversed = Object.fromEntries(Object.entries(files).reverse())
  const texts = []
  for (const [platform, given] of [['darwin', files], ['win32', reversed], ['linux', files]]) {
    const home = await obsidianHome(platform, { Vault: { files: given } })
    const dir = await team({ 'vaults.yml': 'vaults:\n  - name: Vault\n    level: titles\n' })
    try {
      texts.push(stringifyVaults(await named(home, dir)))
    } finally {
      await Promise.all([home.cleanup(), dir.cleanup()])
    }
  }
  assert.equal(texts[0], texts[1])
  assert.equal(texts[1], texts[2])
})

test('readVault on a place that is gone is nothing, not a crash and not a message', async () => {
  const home = await obsidianHome('darwin', {})
  try {
    const result = await readVault({ name: 'Gone', level: 'shape', path: join(home.root, 'Not here') }, home.depsFor({ now: NOW }))
    assert.equal(result, null)
  } finally {
    await home.cleanup()
  }
})
