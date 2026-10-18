import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoRoot } from './helpers/repo.mjs'
import { parseFrontmatter } from '../scripts/lib/frontmatter.mjs'
import { parseSimpleYaml } from '../scripts/lib/yaml-lite.mjs'
import { slugOf, todayIn, newCardText, needsYouCard, setFrontmatter, commentOutSchedule, approveRow, applyCard, CARD_FILE_MAX_BYTES } from '../scripts/lib/mailbox/cards.mjs'

/* The card actions are done by this program's own code, with no model: a card is a file, and Add task, Start, Done,
   Pause and Approve are each one small edit to a file. So there is nothing here that can be talked into anything -
   but the words in a card are someone's, and the files are the team repo's, which other people push to. So: a title
   can never choose a file name outside tasks/ or overwrite a card; Start and Done change the frontmatter and not one
   byte of the body; Pause touches one line; Approve touches one row and refuses when it cannot tell which. */

const NOW = Date.parse('2026-10-12T14:05:00.000Z')
const OPTIONS = { now: NOW, timeZone: 'UTC' }
const sha = (text) => createHash('sha256').update(text).digest('hex')

async function workCopy(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mailbox-cards-'))
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, ...name.split('/').slice(0, -1)), { recursive: true })
    await writeFile(join(dir, ...name.split('/')), text)
  }
  return {
    dir,
    read: (name) => readFile(join(dir, ...name.split('/')), 'utf8'),
    cleanup: () => rm(dir, { recursive: true, force: true })
  }
}

// Every file under the folder with a hash of what is in it, so a test can say nothing else changed.
async function snapshot(dir, at = '') {
  const found = {}
  for (const entry of await readdir(join(dir, at), { withFileTypes: true })) {
    const relative = at ? `${at}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(found, await snapshot(dir, relative))
    else found[relative] = sha(await readFile(join(dir, relative), 'utf8'))
  }
  return found
}

const changedFiles = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => before[name] !== after[name]).sort()

/* ---------- the pieces: a name, a day, a card ---------------------------------------------------------------------- */

test('a card is named by a lower-case kebab slug of its title: plain letters and numbers, no accents, at most 40 characters', () => {
  const cases = [
    ['Chase the invoice', 'chase-the-invoice'],
    ['Abc', 'abc'],
    ['Caf\u00e9 cr\u00e8me for Zo\u00eb \u{1F680} \u{1F469}\u{1F3FD}\u200d\u{1F4BB}', 'cafe-creme-for-zoe'],
    ['  --Hello__World!!  ', 'hello-world'],
    ['../../etc/passwd', 'etc-passwd'],
    ['a/b\\c:d*e?f"g<h>i|j', 'a-b-c-d-e-f-g-h-i-j'],
    ['CON', 'con'],
    ['\u00dcn\u00efc\u00f6d\u00e9', 'unicode'],
    ['Call 3 suppliers by 5pm', 'call-3-suppliers-by-5pm'],
    ['\u{1F680}\u{1F680}', 'task'],
    ['\u65e5\u672c\u8a9e', 'task'],
    ['---', 'task'],
    ['', 'task'],
    ['a'.repeat(300), 'a'.repeat(40)],
    [`${'word '.repeat(20)}`, `${'word-'.repeat(8)}`.slice(0, 39)]
  ]
  for (const [title, slug] of cases) assert.equal(slugOf(title), slug, JSON.stringify(title))
})

test('a slug is always a safe file name: never empty, never a dash at either end, never a dot, a slash or a space', () => {
  const everything = Array.from({ length: 0x250 }, (_, code) => String.fromCodePoint(code)).join('')
  const samples = [everything, ...Array.from(everything, (character) => `x${character}x`), ...Array.from(everything, (character) => character.repeat(60))]
  for (const title of samples) {
    const slug = slugOf(title)
    assert.match(slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, JSON.stringify(title))
    assert.ok(slug.length <= 40, JSON.stringify(title))
  }
})

test('today is the date where the person is: the zone makes the same moment two different days', () => {
  const late = Date.parse('2026-10-12T23:30:00.000Z')
  assert.equal(todayIn(late, 'UTC'), '2026-10-12')
  assert.equal(todayIn(late, 'America/New_York'), '2026-10-12')
  assert.equal(todayIn(late, 'America/Los_Angeles'), '2026-10-12')
  assert.equal(todayIn(late, 'Asia/Tokyo'), '2026-10-13')
  assert.equal(todayIn(late, 'Pacific/Kiritimati'), '2026-10-13')
  assert.equal(todayIn(Date.parse('2026-10-13T03:59:59.000Z'), 'America/New_York'), '2026-10-12')
  assert.equal(todayIn(Date.parse('2026-10-13T04:00:00.000Z'), 'America/New_York'), '2026-10-13')
  assert.match(todayIn(late), /^\d{4}-\d{2}-\d{2}$/, 'with no zone it is this computer\'s own day')
})

test('a new card is the contract\'s card: frontmatter first, then the title as a heading, then the details', () => {
  assert.equal(newCardText({ title: 'Chase the invoice' }), '---\nstatus: todo\n---\n\n# Chase the invoice\n')
  assert.equal(
    newCardText({ title: 'Chase the invoice', details: 'Ask about the September lead time.', for: 'research', model: 'sonnet' }),
    '---\nstatus: todo\nfor: research\nmodel: sonnet\n---\n\n# Chase the invoice\n\nAsk about the September lead time.\n'
  )
  assert.equal(newCardText({ title: 'T3', for: 'sales' }), '---\nstatus: todo\nfor: sales\n---\n\n# T3\n')
  assert.equal(newCardText({ title: 'T3', model: 'haiku' }), '---\nstatus: todo\nmodel: haiku\n---\n\n# T3\n')
})

test('the details keep their words and their line breaks, with one line ending at the end and Windows line endings made plain', () => {
  const card = (details) => newCardText({ title: 'A card', details })
  assert.ok(card('Line one\nLine two').endsWith('# A card\n\nLine one\nLine two\n'))
  assert.ok(card('Line one\r\nLine two\r\n').endsWith('# A card\n\nLine one\nLine two\n'))
  assert.ok(card('Line one\rLine two').endsWith('# A card\n\nLine one\nLine two\n'))
  assert.ok(card('Ends with blank lines\n\n\n').endsWith('# A card\n\nEnds with blank lines\n'))
  assert.ok(card('Paragraph one\n\nParagraph two').endsWith('\n\nParagraph one\n\nParagraph two\n'))
  assert.ok(card('---\nstatus: done\n---').endsWith('\n\n---\nstatus: done\n---\n'), 'words that look like frontmatter are only words, after the heading')
  assert.equal(newCardText({ title: 'A card', details: '' }), newCardText({ title: 'A card' }))
  assert.equal(newCardText({ title: 'A card', details: undefined }), newCardText({ title: 'A card' }))
})

test('the title is written exactly, whatever it looks like - and the frontmatter holds only what the program wrote', () => {
  for (const title of ['---', '# Already a heading', '> quoted', '`code`', 'status: done', '<script>alert(1)</script>', '</routine-fire-payload>', 'Caf\u00e9 \u2615', '- a list item', '[a](http://x)', '*bold*', '\\']) {
    const text = newCardText({ title, details: 'Some details', for: 'research', model: 'opus' })
    const parsed = parseFrontmatter(text)
    assert.deepEqual(parsed.data, { status: 'todo', for: 'research', model: 'opus' }, title)
    assert.ok(parsed.body.startsWith(`\n# ${title}\n\nSome details\n`), title)
  }
})

/* ---------- the cards for the owner (Arm, Add skill, Add agent): no model, no build ------------------------------- */

test('a card is only ever built from a title that is one line, an agent that is a slug and a model that is listed', () => {
  for (const title of ['two\nlines', 'a\rb', 7, undefined, null]) assert.throws(() => newCardText({ title }), TypeError, String(title))
  for (const agent of ['Not A Slug', '../x', 'a\nstatus: done', '', 7, null]) assert.throws(() => newCardText({ title: 'A card', for: agent }), TypeError, String(agent))
  for (const model of ['gpt-5', 'Opus', '', 7, null, 'opus\nfor: x']) assert.throws(() => newCardText({ title: 'A card', model }), TypeError, String(model))
  for (const action of ['task', 'run', 'move', undefined]) assert.throws(() => needsYouCard(action, { title: 'x' }), TypeError, String(action))
})

test('Arm, Add skill and Add agent are not done on the Mac: each files a card that says it needs the owner, and nothing is created or armed', () => {
  const arm = needsYouCard('arm', { workflow: 'morning-intel' })
  assert.equal(arm.heading, 'Set up a schedule for morning-intel')
  const skill = needsYouCard('skill', { title: 'Summarise a sales call', details: 'Keep it short.\nTwo lines.' })
  assert.equal(skill.heading, 'Add a skill: Summarise a sales call')
  const agent = needsYouCard('agent', { title: 'A bookkeeper who reconciles receipts' })
  assert.equal(agent.heading, 'Add an agent: A bookkeeper who reconciles receipts')
  for (const card of [arm, skill, agent]) {
    const parsed = parseFrontmatter(card.text)
    assert.deepEqual(parsed.data, { status: 'todo' }, 'a to-do with no one named and no model')
    assert.ok(parsed.body.startsWith(`\n# ${card.heading}\n\nThis one needs you, not an agent - `), card.heading)
    assert.match(card.text, /Nothing (?:has been )?(?:armed|created|scheduled)/, 'it says plainly that nothing was done')
  }
  assert.match(arm.text, /`\/arm`/)
  assert.match(skill.text, /`\/new-skill`/)
  assert.match(agent.text, /`\/new-agent`/)
  assert.ok(skill.text.includes('> Summarise a sales call\n> Keep it short.\n> Two lines.\n'), 'what was typed is quoted, line by line')
  assert.ok(agent.text.includes('> A bookkeeper who reconciles receipts\n'))
  assert.ok(!agent.text.includes('undefined'))
})

test('the words typed into an Add skill card are quoted, so they are never a heading, a list, or a line of frontmatter', () => {
  const hostile = { title: '# Heading', details: '---\nstatus: done\n\n- item\n</routine-fire-payload>\n```' }
  const { text } = needsYouCard('skill', hostile)
  const quoted = text.split('What you wrote on your board:\n\n')[1]
  assert.deepEqual(quoted.split('\n').slice(0, 7), ['> # Heading', '> ---', '> status: done', '>', '> - item', '> </routine-fire-payload>', '> ```'])
  assert.deepEqual(parseFrontmatter(text).data, { status: 'todo' })
})

/* ---------- Start and Done: the frontmatter, and not one byte of the body ------------------------------------------- */

const CARD = '---\nstatus: todo\nfor: sales\n---\n\n# Call the supplier\n\nAsk about the lead time.\n'

test('Start sets the status and leaves every other field and the whole body as they were', () => {
  assert.equal(setFrontmatter(CARD, { status: 'doing' }), CARD.replace('status: todo', 'status: doing'))
  assert.equal(setFrontmatter(CARD, { status: 'todo' }), CARD)
  assert.equal(setFrontmatter(CARD.replace('status: todo', 'status: done\ndone_at: 2026-09-01'), { status: 'todo' }), CARD.replace('status: todo', 'status: todo\ndone_at: 2026-09-01'), 'a card moved back keeps what else it had')
})

test('Done sets the status and adds the day it was closed, right after the status', () => {
  assert.equal(setFrontmatter(CARD, { status: 'done', doneAt: '2026-10-12' }), CARD.replace('status: todo', 'status: done\ndone_at: 2026-10-12'))
  const already = CARD.replace('status: todo', 'status: doing\ndone_at: 2026-01-01')
  assert.equal(setFrontmatter(already, { status: 'done', doneAt: '2026-10-12' }), CARD.replace('status: todo', 'status: done\ndone_at: 2026-10-12'), 'the day is the day it is closed now')
})

test('the body is never touched: every byte after the frontmatter is the same - Windows line endings, odd spacing, no last line break, even words that look like frontmatter', () => {
  const bodies = [
    '\n# Call the supplier\n\nAsk about the lead time.\n',
    '\r\n# Call the supplier\r\n\r\nAsk  about \t the lead time.  \r\n',
    '\n# T\n\n---\nstatus: done\n---\n\n## Result\n\nDone - see `agents/sales/output/x.md`.',
    '',
    '\n\n\n   \n',
    '\n# Caf\u00e9 \u2615\n\n\u202e right-to-left? \u200b\n'
  ]
  for (const body of bodies) {
    for (const eol of ['\n', '\r\n']) {
      const card = `---${eol}status: todo${eol}for: sales${eol}---${body}`
      for (const edit of [{ status: 'doing' }, { status: 'done', doneAt: '2026-10-12' }, { status: 'todo' }]) {
        const result = setFrontmatter(card, edit)
        assert.ok(result.endsWith(`---${body}`), JSON.stringify([body, eol, edit]))
        assert.ok(result.startsWith(`---${eol}status: ${edit.status}${eol}`), JSON.stringify([body, eol, edit]))
        // Whatever lines were added use the card's own line ending.
        assert.equal(result.replaceAll(eol, '').includes('\n') && eol === '\r\n' && !body.includes('\n'), false)
      }
    }
  }
})

test('the frontmatter keeps its line ending: a card written on Windows stays Windows, in the lines that are added too', () => {
  const card = '---\r\nstatus: todo\r\nfor: sales\r\n---\r\n\r\n# Call\r\n'
  assert.equal(setFrontmatter(card, { status: 'done', doneAt: '2026-10-12' }), '---\r\nstatus: done\r\ndone_at: 2026-10-12\r\nfor: sales\r\n---\r\n\r\n# Call\r\n')
  const onlyStatus = '---\r\nstatus: todo\r\n---\r\n# Call\r\n'
  assert.equal(setFrontmatter(onlyStatus, { status: 'done', doneAt: '2026-10-12' }), '---\r\nstatus: done\r\ndone_at: 2026-10-12\r\n---\r\n# Call\r\n')
})

test('a status written twice, or written in quotes, or not there at all, still ends as the one status asked for', () => {
  assert.equal(parseFrontmatter(setFrontmatter('---\nstatus: todo\nfor: a\nstatus: doing\n---\nbody\n', { status: 'done', doneAt: '2026-10-12' })).data.status, 'done')
  assert.equal(setFrontmatter('---\nstatus: "todo"\n---\nbody\n', { status: 'doing' }), '---\nstatus: doing\n---\nbody\n')
  assert.equal(setFrontmatter('---\nfor: sales\n---\nbody\n', { status: 'doing' }), '---\nstatus: doing\nfor: sales\n---\nbody\n')
  assert.equal(setFrontmatter('---\nfor: sales\n---\nbody\n', { status: 'done', doneAt: '2026-10-12' }), '---\nstatus: done\ndone_at: 2026-10-12\nfor: sales\n---\nbody\n')
  assert.equal(setFrontmatter('---\nstatus: todo\ndone_at: 2026-01-01\ndone_at: 2026-02-02\n---\nx\n', { status: 'done', doneAt: '2026-10-12' }), '---\nstatus: done\ndone_at: 2026-10-12\ndone_at: 2026-10-12\n---\nx\n')
})

test('only a key at the start of a line in the frontmatter is the key: an indented or longer name, a comment, or the same words in the body are left alone', () => {
  const card = '---\n# status: none\nstatus_note: keep\n  status: indented\nstatus: todo\n---\nstatus: body\n'
  assert.equal(setFrontmatter(card, { status: 'doing' }), '---\n# status: none\nstatus_note: keep\n  status: indented\nstatus: doing\n---\nstatus: body\n')
})

test('the frontmatter ends where the reader of the board says it ends - at the first line that starts with three dashes', () => {
  const card = '---\nstatus: todo\n---- not an end in a real file\nfor: x\n---\nbody\n'
  // The board's reader (frontmatter.mjs) stops at the first "\n---". So does this.
  assert.deepEqual(parseFrontmatter(card).data, { status: 'todo' })
  assert.equal(setFrontmatter(card, { status: 'done', doneAt: '2026-10-12' }), '---\nstatus: done\ndone_at: 2026-10-12\n---- not an end in a real file\nfor: x\n---\nbody\n')
})

test('a card with no frontmatter gets one in front, and its text after is exactly what it was', () => {
  const body = '# Old card\r\n\r\nNo frontmatter here.'
  assert.equal(setFrontmatter(body, { status: 'doing' }), `---\nstatus: doing\n---\n${body}`)
  assert.equal(setFrontmatter(body, { status: 'done', doneAt: '2026-10-12' }), `---\nstatus: done\ndone_at: 2026-10-12\n---\n${body}`)
  for (const notFrontmatter of ['---\n---\nbody', '--- \nstatus: todo\n---\nbody', ' ---\nstatus: todo\n---\nbody', '---\nstatus: todo\nbody with no end']) {
    assert.equal(setFrontmatter(notFrontmatter, { status: 'doing' }), `---\nstatus: doing\n---\n${notFrontmatter}`, JSON.stringify(notFrontmatter))
  }
})

test('a status that is not one of the three, or a day that is not a day, is a mistake in the caller and throws', () => {
  for (const status of ['', 'finished', 'DONE', undefined, null, 7, 'todo\nfor: x']) assert.throws(() => setFrontmatter(CARD, { status }), TypeError, String(status))
  for (const doneAt of ['', 'today', '2026-13-01', '2026-10-12T00:00', '10/12/2026', 20261012, null]) assert.throws(() => setFrontmatter(CARD, { status: 'done', doneAt }), TypeError, String(doneAt))
  assert.throws(() => setFrontmatter(CARD, { status: 'done' }), TypeError, 'done needs its day')
})

/* ---------- Pause: one line ---------------------------------------------------------------------------------------- */

const MORNING = await readFile(join(repoRoot, 'workflows', 'morning-intel.yml'), 'utf8')

test('Pause comments out the schedule line of the workflow, keeping its words and its indent, and changes nothing else', () => {
  const result = commentOutSchedule(MORNING)
  assert.equal(result.changed, true)
  assert.equal(result.text, MORNING.replace('  schedule: "daily 06:30"', '  # schedule: "daily 06:30"'))
  const before = MORNING.split('\n')
  const after = result.text.split('\n')
  assert.equal(before.filter((line, at) => line !== after[at]).length, 1, 'one line')
  assert.equal(parseSimpleYaml(result.text).trigger.schedule, undefined, 'the board no longer sees a schedule')
  assert.equal(parseSimpleYaml(result.text).trigger.fire, true, 'and still sees the rest')
})

test('a workflow with no schedule line, or whose schedule is already commented out, is already paused: nothing changes', () => {
  const paused = commentOutSchedule(MORNING).text
  assert.deepEqual(commentOutSchedule(paused), { text: paused, changed: false })
  const none = MORNING.replace(/ {2}schedule:.*\n/, '')
  assert.deepEqual(commentOutSchedule(none), { text: none, changed: false })
})

test('only a schedule inside the trigger is paused; a line that merely starts with the same word, a note and another block are not', () => {
  const text = [
    '# a note: schedule: not this one',
    'name: Example',
    'schedule_note: leave me',
    'steps: [a, b]',
    'trigger:',
    '  armed: true',
    '  schedule: "daily 06:30"',
    '  schedule_extra: leave me too',
    '  fire: true',
    'other:',
    '  schedule: "not in the trigger"',
    'output: inbox/{date}/x.md',
    ''
  ].join('\n')
  assert.equal(commentOutSchedule(text).text, text.replace('  schedule: "daily 06:30"', '  # schedule: "daily 06:30"'))
})

test('every active schedule line in the trigger is paused - the reader of the board takes the last one, so one left would still run', () => {
  const text = 'trigger:\n  schedule: "daily 06:30"\n  armed: true\n  schedule: "daily 07:30"\n'
  assert.equal(commentOutSchedule(text).text, 'trigger:\n  # schedule: "daily 06:30"\n  armed: true\n  # schedule: "daily 07:30"\n')
})

test('a workflow written on Windows keeps its line endings and its byte order mark', () => {
  const mark = String.fromCharCode(0xfeff)
  const text = `${mark}${MORNING.replaceAll('\n', '\r\n')}`
  const result = commentOutSchedule(text)
  assert.equal(result.text, text.replace('  schedule: "daily 06:30"', '  # schedule: "daily 06:30"'))
  assert.ok(result.text.startsWith(mark))
})

/* ---------- Approve: one row, and only when it is certain which -------------------------------------------------- */

const PROPOSALS = [
  '# proposals written by /match',
  'proposals:',
  '  - task: Writing the newsletter',
  '    item: agent:content',
  '    why: its description names newsletters directly',
  '    words: I write the newsletter myself',
  '    number: 3 hours a week, 450 a week',
  '',
  '  - task: "Weekly brief: Caf\u00e9 \u2615 edition"',
  '    item: workflow:weekly-review',
  '    why: it is the weekly brief',
  '  - task: Sorting the inbox',
  '    item: agent:email',
  'gaps:',
  '  - task: Writing the newsletter',
  '    why: not a proposal, a gap',
  ''
].join('\n')

test('Approve adds approved: true to the one row whose task matches word for word, at the end of that row, and changes nothing else', () => {
  const result = approveRow(PROPOSALS, 'Writing the newsletter')
  assert.equal(result.state, 'ok')
  assert.equal(result.changed, true)
  const expected = PROPOSALS.replace('    number: 3 hours a week, 450 a week\n', '    number: 3 hours a week, 450 a week\n    approved: true\n')
  assert.equal(result.text, expected)
  const rows = parseSimpleYaml(result.text).proposals
  assert.deepEqual(rows.map((row) => row.approved), [true, undefined, undefined])
  assert.equal(parseSimpleYaml(result.text).gaps[0].approved, undefined, 'a gap with the same words is not a proposal')
})

test('a row in quotes, and one at the end of its block or of the file, take the line at the right place and the right indent', () => {
  const quoted = approveRow(PROPOSALS, 'Weekly brief: Caf\u00e9 \u2615 edition')
  assert.equal(quoted.text, PROPOSALS.replace('    why: it is the weekly brief\n', '    why: it is the weekly brief\n    approved: true\n'))
  const last = approveRow(PROPOSALS, 'Sorting the inbox')
  assert.equal(last.text, PROPOSALS.replace('    item: agent:email\n', '    item: agent:email\n    approved: true\n'))
  const atEnd = 'proposals:\n  - task: Only row\n    item: agent:x'
  assert.equal(approveRow(atEnd, 'Only row').text, 'proposals:\n  - task: Only row\n    item: agent:x\n    approved: true')
  const oneLine = 'proposals:\n  - task: Only row\n'
  assert.equal(approveRow(oneLine, 'Only row').text, 'proposals:\n  - task: Only row\n    approved: true\n')
  const wide = 'proposals:\n    -   task: Wide\n        item: agent:x\n'
  assert.equal(approveRow(wide, 'Wide').text, 'proposals:\n    -   task: Wide\n        item: agent:x\n        approved: true\n')
  const tabs = 'proposals:\n\t- task: Tabbed\n\t  item: agent:x\n'
  assert.equal(approveRow(tabs, 'Tabbed').state, 'ok')
})

test('comments and blank lines after a row stay after it', () => {
  const text = 'proposals:\n  - task: A\n    item: agent:x\n    # a note about A\n\n  # about B\n  - task: B\n    item: agent:y\n'
  assert.equal(approveRow(text, 'A').text, 'proposals:\n  - task: A\n    item: agent:x\n    # a note about A\n    approved: true\n\n  # about B\n  - task: B\n    item: agent:y\n')
})

test('a row already approved is left as it is; a row that says approved something else is set to true, wherever its line is', () => {
  const done = approveRow(PROPOSALS.replace('    item: agent:content\n', '    item: agent:content\n    approved: true\n'), 'Writing the newsletter')
  assert.deepEqual(done, { state: 'ok', text: PROPOSALS.replace('    item: agent:content\n', '    item: agent:content\n    approved: true\n'), changed: false })
  const no = approveRow(PROPOSALS.replace('    item: agent:content\n', '    item: agent:content\n    approved: false\n'), 'Writing the newsletter')
  assert.equal(no.text, PROPOSALS.replace('    item: agent:content\n', '    item: agent:content\n    approved: true\n'))
  assert.equal(no.changed, true)
  const twice = approveRow('proposals:\n  - task: A\n    approved: no\n    item: x\n    approved: false\n', 'A')
  assert.equal(twice.text, 'proposals:\n  - task: A\n    approved: true\n    item: x\n    approved: true\n')
})

test('no row, or more than one row, or a row that is only similar: no change, and it says which', () => {
  for (const task of ['Writing the newsletter ', ' Writing the newsletter', 'writing the newsletter', 'Writing the', 'Writing the newsletter?', 'Something else', '']) {
    assert.deepEqual(approveRow(PROPOSALS, task), { state: 'none' }, JSON.stringify(task))
  }
  const twice = PROPOSALS.replace('  - task: Sorting the inbox\n', '  - task: Writing the newsletter\n')
  assert.deepEqual(approveRow(twice, 'Writing the newsletter'), { state: 'several' })
  assert.equal(approveRow(twice, 'Sorting the inbox').state, 'none')
})

test('a file that is not a proposals file has no row: nothing is guessed', () => {
  for (const text of ['', 'nothing here\n', 'proposals:\n', 'proposals: []\n', 'proposals: none\n', 'gaps:\n  - task: A\n', '- task: A\n', 'proposals:\n- task: A\n', 'proposals:\n  - {task: A}\n', 'proposals:\n  - A\n', 'other:\n  - task: A\n']) {
    assert.deepEqual(approveRow(text, 'A'), { state: 'none' }, JSON.stringify(text))
  }
})

test('the row is found the way the board reads the file: the last proposals: block, and a block ends at the next key', () => {
  const text = 'proposals:\n  - task: Old\n    item: x\nproposals:\n  - task: New\n    item: y\nversion: 2\n  - task: After\n'
  assert.deepEqual(approveRow(text, 'Old'), { state: 'none' }, 'the earlier block is replaced by the later one')
  assert.equal(approveRow(text, 'New').text, 'proposals:\n  - task: Old\n    item: x\nproposals:\n  - task: New\n    item: y\n    approved: true\nversion: 2\n  - task: After\n')
  assert.deepEqual(approveRow(text, 'After'), { state: 'none' }, 'after another key it is no longer in the block')
})

test('a proposals file written on Windows, with a byte order mark, or without a last line break, keeps all three', () => {
  const mark = String.fromCharCode(0xfeff)
  const crlf = `${mark}${PROPOSALS.replaceAll('\n', '\r\n')}`
  const result = approveRow(crlf, 'Writing the newsletter')
  assert.equal(result.text, crlf.replace('    number: 3 hours a week, 450 a week\r\n', '    number: 3 hours a week, 450 a week\r\n    approved: true\r\n'))
  const bare = 'proposals:\r\n  - task: A\r\n    item: x'
  assert.equal(approveRow(bare, 'A').text, 'proposals:\r\n  - task: A\r\n    item: x\r\n    approved: true')
})

/* ---------- the whole action on a work copy ------------------------------------------------------------------------ */

const WORKFLOW_FILES = { 'workflows/morning-intel.yml': MORNING, 'workflows/README.md': '# workflows\n' }

test('Add task writes one new file in tasks/, named by the day and the title, and nothing else in the work copy changes', async () => {
  const work = await workCopy({ 'tasks/README.md': '# tasks\n', ...WORKFLOW_FILES })
  try {
    const before = await snapshot(work.dir)
    const result = await applyCard({ root: work.dir, action: 'task', fields: { title: 'Chase the invoice', details: 'Ask about the September lead time.', for: 'research', model: 'sonnet' }, ...OPTIONS })
    assert.deepEqual(result, { ok: true, paths: ['tasks/2026-10-12-chase-the-invoice.md'], changed: true })
    assert.equal(await work.read('tasks/2026-10-12-chase-the-invoice.md'), '---\nstatus: todo\nfor: research\nmodel: sonnet\n---\n\n# Chase the invoice\n\nAsk about the September lead time.\n')
    assert.deepEqual(changedFiles(before, await snapshot(work.dir)), ['tasks/2026-10-12-chase-the-invoice.md'])
  } finally {
    await work.cleanup()
  }
})

test('a card is never overwritten: the same title again is the same name with -2, then -3', async () => {
  const work = await workCopy({ 'tasks/README.md': '# tasks\n' })
  try {
    const paths = []
    for (let again = 0; again < 4; again += 1) paths.push((await applyCard({ root: work.dir, action: 'task', fields: { title: 'Chase the invoice' }, ...OPTIONS })).paths[0])
    assert.deepEqual(paths, ['tasks/2026-10-12-chase-the-invoice.md', 'tasks/2026-10-12-chase-the-invoice-2.md', 'tasks/2026-10-12-chase-the-invoice-3.md', 'tasks/2026-10-12-chase-the-invoice-4.md'])
    await writeFile(join(work.dir, 'tasks', '2026-10-12-other-card.md'), 'the owner\'s own words')
    const taken = await workCopy({ 'tasks/2026-10-12-other-card.md': 'the owner\'s own words' })
    try {
      await applyCard({ root: taken.dir, action: 'task', fields: { title: 'Other card' }, ...OPTIONS })
      assert.equal(await taken.read('tasks/2026-10-12-other-card.md'), 'the owner\'s own words')
      assert.ok((await readdir(join(taken.dir, 'tasks'))).includes('2026-10-12-other-card-2.md'))
    } finally {
      await taken.cleanup()
    }
  } finally {
    await work.cleanup()
  }
})

test('a name taken by a link, even one that points nowhere, is taken: the link is not followed or replaced', async () => {
  const work = await workCopy({ 'tasks/README.md': '# tasks\n' })
  const outside = await workCopy({ 'secret.txt': 'outside the repo' })
  try {
    try {
      await symlink(join(outside.dir, 'secret.txt'), join(work.dir, 'tasks', '2026-10-12-chase-the-invoice.md'))
      await symlink(join(outside.dir, 'nowhere.txt'), join(work.dir, 'tasks', '2026-10-12-chase-the-invoice-2.md'))
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return
      throw error
    }
    const result = await applyCard({ root: work.dir, action: 'task', fields: { title: 'Chase the invoice' }, ...OPTIONS })
    assert.equal(result.ok, true)
    assert.deepEqual(result.paths, ['tasks/2026-10-12-chase-the-invoice-3.md'])
    assert.equal(await outside.read('secret.txt'), 'outside the repo')
    assert.deepEqual(await readdir(outside.dir), ['secret.txt'])
  } finally {
    await Promise.all([work.cleanup(), outside.cleanup()])
  }
})

test('if every name up to -99 is taken the card is not written and the order fails', async () => {
  const files = { 'tasks/README.md': '# tasks\n', 'tasks/2026-10-12-busy.md': 'x' }
  for (let number = 2; number <= 99; number += 1) files[`tasks/2026-10-12-busy-${number}.md`] = 'x'
  const work = await workCopy(files)
  try {
    const before = await snapshot(work.dir)
    assert.deepEqual(await applyCard({ root: work.dir, action: 'task', fields: { title: 'Busy' }, ...OPTIONS }), { ok: false, state: 'failed', why: 'change-refused' })
    assert.deepEqual(await snapshot(work.dir), before)
  } finally {
    await work.cleanup()
  }
})

test('a title can never choose where the card goes: whatever it says, the card is one new file directly in tasks/', async () => {
  const titles = ['../../../etc/passwd', '..\\..\\Windows\\win.ini', '/etc/cron.d/x', 'C:\\Users\\x\\file', 'tasks/../.github/workflows/x', 'CON', 'NUL.txt', 'aux', '.hidden', '....', '~root', '$(whoami)', '`id`', 'a'.repeat(200), '\u{1F680}', '--help', '-rf', 'x.md', 'x\u0000y'.replace('\u0000', ' ')]
  for (const title of titles) {
    const work = await workCopy({ 'tasks/README.md': '# tasks\n', '.github/workflows/ci.yml': 'name: ci\n', 'package.json': '{}\n' })
    try {
      const before = await snapshot(work.dir)
      const result = await applyCard({ root: work.dir, action: 'task', fields: { title }, ...OPTIONS })
      assert.equal(result.ok, true, title)
      assert.equal(result.paths.length, 1, title)
      assert.match(result.paths[0], /^tasks\/2026-10-12-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/, title)
      const changed = changedFiles(before, await snapshot(work.dir))
      assert.deepEqual(changed, result.paths, title)
      assert.ok((await readFile(join(work.dir, result.paths[0]), 'utf8')).includes(`# ${title}\n`), title)
    } finally {
      await work.cleanup()
    }
  }
})

test('with no tasks folder yet, Add task makes it; if tasks is a link, nothing is written through it', async () => {
  const bare = await workCopy({ 'README.md': 'x' })
  const linked = await workCopy({ 'README.md': 'x' })
  const target = await workCopy({ 'keep.txt': 'x' })
  try {
    assert.deepEqual((await applyCard({ root: bare.dir, action: 'task', fields: { title: 'First card' }, ...OPTIONS })).paths, ['tasks/2026-10-12-first-card.md'])
    try {
      await symlink(target.dir, join(linked.dir, 'tasks'), 'junction')
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return
      throw error
    }
    assert.deepEqual(await applyCard({ root: linked.dir, action: 'task', fields: { title: 'First card' }, ...OPTIONS }), { ok: false, state: 'failed', why: 'change-refused' })
    assert.deepEqual(await readdir(target.dir), ['keep.txt'])
  } finally {
    await Promise.all([bare.cleanup(), linked.cleanup(), target.cleanup()])
  }
})

test('git\'s own record counts too: a tasks folder that git holds as a link is refused even where this system checked it out as a plain file', async () => {
  const work = await workCopy({ 'tasks/README.md': '# tasks\n' })
  try {
    const git = async (args) => ({ stdout: args[0] === 'ls-files' ? '120000 0123456789abcdef0123456789abcdef01234567 0\ttasks\n' : '' })
    assert.deepEqual(await applyCard({ root: work.dir, action: 'task', fields: { title: 'A card' }, git, ...OPTIONS }), { ok: false, state: 'failed', why: 'change-refused' })
    assert.deepEqual(await readdir(join(work.dir, 'tasks')), ['README.md'])
  } finally {
    await work.cleanup()
  }
})

test('Arm, Add skill and Add agent each file one card for the owner and nothing else; Arm needs the workflow to exist', async () => {
  const work = await workCopy({ 'tasks/README.md': '# tasks\n', ...WORKFLOW_FILES })
  try {
    const before = await snapshot(work.dir)
    const arm = await applyCard({ root: work.dir, action: 'arm', fields: { workflow: 'morning-intel' }, ...OPTIONS })
    assert.deepEqual(arm, { ok: true, paths: ['tasks/2026-10-12-set-up-a-schedule-for-morning-intel.md'], changed: true })
    const skill = await applyCard({ root: work.dir, action: 'skill', fields: { title: 'Summarise a sales call', details: 'Keep it short.' }, ...OPTIONS })
    assert.deepEqual(skill.paths, ['tasks/2026-10-12-add-a-skill-summarise-a-sales-call.md'])
    const agent = await applyCard({ root: work.dir, action: 'agent', fields: { title: 'A bookkeeper who reconciles receipts' }, ...OPTIONS })
    assert.deepEqual(agent.paths, ['tasks/2026-10-12-add-an-agent-a-bookkeeper-who-reconciles.md'])
    assert.equal(await work.read(arm.paths[0]), needsYouCard('arm', { workflow: 'morning-intel' }).text)
    assert.deepEqual(changedFiles(before, await snapshot(work.dir)), [...arm.paths, ...skill.paths, ...agent.paths].sort())
    assert.equal(await work.read('workflows/morning-intel.yml'), MORNING, 'nothing was armed or paused')
    assert.deepEqual(await applyCard({ root: work.dir, action: 'arm', fields: { workflow: 'no-such-job' }, ...OPTIONS }), { ok: false, state: 'refused', why: 'no-workflow' })
  } finally {
    await work.cleanup()
  }
})

test('Arm for a workflow that is a folder, or a link, is not a workflow either', async () => {
  const work = await workCopy({ 'tasks/README.md': '# tasks\n', 'workflows/README.md': 'x' })
  const target = await workCopy({ 'real.yml': 'name: x\n' })
  try {
    await mkdir(join(work.dir, 'workflows', 'a-folder.yml'))
    assert.deepEqual(await applyCard({ root: work.dir, action: 'arm', fields: { workflow: 'a-folder' }, ...OPTIONS }), { ok: false, state: 'refused', why: 'no-workflow' })
    try {
      await symlink(join(target.dir, 'real.yml'), join(work.dir, 'workflows', 'linked.yml'))
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return
      throw error
    }
    assert.deepEqual(await applyCard({ root: work.dir, action: 'arm', fields: { workflow: 'linked' }, ...OPTIONS }), { ok: false, state: 'failed', why: 'change-refused' })
  } finally {
    await Promise.all([work.cleanup(), target.cleanup()])
  }
})

test('Start and Done change the card\'s frontmatter and not one byte of its body, on disk', async () => {
  const body = '\r\n# Call the supplier\r\n\r\nAsk  about \t the lead time.  \r\n\r\n---\r\nstatus: done\r\n---'
  const card = `---\nstatus: todo\nfor: sales\n---${body}`
  const work = await workCopy({ 'tasks/2026-08-18-call-supplier.md': card, 'tasks/README.md': '# tasks\n' })
  try {
    const before = await snapshot(work.dir)
    const started = await applyCard({ root: work.dir, action: 'move', fields: { task: '2026-08-18-call-supplier', status: 'doing' }, ...OPTIONS })
    assert.deepEqual(started, { ok: true, paths: ['tasks/2026-08-18-call-supplier.md'], changed: true })
    assert.equal(await work.read('tasks/2026-08-18-call-supplier.md'), `---\nstatus: doing\nfor: sales\n---${body}`)
    const done = await applyCard({ root: work.dir, action: 'move', fields: { task: '2026-08-18-call-supplier', status: 'done' }, ...OPTIONS })
    assert.equal(done.ok, true)
    assert.equal(await work.read('tasks/2026-08-18-call-supplier.md'), `---\nstatus: done\ndone_at: 2026-10-12\nfor: sales\n---${body}`)
    assert.deepEqual(changedFiles(before, await snapshot(work.dir)), ['tasks/2026-08-18-call-supplier.md'])
  } finally {
    await work.cleanup()
  }
})

test('Done writes the day where the person is, not the day in UTC', async () => {
  const work = await workCopy({ 'tasks/2026-08-18-call-supplier.md': CARD })
  try {
    await applyCard({ root: work.dir, action: 'move', fields: { task: '2026-08-18-call-supplier', status: 'done' }, now: Date.parse('2026-10-12T23:30:00.000Z'), timeZone: 'Asia/Tokyo' })
    assert.ok((await work.read('tasks/2026-08-18-call-supplier.md')).includes('done_at: 2026-10-13\n'))
  } finally {
    await work.cleanup()
  }
})

test('Start on a card that is already started changes nothing and says so', async () => {
  const work = await workCopy({ 'tasks/2026-08-18-call-supplier.md': CARD.replace('todo', 'doing') })
  try {
    assert.deepEqual(await applyCard({ root: work.dir, action: 'move', fields: { task: '2026-08-18-call-supplier', status: 'doing' }, ...OPTIONS }), { ok: true, paths: [], changed: false })
  } finally {
    await work.cleanup()
  }
})

test('a card that is not there - no file, a folder, a card named with a path - is "card not found" and nothing is made', async () => {
  const work = await workCopy({ 'tasks/README.md': '# tasks\n', 'outside.md': 'not a card' })
  try {
    await mkdir(join(work.dir, 'tasks', 'a-folder.md'))
    const before = await snapshot(work.dir)
    // 'readme' is the folder's own README, which a system that ignores capitals finds under a card's kind of name.
    for (const task of ['2026-08-18-call-supplier', 'a-folder', 'README', 'readme', '../outside', 'outside.md', '', undefined]) {
      const answer = await applyCard({ root: work.dir, action: 'move', fields: { task, status: 'doing' }, ...OPTIONS })
      assert.deepEqual(answer, { ok: false, state: 'refused', why: 'card-not-found' }, String(task))
    }
    assert.deepEqual(await snapshot(work.dir), before)
  } finally {
    await work.cleanup()
  }
})

test('a card that is a link is refused and not followed; a card too big to be a card is not found', async () => {
  const work = await workCopy({ 'tasks/README.md': '# tasks\n', 'tasks/big.md': `---\nstatus: todo\n---\n${'x'.repeat(CARD_FILE_MAX_BYTES)}` })
  const target = await workCopy({ 'real.md': CARD })
  try {
    assert.deepEqual(await applyCard({ root: work.dir, action: 'move', fields: { task: 'big', status: 'doing' }, ...OPTIONS }), { ok: false, state: 'refused', why: 'card-not-found' })
    try {
      await symlink(join(target.dir, 'real.md'), join(work.dir, 'tasks', 'linked.md'))
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return
      throw error
    }
    assert.deepEqual(await applyCard({ root: work.dir, action: 'move', fields: { task: 'linked', status: 'doing' }, ...OPTIONS }), { ok: false, state: 'failed', why: 'change-refused' })
    assert.equal(await target.read('real.md'), CARD)
  } finally {
    await Promise.all([work.cleanup(), target.cleanup()])
  }
})

test('Pause comments out one line of the workflow file and nothing else changes in the work copy', async () => {
  const work = await workCopy({ 'tasks/README.md': '# tasks\n', ...WORKFLOW_FILES })
  try {
    const before = await snapshot(work.dir)
    const result = await applyCard({ root: work.dir, action: 'pause', fields: { workflow: 'morning-intel' }, ...OPTIONS })
    assert.deepEqual(result, { ok: true, paths: ['workflows/morning-intel.yml'], changed: true })
    assert.equal(await work.read('workflows/morning-intel.yml'), commentOutSchedule(MORNING).text)
    assert.deepEqual(changedFiles(before, await snapshot(work.dir)), ['workflows/morning-intel.yml'])
    assert.deepEqual(await applyCard({ root: work.dir, action: 'pause', fields: { workflow: 'morning-intel' }, ...OPTIONS }), { ok: true, paths: [], changed: false }, 'paused twice is paused')
  } finally {
    await work.cleanup()
  }
})

test('Pause of a job with no workflow file is "no workflow"; one that is a link is refused', async () => {
  const work = await workCopy({ 'workflows/README.md': 'x' })
  const target = await workCopy({ 'real.yml': MORNING })
  try {
    assert.deepEqual(await applyCard({ root: work.dir, action: 'pause', fields: { workflow: 'no-such-job' }, ...OPTIONS }), { ok: false, state: 'refused', why: 'no-workflow' })
    try {
      await symlink(join(target.dir, 'real.yml'), join(work.dir, 'workflows', 'linked.yml'))
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return
      throw error
    }
    assert.deepEqual(await applyCard({ root: work.dir, action: 'pause', fields: { workflow: 'linked' }, ...OPTIONS }), { ok: false, state: 'failed', why: 'change-refused' })
    assert.equal(await target.read('real.yml'), MORNING)
  } finally {
    await Promise.all([work.cleanup(), target.cleanup()])
  }
})

test('Approve adds the one line to the one row in proposals.yml, and nothing else in the work copy changes', async () => {
  const work = await workCopy({ 'tasks/README.md': '# tasks\n', 'proposals.yml': PROPOSALS })
  try {
    const before = await snapshot(work.dir)
    const result = await applyCard({ root: work.dir, action: 'approve', fields: { task: 'Writing the newsletter' }, ...OPTIONS })
    assert.deepEqual(result, { ok: true, paths: ['proposals.yml'], changed: true })
    assert.equal(await work.read('proposals.yml'), approveRow(PROPOSALS, 'Writing the newsletter').text)
    assert.deepEqual(changedFiles(before, await snapshot(work.dir)), ['proposals.yml'])
    assert.deepEqual(await applyCard({ root: work.dir, action: 'approve', fields: { task: 'Writing the newsletter' }, ...OPTIONS }), { ok: true, paths: [], changed: false })
  } finally {
    await work.cleanup()
  }
})

test('Approve with no proposals.yml, no matching row, or two: refused with the reason, and the file is not touched', async () => {
  const none = await workCopy({ 'tasks/README.md': '# tasks\n' })
  const twice = await workCopy({ 'proposals.yml': 'proposals:\n  - task: A\n  - task: A\n' })
  const one = await workCopy({ 'proposals.yml': PROPOSALS })
  try {
    assert.deepEqual(await applyCard({ root: none.dir, action: 'approve', fields: { task: 'A' }, ...OPTIONS }), { ok: false, state: 'refused', why: 'no-such-row' })
    assert.deepEqual(await applyCard({ root: twice.dir, action: 'approve', fields: { task: 'A' }, ...OPTIONS }), { ok: false, state: 'refused', why: 'several-rows' })
    assert.equal(await twice.read('proposals.yml'), 'proposals:\n  - task: A\n  - task: A\n')
    assert.deepEqual(await applyCard({ root: one.dir, action: 'approve', fields: { task: 'Writing the' }, ...OPTIONS }), { ok: false, state: 'refused', why: 'no-such-row' })
    assert.equal(await one.read('proposals.yml'), PROPOSALS)
  } finally {
    await Promise.all([none.cleanup(), twice.cleanup(), one.cleanup()])
  }
})

test('Approve with proposals.yml as a folder or too big is no row; as a link it is refused and not followed', async () => {
  const folder = await workCopy({ 'tasks/README.md': 'x' })
  const big = await workCopy({ 'proposals.yml': `proposals:\n  - task: A\n# ${'x'.repeat(CARD_FILE_MAX_BYTES)}\n` })
  const linked = await workCopy({ 'tasks/README.md': 'x' })
  const target = await workCopy({ 'real.yml': PROPOSALS })
  try {
    await mkdir(join(folder.dir, 'proposals.yml'))
    assert.deepEqual(await applyCard({ root: folder.dir, action: 'approve', fields: { task: 'A' }, ...OPTIONS }), { ok: false, state: 'refused', why: 'no-such-row' })
    assert.deepEqual(await applyCard({ root: big.dir, action: 'approve', fields: { task: 'A' }, ...OPTIONS }), { ok: false, state: 'refused', why: 'no-such-row' })
    try {
      await symlink(join(target.dir, 'real.yml'), join(linked.dir, 'proposals.yml'))
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return
      throw error
    }
    assert.deepEqual(await applyCard({ root: linked.dir, action: 'approve', fields: { task: 'Writing the newsletter' }, ...OPTIONS }), { ok: false, state: 'failed', why: 'change-refused' })
    assert.equal(await target.read('real.yml'), PROPOSALS)
  } finally {
    await Promise.all([folder.cleanup(), big.cleanup(), linked.cleanup(), target.cleanup()])
  }
})

test('an edit is written whole or not at all: no temporary file is left in the work copy', async () => {
  const work = await workCopy({ 'tasks/2026-08-18-call-supplier.md': CARD, 'proposals.yml': PROPOSALS, ...WORKFLOW_FILES })
  try {
    await applyCard({ root: work.dir, action: 'move', fields: { task: '2026-08-18-call-supplier', status: 'done' }, ...OPTIONS })
    await applyCard({ root: work.dir, action: 'approve', fields: { task: 'Sorting the inbox' }, ...OPTIONS })
    await applyCard({ root: work.dir, action: 'pause', fields: { workflow: 'morning-intel' }, ...OPTIONS })
    await applyCard({ root: work.dir, action: 'task', fields: { title: 'A new card' }, ...OPTIONS })
    const names = Object.keys(await snapshot(work.dir))
    assert.ok(!names.some((name) => name.endsWith('.tmp')), JSON.stringify(names))
  } finally {
    await work.cleanup()
  }
})

test('the file mode of a card is not changed by an edit', async (t) => {
  if (process.platform === 'win32') return t.skip('this system has no file modes to keep')
  const work = await workCopy({ 'tasks/2026-08-18-call-supplier.md': CARD })
  try {
    const before = (await stat(join(work.dir, 'tasks', '2026-08-18-call-supplier.md'))).mode & 0o777
    await applyCard({ root: work.dir, action: 'move', fields: { task: '2026-08-18-call-supplier', status: 'done' }, ...OPTIONS })
    assert.equal((await stat(join(work.dir, 'tasks', '2026-08-18-call-supplier.md'))).mode & 0o777, before)
  } finally {
    await work.cleanup()
  }
})

test('only the card actions are done here: a run is Claude\'s, and anything else is a mistake in the caller', async () => {
  const work = await workCopy({ 'tasks/README.md': 'x' })
  try {
    for (const action of ['run', 'delete', '__proto__', '', undefined, 7]) {
      await assert.rejects(applyCard({ root: work.dir, action, fields: {}, ...OPTIONS }), TypeError, String(action))
    }
  } finally {
    await work.cleanup()
  }
})

/* ---------- more edges: the cases a careless edit gets wrong ------------------------------------------------------- */

test('a column-0 comment inside the trigger block does not end it, and a byte order mark in front of "trigger:" does not hide it', () => {
  const text = 'name: X\ntrigger:\n# a note inside the block\n  schedule: "daily 06:30"\n'
  assert.equal(commentOutSchedule(text).text, 'name: X\ntrigger:\n# a note inside the block\n  # schedule: "daily 06:30"\n')
  const mark = String.fromCharCode(0xfeff)
  assert.equal(commentOutSchedule(`${mark}trigger:\n  schedule: "daily 06:30"\n`).text, `${mark}trigger:\n  # schedule: "daily 06:30"\n`)
})

// A row that is a dash with a word, then keys of the next row: the reader of the board counts differently from a
// reader that counts dashes, and an edit by dash count would land on the wrong row.
const MISALIGNED = 'proposals:\n  - weird\n    task: A\n  - task: B\n    item: y\n'

test('where counting rows by their dashes would point at the wrong row, nothing is edited - the result is read back and must differ in that one row only', () => {
  assert.deepEqual(parseSimpleYaml(MISALIGNED).proposals, [{ task: 'B', item: 'y' }], 'the board sees one row')
  assert.deepEqual(approveRow(MISALIGNED, 'B'), { state: 'none' })
  assert.deepEqual(approveRow(MISALIGNED, 'A'), { state: 'none' })
})

test('a row that is already approved is still reported approved in a file like that: nothing is edited so nothing can go wrong', () => {
  const text = `${MISALIGNED}    approved: true\n`
  assert.deepEqual(approveRow(text, 'B'), { state: 'ok', text, changed: false })
})

test('a dash at the start of a line is not a row to the board, so it is not one here', () => {
  const text = 'proposals:\n- not a row\n  - task: A\n    item: x\n'
  assert.equal(approveRow(text, 'A').text, 'proposals:\n- not a row\n  - task: A\n    item: x\n    approved: true\n')
})

test('the new line is indented like the keys of its own row, and a row with no keys of its own does not borrow another row\'s', () => {
  const wide = 'proposals:\n  - task: A\n          item: x\n'
  assert.equal(approveRow(wide, 'A').text, 'proposals:\n  - task: A\n          item: x\n          approved: true\n')
  const alone = 'proposals:\n  - task: A\n  - task: B\n      item: far-in\n'
  assert.equal(approveRow(alone, 'A').text, 'proposals:\n  - task: A\n    approved: true\n  - task: B\n      item: far-in\n')
})

test('an approved line in the dash line itself is set too', () => {
  const text = 'proposals:\n  - approved: false\n    task: A\n'
  assert.equal(approveRow(text, 'A').text, 'proposals:\n  - approved: true\n    task: A\n')
})

test('the days Date forgives, and the shapes that are not a day, are not a day', () => {
  for (const doneAt of ['2026-02-30', '2025-02-29', '2026', '2026-10', ['2026-10-12'], new String('2026-10-12')]) {
    assert.throws(() => setFrontmatter(CARD, { status: 'done', doneAt }), TypeError, String(doneAt))
  }
  assert.doesNotThrow(() => setFrontmatter(CARD, { status: 'done', doneAt: '2024-02-29' }))
})

test('a card just over 256 KB is too big to be one, and just under is fine', async () => {
  const head = '---\nstatus: todo\n---\n'
  const under = `${head}${'x'.repeat(262144 - head.length)}`
  assert.equal(Buffer.byteLength(under), 262144)
  const work = await workCopy({ 'tasks/under.md': under, 'tasks/over.md': `${under}x` })
  try {
    assert.equal((await applyCard({ root: work.dir, action: 'move', fields: { task: 'under', status: 'doing' }, ...OPTIONS })).ok, true)
    assert.deepEqual(await applyCard({ root: work.dir, action: 'move', fields: { task: 'over', status: 'doing' }, ...OPTIONS }), { ok: false, state: 'refused', why: 'card-not-found' })
  } finally {
    await work.cleanup()
  }
})

test('a link that appears after the first look is still not written through: git is asked again before the write', async () => {
  const files = { 'tasks/2026-08-18-call-supplier.md': CARD, 'proposals.yml': PROPOSALS, ...WORKFLOW_FILES }
  const attempts = [
    { action: 'move', fields: { task: '2026-08-18-call-supplier', status: 'done' }, path: 'tasks/2026-08-18-call-supplier.md' },
    { action: 'pause', fields: { workflow: 'morning-intel' }, path: 'workflows/morning-intel.yml' },
    { action: 'approve', fields: { task: 'Writing the newsletter' }, path: 'proposals.yml' }
  ]
  for (const attempt of attempts) {
    const work = await workCopy(files)
    try {
      const before = await snapshot(work.dir)
      let asked = 0
      // The first look finds nothing; a link has been put there by the time of the second.
      const git = async () => ({ stdout: (asked += 1) >= 2 ? `120000 0123456789abcdef0123456789abcdef01234567 0\t${attempt.path.split('/')[0]}\n` : '' })
      assert.deepEqual(await applyCard({ root: work.dir, action: attempt.action, fields: attempt.fields, git, ...OPTIONS }), { ok: false, state: 'failed', why: 'change-refused' }, attempt.action)
      assert.deepEqual(await snapshot(work.dir), before, attempt.action)
    } finally {
      await work.cleanup()
    }
  }
})

test('six cards added at the same moment with the same title all get a name of their own', async () => {
  const work = await workCopy({ 'tasks/README.md': '# tasks\n' })
  try {
    const results = await Promise.all(Array.from({ length: 6 }, () => applyCard({ root: work.dir, action: 'task', fields: { title: 'Same title' }, ...OPTIONS })))
    const paths = results.map((result) => result.paths[0])
    assert.equal(new Set(paths).size, 6, JSON.stringify(paths))
    assert.equal((await readdir(join(work.dir, 'tasks'))).filter((name) => name !== 'README.md').length, 6)
  } finally {
    await work.cleanup()
  }
})

test('the 99th name is the last: with 98 taken the card is made as -99', async () => {
  const files = { 'tasks/README.md': '# tasks\n', 'tasks/2026-10-12-busy.md': 'x' }
  for (let number = 2; number <= 98; number += 1) files[`tasks/2026-10-12-busy-${number}.md`] = 'x'
  const work = await workCopy(files)
  try {
    assert.deepEqual((await applyCard({ root: work.dir, action: 'task', fields: { title: 'Busy' }, ...OPTIONS })).paths, ['tasks/2026-10-12-busy-99.md'])
  } finally {
    await work.cleanup()
  }
})

test('tasks that is a link to a file, or to nowhere, is refused - not made into a folder and not an error', async () => {
  const work = await workCopy({ 'README.md': 'x' })
  const other = await workCopy({ 'README.md': 'x' })
  const target = await workCopy({ 'a-file': 'x' })
  try {
    try {
      await symlink(join(target.dir, 'a-file'), join(work.dir, 'tasks'))
      await symlink(join(target.dir, 'nowhere'), join(other.dir, 'tasks'))
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') return
      throw error
    }
    assert.deepEqual(await applyCard({ root: work.dir, action: 'task', fields: { title: 'A card' }, ...OPTIONS }), { ok: false, state: 'failed', why: 'change-refused' })
    assert.deepEqual(await applyCard({ root: other.dir, action: 'task', fields: { title: 'A card' }, ...OPTIONS }), { ok: false, state: 'failed', why: 'change-refused' })
    assert.deepEqual(await readdir(target.dir), ['a-file'])
  } finally {
    await Promise.all([work.cleanup(), other.cleanup(), target.cleanup()])
  }
})

test('a card is named by the day where the person is, in the zone given', async () => {
  const work = await workCopy({ 'tasks/README.md': '# tasks\n' })
  try {
    const late = Date.parse('2026-10-12T23:30:00.000Z')
    assert.deepEqual((await applyCard({ root: work.dir, action: 'task', fields: { title: 'Late one' }, now: late, timeZone: 'Asia/Tokyo' })).paths, ['tasks/2026-10-13-late-one.md'])
    assert.deepEqual((await applyCard({ root: work.dir, action: 'task', fields: { title: 'Late one' }, now: late, timeZone: 'America/Los_Angeles' })).paths, ['tasks/2026-10-12-late-one.md'])
  } finally {
    await work.cleanup()
  }
})

test('a workflow named by anything but a slug is no workflow: no path is built from it', async () => {
  const work = await workCopy({ 'tasks/README.md': '# tasks\n', ...WORKFLOW_FILES, 'outside.yml': MORNING })
  try {
    const before = await snapshot(work.dir)
    for (const workflow of ['../outside', '../workflows/morning-intel', 'Morning Intel', 'morning-intel.yml', 'workflows/morning-intel', '', undefined, 7]) {
      for (const action of ['pause', 'arm']) {
        assert.deepEqual(await applyCard({ root: work.dir, action, fields: { workflow }, ...OPTIONS }), { ok: false, state: 'refused', why: 'no-workflow' }, `${action} ${String(workflow)}`)
      }
    }
    assert.deepEqual(await snapshot(work.dir), before)
  } finally {
    await work.cleanup()
  }
})
