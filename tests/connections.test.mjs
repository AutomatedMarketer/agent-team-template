import test from 'node:test'
import assert from 'node:assert/strict'
import { read, exists } from './helpers/repo.mjs'
import { parseSimpleYaml } from '../scripts/lib/yaml-lite.mjs'

const skill = () => read('.claude/skills/connect/SKILL.md')

// --- the register ships empty and honest -----------------------------------------------

test('the register ships with no connections claimed', async () => {
  const register = parseSimpleYaml(await read('connections/register.yml'))
  assert.deepEqual(register.connections, [], 'a fresh repo must claim nothing it has not proved')
})

test('the register explains every field a connection needs', async () => {
  const source = await read('connections/register.yml')
  for (const field of ['kind:', 'account:', 'used_by:', 'verified', 'proof']) {
    assert.ok(source.includes(field), `register.yml never explains ${field}`)
  }
})

test('recipes have somewhere to live and a stated shape', async () => {
  assert.ok(await exists('connections/recipes/README.md'))
  const doc = await read('connections/recipes/README.md')
  for (const field of ['verified', 'source', 'Known traps']) {
    assert.match(doc, new RegExp(field), `the recipe shape is missing ${field}`)
  }
})

// --- the rules that stop a connection being claimed rather than proved ------------------

test('a connection is not connected until it returns the owner\'s own data', async () => {
  const doc = await skill()
  assert.match(doc, /returns their own data/i)
  assert.match(doc, /Do not\s+register a connection that has not answered/i)
})

test('proving a connection is read-only - never a write, a send, or a spend', async () => {
  assert.match(await skill(), /Never write, send, post, or spend to verify/i)
})

test('one connection per session, because a batch fails halfway', async () => {
  assert.match(await skill(), /One connection per session/i)
})

test('connection details are researched, never recalled', async () => {
  const doc = await skill()
  assert.match(doc, /Never research from memory/i)
  assert.match(doc, /last 90 days/i, 'a dated search is the floor for a moving target')
})

test('research prefers official sources, and Context7 is optional rather than assumed', async () => {
  const doc = await skill()
  assert.match(doc, /Context7\*{0,2},\s+if it is available/i, 'students may not have Context7 installed')
  assert.match(doc, /resolve-library-id/)
})

test('browser automation is the last resort, and its cost is stated up front', async () => {
  const doc = await skill()
  assert.match(doc, /Last resort/i)
  assert.match(doc, /before building it, not after/i)
})

test('a tool that cannot be connected properly is allowed to be refused', async () => {
  assert.match(await skill(), /This cannot be connected\s*\n?\s*properly today/i)
})

// --- credentials and accounts ----------------------------------------------------------

test('the promise names its own limit - the owner signs in, nothing else is asked of them', async () => {
  const doc = await skill()
  assert.match(doc, /You click "sign in"\. I do everything else\./)
  assert.match(doc, /never see, ask for, or hold a credential/i)
})

test('secrets go to .env and only the name reaches .env.example', async () => {
  const doc = await skill()
  assert.match(doc, /never in chat/i)
  assert.match(doc, /name\*{0,2}\s+\*{0,2}only/i)
  assert.match(doc, /never committed/i)
})

test('the minimum scope is asked for, because nobody ever narrows one later', async () => {
  assert.match(await skill(), /minimum that makes the job work/i)
})

test('a second account of the same tool must be named', async () => {
  const doc = await skill()
  assert.match(doc, /never let a nameless second account exist/i)
  assert.match(doc, /wrong account is worse than a job that fails/i)
})

// --- the long tail compounds ------------------------------------------------------------

test('a newly researched tool leaves a recipe behind', async () => {
  const doc = await skill()
  assert.match(doc, /Tier 3 only, and it is not optional/i)
  assert.match(doc, /connections\/recipes\/<slug>\.md/)
})

test('all four ways of talking to the team are offered, not just one', async () => {
  const doc = await skill()
  for (const surface of [/claude\.ai on their phone/i, /dashboard/i, /Claude Code on the desktop/i, /messaging gateway/i]) {
    assert.match(doc, surface, `a surface is missing: ${surface}`)
  }
})

// --- the rest of the system knows about it ----------------------------------------------

test('the weekly tune-up checks the register and flags stale recipes', async () => {
  const lane = await read('.claude/skills/check-whats-changed/SKILL.md')
  assert.match(lane, /connections\/register\.yml/)
  assert.match(lane, /more than 90 days/i, 'a stale recipe is a guide to a page that has moved')
})

test('the front door offers /connect instead of assuming a tool is reachable', async () => {
  const doc = await read('CLAUDE.md')
  assert.match(doc, /connections\/register\.yml/)
  assert.match(doc, /Never assume a tool is reachable/i)
})
