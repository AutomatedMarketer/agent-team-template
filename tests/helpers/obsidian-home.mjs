// Test helpers for the vaults part: a pretend team folder, a pretend home with Obsidian's list of vaults,
// and a file system that remembers every path it was asked about.

import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises'
import * as nodeFs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { obsidianListPath } from '../../scripts/lib/status/vaults.mjs'
import { makeFakeHome } from './fake-home.mjs'

// A folder standing in for the team repo (or its clone), holding the files named, e.g. 'vaults.yml'.
export async function team(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-vaults-team-'))
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, ...name.split('/').slice(0, -1)), { recursive: true })
    await writeFile(join(dir, ...name.split('/')), content)
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// Folders for each vault under `fake.root/Vaults`, and Obsidian's list of them in the right place for the
// platform, inside an existing pretend home. `vaults` maps a folder name to { files: { 'Folder/Note.md': 'text' },
// asPath }. Returns where the list is and where each vault is.
export async function placeVaults(fake, platform, vaults, { env = {}, raw } = {}) {
  const listPath = obsidianListPath({ home: fake.home, platform, env: { ...env, ...(platform === 'win32' ? { APPDATA: join(fake.home, 'AppData', 'Roaming') } : {}) } })
  const entries = {}
  let index = 0
  const places = {}
  for (const [folder, { files = {}, asPath } = {}] of Object.entries(vaults)) {
    const path = asPath ?? join(fake.root, 'Vaults', folder)
    places[folder] = path
    await mkdir(path, { recursive: true }).catch(() => {})
    for (const [file, text] of Object.entries(files)) {
      await mkdir(join(path, ...file.split('/').slice(0, -1)), { recursive: true })
      await writeFile(join(path, ...file.split('/')), text)
    }
    entries[`id${index += 1}`] = { path, ts: 1760000000000, open: index === 1 }
  }
  await mkdir(join(listPath, '..'), { recursive: true })
  await writeFile(listPath, raw ?? JSON.stringify({ vaults: entries }))
  return { listPath, places }
}

// The allowlist file a computer keeps (see ALLOWED_VAULTS in vaults.mjs): every name given, each allowed up to
// `level`. The test helper spells it so a test says only what it means.
export const ALLOWED_FILE = 'allowed-vaults.yml'
export const allowText = (names, level = 'titles') => ['vaults:', ...names.flatMap((name) => [`  - name: ${name}`, `    level: ${level}`]), ''].join('\n')

// Writes (or, with null, removes) the allowlist in a state folder.
export async function setAllowed(stateDir, text) {
  await mkdir(stateDir, { recursive: true })
  if (text === null) await rm(join(stateDir, ALLOWED_FILE), { force: true })
  else await writeFile(join(stateDir, ALLOWED_FILE), text)
}

// A new pretend home with its vaults placed (see placeVaults) and, by default, an allowlist in its state folder
// that allows every vault placed up to titles - so a test about something else is not about the allowlist.
// `allow` is the text of the allowlist instead, or null for none.
export async function obsidianHome(platform, vaults, { allow, ...options } = {}) {
  const fake = await makeFakeHome()
  const placed = await placeVaults(fake, platform, vaults, options)
  const stateDir = join(fake.root, 'state')
  await setAllowed(stateDir, allow === undefined ? allowText(Object.keys(vaults)) : allow)
  return {
    ...fake,
    ...placed,
    stateDir,
    setAllowed: (text) => setAllowed(stateDir, text),
    depsFor: (extra = {}) => ({ home: fake.home, platform, env: {}, identity: fake.identity, stateDir, ...extra })
  }
}

// A file system that remembers every path it was asked about (`touched`), and what it was asked to do
// with each (`calls`: [operation, path]). `failOn` makes the named operation on a path containing the text
// fail the way a locked file does.
export function recordingFs({ failOn = [] } = {}) {
  const touched = []
  const calls = []
  const wrap = (name) => (path, ...rest) => {
    touched.push(String(path))
    calls.push([name, String(path)])
    const blocked = failOn.find(([operation, part]) => operation === name && String(path).includes(part))
    if (blocked) return Promise.reject(Object.assign(new Error(`locked: ${path}`), { code: 'EACCES' }))
    return nodeFs[name](path, ...rest)
  }
  return { touched, calls, lstat: wrap('lstat'), stat: wrap('stat'), readFile: wrap('readFile'), readdir: wrap('readdir') }
}
