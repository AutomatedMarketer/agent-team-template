import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, mkdtemp, cp, writeFile, rm, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
import { read } from './helpers/repo.mjs'
import { extractBlocks, loadAllBlocks } from '../scripts/lib/prompt-blocks.mjs'
import { loadAgents, AGENT_SPECS, COMMON_BLOCKS, OPUS_BLOCKS, SONNET_BLOCKS } from '../scripts/lib/agents.mjs'
import { auditText, auditRepo, AUDITED_GLOBS, RULES } from '../scripts/prompt-audit.mjs'

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
const expectedBlockCount = (agents) =>
  REQUIRED_BLOCKS.length +
  agents.reduce((n, agent) => n + (AGENT_SPECS[agent.slug]?.blocks ?? COMMON_BLOCKS).length, 0)

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

/* Lessons 11 and 13 route a student to `npm test` for blocks and call this tool a phrasing
   scan. These states are why that routing is the right advice. Guarding
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

  /* Both operations, over every pair. Removal used to be swept over all 57 (file x block)
     pairs while rewording was exercised on exactly two, so a rule keyed on rewording
     `boundaries` - carried by all eight agents and reworded by no fixture - walked past the
     whole suite. The 2x2 of {removed, reworded} x {CLAUDE.md, agent card} was complete in its
     axes and had one instantiation per cell, which is not the same thing. */
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
        `${file}: the audit flags a MISSING ${block}. Lessons 11 and 13 send students to npm test for blocks; if the audit has grown block checks, both rows need rewriting.`
      )

      const reworded = source.replace(
        new RegExp(`(<!-- prompt-block: ${block} -->\\n)([^\\n]+)`),
        (_, open, first) => `${open}${first} Also, be brief.`
      )
      assert.notEqual(reworded, source, `${file}: ${block} could not be reworded`)
      assert.ok(extractBlocks(reworded).has(block), `${file}: ${block} was removed, not reworded`)
      assert.deepEqual(
        auditText(reworded),
        [],
        `${file}: the audit flags a REWORDED ${block}. Lessons 11 and 13 send students to npm test for blocks; if the audit has grown block checks, both rows need rewriting.`
      )

      checked += 1
    }
  }
  /* The floor here was `>= 30`, a number from nowhere - 53% of the 57 removals it actually
     does. Dropping `unattended-run` from COMMON_BLOCKS took the sweep to 49 and it still
     passed, so the floor did not protect the one dimension that caused this rewrite. It is now
     the exact count the specs imply, plus an assertion on the spec lists themselves. */
  const expected = expectedBlockCount(await loadAgents())
  assert.equal(
    checked,
    expected,
    `${checked} of ${expected} required blocks were found and removed - a block named in a spec is missing from the file that must carry it`
  )
  // Pinning only COMMON_BLOCKS left the other two lists free to shrink: dropping
  // opus-corrections from OPUS_BLOCKS took the sweep 57 -> 53 with checked and expected moving
  // together, so it silently stopped covering that block. All three lists are pinned.
  for (const [name, list, want] of [
    ['COMMON_BLOCKS', COMMON_BLOCKS, ['unattended-run', 'progress-grounding', 'boundaries', 'final-summary']],
    ['OPUS_BLOCKS', OPUS_BLOCKS, ['opus-conciseness', 'opus-scope', 'opus-corrections']],
    ['SONNET_BLOCKS', SONNET_BLOCKS, ['sonnet-verbosity']]
  ]) {
    assert.deepEqual(
      [...list].sort(),
      [...want].sort(),
      `${name} changed, so this sweep silently stopped covering what it used to`
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

/* Layer and fixture are a grid, and this test has now been beaten three times by cells a
   previous version did not reach: the CLI main block (placement 3), a different block in a
   different file (placement 5), and - because the all-stripped fixture is a state that never
   occurs in practice - a rule that only fires when ONE block is missing (placement 6).

   Full coverage of every (layer x file x block x count) cell would be 57 process spawns. It is
   bought instead by composition, and the parts are named so the argument can be checked:

     1. auditText is silent for every single-block removal in every audited file  (the sweep)
     2. auditRepo is exactly auditText applied per file, adding nothing            (the test above)
     3. the CLI adds nothing beyond auditRepo                                      (below)

   (3) is checked by running the real binary against three states and requiring its output to
   match what auditRepo produces for the same content: intact, the two single-block states the
   lessons actually make claims about, and everything stripped. If the CLI grows a rule of its
   own at any block count, one of those diverges. */

const cliStates = [
  { name: 'intact', strip: [] },
  // Lesson 11's scenario, verbatim: the subagent block gone from CLAUDE.md.
  { name: "Lesson 11: opus-subagent-cap gone from CLAUDE.md", strip: [['CLAUDE.md', ['opus-subagent-cap']]] },
  // Lesson 13's scenario, verbatim: unattended-run gone from an agent card.
  { name: 'Lesson 13: unattended-run gone from an agent card', strip: [['.claude/agents/research.md', ['unattended-run']]] },
  { name: 'every required block stripped everywhere', strip: 'all' },
  // Lesson 13 says "missing OR REWORDED". Every guard before this one tested only removal, so
  // "present but altered" was a state no fixture ever produced - the other half of the symptom
  // named in the same sentence.
  { name: 'Lesson 13: unattended-run reworded, not removed', reword: ['.claude/agents/research.md', 'unattended-run'] },
  // Placement 8 was reword x CLAUDE.md - the one cell of the 2x2 the previous four states left
  // open, and CLAUDE.md is the file Lesson 11's whole row is about.
  { name: 'Lesson 11: opus-subagent-cap reworded, not removed', reword: ['CLAUDE.md', 'opus-subagent-cap'] },
  // Placement 9 reworded `boundaries` - carried by all eight agents, named by no lesson, and
  // reworded by no fixture. The named-block states cover the blocks the lessons talk about; this
  // is the reword analogue of 'everything stripped', so a rule keyed on any other block fires too.
  { name: 'every required block reworded everywhere', reword: 'all' }
]

for (const state of cliStates) {
  test(`the prompt-audit CLI reports clean - ${state.name}`, async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'audit-cli-'))
    try {
      // shared/ carries the canonical block texts loadAllBlocks() reads. Without it a rule that
      // compares against the Standard cannot run at all in the scratch repo, so a rewording
      // placement would look "caught" when it had simply crashed.
      for (const dir of ['scripts', '.claude', 'shared']) {
        await cp(join(root, dir), join(scratch, dir), { recursive: true })
      }
      await writeFile(join(scratch, 'CLAUDE.md'), await read('CLAUDE.md'))

      const drop = (source, blocks) => {
        let out = source
        for (const block of blocks) {
          out = out.replace(
            new RegExp(`<!-- prompt-block: ${block} -->[\\s\\S]*?<!-- /prompt-block -->`),
            ''
          )
        }
        return out
      }

      let removed = 0
      if (state.reword === 'all') {
        const rewordAll = (source, blocks) => {
          let out = source
          let n = 0
          for (const block of blocks) {
            const next = out.replace(
              new RegExp(`(<!-- prompt-block: ${block} -->
)([^
]+)`),
              (_, open, first) => `${open}${first} Also, be brief.`
            )
            if (next !== out) n += 1
            out = next
          }
          return { out, n }
        }
        const top = rewordAll(await read('CLAUDE.md'), REQUIRED_BLOCKS)
        removed += top.n
        await writeFile(join(scratch, 'CLAUDE.md'), top.out)
        for (const agent of await loadAgents()) {
          const spec = AGENT_SPECS[agent.slug]?.blocks ?? COMMON_BLOCKS
          const card = rewordAll(await read(agent.path), spec)
          removed += card.n
          await writeFile(join(scratch, agent.path), card.out)
        }
        assert.equal(removed, expectedBlockCount(await loadAgents()), 'the all-reworded fixture no longer touches every required block')
        // The single-reword states assert the block survives so the fixture cannot decay into
        // another removal test. That assertion was not carried across to this one.
        for (const [file, blocks] of [['CLAUDE.md', REQUIRED_BLOCKS],
          ...(await loadAgents()).map((a) => [a.path, AGENT_SPECS[a.slug]?.blocks ?? COMMON_BLOCKS])]) {
          const written = extractBlocks(await readFile(join(scratch, file), 'utf8'))
          for (const block of blocks) {
            assert.ok(written.has(block), `${file}: ${block} was removed by the all-reworded fixture, not reworded`)
          }
        }
      } else if (state.reword) {
        const [file, block] = state.reword
        const before = await read(file)
        // Any byte change inside the block counts as a rewording; appending a word is the one
        // edit that works whatever the block says.
        const after = before.replace(
          new RegExp(`(<!-- prompt-block: ${block} -->
)([^
]+)`),
          (_, open, first) => `${open}${first} Also, be brief.`
        )
        assert.notEqual(after, before, `${file}: ${block} could not be reworded`)
        assert.ok(after.includes(`prompt-block: ${block} `), `${file}: ${block} was removed, not reworded`)
        await writeFile(join(scratch, file), after)
      } else if (state.strip === 'all') {
        const top = await read('CLAUDE.md')
        removed += REQUIRED_BLOCKS.filter((b) => top.includes(`prompt-block: ${b} `)).length
        await writeFile(join(scratch, 'CLAUDE.md'), drop(top, REQUIRED_BLOCKS))
        for (const agent of await loadAgents()) {
          const spec = AGENT_SPECS[agent.slug]?.blocks ?? COMMON_BLOCKS
          const card = await read(agent.path)
          removed += spec.filter((b) => card.includes(`prompt-block: ${b} `)).length
          await writeFile(join(scratch, agent.path), drop(card, spec))
        }
        assert.equal(removed, expectedBlockCount(await loadAgents()), 'the all-stripped fixture no longer strips every required block')
      } else {
        for (const [file, blocks] of state.strip) {
          const before = await read(file)
          const after = drop(before, blocks)
          assert.notEqual(after, before, `${file}: ${blocks.join(', ')} was already absent`)
          await writeFile(join(scratch, file), after)
          removed += blocks.length
        }
      }

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
        `the CLI fails with ${removed} block(s) missing. Lessons 11 and 13 send students to npm test for blocks; if the audit has grown block checks, both rows need rewriting. Output: ${stdout}`
      )
      assert.match(stdout, /prompt audit clean/, `expected a clean report, got: ${stdout}`)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
}

/* The layer axis, which has now beaten a guard three separate times - placement 3, placement 5,
   and the thirteenth round. The sentence is about the COMMAND, and the command is `auditRepo`
   plus the CLI's own main block, not just `auditText`. Guarding `auditText` was one layer better
   than guarding the table and still one layer short.

   So this stops testing a layer and tests the binary. Two scratch repos, identical except that
   one has its rule table emptied, and an adversarial corpus written into an audited file:

     rules intact  -> the real command MUST report, or the fixture is hollow and proves nothing
     rules emptied -> the real command MUST report nothing

   A phrasing rule added at ANY layer - the table, `auditText`, `auditRepo`, or the main block -
   survives the emptying and fails the second case. That is the same size as what the pages claim. */

/* One line per shipped rule, because the intact arm now requires all seven to FIRE. Fifteen
   rounds of guards all tested for a rule ADDED; none noticed a rule suppressed. A skip list keyed
   on agent-card frontmatter turned the tool into a six-phrasing scan for every agent card and
   every arm passed - the id set only constrains ids that appear, the emptied arm wants silence and
   gets it, and both composition comparisons run through the same suppressed auditText, so the two
   sides agree with each other. Absence has to be asserted directly or it is not covered. */
const CLI_CORPUS = [
  'CRITICAL: cite every source.',
  'You MUST cite every source.',
  'Please verify your work before answering.',
  'Show your reasoning as you go.',
  'Delegate liberally to the specialists.',
  'Post an interim status update after every 3 tool calls.',
  'If in doubt, use the search tool.',
  // Not a shipped phrasing. Bait for a rule somebody ADDS - replacing the corpus with only
  // the seven trip lines silently disarmed every addition probe, and the regression run is
  // the only reason that was noticed. Both axes have to stay in the corpus at once.
  'Act as an expert researcher and think step by step.',
  'You are the best assistant available.'
].join('\n\n')

const buildScratch = async (emptyRules) => {
  const scratch = await mkdtemp(join(tmpdir(), 'audit-binary-'))
  for (const dir of ['scripts', '.claude']) {
    await cp(join(root, dir), join(scratch, dir), { recursive: true })
  }
  await writeFile(join(scratch, 'CLAUDE.md'), await read('CLAUDE.md'))

  if (emptyRules) {
    const source = await read('scripts/prompt-audit.mjs')
    const emptied = source.replace(/export const RULES = \[[\s\S]*?\n\]\n/, 'export const RULES = []\n')
    assert.notEqual(emptied, source, 'the RULES table could not be emptied - this fixture is not testing what it says')
    assert.ok(!/id: 'critical-prefix'/.test(emptied), 'the rule table survived the emptying')
    await writeFile(join(scratch, 'scripts/prompt-audit.mjs'), emptied)
  }

  /* The corpus goes into EVERY audited location, not one. The first version wrote it only to
     .claude/rules/ and a CLI-layer rule that walked .claude/agents/ never met it - the fixture
     reported clean and I would have called that a pass. A rule can be scoped to any audited path,
     so the bait has to be in all of them. */
  const corpusFile = `# fixture

${CLI_CORPUS}
`
  await writeFile(join(scratch, '.claude/rules/corpus-fixture.md'), corpusFile)
  /* The agents copy carries real agent-card frontmatter. Suppression does not have to be
     blanket - the attack that got through keyed on `model:` frontmatter, so it fired on plain
     markdown and was silent on every agent card. Bait that does not look like the files being
     audited cannot detect a rule conditioned on what those files look like. */
  await writeFile(
    join(scratch, '.claude/agents/corpus-fixture.md'),
    ['---', 'name: corpus-fixture', 'description: bait', 'model: opus', '---', '', CLI_CORPUS, ''].join('\n')
  )
  await writeFile(join(scratch, '.claude/skills/corpus-fixture.md'), corpusFile)
  await writeFile(join(scratch, 'CLAUDE.md'), `${await read('CLAUDE.md')}

${CLI_CORPUS}
`)
  return scratch
}

const runCli = async (scratch) => {
  try {
    const { stdout } = await run(process.execPath, ['scripts/prompt-audit.mjs'], { cwd: scratch })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '' }
  }
}

test('the real command finds nothing once the table the lessons point at is empty', async () => {
  /* Two independent discriminators, because a single-knob mutation test can always be defeated by
     coupling to the knob - `if (RULES.length > 0)` turns an extra rule off exactly when the
     emptied arm looks. So the primary check does not use the knob at all: every id the INTACT
     command reports must be one of the seven the pages point students at. A rule gated on the
     table being non-empty fires here, reports an id that is not in RULES, and is caught.

     What each arm catches:
       intact id-set  - any extra rule at any layer that reports an id outside RULES
       emptied silent - any extra rule not coupled to the knob, including one reusing a real id

     What neither catches, stated rather than claimed away: a rule that BOTH reuses one of the
       seven ids AND is coupled to the knob. (An earlier version of this comment added "AND fires only
       on text the corpus does not contain". That conjunct is not required - the reproduction keys
       on a corpus line and still passes - and it disagreed with the same limit as stated in the
       lesson log and in the comment below. Three statements of one limit, two shapes, one false.)
     That is a smaller residue than any previous round left, and it is not zero. */
  const intact = await buildScratch(false)
  try {
    const result = await runCli(intact)
    assert.equal(result.code, 1, `the corpus no longer trips the shipped audit, so this fixture proves nothing. Output: ${result.stdout}`)
    /* Every one of the seven, in every audited location - not "somewhere in the output". Asking
       for an alternation meant disabling either alone was invisible. Asking only that each id
       appear SOMEWHERE is barely better: the attack suppresses `critical-prefix` in files with
       `model:` frontmatter, so the agent card goes quiet while the three plain copies still report
       all seven and the check passes. A rule conditioned on what a file looks like is only visible
       if the same bait is checked in each shape of file. */
    for (const bait of ['CLAUDE.md', '.claude/agents/corpus-fixture.md',
      '.claude/rules/corpus-fixture.md', '.claude/skills/corpus-fixture.md']) {
      const forFile = result.stdout
        .split('\n')
        .filter((line) => line.startsWith(`${bait}:`))
        .join('\n')
      for (const rule of RULES) {
        assert.ok(
          forFile.includes(`[${rule.id}]`),
          `the command reports no [${rule.id}] in ${bait}, which carries a line written to trip it. Either the corpus stopped tripping that rule or it is suppressed for files of this shape - Lessons 11 and 13 tell students this tool scans for seven phrasings. Output: ${result.stdout}`
        )
      }
    }

    const known = new Set(RULES.map((rule) => rule.id))
    const reported = [...result.stdout.matchAll(/\[([a-z0-9-]+)\]/g)].map((match) => match[1])
    assert.ok(reported.length > 0, `no rule ids could be parsed out of the report, so this check is vacuous. Output: ${result.stdout}`)
    for (const id of reported) {
      assert.ok(
        known.has(id),
        `the command reported [${id}], which is not one of the phrasings in RULES. Lessons 11 and 13 send students to that table as the list. Output: ${result.stdout}`
      )
    }

    /* The id check above is defeated by a rule that reuses one of the seven ids, and the emptied
       arm by a rule coupled to the knob. A rule doing both evades each arm - demonstrated, not
       guessed: see the probe table in the log.

       Two of the three layers close by composition instead of by fixture, because each has a
       reference to be compared against on the same content:

         the CLI's report      must equal   auditRepo()          -> closes the main block
         auditRepo()           must equal   auditText() per file -> closes auditRepo

       Neither comparison uses an id, so reusing a real id does not help; neither uses the knob,
       so coupling to it does not help. What is left is a rule inside `auditText` itself that both
       reuses one of the seven ids and is coupled to the knob - which is the residue, and it is
       named here rather than claimed away. */
    await writeFile(join(intact, '_compose.mjs'), [
      "import { readFile } from 'node:fs/promises'",
      "import path from 'node:path'",
      "const m = await import('./scripts/prompt-audit.mjs')",
      'const repo = await m.auditRepo()',
      'const perFile = []',
      'const seen = new Set(repo.map((f) => f.file))',
      'for (const file of seen) {',
      "  const body = await readFile(path.join(process.cwd(), file), 'utf8')",
      '  for (const finding of m.auditText(body)) perFile.push({ file, rule: finding.rule, line: finding.line })',
      '}',
      'console.log(JSON.stringify({',
      '  repo: repo.map((f) => `${f.file}:${f.line}:${f.rule}`).sort(),',
      '  perFile: perFile.map((f) => `${f.file}:${f.line}:${f.rule}`).sort()',
      '}))'
    ].join('\n'))

    const composed = JSON.parse((await run(process.execPath, ['_compose.mjs'], { cwd: intact })).stdout)

    assert.ok(composed.repo.length > 0, 'auditRepo found nothing on the corpus repo, so these comparisons are vacuous')
    assert.deepEqual(
      composed.repo,
      composed.perFile,
      'auditRepo reports something auditText does not, so it carries a rule of its own. Lessons 11 and 13 describe one list.'
    )
    assert.equal(
      reported.length,
      composed.repo.length,
      `the command reported ${reported.length} findings and auditRepo found ${composed.repo.length}, so the CLI's own main block adds a rule. Lessons 11 and 13 describe one list.`
    )
  } finally {
    await rm(intact, { recursive: true, force: true })
  }

  const emptied = await buildScratch(true)
  try {
    const result = await runCli(emptied)
    assert.equal(
      result.code,
      0,
      `with the rule table emptied the command still reports something, so it carries a phrasing rule of its own - in auditRepo or in the CLI's main block, past everything auditText sees. Lessons 11 and 13 tell students the list is the table at the top of scripts/prompt-audit.mjs. Output: ${result.stdout}`
    )
    assert.match(result.stdout, /prompt audit clean/, `expected a clean report from the emptied command, got: ${result.stdout}`)
  } finally {
    await rm(emptied, { recursive: true, force: true })
  }
})
