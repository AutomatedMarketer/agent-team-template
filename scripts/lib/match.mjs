import { classify, deriveTask, validateLedger, isUnfilled } from './ledger.mjs'
import { describable, proposable, validateCatalogue } from './catalogue.mjs'

// The match engine turns a measured week into a proposed team. It does exactly one thing that
// matters: it refuses.
//
// It refuses to propose anything while the ledger still has problems, because a wrong ledger is
// obvious to the person who lived that week and a wrong list of agents is not. It refuses to
// name anything outside the catalogue, because the failure this whole build exists to stop is a
// declaration nothing backs. And it refuses to emit a proposal that cannot cite the owner's own
// words, the number those words produced, and the catalogue item being offered.
//
// There is no model call in here. Matching is a deterministic comparison of words, so the same
// ledger and the same catalogue always give the same proposals — which is what makes it possible
// to hand someone a proposals.md and have them check it.

export const REQUIRED_CITATIONS = ['words', 'number', 'item']

// The gate is the COUNT; the weight only decides which of the candidates wins.
//
// One shared word is an accident of English however rare it is — "Calibrating the spectrometer"
// and a skill that installs a stack share exactly one uncommon word and nothing else, and a
// weight-only gate happily scored that 3.74 and proposed it. Two independent agreements between
// two texts written months apart by different people is the smallest thing that is not luck.
//
// The gate is deliberately NOT a weighted threshold. Weights are log(items / items using the
// word), so they scale with the size of the catalogue: any absolute bar that behaved sensibly on
// this repo's 42 items would silently refuse everything in a student's smaller repo, which is the
// opposite of the failure it was meant to prevent. A count travels; a magic number does not.
export const MIN_SHARED_WORDS = 2

// When something happens is not what it is. The ledger already records the when, as numbers the
// owner corrected — times_per_week and minutes_each. Leaving day names and cadence words in the
// text lets them match twice and, worse, match wrongly: "Every Sunday I write the newsletter"
// scored against the weekly tune-up on {sunday, weekly} and beat the content agent, whose own
// description literally ends "posts, captions, and newsletters".
const WHEN = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'morning', 'afternoon', 'evening', 'night', 'today', 'tomorrow', 'yesterday',
  'daily', 'weekly', 'monthly', 'yearly', 'hourly', 'often', 'always', 'never',
  'hour', 'hours', 'minute', 'minutes', 'day', 'days', 'month', 'months', 'year', 'years'
]

// Auxiliaries and the handful of verbs that mean nothing on their own. 'did' alone was enough
// to pair 'what I did for my manager' with 'Did the team produce work you actually used?' and
// propose the quality review as the answer to reporting up.
const AUXILIARY = [
  'did', 'done', 'doing', 'am', 'been', 'having', 'could', 'should', 'must', 'may', 'might',
  'shall', 'let', 'make', 'makes', 'made', 'give', 'gives', 'given', 'want', 'wants', 'like',
  'know', 'knows', 'think', 'thinks', 'say', 'says', 'said', 'see', 'sees', 'seen', 'come',
  'comes', 'came', 'went', 'goes', 'going', 'actually', 'already', 'even', 'ever', 'here', 'how',
  // Interrogatives and vague nouns. 'where' survived as the stem "wher" and, being rare in the
  // catalogue, scored a perfect 1.00 - enough on its own to answer "prepping for meetings" with
  // the research agent. A word that means nothing should never be the rarest word in the room.
  'where', 'why', 'whose', 'whom', 'because', 'round', 'ages', 'stuff', 'somewhere', 'anywhere',
  'everything', 'something', 'nothing', 'anyone', 'someone', 'everyone', 'else', 'etc'
]

// How many is not what it is, for the same reason the day of the week is not. "my three staff"
// matched the task sweep's "three per run" and, with one generic word beside it, was enough to
// propose the team's own card-router as the answer to running payroll.
const QUANTITY = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'dozen', 'few', 'several', 'many', 'half', 'both', 'each',
  'first', 'second', 'third', 'last', 'next', 'per'
]

// Filler carries no meaning and would otherwise let any task match any item. Kept deliberately
// short and boring: this is not a stemmer, and it does not need to be.
const FILLER = new Set([
  ...WHEN,
  ...QUANTITY,
  ...AUXILIARY,
  'a', 'about', 'after', 'all', 'an', 'and', 'any', 'anything', 'are', 'as', 'at', 'back',
  'be', 'been', 'before', 'being', 'but', 'by', 'can', 'do', 'does', 'each', 'every', 'for',
  'from', 'get', 'gets', 'go', 'goes', 'got', 'had', 'has', 'have', 'i', 'if', 'in', 'into',
  'is', 'it', 'its', 'just', 'keep', 'lot', 'me', 'more', 'most', 'much', 'my', 'need',
  'needs', 'no', 'not', 'of', 'off', 'on', 'one', 'only', 'or', 'other', 'our', 'out', 'over',
  'own', 'put', 'really', 'same', 'she', 'so', 'some', 'still', 'take', 'takes', 'than',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'thing', 'things', 'this',
  'those', 'through', 'time', 'to', 'up', 'us', 'use', 'very', 'was', 'we', 'week', 'were',
  'what', 'when', 'which', 'who', 'whole', 'will', 'with', 'work', 'would', 'you', 'your'
])

// An owner writes their week in gerunds — "Chasing invoices", "Sorting the inbox". An item
// describes itself in the third person — "Chases invoices", "Sweeps your inbox". Those are the
// same word and must stem to the same root, or the matcher misses the most obvious pairings in
// the whole product while the right item sits in the catalogue doing nothing.
//
// Order matters: plural, then tense, then the trailing e. That is what puts invoice/invoices,
// write/writes/writing and chase/chases/chasing each on a single root.
export function stem(word) {
  let root = word

  if (root.length > 4 && root.endsWith('ies')) root = `${root.slice(0, -3)}y`
  else if (root.length > 4 && root.endsWith('ses')) root = root.slice(0, -2)
  else if (root.length > 3 && root.endsWith('s') && !root.endsWith('ss') && !root.endsWith('us')) {
    root = root.slice(0, -1)
  }

  if (root.length > 5 && root.endsWith('ing')) root = root.slice(0, -3)
  else if (root.length > 4 && root.endsWith('ed')) root = root.slice(0, -2)

  if (root.length > 4 && root.endsWith('e')) root = root.slice(0, -1)

  return root
}

// Filler is checked on the stem as well as the raw word. Checking the raw word alone let "works"
// and "weeks" through the filter and back into the score as work/week — filler leaking in by the
// back door, inflating exactly the generic matches the floor exists to stop.
function meaningful(word) {
  if (word.length <= 2 || FILLER.has(word)) return false
  return !FILLER.has(stem(word))
}

function meaningfulWords(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(meaningful)
      .map(stem)
  )
}

function itemWords(item) {
  return meaningfulWords(`${item?.name ?? ''} ${item?.description ?? ''}`)
}

// How rare a word is across this catalogue is the whole signal. "weekly", "run", "write" and
// "review" appear all over a team repo and mean almost nothing; "invoice", "inbox", "newsletter"
// appear once or twice and mean almost everything. Counting shared words flat treats those the
// same — which is how "doing the weekly payroll" came to match the team's own run-log collector
// on {weekly, run}: a confident, absurd proposal of exactly the kind this build exists to stop.
//
// So a shared word is worth log(items / items using it). Near zero for a word everything uses,
// high for a word that names one specific job.
export function buildIndex(catalogue) {
  const frequency = new Map()
  let items = 0
  for (const item of catalogue ?? []) {
    // Counted over the pool we actually match against. Including team tooling would make a word
    // look common because the maintenance skills use it, and quietly devalue it for the owner.
    if (!proposable(item)) continue
    items += 1
    for (const word of itemWords(item)) frequency.set(word, (frequency.get(word) ?? 0) + 1)
  }
  return { frequency, items }
}

// Smoothed with items + 1 rather than items. Plain log(items / seen) is degenerate at the small
// end: in a one-item catalogue every word has seen === items, so log(1) is 0 and NOTHING can ever
// match. A student's first repo is exactly that small, so the unsmoothed form would have shipped
// a matcher that works here and silently refuses everything for them.
export function weightOf(word, index) {
  if (!index || !index.items) return 1 // no catalogue to weigh against: every shared word counts once
  const seen = index.frequency.get(word) ?? 0
  if (seen === 0) return 0
  return Math.log((index.items + 1) / seen)
}

// The score is what the owner's own words and the item's own description agree on, weighted by
// how much that agreement is worth. Both texts were written for humans, by different people, at
// different times — which is why agreement between them means anything at all.
//
// `index` is optional. Without one every shared word counts as 1, which is the plain overlap
// count the unit tests compare relative scores with.
export function scoreMatch(task, item, index) {
  return measureMatch(task, item, index).score
}

// The same comparison, but keeping the count as well as the weight, because a match has to clear
// both bars and a caller that only sees the total cannot tell one rare coincidence from two real
// agreements.
export function measureMatch(task, item, index) {
  if (!describable(item)) return { score: 0, shared: 0, words: [] }
  const theirs = meaningfulWords(`${task?.task ?? ''} ${task?.words ?? ''}`)
  const its = itemWords(item)
  const words = []
  let score = 0
  for (const word of theirs) {
    if (!its.has(word)) continue
    words.push(word)
    score += weightOf(word, index)
  }
  return { score, shared: words.length, words: words.sort() }
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

// Rule 2, enforced in code rather than in a checklist. Returns human-readable problems; empty
// means the proposal can be shown to someone. Nothing in this file emits a proposal without
// running it through here first.
export function validateProposal(proposal) {
  const problems = []
  const citations = proposal?.citations ?? {}

  for (const citation of REQUIRED_CITATIONS) {
    const value = textOf(citations[citation])
    if (!value || isUnfilled(value)) {
      problems.push(
        `${proposal?.task ?? 'a proposal'} cannot be offered: it is missing the ${citation} citation`
      )
    }
  }

  // A citation that points somewhere other than the thing being proposed is worse than a missing
  // one, because it reads as evidence while being none.
  if (problems.length === 0 && textOf(citations.item) !== textOf(proposal?.item)) {
    problems.push(
      `${proposal?.task ?? 'a proposal'} offers ${proposal?.item} but cites ${citations.item} — a citation must name the thing it is evidence for`
    )
  }

  // Rule 6 has to fail closed like the rest. Presence is not enough: "NaN hours a week" and
  // "Infinity a week" are non-empty strings that sail through a presence check, and a prediction
  // that is not a real number is one the tune-up can never check against what actually ran.
  const predicted = proposal?.predicted
  if (!Number.isFinite(predicted?.hoursPerWeek)) {
    problems.push(
      `${proposal?.task ?? 'a proposal'} has no usable predicted saving — there would be nothing for the tune-up to check`
    )
  } else if (predicted.costPerWeek !== null && !Number.isFinite(predicted.costPerWeek)) {
    problems.push(
      `${proposal?.task ?? 'a proposal'} has a predicted cost that is not a real number`
    )
  }

  return problems
}

function numberCitation({ hoursPerWeek, costPerWeek }) {
  const hours = Math.round(hoursPerWeek * 10) / 10
  const time = `${hours} hours a week`
  return costPerWeek === null ? time : `${time}, ${Math.round(costPerWeek)} a week`
}

// Ties break on the catalogue's own order, which is alphabetical by kind then slug. Arbitrary,
// but fixed — so the same week never produces two different teams on two different days.
// Word-counting cannot tell a customer's REVIEW from the sales pipeline REVIEW, and no threshold
// fixes that: raising the bar to three shared words kills every good match too. So this stops
// choosing. It ranks, honestly and deterministically, and hands the choice to something that can
// read a sentence — the /match skill.
//
// What it does NOT hand over is the ability to invent. The skill may only pick from this list,
// and proposalFrom() refuses anything that is not on it. Rule 3 survives having a model in the
// loop precisely because the closed world is built here, before any judgment happens.
export const SHORTLIST_LIMIT = 3

export function shortlist(task, catalogue, index, limit = SHORTLIST_LIMIT) {
  const candidates = []
  for (const item of catalogue ?? []) {
    // Team-maintenance tooling is never an answer to where the owner's week goes.
    if (!proposable(item)) continue
    const measured = measureMatch(task, item, index)
    if (measured.shared < MIN_SHARED_WORDS) continue
    // A positive score as well as the count: if every shared word is one that literally every
    // item uses, the words agree on nothing that distinguishes anything.
    if (measured.score <= 0) continue
    candidates.push({
      id: item.id,
      name: item.name,
      kind: item.kind,
      path: item.path,
      description: item.description,
      score: measured.score,
      shared: measured.shared,
      words: measured.words
    })
  }
  // Ties break on the catalogue's own order, which is alphabetical by kind then slug. Arbitrary,
  // but fixed — so the same week never produces two different shortlists on two different days.
  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return candidates.slice(0, limit)
}

// A task can miss the two-word bar and still have one strong, obvious near-neighbour: "Posting
// on LinkedIn" shares only `post` with the agent whose description opens "Writes posts". One word
// is not enough to PROPOSE on - the same shape gave "approving holiday requests" to the security
// agent on `approv`, at maximum rarity - but it is worth asking about.
//
// So the near miss goes into the question, not into a proposal. The owner is the one who can say
// in a second whether that is what they meant, and asking them costs nothing. Guessing does not.
export const NEAR_MISS_RATIO = 0.55

export function nearMiss(task, catalogue, index) {
  if (!index?.items) return null
  const ceiling = Math.log(index.items + 1)
  let best = null
  for (const item of catalogue ?? []) {
    if (!proposable(item)) continue
    const measured = measureMatch(task, item, index)
    if (measured.shared !== 1) continue
    if (measured.score / ceiling < NEAR_MISS_RATIO) continue
    if (!best || measured.score > best.score) best = { item, ...measured }
  }
  return best
}

function gapFor(task, catalogue, index) {
  const near = nearMiss(task, catalogue, index)
  if (!near) {
    return {
      question: `Nothing on the team does this yet — what would have to exist to take "${task.task}" off your week?`
    }
  }
  return {
    nearest: near.item.id,
    sharedWord: near.words[0],
    question: `Nothing on the team clearly does this. The closest is ${near.item.id}, and the only word you share with it is "${near.words[0]}" — is that the same job, or is "${task.task}" something the team cannot do yet?`
  }
}

// Builds the cited proposal once something has chosen. The chooser may be the /match skill or a
// person; either way this is the only door, and it refuses anything not on the shortlist.
export function proposalFrom(entry, itemId) {
  const candidate = (entry?.candidates ?? []).find((option) => option.id === itemId)
  if (!candidate) {
    return {
      proposal: null,
      problems: [
        `${entry?.task ?? 'a task'} cannot be answered with ${itemId} — it is not on the shortlist, and only what the catalogue offered may be proposed`
      ]
    }
  }

  const proposal = {
    task: entry.task,
    item: candidate.id,
    itemName: candidate.name,
    itemKind: candidate.kind,
    itemPath: candidate.path,
    score: candidate.score,
    sharedWords: candidate.words,
    // Rule 6. The saving is written down as a prediction now so the weekly tune-up can check it
    // against what actually ran, instead of the claim standing unexamined forever.
    predicted: entry.predicted,
    citations: {
      words: textOf(entry.words),
      number: numberCitation(entry.predicted),
      item: candidate.id
    }
  }

  // Rule 2, at the only place that matters: the exit. A proposal that cannot cite all three
  // things never leaves this function, no matter who chose it or how good the match looked.
  const problems = validateProposal(proposal)
  return problems.length > 0 ? { proposal: null, problems } : { proposal, problems: [] }
}

export function match(ledger, catalogue) {
  const result = { shortlists: [], gaps: [], notes: [], parked: [], problems: [] }

  // Rule 1. The ledger comes first. If the numbers are not yet sound there is nothing honest to
  // derive from them, and proposing anyway would hand someone a team built on a typo.
  const problems = validateLedger(ledger)
  if (problems.length > 0) {
    result.problems = problems
    return result
  }

  // Rule 3's closed world is only as closed as the catalogue it is handed. A catalogue with a
  // duplicated id or an item nothing can cite is not a world worth deriving from, so it refuses
  // here for the same reason a bad ledger does — before anything is proposed off it.
  if (!Array.isArray(catalogue)) {
    result.problems = ['the catalogue must be a list of items read from the repo']
    return result
  }
  const catalogueProblems = validateCatalogue(catalogue)
  if (catalogueProblems.length > 0) {
    result.problems = catalogueProblems
    return result
  }

  const index = buildIndex(catalogue)

  const hourlyValue = ledger?.hourly_value

  for (const task of ledger?.tasks ?? []) {
    const kind = classify(task)

    // Rule 4. Said once is a note. We write it down and wait to hear it again.
    if (kind === 'note') {
      result.notes.push({ task: task.task, words: task.words })
      continue
    }

    // Rule 5. If nobody can say who acts on the output, automating it produces work that runs
    // and nobody adopts. Parked, with the question that would unpark it.
    if (kind === 'parked') {
      result.parked.push({
        task: task.task,
        words: task.words,
        reason: 'nobody has said who acts on this when it produces a draft, or what would stop them'
      })
      continue
    }

    const candidates = shortlist(task, catalogue, index)

    // Rule 3. Nothing in the catalogue does this. That is a question for the owner, not licence
    // to invent a capability and describe it confidently.
    if (candidates.length === 0) {
      result.gaps.push({ task: task.task, words: task.words, ...gapFor(task, catalogue, index) })
      continue
    }

    result.shortlists.push({
      task: task.task,
      words: task.words,
      predicted: deriveTask(task, hourlyValue),
      candidates
    })
  }

  return result
}
