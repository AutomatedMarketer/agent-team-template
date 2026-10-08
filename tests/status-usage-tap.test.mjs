import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm, readdir, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  runTap,
  tapFilePath,
  readingFromStatusLine,
  shortLine,
  TAP_SCHEMA,
  REWRITE_AFTER_MS,
  earlierShell,
  shellFor
} from '../scripts/lib/status/tap.mjs'
import { makeFakeHome, fakeClaudeToken, FAKE_EMAIL, FAKE_UUID, FAKE_USERNAME } from './helpers/fake-home.mjs'
import { repoRoot } from './helpers/repo.mjs'

/* The status line tap. Claude Code hands every status line command a JSON description of the
   session on stdin - and, for Pro and Max, the official 5-hour and 7-day limit readings. The tap
   keeps ONLY those two readings, in a small file the collector picks up later. Everything else on
   stdin (the working folder, session ids, the transcript path, the model, the cost) is the kind of
   thing that must never leave the machine, so the tests below feed it exactly that and look. */

const run = promisify(execFile)
const NOW = Date.parse('2026-10-08T12:00:00Z')
const FIVE_HOUR_RESET = Math.floor(Date.parse('2026-10-08T14:30:00Z') / 1000)
const WEEK_RESET = Math.floor(Date.parse('2026-10-11T22:00:00Z') / 1000)

// What Claude Code sends, with every field the docs list that could identify a person or a project.
function statusLineInput(overrides = {}) {
  return {
    hook_event_name: 'Status',
    cwd: `/Users/${FAKE_USERNAME}/secret-client`,
    session_id: FAKE_UUID,
    session_name: 'secret-client-launch',
    prompt_id: FAKE_UUID,
    transcript_path: `/Users/${FAKE_USERNAME}/.claude/projects/-Users-${FAKE_USERNAME}-secret-client/${FAKE_UUID}.jsonl`,
    model: { id: 'claude-opus-5-5', display_name: 'Opus' },
    workspace: {
      current_dir: `C:\\Users\\${FAKE_USERNAME}\\secret-client`,
      project_dir: `/Users/${FAKE_USERNAME}/secret-client`,
      added_dirs: [`/Users/${FAKE_USERNAME}/other`],
      repo: { host: 'github.com', owner: FAKE_USERNAME, name: 'secret-client' }
    },
    version: '2.1.300',
    output_style: { name: 'default' },
    cost: { total_cost_usd: 1.23, total_duration_ms: 45000, total_lines_added: 156 },
    context_window: { used_percentage: 8 },
    rate_limits: {
      five_hour: { used_percentage: 18.04, resets_at: FIVE_HOUR_RESET, owner: FAKE_EMAIL },
      seven_day: { used_percentage: 49, resets_at: WEEK_RESET },
      spend_limit: { used_percentage: 62.8, resets_at: WEEK_RESET, used_usd: 314.12, limit_usd: 500, period: 'monthly' },
      [fakeClaudeToken()]: { used_percentage: 1 }
    },
    ...overrides
  }
}

async function tapIn(fake, input, extra = {}) {
  return runTap({
    input: typeof input === 'string' ? input : JSON.stringify(input),
    argv: [],
    home: fake.home,
    env: {},
    platform: 'linux',
    now: NOW,
    ...extra
  })
}

const tapFileOf = (fake, platform = 'linux', env = {}) => tapFilePath({ home: fake.home, env, platform })

// --- where the file lives -----------------------------------------------------------------------

test('the tap file lives in a per-user state folder, never in a repo', () => {
  const home = join('/', 'Users', 'someone')
  assert.equal(tapFilePath({ home, env: {}, platform: 'darwin' }), join(home, '.local', 'state', 'agent-status', 'claude-statusline.json'))
  assert.equal(tapFilePath({ home, env: {}, platform: 'linux' }), join(home, '.local', 'state', 'agent-status', 'claude-statusline.json'))
  const local = join('/', 'fake', 'AppData', 'Local')
  assert.equal(tapFilePath({ home, env: { LOCALAPPDATA: local }, platform: 'win32' }), join(local, 'agent-status', 'claude-statusline.json'))
  // No LOCALAPPDATA (a stripped environment): the usual place under the home folder.
  assert.equal(tapFilePath({ home, env: {}, platform: 'win32' }), join(home, 'AppData', 'Local', 'agent-status', 'claude-statusline.json'))
})

// The collector may run from a scheduler that has a thinner environment than the terminal, so
// the folder must not depend on a variable only the terminal sets.
test('the tap file ignores XDG_STATE_HOME, so the tap and a scheduled collector agree', () => {
  const home = join('/', 'Users', 'someone')
  assert.equal(
    tapFilePath({ home, env: { XDG_STATE_HOME: join('/', 'elsewhere') }, platform: 'linux' }),
    join(home, '.local', 'state', 'agent-status', 'claude-statusline.json')
  )
})

// --- what it keeps -------------------------------------------------------------------------------

test('only the 5-hour and 7-day readings are kept, as the contract window kinds', () => {
  assert.deepEqual(readingFromStatusLine(statusLineInput()), [
    { kind: 'five_hour', usedPercent: 18, resetsAt: '2026-10-08T14:30:00Z' },
    { kind: 'weekly_all', usedPercent: 49, resetsAt: '2026-10-11T22:00:00Z' }
  ])
})

test('no rate_limits (API key, or before the first reply) is no reading, not a zero', () => {
  assert.deepEqual(readingFromStatusLine(statusLineInput({ rate_limits: undefined })), [])
  assert.deepEqual(readingFromStatusLine({}), [])
  assert.deepEqual(readingFromStatusLine(null), [])
  assert.deepEqual(readingFromStatusLine('rate_limits'), [])
})

test('each window may be absent on its own, and the other is still kept', () => {
  const input = statusLineInput()
  delete input.rate_limits.five_hour
  assert.deepEqual(readingFromStatusLine(input), [{ kind: 'weekly_all', usedPercent: 49, resetsAt: '2026-10-11T22:00:00Z' }])
})

test('a window it does not fully understand is left out, never guessed', () => {
  for (const broken of [
    { used_percentage: '18', resets_at: FIVE_HOUR_RESET },
    { used_percentage: -1, resets_at: FIVE_HOUR_RESET },
    { used_percentage: Number.NaN, resets_at: FIVE_HOUR_RESET },
    { used_percentage: 5000, resets_at: FIVE_HOUR_RESET },
    { used_percentage: `C:\\Users\\${FAKE_USERNAME}`, resets_at: FIVE_HOUR_RESET },
    { used_percentage: 18, resets_at: 'soon' },
    { used_percentage: 18, resets_at: -5 },
    { used_percentage: null, resets_at: FIVE_HOUR_RESET },
    'eighteen'
  ]) {
    const input = statusLineInput()
    input.rate_limits.five_hour = broken
    assert.deepEqual(readingFromStatusLine(input).map((window) => window.kind), ['weekly_all'])
  }
})

test('a window with no reset time is kept without one', () => {
  const input = statusLineInput()
  delete input.rate_limits.seven_day.resets_at
  assert.deepEqual(readingFromStatusLine(input)[1], { kind: 'weekly_all', usedPercent: 49 })
})

test('the short line reads "5h 18% · wk 49%", or nothing at all', () => {
  assert.equal(shortLine(readingFromStatusLine(statusLineInput())), '5h 18% · wk 49%')
  assert.equal(shortLine([{ kind: 'weekly_all', usedPercent: 49.6 }]), 'wk 50%')
  assert.equal(shortLine([]), '')
})

// --- the file -------------------------------------------------------------------------------------

test('it writes { schema, capturedAt, windows } and nothing else', async () => {
  const fake = await makeFakeHome()
  try {
    const result = await tapIn(fake, statusLineInput())
    assert.equal(result.stdout, '5h 18% · wk 49%\n')
    const saved = JSON.parse(await readFile(tapFileOf(fake), 'utf8'))
    assert.deepEqual(saved, {
      schema: TAP_SCHEMA,
      capturedAt: '2026-10-08T12:00:00Z',
      windows: [
        { kind: 'five_hour', usedPercent: 18, resetsAt: '2026-10-08T14:30:00Z' },
        { kind: 'weekly_all', usedPercent: 49, resetsAt: '2026-10-11T22:00:00Z' }
      ]
    })
  } finally {
    await fake.cleanup()
  }
})

test('LEAK TEST: nothing from stdin but the two readings reaches the file or the status bar', async () => {
  const fake = await makeFakeHome()
  try {
    const result = await tapIn(fake, statusLineInput())
    const file = await readFile(tapFileOf(fake), 'utf8')
    const forbidden = [
      FAKE_USERNAME,
      FAKE_UUID,
      FAKE_EMAIL,
      fakeClaudeToken(),
      'secret-client',
      '/Users/',
      'C:\\',
      '.jsonl',
      'transcript',
      'Opus',
      'opus',
      'cwd',
      'session',
      'cost',
      'spend',
      '314',
      'github.com',
      'monthly',
      '2.1.300'
    ]
    for (const output of [file, result.stdout]) {
      for (const needle of forbidden) {
        assert.ok(!output.includes(needle), `the tap wrote a forbidden string (${needle.slice(0, 6)}...)`)
      }
    }
    // Every key in the file is one the format names - a walk, not a spot check.
    const keys = new Set()
    const walk = (value) => {
      if (Array.isArray(value)) return value.forEach(walk)
      if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key)
          walk(inner)
        }
      }
    }
    walk(JSON.parse(file))
    assert.deepEqual([...keys].sort(), ['capturedAt', 'kind', 'resetsAt', 'schema', 'usedPercent', 'windows'])
  } finally {
    await fake.cleanup()
  }
})

test('with no reading on stdin it writes nothing and prints nothing', async () => {
  const fake = await makeFakeHome()
  try {
    for (const input of [statusLineInput({ rate_limits: undefined }), '', 'not json', '{"rate_limits":', '[]']) {
      const result = await tapIn(fake, input)
      assert.equal(result.stdout, '')
    }
    assert.equal(existsSync(tapFileOf(fake)), false)
  } finally {
    await fake.cleanup()
  }
})

test('no reading on stdin leaves the last good reading in place', async () => {
  const fake = await makeFakeHome()
  try {
    await tapIn(fake, statusLineInput())
    const before = await readFile(tapFileOf(fake), 'utf8')
    await tapIn(fake, statusLineInput({ rate_limits: undefined }), { now: NOW + 3600_000 })
    assert.equal(await readFile(tapFileOf(fake), 'utf8'), before)
  } finally {
    await fake.cleanup()
  }
})

test('an unchanged reading is not rewritten within a minute, and is refreshed after', async () => {
  const fake = await makeFakeHome()
  try {
    await tapIn(fake, statusLineInput())
    const first = JSON.parse(await readFile(tapFileOf(fake), 'utf8'))
    const soon = await tapIn(fake, statusLineInput(), { now: NOW + REWRITE_AFTER_MS - 1000 })
    assert.equal(soon.wrote, false)
    assert.deepEqual(JSON.parse(await readFile(tapFileOf(fake), 'utf8')), first)
    const later = await tapIn(fake, statusLineInput(), { now: NOW + REWRITE_AFTER_MS + 1000 })
    assert.equal(later.wrote, true)
    assert.equal(JSON.parse(await readFile(tapFileOf(fake), 'utf8')).capturedAt, '2026-10-08T12:01:01Z')
  } finally {
    await fake.cleanup()
  }
})

test('a changed reading is written at once', async () => {
  const fake = await makeFakeHome()
  try {
    await tapIn(fake, statusLineInput())
    const input = statusLineInput()
    input.rate_limits.five_hour.used_percentage = 19
    const result = await tapIn(fake, input, { now: NOW + 5000 })
    assert.equal(result.wrote, true)
    assert.equal(JSON.parse(await readFile(tapFileOf(fake), 'utf8')).windows[0].usedPercent, 19)
  } finally {
    await fake.cleanup()
  }
})

test('the write is atomic: no temporary file is left beside the reading', async () => {
  const fake = await makeFakeHome()
  try {
    await tapIn(fake, statusLineInput())
    const input = statusLineInput()
    input.rate_limits.seven_day.used_percentage = 50
    await tapIn(fake, input, { now: NOW + 1000 })
    assert.deepEqual(await readdir(dirname(tapFileOf(fake))), ['claude-statusline.json'])
  } finally {
    await fake.cleanup()
  }
})

test('a broken earlier file is replaced, not trusted', async () => {
  const fake = await makeFakeHome()
  try {
    await mkdir(dirname(tapFileOf(fake)), { recursive: true })
    await writeFile(tapFileOf(fake), '{ broken')
    const result = await tapIn(fake, statusLineInput())
    assert.equal(result.wrote, true)
    assert.equal(JSON.parse(await readFile(tapFileOf(fake), 'utf8')).schema, TAP_SCHEMA)
  } finally {
    await fake.cleanup()
  }
})

test('it never throws and never prints an error, even when the folder cannot be made', async () => {
  const fake = await makeFakeHome()
  try {
    // A FILE where the state folder should be: mkdir fails, the tap still prints its line.
    await mkdir(join(fake.home, '.local', 'state'), { recursive: true })
    await writeFile(join(fake.home, '.local', 'state', 'agent-status'), 'in the way')
    const result = await tapIn(fake, statusLineInput())
    assert.equal(result.stdout, '5h 18% · wk 49%\n')
    assert.equal(result.wrote, false)
  } finally {
    await fake.cleanup()
  }
})

// --- chaining an existing status line ------------------------------------------------------------

test('--then hands the same stdin to the earlier command and prints only its output', async () => {
  const fake = await makeFakeHome()
  try {
    const raw = JSON.stringify(statusLineInput())
    const calls = []
    const result = await tapIn(fake, raw, {
      argv: ['--then', 'my-old-statusline --flag'],
      runThen: async (command, input) => {
        calls.push({ command, input })
        return 'old line one\nold line two\n'
      }
    })
    assert.deepEqual(calls, [{ command: 'my-old-statusline --flag', input: raw }])
    assert.equal(result.stdout, 'old line one\nold line two\n')
    // The reading is still saved.
    assert.equal(JSON.parse(await readFile(tapFileOf(fake), 'utf8')).windows.length, 2)
  } finally {
    await fake.cleanup()
  }
})

test('--then64 carries the earlier command in a form no shell can mangle', async () => {
  const fake = await makeFakeHome()
  try {
    const command = `jq -r '"[\\(.model.display_name)] \\(.cwd)"' && echo "$HOME" \`x\``
    const encoded = Buffer.from(command, 'utf8').toString('base64url')
    assert.match(encoded, /^[A-Za-z0-9_-]+$/)
    const seen = []
    await tapIn(fake, statusLineInput(), { argv: ['--then64', encoded], runThen: async (given) => { seen.push(given); return '' } })
    assert.deepEqual(seen, [command])
  } finally {
    await fake.cleanup()
  }
})

test('if the earlier command fails, the status bar stays clean', async () => {
  const fake = await makeFakeHome()
  try {
    const result = await tapIn(fake, statusLineInput(), {
      argv: ['--then', 'broken'],
      runThen: async () => {
        throw new Error(`spawn failed in /Users/${FAKE_USERNAME}`)
      }
    })
    assert.equal(result.stdout, '')
    assert.equal(existsSync(tapFileOf(fake)), true, 'the reading is saved regardless')
  } finally {
    await fake.cleanup()
  }
})

test('an unknown option is ignored rather than breaking the status line', async () => {
  const fake = await makeFakeHome()
  try {
    const result = await tapIn(fake, statusLineInput(), { argv: ['--colour', 'blue', '--then'] })
    assert.equal(result.stdout, '5h 18% · wk 49%\n')
  } finally {
    await fake.cleanup()
  }
})

// --- the real script, spawned against a fake home --------------------------------------------------

// The environment is built from nothing, so the real LOCALAPPDATA and HOME never reach the child.
function fakeEnv(fake, extra = {}) {
  const env = {
    HOME: fake.home,
    USERPROFILE: fake.home,
    LOCALAPPDATA: join(fake.home, 'AppData', 'Local'),
    PATH: process.env.PATH ?? '',
    ...extra
  }
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot
  return env
}

function spawnTap(fake, args, input, env = fakeEnv(fake)) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [join('scripts', 'usage-tap.mjs'), ...args], { cwd: repoRoot, env, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr })
    })
    child.stdin.end(input)
  })
}

test('the real script reads stdin, saves the reading in the fake home and prints the short line', async () => {
  const fake = await makeFakeHome()
  try {
    const now = Math.floor(Date.now() / 1000)
    const input = statusLineInput()
    input.rate_limits.five_hour.resets_at = now + 3600
    input.rate_limits.seven_day.resets_at = now + 86400
    const result = await spawnTap(fake, [], JSON.stringify(input))
    assert.equal(result.code, 0)
    assert.equal(result.stdout, '5h 18% · wk 49%\n')
    assert.equal(result.stderr, '')
    const file = tapFilePath({ home: fake.home, env: { LOCALAPPDATA: join(fake.home, 'AppData', 'Local') }, platform: process.platform })
    assert.equal(JSON.parse(await readFile(file, 'utf8')).windows.length, 2)
  } finally {
    await fake.cleanup()
  }
})

test('the real script exits 0 with nothing printed on rubbish input', async () => {
  const fake = await makeFakeHome()
  try {
    const result = await spawnTap(fake, [], '\u0000not json at all')
    assert.equal(result.code, 0)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
  } finally {
    await fake.cleanup()
  }
})

// --- which shell runs the earlier command ---------------------------------------------------------
//
// Found in review: on Windows the tap trusted only SHELL to find Git Bash, and Claude Code's
// environment has no SHELL - so an earlier command written for bash went to PowerShell and the
// person's old status line vanished. The installer now writes the shell it chose into the command
// (--then-shell), and the tap uses exactly that.

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const onlyGitBash = (path) => path === GIT_BASH

test('--then-shell is read from the command line, and only sh or powershell', () => {
  assert.equal(earlierShell(['--then-shell', 'sh', '--then64', 'eA']), 'sh')
  assert.equal(earlierShell(['--then-shell', 'powershell']), 'powershell')
  assert.equal(earlierShell(['--then-shell', 'cmd']), null)
  assert.equal(earlierShell([]), null)
})

test('on Windows, "sh" means Git Bash, found WITHOUT a SHELL variable', () => {
  assert.deepEqual(shellFor('win32', {}, onlyGitBash, 'sh'), [GIT_BASH, ['-c']])
  assert.deepEqual(shellFor('win32', { ProgramFiles: 'C:\\Program Files' }, onlyGitBash, 'sh'), [GIT_BASH, ['-c']])
  const custom = 'E:\\tools\\Git\\bin\\bash.exe'
  assert.deepEqual(shellFor('win32', { CLAUDE_CODE_GIT_BASH_PATH: custom }, (path) => path === custom, 'sh'), [custom, ['-c']])
})

test('on Windows, a command written for bash is never handed to PowerShell', () => {
  // No Git Bash to be found: the earlier line is not run at all, rather than run in the wrong shell.
  assert.equal(shellFor('win32', {}, () => false, 'sh'), null)
})

test('on Windows, "powershell" means PowerShell even when Git Bash is there', () => {
  assert.deepEqual(shellFor('win32', { SHELL: GIT_BASH }, onlyGitBash, 'powershell')[0], 'powershell.exe')
})

test('on a Mac or Linux the earlier command runs with /bin/sh', () => {
  assert.deepEqual(shellFor('darwin', {}, () => false, 'sh'), ['/bin/sh', ['-c']])
  assert.deepEqual(shellFor('linux', {}, () => false, null), ['/bin/sh', ['-c']])
})

test('a hand-wired --then with no --then-shell: Git Bash if it can be found, else PowerShell', () => {
  assert.deepEqual(shellFor('win32', {}, onlyGitBash, null), [GIT_BASH, ['-c']])
  assert.equal(shellFor('win32', {}, () => false, null)[0], 'powershell.exe')
})

test('the tap hands the recorded shell to whatever runs the earlier command', async () => {
  const fake = await makeFakeHome()
  try {
    const seen = []
    await tapIn(fake, statusLineInput(), {
      argv: ['--then-shell', 'powershell', '--then', 'x'],
      runThen: async (command, input, dialect) => { seen.push(dialect); return '' }
    })
    assert.deepEqual(seen, ['powershell'])
  } finally {
    await fake.cleanup()
  }
})

// Through a real shell: /bin/sh on a Mac or Linux, Git Bash on Windows - with NO SHELL variable,
// as in Claude Code's own environment.
const gitBash = process.platform === 'win32' ? [GIT_BASH].find((candidate) => existsSync(candidate)) : null

test('the real script chains a real earlier status line through the shell', { skip: process.platform === 'win32' && !gitBash ? 'no Git Bash at the usual place on this Windows computer' : false }, async () => {
  const fake = await makeFakeHome()
  const scratch = await mkdtemp(join(tmpdir(), 'agent-status-then-'))
  try {
    const earlier = join(scratch, 'earlier.mjs')
    await writeFile(earlier, "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const d=JSON.parse(s);console.log('earlier saw '+d.model.display_name)})\n")
    const quote = (text) => `'${text.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`
    const command = `${quote(process.execPath)} ${quote(earlier)}`
    const env = fakeEnv(fake)
    assert.equal(env.SHELL, undefined, 'this test must run without SHELL, as Claude Code does')
    const result = await spawnTap(fake, ['--then-shell', 'sh', '--then', command], JSON.stringify(statusLineInput()), env)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'earlier saw Opus')
  } finally {
    await rm(scratch, { recursive: true, force: true })
    await fake.cleanup()
  }
})
