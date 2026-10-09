import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as realFs from 'node:fs/promises'
import { join } from 'node:path'
import { repoRoot } from './helpers/repo.mjs'
import { collectLaunchd, collectHermesJobs, collectJobs, machineZone, fitToFile, parseLaunchctlList, MAX_PLISTS_READ, HERMES_RESULT_WORDS } from '../scripts/lib/status/jobs.mjs'
import { checkJobs } from '../scripts/lib/status/safe.mjs'
import { JOBS_SCHEMA } from '../scripts/lib/status/jobs-schema.mjs'
import {
  makeFakeHome,
  setMtime,
  fakeClaudeToken,
  fakeRefreshToken,
  FAKE_EMAIL,
  FAKE_USERNAME,
  FAKE_HOSTNAME,
  FAKE_UUID
} from './helpers/fake-home.mjs'
import { writeHermes, fingerprint } from './helpers/hermes-home.mjs'
import { fakePrograms, launchctlTable } from './helpers/mac-programs.mjs'

/* The launchd half of the jobs part: which LaunchAgents a Mac has, how each is scheduled, whether
   launchd has it loaded and how its last run ended - and nothing else. A plist holds a great deal
   more (the program and its arguments, its environment settings with keys in them, folders with the
   username in them), and launchd's own logs hold whatever the job printed. Every test here runs the
   real code against a pretend home and a pretend plutil and launchctl; none starts a program. The
   clock is fixed because the due times in the answers depend on it. */

const fixture = JSON.parse(readFileSync(join(repoRoot, 'tests', 'fixtures', 'jobs-parity.json'), 'utf8'))
const NOW = Date.parse('2026-10-09T15:00:00Z')
const ZONE = 'America/New_York'
const MINUTE = 60_000
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

// A Mac's home with a plist file for each name given (their contents are only ever read by plutil,
// which is pretend here), plus any other files.
async function macHome(names, others = {}) {
  const files = { ...others }
  for (const name of names) files[`Library/LaunchAgents/${name}`] = '<plist version="1.0"><dict/></plist>'
  return makeFakeHome(files)
}

const stateDirOf = (fake) => join(fake.root, 'state')
function depsFor(fake, exec, extra = {}) {
  return { home: fake.home, env: {}, platform: 'darwin', now: NOW, timezone: ZONE, identity: fake.identity, stateDir: stateDirOf(fake), exec, ...extra }
}

// A recording stand-in for node:fs/promises. A property outside `allowed` throws the moment it is
// reached, so a test that wants "nothing but stat and readdir" does not depend on the code being
// polite about it.
function recordingFs(allowed) {
  const used = []
  const proxy = new Proxy({}, {
    get(_, name) {
      if (name === 'used') return used
      if (!allowed.includes(name)) throw new Error(`the code reached for fs.${String(name)}`)
      return async (...args) => {
        used.push({ name, path: String(args[0]) })
        return realFs[name](...args)
      }
    }
  })
  return proxy
}
const usedOn = (fs, name) => fs.used.filter((entry) => entry.name === name).map((entry) => entry.path)

// --- the table launchctl prints ------------------------------------------------------------------------------

test('launchctl list: the header is skipped; a dash means no process or no exit status; a negative status is a signal', () => {
  const rows = parseLaunchctlList(launchctlTable([
    ['-', 0, 'local.donna.story-belt-daily'],
    ['4242', 0, 'local.donna.security-changelog'],
    ['-', 78, 'com.donna.blog-watch'],
    ['515', '-', 'local.donna.new-service'],
    ['-', -15, 'ai.hermes.gateway-donna']
  ]))
  assert.deepEqual([...rows.entries()], [
    ['local.donna.story-belt-daily', { running: false, status: 0 }],
    ['local.donna.security-changelog', { running: true, status: 0 }],
    ['com.donna.blog-watch', { running: false, status: 78 }],
    ['local.donna.new-service', { running: true, status: null }],
    ['ai.hermes.gateway-donna', { running: false, status: -15 }]
  ])
})

test('launchctl list: lines that are not a row are ignored, Windows line ends are read, and text that is not a table is no table', () => {
  assert.equal(parseLaunchctlList(`PID\tStatus\tLabel\r\n-\t0\tlocal.a\r\nnot a row at all\r\n\r\n-\t1\tlocal.b\r\n`).size, 2)
  assert.equal(parseLaunchctlList('PID\tStatus\tLabel\n-\t0\tlocal.a\n-\t0\tlocal.a\n').size, 1, 'a label is listed once')
  assert.equal(parseLaunchctlList('PID\tStatus\tLabel\n').size, 0, 'an empty table is a table with no jobs')
  assert.equal(parseLaunchctlList(''), null)
  assert.equal(parseLaunchctlList('launchctl: command not found'), null)
  assert.equal(parseLaunchctlList(undefined), null)
})

// --- where it looks -------------------------------------------------------------------------------------------

test('off a Mac, launchd is not found and nothing is read or run', async () => {
  const fake = await macHome(['local.a.plist'])
  try {
    for (const platform of ['win32', 'linux']) {
      const exec = fakePrograms({ plists: { 'local.a.plist': { Label: 'local.a' } }, launchctl: launchctlTable([]) })
      const fs = recordingFs([])
      assert.deepEqual(await collectLaunchd(depsFor(fake, exec, { platform, fs }), ZONE), { status: 'not found' })
      assert.equal(exec.calls.length, 0)
    }
  } finally {
    await fake.cleanup()
  }
})

test('a Mac with no LaunchAgents folder: not found; a folder with no plists: found, with nothing in it', async () => {
  const fake = await makeFakeHome()
  try {
    const exec = fakePrograms({ launchctl: launchctlTable([]) })
    assert.deepEqual(await collectLaunchd(depsFor(fake, exec), ZONE), { status: 'not found' })
    await fake.write('Library/LaunchAgents/notes.txt', 'not a plist')
    await fake.write('Library/LaunchAgents/.hidden.plist', 'a dot file is not read')
    assert.deepEqual(await collectLaunchd(depsFor(fake, exec), ZONE), { status: 'found', items: [], hidden: 0, more: 0 })
    assert.ok(!exec.calls.some((call) => call.file === '/usr/bin/plutil'), 'plutil was run on something that is not a plist')
  } finally {
    await fake.cleanup()
  }
})

test('only the user\'s own LaunchAgents folder is read, never /Library, by two absolute programs from the empty folder', async () => {
  const fake = await macHome(['local.donna.a.plist', 'local.donna.b.plist'])
  try {
    const exec = fakePrograms({
      plists: { 'local.donna.a.plist': { Label: 'local.donna.a', RunAtLoad: true }, 'local.donna.b.plist': { Label: 'local.donna.b', RunAtLoad: true } },
      launchctl: launchctlTable([])
    })
    const fs = recordingFs(['readdir', 'stat'])
    await collectLaunchd(depsFor(fake, exec, { fs }), ZONE)
    const agents = join(fake.home, 'Library', 'LaunchAgents')
    assert.deepEqual(usedOn(fs, 'readdir'), [agents], 'it listed some other folder')
    assert.deepEqual([...new Set(exec.calls.map((call) => call.file))].sort(), ['/bin/launchctl', '/usr/bin/plutil'])
    const converted = exec.calls.filter((call) => call.file === '/usr/bin/plutil').map((call) => call.args[4])
    assert.deepEqual(converted.sort(), [join(agents, 'local.donna.a.plist'), join(agents, 'local.donna.b.plist')])
    for (const call of exec.calls) {
      assert.ok(call.file.startsWith('/'), 'a program was not given by absolute path')
      assert.ok(call.args.every((arg) => !arg.includes('/Library/LaunchDaemons') && !arg.startsWith('/Library')), 'it looked in /Library')
      assert.equal(call.options.cwd, join(stateDirOf(fake), 'empty-cwd'), 'a program ran outside the empty folder')
      assert.ok(call.options.timeout > 0 && call.options.timeout <= 10_000)
      assert.ok(call.options.maxOutput > 0 && call.options.maxOutput <= 1024 * 1024)
    }
  } finally {
    await fake.cleanup()
  }
})

// --- the answer for an ordinary Mac -------------------------------------------------------------------------------

const ORDINARY = {
  'local.donna.story-belt-daily.plist': { Label: 'local.donna.story-belt-daily', StartCalendarInterval: { Hour: 6, Minute: 15 }, RunAtLoad: false },
  'com.donna.blog-watch.plist': { Label: 'com.donna.blog-watch', StartInterval: 900 },
  'local.donna.security-changelog.plist': { Label: 'local.donna.security-changelog', RunAtLoad: true, KeepAlive: false },
  'local.donna.keeper.plist': { Label: 'local.donna.keeper', KeepAlive: true },
  'local.donna.paused-draft.plist': { Label: 'local.donna.paused-draft', StartCalendarInterval: { Weekday: 1, Hour: 9, Minute: 0 }, Disabled: true },
  'local.donna.agent-status-collector.plist': { Label: 'local.donna.agent-status-collector', StartCalendarInterval: [0, 3, 6, 9, 12, 15, 18, 21].map((Hour) => ({ Hour, Minute: 0 })), RunAtLoad: true },
  'local.donna.retry-job.plist': { Label: 'local.donna.retry-job', KeepAlive: { SuccessfulExit: false } },
  'local.donna.both.plist': { Label: 'local.donna.both', StartInterval: 600, StartCalendarInterval: { Minute: 0 } },
  'local.donna.nothing.plist': { Label: 'local.donna.nothing', ProgramArguments: ['/bin/true'] },
  'local.donna.weekday-brief.plist': { Label: 'local.donna.weekday-brief', StartCalendarInterval: [1, 2, 3, 4, 5].map((Weekday) => ({ Weekday, Hour: 7, Minute: 45 })) }
}
const ORDINARY_TABLE = launchctlTable([
  ['-', 0, 'local.donna.story-belt-daily'],
  ['-', 78, 'com.donna.blog-watch'],
  ['4242', 0, 'local.donna.security-changelog'],
  ['4300', '-', 'local.donna.keeper'],
  ['-', 0, 'local.donna.agent-status-collector'],
  ['-', 0, 'local.donna.retry-job'],
  ['-', 0, 'local.donna.both'],
  ['-', 0, 'local.donna.nothing'],
  ['-', 0, 'com.apple.something.else']
])

test('an ordinary Mac: each job with its cadence, state, last exit and due times; nothing else', async () => {
  const fake = await macHome(Object.keys(ORDINARY))
  try {
    const exec = fakePrograms({ plists: ORDINARY, launchctl: ORDINARY_TABLE })
    const block = await collectLaunchd(depsFor(fake, exec, { env: { XPC_SERVICE_NAME: 'local.donna.agent-status-collector' } }), ZONE)
    assert.deepEqual(checkJobs({ schema: JOBS_SCHEMA, takenAt: iso(NOW), computer: 'Mac Mini', timezone: ZONE, launchd: block, hermes: { status: 'not found' } }, fake.identity), [])
    assert.equal(block.status, 'found')
    assert.deepEqual([block.hidden, block.more], [0, 0])
    const byLabel = Object.fromEntries(block.items.map((item) => [item.label, item]))
    assert.deepEqual(block.items.map((item) => item.label), Object.values(ORDINARY).map((plist) => plist.Label).sort(), 'sorted by label')

    assert.deepEqual(byLabel['local.donna.story-belt-daily'], {
      label: 'local.donna.story-belt-daily',
      cadence: { kind: 'slots', slots: [{ minute: 15, hour: 6 }] },
      state: 'loaded',
      lastExit: 0,
      dueAt: '2026-10-09T10:15:00Z',
      dueBeforeAt: '2026-10-08T10:15:00Z'
    })
    assert.deepEqual(byLabel['com.donna.blog-watch'], {
      label: 'com.donna.blog-watch',
      cadence: { kind: 'every', minutes: 15 },
      state: 'loaded',
      lastExit: 78,
      dueAt: '2026-10-09T14:15:00Z',
      dueBeforeAt: '2026-10-09T14:00:00Z'
    })
    assert.deepEqual(byLabel['local.donna.security-changelog'], { label: 'local.donna.security-changelog', cadence: { kind: 'always' }, state: 'running', lastExit: 0 })
    assert.deepEqual(byLabel['local.donna.keeper'], { label: 'local.donna.keeper', cadence: { kind: 'always' }, state: 'running' }, 'a dash is no exit status')
    // Not in launchctl's list: not loaded. Disabled counts only when it is true AND the job is not loaded.
    assert.deepEqual(byLabel['local.donna.paused-draft'], { label: 'local.donna.paused-draft', cadence: { kind: 'slots', slots: [{ minute: 0, hour: 9, weekday: 1 }] }, state: 'not loaded', disabled: true })
    assert.deepEqual(byLabel['local.donna.weekday-brief'].state, 'not loaded')
    assert.equal(byLabel['local.donna.weekday-brief'].disabled, undefined)
    assert.equal(byLabel['local.donna.weekday-brief'].lastExit, undefined)
    assert.equal(byLabel['local.donna.weekday-brief'].dueAt, '2026-10-09T11:45:00Z')
    // The collector's own row.
    assert.equal(byLabel['local.donna.agent-status-collector'].self, true)
    assert.equal(byLabel['local.donna.agent-status-collector'].dueAt, '2026-10-09T13:00:00Z')
    assert.equal(byLabel['local.donna.agent-status-collector'].dueBeforeAt, '2026-10-09T10:00:00Z')
    assert.equal(block.items.filter((item) => item.self).length, 1)
    // A schedule it cannot read is unknown: a retry-on-failure KeepAlive, two schedules at once, none at all.
    for (const label of ['local.donna.retry-job', 'local.donna.both', 'local.donna.nothing']) {
      assert.deepEqual(byLabel[label].cadence, { kind: 'unknown' }, label)
      assert.equal(byLabel[label].dueAt, undefined, label)
    }
    // A job launchctl lists that no plist here names is never written.
    assert.ok(!JSON.stringify(block).includes('com.apple.something.else'))
  } finally {
    await fake.cleanup()
  }
})

test('the same Mac in a different order gives the same bytes', async () => {
  const names = Object.keys(ORDINARY)
  const answers = []
  for (const order of [names, [...names].reverse()]) {
    const fake = await macHome(order)
    try {
      answers.push(JSON.stringify(await collectLaunchd(depsFor(fake, fakePrograms({ plists: ORDINARY, launchctl: ORDINARY_TABLE })), ZONE)))
    } finally {
      await fake.cleanup()
    }
  }
  assert.equal(answers[0], answers[1])
})

test('Disabled means switched off only for a job that is not loaded', async () => {
  const fake = await macHome(['local.donna.on.plist', 'local.donna.off.plist'])
  try {
    const plists = {
      'local.donna.on.plist': { Label: 'local.donna.on', StartInterval: 3600, Disabled: true },
      'local.donna.off.plist': { Label: 'local.donna.off', StartInterval: 3600, Disabled: true }
    }
    const block = await collectLaunchd(depsFor(fake, fakePrograms({ plists, launchctl: launchctlTable([['-', 0, 'local.donna.on']]) })), ZONE)
    const byLabel = Object.fromEntries(block.items.map((item) => [item.label, item]))
    assert.equal(byLabel['local.donna.on'].disabled, undefined, 'it is loaded, so it is on')
    assert.ok(byLabel['local.donna.on'].dueAt)
    assert.equal(byLabel['local.donna.off'].disabled, true)
    assert.equal(byLabel['local.donna.off'].dueAt, undefined, 'a switched-off job has no due time')
  } finally {
    await fake.cleanup()
  }
})

test('self is the label launchd put in XPC_SERVICE_NAME, and only that', async () => {
  const fake = await macHome(['local.donna.a.plist', 'local.donna.b.plist'])
  try {
    const plists = { 'local.donna.a.plist': { Label: 'local.donna.a', RunAtLoad: true }, 'local.donna.b.plist': { Label: 'local.donna.b', RunAtLoad: true } }
    const selfOf = async (env) => (await collectLaunchd(depsFor(fake, fakePrograms({ plists, launchctl: launchctlTable([]) }), { env }), ZONE)).items.filter((item) => item.self).map((item) => item.label)
    assert.deepEqual(await selfOf({ XPC_SERVICE_NAME: 'local.donna.b' }), ['local.donna.b'])
    assert.deepEqual(await selfOf({ XPC_SERVICE_NAME: 'local.donna.' }), [])
    assert.deepEqual(await selfOf({ XPC_SERVICE_NAME: '0' }), [], 'a Terminal sets it to 0')
    assert.deepEqual(await selfOf({}), [])
    assert.deepEqual(await selfOf({ XPC_SERVICE_NAME: ['local.donna.a'] }), [])
  } finally {
    await fake.cleanup()
  }
})

// --- logs: the time they were last written, and nothing else ---------------------------------------------------------

test('the last report is the newest modified time of the two log files; their contents are never opened', async () => {
  const fake = await macHome(['local.donna.a.plist', 'local.donna.b.plist', 'local.donna.c.plist', 'local.donna.d.plist'])
  try {
    const out = await fake.write('Library/Logs/a.out.log', `log-secret-words ${fakeClaudeToken()}`)
    const err = await fake.write('Library/Logs/a.err.log', `log-secret-words ${FAKE_EMAIL}`)
    const lone = await fake.write('Library/Logs/b.out.log', 'log-secret-words')
    const future = await fake.write('Library/Logs/d.out.log', 'log-secret-words')
    await setMtime(out, NOW - 90 * MINUTE)
    await setMtime(err, NOW - 20 * MINUTE)
    await setMtime(lone, NOW - 3 * 3600_000)
    await setMtime(future, NOW + 3 * 86_400_000)
    const plists = {
      'local.donna.a.plist': { Label: 'local.donna.a', RunAtLoad: true, StandardOutPath: out, StandardErrorPath: err },
      'local.donna.b.plist': { Label: 'local.donna.b', RunAtLoad: true, StandardOutPath: lone, StandardErrorPath: join(fake.home, 'Library', 'Logs', 'missing.err.log') },
      // A relative path, a folder, a device and a made-up type are not log files.
      'local.donna.c.plist': { Label: 'local.donna.c', RunAtLoad: true, StandardOutPath: 'relative/out.log', StandardErrorPath: join(fake.home, 'Library', 'Logs') },
      'local.donna.d.plist': { Label: 'local.donna.d', RunAtLoad: true, StandardOutPath: future, StandardErrorPath: 42 }
    }
    const fs = recordingFs(['readdir', 'stat'])
    const block = await collectLaunchd(depsFor(fake, fakePrograms({ plists, launchctl: launchctlTable([]) }), { fs }), ZONE)
    const at = Object.fromEntries(block.items.map((item) => [item.label, item.lastReportAt]))
    assert.equal(at['local.donna.a'], iso(NOW - 20 * MINUTE), 'the newer of the two')
    assert.equal(at['local.donna.b'], iso(NOW - 3 * 3600_000), 'a log that is not there is not a time')
    assert.equal(at['local.donna.c'], undefined)
    assert.equal(at['local.donna.d'], undefined, 'a time days in the future is a broken clock, not a report')
    // The files were looked at, never opened: only readdir and stat were reachable at all.
    assert.deepEqual(usedOn(fs, 'stat').sort(), [
      join(fake.home, 'Library', 'Logs'),
      lone,
      join(fake.home, 'Library', 'Logs', 'missing.err.log'),
      out,
      err,
      future
    ].sort())
    const text = JSON.stringify(block)
    for (const word of ['log-secret-words', fakeClaudeToken(), FAKE_EMAIL, 'Logs', '.log']) assert.ok(!text.includes(word), `the answer holds ${word}`)
  } finally {
    await fake.cleanup()
  }
})

// --- names ----------------------------------------------------------------------------------------------------------

test('a label that fails the name rule is dropped and counted, not written; the same label twice is one', async () => {
  const names = [
    ['ok.plist', 'local.donna.ok'],
    ['mail.plist', `local.${FAKE_EMAIL}`],
    ['user.plist', `local.${FAKE_USERNAME}.sync`],
    ['host.plist', `com.${FAKE_HOSTNAME}.agent`],
    ['key.plist', `local.${fakeClaudeToken()}`],
    ['slash.plist', 'local/donna.job'],
    ['uuid.plist', FAKE_UUID],
    ['desk.plist', 'local.desk-helper'],
    ['long.plist', 'local.abcdefghijklmnopqrstuvwxyz0123'],
    ['space.plist', 'local donna job'],
    ['empty.plist', ''],
    ['number.plist', 7],
    ['dup-a.plist', 'local.donna.twice'],
    ['dup-b.plist', 'local.donna.twice']
  ]
  const fake = await macHome(names.map(([file]) => file))
  try {
    const plists = Object.fromEntries(names.map(([file, Label]) => [file, { Label, RunAtLoad: true }]))
    plists['nolabel.plist'] = { RunAtLoad: true }
    await fake.write('Library/LaunchAgents/nolabel.plist', '<plist/>')
    const block = await collectLaunchd(depsFor(fake, fakePrograms({ plists, launchctl: launchctlTable([]) })), ZONE)
    assert.deepEqual(block.items.map((item) => item.label), ['local.donna.ok', 'local.donna.twice'])
    assert.equal(block.hidden, 13, 'eleven bad labels, the file with no label, and the second of the twins')
    assert.equal(block.more, 0)
    const text = JSON.stringify(block)
    for (const word of [FAKE_EMAIL, FAKE_USERNAME, FAKE_HOSTNAME, fakeClaudeToken(), FAKE_UUID, 'desk-helper']) assert.ok(!text.includes(word), `the answer holds ${word}`)
  } finally {
    await fake.cleanup()
  }
})

test('a plist plutil cannot read, or does not answer as an object, is hidden and the rest are still read', async () => {
  const fake = await macHome(['local.donna.good.plist', 'broken.plist', 'array.plist', 'text.plist', 'null.plist'])
  try {
    const plists = {
      'local.donna.good.plist': { Label: 'local.donna.good', RunAtLoad: true },
      'broken.plist': new Error(`plutil: ${FAKE_EMAIL} is not a plist`),
      'array.plist': '[{"Label": "local.donna.array"}]',
      'text.plist': '{ this is not json',
      'null.plist': 'null'
    }
    const block = await collectLaunchd(depsFor(fake, fakePrograms({ plists, launchctl: launchctlTable([]) })), ZONE)
    assert.deepEqual(block.items.map((item) => item.label), ['local.donna.good'])
    assert.equal(block.hidden, 4)
    assert.ok(!JSON.stringify(block).includes(FAKE_EMAIL))
  } finally {
    await fake.cleanup()
  }
})

test('launchd that cannot be asked is unavailable, with a reason and nothing else', async () => {
  const fake = await macHome(['local.donna.good.plist'])
  try {
    const plists = { 'local.donna.good.plist': { Label: 'local.donna.good', RunAtLoad: true } }
    assert.deepEqual(await collectLaunchd(depsFor(fake, fakePrograms({ plists, launchctlFails: true })), ZONE), { status: 'unavailable', why: 'could not be read' })
    assert.deepEqual(await collectLaunchd(depsFor(fake, fakePrograms({ plists, launchctl: 'launchctl: not a table' })), ZONE), { status: 'unavailable', why: 'could not be read' })
    // No state folder to run programs from, or no way to run them.
    assert.deepEqual(await collectLaunchd(depsFor(fake, fakePrograms({ plists, launchctl: launchctlTable([]) }), { stateDir: undefined }), ZONE), { status: 'unavailable', why: 'could not be read' })
    assert.deepEqual(await collectLaunchd(depsFor(fake, undefined), ZONE), { status: 'unavailable', why: 'could not be read' })
    // A folder that cannot be listed is not "not found".
    const fs = { readdir: async () => { throw Object.assign(new Error(`EACCES /Users/${FAKE_USERNAME}`), { code: 'EACCES' }) }, stat: realFs.stat }
    const refused = await collectLaunchd(depsFor(fake, fakePrograms({ plists, launchctl: launchctlTable([]) }), { fs }), ZONE)
    assert.deepEqual(refused, { status: 'unavailable', why: 'could not be read' })
  } finally {
    await fake.cleanup()
  }
})

// --- caps ---------------------------------------------------------------------------------------------------------------

test('60 jobs at most are written, the first 60 by label; the rest are counted in more', async () => {
  const labels = Array.from({ length: 63 }, (_, index) => `local.donna.job-${String(index).padStart(2, '0')}`)
  const fake = await macHome(labels.map((label) => `${label}.plist`))
  try {
    const plists = Object.fromEntries(labels.map((label) => [`${label}.plist`, { Label: label, RunAtLoad: true }]))
    const block = await collectLaunchd(depsFor(fake, fakePrograms({ plists, launchctl: launchctlTable([]) })), ZONE)
    assert.equal(block.items.length, fixture.caps.launchd)
    assert.equal(block.more, 3)
    assert.deepEqual(block.items.map((item) => item.label), labels.slice(0, 60))
    assert.deepEqual(checkJobs({ schema: JOBS_SCHEMA, takenAt: iso(NOW), computer: 'Mac Mini', timezone: ZONE, launchd: block, hermes: { status: 'not found' } }, fake.identity), [])
  } finally {
    await fake.cleanup()
  }
})

test('a folder of hundreds of plists is only read so far; the rest are counted in more', async () => {
  const total = MAX_PLISTS_READ + 25
  const files = Array.from({ length: total }, (_, index) => `app.vendor-${String(index).padStart(3, '0')}.plist`)
  const fake = await macHome(files)
  try {
    const exec = fakePrograms({ plists: Object.fromEntries(files.map((file) => [file, { Label: file.replace(/\.plist$/, ''), RunAtLoad: true }])), launchctl: launchctlTable([]) })
    const block = await collectLaunchd(depsFor(fake, exec), ZONE)
    assert.equal(exec.calls.filter((call) => call.file === '/usr/bin/plutil').length, MAX_PLISTS_READ)
    assert.equal(block.items.length, fixture.caps.launchd)
    assert.equal(block.more, total - fixture.caps.launchd)
    assert.equal(MAX_PLISTS_READ, 200)
  } finally {
    await fake.cleanup()
  }
})

// --- the zone -------------------------------------------------------------------------------------------------------------

test('with no zone, jobs are still listed with their cadence but have no due times', async () => {
  const fake = await macHome(['local.donna.story-belt-daily.plist'])
  try {
    const plists = { 'local.donna.story-belt-daily.plist': ORDINARY['local.donna.story-belt-daily.plist'] }
    const block = await collectLaunchd(depsFor(fake, fakePrograms({ plists, launchctl: launchctlTable([['-', 0, 'local.donna.story-belt-daily']]) })), null)
    assert.deepEqual(block.items, [{ label: 'local.donna.story-belt-daily', cadence: { kind: 'slots', slots: [{ minute: 15, hour: 6 }] }, state: 'loaded', lastExit: 0 }])
  } finally {
    await fake.cleanup()
  }
})

// --- the hostile Mac -----------------------------------------------------------------------------------------------------------

test('a plist full of secrets: arguments, environment settings, folders, logs and extra keys never reach the answer', async () => {
  const token = fakeClaudeToken()
  const refresh = fakeRefreshToken()
  const home = `/Users/${FAKE_USERNAME}`
  const names = ['local.donna.story-belt-daily.plist', 'local.donna.hostile-calendar.plist', `local.${FAKE_USERNAME}.private.plist`]
  const fake = await macHome(names)
  try {
    const out = await fake.write('Library/Logs/secret-client.out.log', `log-secret-words ${token} ${home}/secret-client`)
    const err = await fake.write('Library/Logs/secret-client.err.log', `log-secret-words ${FAKE_EMAIL}`)
    await setMtime(out, NOW - 40 * MINUTE)
    await setMtime(err, NOW - 50 * MINUTE)
    const baggage = {
      ProgramArguments: [`${home}/bin/run`, '--token', token, `--owner=${FAKE_EMAIL}`],
      Program: `${home}/bin/run`,
      EnvironmentVariables: { ANTHROPIC_API_KEY: token, DB_PASSWORD: refresh, OWNER: FAKE_EMAIL, PATH: `${home}/bin:/usr/bin` },
      WorkingDirectory: `${home}/secret-client`,
      UserName: FAKE_USERNAME,
      GroupName: 'staff',
      Sockets: { Listeners: { SockServiceName: 'secret-client-port' } },
      MachServices: { 'com.secret-client.service': true },
      WatchPaths: [`${home}/secret-client/inbox`],
      StandardInPath: `${home}/secret-client/in`,
      ProcessType: 'Background',
      Nice: 5,
      ThrottleInterval: 30,
      AbandonProcessGroup: true,
      LimitLoadToSessionType: 'Aqua'
    }
    const plists = {
      'local.donna.story-belt-daily.plist': {
        ...baggage,
        Label: 'local.donna.story-belt-daily',
        StartCalendarInterval: { Hour: 6, Minute: 15 },
        StandardOutPath: out,
        StandardErrorPath: err
      },
      // A schedule with a secret where a number should be, and one with a secret as an extra key.
      'local.donna.hostile-calendar.plist': {
        ...baggage,
        Label: 'local.donna.hostile-calendar',
        StartCalendarInterval: [{ Hour: 6, Minute: token }, { Hour: 7, Minute: 0, [token]: 'x', note: 'secret-client' }]
      },
      [`local.${FAKE_USERNAME}.private.plist`]: { ...baggage, Label: `local.${FAKE_USERNAME}.private`, RunAtLoad: true }
    }
    const exec = fakePrograms({ plists, launchctl: launchctlTable([['-', 0, 'local.donna.story-belt-daily'], ['-', 0, 'local.donna.hostile-calendar'], ['-', 0, `local.${FAKE_USERNAME}.private`]]) })
    const fs = recordingFs(['readdir', 'stat'])
    const block = await collectLaunchd(depsFor(fake, exec, { fs }), ZONE)
    const doc = { schema: JOBS_SCHEMA, takenAt: iso(NOW), computer: 'Mac Mini', timezone: ZONE, launchd: block, hermes: { status: 'not found' } }
    assert.deepEqual(checkJobs(doc, fake.identity), [], 'the gate refused the answer')
    assert.deepEqual(block.items.map((item) => item.label), ['local.donna.hostile-calendar', 'local.donna.story-belt-daily'])
    assert.equal(block.hidden, 1, 'the label with the username in it')
    assert.deepEqual(block.items[0].cadence, { kind: 'unknown' })
    assert.equal(block.items[1].lastReportAt, iso(NOW - 40 * MINUTE))

    // The whole answer, as it would be written, and every word that was planted.
    const written = JSON.stringify(doc, null, 2)
    const planted = [
      token, refresh, FAKE_EMAIL, FAKE_USERNAME, FAKE_HOSTNAME, FAKE_UUID,
      '/Users/', 'secret-client', 'log-secret-words', 'ANTHROPIC_API_KEY', 'DB_PASSWORD', '--token', '--owner',
      'EnvironmentVariables', 'ProgramArguments', 'WorkingDirectory', 'StandardOutPath', 'StandardErrorPath', 'Sockets', 'MachServices', 'WatchPaths',
      'sk-', 'eyJ', 'Bearer', 'staff', 'Aqua', 'Background', 'Library/Logs', '.log'
    ]
    for (const word of planted) assert.ok(!written.includes(word), `the answer holds ${JSON.stringify(word)}`)
    // Nothing printed or thrown on the way could have carried it either: the code returns, it does not log.
    assert.deepEqual(Object.keys(block.items[1]).sort(), ['cadence', 'dueAt', 'dueBeforeAt', 'label', 'lastExit', 'lastReportAt', 'state'])
    assert.deepEqual(usedOn(fs, 'stat').sort(), [out, err].sort(), 'only the two log files were looked at')
  } finally {
    await fake.cleanup()
  }
})

// ============================================================================================================
// The Hermes half: the jobs Hermes schedules, from its own cron/jobs.json - by name, schedule and how the
// last run ended. Hermes is never run. Each job in that file also carries its prompt, where it delivers,
// where it came from, and the text of its last error; none of that has a key in the answer.
// ============================================================================================================

const noProgram = Object.assign(async () => { throw new Error('no program may run') }, { calls: [] })
const hermesDeps = (fake, extra = {}) => ({ home: fake.home, env: {}, platform: 'darwin', now: NOW, identity: fake.identity, stateDir: stateDirOf(fake), exec: noProgram, ...extra })
const hermesJob = (extra = {}) => ({
  id: 'a1b2c3d4e5f6',
  name: 'YouTube morning brief',
  enabled: true,
  schedule: { kind: 'cron', expr: '30 6 * * *', timezone: ZONE },
  last_run_at: '2026-10-09T10:30:04+00:00',
  last_status: 'ok',
  ...extra
})
const writeJobs = (fake, jobs, profile = null) => fake.write(`${profile ? `.hermes/profiles/${profile}` : '.hermes'}/cron/jobs.json`, jobs)
const withProfile = (name) => ({ [name]: { 'config.yaml': 'model: gpt-5.1\n' } })
const wholeDoc = (hermes) => ({ schema: JOBS_SCHEMA, takenAt: iso(NOW), computer: 'Mac Mini', timezone: ZONE, launchd: { status: 'not found' }, hermes })

test('no Hermes at all: hermes is not found; Hermes with no cron files: found, with no jobs', async () => {
  const fake = await makeFakeHome()
  try {
    assert.deepEqual(await collectHermesJobs(hermesDeps(fake), ZONE), { status: 'not found' })
    await writeHermes(fake, { now: NOW })
    assert.deepEqual(await collectHermesJobs(hermesDeps(fake), ZONE), { status: 'found', items: [], hidden: 0, more: 0 })
    // Hermes's home is a file, not a folder.
    const other = await makeFakeHome({ '.hermes': 'a file' })
    try {
      assert.deepEqual(await collectHermesJobs(hermesDeps(other), ZONE), { status: 'unavailable', why: 'could not be read' })
    } finally {
      await other.cleanup()
    }
  } finally {
    await fake.cleanup()
  }
})

test('one cron job: its schedule, when it last ran, how it ended, and when it should have', async () => {
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now: NOW })
    await writeJobs(fake, { jobs: [hermesJob()] })
    const block = await collectHermesJobs(hermesDeps(fake), ZONE)
    assert.deepEqual(block, {
      status: 'found',
      items: [{
        profile: 'default',
        id: 'a1b2c3d4e5f6',
        name: 'YouTube morning brief',
        enabled: true,
        cadence: { kind: 'slots', slots: [{ minute: 30, hour: 6 }] },
        lastRunAt: '2026-10-09T10:30:04Z',
        lastResult: 'ok',
        dueAt: '2026-10-09T10:30:00Z',
        dueBeforeAt: '2026-10-08T10:30:00Z'
      }],
      hidden: 0,
      more: 0
    })
  } finally {
    await fake.cleanup()
  }
})

test('the jobs file may be a bare list, and a job that never ran has no last run and an unknown result', async () => {
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now: NOW })
    await writeJobs(fake, [hermesJob({ last_run_at: null, last_status: null })])
    const block = await collectHermesJobs(hermesDeps(fake), ZONE)
    assert.equal(block.items.length, 1)
    assert.equal(block.items[0].lastRunAt, undefined)
    assert.equal(block.items[0].lastResult, 'unknown')
    assert.ok(block.items[0].dueAt, 'it is still judged against its schedule')
  } finally {
    await fake.cleanup()
  }
})

test('each profile\'s own jobs, listed under its name: default first, then A to Z', async () => {
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now: NOW, profiles: { ...withProfile('donna'), ...withProfile('coder') } })
    await writeJobs(fake, { jobs: [hermesJob({ id: 'job2', name: 'B job' }), hermesJob({ id: 'job1', name: 'A job' })] })
    await writeJobs(fake, { jobs: [hermesJob({ id: 'job3', name: 'Donna job' })] }, 'donna')
    await writeJobs(fake, { jobs: [hermesJob({ id: 'job4', name: 'Coder job' })] }, 'coder')
    const block = await collectHermesJobs(hermesDeps(fake), ZONE)
    assert.deepEqual(block.items.map((item) => `${item.profile}/${item.name}`), ['default/A job', 'default/B job', 'coder/Coder job', 'donna/Donna job'])
    assert.deepEqual([block.hidden, block.more], [0, 0])
  } finally {
    await fake.cleanup()
  }
})

test('switched off, and run once: enabled false, no due times; a one-shot has no schedule at all', async () => {
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now: NOW })
    await writeJobs(fake, { jobs: [
      hermesJob({ id: 'paused', name: 'Paused job', enabled: false }),
      hermesJob({ id: 'nokey', name: 'No enabled key', enabled: undefined }),
      hermesJob({ id: 'oneat', name: 'One shot at', schedule: { kind: 'at', at: '2026-10-20T10:00:00Z' } }),
      hermesJob({ id: 'oneonce', name: 'One shot once', schedule: { kind: 'once', run_at: '2026-10-20T10:00:00Z' } })
    ] })
    const block = await collectHermesJobs(hermesDeps(fake), ZONE)
    const byId = Object.fromEntries(block.items.map((item) => [item.id, item]))
    assert.equal(byId.paused.enabled, false)
    assert.deepEqual(byId.paused.cadence, { kind: 'slots', slots: [{ minute: 30, hour: 6 }] }, 'a paused job keeps its schedule')
    assert.equal(byId.paused.dueAt, undefined)
    assert.equal(byId.nokey.enabled, false, 'a job that does not say it is on is not on')
    for (const id of ['oneat', 'oneonce']) {
      assert.equal(byId[id].enabled, false, id)
      assert.deepEqual(byId[id].cadence, { kind: 'unknown' }, id)
      assert.equal(byId[id].dueAt, undefined, id)
    }
    assert.deepEqual(checkJobs(wholeDoc(block), fake.identity), [])
  } finally {
    await fake.cleanup()
  }
})

test('a job in another timezone than the computer\'s, or one that is not a zone, has no schedule; none given means the computer\'s', async () => {
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now: NOW })
    const at = (id, schedule) => hermesJob({ id, name: `Job ${id}`, schedule })
    await writeJobs(fake, { jobs: [
      at('same', { kind: 'cron', expr: '30 6 * * *', timezone: 'US/Eastern' }),
      at('none', { kind: 'cron', expr: '30 6 * * *' }),
      at('null', { kind: 'cron', expr: '30 6 * * *', timezone: null }),
      at('empty', { kind: 'cron', expr: '30 6 * * *', timezone: '' }),
      at('london', { kind: 'cron', expr: '30 6 * * *', timezone: 'Europe/London' }),
      at('mars', { kind: 'cron', expr: '30 6 * * *', timezone: 'Mars/Olympus' }),
      at('number', { kind: 'cron', expr: '30 6 * * *', timezone: 5 })
    ] })
    const byId = Object.fromEntries((await collectHermesJobs(hermesDeps(fake), ZONE)).items.map((item) => [item.id, item]))
    for (const id of ['same', 'none', 'null', 'empty']) assert.equal(byId[id].cadence.kind, 'slots', id)
    for (const id of ['london', 'mars', 'number']) {
      assert.deepEqual(byId[id].cadence, { kind: 'unknown' }, id)
      assert.equal(byId[id].dueAt, undefined, id)
    }
    // The computer's zone is whatever machineZone() made of it; a job in New York on a Kolkata computer is in another zone.
    const elsewhere = await collectHermesJobs(hermesDeps(fake), 'Asia/Calcutta')
    assert.equal(elsewhere.items.find((item) => item.id === 'same').cadence.kind, 'unknown')
    assert.equal(elsewhere.items.find((item) => item.id === 'none').cadence.kind, 'slots')
  } finally {
    await fake.cleanup()
  }
})

test('schedules the plan does not read are unknown, never guessed: other kinds, missing or odd expressions', async () => {
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now: NOW })
    const schedules = {
      interval: { kind: 'interval', minutes: 30 },
      nokind: { expr: '30 6 * * *' },
      noexpr: { kind: 'cron' },
      numexpr: { kind: 'cron', expr: 630 },
      nickname: { kind: 'cron', expr: '@daily' },
      names: { kind: 'cron', expr: '0 6 * * MON' },
      text: 'every day at 6',
      nothing: null,
      listed: [1, 2]
    }
    await writeJobs(fake, { jobs: Object.entries(schedules).map(([id, schedule]) => hermesJob({ id, name: `Job ${id}`, schedule })) })
    const block = await collectHermesJobs(hermesDeps(fake), ZONE)
    assert.equal(block.items.length, Object.keys(schedules).length)
    for (const item of block.items) {
      assert.deepEqual(item.cadence, { kind: 'unknown' }, item.id)
      assert.equal(item.dueAt, undefined, item.id)
      assert.equal(item.enabled, true, `${item.id}: an enabled job with a schedule nobody can read is still enabled`)
    }
  } finally {
    await fake.cleanup()
  }
})

test('last_status words become ok, error or unknown, whatever case or spacing; any other word is unknown', async () => {
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now: NOW })
    const words = ['ok', 'OK', ' Ok ', 'success', 'succeeded', 'completed', 'error', 'ERROR', 'failed', 'failure', 'timeout', 'running', 'skipped', 'delivered', '', null, 5, true, ['ok'], { status: 'ok' }]
    await writeJobs(fake, { jobs: words.map((word, index) => hermesJob({ id: `job-${index}`, name: `Job ${index}`, last_status: word })) })
    const items = (await collectHermesJobs(hermesDeps(fake), ZONE)).items
    const results = items.sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4))).map((item) => item.lastResult)
    assert.deepEqual(results, ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'error', 'error', 'error', 'error', 'error', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown'])
    assert.deepEqual(Object.keys(HERMES_RESULT_WORDS), ['ok', 'error'])
  } finally {
    await fake.cleanup()
  }
})

test('last_run_at is read as Hermes writes it, and a time nobody could believe is left out', async () => {
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now: NOW })
    const stamps = {
      offset: '2026-10-09T10:30:04.123456+00:00',
      zulu: '2026-10-09T10:30:04Z',
      naive: '2026-10-09T10:30:04',
      epoch: Math.floor(Date.parse('2026-10-09T10:30:04Z') / 1000),
      future: '2026-10-20T10:00:00Z',
      ancient: '1999-01-01T00:00:00Z',
      text: 'yesterday',
      zero: 0
    }
    await writeJobs(fake, { jobs: Object.entries(stamps).map(([id, stamp]) => hermesJob({ id, name: `Job ${id}`, last_run_at: stamp })) })
    const at = Object.fromEntries((await collectHermesJobs(hermesDeps(fake), ZONE)).items.map((item) => [item.id, item.lastRunAt]))
    for (const id of ['offset', 'zulu', 'naive', 'epoch']) assert.equal(at[id], '2026-10-09T10:30:04Z', id)
    for (const id of ['future', 'ancient', 'text', 'zero']) assert.equal(at[id], undefined, id)
  } finally {
    await fake.cleanup()
  }
})

test('a job whose name, id or shape the board would refuse is dropped and counted; the same job twice is one', async () => {
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now: NOW })
    await writeJobs(fake, { jobs: [
      hermesJob({ id: 'fine', name: 'Fine job' }),
      hermesJob({ id: 'mail', name: FAKE_EMAIL }),
      hermesJob({ id: 'user', name: `${FAKE_USERNAME} notes` }),
      hermesJob({ id: 'path', name: 'Run /Users/someone/brief.sh' }),
      hermesJob({ id: 'key', name: `Brief ${fakeClaudeToken()}` }),
      hermesJob({ id: 'dash', name: 'Brief — morning' }),
      hermesJob({ id: 'long', name: 'A very long job name that goes on and on past sixty characters in all' }),
      hermesJob({ id: 'noname', name: undefined }),
      hermesJob({ id: 'numname', name: 7 }),
      hermesJob({ id: undefined, name: 'No id' }),
      hermesJob({ id: 'bad/id', name: 'Slash id' }),
      hermesJob({ id: FAKE_UUID, name: 'Uuid id' }),
      hermesJob({ id: 'fine', name: 'Fine job again' }),
      'not an object',
      null,
      ['a list']
    ] })
    const block = await collectHermesJobs(hermesDeps(fake), ZONE)
    assert.deepEqual(block.items.map((item) => item.id), ['fine'])
    assert.equal(block.items[0].name, 'Fine job', 'the first of two with one id is the one kept')
    assert.equal(block.hidden, 15)
    const text = JSON.stringify(block)
    for (const word of [FAKE_EMAIL, FAKE_USERNAME, fakeClaudeToken(), FAKE_UUID, '/Users/', '—']) assert.ok(!text.includes(word), `the answer holds ${word}`)
  } finally {
    await fake.cleanup()
  }
})

test('a profile the board would refuse is counted and its jobs are not read; a broken jobs file counts as one', async () => {
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now: NOW, profiles: { ...withProfile('donna'), ...withProfile('Capital'), ...withProfile('broken'), ...withProfile('empty'), ...withProfile(FAKE_USERNAME) } })
    await writeJobs(fake, { jobs: [hermesJob({ id: 'ok1', name: 'Root job' })] })
    await writeJobs(fake, { jobs: [hermesJob({ id: 'ok2', name: 'Donna job' })] }, 'donna')
    await writeJobs(fake, { jobs: [hermesJob({ id: 'x1', name: 'Capital job' })] }, 'Capital')
    await writeJobs(fake, { jobs: [hermesJob({ id: 'x2', name: 'Private job' })] }, FAKE_USERNAME)
    await fake.write('.hermes/profiles/broken/cron/jobs.json', '{ this is not json')
    await fake.write('.hermes/profiles/empty/cron/jobs.json', JSON.stringify({ not: 'jobs' }))
    const block = await collectHermesJobs(hermesDeps(fake), ZONE)
    assert.deepEqual(block.items.map((item) => item.id), ['ok1', 'ok2'])
    assert.equal(block.hidden, 4, 'two refused profiles, a broken file, a file with no jobs list')
    assert.ok(!JSON.stringify(block).includes('Capital') && !JSON.stringify(block).includes(FAKE_USERNAME))
  } finally {
    await fake.cleanup()
  }
})

test('a jobs file over a megabyte is not one Hermes wrote: it is not read, and counts as one', async () => {
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now: NOW })
    await fake.write('.hermes/cron/jobs.json', JSON.stringify({ jobs: [hermesJob()], padding: 'x'.repeat(1024 * 1024) }))
    assert.deepEqual(await collectHermesJobs(hermesDeps(fake), ZONE), { status: 'found', items: [], hidden: 1, more: 0 })
  } finally {
    await fake.cleanup()
  }
})

test('40 jobs at most, in name order within a profile; the rest are counted in more', async () => {
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now: NOW })
    const jobs = Array.from({ length: 43 }, (_, index) => hermesJob({ id: `job-${String(index).padStart(2, '0')}`, name: `Job ${String(index).padStart(2, '0')}` }))
    await writeJobs(fake, { jobs: [...jobs].reverse() })
    const block = await collectHermesJobs(hermesDeps(fake), ZONE)
    assert.equal(block.items.length, fixture.caps.hermes)
    assert.equal(block.more, 3)
    assert.deepEqual(block.items.map((item) => item.id), jobs.slice(0, 40).map((job) => job.id))
    assert.deepEqual(checkJobs(wholeDoc(block), fake.identity), [])
  } finally {
    await fake.cleanup()
  }
})

test('with no zone, a Hermes job that names none is listed with its schedule and no due times; one that names a zone cannot be confirmed', async () => {
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now: NOW })
    await writeJobs(fake, { jobs: [
      hermesJob({ id: 'plain', name: 'Plain', schedule: { kind: 'cron', expr: '30 6 * * *' } }),
      hermesJob({ id: 'zoned', name: 'Zoned' })
    ] })
    const block = await collectHermesJobs(hermesDeps(fake), null)
    const byId = Object.fromEntries(block.items.map((item) => [item.id, item]))
    assert.equal(byId.plain.cadence.kind, 'slots')
    assert.equal(byId.zoned.cadence.kind, 'unknown')
    assert.ok(block.items.every((item) => item.dueAt === undefined))
  } finally {
    await fake.cleanup()
  }
})

test('Hermes is never run and its files are only read: no program starts, nothing in its home changes', async () => {
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now: NOW, profiles: withProfile('donna') })
    await writeJobs(fake, { jobs: [hermesJob()] })
    await fake.write('.hermes/bin/hermes', '#!/bin/sh\necho ran\n')
    const before = await fingerprint(join(fake.home, '.hermes'))
    const calls = []
    const exec = async (...args) => {
      calls.push(args)
      throw new Error('no program may run')
    }
    await collectHermesJobs(hermesDeps(fake, { exec }), ZONE)
    assert.equal(calls.length, 0, 'the Hermes part started a program')
    assert.deepEqual(await fingerprint(join(fake.home, '.hermes')), before, 'something in the Hermes home changed')
  } finally {
    await fake.cleanup()
  }
})

test('a Hermes jobs file full of prompts, destinations, error text and keys: none of it reaches the answer', async () => {
  const token = fakeClaudeToken()
  const refresh = fakeRefreshToken()
  const home = `/Users/${FAKE_USERNAME}`
  const fake = await makeFakeHome()
  try {
    await writeHermes(fake, { now: NOW, profiles: withProfile('donna') })
    const baggage = (tag) => ({
      prompt: `prompt-secret-words ${tag}: write to ${FAKE_EMAIL} using ${token} and read ${home}/secret-client/notes.md`,
      script: `${home}/secret-client/run.sh --token ${refresh}`,
      deliver: `telegram:chat-77-${tag}`,
      origin: { platform: 'telegram', chat_id: 'telegram-chat-77', user: FAKE_EMAIL },
      last_error: `error-secret-words Bearer ${token} at ${home}/secret-client/brief.py line 9: ${FAKE_EMAIL}`,
      last_delivery_error: `delivery-secret-words ${refresh}`,
      next_run_at: '2026-10-10T10:30:00+00:00',
      created_at: '2026-09-01T00:00:00+00:00',
      model: 'secret-model-name',
      provider: 'secret-provider',
      skills: ['secret-skill'],
      repeat: { times: null, completed: 41 },
      env: { OPENROUTER_API_KEY: token },
      workdir: `${home}/secret-client`
    })
    await writeJobs(fake, { jobs: [
      hermesJob({ id: 'ok1', name: 'Morning brief', ...baggage('one') }),
      hermesJob({ id: 'bad1', name: 'Memory tidy', last_status: 'error', ...baggage('two') }),
      hermesJob({ id: 'bad2', name: 'Weekly review', schedule: { kind: 'cron', expr: '0 9 * * 1', timezone: ZONE, display: `secret-display ${token}`, note: FAKE_EMAIL }, ...baggage('three') })
    ] })
    await writeJobs(fake, { jobs: [hermesJob({ id: 'd1', name: 'Donna brief', ...baggage('four') })] }, 'donna')
    const block = await collectHermesJobs(hermesDeps(fake), ZONE)
    const doc = wholeDoc(block)
    assert.deepEqual(checkJobs(doc, fake.identity), [], 'the gate refused the answer')
    assert.equal(block.items.length, 4)
    assert.equal(block.items.find((item) => item.id === 'bad1').lastResult, 'error', 'it still says the job failed - only that it did')
    const written = JSON.stringify(doc, null, 2)
    const planted = [
      token, refresh, FAKE_EMAIL, FAKE_USERNAME, FAKE_HOSTNAME,
      '/Users/', 'secret-client', 'prompt-secret-words', 'error-secret-words', 'delivery-secret-words', 'secret-display', 'secret-model-name', 'secret-provider', 'secret-skill',
      'telegram', 'chat-77', 'OPENROUTER_API_KEY', 'Bearer', 'sk-', 'eyJ', '--token', 'brief.py', 'notes.md', 'run.sh', 'workdir', 'next_run_at', 'last_error'
    ]
    for (const word of planted) assert.ok(!written.includes(word), `the answer holds ${JSON.stringify(word)}`)
    for (const item of block.items) {
      assert.deepEqual(Object.keys(item).filter((key) => !['profile', 'id', 'name', 'enabled', 'cadence', 'lastRunAt', 'lastResult', 'dueAt', 'dueBeforeAt'].includes(key)), [], item.id)
    }
  } finally {
    await fake.cleanup()
  }
})

// --- the whole part ----------------------------------------------------------------------------------------------------------

test('the whole part: launchd and Hermes in one file that passes the gate, with the computer\'s zone', async () => {
  const fake = await macHome(Object.keys(ORDINARY))
  try {
    await writeHermes(fake, { now: NOW })
    await writeJobs(fake, { jobs: [hermesJob()] })
    const exec = fakePrograms({ plists: ORDINARY, launchctl: ORDINARY_TABLE })
    const doc = await collectJobs(depsFor(fake, exec), 'Mac Mini')
    assert.deepEqual(Object.keys(doc), ['schema', 'takenAt', 'computer', 'timezone', 'launchd', 'hermes'])
    assert.equal(doc.schema, 'agent-status/jobs/v1')
    assert.equal(doc.takenAt, iso(NOW))
    assert.equal(doc.computer, 'Mac Mini')
    assert.equal(doc.timezone, ZONE)
    assert.equal(doc.launchd.status, 'found')
    assert.equal(doc.hermes.items.length, 1)
    assert.deepEqual(checkJobs(doc, fake.identity), [])
    // Hermes was read from files; the only programs that ran are the two for launchd.
    assert.deepEqual([...new Set(exec.calls.map((call) => call.file))].sort(), ['/bin/launchctl', '/usr/bin/plutil'])
  } finally {
    await fake.cleanup()
  }
})

test('the whole part on a computer that is not a Mac and has no Hermes: both blocks not found, and the file still passes the gate', async () => {
  const fake = await makeFakeHome()
  try {
    const doc = await collectJobs(depsFor(fake, noProgram, { platform: 'win32' }), 'Test PC')
    assert.deepEqual(doc.launchd, { status: 'not found' })
    assert.deepEqual(doc.hermes, { status: 'not found' })
    assert.deepEqual(checkJobs(doc, fake.identity), [])
  } finally {
    await fake.cleanup()
  }
})

test('a block that throws is unavailable and the other still stands', async () => {
  const fake = await macHome(['local.donna.a.plist'])
  try {
    await writeHermes(fake, { now: NOW })
    await writeJobs(fake, { jobs: [hermesJob()] })
    const broken = { readdir: async () => { throw new TypeError('boom') }, stat: realFs.stat }
    const doc = await collectJobs(depsFor(fake, fakePrograms({ launchctl: launchctlTable([]) }), { fs: broken }), 'Mac Mini')
    assert.deepEqual(doc.launchd, { status: 'unavailable', why: 'could not be read' })
    assert.equal(doc.hermes.status, 'found')
    assert.deepEqual(checkJobs(doc, fake.identity), [])
  } finally {
    await fake.cleanup()
  }
})

test('the computer\'s zone: its own name when this runtime lists it, an alias spelled the way the runtime lists it, UTC when it does not know it', async () => {
  assert.equal(machineZone({ timezone: 'America/New_York' }), 'America/New_York')
  assert.equal(machineZone({ timezone: 'US/Eastern' }), 'America/New_York')
  assert.equal(machineZone({ timezone: 'Asia/Kolkata' }), 'Asia/Calcutta')
  assert.equal(machineZone({ timezone: 'UTC' }), 'UTC')
  // '+05:30' is a zone this runtime understands and the gate would refuse, so it is no zone here.
  for (const timezone of ['Mars/Olympus', '', undefined, null, 5, 'Users/fakeperson', '+05:30']) assert.equal(machineZone({ timezone }), null, String(timezone))
  const fake = await macHome(['local.donna.story-belt-daily.plist'])
  try {
    const plists = { 'local.donna.story-belt-daily.plist': ORDINARY['local.donna.story-belt-daily.plist'] }
    const doc = await collectJobs(depsFor(fake, fakePrograms({ plists, launchctl: launchctlTable([['-', 0, 'local.donna.story-belt-daily']]) }), { timezone: 'Mars/Olympus' }), 'Mac Mini')
    assert.equal(doc.timezone, 'UTC')
    assert.deepEqual(doc.launchd.items, [{ label: 'local.donna.story-belt-daily', cadence: { kind: 'slots', slots: [{ minute: 15, hour: 6 }] }, state: 'loaded', lastExit: 0 }])
    assert.deepEqual(checkJobs(doc, fake.identity), [])
  } finally {
    await fake.cleanup()
  }
})

test('the file never outgrows what the board reads: the biggest schedules give way first', () => {
  const slots = (count) => ({ kind: 'slots', slots: Array.from({ length: count }, (_, index) => ({ minute: index % 60, hour: Math.floor(index / 60) })) })
  const item = (index, count) => ({ label: `local.donna.job-${String(index).padStart(2, '0')}`, cadence: slots(count), state: 'loaded', dueAt: '2026-10-09T10:15:00Z', dueBeforeAt: '2026-10-08T10:15:00Z' })
  const size = (doc) => Buffer.byteLength(`${JSON.stringify(doc, null, 2)}\n`)
  const doc = {
    schema: JOBS_SCHEMA,
    takenAt: iso(NOW),
    computer: 'Mac Mini',
    timezone: ZONE,
    launchd: { status: 'found', items: Array.from({ length: 60 }, (_, index) => item(index, index === 7 ? 48 : 40)), hidden: 0, more: 0 },
    hermes: { status: 'not found' }
  }
  assert.ok(size(doc) > fixture.maxFileBytes, 'the test needs a file that is too big')
  const fitted = fitToFile(structuredClone(doc))
  assert.ok(size(fitted) <= fixture.maxFileBytes)
  assert.deepEqual(checkJobs(fitted, { username: 'fakeperson', home: '/Users/fakeperson', hostname: 'fake-host-77' }), [])
  // The 48-slot schedule went first, then the 40-slot ones, until it fitted - and only what had to.
  const unknown = fitted.launchd.items.filter((entry) => entry.cadence.kind === 'unknown')
  assert.ok(unknown.some((entry) => entry.label === 'local.donna.job-07'), 'the biggest schedule gave way')
  assert.ok(unknown.length >= 1 && unknown.length < 60)
  for (const entry of unknown) assert.equal(entry.dueAt, undefined)
  assert.equal(fitted.launchd.items.length, 60)
  // A file that already fits is returned as it is.
  assert.deepEqual(fitToFile(structuredClone(fixture.sample)), fixture.sample)
})

test('the contract\'s rule for last_status names exactly the words the code reads', () => {
  const rule = fixture.rules.find((text) => text.includes('last_status is written as'))
  assert.ok(rule, 'the contract has no rule for last_status')
  for (const words of Object.values(HERMES_RESULT_WORDS)) {
    for (const word of words) assert.match(rule, new RegExp(`(?<![a-z])${word}(?![a-z])`), `the rule leaves out ${word}`)
  }
  assert.equal(Object.values(HERMES_RESULT_WORDS).flat().length, 8)
})
