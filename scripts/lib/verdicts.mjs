import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseFrontmatter } from './frontmatter.mjs'

// A verdict is the owner saying what they did with a piece the team made. It is the only file in
// this repo written BY the owner ABOUT the team, and the whole improvement stage is built on it:
// acceptance rate is shipped / (shipped + edited + rejected), and every rule the team learns
// starts life in one of these files.
//
// It was also the only artifact in the repo with no checker. runs/ has validate:runs, ledger.yml
// has check:ledger, proposals.yml has check:proposals, workflows/ has check:arming. A verdict
// naming a run that never happened, an artifact that was never written, and a verdict value that
// is not one of the three passed every one of them - and the lesson taught the consequence as if
// it were the design: "anything else cannot be counted, so the review silently drops it."
//
// Silently dropping a verdict does not lower the acceptance rate. It removes the piece from both
// halves of the fraction, so a week where the owner rejected everything can report a clean 100%.

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const VERDICT_DIR = 'quality/verdicts'

export const VERDICTS = ['shipped', 'edited', 'rejected']

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

// `graded` is optional and deliberately so. A piece only carries a score when review-draft ran on
// it, and plenty of real work is produced by an agent invoked directly. What it may not be is a
// score that beats its own total - the same rule run logs already enforce on their quality block.
export function parseGrade(value) {
  const text = textOf(value)
  if (text === '') return { absent: true }
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(text)
  if (!match) return { absent: false, ungraded: true, text }
  return { absent: false, score: Number(match[1]), total: Number(match[2]) }
}

// Returns human-readable problems, the same contract as validateLedger, validateWorkflow and
// validateArming. Empty means the verdict is backed by things that exist.
//
// `known` is injected rather than read from disk so this stays pure and testable: `runIds` and
// `artifacts` are the ones the repo actually has, `rubrics` the ones it ships. Omit any of them
// and that cross-check is skipped rather than failed - a caller with no list is not evidence that
// the thing does not exist.
export function validateVerdict(file, known = {}) {
  const problems = []
  const name = file?.path || file?.slug || 'a verdict'
  const at = (problem) => problems.push(`${name}: ${problem}`)

  const { data, body } = parseFrontmatter(String(file?.source ?? ''))

  const verdict = textOf(data.verdict)
  if (verdict === '') {
    at('has no `verdict:` - it has to say what you did with the piece')
  } else if (!VERDICTS.includes(verdict)) {
    at(`says \`verdict: ${verdict}\`, which is not one of ${VERDICTS.join(', ')} - the review counts the three and would drop this one silently`)
  }

  const artifact = textOf(data.artifact)
  if (artifact === '') {
    at('names no `artifact:` - a verdict has to be about a specific piece')
  } else if (Array.isArray(known.artifacts) && !known.artifacts.includes(artifact)) {
    at(`is about \`${artifact}\`, which is not in this repo - a verdict on a piece nobody can open cannot be checked by anyone`)
  }

  const runId = textOf(data.run_id)
  if (runId !== '' && Array.isArray(known.runIds) && !known.runIds.includes(runId)) {
    at(`cites run \`${runId}\`, which has no run log - the piece and the run that made it have to agree`)
  }

  const rubric = textOf(data.rubric)
  if (rubric !== '' && Array.isArray(known.rubrics) && !known.rubrics.includes(rubric)) {
    at(`marks itself against rubric \`${rubric}\`, which does not exist - the rubrics here are ${known.rubrics.join(', ') || '(none)'}`)
  }

  const grade = parseGrade(data.graded)
  if (!grade.absent && !grade.ungraded && grade.score > grade.total) {
    at(`is graded ${grade.score}/${grade.total} - a score cannot beat its own total`)
  }

  // The loop closes when a correction becomes a rule. A verdict with no rule section is the diary
  // entry the capture-verdict skill exists to stop somebody writing.
  if (!/^##\s+The rule this becomes\s*$/m.test(body)) {
    at('has no "## The rule this becomes" section - a verdict that does not become a rule is a diary entry')
  }

  return problems
}

async function listIfPresent(root, relative) {
  try {
    return await readdir(path.join(root, relative))
  } catch {
    return []
  }
}

export async function loadVerdicts(root = repoRoot) {
  const files = []
  for (const entry of (await listIfPresent(root, VERDICT_DIR)).filter((f) => f.endsWith('.md')).sort()) {
    const relative = path.posix.join(VERDICT_DIR, entry)
    files.push({
      slug: entry.slice(0, -3),
      path: relative,
      source: await readFile(path.join(root, relative), 'utf8')
    })
  }
  return files
}

// shipped / (shipped + edited + rejected), plus the thing the fraction cannot show: how many
// verdicts were written that no bucket could hold. A rate printed without that count is the
// silent-drop bug with a percentage sign on it.
export function acceptance(files) {
  const counts = { shipped: 0, edited: 0, rejected: 0, uncountable: 0 }
  for (const file of files ?? []) {
    const { data } = parseFrontmatter(String(file?.source ?? ''))
    const verdict = textOf(data.verdict)
    if (VERDICTS.includes(verdict)) counts[verdict] += 1
    else counts.uncountable += 1
  }
  const counted = counts.shipped + counts.edited + counts.rejected
  return { ...counts, counted, rate: counted === 0 ? null : counts.shipped / counted }
}
