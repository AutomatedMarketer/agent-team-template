import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/* ---------- the routing rules must not contradict the rest of the repo ------------------------

   Lesson 11 is the most tangled lesson in the course and the walkthrough found four separate
   problems in this one file. All four were the same shape: the file said something its own
   siblings contradicted, and nothing read both.

     1. "Stop at the first one that matches" cancelled the editor pattern. "Write me a post"
        matches step 2, stops at `content`, and never reaches "anything a person will read".
        Read literally, the quality gate was off for every single-specialist job.
     2. The specialist table listed `orchestrator`, while .claude/agents/orchestrator.md says
        "nobody routes work 'to' you" and Lesson 11's own Under the hood says the count is seven.
     3. The same table listed `connect`, which is a skill, not an agent.
     4. Step 1 said "does a skill already do this?" with nothing telling it to skip a skill that
        is half a chain - and half this repo's skills say they are exactly that.

   Each guard below fails if one of those comes back. */

const root = new URL('../', import.meta.url)
const read = (p) => readFile(new URL(p, root), 'utf8')

const SPECIALISTS = ['research', 'content', 'email', 'customer-service', 'sales', 'security', 'editor']
const NOT_SPECIALISTS = ['orchestrator', 'connect']

// The rows of the "Who owns what" table, by what sits in the last column.
async function specialistColumn() {
  const rules = await read('.claude/rules/routing.md')
  const table = rules.split('## Who owns what')[1]?.split('##')[0] ?? ''
  return table
    .split('\n')
    .filter((line) => line.startsWith('|') && line.includes('`'))
    .map((line) => line.split('|').filter(Boolean).pop().trim())
    .map((cell) => (cell.match(/`([^`]+)`/) ?? [])[1])
    .filter(Boolean)
}

test('the specialist table lists the seven specialists and nothing else', async () => {
  const owners = await specialistColumn()
  assert.deepEqual(
    [...owners].sort(),
    [...SPECIALISTS].sort(),
    'the table drifted from the seven agents you actually delegate to'
  )
})

test('the front door and a skill are not listed as things you route to', async () => {
  const owners = await specialistColumn()
  for (const slug of NOT_SPECIALISTS) {
    assert.ok(
      !owners.includes(slug),
      `${slug} is back in the specialist table - a reader scanning "who does this" gets ` +
        (slug === 'connect' ? 'a skill' : 'the router itself')
    )
  }
})

test('the orchestrator is not routed to, and its own card is why', async () => {
  const card = await read('.claude/agents/orchestrator.md')
  assert.match(card, /nobody routes work/i,
    'the sentence the routing table was contradicting has gone - re-check both files together')
})

test('stopping at the first match does not switch the editor off', async () => {
  const rules = await read('.claude/rules/routing.md')
  assert.match(rules, /stop at the first one that matches/i)
  assert.match(
    rules,
    /not a fourth step you can stop before/i,
    'without this, "write me a post" stops at step 2 and the quality gate never runs'
  )
  assert.match(rules, /anything a person outside the team will read goes to `editor`/i)
})

/* Step 1's trap, and the reason it is a real trap rather than a hypothetical: the marker the
   rule tells the router to look for has to actually be on the skills. If someone tidies the
   boilerplate away, the rule silently stops catching anything. */

test('step 1 says to skip chain fragments, and the marker it looks for is really there', async () => {
  const rules = await read('.claude/rules/routing.md')
  assert.match(
    rules,
    /skip any skill whose description says it is the opening or closing step/i,
    'step 1 lost the rule that stops a whole job going to half a chain'
  )

  const dir = new URL('.claude/skills/', root)
  const entries = await readdir(dir, { withFileTypes: true })
  const fragments = []
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const body = await readFile(new URL(`${entry.name}/SKILL.md`, dir), 'utf8').catch(() => '')
    const description = (body.match(/^description:.*$/m) ?? [''])[0]
    if (/opening step|closing step/i.test(description)) fragments.push(entry.name)
  }

  assert.ok(
    fragments.length >= 5,
    `only ${fragments.length} skills still declare themselves a chain step - the rule in ` +
      'routing.md now describes a convention that has been tidied away, so it catches nothing'
  )
  assert.ok(fragments.includes('scan-market'), 'routing.md quotes scan-market by name')
  assert.ok(fragments.includes('draft-content-queue'), 'routing.md quotes draft-content-queue by name')
})
