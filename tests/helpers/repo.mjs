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

// Several guards in this suite protect the TEMPLATE by asserting something is still empty -
// the register claims nothing, the brain is all fill markers, the board has no tiles chosen.
// Every one of them would fail a correctly onboarded repo forever, because doing the course is
// exactly what fills those files in. The onboarding state file the installer commits says which
// world we are in, so a guard can retire itself instead of needing hand surgery.
//
// `stage` is the label in the state table's Stage column: "1 · Brief", "2 · Access", and so on.
// A missing state file means the installer has not run, which is the template's own world.
// Split from the file read so it can be tested against real state-file text. A guard that
// retires itself is only as trustworthy as this function, and it cannot be exercised by pointing
// the suite at a temp repo - `read` resolves against this repo root by design.
export function stageDoneIn(stateText, stage) {
  if (typeof stateText !== 'string' || !stateText) return false
  const label = String(stage).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')
  const rows = [
    ...stateText.matchAll(
      new RegExp(`^\\|\\s*\\d+\\s*\\|[^|]+\\|\\s*${label}\\s*\\|\\s*([a-z-]+)\\s*\\|`, 'gm')
    )
  ]
  return rows.length > 0 && rows.every((row) => row[1] === 'done' || row[1] === 'skipped')
}

export async function stageDone(stage) {
  try {
    return stageDoneIn(await read('.agent-team/onboarding-state.md'), stage)
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
