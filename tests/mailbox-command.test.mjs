import test from 'node:test'
import assert from 'node:assert/strict'
import { access, chmod, mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mailboxWorld, ALLOWLIST, FAKE_API_KEY } from './helpers/mailbox-world.mjs'
import { main, parseArgs, USAGE } from '../scripts/lib/mailbox/command.mjs'
import { repoRoot } from './helpers/repo.mjs'
import { confinedClaude, stepsOf } from './helpers/mailbox-selftest-claude.mjs'
import { SELFTEST_MARKER } from '../scripts/lib/mailbox/selftest.mjs'
import { keepProof } from '../scripts/lib/mailbox/proof.mjs'
import { claudeFolders } from '../scripts/lib/mailbox/claude.mjs'
import { findEveryProgram, findProgram } from '../scripts/lib/status/programs.mjs'

/* The command a LaunchAgent runs every five minutes, and the few switches a person uses by hand: one tick, a check that
   says in plain words what is wrong, and a test of the walls around Claude. Output is plain lines for a person to read -
   never a key, a path with a user name in it, or a word anyone typed. */

function capture() {
  const lines = []
  return { lines, out: (text) => lines.push(text), err: (text) => lines.push(text) }
}

async function run(w, argv, change = {}) {
  const sink = capture()
  // The self-test plants files in a home folder and a temp folder: here, folders of the fake world, never this computer's.
  const code = await main({ argv, ...w.ctx({ log: sink.out }), codeDir: w.places.codeDir, tmpDir: join(w.root, 'tmp'), out: sink.out, err: sink.err, ...change })
  return { code, text: sink.lines.join('\n'), lines: sink.lines }
}

test('the switches are known, and a switch that is not is a mistake that prints how to use it and exits 2', () => {
  assert.deepEqual(parseArgs([]), { ok: true, mode: 'tick', force: false, paths: {} })
  assert.deepEqual(parseArgs(['--once']), { ok: true, mode: 'tick', force: true, paths: {} })
  assert.deepEqual(parseArgs(['--preflight']), { ok: true, mode: 'preflight', force: false, paths: {} })
  assert.deepEqual(parseArgs(['--selftest']), { ok: true, mode: 'selftest', force: false, paths: {} })
  assert.deepEqual(parseArgs(['--state-dir', '/s', '--work-dir', '/w', '--env-file', '/e']), { ok: true, mode: 'tick', force: false, paths: { stateDir: '/s', workDir: '/w', envFile: '/e' } })
  for (const bad of [['--nope'], ['--once', '--preflight'], ['--state-dir'], ['--state-dir', '--once'], ['extra'], ['--once=1'], ['--selftest', '--selftest'], ['--help']]) {
    assert.equal(parseArgs(bad).ok, false, bad.join(' '))
  }
  assert.match(USAGE, /--preflight/)
  assert.match(USAGE, /--selftest/)
  assert.match(USAGE, /--once/)
})

test('the help is printed for --help and for a mistake, and nothing runs', async () => {
  const w = await mailboxWorld()
  try {
    const mistake = await run(w, ['--nope'])
    assert.equal(mistake.code, 2)
    assert.match(mistake.text, /Usage/)
    const help = await run(w, ['--help'])
    assert.equal(help.code, 0)
    assert.match(help.text, /Usage/)
    assert.equal(w.board.polls, 0)
  } finally {
    await w.cleanup()
  }
})

test('with no switch it is one tick at the board\'s pace; --once is one tick now; a good tick exits 0 and says what it did in one line', async () => {
  const w = await mailboxWorld()
  try {
    w.send({ action: 'task', title: 'Chase the invoice' })
    const first = await run(w, [])
    assert.equal(first.code, 0)
    assert.equal(first.lines.length, 1)
    assert.match(first.text, /done/)
    assert.match(first.text, /1 claimed/)
    const waiting = await run(w, [])
    assert.equal(waiting.code, 0)
    assert.match(waiting.text, /waiting/)
    assert.equal(w.board.polls, 1)
    const forced = await run(w, ['--once'])
    assert.equal(forced.code, 0)
    assert.equal(w.board.polls, 2)
  } finally {
    await w.cleanup()
  }
})

test('a tick that cannot do its work exits 1 and says why in a word, not a message: no allowlist, a paused runner exits 0', async () => {
  const w = await mailboxWorld()
  try {
    await rm(join(w.places.stateDir, 'allowed-orders.yml'))
    const missing = await run(w, ['--once'])
    assert.equal(missing.code, 1)
    assert.match(missing.text, /unavailable \(no-allowlist\)/)
    await writeFile(join(w.places.stateDir, 'allowed-orders.yml'), ALLOWLIST())
    await writeFile(join(w.places.stateDir, 'PAUSE'), '')
    const paused = await run(w, ['--once'])
    assert.equal(paused.code, 0)
    assert.match(paused.text, /paused/)
  } finally {
    await w.cleanup()
  }
})

test('the places are the usual ones under the home folder unless a switch says otherwise, and the code is the checkout the command is in', async () => {
  const seen = []
  const sink = capture()
  await main({
    argv: ['--once'],
    home: join(tmpdir(), 'home-of-someone'),
    out: sink.out,
    err: sink.err,
    tick: async (ctx) => { seen.push(ctx.places); return { state: 'done', orders: { claimed: 0, ok: 0, refused: 0, failed: 0 } } }
  })
  assert.deepEqual(seen[0], {
    stateDir: join(tmpdir(), 'home-of-someone', '.local', 'state', 'agent-mailbox'),
    codeDir: repoRoot.replace(/[\\/]+$/, ''),
    workDir: join(tmpdir(), 'home-of-someone', '.local', 'share', 'agent-mailbox', 'work'),
    envFile: join(tmpdir(), 'home-of-someone', '.config', 'agent-mailbox', 'env')
  })
  seen.length = 0
  await main({ argv: ['--state-dir', '/s', '--work-dir', '/w', '--env-file', '/e'], home: '/h', out: sink.out, err: sink.err, tick: async (ctx) => { seen.push(ctx.places); return { state: 'done', orders: {} } } })
  assert.deepEqual([seen[0].stateDir, seen[0].workDir, seen[0].envFile], ['/s', '/w', '/e'])
})

/* ---------- --preflight --------------------------------------------------------------------------------------------- */

test('--preflight says in plain words what is ready and what is not, exits 0 only when every part is ready, and never prints a secret', async () => {
  const w = await mailboxWorld()
  try {
    const good = await run(w, ['--preflight'])
    assert.equal(good.code, 0)
    for (const part of ['folders', 'allowlist', 'secrets', 'Claude', 'login', 'team repo', 'self-test']) assert.match(good.text, new RegExp(part), part)
    assert.ok(!good.text.includes('signing-secret'))
    assert.ok(!good.text.includes('poll-key'))
    assert.equal(w.board.polls, 0, 'it asks no board')
    assert.equal(w.claude.calls.length, 0, 'it starts no run')
  } finally {
    await w.cleanup()
  }
})

const PROBLEMS = [
  ['no allowlist', async (w) => rm(join(w.places.stateDir, 'allowed-orders.yml')), {}, /allowlist.*missing|no allowlist/i],
  ['a broken allowlist', async (w) => writeFile(join(w.places.stateDir, 'allowed-orders.yml'), 'board: http://x\n'), {}, /allowlist.*(broken|not usable)/i],
  ['no secrets file', async (w) => rm(w.places.envFile), {}, /secrets.*missing|no secrets/i],
  ['Claude not found', async () => {}, { find: async () => ({ state: 'not found' }) }, /Claude Code was not found/],
  ['not logged in', async () => {}, { exec: async (file, args) => { if (args[0] === 'auth') throw Object.assign(new Error('x'), { code: 'EXIT' }); return { stdout: '2.1.290', code: 0 } } }, /not logged in/i],
  ['a Claude Code that is too old', async () => {}, { exec: async (file, args) => (args[0] === 'auth' ? { stdout: JSON.stringify({ authMethod: 'claude.ai' }), code: 0 } : { stdout: '2.1.258 (Claude Code)', code: 0 }) }, /too old.*2\.1\.259/i],
  ['an API key in the environment', async () => {}, { env: { HOME: '/h', ANTHROPIC_API_KEY: FAKE_API_KEY } }, /API key/i],
  ['a different team repo', async () => {}, { originAccepted: () => false }, /team repo/i],
  ['no self-test passed yet', async (w) => rm(join(w.places.stateDir, 'selftest.json')), {}, /PROBLEM self-test: .*--selftest/],
  ['a self-test passed for another Claude version', async () => {}, { exec: async (file, args) => (args[0] === 'auth' ? { stdout: JSON.stringify({ authMethod: 'claude.ai' }), code: 0 } : { stdout: '2.1.300 (Claude Code)', code: 0 }) }, /PROBLEM self-test: .*--selftest/]
]

for (const [name, setup, change, words] of PROBLEMS) {
  test(`--preflight finds ${name}, says so in words, and exits 1`, async () => {
    const w = await mailboxWorld()
    try {
      await setup(w)
      const result = await run(w, ['--preflight'], change)
      assert.equal(result.code, 1)
      assert.match(result.text, words)
      assert.ok(!result.text.includes(FAKE_API_KEY), 'the key is not printed')
    } finally {
      await w.cleanup()
    }
  })
}

/* ---------- --selftest ---------------------------------------------------------------------------------------------- */

test('--selftest plants a hook, a shell skill, a connector and a secret in a throwaway folder and passes only if Claude did not run or read any', async () => {
  const w = await mailboxWorld()
  try {
    w.claude.script = confinedClaude(w)
    const good = await run(w, ['--selftest'])
    assert.equal(good.code, 0, good.text)
    assert.match(good.text, /passed/i)
    assert.equal(w.claude.calls.length, 2, 'once for each kind of job')
    for (const call of w.claude.calls) {
      assert.ok(call.args.includes('dontAsk'))
      assert.ok(call.options.cwd.includes('selftest'))
      assert.ok(!call.options.cwd.startsWith(w.places.workDir), 'not in the work copy')
      assert.ok(!call.options.cwd.startsWith(w.places.codeDir))
    }
  } finally {
    await w.cleanup()
  }
})

const FOOTPRINTS = [
  ['a hook ran', 'HOOK-RAN'],
  ['a shell skill ran', 'SKILL-RAN'],
  ['a connector started', 'MCP-RAN'],
  ['a key helper ran', 'HELPER-RAN']
]

for (const [name, canary] of FOOTPRINTS) {
  test(`--selftest fails if ${name}: the walls are not holding, and it says which`, async () => {
    const w = await mailboxWorld()
    try {
      const refused = confinedClaude(w)
      w.claude.script = async (cwd, args) => {
        await writeFile(join(cwd, canary), 'ran')
        return refused(cwd, args)
      }
      const result = await run(w, ['--selftest'])
      assert.equal(result.code, 1)
      assert.match(result.text, /FAILED/)
      assert.match(result.text, new RegExp(canary))
    } finally {
      await w.cleanup()
    }
  })
}

test('--selftest fails if Claude lists a shell or a connector among its tools', async () => {
  const w = await mailboxWorld()
  try {
    w.claude.script = async () => [{ ...w.INIT, tools: [...w.INIT.tools, 'Bash'] }, w.RESULT]
    const result = await run(w, ['--selftest'])
    assert.equal(result.code, 1)
    assert.match(result.text, /tool/i)
  } finally {
    await w.cleanup()
  }
})

test('--selftest cleans up after itself, and refuses to run when Claude is not ready', async () => {
  const w = await mailboxWorld()
  try {
    w.claude.script = confinedClaude(w)
    await run(w, ['--selftest'])
    await mkdir(join(dirname(w.places.workDir), 'selftest'), { recursive: true })
    const left = await run(w, ['--selftest'], { find: async () => ({ state: 'not found' }) })
    assert.equal(left.code, 1)
    assert.match(left.text, /not ready|was not found/i)
    assert.equal(w.claude.calls.length, 2, 'the two runs of the first test, and no more')
  } finally {
    await w.cleanup()
  }
})

test('a program is looked for with the work copy named as a clone, so one inside the team repo is never run', async () => {
  const w = await mailboxWorld()
  try {
    const asked = []
    const find = async (name, extra) => {
      asked.push([name, extra])
      return { state: 'not found' }
    }
    for (const switches of [['--preflight'], ['--once'], ['--selftest']]) {
      asked.length = 0
      await run(w, switches, { find })
      assert.ok(asked.length > 0, `${switches[0]} did not look for Claude`)
      for (const [name, extra] of asked) assert.deepEqual([name, extra], ['claude', { clone: w.places.workDir, folders: claudeFolders(w.root) }], switches[0])
    }
    // The work copy named by a switch is the one named.
    asked.length = 0
    await run(w, ['--preflight', '--work-dir', join(w.root, 'elsewhere')], { find })
    assert.deepEqual(asked[0][1], { clone: join(w.root, 'elsewhere'), folders: claudeFolders(w.root) })
  } finally {
    await w.cleanup()
  }
})

test('a tick, a check or a self-test that throws is "stopped (unexpected-error)" and exit 1 - and what went wrong is never printed, for it can hold a path', async () => {
  const w = await mailboxWorld()
  try {
    const message = 'ENOENT: no such file, open /Users/someone/secret/path'
    const boom = async () => { throw new Error(message) }
    const throwing = () => { throw new Error(message) }
    const tick = await run(w, ['--once'], { tick: boom })
    assert.equal(tick.code, 1)
    assert.equal(tick.text, 'mailbox tick: stopped (unexpected-error)')
    const check = await run(w, ['--preflight'], { originAccepted: throwing })
    assert.equal(check.code, 1)
    assert.match(check.text, /stopped \(unexpected-error\)/)
    const test = await run(w, ['--selftest'], { originAccepted: throwing })
    assert.equal(test.code, 1)
    assert.match(test.text, /stopped \(unexpected-error\)/)
    for (const result of [tick, check, test]) assert.ok(!result.text.includes('someone'))
  } finally {
    await w.cleanup()
  }
})

/* ---------- the rest of what each switch says and does -------------------------------------------------------------- */

test('a place may be named once: naming it twice is a mistake', () => {
  assert.equal(parseArgs(['--state-dir', '/a', '--state-dir', '/b']).ok, false)
  assert.equal(parseArgs(['--work-dir', '/a', '--work-dir', '/a']).ok, false)
  assert.equal(parseArgs(['--env-file', '/a', '--env-file', '/b']).ok, false)
})

test('how to use it goes where it belongs: asked for, to the normal output; a mistake, to the error output', async () => {
  const w = await mailboxWorld()
  try {
    const out = []
    const err = []
    assert.equal(await main({ argv: ['--help'], ...w.ctx(), out: (line) => out.push(line), err: (line) => err.push(line) }), 0)
    assert.equal(out.length, 1)
    assert.deepEqual(err, [])
    out.length = 0
    assert.equal(await main({ argv: ['--nope'], ...w.ctx(), out: (line) => out.push(line), err: (line) => err.push(line) }), 2)
    assert.deepEqual(out, [])
    assert.equal(err.length, 1)
    assert.match(err[0], /Usage/)
  } finally {
    await w.cleanup()
  }
})

test('--preflight ends with the one line that says whether to go on; and a folder inside another is a problem it names', async () => {
  const w = await mailboxWorld()
  try {
    const good = await run(w, ['--preflight'])
    assert.equal(good.code, 0, good.text)
    assert.equal(good.lines.at(-1), 'Everything is ready.')
    assert.match(good.lines[0], /^ok +folders: none overlaps another/)
    const overlap = await run(w, ['--preflight', '--state-dir', join(w.places.workDir, 'state')])
    assert.equal(overlap.code, 1)
    assert.match(overlap.text, /PROBLEM folders: the state folder is inside the work copy/)
    assert.match(overlap.lines.at(-1), /^Not everything is ready/)
  } finally {
    await w.cleanup()
  }
})

test('--selftest does not mind a work copy whose origin is not the team repo: it never uses the work copy', async () => {
  const w = await mailboxWorld()
  try {
    w.claude.script = confinedClaude(w)
    const result = await run(w, ['--selftest'], { originAccepted: () => false })
    assert.equal(result.code, 0, result.text)
    assert.equal(w.claude.calls.length, 2)
  } finally {
    await w.cleanup()
  }
})

test('--selftest says what failed in plain words: a tool it should not have, a run that did not end well, a file written outside', async () => {
  const w = await mailboxWorld()
  try {
    w.claude.script = async () => [{ ...w.INIT, tools: [...w.INIT.tools, 'Bash'] }, w.RESULT]
    const tools = await run(w, ['--selftest'])
    assert.match(tools.text, /Claude was given a tool it should not have \(Bash\): the tool limits are not holding/)

    w.claude.script = async () => [w.INIT, { ...w.RESULT, is_error: true, subtype: 'error_during_execution' }]
    const failed = await run(w, ['--selftest'])
    assert.equal(failed.code, 1)
    assert.match(failed.text, /the run did not finish well \(claude-failed\)/)

    const refused = confinedClaude(w)
    w.claude.script = async (cwd, args) => {
      await writeFile(stepsOf(args[1])[7], 'done')
      return refused(cwd, args)
    }
    const outside = await run(w, ['--selftest'])
    assert.equal(outside.code, 1)
    assert.match(outside.text, /WRITTEN-OUTSIDE/)
  } finally {
    await w.cleanup()
  }
})

test('--selftest leaves nothing behind, and a throwaway folder left by an earlier one cannot make this one fail', async () => {
  const w = await mailboxWorld()
  try {
    w.claude.script = confinedClaude(w)
    const stale = join(dirname(w.places.workDir), 'selftest', 'repo')
    await mkdir(stale, { recursive: true })
    await writeFile(join(dirname(w.places.workDir), 'selftest', SELFTEST_MARKER), 'left over\n')
    await writeFile(join(stale, 'HOOK-RAN'), 'left over from an earlier run')
    const result = await run(w, ['--selftest'])
    assert.equal(result.code, 0, result.text)
    await assert.rejects(access(join(dirname(w.places.workDir), 'selftest')), 'the throwaway folder is gone')
  } finally {
    await w.cleanup()
  }
})

test('--selftest runs the real kind of run: the cheaper model, and the small environment and nothing of the Mac\'s', async () => {
  const w = await mailboxWorld()
  try {
    w.claude.script = confinedClaude(w)
    const env = { HOME: w.root, PATH: '/usr/bin', GITHUB_TOKEN: 'a-github-token', MAILBOX_KEY: 'a-mailbox-key' }
    await run(w, ['--selftest'], { env })
    for (const call of w.claude.calls) {
      assert.equal(call.args[call.args.indexOf('--model') + 1], 'sonnet')
      assert.deepEqual(call.options.env, { HOME: w.root, PATH: '/usr/bin', DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' })
    }
  } finally {
    await w.cleanup()
  }
})

/* ---------- the self-test proof is for the file the link leads to ------------------------------------------------------- */

// Where the link leads. The fake world's realpath is the identity, so without this the link and the file are the same text and a check that
// handed the link where the file belongs would still pass.
const LINK = '/fake/bin/claude'
const FILE = '/fake/versions/2.1.290/claude'

test('--preflight asks whether the self-test holds for the file the link leads to, not for the link: a proof kept for the file is "passed", one kept for the link is not', async () => {
  const w = await mailboxWorld({ proof: false })
  try {
    const stateDir = w.places.stateDir
    const followed = { realpath: async (path) => (path === LINK ? FILE : path) }
    const kept = (file) => keepProof({ stateDir, codeDir: w.places.codeDir, version: [2, 1, 290], file, now: () => Date.parse('2026-10-13T10:00:00Z') })
    assert.equal(await kept(FILE), true)
    const forTheFile = await run(w, ['--preflight'], followed)
    assert.match(forTheFile.text, /self-test: passed/)
    assert.equal(await kept(LINK), true)
    const forTheLink = await run(w, ['--preflight'], followed)
    assert.match(forTheLink.text, /PROBLEM self-test: .*--selftest/)
  } finally {
    await w.cleanup()
  }
})

/* ---------- one Claude, found the same way from a terminal and from launchd ------------------------------------------------ */

// Two real files named claude, in two folders of a fixed list. The native one is first on the list; an older copy is second.
async function twoClaudes(w) {
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const native = join(w.root, 'native-bin')
  const older = join(w.root, 'older-bin')
  for (const folder of [native, older]) {
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, `claude${suffix}`), 'x')
    await chmod(join(folder, `claude${suffix}`), 0o755)
  }
  return { native, older, nativeFile: join(native, `claude${suffix}`), olderFile: join(older, `claude${suffix}`) }
}

test('the file Claude is started from is the same from a terminal and from launchd: one fixed list of folders, never the PATH it was started with', async () => {
  const w = await mailboxWorld()
  try {
    const two = await twoClaudes(w)
    const delimiter = process.platform === 'win32' ? ';' : ':'
    // A terminal's PATH puts the older copy first; launchd's puts it first too, in a different spot. Neither can change the answer.
    const environments = {
      terminal: { HOME: w.root, PATH: [two.older, '/usr/bin'].join(delimiter) },
      launchd: { HOME: w.root, PATH: ['/usr/local/bin', two.older, '/usr/bin'].join(delimiter) },
      nothing: { HOME: w.root }
    }
    const startedWith = []
    for (const [name, env] of Object.entries(environments)) {
      const asked = []
      const exec = async (file, args, options) => {
        if (args[0] === '--version') asked.push(file)
        return w.exec(file, args, options)
      }
      const find = (program, extra = {}) => findProgram(program, { env, home: w.root, platform: process.platform, ...extra })
      const findAll = (program, extra = {}) => findEveryProgram(program, { env, home: w.root, platform: process.platform, ...extra })
      const result = await run(w, ['--preflight'], { find, findAll, exec, env, claudeFolders: [two.native, two.older] })
      assert.match(result.text, /Claude: found/, name)
      startedWith.push(asked[0])
    }
    assert.deepEqual(startedWith, [two.nativeFile, two.nativeFile, two.nativeFile])
  } finally {
    await w.cleanup()
  }
})

test('--preflight lists every Claude it finds on the fixed list and says which one the runner uses, with no user name in the paths', async () => {
  const w = await mailboxWorld()
  try {
    const two = await twoClaudes(w)
    const find = (program, extra = {}) => findProgram(program, { env: { PATH: two.older }, home: w.root, platform: process.platform, ...extra })
    const findAll = (program, extra = {}) => findEveryProgram(program, { env: { PATH: two.older }, home: w.root, platform: process.platform, ...extra })
    const result = await run(w, ['--preflight'], { find, findAll, claudeFolders: [two.native, two.older] })
    const line = result.lines.find((one) => one.includes('on the fixed list'))
    assert.ok(line, result.text)
    assert.match(line, /2 copies on the fixed list/)
    assert.ok(line.includes('native-bin') && line.includes('older-bin'))
    assert.ok(line.indexOf('native-bin') < line.indexOf('older-bin'), 'in the order they are tried')
    assert.match(line, /native-bin[^;]*\(the runner uses this one\)/)
    assert.match(line, /older-bin[^;]*\(not used\)/)
    assert.ok(!line.includes(w.root), 'shown from the home folder, not with the whole path')
    assert.ok(line.includes('~'))
  } finally {
    await w.cleanup()
  }
})

test('with only one Claude on the list the line says so, and with none it is "not found" as before', async () => {
  const w = await mailboxWorld()
  try {
    const two = await twoClaudes(w)
    const make = (folders) => ({
      find: (program, extra = {}) => findProgram(program, { env: {}, home: w.root, platform: process.platform, ...extra }),
      findAll: (program, extra = {}) => findEveryProgram(program, { env: {}, home: w.root, platform: process.platform, ...extra }),
      claudeFolders: folders
    })
    const one = await run(w, ['--preflight'], make([two.native]))
    assert.match(one.lines.find((line) => line.includes('on the fixed list')), /one copy on the fixed list - .*\(the runner uses this one\)$/)
    const none = await run(w, ['--preflight'], make([join(w.root, 'nowhere')]))
    assert.match(none.text, /PROBLEM Claude: Claude Code was not found/)
    assert.ok(!none.text.includes('on the fixed list'))
  } finally {
    await w.cleanup()
  }
})
