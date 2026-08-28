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

// ---------------------------------------------------------------- the verdict

for (const note of notes) console.log(`ok   ${note}`)
if (problems.length) {
  console.log('')
  for (const p of problems) console.log(`FAIL ${p}`)
  console.log(`\n${problems.length} number(s) in the course prose no longer match the files`)
  process.exit(1)
}
console.log('\nevery stated course number matches what the files actually contain')
