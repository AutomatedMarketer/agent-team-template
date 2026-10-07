import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runCollector, collectUsage } from '../scripts/lib/status/run.mjs'
import { checkUsage } from '../scripts/lib/status/safe.mjs'
import { makeFakeHome, fakeClaudeToken, fetchStub, FAKE_EMAIL, FAKE_USERNAME, FAKE_HOSTNAME } from './helpers/fake-home.mjs'
import { hostileHome, echoingAnswer, FORBIDDEN, depsFor, runIn, filesUnder } from './helpers/hostile-home.mjs'
import { repoRoot } from './helpers/repo.mjs'

const run = promisify(execFile)

// --- plan test 1: the fake-token leak test, end to end ------------------------------------------------

test('LEAK TEST: nothing from the hostile home reaches the file, stdout or stderr', async () => {
  const fake = await hostileHome()
  try {
    const written = await runIn(fake, ['--computer', 'Test PC'])
    const dry = await runIn(fake, ['--computer', 'Test PC', '--dry-run'])
    // And a run where the server echoes the token back where a model name belongs.
    const hostileAnswer = echoingAnswer(fakeClaudeToken())
    hostileAnswer.limits[2].scope.model.display_name = fakeClaudeToken()
    const hostile = await runIn(fake, ['--computer', 'Test PC'], { fetch: fetchStub(() => ({ status: 200, body: hostileAnswer })) })

    assert.equal(written.code, 0, written.stderr)
    assert.equal(dry.code, 0, dry.stderr)
    assert.equal(hostile.code, 0, hostile.stderr)

    const outputs = [written.stdout, written.stderr, dry.stdout, dry.stderr, hostile.stdout, hostile.stderr]
    for (const result of [written, hostile]) {
      const files = await filesUnder(result.target)
      assert.equal(files.length, 1, 'exactly one file is written')
      outputs.push(await readFile(files[0], 'utf8'))
    }
    for (const output of outputs) {
      for (const needle of FORBIDDEN()) {
        assert.ok(!output.includes(needle), `an output contained a forbidden string (${needle.slice(0, 6)}...)`)
      }
    }

    // It did work - the leak test is not passing because nothing was written.
    const doc = JSON.parse(outputs[6])
    assert.equal(doc.claude.limits.source, 'unofficial-live')
    assert.equal(doc.claude.plan.name, 'Max 20x')
    assert.equal(doc.codex.plan.name, 'Pro')
    assert.equal(doc.codex.limits.windows[0].usedPercent, 3)
    assert.equal(doc.claude.activity.days[0].replies, 1)
    // The echoed-token run read the saved reading instead, which is also free of the token.
    assert.equal(JSON.parse(outputs[7]).claude.limits.source, 'claude-code-saved')
    for (const result of [written, dry, hostile]) await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('LEAK TEST: the token is sent to the usage address and nowhere else', async () => {
  const fake = await hostileHome()
  try {
    const deps = depsFor(fake)
    await collectUsage(deps, 'Test PC')
    assert.deepEqual(deps.fetch.calls.map((call) => call.url), ['https://api.anthropic.com/api/oauth/usage'])
  } finally {
    await fake.cleanup()
  }
})

// --- plan tests 4, 5, 8 ---------------------------------------------------------------------------------

test('an empty home is "not found" everywhere, with no usedPercent anywhere', async () => {
  const fake = await makeFakeHome()
  try {
    const deps = depsFor(fake)
    const doc = await collectUsage(deps, 'this computer')
    assert.deepEqual(doc, {
      schema: 'agent-status/usage/v1',
      takenAt: '2026-10-07T20:00:00Z',
      computer: 'this computer',
      claude: { plan: { status: 'not found' }, limits: { status: 'not found' }, activity: { status: 'not found' } },
      codex: { plan: { status: 'not found' }, limits: { status: 'not found' } }
    })
    assert.ok(!JSON.stringify(doc).includes('usedPercent'))
    assert.equal(deps.fetch.calls.length, 0)
    assert.deepEqual(checkUsage(doc, fake.identity), [])
  } finally {
    await fake.cleanup()
  }
})

test('every file carries the envelope, the label given, and is named after it', async () => {
  const fake = await makeFakeHome()
  try {
    const result = await runIn(fake, ['--computer', 'Mac Mini'])
    assert.equal(result.code, 0, result.stderr)
    const path = join(result.target, '.agent-team', 'status', 'usage', 'mac-mini.json')
    const doc = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(doc.schema, 'agent-status/usage/v1')
    assert.equal(doc.takenAt, '2026-10-07T20:00:00Z')
    assert.equal(doc.computer, 'Mac Mini')
    assert.match(result.stdout, /\.agent-team\/status\/usage\/mac-mini\.json/)
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('with no label the file says "this computer", never the hostname', async () => {
  const fake = await makeFakeHome()
  try {
    const result = await runIn(fake, [])
    assert.equal(result.code, 0, result.stderr)
    const doc = JSON.parse(await readFile(join(result.target, '.agent-team', 'status', 'usage', 'this-computer.json'), 'utf8'))
    assert.equal(doc.computer, 'this computer')
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('a hostile label is refused before anything is read or written', async () => {
  const fake = await hostileHome()
  try {
    for (const label of [FAKE_HOSTNAME, FAKE_EMAIL, '../../etc', 'x'.repeat(61), '!!!', `${FAKE_USERNAME} laptop`]) {
      const deps = depsFor(fake)
      const target = await mkdtemp(join(tmpdir(), 'agent-status-repo-'))
      const stderr = []
      const code = await runCollector({ argv: ['--computer', label], deps, repoRoot: target, out: () => {}, err: (line) => stderr.push(line) })
      assert.notEqual(code, 0, 'a hostile label was accepted')
      assert.equal(deps.fetch.calls.length, 0, 'sources were read before the label was checked')
      assert.deepEqual(await filesUnder(target), [])
      assert.ok(!stderr.join('\n').includes(label), 'the refusal repeated the label')
      await rm(target, { recursive: true, force: true })
    }
  } finally {
    await fake.cleanup()
  }
})

test('sources are labelled with where each reading came from', async () => {
  const fake = await hostileHome()
  try {
    const live = await collectUsage(depsFor(fake), 'Test PC')
    assert.equal(live.claude.limits.source, 'unofficial-live')
    const saved = await collectUsage(depsFor(fake, { fetch: fetchStub(() => ({ status: 500, body: {} })) }), 'Test PC')
    assert.equal(saved.claude.limits.source, 'claude-code-saved')
    assert.equal(saved.claude.activity.estimate, true)
    assert.equal(saved.codex.limits.source, 'codex-session-log')
  } finally {
    await fake.cleanup()
  }
})

test('a source that throws becomes "unavailable", and the message never reaches the output', async () => {
  const fake = await hostileHome()
  try {
    const throwing = async () => {
      throw new Error(`EACCES ${fake.home} ${FAKE_EMAIL}`)
    }
    const result = await runIn(fake, ['--computer', 'Test PC'], { fetch: throwing, sources: { codexLimits: throwing } })
    assert.equal(result.code, 0, result.stderr)
    const [file] = await filesUnder(result.target)
    const doc = JSON.parse(await readFile(file, 'utf8'))
    assert.deepEqual(doc.codex.limits, { status: 'unavailable', why: 'could not be read' })
    assert.ok(!(result.stdout + result.stderr).includes(FAKE_EMAIL))
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('if the gate refuses, nothing is written and the exit is not zero', async () => {
  const fake = await makeFakeHome()
  try {
    const leaky = async () => ({ status: 'found', name: FAKE_EMAIL })
    const result = await runIn(fake, ['--computer', 'Test PC'], { sources: { codexPlan: leaky } })
    assert.notEqual(result.code, 0)
    assert.deepEqual(await filesUnder(result.target), [])
    assert.match(result.stderr, /codex\.plan\.name/)
    assert.ok(!result.stderr.includes(FAKE_EMAIL))
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

// --- plan test 13 (part): a dry run writes nothing --------------------------------------------------------

test('--dry-run prints the file it would write and writes nothing', async () => {
  const fake = await hostileHome()
  try {
    const result = await runIn(fake, ['--computer', 'Test PC', '--dry-run'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(await filesUnder(result.target), [])
    const printed = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'), result.stdout.lastIndexOf('}') + 1))
    assert.equal(printed.computer, 'Test PC')
    await rm(result.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

test('options it does not know, and --only for anything but usage, are refused', async () => {
  const fake = await makeFakeHome()
  try {
    for (const args of [['--bogus'], ['--only', 'connections'], ['--computer']]) {
      const result = await runIn(fake, args)
      assert.notEqual(result.code, 0, `${args.join(' ')} was accepted`)
      assert.deepEqual(await filesUnder(result.target), [])
      await rm(result.target, { recursive: true, force: true })
    }
    const ok = await runIn(fake, ['--only', 'usage', '--dry-run'])
    assert.equal(ok.code, 0, ok.stderr)
    await rm(ok.target, { recursive: true, force: true })
  } finally {
    await fake.cleanup()
  }
})

// --- the real command line, against an empty home ---------------------------------------------------------

test('the command runs as a script, with a dry run that writes nothing into this repo', async () => {
  const fake = await makeFakeHome()
  try {
    const env = { ...process.env, HOME: fake.home, USERPROFILE: fake.home }
    delete env.CLAUDE_CONFIG_DIR
    delete env.CODEX_HOME
    const { stdout } = await run(process.execPath, ['scripts/collect-status.mjs', '--dry-run', '--computer', 'Script Test'], { cwd: repoRoot, env })
    assert.match(stdout, /"schema": "agent-status\/usage\/v1"/)
    assert.match(stdout, /Claude limits not found/)
    assert.equal(existsSync(join(repoRoot, '.agent-team', 'status', 'usage', 'script-test.json')), false)
  } finally {
    await fake.cleanup()
  }
})

test('package.json runs the collector as collect:status', async () => {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['collect:status'], 'node scripts/collect-status.mjs')
})
