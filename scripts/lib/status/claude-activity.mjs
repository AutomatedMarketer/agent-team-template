// An estimate of Claude Code activity, counted from Claude Code's own logs on this machine.
//
// It is labelled an estimate everywhere because it is one: it sees only this computer, only Claude
// Code, and it cannot know what a plan's limit is. It never produces a percentage. What it can
// say honestly is how many replies, sessions and tokens there were, per local day.
//
// The logs hold project folder names (which contain the username), working folders, session ids
// and the conversation itself. Only numbers leave this module.

import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { claudeConfigDir } from './claude-limits.mjs'
import { isPlainObject } from './util.mjs'
import { isKnownTimezone } from './safe.mjs'
import { MAX_ACTIVITY_DAYS } from './schema.mjs'

export const ESTIMATE_DAYS = 15
const DAY_MS = 86400_000

async function listDir(path) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

// Session logs sit directly in each project folder; a subagent's log sits in
// <project>/<session>/subagents/. Files untouched since before the cut are skipped unopened.
async function recentLogs(projectsDir, cutoff) {
  const candidates = []
  for (const project of await listDir(projectsDir)) {
    if (!project.isDirectory()) continue
    const projectDir = join(projectsDir, project.name)
    for (const entry of await listDir(projectDir)) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) candidates.push(join(projectDir, entry.name))
      if (entry.isDirectory()) {
        const subagentsDir = join(projectDir, entry.name, 'subagents')
        for (const sub of await listDir(subagentsDir)) {
          if (sub.isFile() && sub.name.endsWith('.jsonl')) candidates.push(join(subagentsDir, sub.name))
        }
      }
    }
  }
  const recent = []
  for (const path of candidates) {
    try {
      if ((await stat(path)).mtimeMs >= cutoff) recent.push(path)
    } catch {
      // Deleted mid-scan.
    }
  }
  return recent
}

function familyOf(model) {
  const name = model.toLowerCase()
  if (name.includes('opus')) return 'opus'
  if (name.includes('sonnet')) return 'sonnet'
  if (name.includes('haiku')) return 'haiku'
  return 'other'
}

const tokenCount = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0)

function dayFormatter(timezone) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
  return (ms) => {
    const parts = Object.fromEntries(format.formatToParts(new Date(ms)).map((part) => [part.type, part.value]))
    return `${parts.year}-${parts.month}-${parts.day}`
  }
}

function emptyDay(day) {
  return {
    day,
    sessions: new Set(),
    replies: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    byModel: { opus: 0, sonnet: 0, haiku: 0, other: 0 }
  }
}

// deps: { home, env, now (ms), timezone }
export async function collectClaudeActivity(deps) {
  const projectsDir = join(claudeConfigDir(deps), 'projects')
  try {
    if (!(await stat(projectsDir)).isDirectory()) return { status: 'not found' }
  } catch {
    return { status: 'not found' }
  }

  // The timezone is the one string here that comes from the machine rather than from code. If it
  // is not a real zone name it is not written; the days are counted in UTC instead.
  const timezone = isKnownTimezone(deps.timezone) ? deps.timezone : 'UTC'
  const dayOf = dayFormatter(timezone)
  const cutoff = deps.now - ESTIMATE_DAYS * DAY_MS
  const latest = deps.now + 5 * 60_000
  const seen = new Set()
  const days = new Map()

  for (const path of await recentLogs(projectsDir, cutoff)) {
    const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        // Cheap test first: most lines are tool output and user turns, and parsing them is the
        // expensive part of reading a fortnight of logs.
        if (!line.includes('"assistant"')) continue
        let entry
        try {
          entry = JSON.parse(line)
        } catch {
          continue
        }
        if (entry?.type !== 'assistant' || !isPlainObject(entry.message) || !isPlainObject(entry.message.usage)) continue
        const model = typeof entry.message.model === 'string' ? entry.message.model : ''
        // Synthetic entries are Claude Code's own placeholders, not replies from a model.
        if (!model || model === '<synthetic>') continue
        const at = Date.parse(entry.timestamp)
        if (!Number.isFinite(at) || at < cutoff || at > latest) continue

        // A streamed reply is logged more than once with the same message and request ids.
        const messageId = typeof entry.message.id === 'string' ? entry.message.id : ''
        const requestId = typeof entry.requestId === 'string' ? entry.requestId : ''
        if (messageId) {
          const key = `${messageId}:${requestId}`
          if (seen.has(key)) continue
          seen.add(key)
        }

        const day = dayOf(at)
        if (!days.has(day)) days.set(day, emptyDay(day))
        const bucket = days.get(day)
        bucket.replies += 1
        bucket.sessions.add(typeof entry.sessionId === 'string' && entry.sessionId ? entry.sessionId : path)
        const usage = entry.message.usage
        bucket.tokens.input += tokenCount(usage.input_tokens)
        bucket.tokens.output += tokenCount(usage.output_tokens)
        bucket.tokens.cacheRead += tokenCount(usage.cache_read_input_tokens)
        bucket.tokens.cacheWrite += tokenCount(usage.cache_creation_input_tokens)
        bucket.byModel[familyOf(model)] += 1
      }
    } catch {
      // A log that cannot be read to the end contributes what was read before the failure.
    } finally {
      lines.close()
    }
  }

  // Never more days than the gate allows - one extra day would refuse the whole snapshot - so if
  // the count ever runs over, the oldest go first.
  const ordered = [...days.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-MAX_ACTIVITY_DAYS)
    .map((bucket) => ({ ...bucket, sessions: bucket.sessions.size }))
  return { status: 'found', estimate: true, timezone, days: ordered }
}
