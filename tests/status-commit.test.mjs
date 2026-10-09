import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { runCollector } from '../scripts/lib/status/run.mjs'
import { slotStamp, codeCommit, scheduledClaimName } from '../scripts/lib/status/commit.mjs'
import { makeFakeHome, setMtime } from './helpers/fake-home.mjs'
import { hostileHome, FORBIDDEN, depsFor, filesUnder, NOW } from './helpers/hostile-home.mjs'
import { repoRoot } from './helpers/repo.mjs'
import { git } from './helpers/git.mjs'

/* Commit mode is the part that touches somebody's repo unattended, every three hours. Two rules
   carry it: it commits only its own file, whatever else is staged; and a refused push in a
   person's own working copy stops and says so, while only the collector's dedicated clone may be
   reset and retried. These run real git against a throwaway bare remote - no network. */

const OWN = '.agent-team/status/usage/test-pc.json'
const OWN_CONNECTIONS = '.agent-team/status/connections/test-pc.json'
const OWN_HERMES = '.agent-team/status/hermes/test-pc.json'
const OWN_JOBS = '.agent-team/status/jobs/test-pc.json'

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

// The git command itself, without any "-c name=value" settings in front of it.
const gitCommand = (args) => {
  let rest = args
  while (rest[0] === '-c') rest = rest.slice(2)
  return rest
}

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
    assert.deepEqual(await filesIn(repo.work), [OWN_CONNECTIONS, OWN_HERMES, OWN_JOBS, OWN])
    assert.equal((await log(repo.work))[0], 'Status snapshot from Test PC')
    const staged = (await git(['diff', '--cached', '--name-only'], repo.work)).stdout.trim()
    assert.equal(staged, 'notes.md', 'the other staged file was committed or unstaged')
    assert.equal((await log(repo.remote, 'main'))[0], 'Status snapshot from Test PC')
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
    if (gitCommand(args)[0] === 'push') pushes.push(gitCommand(args))
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
    const stateDir = join(repo.root, 'state')
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir, extra: { git: recordingGit } })
    assert.equal(result.code, 0, result.stderr)
    // The snapshot's own commit by id, not HEAD: whatever HEAD becomes after the check, the
    // push carries exactly the commit that was checked.
    const { commit } = await finalRecord(stateDir)
    const expected = (await git(['rev-parse', `${commit}^`], repo.work)).stdout.trim()
    assert.deepEqual(pushes, [['push', '--quiet', '--no-follow-tags', '--recurse-submodules=no', `--force-with-lease=refs/heads/main:${expected}`, 'origin', `${commit}:refs/heads/main`]])
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
    assert.deepEqual(await log(repo.work), ['Status snapshot from Test PC', 'My private plan', 'start'])
    assert.deepEqual(await log(repo.remote, 'main'), ['start'])
    assert.match(result.stdout, /committed here but was not pushed/i)
    assert.match(result.stdout, /other commits that are not on origin's main yet/i)
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
    assert.equal((await log(repo.work))[0], 'Status snapshot from Test PC')
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
    const stateDir = join(repo.root, 'state')
    const result = await collect(fake, ['--commit', '--clone', dedicated], { repo: repo.work, stateDir, extra: { git: recordingGit } })
    assert.equal(result.code, 0, result.stderr)
    const { commit } = await finalRecord(stateDir)
    const expected = (await git(['rev-parse', `${commit}^`], dedicated)).stdout.trim()
    assert.deepEqual(pushes, [['push', '--quiet', '--no-follow-tags', '--recurse-submodules=no', `--force-with-lease=refs/heads/main:${expected}`, 'origin', `${commit}:refs/heads/main`]])
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

// The check has to be against the branch the push goes to - origin's default branch - not against
// whatever this branch happens to follow. A copy fast-forwarded from the template's own remote, or
// following another branch on origin, has nothing "ahead" of its upstream and still holds commits
// origin has never seen. A push of HEAD would publish them too.
async function expectHeldBack(repo, fake, extraSetup) {
  const stateDir = join(repo.root, 'state')
  const { pushes, recordingGit } = pushRecorder()
  const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir, extra: { git: recordingGit } })
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(pushes, [], 'it pushed from a copy holding commits the team repo has never seen')
  assert.deepEqual(await log(repo.remote, 'main'), ['start'])
  assert.match(result.stdout, /committed here but was not pushed/i)
  assert.equal((await finalRecord(stateDir)).outcome, 'committed, not pushed')
  return result
}

test('working copy: following another remote (say, the template) does not hide unreviewed commits', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const template = join(repo.root, 'template.git')
    await git(['init', '--bare', '-q', '-b', 'main', template], repo.root)
    await writeFile(join(repo.work, 'upstream.md'), 'from the template\n')
    await git(['add', 'upstream.md'], repo.work)
    await git(['commit', '-q', '-m', 'UNREVIEWED upstream change'], repo.work)
    await git(['remote', 'add', 'upstream', template], repo.work)
    await git(['push', '-q', 'upstream', 'main'], repo.work)
    await git(['branch', '-q', '--set-upstream-to=upstream/main', 'main'], repo.work)
    const result = await expectHeldBack(repo, fake)
    assert.match(result.stdout, /other commits that are not on origin's main yet/i)
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('working copy: following another branch on origin does not hide unreviewed commits', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    await writeFile(join(repo.work, 'feature.md'), 'half done\n')
    await git(['add', 'feature.md'], repo.work)
    await git(['commit', '-q', '-m', 'Feature work'], repo.work)
    await git(['push', '-q', 'origin', 'HEAD:refs/heads/develop'], repo.work)
    await git(['branch', '-q', '--set-upstream-to=origin/develop', 'main'], repo.work)
    const result = await expectHeldBack(repo, fake)
    assert.match(result.stdout, /other commits that are not on origin's main yet/i)
    assert.deepEqual(await log(repo.remote, 'develop'), ['Feature work', 'start'])
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('working copy: with no remote called origin it says so, instead of blaming the remote', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    await git(['remote', 'rename', 'origin', 'team'], repo.work)
    const result = await expectHeldBack(repo, fake)
    assert.match(result.stdout, /no remote called origin/i)
    assert.doesNotMatch(result.stdout + result.stderr, /remote has commits/i)
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

// Everything this copy checks, it checks against what it last fetched from origin. The push goes
// to the real remote, which may have moved since - or may be a different repo altogether
// (pushurl, pushInsteadOf). So the push carries a lease: it lands only if the remote's branch is
// still exactly what was checked. Anything else is held back with a plain sentence, never forced.
test('working copy: a commit removed from origin is never pushed back by a copy that still holds it', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    // Someone pushes a commit, this copy pulls it, then it is taken off origin (a leaked secret,
    // say) with a force push. This copy never fetches again, so its origin/main still has it.
    await advanceRemote(repo, 'LEAKED SECRET')
    await git(['pull', '-q', '--ff-only'], repo.work)
    const start = (await git(['rev-parse', 'HEAD~1'], repo.seed)).stdout.trim()
    await git(['push', '-q', '--force', 'origin', `${start}:refs/heads/main`], repo.seed)
    assert.deepEqual(await log(repo.remote, 'main'), ['start'])

    const stateDir = join(repo.root, 'state')
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await log(repo.remote, 'main'), ['start'], 'the removed commit was pushed back to origin')
    assert.equal((await finalRecord(stateDir)).outcome, 'committed, not pushed')
    assert.match(result.stdout, /fetch or pull, then take the snapshot again/i)
    assert.doesNotMatch(result.stdout + result.stderr, /experiment|work\b/)
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

for (const [label, redirect] of [
  ['remote.origin.pushurl', async (repo, other) => git(['config', 'remote.origin.pushurl', other], repo.work)],
  ['url.<other>.pushInsteadOf', async (repo, other) => git(['config', `url.${other}.pushInsteadOf`, repo.remote], repo.work)]
]) {
  test(`working copy: ${label} sending pushes to another repo does not carry commits it lacks`, async () => {
    const repo = await makeRemote()
    const fake = await makeFakeHome()
    try {
      const other = join(repo.root, 'other.git')
      await git(['clone', '--bare', '-q', repo.remote, other], repo.root)
      await advanceRemote(repo, 'ONLY ON FETCH REMOTE')
      await git(['pull', '-q', '--ff-only'], repo.work)
      await redirect(repo, other)
      const stateDir = join(repo.root, 'state')
      const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir })
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(await log(other, 'main'), ['start'], 'the push carried a commit the push remote never had')
      assert.equal((await finalRecord(stateDir)).outcome, 'committed, not pushed')
    } finally {
      await fake.cleanup()
      await repo.cleanup()
    }
  })
}

// Found in review round 4: with push.followTags on (a common global setting), git also sends every
// annotated tag reachable from the pushed commit - the person's private tags rode along.
test('working copy: the push carries no tags, even with push.followTags switched on', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    await git(['config', 'push.followTags', 'true'], repo.work)
    await git(['tag', '-a', 'private-tag', '-m', 'my private note'], repo.work)
    const stateDir = join(repo.root, 'state')
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir })
    assert.equal(result.code, 0, result.stderr)
    assert.equal((await finalRecord(stateDir)).outcome, 'pushed')
    const tags = (await git(['tag', '--list'], repo.remote)).stdout.trim()
    assert.equal(tags, '', 'a private tag was pushed with the snapshot')
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('working copy: a copy behind origin is told to pull, and the push is never forced', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    await advanceRemote(repo, 'newer on origin')
    await git(['fetch', '-q'], repo.work)
    const { pushes, recordingGit } = pushRecorder()
    const stateDir = join(repo.root, 'state')
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir, extra: { git: recordingGit } })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(pushes, [], 'a push that is not a fast-forward was attempted')
    assert.deepEqual(await log(repo.remote, 'main'), ['newer on origin', 'start'])
    assert.match(result.stdout, /behind/i)
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('working copy: a remote that moved since the last fetch holds the snapshot back, and nothing is reset', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    await advanceRemote(repo, 'someone-else')
    await writeFile(join(repo.work, 'notes.md'), 'mine\n')
    await git(['add', 'notes.md'], repo.work)
    const stateDir = join(repo.root, 'state')
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /committed here but was not pushed/i)
    assert.match(result.stdout, /fetch or pull, then take the snapshot again/i)
    assert.equal((await finalRecord(stateDir)).outcome, 'committed, not pushed')
    assert.equal((await log(repo.work))[0], 'Status snapshot from Test PC', 'the local commit should stay')
    assert.equal((await git(['diff', '--cached', '--name-only'], repo.work)).stdout.trim(), 'notes.md')
    assert.ok(existsSync(join(repo.work, 'notes.md')))
    assert.notEqual((await log(repo.remote, 'main'))[0], 'Status snapshot from Test PC')
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
    assert.deepEqual((await log(repo.remote, 'main')).slice(0, 2), ['Status snapshot from Test PC', 'earlier'])
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
      if (gitCommand(args)[0] === 'push' && pushes++ === 0) await advanceRemote(repo, 'raced')
      return realGit(args, cwd)
    }
    const result = await collect(fake, ['--commit', '--clone', dedicated], { repo: repo.work, stateDir: join(repo.root, 'state'), extra: { git: racingGit } })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(pushes, 2)
    assert.deepEqual((await log(repo.remote, 'main')).slice(0, 2), ['Status snapshot from Test PC', 'raced'])
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
      if (gitCommand(args)[0] === 'push') {
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

// A remote that cannot be reached is a failed run - the network, the remote, a revoked key - not
// a sign that the folder is somebody's work. Calling it "not a dedicated clone" sent people to
// look at the wrong thing.
test('dedicated clone: a fetch that fails is a failed run, not "not a dedicated clone"', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const dedicated = await repo.clone('dedicated')
    await git(['remote', 'set-url', 'origin', join(repo.root, 'gone.git')], dedicated)
    const stateDir = join(repo.root, 'state')
    const result = await collect(fake, ['--commit', '--clone', dedicated], { repo: join(repo.root, 'code'), stateDir })
    assert.equal(result.code, 1)
    assert.doesNotMatch(result.stderr, /not a dedicated clone/i)
    assert.match(result.stderr, /could not reach the team repo/i)
    assert.ok(!result.stderr.includes('gone.git'), 'git\'s own message, with the remote address, was passed on')
    assert.equal((await finalRecord(stateDir)).outcome, 'failed')
    assert.equal(existsSync(join(dedicated, ...OWN.split('/'))), false, 'it wrote a snapshot it could not push')
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
    await git(['commit', '-q', '-m', 'Status snapshot from Test PC'], dedicated)
    const result = await collect(fake, ['--commit', '--clone', dedicated], { repo: join(repo.root, 'code'), stateDir: join(repo.root, 'state') })
    assert.equal(result.code, 0, result.stderr)
    assert.equal((await log(repo.remote, 'main'))[0], 'Status snapshot from Test PC')
    assert.equal((await log(repo.remote, 'main')).filter((line) => line.startsWith('Status snapshot')).length, 1)
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
    assert.equal(receipt.schema, 'agent-status/receipt/v2')
    assert.deepEqual(receipt.files.map((entry) => entry.file), [OWN, OWN_CONNECTIONS, OWN_HERMES, OWN_JOBS])
    for (const entry of receipt.files) assert.match(entry.sha256, /^[0-9a-f]{64}$/)
    assert.deepEqual(Object.keys(receipt.sources.usage).sort(), ['claudeActivity', 'claudeLimits', 'claudePlan', 'codexLimits', 'codexPlan'])
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

// The schedule runs at 00:07, 03:07 ... New York time. A Mac that slept through 15:07 runs once
// on waking at, say, 16:00; someone then kickstarts it by hand at 17:30. Same slot - the second
// one must not run. A claim named after the clock second never matched anything, so it never
// stopped a repeat.
test('the same scheduled slot is never run twice, even at a different time inside it', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const dedicated = await repo.clone('dedicated')
    const stateDir = join(repo.root, 'state')
    const at = (iso) => ({ repo: join(repo.root, 'code'), stateDir, extra: { now: Date.parse(iso) } })
    // 16:00 and 17:30 New York (daylight time) are both in the 15:00 slot; 18:10 is the next one.
    const wake = await collect(fake, ['--commit', '--clone', dedicated], at('2026-10-07T20:00:00Z'))
    assert.equal(wake.code, 0, wake.stderr)
    const kickstart = await collect(fake, ['--commit', '--clone', dedicated], at('2026-10-07T21:30:00Z'))
    assert.equal(kickstart.code, 0)
    assert.match(kickstart.stdout, /already/i)
    assert.equal((await log(repo.remote, 'main')).filter((line) => line.startsWith('Status snapshot')).length, 1)
    const next = await collect(fake, ['--commit', '--clone', dedicated], at('2026-10-07T22:10:00Z'))
    assert.equal(next.code, 0, next.stderr)
    assert.doesNotMatch(next.stdout, /already/i)
    assert.equal((await log(repo.remote, 'main')).filter((line) => line.startsWith('Status snapshot')).length, 2)
    assert.deepEqual((await readdir(join(stateDir, 'claims'))).sort(), ['2026-10-07T15-00-new-york.claim', '2026-10-07T18-00-new-york.claim'])
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

// The README tells a person who has just moved the code pin to kickstart the job and watch it
// work. Moving the pin is new code, so that kickstart must run even inside a slot the old code
// already used - and a second kickstart on the same code still must not.
test('a slot already run by older code runs once more after the code pin moves', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const dedicated = await repo.clone('dedicated')
    const code = await repo.clone('code')
    const stateDir = join(repo.root, 'state')
    const at = (iso) => ({ repo: code, stateDir, extra: { now: Date.parse(iso) } })
    const snapshots = async () => (await log(repo.remote, 'main')).filter((line) => line.startsWith('Status snapshot')).length
    const scheduled = await collect(fake, ['--commit', '--clone', dedicated], at('2026-10-07T19:07:00Z'))
    assert.equal(scheduled.code, 0, scheduled.stderr)
    assert.equal(await snapshots(), 1)

    await writeFile(join(code, 'newer.md'), 'newer code\n')
    await git(['add', '.'], code)
    await git(['commit', '-q', '-m', 'newer code'], code)
    const kickstart = await collect(fake, ['--commit', '--clone', dedicated], at('2026-10-07T20:30:00Z'))
    assert.equal(kickstart.code, 0, kickstart.stderr)
    assert.doesNotMatch(kickstart.stdout, /already/i)
    assert.equal(await snapshots(), 2)

    const again = await collect(fake, ['--commit', '--clone', dedicated], at('2026-10-07T21:00:00Z'))
    assert.equal(again.code, 0)
    assert.match(again.stdout, /already/i)
    assert.equal(await snapshots(), 2)

    const head = (await git(['rev-parse', 'HEAD'], code)).stdout.trim()
    const claims = await readdir(join(stateDir, 'claims'))
    assert.equal(claims.length, 2)
    for (const claim of claims) assert.match(claim, /^2026-10-07T15-00-new-york-code-[0-9a-f]{12}\.claim$/)
    assert.ok(claims.includes(`2026-10-07T15-00-new-york-code-${head.slice(0, 12)}.claim`), claims.join(', '))
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

// The claim name only takes the commit of a checkout that is the code folder itself. A code
// folder that is a plain folder, or a folder inside some other repo, has no commit of its own -
// that repo's commit says nothing about the code that runs - so the bare slot is used.
test('a code folder that is not its own git checkout claims the bare slot', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const dedicated = await repo.clone('dedicated')
    const outer = await repo.clone('outer')
    const inside = join(outer, 'sub')
    const plain = join(repo.root, 'plain')
    await mkdir(inside, { recursive: true })
    await mkdir(plain, { recursive: true })
    for (const [index, code] of [inside, plain].entries()) {
      const stateDir = join(repo.root, `state-${index}`)
      const result = await collect(fake, ['--commit', '--clone', dedicated], { repo: code, stateDir, extra: { now: Date.parse('2026-10-07T19:07:00Z') } })
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(await readdir(join(stateDir, 'claims')), ['2026-10-07T15-00-new-york.claim'])
    }
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

// What git prints becomes part of a folder name. Only a full hex commit id may.
test('a code commit is used only when git answers with a commit id', async () => {
  const answering = (head) => async (args, cwd) => ({ stdout: args.includes('--show-toplevel') ? `${cwd}\n` : `${head}\n` })
  const folder = await mkdtemp(join(tmpdir(), 'agent-status-code-'))
  try {
    const id = 'a'.repeat(40)
    assert.equal(await codeCommit(answering(id), folder), id)
    for (const head of ['../../escape', 'A'.repeat(40), 'abc123', 'HEAD', '', `${'a'.repeat(40)}/x`]) {
      assert.equal(await codeCommit(answering(head), folder), null, `accepted ${JSON.stringify(head)}`)
    }
    assert.equal(await codeCommit(async () => { throw new Error('not a repo') }, folder), null)
    assert.equal(scheduledClaimName(Date.parse('2026-10-07T19:07:00Z'), id), `2026-10-07T15-00-new-york-code-${'a'.repeat(12)}`)
    assert.equal(scheduledClaimName(Date.parse('2026-10-07T19:07:00Z'), null), '2026-10-07T15-00-new-york')
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('a slot is the New York date and three-hour block, through both clock changes', () => {
  assert.equal(slotStamp(Date.parse('2026-10-07T20:00:00Z')), '2026-10-07T15-00-new-york')
  assert.equal(slotStamp(Date.parse('2026-10-08T03:59:59Z')), '2026-10-07T21-00-new-york')
  assert.equal(slotStamp(Date.parse('2026-10-08T04:00:00Z')), '2026-10-08T00-00-new-york')
  // Clocks go back at 02:00 on 1 November: 01:30 happens twice, and both are the 00:00 slot.
  assert.equal(slotStamp(Date.parse('2026-11-01T05:30:00Z')), '2026-11-01T00-00-new-york')
  assert.equal(slotStamp(Date.parse('2026-11-01T06:30:00Z')), '2026-11-01T00-00-new-york')
  assert.equal(slotStamp(Date.parse('2026-11-01T08:00:00Z')), '2026-11-01T03-00-new-york')
  // Clocks go forward at 02:00 on 8 March 2026: 01:59 then 03:00, two different slots.
  assert.equal(slotStamp(Date.parse('2026-03-08T06:59:00Z')), '2026-03-08T00-00-new-york')
  assert.equal(slotStamp(Date.parse('2026-03-08T07:00:00Z')), '2026-03-08T03-00-new-york')
})

test('by hand in a working copy, a later run is never mistaken for a repeat', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const stateDir = join(repo.root, 'state')
    const first = await collect(fake, ['--commit'], { repo: repo.work, stateDir })
    assert.equal(first.code, 0, first.stderr)
    const again = await collect(fake, ['--commit'], { repo: repo.work, stateDir, extra: { now: NOW + 10 * 60_000 } })
    assert.equal(again.code, 0, again.stderr)
    assert.doesNotMatch(again.stdout, /already/i)
    assert.equal((await log(repo.work)).filter((line) => line.startsWith('Status snapshot')).length, 2)
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

// --- the snapshot's folder must be a real folder inside the clone ----------------------------------
//
// Anyone who can push to the team repo can commit .agent-team/status/usage (or .agent-team) as a
// link to somewhere else. The data clone is reset to that every run, and a write that follows the
// link lands anywhere this user can write. So every part of the path is checked - on disk and in
// git's own index - and the folder written to must really be inside the clone.

async function expectNothingOutside(outside) {
  assert.deepEqual(await readdir(outside), [], 'something was written through the link')
}

test('dedicated clone: a usage folder pushed as a link is refused, and nothing is written through it', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const dedicated = await repo.clone('dedicated')
    const outside = join(repo.root, 'outside')
    await mkdir(outside)
    // Committed as a link in git itself (mode 120000), the way a push from any system would.
    await git(['pull', '-q', '--ff-only'], repo.seed).catch(() => {})
    const linkBlob = await new Promise((resolve, reject) => {
      const child = execFile('git', ['hash-object', '-w', '--stdin'], { cwd: repo.seed, encoding: 'utf8' }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())))
      child.stdin.end(outside)
    })
    await git(['update-index', '--add', '--cacheinfo', `120000,${linkBlob},.agent-team/status/usage`], repo.seed)
    await git(['commit', '-q', '-m', 'Usage folder now points elsewhere'], repo.seed)
    await git(['push', '-q'], repo.seed)

    const stateDir = join(repo.root, 'state')
    const result = await collect(fake, ['--commit', '--clone', dedicated], { repo: join(repo.root, 'code'), stateDir })
    assert.equal(result.code, 1, result.stdout + result.stderr)
    assert.match(result.stderr, /is a link/i)
    assert.equal((await finalRecord(stateDir)).outcome, 'failed')
    await expectNothingOutside(outside)
    assert.deepEqual(await log(repo.remote, 'main'), ['Usage folder now points elsewhere', 'start'])
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

for (const linked of ['.agent-team', '.agent-team/status/usage']) {
  test(`working copy: ${linked} as a link on disk is refused, and nothing is written through it`, async () => {
    const repo = await makeRemote()
    const fake = await makeFakeHome()
    try {
      const outside = join(repo.root, 'outside')
      await mkdir(outside)
      const link = join(repo.work, ...linked.split('/'))
      await mkdir(join(link, '..'), { recursive: true })
      // A junction needs no special rights on Windows; elsewhere the type is ignored.
      await symlink(outside, link, 'junction')
      const stateDir = join(repo.root, 'state')
      const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir })
      assert.equal(result.code, 1, result.stdout + result.stderr)
      assert.match(result.stderr, /is a link/i)
      assert.equal((await finalRecord(stateDir)).outcome, 'failed')
      await expectNothingOutside(outside)
      assert.deepEqual(await log(repo.work), ['start'])
    } finally {
      await fake.cleanup()
      await repo.cleanup()
    }
  })
}

test('without --commit too, a linked usage folder is refused and nothing is written through it', async () => {
  const fake = await makeFakeHome()
  const target = await mkdtemp(join(tmpdir(), 'agent-status-repo-'))
  const outside = await mkdtemp(join(tmpdir(), 'agent-status-outside-'))
  try {
    await mkdir(join(target, '.agent-team', 'status'), { recursive: true })
    await symlink(outside, join(target, '.agent-team', 'status', 'usage'), 'junction')
    const stderr = []
    const code = await runCollector({ argv: ['--computer', 'Test PC'], deps: depsFor(fake), repoRoot: target, out: () => {}, err: (line) => stderr.push(line) })
    assert.equal(code, 1)
    assert.match(stderr.join('\n'), /is a link/i)
    await expectNothingOutside(outside)
  } finally {
    await fake.cleanup()
    await rm(target, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

// Every exit after the claim leaves a final record. A write that fails for an ordinary reason - a
// file where the folder should be, a full disk - used to throw straight past it, leaving a claim
// with no outcome that the task policy says not to replay blindly.
test('a write that fails after the claim still leaves a final record saying failed', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    await mkdir(join(repo.work, '.agent-team', 'status'), { recursive: true })
    await writeFile(join(repo.work, '.agent-team', 'status', 'usage'), 'a file, not a folder\n')
    const stateDir = join(repo.root, 'state')
    const result = await collect(fake, ['--commit'], { repo: repo.work, stateDir })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /could not be written/i)
    assert.equal((await finalRecord(stateDir)).outcome, 'failed')
    assert.ok(!existsSync(join(stateDir, 'lock')), 'the lock was not released')
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

// --- no git hooks in the data clone ------------------------------------------------------------------
//
// The data clone holds whatever the team repo holds. If git there runs hooks from a folder inside
// the repo - a relative core.hooksPath in the person's global settings does exactly that - then a
// pushed hook script is code run on the Mac. In clone mode every git command is told to look for
// hooks in an empty folder the collector owns.

test('dedicated clone: every git command runs with hooks pointed at an empty folder', async () => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const dedicated = await repo.clone('dedicated')
    const calls = []
    const recordingGit = async (args, cwd) => {
      calls.push(args)
      return realGit(args, cwd)
    }
    const stateDir = join(repo.root, 'state')
    const result = await collect(fake, ['--commit', '--clone', dedicated], { repo: join(repo.root, 'code'), stateDir, extra: { git: recordingGit } })
    assert.equal(result.code, 0, result.stderr)
    assert.ok(calls.length > 5)
    const hooks = join(stateDir, 'no-hooks')
    for (const args of calls) {
      assert.deepEqual(args.slice(0, 2), ['-c', `core.hooksPath=${hooks}`], `git ${gitCommand(args)[0]} ran without the empty hooks folder`)
    }
    assert.deepEqual(await readdir(hooks), [])
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('dedicated clone: a hook pushed into the team repo does not run', async (t) => {
  const repo = await makeRemote()
  const fake = await makeFakeHome()
  try {
    const marker = join(repo.root, 'hook-ran.txt')
    const hook = `#!/bin/sh\necho ran > "${marker.replaceAll('\\', '/')}"\n`
    await git(['pull', '-q', '--ff-only'], repo.seed).catch(() => {})
    await mkdir(join(repo.seed, '.githooks'), { recursive: true })
    await writeFile(join(repo.seed, '.githooks', 'pre-commit'), hook)
    await git(['add', '.githooks/pre-commit'], repo.seed)
    await git(['update-index', '--chmod=+x', '.githooks/pre-commit'], repo.seed)
    await git(['commit', '-q', '-m', 'Add a hook'], repo.seed)
    await git(['push', '-q'], repo.seed)

    // A relative hooks folder, as a person's global git settings might set it.
    const withHooks = async (name) => {
      const dir = await repo.clone(name)
      await git(['config', 'core.hooksPath', '.githooks'], dir)
      return dir
    }
    // First prove the hook really runs here, so the test below means something.
    const control = await withHooks('control')
    await writeFile(join(control, 'x.md'), 'x\n')
    await git(['add', 'x.md'], control)
    await git(['commit', '-q', '-m', 'control'], control)
    if (!existsSync(marker)) {
      t.skip('git hooks do not run on this computer, so there is nothing to switch off here')
      return
    }
    await rm(marker)

    const dedicated = await withHooks('dedicated')
    const result = await collect(fake, ['--commit', '--clone', dedicated], { repo: join(repo.root, 'code'), stateDir: join(repo.root, 'state') })
    assert.equal(result.code, 0, result.stderr)
    assert.equal((await log(repo.remote, 'main'))[0], 'Status snapshot from Test PC')
    assert.equal(existsSync(marker), false, 'a hook from the team repo ran during the collector\'s commit')
  } finally {
    await fake.cleanup()
    await repo.cleanup()
  }
})

test('the collector never writes into the template repo itself during these tests', () => {
  assert.equal(existsSync(join(repoRoot, '.agent-team', 'status', 'usage')), false)
})
