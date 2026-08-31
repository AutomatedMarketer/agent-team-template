import test from 'node:test'
import assert from 'node:assert/strict'
import { read, exists, stageDone, stageDoneIn } from './helpers/repo.mjs'
import { parseSimpleYaml } from '../scripts/lib/yaml-lite.mjs'

const skill = () => read('.claude/skills/connect/SKILL.md')

// --- the register ships empty and honest -----------------------------------------------

// This guard protects the TEMPLATE: it ships claiming nothing it has not proved. It cannot go on
// asserting that once /connect has run, because /connect is the Access stage's own lesson -
// Lesson 4, "Connectors", which is where register.yml is first written. (Installer phase 6 is the
// same stage but does NOT touch this file: it attaches connectors and writes prose into
// shared/business-brain.md. That distinction is the whole reason an empty register is legitimate
// below.) Left absolute, this turned red the moment a student did the thing they were told to do,
// and stayed red; onboarding phase 12 then refuses to advance until `npm test` in their repo is
// clean, so the install could not finish.
//
// The board's own tiles guard is retired by hand in onboard phase 10, and the brain's guard
// retires itself off the same state file this does. This was the third of the three and the only
// one nothing released. What the register has to promise after the Access stage is not emptiness
// but honesty: register.yml's own header says a line without a verified date and a proof is a
// claim, not a connection, and the dashboard shows it as unproven.
//
// Written as a pure list-of-problems rather than inline assertions so the awkward cases can be
// tested rather than hoped about. The interesting one is "access settled, register empty": that
// has to be a deliberate PASS, and a loop that simply runs zero times passes by accident instead.
// From the outside those look identical, and only one of them is a decision.
//
// Zero connections after the Access stage is legitimate, for two separate reasons, and neither is
// a student cutting corners: phase 6 can be `skipped` outright when they have no Google account,
// and phase 6 does not write this file at all - `/connect` does, and that is a later lesson. What
// must hold either way is that the file is readable and anything in it carries its proof.
export function registerProblems(register, accessSettled) {
  if (!Array.isArray(register?.connections)) {
    return ['connections: in register.yml is not a list, so nothing can read it']
  }
  if (!accessSettled) {
    return register.connections.length
      ? ['a fresh repo must claim nothing it has not proved']
      : []
  }
  const problems = []
  for (const connection of register.connections) {
    const named = connection?.name ?? connection?.slug ?? 'an unnamed connection'
    if (!connection?.verified) {
      problems.push(`${named} has no verified date, so it is a claim rather than a connection`)
    }
    if (!connection?.proof) {
      problems.push(`${named} has no proof, so nothing shows it ever answered with your own data`)
    }
  }
  return problems
}

test('the register claims nothing it has not proved', async () => {
  const register = parseSimpleYaml(await read('connections/register.yml'))
  assert.deepEqual(registerProblems(register, await stageDone('2 · Access')), [])
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

/* Three guards in this suite protect the TEMPLATE by asserting a file is still empty. Doing the
   course fills all three in, so each has to retire itself or the student's suite goes red for
   doing as it was told - and onboard phase 12 will not finish an install whose `npm test` is not
   clean. The board's guard is retired by hand in phase 10; the brain's and this one read the
   installer's own state file.

   The mechanism is tested here against real state-file text, because it cannot be tested by
   pointing the suite at a temp repo - `read` resolves against this repo root by design. */

test('a guard retires only once its stage is genuinely finished', async () => {
  const table = (accessStatus) =>
    [
      '| # | Phase | Stage | Status | Finished |',
      '|---|---|---|---|---|',
      '| 5 | Voice | 1 · Brief | done | 2026-08-19 |',
      `| 6 | Connectors | 2 · Access | ${accessStatus} | |`,
      '| 7 | Meet the team | 3 · Training | pending | |'
    ].join('\n')

  assert.equal(stageDoneIn(table('done'), '2 · Access'), true, 'a finished stage did not retire its guard')
  assert.equal(stageDoneIn(table('skipped'), '2 · Access'), true, 'a deliberately skipped stage must count as settled')
  assert.equal(stageDoneIn(table('pending'), '2 · Access'), false, 'an unfinished stage retired its guard early')
  assert.equal(stageDoneIn(table('in-progress'), '2 · Access'), false, 'a half-done stage retired its guard early')

  assert.equal(stageDoneIn(table('done'), '3 · Training'), false, 'a later stage was read as finished')
  assert.equal(stageDoneIn('', '2 · Access'), false, 'an empty state file retired a guard')
  assert.equal(stageDoneIn(undefined, '2 · Access'), false, 'a missing state file retired a guard')
  assert.equal(stageDoneIn(table('done'), '9 · Nothing'), false, 'a stage with no rows counted as finished')
})

test('the register guard is not vacuous once the access stage is settled', () => {
  const proved = { name: 'Gmail', verified: '2026-08-24', proof: 'Read three subject lines' }

  // Before the stage is settled the register must be empty - the template's own promise.
  assert.deepEqual(registerProblems({ connections: [] }, false), [])
  assert.deepEqual(registerProblems({ connections: [proved] }, false).length, 1)

  // After it, an empty register is a deliberate pass: phase 6 can be skipped, and /connect is a
  // later lesson. This is the case a plain `for` loop passed by accident.
  assert.deepEqual(registerProblems({ connections: [] }, true), [])

  // ...but anything present has to carry both halves of its proof.
  assert.deepEqual(registerProblems({ connections: [proved] }, true), [])
  assert.equal(registerProblems({ connections: [{ ...proved, verified: undefined }] }, true).length, 1)
  assert.equal(registerProblems({ connections: [{ ...proved, proof: undefined }] }, true).length, 1)
  assert.equal(registerProblems({ connections: [{ name: 'Gmail' }] }, true).length, 2)

  // A register nothing can read is never acceptable, settled or not.
  for (const settled of [true, false]) {
    assert.equal(registerProblems({}, settled).length, 1, 'a missing list read as fine')
    assert.equal(registerProblems({ connections: 'gmail' }, settled).length, 1, 'a string read as a list')
    assert.equal(registerProblems(null, settled).length, 1, 'an unreadable file read as fine')
  }
})

test('the register guard is wired to the Access stage', async () => {
  const source = await read('tests/connections.test.mjs')
  assert.ok(
    /stageDone\(\s*'2 · Access'\s*\)/.test(source),
    'the register guard no longer retires itself, so a student who ran /connect has a red suite forever'
  )
})
