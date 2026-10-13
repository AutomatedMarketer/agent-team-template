// The card actions of the board, done by this program's own code - no model, no shell, nothing to talk into anything.
//
// A card is a file, and each of these is one small edit to a file in the work copy:
//   task      Add task: one new file, tasks/YYYY-MM-DD-<slug>.md, status todo, with the title as its heading
//   move      Start / Done: the card's FRONTMATTER, and not one byte of its body (Done also writes the day)
//   pause     Pause: the workflow's `schedule:` line is commented out - one line, words kept
//   approve   Approve: `approved: true` on the one row of proposals.yml whose task matches word for word
//   arm, skill, agent   a card for the owner: these need a session with the owner (a new schedule has to be reviewed;
//             a new skill or agent has to pass this repo's own checks), so the Mac files a card saying so and builds
//             nothing
// A run of a job is not here: that is Claude's (claude.mjs).
//
// The words in a card are someone's, and the files are the team repo's, which other people push to. So: a title never
// chooses a file name outside tasks/ (it becomes a plain slug) and never overwrites a card (a taken name gets -2, -3);
// no path is followed through a link, on disk or in git's own record; and an edit that cannot be certain which line is
// meant (no row, two rows) is a refusal, never a guess.
//
// Every edit is a text edit that mirrors how the board and the checks READ the file (frontmatter.mjs, yaml-lite.mjs),
// because "the first status line" to this code and "the status" to the board must be the same thing.
//
// applyCard answers:
//   { ok: true, paths, changed }                  the relative paths it wrote ([] when there was nothing to change)
//   { ok: false, state: 'refused', why }          nothing to do here, with a reason from the contract's refused list
//   { ok: false, state: 'failed', why: 'change-refused' }   it would have had to write through a link

import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSimpleYaml } from '../yaml-lite.mjs'
import { assertNoLinks, writeSnapshot, LinkedPath } from '../status/write.mjs'
import { isInsideFolder } from '../status/commit.mjs'
import { readSmallFile } from './small-file.mjs'
import { isSlug, MODEL_TIERS, TASK_STATUSES } from './validate.mjs'

export const CARD_FILE_MAX_BYTES = 256 * 1024
const SLUG_MAX = 40
const MOST_NAMES = 99
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff)
const DAY = /^\d{4}-\d{2}-\d{2}$/

const refused = (why) => ({ ok: false, state: 'refused', why })
const failed = () => ({ ok: false, state: 'failed', why: 'change-refused' })

/* ---------- names and days ----------------------------------------------------------------------------------------- */

// A title as a file-name slug: letters and numbers only, lower case, no accents, dashes between, at most 40
// characters. Nothing else gets through, so a title can never carry a slash, a dot, a space or a reserved name.
export function slugOf(title) {
  const plain = String(title).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '')
  // (The dash a cut leaves at the end is taken off after the cut, so one pass there serves a long slug and a short one.)
  return plain.slice(0, SLUG_MAX).replace(/-+$/, '') || 'task'
}

// The day, YYYY-MM-DD, where the person is: `timeZone` is a zone name, or nothing for this computer's own.
export function todayIn(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now))
  const part = Object.fromEntries(parts.map((one) => [one.type, one.value]))
  return `${part.year}-${part.month}-${part.day}`
}

// A day that is on the calendar: Date reads 2026-02-30 as March the 2nd, and 2026-13-01 not at all.
function isRealDay(value) {
  if (typeof value !== 'string' || !DAY.test(value)) return false
  const ms = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(value)
}

/* ---------- a new card ---------------------------------------------------------------------------------------------- */

const oneLine = (value) => typeof value === 'string' && !/[\r\n]/.test(value)

// The details as lines: Windows line endings made plain and the blank lines at the end dropped, nothing else.
const plainDetails = (details) => (typeof details === 'string' ? details.replace(/\r\n|\r/g, '\n').replace(/\n+$/, '') : '')

// The card the task-intake contract describes: frontmatter first (status todo, plus `for` and `model` when named),
// then the title as a heading - the board names a card by that heading - then the details.
export function newCardText({ title, details, for: agent, model }) {
  if (!oneLine(title)) throw new TypeError('cards: a title is one line of text')
  if (agent !== undefined && !isSlug(agent)) throw new TypeError('cards: for is an agent slug')
  if (model !== undefined && !MODEL_TIERS.includes(model)) throw new TypeError('cards: model is one of the listed tiers')
  const head = ['---', 'status: todo']
  if (agent !== undefined) head.push(`for: ${agent}`)
  if (model !== undefined) head.push(`model: ${model}`)
  const body = plainDetails(details)
  return `${head.join('\n')}\n---\n\n# ${title}\n${body ? `\n${body}\n` : ''}`
}

// What was typed, quoted line by line: never a heading, a list or a line of frontmatter in the card.
const quoted = (lines) => lines.map((line) => (line === '' ? '>' : `> ${line}`)).join('\n')

const NEEDS_YOU = 'This one needs you, not an agent - '

// Arm, Add skill and Add agent are not done on the Mac. The card says so, says nothing has been done, and says what
// to do. Returns { heading, text } - the heading is the card's name, and the file is named from it.
export function needsYouCard(action, fields) {
  let heading
  let paragraphs
  if (action === 'arm') {
    heading = `Set up a Mac schedule for ${fields.workflow}`
    paragraphs = [
      `${NEEDS_YOU}a new schedule on your Mac has to be set up with you in a session, never unattended.`,
      `You tapped Arm on your board for the job \`${fields.workflow}\`. Nothing has been armed or scheduled.`,
      `To go ahead, open a session in this repo and run \`/arm\`, then choose \`${fields.workflow}\`.`
    ]
  } else if (action === 'skill' || action === 'agent') {
    const details = plainDetails(fields.details)
    const words = details ? [fields.title, ...details.split('\n')] : [fields.title]
    const noun = action === 'skill' ? 'skill' : 'agent'
    heading = `Add ${action === 'skill' ? 'a' : 'an'} ${noun}: ${fields.title}`
    paragraphs = [
      `${NEEDS_YOU}your Mac does not build ${noun}s on its own, because a new ${noun} has to pass this repo's own checks first.`,
      `What you wrote on your board:\n\n${quoted(words)}`,
      `Nothing has been created. To go ahead, open a session in this repo and run \`/new-${noun}\` with that sentence.`
    ]
  } else {
    throw new TypeError('cards: that is not a card for the owner')
  }
  return { heading, text: `---\nstatus: todo\n---\n\n# ${heading}\n\n${paragraphs.join('\n\n')}\n` }
}

/* ---------- Start and Done: the frontmatter and nothing else ------------------------------------------------------ */

const OPENING = /^---\r?\n/

// Where the frontmatter is, the way the board's reader finds it (frontmatter.mjs): `---` and a line break at the very
// start, up to the first line that starts with `---`. Not an end that is only nearly one.
export function frontmatterOf(text) {
  const opening = OPENING.exec(text)
  if (!opening) return null
  const from = opening[0].length
  const close = text.indexOf('\n---', from)
  if (close === -1) return null
  const end = text[close - 1] === '\r' ? close - 1 : close
  return { from, end, eol: opening[0].endsWith('\r\n') ? '\r\n' : '\n' }
}

// The lines of a stretch of text, each with the line break that ended it (the last has none).
function linesOf(text) {
  const parts = text.split(/(\r?\n)/)
  const lines = []
  for (let at = 0; at < parts.length; at += 2) lines.push({ content: parts[at], eol: parts[at + 1] ?? '' })
  return lines
}

const joinLines = (lines) => lines.map((line) => line.content + line.eol).join('')

// Put a line after `index`, with the stretch's own line break - and give the line before it a break if it was the last.
function insertAfter(lines, index, content, eol) {
  if (lines[index].eol === '') {
    lines[index].eol = eol
    lines.splice(index + 1, 0, { content, eol: '' })
  } else {
    lines.splice(index + 1, 0, { content, eol: lines[index].eol })
  }
}

// The card's status (and, for Done, the day) set in its frontmatter. Every status line is set, so the board's reader
// finds the one asked for however many there were; a done_at is set the same way and added after the status when there
// is none. A card with no frontmatter gets one in front. Everything after the frontmatter is returned as it was.
export function setFrontmatter(text, { status, doneAt } = {}) {
  if (!TASK_STATUSES.includes(status)) throw new TypeError('cards: status is one of the listed statuses')
  if (status === 'done' && !isRealDay(doneAt)) throw new TypeError('cards: Done needs the day it was closed, as YYYY-MM-DD')
  const frontmatter = frontmatterOf(text)
  if (frontmatter === null) return `---\nstatus: ${status}\n${status === 'done' ? `done_at: ${doneAt}\n` : ''}---\n${text}`

  const lines = linesOf(text.slice(frontmatter.from, frontmatter.end))
  let lastStatus = -1
  let hasDoneAt = false
  lines.forEach((line, at) => {
    if (line.content.startsWith('status:')) {
      line.content = `status: ${status}`
      lastStatus = at
    } else if (status === 'done' && line.content.startsWith('done_at:')) {
      line.content = `done_at: ${doneAt}`
      hasDoneAt = true
    }
  })
  if (lastStatus === -1) {
    lines.unshift({ content: `status: ${status}`, eol: frontmatter.eol })
    lastStatus = 0
  }
  if (status === 'done' && !hasDoneAt) insertAfter(lines, lastStatus, `done_at: ${doneAt}`, frontmatter.eol)
  return text.slice(0, frontmatter.from) + joinLines(lines) + text.slice(frontmatter.end)
}

/* ---------- Pause: one line ---------------------------------------------------------------------------------------- */

// Comment out every `schedule:` line in the workflow's `trigger:` block - the board's reader takes the last one it
// sees, so one left behind would still run. The line keeps its words and its indent: `  # schedule: "daily 06:30"`.
// Nothing else changes. { text, changed }; none to comment out means it is already paused.
export function commentOutSchedule(text) {
  let inTrigger = false
  let changed = false
  const lines = linesOf(text)
  lines.forEach((line, at) => {
    const bare = at === 0 ? line.content.replace(BYTE_ORDER_MARK, '') : line.content
    if (/^\S/.test(bare) && !bare.startsWith('#')) inTrigger = /^trigger:\s*$/.test(bare)
    const schedule = inTrigger ? /^([ \t]+)(schedule:.*)$/.exec(line.content) : null
    if (schedule) {
      line.content = `${schedule[1]}# ${schedule[2]}`
      changed = true
    }
  })
  return { text: joinLines(lines), changed }
}

/* ---------- Approve: one row ---------------------------------------------------------------------------------------- */

const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const indentOf = (content) => /^[ \t]*/.exec(content)[0]

// Where the rows of the last `proposals:` block start and where the block ends, as the board's reader counts them:
// the block runs to the next key at the start of a line, and every indented dashed line in it is one element.
function proposalRows(lines) {
  let opener = -1
  lines.forEach((line, at) => {
    const bare = at === 0 ? line.content.replace(BYTE_ORDER_MARK, '') : line.content
    if (/^proposals:\s*$/.test(bare)) opener = at
  })
  if (opener === -1) return null
  const starts = []
  let end = lines.length
  for (let at = opener + 1; at < lines.length; at += 1) {
    const { content } = lines[at]
    if (/^[A-Za-z0-9_-]+:/.test(content)) {
      end = at
      break
    }
    if (/^\s+-\s+/.test(content)) starts.push(at)
  }
  return { starts, end }
}

// Add `approved: true` to the one row of proposals.yml whose task is exactly `task`.
//   { state: 'ok', text, changed }   the row had it, or now does
//   { state: 'none' }                no such row, or the file is not one this can safely edit
//   { state: 'several' }             more than one row has that task: it will not pick one
// The edit is checked by reading the result back: it must differ from the original in that one row, and only by that.
export function approveRow(text, task) {
  const doc = parseSimpleYaml(text)
  const rows = Array.isArray(doc.proposals) ? doc.proposals : []
  const matching = rows.flatMap((row, at) => (isMap(row) && row.task === task ? [at] : []))
  if (matching.length === 0) return { state: 'none' }
  if (matching.length > 1) return { state: 'several' }
  const target = matching[0]
  if (rows[target].approved === true) return { state: 'ok', text, changed: false }

  const lines = linesOf(text)
  const block = proposalRows(lines)
  const first = block?.starts[target]
  if (first === undefined) return { state: 'none' }
  const rowEnd = target + 1 < block.starts.length ? block.starts[target + 1] : block.end

  const continuation = lines.slice(first + 1, rowEnd).find((line) => /^\s+[A-Za-z0-9_-]+:/.test(line.content))
  const dash = /^(\s*)-(\s+)/.exec(lines[first].content)
  const indent = continuation ? indentOf(continuation.content) : `${dash[1]} ${dash[2]}`

  if (Object.hasOwn(rows[target], 'approved')) {
    for (let at = first; at < rowEnd; at += 1) {
      lines[at].content = lines[at].content.replace(/^(\s+-\s+|\s+)approved:.*$/, '$1approved: true')
    }
  } else {
    // The row ends at its last line of its own: blank lines, and comments that sit left of its keys, belong to what follows.
    let last = rowEnd - 1
    while (last > first && (!lines[last].content.trim() || (lines[last].content.trim().startsWith('#') && indentOf(lines[last].content).length < indent.length))) last -= 1
    insertAfter(lines, last, `${indent}approved: true`, text.includes('\r\n') ? '\r\n' : '\n')
  }
  const edited = joinLines(lines)

  const expected = structuredClone(doc)
  expected.proposals[target].approved = true
  if (JSON.stringify(parseSimpleYaml(edited)) !== JSON.stringify(expected)) return { state: 'none' }
  // (Past the early return above the row was not approved, so the edit always changes the text.)
  return { state: 'ok', text: edited, changed: true }
}

/* ---------- the actions on a work copy ----------------------------------------------------------------------------- */

const absolute = (root, relative) => join(root, ...relative.split('/'))

// A file that should be there: its text, or the word 'link' (it, or a folder above it, is one - never followed),
// or 'missing' (not there, not a plain file, or too big to be one).
export async function readRepoFile(root, relative, git) {
  try {
    await assertNoLinks(root, relative, { git })
  } catch (error) {
    if (error instanceof LinkedPath) return { state: 'link' }
    throw error
  }
  const found = await readSmallFile(absolute(root, relative), CARD_FILE_MAX_BYTES)
  return found.state === 'ok' ? { state: 'ok', text: found.text } : { state: found.reason === 'link' ? 'link' : 'missing' }
}

// Write an edited file whole (a new file beside it, then moved into place), unless it came out the same.
async function save(root, relative, before, after, git) {
  if (after === before) return { ok: true, paths: [], changed: false }
  try {
    await writeSnapshot(root, relative, after, { git })
  } catch (error) {
    if (error instanceof LinkedPath) return failed()
    throw error
  }
  return { ok: true, paths: [relative], changed: true }
}

async function somethingIsAt(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

// Make a new card with the first free name: -2, -3 ... when the day's name for it is taken. A name is free only if
// nothing is there - lstat does not follow a link, so a link (one that points nowhere included, which Windows would
// otherwise write through) is a taken name - and the file is then created only where there is still none.
async function addCard(root, heading, text, { now, timeZone, git }) {
  try {
    await assertNoLinks(root, 'tasks', { git })
    await mkdir(absolute(root, 'tasks'), { recursive: true })
    await assertNoLinks(root, 'tasks', { git })
    if (!(await isInsideFolder(absolute(root, 'tasks'), root))) return failed()
  } catch (error) {
    if (error instanceof LinkedPath) return failed()
    throw error
  }
  const stem = `${todayIn(now, timeZone)}-${slugOf(heading)}`
  for (let number = 1; number <= MOST_NAMES; number += 1) {
    const relative = `tasks/${number === 1 ? stem : `${stem}-${number}`}.md`
    if (await somethingIsAt(absolute(root, relative))) continue
    try {
      await writeFile(absolute(root, relative), text, { flag: 'wx' })
      return { ok: true, paths: [relative], changed: true }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  return failed()
}

const WORKFLOW_NAME_RULE = (fields) => (isSlug(fields?.workflow) ? `workflows/${fields.workflow}.yml` : null)

export async function applyCard({ root, action, fields, now, timeZone, git }) {
  const when = { now, timeZone, git }
  switch (action) {
    case 'task':
      return addCard(root, fields.title, newCardText(fields), when)
    case 'skill':
    case 'agent': {
      const card = needsYouCard(action, fields)
      return addCard(root, card.heading, card.text, when)
    }
    case 'arm': {
      const workflow = WORKFLOW_NAME_RULE(fields)
      const found = workflow ? await readRepoFile(root, workflow, git) : { state: 'missing' }
      if (found.state === 'link') return failed()
      if (found.state !== 'ok') return refused('no-workflow')
      const card = needsYouCard('arm', fields)
      return addCard(root, card.heading, card.text, when)
    }
    case 'move': {
      // 'readme' is the folder's own README, which a case-blind system would find under the name of a card.
      const relative = isSlug(fields?.task) && fields.task !== 'readme' ? `tasks/${fields.task}.md` : null
      const found = relative ? await readRepoFile(root, relative, git) : { state: 'missing' }
      if (found.state === 'link') return failed()
      if (found.state !== 'ok') return refused('card-not-found')
      const after = setFrontmatter(found.text, { status: fields.status, doneAt: todayIn(now, timeZone) })
      return save(root, relative, found.text, after, git)
    }
    case 'pause': {
      const relative = WORKFLOW_NAME_RULE(fields)
      const found = relative ? await readRepoFile(root, relative, git) : { state: 'missing' }
      if (found.state === 'link') return failed()
      if (found.state !== 'ok') return refused('no-workflow')
      return save(root, relative, found.text, commentOutSchedule(found.text).text, git)
    }
    case 'approve': {
      const found = await readRepoFile(root, 'proposals.yml', git)
      if (found.state === 'link') return failed()
      if (found.state !== 'ok') return refused('no-such-row')
      const approved = approveRow(found.text, fields.task)
      if (approved.state === 'several') return refused('several-rows')
      if (approved.state !== 'ok') return refused('no-such-row')
      return save(root, 'proposals.yml', found.text, approved.text, git)
    }
    default:
      throw new TypeError('cards: that is not a card action')
  }
}
