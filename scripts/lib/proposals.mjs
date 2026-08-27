import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseSimpleYaml } from './yaml-lite.mjs'
import { validateLedger, classify, deriveTask } from './ledger.mjs'
import { validateCatalogue } from './catalogue.mjs'
import { match, proposalFrom, validateProposal } from './match.mjs'

// proposals.yml is the one file in this repo written by a model rather than by a person or by
// code. The /match skill reads the shortlists the engine produced, reads the sentences, and
// chooses. That judgment is the reason it exists — word-counting cannot tell a customer's REVIEW
// from the sales pipeline REVIEW.
//
// Which means this file is the check on that judgment. Everything the skill claims gets re-derived
// from ledger.yml and the catalogue and compared. It cannot quietly widen its own remit:
//
//   - it may only answer a task that is a CANDIDATE in the ledger
//   - it may only choose from the shortlist the engine actually produced for that task
//   - the quote must be the owner's words, character for character
//   - the number must be the number the ledger derives, not one the model liked better
//
// The ledger has check:ledger for the same reason: a file that decides everything downstream is
// worth being able to check in one command, on Windows, without a nested-quote incantation.

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const PROPOSALS = 'proposals.yml'

export async function loadProposals(root = repoRoot) {
  return parseSimpleYaml(await readFile(path.join(root, PROPOSALS), 'utf8'))
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

// A written row carries its citations as three flat fields. The item is its own citation, which
// is why there are three names here and only two extra keys in the file.
export function citationsOf(row) {
  return {
    words: textOf(row?.words),
    number: textOf(row?.number),
    item: textOf(row?.item)
  }
}

// Returns human-readable problems, the same contract as validateLedger and validateCatalogue.
// Empty means every row in proposals.yml is backed by the ledger and the catalogue.
export function validateProposals(written, ledger, catalogue) {
  const problems = []

  const ledgerProblems = validateLedger(ledger)
  if (ledgerProblems.length > 0) {
    return ['the ledger itself is not sound yet, so nothing derived from it can be checked:', ...ledgerProblems]
  }

  const catalogueProblems = validateCatalogue(catalogue)
  if (catalogueProblems.length > 0) {
    return ['the catalogue is not sound yet:', ...catalogueProblems]
  }

  const derived = match(ledger, catalogue)
  const shortlistFor = new Map(derived.shortlists.map((entry) => [entry.task, entry]))
  const gapTasks = new Set(derived.gaps.map((gap) => gap.task))

  const rows = Array.isArray(written?.proposals) ? written.proposals : null
  if (!rows) {
    problems.push('proposals.yml needs a `proposals:` list, even if it is empty')
    return problems
  }

  const answered = new Set()

  for (const [index, row] of rows.entries()) {
    const name = textOf(row?.task) || `proposal ${index + 1}`
    const at = (problem) => problems.push(`${name}: ${problem}`)

    const task = (ledger.tasks ?? []).find((entry) => textOf(entry.task) === textOf(row?.task))
    if (!task) {
      at('names a task that is not in the ledger — a proposal has to answer something the owner actually said')
      continue
    }

    // Rules 4 and 5. Notes and parked tasks were held back for a reason; a proposal for one of
    // them is the model deciding that reason did not apply to it.
    const kind = classify(task)
    if (kind !== 'candidate') {
      at(
        kind === 'note'
          ? 'was only mentioned once, so it is a note — proposing on it skips the rule that a pattern is named twice'
          : 'has nobody named to act on its output, so it is parked — proposing on it skips the decision-readiness check'
      )
      continue
    }

    if (answered.has(textOf(row.task))) {
      at('is answered twice — one task, one proposal')
      continue
    }
    answered.add(textOf(row.task))

    const entry = shortlistFor.get(textOf(row.task))
    if (!entry) {
      at('has no shortlist — the engine found nothing in the catalogue for it, so it is a gap, not a proposal')
      continue
    }

    // Rule 3, checked rather than trusted. proposalFrom refuses anything off the shortlist, and
    // re-running it here means the written file has to agree with what the engine would allow.
    const { proposal, problems: refusals } = proposalFrom(entry, textOf(row.item))
    if (!proposal) {
      for (const refusal of refusals) problems.push(refusal)
      continue
    }

    // Rule 2, on the written citations rather than the derived ones. The skill can write anything
    // into this file; what it cannot do is write something that survives being compared.
    //
    // The three citations are flat fields rather than a nested block, because yaml-lite is
    // deliberately flat and its own comment says richer nesting means a config file is drifting
    // away from something a person can read at a glance. A side effect worth having: the item
    // and its citation are now the SAME field, so they cannot disagree by construction.
    const cited = citationsOf(row)
    if (textOf(cited.words) !== textOf(task.words)) {
      at('quotes something other than the owner\'s words — the quote is verbatim or it is not a quote')
    }
    if (textOf(cited.number) !== textOf(proposal.citations.number)) {
      at(`cites "${textOf(cited.number)}" but the ledger derives "${proposal.citations.number}"`)
    }

    for (const problem of validateProposal({ ...proposal, citations: cited })) problems.push(problem)

    // Rule 5 again, at the level of the written row: the skill has to say why this one and not
    // the other two it was offered. A shortlist of three answered without a reason is a coin flip
    // wearing a citation.
    if (entry.candidates.length > 1 && !textOf(row.why)) {
      at(`was chosen from ${entry.candidates.length} candidates with no reason given — say why this one and not the others`)
    }
  }

  // Nothing may be quietly dropped. A candidate the owner named twice, that the engine found
  // something for, has to appear either as a proposal or as a stated gap.
  for (const entry of derived.shortlists) {
    if (!answered.has(entry.task)) {
      problems.push(`${entry.task}: the engine shortlisted ${entry.candidates.length} option(s) for this and proposals.yml says nothing about it`)
    }
  }

  const writtenGaps = new Set((written?.gaps ?? []).map((gap) => textOf(gap?.task)))
  for (const gap of derived.gaps) {
    if (!writtenGaps.has(gap.task)) {
      problems.push(`${gap.task}: nothing in the catalogue does this, and proposals.yml does not carry it as a gap`)
    }
  }

  return problems
}

// The same numbers the check script prints back, so a caller can show the owner what they agreed
// to without re-deriving it themselves.
export function summarizeProposals(written, ledger, catalogue) {
  const derived = match(ledger, catalogue)
  const rows = Array.isArray(written?.proposals) ? written.proposals : []
  const hourlyValue = ledger?.hourly_value

  let hoursPerWeek = 0
  for (const row of rows) {
    const task = (ledger.tasks ?? []).find((entry) => textOf(entry.task) === textOf(row?.task))
    if (!task) continue
    const { hoursPerWeek: hours } = deriveTask(task, hourlyValue)
    if (Number.isFinite(hours)) hoursPerWeek += hours
  }

  const priced = typeof hourlyValue === 'number' && Number.isFinite(hourlyValue) && hourlyValue > 0
  return {
    proposed: rows.length,
    gaps: derived.gaps.length,
    notes: derived.notes.length,
    parked: derived.parked.length,
    hoursPerWeek,
    costPerWeek: priced ? hoursPerWeek * hourlyValue : null,
    unpriced: !priced
  }
}
