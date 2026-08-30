import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fromRoot, read, exists } from './helpers/repo.mjs'
import { loadWorkflows, normaliseSteps } from '../scripts/lib/workflows.mjs'
import { validateRunLog, QUALITY_VERDICTS } from '../scripts/lib/run-log.mjs'

const fixture = async (name) => JSON.parse(await readFile(fromRoot('tests/fixtures/runs', name), 'utf8'))
const graded = async (quality) => {
  const entry = await fixture('valid-schedule.json')
  return { ...entry, quality }
}
const problemsFor = async (quality) => {
  const entry = await graded(quality)
  return validateRunLog(entry, { filename: `${entry.run_id}.json` })
}

const VALID_QUALITY = { rubric: 'content', score: 11, total: 12, verdict: 'passed', retried: false }

// --- the grade is recorded, or the weekly review counts nothing -----------------------

test('a run log may carry a quality block, and a well-formed one validates', async () => {
  assert.deepEqual(await problemsFor(VALID_QUALITY), [])
})

test('a run log with no quality block is still valid - not every job is graded', async () => {
  const entry = await fixture('valid-schedule.json')
  assert.deepEqual(validateRunLog(entry, { filename: `${entry.run_id}.json` }), [])
})

test('a score above its total is rejected', async () => {
  const problems = await problemsFor({ ...VALID_QUALITY, score: 13 })
  assert.ok(problems.some((problem) => /cannot exceed/i.test(problem)), problems.join('; '))
})

test('an invented verdict is rejected, so passed and flagged stay the only two', async () => {
  const problems = await problemsFor({ ...VALID_QUALITY, verdict: 'excellent' })
  assert.ok(problems.some((problem) => /verdict/i.test(problem)), problems.join('; '))
  assert.deepEqual(QUALITY_VERDICTS, ['passed', 'flagged'])
})

test('the rubric that was marked against must be named', async () => {
  const problems = await problemsFor({ ...VALID_QUALITY, rubric: '' })
  assert.ok(problems.some((problem) => /rubric/i.test(problem)), problems.join('; '))
})

test('whether the piece was sent back once has to be recorded', async () => {
  const problems = await problemsFor({ ...VALID_QUALITY, retried: 'yes' })
  assert.ok(problems.some((problem) => /retried/i.test(problem)), problems.join('; '))
})

// --- grading is wired into the work, not an optional extra ---------------------------

test('the draft queue ends in a grading step - writing is never the last word', async () => {
  const workflows = await loadWorkflows()
  const draftQueue = workflows.find((workflow) => workflow.slug === 'draft-queue')
  assert.ok(draftQueue, 'workflows/draft-queue.yml is missing')
  const steps = normaliseSteps(draftQueue.data.steps)
  assert.equal(steps.at(-1), 'review-draft', 'the grader must be the closing step')
})

test('every workflow that gets graded declares what good looks like', async () => {
  for (const workflow of await loadWorkflows()) {
    const steps = normaliseSteps(workflow.data.steps) ?? []
    if (!steps.includes('review-draft')) continue
    const done = workflow.data.done
    assert.ok(done, `${workflow.slug} is graded but has no done block to grade against`)
    assert.equal(typeof done.looks_like, 'string', `${workflow.slug}: done.looks_like must be a sentence`)
    assert.ok(Array.isArray(done.must_have) && done.must_have.length, `${workflow.slug}: done.must_have is empty`)
    assert.ok(Array.isArray(done.never) && done.never.length, `${workflow.slug}: done.never is empty`)
  }
})

test('the editor owns the weekly quality review', async () => {
  const workflows = await loadWorkflows()
  const review = workflows.find((workflow) => workflow.slug === 'quality-review')
  assert.ok(review, 'workflows/quality-review.yml is missing')
  assert.equal(review.data.owner, 'editor')
})

// --- the rules the whole thing rests on ----------------------------------------------

test('the content rubric is scored and has a stated threshold', async () => {
  const rubric = await read('shared/standards/rubrics/content.md')
  assert.match(rubric, /threshold/i, 'a rubric with no threshold cannot fail anything')
  assert.match(rubric, /no half marks/i, 'half marks are how a grader talks itself into passing')
  assert.match(rubric, /automatic fail/i, "the owner's never list must outrank the score")
})

test('failure is retry once, then flag - never a silent bin', async () => {
  const standard = await read('shared/standards/definition-of-done.md')
  assert.match(standard, /retry once, then flag/i)
  const skill = await read('.claude/skills/review-draft/SKILL.md')
  assert.match(skill, /still lands/i, 'a flagged piece must still reach the owner')
  assert.match(skill, /never bin/i)
})

test('the report card format is one format, used by every team', async () => {
  const standard = await read('shared/standards/definition-of-done.md')
  for (const field of ['Made:', 'Quality:', 'Confidence:', 'Sources:', 'Needs you:']) {
    assert.match(standard, new RegExp(`\\*\\*${field}\\*\\*`), `report card is missing ${field}`)
  }
})

test('verdicts have somewhere to live and three possible values', async () => {
  assert.ok(await exists('quality/verdicts'), 'quality/verdicts is missing')
  const doc = await read('quality/README.md')
  for (const verdict of ['shipped', 'edited', 'rejected']) {
    assert.match(doc, new RegExp(`\`${verdict}\``), `quality/README.md never defines ${verdict}`)
  }
})

test('a captured verdict must change a file, or the loop never closes', async () => {
  const skill = await read('.claude/skills/capture-verdict/SKILL.md')
  assert.match(skill, /shared\/writing-rules\.md/)
  assert.match(skill, /diary entry/i, 'the skill must say why an unwritten rule is worthless')
})

test('the weekly review reports acceptance, and says when it has too little to go on', async () => {
  const skill = await read('.claude/skills/write-quality-review/SKILL.md')
  assert.match(skill, /acceptance rate/i)
  assert.match(skill, /unreviewed/i, 'ungraded outputs must not be silently treated as accepted')
})

test('a specialist never grades its own work', async () => {
  const routing = await read('.claude/rules/routing.md')
  assert.match(routing, /never let a specialist grade its own work/i)
  const skill = await read('.claude/skills/review-draft/SKILL.md')
  assert.match(skill, /editor/, 'the grading step must delegate to the editor')
})

/* ---------- the verdict was the one artifact with no checker -------------------------------

   runs/ has validate:runs, ledger.yml has check:ledger, proposals.yml has check:proposals,
   workflows/ has check:arming. quality/verdicts/ had nothing - and it is the file the entire
   improvement stage is computed from.

   The failure is not that a bad verdict is counted badly. It is that it is not counted at all:
   an unrecognised value leaves BOTH halves of shipped/(shipped+edited+rejected), so dropping a
   rejection RAISES the acceptance rate. The lesson taught that as the design - "anything else
   cannot be counted, so the review silently drops it". */

const verdictFile = (over = {}) => ({
  path: 'quality/verdicts/2026-08-30-a-piece.md',
  source: [
    '---',
    `run_id: ${over.run_id ?? '2026-08-30T0546Z-content'}`,
    `artifact: ${over.artifact ?? 'agents/content/output/a-piece.md'}`,
    `rubric: ${over.rubric ?? 'content'}`,
    `verdict: ${over.verdict ?? 'edited'}`,
    ...(over.graded === null ? [] : [`graded: ${over.graded ?? '11/12'}`]),
    '---',
    '',
    '# A piece',
    '',
    '## What changed',
    'Opening was X. Replaced with Y.',
    ...(over.rule === null ? [] : ['', '## The rule this becomes', 'Open on something that happened to me.'])
  ].join('\n')
})

const KNOWN = {
  runIds: ['2026-08-30T0546Z-content'],
  artifacts: ['agents/content/output/a-piece.md'],
  rubrics: ['content']
}

test('a well-formed verdict passes', async () => {
  const { validateVerdict } = await import('../scripts/lib/verdicts.mjs')
  assert.deepEqual(validateVerdict(verdictFile(), KNOWN), [])
})

test('a verdict value outside the three is refused, not dropped', async () => {
  const { validateVerdict } = await import('../scripts/lib/verdicts.mjs')
  const problems = validateVerdict(verdictFile({ verdict: 'partial' }), KNOWN)
  assert.equal(problems.length, 1, problems.join('\n'))
  assert.match(problems[0], /not one of shipped, edited, rejected/)
})

test('a verdict about a piece that does not exist is refused', async () => {
  const { validateVerdict } = await import('../scripts/lib/verdicts.mjs')
  const problems = validateVerdict(verdictFile({ artifact: 'agents/content/output/never-written.md' }), KNOWN)
  assert.match(problems.join('\n'), /which is not in this repo/)
})

test('a verdict citing a run that never happened is refused', async () => {
  const { validateVerdict } = await import('../scripts/lib/verdicts.mjs')
  assert.match(
    validateVerdict(verdictFile({ run_id: '2026-08-30T9999Z-does-not-exist' }), KNOWN).join('\n'),
    /which has no run log/
  )
})

test('a score cannot beat its own total - the same rule run logs already enforce', async () => {
  const { validateVerdict } = await import('../scripts/lib/verdicts.mjs')
  assert.match(validateVerdict(verdictFile({ graded: '47/12' }), KNOWN).join('\n'), /cannot beat its own total/)
})

test('an ungraded piece is fine - review-draft does not run on every output', async () => {
  // Marcus's content run was invoked directly and carries no quality block, so there is no
  // score to cite. Demanding one would make the common case unfileable.
  const { validateVerdict } = await import('../scripts/lib/verdicts.mjs')
  assert.deepEqual(validateVerdict(verdictFile({ graded: null }), KNOWN), [])
  assert.deepEqual(validateVerdict(verdictFile({ graded: 'none - review-draft did not run' }), KNOWN), [])
})

test('a verdict with no rule is a diary entry and is refused', async () => {
  const { validateVerdict } = await import('../scripts/lib/verdicts.mjs')
  assert.match(validateVerdict(verdictFile({ rule: null }), KNOWN).join('\n'), /diary entry/)
})

test('an unknown list is skipped, not failed - absence is not evidence', async () => {
  // Called with no `known` at all, the cross-checks have nothing to compare against. A caller
  // without a list must not turn every verdict into a problem.
  const { validateVerdict } = await import('../scripts/lib/verdicts.mjs')
  assert.deepEqual(validateVerdict(verdictFile({ artifact: 'anything/at/all.md', rubric: 'whatever' })), [])
})

test('a dropped verdict raises the acceptance rate, which is why it must be counted', async () => {
  const { acceptance } = await import('../scripts/lib/verdicts.mjs')
  const week = [
    verdictFile({ verdict: 'shipped' }),
    verdictFile({ verdict: 'rejected' }),
    verdictFile({ verdict: 'rejected' })
  ]
  assert.equal(acceptance(week).rate, 1 / 3)

  // The same week with one rejection mistyped. Silently dropping it does not report a worse
  // week - it reports a better one.
  const mistyped = [week[0], week[1], verdictFile({ verdict: 'binned' })]
  const got = acceptance(mistyped)
  assert.equal(got.rate, 1 / 2, 'a dropped rejection moves the rate from 33% to 50%')
  assert.equal(got.uncountable, 1, 'and the only thing that makes it visible is counting it apart')
})
