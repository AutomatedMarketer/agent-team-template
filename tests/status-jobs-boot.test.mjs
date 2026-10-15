import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './helpers/repo.mjs'
import { makeFakeHome } from './helpers/fake-home.mjs'
import { collectJobs, collectBootTime } from '../scripts/lib/status/jobs.mjs'
import { checkJobs } from '../scripts/lib/status/safe.mjs'
import { fakePrograms, launchctlTable } from './helpers/mac-programs.mjs'

/* When the computer last started, written as `bootedAt` at the top of the jobs file. It is there so the
   board can say "the Mac restarted at 3:56pm" and word a job that failed right after it differently from
   one that failed on an ordinary day. One time, to the minute, from one program on a Mac (sysctl) and
   nothing anywhere else. Every way it can be wrong leaves it out: a missing time is never a wrong one,
   and the rest of the file is written as it always was. */

const fixture = JSON.parse(readFileSync(join(repoRoot, 'tests', 'fixtures', 'jobs-parity.json'), 'utf8'))
const NOW = Date.parse('2026-10-14T13:07:00Z')
const BOOT_SECONDS = Date.parse('2026-10-13T19:56:27Z') / 1000
// What `/usr/sbin/sysctl -n kern.boottime` prints on a Mac: a struct, then the same moment as a date.
const sysctlText = (seconds, usec = 481926) => `{ sec = ${seconds}, usec = ${usec} } Tue Oct 13 15:56:27 2026\n`

const stateDirOf = (fake) => join(fake.root, 'state')
const depsFor = (fake, exec, extra = {}) => ({ home: fake.home, env: {}, platform: 'darwin', now: NOW, timezone: 'America/New_York', identity: fake.identity, stateDir: stateDirOf(fake), exec, ...extra })

async function withMac(run, programs = {}) {
  const fake = await makeFakeHome({})
  try {
    await run(fake, fakePrograms({ launchctl: launchctlTable([]), ...programs }))
  } finally {
    await fake.cleanup()
  }
}

test('the boot time is the moment the Mac started, rounded down to the minute, in UTC', async () => {
  await withMac(async (fake, exec) => {
    assert.equal(await collectBootTime(depsFor(fake, exec)), '2026-10-13T19:56:00Z')
  }, { boottime: sysctlText(BOOT_SECONDS) })
})

test('it asks one program, by absolute path, from the empty folder, with a time limit and an output cap', async () => {
  await withMac(async (fake, exec) => {
    await collectBootTime(depsFor(fake, exec))
    assert.equal(exec.calls.length, 1)
    const [call] = exec.calls
    assert.equal(call.file, '/usr/sbin/sysctl')
    assert.deepEqual(call.args, ['-n', 'kern.boottime'])
    assert.equal(call.options.cwd, join(stateDirOf(fake), 'empty-cwd'))
    assert.ok(call.options.timeout > 0 && call.options.timeout <= 10_000)
    assert.ok(call.options.maxOutput > 0 && call.options.maxOutput <= 4096)
  }, { boottime: sysctlText(BOOT_SECONDS) })
})

test('off a Mac no program runs and there is no boot time', async () => {
  await withMac(async (fake, exec) => {
    for (const platform of ['win32', 'linux']) assert.equal(await collectBootTime(depsFor(fake, exec, { platform })), null)
    assert.equal(exec.calls.length, 0)
  }, { boottime: sysctlText(BOOT_SECONDS) })
})

test('a Mac that cannot answer, answers with something else, or answers a time nobody could believe has no boot time', async () => {
  const answers = [
    new Error('sysctl failed at /Users/fakeperson'),
    '',
    'sysctl: unknown oid',
    '{ sec = , usec = 0 }',
    '{ sec = abc, usec = 0 }',
    '{ sec = -5, usec = 0 }',
    '{ sec = 1.5, usec = 0 }',
    sysctlText(Date.parse('1999-12-31T23:59:00Z') / 1000),
    sysctlText(NOW / 1000 + 120),
    sysctlText(NOW / 1000 + 86400 * 400),
    sysctlText(9e15)
  ]
  for (const boottime of answers) {
    await withMac(async (fake, exec) => {
      assert.equal(await collectBootTime(depsFor(fake, exec)), null, String(boottime))
    }, { boottime })
  }
  // With no program at all (the helper's "nobody expected it") the answer is the same.
  await withMac(async (fake, exec) => {
    assert.equal(await collectBootTime(depsFor(fake, exec)), null)
  })
  await withMac(async (fake) => {
    assert.equal(await collectBootTime(depsFor(fake, undefined)), null)
    assert.equal(await collectBootTime(depsFor(fake, fakePrograms({ boottime: sysctlText(BOOT_SECONDS) }), { stateDir: undefined })), null)
  })
})

test('a boot at the very second of the check is allowed, and one a few seconds earlier rounds down into the minute before', async () => {
  await withMac(async (fake, exec) => {
    assert.equal(await collectBootTime(depsFor(fake, exec)), '2026-10-14T13:07:00Z')
  }, { boottime: sysctlText(NOW / 1000) })
  await withMac(async (fake, exec) => {
    assert.equal(await collectBootTime(depsFor(fake, exec)), '2026-10-14T13:06:00Z')
  }, { boottime: sysctlText(NOW / 1000 - 5) })
})

test('the whole file carries bootedAt right after the timezone, and still passes the gate', async () => {
  await withMac(async (fake, exec) => {
    const doc = await collectJobs(depsFor(fake, exec), 'Mac Mini')
    assert.deepEqual(Object.keys(doc), ['schema', 'takenAt', 'computer', 'timezone', 'bootedAt', 'launchd', 'hermes'])
    assert.equal(doc.bootedAt, '2026-10-13T19:56:00Z')
    assert.deepEqual(checkJobs(doc, fake.identity), [])
  }, { boottime: sysctlText(BOOT_SECONDS) })
})

test('a Mac that gives no boot time writes the file exactly as before: no key, no null', async () => {
  await withMac(async (fake, exec) => {
    const doc = await collectJobs(depsFor(fake, exec), 'Mac Mini')
    assert.deepEqual(Object.keys(doc), ['schema', 'takenAt', 'computer', 'timezone', 'launchd', 'hermes'])
    assert.deepEqual(checkJobs(doc, fake.identity), [])
  })
})

test('the gate: bootedAt is optional, a whole minute, a real time, after 2000 and not after the check', () => {
  const identity = { username: 'fakeperson', home: '/Users/fakeperson', hostname: 'fake-host-77' }
  const sample = (patch) => ({ ...structuredClone(fixture.sample), ...patch })
  assert.deepEqual(checkJobs(sample({}), identity), [])
  assert.deepEqual(checkJobs(sample({ bootedAt: '2026-10-09T11:42:00Z' }), identity), [])
  assert.deepEqual(checkJobs(sample({ bootedAt: fixture.sample.takenAt }), identity), [], 'the minute of the check is allowed')
  const refused = [
    ['2026-10-09T11:42:07Z', /bootedAt: is not a whole minute/],
    ['2026-10-09T11:42:00.000Z', /bootedAt/],
    ['2026-10-09T15:01:00Z', /bootedAt: is after the time the file was taken/],
    ['1999-12-31T23:59:00Z', /bootedAt: is before the year 2000/],
    ['yesterday', /bootedAt: is not an ISO time/],
    ['2026-02-31T10:00:00Z', /bootedAt: is not an ISO time/],
    [null, /bootedAt/],
    [1791920160, /bootedAt/],
    ['', /bootedAt/]
  ]
  for (const [value, pattern] of refused) {
    const problems = checkJobs(sample({ bootedAt: value }), identity)
    assert.ok(problems.some((problem) => pattern.test(problem)), `${JSON.stringify(value)} was not refused as ${pattern}: ${problems.join(' | ')}`)
  }
})

test('the shared contract lists bootedAt as a file key that is not required, and says what it is', () => {
  assert.ok(fixture.allowedKeys.file.includes('bootedAt'))
  assert.ok(!fixture.requiredKeys.file.includes('bootedAt'))
  assert.equal(fixture.boot.key, 'bootedAt')
  assert.equal(fixture.boot.roundedToSeconds, 60)
  assert.equal(fixture.boot.earliest, '2000-01-01T00:00:00Z')
  assert.match(fixture.boot.rule, /whole minute/)
  assert.ok(fixture.sample.bootedAt, 'the shared sample carries one, so the board reads one in its own tests')
  assert.deepEqual(checkJobs(fixture.sample, { username: 'fakeperson', home: '/Users/fakeperson', hostname: 'fake-host-77' }), [])
})
