import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm, readdir, mkdir, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { installTap, earlierFrom } from '../scripts/lib/status/install-tap.mjs'
import { tapCopyRoot, collectTapFiles } from '../scripts/lib/status/tap-copy.mjs'
import { repoRoot } from './helpers/repo.mjs'

/* SECURITY: the status line runs after every Claude reply, with no permission prompt. If it ran
   the tap straight out of the team repo's working copy, anyone who can push to the team repo would
   choose code that runs on the student's laptop after their next pull - the same reason the Mac
   collector runs from a checkout pinned by hand. So the installer COPIES the tap, and every file it
   imports, into a per-user folder named after the content's hash, checks the copy, and points the
   status line at the copy. Running the installer again is the deliberate update.

   Every test here works in temporary folders: a fake team repo, a fake home. */

const STAMP = Date.parse('2026-10-08T12:00:00Z')

async function fakeRepoAndHome() {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-copy-'))
  const repo = join(root, 'team-repo')
  await cp(join(repoRoot, 'scripts'), join(repo, 'scripts'), { recursive: true })
  const home = join(root, 'home')
  await mkdir(join(home, '.claude'), { recursive: true })
  return { root, repo, home, settings: join(home, '.claude', 'settings.json'), cleanup: () => rm(root, { recursive: true, force: true }) }
}

const deps = (fake, extra = {}) => ({
  home: fake.home,
  env: {},
  platform: 'darwin',
  nodePath: process.execPath,
  sourceTap: join(fake.repo, 'scripts', 'usage-tap.mjs'),
  now: STAMP,
  exists: () => false,
  ...extra
})

const tapPathIn = async (fake) => {
  const command = JSON.parse(await readFile(fake.settings, 'utf8')).statusLine.command
  return /'([^']*usage-tap\.mjs)'/.exec(command)[1]
}

function runNode(script, input, env) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [script], { env, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
    child.stdin.end(input)
  })
}

const reading = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 18, resets_at: Math.floor(Date.now() / 1000) + 3600 } } })

test('the copy goes to a per-user folder, outside every repo', () => {
  const home = join(sep, 'Users', 'someone')
  assert.equal(tapCopyRoot({ home, env: {}, platform: 'darwin' }), join(home, '.local', 'share', 'agent-status', 'tap'))
  assert.equal(tapCopyRoot({ home, env: { LOCALAPPDATA: join(sep, 'L') }, platform: 'win32' }), join(sep, 'L', 'agent-status', 'tap'))
})

test('the tap and exactly the files it imports are collected, with their paths inside scripts/', async () => {
  const files = await collectTapFiles(join(repoRoot, 'scripts', 'usage-tap.mjs'))
  assert.deepEqual(files.map((file) => file.rel), ['lib/status/safe.mjs', 'lib/status/schema.mjs', 'lib/status/tap.mjs', 'lib/status/util.mjs', 'usage-tap.mjs'])
})

test('an import that reaches outside scripts/, or a package, is refused', async () => {
  const fake = await fakeRepoAndHome()
  try {
    const tapModule = join(fake.repo, 'scripts', 'lib', 'status', 'tap.mjs')
    const original = await readFile(tapModule, 'utf8')
    await writeFile(tapModule, `import '../../../outside.mjs'\n${original}`)
    await writeFile(join(fake.repo, 'outside.mjs'), 'export {}\n')
    await assert.rejects(collectTapFiles(join(fake.repo, 'scripts', 'usage-tap.mjs')), /outside/)
    await writeFile(tapModule, `import 'left-pad'\n${original}`)
    await assert.rejects(collectTapFiles(join(fake.repo, 'scripts', 'usage-tap.mjs')), /package/)
  } finally {
    await fake.cleanup()
  }
})

test('the status line points at a hash-named copy, never at the team repo', async () => {
  const fake = await fakeRepoAndHome()
  try {
    const result = await installTap(deps(fake))
    assert.equal(result.action, 'install')
    const tapPath = await tapPathIn(fake)
    const root = tapCopyRoot({ home: fake.home, env: {}, platform: 'darwin' }).replaceAll('\\', '/')
    assert.ok(tapPath.startsWith(`${root}/`), `the status line runs ${tapPath}`)
    assert.ok(!tapPath.includes('team-repo'), 'the status line still runs the working copy')
    assert.match(tapPath, /\/tap\/[0-9a-f]{16}\/usage-tap\.mjs$/)
    const copyDir = tapPath.slice(0, -'/usage-tap.mjs'.length)
    assert.deepEqual((await readdir(join(copyDir, 'lib', 'status'))).sort(), ['safe.mjs', 'schema.mjs', 'tap.mjs', 'util.mjs'])
  } finally {
    await fake.cleanup()
  }
})

test('after install, altering or deleting the team repo changes nothing the status line runs', async () => {
  const fake = await fakeRepoAndHome()
  try {
    await installTap(deps(fake))
    const tapPath = await tapPathIn(fake)
    const env = { HOME: fake.home, USERPROFILE: fake.home, LOCALAPPDATA: join(fake.home, 'AppData', 'Local'), PATH: process.env.PATH ?? '' }
    // Someone pushes a change and the student pulls it: the copy does not see it.
    const tapModule = join(fake.repo, 'scripts', 'lib', 'status', 'tap.mjs')
    await writeFile(tapModule, (await readFile(tapModule, 'utf8')).replace("join(' · ')", "join(' · ') + ' HACKED'"))
    const altered = await runNode(tapPath, reading, env)
    assert.equal(altered.stdout, '5h 18%\n', altered.stderr)
    // And with the repo gone altogether, the copy still runs.
    await rm(fake.repo, { recursive: true, force: true })
    const deleted = await runNode(tapPath, reading, env)
    assert.equal(deleted.stdout, '5h 18%\n', deleted.stderr)
  } finally {
    await fake.cleanup()
  }
})

test('re-running is the deliberate update: same code reuses the copy, new code makes a new one and drops the old', async () => {
  const fake = await fakeRepoAndHome()
  try {
    await writeFile(fake.settings, JSON.stringify({ statusLine: { type: 'command', command: 'my-old-line' } }))
    await installTap(deps(fake))
    const first = await tapPathIn(fake)
    const again = await installTap(deps(fake, { now: STAMP + 60_000 }))
    assert.equal(again.action, 'unchanged')
    assert.equal(await tapPathIn(fake), first)
    const tapModule = join(fake.repo, 'scripts', 'lib', 'status', 'tap.mjs')
    await writeFile(tapModule, `${await readFile(tapModule, 'utf8')}\n// a reviewed change\n`)
    const updated = await installTap(deps(fake, { now: STAMP + 120_000 }))
    assert.equal(updated.action, 'update')
    const second = await tapPathIn(fake)
    assert.notEqual(second, first)
    assert.equal(existsSync(first), false, 'the old copy was left behind')
    assert.equal(existsSync(second), true)
    const settings = JSON.parse(await readFile(fake.settings, 'utf8'))
    assert.equal(earlierFrom(settings.statusLine.command), 'my-old-line', 'the update lost the earlier status line')
  } finally {
    await fake.cleanup()
  }
})

test('a copy that was changed after install is detected and replaced on the next run', async () => {
  const fake = await fakeRepoAndHome()
  try {
    await installTap(deps(fake))
    const tapPath = await tapPathIn(fake)
    const copied = join(tapPath.slice(0, -'/usage-tap.mjs'.length), 'lib', 'status', 'tap.mjs')
    await writeFile(copied, 'tampered\n')
    const repaired = await installTap(deps(fake, { now: STAMP + 60_000 }))
    assert.equal(repaired.repairedCopy, true)
    assert.equal(await readFile(copied, 'utf8'), await readFile(join(fake.repo, 'scripts', 'lib', 'status', 'tap.mjs'), 'utf8'))
  } finally {
    await fake.cleanup()
  }
})

test('--remove deletes the copy it made, and the empty copies folder', async () => {
  const fake = await fakeRepoAndHome()
  try {
    await installTap(deps(fake))
    const tapPath = await tapPathIn(fake)
    await installTap(deps(fake, { remove: true, now: STAMP + 60_000 }))
    assert.equal(existsSync(tapPath), false)
    assert.equal(existsSync(tapCopyRoot({ home: fake.home, env: {}, platform: 'darwin' })), false)
  } finally {
    await fake.cleanup()
  }
})

test('--dry-run copies nothing', async () => {
  const fake = await fakeRepoAndHome()
  try {
    const result = await installTap(deps(fake, { dryRun: true }))
    assert.equal(result.action, 'install')
    assert.equal(existsSync(tapCopyRoot({ home: fake.home, env: {}, platform: 'darwin' })), false)
  } finally {
    await fake.cleanup()
  }
})
