import test from 'node:test'
import assert from 'node:assert/strict'
import { loadAgents, AGENT_SPECS, COMMON_BLOCKS } from '../scripts/lib/agents.mjs'
import { extractBlocks, loadAllBlocks } from '../scripts/lib/prompt-blocks.mjs'
import { auditText } from '../scripts/prompt-audit.mjs'

const IMPLEMENTED = ['content', 'customer-service', 'email', 'research', 'sales']

test('every implemented agent has a definition file', async () => {
  const found = (await loadAgents()).map((agent) => agent.slug).sort()
  assert.deepEqual(found, IMPLEMENTED)
})

test('frontmatter name matches the filename', async () => {
  for (const agent of await loadAgents()) {
    assert.equal(agent.data.name, agent.slug, `${agent.path} name/filename mismatch`)
  }
})

test('the description is one plain sentence a non-technical person understands', async () => {
  for (const agent of await loadAgents()) {
    const description = agent.data.description ?? ''
    assert.ok(description.length >= 40, `${agent.slug}: description too short`)
    assert.doesNotMatch(description, /\n/, `${agent.slug}: description must be one line`)
    assert.doesNotMatch(
      description,
      /\b(API|LLM|prompt|token|frontmatter)\b/i,
      `${agent.slug}: description uses jargon`
    )
  }
})

test('the model is the alias the Standard assigns, never a pinned id', async () => {
  for (const agent of await loadAgents()) {
    const expected = AGENT_SPECS[agent.slug].model
    assert.equal(agent.data.model, expected, `${agent.slug} must run on ${expected}`)
    assert.doesNotMatch(agent.data.model, /claude-|\d/, `${agent.slug}: use an alias`)
  }
})

test('every agent carries its required blocks, byte for byte', async () => {
  const canonical = await loadAllBlocks()
  for (const agent of await loadAgents()) {
    const carried = extractBlocks(agent.body)
    for (const name of AGENT_SPECS[agent.slug].blocks) {
      assert.ok(carried.has(name), `${agent.slug} is missing the ${name} block`)
      assert.equal(carried.get(name), canonical.get(name), `${agent.slug} reworded ${name}`)
    }
    for (const name of COMMON_BLOCKS) {
      assert.ok(carried.has(name), `${agent.slug} is missing the shared ${name} block`)
    }
  }
})

test('every agent states that it drafts and waits for approval', async () => {
  for (const agent of await loadAgents()) {
    assert.match(
      agent.body,
      /waits? for you to say yes|leave it in drafts|left in drafts|does not send/i,
      `${agent.slug} never states the approval boundary`
    )
  }
})

test('every agent reads the business brain and says what it does when the brain is empty', async () => {
  for (const agent of await loadAgents()) {
    assert.match(agent.body, /shared\/business-brain\.md/, `${agent.slug} never reads the brain`)
    assert.match(
      agent.body,
      /(name|say) what was missing/i,
      `${agent.slug} has no empty-brain behaviour`
    )
  }
})

test('every agent writes to its workspace and finishes with the run-log skill', async () => {
  for (const agent of await loadAgents()) {
    assert.match(
      agent.body,
      new RegExp(`agents/${agent.slug}/output`),
      `${agent.slug} never names its output folder`
    )
    assert.match(
      agent.body,
      /\.claude\/skills\/run-log\/SKILL\.md/,
      `${agent.slug} never invokes the run-log skill`
    )
  }
})

test('every agent passes the prompt audit', async () => {
  for (const agent of await loadAgents()) {
    const findings = auditText(agent.body)
    assert.deepEqual(findings, [], `${agent.slug}: ${JSON.stringify(findings)}`)
  }
})
