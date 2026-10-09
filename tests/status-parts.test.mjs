import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { runCollector } from '../scripts/lib/status/run.mjs'
import { PARTS, RECEIPT_SHAPE } from '../scripts/lib/status/schema.mjs'
import { SNAPSHOT_SUBJECT, SNAPSHOT_SUBJECTS } from '../scripts/lib/status/commit.mjs'
import { checkAgainst } from '../scripts/lib/status/safe.mjs'
import { makeFakeHome, FAKE_EMAIL } from './helpers/fake-home.mjs'
import { depsFor, filesUnder, runIn } from './helpers/hostile-home.mjs'
import { git } from './helpers/git.mjs'

/* A run collects several parts - usage, connections and Hermes - and each part is its own
   file. They travel together: every part passes the gate before anything is written, the files
   are committed in one commit, and the receipt lists each file with its hash. These run real git
   against a throwaway bare remote, as tests/status-commit.test.mjs does - no network. */

const USAGE = '.agent-team/status/usage/test-pc.json'
const CONNECTIONS = '.agent-team/status/connections/test-pc.json'
const HERMES = '.agent-team/status/hermes/test-pc.json'
const JOBS = '.agent-team/status/jobs/test-pc.json'

const relativeFiles = async (target) => (await filesUnder(target)).map((file) => file.slice(target.length + 1).replaceAll('\\', '/')).sort()

async function makeRemote() {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-parts-'))
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
  await git(['add', '.'], seed)
  await git(['commit', '-q', '-m', 'start'], seed)
  await git(['push', '-q', '-u', 'origin', 'main'], seed)
  const work = await clone('work')
  await git(['branch', '-q', '--set-upstream-to=origin/main', 'main'], work)
  return { root, remote, work, clone, cleanup: () => rm(root, { recursive: true, force: true }) }
}

async function collect(fake, args, { repo, stateDir, extra = {} }) {
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

test('the parts are usage, connections, hermes and jobs, and a run with no --only writes them all', async () => {
  assert.deepEqual(PARTS, ['usage', 'connections', 'hermes', 'jobs'])
  const fake = await makeFakeHome()
  try {
    const result = await runIn(fake, ['--computer', 'Test PC'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await relativeFiles(result.target), [CONNECTIONS, HERMES, JOBS, USAGE])
    assert.match(result.stdout, /\.agent-team\/status\/usage\/test-pc\.json/)
    assert.match(result.stdout, /\.agent-team\/status\/hermes\/test-pc\.json/)
    assert.match(result.stdout, /\.agent-team\/status\/connections\/test-pc\.json/)
    const doc = JSON.parse(await readFile(join(result.target, ...CONNECTIONS.split('/')), 'utf8'))
    assert.equal(doc.schema, 'agent-status/connections/v1')
    assert.equal(doc.computer, 'Test PC')
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('--only picks parts, in any order, and writes nothing else', async () => {
  const fake = await makeFakeHome()
  try {
    for (const [only, expected] of [
      ['usage', [USAGE]],
      ['connections', [CONNECTIONS]],
      ['connections,usage', [CONNECTIONS, USAGE]],
      ['usage, connections', [CONNECTIONS, USAGE]],
      ['usage,usage', [USAGE]],
      ['hermes', [HERMES]],
      ['hermes,usage', [HERMES, USAGE]]
    ]) {
      const result = await runIn(fake, ['--computer', 'Test PC', '--only', only])
      assert.equal(result.code, 0, `${only}: ${result.stderr}`)
      assert.deepEqual(await relativeFiles(result.target), expected, only)
      await rm(result.target, { recursive: true, force: true })
    }
  } finally {
    await fake.cleanup()
  }
})

test('--only refuses parts that do not exist, before reading anything', async () => {
  const fake = await makeFakeHome()
  try {
    for (const only of ['bogus', 'hermes,bogus', '', ',', 'usage,,connections', FAKE_EMAIL]) {
      const deps = depsFor(fake)
      const result = await runIn(fake, ['--computer', 'Test PC', '--only', only], { fetch: deps.fetch })
      assert.equal(result.code, 2, `--only ${JSON.stringify(only)} was accepted`)
      assert.deepEqual(await filesUnder(result.target), [])
      assert.equal(deps.fetch.calls.length, 0, 'sources were read before --only was checked')
      if (only.length > 3) assert.ok(!result.stderr.includes(only), 'the refusal repeated what was typed')
      await rm(result.target, { recursive: true, force: true })
    }
  } finally {
    await fake.cleanup()
  }
})

test('all or nothing on disk too: a failure writing the last file leaves no file and no temporary file', async () => {
  const fake = await makeFakeHome()
  const target = await mkdtemp(join(tmpdir(), 'agent-status-repo-'))
  try {
    // Something already sits where the Hermes file's temporary copy goes, and cannot be cleared: a
    // folder with a file in it. Writing that last file fails after the first two could have landed.
    const blocker = join(target, '.agent-team', 'status', 'hermes', `test-pc.json.${process.pid}.tmp`)
    await mkdir(blocker, { recursive: true })
    await writeFile(join(blocker, 'keep'), 'not the collector\'s\n')
    const result = await runIn(fake, ['--computer', 'Test PC'], {}, target)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /Nothing was written/)
    assert.deepEqual(await relativeFiles(target), [`.agent-team/status/hermes/test-pc.json.${process.pid}.tmp/keep`], 'a snapshot or a temporary file was left behind')
  } finally {
    await fake.cleanup()
    await rm(target, { recursive: true, force: true })
  }
})

test('all or nothing: if one part is refused by the gate, no part is written', async () => {
  const fake = await makeFakeHome()
  try {
    const leaky = async (deps, computer) => ({
      schema: 'agent-status/connections/v1',
      takenAt: '2026-10-07T20:00:00Z',
      computer,
      tools: [],
      claude: { status: 'found', live: 'checked', servers: [{ name: FAKE_EMAIL, scope: 'user', transport: 'web', state: 'connected' }], projectServers: 0, hidden: 0, more: 0 },
      codex: { status: 'not found' }
    })
    const result = await runIn(fake, ['--computer', 'Test PC'], { sources: { connections: leaky } })
    assert.equal(result.code, 1)
    assert.deepEqual(await filesUnder(result.target), [], 'the usage file was written although connections was refused')
    assert.match(result.stderr, /connections: claude\.servers\[0\]\.name/)
    assert.ok(!result.stderr.includes(FAKE_EMAIL))
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('--dry-run prints every part it would write and writes nothing', async () => {
  const fake = await makeFakeHome()
  try {
    const result = await runIn(fake, ['--computer', 'Test PC', '--dry-run'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await filesUnder(result.target), [])
    assert.match(result.stdout, /"schema": "agent-status\/usage\/v1"/)
    assert.match(result.stdout, /"schema": "agent-status\/connections\/v1"/)
    assert.match(result.stdout, /"schema": "agent-status\/hermes\/v1"/)
    assert.match(result.stdout, /It would go to \.agent-team\/status\/usage\/test-pc\.json/)
    assert.match(result.stdout, /It would go to \.agent-team\/status\/connections\/test-pc\.json/)
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('several files, one commit, with the new subject, and other staged work left staged', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    await writeFile(join(repo.work, 'notes.md'), 'half-finished thought\n')
    await git(['add', 'notes.md'], repo.work)
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir: join(repo.root, 'state') })
    assert.equal(result.code, 0, result.stderr)
    const files = (await git(['show', '--name-only', '--format=', 'HEAD'], repo.work)).stdout.trim().split('\n').sort()
    assert.deepEqual(files, [CONNECTIONS, HERMES, JOBS, USAGE])
    assert.equal(SNAPSHOT_SUBJECT, 'Status snapshot from ')
    const subjects = (await git(['log', '--format=%s', 'origin/main'], repo.work)).stdout.trim().split('\n')
    assert.deepEqual(subjects, ['Status snapshot from Test PC', 'start'], 'one commit carried both files')
    assert.equal((await git(['diff', '--cached', '--name-only'], repo.work)).stdout.trim(), 'notes.md')
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('a second run with nothing changed commits nothing', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const first = await collect(fake, ['--commit'], { repo: repo.work, stateDir: join(repo.root, 'state-1') })
    assert.equal(first.code, 0, first.stderr)
    const second = await collect(fake, ['--commit'], { repo: repo.work, stateDir: join(repo.root, 'state-2') })
    assert.equal(second.code, 0, second.stderr)
    assert.match(second.stdout, /Nothing changed since the last snapshot/)
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('dedicated clone: its own unpushed snapshots under the old or the new subject are replaced, not refused', async () => {
  assert.deepEqual(SNAPSHOT_SUBJECTS, ['Status snapshot from ', 'Usage snapshot from '])
  for (const subject of ['Usage snapshot from Test PC', 'Status snapshot from Test PC']) {
    const repo = await makeRemote()
    const fake = await makeFakeHome()
    try {
      const dedicated = await repo.clone('dedicated')
      await mkdir(join(dedicated, '.agent-team', 'status', 'usage'), { recursive: true })
      await writeFile(join(dedicated, ...USAGE.split('/')), '{}\n')
      await git(['add', '.'], dedicated)
      await git(['commit', '-q', '-m', subject], dedicated)
      const result = await collect(fake, ['--commit', '--clone', dedicated], { repo: repo.work, stateDir: join(repo.root, 'state') })
      assert.equal(result.code, 0, `${subject}: ${result.stderr}`)
      const pushed = (await git(['log', '--format=%s', 'main'], repo.remote)).stdout.trim().split('\n')
      assert.deepEqual(pushed, ['Status snapshot from Test PC', 'start'])
    } finally {
      await fake.cleanup()
      await repo.cleanup()
    }
  }
})

test('dedicated clone: a change to any file outside the parts this run writes is somebody else\'s', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const dedicated = await repo.clone('dedicated')
    // A connections file left over is fine when this run writes connections ...
    await mkdir(join(dedicated, '.agent-team', 'status', 'connections'), { recursive: true })
    await writeFile(join(dedicated, ...CONNECTIONS.split('/')), '{}\n')
    const both = await collect(fake, ['--commit', '--clone', dedicated], { repo: repo.work, stateDir: join(repo.root, 'state-1') })
    assert.equal(both.code, 0, both.stderr)
    // ... but not when this run writes usage only.
    await writeFile(join(dedicated, ...CONNECTIONS.split('/')), '{"changed": true}\n')
    const usageOnly = await collect(fake, ['--commit', '--clone', dedicated, '--only', 'usage'], { repo: repo.work, stateDir: join(repo.root, 'state-2') })
    assert.equal(usageOnly.code, 2)
    assert.match(usageOnly.stderr, /not a dedicated clone/)
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('the receipt lists every file written with its hash, and the parts', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const stateDir = join(repo.root, 'state')
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir })
    assert.equal(result.code, 0, result.stderr)
    const [claim] = await readdir(join(stateDir, 'claims'))
    const receipt = JSON.parse(await readFile(join(stateDir, 'claims', claim, 'receipt.json'), 'utf8'))
    assert.equal(receipt.schema, 'agent-status/receipt/v2')
    assert.deepEqual(receipt.parts, ['usage', 'connections', 'hermes', 'jobs'])
    assert.deepEqual(receipt.files.map((entry) => entry.file), [USAGE, CONNECTIONS, HERMES, JOBS])
    for (const entry of receipt.files) {
      const bytes = await readFile(join(repo.work, ...entry.file.split('/')))
      assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'))
    }
    assert.deepEqual(Object.keys(receipt.sources), ['usage', 'connections', 'hermes', 'jobs'])
    assert.deepEqual(Object.keys(receipt.sources.connections).sort(), ['claude', 'codex', 'tools'])
    assert.deepEqual(checkAgainst(receipt, RECEIPT_SHAPE, fake.identity), [])
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('the receipt gate refuses a file outside the parts, or a part named twice', () => {
  const identity = { username: 'fakeperson', home: '/Users/fakeperson', hostname: 'fake-host-77' }
  const receipt = () => ({
    schema: 'agent-status/receipt/v2',
    claimedAt: '2026-10-07T20:00:00Z',
    computer: 'Mac Mini',
    parts: ['usage'],
    files: [{ file: '.agent-team/status/usage/mac-mini.json', sha256: 'a'.repeat(64) }],
    sources: { usage: { claudePlan: 'found', claudeLimits: 'found', claudeActivity: 'found', codexPlan: 'not found', codexLimits: 'unavailable' } }
  })
  assert.deepEqual(checkAgainst(receipt(), RECEIPT_SHAPE, identity), [])
  const cases = [
    [(r) => { r.files[0].file = '.agent-team/status/hermes/../../x.json' }, /files\[0\]\.file/],
    [(r) => { r.files[0].file = '.agent-team/status/secrets/mac-mini.json' }, /files\[0\]\.file/],
    [(r) => { r.files.push({ ...r.files[0] }) }, /files: names the same entry twice/],
    [(r) => { r.parts = ['usage', 'usage'] }, /parts: names the same entry twice/],
    [(r) => { r.parts = ['bogus'] }, /parts\[0\]/],
    [(r) => { r.sources.connections = { claude: 'found', codex: 'found', tools: 'nine' } }, /sources\.connections\.tools/],
    [(r) => { r.file = 'x' }, /^file: is not an allowed key/]
  ]
  for (const [change, field] of cases) {
    const value = receipt()
    change(value)
    const problems = checkAgainst(value, RECEIPT_SHAPE, identity)
    assert.ok(problems.some((problem) => field.test(problem)), `not refused: ${field} (${problems.join(' | ')})`)
  }
})

test('a linked connections folder is refused before anything is written, the usage file included', async (t) => {
  const fake = await makeFakeHome()
  const target = await mkdtemp(join(tmpdir(), 'agent-status-repo-'))
  const elsewhere = await mkdtemp(join(tmpdir(), 'agent-status-elsewhere-'))
  try {
    await mkdir(join(target, '.agent-team', 'status'), { recursive: true })
    try {
      await symlink(elsewhere, join(target, '.agent-team', 'status', 'connections'), 'junction')
    } catch (error) {
      t.skip(`this computer does not let a test make a folder link (${error.code}) - NOT CHECKED here`)
      return
    }
    const result = await runIn(fake, ['--computer', 'Test PC'], {}, target)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /is a link to somewhere else/)
    assert.deepEqual(await readdir(elsewhere), [], 'something was written through the link')
    assert.equal(existsSync(join(target, ...USAGE.split('/'))), false, 'the usage file was written although connections was refused')
  } finally {
    await fake.cleanup()
    await rm(target, { recursive: true, force: true })
    await rm(elsewhere, { recursive: true, force: true })
  }
})
