import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { runCollector, partsFrom, summarizeJobs, jobsStatuses } from '../scripts/lib/status/run.mjs'
import { PARTS, RECEIPT_SHAPE } from '../scripts/lib/status/schema.mjs'
import { checkAgainst, checkJobs } from '../scripts/lib/status/safe.mjs'
import { JOBS_SCHEMA, JOBS_WHY } from '../scripts/lib/status/jobs-schema.mjs'
import { makeFakeHome, FAKE_EMAIL, FAKE_USERNAME, fakeClaudeToken } from './helpers/fake-home.mjs'
import { hostileHome, hostileMac, FORBIDDEN, depsFor, filesUnder, NOW } from './helpers/hostile-home.mjs'
import { writeHermes } from './helpers/hermes-home.mjs'
import { fakePrograms, launchctlTable } from './helpers/mac-programs.mjs'
import { git } from './helpers/git.mjs'

/* The jobs part inside a run: --only jobs, the file written beside the other parts behind the same
   gate and link checks, in the same commit, the receipt and the log saying statuses and counts only.
   A run on a Mac is pretended with a fake plutil and launchctl; nothing real starts. Real git runs
   against a throwaway bare remote, as tests/status-parts.test.mjs does - no network. */

const JOBS = '.agent-team/status/jobs/test-pc.json'
const USAGE = '.agent-team/status/usage/test-pc.json'
const CONNECTIONS = '.agent-team/status/connections/test-pc.json'
const HERMES = '.agent-team/status/hermes/test-pc.json'

const relativeFiles = async (target) => (await filesUnder(target)).map((file) => file.slice(target.length + 1).replaceAll('\\', '/')).sort()
const readAt = async (target, relative) => JSON.parse(await readFile(join(target, ...relative.split('/')), 'utf8'))

async function makeRemote() {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-jobs-'))
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

// A Mac with three jobs, as plutil and launchctl would describe them.
const PLISTS = {
  'local.donna.story-belt-daily.plist': { Label: 'local.donna.story-belt-daily', StartCalendarInterval: { Hour: 6, Minute: 15 } },
  'local.donna.blog-watch.plist': { Label: 'local.donna.blog-watch', StartInterval: 900 },
  'local.donna.security-changelog.plist': { Label: 'local.donna.security-changelog', RunAtLoad: true }
}
const TABLE = launchctlTable([['-', 0, 'local.donna.story-belt-daily'], ['-', 78, 'local.donna.blog-watch'], ['4242', 0, 'local.donna.security-changelog']])

async function aMac(extra = {}) {
  const fake = await makeFakeHome()
  for (const name of Object.keys(PLISTS)) await fake.write(`Library/LaunchAgents/${name}`, '<plist/>')
  const exec = fakePrograms({ plists: PLISTS, launchctl: TABLE })
  return { fake, exec, extra: { platform: 'darwin', exec, appsFolder: join(fake.root, 'Applications'), ...extra } }
}

async function run(fake, args, { target = null, extra = {} } = {}) {
  target = target ?? (await mkdtemp(join(tmpdir(), 'agent-status-repo-')))
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

// --- the part list ------------------------------------------------------------------------------------------------

test('the parts are usage, connections, hermes and jobs; --only jobs is a part, in any order', () => {
  assert.deepEqual(PARTS, ['usage', 'connections', 'hermes', 'jobs'])
  assert.deepEqual(partsFrom('jobs'), { parts: ['jobs'] })
  assert.deepEqual(partsFrom('jobs,usage'), { parts: ['usage', 'jobs'] })
  assert.deepEqual(partsFrom('hermes, jobs ,connections'), { parts: ['connections', 'hermes', 'jobs'] })
  assert.deepEqual(partsFrom(undefined), { parts: ['usage', 'connections', 'hermes', 'jobs'] })
  assert.ok(partsFrom('jobs,bogus').refusal)
  assert.match(partsFrom('bogus').refusal, /usage, connections, hermes, jobs/)
})

// --- one run --------------------------------------------------------------------------------------------------------

test('--only jobs on a Mac writes the jobs file and nothing else, and says counts, never names', async () => {
  const { fake, exec, extra } = await aMac()
  try {
    await writeHermes(fake, { now: NOW })
    const result = await run(fake, ['--only', 'jobs'], { extra })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await relativeFiles(result.target), [JOBS], 'a heartbeat or another part was written')
    assert.match(result.stdout, /Snapshot for Test PC\. Wrote \.agent-team\/status\/jobs\/test-pc\.json/)
    const doc = await readAt(result.target, JOBS)
    assert.equal(doc.schema, JOBS_SCHEMA)
    assert.equal(doc.computer, 'Test PC')
    assert.equal(doc.timezone, 'America/New_York')
    assert.deepEqual(doc.launchd.items.map((item) => item.label), ['local.donna.blog-watch', 'local.donna.security-changelog', 'local.donna.story-belt-daily'])
    assert.deepEqual(checkJobs(doc, fake.identity), [])
    // The log: a title and counts. No label and no job name - those are the person's own words.
    assert.match(result.stdout, /^Jobs:$/m)
    assert.match(result.stdout, /- launchd found: 3 listed \(1 running, 2 loaded, 0 not loaded\), 0 hidden, 0 more/)
    for (const label of Object.values(PLISTS).map((plist) => plist.Label)) assert.ok(!result.stdout.includes(label), `the log named ${label}`)
    assert.deepEqual([...new Set(exec.calls.map((call) => call.file))].sort(), ['/bin/launchctl', '/usr/bin/plutil'])
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('a computer that is not a Mac and has no Hermes still writes a jobs file, saying not found twice', async () => {
  const fake = await makeFakeHome()
  try {
    const result = await run(fake, ['--only', 'jobs'])
    assert.equal(result.code, 0, result.stderr)
    const doc = await readAt(result.target, JOBS)
    assert.deepEqual(doc.launchd, { status: 'not found' })
    assert.deepEqual(doc.hermes, { status: 'not found' })
    assert.match(result.stdout, /- launchd not found/)
    assert.match(result.stdout, /- Hermes jobs not found/)
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('the log counts jobs by state and by kind of schedule, and Hermes jobs by on and off', () => {
  const doc = {
    schema: JOBS_SCHEMA,
    takenAt: '2026-10-09T15:00:00Z',
    computer: 'Mac Mini',
    timezone: 'America/New_York',
    launchd: {
      status: 'found',
      items: [
        { label: 'local.a', cadence: { kind: 'always' }, state: 'running' },
        { label: 'local.b', cadence: { kind: 'every', minutes: 15 }, state: 'loaded' },
        { label: 'local.c', cadence: { kind: 'slots', slots: [{ minute: 0 }] }, state: 'not loaded' },
        { label: 'local.d', cadence: { kind: 'unknown' }, state: 'not loaded' }
      ],
      hidden: 2,
      more: 1
    },
    hermes: {
      status: 'found',
      items: [
        { profile: 'default', id: 'a', name: 'Secret name', enabled: true, cadence: { kind: 'slots', slots: [{ minute: 0, hour: 6 }] }, lastResult: 'ok' },
        { profile: 'default', id: 'b', name: 'Another name', enabled: false, cadence: { kind: 'unknown' }, lastResult: 'unknown' }
      ],
      hidden: 0,
      more: 0
    }
  }
  assert.deepEqual(summarizeJobs(doc), [
    '- launchd found: 4 listed (1 running, 1 loaded, 2 not loaded), 2 hidden, 1 more',
    '- Hermes jobs found: 2 listed (1 on, 1 off), 0 hidden, 0 more',
    '- Schedules: 2 at set times, 1 every N minutes, 1 always on, 2 not known'
  ])
  assert.deepEqual(summarizeJobs({ ...doc, launchd: { status: 'unavailable', why: 'could not be read' }, hermes: { status: 'not found' } }), [
    '- launchd unavailable (could not be read)',
    '- Hermes jobs not found',
    '- Schedules: 0 at set times, 0 every N minutes, 0 always on, 0 not known'
  ])
  assert.deepEqual(jobsStatuses(doc), { launchd: 'found', hermes: 'found', items: 6 })
  assert.deepEqual(jobsStatuses({ ...doc, launchd: { status: 'not found' }, hermes: { status: 'unavailable', why: 'x' } }), { launchd: 'not found', hermes: 'unavailable', items: 0 })
})

test('--dry-run prints the jobs file and where it would go, and writes nothing', async () => {
  const { fake, extra } = await aMac()
  try {
    const result = await run(fake, ['--only', 'jobs', '--dry-run'], { extra })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await filesUnder(result.target), [])
    assert.match(result.stdout, /"schema": "agent-status\/jobs\/v1"/)
    assert.match(result.stdout, /It would go to \.agent-team\/status\/jobs\/test-pc\.json/)
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('a run with no --only writes all four parts, and --help names the jobs part', async () => {
  const { fake, extra } = await aMac()
  try {
    const result = await run(fake, [], { extra })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await relativeFiles(result.target), [CONNECTIONS, HERMES, JOBS, USAGE])
    await rm(result.target, { recursive: true, force: true })
    const help = await run(fake, ['--help'])
    assert.equal(help.code, 0)
    assert.match(help.stdout, /--only usage,connections,hermes,jobs/)
    assert.match(help.stdout, /jobs: .*names, times and states only/i)
    assert.match(help.stdout, /plutil/)
    assert.match(help.stdout, /never runs hermes/i)
    await rm(help.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

// --- the gate and the links ------------------------------------------------------------------------------------------

// The jobs part is the newest and reads the most unfamiliar files, so a refusal of its file is not allowed to
// cost the three older parts their snapshot. The refused jobs file is replaced by one that says it is
// unavailable, with a fixed reason and none of what was refused. Every other part keeps the rule it had:
// a part the gate refuses stops the whole run, and nothing is written.
const leakyJobs = async (deps, computer) => ({
  schema: JOBS_SCHEMA,
  takenAt: '2026-10-07T20:00:00Z',
  computer,
  timezone: 'America/New_York',
  launchd: { status: 'found', items: [{ label: `local.${FAKE_EMAIL}`, cadence: { kind: 'always' }, state: 'running', args: [fakeClaudeToken()] }], hidden: 0, more: 0 },
  hermes: { status: 'not found' }
})

test('a jobs file the gate refuses is written as unavailable with a fixed reason, and the other three files are still written', async () => {
  const fake = await makeFakeHome()
  try {
    const result = await run(fake, [], { extra: { sources: { jobs: leakyJobs } } })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await relativeFiles(result.target), [CONNECTIONS, HERMES, JOBS, USAGE])
    const doc = await readAt(result.target, JOBS)
    assert.deepEqual(doc, {
      schema: JOBS_SCHEMA,
      takenAt: new Date(NOW).toISOString().replace('.000Z', 'Z'),
      computer: 'Test PC',
      timezone: 'UTC',
      launchd: { status: 'unavailable', why: JOBS_WHY.refused },
      hermes: { status: 'unavailable', why: JOBS_WHY.refused }
    })
    assert.equal(JOBS_WHY.refused, 'refused by the safety check')
    assert.deepEqual(checkJobs(doc, fake.identity), [])
    // The other parts are what they would have been.
    assert.equal((await readAt(result.target, USAGE)).schema, 'agent-status/usage/v1')
    assert.equal((await readAt(result.target, CONNECTIONS)).schema, 'agent-status/connections/v1')
    assert.equal((await readAt(result.target, HERMES)).schema, 'agent-status/hermes/v1')
    // It says so, naming the fields and never the values.
    assert.match(result.stderr, /The jobs file was refused by the safety check/)
    assert.match(result.stderr, /jobs: launchd\.items\[0\]\.label/)
    assert.match(result.stderr, /jobs: launchd\.items\[0\]\.args: is not an allowed key/)
    assert.match(result.stderr, /The other files are written/)
    for (const file of await filesUnder(result.target)) {
      const text = await readFile(file, 'utf8')
      assert.ok(!text.includes(FAKE_EMAIL) && !text.includes('sk-'), `${file} holds something that was refused`)
    }
    assert.ok(!result.stderr.includes(FAKE_EMAIL) && !result.stderr.includes('sk-') && !result.stdout.includes(FAKE_EMAIL))
    assert.match(result.stdout, /- launchd unavailable \(refused by the safety check\)/)
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('--only jobs with a refused file writes the unavailable file alone, and a source that returns rubbish does the same', async () => {
  const fake = await makeFakeHome()
  try {
    for (const source of [leakyJobs, async () => 'not even an object', async () => null, async () => ({ token: fakeClaudeToken() })]) {
      const result = await run(fake, ['--only', 'jobs'], { extra: { sources: { jobs: source } } })
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(await relativeFiles(result.target), [JOBS])
      assert.deepEqual((await readAt(result.target, JOBS)).launchd, { status: 'unavailable', why: JOBS_WHY.refused })
      assert.ok(!result.stderr.includes('sk-') && !result.stdout.includes('sk-'), 'a refused value was printed')
      await rm(result.target, { recursive: true, force: true })
    }
  } finally {
    await fake.cleanup()
  }
})

test('the other parts keep their rule: if one of them is refused the whole run still stops, jobs or no jobs', async () => {
  const fake = await makeFakeHome()
  try {
    const leakyConnections = async (deps, computer) => ({
      schema: 'agent-status/connections/v1',
      takenAt: '2026-10-07T20:00:00Z',
      computer,
      tools: [],
      claude: { status: 'found', live: 'checked', servers: [{ name: FAKE_EMAIL, scope: 'user', transport: 'web', state: 'connected' }], projectServers: 0, hidden: 0, more: 0 },
      codex: { status: 'not found' }
    })
    for (const sources of [{ connections: leakyConnections }, { connections: leakyConnections, jobs: leakyJobs }]) {
      const result = await run(fake, [], { extra: { sources } })
      assert.equal(result.code, 1)
      assert.deepEqual(await filesUnder(result.target), [], 'a file was written although another part was refused')
      assert.match(result.stderr, /Nothing written/)
      assert.match(result.stderr, /connections: claude\.servers\[0\]\.name/)
      assert.ok(!result.stderr.includes(FAKE_EMAIL))
      await rm(result.target, { recursive: true, force: true })
    }
  } finally {
    await fake.cleanup()
  }
})

test('--commit with a refused jobs file: all four files go in the one commit, and the receipt says jobs was unavailable', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const stateDir = join(repo.root, 'state')
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir, extra: { sources: { jobs: leakyJobs } } })
    assert.equal(result.code, 0, result.stderr)
    const files = (await git(['show', '--name-only', '--format=', 'HEAD'], repo.work)).stdout.trim().split('\n').sort()
    assert.deepEqual(files, [CONNECTIONS, HERMES, JOBS, USAGE])
    const [claim] = await readdir(join(stateDir, 'claims'))
    const receipt = JSON.parse(await readFile(join(stateDir, 'claims', claim, 'receipt.json'), 'utf8'))
    assert.deepEqual(receipt.sources.jobs, { launchd: 'unavailable', hermes: 'unavailable', items: 0 })
    assert.deepEqual(checkAgainst(receipt, RECEIPT_SHAPE, fake.identity), [])
    const final = JSON.parse(await readFile(join(stateDir, 'claims', claim, 'final.json'), 'utf8'))
    assert.equal(final.outcome, 'pushed')
    const pushed = (await git(['show', 'main:' + JOBS], repo.remote)).stdout
    assert.ok(!pushed.includes(FAKE_EMAIL) && !pushed.includes('sk-'))
    assert.match(result.stderr, /The jobs file was refused by the safety check/)
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('a linked jobs folder is refused before anything is written, the usage file included', async (t) => {
  const fake = await makeFakeHome()
  const target = await mkdtemp(join(tmpdir(), 'agent-status-repo-'))
  const elsewhere = await mkdtemp(join(tmpdir(), 'agent-status-elsewhere-'))
  try {
    await mkdir(join(target, '.agent-team', 'status'), { recursive: true })
    try {
      await symlink(elsewhere, join(target, '.agent-team', 'status', 'jobs'), 'junction')
    } catch (error) {
      t.skip(`this computer does not let a test make a folder link (${error.code}) - NOT CHECKED here`)
      return
    }
    const result = await run(fake, [], { target })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /is a link to somewhere else/)
    assert.deepEqual(await readdir(elsewhere), [], 'something was written through the link')
    assert.equal(existsSync(join(target, ...USAGE.split('/'))), false, 'the usage file was written although jobs was refused')
  } finally {
    await fake.cleanup()
    await rm(target, { recursive: true, force: true })
    await rm(elsewhere, { recursive: true, force: true })
  }
})

// --- commit, receipt ------------------------------------------------------------------------------------------------------

test('--commit: the jobs file travels in the one commit with the other parts, and the receipt lists it with its hash and its statuses', async () => {
  const repo = await makeRemote()
  const { fake, extra } = await aMac()
  try {
    const stateDir = join(repo.root, 'state')
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir, extra })
    assert.equal(result.code, 0, result.stderr)
    const files = (await git(['show', '--name-only', '--format=', 'HEAD'], repo.work)).stdout.trim().split('\n').sort()
    assert.deepEqual(files, [CONNECTIONS, HERMES, JOBS, USAGE])
    const subjects = (await git(['log', '--format=%s', 'origin/main'], repo.work)).stdout.trim().split('\n')
    assert.deepEqual(subjects, ['Status snapshot from Test PC', 'start'], 'one commit carried every file')

    const [claim] = await readdir(join(stateDir, 'claims'))
    const receipt = JSON.parse(await readFile(join(stateDir, 'claims', claim, 'receipt.json'), 'utf8'))
    assert.deepEqual(receipt.parts, ['usage', 'connections', 'hermes', 'jobs'])
    assert.deepEqual(receipt.files.map((entry) => entry.file), [USAGE, CONNECTIONS, HERMES, JOBS])
    for (const entry of receipt.files) {
      const bytes = await readFile(join(repo.work, ...entry.file.split('/')))
      assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'))
    }
    assert.deepEqual(Object.keys(receipt.sources), ['usage', 'connections', 'hermes', 'jobs'])
    assert.deepEqual(receipt.sources.jobs, { launchd: 'found', hermes: 'not found', items: 3 })
    assert.deepEqual(checkAgainst(receipt, RECEIPT_SHAPE, fake.identity), [])
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('the receipt gate accepts the jobs file path and its sources, and refuses a jobs source with a name in it', () => {
  const identity = { username: 'fakeperson', home: '/Users/fakeperson', hostname: 'fake-host-77' }
  const receipt = () => ({
    schema: 'agent-status/receipt/v2',
    claimedAt: '2026-10-09T15:00:00Z',
    computer: 'Mac Mini',
    parts: ['jobs'],
    files: [{ file: '.agent-team/status/jobs/mac-mini.json', sha256: 'a'.repeat(64) }],
    sources: { jobs: { launchd: 'found', hermes: 'not found', items: 12 } }
  })
  assert.deepEqual(checkAgainst(receipt(), RECEIPT_SHAPE, identity), [])
  const cases = [
    [(r) => { r.sources.jobs.items = 'twelve' }, /sources\.jobs\.items/],
    [(r) => { r.sources.jobs.launchd = 'local.donna.x' }, /sources\.jobs\.launchd/],
    [(r) => { r.sources.jobs.names = ['local.donna.x'] }, /sources\.jobs\.names: is not an allowed key/],
    [(r) => { delete r.sources.jobs.hermes }, /sources\.jobs\.hermes: is missing/],
    [(r) => { r.files[0].file = '.agent-team/status/jobs/../x.json' }, /files\[0\]\.file/]
  ]
  for (const [change, field] of cases) {
    const value = receipt()
    change(value)
    const problems = checkAgainst(value, RECEIPT_SHAPE, identity)
    assert.ok(problems.some((problem) => field.test(problem)), `not refused: ${field} (${problems.join(' | ')})`)
  }
})

test('dedicated clone: a jobs file left over is the collector\'s own when this run writes jobs, and somebody else\'s when it does not', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const dedicated = await repo.clone('dedicated')
    await mkdir(join(dedicated, '.agent-team', 'status', 'jobs'), { recursive: true })
    await writeFile(join(dedicated, ...JOBS.split('/')), '{}\n')
    const withJobs = await collect(fake, ['--commit', '--clone', dedicated, '--only', 'jobs'], { repo: repo.work, stateDir: join(repo.root, 'state-1') })
    assert.equal(withJobs.code, 0, withJobs.stderr)
    await writeFile(join(dedicated, ...JOBS.split('/')), '{"changed": true}\n')
    const withoutJobs = await collect(fake, ['--commit', '--clone', dedicated, '--only', 'usage'], { repo: repo.work, stateDir: join(repo.root, 'state-2') })
    assert.equal(withoutJobs.code, 2)
    assert.match(withoutJobs.stderr, /not a dedicated clone/)
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

// --- the hostile Mac, through a whole run -----------------------------------------------------------------------------------------

test('a Mac and a Hermes full of secrets, through a whole committed run: the files, the receipt, the log and every error say none of it', async () => {
  const repo = await makeRemote()
  const fake = await hostileHome()
  try {
    const mac = await hostileMac(fake, NOW)
    const exec = fakePrograms({ plists: mac.plists, launchctl: mac.launchctl })
    const stateDir = join(repo.root, 'state')
    const result = await collect(fake, ['--commit', '--only', 'jobs'], { repo: repo.work, stateDir, extra: { platform: 'darwin', exec, appsFolder: join(fake.root, 'Applications') } })
    assert.equal(result.code, 0, result.stderr)

    const doc = await readAt(repo.work, JOBS)
    assert.deepEqual(checkJobs(doc, fake.identity), [])
    // What it did keep: the jobs the wall shows, each Hermes job under its id, never the name the file gives it.
    assert.deepEqual(doc.launchd.items.map((item) => item.label), ['local.donna.blog-watch', 'local.donna.security-changelog', 'local.donna.story-belt-daily'])
    assert.equal(doc.launchd.hidden, 2, 'the label with the username and the one with the email')
    assert.deepEqual(doc.hermes.items.map((item) => `${item.profile}/${item.name}/${item.lastResult}`), ['default/Hermes job brief1/ok', 'default/Hermes job mail1/ok', 'default/Hermes job review1/error', 'default/Hermes job unnamed1/ok', 'donna/Hermes job donna1/error'])
    assert.equal(doc.hermes.hidden, 1, 'only the profile named after the person: a job called after an email is no longer a reason to hide it')

    const [claim] = await readdir(join(stateDir, 'claims'))
    const outputs = [
      result.stdout,
      result.stderr,
      await readFile(join(stateDir, 'claims', claim, 'receipt.json'), 'utf8'),
      await readFile(join(stateDir, 'claims', claim, 'final.json'), 'utf8'),
      ...(await Promise.all((await filesUnder(repo.work)).filter((file) => !file.includes(`${join('.git')}`) && !file.endsWith('README.md')).map((file) => readFile(file, 'utf8')))),
      (await git(['log', '--format=%B', '-5'], repo.work)).stdout,
      (await git(['show', 'HEAD'], repo.work)).stdout
    ]
    const output = outputs.join('\n')
    for (const needle of [...FORBIDDEN(), FAKE_USERNAME, 'secret-client', 'Library/Logs', 'StandardOutPath']) {
      assert.ok(!output.includes(needle), `an output contained a forbidden string (${needle.slice(0, 6)}...)`)
    }
    // And through the remote: what was pushed is the same.
    const pushed = (await git(['show', 'main:' + JOBS], repo.remote)).stdout
    for (const needle of FORBIDDEN()) assert.ok(!pushed.includes(needle), `the pushed file contained a forbidden string (${needle.slice(0, 6)}...)`)
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('if even the unavailable file would not pass the gate, nothing is written: the fallback is checked like any file', async () => {
  const fake = await makeFakeHome()
  try {
    // A clock that gives no time makes the file's own time invalid, so the file is refused - and so is the
    // fallback, which carries the same time. The run must stop, not write a file the gate has not passed.
    const result = await run(fake, ['--only', 'jobs'], { extra: { now: NaN } })
    assert.equal(result.code, 1)
    assert.deepEqual(await filesUnder(result.target), [])
    assert.match(result.stderr, /Nothing written/)
    assert.match(result.stderr, /jobs: takenAt/)
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})
