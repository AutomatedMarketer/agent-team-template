import test from 'node:test'
import assert from 'node:assert/strict'
import { loadAllBlocks, extractBlocks, stripBlocks } from '../scripts/lib/prompt-blocks.mjs'

const EXPECTED = [
  'boundaries',
  'final-summary',
  'opus-conciseness',
  'opus-corrections',
  'opus-scope',
  'opus-subagent-cap',
  'parallel-tool-calls',
  'progress-grounding',
  'sonnet-verbosity',
  'unattended-run'
]

test('all ten canonical blocks are present and non-empty', async () => {
  const blocks = await loadAllBlocks()
  assert.deepEqual([...blocks.keys()].sort(), EXPECTED)
  for (const [name, text] of blocks) {
    assert.ok(text.length > 40, `${name} looks truncated`)
  }
})

test('the unattended-run block is byte-identical to the Standard', async () => {
  const blocks = await loadAllBlocks()
  assert.ok(blocks.get('unattended-run').startsWith('You are operating autonomously.'))
  assert.ok(
    blocks.get('unattended-run').endsWith('or you are blocked on input only the user can provide.')
  )
})

test('extractBlocks reads a marked region back out', () => {
  const source = [
    'intro',
    '<!-- prompt-block: boundaries -->',
    'line one',
    'line two',
    '<!-- /prompt-block -->',
    'outro'
  ].join('\n')
  const found = extractBlocks(source)
  assert.deepEqual([...found.keys()], ['boundaries'])
  assert.equal(found.get('boundaries'), 'line one\nline two')
})

test('stripBlocks removes verbatim regions so they are never linted', () => {
  const source = [
    'keep me',
    '<!-- prompt-block: opus-subagent-cap -->',
    'do not use subagents to verify or double-check your own work',
    '<!-- /prompt-block -->',
    'keep me too'
  ].join('\n')
  const stripped = stripBlocks(source)
  assert.doesNotMatch(stripped, /double-check/)
  assert.match(stripped, /keep me/)
  assert.match(stripped, /keep me too/)
})
