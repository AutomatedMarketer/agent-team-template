import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { read, fromRoot } from './helpers/repo.mjs'

/* The file a LaunchAgent runs is thin: it only wires the real computer into the tested parts. These start it for real, in a
   home folder of its own, down the paths that never reach Claude, git or the network - the real Claude is never run on a
   development computer. */

const ENTRY = fromRoot('scripts', 'mailbox-runner.mjs')

async function start(args) {
  const home = await mkdtemp(join(tmpdir(), 'mailbox-entry-'))
  // A home folder of its own, and an environment with nothing of the person's in it.
  const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP }
  const result = spawnSync(process.execPath, [ENTRY, ...args], { env, encoding: 'utf8', timeout: 60_000, windowsHide: true })
  return { home, status: result.status, out: result.stdout, err: result.stderr, cleanup: () => rm(home, { recursive: true, force: true }) }
}

test('--help says how to use it and exits 0', async () => {
  const run = await start(['--help'])
  try {
    assert.equal(run.status, 0)
    assert.match(run.out, /Usage: node scripts\/mailbox-runner\.mjs/)
    assert.match(run.out, /--preflight/)
  } finally {
    await run.cleanup()
  }
})

test('a switch that is not one is a mistake: how to use it on the error stream, and exit 2', async () => {
  const run = await start(['--nope'])
  try {
    assert.equal(run.status, 2)
    assert.match(run.err, /Usage/)
    assert.equal(run.out, '')
  } finally {
    await run.cleanup()
  }
})

test('a tick on a computer with no allowlist says so in one line and exits 1 - and has asked nobody and made no claim', async () => {
  const run = await start(['--once'])
  try {
    assert.equal(run.status, 1)
    assert.equal(run.out.trim(), 'mailbox tick: unavailable (no-allowlist) - 0 claimed, 0 done, 0 refused, 0 failed')
    const state = join(run.home, '.local', 'state', 'agent-mailbox')
    assert.ok((await readdir(state)).includes('last-tick.json'), 'the owner can see when it last ran')
    await assert.rejects(access(join(state, 'claims')), 'nothing was claimed')
    assert.deepEqual(await readdir(join(run.home, '.local', 'share')).catch(() => []), [], 'no clone was made')
  } finally {
    await run.cleanup()
  }
})

test('the entry file reaches the machine only through the tested parts: git never asks for a password, and nothing else is imported', async () => {
  const text = await read('scripts/mailbox-runner.mjs')
  assert.ok(text.includes("GIT_TERMINAL_PROMPT: '0'"), 'git could stop to ask a question nobody is there to answer')
  const imports = [...text.matchAll(/^import .* from '([^']+)'$/gm)].map((match) => match[1]).sort()
  assert.deepEqual(imports, ['./lib/mailbox/command.mjs', './lib/status/programs.mjs', 'node:child_process', 'node:os', 'node:util'])
  assert.ok(!/ANTHROPIC|MAILBOX_(KEY|SECRET)/.test(text), 'the entry file reads no secret itself')
})
