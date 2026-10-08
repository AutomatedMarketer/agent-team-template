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
import { execFile } from 'node:child_process'
import { join, dirname, basename, resolve, relative, isAbsolute, sep } from 'node:path'

export const COPY_NAME = /^[0-9a-f]{16}-[0-9a-f]{8}$/

export function tapCopyRoot({ home, env = {}, platform }) {
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'agent-status', 'tap')
  return join(home, '.local', 'share', 'agent-status', 'tap')
}

// What a copied file may load must be known before it is copied, or the copy could reach back into
// the team repo at run time. Two rules:
//
// 1. Static imports are listed by V8 itself - the same parser that will run the file - so a comment
//    between `from` and the path, or an import spread over lines, cannot hide one. vm's module
//    parser needs a flag, so it runs in a short-lived child Node; the child parses, never runs.
// 2. Every way of loading code that is not a static import is refused outright, wherever the words
//    appear - comments included. Telling a comment from code is exactly what a hand-made scanner
//    gets wrong, and a comment is cheap to reword.
const DYNAMIC_LOADS = [
  [/\bimport\s*\(/, 'import()'],
  [/\brequire\s*\(/, 'require()'],
  [/\bcreateRequire\b/, 'createRequire'],
  [/\bimport\.meta\.resolve\b/, 'import.meta.resolve']
]

const LISTER = [
  "const vm = require('node:vm')",
  "let source = ''",
  "process.stdin.on('data', (chunk) => { source += chunk })",
  "process.stdin.on('end', () => {",
  '  try {',
  '    const parsed = new vm.SourceTextModule(source)',
  '    const specifiers = parsed.moduleRequests ? parsed.moduleRequests.map((request) => request.specifier) : parsed.dependencySpecifiers',
  '    process.stdout.write(JSON.stringify({ ok: true, specifiers }))',
  '  } catch {',
  "    process.stdout.write(JSON.stringify({ ok: false }))",
  '  }',
  '})'
].join('\n')

function staticImportsOf(text) {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(process.execPath, ['--experimental-vm-modules', '--no-warnings', '-e', LISTER], { encoding: 'utf8', timeout: 20_000, windowsHide: true }, (error, stdout) => {
      let answer = null
      try {
        answer = JSON.parse(stdout)
      } catch {
        answer = null
      }
      if (error || !answer?.ok || !Array.isArray(answer.specifiers)) reject(new Error('a tap file could not be parsed, so its imports are not known'))
      else resolvePromise(answer.specifiers)
    })
    child.stdin.end(text)
  })
}

async function specifiersIn(text) {
  for (const [pattern, name] of DYNAMIC_LOADS) {
    if (pattern.test(text)) throw new Error(`the tap uses ${name}, which could load code from outside the copy; only plain static imports can be copied`)
  }
  return staticImportsOf(text)
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
    for (const specifier of await specifiersIn(content.toString('utf8'))) {
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
