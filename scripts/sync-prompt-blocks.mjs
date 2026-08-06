import { readFile, writeFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { loadAllBlocks } from './lib/prompt-blocks.mjs'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const OPEN = /^(\s*)<!--\s*prompt-block:\s*([a-z0-9-]+)\s*-->\s*$/
const CLOSE = /^\s*<!--\s*\/prompt-block\s*-->\s*$/

async function targets() {
  const agentDir = path.join(repoRoot, '.claude/agents')
  const agentFiles = (await readdir(agentDir))
    .filter((file) => file.endsWith('.md'))
    .map((file) => path.posix.join('.claude/agents', file))
  return ['CLAUDE.md', ...agentFiles]
}

async function syncFile(relativePath, blocks) {
  const full = path.join(repoRoot, relativePath)
  const lines = (await readFile(full, 'utf8')).replace(/\r\n/g, '\n').split('\n')
  const output = []
  let inside = null
  let changed = false
  for (const line of lines) {
    const opening = OPEN.exec(line)
    if (opening) {
      inside = opening[2]
      output.push(line)
      const canonical = blocks.get(inside)
      if (!canonical) throw new Error(`${relativePath} references unknown block "${inside}"`)
      output.push(canonical)
      changed = true
      continue
    }
    if (inside && CLOSE.test(line)) {
      inside = null
      output.push(line)
      continue
    }
    if (!inside) output.push(line)
  }
  await writeFile(full, output.join('\n'), 'utf8')
  return changed
}

const blocks = await loadAllBlocks()
for (const target of await targets()) {
  const touched = await syncFile(target, blocks)
  console.log(`${touched ? 'synced  ' : 'skipped '}${target}`)
}
