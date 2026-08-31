import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { read } from './helpers/repo.mjs'
import { notInUse, ownWords, fillMarkers, KNOWLEDGE } from '../scripts/lib/knowledge.mjs'

/* ---------- the switched-off judgement must not drift from the board ---------------------------

   Two of the eight agents - sales and customer-service - are the ones somebody with a job switches
   off, and both this repo and the dashboard have to agree about which. `notInUse` here and the
   copy in agent-cockpit's api/lib.js are the same rule written twice, mirrored by hand because
   there is no import path between a student's repo and a deployed web app. That is the same shape
   as the arming mirror next door, which drifted and needed a shared fixture to catch it. This one
   did not have a fixture, and it was wrong in both copies at once.

   It got the answer backwards for the person it most often describes: a business owner who had
   answered every question. Both knowledge files open with a paragraph telling somebody in a job
   what to write, and it QUOTES the sentence. Nothing tells an owner to delete that paragraph.
   Answer everything, and the markers are gone while the quoted sentence remains - so the board
   said "Not in use" about a working sales agent.

   tests/fixtures/knowledge-parity.json is the shared contract: the same bytes in both repos, run
   by both sides. Change one implementation only and that side fails here. */

const fixtureUrl = new URL('./fixtures/knowledge-parity.json', import.meta.url)
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'))

for (const testCase of fixture.cases) {
  test(`switched-off parity: ${testCase.label}`, () => {
    const body = (fixture.guidance[testCase.guidance] ?? '') + testCase.body
    assert.equal(notInUse(body), testCase.notInUse)
  })
}

test('the two repos hold the same contract, byte for byte', (t) => {
  const sibling = fileURLToPath(
    new URL('../../agent-cockpit/tests/fixtures/knowledge-parity.json', import.meta.url)
  )
  if (!existsSync(sibling)) {
    t.skip('agent-cockpit is not checked out beside this repo')
    return
  }
  assert.equal(
    readFileSync(sibling, 'utf8'),
    readFileSync(fixtureUrl, 'utf8'),
    'the shared contract has been edited on one side only - that is the drift, one level up'
  )
})

/* ---------- the guard that actually lasts ------------------------------------------------------

   Everything above tests the rule against wording copied into a fixture. This tests it against the
   FILES THEMSELVES. If the guidance is ever reworded so its example is no longer quoted the way
   the rule expects, this is what fails - and it fails at the moment of the rewording, not months
   later on somebody's dashboard. The regex is not the protection. This is. */

test('answering the real shipped files leaves both agents in use', async (t) => {
  for (const [slug, path] of Object.entries(KNOWLEDGE)) {
    const shipped = await read(path)

    // In a student's own repo these files are already answered - that is the point of them - and
    // this test has nothing left to fill in. Guarding the SHIPPED wording is a template job, so it
    // stands down rather than failing somebody for having done the course. (That is the same
    // mistake this suite's freshness guards used to make, one file along.)
    if (fillMarkers(shipped).length === 0) {
      t.skip(`${path} has already been answered, so there is no shipped wording here to guard`)
      return
    }
    assert.equal(notInUse(shipped), false, `${path} reads as switched off before anyone touches it`)

    // Answer every question the way an owner would, and leave the instructions alone - nothing in
    // the file tells them to remove that paragraph, and there is no reason they would.
    const answered = shipped.replace(
      /<!--\s*fill:\s*[a-z0-9-]+\s*-->/g,
      'We sell commercial landscape design to developers and hotel groups.'
    )
    assert.equal(fillMarkers(answered).length, 0, `${path} still had markers after being answered`)
    assert.equal(
      notInUse(answered),
      false,
      `a business owner who answered every question in ${path} is being told their ${slug} agent ` +
        `is Not in use - the guidance paragraph's quoted example is being read as their answer`
    )
  }
})

test('the shipped guidance still quotes its example the way the rule expects', async (t) => {
  for (const path of Object.values(KNOWLEDGE)) {
    const shipped = await read(path)
    if (fillMarkers(shipped).length === 0) {
      t.skip(`${path} has already been answered, so the shipped guidance is not here to check`)
      return
    }
    assert.notEqual(
      ownWords(shipped),
      shipped,
      `${path} no longer wraps its example refusal in *"..."*, so nothing is being stripped and ` +
        `the rule in scripts/lib/knowledge.mjs needs rewriting to match the new wording`
    )
  }
})
