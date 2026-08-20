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
