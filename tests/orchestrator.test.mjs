import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, mkdtemp, cp, writeFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
import { read } from './helpers/repo.mjs'
import { extractBlocks, loadAllBlocks } from '../scripts/lib/prompt-blocks.mjs'
import { auditText, auditRepo, AUDITED_GLOBS } from '../scripts/prompt-audit.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))

const REQUIRED_BLOCKS = [
  'opus-conciseness',
  'opus-scope',
  'opus-subagent-cap',
  'opus-corrections',
  'unattended-run',
  'progress-grounding',
  'final-summary'
]

// Was six - `editor` was added to CLAUDE.md's team table and to routing.md, and this list
// was never updated, so the guard that exists to catch a specialist going missing did not
// cover the newest one. The same omission left CLAUDE.md's prose saying "six workers" while
// its own table listed seven.
const SLUGS = ['research', 'content', 'email', 'customer-service', 'sales', 'security', 'editor']

test('CLAUDE.md carries every Opus 5 block, byte for byte', async () => {
  const source = await read('CLAUDE.md')
  const canonical = await loadAllBlocks()
  const carried = extractBlocks(source)
  for (const name of REQUIRED_BLOCKS) {
    assert.ok(carried.has(name), `CLAUDE.md is missing the ${name} block`)
    assert.equal(carried.get(name), canonical.get(name), `${name} was reworded`)
  }
})

test('CLAUDE.md names every specialist in its own team table', async () => {
  const source = await read('CLAUDE.md')
  for (const slug of SLUGS) {
    assert.match(source, new RegExp(`\\b${slug}\\b`), `CLAUDE.md never mentions ${slug}`)
  }
})

/* CLAUDE.md's prose said "six workers", twice, while its own team table listed seven and
   .claude/agents/ held eight files. Nothing checked the number, so `editor` was added to the
   table and the sentence above it stayed as it was. This is the file the course calls the job
   description and it is read at the start of every session, so a wrong count there is read
   more often than anything else in the repo. */

test('the count CLAUDE.md states matches the table it states it above', async () => {
  const source = await read('CLAUDE.md')
  const table = source.match(/## The team[\s\S]*?\n\n(?=[A-Z]|##)/)
  assert.ok(table, 'the team section is no longer findable')
  const rows = (table[0].match(/^\| `[a-z-]+` \|/gm) ?? []).length
  assert.equal(rows, SLUGS.length, `the team table lists ${rows} specialists, SLUGS has ${SLUGS.length}`)

  // Two different true numbers live in this file and they must not be swapped: "specialists"
  // is who you delegate to (the table), "workers" is what runs (the agent files, which include
  // the front door's own card). The original defect was "six workers" - wrong on both counts.
  const files = (await readdir(join(root, '.claude/agents'))).filter((f) => f.endsWith('.md'))
  const WORDS = { five: 5, six: 6, seven: 7, eight: 8, nine: 9 }

  for (const [word, n] of Object.entries(WORDS)) {
    if (n !== rows) {
      assert.doesNotMatch(
        source,
        new RegExp(`\\b${word} specialists\\b`, 'i'),
        `CLAUDE.md says "${word} specialists" but its team table lists ${rows}`
      )
    }
    if (n !== files.length) {
      assert.doesNotMatch(
        source,
        new RegExp(`\\b${word} workers\\b`, 'i'),
        `CLAUDE.md says "${word} workers" but .claude/agents/ holds ${files.length}`
      )
    }
  }
})

test('CLAUDE.md states the golden rule and points at the routing file', async () => {
  const source = await read('CLAUDE.md')
  assert.match(source, /one front door|talk to the orchestrator|never open a specialist/i)
  assert.match(source, /\.claude\/rules\/routing\.md/)
})

test('routing rules give a three-step decision tree and one row per specialist', async () => {
  const rules = await read('.claude/rules/routing.md')
  for (const marker of ['1.', '2.', '3.']) {
    assert.ok(rules.includes(marker), `routing.md is missing step ${marker}`)
  }
  for (const slug of SLUGS) {
    assert.match(rules, new RegExp(`\\b${slug}\\b`), `routing.md never routes to ${slug}`)
  }
})

test('both files pass the prompt audit', async () => {
  for (const file of ['CLAUDE.md', '.claude/rules/routing.md']) {
    const findings = auditText(await read(file))
    assert.deepEqual(findings, [], `${file}: ${JSON.stringify(findings)}`)
  }
})

/* The prompt audit is a rejection linter: seven banned phrasings, and no presence check for
   anything. Deleting the opus-subagent-cap block from CLAUDE.md leaves it reporting "prompt
   audit clean" and exiting 0 - which a course lesson relied on as the way to check that block
   was still there. The presence check is the first test in this file. This pins the difference
   so the two commands are not confused for each other again. */

test('the prompt audit does not detect a missing block - only the suite does', async () => {
  const source = await read('CLAUDE.md')
  const withoutBlock = source.replace(
    /<!-- prompt-block: opus-subagent-cap -->[\s\S]*?<!-- \/prompt-block -->/,
    ''
  )
  assert.notEqual(withoutBlock, source, 'the block this test removes is no longer in CLAUDE.md')
  assert.ok(
    !extractBlocks(withoutBlock).has('opus-subagent-cap'),
    'the block was not actually removed, so this proves nothing'
  )
  assert.deepEqual(
    auditText(withoutBlock),
    [],
    'the audit now flags a missing block; if that is deliberate, the lessons pointing at npm test should be revisited'
  )
})

/* Two library-level guards and one that runs the actual binary.

   The first pins auditText, the analysis function. That was not enough: the command the lessons
   name is the CLI, which calls auditRepo, so a presence rule added there left it green. The
   second closes that - auditRepo must be auditText applied per file and nothing more.

   That was still not enough. A presence rule in the CLI's own main block bypasses both, because
   until now no test in this repo ever executed a script - every guard imported functions. The
   third runs `node scripts/prompt-audit.mjs` against a repo whose block has been removed, which
   is the only form of this check that tests what the lesson actually tells someone to type. */

test('auditRepo adds no rules of its own beyond auditText', async () => {
  const fromRepo = await auditRepo()
  const expected = []
  for (const target of AUDITED_GLOBS) {
    const files = target.endsWith('.md')
      ? [target]
      : (await readdir(join(root, target), { recursive: true }))
          .filter((f) => f.endsWith('.md'))
          .map((f) => `${target}/${f.replaceAll(sep, '/')}`)
    for (const file of files) {
      for (const finding of auditText(await read(file))) expected.push({ file, ...finding })
    }
  }
  assert.equal(
    fromRepo.length,
    expected.length,
    `auditRepo reported ${fromRepo.length} findings, auditText over the same files reports ${expected.length} - auditRepo has gained a rule of its own`
  )
})

test('the prompt-audit CLI itself reports clean with a block removed', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'audit-cli-'))
  try {
    for (const dir of ['scripts', '.claude']) {
      await cp(join(root, dir), join(scratch, dir), { recursive: true })
    }
    const source = await read('CLAUDE.md')
    const withoutBlock = source.replace(
      /<!-- prompt-block: opus-subagent-cap -->[\s\S]*?<!-- \/prompt-block -->/,
      ''
    )
    assert.notEqual(withoutBlock, source, 'the block this test removes is no longer in CLAUDE.md')
    await writeFile(join(scratch, 'CLAUDE.md'), withoutBlock)

    let stdout = ''
    let code = 0
    try {
      const result = await run(process.execPath, ['scripts/prompt-audit.mjs'], { cwd: scratch })
      stdout = result.stdout
    } catch (error) {
      stdout = error.stdout ?? ''
      code = error.code ?? 1
    }
    assert.equal(
      code,
      0,
      `the CLI now fails on a missing block. If that is deliberate, Lessons 11 and 13 should stop saying npm test is the only thing that finds it. Output: ${stdout}`
    )
    assert.match(stdout, /prompt audit clean/, `expected a clean report, got: ${stdout}`)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
