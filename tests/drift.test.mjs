import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

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
      !new RegExp(`'${forbidden}'`).test(source),
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
