import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* The drift check exists because of a real failure: this clone sat one commit behind while the
   cloud had already committed into the same repo. Nothing was broken and nothing said anything,
   so the next local edit was made against a stale copy.

   The tests below are all about what it must NOT do. A session-start hook that occasionally
   rewrites the file somebody is mid-thought about is a hook that gets deleted, and rightly. */

const source = await readFile(fileURLToPath(new URL('../scripts/check-drift.mjs', import.meta.url)), 'utf8')
const settings = JSON.parse(
  await readFile(fileURLToPath(new URL('../.claude/settings.json', import.meta.url)), 'utf8')
)

test('it fetches, and does nothing else to the repo', () => {
  assert.match(source, /'fetch'/, 'it has to fetch or it cannot know anything')
  for (const forbidden of ['pull', 'merge', 'rebase', 'reset', 'checkout', 'stash', 'clean']) {
    assert.ok(
      !new RegExp(`['"\`]${forbidden}['"\`]`).test(source),
      `check-drift runs git ${forbidden} — this hook must never change the working tree`
    )
  }
})

test('it reports both directions, so being ahead is visible too', () => {
  assert.match(source, /behind/)
  assert.match(source, /ahead/)
})

test('it says nothing has been changed, rather than leaving that to be assumed', () => {
  assert.match(source, /Nothing has been changed/)
})

test('it fails silent - a broken drift check must not break a session start', () => {
  assert.match(source, /catch\s*\{[\s\S]*process\.exit\(0\)/, 'the outer catch must exit clean')
})

test('a fresh git init with no remote is silent, not an error', () => {
  assert.match(source, /if \(!remotes\) process\.exit\(0\)/)
})

test('the hook is registered on SessionStart and runs the drift script', () => {
  const hooks = settings?.hooks?.SessionStart
  assert.ok(Array.isArray(hooks) && hooks.length, 'no SessionStart hook registered')
  const commands = hooks.flatMap((entry) => entry.hooks ?? []).map((hook) => hook.command)
  assert.ok(
    commands.some((command) => /check-drift\.mjs/.test(command)),
    `expected the drift check on SessionStart, got ${JSON.stringify(commands)}`
  )
})

test('no SessionStart hook writes to the repo', () => {
  const commands = (settings?.hooks?.SessionStart ?? []).flatMap((entry) => entry.hooks ?? []).map((hook) => hook.command)
  for (const command of commands) {
    for (const forbidden of ['git pull', 'git merge', 'git push', 'git reset', 'git checkout']) {
      assert.ok(!command.includes(forbidden), `a SessionStart hook runs "${forbidden}"`)
    }
  }
})

/* ---------- what a fetch is allowed to cost ---------------------------------------------------
   Verified behaviour, not a guess: pointed at an unroutable address, `git fetch` sat for 21.3
   seconds before giving up. That is 21 seconds of silence at the start of every session behind a
   captive portal or a dropped VPN - and a private repo with no cached credential can wait on a
   prompt that never comes at all. Failing silent is only a virtue if it fails promptly. */

test('a fetch is bounded, so a dead network cannot stall a session start', () => {
  assert.match(source, /timeout:\s*[A-Z_\d]/, 'the git child process has no timeout - a blackholed route hangs it')
  const deadline = /(?:DEADLINE|TIMEOUT)[A-Z_]*\s*=\s*(\d+)/.exec(source)
  assert.ok(deadline, 'the deadline should be a named constant, so its value is reviewable')
  assert.ok(Number(deadline[1]) > 0 && Number(deadline[1]) <= 15000,
    `a ${deadline[1]}ms deadline is not a deadline anybody would wait through at session start`)
})

test('git can never stop and ask for a password inside a session-start hook', () => {
  assert.match(source, /GIT_TERMINAL_PROMPT/, 'a private repo with no cached credential would wait on a prompt nobody sees')
})

/* ---------- the hook has to survive its own script being missing ------------------------------
   `node scripts/check-drift.mjs` cannot be guarded by the try/catch INSIDE that script. Check out
   any commit from before the script existed - or open the repo from anywhere the relative path
   does not resolve - and a session start greets you with a raw Node stack trace. */

test('the SessionStart hook is silent when its own script is not there', () => {
  const commands = (settings?.hooks?.SessionStart ?? []).flatMap((entry) => entry.hooks ?? []).map((hook) => hook.command)
  const drift = commands.find((command) => /check-drift/.test(command))
  assert.ok(drift, 'no drift command registered')

  const empty = mkdtempSync(join(tmpdir(), 'drift-absent-'))
  try {
    const result = spawnSync(drift, { cwd: empty, shell: true, encoding: 'utf8' })
    assert.equal(result.status, 0, `the hook exited ${result.status} when its script was absent`)
    const noise = `${result.stdout ?? ''}${result.stderr ?? ''}`
    assert.ok(!/Cannot find module|ERR_MODULE_NOT_FOUND|at [A-Za-z]/.test(noise),
      `a session start printed a stack trace:\n${noise}`)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})
