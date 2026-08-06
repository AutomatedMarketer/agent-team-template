import { readFile, readdir, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

export function fromRoot(...parts) {
  return path.join(repoRoot, ...parts)
}

export function read(relativePath) {
  return readFile(fromRoot(relativePath), 'utf8')
}

export async function exists(relativePath) {
  try {
    await access(fromRoot(relativePath))
    return true
  } catch {
    return false
  }
}

export async function listDir(relativePath) {
  const entries = await readdir(fromRoot(relativePath), { withFileTypes: true })
  return entries.map((entry) => entry.name).sort()
}

// Every markdown, JSON and script file in the repo, excluding git internals and node_modules.
export async function allTextFiles(startRelative = '.') {
  const found = []
  async function walk(current) {
    const entries = await readdir(fromRoot(current), { withFileTypes: true })
    for (const entry of entries) {
      if (['.git', 'node_modules'].includes(entry.name)) continue
      const next = path.posix.join(current === '.' ? '' : current, entry.name)
      if (entry.isDirectory()) await walk(next)
      else if (/\.(md|json|mjs)$/.test(entry.name)) found.push(next)
    }
  }
  await walk(startRelative)
  return found.sort()
}
