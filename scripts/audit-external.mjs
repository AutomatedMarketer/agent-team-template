// Audit any folder of markdown with this repo's rules. Used to keep the plugin and the
// SOPs to the same standard as the agents.
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { auditText } from './prompt-audit.mjs'

const root = process.argv[2]
if (!root) {
  console.log('usage: node scripts/audit-external.mjs <folder>')
  process.exit(2)
}

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

let count = 0
for (const file of await walk(root)) {
  for (const finding of auditText(await readFile(file, 'utf8'))) {
    console.log(`${path.relative(root, file)}:${finding.line} [${finding.rule}] ${finding.excerpt}`)
    count += 1
  }
}
console.log(count ? `\n${count} finding(s)` : 'prompt audit clean')
process.exit(count ? 1 : 0)
