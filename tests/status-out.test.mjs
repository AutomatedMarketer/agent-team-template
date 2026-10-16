import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile, symlink, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join, sep } from 'node:path'
import { runCollector, outFolderProblems } from '../scripts/lib/status/run.mjs'
import { collectConnections } from '../scripts/lib/status/connections.mjs'
import { collectJobs } from '../scripts/lib/status/jobs.mjs'
import { whyLeaveVaultsAlone } from '../scripts/lib/status/vaults.mjs'
import { makeFakeHome } from './helpers/fake-home.mjs'
import { hostileHome, FORBIDDEN, depsFor, filesUnder, NOW } from './helpers/hostile-home.mjs'
import { placeVaults, setAllowed, allowText } from './helpers/obsidian-home.mjs'

/* --out <folder> is the Student Edition's way to run the collector on demand: the snapshot files go to a
   folder outside every repo, and no git command runs. The default run (the Mac Mini's scheduled one, which
   commits and pushes) is pinned by the rest of the collector's tests, which are unchanged; the byte-for-byte
   comparison below pins that --out writes the very same files the default writes. */

const isWindows = process.platform === 'win32'
const OWN = '.agent-team/status/usage/test-pc.json'
const relativeFiles = async (dir) => (await filesUnder(dir)).map((file) => file.slice(dir.length + 1).replaceAll('\\', '/')).sort()

const temp = (name) => mkdtemp(join(tmpdir(), name))

// A git that fails the test the moment anything calls it.
function gitSpy() {
  const calls = []
  const spy = async (args) => {
    calls.push(args)
    throw new Error('git must not run in --out mode')
  }
  spy.calls = calls
  return spy
}

async function collect(fake, args, { repo, extra = {} } = {}) {
  const target = repo ?? (await temp('agent-out-repo-'))
  const stdout = []
  const stderr = []
  const deps = depsFor(fake, extra)
  const code = await runCollector({
    // --state-dir only means something with --commit or --out; a plain run uses the default one.
    argv: ['--computer', 'Test PC', ...(args.includes('--out') ? ['--state-dir', join(fake.root, 'state')] : []), ...args],
    deps,
    repoRoot: target,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line)
  })
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n'), repo: target, deps }
}

// A link to a folder that works without special rights on Windows too (a junction), or null if it cannot be made.
async function link(target, path) {
  try {
    await symlink(target, path, 'junction')
    return true
  } catch {
    return false
  }
}

// --- what it does -------------------------------------------------------------------------------------

test('--out writes every file of the run to the folder, and the repo folder is left empty', async () => {
  const fake = await hostileHome()
  const out = await temp('agent-out-')
  try {
    const result = await collect(fake, ['--out', out])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await relativeFiles(result.repo), [], 'nothing is written into the repo folder')
    const files = await relativeFiles(out)
    assert.ok(files.includes(OWN))
    assert.ok(files.includes('runs/heartbeat/hermes.json'))
    assert.equal(files.length, 5)
    // The log names the file the way the default run does - relative, never the full folder.
    assert.match(result.stdout, /Wrote \.agent-team\/status\/usage\/test-pc\.json/)
    assert.ok(!result.stdout.includes(out), 'the out folder path is not printed')
    await rm(result.repo, { recursive: true, force: true })
  } finally {
    await rm(out, { recursive: true, force: true })
    await fake.cleanup()
  }
})

test('--out writes the same bytes the default run writes into a repo folder', async () => {
  const fake = await hostileHome()
  const out = await temp('agent-out-')
  try {
    const plain = await collect(fake, [])
    const outRun = await collect(fake, ['--out', out])
    assert.equal(plain.code, 0, plain.stderr)
    assert.equal(outRun.code, 0, outRun.stderr)
    const inRepo = await relativeFiles(plain.repo)
    assert.ok(inRepo.length >= 5, 'the default run still writes into the repo folder')
    assert.deepEqual(await relativeFiles(out), inRepo)
    for (const file of inRepo) {
      assert.equal(await readFile(join(out, ...file.split('/')), 'utf8'), await readFile(join(plain.repo, ...file.split('/')), 'utf8'), file)
    }
    assert.equal(plain.stdout, outRun.stdout, 'and says the same things')
    await rm(plain.repo, { recursive: true, force: true })
    await rm(outRun.repo, { recursive: true, force: true })
  } finally {
    await rm(out, { recursive: true, force: true })
    await fake.cleanup()
  }
})

test('--out runs no git command at all - not to check a link, not to anything', async () => {
  const fake = await hostileHome()
  const out = await temp('agent-out-')
  try {
    const spy = gitSpy()
    const result = await collect(fake, ['--out', out], { extra: { git: spy } })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(spy.calls, [])
    assert.ok((await relativeFiles(out)).length >= 5, 'and the files were written')
    await rm(result.repo, { recursive: true, force: true })
  } finally {
    await rm(out, { recursive: true, force: true })
    await fake.cleanup()
  }
})

test('--out takes no lock and leaves no claim: the state folder is not made', async () => {
  const fake = await hostileHome()
  const out = await temp('agent-out-')
  try {
    const result = await collect(fake, ['--out', out, '--only', 'usage'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await relativeFiles(out), [OWN])
    assert.deepEqual(await relativeFiles(join(fake.root, 'state')).catch(() => []), [])
    await rm(result.repo, { recursive: true, force: true })
  } finally {
    await rm(out, { recursive: true, force: true })
    await fake.cleanup()
  }
})

test('--out makes the folder when it is not there yet, however deep', async () => {
  const fake = await makeFakeHome()
  const base = await temp('agent-out-')
  try {
    const out = join(base, 'a', 'b', 'status')
    const result = await collect(fake, ['--out', out, '--only', 'usage'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await relativeFiles(out), [OWN])
    await rm(result.repo, { recursive: true, force: true })
  } finally {
    await rm(base, { recursive: true, force: true })
    await fake.cleanup()
  }
})

test('--out with nothing different since the last run: the earlier file in the OUT folder decides, not the repo', async () => {
  const fake = await makeFakeHome()
  const out = await temp('agent-out-')
  try {
    const placed = await placeVaults(fake, 'linux', { Orchard: { files: { 'Pear.md': 'Pears. [[Apple]]', 'Apple.md': 'Cold.' } } })
    assert.ok(placed.places.Orchard)
    await setAllowed(join(fake.root, 'state'), allowText(['Orchard']))
    const repo = await temp('agent-out-repo-')
    await writeFile(join(repo, 'vaults.yml'), 'vaults:\n  - name: Orchard\n')
    const first = await collect(fake, ['--out', out, '--only', 'vaults'], { repo })
    assert.equal(first.code, 0, first.stderr)
    assert.match(first.stdout, /Wrote \.agent-team\/status\/vaults\/test-pc\.json/)
    const second = await collect(fake, ['--out', out, '--only', 'vaults'], { repo, extra: { now: NOW + 3600_000 } })
    assert.equal(second.code, 0, second.stderr)
    assert.match(second.stdout, /Nothing changed since the last snapshot, so nothing was written/)
    assert.deepEqual(await relativeFiles(repo), ['vaults.yml'], 'the repo only ever held vaults.yml')
    await rm(repo, { recursive: true, force: true })
  } finally {
    await rm(out, { recursive: true, force: true })
    await fake.cleanup()
  }
})

test('whyLeaveVaultsAlone reads the earlier file from priorDir when it is given, and from dataDir when it is not', async () => {
  const data = await temp('agent-out-data-')
  const prior = await temp('agent-out-prior-')
  try {
    const relativePath = '.agent-team/status/vaults/test-pc.json'
    const doc = { schema: 'agent-status/vaults/v1', computer: 'Test PC', takenAt: '2026-10-07T20:00:00Z', vaults: { status: 'not found' } }
    await mkdir(join(prior, '.agent-team', 'status', 'vaults'), { recursive: true })
    await writeFile(join(prior, ...relativePath.split('/')), JSON.stringify(doc))
    const deps = { now: NOW, dataDir: data }
    assert.equal(await whyLeaveVaultsAlone({ ...deps, priorDir: prior }, relativePath, doc), 'unchanged')
    assert.equal(await whyLeaveVaultsAlone(deps, relativePath, doc), 'nothing named', 'without priorDir it looks in dataDir, as before')
  } finally {
    await rm(data, { recursive: true, force: true })
    await rm(prior, { recursive: true, force: true })
  }
})

// --- the folder must be a safe one ---------------------------------------------------------------------

async function refused(fake, args, { repo } = {}) {
  const result = await collect(fake, args, { repo })
  assert.equal(result.code, 2, `expected a refusal before anything was read (exit ${result.code}): ${result.stderr}`)
  assert.equal(result.deps.fetch.calls.length, 0, 'nothing was read from the network')
  assert.deepEqual(await relativeFiles(result.repo), [], 'and nothing was written to the repo')
  return result
}

test('--out must be a full path: a relative one, an empty one and a bare name are refused', async () => {
  const fake = await makeFakeHome()
  try {
    for (const bad of ['status', './status', '../status', '']) {
      const result = await refused(fake, ['--out', bad])
      assert.match(result.stderr, /--out/)
      await rm(result.repo, { recursive: true, force: true })
    }
  } finally {
    await fake.cleanup()
  }
})

test('a relative --out is refused whatever folder the collector was started from (it would land under that folder)', async () => {
  const fake = await makeFakeHome()
  const here = process.cwd()
  const start = await temp('agent-out-cwd-')
  try {
    process.chdir(start)
    const result = await refused(fake, ['--out', 'status'])
    assert.deepEqual(await relativeFiles(start), [], 'nothing was written under the folder it started in')
    await rm(result.repo, { recursive: true, force: true })
  } finally {
    process.chdir(here)
    await rm(start, { recursive: true, force: true })
    await fake.cleanup()
  }
})

test('a source that is handed deps.git finds none in --out mode', async () => {
  const fake = await makeFakeHome()
  const out = await temp('agent-out-')
  try {
    const spy = gitSpy()
    const seen = []
    const connections = async (deps, computer) => {
      seen.push(typeof deps.git)
      if (typeof deps.git === 'function') await deps.git(['probe']).catch(() => {})
      return collectConnections(deps, computer)
    }
    const result = await collect(fake, ['--out', out, '--only', 'connections'], { extra: { git: spy, sources: { connections } } })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(seen, ['undefined'])
    assert.deepEqual(spy.calls, [])
    await rm(result.repo, { recursive: true, force: true })
  } finally {
    await rm(out, { recursive: true, force: true })
    await fake.cleanup()
  }
})

// --- the folder is swapped for a link while the run is going --------------------------------------------

// A source that, when it is asked for its part, replaces the out folder with a link into a git repo - as a
// program on this computer could during the two minutes the connections part may take.
async function swapDuring(fake, out, victim) {
  const repo = await temp('agent-out-repo-')
  const jobs = async (deps, computer) => {
    await rm(out, { recursive: true, force: true })
    await symlink(victim, out, 'junction')
    return collectJobs(deps, computer)
  }
  return collect(fake, ['--out', out, '--only', 'jobs'], { repo, extra: { sources: { jobs } } })
}

test('the out folder swapped for a link into a git repo during the run: refused, nothing lands in that repo', async () => {
  const fake = await makeFakeHome()
  const base = await temp('agent-out-')
  try {
    const victim = await temp('agent-out-victim-')
    await mkdir(join(victim, '.git'))
    const out = join(base, 'out')
    await mkdir(out)
    const result = await swapDuring(fake, out, victim)
    assert.notEqual(result.code, 0, 'the run did not report success')
    assert.deepEqual(await relativeFiles(victim), [], 'nothing was written in the repo the link pointed to')
    await rm(result.repo, { recursive: true, force: true })
    await rm(victim, { recursive: true, force: true })
  } finally {
    await rm(base, { recursive: true, force: true })
    await fake.cleanup()
  }
})

test('an out folder that did not exist when checked, made a link into a git repo before it was created: refused', async () => {
  const fake = await makeFakeHome()
  const base = await temp('agent-out-')
  try {
    const victim = await temp('agent-out-victim-')
    await mkdir(join(victim, '.git'))
    const result = await swapDuring(fake, join(base, 'not-yet'), victim)
    assert.notEqual(result.code, 0)
    assert.deepEqual(await relativeFiles(victim), [])
    await rm(result.repo, { recursive: true, force: true })
    await rm(victim, { recursive: true, force: true })
  } finally {
    await rm(base, { recursive: true, force: true })
    await fake.cleanup()
  }
})

// --- odd paths ---------------------------------------------------------------------------------------------

test('a path with a NUL character is refused with exit 2, not a crash', async () => {
  const fake = await makeFakeHome()
  try {
    const result = await refused(fake, ['--out', join(tmpdir(), 'bad' + String.fromCharCode(0) + 'name')])
    await rm(result.repo, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('an --out that cannot be checked is refused, whatever the reason (checking never throws)', async () => {
  const repo = await temp('agent-out-repo-')
  try {
    const missingDrive = isWindows ? [...'ZYXWVUTSRQPONMLKJIHGFED'].find((letter) => !existsSync(letter + ':' + sep)) : null
    const odd = isWindows ? [...(missingDrive ? [missingDrive + ':' + sep + 'no-such-drive' + sep + 'x'] : []), 'C:' + sep + 'tmp' + sep + 'NUL', 'C:' + sep + 'CON'] : ['/proc/self/mem/x']
    for (const path of odd) {
      assert.ok((await outFolderProblems(path, repo)).length > 0, path + ' was accepted')
    }
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('on Windows a network path, a long-path spelling, a stream name and a trailing dot or space are refused', { skip: !isWindows && 'Windows spellings' }, async () => {
  const repo = await temp('agent-out-repo-')
  const BS = String.fromCharCode(92)
  try {
    const drive = repo.slice(0, 1)
    const rest = repo.slice(2)
    const spellings = [
      BS + BS + 'localhost' + BS + drive + '$' + rest + BS + 'x',
      BS + BS + '?' + BS + repo + BS + 'x',
      BS + BS + '?' + BS + 'UNC' + BS + 'localhost' + BS + drive + '$' + rest + BS + 'x',
      BS + BS + '.' + BS + repo + BS + 'x',
      repo + '.' + BS + 'x',
      repo + ' ' + BS + 'x',
      repo + '::$INDEX_ALLOCATION' + BS + 'x'
    ]
    for (const path of spellings) {
      assert.ok((await outFolderProblems(path, repo)).length > 0, path + ' was accepted')
    }
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('the repo is recognised by what it is, not how its path is spelled: its 8.3 short name is refused', { skip: !isWindows && 'Windows short names' }, async () => {
  const repo = await mkdtemp(join(tmpdir(), 'agent-out-a-long-repo-name-'))
  try {
    let short
    try {
      short = execFileSync('cmd', ['/c', 'for', '%I', 'in', '("' + repo + '")', 'do', '@echo', '%~sI'], { encoding: 'utf8' }).trim()
    } catch {
      return
    }
    if (!short || short.toLowerCase() === repo.toLowerCase()) return // short names are off on this drive
    assert.ok((await outFolderProblems(join(short, 'x'), repo)).length > 0, 'the short name got through')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('--out inside the repo folder is refused, and so is the repo folder itself', async () => {
  const fake = await makeFakeHome()
  try {
    const repo = await temp('agent-out-repo-')
    for (const inside of [join(repo, 'status'), join(repo, '.agent-team', 'status'), repo]) {
      const result = await refused(fake, ['--out', inside], { repo })
      assert.match(result.stderr, /inside the folder the collector runs in|inside this working copy/)
    }
    assert.deepEqual(await relativeFiles(repo), [])
    await rm(repo, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('--out that is a link into the repo folder is refused', async () => {
  const fake = await makeFakeHome()
  const base = await temp('agent-out-')
  try {
    const repo = await temp('agent-out-repo-')
    const door = join(base, 'door')
    if (!(await link(repo, door))) return // links cannot be made here
    await refused(fake, ['--out', door], { repo })
    await refused(fake, ['--out', join(door, 'deeper')], { repo })
    assert.deepEqual(await relativeFiles(repo), [])
    await rm(repo, { recursive: true, force: true })
  } finally {
    await rm(base, { recursive: true, force: true })
    await fake.cleanup()
  }
})

test('--out that is itself a link is refused, even to a harmless folder', async () => {
  const fake = await makeFakeHome()
  const base = await temp('agent-out-')
  try {
    const elsewhere = await temp('agent-out-elsewhere-')
    const door = join(base, 'door')
    if (!(await link(elsewhere, door))) return
    const result = await refused(fake, ['--out', door])
    assert.match(result.stderr, /link/)
    assert.deepEqual(await relativeFiles(elsewhere), [])
    await rm(result.repo, { recursive: true, force: true })
    await rm(elsewhere, { recursive: true, force: true })
  } finally {
    await rm(base, { recursive: true, force: true })
    await fake.cleanup()
  }
})

test('--out inside any git repo is refused (found by looking for .git, with no git command)', async () => {
  const fake = await makeFakeHome()
  const base = await temp('agent-out-')
  try {
    await mkdir(join(base, '.git'))
    const spy = gitSpy()
    const result = await collect(fake, ['--out', join(base, 'deep', 'status')], { extra: { git: spy } })
    assert.equal(result.code, 2, result.stderr)
    assert.match(result.stderr, /git repo/)
    assert.equal(result.deps.fetch.calls.length, 0)
    assert.deepEqual(spy.calls, [])
    assert.deepEqual(await relativeFiles(base), [])
    await rm(result.repo, { recursive: true, force: true })
    // A repo that is a linked work tree has a .git FILE, not a folder: also a repo.
    await rm(join(base, '.git'), { recursive: true })
    await writeFile(join(base, '.git'), 'gitdir: /somewhere/else\n')
    const second = await collect(fake, ['--out', join(base, 'status')])
    assert.equal(second.code, 2, second.stderr)
    await rm(second.repo, { recursive: true, force: true })
  } finally {
    await rm(base, { recursive: true, force: true })
    await fake.cleanup()
  }
})

test('--out that is a file, not a folder, is refused', async () => {
  const fake = await makeFakeHome()
  const base = await temp('agent-out-')
  try {
    const file = join(base, 'status')
    await writeFile(file, 'not a folder')
    const result = await refused(fake, ['--out', file])
    await rm(result.repo, { recursive: true, force: true })
  } finally {
    await rm(base, { recursive: true, force: true })
    await fake.cleanup()
  }
})

test('--out cannot be combined with --commit, --dry-run or --clone', async () => {
  const fake = await makeFakeHome()
  const out = await temp('agent-out-')
  try {
    for (const other of [['--commit'], ['--dry-run'], ['--clone', await temp('agent-out-clone-')]]) {
      const result = await refused(fake, ['--out', out, ...other])
      assert.match(result.stderr, /--out/)
      await rm(result.repo, { recursive: true, force: true })
    }
    assert.deepEqual(await relativeFiles(out), [])
  } finally {
    await rm(out, { recursive: true, force: true })
    await fake.cleanup()
  }
})

test('a link in the out folder\'s own tree (.agent-team, status, usage) stops the run and nothing lands where the link points', async () => {
  const fake = await makeFakeHome()
  const out = await temp('agent-out-')
  const elsewhere = await temp('agent-out-elsewhere-')
  try {
    for (const at of [['.agent-team'], ['.agent-team', 'status'], ['.agent-team', 'status', 'usage']]) {
      await rm(join(out, '.agent-team'), { recursive: true, force: true })
      if (at.length > 1) await mkdir(join(out, ...at.slice(0, -1)), { recursive: true })
      if (!(await link(elsewhere, join(out, ...at)))) return
      const result = await collect(fake, ['--out', out, '--only', 'usage'])
      assert.equal(result.code, 1, `${at.join('/')}: ${result.stderr}`)
      assert.match(result.stderr, /is a link to somewhere else/)
      assert.deepEqual(await relativeFiles(elsewhere), [], `${at.join('/')}: nothing went through the link`)
      await rm(result.repo, { recursive: true, force: true })
    }
  } finally {
    await rm(out, { recursive: true, force: true })
    await rm(elsewhere, { recursive: true, force: true })
    await fake.cleanup()
  }
})

// --- privacy ---------------------------------------------------------------------------------------------

test('the folders and files --out makes are private to the user where the system has file modes', { skip: isWindows && 'Windows has no file modes Node can set' }, async () => {
  const fake = await makeFakeHome()
  const base = await temp('agent-out-')
  try {
    const out = join(base, 'a', 'status')
    const result = await collect(fake, ['--out', out, '--only', 'usage'])
    assert.equal(result.code, 0, result.stderr)
    for (const dir of [join(base, 'a'), out, join(out, '.agent-team'), join(out, '.agent-team', 'status'), join(out, '.agent-team', 'status', 'usage')]) {
      assert.equal((await stat(dir)).mode & 0o077, 0, `${dir.slice(base.length)} is open to others`)
    }
    assert.equal((await stat(join(out, ...OWN.split('/')))).mode & 0o077, 0, 'the file is open to others')
    await rm(result.repo, { recursive: true, force: true })
  } finally {
    await rm(base, { recursive: true, force: true })
    await fake.cleanup()
  }
})

test('the default run is unchanged: its folders and files are made as before, with no mode asked for', { skip: isWindows && 'Windows has no file modes Node can set' }, async () => {
  const fake = await makeFakeHome()
  try {
    const plain = await collect(fake, ['--only', 'usage'])
    assert.equal(plain.code, 0, plain.stderr)
    const mode = (await stat(join(plain.repo, ...OWN.split('/')))).mode & 0o777
    // 0o666 less the umask: group and other bits come from the umask, not from the collector.
    const umask = process.umask()
    assert.equal(mode, 0o666 & ~umask)
    await rm(plain.repo, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('--out never lets a token, a prompt, a log line or the user name reach the files or the log', async () => {
  const fake = await hostileHome()
  const out = await temp('agent-out-')
  try {
    const result = await collect(fake, ['--out', out])
    assert.equal(result.code, 0, result.stderr)
    const outputs = [result.stdout, result.stderr]
    for (const file of await filesUnder(out)) outputs.push(await readFile(file, 'utf8'))
    assert.ok(outputs.length > 6)
    for (const output of outputs) {
      for (const needle of FORBIDDEN()) assert.ok(!output.includes(needle), `an output contained a forbidden string (${needle.slice(0, 6)}...)`)
    }
    // The refusals do not echo the folder either: it holds the user name.
    const refusal = await collect(fake, ['--out', join(result.repo, 'inside')], { repo: result.repo })
    assert.equal(refusal.code, 2)
    assert.ok(!refusal.stderr.includes(result.repo) && !refusal.stderr.includes(sep + 'inside'))
    await rm(result.repo, { recursive: true, force: true })
  } finally {
    await rm(out, { recursive: true, force: true })
    await fake.cleanup()
  }
})
