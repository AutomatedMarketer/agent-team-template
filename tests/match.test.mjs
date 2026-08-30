import test from 'node:test'
import assert from 'node:assert/strict'
import {
  REQUIRED_CITATIONS,
  MIN_SHARED_WORDS,
  SHORTLIST_LIMIT,
  validateProposal,
  scoreMatch,
  stem,
  meaningful,
  shortlist,
  proposalFrom,
  buildIndex,
  match
} from '../scripts/lib/match.mjs'
import { loadCatalogue } from '../scripts/lib/catalogue.mjs'

/* Matching is where a measured week turns into a proposed team. Almost every test below is a test
   that something is REFUSED, because the expensive failure here is not missing a match — it is
   confidently proposing a capability nobody built, or proposing anything at all off a number the
   owner has not corrected yet.

   The engine does NOT choose. Word-counting cannot tell a customer's REVIEW from the sales
   pipeline REVIEW, and no threshold fixes that — a three-word floor kills every good match too.
   So it ranks, deterministically, and the /match skill reads the sentences and picks. What the
   skill cannot do is invent: proposalFrom() refuses anything not on the shortlist, so the closed
   world is still built in code, before any judgment happens.

   The six anti-deviation rules, and where each is enforced:
     1 ledger before proposal   -> match() refuses outright while the ledger has problems
     2 three citations          -> validateProposal, and proposalFrom refuses without them
     3 match, never invent      -> shortlist() is the only source; no match becomes a gap QUESTION
     4 twice, or not a pattern  -> only ledger candidates get a shortlist
     5 decision-readiness       -> a task with no hands_off is parked, never shortlisted
     6 predicted vs actual      -> every proposal carries a predicted weekly saving */

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
   nowhere in the repo — a green suite proving nothing about the product. */

const catalogue = [
  {
    id: 'agent:email',
    kind: 'agent',
    slug: 'email',
    name: 'email',
    audience: 'owner',
    description:
      'Sweeps your inbox, archives the noise, tells you what actually needs you, and leaves replies sitting in your drafts folder.',
    path: '.claude/agents/email.md'
  },
  {
    id: 'agent:content',
    kind: 'agent',
    slug: 'content',
    name: 'content',
    audience: 'owner',
    description:
      'Writes posts, captions, and newsletters that sound like you, and leaves them as drafts for you to read before anything goes out.',
    path: '.claude/agents/content.md'
  },
  {
    id: 'agent:sales',
    kind: 'agent',
    slug: 'sales',
    name: 'sales',
    audience: 'owner',
    description:
      'Researches a prospect, writes the first message you would actually send them, and keeps a running list of who you have approached.',
    path: '.claude/agents/sales.md'
  }
]

/* Owners write gerunds, in their own words. Items describe themselves in the third person.
   Matching has to survive that gap, so the fixtures keep it. */

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

const entryFor = (result, task) => result.shortlists.find((entry) => entry.task === task)

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

test('a prediction that is not a real number is refused — NaN hours is not a citation', () => {
  const problems = validateProposal({ ...soundProposal, predicted: { hoursPerWeek: NaN, costPerWeek: null } })
  assert.ok(problems.length > 0)
  assert.match(problems[0], /predicted saving/)
})

test('an infinite predicted cost is refused too', () => {
  const problems = validateProposal({ ...soundProposal, predicted: { hoursPerWeek: 3, costPerWeek: Infinity } })
  assert.ok(problems.length > 0)
  assert.match(problems[0], /not a real number/)
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
    assert.equal(stem(a), stem(b), `${a} and ${b} are the same word to an owner reading their own ledger`)
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

/* ---------- the shortlist ---------------------------------------------------------------- */

test('the shortlist ranks candidates and never exceeds its limit', () => {
  const index = buildIndex(catalogue)
  const candidates = shortlist(newsletter, catalogue, index)
  assert.ok(candidates.length > 0)
  assert.ok(candidates.length <= SHORTLIST_LIMIT)
  assert.equal(candidates[0].id, 'agent:content')
  for (let i = 1; i < candidates.length; i += 1) {
    assert.ok(candidates[i - 1].score >= candidates[i].score, 'candidates come back ranked')
  }
})

test('one shared word never reaches the shortlist, however rare that word is', () => {
  const index = buildIndex(catalogue)
  const candidates = shortlist(exotic, catalogue, index)
  assert.equal(candidates.length, 0)
  for (const candidate of shortlist(newsletter, catalogue, index)) {
    assert.ok(candidate.shared >= MIN_SHARED_WORDS)
  }
})

test('team-maintenance tooling never reaches the shortlist', () => {
  const withTeamItem = [
    ...catalogue,
    {
      id: 'skill:token-saver',
      kind: 'skill',
      slug: 'token-saver',
      name: 'token-saver',
      audience: 'team',
      description: 'Use when the user asks about token usage — what is eating my context, should I clear or compact',
      path: '.claude/skills/token-saver/SKILL.md'
    }
  ]
  const clearing = { task: 'Clearing my inbox', words: 'My inbox eats the first hour of every day' }
  const ids = shortlist(clearing, withTeamItem, buildIndex(withTeamItem)).map((candidate) => candidate.id)
  assert.ok(!ids.includes('skill:token-saver'), "the team's own token advisor is not an answer to an inbox problem")
})

test('the shortlist is stable — the same inputs give the same order every time', () => {
  const index = buildIndex(catalogue)
  assert.deepEqual(shortlist(newsletter, catalogue, index), shortlist(newsletter, catalogue, index))
})

/* ---------- choosing --------------------------------------------------------------------- */

test('choosing from the shortlist produces a proposal carrying all three citations', () => {
  const result = match(ledgerOf([newsletter]), catalogue)
  const entry = entryFor(result, 'Writing the newsletter')
  assert.ok(entry, 'the task should get a shortlist')

  const { proposal, problems } = proposalFrom(entry, 'agent:content')
  assert.deepEqual(problems, [])
  assert.equal(proposal.item, 'agent:content')
  assert.equal(proposal.citations.words, newsletter.words, 'the quote is verbatim, not a summary')
  assert.match(proposal.citations.number, /3/)
  assert.equal(proposal.citations.item, 'agent:content')
  assert.deepEqual(validateProposal(proposal), [])
})

/* This is the whole reason a model is allowed to choose at all. It may read sentences; it may not
   make things up. The closed world is still built in code, before any judgment happens. */

test('choosing something that is not on the shortlist is refused — the skill may pick, never invent', () => {
  const result = match(ledgerOf([newsletter]), catalogue)
  const entry = entryFor(result, 'Writing the newsletter')

  const { proposal, problems } = proposalFrom(entry, 'agent:invented-by-the-model')
  assert.equal(proposal, null)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /not on the shortlist/)
})

test('choosing a real catalogue item that simply did not make this shortlist is also refused', () => {
  const result = match(ledgerOf([inbox]), catalogue)
  const entry = entryFor(result, 'Sorting the inbox')
  assert.ok(entry, 'the inbox task should shortlist something')
  assert.ok(!entry.candidates.some((candidate) => candidate.id === 'agent:content'), 'baseline: content is not a candidate here')

  const { proposal } = proposalFrom(entry, 'agent:content')
  assert.equal(proposal, null, 'agent:content is real, but it is not an answer to this task')
})

test('every proposal carries a predicted weekly saving, so the tune-up has something to check', () => {
  const entry = entryFor(match(ledgerOf([newsletter]), catalogue), 'Writing the newsletter')
  const { proposal } = proposalFrom(entry, 'agent:content')
  assert.equal(proposal.predicted.hoursPerWeek, 3)
  assert.equal(proposal.predicted.costPerWeek, 450)
})

test('with no hourly value the predicted cost is null, never zero', () => {
  const ledger = { owner_type: 'job', tasks: [newsletter] }
  const entry = entryFor(match(ledger, catalogue), 'Writing the newsletter')
  const { proposal } = proposalFrom(entry, 'agent:content')
  assert.equal(proposal.predicted.hoursPerWeek, 3)
  assert.equal(proposal.predicted.costPerWeek, null, 'zero would read as "this time is free", which is false')
})

/* ---------- matching --------------------------------------------------------------------- */

test('a task with no catalogue match becomes a gap phrased as a question, never a match', () => {
  const result = match(ledgerOf([exotic]), catalogue)
  assert.equal(result.shortlists.length, 0, 'nothing in the catalogue does this, so nothing is offered')
  assert.equal(result.gaps.length, 1)
  assert.match(result.gaps[0].question, /\?$/, 'a gap is a question, because we do not know the answer')
  assert.equal(result.gaps[0].words, exotic.words, 'the gap still quotes them')
})

test('named once is a note, and a note never gets a shortlist', () => {
  const result = match(ledgerOf([{ ...newsletter, confirmed: 'once' }]), catalogue)
  assert.equal(result.shortlists.length, 0)
  assert.equal(result.notes.length, 1)
  assert.equal(result.gaps.length, 0, 'a note is not a gap — we simply have not heard it twice')
})

test('a task nobody can act on is parked, not shortlisted, even with a perfect match', () => {
  const result = match(ledgerOf([{ ...newsletter, hands_off: '' }]), catalogue)
  assert.equal(result.shortlists.length, 0)
  assert.equal(result.parked.length, 1)
  assert.match(result.parked[0].reason, /who/i, 'the reason says what is missing')
})

test('nothing is offered while the ledger still has problems — the numbers get corrected first', () => {
  const result = match(ledgerOf([{ ...newsletter, words: '' }]), catalogue)
  assert.equal(result.shortlists.length, 0)
  assert.ok(result.problems.length > 0, 'it says why it refused')
  assert.match(result.problems[0], /Writing the newsletter/)
})

test('a catalogue containing something uncitable is refused outright, like a bad ledger', () => {
  const undescribed = [{ id: 'agent:ghost', kind: 'agent', slug: 'ghost', name: 'ghost', description: '', path: 'x' }]
  const result = match(ledgerOf([newsletter]), undescribed)
  assert.equal(result.shortlists.length, 0)
  assert.ok(result.problems.length > 0, 'it says why, rather than quietly offering nothing')
  assert.match(result.problems[0], /agent:ghost/)
})

test('a catalogue that is not a list is refused rather than throwing', () => {
  const result = match(ledgerOf([newsletter]), 42)
  assert.equal(result.shortlists.length, 0)
  assert.ok(result.problems.length > 0)
})

test('results are stable — matching twice gives the same answer in the same order', () => {
  const once = match(ledgerOf([newsletter, inbox, exotic]), catalogue)
  const twice = match(ledgerOf([newsletter, inbox, exotic]), catalogue)
  assert.deepEqual(once, twice)
})

/* ---------- the adversarial tests ---------------------------------------------------------- */

/* Rule 2 is only real if breaking it breaks the build. Delete the validateProposal call in
   proposalFrom and this goes red: an un-citable item reaches the caller as a finished proposal. */

test('ADVERSARIAL: the citation gate is load-bearing — remove it and this fails', () => {
  const idless = [
    {
      id: '',
      kind: 'agent',
      slug: 'content',
      name: 'content',
      audience: 'owner',
      description:
        'Writes posts, captions, and newsletters that sound like you, and leaves them as drafts for you to read before anything goes out.',
      path: '.claude/agents/content.md'
    }
  ]
  const result = match(ledgerOf([newsletter]), idless)
  const entry = entryFor(result, 'Writing the newsletter')
  assert.ok(entry, 'baseline: the item still shortlists, so the citation gate is what has to stop it')

  const { proposal, problems } = proposalFrom(entry, '')
  assert.equal(proposal, null, 'an item with no id cannot be cited, so nothing may be proposed from it')
  assert.ok(problems.length > 0)
  assert.match(problems[0], /item citation/)
})

test('ADVERSARIAL: a proposal with a citation stripped out is caught, not shipped', () => {
  const entry = entryFor(match(ledgerOf([newsletter]), catalogue), 'Writing the newsletter')
  const { proposal } = proposalFrom(entry, 'agent:content')
  assert.deepEqual(validateProposal(proposal), [], 'baseline: the real proposal is sound')

  for (const citation of REQUIRED_CITATIONS) {
    const tampered = { ...proposal, citations: { ...proposal.citations } }
    delete tampered.citations[citation]
    assert.ok(
      validateProposal(tampered).length > 0,
      `stripping the ${citation} citation produced no complaint — rule 2 is not being enforced`
    )
  }
})

/* ---------- the real repo ----------------------------------------------------------------- */

/* Every test above runs against hand-written fixtures, so the suite could be green while the
   shipped matcher offered the team's own retro tooling as the answer to running payroll — which
   it did, twice, before these existed. */

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

const idsOf = (entry) => entry.candidates.map((candidate) => candidate.id)

test('the inbox task shortlists the inbox tooling in the real catalogue', async () => {
  const result = await matchAgainstTheRealRepo([
    realTask('Sorting the inbox', 'The inbox eats my morning before I get to anything real')
  ])
  assert.equal(result.shortlists.length, 1)
  const ids = idsOf(result.shortlists[0])
  assert.ok(ids.some((id) => /inbox|email/.test(id)), `sorting the inbox should shortlist the inbox tooling, got ${ids}`)
})

test('writing the newsletter shortlists the agent whose description ends "and newsletters"', async () => {
  const result = await matchAgainstTheRealRepo([
    realTask('Writing the newsletter', 'I write the newsletter myself and it eats most of an afternoon')
  ])
  assert.ok(idsOf(result.shortlists[0]).includes('agent:content'))
})

/* The case the shortlist exists for. Word-counting ranks the sales-pipeline reviewer top for
   "replying to Google reviews" — a pun on "review" — and no threshold fixes that without killing
   every good match. What the engine must do is put the right answer in front of the skill. */

test('a homograph does not hide the right answer — it is shortlisted for the skill to pick', async () => {
  const result = await matchAgainstTheRealRepo([
    realTask('Replying to Google reviews', 'I never get round to answering the reviews people leave us')
  ])
  const ids = idsOf(result.shortlists[0])
  assert.ok(
    ids.includes('agent:email') || ids.includes('skill:draft-replies'),
    `the reply tooling must be offered even when a pun outranks it, got ${ids}`
  )
})

/* Payroll is the case that shows what the one-word floor buys and what it costs. Something in the
   catalogue shares a word with it, so it gets shown — and everything shown is wrong. The engine is
   not supposed to catch this; the skill is, by declining. What the engine MUST do is never let the
   team's own tooling be among the wrong things offered. */

test('payroll is offered nothing that could plausibly do it, and never team tooling', async () => {
  const catalogue = await loadCatalogue()
  const teamIds = new Set(catalogue.filter((item) => item.audience === 'team').map((item) => item.id))
  const result = await matchAgainstTheRealRepo([
    realTask('Doing the payroll', 'I work out the hours and run the payroll for my three staff')
  ])

  for (const entry of result.shortlists) {
    for (const candidate of entry.candidates) {
      assert.ok(!teamIds.has(candidate.id), `payroll was offered the team's own tooling (${candidate.id})`)
      assert.equal(candidate.shared, 1, 'nothing here agrees with payroll on more than a single coincidental word')
    }
  }
})

/* The guard that used to live here named four items. That is a blacklist, and a blacklist only
   covers the instances somebody already found — the next sweep turned up five more. The rule is
   structural now: NOTHING marked `audience: team` reaches a shortlist, whatever it is called. */

test('no team-maintenance tooling is ever offered for a real job', async () => {
  const catalogue = await loadCatalogue()
  const teamIds = new Set(catalogue.filter((item) => item.audience === 'team').map((item) => item.id))
  assert.ok(teamIds.size > 0, 'if nothing is marked team, this test proves nothing')

  const result = await matchAgainstTheRealRepo([
    realTask('Clearing my inbox', 'My inbox is a nightmare, it eats the first hour of every day'),
    realTask('Onboarding a new hire', 'Walking a new starter through our tools and processes'),
    realTask('Handing over to the night shift', 'I write up what happened so the next shift knows'),
    realTask('Keeping the team handbook current', 'Our handbook goes stale and I have to check what changed'),
    realTask('Updating the website prices', 'Every time we change a price I edit the website by hand'),
    realTask('Writing the monthly status report for my manager', 'Every month I write up a status report for my manager'),
    realTask('Booking travel for the team', 'I book flights and hotels for the team'),
    realTask('Prepping for meetings', 'Before every call I dig through notes to remember where we left off'),
    realTask('Doing the payroll', 'I work out the hours and run the payroll for my three staff')
  ])

  for (const entry of result.shortlists) {
    for (const candidate of entry.candidates) {
      assert.ok(
        !teamIds.has(candidate.id),
        `"${entry.task}" was offered the team's own maintenance tooling (${candidate.id})`
      )
    }
  }
  for (const gap of result.gaps) {
    assert.ok(
      !teamIds.has(gap.nearest),
      `"${gap.task}" was pointed at team tooling (${gap.nearest}) as its closest match`
    )
  }
})

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
    for (const entry of result.shortlists) {
      assert.ok(!idsOf(entry).includes(wrongAnswer), `"${task}" was offered ${wrongAnswer} again`)
    }
  }
})

/* This used to be a gap with a "nearest thing" bolted onto the question, because one shared word
   could not clear the old two-word bar. That mechanism named the item with the RAREST shared word,
   which in a small catalogue is exactly where the homographs live — it once told an owner the
   closest thing to clearing their inbox was the research agent, on the word "click". Now the
   candidate is simply shown and the skill decides. */

test('one strong shared word puts the right answer in front of the skill', async () => {
  const result = await matchAgainstTheRealRepo([
    realTask('Posting on LinkedIn', 'I know I should post on LinkedIn but I never get round to it')
  ])
  assert.equal(result.shortlists.length, 1)
  assert.ok(
    idsOf(result.shortlists[0]).includes('agent:content'),
    `the agent whose description opens "Writes posts" must be offered, got ${idsOf(result.shortlists[0])}`
  )
})

test('the tasks the product is built around all reach the skill with the right answer shown', async () => {
  const cases = [
    ['Clearing out my inbox', 'My inbox is a nightmare, it eats the first hour of every day', /email|inbox/],
    ['Answering support tickets', 'Tickets pile up and I answer the same things over and over', /customer-service/],
    ['Answering our Google reviews', 'I never get round to answering the reviews people leave us', /customer-service|email|repl/]
  ]
  for (const [task, words, expected] of cases) {
    const result = await matchAgainstTheRealRepo([realTask(task, words)])
    assert.equal(result.shortlists.length, 1, `"${task}" should reach the skill, not gap out`)
    const ids = idsOf(result.shortlists[0])
    assert.ok(
      ids.some((id) => expected.test(id)),
      `"${task}" must have a defensible answer ON the shortlist - a model cannot choose what it was not shown. Got ${ids}`
    )
  }
})

test('a gap with nothing near it does not invent a neighbour', async () => {
  const result = await matchAgainstTheRealRepo([
    realTask('Calibrating the spectrometer', 'I recalibrate the spectrometer by hand')
  ])
  assert.equal(result.gaps.length, 1)
  assert.equal(result.gaps[0].nearest, undefined)
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

// A preposition says how two things relate, never what either thing IS. The scoring makes that
// actively dangerous rather than merely useless: rarity IS the score, so a joining word that only
// one item happens to use scores the ceiling. "against" appeared once — in "graded against the
// content rubric" — and took the top slot for "close the books against last month". "behind",
// "since", "don" (the half "don't" leaves behind) and "using" all had the identical flaw.
//
// This asserts on meaningful() rather than on a score, deliberately. A score is already zero for
// any word the catalogue never happens to use, so scoring cannot tell a word that is FILTERED
// from one that is merely ABSENT — an earlier version of this test listed "above", which was not
// in the filter at all, and passed.
test('words that carry no meaning of their own are filtered, not scored', () => {
  const joiners = [
    'above', 'across', 'against', 'along', 'alongside', 'amid', 'amidst', 'among', 'amongst', 'around',
    'atop', 'behind', 'below', 'beneath', 'beside', 'besides', 'between', 'beyond', 'concerning',
    'despite', 'during', 'except', 'inside', 'minus', 'near', 'onto', 'outside', 'plus',
    'regarding', 'since', 'though', 'throughout', 'toward', 'towards', 'under', 'underneath',
    'unless', 'until', 'upon', 'versus', 'via', 'whereas', 'whether', 'while', 'whilst',
    'within', 'without'
  ]
  for (const word of joiners) {
    assert.equal(meaningful(word), false, `"${word}" is treated as meaning — it only joins two things`)
  }

  // What a contraction leaves behind after the tokenizer splits on the apostrophe.
  for (const half of [
    'don', 'doesn', 'didn', 'isn', 'aren', 'wasn', 'weren', 'won', 'wouldn', 'couldn',
    'shouldn', 'hasn', 'haven', 'hadn', 'mustn', 'needn', 'shan', 'ain'
  ]) {
    assert.equal(meaningful(half), false, `"${half}" is half a contraction, not a word`)
  }

  // 'using' cannot be reached by the stemmer: the -ing rule needs a root over five letters, so
  // it never becomes 'use' and never meets the existing use/uses filler.
  for (const adverb of [
    'using', 'accordingly', 'exactly', 'instead', 'therefore', 'however', 'meanwhile',
    // Adjectives and vague verbs that were each the rarest word in the catalogue, and so
    // the entire reason for a proposal. 'look' is the same class as see/know/think above.
    'ready', 'important', 'useful', 'proper', 'simple', 'quick', 'easy', 'hard',
    'look', 'looks', 'looking',
    // When a thing happens is not what it is — the same rule as monday/weekly above.
    'overnight', 'past', 'recent', 'recently', 'current', 'currently'
  ]) {
    assert.equal(meaningful(adverb), false, `"${adverb}" carries no meaning of its own`)
  }

  // The other half of the bargain: real words must survive. A filter that eats these is worse
  // than the defect it fixes.
  // 'news' stems to 'new', so the generic adjective and the real noun share one entry. That
  // is why 'new' is NOT filtered despite scoring the ceiling — doing so would strip the
  // market scanner's own signal. Recorded as a stemmer collision, not fixed by a word list.
  for (const real of [
    'invoice', 'inbox', 'newsletter', 'chasing', 'closing', 'payroll', 'sales', 'news', 'new'
  ]) {
    assert.equal(meaningful(real), true, `"${real}" is a real word and must still score`)
  }
})

// The regression that found it. The remaining candidates share "clos" with "Use as the closing
// step", which is chain-position boilerplate rather than meaning — recorded, not fixed here,
// because "close" is a real word a student writing "closing deals" means.
test('closing the books is not answered by whatever else said "against"', async () => {
  const catalogue = await loadCatalogue()
  const index = buildIndex(catalogue)
  const task = { task: 'Closing the books against last month', words: 'I close the books at month end' }
  for (const candidate of shortlist(task, catalogue, index)) {
    assert.ok(
      !candidate.words.includes('against'),
      `${candidate.id} was offered on the word "against": [${candidate.words.join(', ')}]`
    )
  }
})

// A confident wrong answer is worse than no answer. Before the filter, this task returned
// customer-service as its ONLY candidate, on "using" alone.
test('a task the catalogue cannot do comes back a gap, not a confident wrong answer', async () => {
  const catalogue = await loadCatalogue()
  const index = buildIndex(catalogue)
  const shown = shortlist({ task: 'Using the spreadsheet every week', words: 'using the spreadsheet' }, catalogue, index)
  assert.deepEqual(shown, [], `offered ${shown.map((c) => `${c.id} on [${c.words}]`).join('; ')}`)
})
