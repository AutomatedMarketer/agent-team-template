import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm, readdir, mkdir, symlink, lstat, chmod, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  installTap,
  planInstall,
  planRemove,
  tapCommand,
  earlierFrom,
  tapPathFrom,
  dialectFor,
  settingsPathFor
} from '../scripts/lib/status/install-tap.mjs'
import { repoRoot } from './helpers/repo.mjs'

/* The installer puts the tap in front of whatever status line the person already has, in their
   own ~/.claude/settings.json. It is the one script here that edits a file outside the repo, so it
   is held to: only the statusLine key changes; a backup first; twice is the same as once; and
   --remove puts back exactly what was there.

   EVERY test here works in a temporary folder. None reads or writes the real settings.json: the
   library is handed an explicit home, and the one spawned run gets HOME, USERPROFILE and
   CLAUDE_CONFIG_DIR all pointing into a temporary folder. */

const run = promisify(execFile)
const NODE = '/opt/homebrew/bin/node'
const TAP = '/Users/someone/team/scripts/usage-tap.mjs'
const STAMP = Date.parse('2026-10-08T12:00:00Z')

async function tempHome() {
  const root = await mkdtemp(join(tmpdir(), 'agent-status-install-'))
  const home = join(root, 'home')
  await mkdir(join(home, '.claude'), { recursive: true })
  return { root, home, settings: join(home, '.claude', 'settings.json'), cleanup: () => rm(root, { recursive: true, force: true }) }
}

// The installer copies the tap out of `sourceTap` into the temporary home before pointing the
// status line at the copy, so `sourceTap` is the real script in this repo.
const deps = (temp, extra = {}) => ({
  home: temp.home,
  env: {},
  platform: 'darwin',
  nodePath: NODE,
  sourceTap: join(repoRoot, 'scripts', 'usage-tap.mjs'),
  now: STAMP,
  exists: () => false,
  ...extra
})

const someSettings = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  model: 'opus',
  permissions: { allow: ['Bash(npm test)'], deny: [] },
  statusLine: { type: 'command', command: `jq -r '"[\\(.model.display_name)] \\(.cwd)"'`, padding: 2 },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
  env: { SOME_FLAG: '1' }
}

const filesIn = async (dir) => (await readdir(dir)).sort()

// --- the command it writes ------------------------------------------------------------------------

test('the command uses absolute paths, quoted for the shell that will run it', () => {
  assert.equal(tapCommand({ nodePath: NODE, tapPath: TAP, dialect: 'sh' }), `'/opt/homebrew/bin/node' '/Users/someone/team/scripts/usage-tap.mjs'`)
  // Windows paths get forward slashes: Git Bash eats backslashes (Claude Code's docs say so).
  assert.equal(
    tapCommand({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', tapPath: "D:\\dev\\Bob's team\\scripts\\usage-tap.mjs", dialect: 'sh' }),
    `'C:/Program Files/nodejs/node.exe' 'D:/dev/Bob'\\''s team/scripts/usage-tap.mjs'`
  )
  // PowerShell runs a quoted path only with the call operator, and doubles a single quote.
  assert.equal(
    tapCommand({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', tapPath: "D:\\dev\\Bob's team\\scripts\\usage-tap.mjs", dialect: 'powershell' }),
    `& 'C:/Program Files/nodejs/node.exe' 'D:/dev/Bob''s team/scripts/usage-tap.mjs'`
  )
})

test('an earlier status line rides along encoded, so no shell can mangle its quotes', () => {
  const earlier = `jq -r '"[\\(.model.display_name)]"' | sed "s/x/$HOME/"`
  const command = tapCommand({ nodePath: NODE, tapPath: TAP, dialect: 'sh', earlier })
  assert.match(command, / --then64 [A-Za-z0-9_-]+$/)
  assert.equal(earlierFrom(command), earlier)
  assert.equal(earlierFrom(tapCommand({ nodePath: NODE, tapPath: TAP, dialect: 'sh' })), null)
})

// The tap must run the earlier command in the shell it was written for, and on Windows it cannot
// learn that from its environment (Claude Code passes no SHELL). So the installer writes it down.
test('the command records which shell the earlier status line is for', () => {
  const sh = tapCommand({ nodePath: NODE, tapPath: TAP, dialect: 'sh', earlier: 'old' })
  const ps = tapCommand({ nodePath: NODE, tapPath: TAP, dialect: 'powershell', earlier: 'old' })
  assert.match(sh, / --then-shell sh --then64 [A-Za-z0-9_-]+$/)
  assert.match(ps, / --then-shell powershell --then64 [A-Za-z0-9_-]+$/)
  assert.equal(earlierFrom(sh), 'old')
  assert.equal(earlierFrom(ps), 'old')
  assert.equal(tapPathFrom(ps), TAP)
  // No earlier status line, nothing to run, nothing to record.
  assert.doesNotMatch(tapCommand({ nodePath: NODE, tapPath: TAP, dialect: 'sh' }), /--then-shell/)
  // Recognised as its own on the next run, so it never wraps itself.
  const plan = planInstall({ settings: { statusLine: { type: 'command', command: ps } }, nodePath: NODE, tapPath: TAP, dialect: 'powershell' })
  assert.equal(plan.action, 'unchanged')
})

test('on Windows it writes for Git Bash when Git Bash is there, PowerShell when it is not', () => {
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe'
  assert.equal(dialectFor('darwin', {}, () => false), 'sh')
  assert.equal(dialectFor('linux', {}, () => false), 'sh')
  assert.equal(dialectFor('win32', { SHELL: bash }, (path) => path === bash), 'sh')
  assert.equal(dialectFor('win32', { CLAUDE_CODE_GIT_BASH_PATH: 'E:\\Git\\bin\\bash.exe' }, (path) => path === 'E:\\Git\\bin\\bash.exe'), 'sh')
  assert.equal(dialectFor('win32', { ProgramFiles: 'D:\\Programs' }, (path) => path === 'D:\\Programs\\Git\\bin\\bash.exe'), 'sh')
  assert.equal(dialectFor('win32', { SHELL: bash }, () => false), 'powershell')
  assert.equal(dialectFor('win32', {}, () => false), 'powershell')
})

test('CLAUDE_CONFIG_DIR is honoured for where settings.json lives', () => {
  const home = join(sep, 'Users', 'someone')
  assert.equal(settingsPathFor({ home, env: {} }), join(home, '.claude', 'settings.json'))
  assert.equal(settingsPathFor({ home, env: { CLAUDE_CONFIG_DIR: join(sep, 'elsewhere') } }), join(sep, 'elsewhere', 'settings.json'))
})

// --- the plan ---------------------------------------------------------------------------------------

test('install over an earlier status line keeps its other fields and chains its command', () => {
  const plan = planInstall({ settings: someSettings, nodePath: NODE, tapPath: TAP, dialect: 'sh' })
  assert.equal(plan.action, 'install')
  assert.equal(plan.next.statusLine.type, 'command')
  assert.equal(plan.next.statusLine.padding, 2)
  assert.equal(earlierFrom(plan.next.statusLine.command), someSettings.statusLine.command)
  // Every other key: the same values, in the same order.
  const others = (settings) => JSON.stringify(Object.entries(settings).filter(([key]) => key !== 'statusLine'))
  assert.equal(others(plan.next), others(someSettings))
  assert.deepEqual(Object.keys(plan.next), Object.keys(someSettings))
})

test('install with no status line adds one that runs the tap alone', () => {
  const plan = planInstall({ settings: { model: 'opus' }, nodePath: NODE, tapPath: TAP, dialect: 'sh' })
  assert.equal(plan.action, 'install')
  assert.deepEqual(plan.next, { model: 'opus', statusLine: { type: 'command', command: tapCommand({ nodePath: NODE, tapPath: TAP, dialect: 'sh' }) } })
})

test('install twice is the same as once - it never wraps itself', () => {
  const first = planInstall({ settings: someSettings, nodePath: NODE, tapPath: TAP, dialect: 'sh' })
  const second = planInstall({ settings: first.next, nodePath: NODE, tapPath: TAP, dialect: 'sh' })
  assert.equal(second.action, 'unchanged')
  // A moved repo or a new node updates the paths, still chaining the ORIGINAL earlier command.
  const moved = planInstall({ settings: first.next, nodePath: '/usr/local/bin/node', tapPath: '/Users/someone/new-place/scripts/usage-tap.mjs', dialect: 'sh' })
  assert.equal(moved.action, 'update')
  assert.equal(earlierFrom(moved.next.statusLine.command), someSettings.statusLine.command)
  assert.equal((moved.next.statusLine.command.match(/usage-tap\.mjs/g) ?? []).length, 1)
})

test('remove puts back exactly what was there', () => {
  for (const before of [someSettings, { model: 'opus' }, {}]) {
    const installed = planInstall({ settings: before, nodePath: NODE, tapPath: TAP, dialect: 'sh' })
    const removed = planRemove({ settings: installed.next })
    assert.equal(removed.action, 'remove')
    assert.deepEqual(removed.next, before)
    assert.deepEqual(Object.keys(removed.next), Object.keys(before))
  }
})

test('remove when the tap is not installed changes nothing', () => {
  assert.equal(planRemove({ settings: someSettings }).action, 'unchanged')
  assert.equal(planRemove({ settings: null }).action, 'unchanged')
})

test('a status line it cannot chain is refused, not overwritten', () => {
  for (const statusLine of [{ type: 'static', text: 'hi' }, { type: 'command', command: '' }, 'just a string', { type: 'command' }]) {
    assert.equal(planInstall({ settings: { statusLine }, nodePath: NODE, tapPath: TAP, dialect: 'sh' }).action, 'refuse')
  }
})

test('a tap someone wired by hand is left alone - installing or removing could drop their --then', () => {
  const byHand = { statusLine: { type: 'command', command: `node ~/team/scripts/usage-tap.mjs --then '~/.claude/statusline.sh'` } }
  assert.equal(planInstall({ settings: byHand, nodePath: NODE, tapPath: TAP, dialect: 'sh' }).action, 'refuse')
  assert.equal(planRemove({ settings: byHand }).action, 'refuse')
})

// --- the file ----------------------------------------------------------------------------------------

test('install writes a backup first, then changes only statusLine', async () => {
  const temp = await tempHome()
  try {
    const original = `${JSON.stringify(someSettings, null, 4)}\n`
    await writeFile(temp.settings, original)
    const result = await installTap(deps(temp))
    assert.equal(result.action, 'install')
    const files = await filesIn(join(temp.home, '.claude'))
    assert.deepEqual(files, ['settings.json', 'settings.json.before-usage-tap-2026-10-08T12-00-00Z.bak'])
    assert.equal(await readFile(join(temp.home, '.claude', files[1]), 'utf8'), original, 'the backup is the file as it was')
    const after = await readFile(temp.settings, 'utf8')
    assert.match(after, /^\{\n {4}"\$schema"/, 'the indentation the person uses is kept')
    assert.ok(after.endsWith('}\n'))
    const parsed = JSON.parse(after)
    assert.equal(earlierFrom(parsed.statusLine.command), someSettings.statusLine.command)
    for (const key of Object.keys(someSettings).filter((key) => key !== 'statusLine')) {
      assert.deepEqual(parsed[key], someSettings[key], `${key} changed`)
    }
  } finally {
    await temp.cleanup()
  }
})

test('running it twice writes nothing the second time and makes no second backup', async () => {
  const temp = await tempHome()
  try {
    await writeFile(temp.settings, JSON.stringify(someSettings, null, 2))
    await installTap(deps(temp))
    const afterFirst = await readFile(temp.settings, 'utf8')
    const second = await installTap(deps(temp, { now: STAMP + 60_000 }))
    assert.equal(second.action, 'unchanged')
    assert.equal(await readFile(temp.settings, 'utf8'), afterFirst)
    assert.equal((await filesIn(join(temp.home, '.claude'))).length, 2)
  } finally {
    await temp.cleanup()
  }
})

// Windows editors sometimes save a byte-order mark at the start. JSON.parse refuses it, so the
// file looked "not plain JSON" when it was. The mark is set aside to read the file, and kept, so
// nothing but statusLine changes.
test('a settings.json that starts with a byte-order mark is read, and the mark is kept', async () => {
  const temp = await tempHome()
  try {
    await writeFile(temp.settings, `﻿${JSON.stringify(someSettings, null, 2)}\n`)
    const result = await installTap(deps(temp))
    assert.equal(result.action, 'install')
    const text = await readFile(temp.settings, 'utf8')
    assert.ok(text.startsWith('﻿{'), 'the byte-order mark was dropped')
    assert.ok(JSON.parse(text.slice(1)).statusLine.command.includes('usage-tap.mjs'))
    await installTap(deps(temp, { remove: true, now: STAMP + 60_000 }))
    assert.deepEqual(JSON.parse((await readFile(temp.settings, 'utf8')).slice(1)), someSettings)
  } finally {
    await temp.cleanup()
  }
})

test('with no ~/.claude folder at all, it makes the folder rather than stopping on an error', async () => {
  const temp = await tempHome()
  try {
    await rm(join(temp.home, '.claude'), { recursive: true, force: true })
    const result = await installTap(deps(temp))
    assert.equal(result.action, 'install')
    assert.ok(JSON.parse(await readFile(temp.settings, 'utf8')).statusLine)
  } finally {
    await temp.cleanup()
  }
})

// Found in review: install then --remove within one second made the same backup name twice, and
// the second copy overwrote the first - the only copy of the original file.
test('two runs in the same second keep both backups, and the first still holds the original', async () => {
  const temp = await tempHome()
  try {
    const original = JSON.stringify(someSettings, null, 2)
    await writeFile(temp.settings, original)
    await installTap(deps(temp))
    await installTap(deps(temp, { remove: true }))
    await installTap(deps(temp))
    const backups = (await filesIn(join(temp.home, '.claude'))).filter((name) => name.endsWith('.bak'))
    assert.deepEqual(backups, [
      'settings.json.before-usage-tap-2026-10-08T12-00-00Z-2.bak',
      'settings.json.before-usage-tap-2026-10-08T12-00-00Z-3.bak',
      'settings.json.before-usage-tap-2026-10-08T12-00-00Z.bak'
    ])
    assert.equal(await readFile(join(temp.home, '.claude', 'settings.json.before-usage-tap-2026-10-08T12-00-00Z.bak'), 'utf8'), original)
  } finally {
    await temp.cleanup()
  }
})

test('--remove restores the earlier status line exactly, after its own backup', async () => {
  const temp = await tempHome()
  try {
    await writeFile(temp.settings, JSON.stringify(someSettings, null, 2))
    await installTap(deps(temp))
    const removed = await installTap(deps(temp, { remove: true, now: STAMP + 60_000 }))
    assert.equal(removed.action, 'remove')
    assert.deepEqual(JSON.parse(await readFile(temp.settings, 'utf8')), someSettings)
    assert.equal((await filesIn(join(temp.home, '.claude'))).length, 3, 'one backup before installing, one before removing')
  } finally {
    await temp.cleanup()
  }
})

test('with no settings.json it creates one holding only the status line', async () => {
  const temp = await tempHome()
  try {
    const result = await installTap(deps(temp))
    assert.equal(result.action, 'install')
    assert.equal(result.backup, null, 'there was nothing to back up')
    assert.deepEqual(Object.keys(JSON.parse(await readFile(temp.settings, 'utf8'))), ['statusLine'])
  } finally {
    await temp.cleanup()
  }
})

test('--dry-run says what would change and writes nothing at all', async () => {
  const temp = await tempHome()
  try {
    const original = JSON.stringify(someSettings, null, 2)
    await writeFile(temp.settings, original)
    const result = await installTap(deps(temp, { dryRun: true }))
    assert.equal(result.action, 'install')
    assert.ok(result.next.statusLine.command.includes('usage-tap.mjs'))
    assert.equal(await readFile(temp.settings, 'utf8'), original)
    assert.deepEqual(await filesIn(join(temp.home, '.claude')), ['settings.json'])
  } finally {
    await temp.cleanup()
  }
})

// Dotfile setups keep settings.json in a repo of their own and link it into ~/.claude. Renaming a
// new file over the link would replace the link with a plain file and quietly cut them off.
test('a settings.json that is a link stays a link, and the file it points to is the one changed', async (t) => {
  const temp = await tempHome()
  try {
    const real = join(temp.root, 'dotfiles', 'claude-settings.json')
    await mkdir(dirname(real), { recursive: true })
    await writeFile(real, JSON.stringify(someSettings, null, 2))
    try {
      await symlink(real, temp.settings, 'file')
    } catch (error) {
      t.skip(`this computer does not let a test make a file link (${error.code}) - NOT CHECKED here`)
      return
    }
    const result = await installTap(deps(temp))
    assert.equal(result.action, 'install')
    assert.ok((await lstat(temp.settings)).isSymbolicLink(), 'the link was replaced by a plain file')
    assert.ok(JSON.parse(await readFile(real, 'utf8')).statusLine.command.includes('usage-tap.mjs'), 'the linked file was not changed')
    assert.deepEqual((await readdir(dirname(real))).sort(), ['claude-settings.json'], 'a temporary file was left beside the real file')
    await installTap(deps(temp, { remove: true, now: STAMP + 60_000 }))
    assert.ok((await lstat(temp.settings)).isSymbolicLink())
    assert.deepEqual(JSON.parse(await readFile(real, 'utf8')), someSettings)
  } finally {
    await temp.cleanup()
  }
})

test('a private settings.json stays private: its permissions are kept', { skip: process.platform === 'win32' ? 'Windows has no Unix file modes - checked on a Mac or Linux' : false }, async () => {
  const temp = await tempHome()
  try {
    await writeFile(temp.settings, JSON.stringify(someSettings, null, 2))
    await chmod(temp.settings, 0o600)
    await installTap(deps(temp))
    assert.equal((await stat(temp.settings)).mode & 0o777, 0o600)
  } finally {
    await temp.cleanup()
  }
})

test('a settings.json that is not valid JSON is refused, untouched', async () => {
  const temp = await tempHome()
  try {
    await writeFile(temp.settings, '{ "model": "opus", // a comment\n }')
    const result = await installTap(deps(temp))
    assert.equal(result.action, 'refuse')
    assert.equal(await readFile(temp.settings, 'utf8'), '{ "model": "opus", // a comment\n }')
    assert.deepEqual(await filesIn(join(temp.home, '.claude')), ['settings.json'])
  } finally {
    await temp.cleanup()
  }
})

// --- the real script and the real shells ----------------------------------------------------------------

const tempEnv = (temp) => {
  // LOCALAPPDATA too: on Windows the tap's copy goes there, and it must be the temporary one.
  const env = { HOME: temp.home, USERPROFILE: temp.home, LOCALAPPDATA: join(temp.home, 'AppData', 'Local'), CLAUDE_CONFIG_DIR: join(temp.home, '.claude'), PATH: process.env.PATH ?? '' }
  // Windows PowerShell 5.1 starts and silently does nothing without these. A real Claude Code
  // session always has them; this hand-built environment has to add them.
  for (const name of ['SystemRoot', 'windir', 'PATHEXT', 'ComSpec']) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return env
}

test('the real script installs into a temporary home, and --remove undoes it', async () => {
  const temp = await tempHome()
  try {
    const env = tempEnv(temp)
    // Belt and braces: this test may only ever point the script at the temporary folder.
    assert.ok(env.CLAUDE_CONFIG_DIR.startsWith(tmpdir()))
    await writeFile(temp.settings, JSON.stringify(someSettings, null, 2))
    const dry = await run(process.execPath, [join('scripts', 'install-usage-tap.mjs'), '--dry-run'], { cwd: repoRoot, env })
    assert.match(dry.stdout, /Dry run/)
    assert.match(dry.stdout, /usage-tap\.mjs/)
    assert.deepEqual(JSON.parse(await readFile(temp.settings, 'utf8')), someSettings)
    const installed = await run(process.execPath, [join('scripts', 'install-usage-tap.mjs')], { cwd: repoRoot, env })
    assert.match(installed.stdout, /Installed/)
    assert.match(installed.stdout, /--remove/)
    const command = JSON.parse(await readFile(temp.settings, 'utf8')).statusLine.command
    assert.ok(command.includes('usage-tap.mjs'))
    assert.ok(command.includes(temp.home.replaceAll('\\', '/')), 'the tap was copied somewhere other than the temporary home')
    assert.ok(!command.includes(repoRoot.replaceAll('\\', '/').replace(/\/$/, '')), 'the status line runs the repo copy')
    const removed = await run(process.execPath, [join('scripts', 'install-usage-tap.mjs'), '--remove'], { cwd: repoRoot, env })
    assert.match(removed.stdout, /Removed/)
    assert.deepEqual(JSON.parse(await readFile(temp.settings, 'utf8')), someSettings)
  } finally {
    await temp.cleanup()
  }
})

// The command the installer writes, run by the shell Claude Code would run it with. This is what
// proves the quoting: a path with a space and an apostrophe, and an earlier command full of quotes.
async function runThroughShell(shell, flags, command, input, env) {
  return new Promise((resolve) => {
    const child = execFile(shell, [...flags, command], { env, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ error, stdout, stderr }))
    child.stdin.end(input)
  })
}

// The outer shell plays Claude Code. Neither run gets a SHELL variable: Claude Code's own
// environment has none, and the tap must find the right shell from the command alone.
const gitBash = process.platform === 'win32'
  ? ['C:\\Program Files\\Git\\bin\\bash.exe'].find((candidate) => existsSync(candidate))
  : '/bin/sh'
const powershell = process.platform === 'win32' ? 'powershell.exe' : null

for (const [name, shell, flags, dialect] of [
  ['sh / Git Bash', gitBash, ['-c'], 'sh'],
  ['PowerShell', powershell, ['-NoProfile', '-NonInteractive', '-Command'], 'powershell']
]) {
  test(`the written command runs through ${name}, chaining an earlier line with quotes in it`, { skip: !shell }, async () => {
    const temp = await tempHome()
    try {
      const odd = join(temp.root, "a folder's name")
      await mkdir(odd, { recursive: true })
      const earlierScript = join(odd, 'earlier.mjs')
      await writeFile(earlierScript, "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{console.log('earlier: '+JSON.parse(s).model.display_name)})\n")
      // An earlier command written for the same shell, with quotes and a space in it.
      const quoted = (text) => (dialect === 'powershell' ? `'${text.replaceAll('\\', '/').replaceAll("'", "''")}'` : `'${text.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`)
      const earlier = `${dialect === 'powershell' ? '& ' : ''}${quoted(process.execPath)} ${quoted(earlierScript)}`
      const command = tapCommand({ nodePath: process.execPath, tapPath: join(repoRoot, 'scripts', 'usage-tap.mjs'), dialect, earlier })
      const env = { ...tempEnv(temp), LOCALAPPDATA: join(temp.home, 'AppData', 'Local') }
      assert.equal(env.SHELL, undefined, 'this run must have no SHELL, as Claude Code has none')
      const input = JSON.stringify({ model: { display_name: 'Opus' }, rate_limits: { five_hour: { used_percentage: 18, resets_at: Math.floor(Date.now() / 1000) + 3600 } } })
      const result = await runThroughShell(shell, flags, command, input, env)
      assert.equal(result.stdout.trim(), 'earlier: Opus', result.stderr)
      const tapFile = process.platform === 'win32'
        ? join(env.LOCALAPPDATA, 'agent-status', 'claude-statusline.json')
        : join(temp.home, '.local', 'state', 'agent-status', 'claude-statusline.json')
      assert.equal(JSON.parse(await readFile(tapFile, 'utf8')).windows[0].usedPercent, 18)
    } finally {
      await temp.cleanup()
    }
  })
}
