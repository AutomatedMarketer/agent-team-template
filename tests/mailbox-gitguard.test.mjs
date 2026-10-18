import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from './helpers/git.mjs'
import { STUCK_FILE, gitUnchanged, remakeWorkCopy, snapshotGit, sweepAside, unstickWorkCopy, workCopyStuck } from '../scripts/lib/mailbox/gitguard.mjs'
import { configText, originUrl, readOrigin, resetWorkCopy } from '../scripts/lib/mailbox/workcopy.mjs'

/* After Claude has run, git is run in the work copy as the owner. Anything in .git that git reads as configuration, changed by Claude,
   would run with the owner's rights. These hold the snapshot to what git reads: a change, an addition or a removal of any of it is seen,
   and a folder nobody touched is not. */

async function clone() {
  const root = await mkdtemp(join(tmpdir(), 'mailbox-guard-'))
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  await git(['init', '-q', '--bare', '-b', 'main', origin], root)
  const seed = join(root, 'seed')
  await git(['clone', '-q', origin, seed], root)
  for (const [key, value] of [['user.email', 'a@example.com'], ['user.name', 'A'], ['commit.gpgsign', 'false']]) await git(['config', key, value], seed)
  await writeFile(join(seed, 'a.txt'), 'a\n')
  await git(['add', '-A'], seed)
  await git(['commit', '-q', '-m', 'seed'], seed)
  await git(['push', '-q', 'origin', 'HEAD:refs/heads/main'], seed)
  await git(['clone', '-q', origin, work], root)
  return { root, origin, work, done: () => rm(root, { recursive: true, force: true }) }
}

const CHANGES = [
  ['a line added to .git/config', (work) => appendFile(join(work, '.git', 'config'), '[credential]\n\thelper = x\n')],
  ['a new hook', (work) => writeFile(join(work, '.git', 'hooks', 'pre-push'), '#!/bin/sh\n')],
  ['a hook changed', async (work) => writeFile(join(work, '.git', 'hooks', 'pre-commit.sample'), 'changed\n')],
  ['a new .git/info/attributes', async (work) => {
    await mkdir(join(work, '.git', 'info'), { recursive: true })
    await writeFile(join(work, '.git', 'info', 'attributes'), '* filter=x\n')
  }],
  ['a .git/config.worktree', (work) => writeFile(join(work, '.git', 'config.worktree'), '[core]\n\tfsmonitor = x\n')],
  ['a .git/commondir', (work) => writeFile(join(work, '.git', 'commondir'), '/elsewhere\n')],
  ['an alternates file', async (work) => {
    await mkdir(join(work, '.git', 'objects', 'info'), { recursive: true })
    await writeFile(join(work, '.git', 'objects', 'info', 'alternates'), '/elsewhere\n')
  }],
  ['HEAD pointed elsewhere', (work) => writeFile(join(work, '.git', 'HEAD'), 'ref: refs/heads/other\n')]
]

test('a work copy nobody touched is unchanged, and asking again changes nothing', async () => {
  const c = await clone()
  try {
    const before = await snapshotGit(c.work)
    assert.equal(before.ok, true)
    assert.match(before.fingerprint, /^[0-9a-f]{64}$/)
    assert.equal(await gitUnchanged(c.work, before), true)
    assert.equal(await gitUnchanged(c.work, before), true)
    assert.match(before.address, /origin.git$/)
  } finally {
    await c.done()
  }
})

for (const [what, change] of CHANGES) {
  test(`${what} is seen as a change`, async () => {
    const c = await clone()
    try {
      const before = await snapshotGit(c.work)
      await change(c.work)
      assert.equal(await gitUnchanged(c.work, before), false)
    } finally {
      await c.done()
    }
  })
}

test('a file inside .git that git does not read as configuration, such as a new object, is not a change', async () => {
  const c = await clone()
  try {
    const before = await snapshotGit(c.work)
    await mkdir(join(c.work, '.git', 'refs', 'heads'), { recursive: true })
    await writeFile(join(c.work, '.git', 'refs', 'heads', 'scratch'), `${(await git(['rev-parse', 'HEAD'], c.work)).stdout.trim()}\n`)
    assert.equal(await gitUnchanged(c.work, before), true)
  } finally {
    await c.done()
  }
})

test('.git replaced by a plain file that points somewhere else, or taken away, is a change; so is a snapshot that could not be made', async () => {
  const c = await clone()
  try {
    const before = await snapshotGit(c.work)
    await rm(join(c.work, '.git'), { recursive: true, force: true })
    assert.equal(await gitUnchanged(c.work, before), false, 'taken away')
    await writeFile(join(c.work, '.git'), 'gitdir: /elsewhere\n')
    assert.equal(await gitUnchanged(c.work, before), false, 'a pointer')
    assert.deepEqual(await snapshotGit(c.work), { ok: false })
    assert.equal(await gitUnchanged(c.work, { ok: false }), false, 'no snapshot to compare with')
    assert.equal(await gitUnchanged(c.work, undefined), false)
  } finally {
    await c.done()
  }
})

// The git calls a remake makes, as the runner hands them over, and whether the folder each one runs in was empty at that moment.
function watchingGit(calls, { insteadOf = null } = {}) {
  return async (args, cwd) => {
    const verb = args.find((one) => ['clone', 'init', 'fetch', 'checkout', 'remote', 'config', 'pull', 'ls-remote'].includes(one))
    calls.push({ args: [...args], cwd, verb, empty: (await readdir(cwd).catch(() => null))?.length === 0 })
    // The test's own way of sending a made-up github address to the local origin. Added after the call is recorded: it is the test's, not the runner's.
    return git(insteadOf ? ['-c', `url.${insteadOf.to}.insteadOf=${insteadOf.from}`, ...args] : args, cwd)
  }
}

test('the work copy is made again from the address the runner knew before Claude started, not from one in the folder now', async () => {
  const c = await clone()
  try {
    const before = await snapshotGit(c.work)
    await appendFile(join(c.work, '.git', 'config'), '[remote "origin"]\n\turl = https://evil.example/x.git\n')
    await writeFile(join(c.work, 'junk.txt'), 'planted\n')
    const empty = join(c.root, 'empty-hooks')
    await mkdir(empty)
    const calls = []
    assert.deepEqual(await remakeWorkCopy({ git: watchingGit(calls), work: c.work, emptyHooks: empty, before }), { ok: true })
    assert.deepEqual(calls.map((one) => one.verb), ['init', 'remote', 'remote', 'fetch', 'checkout'], 'git is asked which addresses it will use (no network) before it fetches')
    assert.equal(calls[0].cwd, c.work)
    assert.equal(calls[0].empty, true, 'the first git runs in a fresh, empty folder: the old one is gone before any git is run')
    assert.equal(await readFile(join(c.work, 'a.txt'), 'utf8'), 'a\n')
    await assert.rejects(readFile(join(c.work, 'junk.txt')), 'what was planted is gone')
    assert.ok(!(await readFile(join(c.work, '.git', 'config'), 'utf8')).includes('evil.example'))
    assert.equal((await git(['rev-parse', '--abbrev-ref', 'HEAD'], c.work)).stdout.trim(), 'main', 'on the same branch a clone would be')
    assert.equal((await git(['rev-parse', 'HEAD'], c.work)).stdout.trim(), (await git(['rev-parse', 'refs/heads/main'], c.origin)).stdout.trim())
    assert.equal((await git(['status', '--porcelain'], c.work)).stdout, '', 'everything checked out, nothing left over')
    assert.deepEqual(await readOrigin(c.work), { fetch: before.address, push: before.address })
    assert.deepEqual((await readdir(c.root)).sort(), ['empty-hooks', 'origin.git', 'seed', 'work'], 'the old folder, moved aside first, is deleted: nothing is left beside the copy')
  } finally {
    await c.done()
  }
})

test('the team repo\'s address is not on a git command line while the copy is made again: git reads it from the config the runner wrote', async () => {
  const c = await clone()
  const address = 'https://github.com/ExampleOwner/example-team.git'
  try {
    // The runner wrote this address into .git/config itself before Claude started (resetWorkCopy); the snapshot records it.
    const empty = join(c.root, 'empty-hooks')
    await mkdir(empty)
    await writeFile(join(c.work, '.git', 'config'), configText({ url: address, emptyHooks: empty }))
    const before = await snapshotGit(c.work)
    assert.equal(before.address, address)
    const calls = []
    assert.deepEqual(await remakeWorkCopy({ git: watchingGit(calls, { insteadOf: { from: address, to: c.origin } }), work: c.work, emptyHooks: empty, before }), { ok: true })
    assert.ok(calls.length > 0)
    for (const call of calls) assert.ok(!call.args.join(' ').includes('github.com'), `the address was on a command line: ${call.verb}`)
    assert.equal(await readFile(join(c.work, 'a.txt'), 'utf8'), 'a\n', 'the copy was made all the same, from the address in its config')
    assert.equal(await originUrl(c.work), address)
  } finally {
    await c.done()
  }
})

test('an address that holds a login is never fetched from: git hands the whole address to git-remote-https on its command line, so no git is run at all', async () => {
  const c = await clone()
  try {
    const empty = join(c.root, 'empty-hooks')
    await mkdir(empty)
    const before = await snapshotGit(c.work)
    const calls = []
    const login = ['https://x-access-token', 'abc123@github.com/ExampleOwner/example-team.git'].join(':')
    assert.deepEqual(await remakeWorkCopy({ git: watchingGit(calls), work: c.work, emptyHooks: empty, before: { ...before, address: login } }), { ok: false })
    assert.deepEqual(calls, [], 'no git was run')
    await assert.rejects(lstat(c.work), 'the old folder is gone all the same')
  } finally {
    await c.done()
  }
})

test('a copy whose git could not even be started (init failed) leaves no folder behind', async () => {
  const c = await clone()
  try {
    const before = await snapshotGit(c.work)
    const empty = join(c.root, 'empty-hooks')
    await mkdir(empty)
    const failing = async (args, cwd) => {
      if (args.includes('init')) throw new Error('git failed at init')
      return git(args, cwd)
    }
    assert.deepEqual(await remakeWorkCopy({ git: failing, work: c.work, emptyHooks: empty, before }), { ok: false })
    await assert.rejects(lstat(c.work), 'no folder is left: an empty one would read as "not a clone" for good')
    assert.deepEqual(await remakeWorkCopy({ git, work: c.work, emptyHooks: empty, before }), { ok: true })
    assert.equal(await readFile(join(c.work, 'a.txt'), 'utf8'), 'a\n')
  } finally {
    await c.done()
  }
})

for (const step of ['fetch', 'checkout']) {
  test(`a copy that could not be fetched (git failed at "${step}") is kept as the runner made it - its own config and nothing else - so the next tick's reset heals it`, async () => {
    const c = await clone()
    try {
      const before = await snapshotGit(c.work)
      const empty = join(c.root, 'empty-hooks')
      await mkdir(empty)
      const failing = async (args, cwd) => {
        if (args.includes(step)) throw new Error(`git failed at ${step}`)
        return git(args, cwd)
      }
      assert.deepEqual(await remakeWorkCopy({ git: failing, work: c.work, emptyHooks: empty, before }), { ok: false })
      assert.equal(await readFile(join(c.work, '.git', 'config'), 'utf8'), configText({ url: before.address, emptyHooks: empty }), 'the config is the runner\'s own')
      assert.deepEqual((await readdir(c.work)).filter((name) => name !== '.git'), [], 'no file of the team repo, and nothing of the old folder')
      // The next tick: the reset that runs before every order brings it level, with no one stepping in.
      assert.deepEqual((await resetWorkCopy({ git, work: c.work, emptyHooks: empty, originAccepted: () => true })).ok, true)
      assert.equal(await readFile(join(c.work, 'a.txt'), 'utf8'), 'a\n')
    } finally {
      await c.done()
    }
  })
}

test('a computer whose git makes sha256 or reftable repos by default (global config) still gets the copy made again', async () => {
  const c = await clone()
  const global = join(c.root, 'global.gitconfig')
  const saved = process.env.GIT_CONFIG_GLOBAL
  try {
    const before = await snapshotGit(c.work)
    const empty = join(c.root, 'empty-hooks')
    await mkdir(empty)
    await writeFile(global, '[init]\n\tdefaultObjectFormat = sha256\n\tdefaultRefFormat = reftable\n')
    process.env.GIT_CONFIG_GLOBAL = global
    assert.deepEqual(await remakeWorkCopy({ git, work: c.work, emptyHooks: empty, before }), { ok: true })
    assert.equal(await readFile(join(c.work, 'a.txt'), 'utf8'), 'a\n')
    assert.equal((await git(['rev-parse', 'HEAD'], c.work)).stdout.trim(), (await git(['rev-parse', 'refs/heads/main'], c.origin)).stdout.trim())
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = saved
    await c.done()
  }
})

test('a commondir or config.worktree that shows up in the fresh .git (from an init template, say) stops the remake before git fetches anything', async () => {
  for (const planted of ['commondir', 'config.worktree']) {
    const c = await clone()
    const global = join(c.root, 'global.gitconfig')
    const saved = process.env.GIT_CONFIG_GLOBAL
    try {
      const before = await snapshotGit(c.work)
      const empty = join(c.root, 'empty-hooks')
      await mkdir(empty)
      const template = join(c.root, 'template')
      await mkdir(template)
      await writeFile(join(template, planted), planted === 'commondir' ? `${c.root}\n` : '[core]\n\tfsmonitor = x\n')
      await writeFile(global, `[init]\n\ttemplateDir = ${template.replaceAll('\\', '/')}\n`)
      process.env.GIT_CONFIG_GLOBAL = global
      const calls = []
      assert.deepEqual(await remakeWorkCopy({ git: watchingGit(calls), work: c.work, emptyHooks: empty, before }), { ok: false }, planted)
      assert.deepEqual(calls.map((one) => one.verb), ['init'], `${planted}: nothing was fetched`)
      await assert.rejects(lstat(c.work), `${planted}: the folder is not kept`)
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = saved
      await c.done()
    }
  }
})

/* ---------- a work copy that cannot be moved aside ------------------------------------------------------------------------------------ */

// On Windows a folder cannot be renamed while a program has its current folder inside it (a terminal is enough). A delete in place
// then stops part way and can leave exactly what made the copy untrusted - a commondir, say - behind. So nothing is deleted in place:
// a marker in the state folder keeps every tick away from the folder until it can be moved.
const refuseRename = async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) }

async function plantCommondir(c) {
  const evil = join(c.work, '.git', 'evil')
  await mkdir(evil)
  await writeFile(join(evil, 'config'), '[core]\n\tbare = false\n')
  await writeFile(join(c.work, '.git', 'commondir'), 'evil\n')
}

test('a work copy that cannot be moved aside is not deleted in place: it is left whole, no git runs, and a marker in the state folder says it is stuck', async () => {
  const c = await clone()
  try {
    const before = await snapshotGit(c.work)
    const empty = join(c.root, 'empty-hooks')
    const state = join(c.root, 'state')
    await mkdir(empty)
    await mkdir(state)
    await plantCommondir(c)
    const calls = []
    assert.deepEqual(await remakeWorkCopy({ git: watchingGit(calls), work: c.work, emptyHooks: empty, before, stateDir: state, rename: refuseRename }), { ok: false, stuck: true })
    assert.deepEqual(calls, [], 'no git was run')
    // (Read as a line: this test's own clone was made with the computer's line-end setting.)
    assert.equal((await readFile(join(c.work, 'a.txt'), 'utf8')).trim(), 'a', 'nothing was deleted in place')
    assert.equal(await readFile(join(c.work, '.git', 'commondir'), 'utf8'), 'evil\n')
    assert.equal(await workCopyStuck(state), true)
    assert.ok(!(await readFile(join(state, STUCK_FILE), 'utf8')).includes('evil'), 'the marker holds the runner\'s own address, nothing from the folder')
  } finally {
    await c.done()
  }
})

test('a work copy that cannot be moved aside, whose marker cannot be written either, is still not deleted in place', async () => {
  const c = await clone()
  try {
    const before = await snapshotGit(c.work)
    const empty = join(c.root, 'empty-hooks')
    await mkdir(empty)
    await plantCommondir(c)
    const calls = []
    // A state folder that is not there: the marker cannot be written.
    const result = await remakeWorkCopy({ git: watchingGit(calls), work: c.work, emptyHooks: empty, before, stateDir: join(c.root, 'no-such-state'), rename: refuseRename })
    assert.deepEqual(result, { ok: false, stuck: true })
    assert.deepEqual(calls, [], 'no git was run')
    assert.equal((await readFile(join(c.work, 'a.txt'), 'utf8')).trim(), 'a', 'nothing was deleted in place')
    assert.equal(await readFile(join(c.work, '.git', 'commondir'), 'utf8'), 'evil\n')
  } finally {
    await c.done()
  }
})

test('a stuck work copy stays stuck while it cannot be moved, with no git run; once it can be, the marker goes and the copy is made again', async () => {
  const c = await clone()
  try {
    const before = await snapshotGit(c.work)
    const empty = join(c.root, 'empty-hooks')
    const state = join(c.root, 'state')
    await mkdir(empty)
    await mkdir(state)
    await plantCommondir(c)
    await remakeWorkCopy({ git, work: c.work, emptyHooks: empty, before, stateDir: state, rename: refuseRename })
    const calls = []
    assert.deepEqual(await unstickWorkCopy({ git: watchingGit(calls), work: c.work, emptyHooks: empty, stateDir: state, rename: refuseRename }), { stuck: true })
    assert.deepEqual(calls, [], 'no git was run while it is stuck')
    assert.deepEqual(await unstickWorkCopy({ git, work: c.work, emptyHooks: empty, stateDir: state }), { stuck: false })
    assert.equal(await workCopyStuck(state), false, 'the marker is gone')
    assert.equal(await readFile(join(c.work, 'a.txt'), 'utf8'), 'a\n')
    await assert.rejects(lstat(join(c.work, '.git', 'commondir')), 'what was planted is gone')
    assert.deepEqual(await unstickWorkCopy({ git, work: c.work, emptyHooks: empty, stateDir: state }), { stuck: false }, 'with no marker there is nothing to do')
  } finally {
    await c.done()
  }
})

test('a planted commondir in a work copy a terminal is sitting in: the remake leaves it whole and stuck, and the next reset runs no git, so the planted settings never run (this computer)', async (t) => {
  if (process.platform !== 'win32') return t.skip('a folder in use cannot be renamed only on Windows')
  const c = await clone()
  let sitter = null
  try {
    const before = await snapshotGit(c.work)
    const empty = join(c.root, 'empty-hooks')
    const state = join(c.root, 'state')
    await mkdir(empty)
    await mkdir(state)
    // The reviewer's attack: a common dir with its own config, whose upload-pack writes a file when git fetches.
    const evil = join(c.work, '.git', 'evil')
    await mkdir(evil)
    await git(['init', '-q', '--bare', evil], c.root)
    const pwned = join(c.root, 'PWNED.txt').replaceAll('\\', '/')
    await writeFile(join(evil, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote "origin"]\n\turl = ${c.origin.replaceAll('\\', '/')}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n\tuploadpack = "echo owned > '${pwned}'; git-upload-pack"\n`)
    await writeFile(join(c.work, '.git', 'commondir'), 'evil\n')
    assert.equal(await gitUnchanged(c.work, before), false)
    sitter = spawn(join(process.env.SystemRoot, 'System32', 'PING.EXE'), ['-n', '60', '127.0.0.1'], { cwd: join(c.work, '.git'), stdio: 'ignore', windowsHide: true })
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.deepEqual(await remakeWorkCopy({ git, work: c.work, emptyHooks: empty, before, stateDir: state }), { ok: false, stuck: true })
    assert.equal(await workCopyStuck(state), true)
    assert.equal(await readFile(join(c.work, '.git', 'commondir'), 'utf8'), 'evil\n', 'left whole, not half-deleted')
    assert.deepEqual(await resetWorkCopy({ git, work: c.work, emptyHooks: empty, originAccepted: () => true }), { ok: false, why: 'points-elsewhere' })
    await assert.rejects(readFile(join(c.root, 'PWNED.txt')), 'the planted settings never ran')
  } finally {
    if (sitter?.pid) {
      try {
        process.kill(sitter.pid)
      } catch {
        // Already gone.
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    await c.done()
  }
})

test('old folders moved aside and left behind are swept: only the runner\'s own name pattern beside the work copy, and a link is removed without following it', async () => {
  const c = await clone()
  try {
    const leftover = join(c.root, '.work.old-0123456789ab')
    await mkdir(join(leftover, '.git'), { recursive: true })
    await writeFile(join(leftover, 'x.txt'), 'x')
    const outside = join(c.root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'precious.txt'), 'keep')
    await symlink(outside, join(c.root, '.work.old-ba9876543210'), 'junction')
    for (const keep of ['.work.old-notours', '.work.old-0123456789abc', 'work.old-0123456789ab', '.other.old-0123456789ab']) await mkdir(join(c.root, keep))
    await sweepAside(c.work)
    const left = (await readdir(c.root)).sort()
    assert.ok(!left.includes('.work.old-0123456789ab') && !left.includes('.work.old-ba9876543210'), left.join(', '))
    for (const keep of ['.work.old-notours', '.work.old-0123456789abc', 'work.old-0123456789ab', '.other.old-0123456789ab', 'work', 'outside']) assert.ok(left.includes(keep), keep)
    assert.equal(await readFile(join(outside, 'precious.txt'), 'utf8'), 'keep', 'the link was not followed')
  } finally {
    await c.done()
  }
})

test('a remake whose address git would rewrite to carry a token (a global insteadOf) fetches nothing', async () => {
  const c = await clone()
  const global = join(c.root, 'global.gitconfig')
  const saved = process.env.GIT_CONFIG_GLOBAL
  try {
    const empty = join(c.root, 'empty-hooks')
    await mkdir(empty)
    const address = 'https://github.com/ExampleOwner/example-team.git'
    await writeFile(join(c.work, '.git', 'config'), configText({ url: address, emptyHooks: empty }))
    const before = await snapshotGit(c.work)
    await writeFile(global, `[url "${['https://x-access-token', 'abc123@github.com/'].join(':')}"]\n\tinsteadOf = https://github.com/\n`)
    process.env.GIT_CONFIG_GLOBAL = global
    const calls = []
    assert.deepEqual(await remakeWorkCopy({ git: watchingGit(calls), work: c.work, emptyHooks: empty, before }), { ok: false })
    assert.deepEqual(calls.filter((one) => one.verb === 'fetch'), [], 'nothing was fetched')
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = saved
    await c.done()
  }
})


test('when the copy cannot be made again the old folder is gone all the same, and nothing of it is left to trust', async () => {
  const c = await clone()
  try {
    const before = await snapshotGit(c.work)
    const empty = join(c.root, 'empty-hooks')
    await mkdir(empty)
    const down = async () => { throw new Error('unreachable') }
    assert.deepEqual(await remakeWorkCopy({ git: down, work: c.work, emptyHooks: empty, before }), { ok: false })
    await assert.rejects(readFile(join(c.work, 'a.txt')))
    assert.deepEqual(await remakeWorkCopy({ git: down, work: c.work, emptyHooks: empty, before: { ok: true, address: null } }), { ok: false })
  } finally {
    await c.done()
  }
})
