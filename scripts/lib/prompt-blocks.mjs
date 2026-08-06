import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

export const BLOCK_DIR = 'shared/standards/prompt-blocks'

const OPEN = /<!--\s*prompt-block:\s*([a-z0-9-]+)\s*-->/
const CLOSE = /<!--\s*\/prompt-block\s*-->/

export async function loadBlock(name) {
  const raw = await readFile(path.join(repoRoot, BLOCK_DIR, `${name}.md`), 'utf8')
  return raw.replace(/\r\n/g, '\n').trimEnd()
}

export async function loadAllBlocks() {
  const files = await readdir(path.join(repoRoot, BLOCK_DIR))
  const names = files
    .filter((file) => file.endsWith('.md') && file !== 'README.md')
    .map((file) => file.slice(0, -3))
  const blocks = new Map()
  for (const name of names.sort()) blocks.set(name, await loadBlock(name))
  return blocks
}

// Returns Map<blockName, text> for every marked region in `source`.
export function extractBlocks(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const found = new Map()
  let current = null
  let buffer = []
  for (const line of lines) {
    const opening = OPEN.exec(line)
    if (opening) {
      current = opening[1]
      buffer = []
      continue
    }
    if (current && CLOSE.test(line)) {
      found.set(current, buffer.join('\n').trim())
      current = null
      continue
    }
    if (current) buffer.push(line)
  }
  return found
}

// The same document with every marked region (and its markers) removed.
export function stripBlocks(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const kept = []
  let inside = false
  for (const line of lines) {
    if (OPEN.test(line)) { inside = true; continue }
    if (inside && CLOSE.test(line)) { inside = false; continue }
    if (!inside) kept.push(line)
  }
  return kept.join('\n')
}
