import test from 'node:test'
import assert from 'node:assert/strict'
import { read, exists, listDir } from './helpers/repo.mjs'
import { parseFrontmatter } from '../scripts/lib/frontmatter.mjs'
import { parseWorkflow, validateWorkflow, normaliseSteps } from '../scripts/lib/workflows.mjs'

// The task inbox: one markdown card per ask, worked off by the daily sweep. The contract
// lives in tasks/README.md; these tests hold the pieces that make it work together.

test('the tasks folder ships, empty except its contract', async () => {
  assert.ok(await exists('tasks/README.md'), 'tasks/README.md is missing')
  assert.ok(await exists('tasks/.gitkeep'), 'tasks/.gitkeep is missing')
})

test('the contract states the filename, the statuses, and the for field', async () => {
  const contract = await read('tasks/README.md')
  assert.match(contract, /YYYY-MM-DD-short-slug\.md|\d{4}-\d{2}-\d{2}-[a-z-]+\.md/)
  for (const status of ['todo', 'doing', 'done']) {
    assert.match(contract, new RegExp(`\\b${status}\\b`), `contract never mentions ${status}`)
  }
  assert.match(contract, /`for`|for:/, 'contract never mentions the for field')
  assert.match(contract, /orchestrator decides/i, 'contract must say what an omitted for means')
})

test('the contract says tasks are made by talking and done cards keep their file', async () => {
  const contract = await read('tasks/README.md')
  assert.match(contract, /add a task/i, 'contract must teach the spoken form')
  assert.match(contract, /## Result/, 'contract must show the appended Result section')
  assert.match(contract, /file stays|history/i, 'contract must say done cards are kept')
})

/* A card recorded WHETHER it was finished and never WHEN. The dashboard shows finished tasks
   for seven days and then hides them behind a link, and it had nothing to measure those seven
   days against - the filename's date prefix is when the card was written, not when the work was
   done. So a done card carries the day it was closed. */

test('the contract carries done_at, and says what writes it and what it is for', async () => {
  const contract = await read('tasks/README.md')
  assert.match(contract, /done_at/, 'the contract never mentions done_at')
  assert.match(contract, /YYYY-MM-DD/, 'the contract must say what shape the date takes')
  assert.match(contract, /seven days|7 days/i, 'the contract must say what the date is used for')
})

test('the sweep records the day it closed a card, not just that it closed it', async () => {
  const skill = await read('.claude/skills/work-the-tasks/SKILL.md')
  assert.match(skill, /done_at/, 'the sweep marks cards done without dating them')
  // Dated when it is closed, not when the run started - a sweep that begins before midnight
  // and finishes after it would otherwise file the card on the wrong day.
  assert.match(skill, /today's date|the date you (?:close|finish)/i,
    'the sweep does not say which date to write')
})

test('the work-the-tasks skill exists and carries the sweep rules', async () => {
  const skills = await listDir('.claude/skills')
  assert.ok(skills.includes('work-the-tasks'), 'the work-the-tasks skill is missing')
  const skill = await read('.claude/skills/work-the-tasks/SKILL.md')
  const { data } = parseFrontmatter(skill)
  assert.equal(data.name, 'work-the-tasks')
  assert.match(skill, /oldest/i, 'the sweep must work oldest first')
  assert.match(skill, /three/i, 'the sweep must stop after three tasks per run')
  assert.match(skill, /`task-sweep`/, 'run logs must carry the task-sweep workflow slug')
  assert.match(skill, /\.claude\/skills\/run-log\/SKILL\.md/, 'the sweep must invoke run-log')
  assert.match(skill, /for:/, 'the sweep must respect the for field')
})

test('the task-sweep workflow validates against real agents and skills', async () => {
  const source = await read('workflows/task-sweep.yml')
  const data = parseWorkflow(source)
  assert.equal(data.name, 'Task Sweep')
  assert.equal(data.owner, 'orchestrator')
  assert.deepEqual(normaliseSteps(data.steps), ['work-the-tasks'])
  assert.equal(data.trigger.schedule, 'daily 09:00')
  assert.equal(data.trigger.fire, true)
  assert.equal(data.output, 'inbox/{date}/task-sweep.md')
  const agents = (await listDir('.claude/agents')).flatMap((entry) =>
    entry.endsWith('.md') ? [entry.replace(/\.md$/, '')] : []
  )
  const skills = (await listDir('.claude/skills')).filter((entry) => !entry.startsWith('.'))
  assert.deepEqual(validateWorkflow(data, { agents, skills }), [])
})

test('CLAUDE.md teaches the owner how to assign work', async () => {
  const source = await read('CLAUDE.md')
  assert.match(source, /add a task/i, 'CLAUDE.md never teaches "add a task: ..."')
  assert.match(source, /tasks\//, 'CLAUDE.md never points at the tasks folder')
  assert.match(source, /task-sweep/, 'CLAUDE.md never names the sweep workflow')
})

test('the orchestrator agent and the front door say they are the same role', async () => {
  const claudeMd = await read('CLAUDE.md')
  const agent = await read('.claude/agents/orchestrator.md')
  assert.match(claudeMd, /\.claude\/agents\/orchestrator\.md/)
  assert.match(claudeMd, /same role/i, 'CLAUDE.md must say the agent is the same role')
  assert.match(agent, /same role/i, 'the agent must say it is the CLAUDE.md role')
  assert.match(agent, /CLAUDE\.md/)
})
