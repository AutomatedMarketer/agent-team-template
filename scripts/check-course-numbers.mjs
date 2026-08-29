// Checks that every number the Level 2 course states about itself is still true.
//
// Run it: node scripts/check-course-numbers.mjs <LEVEL_2 folder>
//
// This exists because the same bug keeps happening in this project: two places assert the
// same fact and nothing keeps them agreed. The README said 332 tests while the suite said
// 339; the index said 640 lesson-minutes after a lesson changed length; every lesson header
// said "of 18" on the day a nineteenth shipped. Each one was a sentence a beginner reads to
// decide whether their install worked.
//
// So the counts are derived here — from the files — and compared against what the prose
// claims. A lesson added, removed or re-timed fails this check until every dependent number
// is updated with it.

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const root = process.argv[2]
if (!root) {
  console.log('usage: node scripts/check-course-numbers.mjs <LEVEL_2 folder>')
  process.exit(2)
}

const problems = []
const notes = []
const fail = (what) => problems.push(what)
const ok = (what) => notes.push(what)

const read = (file) => readFile(path.join(root, file), 'utf8')

// ---------------------------------------------------------------- the files

const all = (await readdir(root)).filter((f) => /^\d\d_.+\.md$/.test(f)).sort()
const numbered = all.filter((f) => !/^00_/.test(f))
const totalFiles = all.length // numbered lessons + the pre-work

ok(`${all.length} SOP files (${numbered.length} numbered + pre-work)`)

// ------------------------------------------------- 1. "Lesson N of M" headers

const seen = []
let declaredTotal = null

for (const file of all) {
  const body = await read(file)
  const header = body.match(/\*\*Lesson (\d+) of (\d+) ·/)
  if (!header) {
    if (!/^00_/.test(file)) fail(`${file}: no "**Lesson N of M ·" header`)
    continue
  }
  const [, n, m] = header
  seen.push({ file, n: Number(n) })
  if (declaredTotal === null) declaredTotal = Number(m)
  else if (declaredTotal !== Number(m)) {
    fail(`${file}: says "of ${m}" but another lesson says "of ${declaredTotal}"`)
  }
}

if (declaredTotal !== null && declaredTotal !== totalFiles) {
  fail(`lesson headers say "of ${declaredTotal}" but there are ${totalFiles} SOP files`)
} else if (declaredTotal !== null) {
  ok(`every lesson header says "of ${declaredTotal}", matching the file count`)
}

const numbers = seen.map((s) => s.n).sort((a, b) => a - b)
const expected = numbered.map((_, i) => i + 1)
if (numbers.join(',') !== expected.join(',')) {
  fail(`lesson numbers are ${numbers.join(',')} — expected ${expected.join(',')} (no gaps, no repeats)`)
} else {
  ok(`lesson numbers run 1–${numbers.length} with no gaps`)
}

// ------------------------------------------ 2. the index catalogue and its sum

const index = await read('00-INDEX.md')

// | 17 | [Arm Your Jobs](17_ARM_YOUR_JOBS.md) | 20m | ... |
const rows = [...index.matchAll(/^\|\s*(\d+)\s*\|\s*\[[^\]]+\]\(([^)]+)\)\s*\|\s*([^|]+?)\s*\|/gm)]

const catalogued = new Set()
let minuteSum = 0
for (const [, num, file, time] of rows) {
  catalogued.add(file)
  if (num === '0') continue // pre-work is "60–90m at home", not part of the lesson sum
  const mins = time.match(/(\d+)m/)
  if (!mins) { fail(`index row ${num} (${file}): no "NNm" in the time cell — got "${time}"`); continue }
  minuteSum += Number(mins[1])
}

for (const file of all) {
  if (!catalogued.has(file)) fail(`${file} exists but has no row in 00-INDEX.md's lesson table`)
}
for (const file of catalogued) {
  if (!all.includes(file)) fail(`00-INDEX.md lists ${file}, which is not a lesson file in this folder`)
}
if (catalogued.size === all.length) ok(`all ${all.length} SOPs have an index row, and nothing extra is listed`)

const claimed = index.match(/\((\d+) minutes across/)
if (!claimed) {
  fail('00-INDEX.md does not state "(NNN minutes across …)" — the total cannot be checked')
} else if (Number(claimed[1]) !== minuteSum) {
  fail(`00-INDEX.md claims ${claimed[1]} lesson-minutes; the table adds up to ${minuteSum}`)
} else {
  ok(`index claims ${minuteSum} lesson-minutes and the table adds up to ${minuteSum}`)
}

// --------------------------------------- 3. run of show: every session sums to 90

const show = await read('RUN_OF_SHOW.md')
const lines = show.split(/\r?\n/)

const SESSION_MINUTES = 90
const sessions = []

for (let i = 0; i < lines.length; i += 1) {
  const heading = lines[i].match(/^### (D\d·\d) — .+· (\d+) min\s*$/)
  if (!heading) continue
  const [, name, stated] = heading

  // Walk to the first table separator, then sum the second column until the table ends.
  let j = i + 1
  while (j < lines.length && !/^\|\s*-+/.test(lines[j])) {
    if (/^### /.test(lines[j])) break
    j += 1
  }
  if (j >= lines.length || !/^\|\s*-+/.test(lines[j])) {
    fail(`${name}: no block table found under its heading`)
    continue
  }

  let sum = 0
  let counted = 0
  for (j += 1; j < lines.length && lines[j].startsWith('|'); j += 1) {
    const cells = lines[j].split('|')
    const min = (cells[2] ?? '').trim()
    if (!/^\d+$/.test(min)) { fail(`${name}: block "${(cells[1] ?? '').trim()}" has no plain minute count ("${min}")`); continue }
    sum += Number(min)
    counted += 1
  }

  sessions.push({ name, sum, stated: Number(stated), blocks: counted })
}

if (sessions.length !== 9) {
  fail(`found ${sessions.length} sessions in RUN_OF_SHOW.md — expected 9`)
} else {
  ok('nine sessions found')
}

for (const s of sessions) {
  if (s.stated !== SESSION_MINUTES) fail(`${s.name}: heading says ${s.stated} min, not ${SESSION_MINUTES}`)
  if (s.sum !== SESSION_MINUTES) fail(`${s.name}: its ${s.blocks} blocks add up to ${s.sum}, not ${SESSION_MINUTES}`)
}

const dayTotal = sessions.reduce((a, s) => a + s.sum, 0)
const expectedTotal = sessions.length * SESSION_MINUTES
if (sessions.length === 9 && dayTotal !== expectedTotal) {
  fail(`sessions total ${dayTotal} minutes, not ${expectedTotal}`)
} else if (sessions.length === 9) {
  ok(`every session sums to ${SESSION_MINUTES}; nine sessions total ${dayTotal}`)
}

// ------------------------------- 4. the deck: sequential slides, matching masthead

const deck = await read('PRESENTATION.md')

const slides = [...deck.matchAll(/^## Slide (\d+) — /gm)].map((m) => Number(m[1]))
const sequential = slides.every((n, i) => n === i + 1)
if (!sequential) {
  const firstBad = slides.findIndex((n, i) => n !== i + 1)
  fail(`PRESENTATION.md slide numbers break at position ${firstBad + 1}: got ${slides[firstBad]}`)
} else {
  ok(`${slides.length} slides, numbered 1–${slides.length} with no gaps`)
}

const masthead = deck.match(/·\s*(\d+) lessons\s*·/)
if (!masthead) {
  fail('PRESENTATION.md masthead does not state "· N lessons ·"')
} else if (Number(masthead[1]) !== totalFiles) {
  fail(`PRESENTATION.md masthead says ${masthead[1]} lessons; there are ${totalFiles} SOP files`)
} else {
  ok(`deck masthead says ${totalFiles} lessons, matching the file count`)
}

// Every slide must name a lesson that exists, or be a declared exception —
// and every lesson must be named by at least one slide.
const covered = new Set()
for (const block of deck.split(/^## Slide /m).slice(1)) {
  const num = block.match(/^(\d+) — (.+)/)
  const lesson = block.match(/\*\*Lesson:\*\* ([^\s·]+)/)
  if (!num || !lesson) continue
  if (lesson[1] === '—') continue // the opener and closes; the deck declares these
  const n = Number(lesson[1])
  // 0 is the pre-work SOP, which is a real lesson the deck is allowed to cite.
  if (!Number.isInteger(n) || n < 0 || n > numbered.length) {
    fail(`slide ${num[1]} ("${num[2].trim()}") names Lesson ${lesson[1]}, which does not exist`)
  } else {
    covered.add(n)
  }
}

const uncovered = []
for (let n = 0; n <= numbered.length; n += 1) if (!covered.has(n)) uncovered.push(n)
if (uncovered.length) {
  fail(`no slide cites Lesson ${uncovered.join(', ')} — a lesson with no slide is taught from nothing`)
} else {
  ok(`every lesson 0–${numbered.length} is cited by at least one slide`)
}

// The index describes the deck too, and that prose drifts the moment a slide is added.
const deckClaim = index.match(/\*\*nine modules, one per session in the run of show\*\*, (\d+) slides/)
if (!deckClaim) {
  fail('00-INDEX.md no longer states the deck\'s slide count in the expected form — the claim cannot be checked')
} else if (Number(deckClaim[1]) !== slides.length) {
  fail(`00-INDEX.md says the deck is ${deckClaim[1]} slides; PRESENTATION.md has ${slides.length}`)
} else {
  ok(`index and deck agree on ${slides.length} slides`)
}

const coverageClaim = index.match(/every one of the (\w+) lessons carrying at least one slide/)
const WORDS = { seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 }
if (coverageClaim) {
  const claimed = WORDS[coverageClaim[1].toLowerCase()]
  if (claimed !== totalFiles) {
    fail(`00-INDEX.md says "${coverageClaim[1]} lessons" carry a slide; there are ${totalFiles} SOP files`)
  } else {
    ok(`index's slide-coverage claim names all ${totalFiles} lessons`)
  }
}

// ------------------------------------------ the course cannot promise safety we do not have
//
// Not a number, but the same failure this file exists for: two places asserting the same fact
// with nothing keeping them agreed. Lesson 8 told students the settings file denied send-capable
// tools by name, citing docs/safety/draft-only.md as recording which ones. The deny list held
// secret-file reads and nothing else, and that doc said "pending". A lesson may describe layer 3
// as a gap for the owner to close. It may not describe it as done while this repo says it is not.

const settings = JSON.parse(
  await readFile(new URL('../.claude/settings.json', import.meta.url), 'utf8')
)
const deniesSend = (settings.permissions?.deny ?? []).some((rule) =>
  /send|mail|message|reply|forward/i.test(rule)
)

if (!deniesSend) {
  // Three unordered tests rather than one ordered regex. Two earlier versions were ordered
  // and both were beaten by an idiom the corpus already uses: the first could not cross the
  // period in "settings.json", the second missed "permissions.deny" standing alone and any
  // sentence putting the verb before the noun. Requiring the three ideas in any order is
  // harder to walk past than requiring them in one sequence.
  //
  // This is still a phrasing guard, not a proof. It catches the ways this claim has actually
  // been written. A determined paraphrase gets through, and that is worth knowing rather than
  // forgetting.
  const NAMES_THE_FILE = /settings|permissions\s*\.\s*deny/i
  const CLAIMS_BLOCKING = /\b(?:den(?:ies|y|ying|ied)|block(?:s|ing|ed)?|prevent(?:s|ing|ed)?|cover(?:s|ing)?|stop(?:s|ping)?)\b/i
  const ABOUT_SENDING = /\bsend|sending|forward|repl(?:y|ies|ying)|mail\b/i
  // Lines that describe the gap, or tell the owner to close it, are the honest ones.
  // Every token here is an excuse, so each one is a way for a false claim to escape by
  // containing that phrase. Three had to be removed for exactly that: "no send" rescued
  // "...so there is no send capability left", "filled in" rescued "...and the table is filled
  // in", and "once you" rescued "...once you have nothing left to close".
  //
  // So the list is deliberately tiny and every entry is either a structural marker of an
  // unchecked box or a whole statement of the gap. Adding a convenient fragment here to
  // silence one line is how the next false claim gets through. It is checked against all 19
  // lessons for false positives instead.
  const NEGATED = /not (?:yet )?in place|pending|⬜|☐|secret file|does not deny/i
  const CLAIMS_DENY = {
    test: (line) =>
      NAMES_THE_FILE.test(line) && CLAIMS_BLOCKING.test(line) && ABOUT_SENDING.test(line)
  }
  const offenders = []
  for (const file of all) {
    for (const line of (await read(file)).split('\n')) {
      if (CLAIMS_DENY.test(line) && !NEGATED.test(line)) offenders.push(`${file}: ${line.trim()}`)
    }
  }
  for (const offender of offenders) {
    fail(`a lesson says the settings file denies send tools, but none is denied — ${offender}`)
  }
  if (!offenders.length) ok('no lesson claims a send-tool deny list this repo does not have')
}

// ---------------------------------------------------------------- the verdict
// ---------------------------------------------------------------------------------------------
// Any course file that mentions FIRE_TRIGGERS must name `task-intake` or defer to the lesson that
// does.
//
// Four buttons on the cockpit - Add task, New workflow, Arm, Approve - dispatch to one dedicated
// routine, `task-intake`, not to the job beside them. Lesson 12 described FIRE_TRIGGERS as "each
// workflow's slug", so a reader wired all nine workflows and got 404 from all four. Reproduced
// against the real endpoint before this check was written.
//
// The first version of this check keyed on the settings-table row and scanned only NN_*.md. Both
// limits were wrong: RUN_OF_SHOW.md instructs the same wiring and gives the same misleading
// diagnosis, and it is not an NN_ file, so nothing could see it. Deferral is what makes the rule
// safe to apply widely - 13_TEAM_DAY mentions the variable in passing about Run buttons, where
// "each workflow's slug" is correct, and points at Lesson 12.
const FIRE_DOCS = [...all, 'RUN_OF_SHOW.md', 'PRESENTATION.md', '00-INDEX.md']
for (const file of FIRE_DOCS) {
  const body = await read(file).catch(() => null)
  if (body === null || !body.includes('FIRE_TRIGGERS')) continue
  // Naming the slug ANYWHERE in the file covers that file - a reader who is told is told.
  // A file that never names it has to defer in the passage itself. File-level deferral was
  // the first attempt and it was wrong: RUN_OF_SHOW.md lists 12_COCKPIT.md as a SOP, so it
  // "mentions Lesson 12" three hundred lines from the wiring it instructs, and sailed past.
  if (body.includes('task-intake')) {
    ok(`${file}: names task-intake alongside FIRE_TRIGGERS`)
    continue
  }
  const paragraphs = body.split(/\r?\n\s*\r?\n/)
  for (const para of paragraphs) {
    if (!para.includes('FIRE_TRIGGERS')) continue
    if (/Lesson 12|12_COCKPIT/.test(para)) continue
    fail(`${file}: a passage explains FIRE_TRIGGERS without naming "task-intake" or pointing ` +
      'at Lesson 12. Add task, New workflow, Arm and Approve all 404 without that entry, and ' +
      'it is not a workflow slug, so wiring every workflow does not supply it. Passage: ' +
      `"${para.trim().slice(0, 80)}…"`)
  }
}
// ---------------------------------------------------------------------------------------------
// A workflow example printed anywhere a reader follows must name skills that exist.
//
// Lesson 14 showed `steps: [pull-calendar, scan-inbox, write-brief]` under a table row saying
// "each one already exists in your repo". None of the three did, and the repo's own suite rejects
// exactly that file: `step "pull-calendar" is not a skill in this repo`, three times, plus 14
// failures across four test files. The lesson taught a file the validator it teaches would refuse.
//
// The first version of this check scanned only NN_*.md and only the inline `steps: [a, b]` form.
// Both limits were wrong, and the second one had already been learned twenty lines above: the
// FIRE_TRIGGERS check was widened off NN_*.md for the same reason. This one now covers the same
// file set, and all three step forms the repo's own fixtures show - inline, dashed list, and the
// `- skill:` map form that tests/fixtures/workflows/skill-map-steps.yml calls "the exact step form
// the design spec shows".
//
// This script lives in the template, so its own repo root is where the real skills are - `root` is
// the LEVEL_2 folder passed on argv, which is a different repo entirely.
const templateRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))
const realSkills = new Set(
  (await readdir(path.join(templateRoot, '.claude', 'skills'), { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
)

// Every step name a fenced example asks for, in any of the three forms.
const stepsIn = (body) => {
  const found = []
  for (const match of body.matchAll(/^[ \t]*steps:[ \t]*(?:\[([^\]]*)\]|((?:\r?\n[ \t]*-[^\n]*)+))/gm)) {
    if (match[1] !== undefined) {
      found.push(...match[1].split(',').map((step) => step.trim()).filter(Boolean))
    } else if (match[2] !== undefined) {
      for (const row of match[2].split(/\r?\n/)) {
        // Skill slugs are lowercase kebab - all 25 are, and the validator resolves only that
        // shape. Requiring it keeps out a prose line that happens to start `steps:` above an
        // ordinary markdown list: widening the accepted forms made this guard unable to tell a
        // YAML example from prose, and "Read"/"Validate" are not candidate skill names.
        const item = /^[ \t]*-[ \t]*(?:skill:[ \t]*)?([a-z][a-z0-9-]*)[ \t]*$/.exec(row)
        if (item) found.push(item[1])
      }
    }
  }
  return found
}

if (realSkills.size === 0) {
  fail('could not read .claude/skills, so workflow examples cannot be checked')
} else {
  for (const file of FIRE_DOCS) {
    const body = await read(file).catch(() => null)
    if (body === null) continue
    const steps = stepsIn(body)
    if (!steps.length) continue
    const missing = [...new Set(steps.filter((step) => !realSkills.has(step)))]
    if (missing.length) {
      fail(`${file}: a workflow example lists ${missing.map((s) => `"${s}"`).join(', ')}, ` +
        'which is not a skill in this repo. The lesson tells a reader every step already exists, ' +
        'and the repo\'s own validator rejects a workflow whose steps do not.')
    } else {
      ok(`${file}: workflow example names ${steps.length} real skills`)
    }
  }
}





// ---------------------------------------------------------------------------------------------
// The ledger lesson prints a sample run and tells the manual-way reader to copy
// ledger.example.yml and "run the check below". Those drifted: the sample said 9.9 hours /
// $1,488 / 2 ready while the example file produces 16.3 / $2,438 / 4 - a stale snapshot from when
// that file had two tasks, and the same figures had been copied into the /ledger skill's read-back
// script, so the assistant would have said them out loud.
//
// This lives here rather than in npm test because it needs the course folder, which is an argument
// to this script and absent on a student's machine. The first version was a test that skipped when
// the folder was missing - and a skipped test is not a passing one, so `npm test` reported
// `pass 381 / fail 1` on every machine but the author's, against a README that names the count.
const { summarize } = await import('../scripts/lib/ledger.mjs')
const { parseSimpleYaml } = await import('../scripts/lib/yaml-lite.mjs')
const exampleSource = await readFile(path.join(templateRoot, 'ledger.example.yml'), 'utf8').catch(() => null)
const ledgerLesson = all.find((file) => /_YOUR_LEDGER\.md$/.test(file))
if (exampleSource && ledgerLesson) {
  const summary = summarize(parseSimpleYaml(exampleSource))
  const line = `Your week: ${summary.hoursPerWeek.toFixed(1)} hours a week - $${Math.round(summary.costPerWeek).toLocaleString('en-US')} a week`
  const body = await read(ledgerLesson)
  if (!body.includes(line)) {
    fail(`${ledgerLesson}: its sample run does not match ledger.example.yml, which prints "${line}". ` +
      'The lesson tells a reader to copy that file and run the check, so the two have to agree.')
  } else if (!body.includes(`${summary.candidates.length} ready to hand over`)) {
    fail(`${ledgerLesson}: the example file has ${summary.candidates.length} ready; the sample says otherwise`)
  } else {
    ok(`${ledgerLesson}: sample run matches ledger.example.yml`)
  }
}

// ---------------------------------------------------------------------------------------------
// A lesson that prints the check's output has to print what the check prints.
//
// The sample-run pairing above was added because a stale sample survived. One section lower on the
// same page, the flag block was stale for the same reason and nothing caught it either: the code,
// the log and the plugin skill were all updated together and the lesson was not, so the page went
// on teaching a message the tool no longer emits - and a sentence the tool now contradicts.
//
// Any console line the reporter emits and a lesson quotes has to appear in both.
const reporter = await readFile(path.join(templateRoot, 'scripts', 'check-ledger.mjs'), 'utf8').catch(() => '')
// Leading escapes are part of the source, not of what a lesson would quote - stripping them
// is why the header line is covered at all. Without it the guard silently checked only the
// indented lines, and a mutation of the header produced no failure.
const PAIRED_LINES = [...reporter.matchAll(/console\.log\('([^']{25,})'\)/g)].map((m) => m[1].replace(/^(?:\\n)+/, ''))
if (ledgerLesson && PAIRED_LINES.length) {
  const body = await read(ledgerLesson)
  // Only the lines the lesson has chosen to quote - it does not have to show all of them.
  const quotedish = PAIRED_LINES.filter((line) => body.includes(line.slice(0, 20)))
  for (const line of quotedish) {
    if (!body.includes(line)) {
      fail(`${ledgerLesson}: quotes the check's output but not as the check prints it. ` +
        `check-ledger.mjs emits "${line}" and the lesson has a near-miss of it.`)
    }
  }
  if (quotedish.length) ok(`${ledgerLesson}: quotes ${quotedish.length} of the check's own output lines verbatim`)
}

for (const note of notes) console.log(`ok   ${note}`)


if (problems.length) {
  console.log('')
  for (const p of problems) console.log(`FAIL ${p}`)
  console.log(`\n${problems.length} number(s) in the course prose no longer match the files`)
  process.exit(1)
}
console.log('\nevery stated course number matches what the files actually contain')
