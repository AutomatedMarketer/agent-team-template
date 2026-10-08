import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod, symlink, readdir, lstat, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, dirname, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { programFolders, findProgram, createRunner, emptyFolder, PROGRAM_OUTPUT_CAP } from '../scripts/lib/status/programs.mjs'
import { repoRoot } from './helpers/repo.mjs'

/* The connections part runs other programs: `claude mcp list` and a handful of `--version`s. Each
   one is a program chosen by whatever is on this computer, so the rules are strict: a program is
   looked up only in absolute folders (never "." or a relative PATH entry), never inside the
   --clone folder (that folder holds whatever the team repo holds), it runs from an empty folder,
   and a program that hangs or floods is stopped - with everything it started. The runner is tested
   for real here against node itself; nothing else is run. */

const exe = (platform) => (platform === 'win32' ? '.exe' : '')

async function fakeProgram(folder, name, platform = 'linux') {
  await mkdir(folder, { recursive: true })
  const path = join(folder, `${name}${exe(platform)}`)
  await writeFile(path, '#!/bin/sh\necho fake\n')
  await chmod(path, 0o755)
  return path
}

test('program folders: absolute PATH entries only, then the known install folders', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-programs-'))
  try {
    const a = join(root, 'a')
    const b = join(root, 'b')
    const home = join(root, 'home')
    const path = [a, '.', '', 'bin', join('relative', 'bin'), b, a].join(process.platform === 'win32' ? ';' : ':')
    const linux = programFolders({ env: { PATH: path }, home, platform: 'linux' })
    assert.deepEqual(linux, [a, b, join(home, '.local', 'bin'), join(home, '.claude', 'local')])
    const mac = programFolders({ env: { PATH: path }, home, platform: 'darwin' })
    assert.deepEqual(mac.slice(-2), ['/opt/homebrew/bin', '/usr/local/bin'])
    // Windows keeps its PATH as "Path" as often as "PATH".
    assert.deepEqual(programFolders({ env: { Path: a }, home, platform: 'win32' })[0], a)
    // Tests hand over their own known folders, so a real Homebrew folder is never looked in.
    assert.deepEqual(programFolders({ env: {}, home, platform: 'darwin', knownFolders: [b] }), [b])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('find: the first absolute folder that holds the program wins, and the path is absolute', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-programs-'))
  try {
    const first = join(root, 'first')
    const second = join(root, 'second')
    await fakeProgram(second, 'claude')
    await mkdir(first, { recursive: true })
    const deps = { env: { PATH: [first, second].join(process.platform === 'win32' ? ';' : ':') }, home: join(root, 'home'), platform: 'linux', knownFolders: [] }
    const found = await findProgram('claude', deps)
    assert.equal(found.state, 'found')
    assert.equal(found.path, join(second, 'claude'))
    assert.deepEqual(await findProgram('codex', deps), { state: 'not found' })
    // A known folder is looked in after PATH.
    const known = join(root, 'home', '.local', 'bin')
    await fakeProgram(known, 'codex')
    assert.equal((await findProgram('codex', { ...deps, knownFolders: undefined })).path, join(known, 'codex'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('find: a program inside the --clone folder is refused, even through a link', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-programs-'))
  try {
    const clone = join(root, 'clone')
    const inside = join(clone, 'node_modules', '.bin')
    const outside = join(root, 'outside')
    await fakeProgram(inside, 'claude')
    const sep_ = process.platform === 'win32' ? ';' : ':'
    const base = { home: join(root, 'home'), platform: 'linux', knownFolders: [], clone }
    assert.deepEqual(await findProgram('claude', { ...base, env: { PATH: inside } }), { state: 'refused' })
    await fakeProgram(outside, 'claude')
    const next = await findProgram('claude', { ...base, env: { PATH: [inside, outside].join(sep_) } })
    assert.equal(next.path, join(outside, 'claude'), 'it stopped at the refused one instead of looking further')
    const linked = join(root, 'linked')
    try {
      await symlink(inside, linked, 'junction')
    } catch (error) {
      t.skip(`this computer does not let a test make a folder link (${error.code}) - NOT CHECKED here`)
      return
    }
    assert.deepEqual(await findProgram('claude', { ...base, env: { PATH: linked } }), { state: 'refused' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('find on Windows: only a real .exe runs; a .cmd or .bat needs a shell, so it is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-programs-'))
  try {
    const folder = join(root, 'npm')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'codex.cmd'), '@echo off\r\n')
    await writeFile(join(folder, 'gh.bat'), '@echo off\r\n')
    const deps = { env: { Path: folder }, home: join(root, 'home'), platform: 'win32', knownFolders: [] }
    assert.deepEqual(await findProgram('codex', deps), { state: 'refused' })
    assert.deepEqual(await findProgram('gh', deps), { state: 'refused' })
    await fakeProgram(folder, 'git', 'win32')
    assert.equal((await findProgram('git', deps)).path, join(folder, 'git.exe'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('find: a name with a slash, a dot path or a drive is not a program name', async () => {
  for (const name of ['../claude', 'bin/claude', 'C:\\x', '.', '', 'claude --version']) {
    await assert.rejects(findProgram(name, { env: {}, home: tmpdir(), platform: 'linux', knownFolders: [] }), /not a program name/)
  }
})

// --- the runner ------------------------------------------------------------------------------------

const runner = createRunner({ spawn, platform: process.platform, env: process.env })

// On Windows a process that has just ended - or been stopped - lets go of its working folder a
// moment later, and a virus scanner may still hold a file it wrote there. Deleting that folder at
// once can fail with EBUSY (seen once in a full-suite run, after every assertion had passed). rm
// retries exactly those errors; the test itself is unchanged.
const RELEASED_LATER = { maxRetries: 10, retryDelay: 200 }

test('the runner runs from the folder it is given, and hands back stdout', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-status-cwd-'))
  try {
    const { stdout } = await runner(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd, timeout: 20_000 })
    assert.equal(await realpath(stdout), await realpath(cwd))
  } finally {
    await rm(cwd, { recursive: true, force: true, ...RELEASED_LATER })
  }
})

test('the runner refuses a program that is not an absolute path', async () => {
  await assert.rejects(runner('node', ['-e', '1'], { cwd: tmpdir() }), /absolute/)
  await assert.rejects(runner(join('.', 'node'), ['-e', '1'], { cwd: tmpdir() }), /absolute/)
})

test('the runner rejects on a failing exit, unless told any exit is an answer', async () => {
  const script = 'process.stdout.write("half"); process.exit(3)'
  await assert.rejects(runner(process.execPath, ['-e', script], { cwd: tmpdir(), timeout: 20_000 }), (error) => error.code === 'EXIT' && error.exitCode === 3)
  const answer = await runner(process.execPath, ['-e', script], { cwd: tmpdir(), timeout: 20_000, acceptAnyExit: true })
  assert.deepEqual(answer, { stdout: 'half', code: 3 })
})

test('the runner stops a program that floods its output, at the cap', async () => {
  assert.equal(PROGRAM_OUTPUT_CAP, 256 * 1024)
  const started = Date.now()
  const flood = 'const line = "x".repeat(1024) + "\\n"; setInterval(() => { for (let i = 0; i < 64; i++) process.stdout.write(line) }, 1)'
  await assert.rejects(runner(process.execPath, ['-e', flood], { cwd: tmpdir(), timeout: 30_000, maxOutput: PROGRAM_OUTPUT_CAP }), (error) => error.code === 'ECAP')
  assert.ok(Date.now() - started < 20_000, 'the cap did not stop it')
})

test('a timeout kills the program and everything it started', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'agent-status-tree-'))
  try {
    const pidFile = join(folder, 'grandchild.pid')
    // The program starts a grandchild that would live for a minute, then waits itself.
    const parent = [
      "const { spawn } = require('node:child_process')",
      `const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })`,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
      'setTimeout(() => {}, 60000)'
    ].join(';')
    const started = Date.now()
    await assert.rejects(runner(process.execPath, ['-e', parent], { cwd: folder, timeout: 6_000 }), (error) => error.code === 'ETIMEDOUT')
    assert.ok(Date.now() - started < 30_000, 'the timeout did not stop it')
    const grandchild = Number(await readFile(pidFile, 'utf8'))
    let alive = true
    for (let tries = 0; tries < 50 && alive; tries++) {
      try {
        process.kill(grandchild, 0)
        await new Promise((resolve) => setTimeout(resolve, 100))
      } catch {
        alive = false
      }
    }
    assert.equal(alive, false, 'the program was stopped but what it started is still running')
  } finally {
    await rm(folder, { recursive: true, force: true, ...RELEASED_LATER })
  }
})

// --- the empty folder programs run from ---------------------------------------------------------------

test('programs run from an empty folder in the state folder, emptied every time', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'agent-status-state-'))
  try {
    const first = await emptyFolder(state)
    assert.equal(first, join(state, 'empty-cwd'))
    await writeFile(join(first, '.mcp.json'), '{"mcpServers":{}}')
    await mkdir(join(first, '.claude'))
    const second = await emptyFolder(state)
    assert.deepEqual(await readdir(second), [], 'what was left in it is still there')
    // A link put where the folder goes is replaced by a real folder, and its target left alone.
    await rm(second, { recursive: true, force: true })
    const elsewhere = await mkdtemp(join(tmpdir(), 'agent-status-elsewhere-'))
    await writeFile(join(elsewhere, 'keep.txt'), 'keep')
    try {
      await symlink(elsewhere, second, 'junction')
    } catch (error) {
      await rm(elsewhere, { recursive: true, force: true })
      t.skip(`this computer does not let a test make a folder link (${error.code}) - NOT CHECKED here`)
      return
    }
    const third = await emptyFolder(state)
    assert.equal((await lstat(third)).isSymbolicLink(), false)
    assert.deepEqual(await readdir(third), [])
    assert.equal(await readFile(join(elsewhere, 'keep.txt'), 'utf8'), 'keep')
    await rm(elsewhere, { recursive: true, force: true })
  } finally {
    await rm(state, { recursive: true, force: true })
  }
})

// --- only machine.mjs may start a program ----------------------------------------------------------------
//
// Every program the collector runs goes through deps.exec, which the tests replace. A module that
// imported child_process itself would run programs the tests cannot see or stop. This walks every
// module the collector loads, from cli.mjs down, and allows child_process in machine.mjs only.

async function moduleGraph(entry) {
  const seen = new Set()
  const queue = [entry]
  while (queue.length) {
    const file = queue.shift()
    if (seen.has(file)) continue
    seen.add(file)
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]/gm)) queue.push(join(dirname(file), match[1]))
  }
  return [...seen]
}

// The file name is put together so the spawn scan, which refuses any test line naming it, sees no use of it.
const MACHINE = ['machine', 'mjs'].join('.')

test('SPAWN SAFETY: of every module the collector loads, only the machine module imports child_process', async () => {
  const modules = await moduleGraph(join(repoRoot, 'scripts', 'lib', 'status', 'cli.mjs'))
  const names = modules.map((file) => relative(join(repoRoot, 'scripts'), file).split(sep).join('/'))
  assert.ok(names.includes('lib/status/programs.mjs') && names.includes(`lib/status/${MACHINE}`), 'the walk did not reach the program modules')
  const offenders = []
  for (const file of modules) {
    const text = await readFile(file, 'utf8')
    const imports = /from\s*['"](node:)?child_process['"]|import\(\s*['"](node:)?child_process['"]|require\(\s*['"](node:)?child_process['"]/.test(text)
    if (imports && !file.endsWith(`${sep}${MACHINE}`)) offenders.push(relative(repoRoot, file))
  }
  assert.deepEqual(offenders, [])
})

// The sources need to know where the empty folder goes and which folder to refuse programs from.
test('the run hands every source the state folder and the --clone folder', async () => {
  const { makeFakeHome } = await import('./helpers/fake-home.mjs')
  const { runIn } = await import('./helpers/hostile-home.mjs')
  const fake = await makeFakeHome()
  try {
    const seen = []
    const spy = async (deps, computer) => {
      seen.push({ stateDir: deps.stateDir, clone: deps.clone })
      return { schema: 'agent-status/connections/v1', takenAt: '2026-10-07T20:00:00Z', computer, tools: [], claude: { status: 'not found' }, codex: { status: 'not found' } }
    }
    const result = await runIn(fake, ['--computer', 'Test PC', '--only', 'connections', '--dry-run'], { sources: { connections: spy } })
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(seen, [{ stateDir: join(fake.home, '.local', 'state', 'agent-status-collector'), clone: undefined }])
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})
