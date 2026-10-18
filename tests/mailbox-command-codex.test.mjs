import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { access, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { mailboxWorld, ALLOWLIST, CLAUDE_FILE, T0 } from './helpers/mailbox-world.mjs'
import { main, parseArgs, USAGE } from '../scripts/lib/mailbox/command.mjs'
import { fakeCodex } from './helpers/fake-codex.mjs'
import { codexFolders, codexHomeOf } from '../scripts/lib/mailbox/codex.mjs'
import { CODEX_PROOF_FILE, keepCodexProof } from '../scripts/lib/mailbox/proof.mjs'

/* The switches a person uses by hand for Codex: --preflight says in plain words whether Codex can do the jobs the allowlist gives it,
   --codex-login signs the runner's own Codex home in (never ~/.codex), and --codex-selftest proves the walls. A computer whose
   allowlist gives no job to Codex is told Codex is not used, and nothing about Codex can make it "not ready". */

const CODEX_FILE = '/fake/bin/codex'
const CODEX_JOBS = '\n  - slug: morning-intel\n    minutes: 20\n  - slug: task-sweep\n    minutes: 30\n    worker: codex'
const exists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function capture() {
  const lines = []
  return { lines, out: (text) => lines.push(text), err: (text) => lines.push(text) }
}

async function withWorld({ allowlist = ALLOWLIST({ jobs: CODEX_JOBS }), codex = {}, proof = true } = {}, fn) {
  const w = await mailboxWorld({ allowlist })
  try {
    const fake = fakeCodex(codex)
    if (proof) await keepCodexProof({ stateDir: w.places.stateDir, codeDir: w.places.codeDir, version: [0, 160, 0], file: CODEX_FILE, now: () => T0 })
    const finds = []
    const run = async (argv, change = {}) => {
      const sink = capture()
      const exec = async (file, args, options) => (file === CODEX_FILE ? fake.exec(file, args, options) : w.exec(file, args, options))
      const code = await main({
        argv,
        ...w.ctx({ log: sink.out }),
        exec,
        find: async (name, where) => {
          finds.push({ name, where })
          return { state: 'found', path: name === 'codex' ? CODEX_FILE : CLAUDE_FILE }
        },
        spawn: fake.spawn,
        kill: fake.kill,
        codeDir: w.places.codeDir,
        tmpDir: join(w.root, 'tmp'),
        out: sink.out,
        err: sink.err,
        ...change
      })
      return { code, text: sink.lines.join('\n'), lines: sink.lines }
    }
    return await fn({ w, fake, run, finds })
  } finally {
    await w.cleanup()
  }
}

test('the Codex switches are known and in the usage text', () => {
  assert.deepEqual(parseArgs(['--codex-selftest']), { ok: true, mode: 'codex-selftest', force: false, paths: {} })
  assert.deepEqual(parseArgs(['--codex-login']), { ok: true, mode: 'codex-login', force: false, paths: {} })
  for (const bad of [['--codex-selftest', '--selftest'], ['--codex-login', '--once'], ['--codex']]) assert.equal(parseArgs(bad).ok, false, bad.join(' '))
  assert.match(USAGE, /--codex-selftest/)
  assert.match(USAGE, /--codex-login/)
})

test('Codex is looked for on its own fixed list of folders, with the work copy named so a copy inside the team repo is never run', () => withWorld({}, async ({ run, finds, w }) => {
  await run(['--preflight'])
  const asked = finds.filter((call) => call.name === 'codex')
  assert.ok(asked.length > 0)
  for (const call of asked) {
    assert.deepEqual(call.where.folders, codexFolders(w.root, process.platform))
    assert.equal(call.where.clone, w.places.workDir)
  }
}))

test('--preflight on a computer with a Codex job: every Codex part is a line, and when all hold, everything is ready', () => withWorld({}, async ({ run }) => {
  const good = await run(['--preflight'])
  assert.equal(good.code, 0, good.text)
  assert.match(good.text, /ok +Codex: found, version 0\.160\.0; it does task-sweep/)
  assert.match(good.text, /ok +Codex login: a ChatGPT login in the runner's own Codex home/)
  assert.match(good.text, /ok +Codex sandbox: it starts with the runner's walls/)
  assert.match(good.text, /ok +Codex API key: none set/)
  assert.match(good.text, /ok +Codex self-test: passed on 2026-10-12 for this Codex and these settings/)
  assert.equal(good.lines.at(-1), 'Everything is ready.')
}))

const PROBLEMS = [
  ['not signed in', { codex: { login: 'none' } }, /PROBLEM Codex login: .*--codex-login/],
  ['signed in with an API key', { codex: { login: 'apiKey' } }, /PROBLEM Codex login: .*ChatGPT/],
  ['too old', { codex: { version: 'codex-cli 0.155.0-alpha.16' } }, /PROBLEM Codex: Codex is too old: the walls need 0\.160\.0 or later/],
  ['whose sandbox does not start', { codex: { noSandbox: true } }, /PROBLEM Codex sandbox: /],
  ['with no self-test', { proof: false }, /PROBLEM Codex self-test: .*--codex-selftest/]
]
for (const [name, options, words] of PROBLEMS) {
  test(`--preflight finds a Codex ${name}, says so in words, and exits 1`, () => withWorld(options, async ({ run }) => {
    const result = await run(['--preflight'])
    assert.equal(result.code, 1)
    assert.match(result.text, words)
    assert.ok(!result.text.includes('sk-***'), 'nothing Codex printed about a key is repeated')
  }))
}

test('--preflight with an OpenAI key in the environment names it without its value', () => withWorld({}, async ({ run, w }) => {
  const result = await run(['--preflight'], { env: { HOME: w.root, PATH: '/usr/bin', OPENAI_API_KEY: 'sk-proj-not-real-1234' } })
  assert.equal(result.code, 1)
  assert.match(result.text, /PROBLEM Codex API key: /)
  assert.ok(!result.text.includes('sk-proj-not-real-1234'))
}))

test('--preflight on Windows says plainly that Codex is refused there without the container sandbox, and that Claude jobs are not affected', () => withWorld({ codex: { noSandbox: true } }, async ({ run }) => {
  const result = await run(['--preflight'], { platform: 'win32', privatePlaces: async () => ({ ok: true }) })
  assert.match(result.text, /PROBLEM Codex sandbox: .*container sandbox.*Claude jobs are not affected/)
}))

test('--preflight on a computer whose allowlist gives no job to Codex: Codex is not used, never looked for, and cannot make it not ready', () => withWorld({ allowlist: ALLOWLIST(), codex: { login: 'none' } }, async ({ run, finds }) => {
  const result = await run(['--preflight'])
  assert.equal(result.code, 0, result.text)
  assert.match(result.text, /ok +Codex: not used - no job in the allowlist says worker: codex/)
  assert.ok(!finds.some((call) => call.name === 'codex'))
}))

test('--preflight names a job given to Codex that needs the web: Codex never has it, so that job is not offered', () => withWorld({ allowlist: ALLOWLIST({ jobs: '\n  - slug: morning-intel\n    minutes: 20\n    worker: codex' }) }, async ({ run }) => {
  const result = await run(['--preflight'])
  assert.equal(result.code, 1)
  assert.match(result.text, /PROBLEM Codex: morning-intel needs the web, which Codex never has, so it is not offered/)
}))

test('--codex-selftest runs the Codex self-test and says so; a pass keeps the Codex proof', () => withWorld({ proof: false }, async ({ run, w }) => {
  const result = await run(['--codex-selftest'])
  assert.equal(result.code, 0, result.text)
  assert.match(result.lines[0], /^Codex self-test passed/)
  assert.ok(await exists(join(w.places.stateDir, CODEX_PROOF_FILE)))
}))

test('--codex-selftest that fails says what failed and that no Codex job runs until it passes', () => withWorld({ proof: false, codex: { leak: ['homeRead'] } }, async ({ run }) => {
  const result = await run(['--codex-selftest'])
  assert.equal(result.code, 1)
  assert.match(result.text, /Codex self-test FAILED/)
  assert.match(result.text, /the sandbox: /)
  assert.match(result.lines.at(-1), /No Codex job runs until a Codex self-test passes/)
}))

test('--codex-login starts `codex login --device-auth` in the runner\'s own Codex home, with the person\'s terminal, and never ~/.codex', () => withWorld({}, async ({ run, w }) => {
  const started = []
  const spawn = (file, args, options) => {
    started.push({ file, args, options })
    const child = new EventEmitter()
    setImmediate(() => child.emit('close', 0))
    return child
  }
  const result = await run(['--codex-login'], { spawn })
  assert.equal(result.code, 0, result.text)
  assert.equal(started.length, 1)
  assert.equal(started[0].file, CODEX_FILE)
  assert.deepEqual(started[0].args, ['login', '--device-auth'])
  assert.equal(started[0].options.stdio, 'inherit')
  assert.equal(started[0].options.shell, false)
  assert.equal(started[0].options.env.CODEX_HOME, codexHomeOf(w.places.stateDir))
  assert.ok(!Object.hasOwn(started[0].options.env, 'OPENAI_API_KEY'))
  const homeConfig = await readFile(join(codexHomeOf(w.places.stateDir), 'config.toml'), 'utf8')
  assert.ok(homeConfig.startsWith(await readFile(join(w.places.codeDir, '.agent-team', 'mailbox', 'codex-config.toml'), 'utf8')), 'the login is made with the runner\'s settings (a ChatGPT login, in a file)')
  assert.match(homeConfig, /trust_level = "untrusted"/, 'and with the work copy marked untrusted')
  assert.match(result.text, /signed in/i)
  const failed = await run(['--codex-login'], { spawn: (file, args, options) => { const child = new EventEmitter(); setImmediate(() => child.emit('close', 1)); return child } })
  assert.equal(failed.code, 1)
  const missing = await run(['--codex-login'], { find: async () => ({ state: 'not found' }) })
  assert.equal(missing.code, 1)
  assert.match(missing.text, /Codex was not found/)
  await rm(codexHomeOf(w.places.stateDir), { recursive: true, force: true })
}))
