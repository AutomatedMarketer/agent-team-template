import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm, readdir, mkdir, cp, utimes } from 'node:fs/promises'
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
  assert.deepEqual(files.map((file) => file.rel), ['lib/status/connections-schema.mjs', 'lib/status/safe.mjs', 'lib/status/schema.mjs', 'lib/status/tap.mjs', 'lib/status/util.mjs', 'usage-tap.mjs'])
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

// Found in re-review: the import scan was a regular expression over `from '...'`, so a static import
// written across a comment, or any dynamic way of loading code, slipped past it - and the copy would
// then load that file from the team repo after all. Static imports are now listed by V8 itself, and
// every dynamic form is refused outright, wherever it appears (comments too: they are cheap to
// reword, and a scanner that tries to tell a comment from code is the thing that was fooled).
const HIDDEN_LOADS = {
  'a static import with a comment before the path': "import { x } from /* note */ '../../../outside.mjs'\n",
  'a static import across lines': "import {\n  x\n} from\n  '../../../outside.mjs'\n",
  'an import() with a template literal': 'const dir = "../../.."\nawait import(`${dir}/outside.mjs`)\n',
  'an import() of a new URL': "await import(new URL('../../../outside.mjs', import.meta.url))\n",
  'an import() of a plain string': "await import('./util.mjs')\n",
  'createRequire': "import { createRequire } from 'node:module'\nconst load = createRequire(import.meta.url)\nload('../../../outside.cjs')\n",
  'require()': "const x = require('../../../outside.cjs')\n",
  'import.meta.resolve': "const where = import.meta.resolve('../../../outside.mjs')\n",
  'a commented-out import()': "// await import('../../../outside.mjs')\n"
}

for (const [name, line] of Object.entries(HIDDEN_LOADS)) {
  test(`the copy refuses code that could load from outside it: ${name}`, async () => {
    const fake = await fakeRepoAndHome()
    try {
      const tapModule = join(fake.repo, 'scripts', 'lib', 'status', 'tap.mjs')
      await writeFile(tapModule, `${line}${await readFile(tapModule, 'utf8')}`)
      await writeFile(join(fake.repo, 'outside.mjs'), 'export const x = 1\n')
      await assert.rejects(collectTapFiles(join(fake.repo, 'scripts', 'usage-tap.mjs')))
      const result = await installTap(deps(fake))
      assert.equal(result.action, 'refuse')
      assert.equal(existsSync(fake.settings), false, 'settings.json was written anyway')
    } finally {
      await fake.cleanup()
    }
  })
}

test('the tap as shipped passes the stricter scan', async () => {
  const files = await collectTapFiles(join(repoRoot, 'scripts', 'usage-tap.mjs'))
  assert.equal(files.length, 6)
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
    // <content hash>-<settings-file hash>: the second part is what makes the copy this profile's own.
    assert.match(tapPath, /\/tap\/[0-9a-f]{16}-[0-9a-f]{8}\/usage-tap\.mjs$/)
    const copyDir = tapPath.slice(0, -'/usage-tap.mjs'.length)
    assert.deepEqual((await readdir(join(copyDir, 'lib', 'status'))).sort(), ['connections-schema.mjs', 'safe.mjs', 'schema.mjs', 'tap.mjs', 'util.mjs'])
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

// Found in re-review: two Claude Code profiles (CLAUDE_CONFIG_DIR) installing the same tap shared
// one content-named copy, so --remove or an update in one deleted the copy the other still ran.
// Each settings file now owns its copy.
test('two CLAUDE_CONFIG_DIR profiles each get their own copy, and removing one leaves the other running', async () => {
  const fake = await fakeRepoAndHome()
  try {
    const profileA = { CLAUDE_CONFIG_DIR: join(fake.home, 'profile-a') }
    const profileB = { CLAUDE_CONFIG_DIR: join(fake.home, 'profile-b') }
    await installTap(deps(fake, { env: profileA }))
    await installTap(deps(fake, { env: profileB }))
    const tapIn = async (profile) => /'([^']*usage-tap\.mjs)'/.exec(JSON.parse(await readFile(join(profile.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8')).statusLine.command)[1]
    const a = await tapIn(profileA)
    const b = await tapIn(profileB)
    assert.notEqual(a, b, 'the two profiles share one copy')
    await installTap(deps(fake, { env: profileA, remove: true, now: STAMP + 60_000 }))
    assert.equal(existsSync(a), false)
    assert.equal(existsSync(b), true, "removing profile A deleted the copy profile B runs")
    const env = { HOME: fake.home, USERPROFILE: fake.home, LOCALAPPDATA: join(fake.home, 'AppData', 'Local'), PATH: process.env.PATH ?? '' }
    assert.equal((await runNode(b, reading, env)).stdout, '5h 18%\n')
  } finally {
    await fake.cleanup()
  }
})

test('a half-built copy left by a crash over an hour ago is cleared; a recent one is left alone', async () => {
  const fake = await fakeRepoAndHome()
  try {
    const root = tapCopyRoot({ home: fake.home, env: {}, platform: 'darwin' })
    const stale = join(root, '0123456789abcdef-01234567.building-4242')
    const recent = join(root, '0123456789abcdef-01234567.building-4343')
    await mkdir(stale, { recursive: true })
    await mkdir(recent, { recursive: true })
    const twoHoursAgo = (Date.now() - 2 * 3600_000) / 1000
    await utimes(stale, twoHoursAgo, twoHoursAgo)
    await installTap(deps(fake))
    assert.equal(existsSync(stale), false, 'a stale half-built copy was left behind')
    assert.equal(existsSync(recent), true, 'a copy another install may still be building was deleted')
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
