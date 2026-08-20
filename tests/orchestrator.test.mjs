import test from 'node:test'
import assert from 'node:assert/strict'
import { read } from './helpers/repo.mjs'
import { extractBlocks, loadAllBlocks } from '../scripts/lib/prompt-blocks.mjs'
import { auditText } from '../scripts/prompt-audit.mjs'

const REQUIRED_BLOCKS = [
  'opus-conciseness',
  'opus-scope',
  'opus-subagent-cap',
  'opus-corrections',
  'unattended-run',
  'progress-grounding',
  'final-summary'
]

const SLUGS = ['research', 'content', 'email', 'customer-service', 'sales', 'security']

test('CLAUDE.md carries every Opus 5 block, byte for byte', async () => {
  const source = await read('CLAUDE.md')
  const canonical = await loadAllBlocks()
  const carried = extractBlocks(source)
  for (const name of REQUIRED_BLOCKS) {
    assert.ok(carried.has(name), `CLAUDE.md is missing the ${name} block`)
    assert.equal(carried.get(name), canonical.get(name), `${name} was reworded`)
  }
})

test('CLAUDE.md names all six specialists', async () => {
  const source = await read('CLAUDE.md')
  for (const slug of SLUGS) {
    assert.match(source, new RegExp(`\\b${slug}\\b`), `CLAUDE.md never mentions ${slug}`)
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
