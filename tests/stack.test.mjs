import test from 'node:test'
import assert from 'node:assert/strict'
import { read } from './helpers/repo.mjs'
import { parseSimpleYaml } from '../scripts/lib/yaml-lite.mjs'

const stack = async () => parseSimpleYaml(await read('stack.yml')).stack
const skill = () => read('.claude/skills/install-stack/SKILL.md')

// --- the starting capabilities, declared not remembered -----------------------------------

// The list is spelled out rather than counted, so adding a capability has to be a deliberate
// edit here too. surplus-burn joined in 4f96572 and this assertion was not updated with it,
// which left both this repo and every repo pulling from it with a red suite on main.
test('the stack declares exactly the starting capabilities', async () => {
  const names = (await stack()).map((entry) => entry.name).sort()
  assert.deepEqual(names, ['claude-mem', 'context7', 'last30days', 'surplus-burn', 'token-saver'])
})

test('every entry says what it gives, why, and how to prove it', async () => {
  for (const entry of await stack()) {
    for (const field of ['gives', 'why', 'verify']) {
      assert.ok(
        typeof entry[field] === 'string' && entry[field].trim().length > 10,
        `${entry.name} is missing a real ${field}`
      )
    }
  }
})

test('each installed capability carries a resolvable plugin id and its marketplace', async () => {
  for (const entry of await stack()) {
    if (!entry.plugin) continue
    assert.match(
      entry.plugin,
      /^[a-z0-9-]+@[a-z0-9-]+$/,
      `${entry.name}: plugin must be <plugin>@<marketplace> so it resolves unambiguously`
    )
    assert.match(entry.marketplace, /^[\w.-]+\/[\w.-]+$/, `${entry.name}: marketplace must be owner/repo`)
  }
})

test('token-saver ships in the repo rather than being installed', async () => {
  const entry = (await stack()).find((candidate) => candidate.name === 'token-saver')
  assert.equal(entry.plugin, undefined, 'a repo skill must not claim to be a plugin')
  assert.equal(entry.skill, '.claude/skills/token-saver/SKILL.md')
  const source = await read(entry.skill)
  assert.match(source, /^---\nname: token-saver/, 'the vendored skill is missing or malformed')
})

// --- installing is safe, honest, and verified --------------------------------------------

test('the installer reads the file rather than trusting its own memory of it', async () => {
  assert.match(await skill(), /Never install from memory of this file/i)
})

test('running it twice is safe, because the second machine is when it gets run', async () => {
  const doc = await skill()
  assert.match(doc, /safe to run twice/i)
  assert.match(doc, /second machine/i)
})

test('one failed install never abandons the rest', async () => {
  assert.match(await skill(), /say which one and why, then keep going/i)
})

test('a capability is not installed until it has answered', async () => {
  const doc = await skill()
  assert.match(doc, /An installed plugin is not a working plugin/i)
  assert.match(doc, /Never report a stack as installed/i)
})

test('the currency check is that the dates come back recent', async () => {
  assert.match(await skill(), /Check the dates are recent/i)
})

test('a missing capability names what the team does worse, and its fallback', async () => {
  const doc = await skill()
  assert.match(doc, /what the\s+team will do worse/i)
  assert.match(doc, /Fallback, and what it costs/i)
})

// --- the rest of the system knows about it ------------------------------------------------

test('the front door tells agents to look things up rather than recall them', async () => {
  const doc = await read('CLAUDE.md')
  assert.match(doc, /stack\.yml/)
  assert.match(doc, /a lookup, not a recollection/i)
})

test('the weekly tune-up notices a capability that has gone missing', async () => {
  const lane = await read('.claude/skills/check-whats-changed/SKILL.md')
  assert.match(lane, /stack\.yml/)
  assert.match(lane, /\.agent-team\/stack-check\.md/)
  assert.match(lane, /quietly disappeared is worse/i)
})

test('the self-improvement loop is inherited, not installed', async () => {
  const doc = await skill()
  assert.match(doc, /weekly-tune-up\.yml/)
  assert.match(doc, /not installed, it is inherited/i)
})
