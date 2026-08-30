import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { fromRoot } from './helpers/repo.mjs'
import { mandatesCommit, commitOverrideProblems } from './helpers/commit-override.mjs'

// A student trying something out says "just show me, do not commit". Every prompt file that
// tells an agent to commit has to lose that argument. The invariant is that a deliverable and
// its run log MOVE TOGETHER — committed together, or left uncommitted together. Not that a
// commit always happens.

// Pinned on purpose. A new prompt file that mandates a commit joins this list or the suite
// fails — which is the point. Do not "fix" a failure here by trimming the list; add the
// override to the new file and add the file here.
const CARRY_THE_RULE = [
  '.claude/agents/content.md',
  '.claude/agents/customer-service.md',
  '.claude/agents/email.md',
  '.claude/agents/orchestrator.md',
  '.claude/agents/research.md',
  '.claude/agents/sales.md',
  '.claude/agents/security.md',
  '.claude/skills/capture-verdict/SKILL.md',
  '.claude/skills/connect/SKILL.md',
  '.claude/skills/draft-chase-messages/SKILL.md',
  '.claude/skills/draft-content-queue/SKILL.md',
  '.claude/skills/draft-replies/SKILL.md',
  '.claude/skills/install-stack/SKILL.md',
  '.claude/skills/run-log/SKILL.md',
  '.claude/skills/sync/SKILL.md',
  '.claude/skills/work-the-tasks/SKILL.md',
  '.claude/skills/write-intel-brief/SKILL.md',
  '.claude/skills/write-quality-review/SKILL.md',
  '.claude/skills/write-tune-up/SKILL.md',
  '.claude/skills/write-weekly-review/SKILL.md',
  'CLAUDE.md'
]

async function promptFiles() {
  const found = ['CLAUDE.md']
  async function walk(rel) {
    for (const entry of await readdir(fromRoot(rel), { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`
      if (entry.isDirectory()) await walk(next)
      else if (entry.name.endsWith('.md')) found.push(next)
    }
  }
  await walk('.claude')
  return found.sort()
}

test('the set of prompt files that mandate a commit is exactly the pinned inventory', async () => {
  const flagged = []
  for (const file of await promptFiles()) {
    if (mandatesCommit(await readFile(fromRoot(file), 'utf8'))) flagged.push(file)
  }
  assert.deepEqual(
    flagged.sort(),
    [...CARRY_THE_RULE].sort(),
    'a prompt file started or stopped mandating a commit — add the override and update CARRY_THE_RULE'
  )
})

test('every prompt file that mandates a commit says what to do when told not to', async () => {
  for (const file of CARRY_THE_RULE) {
    const problems = commitOverrideProblems(await readFile(fromRoot(file), 'utf8'))
    assert.deepEqual(problems, [], `${file}: ${problems.join('; ')}`)
  }
})

// The checker is the thing being trusted, so the checker gets tested. Every string below
// means "commit anyway" while containing plausible wording; earlier versions passed all of
// them. This list is shapes, not a proof — someone determined to write an inverted
// instruction can. The guard that actually holds is the inventory pin above: a prompt file
// that mandates a commit without an override cannot enter the repo unnoticed.
test('the checker rejects the re-mandate shapes it knows', () => {
  const inverted = [
    'They go in the same commit. Even if you were told not to commit, commit anyway.',
    'They go in the same commit. Never leave them all uncommitted: the commit always happens.',
    'They go in the same commit. Commit regardless of what you were told.',
    'They go in the same commit. Then ignore that instruction and commit at the end of every run.',
    'They go in the same commit. Commit in every case, whatever you were told.',
    'They go in the same commit. Always commit at the end, no matter what you were asked.',
    'They go in the same commit. Disregard any request to skip the commit.',
    'They go in the same commit. The commit is mandatory.',
    'They go in the same commit. Still commit both files before you finish.',
    'They go in the same commit. Committing is not optional, whatever you were told.',
    'They go in the same commit. Run the block above without exception and commit.'
  ]
  for (const body of inverted) {
    assert.ok(mandatesCommit(body), `the detector must see this as a commit mandate:\n${body}`)
    assert.notDeepEqual(commitOverrideProblems(body), [], `inverted text slipped through:\n${body}`)
  }
})

test('the checker accepts the real wording', () => {
  const good =
    'The report and the run log go in the same commit.\n\n' +
    'If you were told not to commit, do not commit — leave them both uncommitted together. ' +
    'What matters is that they move as one.'
  assert.ok(mandatesCommit(good))
  assert.deepEqual(commitOverrideProblems(good), [])
})

// A future skill will not use today's exact wording. The detector has to see the instruction,
// not the phrase — an earlier version knew only three phrasings and missed nine of these.
test('the detector sees a commit mandate however it is worded', () => {
  const mandates = [
    'The brief and the run log go in the same\ncommit.',
    'Commit the queue file and the run log together.',
    'Add and commit the report at the end of the run.',
    'Stage the ticket file and the run log, then commit.',
    'Put the report and the log in one commit.',
    'git commit --message "run"',
    'Commit that file. No run log — this is setup, not a run.'
  ]
  for (const body of mandates) assert.ok(mandatesCommit(body), `missed a mandate:\n${body}`)
})

// A commit as a noun is not an instruction to make one.
test('the detector ignores talk about commits that is not an instruction', () => {
  const notMandates = [
    'Report the commit date and the commit message.',
    'Scan for committed secrets before you start.',
    'Show the commit list, newest first.',
    'The branch is three commits behind.',
    'Never commit your `.env` file.',
    'Do not commit the `.env` file.'
  ]
  for (const body of notMandates) assert.ok(!mandatesCommit(body), `false positive:\n${body}`)
})
