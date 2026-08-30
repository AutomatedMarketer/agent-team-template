import { AGENT_SLUGS, runIdFor, monthFolderFor } from './lib/run-log.mjs'

// Every fact a run log needs, printed the same way in every shell. The bash-only
// version of this (date -u, echo "$VAR") failed on Windows, which is where most
// students are.

const [agent, workflow] = process.argv.slice(2)

if (!agent) {
  console.error('Usage: node scripts/run-facts.mjs <agent> [workflow]')
  console.error(`Agents: ${AGENT_SLUGS.join(', ')}`)
  process.exit(1)
}

if (!AGENT_SLUGS.includes(agent)) {
  console.error(`"${agent}" is not an agent in this repo.`)
  console.error(`Agents: ${AGENT_SLUGS.join(', ')}`)
  process.exit(1)
}

const now = new Date()
const sessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID || null
const isRemote = process.env.CLAUDE_CODE_REMOTE === 'true'
const runId = workflow ? `${runIdFor(agent, now)}-${workflow}` : runIdFor(agent, now)

const facts = {
  started_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  trigger: isRemote ? 'schedule' : 'manual',
  session_id: sessionId,
  session_url: sessionId ? `https://claude.ai/code/session_${sessionId}` : null,
  run_id: runId,
  path: `${monthFolderFor(now)}/${runId}.json`
}

for (const [field, value] of Object.entries(facts)) {
  console.log(`${field.padEnd(12)} ${value === null ? 'null' : value}`)
}
