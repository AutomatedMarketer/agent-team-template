import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, symlink, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { runCollector, partsFrom, summarizeVaults, vaultsStatuses } from '../scripts/lib/status/run.mjs'
import { PARTS, RECEIPT_SHAPE } from '../scripts/lib/status/schema.mjs'
import { checkAgainst, checkVaults } from '../scripts/lib/status/safe.mjs'
import { VAULTS_SCHEMA, VAULTS_WHY, REWRITE_AFTER_HOURS } from '../scripts/lib/status/vaults-schema.mjs'
import { stringifyVaults } from '../scripts/lib/status/vaults.mjs'
import { makeFakeHome, FAKE_EMAIL, FAKE_USERNAME, fakeClaudeToken } from './helpers/fake-home.mjs'
import { hostileHome, FORBIDDEN, depsFor, filesUnder, NOW } from './helpers/hostile-home.mjs'
import { placeVaults, recordingFs, setAllowed, allowText, ALLOWED_FILE } from './helpers/obsidian-home.mjs'
import { git } from './helpers/git.mjs'

/* The vaults part inside a run: --only vaults, the file written beside the other parts behind the same gate
   and link checks, in the same commit, the receipt and the log saying statuses and counts only. A vault is
   pretended with a folder of notes and Obsidian's own list of vaults in a fake home; real git runs against a
   throwaway bare remote, as tests/status-parts.test.mjs does - no network. */

const fixture = JSON.parse(readFileSync(new URL('./fixtures/vaults-parity.json', import.meta.url), 'utf8'))
const VAULTS = '.agent-team/status/vaults/test-pc.json'
const USAGE = '.agent-team/status/usage/test-pc.json'
const CONNECTIONS = '.agent-team/status/connections/test-pc.json'
const HERMES = '.agent-team/status/hermes/test-pc.json'
const JOBS = '.agent-team/status/jobs/test-pc.json'
const HOUR = 3600_000

const relativeFiles = async (target) => (await filesUnder(target)).map((file) => file.slice(target.length + 1).replaceAll('\\', '/')).sort()
const readAt = async (target, relative) => JSON.parse(await readFile(join(target, ...relative.split('/')), 'utf8'))
const textAt = (target, relative) => readFile(join(target, ...relative.split('/')), 'utf8')

const NOTES = {
  'Pear harvest.md': '---\ntags: [orchard, autumn]\ndate: 2026-10-01\n---\nPick the pears. See [[Apple store]].',
  'Apple store.md': '---\ntags: [orchard]\ndate: 2026-10-01\n---\nCold room.',
  'Beds/Raised bed.md': 'Soil. [Pears](../Pear%20harvest.md)',
  'Lonely idea.md': 'Nobody links here.'
}
const ORCHARD = 'Orchard Notes'
const YML_SHAPE = `vaults:\n  - name: ${ORCHARD}\n`
const YML_TITLES = `vaults:\n  - name: ${ORCHARD}\n    level: titles\n`

// Where the collector looks for the computer's allowlist when it is not told another state folder.
const defaultState = (fake) => join(fake.home, '.local', 'state', 'agent-status-collector')

// A pretend home (Linux, so no Mac programs are needed) with the vaults placed, Obsidian's list written and, by
// default, an allowlist that allows every vault placed up to titles - so a test about something else is not
// about the allowlist. `allow` is the allowlist's text instead, or null for none.
async function aHome(vaults = { [ORCHARD]: { files: NOTES } }, { raw, allow } = {}) {
  const fake = await makeFakeHome()
  const placed = await placeVaults(fake, 'linux', vaults, { raw })
  fake.allowedText = allow === undefined ? allowText(Object.keys(vaults)) : allow
  await setAllowed(defaultState(fake), fake.allowedText)
  return { fake, ...placed }
}

async function run(fake, args, { target = null, extra = {}, yml } = {}) {
  target = target ?? (await mkdtemp(join(tmpdir(), 'agent-status-repo-')))
  if (yml !== undefined) await writeFile(join(target, 'vaults.yml'), yml)
  const stdout = []
  const stderr = []
  const code = await runCollector({
    argv: ['--computer', 'Test PC', ...args],
    deps: depsFor(fake, extra),
    repoRoot: target,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line)
  })
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), target }
}

async function collect(fake, args, { repo, stateDir, extra = {} }) {
  // The state folder is the one the run was told to use, so the allowlist goes there.
  if (fake.allowedText !== undefined) await setAllowed(stateDir, fake.allowedText)
  const stdout = []
  const stderr = []
  const code = await runCollector({
    argv: ['--computer', 'Test PC', '--state-dir', stateDir, ...args],
    deps: depsFor(fake, { git: (gitArgs, cwd) => git(gitArgs, cwd), ...extra }),
    repoRoot: repo,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line)
  })
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
}

async function makeRemote(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-vaults-'))
  const remote = join(root, 'remote.git')
  await git(['init', '--bare', '-q', '-b', 'main', remote], root)
  const clone = async (name) => {
    const dir = join(root, name)
    await git(['clone', '-q', remote, dir], root)
    await git(['config', 'user.name', 'Collector Test'], dir)
    await git(['config', 'user.email', 'collector-test' + '@' + 'invalid'], dir)
    await git(['config', 'commit.gpgsign', 'false'], dir)
    await git(['checkout', '-q', '-B', 'main'], dir)
    return dir
  }
  const seed = await clone('seed')
  await writeFile(join(seed, 'README.md'), 'team\n')
  for (const [name, content] of Object.entries(files)) await writeFile(join(seed, name), content)
  await git(['add', '.'], seed)
  await git(['commit', '-q', '-m', 'start'], seed)
  await git(['push', '-q', '-u', 'origin', 'main'], seed)
  const work = await clone('work')
  await git(['branch', '-q', '--set-upstream-to=origin/main', 'main'], work)
  return { root, remote, work, clone, cleanup: () => rm(root, { recursive: true, force: true }) }
}

// --- the part list and the log -----------------------------------------------------------------------------------------

test('the parts are usage, connections, hermes, jobs and vaults; --only vaults is a part, in any order', () => {
  assert.deepEqual(PARTS, ['usage', 'connections', 'hermes', 'jobs', 'vaults'])
  assert.deepEqual(partsFrom('vaults'), { parts: ['vaults'] })
  assert.deepEqual(partsFrom('vaults,usage'), { parts: ['usage', 'vaults'] })
  assert.deepEqual(partsFrom('jobs, vaults ,connections'), { parts: ['connections', 'jobs', 'vaults'] })
  assert.deepEqual(partsFrom(undefined), { parts: ['usage', 'connections', 'hermes', 'jobs', 'vaults'] })
  assert.ok(partsFrom('vaults,bogus').refusal)
  assert.match(partsFrom('bogus').refusal, /usage, connections, hermes, jobs, vaults/)
})

test('the log counts vaults, notes and lines - never a vault name, a title or a path', () => {
  assert.deepEqual(summarizeVaults(fixture.sample), [
    '- Vaults found: 2 listed (1 at titles, 1 at shape), 0 hidden, 0 more',
    '- Notes: 11 drawn, 1 withheld, 0 past the caps',
    '- Lines: 11 drawn, 0 cut by the caps, 3 notes with no link'
  ])
  const text = summarizeVaults(fixture.sample).join('\n')
  for (const word of ['Field Notes', 'Ideas', 'Shopping', 'Garden', 'Plans']) assert.ok(!text.includes(word), `the log says ${word}`)
  const doc = (vaults) => ({ ...fixture.sample, vaults })
  assert.deepEqual(summarizeVaults(doc({ status: 'not found' })), ['- Vaults not found: none is both allowed on this computer and named in vaults.yml, or none of them is here'])
  assert.deepEqual(summarizeVaults(doc({ status: 'unavailable', why: VAULTS_WHY.unreadable })), ['- Vaults unavailable (could not be read)'])
  assert.deepEqual(vaultsStatuses(fixture.sample), { vaults: 'found', items: 2 })
  assert.deepEqual(vaultsStatuses(doc({ status: 'not found' })), { vaults: 'not found', items: 0 })
  assert.deepEqual(vaultsStatuses(doc({ status: 'unavailable', why: VAULTS_WHY.refused })), { vaults: 'unavailable', items: 0 })
})

// --- one run -----------------------------------------------------------------------------------------------------------------

test('--only vaults with nothing named writes no file, opens neither Obsidian\'s list nor a vault, and says so', async () => {
  const { fake } = await aHome()
  const fs = recordingFs()
  try {
    for (const yml of ['vaults: []\n', undefined]) {
      const result = await run(fake, ['--only', 'vaults'], { yml, extra: { fs } })
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(await filesUnder(result.target), yml === undefined ? [] : [join(result.target, 'vaults.yml')])
      assert.match(result.stdout, /^Vaults:$/m)
      assert.match(result.stdout, /- Vaults not found: none is both allowed on this computer and named in vaults.yml/)
      assert.match(result.stdout, /No file written: nothing to draw here, and no earlier file to replace/)
      assert.match(result.stdout, /The allowlist on this computer .* names no vault|is both allowed/)
      assert.match(result.stdout, /Nothing changed since the last snapshot, so nothing was written/)
      await rm(result.target, { recursive: true, force: true })
    }
    // The allowlist, vaults.yml, and the earlier vaults file (to know there is none): nothing of Obsidian's,
    // nothing of a vault.
    assert.ok(fs.touched.every((path) => path.endsWith('vaults.yml') || path.endsWith('test-pc.json') || path.endsWith(ALLOWED_FILE)), JSON.stringify(fs.touched))
    assert.ok(!fs.touched.some((path) => path.includes('obsidian') || path.includes(ORCHARD)))
  } finally {
    await fake.cleanup()
  }
})

test('--only vaults at shape writes the file - dots and lines, in rows - and the log says counts only', async () => {
  const { fake, places } = await aHome()
  try {
    const result = await run(fake, ['--only', 'vaults'], { yml: YML_SHAPE })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual((await relativeFiles(result.target)).filter((file) => file !== 'vaults.yml'), [VAULTS])
    assert.match(result.stdout, /Snapshot for Test PC\. Wrote \.agent-team\/status\/vaults\/test-pc\.json/)
    const text = await textAt(result.target, VAULTS)
    const doc = JSON.parse(text)
    assert.equal(text, stringifyVaults(doc), 'written the way the collector writes it')
    assert.equal(doc.schema, VAULTS_SCHEMA)
    assert.equal(doc.computer, 'Test PC')
    assert.equal(doc.takenAt, new Date(NOW).toISOString().replace('.000Z', 'Z'))
    assert.deepEqual(checkVaults(doc, fake.identity), [])
    const [item] = doc.vaults.items
    assert.deepEqual({ name: item.name, level: item.level, notes: item.notes, lines: item.lines, lonely: item.lonely }, { name: ORCHARD, level: 'shape', notes: 4, lines: 2, lonely: 1 })
    assert.equal(item.nodes, undefined)
    for (const word of ['Pear', 'Apple', 'Raised', 'Lonely', 'orchard', 'autumn', 'Beds']) assert.ok(!text.includes(word), `the shape file holds ${word}`)
    assert.match(result.stdout, /^Vaults:$/m)
    assert.match(result.stdout, /- Vaults found: 1 listed \(0 at titles, 1 at shape\), 0 hidden, 0 more/)
    assert.match(result.stdout, /- Notes: 4 drawn, 0 withheld, 0 past the caps/)
    assert.match(result.stdout, /- Lines: 2 drawn, 0 cut by the caps, 1 notes with no link/)
    const talk = result.stdout + result.stderr
    for (const word of [ORCHARD, 'Pear', 'Apple', 'Raised', places[ORCHARD], fake.root]) assert.ok(!talk.includes(word), `the log says ${word}`)
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('--only vaults at titles writes titles, folders, days and tags to the file - and still not one of them to the log', async () => {
  const { fake } = await aHome()
  try {
    const result = await run(fake, ['--only', 'vaults'], { yml: YML_TITLES })
    assert.equal(result.code, 0, result.stderr)
    const doc = await readAt(result.target, VAULTS)
    assert.deepEqual(checkVaults(doc, fake.identity), [])
    const [item] = doc.vaults.items
    assert.equal(item.level, 'titles')
    assert.deepEqual(item.nodes.map((node) => node.title).sort(), ['Apple store', 'Lonely idea', 'Pear harvest', 'Raised bed'])
    assert.deepEqual(item.hubs, [{ kind: 'day', label: '2026-10-01' }, { kind: 'tag', label: 'orchard' }])
    const talk = result.stdout + result.stderr
    for (const word of ['Pear', 'Apple', 'Raised', 'Lonely', 'orchard', '2026-10-01', ORCHARD]) assert.ok(!talk.includes(word), `the log says ${word}`)
    assert.match(result.stdout, /- Vaults found: 1 listed \(1 at titles, 0 at shape\)/)
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('--dry-run prints the vaults file and where it would go, and writes nothing; at shape it holds no title', async () => {
  const { fake } = await aHome()
  try {
    const shape = await run(fake, ['--only', 'vaults', '--dry-run'], { yml: YML_SHAPE })
    assert.equal(shape.code, 0, shape.stderr)
    assert.deepEqual(await relativeFiles(shape.target), ['vaults.yml'])
    assert.match(shape.stdout, /"schema": "agent-status\/vaults\/v1"/)
    assert.match(shape.stdout, /It would go to \.agent-team\/status\/vaults\/test-pc\.json/)
    assert.match(shape.stdout, /- Notes: 4 drawn/)
    for (const word of ['Pear', 'Apple', 'Raised', 'Lonely', 'orchard']) assert.ok(!shape.stdout.includes(word), `the dry run at shape holds ${word}`)
    await rm(shape.target, { recursive: true, force: true })

    const none = await run(fake, ['--only', 'vaults', '--dry-run'], { yml: 'vaults: []\n' })
    assert.equal(none.code, 0, none.stderr)
    assert.match(none.stdout, /"status": "not found"/)
    assert.match(none.stdout, /would write nothing for it/)
    await rm(none.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('a run with no --only writes the four older parts and, when a vault is named, the vaults file too; --help names the part', async () => {
  const { fake } = await aHome()
  try {
    const named = await run(fake, [], { yml: YML_SHAPE })
    assert.equal(named.code, 0, named.stderr)
    assert.deepEqual((await relativeFiles(named.target)).filter((file) => file !== 'vaults.yml'), [CONNECTIONS, HERMES, JOBS, USAGE, VAULTS])
    await rm(named.target, { recursive: true, force: true })

    const unnamed = await run(fake, [], { yml: 'vaults: []\n' })
    assert.equal(unnamed.code, 0, unnamed.stderr)
    assert.deepEqual((await relativeFiles(unnamed.target)).filter((file) => file !== 'vaults.yml'), [CONNECTIONS, HERMES, JOBS, USAGE], 'a vaults file was written with nothing named')
    await rm(unnamed.target, { recursive: true, force: true })

    const help = await run(fake, ['--help'])
    assert.equal(help.code, 0)
    assert.match(help.stdout, /--only usage,connections,hermes,jobs,vaults/)
    assert.match(help.stdout, /vaults: .*Only a vault this computer allows/s)
    assert.match(help.stdout, /allowed-vaults\.yml/)
    assert.match(help.stdout, /no note text is kept/)
    assert.match(help.stdout, /No allowlist: nothing is read/)
    await rm(help.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

// --- written only when it changed, or when a day old ----------------------------------------------------------------------------

test('the vaults file is not rewritten while nothing changed and it is under a day old; the other parts are', async () => {
  const { fake } = await aHome()
  try {
    const first = await run(fake, [], { yml: YML_SHAPE })
    assert.equal(first.code, 0, first.stderr)
    const { target } = first
    const before = await textAt(target, VAULTS)
    const usageBefore = await textAt(target, USAGE)

    const later = await run(fake, [], { target, extra: { now: NOW + 5 * HOUR } })
    assert.equal(later.code, 0, later.stderr)
    assert.equal(await textAt(target, VAULTS), before, 'the vaults file was rewritten although nothing changed')
    assert.notEqual(await textAt(target, USAGE), usageBefore, 'the usage file was left as it was')
    assert.ok(!later.stdout.includes('Wrote .agent-team/status/vaults'), later.stdout)
    assert.match(later.stdout, /Wrote \.agent-team\/status\/usage\/test-pc\.json/)
    assert.match(later.stdout, /Not rewritten: nothing changed and the file is under 24 hours old/)
    assert.match(later.stdout, /- Vaults found: 1 listed/, 'the log still says what the vault is')

    // Just under a day: still left alone. A day: rewritten, the same graph with a new time.
    const almost = await run(fake, ['--only', 'vaults'], { target, extra: { now: NOW + REWRITE_AFTER_HOURS * HOUR - 1000 } })
    assert.equal(await textAt(target, VAULTS), before)
    assert.match(almost.stdout, /Nothing changed since the last snapshot, so nothing was written/)
    const aDay = await run(fake, ['--only', 'vaults'], { target, extra: { now: NOW + REWRITE_AFTER_HOURS * HOUR } })
    assert.equal(aDay.code, 0, aDay.stderr)
    const refreshed = await readAt(target, VAULTS)
    assert.equal(refreshed.takenAt, new Date(NOW + REWRITE_AFTER_HOURS * HOUR).toISOString().replace('.000Z', 'Z'))
    assert.deepEqual(refreshed.vaults, JSON.parse(before).vaults)
    assert.match(aDay.stdout, /Wrote \.agent-team\/status\/vaults\/test-pc\.json/)
    await rm(target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('a vault that changed is rewritten at once, whatever the age of the file: a note, a link, a level or a computer label', async () => {
  const { fake, places } = await aHome()
  try {
    const first = await run(fake, ['--only', 'vaults'], { yml: YML_SHAPE })
    const { target } = first
    const soon = { now: NOW + HOUR }
    const wrote = async (args, extra) => {
      const result = await run(fake, args, { target, extra: { ...soon, ...extra } })
      assert.equal(result.code, 0, result.stderr)
      return result.stdout.includes('Wrote .agent-team/status/vaults/test-pc.json')
    }
    assert.equal(await wrote(['--only', 'vaults']), false, 'unchanged')

    await writeFile(join(places[ORCHARD], 'New note.md'), 'A new note. [[Pear harvest]]')
    assert.equal(await wrote(['--only', 'vaults']), true, 'a new note')
    assert.equal(await wrote(['--only', 'vaults']), false, 'and then unchanged again')

    await writeFile(join(places[ORCHARD], 'New note.md'), 'A new note. [[Apple store]]')
    assert.equal(await wrote(['--only', 'vaults']), true, 'a link that moved')
    assert.equal(await wrote(['--only', 'vaults']), false)

    await writeFile(join(target, 'vaults.yml'), YML_TITLES)
    assert.equal(await wrote(['--only', 'vaults']), true, 'the level')
    assert.equal(await wrote(['--only', 'vaults']), false)

    // The same file name for the same computer, written under another label, is a changed file.
    assert.equal(await wrote(['--only', 'vaults', '--computer', 'Test-PC']), true, 'the label')
    await rm(target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('an earlier file that cannot be trusted is rewritten: from the future, not JSON, too big, or not a vaults file', async () => {
  const { fake } = await aHome()
  try {
    const first = await run(fake, ['--only', 'vaults'], { yml: YML_SHAPE })
    const { target } = first
    const good = await textAt(target, VAULTS)
    const doc = JSON.parse(good)
    const cases = {
      future: JSON.stringify({ ...doc, takenAt: new Date(NOW + 3 * HOUR).toISOString().replace('.000Z', 'Z') }),
      'not JSON': '{ not json',
      'too big': ' '.repeat(300 * 1024),
      array: '[]',
      'no time': JSON.stringify({ ...doc, takenAt: undefined }),
      'a time that is not a time': JSON.stringify({ ...doc, takenAt: 'yesterday' })
    }
    for (const [what, text] of Object.entries(cases)) {
      await writeFile(join(target, ...VAULTS.split('/')), text)
      const result = await run(fake, ['--only', 'vaults'], { target, extra: { now: NOW + HOUR } })
      assert.equal(result.code, 0, `${what}: ${result.stderr}`)
      assert.match(result.stdout, /Wrote \.agent-team\/status\/vaults\/test-pc\.json/, what)
      assert.equal((await readAt(target, VAULTS)).computer, 'Test PC', what)
    }
    await rm(target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('nothing named but a file from earlier: the file is replaced by "not found" once, and then left alone', async () => {
  const { fake } = await aHome()
  try {
    const first = await run(fake, ['--only', 'vaults'], { yml: YML_SHAPE })
    const { target } = first
    assert.equal((await readAt(target, VAULTS)).vaults.status, 'found')
    await writeFile(join(target, 'vaults.yml'), 'vaults: []\n')
    const second = await run(fake, ['--only', 'vaults'], { target, extra: { now: NOW + HOUR } })
    assert.equal(second.code, 0, second.stderr)
    assert.deepEqual((await readAt(target, VAULTS)).vaults, { status: 'not found' })
    const text = await textAt(target, VAULTS)
    const third = await run(fake, ['--only', 'vaults'], { target, extra: { now: NOW + 2 * HOUR } })
    assert.equal(await textAt(target, VAULTS), text)
    assert.match(third.stdout, /Nothing changed since the last snapshot/)
    await rm(target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('a list of vaults that cannot be read is written as unavailable, with the fixed reason and no word of what it held', async () => {
  const { fake } = await aHome({}, { raw: `{ not json ${fakeClaudeToken()} ${FAKE_EMAIL}`, allow: allowText([ORCHARD]) })
  try {
    const result = await run(fake, ['--only', 'vaults'], { yml: YML_SHAPE })
    assert.equal(result.code, 0, result.stderr)
    const doc = await readAt(result.target, VAULTS)
    assert.deepEqual(doc.vaults, { status: 'unavailable', why: VAULTS_WHY.unreadable })
    assert.match(result.stdout, /- Vaults unavailable \(could not be read\)/)
    const everything = result.stdout + result.stderr + JSON.stringify(doc)
    assert.ok(!everything.includes('sk-') && !everything.includes(FAKE_EMAIL))
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

// --- the gate and the links ----------------------------------------------------------------------------------------------------

const leakyVaults = async (deps, computer) => ({
  schema: VAULTS_SCHEMA,
  takenAt: '2026-10-07T20:00:00Z',
  computer,
  vaults: {
    status: 'found',
    items: [{ name: `Notes of ${FAKE_EMAIL}`, level: 'shape', notes: 1, lines: 0, lonely: 1, hidden: 0, more: 0, moreLines: 0, edges: [], path: `/Users/${FAKE_USERNAME}/Vault`, text: fakeClaudeToken() }],
    hidden: 0,
    more: 0
  }
})

test('a vaults file the gate refuses is written as unavailable with a fixed reason, and the other four files are still written', async () => {
  const { fake } = await aHome()
  try {
    const result = await run(fake, [], { yml: 'vaults: []\n', extra: { sources: { vaults: leakyVaults } } })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual((await relativeFiles(result.target)).filter((file) => file !== 'vaults.yml'), [CONNECTIONS, HERMES, JOBS, USAGE, VAULTS])
    const doc = await readAt(result.target, VAULTS)
    assert.deepEqual(doc, {
      schema: VAULTS_SCHEMA,
      takenAt: new Date(NOW).toISOString().replace('.000Z', 'Z'),
      computer: 'Test PC',
      vaults: { status: 'unavailable', why: VAULTS_WHY.refused }
    })
    assert.equal(VAULTS_WHY.refused, 'refused by the safety check')
    assert.deepEqual(checkVaults(doc, fake.identity), [])
    assert.equal((await readAt(result.target, USAGE)).schema, 'agent-status/usage/v1')
    assert.match(result.stderr, /The vaults file was refused by the safety check/)
    assert.match(result.stderr, /vaults: vaults\.items\[0\]\.name/)
    assert.match(result.stderr, /vaults: vaults\.items\[0\]\.path: is not an allowed key/)
    assert.match(result.stderr, /The other files are written/)
    for (const file of await filesUnder(result.target)) {
      const text = await readFile(file, 'utf8')
      assert.ok(!text.includes(FAKE_EMAIL) && !text.includes('sk-') && !text.includes(FAKE_USERNAME), `${file} holds something that was refused`)
    }
    const talk = result.stderr + result.stdout
    assert.ok(!talk.includes(FAKE_EMAIL) && !talk.includes('sk-') && !talk.includes(`/Users/${FAKE_USERNAME}`))
    assert.match(result.stdout, /- Vaults unavailable \(refused by the safety check\)/)
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('--only vaults with a refused file writes the unavailable file alone, and a source that returns rubbish does the same', async () => {
  const { fake } = await aHome()
  try {
    for (const source of [leakyVaults, async () => 'not even an object', async () => null, async () => ({ token: fakeClaudeToken() })]) {
      const result = await run(fake, ['--only', 'vaults'], { yml: 'vaults: []\n', extra: { sources: { vaults: source } } })
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual((await relativeFiles(result.target)).filter((file) => file !== 'vaults.yml'), [VAULTS])
      assert.deepEqual((await readAt(result.target, VAULTS)).vaults, { status: 'unavailable', why: VAULTS_WHY.refused })
      assert.ok(!result.stderr.includes('sk-') && !result.stdout.includes('sk-'), 'a refused value was printed')
      await rm(result.target, { recursive: true, force: true })
    }
  } finally {
    await fake.cleanup()
  }
})

test('the other parts keep their rule: if one of them is refused the whole run still stops, vaults or no vaults', async () => {
  const { fake } = await aHome()
  try {
    const leakyConnections = async (deps, computer) => ({
      schema: 'agent-status/connections/v1',
      takenAt: '2026-10-07T20:00:00Z',
      computer,
      tools: [],
      claude: { status: 'found', live: 'checked', servers: [{ name: FAKE_EMAIL, scope: 'user', transport: 'web', state: 'connected' }], projectServers: 0, hidden: 0, more: 0 },
      codex: { status: 'not found' }
    })
    const result = await run(fake, [], { yml: YML_SHAPE, extra: { sources: { connections: leakyConnections } } })
    assert.equal(result.code, 1)
    assert.deepEqual(await relativeFiles(result.target), ['vaults.yml'], 'a file was written although another part was refused')
    assert.match(result.stderr, /Nothing written/)
    assert.ok(!result.stderr.includes(FAKE_EMAIL))
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('if even the unavailable file would not pass the gate, nothing is written: the fallback is checked like any file', async () => {
  const { fake } = await aHome()
  try {
    const result = await run(fake, ['--only', 'vaults'], { yml: YML_SHAPE, extra: { now: NaN } })
    assert.equal(result.code, 1)
    assert.deepEqual(await relativeFiles(result.target), ['vaults.yml'])
    assert.match(result.stderr, /Nothing written/)
    assert.match(result.stderr, /vaults: takenAt/)
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('a linked vaults folder is refused before anything is written, the usage file included', async (t) => {
  const { fake } = await aHome()
  const target = await mkdtemp(join(tmpdir(), 'agent-status-repo-'))
  const elsewhere = await mkdtemp(join(tmpdir(), 'agent-status-elsewhere-'))
  try {
    await mkdir(join(target, '.agent-team', 'status'), { recursive: true })
    try {
      await symlink(elsewhere, join(target, '.agent-team', 'status', 'vaults'), 'junction')
    } catch (error) {
      t.skip(`this computer does not let a test make a folder link (${error.code}) - NOT CHECKED here`)
      return
    }
    const result = await run(fake, [], { target, yml: YML_SHAPE })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /is a link to somewhere else/)
    assert.deepEqual(await readdir(elsewhere), [], 'something was written through the link')
    assert.equal(existsSync(join(target, ...USAGE.split('/'))), false, 'the usage file was written although vaults was refused')
  } finally {
    await fake.cleanup()
    await rm(target, { recursive: true, force: true })
    await rm(elsewhere, { recursive: true, force: true })
  }
})

// --- commit, receipt ------------------------------------------------------------------------------------------------------------

test('--commit: the vaults file travels in the one commit with the other parts, and the receipt lists it with its hash and its statuses', async () => {
  const repo = await makeRemote()
  const { fake } = await aHome()
  try {
    await writeFile(join(repo.work, 'vaults.yml'), YML_TITLES)
    const stateDir = join(repo.root, 'state')
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir })
    assert.equal(result.code, 0, result.stderr)
    const files = (await git(['show', '--name-only', '--format=', 'HEAD'], repo.work)).stdout.trim().split('\n').sort()
    assert.deepEqual(files, [CONNECTIONS, HERMES, JOBS, USAGE, VAULTS])
    const subjects = (await git(['log', '--format=%s', 'origin/main'], repo.work)).stdout.trim().split('\n')
    assert.deepEqual(subjects, ['Status snapshot from Test PC', 'start'], 'one commit carried every file')

    const [claim] = await readdir(join(stateDir, 'claims'))
    const receipt = JSON.parse(await readFile(join(stateDir, 'claims', claim, 'receipt.json'), 'utf8'))
    assert.deepEqual(receipt.parts, ['usage', 'connections', 'hermes', 'jobs', 'vaults'])
    assert.deepEqual(receipt.files.map((entry) => entry.file), [USAGE, CONNECTIONS, HERMES, JOBS, VAULTS])
    for (const entry of receipt.files) {
      const bytes = await readFile(join(repo.work, ...entry.file.split('/')))
      assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'))
    }
    assert.deepEqual(Object.keys(receipt.sources), ['usage', 'connections', 'hermes', 'jobs', 'vaults'])
    assert.deepEqual(receipt.sources.vaults, { vaults: 'found', items: 1 })
    assert.deepEqual(checkAgainst(receipt, RECEIPT_SHAPE, fake.identity), [])
    const receiptText = JSON.stringify(receipt)
    for (const word of ['Pear', 'Apple', ORCHARD]) assert.ok(!receiptText.includes(word), `the receipt says ${word}`)
    const pushed = (await git(['show', 'main:' + VAULTS], repo.remote)).stdout
    assert.deepEqual(JSON.parse(pushed).vaults.items[0].nodes.map((node) => node.title).sort(), ['Apple store', 'Lonely idea', 'Pear harvest', 'Raised bed'])
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('--commit with an unchanged vaults file: it stays out of the commit and the receipt\'s files, and still has its statuses', async () => {
  const repo = await makeRemote()
  const { fake } = await aHome()
  try {
    await writeFile(join(repo.work, 'vaults.yml'), YML_SHAPE)
    const stateDir = join(repo.root, 'state')
    assert.equal((await collect(fake, ['--commit'], { repo: repo.work, stateDir: join(repo.root, 'state-1') })).code, 0)
    const second = await collect(fake, ['--commit'], { repo: repo.work, stateDir, extra: { now: NOW + 4 * HOUR } })
    assert.equal(second.code, 0, second.stderr)
    const files = (await git(['show', '--name-only', '--format=', 'HEAD'], repo.work)).stdout.trim().split('\n').sort()
    assert.deepEqual(files, [CONNECTIONS, HERMES, JOBS, USAGE], 'the vaults file was committed although nothing changed')
    const [claim] = await readdir(join(stateDir, 'claims'))
    const receipt = JSON.parse(await readFile(join(stateDir, 'claims', claim, 'receipt.json'), 'utf8'))
    assert.deepEqual(receipt.parts, ['usage', 'connections', 'hermes', 'jobs', 'vaults'])
    assert.ok(!receipt.files.some((entry) => entry.file === VAULTS))
    assert.deepEqual(receipt.sources.vaults, { vaults: 'found', items: 1 })
    assert.deepEqual(checkAgainst(receipt, RECEIPT_SHAPE, fake.identity), [])
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('--commit --only vaults when there is nothing to write: no file, no commit, no receipt - the claim says "nothing to commit"', async () => {
  const repo = await makeRemote()
  const { fake } = await aHome()
  try {
    await writeFile(join(repo.work, 'vaults.yml'), 'vaults: []\n')
    const stateDir = join(repo.root, 'state')
    const before = (await git(['rev-parse', 'HEAD'], repo.work)).stdout.trim()
    const result = await collect(fake, ['--commit', '--only', 'vaults'], { repo: repo.work, stateDir })
    assert.equal(result.code, 0, result.stderr)
    assert.equal((await git(['rev-parse', 'HEAD'], repo.work)).stdout.trim(), before, 'a commit was made')
    assert.match(result.stdout, /Nothing changed since the last snapshot, so nothing was committed/)
    const [claim] = await readdir(join(stateDir, 'claims'))
    assert.deepEqual((await readdir(join(stateDir, 'claims', claim))).sort(), ['final.json'])
    assert.equal(JSON.parse(await readFile(join(stateDir, 'claims', claim, 'final.json'), 'utf8')).outcome, 'nothing to commit')
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('the receipt gate accepts the vaults file path and its sources, and refuses a vaults source with a name in it', () => {
  const identity = { username: 'fakeperson', home: '/Users/fakeperson', hostname: 'fake-host-77' }
  const receipt = () => ({
    schema: 'agent-status/receipt/v2',
    claimedAt: '2026-10-09T15:00:00Z',
    computer: 'Mac Mini',
    parts: ['vaults'],
    files: [{ file: '.agent-team/status/vaults/mac-mini.json', sha256: 'a'.repeat(64) }],
    sources: { vaults: { vaults: 'found', items: 2 } }
  })
  assert.deepEqual(checkAgainst(receipt(), RECEIPT_SHAPE, identity), [])
  const cases = [
    [(r) => { r.sources.vaults.items = 'two' }, /sources\.vaults\.items/],
    [(r) => { r.sources.vaults.vaults = 'Orchard Notes' }, /sources\.vaults\.vaults/],
    [(r) => { r.sources.vaults.names = ['Orchard Notes'] }, /sources\.vaults\.names: is not an allowed key/],
    [(r) => { delete r.sources.vaults.items }, /sources\.vaults\.items: is missing/],
    [(r) => { r.files[0].file = '.agent-team/status/vaults/../x.json' }, /files\[0\]\.file/]
  ]
  for (const [change, field] of cases) {
    const value = receipt()
    change(value)
    const problems = checkAgainst(value, RECEIPT_SHAPE, identity)
    assert.ok(problems.some((problem) => field.test(problem)), `not refused: ${field} (${problems.join(' | ')})`)
  }
})

// --- where vaults.yml is read from ---------------------------------------------------------------------------------------------------

test('the dedicated clone is where vaults.yml is read - the clone as the team repo has it, not the code checkout', async () => {
  const repo = await makeRemote({ 'vaults.yml': YML_SHAPE })
  const { fake } = await aHome()
  try {
    // The code checkout names nothing (and could say anything): only the clone's copy counts.
    await writeFile(join(repo.work, 'vaults.yml'), 'vaults: []\n')
    const dedicated = await repo.clone('dedicated')
    const named = await collect(fake, ['--commit', '--clone', dedicated, '--only', 'vaults'], { repo: repo.work, stateDir: join(repo.root, 'state-1') })
    assert.equal(named.code, 0, named.stderr)
    assert.equal((await readAt(dedicated, VAULTS)).vaults.items[0].name, ORCHARD)
    assert.deepEqual((await git(['show', '--name-only', '--format=', 'HEAD'], dedicated)).stdout.trim().split('\n'), [VAULTS])

    // And the other way round: the code checkout names the vault, the team repo does not.
    const repo2 = await makeRemote({ 'vaults.yml': 'vaults: []\n' })
    try {
      await writeFile(join(repo2.work, 'vaults.yml'), YML_SHAPE)
      const dedicated2 = await repo2.clone('dedicated')
      const unnamed = await collect(fake, ['--commit', '--clone', dedicated2, '--only', 'vaults'], { repo: repo2.work, stateDir: join(repo2.root, 'state-1') })
      assert.equal(unnamed.code, 0, unnamed.stderr)
      assert.equal(existsSync(join(dedicated2, ...VAULTS.split('/'))), false, 'the code checkout\'s vaults.yml was read')
      assert.match(unnamed.stdout, /nothing was committed/)
    } finally {
      await repo2.cleanup()
    }
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('in a full run an unnamed vault is never opened: not listed, not read, not counted', async () => {
  const { fake, places } = await aHome({
    [ORCHARD]: { files: NOTES },
    'Private Vault': { files: { 'Secrets.md': 'PRIVATE-PROSE-77 and the plan', 'Deep/More.md': 'PRIVATE-PROSE-78' } }
  })
  const fs = recordingFs()
  try {
    const result = await run(fake, ['--only', 'vaults'], { yml: YML_TITLES, extra: { fs } })
    assert.equal(result.code, 0, result.stderr)
    assert.ok(!fs.touched.some((path) => path.includes('Private Vault')), 'an unnamed vault was touched')
    const doc = await readAt(result.target, VAULTS)
    assert.deepEqual(doc.vaults.items.map((item) => item.name), [ORCHARD])
    assert.equal(doc.vaults.hidden, 0)
    assert.ok(!JSON.stringify(doc).includes('Private') && !(result.stdout + result.stderr).includes('Private'))
    assert.ok(places['Private Vault'])
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

// --- the computer decides which vaults are read; the team repo can only narrow ---------------------------------------------------------

test('no allowlist on the computer: a team repo that names vaults at titles still gets no vaults file, and the log says why', async () => {
  const { fake } = await aHome(undefined, { allow: null })
  const fs = recordingFs()
  try {
    const full = await run(fake, [], { yml: YML_TITLES, extra: { fs } })
    assert.equal(full.code, 0, full.stderr)
    assert.deepEqual((await relativeFiles(full.target)).filter((file) => file !== 'vaults.yml'), [CONNECTIONS, HERMES, JOBS, USAGE], 'a vaults file was written with no allowlist')
    assert.match(full.stdout, /No allowlist on this computer \(allowed-vaults\.yml in the state folder\), so no vault is read, whatever vaults\.yml says/)
    assert.match(full.stdout, /- Vaults not found/)
    assert.ok(!fs.touched.some((path) => path.endsWith('obsidian.json') || path.includes(ORCHARD)), 'Obsidian\'s list or a vault was read')
    assert.ok(!fs.touched.some((path) => /[\\/]vaults\.yml$/.test(path)), 'vaults.yml was read although nothing can be allowed')
    await rm(full.target, { recursive: true, force: true })

    const only = await run(fake, ['--only', 'vaults'], { yml: YML_TITLES })
    assert.equal(only.code, 0, only.stderr)
    assert.deepEqual((await relativeFiles(only.target)).filter((file) => file !== 'vaults.yml'), [])
    assert.match(only.stdout, /Nothing changed since the last snapshot, so nothing was written/)
    await rm(only.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('taking the allowlist away replaces an earlier vaults file once with "not found", so what was shown is no longer shown', async () => {
  const { fake } = await aHome()
  try {
    const first = await run(fake, ['--only', 'vaults'], { yml: YML_TITLES })
    const { target } = first
    assert.equal((await readAt(target, VAULTS)).vaults.items[0].level, 'titles')
    await setAllowed(defaultState(fake), null)
    const second = await run(fake, ['--only', 'vaults'], { target, extra: { now: NOW + HOUR } })
    assert.equal(second.code, 0, second.stderr)
    const doc = await readAt(target, VAULTS)
    assert.deepEqual(doc.vaults, { status: 'not found' })
    assert.ok(!JSON.stringify(doc).includes('Pear'))
    const text = await textAt(target, VAULTS)
    const third = await run(fake, ['--only', 'vaults'], { target, extra: { now: NOW + 2 * HOUR } })
    assert.equal(await textAt(target, VAULTS), text)
    assert.match(third.stdout, /Nothing changed since the last snapshot/)
    await rm(target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('a vault the team repo names that the computer does not allow is not opened, not published, and counted in the log only', async () => {
  const { fake } = await aHome({
    [ORCHARD]: { files: NOTES },
    'Therapy Sessions': { files: { 'Dr Lee.md': 'PRIVATE-PROSE-31 [[Dr Lee follow-up]]', 'Dr Lee follow-up.md': 'PRIVATE-PROSE-32' } }
  }, { allow: allowText([ORCHARD]) })
  const fs = recordingFs()
  try {
    const result = await run(fake, ['--only', 'vaults'], { yml: `vaults:\n  - name: Therapy Sessions\n    level: titles\n  - name: ${ORCHARD}\n    level: titles\n`, extra: { fs } })
    assert.equal(result.code, 0, result.stderr)
    const text = await textAt(result.target, VAULTS)
    const doc = JSON.parse(text)
    assert.deepEqual(doc.vaults.items.map((item) => item.name), [ORCHARD])
    assert.equal(doc.vaults.hidden, 0)
    for (const word of ['Therapy', 'Dr Lee', 'PRIVATE-PROSE']) assert.ok(!text.includes(word) && !(result.stdout + result.stderr).includes(word), `${word} reached an output`)
    assert.ok(!fs.touched.some((path) => path.includes('Therapy')), 'the vault that is not allowed was touched')
    assert.match(result.stdout, /1 vault named in vaults\.yml is not in this computer's allowlist, so it was ignored\./)
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('titles asked for by the team repo on a vault the computer allows only as dots: the file has dots, and the log says so', async () => {
  const { fake } = await aHome(undefined, { allow: allowText([ORCHARD], 'shape') })
  try {
    const result = await run(fake, ['--only', 'vaults'], { yml: YML_TITLES })
    assert.equal(result.code, 0, result.stderr)
    const text = await textAt(result.target, VAULTS)
    const [item] = JSON.parse(text).vaults.items
    assert.equal(item.level, 'shape')
    assert.equal(item.nodes, undefined)
    for (const word of ['Pear', 'Apple', 'Raised', 'Lonely', 'orchard']) assert.ok(!text.includes(word), `the file holds ${word}`)
    assert.match(result.stdout, /1 vault asked for titles in vaults\.yml but this computer's allowlist allows only dots, so it is shown as dots\./)
    assert.match(result.stdout, /- Vaults found: 1 listed \(0 at titles, 1 at shape\)/)
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('the team repo lowering a level, or dropping a vault, is honoured in a run', async () => {
  const { fake } = await aHome({ [ORCHARD]: { files: NOTES }, Second: { files: { 'One.md': 'text' } } }, { allow: allowText([ORCHARD, 'Second']) })
  try {
    const lowered = await run(fake, ['--only', 'vaults'], { yml: `vaults:\n  - name: ${ORCHARD}\n    level: shape\n  - name: Second\n    level: titles\n` })
    assert.deepEqual((await readAt(lowered.target, VAULTS)).vaults.items.map((item) => [item.name, item.level]), [[ORCHARD, 'shape'], ['Second', 'titles']])
    await rm(lowered.target, { recursive: true, force: true })
    const dropped = await run(fake, ['--only', 'vaults'], { yml: 'vaults:\n  - name: Second\n' })
    assert.deepEqual((await readAt(dropped.target, VAULTS)).vaults.items.map((item) => item.name), ['Second'])
    await rm(dropped.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('an allowlist committed to the team repo is never read: in the dedicated clone only the state folder\'s counts', async () => {
  const repo = await makeRemote({ 'vaults.yml': YML_TITLES, [ALLOWED_FILE]: allowText([ORCHARD]) })
  const { fake } = await aHome(undefined, { allow: null })
  try {
    const dedicated = await repo.clone('dedicated')
    assert.ok(existsSync(join(dedicated, ALLOWED_FILE)), 'the pusher\'s allowlist is in the clone')
    const stateDir = join(repo.root, 'state')
    const result = await collect(fake, ['--commit', '--clone', dedicated, '--only', 'vaults'], { repo: repo.work, stateDir })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(existsSync(join(dedicated, ...VAULTS.split('/'))), false, 'a vaults file was written from the team repo\'s own allowlist')
    assert.match(result.stdout, /No allowlist on this computer/)
    assert.match(result.stdout, /nothing was committed/)
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('the allowlist is read from the state folder the run uses: --state-dir moves it, and the default folder is then not looked at', async () => {
  const repo = await makeRemote()
  const { fake } = await aHome()
  // collect() must not write the allowlist for this test: the point is where it is looked for.
  fake.allowedText = undefined
  try {
    await writeFile(join(repo.work, 'vaults.yml'), YML_SHAPE)
    // The default folder allows the vault; the folder this run is told to use does not.
    const refused = await collect(fake, ['--commit', '--only', 'vaults'], { repo: repo.work, stateDir: join(repo.root, 'state-a') })
    assert.equal(refused.code, 0, refused.stderr)
    assert.match(refused.stdout, /No allowlist on this computer/)
    assert.equal(existsSync(join(repo.work, ...VAULTS.split('/'))), false)
    const stateB = join(repo.root, 'state-b')
    await setAllowed(stateB, allowText([ORCHARD], 'shape'))
    const allowed = await collect(fake, ['--commit', '--only', 'vaults'], { repo: repo.work, stateDir: stateB, extra: { now: NOW + HOUR } })
    assert.equal(allowed.code, 0, allowed.stderr)
    assert.equal((await readAt(repo.work, VAULTS)).vaults.items[0].name, ORCHARD)
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

// --- the hostile machine, through a whole run -----------------------------------------------------------------------------------------

test('a home and a vault full of secrets, through a whole committed run: the files, the receipt, the log and every error say none of it', async () => {
  const repo = await makeRemote()
  const fake = await hostileHome()
  const PRIVATE = 'PRIVATE-PROSE-9c1e'
  const SECRET = fakeClaudeToken()
  try {
    await placeVaults(fake, 'linux', {
      Hostile: {
        files: {
          'Plans/Weekly plan.md': `---\ntitle: ${SECRET}\napi_key: ${SECRET}\ntags: [${SECRET}, planning]\n---\n${PRIVATE} [[Garden]] [[Bearer abc]] [[${SECRET}]]`,
          'Plans/Garden.md': `---\ntags: [planning]\n---\n${PRIVATE} ${SECRET}`,
          'sk-live-notes.md': `${PRIVATE} ${SECRET}`,
          [`${FAKE_USERNAME}/Under the username.md`]: PRIVATE,
          'Big note.md': `${PRIVATE} ${'x'.repeat(300 * 1024)}`,
          '.obsidian/app.json': JSON.stringify({ token: SECRET }),
          '.trash/Deleted.md': `${PRIVATE} ${SECRET}`
        }
      },
      Quiet: { files: { 'One note.md': PRIVATE, 'Two note.md': `${PRIVATE} [[One note]]` } }
    })
    fake.allowedText = allowText(['Hostile', 'Quiet'])
    await writeFile(join(repo.work, 'vaults.yml'), 'vaults:\n  - name: Hostile\n    level: titles\n  - name: Quiet\n')
    const stateDir = join(repo.root, 'state')
    const result = await collect(fake, ['--commit', '--only', 'vaults'], { repo: repo.work, stateDir })
    assert.equal(result.code, 0, result.stderr)

    const doc = await readAt(repo.work, VAULTS)
    assert.deepEqual(checkVaults(doc, fake.identity), [])
    const [hostile, quiet] = doc.vaults.items
    assert.equal(hostile.level, 'titles')
    assert.equal(hostile.hidden, 1, 'the note that is too big')
    assert.deepEqual(hostile.nodes.map((node) => node.title).filter(Boolean).sort(), ['Garden', 'Under the username', 'Weekly plan'])
    assert.equal(hostile.untitled, 1, 'the name that looks like a key')
    assert.equal(quiet.level, 'shape')
    assert.equal(quiet.nodes, undefined)

    const [claim] = await readdir(join(stateDir, 'claims'))
    const outputs = [
      result.stdout,
      result.stderr,
      await readFile(join(stateDir, 'claims', claim, 'receipt.json'), 'utf8'),
      await readFile(join(stateDir, 'claims', claim, 'final.json'), 'utf8'),
      ...(await Promise.all((await filesUnder(repo.work)).filter((file) => !file.includes(`${join('.git')}`) && !file.endsWith('README.md') && !file.endsWith('vaults.yml')).map((file) => readFile(file, 'utf8')))),
      (await git(['log', '--format=%B', '-5'], repo.work)).stdout,
      (await git(['show', 'HEAD'], repo.work)).stdout
    ]
    const output = outputs.join('\n')
    for (const needle of [...FORBIDDEN(), FAKE_USERNAME, PRIVATE, SECRET, 'api_key', 'Library/Logs', fake.root]) {
      assert.ok(!output.includes(needle), `an output contained a forbidden string (${needle.slice(0, 6)}...)`)
    }
    // Quiet is at shape: its notes' names are nowhere, though Hostile's titles are in the file.
    for (const word of ['One note', 'Two note']) assert.ok(!output.includes(word), `${word} reached an output`)
    const pushed = (await git(['show', 'main:' + VAULTS], repo.remote)).stdout
    for (const needle of [...FORBIDDEN(), PRIVATE, SECRET]) assert.ok(!pushed.includes(needle), `the pushed file contained a forbidden string (${needle.slice(0, 6)}...)`)
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('the file stays under the size the board will read, even for three big vaults', async () => {
  const files = {}
  for (let index = 0; index < 650; index += 1) {
    const name = `${String(index).padStart(3, '0')} ${'abcdefgh '.repeat(8).trim()}`
    files[`Folder ${index % 9}/${name}.md`] = `---\ndate: 2026-10-${String(1 + (index % 28)).padStart(2, '0')}\ntags: [t${index % 40}]\n---\n[[${String((index + 1) % 650).padStart(3, '0')} ${'abcdefgh '.repeat(8).trim()}]]`
  }
  const { fake } = await aHome({ One: { files }, Two: { files }, Three: { files } })
  try {
    const result = await run(fake, ['--only', 'vaults'], { yml: 'vaults:\n  - name: One\n    level: titles\n  - name: Two\n    level: titles\n  - name: Three\n    level: titles\n' })
    assert.equal(result.code, 0, result.stderr)
    const info = await stat(join(result.target, ...VAULTS.split('/')))
    assert.ok(info.size <= 256 * 1024, `${info.size} bytes`)
    const doc = await readAt(result.target, VAULTS)
    assert.equal(doc.vaults.items.length, 3)
    assert.deepEqual(checkVaults(doc, fake.identity), [])
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})
