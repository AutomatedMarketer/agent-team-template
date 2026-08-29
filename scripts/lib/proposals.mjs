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

// Short enough to write honestly, long enough that a tautology does not fit.
export const MIN_REASON_LENGTH = 25

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

  // `gaps:` with nothing under it is the natural way to write "I declined nothing", and it parses
  // to an empty string rather than a list. Guarded like `proposals:` because a Node stack trace is
  // not a validation message, and the person who sees it wrote a reasonable file.
  const gapRows = written?.gaps === undefined || written?.gaps === '' || written?.gaps === null
    ? []
    : (Array.isArray(written.gaps) ? written.gaps : null)
  if (!gapRows) {
    problems.push('`gaps:` must be a list, or left out entirely')
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

    // Every choice needs its reason, including a choice between one candidate and nothing.
    //
    // This used to be required only when there were two or more candidates, which sounded right
    // and was measurably wrong: on a sweep of real tasks, most shortlists had exactly one entry,
    // so the reason was almost never demanded and the judgment step was inert on the majority of
    // the file. A sole candidate still has to be read and still has to be right; "it was the only
    // one" is a fact about the engine, not a reason to hand somebody a worker.
    const why = textOf(row.why)
    if (!why) {
      at(
        entry.candidates.length > 1
          ? `was chosen from ${entry.candidates.length} candidates with no reason given — say why this one and not the others`
          : 'was the only candidate, which is not a reason — say why it actually does this job'
      )
    } else if (why.length < MIN_REASON_LENGTH) {
      // "It chases." and "It handles email." both cleared a presence check. Under twenty
      // shortlists a model will write thin reasons and nothing catches it, which makes the whole
      // judgment step a rubber stamp with a citation attached.
      at(`gives "${why}" as the reason, which is a restatement rather than a reason — say what it does that answers this task`)
    } else if (entry.candidates.length > 1) {
      // Where something was rejected, name it. A reason that never mentions the alternative is a
      // reason that did not consider it.
      const rejected = entry.candidates.filter((candidate) => candidate.id !== textOf(row.item))
      const mentionsOne = rejected.some((candidate) => {
        const haystack = why.toLowerCase()
        return haystack.includes(candidate.id.toLowerCase()) ||
          haystack.includes(candidate.slug?.toLowerCase() ?? '\u0000') ||
          haystack.includes(candidate.name.toLowerCase())
      })
      if (!mentionsOne) {
        at(`was chosen over ${rejected.length} other candidate(s) without naming any of them — say which you rejected and why`)
      }

    }

    // A reason may not name something that was never on the table.
    //
    // `rejected.some(...)` above is satisfied by naming ONE of N, and nothing checked that a
    // named item was ever offered. A walkthrough shipped a committed proposal citing
    // "Rejected agent:sales" for a task where agent:sales was not a candidate in that repo -
    // the shortlist had been computed somewhere else - and this file passed it. That is the
    // one thing the engine is supposed to make impossible: the reason cannot invent.
    const offered = new Set([textOf(row.item), ...entry.candidates.map((candidate) => candidate.id)])
    const named = [...String(row.why ?? '').matchAll(/\b(?:agent|skill|workflow):[a-z0-9-]+/g)]
      .map((found) => found[0])
    for (const mention of new Set(named)) {
      if (!offered.has(mention)) {
        at(`names ${mention} in its reason, which was never offered for this task — the candidates were ${[...offered].join(', ')}`)
      }
    }
  }

  // DECLINING. The engine shortlists anything sharing a word, so most shortlists contain things
  // that do not do the job. Refusing all of them is the correct answer often enough that it has to
  // be first class — and for a while it was not: the skill and the lesson both told the reader to
  // move a shortlisted task to gaps, and doing so produced an error with no way out.
  //
  // It was then checked in exactly ONE direction: you could not silently skip a shortlist. Every
  // other way of writing a wrong gap sailed through, and the results contradicted themselves in
  // the same printout — one run proposed "Chasing invoices" and, four lines lower, listed it under
  // "things nothing on the team does yet". The gaps list is the specification for what gets built
  // next, so it gets the same scrutiny the proposals do.
  const declinedTasks = new Set()

  for (const [index, gap] of gapRows.entries()) {
    const name = textOf(gap?.task) || `gap ${index + 1}`
    const at = (problem) => problems.push(`${name}: ${problem}`)

    if (!textOf(gap?.question)) {
      at('is carried as a gap with no reason — say what was offered and why none of it fits')
    }

    if (declinedTasks.has(textOf(gap?.task))) {
      at('is carried as a gap twice — one task, one entry')
      continue
    }
    declinedTasks.add(textOf(gap?.task))

    // The same task cannot be both switched on and declared impossible. Its hours were counted in
    // the total AND it was printed as something nothing does.
    if (answered.has(textOf(gap?.task))) {
      at('is both proposed and declined — it cannot be switched on and reported as impossible in the same file')
      continue
    }

    const task = (ledger.tasks ?? []).find((entry) => textOf(entry.task) === textOf(gap?.task))
    if (!task) {
      at('is not in the ledger — a gap is a thing the owner said they do, not a thing somebody thought of')
      continue
    }

    // Rules 4 and 5 apply here too. A note was named once and a parked task has nobody to act on
    // it; putting either in the gaps list promotes it into the build specification on the quiet.
    const kind = classify(task)
    if (kind !== 'candidate') {
      at(
        kind === 'note'
          ? 'was only mentioned once, so it is a note — carrying it as a gap puts it in the build list without it ever being a pattern'
          : 'has nobody named to act on its output, so it is parked — carrying it as a gap skips the decision-readiness check'
      )
    }
  }

  // Nothing may be quietly dropped: every shortlisted task is either proposed on or declined.
  for (const entry of derived.shortlists) {
    if (answered.has(entry.task) || declinedTasks.has(entry.task)) continue
    problems.push(
      `${entry.task}: proposals.yml says nothing about it — either propose one of the ${entry.candidates.length} candidate(s), or decline them all by carrying it as a gap`
    )
  }

  for (const gap of derived.gaps) {
    if (!declinedTasks.has(gap.task)) {
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
  // Counted from what was WRITTEN, not from what the engine derived. Most gaps now arrive as a
  // decline - the engine offered candidates and the skill refused all of them - so counting
  // derived gaps alone reported zero while the file plainly carried two.
  return {
    proposed: rows.length,
    gaps: (written?.gaps ?? []).length,
    notes: derived.notes.length,
    parked: derived.parked.length,
    hoursPerWeek,
    costPerWeek: priced ? hoursPerWeek * hourlyValue : null,
    unpriced: !priced
  }
}
