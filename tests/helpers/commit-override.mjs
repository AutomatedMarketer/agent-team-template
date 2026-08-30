// Every prompt file that tells an agent to commit must also say what to do when the person
// said not to. Two things this checker is and is not:
//
//   It IS a guard against drift — a new skill written months from now that mandates a commit
//   in fresh wording, or an edit that quietly drops the override from a file that had one.
//   That is the real risk, and it is what the inventory below pins.
//
//   It is NOT proof against someone deliberately writing text that means the opposite. Anyone
//   editing these files already controls the repo. Regexes cannot settle meaning, so the rules
//   below catch the shapes an inverted instruction actually takes, not every possible one.

// Uses of the word that are not instructions — a commit as a noun, not a thing to do.
const NOT_A_MANDATE = [
  /commit\s+(?:date|list|message|hash|sha|id)/gi,
  /committed\s+secrets?/gi,
  /merge\s+commits?/gi,
  /commits?\s+(?:behind|ahead)/gi,
  /never\s+committed/gi,
  /is\s+never\s+commit(?:ted)?/gi,
  // A warning never to commit something is not an instruction to commit.
  /(?:never|do not|don't)\s+commit\b/gi
]

function instructionalText(body) {
  return NOT_A_MANDATE.reduce((text, pattern) => text.replace(pattern, ''), body)
}

export function mandatesCommit(body) {
  return /\bcommit(?:s|ted|ting)?\b/i.test(instructionalText(body))
}

// An instruction that re-mandates the commit after conceding the override. These are shapes
// — "commit <anything> regardless", "ignore <anything> commit" — not fixed phrases.
export const INVERSIONS = [
  /\bcommit\b[^.]*?\b(?:regardless|anyway|no matter|whatever you|without exception|in every case)\b/i,
  /\b(?:disregard|ignore|override)\b[^.]*?\bcommit\b/i,
  /\bcommit(?:ting)?\b[^.]*?\b(?:is mandatory|is not optional|is required)\b/i,
  /\b(?:always|still)\s+commit\b/i,
  /\bnever\s+leave\b[^.]*?\buncommitted\b/i,
  /\bthe\s+commit\s+always\s+happens\b/i
]

export function commitOverrideProblems(body) {
  const problems = []
  if (!/(?:^|[.\n])\s*If (?:you were|the owner) told (?:you )?not to commit, do not commit/m.test(body)) {
    problems.push('no sentence-anchored "If you were told not to commit, do not commit"')
  }
  if (!/leave[^.]*?uncommitted/i.test(body)) {
    problems.push('does not name what to leave uncommitted')
  }
  for (const inversion of INVERSIONS) {
    if (inversion.test(body)) problems.push(`re-mandates the commit: ${inversion}`)
  }
  return problems
}
