import test from 'node:test'
import assert from 'node:assert/strict'
import { read } from './helpers/repo.mjs'
import { buildModelCard } from '../scripts/build-model-card.mjs'
import { loadAgents } from '../scripts/lib/agents.mjs'

test('the committed card is exactly what the generator produces', async () => {
  const committed = await read('shared/standards/model-card.md')
  const generated = await buildModelCard()
  assert.equal(
    committed.trimEnd(),
    generated.trimEnd(),
    'run `node scripts/build-model-card.mjs` — the card has drifted from the agent files'
  )
})

test('the card lists all five agents plus the orchestrator', async () => {
  const card = await read('shared/standards/model-card.md')
  for (const agent of await loadAgents()) {
    assert.match(card, new RegExp(`\`${agent.slug}\``), `the card is missing ${agent.slug}`)
  }
  assert.match(card, /orchestrator/i, 'the card must include the orchestrator row')
})

test('the card teaches the rule, not just the table', async () => {
  const card = await read('shared/standards/model-card.md')
  assert.match(card, /high-frequency/i)
  assert.match(card, /judgment/i)
})
