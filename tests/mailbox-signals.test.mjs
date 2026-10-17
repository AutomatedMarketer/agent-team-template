import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { access, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { defaultPlaces } from '../scripts/lib/mailbox/places.mjs'
import { mailboxWorld } from './helpers/mailbox-world.mjs'
import { git } from './helpers/git.mjs'
import { main } from '../scripts/lib/mailbox/command.mjs'
import { runTick } from '../scripts/lib/mailbox/tick.mjs'
import { createLive, listenForSignals, signalHandler } from '../scripts/lib/mailbox/signals.mjs'
import { releaseLock } from '../scripts/lib/status/commit.mjs'
import { read } from './helpers/repo.mjs'
import { confinedClaude } from './helpers/mailbox-selftest-claude.mjs'

/* launchctl bootout, a logout or Ctrl-C ends the runner with a signal. Claude is in its own process group, so it would run on with no time
   limit, and the lock would stay for an hour. On a signal the runner kills Claude's group, releases the lock, leaves the order as it is for the
   next tick to settle by reading, and exits with a code that is not 0. */

const MINUTE = 60_000
const exists = (path) => access(path).then(() => true, () => false)

test('a signal kills every live Claude group, releases the lock, and exits non-zero - and a second signal changes nothing', async () => {
  const live = createLive()
  live.children.add(4242)
  live.children.add(4243)
  live.lock = '/state/lock'
  const killed = []
  const released = []
  const exited = []
  const handle = signalHandler(live, { kill: (pid, signal) => killed.push([pid, signal]), release: async (lock) => released.push(lock), exit: (code) => exited.push(code) })
  await handle('SIGTERM')
  await handle('SIGINT')
  assert.deepEqual(killed, [[4242, 'SIGKILL'], [4243, 'SIGKILL']])
  assert.deepEqual(released, ['/state/lock'])
  assert.deepEqual(exited, [143])
  assert.equal(live.stopping, true)
  assert.equal(live.children.size, 0)
  assert.equal(live.lock, null)
})

test('Ctrl-C exits 130, and a kill that throws (the group is already gone) does not stop the lock being released', async () => {
  const live = createLive()
  live.children.add(7)
  const exited = []
  let released = 0
  const handle = signalHandler(live, { kill: () => { throw new Error('already gone') }, release: async () => { released += 1 }, exit: (code) => exited.push(code) })
  await handle('SIGINT')
  assert.deepEqual(exited, [130])
  assert.equal(released, 1)
})

test('a signal during a run kills the Claude group, releases the lock, and leaves the order unknown: not ok, not failed, and not run again by the next tick', async () => {
  const w = await mailboxWorld()
  try {
    w.claude.script = w.claude.good
    const sent = w.send({ action: 'run', workflow: 'morning-intel' })
    const live = createLive()
    const killed = []
    const exited = []
    const handle = signalHandler(live, { kill: (pid, signal) => killed.push([pid, signal]), release: releaseLock, exit: (code) => exited.push(code) })
    // The signal comes while Claude is running. The group is killed, so the stand-in for Claude says nothing more and ends.
    let lockHeldWhenSignalled = null
    w.claude.script = async () => {
      lockHeldWhenSignalled = await exists(join(w.places.stateDir, 'lock'))
      await handle('SIGTERM')
      return []
    }
    await assert.rejects(runTick(w.ctx({ live })), /stopped by a signal/)
    assert.equal(lockHeldWhenSignalled, true, 'the lock was held when it came')
    assert.deepEqual(killed, [[4242, 'SIGKILL']], 'the Claude group was killed')
    assert.deepEqual(exited, [143])
    assert.equal(await exists(join(w.places.stateDir, 'lock')), false, 'the lock is released')
    assert.equal(await w.claimFile(sent.id, 'final.json'), null, 'no final word: it did not end ok, and it did not end failed')
    assert.equal((await w.claimFile(sent.id, 'receipt.json')).state, 'running')

    // The next tick settles it by reading, and never runs it again.
    w.clock.advance(5 * MINUTE)
    w.claude.script = async () => { throw new Error('Claude must not be started again') }
    const next = await runTick(w.ctx({ force: true }))
    assert.equal(next.state, 'done')
    const final = await w.claimFile(sent.id, 'final.json')
    assert.deepEqual([final.state, final.landed], ['unknown', false])
    assert.equal(w.claude.calls.length, 1)
    assert.equal((await w.inOrigin.log()).some((subject) => subject.startsWith('Mailbox order')), false, 'nothing of it was pushed')
  } finally {
    await w.cleanup()
  }
})

test('a signal that comes when the run had already pushed leaves the order unknown, and the next tick finds it landed by reading', async () => {
  const w = await mailboxWorld()
  try {
    w.claude.script = w.claude.good
    const sent = w.send({ action: 'run', workflow: 'morning-intel' })
    const live = createLive()
    const handle = signalHandler(live, { kill: () => {}, release: releaseLock, exit: () => {} })
    // The signal arrives just after the order's change was pushed, before its final word.
    const signalling = async (args, cwd) => {
      const done = await git(args, cwd)
      if (args.includes('push') && (await git(['log', '-1', '--format=%s', args.at(-1).split(':')[0]], cwd)).stdout.startsWith('Mailbox order')) await handle('SIGTERM')
      return done
    }
    await assert.rejects(runTick(w.ctx({ live, git: signalling })), /stopped by a signal/)
    assert.equal(await w.claimFile(sent.id, 'final.json'), null)
    assert.ok(await w.inOrigin.file('inbox/2026-10-12/morning-intel.md'), 'it had landed')
    w.clock.advance(5 * MINUTE)
    await runTick(w.ctx({ force: true }))
    const final = await w.claimFile(sent.id, 'final.json')
    assert.deepEqual([final.state, final.landed], ['unknown', true])
    assert.equal(w.claude.calls.length, 1)
  } finally {
    await w.cleanup()
  }
})

test('the command listens for SIGTERM and SIGINT on the process it is given, and a signal reaches the same handler: it kills, releases and exits', async () => {
  const w = await mailboxWorld()
  try {
    const proc = Object.assign(new EventEmitter(), { exit: (code) => { proc.exited = code } })
    const killed = []
    let lockAtExit = null
    w.claude.script = async () => {
      proc.emit('SIGTERM')
      // On a Mac the process ends at exit(), so the tick's own finally never runs: the handler must have released the lock by then.
      for (let turn = 0; turn < 400 && proc.exited === undefined; turn += 1) await new Promise((resolve) => setTimeout(resolve, 5))
      lockAtExit = await exists(join(w.places.stateDir, 'lock'))
      return []
    }
    w.send({ action: 'run', workflow: 'morning-intel' })
    const lines = []
    await main({ argv: ['--once'], ...w.ctx({ kill: (pid, signal) => killed.push([pid, signal]) }), codeDir: w.places.codeDir, out: (text) => lines.push(text), err: (text) => lines.push(text), proc })
    assert.equal(lockAtExit, false, 'the handler left the lock to the tick, whose finally never runs once the process has exited')
    assert.deepEqual(proc.listenerCount('SIGTERM'), 1)
    assert.deepEqual(proc.listenerCount('SIGINT'), 1)
    assert.deepEqual(killed, [[4242, 'SIGKILL']])
    assert.equal(proc.exited, 143)
    assert.equal(await exists(join(w.places.stateDir, 'lock')), false)
    assert.ok(lines.some((line) => line.includes('left as outcome unknown')))
    assert.equal((await readdir(join(w.places.stateDir, 'claims'))).filter((name) => name.endsWith('.claim')).length, 1)
  } finally {
    await w.cleanup()
  }
})

// The board on a student's computer runs the runner inside its own process (agent-cockpit local/runner.mjs): a signal handed to the
// runner there must stop Claude, but the process does not end, so the tick goes on until it unwinds. The lock must stay the tick's until
// then - released by the handler, a second taker (a second board, a --selftest by hand) would get it while the tick still works, and the
// tick's own cleanup would then delete THAT lock.
test('in a process that does not end on a signal (keepLockOnSignal), the handler kills Claude but leaves the lock to the tick, which releases it when it really ends', async () => {
  const w = await mailboxWorld()
  try {
    const proc = Object.assign(new EventEmitter(), { exit: (code) => { proc.exited = code } })
    const killed = []
    let lockWhileUnwinding = null
    w.claude.script = async () => {
      proc.emit('SIGTERM')
      for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve))
      lockWhileUnwinding = await exists(join(w.places.stateDir, 'lock'))
      return []
    }
    w.send({ action: 'run', workflow: 'morning-intel' })
    const lines = []
    const code = await main({ argv: ['--once'], ...w.ctx({ kill: (pid, signal) => killed.push([pid, signal]) }), codeDir: w.places.codeDir, out: (text) => lines.push(text), err: (text) => lines.push(text), proc, keepLockOnSignal: true })
    assert.deepEqual(killed, [[4242, 'SIGKILL']], 'Claude is still killed at once')
    assert.equal(lockWhileUnwinding, true, 'the lock was released while the tick was still running')
    assert.equal(await exists(join(w.places.stateDir, 'lock')), false, 'the tick released it when it ended')
    assert.equal(code, 1)
    assert.ok(lines.some((line) => line.includes('left as outcome unknown')))
    const claim = (await readdir(join(w.places.stateDir, 'claims'))).find((name) => name.endsWith('.claim'))
    assert.equal(await w.claimFile(claim.slice(0, -'.claim'.length), 'final.json'), null, 'the order is left for the next tick to settle by reading')
  } finally {
    await w.cleanup()
  }
})

test('the entry file hands the real process to the command, so a real signal is heard', async () => {
  const text = await read('scripts/mailbox-runner.mjs')
  assert.ok(text.includes('proc: process'))
  const listener = new EventEmitter()
  listenForSignals(listener, () => {})
  assert.deepEqual([listener.listenerCount('SIGTERM'), listener.listenerCount('SIGINT')], [1, 1])
})

/* ---------- the gaps the first handler left ------------------------------------------------------------------------------------ */

test('a signal that arrives during the version check right before a run: Claude is not started at all', async () => {
  const w = await mailboxWorld()
  try {
    w.claude.script = w.claude.good
    w.send({ action: 'run', workflow: 'morning-intel' })
    const live = createLive()
    const killed = []
    const exited = []
    // Releasing the lock takes a moment on a real disk, as here.
    const handle = signalHandler(live, { kill: (pid, signal) => killed.push([pid, signal]), release: async (lock) => { await new Promise((resolve) => setTimeout(resolve, 25)); await releaseLock(lock) }, exit: (code) => exited.push(code) })
    let versions = 0
    const exec = async (file, args) => {
      if (args[0] === '--version') {
        versions += 1
        if (versions === 2) handle('SIGTERM')
        return { stdout: '2.1.290 (Claude Code)\n', code: 0 }
      }
      if (args[0] === 'auth') return { stdout: JSON.stringify({ authMethod: 'claude.ai', loggedIn: true }), code: 0 }
      throw new Error('an unexpected program')
    }
    await assert.rejects(runTick(w.ctx({ live, exec })), /stopped by a signal/)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(w.claude.calls.length, 0, 'Claude was never started')
    assert.deepEqual(exited, [143])
    assert.equal(await exists(join(w.places.stateDir, 'lock')), false)
  } finally {
    await w.cleanup()
  }
})

test('a signal that arrives while Claude is being started: the process that was started is killed at once, never left running', async () => {
  const w = await mailboxWorld()
  try {
    w.claude.script = w.claude.good
    w.send({ action: 'run', workflow: 'morning-intel' })
    const live = createLive()
    const killed = []
    const starting = (...args) => {
      live.stopping = true
      return w.claudeSpawn(...args)
    }
    await assert.rejects(runTick(w.ctx({ live, spawn: starting, kill: (pid, signal) => killed.push([pid, signal]) })), /stopped by a signal/)
    assert.deepEqual(killed, [[4242, 'SIGKILL']])
  } finally {
    await w.cleanup()
  }
})

test('closing the Terminal (SIGHUP) is handled like SIGTERM, exit 129, and the command listens for it', async () => {
  const live = createLive()
  live.children.add(9)
  const exited = []
  const killed = []
  await signalHandler(live, { kill: (pid) => killed.push(pid), release: async () => {}, exit: (code) => exited.push(code) })('SIGHUP')
  assert.deepEqual([killed, exited], [[9], [129]])
  const w = await mailboxWorld()
  try {
    const proc = Object.assign(new EventEmitter(), { exit: () => {} })
    await main({ argv: ['--preflight'], ...w.ctx(), codeDir: w.places.codeDir, out: () => {}, err: () => {}, proc })
    assert.deepEqual(['SIGHUP', 'SIGINT', 'SIGTERM'].map((name) => proc.listenerCount(name)), [1, 1, 1])
  } finally {
    await w.cleanup()
  }
})

test('what is on disk at the moment a --selftest stopped by Ctrl-C exits: no further configuration is started, nothing is left in the home, temp or throwaway folders, and the next --selftest is not refused', async () => {
  const w = await mailboxWorld({ proof: false })
  try {
    const places = { ...defaultPlaces(w.root), codeDir: w.places.codeDir }
    const tmp = join(w.root, 'tmp')
    const selfFolder = join(dirname(places.workDir), 'selftest')
    const leftovers = async () => ({
      home: (await readdir(w.root)).filter((name) => name.startsWith('.mailbox-selftest-')),
      tmp: (await readdir(tmp).catch(() => [])).filter((name) => name.startsWith('mailbox-selftest-')),
      folder: await exists(selfFolder),
      inside: await readdir(selfFolder, { recursive: true }).catch(() => null)
    })
    // The real process ends AT exit(): what is on disk then is what stays behind. So the disk is read there, not while the first Claude still runs.
    let atExit = null
    const proc = Object.assign(new EventEmitter(), { exit: async (code) => { proc.exited = code; atExit = await leftovers() } })
    w.claude.script = async () => {
      // The signal arrives while the first Claude runs; the killed Claude ends at once and the first run finishes.
      proc.emit('SIGINT')
      return []
    }
    const lines = []
    await main({ argv: ['--selftest'], ...w.ctx({ log: (text) => lines.push(text) }), places, codeDir: w.places.codeDir, tmpDir: tmp, out: (text) => lines.push(text), err: (text) => lines.push(text), proc })
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(proc.exited, 130)
    assert.deepEqual(atExit, { home: [], tmp: [], folder: false, inside: null }, 'nothing left at the moment the process ends')
    assert.equal(w.claude.calls.length, 1, 'the second configuration was never started')
    assert.deepEqual(await leftovers(), { home: [], tmp: [], folder: false, inside: null }, 'and nothing was planted after it either')

    // Nothing is left to refuse the next self-test as a folder that is not its own.
    w.claude.script = confinedClaude(w)
    const again = await main({ argv: ['--selftest'], ...w.ctx(), places, codeDir: w.places.codeDir, tmpDir: tmp, out: (text) => lines.push(text), err: (text) => lines.push(text) })
    assert.equal(again, 0, lines.join(' | '))
  } finally {
    await w.cleanup()
  }
})
