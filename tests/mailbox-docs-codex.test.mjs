import test from 'node:test'
import assert from 'node:assert/strict'
import { read, exists } from './helpers/repo.mjs'
import { CODEX_CONFIG_FILE, CODEX_MINIMUM_VERSION } from '../scripts/lib/mailbox/codex.mjs'
import { USAGE } from '../scripts/lib/mailbox/command.mjs'

/* The guide's Codex part, held to the code like the rest of the guide: the floor is the code's floor, every word in the
   troubleshooting rows is a word the code makes, the switches it names exist, and the settings file it links is the one
   the runner copies. */

const GUIDE = '.agent-team/mailbox/README.md'
const flat = (text) => text.replace(/\s+/g, ' ')

test('the guide names the oldest Codex the runner will start, and that is the floor in the code', async () => {
  const doc = await read(GUIDE)
  assert.ok(doc.includes(`Codex ${CODEX_MINIMUM_VERSION.join('.')} or later`))
  assert.ok(doc.includes(`The walls need Codex ${CODEX_MINIMUM_VERSION.join('.')} or later`))
})

test('every Codex word in the guide is a word the code makes, and every switch it names is one the runner knows', async () => {
  const doc = await read(GUIDE)
  const sources = (await Promise.all(['codex.mjs', 'tick.mjs', 'allow.mjs', 'codex-selftest.mjs', 'command.mjs'].map((name) => read(`scripts/lib/mailbox/${name}`)))).join('\n')
  for (const word of ['worker-not-allowed', 'codex-repo-refused', 'codex-not-logged-in', 'codex-wrong-login', 'codex-too-old', 'codex-no-sandbox', 'codex-key-in-environment', 'codex-selftest-needed', 'codex-failed']) {
    assert.ok(doc.includes(word), `the guide does not show ${word}`)
    assert.ok(sources.includes(`'${word}'`), `the code does not make ${word}`)
  }
  for (const flag of ['--codex-login', '--codex-selftest', '--preflight']) {
    assert.ok(doc.includes(flag), flag)
    assert.ok(USAGE.includes(flag), `the runner does not know ${flag}`)
  }
})

test('the settings file the guide links is the one the runner copies, and the walls it names are in it', async () => {
  const doc = flat(await read(GUIDE))
  assert.ok(doc.includes('](codex-config.toml)'))
  assert.ok(await exists(CODEX_CONFIG_FILE))
  const settings = await read(CODEX_CONFIG_FILE)
  assert.match(settings, /^default_permissions = "mailbox-work"$/m)
  assert.match(settings, /^\[windows\]\nsandbox = "mxc"$/m)
  for (const claim of ['--strict-config', 'workspace-write', 'mxc', 'worker: codex', 'Claude jobs are not affected']) assert.ok(doc.includes(claim), claim)
})

test('the guide says what has been tried on a real computer and what has not', async () => {
  const doc = flat(await read(GUIDE))
  const part = doc.slice(doc.indexOf('## Codex as a second worker'), doc.indexOf('## On a Windows computer'))
  assert.match(part, /the sandbox part of the self-test ran on a Windows 11 25H2 computer with Codex 0\.160\.0, and every wall held/)
  assert.match(part, /The real run has not yet been tried on Windows or on a Mac/)
})
