import test from 'node:test'
import assert from 'node:assert/strict'
import { git, HELD_BY_SCANNER, RETRIES } from './helpers/git.mjs'
import { repoRoot } from './helpers/repo.mjs'

/* The tests' git retries one thing only: a virus scanner holding a file git has just written, which
   makes git's rename fail with "unable to write file ...: Permission denied" (tests/helpers/git.mjs
   says how it was found). Every other git failure must reach the test at once and unchanged, or a
   retry could hide exactly what a test is checking. */

test('the retry matches the scanner\'s hold and nothing else', () => {
  assert.equal(RETRIES, 4)
  for (const held of [
    'remote: error: unable to write file C:/T/remote.git/./objects/tmp_objdir-incoming-x/a4/2489: Permission denied',
    'error: unable to write file .git/objects/fb/0cf6ab0e0b: Permission denied',
    'error: unable to create temporary file: Permission denied'
  ]) assert.match(held, HELD_BY_SCANNER, held)
  for (const other of [
    ' ! [rejected]        main -> main (fetch first)',
    'error: failed to push some refs to origin',
    'fatal: not a git repository (or any of the parent directories): .git',
    'error: unable to write file x: No space left on device',
    'fatal: could not read Username: Permission denied (publickey)'
  ]) assert.doesNotMatch(other, HELD_BY_SCANNER, other)
})

test('any other git failure comes back at once, not after retries', async () => {
  const started = Date.now()
  await assert.rejects(git(['no-such-git-command'], repoRoot))
  // Four retries would wait 200 + 400 + 600 + 800 ms first.
  assert.ok(Date.now() - started < 1500, 'a failure that is not the scanner\'s was retried')
})
