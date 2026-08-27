import { classify, deriveTask, validateLedger, isUnfilled } from './ledger.mjs'
import { describable } from './catalogue.mjs'

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

// A proposal has to clear this to be counted a real match rather than two words coinciding.
// Two shared meaningful words is the floor; one is usually an accident of English.
export const MATCH_FLOOR = 2

// Filler carries no meaning and would otherwise let any task match any item. Kept deliberately
// short and boring: this is not a stemmer, and it does not need to be.
const FILLER = new Set([
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

// Crude singularisation only. "invoices" and "invoice" are the same word to an owner reading
// their own ledger, and pretending otherwise would lose real matches for no gain.
function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 3 && word.endsWith('es') && !word.endsWith('ses')) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

function meaningfulWords(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !FILLER.has(word))
    .map(stem)
  return new Set(words)
}

// The score is how many meaningful words the owner's description of the task shares with the
// item's own description of itself. Both texts were written for humans, by different people, at
// different times — which is exactly why agreement between them means something.
export function scoreMatch(task, item) {
  if (!describable(item)) return 0
  const theirs = meaningfulWords(`${task?.task ?? ''} ${task?.words ?? ''}`)
  const its = meaningfulWords(`${item?.name ?? ''} ${item?.description ?? ''}`)
  let shared = 0
  for (const word of theirs) if (its.has(word)) shared += 1
  return shared
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

  return problems
}

function numberCitation({ hoursPerWeek, costPerWeek }) {
  const hours = Math.round(hoursPerWeek * 10) / 10
  const time = `${hours} hours a week`
  return costPerWeek === null ? time : `${time}, ${Math.round(costPerWeek)} a week`
}

// Ties break on the catalogue's own order, which is alphabetical by kind then slug. Arbitrary,
// but fixed — so the same week never produces two different teams on two different days.
function bestMatch(task, catalogue) {
  let best = null
  let bestScore = 0
  for (const item of catalogue ?? []) {
    const score = scoreMatch(task, item)
    if (score > bestScore) {
      best = item
      bestScore = score
    }
  }
  return bestScore >= MATCH_FLOOR ? { item: best, score: bestScore } : null
}

export function match(ledger, catalogue) {
  const result = { proposals: [], gaps: [], notes: [], parked: [], refused: [], problems: [] }

  // Rule 1. The ledger comes first. If the numbers are not yet sound there is nothing honest to
  // derive from them, and proposing anyway would hand someone a team built on a typo.
  const problems = validateLedger(ledger)
  if (problems.length > 0) {
    result.problems = problems
    return result
  }

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

    const found = bestMatch(task, catalogue)

    // Rule 3. Nothing in the catalogue does this. That is a question for the owner, not licence
    // to invent a capability and describe it confidently.
    if (!found) {
      result.gaps.push({
        task: task.task,
        words: task.words,
        question: `Nothing on the team does this yet — what would have to exist to take "${task.task}" off your week?`
      })
      continue
    }

    const predicted = deriveTask(task, hourlyValue)
    const proposal = {
      task: task.task,
      item: found.item.id,
      itemName: found.item.name,
      itemKind: found.item.kind,
      itemPath: found.item.path,
      score: found.score,
      // Rule 6. The saving is written down as a prediction now so the weekly tune-up can check it
      // against what actually ran, instead of the claim standing unexamined forever.
      predicted,
      citations: {
        words: textOf(task.words),
        number: numberCitation(predicted),
        item: found.item.id
      }
    }

    // Rule 2, at the only place that matters: the exit. A proposal that cannot cite all three
    // things never leaves this function, no matter how good the match looked.
    const refusals = validateProposal(proposal)
    if (refusals.length > 0) {
      result.refused.push({ task: task.task, reasons: refusals })
      continue
    }

    result.proposals.push(proposal)
  }

  return result
}
