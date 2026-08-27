import test from 'node:test'
import assert from 'node:assert/strict'
import {
  REQUIRED_CITATIONS,
  validateProposal,
  scoreMatch,
  stem,
  match
} from '../scripts/lib/match.mjs'
import { loadCatalogue } from '../scripts/lib/catalogue.mjs'

/* Matching is where a measured week turns into a proposed team. Almost every test below is a
   test that something is REFUSED, because the expensive failure here is not missing a match —
   it is confidently proposing a capability nobody built, or proposing anything at all off a
   number the owner has not corrected yet.

   The six anti-deviation rules, and where each is enforced:
     1 ledger before proposal   -> match() refuses outright while the ledger has problems
     2 three citations          -> validateProposal, and match() drops anything that fails it
     3 match, never invent      -> only catalogue ids; no match becomes a gaps QUESTION
     4 twice, or not a pattern  -> only ledger candidates are proposed
     5 decision-readiness       -> a task with no hands_off is parked, never proposed
     6 predicted vs actual      -> every proposal carries a predicted weekly saving */

const chasing = {
  task: 'Chasing invoices',
  words: 'I lose half of Friday chasing people who owe me',
  who: 'me',
  times_per_week: 1,
  minutes_each: 180,
  confirmed: 'twice',
  hands_off: 'I approve every chase before it sends'
}

const inbox = {
  task: 'Sorting the inbox',
  words: 'The inbox eats my morning before I get to anything real',
  who: 'me',
  times_per_week: 5,
  minutes_each: 40,
  confirmed: 'twice',
  hands_off: 'They sit in drafts and I send them'
}

const exotic = {
  task: 'Calibrating the spectrometer',
  words: 'Every Tuesday I recalibrate the spectrometer by hand',
  who: 'me',
  times_per_week: 1,
  minutes_each: 90,
  confirmed: 'twice',
  hands_off: 'I sign off the calibration sheet'
}

/* These descriptions are copied VERBATIM from the shipped files. An earlier version of this test
   invented friendlier wording, and both positive-match tests passed on sentences that existed
   nowhere in the repo — a green suite proving nothing about the product. If a description here
   drifts from the file it names, the real-catalogue test at the bottom is what catches it. */

const catalogue = [
  {
    id: 'agent:email',
    kind: 'agent',
    slug: 'email',
    name: 'email',
    description:
      'Sweeps your inbox, archives the noise, tells you what actually needs you, and leaves replies sitting in your drafts folder.',
    path: '.claude/agents/email.md'
  },
  {
    id: 'agent:content',
    kind: 'agent',
    slug: 'content',
    name: 'content',
    description:
      'Writes posts, captions, and newsletters that sound like you, and leaves them as drafts for you to read before anything goes out.',
    path: '.claude/agents/content.md'
  },
  {
    id: 'agent:sales',
    kind: 'agent',
    slug: 'sales',
    name: 'sales',
    description:
      'Researches a prospect, writes the first message you would actually send them, and keeps a running list of who you have approached.',
    path: '.claude/agents/sales.md'
  }
]

/* The tasks above are written the way an owner writes — gerunds, their own words. The items are
   written in the third person. Matching has to survive that gap, so the fixtures keep it. */

const newsletter = {
  task: 'Writing the newsletter',
  words: 'I write the newsletter myself and it eats most of an afternoon',
  who: 'me',
  times_per_week: 1,
  minutes_each: 180,
  confirmed: 'twice',
  hands_off: 'I read it before it goes out'
}

const ledgerOf = (tasks, extra = {}) => ({
  owner_type: 'business',
  hourly_value: 150,
  tasks,
  ...extra
})

/* ---------- citations -------------------------------------------------------------------- */

test('the three required citations are the owner words, the ledger number, and the catalogue item', () => {
  assert.deepEqual(REQUIRED_CITATIONS, ['words', 'number', 'item'])
})

const soundProposal = {
  task: 'Chasing invoices',
  item: 'agent:sales',
  citations: {
    words: 'I lose half of Friday chasing people who owe me',
    number: '3 hours a week',
    item: 'agent:sales'
  },
  predicted: { hoursPerWeek: 3, costPerWeek: 450 }
}

test('a proposal carrying all three citations is sound', () => {
  assert.deepEqual(validateProposal(soundProposal), [])
})

for (const missing of ['words', 'number', 'item']) {
  test(`a proposal missing the ${missing} citation is refused`, () => {
    const citations = { ...soundProposal.citations }
    delete citations[missing]
    const problems = validateProposal({ ...soundProposal, citations })
    assert.equal(problems.length, 1, 'exactly one problem, naming the missing citation')
    assert.match(problems[0], new RegExp(missing))
  })
}

test('a blank citation is the same as a missing one — whitespace is not evidence', () => {
  const problems = validateProposal({
    ...soundProposal,
    citations: { ...soundProposal.citations, words: '   ' }
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /words/)
})

test('a proposal whose item citation disagrees with the item it names is refused', () => {
  const problems = validateProposal({
    ...soundProposal,
    citations: { ...soundProposal.citations, item: 'agent:email' }
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /agent:sales/)
})

/* ---------- scoring ---------------------------------------------------------------------- */

test('scoring is about shared meaning, not shared filler words', () => {
  const strong = scoreMatch(newsletter, catalogue[1])
  const weak = scoreMatch(newsletter, catalogue[0])
  assert.ok(strong > weak, 'writing a newsletter should score higher against the agent that writes newsletters')
})

test('an owner writes gerunds and an item writes third person - they must still meet', () => {
  const pairs = [['invoices', 'invoice'], ['writes', 'write'], ['writing', 'write'], ['chasing', 'chases'], ['sorted', 'sorts']]
  for (const [a, b] of pairs) {
    assert.equal(stem(a), stem(b), a + ' and ' + b + ' are the same word to an owner reading their own ledger')
  }
})

test('scoring is deterministic — the same inputs give the same number every time', () => {
  assert.equal(scoreMatch(inbox, catalogue[0]), scoreMatch(inbox, catalogue[0]))
})

test('a task about something nobody built scores zero against everything', () => {
  for (const item of catalogue) {
    assert.equal(scoreMatch(exotic, item), 0)
  }
})

/* ---------- matching --------------------------------------------------------------------- */

test('a candidate with a real catalogue match becomes a proposal carrying all three citations', () => {
  const result = match(ledgerOf([newsletter]), catalogue)

  assert.equal(result.proposals.length, 1)
  const [proposal] = result.proposals
  assert.equal(proposal.item, 'agent:content')
  assert.equal(proposal.citations.words, newsletter.words, 'the quote is verbatim, not a summary')
  assert.match(proposal.citations.number, /3/)
  assert.equal(proposal.citations.item, 'agent:content')
  assert.deepEqual(validateProposal(proposal), [])
})

test('one shared word is not a match, however rare that word is', () => {
  const result = match(ledgerOf([exotic]), catalogue)
  assert.equal(result.proposals.length, 0, 'two texts agreeing on one word is luck, not evidence')
  assert.equal(result.gaps.length, 1)
})

test('every proposal the matcher emits passes its own citation check', () => {
  const result = match(ledgerOf([newsletter, inbox]), catalogue)
  assert.ok(result.proposals.length > 0)
  for (const proposal of result.proposals) {
    assert.deepEqual(validateProposal(proposal), [], `${proposal.item} was emitted without full citations`)
  }
})

test('a task with no catalogue match becomes a gap phrased as a question, never a match', () => {
  const result = match(ledgerOf([exotic]), catalogue)

  assert.equal(result.proposals.length, 0, 'nothing in the catalogue does this, so nothing is proposed')
  assert.equal(result.gaps.length, 1)
  assert.match(result.gaps[0].question, /\?$/, 'a gap is a question, because we do not know the answer')
  assert.equal(result.gaps[0].words, exotic.words, 'the gap still quotes them')
})

test('named once is a note, and a note is never proposed', () => {
  const once = { ...chasing, confirmed: 'once' }
  const result = match(ledgerOf([once]), catalogue)
  assert.equal(result.proposals.length, 0)
  assert.equal(result.notes.length, 1)
  assert.equal(result.gaps.length, 0, 'a note is not a gap — we simply have not heard it twice')
})

test('a task nobody can act on is parked, not proposed, even with a perfect match', () => {
  const noHandsOff = { ...chasing, hands_off: '' }
  const result = match(ledgerOf([noHandsOff]), catalogue)
  assert.equal(result.proposals.length, 0)
  assert.equal(result.parked.length, 1)
  assert.match(result.parked[0].reason, /who/i, 'the reason says what is missing')
})

test('every proposal carries a predicted weekly saving, so the tune-up has something to check', () => {
  const [proposal] = match(ledgerOf([newsletter]), catalogue).proposals
  assert.equal(proposal.predicted.hoursPerWeek, 3)
  assert.equal(proposal.predicted.costPerWeek, 450)
})

test('with no hourly value the predicted cost is null, never zero', () => {
  const ledger = { owner_type: 'job', tasks: [newsletter] }
  const [proposal] = match(ledger, catalogue).proposals
  assert.equal(proposal.predicted.hoursPerWeek, 3)
  assert.equal(proposal.predicted.costPerWeek, null, 'zero would read as "this time is free", which is false')
})

test('nothing is proposed while the ledger still has problems — the numbers get corrected first', () => {
  const broken = ledgerOf([{ ...chasing, words: '' }])
  const result = match(broken, catalogue)

  assert.equal(result.proposals.length, 0)
  assert.ok(result.problems.length > 0, 'it says why it refused')
  assert.match(result.problems[0], /Chasing invoices/)
})

test('a catalogue containing something uncitable is refused outright, like a bad ledger', () => {
  const undescribed = [{ id: 'agent:ghost', kind: 'agent', slug: 'ghost', name: 'ghost', description: '', path: 'x' }]
  const result = match(ledgerOf([newsletter]), undescribed)
  assert.equal(result.proposals.length, 0)
  assert.ok(result.problems.length > 0, 'it says why, rather than quietly proposing nothing')
  assert.match(result.problems[0], /agent:ghost/)
})

test('a catalogue that is not a list is refused rather than throwing', () => {
  const result = match(ledgerOf([newsletter]), 42)
  assert.equal(result.proposals.length, 0)
  assert.ok(result.problems.length > 0)
})

test('a prediction that is not a real number is refused - NaN hours is not a citation', () => {
  const problems = validateProposal({ ...soundProposal, predicted: { hoursPerWeek: NaN, costPerWeek: null } })
  assert.ok(problems.length > 0)
  assert.match(problems[0], /predicted saving/)
})

test('an infinite predicted cost is refused too', () => {
  const problems = validateProposal({ ...soundProposal, predicted: { hoursPerWeek: 3, costPerWeek: Infinity } })
  assert.ok(problems.length > 0)
  assert.match(problems[0], /not a real number/)
})

test('results are stable — matching twice gives the same answer in the same order', () => {
  const once = match(ledgerOf([newsletter, inbox, exotic]), catalogue)
  const twice = match(ledgerOf([newsletter, inbox, exotic]), catalogue)
  assert.deepEqual(once, twice)
})

/* ---------- the adversarial test ---------------------------------------------------------- */

/* Rule 2 is only real if breaking it breaks the build. This is the test the plan asks for by
   name: strip a citation and the suite must go red. It is written against the matcher's own
   output so it cannot be satisfied by a fixture nobody uses. */

/* The test above proves validateProposal works. It does NOT prove match() actually calls it —
   in normal operation every proposal is complete, so deleting the gate changes nothing anyone
   can see. That is precisely how a rule rots into a comment. This test forces the gate to be
   load-bearing: a catalogue item with no id cannot produce an item citation, so match() must
   refuse it. Delete the gate in match.mjs and this test goes red. */

test('ADVERSARIAL: the citation gate is load-bearing — remove it and this fails', () => {
  const idless = [
    {
      id: '',
      kind: 'agent',
      slug: 'content',
      name: 'content',
      description:
        'Writes posts, captions, and newsletters that sound like you, and leaves them as drafts for you to read before anything goes out.',
      path: '.claude/agents/content.md'
    }
  ]

  const result = match(ledgerOf([newsletter]), idless)

  assert.equal(
    result.proposals.length,
    0,
    'an item with no id cannot be cited, so nothing may be proposed from it'
  )
  assert.equal(result.refused.length, 1, 'and the refusal is recorded rather than swallowed')
  assert.match(result.refused[0].reasons[0], /item citation/)
})

test('ADVERSARIAL: a proposal with a citation stripped out is caught, not shipped', () => {
  const [proposal] = match(ledgerOf([newsletter]), catalogue).proposals
  assert.deepEqual(validateProposal(proposal), [], 'baseline: the real proposal is sound')

  for (const citation of REQUIRED_CITATIONS) {
    const tampered = { ...proposal, citations: { ...proposal.citations } }
    delete tampered.citations[citation]

    const problems = validateProposal(tampered)
    assert.ok(
      problems.length > 0,
      `stripping the ${citation} citation produced no complaint — rule 2 is not being enforced`
    )
  }
})

/* ---------- the real repo ----------------------------------------------------------------- */

/* The test that was missing, and whose absence hid everything else. Every test above runs against
   hand-written fixtures, so the suite could be green while the shipped matcher proposed the
   team's own retro tooling as the answer to running payroll — which it did.

   These are the tasks a small-business owner and an employee actually write. They are checked
   against the catalogue this repo really ships. Two rules:
     - a named match must be defensible to a human reading it
     - an absurd match is worse than no match, so absurd matches are asserted AGAINST by name */

const realTask = (task, words) => ({
  task,
  words,
  who: 'me',
  times_per_week: 2,
  minutes_each: 60,
  confirmed: 'twice',
  hands_off: 'I read it before anything goes out'
})

async function matchAgainstTheRealRepo(tasks) {
  const catalogue = await loadCatalogue()
  const result = match({ owner_type: 'both', hourly_value: 150, tasks }, catalogue)
  assert.deepEqual(result.problems, [], 'the shipped catalogue must be sound enough to match against')
  return result
}

test('the inbox task finds the inbox tooling in the real catalogue', async () => {
  const result = await matchAgainstTheRealRepo([
    realTask('Sorting the inbox', 'The inbox eats my morning before I get to anything real')
  ])
  assert.equal(result.proposals.length, 1)
  assert.match(result.proposals[0].item, /inbox|email/, 'sorting the inbox should land on the inbox tooling')
})

test('writing the newsletter finds the agent whose description ends "and newsletters"', async () => {
  const result = await matchAgainstTheRealRepo([
    realTask('Writing the newsletter', 'I write the newsletter myself and it eats most of an afternoon')
  ])
  assert.equal(result.proposals.length, 1)
  assert.equal(result.proposals[0].item, 'agent:content')
})

/* This one is the regression guard. Payroll is not something this team does. It once matched
   skill:work-the-tasks on {run, three} - "three per run" in the task sweep against "my three
   staff" in the owner's sentence - and was proposed with full citations and total confidence. */

test('payroll is a gap, not the team\'s own card-router', async () => {
  const result = await matchAgainstTheRealRepo([
    realTask('Doing the payroll', 'I work out the hours and run the payroll for my three staff')
  ])
  assert.equal(result.proposals.length, 0, 'nothing in this catalogue does payroll')
  assert.equal(result.gaps.length, 1)
  assert.match(result.gaps[0].question, /\?$/)
})

/* The guard that used to live here named four items. That is a blacklist, and a blacklist only
   ever covers the instances somebody already found - the next sweep turned up five more, on
   token-saver, install-stack, watch-updates and check-whats-changed. The rule is structural now:
   NOTHING marked `audience: team` may be proposed for anybody's actual job, whatever it is
   called. The named cases below are kept as history, not as the mechanism. */

test('no team-maintenance tooling is ever proposed for a real job', async () => {
  const catalogue = await loadCatalogue()
  const teamIds = new Set(catalogue.filter((item) => item.audience === 'team').map((item) => item.id))
  assert.ok(teamIds.size > 0, 'if nothing is marked team, this test proves nothing')

  const result = await matchAgainstTheRealRepo([
    realTask('Clearing my inbox', 'My inbox is a nightmare, it eats the first hour of every day'),
    realTask('Onboarding a new hire', 'Walking a new starter through our tools and processes'),
    realTask('Handing over to the night shift', 'I write up what happened so the next shift knows'),
    realTask('Keeping the team handbook current', 'Our handbook goes stale and I have to check what changed'),
    realTask('Updating the website prices', 'Every time we change a price I edit the website by hand'),
    realTask('Prepping for meetings', 'Before every call I dig through notes to remember where we left off'),
    realTask('Reporting up to my manager', 'Every fortnight I pull together what I did for my manager'),
    realTask('Doing the payroll', 'I work out the hours and run the payroll for my three staff')
  ])

  for (const proposal of result.proposals) {
    assert.ok(
      !teamIds.has(proposal.item),
      `"${proposal.task}" was answered with the team's own maintenance tooling (${proposal.item})`
    )
  }
})

/* Each of these was a real proposal at some point in this build, cited and confident. */

test('the five absurd matches found in review stay dead, by name', async () => {
  const cases = [
    ['Clearing my inbox', 'My inbox is a nightmare, it eats the first hour of every day', 'skill:token-saver'],
    ['Onboarding a new hire', 'Walking a new starter through our tools and processes', 'skill:install-stack'],
    ['Handing over to the night shift', 'I write up what happened so the next shift knows', 'skill:token-saver'],
    ['Keeping the team handbook current', 'Our handbook goes stale and I have to check what changed', 'skill:check-whats-changed'],
    ['Updating the website prices', 'Every time we change a price I edit the website by hand', 'skill:watch-updates']
  ]
  for (const [task, words, wrongAnswer] of cases) {
    const result = await matchAgainstTheRealRepo([realTask(task, words)])
    for (const proposal of result.proposals) {
      assert.notEqual(proposal.item, wrongAnswer, `"${task}" was answered with ${wrongAnswer} again`)
    }
  }
})

/* A gap with an obvious near-neighbour should say so. "Posting on LinkedIn" shares exactly one
   word with the agent whose description opens "Writes posts" - not enough to propose on, easily
   enough to ask about. Asking costs nothing; guessing is what this build exists to stop. */

test('a gap with one strong near-neighbour asks about it instead of guessing', async () => {
  const result = await matchAgainstTheRealRepo([
    realTask('Posting on LinkedIn', 'I know I should post on LinkedIn but I never get round to it')
  ])
  assert.equal(result.proposals.length, 0, 'one shared word is not enough to propose on')
  assert.equal(result.gaps.length, 1)
  assert.equal(result.gaps[0].nearest, 'agent:content')
  assert.match(result.gaps[0].question, /post/)
  assert.match(result.gaps[0].question, /\?$/, 'it is still a question, not a claim')
})

test('a gap with nothing near it does not invent a neighbour', async () => {
  const result = await matchAgainstTheRealRepo([
    realTask('Calibrating the spectrometer', 'I recalibrate the spectrometer by hand')
  ])
  assert.equal(result.gaps.length, 1)
  assert.equal(result.gaps[0].nearest, undefined)
})

test('a task nobody built anything for is a gap against the real catalogue', async () => {
  const result = await matchAgainstTheRealRepo([
    realTask('Calibrating the spectrometer', 'Every Tuesday I recalibrate the spectrometer by hand')
  ])
  assert.equal(result.proposals.length, 0)
  assert.equal(result.gaps.length, 1)
})

test('the shipped workflow descriptions are descriptions, not engineering notes', async () => {
  const catalogue = await loadCatalogue()
  for (const item of catalogue.filter((entry) => entry.kind === 'workflow')) {
    assert.doesNotMatch(
      item.description,
      /\.claude\/|CLAUDE\.md|dispatchable/,
      `${item.id} has internal engineering prose in its user-facing description`
    )
  }
})
