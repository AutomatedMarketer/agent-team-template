import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawn as realSpawn } from 'node:child_process'
import { repoRoot } from './helpers/repo.mjs'
import { fakeCodex } from './helpers/fake-codex.mjs'
import { CODEX_SELFTEST_MARKER, CODEX_WALLS, codexSelftest, countingServer, plantCodexWalls, probeCommands, probeWalls, promptWalls } from '../scripts/lib/mailbox/codex-selftest.mjs'
import { buildCodexArgv, codexEnv, codexFolders, codexHomeOf, codexHomeTrusts, codexTrustKey, writeCodexHome } from '../scripts/lib/mailbox/codex.mjs'
import { CODEX_PROOF_FILE, codexProofHolds, codexProofKept, PROOF_FILE } from '../scripts/lib/mailbox/proof.mjs'
import { createRunner } from '../scripts/lib/status/programs.mjs'

/* No Codex job runs until the walls were tried on this computer, with this Codex and this setup: the sandbox by plain commands
   (no model), what Codex is told (no model), then a real run asked to try every wall. These tests use a fake Codex that behaves as
   the profile says, and make it misbehave to see each failure caught. The tests at the end use the real Codex when it is on this
   computer: the sandbox part needs no login, so it runs; the whole self-test runs only when a signed-in runner Codex home is named. */

const CODEX_FILE = '/fake/bin/codex'
const exists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function world(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-selftest-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const tmp = join(root, 'tmp')
  await mkdir(home)
  await mkdir(tmp)
  const places = { stateDir: join(root, 'state'), codeDir: repoRoot, workDir: join(root, 'work'), envFile: join(root, 'state', 'env') }
  const codex = fakeCodex(options)
  const ctx = {
    places,
    home,
    tmpDir: tmp,
    env: { HOME: home, PATH: '/usr/bin' },
    platform: 'darwin',
    find: async () => ({ state: 'found', path: CODEX_FILE }),
    realpath: async (path) => path,
    exec: codex.exec,
    spawn: codex.spawn,
    kill: codex.kill,
    now: () => Date.parse('2026-10-18T12:00:00Z')
  }
  return { root, home, tmp, places, codex, ctx }
}

const proofThere = async (places) => exists(join(places.stateDir, CODEX_PROOF_FILE))

test('a Codex whose sandbox, settings and run hold every wall passes, the proof is kept for its version and file, and nothing planted is left', async (t) => {
  const w = await world(t)
  const result = await codexSelftest(w.ctx)
  assert.deepEqual(result, { ok: true, problems: [] })
  assert.deepEqual(await codexProofHolds({ stateDir: w.places.stateDir, codeDir: repoRoot, version: [0, 160, 0], file: CODEX_FILE }), { holds: true, at: '2026-10-18T12:00:00Z' })
  assert.equal((await codexProofHolds({ stateDir: w.places.stateDir, codeDir: repoRoot, version: [0, 161, 0], file: CODEX_FILE })).holds, false, 'another version was never tested')
  assert.equal((await codexProofHolds({ stateDir: w.places.stateDir, codeDir: repoRoot, version: [0, 160, 0], file: '/other/codex' })).holds, false, 'another file was never tested')
  assert.equal((await codexProofKept({ stateDir: w.places.stateDir, codeDir: repoRoot, version: [0, 160, 0] })).holds, true)
  assert.ok(!(await exists(join(w.places.stateDir, PROOF_FILE))), 'Claude\'s proof is a different file and is never made here')
  assert.deepEqual(await readdir(w.home), [])
  assert.deepEqual(await readdir(w.tmp), [])
  assert.ok(!(await exists(join(dirname(w.places.workDir), 'codex-selftest'))))
  assert.deepEqual((await readdir(codexHomeOf(w.places.stateDir))).filter((name) => name.startsWith('selftest-canary')), [])
  // Every sandbox question went to `codex sandbox` with the runner's profile, from the trapped repo, in the runner's Codex home.
  const sandbox = w.codex.state.calls.filter((call) => call.args[0] === 'sandbox')
  assert.ok(sandbox.length >= 10)
  for (const call of sandbox) {
    assert.deepEqual(call.args.slice(0, 3), ['sandbox', '-P', 'mailbox-work'])
    assert.equal(call.options.env.CODEX_HOME, codexHomeOf(w.places.stateDir))
  }
  // The real run is started exactly as a job is.
  const [run] = w.codex.state.runs
  assert.equal(run.file, CODEX_FILE)
  assert.deepEqual(run.args.slice(0, 7), ['exec', '--json', '--strict-config', '--ephemeral', '--ignore-rules', '--skip-git-repo-check', '-C'])
  assert.equal(run.options.env.CODEX_HOME, codexHomeOf(w.places.stateDir))
})

for (const wall of [...CODEX_WALLS.map((one) => one.key), 'network']) {
  test(`a sandbox that lets ${wall} through fails, keeps no proof, and never starts the real run`, async (t) => {
    const w = await world(t, { leak: [wall] })
    const result = await codexSelftest(w.ctx)
    assert.equal(result.ok, false)
    assert.ok(result.problems.some((problem) => problem.startsWith('the sandbox:') && /not holding|not off/.test(problem)), result.problems.join(' | '))
    assert.equal(await proofThere(w.places), false)
    assert.equal(w.codex.state.runs.length, 0, 'the model is not paid for when the sandbox already failed')
    assert.ok(!result.problems.join(' ').includes(w.home), 'no path is named')
  })
}

test('Codex told the repo\'s AGENTS.md or offered its skill fails, with no proof and no run', async (t) => {
  for (const tells of ['agents', 'skill']) {
    const w = await world(t, { tells })
    const result = await codexSelftest(w.ctx)
    assert.equal(result.ok, false, tells)
    assert.ok(result.problems.some((problem) => problem.startsWith('what Codex is told:')), tells)
    assert.equal(await proofThere(w.places), false)
    assert.equal(w.codex.state.runs.length, 0)
  }
})

test('a real run that uses an MCP tool, fires a trap, leaks a secret, writes outside, skips a wall or fails is caught', async (t) => {
  const cases = [
    [{ item: 'mcp_tool_call' }, /used something it may not use \(mcp_tool_call\)/],
    [{ item: 'web_search' }, /used something it may not use \(web_search\)/],
    [{ trap: 'AGENTS-RAN' }, /AGENTS-RAN: something the repo planted ran/],
    [{ trap: 'MCP-RAN' }, /MCP-RAN: something the repo planted ran/],
    [{ leak: ['codexHomeRead'] }, /came out in what Codex said/],
    [{ leak: ['outsideWrite'] }, /managed writing a file next to its own folder/],
    [{ leak: ['network'] }, /reached the network/],
    [{ skip: ['tmpRead'] }, /never seen trying reading a file in the temp folder/],
    [{ skip: ['network'] }, /never seen trying the network/],
    [{ fail: true }, /did not finish well \(codex-failed\)/]
  ]
  for (const [run, expected] of cases) {
    const w = await world(t, { run })
    const result = await codexSelftest(w.ctx)
    assert.equal(result.ok, false, JSON.stringify(run))
    assert.ok(result.problems.some((problem) => expected.test(problem)), `${JSON.stringify(run)}: ${result.problems.join(' | ')}`)
    assert.equal(await proofThere(w.places), false)
  }
})

test('a Codex that is not ready is not tested: it says to run --preflight, and an older proof is dropped first', async (t) => {
  const w = await world(t, { login: 'apiKey' })
  await mkdir(w.places.stateDir, { recursive: true })
  await writeFile(join(w.places.stateDir, CODEX_PROOF_FILE), '{"ok":true}\n')
  const result = await codexSelftest(w.ctx)
  assert.deepEqual(result, { ok: false, problems: ['Codex is not ready (codex-wrong-login); run --preflight first.'] })
  assert.equal(await proofThere(w.places), false)
  const noSandbox = await world(t, { noSandbox: true })
  assert.deepEqual((await codexSelftest(noSandbox.ctx)).problems, ['Codex is not ready (codex-no-sandbox); run --preflight first.'])
})

test('a folder named codex-selftest that is not the self-test\'s own is left alone', async (t) => {
  const w = await world(t)
  const theirs = join(dirname(w.places.workDir), 'codex-selftest')
  await mkdir(theirs, { recursive: true })
  await writeFile(join(theirs, 'mine.txt'), 'keep me\n')
  const result = await codexSelftest(w.ctx)
  assert.equal(result.ok, false)
  assert.equal(await readFile(join(theirs, 'mine.txt'), 'utf8'), 'keep me\n')
  assert.ok(!(await exists(join(theirs, CODEX_SELFTEST_MARKER))))
})

test('the counting server counts what reaches it', async (t) => {
  const server = await countingServer()
  t.after(() => server.close())
  assert.equal((await (await fetch(server.url('x'))).text()), 'REACHED')
  assert.deepEqual(server.hits, ['/x'])
})

/* ---------- the real Codex, when it is on this computer ------------------------------------------------------------------ */

// The first Codex program on the runner's own fixed list, or null.
async function realCodex() {
  const { homedir } = await import('node:os')
  for (const folder of codexFolders(homedir(), process.platform)) {
    const file = join(folder, process.platform === 'win32' ? 'codex.exe' : 'codex')
    if (await exists(file)) return file
  }
  return null
}

test('the REAL Codex sandbox, with the runner\'s profile and settings, holds every wall on this computer (no model, no login)', async (t) => {
  const file = await realCodex()
  if (file === null) {
    t.skip('SKIPPED, not passed: no Codex on the runner\'s fixed list on this computer.')
    return
  }
  const { homedir } = await import('node:os')
  const root = await mkdtemp(join(tmpdir(), 'codex-real-'))
  const planted = []
  const server = await countingServer()
  t.after(async () => {
    for (const path of planted) await rm(path, { force: true })
    await rm(root, { recursive: true, force: true })
    await server.close()
  })
  const stateDir = join(root, 'state')
  await mkdir(stateDir)
  await mkdir(codexHomeOf(stateDir), { recursive: true })
  const env = Object.fromEntries(['HOME', 'PATH', 'USER', 'LANG', 'TMPDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP', 'Path'].filter((name) => typeof process.env[name] === 'string').map((name) => [name, process.env[name]]))
  const exec = createRunner({ spawn: realSpawn, platform: process.platform, env })
  const tmp = join(root, 'tmp')
  await mkdir(tmp)
  const walls = await plantCodexWalls({ folder: join(root, 'sel'), home: homedir(), tmp, codexHome: codexHomeOf(stateDir), planted })
  // As a job: the folder Codex is started in is marked untrusted (the trapped repo has a .codex folder that would open every wall).
  assert.equal((await writeCodexHome({ stateDir, codeDir: repoRoot, untrusted: [walls.repo] })).ok, true)
  const probe = await exec(file, ['sandbox', '-P', 'mailbox-work', '-C', walls.repo, '--', ...probeCommands(process.platform, env).read(walls.paths.insideRead)], { cwd: walls.repo, env: { ...env, CODEX_HOME: codexHomeOf(stateDir) }, timeout: 60_000, acceptAnyExit: true }).catch(() => null)
  if (!probe || !String(probe.stdout).includes(walls.secrets.inside)) {
    // Not a pass: on Windows without the container sandbox Codex refuses the profile, which is the runner's own answer (codex-no-sandbox).
    t.skip(`SKIPPED, not passed: Codex's sandbox does not start here with the runner's profile, so the runner refuses Codex on this computer (codex-no-sandbox).`)
    return
  }
  const problems = await probeWalls({ exec, file, planted: walls, server, env, platform: process.platform, codexHome: codexHomeOf(stateDir) })
  assert.deepEqual(problems, [])
  assert.deepEqual(server.hits, [])
  // Then one `codex exec` in the trapped repo, with no login (it stops at the first model request): the T14 review's way in. Codex must not
  // trust the repo, start its MCP server or hook, or let its profile table and AGENTS.md in - parts 1 and 2 are tried again after it.
  await exec(file, buildCodexArgv({ prompt: 'hello', workDir: walls.repo }), { cwd: walls.repo, env: codexEnv(env, process.platform, codexHomeOf(stateDir)), timeout: 45_000, acceptAnyExit: true }).catch(() => null)
  assert.equal(await codexHomeTrusts(codexHomeOf(stateDir)), false, 'Codex trusted the repo')
  for (const trap of walls.traps) assert.equal(await exists(trap.path), false, `${trap.name}: something the repo planted ran`)
  assert.deepEqual(await probeWalls({ exec, file, planted: walls, server, env, platform: process.platform, codexHome: codexHomeOf(stateDir) }), [])
  assert.deepEqual(await promptWalls({ exec, file, planted: walls, env, platform: process.platform, codexHome: codexHomeOf(stateDir) }), [])
  assert.deepEqual(server.hits, [])
})

test('the REAL whole Codex self-test, only when a signed-in runner state folder is named (MAILBOX_CODEX_SELFTEST_STATE)', async (t) => {
  const stateDir = process.env.MAILBOX_CODEX_SELFTEST_STATE
  const file = await realCodex()
  if (!stateDir || file === null) {
    t.skip('SKIPPED, not passed: set MAILBOX_CODEX_SELFTEST_STATE to a runner state folder whose Codex home is signed in (node scripts/mailbox-runner.mjs --codex-login) to run the real one. It costs a little of the Codex plan.')
    return
  }
  const { homedir } = await import('node:os')
  const env = { ...process.env }
  const root = await mkdtemp(join(tmpdir(), 'codex-real-all-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const result = await codexSelftest({
    places: { stateDir, codeDir: repoRoot, workDir: join(root, 'work'), envFile: join(stateDir, 'env') },
    home: homedir(),
    env,
    platform: process.platform,
    find: async () => ({ state: 'found', path: file }),
    exec: createRunner({ spawn: realSpawn, platform: process.platform, env }),
    spawn: realSpawn,
    now: Date.now
  })
  assert.deepEqual(result.problems, [])
})

/* ---------- the T14 review: trust, links, and a network check with a control ----------------------------------------------- */

test('the trapped repo is marked untrusted in the Codex home before any part runs, as a job\'s work copy is', async (t) => {
  const w = await world(t)
  let seen = null
  const exec = w.codex.exec
  w.ctx.exec = async (file, args, options) => {
    if (args[0] === 'sandbox' && seen === null && args.includes('--') && !args.includes('/bin/echo')) seen = await readFile(join(codexHomeOf(w.places.stateDir), 'config.toml'), 'utf8')
    return exec(file, args, options)
  }
  assert.equal((await codexSelftest(w.ctx)).ok, true)
  assert.ok(seen.toLowerCase().includes(JSON.stringify(codexTrustKey(join(dirname(w.places.workDir), 'codex-selftest', 'repo'))).toLowerCase() + ']' + String.fromCharCode(10) + 'trust_level = "untrusted"'), seen.slice(-400))
})

test('a sandbox that lets a link made inside read a secret outside fails part 1', async (t) => {
  const w = await world(t, { leak: ['links'] })
  const result = await codexSelftest(w.ctx)
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((problem) => /through a link it made|through a hard link it made/.test(problem)), result.problems.join(' | '))
  assert.equal(w.codex.state.runs.length, 0)
})

test('the network wall is not proven when the program it is tried with does not start in the sandbox', async (t) => {
  const w = await world(t, { leak: ['noNetControl'] })
  const result = await codexSelftest(w.ctx)
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((problem) => problem.includes('network wall is not proven')), result.problems.join(' | '))
})

test('on Windows the network is tried with PowerShell, shown to start first; curl.exe cannot start inside the container sandbox', () => {
  const commands = probeCommands('win32', { SystemRoot: 'C:\Windows' })
  assert.ok(commands.control[0].endsWith(['WindowsPowerShell', 'v1.0', 'powershell.exe'].join(String.fromCharCode(92))), commands.control[0])
  assert.match(commands.reach('http://127.0.0.1:1/x')[0], /powershell\.exe$/)
  assert.ok(!commands.reach('http://127.0.0.1:1/x').join(' ').includes('curl'))
})

test('a real run after which the Codex home trusts a folder fails, with no proof', async (t) => {
  const w = await world(t, { run: { trust: true } })
  const result = await codexSelftest(w.ctx)
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((problem) => problem.includes('Codex trusted a folder')), result.problems.join(' | '))
  assert.equal(await proofThere(w.places), false)
})
