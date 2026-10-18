// The jobs a run order can start, and what each is allowed to do.
//
// A run order carries only the job's name. Everything Claude is told, every path it may write and the names of its run
// logs come from this file and from the prompt files next to this code (.agent-team/mailbox/prompts) - the runner's own
// pinned code - never from the order and never from the team repo, which other people push to. From the team repo
// comes only what a job is made of: its owner, its steps, and the owner's model. Each is checked before it is used,
// and only the checked words reach the prompt: not the workflow's name, its reason, or a line of the agent's file.
//
// A job with no entry here cannot be run, whatever the allowlist says (that is the allowlist's job; this is the
// code's). To let a new job run, its rules are added here, reviewed, and the runner's code is moved by hand.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSimpleYaml } from '../yaml-lite.mjs'
import { parseFrontmatter } from '../frontmatter.mjs'
import { AGENT_SLUGS } from '../run-log.mjs'
import { isoSeconds } from '../status/util.mjs'
import { isSlug } from './validate.mjs'
import { readRepoFile, todayIn } from './cards.mjs'

export const RUN_PROMPT_FILE = '.agent-team/mailbox/prompts/run.md'
export const MAC_NOTE_FILE = '.agent-team/mailbox/prompts/mac-note.md'
// The note a Codex run gets in place of the one above: it has a shell, inside the work copy only, with no network (codex.mjs).
export const CODEX_NOTE_FILE = '.agent-team/mailbox/prompts/codex-note.md'
const MOST_STEPS = 12
// The run log's model field takes only these two; a lighter owner runs as sonnet so the log can say what ran.
const RUN_MODELS = ['opus', 'sonnet']

const freeze = Object.freeze
export const JOBS = freeze({
  'morning-intel': freeze({
    output: (date) => `inbox/${date}/morning-intel.md`,
    logs: freeze({ min: 1, max: 1 }),
    web: true,
    changes: 'You may create exactly two files: the output above and one run log. Change nothing else.',
    logsSentence: 'Write exactly one run log.'
  }),
  'task-sweep': freeze({
    output: (date) => `inbox/${date}/task-sweep.md`,
    logs: freeze({ min: 1, max: 3 }),
    web: false,
    changes:
      'You may: create the digest above and up to three run logs; change task cards that already exist in `tasks/` - only their frontmatter `status` and `done_at`, ' +
      'and a `## Result` section added at the end of the card (never their other words); and create new files in `agents/<agent>/output/`. Change nothing else. ' +
      'You cannot start sub-agents, so work every card yourself; if a card names a `model:`, say in the digest that it was ignored.',
    logsSentence: 'Write one run log for each card you worked (at most three); if you worked none, write one for `orchestrator` whose artifact is the digest.'
  })
})

export const knownJobs = () => Object.keys(JOBS)

// Whether Codex may be a job's worker: only a job with no web. Codex never has the network (its sandbox has none, and its web search is
// off), so a job that needs the news is Claude's whatever the allowlist says.
export const codexMayRun = (slug) => typeof slug === 'string' && Object.hasOwn(JOBS, slug) && JOBS[slug].web === false

const refused = (why) => ({ ok: false, state: 'refused', why })
const LINKED = { ok: false, state: 'failed', why: 'change-refused' }

// A minute stamp the way run ids are written: 2026-10-12T1405Z.
function stampOf(ms) {
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z`
}

// What a run of `slug` is made of, read from the work copy, or the reason it cannot run:
//   { ok: true, plan }
//   { ok: false, state: 'refused', why: 'job-not-allowed' | 'no-workflow' }
//   { ok: false, state: 'failed', why: 'change-refused' }   a file it needs is a link
export async function planRun({ root, slug, now, timeZone, git }) {
  if (typeof slug !== 'string' || !Object.hasOwn(JOBS, slug)) return refused('job-not-allowed')
  const job = JOBS[slug]
  const workflow = await readRepoFile(root, `workflows/${slug}.yml`, git)
  if (workflow.state === 'link') return LINKED
  if (workflow.state !== 'ok') return refused('no-workflow')
  const doc = parseSimpleYaml(workflow.text)
  const { owner, steps } = doc
  if (!AGENT_SLUGS.includes(owner)) return refused('no-workflow')
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MOST_STEPS || !steps.every(isSlug)) return refused('no-workflow')
  const agent = await readRepoFile(root, `.claude/agents/${owner}.md`, git)
  if (agent.state === 'link') return LINKED
  if (agent.state !== 'ok') return refused('no-workflow')
  const written = parseFrontmatter(agent.text).data.model
  const date = todayIn(now, timeZone)
  return {
    ok: true,
    plan: {
      slug,
      owner,
      steps: [...steps],
      model: RUN_MODELS.includes(written) ? written : 'sonnet',
      date,
      startedAt: isoSeconds(now),
      stamps: Array.from({ length: job.logs.max }, (_, at) => stampOf(now + at * 60_000)),
      outputPath: job.output(date),
      logs: { ...job.logs },
      web: job.web
    }
  }
}

export function describeChanges(plan) {
  return JOBS[plan.slug].changes
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{4}Z$/

// The prompt is built only from a plan of exactly the shape planRun makes - every value checked again here, and the
// output path made again from the job's own rule - so nothing but known words can reach Claude.
function assertPlan(plan) {
  const job = plan && typeof plan.slug === 'string' && Object.hasOwn(JOBS, plan.slug) ? JOBS[plan.slug] : null
  const good =
    job !== null &&
    AGENT_SLUGS.includes(plan.owner) &&
    Array.isArray(plan.steps) && plan.steps.length >= 1 && plan.steps.length <= MOST_STEPS && plan.steps.every(isSlug) &&
    RUN_MODELS.includes(plan.model) &&
    typeof plan.date === 'string' && DAY.test(plan.date) &&
    typeof plan.startedAt === 'string' && INSTANT.test(plan.startedAt) &&
    Array.isArray(plan.stamps) && plan.stamps.length === job.logs.max && plan.stamps.every((stamp) => typeof stamp === 'string' && STAMP.test(stamp)) &&
    plan.outputPath === job.output(plan.date) &&
    plan.logs?.min === job.logs.min && plan.logs?.max === job.logs.max &&
    plan.web === job.web
  if (!good) throw new TypeError('jobs: that is not a plan this code made')
}

// The prompt for a run: the pinned template with the plan's checked values in it. { codeDir } is the runner's own
// checkout, where the prompt files live; `worker` picks the note at its end (Claude's unless it is 'codex').
export async function runPrompt(plan, { codeDir, worker = 'claude' }) {
  assertPlan(plan)
  const values = {
    workflow: plan.slug,
    owner: plan.owner,
    outputPath: plan.outputPath,
    changes: describeChanges(plan),
    date: plan.date,
    startedAt: plan.startedAt,
    model: plan.model,
    stamps: plan.stamps.join(', '),
    logs: JOBS[plan.slug].logsSentence,
    macNote: (await readFile(join(codeDir, worker === 'codex' ? CODEX_NOTE_FILE : MAC_NOTE_FILE), 'utf8')).trim()
  }
  const template = await readFile(join(codeDir, RUN_PROMPT_FILE), 'utf8')
  return template.replace(/\{\{([A-Za-z]+)\}\}/g, (placeholder, name) => {
    if (!Object.hasOwn(values, name)) throw new Error(`jobs: the prompt has a placeholder this code does not fill (${name})`)
    return values[name]
  })
}
