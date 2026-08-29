import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditText, auditRepo, RULES, AUDITED_GLOBS } from '../scripts/prompt-audit.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('flags pressure language', () => {
  const findings = auditText('CRITICAL: you MUST always call the tool.')
  const ids = findings.map((finding) => finding.rule)
  assert.ok(ids.includes('critical-prefix'), 'CRITICAL: should be flagged')
  assert.ok(ids.includes('shouting-imperative'), 'uppercase MUST should be flagged')
})

test('flags verification instructions Opus 5 does not need', () => {
  const ids = auditText('Verify your work before responding. Double-check the totals.').map(
    (finding) => finding.rule
  )
  assert.ok(ids.includes('self-verification'))
})

test('flags reasoning-extraction language', () => {
  const ids = auditText('Show your reasoning as you go.').map((finding) => finding.rule)
  assert.ok(ids.includes('reasoning-extraction'))
})

test('flags over-delegation and forced progress scaffolding', () => {
  const ids = auditText(
    ['Delegate to subagents freely.', 'After every 3 tool calls, summarize progress.', 'Default to using firecrawl.'].join('\n')
  ).map((finding) => finding.rule)
  assert.ok(ids.includes('over-delegation'))
  assert.ok(ids.includes('progress-scaffolding'))
  assert.ok(ids.includes('tool-over-trigger'))
})

test('leaves ordinary prose alone', () => {
  assert.deepEqual(auditText('Draft the reply and leave it in the drafts folder. Cite every source.'), [])
})

test('does not lint text inside verbatim prompt blocks', () => {
  const source = [
    '<!-- prompt-block: opus-subagent-cap -->',
    'do not use subagents to verify or double-check your own work',
    '<!-- /prompt-block -->'
  ].join('\n')
  assert.deepEqual(auditText(source), [])
})

test('an audit-ignore region opts documentation out of the lint', () => {
  const source = [
    'Never write these:',
    '<!-- audit-ignore -->',
    '| `CRITICAL:` anything | Say it plainly instead. |',
    '| "Verify your work" | Nothing. |',
    '<!-- /audit-ignore -->',
    'That is the list.'
  ].join('\n')
  assert.deepEqual(auditText(source), [])
})

test('the whole repo passes the audit', async () => {
  const findings = await auditRepo()
  const report = findings
    .map((finding) => `${finding.file}:${finding.line} [${finding.rule}] ${finding.excerpt}`)
    .join('\n')
  assert.deepEqual(findings, [], report)
})

/* Lessons 11 and 13 tell a student what `prompt-audit` looks for: "seven banned phrasings,
   listed at the top of scripts/prompt-audit.mjs", and that blocks are `npm test`'s job.

   Ten earlier attempts guarded the opposite sentence - that the audit CANNOT detect a missing or
   reworded block. That is a universal over an open space of rules, and over an unbounded space of
   edits ("reworded" is a class, not a state), so no fixture set holds it. Both lessons now make a
   positive claim about the shipped rule set instead, and a positive claim about a finite exported
   table is exactly this size: enumerate it. Add an eighth rule, or one that reads structure rather
   than phrasing, and the pages need rewriting - this fails and says so. */

test('the audit is seven banned phrasings, which is what Lessons 11 and 13 tell students', () => {
  assert.equal(
    RULES.length,
    7,
    `Lessons 11 and 13 both say "seven banned phrasings"; the table now has ${RULES.length}. Update both rows.`
  )
  assert.deepEqual(
    RULES.map((rule) => rule.id),
    [
      'critical-prefix',
      'shouting-imperative',
      'self-verification',
      'reasoning-extraction',
      'over-delegation',
      'progress-scaffolding',
      'tool-over-trigger'
    ],
    'the rule set changed - Lessons 11 and 13 describe it to students'
  )
  for (const rule of RULES) {
    assert.ok(
      rule.pattern instanceof RegExp,
      `${rule.id} is not a phrasing pattern. Lessons 11 and 13 call this tool a phrasing scan and send students to npm test for anything structural.`
    )
    assert.equal(
      typeof rule.why,
      'string',
      `${rule.id} has no rationale, so a student who trips it cannot be told why`
    )
  }
})

/* The previous guard enumerated `RULES`. The sentence is about what the COMMAND scans for, and
   `auditText` is free to carry a phrasing rule of its own without touching the table - which is
   how the twelfth placement got past. Guarding the table is guarding the artifact I was shown
   rather than the one the sentence names.

   `auditText` iterates `RULES` and nothing else, so that is directly checkable: empty the table
   and it must find nothing, in anything. A rule written inline still fires and this fails.

   Honest about the limit, because claiming closure is the mistake this sequence keeps making:
   with the table emptied, ANY finding is a violation, so the corpus only has to TRIGGER an extra
   rule rather than match its shape - which is a much broader net than the earlier fixtures cast.
   It is still not every input. What it does close is the gap the twelfth placement used. */

const CORPUS = [
  'Act as an expert researcher and think step by step.',
  'You are the best assistant. Pretend to be a senior engineer.',
  'CRITICAL: you MUST always verify your work and double-check the output.',
  'Delegate liberally. After every 3 tool calls, post an interim status update.',
  'Default to using `rg`. If in doubt, use the search tool. Show your reasoning.',
  'Ordinary prose that should trip nothing at all.'
]

test('every phrasing the audit reports comes from the table the lessons point at', async () => {
  const files = []
  for (const glob of AUDITED_GLOBS) {
    const full = join(root, glob)
    const info = await stat(full).catch(() => null)
    if (!info) continue
    if (info.isFile()) files.push(glob)
    else {
      const walk = async (dir) => {
        for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
          const next = `${dir}/${entry.name}`
          if (entry.isDirectory()) await walk(next)
          else if (entry.name.endsWith('.md')) files.push(next)
        }
      }
      await walk(glob)
    }
  }
  assert.ok(files.length > 5, `only ${files.length} audited files were found; the corpus has gone hollow`)

  const texts = [...CORPUS]
  for (const file of files) texts.push(await readFile(join(root, file), 'utf8'))

  // 1. Nothing the audit reports carries an id the lessons do not point students at.
  const known = new Set(RULES.map((rule) => rule.id))
  for (const text of texts) {
    for (const finding of auditText(text)) {
      assert.ok(
        known.has(finding.rule),
        `the audit reported [${finding.rule}], which is not one of the phrasings in RULES. Lessons 11 and 13 send students to that table.`
      )
    }
  }

  // 2. With the table emptied, the command must have nothing left to look for.
  const saved = RULES.splice(0, RULES.length)
  try {
    for (const text of texts) {
      const findings = auditText(text)
      assert.deepEqual(
        findings.map((finding) => finding.rule),
        [],
        `with RULES emptied the audit still reports ${findings[0]?.rule}, so it carries a phrasing rule of its own. Lessons 11 and 13 tell students the list is the table at the top of scripts/prompt-audit.mjs.`
      )
    }
  } finally {
    RULES.push(...saved)
  }
  assert.equal(RULES.length, saved.length, 'the rule table was not restored')
})

test('the block test Lessons 11 and 13 send students to still exists', async () => {
  const suite = await readFile(join(root, 'tests/orchestrator.test.mjs'), 'utf8')
  assert.match(
    suite,
    /CLAUDE\.md carries every Opus 5 block, byte for byte/,
    'Lesson 11 names this test by name and both lessons say blocks are npm test’s job. Renaming it silently breaks that row.'
  )
})
