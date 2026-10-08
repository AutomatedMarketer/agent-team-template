import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runCollector, partsFrom } from '../scripts/lib/status/run.mjs'
import { collectHermes } from '../scripts/lib/status/hermes.mjs'
import { PARTS, RECEIPT_SHAPE, HEARTBEAT_FILE } from '../scripts/lib/status/schema.mjs'
import { HEARTBEAT } from '../scripts/lib/status/hermes-schema.mjs'
import { checkAgainst } from '../scripts/lib/status/safe.mjs'
import { makeFakeHome, execStub, FAKE_USERNAME } from './helpers/fake-home.mjs'
import { hostileHome, FORBIDDEN, depsFor, filesUnder } from './helpers/hostile-home.mjs'
import { writeHermes, hermesFolderFor } from './helpers/hermes-home.mjs'
import { repoRoot } from './helpers/repo.mjs'
import { git } from './helpers/git.mjs'

/* The Hermes part inside a run: --only hermes, the heartbeat written when (and only when) the alive
   rule holds, in the same commit as the status files and behind the same link checks, the log and
   the receipt saying statuses and counts only. Times come from the real clock - the fake gateway is
   stamped seconds before the run - so nothing here starts failing on a later date. Real git runs
   against a throwaway bare remote, as tests/status-commit.test.mjs does; no network. */

const execFileP = promisify(execFile)
const HERMES = '.agent-team/status/hermes/test-pc.json'
const USAGE = '.agent-team/status/usage/test-pc.json'
const CONNECTIONS = '.agent-team/status/connections/test-pc.json'
const BEAT = 'runs/heartbeat/hermes.json'

const relativeFiles = async (target) => (await filesUnder(target)).map((file) => file.slice(target.length + 1).replaceAll('\\', '/')).sort()
const readAt = async (target, relative) => JSON.parse(await readFile(join(target, ...relative.split('/')), 'utf8'))

async function run(fake, args, { now = Date.now(), target = null, extra = {} } = {}) {
  target = target ?? (await mkdtemp(join(tmpdir(), 'agent-status-repo-')))
  const stdout = []
  const stderr = []
  const code = await runCollector({
    argv: ['--computer', 'Test PC', ...args],
    deps: depsFor(fake, { now, ...extra }),
    repoRoot: target,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line)
  })
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), target }
}

async function makeRemote() {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-hermes-'))
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

test('the parts are usage, connections and hermes; --only hermes is a part now', () => {
  assert.deepEqual(PARTS, ['usage', 'connections', 'hermes'])
  assert.deepEqual(partsFrom('hermes'), { parts: ['hermes'] })
  assert.deepEqual(partsFrom('hermes,usage'), { parts: ['usage', 'hermes'] })
  assert.deepEqual(partsFrom(undefined), { parts: ['usage', 'connections', 'hermes'] })
  assert.ok(partsFrom('hermes,bogus').refusal)
})

test('alive: --only hermes writes the Hermes file and the heartbeat, at the newest proof', async () => {
  const now = Date.now()
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now, gatewaySecondsAgo: 30 })
    const result = await run(fake, ['--only', 'hermes'], { now })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await relativeFiles(result.target), [HERMES, BEAT])
    const doc = await readAt(result.target, HERMES)
    assert.equal(doc.schema, 'agent-status/hermes/v1')
    assert.equal(doc.gateway.state, 'running')
    // The scheduler beat (20 s ago) is newer than the gateway's stamp (30 s ago): it is the heartbeat.
    const beat = await readAt(result.target, BEAT)
    assert.deepEqual(beat, { runtime: 'hermes', at: doc.profiles.items[0].scheduler.beatAt })
    assert.equal(await readFile(join(result.target, ...BEAT.split('/')), 'utf8'), `${JSON.stringify(beat, null, 2)}\n`)
    assert.ok(!('alive' in doc), 'the file must never say alive itself')
    assert.match(result.stdout, /Wrote runs\/heartbeat\/hermes\.json/)
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('not alive: no heartbeat is written, and one already there is left as it was', async () => {
  const now = Date.now()
  const fake = await makeFakeHome()
  const target = await mkdtemp(join(tmpdir(), 'agent-status-repo-'))
  try {
    // The gateway's last stamp is ten minutes old and the scheduler's an hour: Down at last check.
    await writeHermes(fake, { now, gatewaySecondsAgo: 600 })
    await fake.write('.hermes/cron/ticker_heartbeat', String((now - 3600_000) / 1000))
    await mkdir(join(target, 'runs', 'heartbeat'), { recursive: true })
    const old = '{\n  "runtime": "hermes",\n  "at": "2026-10-01T00:00:00Z"\n}\n'
    await writeFile(join(target, 'runs', 'heartbeat', 'hermes.json'), old)
    const result = await run(fake, ['--only', 'hermes'], { now, target })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await relativeFiles(target), [HERMES, BEAT])
    assert.equal(await readFile(join(target, 'runs', 'heartbeat', 'hermes.json'), 'utf8'), old, 'a stale heartbeat was refreshed without proof')
    assert.match(result.stdout, /no heartbeat written/)
  } finally {
    await fake.cleanup()
    await rm(target, { recursive: true, force: true })
  }
})

test('no Hermes: the file says not found three times, and there is no heartbeat', async () => {
  const fake = await makeFakeHome()
  try {
    const result = await run(fake, ['--only', 'hermes'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await relativeFiles(result.target), [HERMES])
    const doc = await readAt(result.target, HERMES)
    assert.deepEqual([doc.install, doc.gateway, doc.profiles], [{ status: 'not found' }, { status: 'not found' }, { status: 'not found' }])
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('--dry-run says where the heartbeat would go and writes nothing', async () => {
  const now = Date.now()
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now })
    const result = await run(fake, ['--only', 'hermes', '--dry-run'], { now })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await filesUnder(result.target), [])
    assert.match(result.stdout, /"schema": "agent-status\/hermes\/v1"/)
    assert.match(result.stdout, /It would go to \.agent-team\/status\/hermes\/test-pc\.json/)
    assert.match(result.stdout, /It would go to runs\/heartbeat\/hermes\.json/)
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('the log says statuses and counts, never a profile or model name', async () => {
  const now = Date.now()
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now, profiles: { donna: { 'config.yaml': 'model:\n  default: gpt-5.1\n  provider: openai\n' } } })
    const result = await run(fake, ['--only', 'hermes'], { now })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^Hermes:$/m)
    assert.match(result.stdout, /- Install found \(version read\)/)
    assert.match(result.stdout, /- Gateway found \(running\)/)
    assert.match(result.stdout, /- Profiles found: 2 listed, 0 hidden, 0 more/)
    assert.match(result.stdout, /- Alive by the rule: yes, heartbeat written/)
    for (const name of ['donna', 'gpt-5.1', 'openai', 'claude-opus-5-5', 'anthropic']) assert.ok(!result.stdout.includes(name), `the log named ${name}`)
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('one commit carries every status file and the heartbeat; the receipt lists each with its hash', async () => {
  const now = Date.now()
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now })
    const stateDir = join(repo.root, 'state')
    const stdout = []
    const stderr = []
    const code = await runCollector({
      argv: ['--computer', 'Test PC', '--state-dir', stateDir, '--commit'],
      deps: depsFor(fake, { now, git }),
      repoRoot: repo.work,
      out: (line) => stdout.push(line),
      err: (line) => stderr.push(line)
    })
    assert.equal(code, 0, stderr.join('\n'))
    const files = (await git(['show', '--name-only', '--format=', 'HEAD'], repo.work)).stdout.trim().split('\n').sort()
    assert.deepEqual(files, [CONNECTIONS, HERMES, USAGE, BEAT].sort())
    const subjects = (await git(['log', '--format=%s', 'origin/main'], repo.work)).stdout.trim().split('\n')
    assert.deepEqual(subjects, ['Status snapshot from Test PC', 'start'])
    const [claim] = await readdir(join(stateDir, 'claims'))
    const receipt = JSON.parse(await readFile(join(stateDir, 'claims', claim, 'receipt.json'), 'utf8'))
    assert.deepEqual(receipt.parts, ['usage', 'connections', 'hermes'])
    assert.deepEqual(receipt.files.map((entry) => entry.file), [USAGE, CONNECTIONS, HERMES, BEAT])
    for (const entry of receipt.files) {
      const bytes = await readFile(join(repo.work, ...entry.file.split('/')))
      assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'))
    }
    assert.deepEqual(receipt.sources.hermes, { install: 'found', gateway: 'found', profiles: 'found', heartbeat: true })
    assert.deepEqual(checkAgainst(receipt, RECEIPT_SHAPE, fake.identity), [])
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('the receipt gate takes the heartbeat path and no other file outside the status folders', () => {
  const identity = { username: 'fakeperson', home: '/Users/fakeperson', hostname: 'fake-host-77' }
  const receipt = () => ({
    schema: 'agent-status/receipt/v2',
    claimedAt: '2026-10-08T15:00:00Z',
    computer: 'Mac Mini',
    parts: ['hermes'],
    files: [{ file: '.agent-team/status/hermes/mac-mini.json', sha256: 'a'.repeat(64) }, { file: HEARTBEAT.path, sha256: 'b'.repeat(64) }],
    sources: { hermes: { install: 'found', gateway: 'not found', profiles: 'found', heartbeat: true } }
  })
  assert.equal(HEARTBEAT_FILE, HEARTBEAT.path, 'the receipt and the Hermes contract spell the heartbeat path differently')
  assert.deepEqual(checkAgainst(receipt(), RECEIPT_SHAPE, identity), [])
  for (const file of ['runs/heartbeat/openclaw.json', 'runs/heartbeat/../hermes.json', 'runs/2026-10/hermes.json']) {
    const value = receipt()
    value.files[1].file = file
    assert.ok(checkAgainst(value, RECEIPT_SHAPE, identity).some((problem) => /files\[1\]\.file/.test(problem)), file)
  }
  const value = receipt()
  value.sources.hermes.heartbeat = 'yes'
  assert.ok(checkAgainst(value, RECEIPT_SHAPE, identity).some((problem) => /sources\.hermes\.heartbeat/.test(problem)))
})

test('a linked runs/heartbeat folder is refused before anything is written, the status files included', async (t) => {
  const now = Date.now()
  const fake = await makeFakeHome()
  const target = await mkdtemp(join(tmpdir(), 'agent-status-repo-'))
  const elsewhere = await mkdtemp(join(tmpdir(), 'agent-status-elsewhere-'))
  try {
    await writeHermes(fake, { now })
    await mkdir(join(target, 'runs'), { recursive: true })
    try {
      await symlink(elsewhere, join(target, 'runs', 'heartbeat'), 'junction')
    } catch (error) {
      t.skip(`this computer does not let a test make a folder link (${error.code}) - NOT CHECKED here`)
      return
    }
    for (const args of [['--only', 'hermes'], []]) {
      // Refused before anything is read, not only before anything is written.
      const read = []
      const spy = async (deps, computer) => {
        read.push(computer)
        return collectHermes(deps, computer)
      }
      const result = await run(fake, args, { now, target, extra: { sources: { hermes: spy } } })
      assert.equal(result.code, 1)
      assert.match(result.stderr, /is a link to somewhere else/)
      assert.deepEqual(read, [], 'Hermes was read although its heartbeat path was a link')
      assert.deepEqual(await readdir(elsewhere), [], 'something was written through the link')
      assert.equal(existsSync(join(target, ...HERMES.split('/'))), false, 'the Hermes file was written although the heartbeat path was refused')
      assert.equal(existsSync(join(target, ...USAGE.split('/'))), false)
    }
  } finally {
    await fake.cleanup()
    await rm(target, { recursive: true, force: true })
    await rm(elsewhere, { recursive: true, force: true })
  }
})

test('LEAK TEST: from the hostile Hermes home only versions, counts, times, states and allowed names come out', async () => {
  const now = Date.now()
  const fake = await hostileHome({ now })
  try {
    const written = await run(fake, [], { now })
    const dry = await run(fake, ['--dry-run'], { now })
    assert.equal(written.code, 0, written.stderr)
    assert.equal(dry.code, 0, dry.stderr)
    const outputs = [written.stdout, written.stderr, dry.stdout, dry.stderr]
    for (const file of await filesUnder(written.target)) outputs.push(await readFile(file, 'utf8'))
    for (const output of outputs) {
      for (const needle of FORBIDDEN()) assert.ok(!output.includes(needle), `an output contained a forbidden string (${needle.slice(0, 6)}...)`)
    }
    // It did read Hermes - the leak test is not passing because nothing was read.
    const doc = await readAt(written.target, HERMES)
    assert.deepEqual(doc.install, { status: 'found', version: '0.21.3', updateAvailable: true })
    assert.equal(doc.gateway.state, 'running')
    assert.deepEqual(doc.profiles.items.map((item) => [item.name, item.model, item.provider]), [['default', 'claude-opus-5-5', 'openrouter'], ['donna', 'gpt-5.1', 'openai']])
    assert.equal(doc.profiles.hidden, 1, 'the profile named after the person is counted, not named')
    if (doc.profiles.items[0].sessions.status === 'found') {
      assert.deepEqual([doc.profiles.items[0].sessions.conversations, doc.profiles.items[0].sessions.scheduled], [1, 1])
    }
    assert.deepEqual(Object.keys(await readAt(written.target, BEAT)), ['runtime', 'at'])
    await rm(written.target, { recursive: true, force: true })
    await rm(dry.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('Hermes is never run: across a whole run, no program the exec seam sees is Hermes', async () => {
  const now = Date.now()
  const fake = await hostileHome({ now })
  try {
    // Programs where the lookup will find them - a hermes among them - so the seam really is used.
    for (const name of ['claude', 'git', 'hermes']) await fake.write(`.local/bin/${name}`, '#!/bin/sh\n')
    await fake.write('.hermes/bin/hermes', '#!/bin/sh\n')
    const exec = execStub(() => '1.2.3\n')
    const result = await run(fake, [], { now, extra: { exec } })
    assert.equal(result.code, 0, result.stderr)
    assert.ok(exec.calls.length > 0, 'nothing was run at all, so this test proves nothing')
    for (const call of exec.calls) {
      const said = [call.file, ...(call.args ?? [])].join(' ')
      assert.doesNotMatch(said, /hermes/i, 'a program call named Hermes')
    }
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('a refused Hermes name stops the whole run: no part is written', async () => {
  const fake = await makeFakeHome()
  try {
    const leaky = async (deps, computer) => ({
      schema: 'agent-status/hermes/v1',
      takenAt: '2026-10-08T15:00:00Z',
      computer,
      install: { status: 'not found' },
      gateway: { status: 'not found' },
      profiles: { status: 'found', items: [{ name: FAKE_USERNAME, skills: { status: 'not found' }, sessions: { status: 'not found' }, scheduler: { status: 'not found' } }], hidden: 0, more: 0 }
    })
    const result = await run(fake, [], { extra: { sources: { hermes: leaky } } })
    assert.equal(result.code, 1)
    assert.deepEqual(await filesUnder(result.target), [])
    assert.match(result.stderr, /hermes: profiles\.items\[0\]\.name/)
    assert.ok(!result.stderr.includes(FAKE_USERNAME))
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

// --- a spawned collector, on this computer's real platform ---------------------------------------------------

test('SPAWN SAFETY: a spawned collector reads the fake Hermes and asks the harness to run nothing', async () => {
  // The real clock: the fake gateway was stamped seconds ago, so the run can find it alive.
  const now = Date.now()
  const fake = await makeFakeHome()
  const emptyPath = await mkdtemp(join(tmpdir(), 'agent-status-path-'))
  try {
    await writeHermes(fake, { now, folder: hermesFolderFor(process.platform) })
    const env = { HOME: fake.home, USERPROFILE: fake.home, PATH: emptyPath }
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
    const result = await execFileP(process.execPath, [join('tests', 'helpers', 'collector-cli.mjs'), '--dry-run', '--only', 'hermes', '--computer', 'Script Test'], { cwd: repoRoot, env, encoding: 'utf8' }).catch((error) => error)
    assert.equal(result.code ?? 0, 0, result.stderr)
    assert.match(result.stdout, /"schema": "agent-status\/hermes\/v1"/)
    assert.match(result.stdout, /"version": "0\.21\.3"/)
    assert.match(result.stdout, /It would go to runs\/heartbeat\/hermes\.json/)
    assert.doesNotMatch(result.stderr, /TEST HARNESS: refused to run/, 'the Hermes part asked to run a program')
  } finally {
    await rm(emptyPath, { recursive: true, force: true })
    await fake.cleanup()
  }
})
