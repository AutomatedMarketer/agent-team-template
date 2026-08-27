import test from 'node:test'
import assert from 'node:assert/strict'
import {
  REQUIRED_CITATIONS,
  validateProposal,
  scoreMatch,
  match
} from '../scripts/lib/match.mjs'

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

const catalogue = [
  {
    id: 'agent:email',
    kind: 'agent',
    slug: 'email',
    name: 'email',
    description: 'Sorts the inbox each morning and drafts replies for you to send',
    path: '.claude/agents/email.md'
  },
  {
    id: 'agent:sales',
    kind: 'agent',
    slug: 'sales',
    name: 'sales',
    description: 'Chases invoices and follows up people who have gone quiet',
    path: '.claude/agents/sales.md'
  },
  {
    id: 'workflow:inbox-triage',
    kind: 'workflow',
    slug: 'inbox-triage',
    name: 'Inbox Triage',
    description: 'Your inbox, sorted into what needs you, what got a drafted reply, and noise',
    path: 'workflows/inbox-triage.yml'
  }
]

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
  const strong = scoreMatch(chasing, catalogue[1])
  const weak = scoreMatch(chasing, catalogue[0])
  assert.ok(strong > weak, 'chasing invoices should score higher against the agent that chases invoices')
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
  const result = match(ledgerOf([chasing]), catalogue)

  assert.equal(result.proposals.length, 1)
  const [proposal] = result.proposals
  assert.equal(proposal.item, 'agent:sales')
  assert.equal(proposal.citations.words, chasing.words, 'the quote is verbatim, not a summary')
  assert.match(proposal.citations.number, /3/)
  assert.equal(proposal.citations.item, 'agent:sales')
  assert.deepEqual(validateProposal(proposal), [])
})

test('every proposal the matcher emits passes its own citation check', () => {
  const result = match(ledgerOf([chasing, inbox]), catalogue)
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
  const [proposal] = match(ledgerOf([chasing]), catalogue).proposals
  assert.equal(proposal.predicted.hoursPerWeek, 3)
  assert.equal(proposal.predicted.costPerWeek, 450)
})

test('with no hourly value the predicted cost is null, never zero', () => {
  const ledger = { owner_type: 'job', tasks: [chasing] }
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

test('an item with no description can never be proposed, because there is nothing to cite', () => {
  const undescribed = [{ id: 'agent:ghost', kind: 'agent', slug: 'ghost', name: 'ghost', description: '', path: 'x' }]
  const result = match(ledgerOf([chasing]), undescribed)
  assert.equal(result.proposals.length, 0)
  assert.equal(result.gaps.length, 1)
})

test('results are stable — matching twice gives the same answer in the same order', () => {
  const once = match(ledgerOf([chasing, inbox, exotic]), catalogue)
  const twice = match(ledgerOf([chasing, inbox, exotic]), catalogue)
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
      slug: 'sales',
      name: 'sales',
      description: 'Chases invoices and follows up people who have gone quiet',
      path: '.claude/agents/sales.md'
    }
  ]

  const result = match(ledgerOf([chasing]), idless)

  assert.equal(
    result.proposals.length,
    0,
    'an item with no id cannot be cited, so nothing may be proposed from it'
  )
  assert.equal(result.refused.length, 1, 'and the refusal is recorded rather than swallowed')
  assert.match(result.refused[0].reasons[0], /item citation/)
})

test('ADVERSARIAL: a proposal with a citation stripped out is caught, not shipped', () => {
  const [proposal] = match(ledgerOf([chasing]), catalogue).proposals
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
