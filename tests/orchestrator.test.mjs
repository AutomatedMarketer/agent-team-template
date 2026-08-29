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
import { loadAgents, AGENT_SPECS, COMMON_BLOCKS } from '../scripts/lib/agents.mjs'
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

/* Lessons 11 and 13 tell a student the prompt audit cannot detect a missing block. Guarding
   that took four attempts, and the first three were the same mistake at different addresses.

   Attempt 1 pinned auditText. Attempt 2 added auditRepo, because the CLI calls that. Attempt 3
   ran the CLI binary itself, because a rule in its main block bypassed both. Each time the rule
   was moved one layer out and the guard was rewritten to chase it.

   That was the wrong generalisation. A rule placed back in auditText - the layer supposedly
   closed first - beat all three, because every one of them used the same fixture: remove
   `opus-subagent-cap` from CLAUDE.md. Lesson 13's claim is about `unattended-run` in an agent
   card, and nothing tested that at all.

   So the guard below is keyed on the class, not an address and not a fixture: for EVERY file
   the audit reads and EVERY block that file is required to carry, removing that block must
   leave the audit silent. */

test('the prompt audit stays silent for every required block in every audited file', async () => {
  const targets = [{ file: 'CLAUDE.md', blocks: REQUIRED_BLOCKS }]
  for (const agent of await loadAgents()) {
    targets.push({ file: agent.path, blocks: AGENT_SPECS[agent.slug]?.blocks ?? COMMON_BLOCKS })
  }

  let checked = 0
  for (const { file, blocks } of targets) {
    const source = await read(file)
    for (const block of blocks) {
      const stripped = source.replace(
        new RegExp(`<!-- prompt-block: ${block} -->[\\s\\S]*?<!-- /prompt-block -->`),
        ''
      )
      if (stripped === source) continue
      assert.ok(!extractBlocks(stripped).has(block), `${file}: ${block} was not actually removed`)
      assert.deepEqual(
        auditText(stripped),
        [],
        `${file}: the audit flags a missing ${block}. If that is deliberate, Lessons 11 and 13 must stop saying it cannot.`
      )
      checked += 1
    }
  }
  /* The floor here was `>= 30`, a number from nowhere - 53% of the 57 removals it actually
     does. Dropping `unattended-run` from COMMON_BLOCKS took the sweep to 49 and it still
     passed, so the floor did not protect the one dimension that caused this rewrite. It is now
     the exact count the specs imply, plus an assertion on the spec lists themselves. */
  const expected =
    REQUIRED_BLOCKS.length +
    (await loadAgents()).reduce(
      (n, agent) => n + (AGENT_SPECS[agent.slug]?.blocks ?? COMMON_BLOCKS).length,
      0
    )
  assert.equal(
    checked,
    expected,
    `${checked} of ${expected} required blocks were found and removed - a block named in a spec is missing from the file that must carry it`
  )
  for (const block of ['unattended-run', 'progress-grounding', 'boundaries', 'final-summary']) {
    assert.ok(
      COMMON_BLOCKS.includes(block),
      `${block} left COMMON_BLOCKS, so this sweep silently stopped covering it`
    )
  }
})

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

/* Layer and fixture are not separate axes - they are a grid, and covering a cross through it
   leaves the product cells open. Two guards each closed one line of that cross: the sweep above
   covers every fixture but only through auditText, and the earlier version of this test ran the
   real binary but for a single fixture. A rule in the CLI's main block keyed on unattended-run
   in an agent card sat in the cell neither reached, and passed both.

   So this runs the real command ONCE against a scratch repo with EVERY required block stripped
   from EVERY audited file. Whatever layer a presence rule is placed in, and whichever block it
   keys on, it has to fire here. */

test('the prompt-audit CLI reports clean with every required block stripped everywhere', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'audit-cli-'))
  try {
    for (const dir of ['scripts', '.claude']) {
      await cp(join(root, dir), join(scratch, dir), { recursive: true })
    }

    const strip = (source, blocks) => {
      let out = source
      let removed = 0
      for (const block of blocks) {
        const next = out.replace(
          new RegExp(`<!-- prompt-block: ${block} -->[\\s\\S]*?<!-- /prompt-block -->`),
          ''
        )
        if (next !== out) removed += 1
        out = next
      }
      return { out, removed }
    }

    let stripped = 0
    const top = strip(await read('CLAUDE.md'), REQUIRED_BLOCKS)
    stripped += top.removed
    await writeFile(join(scratch, 'CLAUDE.md'), top.out)

    for (const agent of await loadAgents()) {
      const spec = AGENT_SPECS[agent.slug]?.blocks ?? COMMON_BLOCKS
      const card = strip(await read(agent.path), spec)
      stripped += card.removed
      await writeFile(join(scratch, agent.path), card.out)
    }

    assert.ok(stripped >= 50, `only ${stripped} blocks were stripped; the fixture has gone hollow`)

    let stdout = ''
    let code = 0
    try {
      stdout = (await run(process.execPath, ['scripts/prompt-audit.mjs'], { cwd: scratch })).stdout
    } catch (error) {
      stdout = error.stdout ?? ''
      code = error.code ?? 1
    }
    assert.equal(
      code,
      0,
      `the CLI fails with blocks missing. If that is deliberate, Lessons 11 and 13 must stop saying it cannot detect one. Output: ${stdout}`
    )
    assert.match(stdout, /prompt audit clean/, `expected a clean report, got: ${stdout}`)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
