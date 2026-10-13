import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { buildArgv } from '../scripts/lib/mailbox/claude.mjs'
import { configFromArgs, decide, parseRule } from './helpers/claude-permissions.mjs'
import { repoRoot } from './helpers/repo.mjs'

/* How Claude Code decides whether a file tool may touch a path, as its docs define it, written down once so that a fake Claude in
   the tests can apply it. A fake that only does what a test script tells it cannot notice a deny rule that refuses the folder
   the self-test works in. Sources: https://code.claude.com/docs/en/permissions (path patterns, "deny beats allow", a Read deny
   rule also blocks Edit from v2.1.208 and Write from v2.1.228), /permission-modes (dontAsk), /settings-reference
   (blockReadsOutsideWorkingDirectories, v2.1.257) and /cli-reference (--restricted, v2.1.248). */

const cwd = resolve('/work/selftest/1/repo')
const home = resolve('/home/me')
const settingsDir = resolve('/code/.agent-team/mailbox')

// A rule in the settings file reads a leading / from the folder the file is in, so a test that means "the folder Claude works in" says `settingsDir: cwd`.
// An allow list as the runner gives it, and nothing else, so each rule can be seen on its own.
const config = (change = {}) => ({ allow: ['Read(/**)', 'Edit(/**)'], deny: [], settingsDir, restricted: false, blockReads: false, mode: 'dontAsk', ...change })
const ask = (change, tool, path) => decide(config(change), { tool, path, cwd, home })
const inside = join(cwd, 'notes.txt')
const outside = resolve('/elsewhere/notes.txt')

test('a rule is a tool name, with a path pattern in brackets or without one', () => {
  assert.deepEqual(parseRule('Read(/**)'), { tool: 'Read', spec: '/**' })
  assert.deepEqual(parseRule('Edit(~/.ssh/**)'), { tool: 'Edit', spec: '~/.ssh/**' })
  assert.deepEqual(parseRule('WebSearch'), { tool: 'WebSearch', spec: null })
  assert.deepEqual(parseRule('mcp__*'), { tool: 'mcp__*', spec: null })
  for (const bad of ['', 'Read(', 'Read()', '(x)', 'Read(a)b', 5, null]) assert.equal(parseRule(bad), null, String(bad))
})

test('a leading / in a rule on the command line is the folder Claude is started in: inside it is allowed, anywhere else is not', () => {
  assert.deepEqual(ask({}, 'Read', inside), { allowed: true, confined: false, denyList: false, notAllowed: false })
  assert.equal(ask({}, 'Write', join(cwd, 'deeper', 'new.txt')).allowed, true, 'Edit covers Write')
  const out = ask({}, 'Read', outside)
  assert.deepEqual([out.allowed, out.notAllowed], [false, true])
  assert.equal(ask({}, 'Write', outside).allowed, false)
})

test('a tool name with no path is allowed everywhere - the mistake the path rules exist to avoid', () => {
  assert.equal(ask({ allow: ['Read', 'Edit'] }, 'Read', outside).allowed, true)
  assert.equal(ask({ allow: ['Read', 'Edit'] }, 'Write', outside).allowed, true)
})

test('~/ is the home folder, // is the root of the disk, and a plain path is relative to the folder Claude is started in', () => {
  assert.equal(ask({ allow: ['Read(~/notes/**)'] }, 'Read', join(home, 'notes', 'a.txt')).allowed, true)
  assert.equal(ask({ allow: ['Read(~/notes/**)'] }, 'Read', join(home, 'other', 'a.txt')).allowed, false)
  assert.equal(ask({ allow: ['Read(//elsewhere/**)'] }, 'Read', outside).allowed, true)
  assert.equal(ask({ allow: ['Read(notes.txt)'] }, 'Read', inside).allowed, true)
  assert.equal(ask({ allow: ['Read(./notes.txt)'] }, 'Read', inside).allowed, true)
  assert.equal(ask({ allow: ['Read(notes.txt)'] }, 'Read', join(cwd, 'sub', 'notes.txt')).allowed, false)
})

test('a * stays inside one folder and a ** goes through any number', () => {
  assert.equal(ask({ allow: ['Read(/*.txt)'] }, 'Read', inside).allowed, true)
  assert.equal(ask({ allow: ['Read(/*.txt)'] }, 'Read', join(cwd, 'sub', 'notes.txt')).allowed, false)
  assert.equal(ask({ allow: ['Read(/**/*.txt)'] }, 'Read', join(cwd, 'sub', 'deeper', 'notes.txt')).allowed, true)
})

test('deny beats allow: a deny rule that covers the folder Claude works in refuses it, though the allow rule names that very folder', () => {
  const denied = ask({ deny: ['Read(/**)'], settingsDir: cwd }, 'Read', inside)
  assert.deepEqual([denied.allowed, denied.denyList, denied.notAllowed], [false, true, false])
  const state = join(home, '.local', 'state', 'agent-mailbox', 'selftest', '1', 'repo')
  const inState = decide(config({ deny: ['Read(~/.local/state/**)'] }), { tool: 'Read', path: join(state, 'a.txt'), cwd: state, home })
  assert.deepEqual([inState.allowed, inState.denyList], [false, true], 'the self-test\'s own folder under the state folder')
})

test('a Read deny rule also blocks Edit and Write, an Edit deny rule blocks Write and not Read, and a Write rule needs no path', () => {
  assert.equal(ask({ deny: ['Read(/**)'], settingsDir: cwd }, 'Write', inside).denyList, true, 'Read deny blocks Write')
  assert.equal(ask({ deny: ['Read(/**)'], settingsDir: cwd }, 'Edit', inside).denyList, true, 'Read deny blocks Edit')
  assert.equal(ask({ deny: ['Edit(/**)'], settingsDir: cwd }, 'Write', inside).denyList, true, 'Edit deny blocks Write')
  assert.equal(ask({ deny: ['Edit(/**)'], settingsDir: cwd }, 'Read', inside).denyList, false, 'Edit deny does not block Read')
  assert.equal(ask({ deny: ['Write(/**)'], settingsDir: cwd }, 'Write', inside).denyList, false, 'a rule for Write that names a path is never consulted')
  assert.equal(ask({ deny: ['Write'] }, 'Write', inside).denyList, true, 'one with no path is')
  assert.equal(ask({ deny: ['Write'] }, 'Read', inside).denyList, false)
})

test('--restricted keeps the file tools in the folder Claude is started in, whatever the allow rules say', () => {
  const out = ask({ allow: ['Read', 'Edit'], restricted: true }, 'Read', outside)
  assert.deepEqual([out.allowed, out.confined], [false, true])
  assert.equal(ask({ allow: ['Read', 'Edit'], restricted: true }, 'Write', outside).confined, true)
  assert.equal(ask({ allow: ['Read', 'Edit'], restricted: true }, 'Write', inside).allowed, true)
})

test('a folder whose name only starts like the working folder is outside it, and so is the folder above', () => {
  const lookalike = `${cwd}-other`
  assert.equal(ask({ allow: ['Read', 'Edit'], restricted: true }, 'Read', join(lookalike, 'notes.txt')).confined, true)
  assert.equal(ask({ allow: ['Read', 'Edit'], restricted: true }, 'Read', resolve(cwd, '..', 'notes.txt')).confined, true)
  assert.equal(ask({ allow: ['Read', 'Edit'], restricted: true }, 'Read', cwd).confined, false, 'the folder itself')
})

test('a leading / in a deny rule of the settings file is the folder that file is in, not the folder Claude works in', () => {
  assert.equal(ask({ deny: ['Read(/**)'] }, 'Read', inside).denyList, false)
  assert.equal(ask({ deny: ['Read(/**)'] }, 'Read', join(settingsDir, 'claude-settings.json')).denyList, true)
})

test('blockReadsOutsideWorkingDirectories refuses a read outside the folder, and says nothing about a write', () => {
  const out = ask({ allow: ['Read', 'Edit'], blockReads: true }, 'Read', outside)
  assert.deepEqual([out.allowed, out.confined], [false, true])
  assert.equal(ask({ allow: ['Read', 'Edit'], blockReads: true }, 'Write', outside).allowed, true, 'a write is the allow rules\' business')
})

test('in dontAsk anything not allowed is refused, and a tool with no rule at all is refused', () => {
  assert.equal(ask({ allow: [] }, 'Read', inside).notAllowed, true)
  assert.equal(ask({ allow: ['Edit(/**)'] }, 'Read', inside).allowed, false, 'Edit does not allow Read')
  assert.equal(ask({ allow: ['Read(/**)'] }, 'Write', inside).allowed, false, 'Read does not allow Write')
})

test('read off a real argument list and the real settings file, the rules are the runner\'s: its own folder works, and the places a Mac keeps secrets do not', () => {
  const codeDir = repoRoot
  const args = buildArgv({ prompt: 'x', model: 'sonnet', codeDir, web: false })
  const real = configFromArgs(args)
  assert.equal(real.restricted, true)
  assert.equal(real.blockReads, true)
  assert.equal(real.mode, 'dontAsk')
  assert.deepEqual(real.allow, ['Read(/**)', 'Edit(/**)'])
  assert.ok(real.deny.includes('Read(~/.hermes/**)'))

  const folder = join(home, '.local', 'share', 'agent-mailbox', 'selftest', '1', 'repo')
  const here = (tool, path) => decide(real, { tool, path, cwd: folder, home })
  for (const tool of ['Read', 'Write']) assert.equal(here(tool, join(folder, 'inside.txt')).allowed, true, `${tool} in its own folder`)
  for (const [tool, path] of [['Read', join(home, '.hermes', '.env')], ['Read', join(home, '.codex', 'auth.json')], ['Write', join(home, '.local', 'share', 'agent-status', 'collector-code')], ['Read', resolve('/tmp/x')], ['Write', resolve('/tmp/x')]]) {
    assert.equal(here(tool, path).allowed, false, `${tool} ${path}`)
  }
})

test('the folders the runner works in are not covered by its own deny list: the work copy and the self-test\'s folder are not, the state folder is', () => {
  const real = configFromArgs(buildArgv({ prompt: 'x', model: 'sonnet', codeDir: repoRoot, web: false }))
  const share = join(home, '.local', 'share', 'agent-mailbox')
  const covered = (tool, folder, path) => decide(real, { tool, path, cwd: folder, home }).denyList
  for (const folder of [join(share, 'work'), join(share, 'selftest', '1', 'repo')]) {
    for (const tool of ['Read', 'Write']) assert.equal(covered(tool, folder, join(folder, 'a', 'b.txt')), false, `${tool} ${folder}`)
  }
  const state = join(home, '.local', 'state', 'agent-mailbox', 'selftest', '1', 'repo')
  assert.equal(covered('Read', state, join(state, 'a.txt')), true, 'the state folder is denied, so no self-test may work there')
  assert.equal(covered('Write', state, join(state, 'a.txt')), true)
})
