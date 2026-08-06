import { readdir, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { validateRunLog } from './lib/run-log.mjs'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))

async function runFiles() {
  const runsDir = path.join(repoRoot, 'runs')
  const months = await readdir(runsDir, { withFileTypes: true })
  const files = []
  for (const month of months) {
    if (!month.isDirectory()) continue
    for (const entry of await readdir(path.join(runsDir, month.name))) {
      if (entry.endsWith('.json')) files.push(path.posix.join('runs', month.name, entry))
    }
  }
  return files.sort()
}

const explicit = process.argv.slice(2)
const targets = explicit.length ? explicit : await runFiles()
let failed = 0

for (const target of targets) {
  const full = path.join(repoRoot, target)
  if (!(await stat(full).catch(() => null))) {
    console.log(`${target}: file not found`)
    failed += 1
    continue
  }
  const entry = JSON.parse(await readFile(full, 'utf8'))
  const problems = validateRunLog(entry, { filename: path.basename(target) })
  if (problems.length) {
    failed += 1
    console.log(`${target}`)
    for (const problem of problems) console.log(`  - ${problem}`)
  }
}

console.log(failed ? `\n${failed} invalid run log(s)` : `${targets.length} run log(s) valid`)
process.exit(failed ? 1 : 0)
