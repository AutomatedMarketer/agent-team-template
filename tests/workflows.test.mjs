import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fromRoot, listDir } from './helpers/repo.mjs'
import {
  parseWorkflow,
  validateWorkflow,
  normaliseSteps,
  isValidSchedule,
  loadWorkflows,
  MIN_INTERVAL_MINUTES
} from '../scripts/lib/workflows.mjs'

function fixture(name) {
  return readFile(fromRoot('tests/fixtures/workflows', name), 'utf8')
}

const AGENTS = ['content', 'customer-service', 'email', 'research', 'sales', 'security']
const SKILLS = ['pull-calendar', 'scan-inbox', 'check-pipeline', 'write-brief']

test('parses the canonical workflow shape', async () => {
  const data = parseWorkflow(await fixture('valid.yml'))
  assert.equal(data.name, 'Monday Brief')
  assert.equal(data.owner, 'research')
  assert.deepEqual(data.steps, ['pull-calendar', 'scan-inbox', 'check-pipeline', 'write-brief'])
  assert.equal(data.trigger.schedule, 'weekly mon 06:00')
  assert.equal(data.trigger.fire, true)
  assert.equal(data.output, 'inbox/{date}/monday-brief.md')
})

test('a dashed list parses the same as an inline one', async () => {
  const data = parseWorkflow(await fixture('dashed-steps.yml'))
  assert.deepEqual(data.steps, ['draft-post', 'make-images'])
  assert.equal(data.trigger.fire, true)
})

test('the spec form `- skill: name` validates the same as plain strings', async () => {
  const data = parseWorkflow(await fixture('skill-map-steps.yml'))
  assert.deepEqual(validateWorkflow(data), [])
  assert.deepEqual(normaliseSteps(data.steps), ['pull-calendar', 'scan-inbox', 'write-brief'])
})

test('the canonical workflow validates clean against real agents and skills', async () => {
  const data = parseWorkflow(await fixture('valid.yml'))
  assert.deepEqual(validateWorkflow(data, { agents: AGENTS, skills: SKILLS }), [])
})

test('an unknown step is rejected', async () => {
  const data = parseWorkflow(await fixture('valid.yml'))
  data.steps = ['scan-inbox', 'no-such-skill']
  const problems = validateWorkflow(data, { agents: AGENTS, skills: SKILLS })
  assert.ok(problems.some((problem) => problem.includes('no-such-skill')))
})

test('an unknown owner is rejected', async () => {
  const data = parseWorkflow(await fixture('valid.yml'))
  data.owner = 'nobody'
  const problems = validateWorkflow(data, { agents: AGENTS, skills: SKILLS })
  assert.ok(problems.some((problem) => problem.includes('nobody')))
})

test('an empty name and a duplicated step are both reported', async () => {
  const data = parseWorkflow(await fixture('bad-steps.yml'))
  const problems = validateWorkflow(data, { agents: AGENTS, skills: SKILLS })
  assert.ok(problems.some((problem) => problem.startsWith('name is required')))
  assert.ok(problems.some((problem) => problem.includes('appears more than once')))
})

test('a missing trigger is reported', () => {
  const problems = validateWorkflow({
    name: 'x',
    owner: 'research',
    steps: ['scan-inbox'],
    output: 'inbox/x.md'
  })
  assert.ok(problems.some((problem) => problem === 'trigger is required'))
})

test('a trigger with no schedule, fire or webhook is reported', () => {
  const problems = validateWorkflow({
    name: 'x',
    owner: 'research',
    steps: ['scan-inbox'],
    trigger: {},
    output: 'inbox/x.md'
  })
  assert.ok(problems.some((problem) => problem.includes('at least one of')))
})

// The routine floor is the whole reason `runner` exists — a sub-hourly schedule silently
// never firing is the failure a student would take days to notice.
test('a sub-hourly schedule is rejected for the routine runner', async () => {
  const data = parseWorkflow(await fixture('sub-hourly.yml'))
  const problems = validateWorkflow(data, { agents: AGENTS, skills: ['scan-inbox'] })
  assert.ok(problems.some((problem) => problem.includes('60-minute floor')))
})

test('the same schedule is allowed once the runner can honour it', async () => {
  const data = parseWorkflow(await fixture('sub-hourly.yml'))
  data.runner = 'github-actions'
  assert.deepEqual(validateWorkflow(data, { agents: AGENTS, skills: ['scan-inbox'] }), [])
})

test('an unknown runner is rejected', async () => {
  const data = parseWorkflow(await fixture('valid.yml'))
  data.runner = 'cron-on-my-laptop'
  const problems = validateWorkflow(data, { agents: AGENTS, skills: SKILLS })
  assert.ok(problems.some((problem) => problem.includes('cron-on-my-laptop')))
})

test('an output path that escapes the repo is rejected', async () => {
  const data = parseWorkflow(await fixture('escapes-repo.yml'))
  const problems = validateWorkflow(data, { agents: AGENTS, skills: ['scan-inbox'] })
  assert.ok(problems.some((problem) => problem.includes('must stay inside the repo')))
})

test('an absolute output path is rejected', () => {
  const problems = validateWorkflow({
    name: 'x',
    owner: 'research',
    steps: ['scan-inbox'],
    trigger: { fire: true },
    output: '/etc/passwd'
  })
  assert.ok(problems.some((problem) => problem.includes('must stay inside the repo')))
})

test('schedule forms are recognised, and near-misses are not', () => {
  for (const good of [
    'hourly',
    'daily 06:00',
    'weekdays 09:30',
    'weekly mon 06:00',
    'monthly 1 08:00',
    'every 2 hours'
  ]) {
    assert.ok(isValidSchedule(good), `${good} should be valid`)
  }
  for (const bad of ['every monday', 'daily 6:00', 'weekly funday 06:00', '0 6 * * 1', '']) {
    assert.ok(!isValidSchedule(bad), `${bad} should be invalid`)
  }
})

test('the routine floor is an hour and github-actions is lower', () => {
  assert.equal(MIN_INTERVAL_MINUTES.routine, 60)
  assert.ok(MIN_INTERVAL_MINUTES['github-actions'] < MIN_INTERVAL_MINUTES.routine)
})

// Whatever ships in workflows/ has to pass the same bar we hold students to — and it is
// checked against what the repo actually contains, not a hardcoded list, so a renamed
// skill or agent breaks the build instead of a student's first run.
test('every shipped workflow parses and validates against real agents and skills', async () => {
  const agents = (await listDir('.claude/agents')).flatMap((entry) =>
    entry.endsWith('.md') ? [entry.replace(/\.md$/, '')] : []
  )
  const skills = (await listDir('.claude/skills')).filter((entry) => !entry.startsWith('.'))
  const workflows = await loadWorkflows()
  for (const workflow of workflows) {
    const problems = validateWorkflow(workflow.data, { agents, skills })
    assert.deepEqual(problems, [], `${workflow.path}: ${problems.join('; ')}`)
  }
})

// The pre-loaded roster: every agent owns a working workflow on day one. An empty board
// is the blank page this template exists to prevent.
test('the nine pre-loaded workflows ship, four for the owner and five for the team', async () => {
  const workflows = await loadWorkflows()
  const slugs = workflows.map((workflow) => workflow.slug)
  for (const slug of [
    'morning-intel',
    'draft-queue',
    'inbox-triage',
    'gone-cold',
    'weekly-review',
    'security-review'
  ]) {
    assert.ok(slugs.includes(slug), `workflows/${slug}.yml is missing`)
  }
  const owners = new Set(workflows.map((workflow) => workflow.data.owner))
  for (const agent of AGENTS) {
    assert.ok(owners.has(agent), `no shipped workflow is owned by ${agent}`)
  }
})

/* A well-formed fixture named `valid` is a loaded gun for documentation. Anyone looking for
   "a valid workflow to show someone" finds tests/fixtures/workflows/valid.yml first: it parses,
   it reads like a real job, and its steps - pull-calendar, scan-inbox, check-pipeline,
   write-brief - are invented. A copy of it names four skills that do not exist.

   The rule is not "these files must be realistic". It is that a file whose job is to be parsed
   has to SAY so, on its first line, where somebody skimming will see it before they copy it. */
test('every workflow fixture says it is a fixture, on its first line', async () => {
  const { readdir, readFile } = await import('node:fs/promises')
  const { fromRoot } = await import('./helpers/repo.mjs')
  const dir = 'tests/fixtures/workflows'
  const files = (await readdir(fromRoot(dir))).filter((file) => file.endsWith('.yml'))
  assert.ok(files.length > 0, 'no workflow fixtures found - this guard has stopped guarding')
  for (const file of files) {
    const body = await readFile(fromRoot(dir, file), 'utf8')
    const [first] = body.split('\n')
    assert.match(first, /^# TEST FIXTURE\b/, `${dir}/${file} does not open by saying it is a fixture`)
    assert.match(body, /steps are invented/, `${dir}/${file} must say why copying it would not work`)
    // The redirect is the part that actually helps somebody who came here looking for an example.
    // Pinned, because without it the banner can be cut to two words and still pass.
    assert.match(body, /workflows\/ in this repo/, `${dir}/${file} must point at the real workflows`)
    assert.match(body, /\/new-workflow/, `${dir}/${file} must say how to make a real one`)
  }
})

// Every one of those banners claims the steps are invented. That claim is only worth printing
// while it is true, so it is checked across all of them, not just the one the finding named.
// If somebody makes a step real, the warning becomes a lie and should be rewritten, not deleted.
//
// Steps come from parseWorkflow, not a regex. A regex for `steps: [a, b]` silently skipped the
// two fixtures that exist precisely BECAUSE they use the other two step forms - dashed-steps.yml
// and skill-map-steps.yml - so the guard covered four of six and looked like it covered all.
test('the parser fixtures name skills this repo does not have', async () => {
  const { readdir, readFile } = await import('node:fs/promises')
  const { fromRoot } = await import('./helpers/repo.mjs')
  const skills = new Set(
    (await readdir(fromRoot('.claude/skills'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  )
  const dir = 'tests/fixtures/workflows'
  const files = (await readdir(fromRoot(dir))).filter((file) => file.endsWith('.yml'))
  let checked = 0
  for (const file of files) {
    const data = parseWorkflow(await readFile(fromRoot(dir, file), 'utf8'))
    for (const step of normaliseSteps(data.steps ?? [])) {
      if (typeof step !== 'string' || !step) continue
      checked += 1
      assert.ok(!skills.has(step),
        `${dir}/${file}: step "${step}" is a real skill now - the banner saying its steps are invented is no longer true`)
    }
  }
  assert.ok(checked >= 10, `only ${checked} fixture steps were checked across ${files.length} files - the guard is missing a step form`)
})