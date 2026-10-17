import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn as realSpawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join, win32 } from 'node:path'
import { mailboxWorld } from './helpers/mailbox-world.mjs'
import { repoRoot } from './helpers/repo.mjs'
import { main } from '../scripts/lib/mailbox/command.mjs'
import { runTick } from '../scripts/lib/mailbox/tick.mjs'
import { checkPlaces, defaultPlaces } from '../scripts/lib/mailbox/places.mjs'
import { claudeEnv, claudeFolders, killTree, runClaude, WINDOWS_SWITCHES } from '../scripts/lib/mailbox/claude.mjs'
import { accessBlocks, accessEntries, privatePlaces, windowsGit } from '../scripts/lib/mailbox/windows.mjs'
import { createRunner, findEveryProgram, findProgram } from '../scripts/lib/status/programs.mjs'

/* The runner on a Windows computer. A Mac gives it three things for free that Windows does not, and each is replaced here:
     file modes (0600/0700)       -> the state folder is given to the current account alone with icacls, read back, and a tick does not start without it
     "a program is its path"      -> git (and everything else) is started by its absolute path, never by a bare name from a folder somebody else writes to
     process groups               -> taskkill /T /F, by absolute path
   Most of this is proved with fakes so that it runs on any computer; the tests marked "this computer" run the real thing and are skipped elsewhere. */

const onWindows = process.platform === 'win32'
const execFileP = promisify(execFile)
const SYSTEM_ROOT = 'C:\\Windows'
const ICACLS = win32.join(SYSTEM_ROOT, 'System32', 'icacls.exe')

/* ---------- where things are -------------------------------------------------------------------------------------- */

test('on Windows the four places default to the board\'s own folders: state and work under LOCALAPPDATA, the runner\'s code under the profile', () => {
  const home = 'C:\\Users\\student'
  const env = { LOCALAPPDATA: 'D:\\Data\\Local' }
  assert.deepEqual(defaultPlaces(home, { platform: 'win32', env }), {
    stateDir: 'D:\\Data\\Local\\Agent Board\\state',
    codeDir: 'C:\\Users\\student\\Agent Board\\runner-code',
    workDir: 'D:\\Data\\Local\\Agent Board\\work',
    envFile: 'D:\\Data\\Local\\Agent Board\\state\\runner.env'
  })
  // No LOCALAPPDATA, or one that is not a full path: the usual place under the profile.
  for (const bad of [{}, { LOCALAPPDATA: 'AppData\\Local' }, { LOCALAPPDATA: 7 }]) {
    assert.equal(defaultPlaces(home, { platform: 'win32', env: bad }).stateDir, 'C:\\Users\\student\\AppData\\Local\\Agent Board\\state')
  }
})

test('a Mac, and every call made before Windows existed, get exactly the places they always had', () => {
  const home = join(tmpdir(), 'home-of-someone')
  const old = defaultPlaces(home)
  assert.deepEqual(old, {
    stateDir: join(home, '.local', 'state', 'agent-mailbox'),
    codeDir: join(home, '.local', 'share', 'agent-mailbox', 'runner-code'),
    workDir: join(home, '.local', 'share', 'agent-mailbox', 'work'),
    envFile: join(home, '.config', 'agent-mailbox', 'env')
  })
  assert.deepEqual(defaultPlaces(home, { platform: 'darwin', env: { LOCALAPPDATA: 'C:\\x' } }), old)
  assert.deepEqual(defaultPlaces(home, { platform: 'linux' }), old)
})

test('the Windows places do not overlap, and the secrets file is inside the state folder (this computer)', async (t) => {
  if (!onWindows) return t.skip('these are Windows paths')
  const dir = await mkdtemp(join(tmpdir(), 'mailbox-win-places-'))
  try {
    const places = defaultPlaces(dir, { platform: 'win32', env: { LOCALAPPDATA: join(dir, 'Local') } })
    assert.deepEqual(await checkPlaces(places), { ok: true })
    assert.ok(places.envFile.startsWith(`${places.stateDir}\\`))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the runner main() takes its four places from a `places` override (the student board\'s own folders) and still refuses an overlap', async () => {
  const w = await mailboxWorld()
  try {
    const asked = []
    const lines = []
    const own = { stateDir: join(w.root, 'board', 'state'), workDir: join(w.root, 'board', 'work'), codeDir: join(w.root, 'board', 'code'), envFile: join(w.root, 'board', 'state', 'runner.env') }
    const lock = async (places) => (asked.push(places), { ok: true })
    const code = await main({ argv: ['--preflight'], ...w.ctx({ platform: 'win32', privatePlaces: lock }), places: own, out: (text) => lines.push(text), err: (text) => lines.push(text) })
    assert.equal(code, 1, 'nothing is set up in those folders yet')
    assert.deepEqual(asked, [own], 'the folders asked about are the ones handed in, not the usual ones')
    assert.match(lines.join('\n'), /ok +folders: none overlaps another/)
    assert.match(lines.join('\n'), /ok +private folder/)

    lines.length = 0
    const overlapping = { ...own, stateDir: join(own.workDir, 'state'), envFile: join(own.workDir, 'state', 'runner.env') }
    await main({ argv: ['--preflight'], ...w.ctx({ platform: 'win32', privatePlaces: lock }), places: overlapping, out: (text) => lines.push(text), err: (text) => lines.push(text) })
    assert.match(lines.join('\n'), /PROBLEM +folders: the state folder is inside the work copy/)
  } finally {
    await w.cleanup()
  }
})

/* ---------- finding Claude --------------------------------------------------------------------------------------- */

test('on Windows Claude is looked for in one folder, %USERPROFILE%\\.local\\bin, where the native installer puts claude.exe - not in the two Mac folders', () => {
  assert.deepEqual(claudeFolders('C:\\Users\\student', 'win32'), ['C:\\Users\\student\\.local\\bin'])
  assert.deepEqual(claudeFolders('', 'win32'), [])
  assert.deepEqual(claudeFolders(undefined, 'win32'), [])
  // A Mac is as it was.
  assert.deepEqual(claudeFolders('/Users/owner', 'darwin'), [join('/Users/owner', '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'])
  assert.deepEqual(claudeFolders('/Users/owner'), claudeFolders('/Users/owner', process.platform))
})

test('only a real claude.exe is started: a claude.cmd (an npm install) is refused, never run through a shell', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mailbox-win-claude-'))
  try {
    const bin = join(dir, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'claude.cmd'), '@echo off\r\n')
    const deps = { env: {}, home: dir, platform: 'win32', folders: [bin] }
    assert.deepEqual(await findProgram('claude', deps), { state: 'refused' })
    await writeFile(join(bin, 'claude.exe'), 'x')
    assert.deepEqual(await findProgram('claude', deps), { state: 'found', path: join(bin, 'claude.exe') })
    assert.deepEqual((await findEveryProgram('claude', deps)).paths, [join(bin, 'claude.exe')])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a claude.exe inside the work copy is refused even if the work copy is on the list: it is the folder other people push to', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mailbox-win-claude-'))
  try {
    const work = join(dir, 'work')
    await mkdir(join(work, 'bin'), { recursive: true })
    await writeFile(join(work, 'bin', 'claude.exe'), 'planted')
    assert.deepEqual(await findProgram('claude', { env: {}, home: dir, platform: 'win32', folders: [join(work, 'bin')], clone: work }), { state: 'refused' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('--preflight on Windows says in plain words when Claude is only an npm claude.cmd (found in the npm folder, never run), and what to do', async () => {
  const w = await mailboxWorld()
  const appData = await mkdtemp(join(tmpdir(), 'mailbox-win-appdata-'))
  try {
    const lines = []
    const say = async (change) => {
      lines.length = 0
      await main({ argv: ['--preflight'], ...w.ctx(change), out: (text) => lines.push(text), err: (text) => lines.push(text) })
      return lines.join('\n')
    }
    // The fixed list has no claude.exe in it, as on a computer that only ever had the npm install.
    const find = async () => ({ state: 'not found' })
    const env = { HOME: w.root, PATH: '/usr/bin', APPDATA: appData }
    const lock = async () => ({ ok: true })
    assert.match(await say({ platform: 'win32', find, env, privatePlaces: lock }), /PROBLEM +Claude: Claude Code was not found\./, 'no npm claude.cmd there: the plain message')
    await mkdir(join(appData, 'npm'))
    await writeFile(join(appData, 'npm', 'claude.cmd'), '@echo off\r\n')
    const text = await say({ platform: 'win32', find, env, privatePlaces: lock })
    assert.match(text, /PROBLEM +Claude: Claude Code was found only as a \.cmd file/)
    assert.match(text, /real claude\.exe/)
    // A refused answer (inside the work copy) gets the same words.
    assert.match(await say({ platform: 'win32', find: async () => ({ state: 'refused' }), env: { HOME: w.root, PATH: '/usr/bin' }, privatePlaces: lock }), /found only as a \.cmd file/)
    // A Mac says what it always said, whatever is in an npm folder.
    assert.match(await say({ platform: 'darwin', find, env }), /PROBLEM +Claude: Claude Code was not found\./)
  } finally {
    await rm(appData, { recursive: true, force: true })
    await w.cleanup()
  }
})

test('Claude\'s environment on Windows says that a bare program name is not looked for in the current folder; a Mac\'s environment has no such name', () => {
  assert.deepEqual({ ...WINDOWS_SWITCHES }, { NoDefaultCurrentDirectoryInExePath: '1' })
  const env = { USERPROFILE: 'C:\\Users\\s', Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', NoDefaultCurrentDirectoryInExePath: '0' }
  assert.equal(claudeEnv(env, 'win32').NoDefaultCurrentDirectoryInExePath, '1', 'and nothing the runner was started with can turn it off')
  for (const platform of ['darwin', 'linux']) assert.ok(!('NoDefaultCurrentDirectoryInExePath' in claudeEnv(env, platform)))
})

/* ---------- a run on Windows, with the fake Claude ---------------------------------------------------------------- */

test('a run order on platform win32 starts the fake Claude by its absolute path, in the work copy, with no shell, no process group, and the small Windows environment', async () => {
  const w = await mailboxWorld()
  try {
    w.claude.script = w.claude.good
    w.send({ action: 'run', workflow: 'morning-intel' })
    const result = await runTick(w.ctx({ platform: 'win32', env: { HOME: w.root, PATH: '/usr/bin', USERPROFILE: w.root, SystemRoot: SYSTEM_ROOT, GITHUB_TOKEN: 'g' } }))
    assert.equal(result.state, 'done')
    assert.equal(w.claude.calls.length, 1)
    const { options, file } = w.claude.calls[0]
    assert.equal(file, '/fake/bin/claude')
    assert.equal(options.cwd, w.places.workDir)
    assert.equal(options.shell, false)
    assert.equal(options.detached, false, 'no process group on Windows: the tree is ended by taskkill')
    assert.equal(options.windowsHide, true)
    assert.equal(options.env.NoDefaultCurrentDirectoryInExePath, '1')
    assert.equal(options.env.SystemRoot, SYSTEM_ROOT)
    assert.ok(!('GITHUB_TOKEN' in options.env), 'no secret of this computer')
    assert.ok(await w.inOrigin.file('inbox/2026-10-12/morning-intel.md'), 'the output landed in the team repo')
  } finally {
    await w.cleanup()
  }
})

/* ---------- stopping a program and what it started ---------------------------------------------------------------- */

test('a time-out on Windows ends the tree with taskkill (asked politely, then for good), not with a signal to a process group', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mailbox-win-timeout-'))
  try {
    const calls = []
    const spawn = (file, args, options) => {
      calls.push({ file, args, options })
      const child = new EventEmitter()
      child.pid = calls.length === 1 ? 4242 : undefined
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      return child
    }
    const result = await runClaude({
      file: 'C:\\Users\\student\\.local\\bin\\claude.exe', argv: ['-p', 'x'], cwd: dir, env: {}, timeoutMs: 30, killAfterMs: 30, closeWaitMs: 30,
      transcriptPath: join(dir, 'transcript.jsonl'), stderrPath: join(dir, 'stderr.txt'), spawn, platform: 'win32'
    })
    assert.equal(result.ok, false)
    assert.equal(result.why, 'timed-out')
    assert.equal(calls[0].options.detached, false)
    const taskkills = calls.slice(1)
    assert.equal(taskkills.length, 2, 'once when the time is up and once for good')
    for (const call of taskkills) {
      assert.match(call.file, /system32.taskkill.exe$/i)
      assert.deepEqual(call.args, ['/PID', '4242', '/T', '/F'])
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a real program and the program IT started are both ended by killTree on Windows (this computer)', async (t) => {
  if (!onWindows) return t.skip('this is the Windows way of ending a tree')
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const parent = realSpawn(process.execPath, ['-e', "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  let childPid = 0
  try {
    childPid = await new Promise((resolve, reject) => {
      parent.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())))
      parent.once('error', reject)
      setTimeout(() => reject(new Error('the parent did not say its child\'s number')), 10_000).unref()
    })
    assert.ok(Number.isInteger(childPid) && childPid > 0)
    assert.ok(alive(parent.pid) && alive(childPid), 'both are running before')
    killTree(parent.pid, 'SIGKILL', { platform: 'win32', spawn: realSpawn })
    const deadline = Date.now() + 10_000
    while ((alive(parent.pid) || alive(childPid)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(alive(parent.pid), false, 'the program is gone')
    assert.equal(alive(childPid), false, 'and so is the one it started')
  } finally {
    for (const pid of [parent.pid, childPid]) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  }
})

/* ---------- the private folder ------------------------------------------------------------------------------------ */

const ME = 'PC\\student'
const ENTRY = (who = ME) => `${who}:(OI)(CI)(F)`
const ONE_ENTRY = (who = ME, path = 'C:\\x\\state') => `${path} ${ENTRY(who)}\n\nSuccessfully processed 1 files; Failed processing 0 files\n`
const BLOCK = (path, ...entries) => `${path} ${entries[0]}\n${entries.slice(1).map((entry) => `    ${entry}`).join('\n')}${entries.length > 1 ? '\n' : ''}\n`
const SUMMARY = 'Successfully processed 2 files; Failed processing 0 files\n'

// A fake icacls that remembers whether the folder has been locked yet: `before` is what it prints until the grant, `after` what it prints from then on.
// Each is { folder, files } where files is the text printed for `state\*`.
function fakeIcacls({ before = { folder: ONE_ENTRY(), files: '' }, after = before, failOn = null } = {}) {
  const calls = []
  let locked = false
  const exec = async (file, args, options) => {
    calls.push({ file, args, options })
    if (failOn !== null && failOn(args)) throw new Error('boom')
    if (args.includes('/inheritance:r')) locked = true
    if (args.length > 1) return { stdout: '', code: 0 }
    const now = locked ? after : before
    return { stdout: args[0].endsWith('*') ? now.files : now.folder, code: 0 }
  }
  return { exec, calls }
}

const placesIn = (dir) => ({ stateDir: join(dir, 'state'), envFile: join(dir, 'state', 'runner.env'), workDir: join(dir, 'work'), codeDir: join(dir, 'code') })

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'mailbox-win-private-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const lockWith = (fake, change = {}) => privatePlaces({ exec: fake.exec, env: { SystemRoot: SYSTEM_ROOT }, user: 'student', domain: 'PC', platform: 'win32', isInside: async () => true, ...change })
const BAD = { folder: `C:\\x\\state ${ENTRY()}\n    ${ENTRY('BUILTIN\\Users')}\n\n${SUMMARY}`, files: '' }

test('a folder that is already the current account\'s alone is only READ: nothing is reset, granted or changed', () => withDir(async (dir) => {
  const places = placesIn(dir)
  await mkdir(places.stateDir, { recursive: true })
  await writeFile(places.envFile, 'x')
  await writeFile(join(places.stateDir, 'allowed-orders.yml'), 'x')
  const state = places.stateDir
  const files = `${BLOCK(`${state}\\allowed-orders.yml`, ENTRY())}\n${BLOCK(`${state}\\runner.env`, ENTRY())}\n${SUMMARY}`
  const fake = fakeIcacls({ before: { folder: ONE_ENTRY(ME, state), files } })
  assert.deepEqual(await lockWith(fake)(places), { ok: true })
  assert.deepEqual(fake.calls.map((call) => [call.file, call.args]), [[ICACLS, [state]], [ICACLS, [`${state}\\*`]]])
  for (const call of fake.calls) {
    assert.equal(call.options.cwd, win32.join(SYSTEM_ROOT, 'System32'), 'started from System32, not from anywhere a repo is')
    assert.deepEqual(call.options.env, { SystemRoot: SYSTEM_ROOT, NoDefaultCurrentDirectoryInExePath: '1' })
    assert.equal(call.options.timeout, 15_000)
  }
}))

test('otherwise every access list in the folder is reset first, then the folder is given to DOMAIN\\user alone, then it is all read back', () => withDir(async (dir) => {
  const places = placesIn(dir)
  await mkdir(places.stateDir, { recursive: true })
  await writeFile(places.envFile, 'x')
  const state = places.stateDir
  const fake = fakeIcacls({ before: BAD, after: { folder: ONE_ENTRY(ME, state), files: `${BLOCK(`${state}\\runner.env`, ENTRY())}\n${SUMMARY}` } })
  assert.deepEqual(await lockWith(fake)(places), { ok: true })
  assert.deepEqual(fake.calls.map((call) => call.args), [
    [state], [`${state}\\*`],
    [state, '/reset', '/T', '/C'],
    [state, '/inheritance:r', '/grant:r', 'PC\\student:(OI)(CI)F'],
    [state], [`${state}\\*`]
  ])
  for (const call of fake.calls) assert.equal(call.file, ICACLS)
  // With no domain the name stands alone.
  const alone = fakeIcacls({ before: BAD, after: { folder: ONE_ENTRY('student', state), files: '' } })
  assert.deepEqual(await lockWith(alone, { domain: undefined })(places), { ok: true })
  assert.equal(alone.calls.find((call) => call.args.includes('/grant:r')).args[3], 'student:(OI)(CI)F')
}))

test('a file that keeps its own access list (inheritance off, readable by another account) is found and fixed, and if it stays that way nothing runs', () => withDir(async (dir) => {
  const places = placesIn(dir)
  await mkdir(places.stateDir, { recursive: true })
  await writeFile(join(places.stateDir, 'allowed-orders.yml'), 'x')
  const state = places.stateDir
  const sneaky = `${BLOCK(`${state}\\allowed-orders.yml`, ENTRY(ME), ENTRY('Everyone').replace('(OI)(CI)(F)', '(R)'))}\n${SUMMARY}`
  const good = { folder: ONE_ENTRY(ME, state), files: `${BLOCK(`${state}\\allowed-orders.yml`, ENTRY())}\n${SUMMARY}` }
  // The folder looks right but the file does not: that alone is a reason to reset.
  const fixed = fakeIcacls({ before: { folder: ONE_ENTRY(ME, state), files: sneaky }, after: good })
  assert.deepEqual(await lockWith(fixed)(places), { ok: true })
  assert.ok(fixed.calls.some((call) => call.args.includes('/reset')))
  // A reset that does not take: still two entries on the file.
  const stuck = fakeIcacls({ before: { folder: ONE_ENTRY(ME, state), files: sneaky } })
  assert.deepEqual(await lockWith(stuck)(places), { ok: false, why: 'others-have-access' })
}))

test('the folder lock fails closed: every way it can go wrong stops the runner with a word, and none says ok', () => withDir(async (dir) => {
  const places = placesIn(dir)
  const state = places.stateDir
  const mine = ONE_ENTRY(ME, state)
  const cases = [
    ['icacls cannot reset it', lockWith(fakeIcacls({ before: BAD, failOn: (args) => args.includes('/reset') })), 'lock-failed'],
    ['icacls cannot set it', lockWith(fakeIcacls({ before: BAD, failOn: (args) => args.includes('/grant:r') })), 'lock-failed'],
    ['another account still has access', lockWith(fakeIcacls({ before: BAD })), 'others-have-access'],
    ['nothing at all is listed', lockWith(fakeIcacls({ before: { folder: '', files: '' } })), 'others-have-access'],
    ['the one entry is not you', lockWith(fakeIcacls({ before: { folder: ONE_ENTRY('PC\\someone-else', state), files: '' } })), 'not-you'],
    ['the Windows folder is not known', privatePlaces({ exec: fakeIcacls().exec, env: {}, user: 'student', platform: 'win32', isInside: async () => true }), 'no-system-root'],
    ['the Windows folder is not a full path', privatePlaces({ exec: fakeIcacls().exec, env: { SystemRoot: 'Windows' }, user: 'student', platform: 'win32', isInside: async () => true }), 'no-system-root'],
    ['the account name is not known', lockWith(fakeIcacls(), { user: null }), 'no-user'],
    ['the account name is not a name', lockWith(fakeIcacls(), { user: 'a:(OI)(CI)F /grant:r Everyone' }), 'no-user'],
    ['the domain is not a name', lockWith(fakeIcacls(), { domain: 'PC\\..\\x' }), 'no-user'],
    ['the secrets file is outside the folder that is locked', lockWith(fakeIcacls(), { isInside: async () => false }), 'secrets-outside-state']
  ]
  void mine
  for (const [what, lock, why] of cases) assert.deepEqual(await lock(places), { ok: false, why }, what)
  const never = fakeIcacls()
  assert.deepEqual(await lockWith(never, { isInside: async () => false })(places), { ok: false, why: 'secrets-outside-state' })
  assert.equal(never.calls.length, 0)
}))

test('an icacls that cannot be read at all is treated as "not private yet" and the folder is locked; if the read-back fails too, nothing runs', () => withDir(async (dir) => {
  const places = placesIn(dir)
  const state = places.stateDir
  let reads = 0
  const exec = async (file, args) => {
    if (args.length === 1) {
      reads += 1
      throw new Error('boom')
    }
    return { stdout: '', code: 0 }
  }
  assert.deepEqual(await lockWith({ exec })(places), { ok: false, why: 'lock-failed' })
  assert.equal(reads, 2, 'once before and once after')
  void state
}))

test('an account name with spaces and round brackets ("John (Work)") is fine: it goes to icacls as one argument', () => withDir(async (dir) => {
  const places = placesIn(dir)
  const state = places.stateDir
  const who = 'PC\\John (Work)'
  const fake = fakeIcacls({ before: BAD, after: { folder: ONE_ENTRY(who, state), files: '' } })
  assert.deepEqual(await lockWith(fake, { user: 'John (Work)' })(places), { ok: true })
  assert.equal(fake.calls.find((call) => call.args.includes('/grant:r')).args[3], 'PC\\John (Work):(OI)(CI)F')
}))

test('"is that entry you" compares the whole name: bob is not rob, and a longer name that ends the same is not you', () => withDir(async (dir) => {
  const places = placesIn(dir)
  const state = places.stateDir
  for (const other of ['PC\\notstudent', 'PC\\student2', 'OTHERPC\\student', 'PC\\xstudent']) {
    const fake = fakeIcacls({ before: { folder: ONE_ENTRY(other, state), files: '' } })
    assert.deepEqual(await lockWith(fake)(places), { ok: false, why: 'not-you' }, other)
  }
  // Capitals do not matter to Windows.
  assert.deepEqual(await lockWith(fakeIcacls({ before: { folder: ONE_ENTRY('pc\\STUDENT', state), files: '' } }))(places), { ok: true })
}))

test('on a Mac or Linux the lock does nothing and asks nobody: file modes do it there', () => withDir(async (dir) => {
  for (const platform of ['darwin', 'linux']) {
    const fake = fakeIcacls()
    assert.deepEqual(await lockWith(fake, { platform })(placesIn(dir)), { ok: true })
    assert.equal(fake.calls.length, 0)
  }
}))

test('access entries are counted from what icacls prints: one per line with NAME:(flags); the path line, blank lines and the summary are not entries', () => {
  assert.equal(accessEntries(ONE_ENTRY()).length, 1)
  assert.equal(accessEntries(`C:\\a b\\state NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)\r\n    BUILTIN\\Administrators:(I)(OI)(CI)(F)\r\n    PC\\x:(I)(OI)(CI)(M)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`).length, 3)
  assert.equal(accessEntries('').length, 0)
  assert.equal(accessEntries(undefined).length, 0)
  assert.deepEqual(accessBlocks(`${BLOCK('C:\\a', ENTRY(), ENTRY('X\\y'))}\n${BLOCK('C:\\b', ENTRY())}\n${SUMMARY}`).map((entries) => entries.length), [2, 1])
})

test('the real icacls on this computer fixes a file that carries its own list (inheritance off, Everyone can read), and leaves one entry on everything (this computer)', async (t) => {
  if (!onWindows) return t.skip('icacls is Windows')
  await withDir(async (dir) => {
    const places = placesIn(dir)
    await mkdir(places.stateDir, { recursive: true })
    const icacls = win32.join(process.env.SystemRoot, 'System32', 'icacls.exe')
    const ask = async (...args) => (await execFileP(icacls, args, { encoding: 'utf8', windowsHide: true })).stdout
    await writeFile(join(places.stateDir, 'made-before-the-lock.txt'), 'before')
    // The reviewer's case: the file's own list, not inherited, with Everyone (S-1-1-0) allowed to read.
    const allowlist = join(places.stateDir, 'allowed-orders.yml')
    await writeFile(allowlist, 'x')
    await ask(allowlist, '/inheritance:d')
    await ask(allowlist, '/grant', '*S-1-1-0:R')
    assert.equal(accessEntries(await ask(allowlist)).length > 1, true, 'the setup: Everyone can read it')

    const exec = createRunner({ spawn: realSpawn, platform: 'win32', env: process.env })
    const lock = privatePlaces({ exec, env: process.env, user: userInfo().username, domain: process.env.USERDOMAIN })
    assert.deepEqual(await lock(places), { ok: true })
    for (const path of [places.stateDir, allowlist, join(places.stateDir, 'made-before-the-lock.txt')]) {
      const entries = accessEntries(await ask(path))
      assert.equal(entries.length, 1, `${path}: ${entries.join(' | ')}`)
    }
    // A second time only reads (the answer is the same, and the folder is not touched again).
    assert.deepEqual(await lock(places), { ok: true })
    await writeFile(places.envFile, 'MAILBOX_KEY=x\n')
    const after = accessEntries(await ask(places.envFile))
    assert.equal(after.length, 1, `a file made later is private too: ${after.join(' | ')}`)
    assert.equal(await readFile(places.envFile, 'utf8'), 'MAILBOX_KEY=x\n')
    assert.deepEqual(await lock(places), { ok: true })
  })
})

/* ---------- a tick on Windows does not start without the lock ------------------------------------------------------ */

test('a tick on Windows stops before it reads anything, and says why in a word, when there is no way to lock the folder or the lock fails', async () => {
  for (const [what, privatePlacesFn, word] of [
    ['no function given', undefined, 'private-unavailable'],
    ['the lock fails', async () => ({ ok: false, why: 'lock-failed' }), 'private-lock-failed'],
    ['others have access', async () => ({ ok: false, why: 'others-have-access' }), 'private-others-have-access']
  ]) {
    const w = await mailboxWorld()
    try {
      w.send({ action: 'task', title: 'Chase the invoice', details: 'Ask.', for: 'research', model: 'sonnet' })
      const result = await runTick(w.ctx({ platform: 'win32', privatePlaces: privatePlacesFn }))
      assert.equal(result.state, 'not-ready', what)
      assert.equal(result.why, word, what)
      assert.equal(w.board.polls, 0, `${what}: the board was never asked`)
      assert.equal(await w.claimFile('00000000000000000000000000000000', 'receipt.json'), null)
      assert.equal(await w.inOrigin.commits(), 1, `${what}: nothing was pushed`)
    } finally {
      await w.cleanup()
    }
  }
})

test('a tick on Windows with the lock in place goes on to do its work; on a Mac the lock is never asked for', async () => {
  const w = await mailboxWorld()
  try {
    const asked = []
    w.send({ action: 'task', title: 'Chase the invoice', details: 'Ask.', for: 'research', model: 'sonnet' })
    const result = await runTick(w.ctx({ platform: 'win32', privatePlaces: async (places) => (asked.push(places), { ok: true }) }))
    assert.equal(result.state, 'done')
    assert.deepEqual(asked, [w.places])
  } finally {
    await w.cleanup()
  }
  for (const platform of ['darwin', 'linux']) {
    const mac = await mailboxWorld()
    try {
      mac.send({ action: 'task', title: 'Chase the invoice', details: 'Ask.', for: 'research', model: 'sonnet' })
      const asked = []
      await runTick(mac.ctx({ platform, privatePlaces: async () => (asked.push(1), { ok: false, why: 'lock-failed' }) }))
      assert.deepEqual(asked, [], `${platform}: file modes do this, so the Windows lock is not asked`)
    } finally {
      await mac.cleanup()
    }
  }
})

test('--preflight on Windows has a line for the private folder, a problem when it fails, and none on a Mac', async () => {
  const w = await mailboxWorld()
  try {
    const say = async (change) => {
      const lines = []
      await main({ argv: ['--preflight'], ...w.ctx(change), out: (text) => lines.push(text), err: (text) => lines.push(text) })
      return lines.join('\n')
    }
    assert.match(await say({ platform: 'win32', privatePlaces: async () => ({ ok: true }) }), /ok +private folder: only your Windows account/)
    assert.match(await say({ platform: 'win32', privatePlaces: async () => ({ ok: false, why: 'others-have-access' }) }), /PROBLEM +private folder: after the lock another account still has access/)
    assert.match(await say({ platform: 'win32', privatePlaces: undefined }), /PROBLEM +private folder: this run has no way to lock the folder/)
    assert.doesNotMatch(await say({ platform: 'darwin' }), /private folder/)
  } finally {
    await w.cleanup()
  }
})

/* ---------- git: absolute, from a neutral folder, never a planted one ---------------------------------------------- */

const GIT = 'C:\\Program Files\\Git\\cmd\\git.exe'
const WORK = 'C:\\Users\\student\\AppData\\Local\\Agent Board\\work'

function gitWith({ paths = [GIT], avoid = ['C:\\runner'], isInside = async () => false, env = { SystemRoot: SYSTEM_ROOT, PATH: 'C:\\x', GIT_ASKPASS: 'keep' } } = {}) {
  const runs = []
  const finds = []
  const run = async (file, args, options) => (runs.push({ file, args, options }), { stdout: 'ok\n', stderr: '' })
  const findAll = async (name, extra) => (finds.push([name, extra]), { paths })
  return { git: windowsGit({ run, findAll, env, avoid, isInside }), runs, finds }
}

test('git is started by its absolute path from System32, told where to work with -C, never prompting, and never looking in the current folder first', async () => {
  const { git, runs, finds } = gitWith()
  assert.equal((await git(['status', '--porcelain'], WORK)).stdout, 'ok\n')
  assert.equal(runs.length, 1)
  assert.equal(runs[0].file, GIT)
  assert.deepEqual(runs[0].args, ['-C', WORK, 'status', '--porcelain'])
  assert.equal(runs[0].options.cwd, win32.join(SYSTEM_ROOT, 'System32'), 'the working folder of the process is not the team repo')
  assert.equal(runs[0].options.env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(runs[0].options.env.GCM_INTERACTIVE, 'never', 'Git Credential Manager opens no window either')
  assert.equal(runs[0].options.env.NoDefaultCurrentDirectoryInExePath, '1')
  assert.equal(runs[0].options.env.GIT_ASKPASS, 'keep', 'the rest of the environment is as it was')
  assert.equal(runs[0].options.encoding, 'utf8')
  assert.deepEqual(finds, [['git', { knownFolders: [] }]], 'only PATH is searched: not the profile\'s own bin folders')
  await git(['--version'])
  assert.deepEqual(runs[1].args, ['--version'], 'no folder given means no -C')
  assert.equal(finds.length, 1, 'the PATH is searched once')
})

test('a git program inside the runner\'s own code, or inside the folder git was asked to work in, is never run', async () => {
  const inside = (folder) => async (path, outer) => path.startsWith(folder) && outer === folder
  // The first git on PATH is in the runner's code: the next one is used.
  const picks = gitWith({ paths: ['C:\\runner\\bin\\git.exe', GIT], isInside: inside('C:\\runner') })
  await picks.git(['--version'])
  assert.equal(picks.runs[0].file, GIT)
  // Only a planted one: there is no git, and nothing is started.
  const planted = gitWith({ paths: ['C:\\runner\\bin\\git.exe'], isInside: inside('C:\\runner') })
  await assert.rejects(() => planted.git(['--version'], WORK), /no git program/)
  assert.equal(planted.runs.length, 0)
  // A git program that sits inside the work copy asked about.
  const inWork = gitWith({ paths: [`${WORK}\\git.exe`], isInside: inside(WORK) })
  await assert.rejects(() => inWork.git(['status'], WORK), /inside the folder/)
  assert.equal(inWork.runs.length, 0)
  const none = gitWith({ paths: [] })
  await assert.rejects(() => none.git(['--version']), /no git program/)
  const noRoot = gitWith({ env: {} })
  await assert.rejects(() => noRoot.git(['--version']), /SystemRoot/)
  assert.equal(noRoot.runs.length, 0)
})

test('a git program that is planted in the work copy does not run, while a bare `git` started there does (this computer)', async (t) => {
  if (!onWindows) return t.skip('this is how Windows looks for a program')
  const whoami = join(process.env.SystemRoot, 'System32', 'whoami.exe')
  const dir = await mkdtemp(join(tmpdir(), 'mailbox-win-planted-'))
  let saved
  try {
    const work = join(dir, 'work')
    await mkdir(work)
    // The planted program is a copy of whoami.exe called git.exe: if it runs, the answer is whoami's, not git's.
    await copyFile(whoami, join(work, 'git.exe'))
    // Windows decides whether to look in the current folder from the environment of the process that STARTS the program (this one), so the variable is taken
    // out of this process for the length of the test, as it is on an ordinary student computer, and put back after.
    saved = process.env.NoDefaultCurrentDirectoryInExePath
    delete process.env.NoDefaultCurrentDirectoryInExePath
    const env = { ...process.env }

    const control = await execFileP('git', ['--version'], { cwd: work, env, encoding: 'utf8', windowsHide: true }).then((answer) => answer.stdout, (error) => `planted: ${error.stdout ?? ''}${error.stderr ?? ''}`)
    assert.match(control, /^planted:/, 'the control: a bare name with the work copy as the working folder DOES run the planted program, so this test can tell')

    const git = windowsGit({
      run: execFileP,
      findAll: (name, extra) => findEveryProgram(name, { env, home: dir, platform: 'win32', ...extra }),
      env,
      avoid: [repoRoot]
    })
    assert.match((await git(['--version'], work)).stdout, /^git version /, 'ours ran the real git')
    assert.match((await git(['--version'])).stdout, /^git version /)
  } finally {
    if (saved !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = saved
    await rm(dir, { recursive: true, force: true })
  }
})

test('the real git, through windowsGit, works in a folder given with -C: a repo is made and read (this computer)', async (t) => {
  if (!onWindows) return t.skip('this is the Windows way of starting git')
  const dir = await mkdtemp(join(tmpdir(), 'mailbox-win-git-'))
  try {
    const git = windowsGit({ run: execFileP, findAll: (name, extra) => findEveryProgram(name, { env: process.env, home: dir, platform: 'win32', ...extra }), env: process.env, avoid: [repoRoot] })
    await git(['init', '-q', '-b', 'main', 'repo'], dir)
    assert.equal((await git(['rev-parse', '--is-inside-work-tree'], join(dir, 'repo'))).stdout.trim(), 'true')
    assert.equal((await git(['rev-parse', '--show-toplevel'], join(dir, 'repo'))).stdout.trim().toLowerCase().replaceAll('/', '\\'), join(dir, 'repo').toLowerCase())
    await assert.rejects(() => git(['rev-parse', 'HEAD'], join(dir, 'repo')), 'a failing git still fails')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ---------- the entry file ---------------------------------------------------------------------------------------- */

test('the entry file uses the Windows git and the folder lock only on Windows, and keeps the Mac\'s git as it was', async () => {
  const text = await readFile(join(repoRoot, 'scripts', 'mailbox-runner.mjs'), 'utf8')
  assert.ok(text.includes("const git = (args, cwd) => execFileP('git', args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })"), 'the Mac\'s git line is unchanged')
  assert.ok(text.includes('git: windows ? windowsGit('), 'Windows gets the absolute-path git')
  assert.ok(text.includes('...(windows ? { privatePlaces: privatePlaces('), 'Windows gets the folder lock, others get no such key')
  assert.ok(text.includes('avoid: [RUNNER_ROOT]'), 'a git inside the runner\'s own code is never used')
  assert.ok(text.includes('const windows = process.platform === \'win32\''))
})

test('with no `places` handed in, main() on Windows uses the Windows defaults, with the runner\'s own folder as the code', async () => {
  const w = await mailboxWorld()
  try {
    const asked = []
    const lines = []
    const home = 'C:\\Users\\student'
    const env = { LOCALAPPDATA: 'C:\\Users\\student\\AppData\\Local', SystemRoot: SYSTEM_ROOT }
    await main({ argv: ['--preflight'], ...w.ctx({ platform: 'win32', home, env, privatePlaces: async (places) => (asked.push(places), { ok: false, why: 'lock-failed' }) }), places: undefined, codeDir: 'C:\runner', out: (text) => lines.push(text), err: (text) => lines.push(text) })
    assert.deepEqual(asked, [{ ...defaultPlaces(home, { platform: 'win32', env }), codeDir: 'C:\runner' }])
    assert.equal(asked[0].stateDir, 'C:\\Users\\student\\AppData\\Local\\Agent Board\\state')
  } finally {
    await w.cleanup()
  }
})

test('once the program has exited, a time-out on Windows does not send a second taskkill: its process number may belong to another program by then', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mailbox-win-recycled-'))
  try {
    const calls = []
    let claude = null
    const spawn = (file, args, options) => {
      calls.push({ file, args, options })
      const child = new EventEmitter()
      child.pid = calls.length === 1 ? 4242 : undefined
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      if (calls.length === 1) claude = child
      // The first taskkill (the polite one) ends the program: it exits, but its pipes stay open, so no 'close' yet.
      if (calls.length === 2) setImmediate(() => claude.emit('exit', 1, null))
      return child
    }
    const result = await runClaude({
      file: 'C:\\Users\\student\\.local\\bin\\claude.exe', argv: ['-p', 'x'], cwd: dir, env: {}, timeoutMs: 20, killAfterMs: 80, closeWaitMs: 30,
      transcriptPath: join(dir, 'transcript.jsonl'), stderrPath: join(dir, 'stderr.txt'), spawn, platform: 'win32'
    })
    assert.equal(result.why, 'timed-out')
    assert.equal(calls.length, 2, 'the program, and one taskkill - no second one for a number that may be somebody else\'s')
    // A Mac still sends both: a group can have survivors after its leader has gone.
    const kills = []
    const macSpawn = () => {
      const child = new EventEmitter()
      child.pid = 4243
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      setImmediate(() => child.emit('exit', 1, null))
      return child
    }
    const mac = await runClaude({
      file: '/usr/local/bin/claude', argv: ['-p', 'x'], cwd: dir, env: {}, timeoutMs: 20, killAfterMs: 60, closeWaitMs: 30,
      transcriptPath: join(dir, 'transcript2.jsonl'), stderrPath: join(dir, 'stderr2.txt'), spawn: macSpawn, platform: 'darwin', kill: (pid, signal) => kills.push([pid, signal])
    })
    assert.equal(mac.why, 'timed-out')
    assert.deepEqual(kills, [[4243, 'SIGTERM'], [4243, 'SIGKILL']])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
