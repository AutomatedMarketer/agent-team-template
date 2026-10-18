// The proof that Claude is confined, and what it is a proof of.
//
// `--selftest` runs the real Claude on this Mac in the runner's exact configuration and checks that it cannot read or write
// outside the work copy. That is only worth something for the Claude Code and the setup it was run with: an update of Claude
// Code, or a change to the flags, the settings or the test itself, can quietly take a protection away. So a pass is kept in
// the state folder together with the Claude version, the real file that was tested (the link Claude Code is found by leads to a
// different file after an update, and two files can say the same version) and a fingerprint of the setup, and the tick refuses
// to run Claude when any of them no longer matches (the order is refused as "not ready" and the log says a self-test is needed).
//
// The fingerprint covers: the two files Claude is started with (settings, connector list), the whole argument list of both
// kinds of run (with the web, without it), the text of the check itself, and the contents of every file of the runner's own code
// (CODE_PARTS). That last part is why a new runner commit needs a new self-test: a change to how Claude is started (its environment,
// how it is run or stopped, the tick's wiring, the prompts it is sent) can quietly take a protection away, and the runner must notice
// that by itself, with no git, from what is on disk.

import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MCP_FILE, SETTINGS_FILE, buildArgv } from './claude.mjs'
import { CODEX_CONFIG_FILE, buildCodexArgv, sandboxProbeArgv } from './codex.mjs'

export const PROOF_FILE = 'selftest.json'

const text = async (path) => (await readFile(path, 'utf8')).replaceAll('\r\n', '\n')
const own = (name) => new URL(name, import.meta.url)

// What the check itself is made of: the self-test, and what it judges a transcript with.
export const CHECK_FILES = Object.freeze(['selftest.mjs', 'evidence.mjs'])
const checkText = () => Promise.all(CHECK_FILES.map((name) => text(own(name))))

// The runner's own code, relative to the code folder: the entry file, every file under the mailbox and status libraries it imports, and the
// prompt files it sends Claude (jobs.mjs). The settings and connector list are covered on their own above.
export const CODE_PARTS = Object.freeze(['scripts/mailbox-runner.mjs', 'scripts/lib/mailbox', 'scripts/lib/status', 'scripts/lib/yaml-lite.mjs', 'scripts/lib/frontmatter.mjs', 'scripts/lib/run-log.mjs', '.agent-team/mailbox/prompts'])

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

// [path, content hash] for every file under a part, in path order, so the same files always give the same list. A link or anything that is not a
// plain file is listed by name with a marker of its own (it could point anywhere), never followed. A part that is not there throws.
async function listCode(codeDir, relative, found) {
  const path = join(codeDir, ...relative.split('/'))
  const info = await lstat(path)
  if (info.isDirectory()) {
    for (const name of (await readdir(path)).sort()) await listCode(codeDir, `${relative}/${name}`, found)
  } else if (info.isFile()) {
    found.push([relative, sha256(await text(path))])
  } else {
    found.push([relative, 'not-a-plain-file'])
  }
  return found
}

export const codeHashes = async (codeDir) => {
  const found = []
  for (const part of CODE_PARTS) await listCode(codeDir, part, found)
  return found.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

// A 64-character hex fingerprint, or null when a part of the setup cannot be read (so nothing can be proven).
// `argv` and `check` are what the runner really uses; a test may hand in others to see the fingerprint move.
export async function configFingerprint(codeDir, { argv = buildArgv, check = checkText } = {}) {
  try {
    const parts = {
      settings: await text(join(codeDir, ...SETTINGS_FILE.split('/'))),
      connectors: await text(join(codeDir, ...MCP_FILE.split('/'))),
      withoutWeb: argv({ prompt: 'x', model: 'sonnet', codeDir, web: false }),
      withWeb: argv({ prompt: 'x', model: 'sonnet', codeDir, web: true }),
      check: await check(),
      code: await codeHashes(codeDir)
    }
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  } catch {
    return null
  }
}

const isVersion = (value) => Array.isArray(value) && value.length === 3 && value.every((part) => Number.isInteger(part) && part >= 0)

const isFile = (value) => typeof value === 'string' && value !== ''

// true when the proof was kept; false (and nothing kept) for a version that is not three numbers, no file, or a setup that cannot be read.
// `file` is the real path of the program the self-test ran (never the link that led to it).
export async function keepProof({ stateDir, codeDir, version, file, now }) {
  const fingerprint = await configFingerprint(codeDir)
  if (fingerprint === null || !isVersion(version) || !isFile(file)) return false
  const path = join(stateDir, PROOF_FILE)
  const temporary = `${path}.${process.pid}.tmp`
  try {
    const at = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    await writeFile(temporary, `${JSON.stringify({ ok: true, at, version, file, fingerprint }, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
    return true
  } catch {
    await rm(temporary, { force: true }).catch(() => {})
    return false
  }
}

export async function dropProof(stateDir) {
  await rm(join(stateDir, PROOF_FILE), { force: true }).catch(() => {})
}

// { holds, at }: whether a kept proof is for this Claude version, this very file and this setup, and when it was made. A proof kept before
// the file was recorded has no file, and does not hold: it cannot say which program it was a proof of.
export const proofHolds = (given) => holding(given, true)

// The same, for whichever file the proof was kept for: a first look at a tick, before a run is claimed, when the file has not been asked for yet.
// It only lets a tick with no proof at all stop early. It never lets a run start: the check just before each run is proofHolds, with the file.
export const proofKept = (given) => holding(given, false)

async function holding({ stateDir, codeDir, version, file }, sameFile) {
  const none = { holds: false, at: null }
  if (!isVersion(version) || (sameFile && !isFile(file))) return none
  let kept
  try {
    kept = JSON.parse(await readFile(join(stateDir, PROOF_FILE), 'utf8'))
  } catch {
    return none
  }
  if (kept === null || typeof kept !== 'object' || kept.ok !== true || typeof kept.at !== 'string' || !isVersion(kept.version)) return none
  if (kept.version.some((part, index) => part !== version[index])) return none
  if (!isFile(kept.file) || (sameFile && kept.file !== file)) return none
  const fingerprint = await configFingerprint(codeDir)
  return fingerprint !== null && kept.fingerprint === fingerprint ? { holds: true, at: kept.at } : none
}

/* ---------- the same, for Codex (codex-selftest.mjs) ------------------------------------------------------------------ */

// Kept in its own file, so a Codex self-test never touches Claude's proof and the other way round. The fingerprint covers what a Codex
// run is made of: the pinned settings file, the argument list of a run and of the sandbox probe (both systems), the text of the check,
// and every file of the runner's own code - so a change to any of them needs a new Codex self-test, found with no git, from the disk.
export const CODEX_PROOF_FILE = 'codex-selftest.json'
export const CODEX_CHECK_FILES = Object.freeze(['codex-selftest.mjs'])

export async function codexFingerprint(codeDir) {
  try {
    const parts = {
      settings: await text(join(codeDir, ...CODEX_CONFIG_FILE.split('/'))),
      run: buildCodexArgv({ prompt: 'x', workDir: join(codeDir, 'work') }),
      probe: [sandboxProbeArgv({ dir: 'p', platform: 'darwin' }), sandboxProbeArgv({ dir: 'p', platform: 'win32' })],
      check: await Promise.all(CODEX_CHECK_FILES.map((name) => text(own(name)))),
      code: await codeHashes(codeDir)
    }
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  } catch {
    return null
  }
}

export async function keepCodexProof({ stateDir, codeDir, version, file, now }) {
  const fingerprint = await codexFingerprint(codeDir)
  if (fingerprint === null || !isVersion(version) || !isFile(file)) return false
  const path = join(stateDir, CODEX_PROOF_FILE)
  const temporary = `${path}.${process.pid}.tmp`
  try {
    const at = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    await writeFile(temporary, `${JSON.stringify({ ok: true, at, version, file, fingerprint }, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
    return true
  } catch {
    await rm(temporary, { force: true }).catch(() => {})
    return false
  }
}

export async function dropCodexProof(stateDir) {
  await rm(join(stateDir, CODEX_PROOF_FILE), { force: true }).catch(() => {})
}

// { holds, at } for this Codex version, this very file and this setup. The first look of a tick uses codexProofKept (no file yet).
export const codexProofHolds = (given) => codexHolding(given, true)
export const codexProofKept = (given) => codexHolding(given, false)

async function codexHolding({ stateDir, codeDir, version, file }, sameFile) {
  const none = { holds: false, at: null }
  if (!isVersion(version) || (sameFile && !isFile(file))) return none
  let kept
  try {
    kept = JSON.parse(await readFile(join(stateDir, CODEX_PROOF_FILE), 'utf8'))
  } catch {
    return none
  }
  if (kept === null || typeof kept !== 'object' || kept.ok !== true || typeof kept.at !== 'string' || !isVersion(kept.version)) return none
  if (kept.version.some((part, index) => part !== version[index])) return none
  if (!isFile(kept.file) || (sameFile && kept.file !== file)) return none
  const fingerprint = await codexFingerprint(codeDir)
  return fingerprint !== null && kept.fingerprint === fingerprint ? { holds: true, at: kept.at } : none
}
