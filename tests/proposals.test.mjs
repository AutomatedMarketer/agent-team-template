import test from 'node:test'
import assert from 'node:assert/strict'
import { validateProposals, summarizeProposals } from '../scripts/lib/proposals.mjs'

/* proposals.yml is the only file in this repo a model writes. The /match skill reads the engine's
   shortlists, reads the sentences, and chooses — which is the whole reason it exists, because
   word-counting cannot tell a customer's REVIEW from the sales pipeline REVIEW.

   Every test here is therefore a test that the skill CANNOT get away with something. It can write
   anything into the file; what it cannot do is write something that survives being compared back
   to the ledger and the catalogue. */

const inbox = {
  task: 'Sorting the inbox',
  words: 'The inbox eats my morning before I get to anything real',
  who: 'me',
  times_per_week: 5,
  minutes_each: 40,
  confirmed: 'twice',
  hands_off: 'They sit in drafts and I send them'
}

const newsletter = {
  task: 'Writing the newsletter',
  words: 'I write the newsletter myself and it eats most of an afternoon',
  who: 'me',
  times_per_week: 1,
  minutes_each: 180,
  confirmed: 'twice',
  hands_off: 'I read it before it goes out'
}

const exotic = {
  task: 'Calibrating the spectrometer',
  words: 'I recalibrate the spectrometer by hand',
  who: 'me',
  times_per_week: 1,
  minutes_each: 90,
  confirmed: 'twice',
  hands_off: 'I sign the calibration sheet'
}

const catalogue = [
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
    id: 'agent:email',
    kind: 'agent',
    slug: 'email',
    name: 'email',
    audience: 'owner',
    description:
      'Sweeps your inbox, archives the noise, tells you what actually needs you, and leaves replies sitting in your drafts folder.',
    path: '.claude/agents/email.md'
  }
]

const ledgerOf = (tasks, extra = {}) => ({ owner_type: 'business', hourly_value: 150, tasks, ...extra })

const soundFile = {
  proposals: [
    {
      task: 'Writing the newsletter',
      item: 'agent:content',
      why: 'its description names newsletters directly',
      words: newsletter.words,
      number: '3 hours a week, 450 a week' 
    }
  ],
  gaps: []
}

/* ---------- the happy path ---------------------------------------------------------------- */

test('a proposals file that agrees with the ledger and the catalogue is sound', () => {
  assert.deepEqual(validateProposals(soundFile, ledgerOf([newsletter]), catalogue), [])
})

/* ---------- what the skill cannot get away with -------------------------------------------- */

test('a proposal for a task nobody put in the ledger is refused', () => {
  const file = {
    proposals: [{ ...soundFile.proposals[0], task: 'Something they never said' }],
    gaps: []
  }
  const problems = validateProposals(file, ledgerOf([newsletter]), catalogue)
  assert.ok(problems.some((problem) => /not in the ledger/.test(problem)))
})

test('a quote that has been tidied up is not a quote', () => {
  const file = {
    proposals: [
      {
        ...soundFile.proposals[0],
        words: 'Writing the newsletter takes a whole afternoon' 
      }
    ],
    gaps: []
  }
  const problems = validateProposals(file, ledgerOf([newsletter]), catalogue)
  assert.ok(problems.some((problem) => /verbatim/.test(problem)))
})

test('a number the model preferred to the derived one is refused', () => {
  const file = {
    proposals: [
      {
        ...soundFile.proposals[0],
        number: '10 hours a week, 1500 a week' 
      }
    ],
    gaps: []
  }
  const problems = validateProposals(file, ledgerOf([newsletter]), catalogue)
  assert.ok(problems.some((problem) => /the ledger derives/.test(problem)))
})

test('choosing an item that was never on the shortlist is refused', () => {
  const file = {
    proposals: [
      {
        task: 'Writing the newsletter',
        item: 'agent:email',
        why: 'I liked it',
        words: newsletter.words,
        number: '3 hours a week, 450 a week' 
      }
    ],
    gaps: []
  }
  const problems = validateProposals(file, ledgerOf([newsletter]), catalogue)
  assert.ok(problems.some((problem) => /not on the shortlist/.test(problem)))
})

test('an item that does not exist at all is refused', () => {
  const file = {
    proposals: [
      {
        task: 'Writing the newsletter',
        item: 'agent:invented',
        why: 'seemed right',
        words: newsletter.words,
        number: '3 hours a week, 450 a week' 
      }
    ],
    gaps: []
  }
  const problems = validateProposals(file, ledgerOf([newsletter]), catalogue)
  assert.ok(problems.some((problem) => /not on the shortlist/.test(problem)))
})

test('proposing on something the owner said only once is refused', () => {
  const once = { ...newsletter, confirmed: 'once' }
  const problems = validateProposals(soundFile, ledgerOf([once]), catalogue)
  assert.ok(problems.some((problem) => /mentioned once|only mentioned once|note/.test(problem)))
})

test('proposing on something nobody acts on is refused', () => {
  const parked = { ...newsletter, hands_off: '' }
  const problems = validateProposals(soundFile, ledgerOf([parked]), catalogue)
  assert.ok(problems.some((problem) => /parked/.test(problem)))
})

test('the same task answered twice is refused', () => {
  const file = { proposals: [soundFile.proposals[0], soundFile.proposals[0]], gaps: [] }
  const problems = validateProposals(file, ledgerOf([newsletter]), catalogue)
  assert.ok(problems.some((problem) => /answered twice/.test(problem)))
})

/* ---------- nothing may be quietly dropped -------------------------------------------------- */

test('a shortlisted task the file says nothing about is a problem', () => {
  const file = { proposals: [], gaps: [] }
  const problems = validateProposals(file, ledgerOf([newsletter]), catalogue)
  assert.ok(problems.some((problem) => /says nothing about it/.test(problem)))
})

test('a task with no catalogue match has to be carried as a stated gap', () => {
  const file = { proposals: soundFile.proposals, gaps: [] }
  const problems = validateProposals(file, ledgerOf([newsletter, exotic]), catalogue)
  assert.ok(problems.some((problem) => /does not carry it as a gap/.test(problem)))
})

test('carrying the gap makes it sound again', () => {
  const file = {
    proposals: soundFile.proposals,
    gaps: [{ task: 'Calibrating the spectrometer', question: 'What would have to exist to take this off your week?' }]
  }
  assert.deepEqual(validateProposals(file, ledgerOf([newsletter, exotic]), catalogue), [])
})

/* ---------- saying why ---------------------------------------------------------------------- */

/* A shortlist of three answered with no reason is a coin flip wearing a citation. The skill was
   given the choice precisely because it can read; if it cannot say what it read, it did not. */

test('choosing from several candidates without saying why is refused', () => {
  const twoWays = {
    task: 'Replying to messages',
    words: 'I write replies and leave them sitting in drafts',
    who: 'me',
    times_per_week: 5,
    minutes_each: 30,
    confirmed: 'twice',
    hands_off: 'They sit in drafts and I send them'
  }
  const wider = [
    ...catalogue,
    {
      id: 'skill:draft-replies',
      kind: 'skill',
      slug: 'draft-replies',
      name: 'draft-replies',
      audience: 'owner',
      description: 'Write a reply for every message triage marked draftable and leave each one in the drafts folder.',
      path: '.claude/skills/draft-replies/SKILL.md'
    }
  ]
  const file = {
    proposals: [
      {
        task: 'Replying to messages',
        item: 'skill:draft-replies',
        words: twoWays.words,
        number: '2.5 hours a week, 375 a week' 
      }
    ],
    gaps: []
  }
  const problems = validateProposals(file, ledgerOf([twoWays]), wider)
  assert.ok(
    problems.some((problem) => /no reason given/.test(problem)),
    `expected a complaint about the missing reason, got ${JSON.stringify(problems)}`
  )
})

/* ---------- refusing to check at all -------------------------------------------------------- */

test('an unsound ledger stops the check rather than producing a verdict on nonsense', () => {
  const problems = validateProposals(soundFile, ledgerOf([{ ...newsletter, words: '' }]), catalogue)
  assert.ok(problems[0].startsWith('the ledger itself is not sound'))
})

test('a file with no proposals list at all is a problem, not an empty pass', () => {
  const problems = validateProposals({}, ledgerOf([newsletter]), catalogue)
  assert.ok(problems.some((problem) => /needs a `proposals:` list/.test(problem)))
})

/* ---------- the summary --------------------------------------------------------------------- */

test('the summary adds up only what was actually proposed, and counts what was written', () => {
  // Gaps are counted from the FILE, not from what the engine derived. Most gaps now arrive as a
  // decline - the engine offered candidates and the skill refused them all - so counting derived
  // gaps reported zero while the file plainly carried two.
  const withGap = {
    proposals: soundFile.proposals,
    gaps: [{ task: 'Calibrating the spectrometer', question: 'Nothing here does this - should it?' }]
  }
  const summary = summarizeProposals(withGap, ledgerOf([newsletter, exotic]), catalogue)
  assert.equal(summary.proposed, 1)
  assert.equal(summary.hoursPerWeek, 3)
  assert.equal(summary.costPerWeek, 450)
  assert.equal(summary.gaps, 1)
})

test('with no rate the summary reports hours and leaves money blank', () => {
  const summary = summarizeProposals(soundFile, { owner_type: 'job', tasks: [newsletter] }, catalogue)
  assert.equal(summary.hoursPerWeek, 3)
  assert.equal(summary.costPerWeek, null)
  assert.equal(summary.unpriced, true)
})

/* ---------- declining ----------------------------------------------------------------------- */

/* The engine shortlists anything sharing a word, so most shortlists contain things that do not do
   the job. Refusing all of them is the correct answer often enough that it has to be first class.

   For a while it was not. The skill said "decline it and move it to gaps" in three places and the
   lesson said it in three more, and doing exactly that produced an error with no way out. Once
   the engine shortlisted anything, a proposal was mandatory - which is how a product built to
   stop confident wrong answers came to require one. */

test('a shortlisted task can be declined by carrying it as a gap', () => {
  const declined = {
    proposals: [],
    gaps: [{ task: 'Writing the newsletter', question: 'Offered the content agent, but it writes marketing posts and this is an internal update. Nothing here does that - should it?' }]
  }
  assert.deepEqual(validateProposals(declined, ledgerOf([newsletter]), catalogue), [])
})

test('declining without saying why none of them fit is refused', () => {
  const declined = {
    proposals: [],
    gaps: [{ task: 'Writing the newsletter', question: '' }]
  }
  const problems = validateProposals(declined, ledgerOf([newsletter]), catalogue)
  assert.ok(problems.some((problem) => /no reason/.test(problem)))
})

test('silence is still refused - a task is proposed on or declined, never ignored', () => {
  const silent = { proposals: [], gaps: [] }
  const problems = validateProposals(silent, ledgerOf([newsletter]), catalogue)
  assert.ok(problems.some((problem) => /says nothing about it/.test(problem)))
  assert.ok(problems.some((problem) => /decline them all/.test(problem)), 'the error has to name the way out')
})

test('a sole candidate still needs a reason - being the only one is not one', () => {
  const soleCandidate = {
    proposals: [{ task: 'Writing the newsletter', item: 'agent:content', words: newsletter.words, number: '3 hours a week, 450 a week' }],
    gaps: []
  }
  const problems = validateProposals(soleCandidate, ledgerOf([newsletter]), catalogue)
  assert.ok(problems.some((problem) => /not a reason/.test(problem)))
})

/* ---------- the decline path, checked in both directions ------------------------------------ */

/* Declining was checked in exactly ONE direction: you could not silently skip a shortlist. Every
   other way of writing a wrong gap sailed through, and the results contradicted themselves in the
   same printout - one run proposed "Chasing invoices" and four lines lower listed it under
   "things nothing on the team does yet", exit 0. The gaps list is the specification for what gets
   built next, so it earns the same scrutiny the proposals get. */

const declineOf = (task, question) => ({ proposals: [], gaps: [{ task, question }] })

test('a task cannot be both proposed and declined', () => {
  const both = {
    proposals: soundFile.proposals,
    gaps: [{ task: 'Writing the newsletter', question: 'Also declared impossible, in the same file.' }]
  }
  const problems = validateProposals(both, ledgerOf([newsletter]), catalogue)
  assert.ok(problems.some((problem) => /both proposed and declined/.test(problem)))
})

test('a gap for something the owner never said is refused', () => {
  const invented = {
    proposals: soundFile.proposals,
    gaps: [{ task: 'Feeding my goldfish', question: 'Nothing here feeds a goldfish - should it?' }]
  }
  const problems = validateProposals(invented, ledgerOf([newsletter]), catalogue)
  assert.ok(problems.some((problem) => /not in the ledger/.test(problem)))
})

test('the same task carried as a gap twice is refused', () => {
  const twice = {
    proposals: [],
    gaps: [
      { task: 'Writing the newsletter', question: 'Declined once, with a reason long enough.' },
      { task: 'Writing the newsletter', question: 'And declined again, which should be refused.' }
    ]
  }
  const problems = validateProposals(twice, ledgerOf([newsletter]), catalogue)
  assert.ok(problems.some((problem) => /as a gap twice/.test(problem)))
})

test('a note cannot be promoted into the build list by declining it', () => {
  const once = { ...newsletter, confirmed: 'once' }
  const problems = validateProposals(
    declineOf('Writing the newsletter', 'Declining something that was only ever mentioned once.'),
    ledgerOf([once]),
    catalogue
  )
  assert.ok(problems.some((problem) => /mentioned once/.test(problem)))
})

test('a parked task cannot be promoted into the build list by declining it', () => {
  const parked = { ...newsletter, hands_off: '' }
  const problems = validateProposals(
    declineOf('Writing the newsletter', 'Declining something nobody has agreed to act on.'),
    ledgerOf([parked]),
    catalogue
  )
  assert.ok(problems.some((problem) => /parked/.test(problem)))
})

test('a bare gaps: key is a validation message, not a stack trace', () => {
  // This used to loop over ['', null, 'none', 42] and assert every one produced a problem. It
  // passed, but never for its own reason: '' and null were ALREADY legal, and the problem it saw
  // was the undeclined shortlist sitting underneath. Split apart, so each half means something.
  for (const value of ['none', 42]) {
    const problems = validateProposals({ proposals: [], gaps: value }, ledgerOf([newsletter]), catalogue)
    assert.ok(Array.isArray(problems), `gaps: ${JSON.stringify(value)} should not throw`)
    assert.ok(
      problems.some((problem) => /`gaps:` must be a list/.test(problem)),
      `gaps: ${JSON.stringify(value)} should be reported as not a list`
    )
  }
})

test('gaps written empty is "I declined nothing", not a malformed file', () => {
  // yaml-lite parses a key with nothing under it to an EMPTY OBJECT. The guard tested for the
  // empty string instead, on the strength of a comment that said so and had never been run
  // against the parser, so `gaps:` on its own line was rejected as "must be a list".
  for (const value of [{}, '', null]) {
    const problems = validateProposals(
      { proposals: soundFile.proposals, gaps: value },
      ledgerOf([newsletter]),
      catalogue
    )
    assert.deepEqual(problems, [], `gaps: ${JSON.stringify(value)} should be an empty decline list`)
  }
})

test('a week where everything correctly declines is a valid file, not a dead end', () => {
  // The employee case, and the one that dead-ended: an owner with no proposals at all. Their
  // shortlists were read and every one was refused, which the lesson calls the correct output.
  // `proposals:` written empty parsed to {}, so the check refused the file with the words
  // "needs a `proposals:` list, even if it is empty" - over a file whose list was empty.
  const file = {
    proposals: {},
    gaps: [
      {
        task: 'Writing the newsletter',
        question: 'Offered agent:content, which writes in the owner\'s own voice; this newsletter is my employer\'s and I only assemble it. Nothing here does that - should it?'
      }
    ]
  }
  assert.deepEqual(validateProposals(file, ledgerOf([newsletter]), catalogue), [])
  assert.equal(summarizeProposals(file, ledgerOf([newsletter]), catalogue).proposed, 0)
})

test('a file with no proposals key at all is still a problem', () => {
  // The other half of the same change, and the reason `undefined` is not folded in with `{}`:
  // a key written empty says "none of them", and no key at all says this is not a proposals file.
  const problems = validateProposals({ gaps: [] }, ledgerOf([newsletter]), catalogue)
  assert.ok(problems.some((problem) => /needs a `proposals:` list/.test(problem)))
})

/* ---------- an agent the owner switched off is not an answer -------------------------------- */

test('a proposal naming an agent the owner is not using is refused', () => {
  // Existing, describable, owner-facing, and top-ranked - and it cannot do a thing, because the
  // owner wrote in its own knowledge file that it does not apply to them. Every other check
  // passed it, and the reporter printed "names something that already exists" underneath.
  const offCatalogue = catalogue.map((item) =>
    item.id === 'agent:content' ? { ...item, inUse: false } : item
  )
  const problems = validateProposals(soundFile, ledgerOf([newsletter]), offCatalogue)
  assert.ok(
    problems.some((problem) => /agent:content, which you have said is not in use/.test(problem)),
    problems.join('\n')
  )
})

test('a proposal naming a workflow owned by a switched-off agent is refused', () => {
  const withWorkflow = [
    ...catalogue,
    {
      id: 'workflow:newsletter-run',
      kind: 'workflow',
      slug: 'newsletter-run',
      name: 'Newsletter Run',
      audience: 'owner',
      inUse: false,
      owner: 'content',
      description: 'Writes the newsletter draft and leaves it for you to read before it goes out.',
      path: 'workflows/newsletter-run.yml'
    }
  ]
  const file = {
    proposals: [
      {
        ...soundFile.proposals[0],
        item: 'workflow:newsletter-run',
        why: 'Beat agent:content, which drafts one piece; this runs the whole newsletter job end to end.'
      }
    ],
    gaps: []
  }
  const problems = validateProposals(file, ledgerOf([newsletter]), withWorkflow)
  assert.ok(
    problems.some((problem) => /workflow:newsletter-run, which is owned by content/.test(problem)),
    problems.join('\n')
  )
})

test('an item with no inUse flag at all is still proposable', () => {
  // The flag is set by loadCatalogue. A hand-built catalogue - every other test in this file, and
  // any caller written before the flag existed - must not have everything silently refused.
  assert.ok(catalogue.every((item) => item.inUse === undefined))
  assert.deepEqual(validateProposals(soundFile, ledgerOf([newsletter]), catalogue), [])
})

test('gaps left out entirely is fine when there is nothing to decline', () => {
  const problems = validateProposals({ proposals: soundFile.proposals }, ledgerOf([newsletter]), catalogue)
  assert.deepEqual(problems, [])
})

/* ---------- a reason has to be a reason ------------------------------------------------------ */

/* "It chases." and "It handles email." both cleared a presence check. Under twenty shortlists a
   model writes thin reasons and nothing catches it, which makes the judgment step a rubber stamp
   with a citation attached. */

test('a tautology is not a reason', () => {
  const thin = {
    proposals: [{ ...soundFile.proposals[0], why: 'It writes.' }],
    gaps: []
  }
  const problems = validateProposals(thin, ledgerOf([newsletter]), catalogue)
  assert.ok(problems.some((problem) => /restatement rather than a reason/.test(problem)))
})

test('a choice from several candidates must name what it rejected', () => {
  const twoWays = {
    task: 'Replying to messages',
    words: 'I write replies and leave them sitting in drafts',
    who: 'me',
    times_per_week: 5,
    minutes_each: 30,
    confirmed: 'twice',
    hands_off: 'They sit in drafts and I send them'
  }
  const wider = [
    ...catalogue,
    {
      id: 'skill:draft-replies',
      kind: 'skill',
      slug: 'draft-replies',
      name: 'draft-replies',
      audience: 'owner',
      description: 'Write a reply for every message triage marked draftable and leave each one in the drafts folder.',
      path: '.claude/skills/draft-replies/SKILL.md'
    }
  ]
  const unnamed = {
    proposals: [{
      task: 'Replying to messages',
      item: 'skill:draft-replies',
      why: 'This one fits the job better than the alternatives offered here.',
      words: twoWays.words,
      number: '2.5 hours a week, 375 a week'
    }],
    gaps: []
  }
  const problems = validateProposals(unnamed, ledgerOf([twoWays]), wider)
  assert.ok(problems.some((problem) => /without naming any of them/.test(problem)))

  const named = {
    proposals: [{ ...unnamed.proposals[0], why: 'Rejected agent:email, which sweeps a whole inbox rather than drafting one reply.' }],
    gaps: []
  }
  assert.deepEqual(validateProposals(named, ledgerOf([twoWays]), wider), [])
})

/* A reason may not name something that was never on the table.

   `rejected.some(...)` is satisfied by naming ONE of N, and nothing checked that a named item was
   ever offered. A walkthrough shipped a committed proposal citing "Rejected agent:sales" for a
   task where agent:sales was not a candidate in that repo - the shortlist had been computed in a
   different repo, whose catalogue ranks differently - and the file passed. Inventing an
   alternative is the one thing the engine exists to make impossible, and the reason was the one
   place nothing checked. */
test('a reason that names a candidate which was never offered is refused', () => {
  const file = {
    proposals: [{
      ...soundFile.proposals[0],
      why: 'its description names newsletters directly. Rejected agent:sales, which only shared write.'
    }],
    gaps: []
  }
  const problems = validateProposals(file, ledgerOf([newsletter]), catalogue)
  assert.ok(
    problems.some((problem) => /agent:sales.*never offered/.test(problem)),
    `expected a never-offered problem, got: ${JSON.stringify(problems)}`
  )
})

test('naming the item that WAS offered - the chosen one - is not a phantom', () => {
  // agent:content is the only candidate this task produces, so it is the only id nameable here.
  // The first version of this test named agent:email, which is in the CATALOGUE but shares no
  // word with the newsletter task and so was never a candidate - the check was right to flag it,
  // and the test was wrong. Being in the catalogue is not the same as being on the table.
  const file = {
    proposals: [{
      ...soundFile.proposals[0],
      why: 'agent:content names newsletters in its own description, which is the job here.'
    }],
    gaps: []
  }
  const problems = validateProposals(file, ledgerOf([newsletter]), catalogue)
  assert.deepEqual(problems.filter((problem) => /never offered/.test(problem)), [])
})
