import test from 'node:test'
import assert from 'node:assert/strict'
import { listDir, read, exists } from './helpers/repo.mjs'
import { AGENT_SLUGS } from '../scripts/lib/run-log.mjs'

test('there is exactly one workspace per agent slug', async () => {
  const found = (await listDir('agents')).filter(
    (entry) => !entry.startsWith('.') && entry !== 'README.md'
  )
  assert.deepEqual(found, [...AGENT_SLUGS].sort())
})

test('every workspace has a README and an output folder', async () => {
  for (const slug of AGENT_SLUGS) {
    assert.ok(await exists(`agents/${slug}/README.md`), `agents/${slug}/README.md missing`)
    assert.ok(await exists(`agents/${slug}/output`), `agents/${slug}/output missing`)
  }
})

test('customer-service ships an editable FAQ and sales ships an offer sheet', async () => {
  const faq = await read('agents/customer-service/knowledge/faq.md')
  assert.match(faq, /<!-- fill: [a-z0-9-]+ -->/, 'the FAQ needs fill markers for /onboard')
  const offers = await read('agents/sales/knowledge/offer-sheet.md')
  assert.match(offers, /<!-- fill: [a-z0-9-]+ -->/)
})

test('sales ships a pipeline file so the no-CRM default works on day one', async () => {
  const pipeline = await read('agents/sales/output/pipeline.md')
  assert.match(pipeline, /\|.*prospect.*\|/i, 'pipeline.md needs a table header the agent appends to')
})

test('agents/README.md explains the split between definitions and workspaces', async () => {
  const doc = await read('agents/README.md')
  assert.match(doc, /\.claude\/agents\//)
  assert.match(doc, /output/)
})
