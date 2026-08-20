import test from 'node:test'
import assert from 'node:assert/strict'
import { read, exists, listDir } from './helpers/repo.mjs'
import { loadWorkflows, normaliseSteps } from '../scripts/lib/workflows.mjs'

const STEPS = ['check-whats-changed', 'learn-from-the-week', 'write-tune-up']

// --- the loop ships, and it is the orchestrator's job ---------------------------------

test('the weekly tune-up ships and the orchestrator owns it', async () => {
  const tuneUp = (await loadWorkflows()).find((workflow) => workflow.slug === 'weekly-tune-up')
  assert.ok(tuneUp, 'workflows/weekly-tune-up.yml is missing')
  assert.equal(tuneUp.data.owner, 'orchestrator', 'the manager owns the self-improvement loop')
  assert.deepEqual(normaliseSteps(tuneUp.data.steps), STEPS)
})

test('all three tune-up skills exist', async () => {
  const installed = await listDir('.claude/skills')
  for (const step of STEPS) {
    assert.ok(installed.includes(step), `.claude/skills/${step} is missing`)
    assert.ok(await exists(`.claude/skills/${step}/SKILL.md`), `${step} has no SKILL.md`)
  }
})

test('the tune-up runs on a different day from the reviews it reads', async () => {
  const workflows = await loadWorkflows()
  const scheduleOf = (slug) =>
    workflows.find((workflow) => workflow.slug === slug)?.data?.trigger?.schedule ?? ''
  const dayOf = (schedule) => /^weekly (\w+)/.exec(schedule)?.[1]
  const tuneUp = dayOf(scheduleOf('weekly-tune-up'))
  assert.ok(tuneUp, 'the tune-up must run weekly')
  // It reads the quality review's week back, so it cannot share that day - and every
  // weekly job on one day would burn the daily run cap in a single morning.
  for (const slug of ['quality-review', 'weekly-review', 'security-review']) {
    assert.notEqual(dayOf(scheduleOf(slug)), tuneUp, `${slug} must not share the tune-up's day`)
  }
})

// --- the four lanes it has to check ---------------------------------------------------

test('it checks models, changelogs, connectors, and what the team leverages', async () => {
  const skill = await read('.claude/skills/check-whats-changed/SKILL.md')
  for (const lane of [/models/i, /changelog/i, /connector/i, /runtimes\.yml/]) {
    assert.match(skill, lane, `check-whats-changed is missing a lane: ${lane}`)
  }
})

test('it catches a pinned model id, which is the thing that actually rots', async () => {
  const skill = await read('.claude/skills/check-whats-changed/SKILL.md')
  assert.match(skill, /pinned id/i)
  assert.match(skill, /grep -rn/, 'the check has to be a command, not an intention')
})

test('it never duplicates the security review watcher', async () => {
  const skill = await read('.claude/skills/check-whats-changed/SKILL.md')
  assert.match(skill, /watch-updates/, 'it must name the watcher it defers to')
})

test('a connector is reported by name and never by credential', async () => {
  const skill = await read('.claude/skills/check-whats-changed/SKILL.md')
  assert.match(skill, /never print a key/i)
})

test('an unreachable item is a finding, not silence', async () => {
  const skill = await read('.claude/skills/check-whats-changed/SKILL.md')
  assert.match(skill, /never "?no news"?/i)
})

// --- the rules that keep the learning honest ------------------------------------------

test('a pattern needs two occurrences before it becomes a rule', async () => {
  const skill = await read('.claude/skills/learn-from-the-week/SKILL.md')
  assert.match(skill, /twice, or it is not a pattern/i)
})

test('it caps itself at three proposals, each with exact replacement text', async () => {
  const skill = await read('.claude/skills/learn-from-the-week/SKILL.md')
  assert.match(skill, /at most three proposals/i)
  assert.match(skill, /nobody can apply advice/i)
})

test('it notices when its own proposals are never applied', async () => {
  const skill = await read('.claude/skills/learn-from-the-week/SKILL.md')
  assert.match(skill, /three weeks of proposals with none applied/i)
  assert.match(skill, /do not propose them again/i, 'a repeated proposal turns the report into wallpaper')
})

// --- the line it must not cross -------------------------------------------------------

test('the tune-up may write down what it learned but may not rewire the team', async () => {
  const learn = await read('.claude/skills/learn-from-the-week/SKILL.md')
  assert.match(learn, /may not change how the team is wired/i)
  const write = await read('.claude/skills/write-tune-up/SKILL.md')
  for (const rewiring of [/model change/i, /connector fix/i, /upstream pull/i]) {
    assert.match(write, rewiring, `${rewiring} must be carded, not applied`)
  }
})

test('a contradicted rule is escalated, never silently replaced', async () => {
  const skill = await read('.claude/skills/write-tune-up/SKILL.md')
  assert.match(skill, /never delete an existing rule/i)
})

test('a quiet week is allowed to be a quiet week', async () => {
  const skill = await read('.claude/skills/write-tune-up/SKILL.md')
  assert.match(skill, /nothing happened twice/i)
  assert.match(skill, /do not manufacture findings/i)
})

test('what could not be checked is always reported', async () => {
  const skill = await read('.claude/skills/write-tune-up/SKILL.md')
  assert.match(skill, /## Not checked/)
  assert.match(skill, /never omitted/i)
})
