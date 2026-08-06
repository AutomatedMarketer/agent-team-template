import test from 'node:test'
import assert from 'node:assert/strict'
import { read } from './helpers/repo.mjs'
import { loadAgents } from '../scripts/lib/agents.mjs'

test('the sales agent works without a CRM and says so', async () => {
  const sales = (await loadAgents()).find((agent) => agent.slug === 'sales')
  assert.ok(sales, '.claude/agents/sales.md is missing')
  assert.match(
    sales.body,
    /agents\/sales\/output\/pipeline\.md/,
    'the no-CRM default is the pipeline file; the agent must name it'
  )
  assert.match(sales.body, /no CRM|without a CRM/i, 'the agent must state that it works with no CRM connected')
})

test('the pipeline table has the columns the agent appends', async () => {
  const pipeline = await read('agents/sales/output/pipeline.md')
  for (const column of ['Date', 'Prospect', 'Source', 'Stage', 'Next action']) {
    assert.ok(pipeline.includes(column), `pipeline.md is missing the ${column} column`)
  }
})
