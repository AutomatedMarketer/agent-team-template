import test from 'node:test'
import assert from 'node:assert/strict'
import { read, exists } from './helpers/repo.mjs'
import { loadAgents } from '../scripts/lib/agents.mjs'

const OUTBOUND_AGENTS = ['email', 'customer-service']

test('outbound agents state the draft-only rule in plain words', async () => {
  const agents = await loadAgents()
  for (const slug of OUTBOUND_AGENTS) {
    const agent = agents.find((candidate) => candidate.slug === slug)
    assert.ok(agent, `${slug} definition missing`)
    assert.match(
      agent.body,
      /leave it in drafts|left in drafts/i,
      `${slug} must say it leaves replies in drafts`
    )
    assert.match(
      agent.body,
      /do not send|does not send|nothing is sent|without sending/i,
      `${slug} must say it does not send`
    )
  }
})

test('the draft-only decision is written down where a lesson can quote it', async () => {
  assert.ok(await exists('docs/safety/draft-only.md'))
  const doc = await read('docs/safety/draft-only.md')
  assert.match(doc, /why/i)
  assert.match(doc, /verif/i, 'the doc must record how the rule is verified, not just asserted')
})
