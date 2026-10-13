import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { MCP_FILE, SETTINGS_FILE } from '../scripts/lib/mailbox/claude.mjs'
import { CHECK_FILES, CODE_PARTS, PROOF_FILE, configFingerprint, dropProof, keepProof, proofHolds, proofKept } from '../scripts/lib/mailbox/proof.mjs'
import { repoRoot } from './helpers/repo.mjs'

/* The self-test proves, on this Mac, that Claude cannot read or write outside the work copy. That proof is only worth
   something for the Claude Code and the settings it was made with, so it is kept with both, and a run is refused when
   either has changed since. */

// The real file the self-test ran.
const FILE = '/home/owner/.local/share/claude/versions/2.1.290'
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
  // The runner's own code is part of the setup too: a copy of it, so a test can change one file of it.
  for (const part of CODE_PARTS) {
    await mkdir(dirname(at(code, part)), { recursive: true })
    await cp(at(repoRoot, part), at(code, part), { recursive: true })
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

// One file from each place the runner's code lives.
const CODE_CHANGES = [
  ['the entry file', 'scripts/mailbox-runner.mjs'],
  ['the mailbox library', 'scripts/lib/mailbox/claude.mjs'],
  ['the status library', 'scripts/lib/status/programs.mjs'],
  ['the prompts the runner sends Claude', '.agent-team/mailbox/prompts/run.md']
]

test("a change to any one file of the runner's own code - the entry file, the mailbox library, the status library, a prompt - is a change of setup: the fingerprint moves and the kept proof no longer holds", async () => {
  const f = await folders()
  try {
    const version = [2, 1, 290]
    assert.equal(await keepProof({ stateDir: f.state, codeDir: f.code, version, file: FILE, now: () => Date.parse('2026-10-13T10:00:00Z') }), true)
    const base = await configFingerprint(f.code)
    assert.equal((await proofHolds({ stateDir: f.state, codeDir: f.code, version, file: FILE })).holds, true)
    for (const [what, relative] of CODE_CHANGES) {
      const path = at(f.code, relative)
      const original = await readFile(path, 'utf8')
      await writeFile(path, `${original}\n// changed\n`)
      assert.notEqual(await configFingerprint(f.code), base, `${what} changed`)
      assert.equal((await proofHolds({ stateDir: f.state, codeDir: f.code, version, file: FILE })).holds, false, `${what} changed: the old proof must not hold`)
      await writeFile(path, original)
      assert.equal((await proofHolds({ stateDir: f.state, codeDir: f.code, version, file: FILE })).holds, true, `${what} put back`)
    }
  } finally {
    await f.done()
  }
})

test('a new file in the code folders, or one taken away, is a change of setup, and the order the files were made in does not matter', async () => {
  const f = await folders()
  try {
    const base = await configFingerprint(f.code)
    const extra = at(f.code, 'scripts/lib/mailbox/zz-new.mjs')
    await writeFile(extra, 'export {}\n')
    assert.notEqual(await configFingerprint(f.code), base, 'a new file')
    await rm(extra)
    assert.equal(await configFingerprint(f.code), base, 'taken away again')
    const gone = at(f.code, 'scripts/lib/status/util.mjs')
    const kept = await readFile(gone, 'utf8')
    await rm(gone)
    assert.notEqual(await configFingerprint(f.code), base, 'a file taken away')
    await writeFile(gone, kept)
    assert.equal(await configFingerprint(f.code), base, 'put back later, so made in another order: the same')
  } finally {
    await f.done()
  }
})

test('with a folder of the runner code missing there is no fingerprint, so nothing can be proven', async () => {
  const f = await folders()
  try {
    await rm(at(f.code, 'scripts/lib/status'), { recursive: true })
    assert.equal(await configFingerprint(f.code), null)
  } finally {
    await f.done()
  }
})

test('the fingerprint covers every file the runner can load: following the imports from the entry file, nothing lies outside the covered places', async () => {
  const covered = (relative) => CODE_PARTS.some((part) => relative === part || relative.startsWith(`${part}/`))
  const seen = new Set()
  const queue = ['scripts/mailbox-runner.mjs']
  while (queue.length) {
    const relative = queue.pop()
    if (seen.has(relative)) continue
    seen.add(relative)
    assert.ok(covered(relative), `${relative} is loaded by the runner and the fingerprint does not cover it`)
    const source = await readFile(at(repoRoot, relative), 'utf8')
    for (const match of source.matchAll(/from '(\.[^']+)'/g)) queue.push(posix.join(posix.dirname(relative), match[1]))
  }
  assert.ok(seen.size > 30, 'the walk found the runner files')
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
    assert.equal(await keepProof({ stateDir: f.state, codeDir: f.code, version: [2, 1, 290], file: FILE, now: () => Date.parse('2026-10-13T10:00:00Z') }), false)
    assert.equal(await stat(join(f.state, PROOF_FILE)).catch(() => null), null, 'nothing was kept')
  } finally {
    await f.done()
  }
})

test('a proof that was kept holds for the same Claude and the same setup, and for nothing else', async () => {
  const f = await folders()
  try {
    const version = [2, 1, 290]
    assert.deepEqual(await proofHolds({ stateDir: f.state, codeDir: f.code, version, file: FILE }), { holds: false, at: null }, 'none kept yet')
    assert.equal(await keepProof({ stateDir: f.state, codeDir: f.code, version, file: FILE, now: () => Date.parse('2026-10-13T10:00:00Z') }), true)
    assert.deepEqual(await proofHolds({ stateDir: f.state, codeDir: f.code, version, file: FILE }), { holds: true, at: '2026-10-13T10:00:00Z' })
    for (const other of [[2, 1, 291], [2, 1, 289], [2, 2, 290], [3, 1, 290]]) {
      assert.equal((await proofHolds({ stateDir: f.state, codeDir: f.code, version: other, file: FILE })).holds, false, `Claude ${other.join('.')}`)
    }
    for (const bad of [null, undefined, '2.1.290', [2, 1], []]) {
      assert.equal((await proofHolds({ stateDir: f.state, codeDir: f.code, version: bad, file: FILE })).holds, false, String(bad))
    }
    const settings = at(f.code, SETTINGS_FILE)
    await writeFile(settings, `${await readFile(settings, 'utf8')} `)
    assert.equal((await proofHolds({ stateDir: f.state, codeDir: f.code, version, file: FILE })).holds, false, 'the settings changed after the proof')
  } finally {
    await f.done()
  }
})

test('a kept proof names only what it is a proof of - no path, no user name - and is for the owner alone', async () => {
  const f = await folders()
  try {
    await keepProof({ stateDir: f.state, codeDir: f.code, version: [2, 1, 290], file: FILE, now: () => Date.parse('2026-10-13T10:00:00Z') })
    const text = await readFile(join(f.state, PROOF_FILE), 'utf8')
    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['at', 'file', 'fingerprint', 'ok', 'version'])
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
    const good = { ok: true, at: '2026-10-13T10:00:00Z', version, file: FILE, fingerprint }
    const cases = [
      ['broken JSON', '{ not json'],
      ['an array', '[]'],
      ['null', 'null'],
      ['not a pass', JSON.stringify({ ...good, ok: false })],
      ['a pass that is only a word', JSON.stringify({ ...good, ok: 'true' })],
      ['another fingerprint', JSON.stringify({ ...good, fingerprint: 'a'.repeat(64) })],
      ['no file (a proof kept before the file was recorded)', JSON.stringify({ ok: true, at: good.at, version, fingerprint })],
      ['a file that is not text', JSON.stringify({ ...good, file: 42 })],
      ['an empty file', JSON.stringify({ ...good, file: '' })],
      ['no fingerprint', JSON.stringify({ ok: true, at: good.at, version })],
      ['a version as text', JSON.stringify({ ...good, version: '2.1.290' })],
      ['a version one short', JSON.stringify({ ...good, version: [2, 1] })],
      ['no day', JSON.stringify({ ...good, at: undefined })]
    ]
    for (const [name, text] of cases) {
      await writeFile(join(f.state, PROOF_FILE), text)
      assert.equal((await proofHolds({ stateDir: f.state, codeDir: f.code, version, file: FILE })).holds, false, name)
    }
    await writeFile(join(f.state, PROOF_FILE), JSON.stringify(good))
    assert.equal((await proofHolds({ stateDir: f.state, codeDir: f.code, version, file: FILE })).holds, true, 'the same file, well formed, holds')
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
    await keepProof({ stateDir: f.state, codeDir: f.code, version: [2, 1, 290], file: FILE, now: Date.now })
    await dropProof(f.state)
    assert.equal((await proofHolds({ stateDir: f.state, codeDir: f.code, version: [2, 1, 290], file: FILE })).holds, false)
    await dropProof(f.state)
    await dropProof(join(f.root, 'no-such-folder'))
  } finally {
    await f.done()
  }
})

test('a proof kept for one file does not hold for another file that reports the same version: the program tested is the program that starts', async () => {
  const f = await folders()
  try {
    const version = [2, 1, 290]
    const other = '/home/owner/.local/share/claude/versions/2.1.290-copy'
    await keepProof({ stateDir: f.state, codeDir: f.code, version, file: FILE, now: () => Date.parse('2026-10-13T10:00:00Z') })
    assert.equal((await proofHolds({ stateDir: f.state, codeDir: f.code, version, file: FILE })).holds, true, 'the same file')
    assert.equal((await proofHolds({ stateDir: f.state, codeDir: f.code, version, file: other })).holds, false, 'another file, the same version')
    assert.equal((await proofHolds({ stateDir: f.state, codeDir: f.code, version, file: FILE.toUpperCase() })).holds, false, 'the path must be the same exactly, not alike')
    for (const none of [undefined, null, '', 42]) assert.equal((await proofHolds({ stateDir: f.state, codeDir: f.code, version, file: none })).holds, false, `no file asked: ${none}`)
  } finally {
    await f.done()
  }
})

test('a proof is kept only for a real file path: without one nothing is kept', async () => {
  const f = await folders()
  try {
    for (const bad of [undefined, null, '', 42]) {
      assert.equal(await keepProof({ stateDir: f.state, codeDir: f.code, version: [2, 1, 290], file: bad, now: Date.now }), false, String(bad))
    }
    assert.equal(await stat(join(f.state, PROOF_FILE)).catch(() => null), null)
  } finally {
    await f.done()
  }
})

test('a proof kept in the old form, with a version and a fingerprint and no file, holds for nothing - not even for a first look at a tick', async () => {
  const f = await folders()
  try {
    const version = [2, 1, 290]
    const fingerprint = await configFingerprint(f.code)
    await writeFile(join(f.state, PROOF_FILE), JSON.stringify({ ok: true, at: '2026-10-13T10:00:00Z', version, fingerprint }))
    assert.equal((await proofHolds({ stateDir: f.state, codeDir: f.code, version, file: FILE })).holds, false)
    assert.equal((await proofKept({ stateDir: f.state, codeDir: f.code, version })).holds, false)
    await keepProof({ stateDir: f.state, codeDir: f.code, version, file: FILE, now: () => Date.parse('2026-10-13T10:00:00Z') })
    assert.equal((await proofKept({ stateDir: f.state, codeDir: f.code, version })).holds, true, 'the first look: a proof of this version for some file')
    assert.equal((await proofKept({ stateDir: f.state, codeDir: f.code, version: [2, 1, 291] })).holds, false, 'but not for another version')
  } finally {
    await f.done()
  }
})
