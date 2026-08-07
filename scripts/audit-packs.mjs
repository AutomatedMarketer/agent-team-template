// Phase 7: prompt-audit the existing agent packs before any of them is sold.
// Scoped to files a model actually loads - agent instructions, skills, rules - so the
// report is about shipped behaviour, not notes and transcripts.
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { auditText, RULES } from './prompt-audit.mjs'

const root = process.argv[2]
if (!root) { console.log('usage: node scripts/audit-packs.mjs <folder>'); process.exit(2) }

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', '.playwright-mcp', '.firecrawl',
  '.transcripts', '.pytest_cache', 'memory', 'outputs', 'docs', '.os', 'vendored-patches'
])

// Files a model loads at runtime.
const LOADED = (file, rel) =>
  file === 'CLAUDE.md' || file === 'core.md' || file === 'SKILL.md' ||
  rel.includes('.claude/rules/') || rel.includes('.claude/agents/') || rel.includes('.claude/commands/')

async function walk(dir, base = dir) {
  const out = []
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    const rel = path.relative(base, full).split(path.sep).join('/')
    if (entry.isDirectory()) out.push(...(await walk(full, base)))
    else if (entry.name.endsWith('.md') && LOADED(entry.name, rel)) out.push({ full, rel })
  }
  return out
}

const files = await walk(root)
const byRule = new Map(RULES.map((rule) => [rule.id, []]))
const byPack = new Map()

for (const { full, rel } of files) {
  const findings = auditText(await readFile(full, 'utf8'))
  if (!findings.length) continue
  const pack = rel.split('/')[0]
  byPack.set(pack, (byPack.get(pack) ?? 0) + findings.length)
  for (const finding of findings) byRule.get(finding.rule).push({ rel, ...finding })
}

const total = [...byRule.values()].reduce((sum, list) => sum + list.length, 0)
console.log(`scanned ${files.length} loaded files under ${root}`)
console.log(`${total} finding(s) across ${byPack.size} pack(s)\n`)

console.log('BY PACK')
for (const [pack, count] of [...byPack].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${pack}`)
}

console.log('\nBY RULE')
for (const rule of RULES) {
  const hits = byRule.get(rule.id)
  console.log(`  ${String(hits.length).padStart(4)}  ${rule.id} - ${rule.why}`)
}

if (process.argv[3] === '--detail') {
  console.log('\nDETAIL')
  for (const rule of RULES) {
    const hits = byRule.get(rule.id)
    if (!hits.length) continue
    console.log(`\n## ${rule.id} (${hits.length})`)
    for (const hit of hits.slice(0, 40)) console.log(`  ${hit.rel}:${hit.line}  ${hit.excerpt}`)
    if (hits.length > 40) console.log(`  ... and ${hits.length - 40} more`)
  }
}
