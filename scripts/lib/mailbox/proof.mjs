// The proof that Claude is confined, and what it is a proof of.
//
// `--selftest` runs the real Claude on this Mac in the runner's exact configuration and checks that it cannot read or write
// outside the work copy. That is only worth something for the Claude Code and the setup it was run with: an update of Claude
// Code, or a change to the flags, the settings or the test itself, can quietly take a protection away. So a pass is kept in
// the state folder together with the Claude version and a fingerprint of the setup, and the tick refuses to run Claude when
// either no longer matches (the order is refused as "not ready" and the log says a self-test is needed).
//
// The fingerprint covers: the two files Claude is started with (settings, connector list), the whole argument list of both
// kinds of run (with the web, without it), and the text of the check itself.

import { createHash } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MCP_FILE, SETTINGS_FILE, buildArgv } from './claude.mjs'

export const PROOF_FILE = 'selftest.json'

const text = async (path) => (await readFile(path, 'utf8')).replaceAll('\r\n', '\n')
const own = (name) => new URL(name, import.meta.url)

// What the check itself is made of: the self-test, and what it judges a transcript with.
export const CHECK_FILES = Object.freeze(['selftest.mjs', 'evidence.mjs'])
const checkText = () => Promise.all(CHECK_FILES.map((name) => text(own(name))))

// A 64-character hex fingerprint, or null when a part of the setup cannot be read (so nothing can be proven).
// `argv` and `check` are what the runner really uses; a test may hand in others to see the fingerprint move.
export async function configFingerprint(codeDir, { argv = buildArgv, check = checkText } = {}) {
  try {
    const parts = {
      settings: await text(join(codeDir, ...SETTINGS_FILE.split('/'))),
      connectors: await text(join(codeDir, ...MCP_FILE.split('/'))),
      withoutWeb: argv({ prompt: 'x', model: 'sonnet', codeDir, web: false }),
      withWeb: argv({ prompt: 'x', model: 'sonnet', codeDir, web: true }),
      check: await check()
    }
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  } catch {
    return null
  }
}

const isVersion = (value) => Array.isArray(value) && value.length === 3 && value.every((part) => Number.isInteger(part) && part >= 0)

// true when the proof was kept; false (and nothing kept) for a version that is not three numbers or a setup that cannot be read.
export async function keepProof({ stateDir, codeDir, version, now }) {
  const fingerprint = await configFingerprint(codeDir)
  if (fingerprint === null || !isVersion(version)) return false
  const path = join(stateDir, PROOF_FILE)
  const temporary = `${path}.${process.pid}.tmp`
  try {
    const at = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z')
    await writeFile(temporary, `${JSON.stringify({ ok: true, at, version, fingerprint }, null, 2)}\n`, { mode: 0o600 })
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

// { holds, at }: whether a kept proof is for this Claude version and this setup, and when it was made.
export async function proofHolds({ stateDir, codeDir, version }) {
  const none = { holds: false, at: null }
  if (!isVersion(version)) return none
  let kept
  try {
    kept = JSON.parse(await readFile(join(stateDir, PROOF_FILE), 'utf8'))
  } catch {
    return none
  }
  if (kept === null || typeof kept !== 'object' || kept.ok !== true || typeof kept.at !== 'string' || !isVersion(kept.version)) return none
  if (kept.version.some((part, index) => part !== version[index])) return none
  const fingerprint = await configFingerprint(codeDir)
  return fingerprint !== null && kept.fingerprint === fingerprint ? { holds: true, at: kept.at } : none
}
