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
  assert.ok(problems.some((problem) => /declined without saying why/.test(problem)))
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
