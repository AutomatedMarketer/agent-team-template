import test from 'node:test'
import assert from 'node:assert/strict'
import { auditText, auditRepo } from '../scripts/prompt-audit.mjs'

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

test('the whole repo passes the audit', async () => {
  const findings = await auditRepo()
  const report = findings
    .map((finding) => `${finding.file}:${finding.line} [${finding.rule}] ${finding.excerpt}`)
    .join('\n')
  assert.deepEqual(findings, [], report)
})
