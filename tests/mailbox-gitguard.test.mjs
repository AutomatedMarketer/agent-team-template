import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from './helpers/git.mjs'
import { gitUnchanged, remakeWorkCopy, snapshotGit } from '../scripts/lib/mailbox/gitguard.mjs'

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

test('the work copy is made again from the address the runner knew before Claude started, not from one in the folder now', async () => {
  const c = await clone()
  try {
    const before = await snapshotGit(c.work)
    await appendFile(join(c.work, '.git', 'config'), '[remote "origin"]\n\turl = https://evil.example/x.git\n')
    await writeFile(join(c.work, 'junk.txt'), 'planted\n')
    const empty = join(c.root, 'empty-hooks')
    await mkdir(empty)
    const calls = []
    const watching = async (args, cwd) => {
      calls.push({ verb: args.find((one) => one === 'clone'), cwd })
      return git(args, cwd)
    }
    assert.deepEqual(await remakeWorkCopy({ git: watching, work: c.work, emptyHooks: empty, before }), { ok: true })
    assert.deepEqual(calls.map((one) => one.verb), ['clone'])
    assert.equal(calls[0].cwd, c.root, 'run beside the old folder, never in it')
    assert.equal(await readFile(join(c.work, 'a.txt'), 'utf8'), 'a\n')
    await assert.rejects(readFile(join(c.work, 'junk.txt')), 'what was planted is gone')
    assert.ok(!(await readFile(join(c.work, '.git', 'config'), 'utf8')).includes('evil.example'))
  } finally {
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
