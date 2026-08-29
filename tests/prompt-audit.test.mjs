import test from 'node:test'
import assert from 'node:assert/strict'
import { auditText, auditRepo, RULES } from '../scripts/prompt-audit.mjs'

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
