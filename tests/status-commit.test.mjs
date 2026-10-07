import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runCollector } from '../scripts/lib/status/run.mjs'
import { makeFakeHome, setMtime } from './helpers/fake-home.mjs'
import { hostileHome, FORBIDDEN, depsFor, filesUnder, NOW } from './helpers/hostile-home.mjs'
import { repoRoot } from './helpers/repo.mjs'

/* Commit mode is the part that touches somebody's repo unattended, every three hours. Two rules
   carry it: it commits only its own file, whatever else is staged; and a refused push in a
   person's own working copy stops and says so, while only the collector's dedicated clone may be
   reset and retried. These run real git against a throwaway bare remote - no network. */

const execFileP = promisify(execFile)
const git = (args, cwd) => execFileP('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
const OWN = '.agent-team/status/usage/test-pc.json'

async function makeRemote() {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-git-'))
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
  return { root, remote, seed, work, clone, cleanup: () => rm(root, { recursive: true, force: true }) }
}

// Someone else pushes while the collector is not looking.
async function advanceRemote(repo, name) {
  await git(['pull', '-q', '--ff-only'], repo.seed).catch(() => {})
  await writeFile(join(repo.seed, `${name}.md`), `${name}\n`)
  await git(['add', '.'], repo.seed)
  await git(['commit', '-q', '-m', name], repo.seed)
  await git(['push', '-q'], repo.seed)
}

const realGit = async (args, cwd) => git(args, cwd)

async function collect(fake, args, { repo, extra = {}, stateDir }) {
  const stdout = []
  const stderr = []
  const code = await runCollector({
    argv: ['--computer', 'Test PC', '--state-dir', stateDir, ...args],
    deps: depsFor(fake, { git: realGit, ...extra }),
    repoRoot: repo,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line)
  })
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
}

const log = async (dir, ref = 'HEAD') => (await git(['log', '--format=%s', ref], dir)).stdout.trim().split('\n')
const filesIn = async (dir, ref = 'HEAD') => (await git(['show', '--name-only', '--format=', ref], dir)).stdout.trim().split('\n')

test('working copy: commits only its own file, leaves other staged work staged, and pushes', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    await writeFile(join(repo.work, 'notes.md'), 'half-finished thought\n')
    await git(['add', 'notes.md'], repo.work)
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir: join(repo.root, 'state') })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await filesIn(repo.work), [OWN])
    assert.equal((await log(repo.work))[0], 'Usage snapshot from Test PC')
    const staged = (await git(['diff', '--cached', '--name-only'], repo.work)).stdout.trim()
    assert.equal(staged, 'notes.md', 'the other staged file was committed or unstaged')
    assert.equal((await log(repo.remote, 'main'))[0], 'Usage snapshot from Test PC')
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

// A plain `git push` sends every unpushed commit on the branch, and pushes whatever branch the
// person happens to be on. In somebody's own copy the collector pushes only when the push would
// carry the snapshot alone, to the branch the dashboard reads - otherwise it commits and says why.

const pushRecorder = () => {
  const pushes = []
  const recordingGit = async (args, cwd) => {
    if (args[0] === 'push') pushes.push(args)
    return realGit(args, cwd)
  }
  return { pushes, recordingGit }
}

const finalRecord = async (stateDir) => {
  const [claim] = await readdir(join(stateDir, 'claims'))
  return JSON.parse(await readFile(join(stateDir, 'claims', claim, 'final.json'), 'utf8'))
}

test('working copy: pushes with an explicit refspec to the default branch', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const { pushes, recordingGit } = pushRecorder()
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir: join(repo.root, 'state'), extra: { git: recordingGit } })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(pushes, [['push', '--quiet', 'origin', 'HEAD:refs/heads/main']])
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('working copy: with other unpushed commits it commits the snapshot, does not push, and says why', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    await writeFile(join(repo.work, 'plan.md'), 'not ready to share\n')
    await git(['add', 'plan.md'], repo.work)
    await git(['commit', '-q', '-m', 'My private plan'], repo.work)
    const stateDir = join(repo.root, 'state')
    const { pushes, recordingGit } = pushRecorder()
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir, extra: { git: recordingGit } })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(pushes, [], 'it pushed, and would have sent the person\'s own commit too')
    assert.deepEqual(await log(repo.work), ['Usage snapshot from Test PC', 'My private plan', 'start'])
    assert.deepEqual(await log(repo.remote, 'main'), ['start'])
    assert.match(result.stdout, /committed here but was not pushed/i)
    assert.match(result.stdout, /other commits that are not pushed yet/i)
    assert.equal((await finalRecord(stateDir)).outcome, 'committed, not pushed')
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('working copy: on another branch it commits the snapshot there, does not push, and says why', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    await git(['checkout', '-q', '-b', 'experiment'], repo.work)
    await git(['push', '-q', '-u', 'origin', 'experiment'], repo.work)
    const { pushes, recordingGit } = pushRecorder()
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir: join(repo.root, 'state'), extra: { git: recordingGit } })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(pushes, [])
    assert.equal((await log(repo.work))[0], 'Usage snapshot from Test PC')
    assert.deepEqual(await log(repo.remote, 'experiment'), ['start'])
    assert.deepEqual(await log(repo.remote, 'main'), ['start'])
    assert.match(result.stdout, /committed here but was not pushed/i)
    assert.match(result.stdout, /not on main, the branch the dashboard reads/i)
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('working copy: the default branch is the one the remote names, not always main', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    // The remote says its default is "trunk"; this copy is on main.
    await git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'], repo.work)
    const { pushes, recordingGit } = pushRecorder()
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir: join(repo.root, 'state'), extra: { git: recordingGit } })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(pushes, [])
    assert.match(result.stdout, /not on trunk, the branch the dashboard reads/i)
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('dedicated clone: pushes with an explicit refspec too', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const dedicated = await repo.clone('dedicated')
    const { pushes, recordingGit } = pushRecorder()
    const result = await collect(fake, ['--commit', '--clone', dedicated], { repo: repo.work, stateDir: join(repo.root, 'state'), extra: { git: recordingGit } })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(pushes, [['push', '--quiet', 'origin', 'HEAD:refs/heads/main']])
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('working copy: a refused push stops and says so, and nothing is reset', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    await advanceRemote(repo, 'someone-else')
    await writeFile(join(repo.work, 'notes.md'), 'mine\n')
    await git(['add', 'notes.md'], repo.work)
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir: join(repo.root, 'state') })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /push was refused/i)
    assert.match(result.stderr, /left as it is/i)
    assert.equal((await log(repo.work))[0], 'Usage snapshot from Test PC', 'the local commit should stay')
    assert.equal((await git(['diff', '--cached', '--name-only'], repo.work)).stdout.trim(), 'notes.md')
    assert.ok(existsSync(join(repo.work, 'notes.md')))
    assert.notEqual((await log(repo.remote, 'main'))[0], 'Usage snapshot from Test PC')
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('dedicated clone: catches up before writing, so another push in between is no problem', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const dedicated = await repo.clone('dedicated')
    await advanceRemote(repo, 'earlier')
    const result = await collect(fake, ['--commit', '--clone', dedicated], { repo: repo.work, stateDir: join(repo.root, 'state') })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual((await log(repo.remote, 'main')).slice(0, 2), ['Usage snapshot from Test PC', 'earlier'])
    assert.equal(existsSync(join(repo.work, ...OWN.split('/'))), false, 'it wrote into the working copy instead of the clone')
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('dedicated clone: a push refused mid-run is fetched, reset, rewritten and retried once', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const dedicated = await repo.clone('dedicated')
    let pushes = 0
    const racingGit = async (args, cwd) => {
      if (args[0] === 'push' && pushes++ === 0) await advanceRemote(repo, 'raced')
      return realGit(args, cwd)
    }
    const result = await collect(fake, ['--commit', '--clone', dedicated], { repo: repo.work, stateDir: join(repo.root, 'state'), extra: { git: racingGit } })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(pushes, 2)
    assert.deepEqual((await log(repo.remote, 'main')).slice(0, 2), ['Usage snapshot from Test PC', 'raced'])
    assert.match(result.stdout, /retried/i)
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('dedicated clone: a second refusal stops rather than looping', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const dedicated = await repo.clone('dedicated')
    let pushes = 0
    const alwaysRacing = async (args, cwd) => {
      if (args[0] === 'push') {
        pushes++
        await advanceRemote(repo, `raced-${pushes}`)
      }
      return realGit(args, cwd)
    }
    const result = await collect(fake, ['--commit', '--clone', dedicated], { repo: repo.work, stateDir: join(repo.root, 'state'), extra: { git: alwaysRacing } })
    assert.equal(result.code, 1)
    assert.equal(pushes, 2, 'it retried more than once')
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('dedicated clone: a folder with someone else\'s changes in it is not a dedicated clone', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    await writeFile(join(repo.work, 'draft.md'), 'work in progress\n')
    const result = await collect(fake, ['--commit', '--clone', repo.work], { repo: join(repo.root, 'elsewhere'), stateDir: join(repo.root, 'state') })
    assert.equal(result.code, 2)
    assert.match(result.stderr, /not a dedicated clone/i)
    assert.ok(existsSync(join(repo.work, 'draft.md')), 'the person\'s file was reset away')
    assert.equal(existsSync(join(repo.work, ...OWN.split('/'))), false)
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

// A clean folder can still hold work: commits that were never pushed. Resetting to the remote
// would throw them away, so a clone with any commit the collector did not make is refused.
test('dedicated clone: unpushed commits that are not snapshots mean it is somebody\'s work', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    await writeFile(join(repo.work, 'plan.md'), 'my plan\n')
    await git(['add', 'plan.md'], repo.work)
    await git(['commit', '-q', '-m', 'My plan'], repo.work)
    const result = await collect(fake, ['--commit', '--clone', repo.work], { repo: join(repo.root, 'code'), stateDir: join(repo.root, 'state') })
    assert.equal(result.code, 2)
    assert.match(result.stderr, /not a dedicated clone/i)
    assert.equal((await log(repo.work))[0], 'My plan', 'the unpushed commit was reset away')
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

// An earlier snapshot commit that never got pushed is the collector's own and safe to replace.
test('dedicated clone: an unpushed snapshot of its own is replaced, not refused', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const dedicated = await repo.clone('dedicated')
    await mkdir(join(dedicated, '.agent-team', 'status', 'usage'), { recursive: true })
    await writeFile(join(dedicated, ...OWN.split('/')), '{}\n')
    await git(['add', '.'], dedicated)
    await git(['commit', '-q', '-m', 'Usage snapshot from Test PC'], dedicated)
    const result = await collect(fake, ['--commit', '--clone', dedicated], { repo: join(repo.root, 'code'), stateDir: join(repo.root, 'state') })
    assert.equal(result.code, 0, result.stderr)
    assert.equal((await log(repo.remote, 'main'))[0], 'Usage snapshot from Test PC')
    assert.equal((await log(repo.remote, 'main')).filter((line) => line.startsWith('Usage snapshot')).length, 1)
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

// The data clone is reset to whatever the remote holds on every run. If the collector's own code
// lived in it, anyone who can push to the team repo - a person, or a cloud agent talked into it -
// would choose the code the Mac runs next, with Keychain access. So the code lives in a separate
// checkout updated by hand, and a run whose code sits inside the data clone refuses outright.
test('dedicated clone: the collector refuses to run when its own code is inside the --clone folder', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const dedicated = await repo.clone('dedicated')
    await advanceRemote(repo, 'pushed-by-someone')
    const before = (await git(['rev-parse', 'HEAD'], dedicated)).stdout.trim()
    for (const code of [dedicated, join(dedicated, 'nested', 'checkout')]) {
      const calls = []
      const recordingGit = async (args, cwd) => {
        calls.push(args[0])
        return realGit(args, cwd)
      }
      const stateDir = join(repo.root, 'state')
      const result = await collect(fake, ['--commit', '--clone', dedicated], { repo: code, stateDir, extra: { git: recordingGit } })
      assert.equal(result.code, 2)
      assert.match(result.stderr, /own code is inside the --clone folder/i)
      assert.deepEqual(calls, [], 'git ran in the data clone before the refusal')
      assert.equal(existsSync(join(stateDir, 'claims')), false, 'it claimed a slot before refusing')
    }
    assert.equal((await git(['rev-parse', 'HEAD'], dedicated)).stdout.trim(), before, 'the data clone was moved')
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('dedicated clone: a --clone path that leads to the code through a link is still refused', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const dedicated = await repo.clone('dedicated')
    const link = join(repo.root, 'link-to-dedicated')
    // A junction needs no special rights on Windows; elsewhere the type is ignored.
    await symlink(dedicated, link, 'junction')
    const result = await collect(fake, ['--commit', '--clone', link], { repo: dedicated, stateDir: join(repo.root, 'state') })
    assert.equal(result.code, 2)
    assert.match(result.stderr, /own code is inside the --clone folder/i)
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('--clone and --state-dir only mean something with --commit', async () => {
  const fake = await makeFakeHome()
  const target = await mkdtemp(join(tmpdir(), 'agent-status-repo-'))
  try {
    for (const args of [['--clone', target], ['--commit', '--dry-run']]) {
      const code = await runCollector({ argv: args, deps: depsFor(fake), repoRoot: target, out: () => {}, err: () => {} })
      assert.equal(code, 2, `${args.join(' ')} was accepted`)
    }
    assert.deepEqual(await filesUnder(target), [])
  } finally {
    await fake.cleanup()
    await rm(target, { recursive: true, force: true })
  }
})

// --- receipts and the lock -------------------------------------------------------------------------------

test('a commit run leaves a claim with a receipt and a final record, statuses and hashes only', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const stateDir = join(repo.root, 'state')
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir })
    assert.equal(result.code, 0, result.stderr)
    const claims = await readdir(join(stateDir, 'claims'))
    assert.deepEqual(claims, ['2026-10-07T20-00-00Z.claim'])
    const receipt = JSON.parse(await readFile(join(stateDir, 'claims', claims[0], 'receipt.json'), 'utf8'))
    const final = JSON.parse(await readFile(join(stateDir, 'claims', claims[0], 'final.json'), 'utf8'))
    assert.equal(receipt.schema, 'agent-status/receipt/v1')
    assert.equal(receipt.file, OWN)
    assert.match(receipt.sha256, /^[0-9a-f]{64}$/)
    assert.deepEqual(Object.keys(receipt.sources).sort(), ['claudeActivity', 'claudeLimits', 'claudePlan', 'codexLimits', 'codexPlan'])
    assert.equal(final.schema, 'agent-status/final/v1')
    assert.equal(final.outcome, 'pushed')
    assert.match(final.commit, /^[0-9a-f]{40}$/)
    assert.equal(final.commit, (await git(['rev-parse', 'HEAD'], repo.work)).stdout.trim())
    assert.ok(!existsSync(join(stateDir, 'lock')), 'the lock was not released')
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('LEAK TEST: receipts from the hostile home carry none of it', async () => {
  const repo = await makeRemote()
  const fake = await hostileHome()
  try {
    const stateDir = join(repo.root, 'state')
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir })
    assert.equal(result.code, 0, result.stderr)
    const texts = [result.stdout, result.stderr]
    for (const file of await filesUnder(stateDir)) texts.push(await readFile(file, 'utf8'))
    texts.push(await readFile(join(repo.work, ...OWN.split('/')), 'utf8'))
    texts.push((await git(['log', '-1', '--format=%B'], repo.work)).stdout)
    for (const text of texts) {
      for (const needle of FORBIDDEN()) {
        assert.ok(!text.includes(needle), `a receipt or output contained a forbidden string (${needle.slice(0, 6)}...)`)
      }
    }
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('a run already holding the lock makes the next one skip, writing nothing', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const stateDir = join(repo.root, 'state')
    await mkdir(join(stateDir, 'lock'), { recursive: true })
    await setMtime(join(stateDir, 'lock'), NOW - 60_000)
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir })
    assert.equal(result.code, 0)
    assert.match(result.stdout, /still running/i)
    assert.equal(existsSync(join(repo.work, ...OWN.split('/'))), false)
    assert.ok(existsSync(join(stateDir, 'lock')), 'it removed somebody else\'s lock')
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('a lock left behind by a crash over an hour ago is taken over', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const stateDir = join(repo.root, 'state')
    await mkdir(join(stateDir, 'lock'), { recursive: true })
    await setMtime(join(stateDir, 'lock'), NOW - 2 * 3600_000)
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir })
    assert.equal(result.code, 0, result.stderr)
    assert.ok(existsSync(join(repo.work, ...OWN.split('/'))))
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('the same occurrence is never run twice', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const stateDir = join(repo.root, 'state')
    assert.equal((await collect(fake, ['--commit'], { repo: repo.work, stateDir })).code, 0)
    const second = await collect(fake, ['--commit'], { repo: repo.work, stateDir })
    assert.equal(second.code, 0)
    assert.match(second.stdout, /already/i)
    assert.equal((await log(repo.work)).filter((line) => line.startsWith('Usage snapshot')).length, 1)
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('the collector never writes into the template repo itself during these tests', () => {
  assert.equal(existsSync(join(repoRoot, '.agent-team', 'status', 'usage')), false)
})
