import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MCP_FILE, SETTINGS_FILE } from '../scripts/lib/mailbox/claude.mjs'
import { CHECK_FILES, PROOF_FILE, configFingerprint, dropProof, keepProof, proofHolds } from '../scripts/lib/mailbox/proof.mjs'
import { repoRoot } from './helpers/repo.mjs'

/* The self-test proves, on this Mac, that Claude cannot read or write outside the work copy. That proof is only worth
   something for the Claude Code and the settings it was made with, so it is kept with both, and a run is refused when
   either has changed since. */

const at = (folder, relative) => join(folder, ...relative.split('/'))

async function folders() {
  const root = await mkdtemp(join(tmpdir(), 'mailbox-proof-'))
  const code = join(root, 'code')
  const state = join(root, 'state')
  await mkdir(state)
  for (const file of [SETTINGS_FILE, MCP_FILE]) {
    await mkdir(dirname(at(code, file)), { recursive: true })
    await copyFile(at(repoRoot, file), at(code, file))
  }
  return { root, code, state, done: () => rm(root, { recursive: true, force: true }) }
}

test('the fingerprint is the same every time, and changes when the settings, the connector list or any other part of the setup changes', async () => {
  const f = await folders()
  try {
    const first = await configFingerprint(f.code)
    assert.match(first, /^[0-9a-f]{64}$/)
    assert.equal(await configFingerprint(f.code), first)

    const settings = at(f.code, SETTINGS_FILE)
    const original = await readFile(settings, 'utf8')
    await writeFile(settings, original.replace('"blockReadsOutsideWorkingDirectories": true', '"blockReadsOutsideWorkingDirectories": false'))
    const changed = await configFingerprint(f.code)
    assert.notEqual(changed, first, 'a settings change')
    await writeFile(settings, original)
    assert.equal(await configFingerprint(f.code), first, 'put back, it is the same again')

    const mcp = at(f.code, MCP_FILE)
    await writeFile(mcp, JSON.stringify({ mcpServers: { evil: { command: 'x' } } }))
    assert.notEqual(await configFingerprint(f.code), first, 'a connector list change')
  } finally {
    await f.done()
  }
})

test('the fingerprint holds the flags of each kind of run and the text of the check itself: a change to any one of them is a change of setup', async () => {
  const f = await folders()
  try {
    const flags = (change = {}) => ({ web }) => ['--model', 'sonnet', web ? 'with-the-web' : 'without-the-web', ...(change[web ? 'withWeb' : 'withoutWeb'] ?? [])]
    const check = async () => ['the text of the check']
    const base = await configFingerprint(f.code, { argv: flags(), check })
    assert.equal(await configFingerprint(f.code, { argv: flags(), check }), base, 'the same inputs, the same fingerprint')
    assert.notEqual(await configFingerprint(f.code, { argv: flags({ withoutWeb: ['--one-more-flag'] }), check }), base, 'a flag of the sweep\'s run')
    assert.notEqual(await configFingerprint(f.code, { argv: flags({ withWeb: ['--one-more-flag'] }), check }), base, 'a flag of the intel\'s run')
    assert.notEqual(await configFingerprint(f.code, { argv: flags(), check: async () => ['another text'] }), base, 'the check itself')
    assert.equal(await configFingerprint(f.code, { argv: flags(), check: async () => { throw new Error('unreadable') } }), null, 'a check that cannot be read proves nothing')
  } finally {
    await f.done()
  }
})

test('the check itself is the self-test and everything it judges with: each file it imports from the mailbox folder is in the fingerprint', async () => {
  const own = (name) => readFile(join(repoRoot, 'scripts', 'lib', 'mailbox', name), 'utf8')
  assert.deepEqual([...CHECK_FILES], ['selftest.mjs', 'evidence.mjs'])
  const source = await own('selftest.mjs')
  // The files the self-test uses to decide whether a wall held are part of the check; the ones that only start Claude are the setup's own flags.
  assert.ok(source.includes("from './evidence.mjs'"))
  for (const name of CHECK_FILES) assert.ok((await own(name)).length > 0, name)
})

test('line endings do not change the fingerprint: a checkout on another system is the same setup', async () => {
  const f = await folders()
  try {
    const settings = at(f.code, SETTINGS_FILE)
    const original = (await readFile(settings, 'utf8')).replaceAll('\r\n', '\n')
    await writeFile(settings, original)
    const lf = await configFingerprint(f.code)
    await writeFile(settings, original.replaceAll('\n', '\r\n'))
    assert.equal(await configFingerprint(f.code), lf)
  } finally {
    await f.done()
  }
})

test('with a file of the setup missing there is no fingerprint, so nothing can be proven', async () => {
  const f = await folders()
  try {
    await rm(at(f.code, MCP_FILE))
    assert.equal(await configFingerprint(f.code), null)
    assert.equal(await configFingerprint(join(f.root, 'nowhere')), null)
    assert.equal(await keepProof({ stateDir: f.state, codeDir: f.code, version: [2, 1, 290], now: () => Date.parse('2026-10-13T10:00:00Z') }), false)
    assert.equal(await stat(join(f.state, PROOF_FILE)).catch(() => null), null, 'nothing was kept')
  } finally {
    await f.done()
  }
})

test('a proof that was kept holds for the same Claude and the same setup, and for nothing else', async () => {
  const f = await folders()
  try {
    const version = [2, 1, 290]
    assert.deepEqual(await proofHolds({ stateDir: f.state, codeDir: f.code, version }), { holds: false, at: null }, 'none kept yet')
    assert.equal(await keepProof({ stateDir: f.state, codeDir: f.code, version, now: () => Date.parse('2026-10-13T10:00:00Z') }), true)
    assert.deepEqual(await proofHolds({ stateDir: f.state, codeDir: f.code, version }), { holds: true, at: '2026-10-13T10:00:00Z' })
    for (const other of [[2, 1, 291], [2, 1, 289], [2, 2, 290], [3, 1, 290]]) {
      assert.equal((await proofHolds({ stateDir: f.state, codeDir: f.code, version: other })).holds, false, `Claude ${other.join('.')}`)
    }
    for (const bad of [null, undefined, '2.1.290', [2, 1], []]) {
      assert.equal((await proofHolds({ stateDir: f.state, codeDir: f.code, version: bad })).holds, false, String(bad))
    }
    const settings = at(f.code, SETTINGS_FILE)
    await writeFile(settings, `${await readFile(settings, 'utf8')} `)
    assert.equal((await proofHolds({ stateDir: f.state, codeDir: f.code, version })).holds, false, 'the settings changed after the proof')
  } finally {
    await f.done()
  }
})

test('a kept proof names only what it is a proof of - no path, no user name - and is for the owner alone', async () => {
  const f = await folders()
  try {
    await keepProof({ stateDir: f.state, codeDir: f.code, version: [2, 1, 290], now: () => Date.parse('2026-10-13T10:00:00Z') })
    const text = await readFile(join(f.state, PROOF_FILE), 'utf8')
    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['at', 'fingerprint', 'ok', 'version'])
    assert.ok(!text.includes(f.root), 'no path')
    if (process.platform !== 'win32') assert.equal((await stat(join(f.state, PROOF_FILE))).mode & 0o777, 0o600)
  } finally {
    await f.done()
  }
})

test('a proof that is missing, broken, not a pass, or about something else holds for nothing', async () => {
  const f = await folders()
  try {
    const version = [2, 1, 290]
    const fingerprint = await configFingerprint(f.code)
    const good = { ok: true, at: '2026-10-13T10:00:00Z', version, fingerprint }
    const cases = [
      ['broken JSON', '{ not json'],
      ['an array', '[]'],
      ['null', 'null'],
      ['not a pass', JSON.stringify({ ...good, ok: false })],
      ['a pass that is only a word', JSON.stringify({ ...good, ok: 'true' })],
      ['another fingerprint', JSON.stringify({ ...good, fingerprint: 'a'.repeat(64) })],
      ['no fingerprint', JSON.stringify({ ok: true, at: good.at, version })],
      ['a version as text', JSON.stringify({ ...good, version: '2.1.290' })],
      ['a version one short', JSON.stringify({ ...good, version: [2, 1] })],
      ['no day', JSON.stringify({ ...good, at: undefined })]
    ]
    for (const [name, text] of cases) {
      await writeFile(join(f.state, PROOF_FILE), text)
      assert.equal((await proofHolds({ stateDir: f.state, codeDir: f.code, version })).holds, false, name)
    }
    await writeFile(join(f.state, PROOF_FILE), JSON.stringify(good))
    assert.equal((await proofHolds({ stateDir: f.state, codeDir: f.code, version })).holds, true, 'the same file, well formed, holds')
  } finally {
    await f.done()
  }
})

test('a proof is kept only for a version that is three numbers', async () => {
  const f = await folders()
  try {
    for (const bad of [null, undefined, [2, 1], '2.1.290', [2, 1, 'x']]) {
      assert.equal(await keepProof({ stateDir: f.state, codeDir: f.code, version: bad, now: Date.now }), false, String(bad))
    }
    assert.equal(await stat(join(f.state, PROOF_FILE)).catch(() => null), null)
  } finally {
    await f.done()
  }
})

test('dropping a proof removes it, and dropping one that is not there is fine', async () => {
  const f = await folders()
  try {
    await keepProof({ stateDir: f.state, codeDir: f.code, version: [2, 1, 290], now: Date.now })
    await dropProof(f.state)
    assert.equal((await proofHolds({ stateDir: f.state, codeDir: f.code, version: [2, 1, 290] })).holds, false)
    await dropProof(f.state)
    await dropProof(join(f.root, 'no-such-folder'))
  } finally {
    await f.done()
  }
})
