import { readFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { stripBlocks } from './lib/prompt-blocks.mjs'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))

export const AUDITED_GLOBS = ['CLAUDE.md', '.claude/agents', '.claude/skills', '.claude/rules']

export const RULES = [
  {
    id: 'critical-prefix',
    pattern: /\bCRITICAL\s*:/,
    why: 'Emphasis written for older models now causes over-triggering (Standard section 7).'
  },
  {
    id: 'shouting-imperative',
    pattern: /\b(MUST|NEVER|ALWAYS)\b/,
    why: 'Uppercase imperatives over-trigger. Say what to do, in normal case (Standard section 7).'
  },
  {
    id: 'self-verification',
    pattern: /verify your work|double[-\s]check|re-?verify|final verification step/i,
    why: 'Opus 5 verifies itself; asking again causes over-verification (Standard section 6.1).'
  },
  {
    id: 'reasoning-extraction',
    pattern: /show your (thinking|reasoning)|explain your reasoning|reproduce your reasoning/i,
    why: 'Can trigger a reasoning_extraction refusal (Standard section 7).'
  },
  {
    id: 'over-delegation',
    pattern: /(delegate|use subagents?)[^.\n]{0,30}\b(freely|liberally|more often)\b/i,
    why: 'Opus 5 already delegates readily (Standard section 6.1).'
  },
  {
    id: 'progress-scaffolding',
    pattern: /after every \d+ tool calls|interim status (message|update)/i,
    why: 'Current models narrate well; forced scaffolding is redundant (Standard section 6.2).'
  },
  {
    id: 'tool-over-trigger',
    pattern: /default to using [`"']?[\w-]+|if in doubt,? use/i,
    why: 'Causes tool over-triggering (Standard section 9).'
  }
]

export function auditText(source) {
  const findings = []
  const lines = stripBlocks(source).split('\n')
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        findings.push({ rule: rule.id, line: index + 1, excerpt: line.trim().slice(0, 120) })
      }
    }
  })
  return findings
}

async function markdownUnder(relativePath) {
  const full = path.join(repoRoot, relativePath)
  const info = await stat(full).catch(() => null)
  if (!info) return []
  if (info.isFile()) return relativePath.endsWith('.md') ? [relativePath] : []
  const out = []
  for (const entry of await readdir(full, { withFileTypes: true })) {
    const next = path.posix.join(relativePath, entry.name)
    if (entry.isDirectory()) out.push(...(await markdownUnder(next)))
    else if (entry.name.endsWith('.md')) out.push(next)
  }
  return out
}

export async function auditRepo() {
  const findings = []
  for (const target of AUDITED_GLOBS) {
    for (const file of await markdownUnder(target)) {
      const body = await readFile(path.join(repoRoot, file), 'utf8')
      for (const finding of auditText(body)) findings.push({ file, ...finding })
    }
  }
  return findings
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const findings = await auditRepo()
  for (const finding of findings) {
    console.log(`${finding.file}:${finding.line} [${finding.rule}] ${finding.excerpt}`)
  }
  console.log(findings.length ? `\n${findings.length} finding(s)` : 'prompt audit clean')
  process.exit(findings.length ? 1 : 0)
}
