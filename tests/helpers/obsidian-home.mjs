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

// A pretend home with Obsidian's list of vaults in the right place for the platform, and a folder for each.
// `vaults` maps a folder name to { files: { 'Folder/Note.md': 'text' }, asPath }.
export async function obsidianHome(platform, vaults, { env = {}, raw } = {}) {
  const fake = await makeFakeHome()
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
  return { ...fake, listPath, places, depsFor: (extra = {}) => ({ home: fake.home, platform, env: {}, identity: fake.identity, ...extra }) }
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
