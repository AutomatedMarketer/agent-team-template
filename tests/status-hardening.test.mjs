import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readdir, readFile, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCollector } from '../scripts/lib/status/run.mjs'
import { makeFakeHome, setMtime, FAKE_EMAIL } from './helpers/fake-home.mjs'
import { depsFor, filesUnder } from './helpers/hostile-home.mjs'

/* Three small guards from the Phase 5+6 security re-review:
   - a private copy of Hermes's state.db left behind by a crash is cleared at the start of the next
     run - only those folders, only in the state folder, never through a link;
   - a --state-dir inside the --clone folder is refused, like the collector's own code there;
   - a write that fails after some files were already renamed into place says so, instead of
     "Nothing was written". */

async function run(fake, args, { target, extra = {} } = {}) {
  const stdout = []
  const stderr = []
  const code = await runCollector({
    argv: ['--computer', 'Test PC', ...args],
    deps: depsFor(fake, extra),
    repoRoot: target,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line)
  })
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
}

const HOUR = 3600_000

// --- 1. leftovers of a crash ---------------------------------------------------------------------------

test('a run clears private state.db copies a crash left in the state folder, and nothing else', async (t) => {
  const fake = await makeFakeHome()
  const target = await mkdtemp(join(tmpdir(), 'agent-status-repo-'))
  const outside = await mkdtemp(join(tmpdir(), 'agent-status-outside-'))
  try {
    // The default state folder: a run without --commit uses it too.
    const state = join(fake.home, '.local', 'state', 'agent-status-collector')
    const folder = async (name, ageMs) => {
      await mkdir(join(state, name), { recursive: true })
      await writeFile(join(state, name, 'state.db'), 'copy')
      await setMtime(join(state, name), Date.now() - ageMs)
    }
    await folder('hermes-db-crashed', 2 * HOUR)
    // A copy made seconds ago may belong to another run that is reading it right now.
    await folder('hermes-db-in-use', 0)
    await folder('not-a-copy', 2 * HOUR)
    await writeFile(join(state, 'hermes-db-a-file'), 'a file, not a copy folder')
    await writeFile(join(outside, 'keep.txt'), 'outside the state folder')
    let linked = true
    try {
      await symlink(outside, join(state, 'hermes-db-linked'), 'junction')
    } catch {
      linked = false
    }
    const result = await run(fake, ['--only', 'usage', '--dry-run'], { target })
    assert.equal(result.code, 0, result.stderr)
    const left = (await readdir(state)).sort()
    assert.ok(!left.includes('hermes-db-crashed'), 'the crashed copy is still there')
    for (const name of ['hermes-db-in-use', 'not-a-copy', 'hermes-db-a-file']) assert.ok(left.includes(name), `${name} was removed`)
    if (!linked) {
      t.diagnostic('this computer does not let a test make a folder link - the link case is NOT CHECKED here')
      return
    }
    assert.ok(left.includes('hermes-db-linked'), 'a link named like a copy was removed')
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'outside the state folder', 'a link was followed')
  } finally {
    await fake.cleanup()
    await rm(target, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

// --- 2. a state folder inside the data clone ---------------------------------------------------------------

test('a --state-dir inside the --clone folder is refused before anything is read', async (t) => {
  const fake = await makeFakeHome()
  const clone = await mkdtemp(join(tmpdir(), 'agent-status-clone-'))
  const code = await mkdtemp(join(tmpdir(), 'agent-status-code-'))
  try {
    const cases = [clone, join(clone, 'state'), join(clone, 'deep', 'er')]
    // Windows and macOS file systems ignore case, so another spelling is the same folder.
    if (process.platform === 'win32' || process.platform === 'darwin') cases.push(join(clone, 'state').toUpperCase())
    const link = join(fake.home, 'state-link')
    try {
      await symlink(clone, link, 'junction')
      cases.push(join(link, 'state'))
    } catch {
      t.diagnostic('this computer does not let a test make a folder link - the link case is NOT CHECKED here')
    }
    for (const stateDir of cases) {
      const deps = depsFor(fake)
      const stdout = []
      const stderr = []
      const exit = await runCollector({
        argv: ['--computer', 'Test PC', '--commit', '--clone', clone, '--state-dir', stateDir],
        deps,
        repoRoot: code,
        out: (line) => stdout.push(line),
        err: (line) => stderr.push(line)
      })
      assert.equal(exit, 2, stateDir)
      assert.match(stderr.join('\n'), /--state-dir folder is inside the --clone folder/)
      assert.equal(deps.fetch.calls.length, 0, 'something was read before the refusal')
    }
    assert.deepEqual(await filesUnder(clone), [], 'a lock, claim or copy was made in the clone')
  } finally {
    await fake.cleanup()
    await rm(clone, { recursive: true, force: true })
    await rm(code, { recursive: true, force: true })
  }
})

test('a --state-dir beside the --clone folder, sharing the start of its name, is not inside it', async () => {
  const fake = await makeFakeHome()
  const root = await mkdtemp(join(tmpdir(), 'agent-status-pair-'))
  const code = await mkdtemp(join(tmpdir(), 'agent-status-code-'))
  try {
    const clone = join(root, 'data')
    await mkdir(clone)
    const result = await runCollector({
      argv: ['--computer', 'Test PC', '--commit', '--clone', clone, '--state-dir', join(root, 'data-state')],
      deps: depsFor(fake, { git: async () => { throw new Error('not a repo') } }),
      repoRoot: code,
      out: () => {},
      err: () => {}
    })
    // Refused for another reason (it is not a git clone), not for the state folder.
    assert.equal(result, 2)
    assert.ok(existsSync(join(root, 'data-state', 'claims')), 'the run never got past the state-folder check')
  } finally {
    await fake.cleanup()
    await rm(root, { recursive: true, force: true })
    await rm(code, { recursive: true, force: true })
  }
})

// --- 3. a rename failing part way ---------------------------------------------------------------------------

test('a rename failing after an earlier file landed says some files may be written, never "Nothing was written"', async () => {
  const fake = await makeFakeHome()
  const target = await mkdtemp(join(tmpdir(), 'agent-status-repo-'))
  try {
    // The connections file's place is taken by a folder with something in it: its temporary file is
    // written fine, but renaming it over the folder fails - after the usage file was renamed into place.
    const blocked = join(target, '.agent-team', 'status', 'connections', 'test-pc.json')
    await mkdir(blocked, { recursive: true })
    await writeFile(join(blocked, 'keep'), 'not the collector\'s\n')
    const result = await run(fake, ['--only', 'usage,connections'], { target })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /Some snapshot files may have been written; check \.agent-team\/status and runs\/heartbeat/)
    assert.doesNotMatch(result.stderr, /Nothing was written/)
    assert.ok(!result.stderr.includes(target), 'the message named the full folder')
    const files = (await filesUnder(target)).map((file) => file.slice(target.length + 1).replaceAll('\\', '/')).sort()
    assert.deepEqual(files, ['.agent-team/status/connections/test-pc.json/keep', '.agent-team/status/usage/test-pc.json'], 'a temporary file was left behind')
    assert.ok(!result.stderr.includes(FAKE_EMAIL))
  } finally {
    await fake.cleanup()
    await rm(target, { recursive: true, force: true })
  }
})

// --- 2b. a state folder inside the working copy ------------------------------------------------------------

// Without --clone the run works in a copy of the team repo, and a pull or checkout there brings in whatever was
// pushed. The state folder holds the list of vaults this computer allows (allowed-vaults.yml), which only the
// person at this computer may write - so it may not be inside that copy, whether it was given or is the default.
test('without --clone, a --state-dir inside the working copy is refused before anything is read', async (t) => {
  const fake = await makeFakeHome()
  const repo = await mkdtemp(join(tmpdir(), 'agent-status-repo-'))
  try {
    const cases = [repo, join(repo, 'state'), join(repo, '.local', 'state', 'agent-status-collector'), join(repo, 'deep', 'er')]
    if (process.platform === 'win32' || process.platform === 'darwin') cases.push(join(repo, 'state').toUpperCase())
    const link = join(fake.home, 'state-link')
    try {
      await symlink(repo, link, 'junction')
      cases.push(join(link, 'state'))
    } catch {
      t.diagnostic('this computer does not let a test make a folder link - the link case is NOT CHECKED here')
    }
    for (const stateDir of cases) {
      const deps = depsFor(fake)
      const stdout = []
      const stderr = []
      const exit = await runCollector({
        argv: ['--computer', 'Test PC', '--commit', '--state-dir', stateDir],
        deps,
        repoRoot: repo,
        out: (line) => stdout.push(line),
        err: (line) => stderr.push(line)
      })
      assert.equal(exit, 2, stateDir)
      assert.match(stderr.join('\n'), /state folder is inside this working copy/)
      assert.match(stderr.join('\n'), /allows|allowed-vaults\.yml/)
      assert.equal(deps.fetch.calls.length, 0, 'something was read before the refusal')
    }
    assert.deepEqual(await filesUnder(repo), [], 'a lock, claim or copy was made in the working copy')
  } finally {
    await fake.cleanup()
    await rm(repo, { recursive: true, force: true })
  }
})

test('without --clone, the default state folder inside the working copy is refused too - in a plain run, a dry run and a commit run', async () => {
  const fake = await makeFakeHome()
  try {
    // The working copy is the home folder itself, so ~/.local/state/agent-status-collector is inside it.
    for (const args of [['--only', 'vaults'], ['--only', 'vaults', '--dry-run'], ['--commit', '--only', 'vaults']]) {
      const result = await run(fake, args, { target: fake.home })
      assert.equal(result.code, 2, args.join(' '))
      assert.match(result.stderr, /state folder is inside this working copy/)
    }
    assert.equal(existsSync(join(fake.home, '.agent-team')), false, 'a snapshot was written into the working copy')
  } finally {
    await fake.cleanup()
  }
})

test('a --state-dir beside the working copy, sharing the start of its name, is not inside it', async () => {
  const fake = await makeFakeHome()
  const root = await mkdtemp(join(tmpdir(), 'agent-status-pair-'))
  try {
    const repo = join(root, 'repo')
    await mkdir(repo)
    const result = await runCollector({
      argv: ['--computer', 'Test PC', '--commit', '--only', 'vaults', '--state-dir', join(root, 'repo-state')],
      deps: depsFor(fake, { git: async () => { throw new Error('not a repo') } }),
      repoRoot: repo,
      out: () => {},
      err: () => {}
    })
    assert.notEqual(result, 2, 'a folder beside the working copy was taken for one inside it')
    assert.ok(existsSync(join(root, 'repo-state', 'claims')), 'the run never got past the state-folder check')
  } finally {
    await fake.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('with --clone the working-copy rule does not apply: the code checkout is pinned, and the data clone is the one that is checked', async () => {
  const fake = await makeFakeHome()
  const root = await mkdtemp(join(tmpdir(), 'agent-status-pair-'))
  try {
    const code = join(root, 'code')
    const clone = join(root, 'data')
    await mkdir(code)
    await mkdir(clone)
    const result = await runCollector({
      argv: ['--computer', 'Test PC', '--commit', '--only', 'vaults', '--clone', clone, '--state-dir', join(code, 'state')],
      deps: depsFor(fake, { git: async () => { throw new Error('not a repo') } }),
      repoRoot: code,
      out: () => {},
      err: () => {}
    })
    // Refused later, because the clone is not a git clone - not for where the state folder is.
    assert.equal(result, 2)
    assert.ok(existsSync(join(code, 'state', 'claims')), 'the state folder inside the pinned code checkout was refused')
  } finally {
    await fake.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})
