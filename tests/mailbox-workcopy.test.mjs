import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile, stat, readdir, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from './helpers/git.mjs'
import { PINS, pinnedGit, configText, resetWorkCopy, commitPaths, pushCommits, landedCommit, originUrl, readOrigin } from '../scripts/lib/mailbox/workcopy.mjs'

/* The work copy is the Mac's own clone of the team repo. Other people and cloud routines push to that repo, so nothing in
   the clone is trusted: before every order it is brought level with the team repo's main and everything else in it -
   changes, untracked files, ignored files, a hook, a setting in .git/config - is thrown away. Git runs with its hooks
   switched off and a few settings fixed on every command, so a planted one has no way to run. A change goes back by
   a push that names its commit and its branch and carries a lease on what the clone was based on. */

const ORIGIN_OK = () => true

async function world() {
  const root = await mkdtemp(join(tmpdir(), 'mailbox-workcopy-'))
  const origin = join(root, 'origin.git')
  const seed = join(root, 'seed')
  const work = join(root, 'work')
  const other = join(root, 'other')
  const empty = join(root, 'empty-hooks')
  await mkdir(empty)
  await git(['init', '-q', '--bare', '-b', 'main', origin], root)
  await git(['clone', '-q', origin, seed], root)
  for (const [key, value] of [['user.email', 'seed@example.com'], ['user.name', 'Seed'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) await git(['config', key, value], seed)
  await writeFile(join(seed, 'README.md'), '# team\n')
  await mkdir(join(seed, 'tasks'))
  await writeFile(join(seed, 'tasks', 'README.md'), '# tasks\n')
  await writeFile(join(seed, '.gitignore'), 'ignored.txt\n')
  await git(['checkout', '-q', '-b', 'main'], seed).catch(() => {})
  await git(['add', '-A'], seed)
  await git(['commit', '-q', '-m', 'seed'], seed)
  await git(['push', '-q', 'origin', 'main'], seed)
  await git(['clone', '-q', origin, work], root)
  await git(['clone', '-q', origin, other], root)
  for (const dir of [other]) for (const [key, value] of [['user.email', 'other@example.com'], ['user.name', 'Other'], ['commit.gpgsign', 'false']]) await git(['config', key, value], dir)
  return {
    root, origin, seed, work, other, empty,
    // Another person's push to the team repo.
    push: async (name, text = 'x\n') => {
      await git(['pull', '-q', '--rebase', 'origin', 'main'], other)
      await writeFile(join(other, name), text)
      await git(['add', '-A'], other)
      await git(['commit', '-q', '-m', `other: ${name}`], other)
      await git(['push', '-q', 'origin', 'main'], other)
      return (await git(['rev-parse', 'HEAD'], other)).stdout.trim()
    },
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}

const reset = (w, change = {}) => resetWorkCopy({ git, work: w.work, emptyHooks: w.empty, originAccepted: ORIGIN_OK, ...change })

/* ---------- git as the runner runs it ------------------------------------------------------------------------------ */

test('every git command carries the pins: hooks off, no external helper and no editor, whatever the clone\'s own settings say', async () => {
  const seen = []
  const run = pinnedGit(async (args, cwd) => { seen.push({ args, cwd }); return { stdout: '' } }, '/empty-hooks')
  await run(['status'], '/work')
  assert.deepEqual(seen[0].cwd, '/work')
  assert.deepEqual(seen[0].args.slice(-1), ['status'])
  const pins = seen[0].args.slice(0, -1)
  assert.deepEqual(pins.filter((arg) => arg !== '-c'), [...PINS('/empty-hooks')])
  for (const must of ['core.hooksPath=/empty-hooks', 'core.fsmonitor=false', 'commit.gpgsign=false', 'core.editor=true', 'core.pager=cat', 'diff.external=', 'gc.auto=0']) assert.ok(pins.includes(must), must)
})

test('a hook planted in the clone does not run - not on commit, not on push', async () => {
  const w = await world()
  try {
    const marker = join(w.root, 'hook-ran.txt')
    await mkdir(join(w.work, '.git', 'hooks'), { recursive: true })
    const script = `#!/bin/sh\necho ran >> "${marker.replaceAll('\\', '/')}"\nexit 0\n`
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'pre-push', 'reference-transaction', 'post-checkout']) await writeFile(join(w.work, '.git', 'hooks', hook), script, { mode: 0o755 })
    const run = pinnedGit(git, w.empty)
    await writeFile(join(w.work, 'tasks', 'a.md'), 'card\n')
    await run(['add', '--', 'tasks/a.md'], w.work)
    await run(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'x'], w.work)
    await run(['push', '-q', 'origin', 'HEAD:refs/heads/main'], w.work)
    await assert.rejects(stat(marker), { code: 'ENOENT' })
  } finally {
    await w.cleanup()
  }
})

/* ---------- the config the clone is given -------------------------------------------------------------------------- */

test('the clone\'s own config is written again from scratch each time: its origin and nothing else the repo could have planted', () => {
  const text = configText({ url: 'https://github.com/ExampleOwner/example-team.git', emptyHooks: '/empty-hooks' })
  assert.ok(text.includes('url = https://github.com/ExampleOwner/example-team.git'))
  assert.ok(text.includes('hooksPath = /empty-hooks'))
  for (const never of ['pushurl', 'insteadOf', 'alias', 'filter', 'include', 'sshCommand', 'credential', 'diff', 'merge "', 'submodule', 'extensions']) assert.ok(!text.includes(never), never)
  assert.match(text, /^\[core\]\n/)
  for (const bad of ['https://github.com/x/y.git\nurl = evil', 'a\r\nb', '', undefined]) assert.throws(() => configText({ url: bad, emptyHooks: '/e' }), TypeError, String(bad))
  assert.throws(() => configText({ url: 'https://github.com/x/y.git', emptyHooks: 'a\nb' }), TypeError)
})

test('what the clone\'s origin is can be read, and a config that cannot be read says nothing', async () => {
  const w = await world()
  try {
    assert.match(await originUrl(w.work), /origin\.git$/)
    assert.equal(await originUrl(join(w.root, 'not-a-clone')), null)
  } finally {
    await w.cleanup()
  }
})

/* ---------- bringing the clone level ------------------------------------------------------------------------------- */

test('a reset brings the clone to the team repo\'s main and throws away every other thing in it', async () => {
  const w = await world()
  try {
    await writeFile(join(w.work, 'README.md'), 'edited\n')
    await writeFile(join(w.work, 'untracked.md'), 'new\n')
    await writeFile(join(w.work, 'ignored.txt'), 'ignored\n')
    await mkdir(join(w.work, 'nested', 'deep'), { recursive: true })
    await writeFile(join(w.work, 'nested', 'deep', 'x.md'), 'x\n')
    await git(['checkout', '-q', '-b', 'side'], w.work)
    await git(['config', 'user.email', 'a@b.c'], w.work)
    await git(['config', 'user.name', 'A'], w.work)
    await writeFile(join(w.work, 'tasks', 'local.md'), 'a local commit\n')
    await git(['add', '-A'], w.work)
    await git(['commit', '-q', '-m', 'local work not pushed'], w.work)
    const head = await w.push('from-someone.md')
    const result = await reset(w)
    assert.deepEqual(result, { ok: true, head })
    assert.equal((await git(['rev-parse', 'HEAD'], w.work)).stdout.trim(), head)
    assert.equal((await git(['symbolic-ref', '--short', 'HEAD'], w.work)).stdout.trim(), 'main')
    assert.equal((await git(['status', '--porcelain', '--ignored'], w.work)).stdout, '')
    assert.equal(await readFile(join(w.work, 'README.md'), 'utf8'), '# team\n')
    assert.equal((await readdir(w.work)).includes('untracked.md'), false)
    assert.equal((await readdir(w.work)).includes('ignored.txt'), false)
    assert.equal((await readdir(w.work)).includes('nested'), false)
    assert.equal((await readFile(join(w.work, 'from-someone.md'), 'utf8')), 'x\n')
  } finally {
    await w.cleanup()
  }
})

test('a reset rewrites the clone\'s config and does not run what the old one named', async () => {
  const w = await world()
  try {
    const marker = join(w.root, 'ran.txt').replaceAll('\\', '/')
    const config = join(w.work, '.git', 'config')
    const before = await readFile(config, 'utf8')
    await writeFile(config, `${before}\n[alias]\n\tst = !echo > "${marker}"\n[core]\n\tpager = echo > "${marker}"\n\tfsmonitor = echo > "${marker}"\n[remote "origin"]\n\tpushurl = https://evil.example/x.git\n[filter "x"]\n\tclean = echo > "${marker}"\n[include]\n\tpath = /tmp/evil\n`)
    const result = await reset(w)
    assert.equal(result.ok, true)
    const after = await readFile(config, 'utf8')
    for (const never of ['pushurl', 'alias', 'filter', 'include', 'fsmonitor', 'evil']) assert.ok(!after.includes(never), never)
    assert.equal(after, configText({ url: await originUrl(w.work), emptyHooks: w.empty }))
    await assert.rejects(stat(marker), { code: 'ENOENT' })
  } finally {
    await w.cleanup()
  }
})

test('a reset of a clone whose origin is not the team repo does nothing: the origin is checked before the config is rewritten and before anything is fetched', async () => {
  const w = await world()
  try {
    await git(['remote', 'set-url', 'origin', 'https://evil.example/ExampleOwner/example-team.git'], w.work)
    const result = await reset(w, { originAccepted: (url) => /github\.com/.test(url) })
    assert.deepEqual(result, { ok: false, why: 'origin-mismatch' })
    assert.match(await originUrl(w.work), /evil\.example/, 'the config was left alone')
  } finally {
    await w.cleanup()
  }
})

test('a reset says "unreachable" when the team repo cannot be fetched, and leaves the clone as it was', async () => {
  const w = await world()
  try {
    await git(['remote', 'set-url', 'origin', join(w.root, 'no-such-repo.git')], w.work)
    await writeFile(join(w.work, 'untracked.md'), 'x\n')
    const result = await reset(w)
    assert.deepEqual(result, { ok: false, why: 'unreachable' })
    assert.ok(!JSON.stringify(result).includes(w.root))
  } finally {
    await w.cleanup()
  }
})

test('a folder that is not a clone, or is a folder inside another repo, is not reset', async () => {
  const w = await world()
  try {
    await mkdir(join(w.root, 'plain'))
    assert.deepEqual(await reset(w, { work: join(w.root, 'plain') }), { ok: false, why: 'not-a-clone' })
    assert.deepEqual(await reset(w, { work: join(w.work, 'tasks') }), { ok: false, why: 'not-a-clone' })
    assert.deepEqual(await reset(w, { work: join(w.root, 'missing') }), { ok: false, why: 'not-a-clone' })
  } finally {
    await w.cleanup()
  }
})

/* ---------- committing --------------------------------------------------------------------------------------------- */

test('a commit holds exactly the paths named, with the message and the trailer, and an author that is the runner\'s', async () => {
  const w = await world()
  try {
    await reset(w)
    await writeFile(join(w.work, 'tasks', '2026-10-12-a.md'), 'card\n')
    await writeFile(join(w.work, 'stray.md'), 'not named\n')
    const commit = await commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/2026-10-12-a.md'], message: 'Mailbox order 0f1e2d3c: task', trailer: 'Mailbox-Order: 0f1e2d3c4b5a69788796a5b4c3d2e1f0' })
    assert.match(commit, /^[0-9a-f]{40}$/)
    assert.deepEqual((await git(['show', '--name-only', '--format=', commit], w.work)).stdout.trim().split('\n'), ['tasks/2026-10-12-a.md'])
    const message = (await git(['log', '-1', '--format=%B', commit], w.work)).stdout
    assert.ok(message.startsWith('Mailbox order 0f1e2d3c: task\n\nMailbox-Order: 0f1e2d3c4b5a69788796a5b4c3d2e1f0'))
    assert.equal((await git(['log', '-1', '--format=%an <%ae>', commit], w.work)).stdout.trim(), 'Agent mailbox <agent-mailbox@users.noreply.github.com>')
    assert.equal((await git(['status', '--porcelain'], w.work)).stdout.trim(), '?? stray.md')
  } finally {
    await w.cleanup()
  }
})

test('files someone staged beforehand do not ride along in the commit: it is refused instead', async () => {
  const w = await world()
  try {
    await reset(w)
    await writeFile(join(w.work, 'staged.md'), 'staged\n')
    await git(['add', 'staged.md'], w.work)
    await writeFile(join(w.work, 'tasks', 'b.md'), 'card\n')
    await assert.rejects(commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/b.md'], message: 'm' }), /staged/)
    const head = (await git(['rev-parse', 'HEAD'], w.work)).stdout.trim()
    assert.equal(head, (await git(['rev-parse', 'origin/main'], w.work)).stdout.trim(), 'nothing was committed')
  } finally {
    await w.cleanup()
  }
})

test('paths that are not plain repo paths, an empty list, or a message with a bad trailer are mistakes that throw before git is run', async () => {
  const never = async () => { throw new Error('git was run') }
  for (const paths of [[], ['../x'], ['/abs'], ['a\\b'], ['-f'], ['a\nb'], ['tasks/*'], [''], 'tasks/a.md', [7]]) {
    await assert.rejects(commitPaths({ git: never, work: '/w', emptyHooks: '/e', paths, message: 'm' }), TypeError, JSON.stringify(paths))
  }
  for (const trailer of ['no colon', 'Mailbox-Order: x\ny', 7]) {
    await assert.rejects(commitPaths({ git: never, work: '/w', emptyHooks: '/e', paths: ['a.md'], message: 'm', trailer }), TypeError, String(trailer))
  }
  for (const message of ['', 'two\nlines is fine but not empty'.repeat(0), 7, undefined]) {
    await assert.rejects(commitPaths({ git: never, work: '/w', emptyHooks: '/e', paths: ['a.md'], message }), TypeError, String(message))
  }
})

test('a path that may be unchanged goes in the commit when it changed, and is left out when it did not - the named paths must still all be there', async () => {
  const w = await world()
  try {
    await reset(w)
    await writeFile(join(w.work, 'tasks', 'k.md'), 'card\n')
    await writeFile(join(w.work, 'status.json'), '{}\n')
    const first = await commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/k.md'], maybe: ['status.json'], message: 'one' })
    assert.deepEqual((await git(['show', '--name-only', '--format=', first], w.work)).stdout.trim().split('\n').sort(), ['status.json', 'tasks/k.md'])

    await writeFile(join(w.work, 'tasks', 'l.md'), 'card\n')
    const second = await commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/l.md'], maybe: ['status.json'], message: 'two' })
    assert.deepEqual((await git(['show', '--name-only', '--format=', second], w.work)).stdout.trim().split('\n'), ['tasks/l.md'], 'the unchanged one is not in it')

    // A named path that did not change is still a mistake: that is a change that did not happen.
    await writeFile(join(w.work, 'status.json'), '{"changed": true}\n')
    await assert.rejects(commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/l.md'], maybe: ['status.json'], message: 'three' }), /named paths/)
    // (checked out the way the runner checks out: a Windows setting must not make the file look changed)
    await git(['-c', 'core.autocrlf=false', 'reset', '--quiet', '--hard'], w.work)
    // And nothing at all to commit is not a commit.
    await assert.rejects(commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: [], maybe: ['status.json'], message: 'four' }), /nothing/)
  } finally {
    await w.cleanup()
  }
})

test('the paths that may be unchanged are plain repo paths too', async () => {
  const never = async () => { throw new Error('git was run') }
  for (const maybe of [['../x'], ['/abs'], ['-f'], [''], 'status.json', [7]]) {
    await assert.rejects(commitPaths({ git: never, work: '/w', emptyHooks: '/e', paths: ['a.md'], maybe, message: 'm' }), TypeError, JSON.stringify(maybe))
  }
})

/* ---------- pushing ------------------------------------------------------------------------------------------------ */

test('a push of one commit that sits right on what the clone was based on lands, and the team repo has that commit', async () => {
  const w = await world()
  try {
    const based = (await reset(w)).head
    await writeFile(join(w.work, 'tasks', 'c.md'), 'card\n')
    const commit = await commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/c.md'], message: 'm' })
    assert.deepEqual(await pushCommits({ git, work: w.work, emptyHooks: w.empty, commit, expected: based, count: 1 }), { ok: true })
    assert.equal((await git(['rev-parse', 'refs/heads/main'], w.origin)).stdout.trim(), commit)
  } finally {
    await w.cleanup()
  }
})

test('two commits can go in one push, and only when both are there on top of what the clone was based on', async () => {
  const w = await world()
  try {
    const based = (await reset(w)).head
    await writeFile(join(w.work, 'tasks', 'd.md'), 'card\n')
    await commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/d.md'], message: 'one' })
    await writeFile(join(w.work, 'tasks', 'e.md'), 'card\n')
    const second = await commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/e.md'], message: 'two' })
    assert.deepEqual(await pushCommits({ git, work: w.work, emptyHooks: w.empty, commit: second, expected: based, count: 1 }), { ok: false, why: 'not-the-commits' })
    assert.deepEqual(await pushCommits({ git, work: w.work, emptyHooks: w.empty, commit: second, expected: based, count: 2 }), { ok: true })
  } finally {
    await w.cleanup()
  }
})

test('a push is refused by the lease when the team repo has moved on since the clone was based - and nothing of the other person\'s is lost', async () => {
  const w = await world()
  try {
    const based = (await reset(w)).head
    await writeFile(join(w.work, 'tasks', 'f.md'), 'card\n')
    const commit = await commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/f.md'], message: 'm' })
    const theirs = await w.push('theirs.md')
    assert.deepEqual(await pushCommits({ git, work: w.work, emptyHooks: w.empty, commit, expected: based, count: 1 }), { ok: false, why: 'moved' })
    assert.equal((await git(['rev-parse', 'refs/heads/main'], w.origin)).stdout.trim(), theirs, 'their commit is still the tip')
  } finally {
    await w.cleanup()
  }
})

test('the lease is held on the commit the clone was based on, so a stale idea of the team repo cannot overwrite it', async () => {
  const w = await world()
  try {
    const based = (await reset(w)).head
    await writeFile(join(w.work, 'tasks', 'g.md'), 'card\n')
    const commit = await commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/g.md'], message: 'm' })
    await w.push('theirs.md')
    // Even after the clone fetches, the lease still names what it was based on, not the new tip.
    await git(['fetch', '-q', 'origin'], w.work)
    assert.deepEqual(await pushCommits({ git, work: w.work, emptyHooks: w.empty, commit, expected: based, count: 1 }), { ok: false, why: 'moved' })
  } finally {
    await w.cleanup()
  }
})

test('a push carries only the named commit to main: not tags, not other branches, not submodules', async () => {
  const w = await world()
  try {
    const based = (await reset(w)).head
    await git(['tag', 'local-tag'], w.work)
    await git(['branch', 'side'], w.work)
    await git(['config', '--local', 'push.followTags', 'true'], w.work)
    await writeFile(join(w.work, 'tasks', 'h.md'), 'card\n')
    const commit = await commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/h.md'], message: 'm' })
    assert.equal((await pushCommits({ git, work: w.work, emptyHooks: w.empty, commit, expected: based, count: 1 })).ok, true)
    assert.equal((await git(['tag', '-l'], w.origin)).stdout.trim(), '')
    assert.equal((await git(['branch', '--list'], w.origin)).stdout.includes('side'), false)
  } finally {
    await w.cleanup()
  }
})

test('a push with an expected commit or a commit that is not a full hash is a mistake that throws', async () => {
  const never = async () => { throw new Error('git was run') }
  for (const [commit, expected] of [['abc', 'a'.repeat(40)], ['a'.repeat(40), 'abc'], ['a'.repeat(40), 'HEAD'], ['--force', 'a'.repeat(40)], [undefined, 'a'.repeat(40)], ['a'.repeat(40), undefined]]) {
    await assert.rejects(pushCommits({ git: never, work: '/w', emptyHooks: '/e', commit, expected, count: 1 }), TypeError, `${commit} ${expected}`)
  }
  for (const count of [0, 3, -1, 1.5, '1', undefined]) {
    await assert.rejects(pushCommits({ git: never, work: '/w', emptyHooks: '/e', commit: 'a'.repeat(40), expected: 'b'.repeat(40), count }), TypeError, String(count))
  }
})

/* ---------- what landed -------------------------------------------------------------------------------------------- */

test('an order is found on the team repo\'s main by the trailer in its commit; with none there it was not found; a team repo that cannot be fetched is "unknown"', async () => {
  const w = await world()
  try {
    const based = (await reset(w)).head
    const id = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
    await writeFile(join(w.work, 'tasks', 'i.md'), 'card\n')
    const commit = await commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/i.md'], message: 'Mailbox order', trailer: `Mailbox-Order: ${id}` })
    assert.deepEqual(await landedCommit({ git, work: w.work, emptyHooks: w.empty, id }), { state: 'not-found' }, 'committed here, not pushed')
    await pushCommits({ git, work: w.work, emptyHooks: w.empty, commit, expected: based, count: 1 })
    assert.deepEqual(await landedCommit({ git, work: w.work, emptyHooks: w.empty, id }), { state: 'found', commit })
    assert.deepEqual(await landedCommit({ git, work: w.work, emptyHooks: w.empty, id: '11111111111111111111111111111111' }), { state: 'not-found' })
    await git(['remote', 'set-url', 'origin', join(w.root, 'gone.git')], w.work)
    assert.deepEqual(await landedCommit({ git, work: w.work, emptyHooks: w.empty, id }), { state: 'unknown' })
  } finally {
    await w.cleanup()
  }
})

test('the trailer must be on its own line: the id in a title, or in the middle of a line, or another order\'s id that merely contains it, is not a match', async () => {
  const w = await world()
  try {
    const based = (await reset(w)).head
    const id = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
    await writeFile(join(w.work, 'tasks', 'j.md'), 'card\n')
    const commit = await commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/j.md'], message: `Mailbox-Order: ${id} is in the title\n\nSee the Mailbox-Order: ${id} elsewhere` })
    await pushCommits({ git, work: w.work, emptyHooks: w.empty, commit, expected: based, count: 1 })
    assert.deepEqual(await landedCommit({ git, work: w.work, emptyHooks: w.empty, id }), { state: 'not-found' })
  } finally {
    await w.cleanup()
  }
})

test('only a good id is looked for: anything else is a mistake that throws before git is run', async () => {
  const never = async () => { throw new Error('git was run') }
  for (const id of ['', 'abc', '../x', `${'a'.repeat(31)}.`, 'A'.repeat(32), undefined, 7]) {
    await assert.rejects(landedCommit({ git: never, work: '/w', emptyHooks: '/e', id }), TypeError, String(id))
  }
})

test('where the clone fetches from and pushes to is read from its config file as text: a push address of its own counts, two origins or none say nothing', async () => {
  const w = await world()
  try {
    const config = join(w.work, '.git', 'config')
    const original = await readFile(config, 'utf8')
    assert.deepEqual(await readOrigin(w.work), { fetch: await originUrl(w.work), push: await originUrl(w.work) })
    await writeFile(config, `${original}[remote "origin"]\n\tpushurl = https://github.com/Other/elsewhere.git\n`)
    assert.deepEqual(await readOrigin(w.work), { fetch: await originUrl(w.work), push: 'https://github.com/Other/elsewhere.git' })
    await writeFile(config, `${original}[remote "origin"]\n\tPushURL = a\n\tpushurl = b\n`)
    assert.equal(await readOrigin(w.work), null, 'two push addresses')
    await writeFile(config, `${original}[remote "origin"]\n\turl = https://github.com/Other/x.git\n`)
    assert.equal(await readOrigin(w.work), null, 'two fetch addresses')
    await writeFile(config, '[core]\n\tbare = false\n')
    assert.equal(await readOrigin(w.work), null, 'no origin')
    await writeFile(config, '[remote "other"]\n\turl = https://github.com/x/y.git\n')
    assert.equal(await readOrigin(w.work), null, 'another remote is not origin')
    assert.equal(await readOrigin(join(w.root, 'not-a-clone')), null)
  } finally {
    await w.cleanup()
  }
})

/* ---------- what the pins and the config are, exactly -------------------------------------------------------------- */

test('the settings given to every git command are exactly these - each shuts one way a setting in the clone, the user\'s config or the system\'s could make git run a program or change a byte', () => {
  assert.deepEqual(PINS('/hooks'), [
    'core.hooksPath=/hooks', 'core.fsmonitor=false', 'core.untrackedCache=false', 'core.autocrlf=false', 'core.safecrlf=false', 'core.editor=true', 'core.pager=cat',
    'diff.external=', 'commit.gpgsign=false', 'tag.gpgsign=false', 'gc.auto=0', 'maintenance.auto=false', 'advice.detachedHead=false'
  ])
})

test('a hooks folder with a space, a backslash and a quote in it is written into the config in quotes, with the quote and the backslash escaped', () => {
  const text = configText({ url: 'https://github.com/Owner/team.git', emptyHooks: 'C:\\Users\\some one\\empty "hooks"' })
  assert.ok(text.includes('\thooksPath = "C:\\\\Users\\\\some one\\\\empty \\"hooks\\""'), text)
  assert.ok(text.includes('\turl = https://github.com/Owner/team.git\n'), 'a plain address is not quoted')
  assert.ok(text.includes('\tmerge = refs/heads/main\n'))
})

/* ---------- more of what bringing the clone level does ------------------------------------------------------------- */

test('a .git that is a link is not a clone: nothing is read through it and nothing is written through it', async () => {
  const w = await world()
  try {
    const elsewhere = join(w.root, 'elsewhere')
    await rename(join(w.work, '.git'), elsewhere)
    await symlink(elsewhere, join(w.work, '.git'), process.platform === 'win32' ? 'junction' : 'dir')
    const before = await readFile(join(elsewhere, 'config'), 'utf8')
    assert.deepEqual(await reset(w), { ok: false, why: 'not-a-clone' })
    assert.equal(await readFile(join(elsewhere, 'config'), 'utf8'), before, 'the config behind the link was not rewritten')
  } finally {
    await w.cleanup()
  }
})

test('the fetch asks for the one branch and nothing else: no tags, no submodules', async () => {
  const w = await world()
  try {
    const seen = []
    const spy = async (args, cwd) => { seen.push(args); return git(args, cwd) }
    assert.equal((await reset(w, { git: spy })).ok, true)
    const fetch = seen.find((args) => args.includes('fetch'))
    for (const flag of ['--no-tags', '--no-recurse-submodules']) assert.ok(fetch.includes(flag), flag)
    assert.deepEqual(fetch.slice(fetch.indexOf('origin')), ['origin', 'main'])
  } finally {
    await w.cleanup()
  }
})

test('a local change to a file the team repo has changed too does not stop the clone being brought level: the change is thrown away', async () => {
  const w = await world()
  try {
    await w.push('README.md', '# changed upstream\n')
    await writeFile(join(w.work, 'README.md'), '# changed here\n')
    const result = await reset(w)
    assert.equal(result.ok, true)
    assert.equal(await readFile(join(w.work, 'README.md'), 'utf8'), '# changed upstream\n')
  } finally {
    await w.cleanup()
  }
})

test('a repository inside the clone is thrown away too, not left for the next order', async () => {
  const w = await world()
  try {
    const nested = join(w.work, 'inner')
    await mkdir(nested)
    await git(['init', '-q'], nested)
    await writeFile(join(nested, 'a.txt'), 'x')
    assert.equal((await reset(w)).ok, true)
    await assert.rejects(stat(nested))
  } finally {
    await w.cleanup()
  }
})

/* ---------- more of what a push does and refuses ------------------------------------------------------------------- */

test('a commit that is not on top of the commit the clone was based on is not pushed, even when it is exactly one commit that main does not have', async () => {
  const w = await world()
  try {
    const first = (await reset(w)).head
    await w.push('theirs.md')
    const second = (await reset(w)).head
    // A commit made on the older one: a sibling of main's tip, one commit "ahead" by count, but not on top of it.
    await git(['-c', 'core.autocrlf=false', 'reset', '--quiet', '--hard', first], w.work)
    await writeFile(join(w.work, 'tasks', 'sibling.md'), 'card\n')
    const sibling = await commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/sibling.md'], message: 'sibling' })
    assert.deepEqual(await pushCommits({ git, work: w.work, emptyHooks: w.empty, commit: sibling, expected: second, count: 1 }), { ok: false, why: 'not-the-commits' })
    assert.equal((await git(['rev-parse', 'refs/heads/main'], w.origin)).stdout.trim(), second, 'main did not move')
  } finally {
    await w.cleanup()
  }
})

test('the push is conditional on main being exactly where the clone started: put back to an older commit, it is "moved" even though a push on top would have been a plain fast-forward', async () => {
  const w = await world()
  try {
    const older = (await git(['rev-parse', 'refs/heads/main'], w.origin)).stdout.trim()
    await w.push('theirs.md')
    const expected = (await reset(w)).head
    await writeFile(join(w.work, 'tasks', 'mine.md'), 'card\n')
    const commit = await commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/mine.md'], message: 'mine' })
    // Someone puts main back to the older commit (a forced push): ours sits on top of that too.
    await git(['push', '-q', '--force', 'origin', `${older}:refs/heads/main`], w.other)
    assert.deepEqual(await pushCommits({ git, work: w.work, emptyHooks: w.empty, commit, expected, count: 1 }), { ok: false, why: 'moved' })
    assert.equal((await git(['rev-parse', 'refs/heads/main'], w.origin)).stdout.trim(), older, 'main was left as it was found')
  } finally {
    await w.cleanup()
  }
})

test('the push names the lease, no tags and no submodules, and the one commit to the one branch', async () => {
  const w = await world()
  try {
    const expected = (await reset(w)).head
    await writeFile(join(w.work, 'tasks', 'mine.md'), 'card\n')
    const commit = await commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/mine.md'], message: 'mine' })
    const seen = []
    const spy = async (args, cwd) => { seen.push(args); return git(args, cwd) }
    assert.deepEqual(await pushCommits({ git: spy, work: w.work, emptyHooks: w.empty, commit, expected, count: 1 }), { ok: true })
    const push = seen.find((args) => args.includes('push'))
    const tail = push.slice(push.indexOf('push'))
    assert.deepEqual(tail, ['push', '--quiet', '--no-follow-tags', '--recurse-submodules=no', `--force-with-lease=refs/heads/main:${expected}`, 'origin', `${commit}:refs/heads/main`])
  } finally {
    await w.cleanup()
  }
})

test('a tag on the commit is not pushed with it, whatever the clone\'s settings say about following tags', async () => {
  const w = await world()
  try {
    const expected = (await reset(w)).head
    await writeFile(join(w.work, 'tasks', 'mine.md'), 'card\n')
    const commit = await commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/mine.md'], message: 'mine' })
    await git(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'tag', '-a', 'v1', '-m', 'a tag', commit], w.work)
    await git(['config', 'push.followTags', 'true'], w.work)
    assert.deepEqual(await pushCommits({ git, work: w.work, emptyHooks: w.empty, commit, expected, count: 1 }), { ok: true })
    assert.equal((await git(['tag', '--list'], w.origin)).stdout.trim(), '', 'no tag reached the team repo')
  } finally {
    await w.cleanup()
  }
})

test('a team repo that cannot be asked why the push was refused is "unreachable", not "refused"', async () => {
  const w = await world()
  try {
    const expected = (await reset(w)).head
    await writeFile(join(w.work, 'tasks', 'mine.md'), 'card\n')
    const commit = await commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/mine.md'], message: 'mine' })
    const down = async (args, cwd) => {
      if (args.includes('push') || args.includes('ls-remote')) throw new Error('unreachable')
      return git(args, cwd)
    }
    assert.deepEqual(await pushCommits({ git: down, work: w.work, emptyHooks: w.empty, commit, expected, count: 1 }), { ok: false, why: 'unreachable' })
  } finally {
    await w.cleanup()
  }
})

/* ---------- finding an order again by its trailer ------------------------------------------------------------------ */

test('an order is found on the team repo\'s main only: a commit with its trailer that was never pushed is not found', async () => {
  const w = await world()
  try {
    const id = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
    await reset(w)
    await writeFile(join(w.work, 'tasks', 'mine.md'), 'card\n')
    await commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/mine.md'], message: 'mine', trailer: `Mailbox-Order: ${id}` })
    assert.deepEqual(await landedCommit({ git, work: w.work, emptyHooks: w.empty, id }), { state: 'not-found' })
  } finally {
    await w.cleanup()
  }
})

test('when the trailer is on more than one commit the newest is the one found, as one full hash', async () => {
  const w = await world()
  try {
    const id = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
    const commitWith = async (name) => {
      await git(['pull', '-q', '--rebase', 'origin', 'main'], w.other)
      await writeFile(join(w.other, name), 'x\n')
      await git(['add', '-A'], w.other)
      await git(['commit', '-q', '-m', `first line\n\nMailbox-Order: ${id}`], w.other)
      await git(['push', '-q', 'origin', 'main'], w.other)
      return (await git(['rev-parse', 'HEAD'], w.other)).stdout.trim()
    }
    await commitWith('a.md')
    const newest = await commitWith('b.md')
    assert.deepEqual(await landedCommit({ git, work: w.work, emptyHooks: w.empty, id }), { state: 'found', commit: newest })
  } finally {
    await w.cleanup()
  }
})

test('a push that lands but whose git reports a failure is "landed", even with another pusher\'s commit on top of it - and is not "moved"', async () => {
  const w = await world()
  try {
    const expected = (await reset(w)).head
    await writeFile(join(w.work, 'tasks', 'mine.md'), 'card\n')
    const commit = await commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/mine.md'], message: 'mine' })
    const dropped = async (args, cwd) => {
      const done = await git(args, cwd)
      if (args.includes('push')) throw new Error('the connection was reset after the server took the push')
      return done
    }
    assert.deepEqual(await pushCommits({ git: dropped, work: w.work, emptyHooks: w.empty, commit, expected, count: 1 }), { ok: true, landed: true })
    await w.push('theirs.md')
    const again = await reset(w)
    assert.equal(again.ok, true)
    assert.equal((await git(['merge-base', '--is-ancestor', commit, 'refs/heads/main'], w.origin).then(() => true, () => false)), true)
  } finally {
    await w.cleanup()
  }
})

test('a push that failed after main moved to something without our commit is "moved", and a push that failed with main untouched is "refused"', async () => {
  const w = await world()
  try {
    const expected = (await reset(w)).head
    await writeFile(join(w.work, 'tasks', 'mine.md'), 'card\n')
    const commit = await commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/mine.md'], message: 'mine' })
    const refusing = async (args, cwd) => {
      if (args.includes('push')) throw new Error('refused')
      return git(args, cwd)
    }
    assert.deepEqual(await pushCommits({ git: refusing, work: w.work, emptyHooks: w.empty, commit, expected, count: 1 }), { ok: false, why: 'refused' })
    await w.push('theirs.md')
    assert.deepEqual(await pushCommits({ git: refusing, work: w.work, emptyHooks: w.empty, commit, expected, count: 1 }), { ok: false, why: 'moved' })
  } finally {
    await w.cleanup()
  }
})

test('a failed push whose team repo answers the tip but cannot be fetched is "unreachable": whether it landed is not known', async () => {
  const w = await world()
  try {
    const expected = (await reset(w)).head
    await writeFile(join(w.work, 'tasks', 'mine.md'), 'card\n')
    const commit = await commitPaths({ git, work: w.work, emptyHooks: w.empty, paths: ['tasks/mine.md'], message: 'mine' })
    const halfDown = async (args, cwd) => {
      if (args.includes('fetch')) throw new Error('unreachable')
      const done = await git(args, cwd)
      if (args.includes('push')) throw new Error('timed out')
      return done
    }
    assert.deepEqual(await pushCommits({ git: halfDown, work: w.work, emptyHooks: w.empty, commit, expected, count: 1 }), { ok: false, why: 'unreachable' })
  } finally {
    await w.cleanup()
  }
})
