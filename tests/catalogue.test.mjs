import test from 'node:test'
import assert from 'node:assert/strict'
import {
  itemId,
  buildCatalogue,
  loadCatalogue,
  validateCatalogue,
  describable,
  leadingComment,
  proposable
} from '../scripts/lib/catalogue.mjs'

/* The catalogue is the only thing a proposal is allowed to name. If it lists something that is
   not really in the repo, the match engine will confidently offer a capability that does not
   exist — which is the exact failure this whole build was written to stop. So the tests here
   are mostly about refusing to list things. */

const agentFile = (slug, name, description) => ({
  kind: 'agent',
  slug,
  path: `.claude/agents/${slug}.md`,
  source: `---\nname: ${name}\ndescription: ${description}\n---\n\nBody text.\n`
})

const skillFile = (slug, name, description) => ({
  kind: 'skill',
  slug,
  path: `.claude/skills/${slug}/SKILL.md`,
  source: `---\nname: ${name}\ndescription: ${description}\n---\n\nBody text.\n`
})

const workflowFile = (slug, name, description) => ({
  kind: 'workflow',
  slug,
  path: `workflows/${slug}.yml`,
  source: `name: ${name}\ndescription: ${description}\nowner: research\nsteps:\n  - do-something\n`
})

/* ---------- ids -------------------------------------------------------------------------- */

test('an id names its kind as well as its slug, so agent:email and skill:email never collide', () => {
  assert.equal(itemId('agent', 'email'), 'agent:email')
  assert.equal(itemId('skill', 'email'), 'skill:email')
  assert.notEqual(itemId('agent', 'email'), itemId('skill', 'email'))
})

/* ---------- building --------------------------------------------------------------------- */

test('agents, skills and workflows all arrive in one uniform shape', () => {
  const items = buildCatalogue([
    agentFile('research', 'research', 'Looks things up and writes what it found'),
    skillFile('ledger', 'ledger', 'Interviews the owner about where their week goes'),
    workflowFile('morning-intel', 'Morning Intel', 'Reads the overnight news and files a brief')
  ])

  assert.equal(items.length, 3)
  for (const item of items) {
    assert.ok(item.id, 'every item has an id')
    assert.ok(item.kind, 'every item has a kind')
    assert.ok(item.name, 'every item has a name')
    assert.ok(item.description, 'every item has a description')
    assert.ok(item.path, 'every item names the file it came from')
  }
})

test('a workflow description is read from plain yaml, not frontmatter', () => {
  const [workflow] = buildCatalogue([
    workflowFile('daily-brief', 'Daily Brief', 'Sends one summary at the end of the day')
  ])
  assert.equal(workflow.name, 'Daily Brief')
  assert.equal(workflow.description, 'Sends one summary at the end of the day')
})

/* Every shipped workflow states its purpose in a comment at the top of the file, in the owner's
   language. That is the description. Reading it means there is one copy, not two that drift. */

test("a workflow's opening comment is its description", () => {
  const [workflow] = buildCatalogue([
    {
      kind: 'workflow',
      slug: 'morning-intel',
      path: 'workflows/morning-intel.yml',
      source: '# What moved in your market overnight, on your screen before your first call.\nname: Morning Intel\nowner: research\n'
    }
  ])
  assert.equal(workflow.description, 'What moved in your market overnight, on your screen before your first call.')
})

test('a comment wrapped over several lines is joined into one description', () => {
  assert.equal(
    leadingComment('# The self-improvement loop. Every Sunday: has anything we run on\n# stopped being true?\nname: Weekly Tune-up\n'),
    'The self-improvement loop. Every Sunday: has anything we run on stopped being true?'
  )
})

test('only the comment block at the top counts, not comments further down', () => {
  assert.equal(
    leadingComment('# The real description.\nname: Thing\n# an aside about the trigger\ntrigger:\n'),
    'The real description.'
  )
})

test('an explicit description field wins over the comment', () => {
  const [workflow] = buildCatalogue([
    {
      kind: 'workflow',
      slug: 'thing',
      path: 'workflows/thing.yml',
      source: '# an old comment nobody updated\nname: Thing\ndescription: what it really does\n'
    }
  ])
  assert.equal(workflow.description, 'what it really does')
})

test('an agent with no description is still listed, but is not describable', () => {
  const items = buildCatalogue([
    {
      kind: 'agent',
      slug: 'mystery',
      path: '.claude/agents/mystery.md',
      source: '---\nname: mystery\n---\n\nNo description anywhere.\n'
    }
  ])
  assert.equal(items.length, 1, 'we do not silently drop it — silence hides the problem')
  assert.equal(describable(items[0]), false)
})

test('the slug is the fallback name, so an unnamed file is still addressable', () => {
  const [item] = buildCatalogue([
    {
      kind: 'skill',
      slug: 'connect',
      path: '.claude/skills/connect/SKILL.md',
      source: '---\ndescription: Wires up an outside tool\n---\n'
    }
  ])
  assert.equal(item.name, 'connect')
})

/* ---------- validation ------------------------------------------------------------------- */

test('a sound catalogue reports no problems', () => {
  const items = buildCatalogue([
    agentFile('research', 'research', 'Looks things up'),
    skillFile('ledger', 'ledger', 'Measures the week')
  ])
  assert.deepEqual(validateCatalogue(items), [])
})

test('two items sharing an id is a problem, because a citation would be ambiguous', () => {
  const items = [
    { id: 'agent:email', kind: 'agent', slug: 'email', name: 'email', description: 'a', path: 'x' },
    { id: 'agent:email', kind: 'agent', slug: 'email', name: 'email', description: 'b', path: 'y' }
  ]
  const problems = validateCatalogue(items)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /agent:email/)
})

test('a missing description is a problem, because nothing can be matched against nothing', () => {
  const items = buildCatalogue([
    {
      kind: 'agent',
      slug: 'mystery',
      path: '.claude/agents/mystery.md',
      source: '---\nname: mystery\n---\n'
    }
  ])
  const problems = validateCatalogue(items)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /mystery/)
  assert.match(problems[0], /description/)
})

test('an unfilled template marker counts as no description at all', () => {
  const items = buildCatalogue([
    skillFile('todo', 'todo', '<!-- fill: what does this skill do -->')
  ])
  assert.equal(describable(items[0]), false)
  assert.equal(validateCatalogue(items).length, 1)
})

/* ---------- the real repo ---------------------------------------------------------------- */

test('this repo has a catalogue, and every item in it can be described', async () => {
  const items = await loadCatalogue()
  assert.ok(items.length > 0, 'a team repo with an empty catalogue can propose nothing')

  const kinds = new Set(items.map((item) => item.kind))
  for (const kind of ['agent', 'skill', 'workflow']) {
    assert.ok(kinds.has(kind), `the catalogue should include ${kind}s`)
  }

  assert.deepEqual(
    validateCatalogue(items),
    [],
    'every shipped agent, skill and workflow needs a plain-language description — that description is what a proposal cites'
  )
})

/* ---------- the paragraph break ------------------------------------------------------------ */

/* A bare `#` ends the description. Everything after it is engineering rationale written for
   whoever maintains the file, and it is neither shown to an owner nor matched against their
   words. Until this test existed, the only thing holding that rule in place was one blacklist
   regex in a different file, which a reworded comment would have walked straight past. */

test('a bare # ends the description - what follows is rationale, not description', () => {
  const source = [
    '# The real description, in the owner\'s language.',
    '#',
    '# Owner: the orchestrator, because routing is the front door\'s job.',
    'name: Task Sweep'
  ].join('\n')
  assert.equal(leadingComment(source), 'The real description, in the owner\'s language.')
})

test('a comment block with no break is kept whole', () => {
  const source = '# One sentence.\n# And its second line.\nname: Thing'
  assert.equal(leadingComment(source), 'One sentence. And its second line.')
})

/* ---------- audience ------------------------------------------------------------------------ */

test('an item is owner-facing unless it says otherwise', () => {
  const [item] = buildCatalogue([agentFile('research', 'research', 'Looks things up')])
  assert.equal(item.audience, 'owner')
  assert.equal(proposable(item), true)
})

test('team tooling is read from frontmatter and is never proposable', () => {
  const [item] = buildCatalogue([
    {
      kind: 'skill',
      slug: 'sync',
      path: '.claude/skills/sync/SKILL.md',
      source: '---\nname: sync\ndescription: Bring this machine level with the repo\naudience: team\n---\n'
    }
  ])
  assert.equal(item.audience, 'team')
  assert.equal(proposable(item), false, 'team tooling stays in the catalogue but is never an answer to a ledger task')
})

test('an unrecognised audience falls back to owner rather than silently hiding the item', () => {
  const [item] = buildCatalogue([
    {
      kind: 'skill',
      slug: 'odd',
      path: '.claude/skills/odd/SKILL.md',
      source: '---\nname: odd\ndescription: Does a thing\naudience: wibble\n---\n'
    }
  ])
  assert.equal(item.audience, 'owner')
})

test('the real repo splits into owner-facing work and team maintenance', async () => {
  const items = await loadCatalogue()
  const owner = items.filter(proposable)
  const team = items.filter((item) => item.audience === 'team')

  assert.ok(owner.length > 0, 'a team that can be proposed nothing is not a team')
  assert.ok(team.length > 0, 'the maintenance tooling has to be marked, or it gets proposed for business work')
  assert.equal(owner.length + team.length, items.length)

  // Named because each of these was, at some point, confidently proposed as the answer to
  // somebody's actual job.
  for (const slug of ['token-saver', 'install-stack', 'watch-updates', 'check-whats-changed', 'sync', 'run-log']) {
    const item = items.find((entry) => entry.id === `skill:${slug}`)
    assert.ok(item, `skill:${slug} should exist`)
    assert.equal(item.audience, 'team', `skill:${slug} maintains the team and must never answer a ledger task`)
  }
})
