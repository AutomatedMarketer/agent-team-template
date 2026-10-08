// The tap's own copy of its code, outside every repo.
//
// Claude Code runs the status line after every reply, with no permission prompt. If that command
// ran scripts/usage-tap.mjs straight out of the team repo's working copy, anyone who can push to
// the team repo would choose code that runs on this computer after the next `git pull` - the same
// reason the always-on Mac runs the collector from a checkout pinned by hand. So the installer
// copies the tap and every file it imports into a per-user folder named after a hash of their
// contents, checks the copy byte for byte, and points the status line at the copy. Nothing in the
// copy imports anything outside it. Running the installer again is the deliberate update.

import { readFile, mkdir, writeFile, rm, rename, readdir, rmdir, realpath, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, dirname, basename, resolve, relative, isAbsolute, sep } from 'node:path'

export const COPY_NAME = /^[0-9a-f]{16}-[0-9a-f]{8}$/

export function tapCopyRoot({ home, env = {}, platform }) {
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'agent-status', 'tap')
  return join(home, '.local', 'share', 'agent-status', 'tap')
}

// Every static `import ... from '...'`, `export ... from '...'`, bare `import '...'` and dynamic
// `import('...')`. The tap's files are ours and plain, so this does not need a full parser; what it
// must never do is miss an import and leave one pointing back into the repo, which is why the copy
// is checked again after it is made.
const SPECIFIERS = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm

function specifiersIn(text) {
  return [...text.matchAll(SPECIFIERS)].map((match) => match[1] ?? match[2] ?? match[3])
}

const inside = (base, path) => {
  const rel = relative(base, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

// Returns [{ rel, content }] for the entry and everything it imports, sorted, with `rel` relative
// to the entry's folder in forward slashes. Throws on an import it will not copy.
export async function collectTapFiles(entry) {
  const base = dirname(resolve(entry))
  const found = new Map()
  const queue = [resolve(entry)]
  while (queue.length) {
    const path = queue.shift()
    if (found.has(path)) continue
    const content = await readFile(path)
    found.set(path, content)
    for (const specifier of specifiersIn(content.toString('utf8'))) {
      if (specifier.startsWith('node:')) continue
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
        throw new Error(`the tap imports a package (${specifier}); only node: modules and its own files can be copied`)
      }
      const target = resolve(dirname(path), specifier)
      if (!inside(base, target)) throw new Error('the tap imports a file outside its own folder, so it cannot be copied whole')
      queue.push(target)
    }
  }
  return [...found]
    .map(([path, content]) => ({ rel: relative(base, path).split(sep).join('/'), content }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

export function filesHash(files) {
  const hash = createHash('sha256')
  for (const { rel, content } of files) {
    hash.update(`${rel}\0${content.length}\0`)
    hash.update(content)
  }
  return hash.digest('hex')
}

// Each settings file owns its copy. Two Claude Code profiles (CLAUDE_CONFIG_DIR) installing the same
// tap would otherwise share one content-named folder, and --remove or an update in one would delete
// the copy the other still runs. So the folder is <content hash>-<settings-file hash>.
export async function profileKey(settingsPath, platform = process.platform) {
  let real
  try {
    real = await realpath(settingsPath)
  } catch {
    real = await realpath(dirname(settingsPath)).then((dir) => join(dir, basename(settingsPath)), () => resolve(settingsPath))
  }
  // Windows paths are the same file whatever their case.
  if (platform === 'win32') real = real.toLowerCase()
  return createHash('sha256').update(real).digest('hex').slice(0, 8)
}

export const copyDirFor = (root, files, profile) => join(root, `${filesHash(files).slice(0, 16)}-${profile}`)

// A half-built copy older than this is a crashed install, not one still in progress.
const STALE_BUILD_MS = 3600_000

async function clearStaleBuilds(root, now) {
  let names = []
  try {
    names = await readdir(root)
  } catch {
    return
  }
  for (const name of names) {
    if (!/^[0-9a-f]{16}-[0-9a-f]{8}\.building-\d+$/.test(name)) continue
    const path = join(root, name)
    const age = now - (await stat(path).then((info) => info.mtimeMs, () => now))
    if (age > STALE_BUILD_MS) await rm(path, { recursive: true, force: true }).catch(() => {})
  }
}

// True when `dir` holds exactly these files, byte for byte, and its entry's imports all resolve
// inside it.
async function copyMatches(dir, files) {
  try {
    for (const { rel, content } of files) {
      const copied = await readFile(join(dir, ...rel.split('/')))
      if (!copied.equals(content)) return false
    }
    const again = await collectTapFiles(join(dir, files.find((file) => !file.rel.includes('/')).rel))
    return filesHash(again) === filesHash(files)
  } catch {
    return false
  }
}

// Makes (or checks and keeps) the copy. Returns { dir, repaired }: `repaired` when a copy was
// there but no longer matched and was replaced.
export async function ensureCopy(root, files, profile) {
  const dir = copyDirFor(root, files, profile)
  let repaired = false
  await clearStaleBuilds(root, Date.now())
  if (await copyMatches(dir, files)) return { dir, repaired }
  if (await readdir(dir).then(() => true, () => false)) {
    repaired = true
    await rm(dir, { recursive: true, force: true })
  }
  // Built beside the final folder and renamed into place, so a status line that runs mid-install
  // never finds half a copy.
  const building = `${dir}.building-${process.pid}`
  await rm(building, { recursive: true, force: true })
  for (const { rel, content } of files) {
    const target = join(building, ...rel.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  await rename(building, dir)
  if (!(await copyMatches(dir, files))) {
    await rm(dir, { recursive: true, force: true })
    throw new Error('the copy of the tap did not match its source after it was made')
  }
  return { dir, repaired }
}

// The copy folder a status line command runs, if it is THIS profile's: <root>/<16 hex>-<profile>/
// usage-tap.mjs. A command pointing at another profile's copy (a settings file copied across) is
// not ours to update or delete.
export function copyDirOf(root, tapPath, profile) {
  if (typeof tapPath !== 'string') return null
  const dir = dirname(resolve(tapPath))
  if (dirname(dir) !== resolve(root) || !COPY_NAME.test(basename(dir))) return null
  if (profile && !basename(dir).endsWith(`-${profile}`)) return null
  return dir
}

// Deletes one of our copies, and the copies folder once it is empty. Anything that is not
// <root>/<16 hex>-<8 hex> is left alone.
export async function removeCopy(root, dir) {
  if (!dir || dirname(dir) !== resolve(root) || !COPY_NAME.test(basename(dir))) return
  await rm(dir, { recursive: true, force: true })
  await rmdir(root).catch(() => {})
}
