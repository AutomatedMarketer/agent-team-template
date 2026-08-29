import test from 'node:test'
import assert from 'node:assert/strict'
import { loadAgents, AGENT_SPECS, COMMON_BLOCKS } from '../scripts/lib/agents.mjs'
import { extractBlocks, loadAllBlocks } from '../scripts/lib/prompt-blocks.mjs'
import { auditText } from '../scripts/prompt-audit.mjs'

const IMPLEMENTED = [
  'content',
  'customer-service',
  'editor',
  'email',
  'orchestrator',
  'research',
  'sales',
  'security'
]

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

// The content agent is told to recommend one of its two hooks. Its output template had
// nowhere to put that, so the recommendation landed wherever the model felt like it - an
// instruction with no home in the artifact is one that quietly stops happening.
test('content gives its hook recommendation a named home in the template', async () => {
  const content = (await loadAgents()).find((agent) => agent.slug === 'content')
  assert.ok(content, 'content agent is missing')
  assert.match(
    content.body,
    /Alternate hook\n<[^>]*which you would pick and why/,
    'the output template never says where the hook recommendation goes'
  )
})

// Only the register may be stated as fact - that is line S3 of the content rubric. The agent
// file said "check against business-brain.md", which is the whole file, leaving a student's
// true-but-unregistered story in an undefined state.
test('content checks claims against the register, not the whole business brain', async () => {
  const content = (await loadAgents()).find((agent) => agent.slug === 'content')
  assert.match(
    content.body,
    /Verified claims register/,
    'content never names the register it is graded against'
  )
})

test('every agent passes the prompt audit', async () => {
  for (const agent of await loadAgents()) {
    const findings = auditText(agent.body)
    assert.deepEqual(findings, [], `${agent.slug}: ${JSON.stringify(findings)}`)
  }
})
