import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './helpers/repo.mjs'
import { cadenceFromCron, cadenceFromCalendar, cadenceFromInterval, dueTimes, wallToInstant, canonicalZone } from '../scripts/lib/status/cadence.mjs'
import { JOBS_CAPS, LOOKBACK_DAYS } from '../scripts/lib/status/jobs-schema.mjs'
import { checkJobs } from '../scripts/lib/status/safe.mjs'

/* How a schedule becomes one of four cadences, and when a job last had to run - above all across
   the days the clocks change. The expected times in tests/fixtures/jobs-parity.json were worked out
   by hand and checked against a separate implementation (Python's zoneinfo, not Intl) before they
   were written down, so the code is held to something it did not produce. */

const fixture = JSON.parse(readFileSync(join(repoRoot, 'tests', 'fixtures', 'jobs-parity.json'), 'utf8'))
const identity = { username: 'fakeperson', home: '/Users/fakeperson', hostname: 'fake-host-77' }
const UNKNOWN = { kind: 'unknown' }

// --- cron -------------------------------------------------------------------------------------------------------

test('cron: every example in the contract becomes the cadence it says', () => {
  assert.ok(fixture.cronExamples.length >= 20)
  for (const { expr, cadence } of fixture.cronExamples) assert.deepEqual(cadenceFromCron(expr), cadence, JSON.stringify(expr))
})

test('cron: every form the plan does not read is unknown, never a guess', () => {
  assert.ok(fixture.cronUnknown.length >= 20)
  for (const { expr, why } of fixture.cronUnknown) assert.deepEqual(cadenceFromCron(expr), UNKNOWN, `${JSON.stringify(expr)} (${why})`)
  for (const value of [null, undefined, 5, {}, [], true]) assert.deepEqual(cadenceFromCron(value), UNKNOWN)
})

test('cron: a minute step that divides the hour is "every N minutes"; one that does not is its slots', () => {
  for (const step of [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30]) {
    assert.deepEqual(cadenceFromCron(`*/${step} * * * *`), { kind: 'every', minutes: step }, `*/${step}`)
  }
  assert.equal(cadenceFromCron('*/7 * * * *').kind, 'slots')
  assert.equal(cadenceFromCron('*/45 * * * *').kind, 'slots')
  // Only when nothing else narrows it: an hour range makes slots, however regular the minutes.
  assert.equal(cadenceFromCron('*/15 8-17 * * *').kind, 'slots')
  assert.equal(cadenceFromCron('*/15 * * * 1-5').kind, 'slots')
  assert.equal(cadenceFromCron('*/15 * 3 * *').kind, 'slots')
})

test('cron: Sunday is 0 and 7, once; day-of-month and weekday together is unknown, not "or"', () => {
  assert.deepEqual(cadenceFromCron('0 9 * * 0'), cadenceFromCron('0 9 * * 7'))
  // Every weekday is no weekday at all.
  assert.deepEqual(cadenceFromCron('0 9 * * 0-7'), { kind: 'slots', slots: [{ minute: 0, hour: 9 }] })
  assert.deepEqual(cadenceFromCron('0 9 1 * 0-7'), { kind: 'slots', slots: [{ minute: 0, hour: 9, day: 1 }] })
  assert.deepEqual(cadenceFromCron('0 9 1 * 1'), UNKNOWN)
})

test('slots: at most 48; exactly 48 is kept, one more is unknown', () => {
  assert.equal(JOBS_CAPS.slots, 48)
  assert.equal(cadenceFromCron('*/15 0-11 * * *').slots.length, 48)
  assert.deepEqual(cadenceFromCron('0,1,2,3,4,5,6 0-6 * * *'), UNKNOWN, '49 slots')
  const calendar = (count) => Array.from({ length: count }, (_, index) => ({ Hour: Math.floor(index / 7), Minute: index % 7 }))
  assert.equal(cadenceFromCalendar(calendar(48)).slots.length, 48)
  assert.deepEqual(cadenceFromCalendar(calendar(49)), UNKNOWN)
})

// --- launchd ---------------------------------------------------------------------------------------------------

test('launchd calendar: every example in the contract becomes the cadence it says', () => {
  assert.ok(fixture.calendarExamples.length >= 8)
  for (const { calendar, cadence } of fixture.calendarExamples) assert.deepEqual(cadenceFromCalendar(calendar), cadence, JSON.stringify(calendar))
})

test('launchd calendar: a missing minute, a month, day with weekday, or anything odd is unknown', () => {
  assert.ok(fixture.calendarUnknown.length >= 15)
  for (const { calendar, why } of fixture.calendarUnknown) assert.deepEqual(cadenceFromCalendar(calendar), UNKNOWN, `${JSON.stringify(calendar)} (${why})`)
  assert.deepEqual(cadenceFromCalendar(undefined), UNKNOWN)
})

test('launchd interval: seconds become whole minutes, never fewer than one, and an absurd one is unknown', () => {
  for (const { seconds, cadence } of fixture.intervalExamples) assert.deepEqual(cadenceFromInterval(seconds), cadence, JSON.stringify(seconds))
  assert.deepEqual(cadenceFromInterval(NaN), UNKNOWN)
  assert.deepEqual(cadenceFromInterval(Infinity), UNKNOWN)
})

test('the same schedule always writes the same bytes, whatever order or repeats it came in', () => {
  const a = cadenceFromCalendar([{ Hour: 9, Minute: 0 }, { Hour: 6, Minute: 15 }, { Weekday: 3, Hour: 6, Minute: 15 }, { Day: 5, Hour: 1, Minute: 0 }])
  const b = cadenceFromCalendar([{ Day: 5, Hour: 1, Minute: 0 }, { Weekday: 3, Hour: 6, Minute: 15 }, { Hour: 6, Minute: 15 }, { Hour: 9, Minute: 0 }, { Hour: 9, Minute: 0 }])
  assert.equal(JSON.stringify(a), JSON.stringify(b))
  // Day first, then weekday, then hour, then minute; a missing value first.
  assert.deepEqual(a.slots, [{ minute: 15, hour: 6 }, { minute: 0, hour: 9 }, { minute: 15, hour: 6, weekday: 3 }, { minute: 0, hour: 1, day: 5 }])
  // A cron list and the same list in launchd's form agree.
  assert.equal(JSON.stringify(cadenceFromCron('15 6,18 * * *')), JSON.stringify(cadenceFromCalendar([{ Hour: 18, Minute: 15 }, { Hour: 6, Minute: 15 }])))
})

test('whatever the parsers write, the gate accepts it', () => {
  const samples = [
    ...fixture.cronExamples.map((example) => example.cadence),
    ...fixture.calendarExamples.map((example) => example.cadence),
    ...fixture.intervalExamples.map((example) => example.cadence),
    UNKNOWN,
    { kind: 'always' }
  ]
  for (const cadence of samples) {
    const doc = structuredClone(fixture.sample)
    doc.launchd.items = [{ label: 'local.donna.x', cadence, state: 'loaded' }]
    assert.deepEqual(checkJobs(doc, identity), [], JSON.stringify(cadence))
  }
})

// --- wall clock to instant ---------------------------------------------------------------------------------

const minutesOf = (day) => Array.from({ length: 24 * 60 }, (_, index) => [Math.floor(index / 60), index % 60]).map(([hour, minute]) => ({ day, hour, minute }))

test('New York, spring forward 2027-03-14: 02:00 to 02:59 never happens, every other minute happens once', () => {
  let missing = 0
  for (const { hour, minute } of minutesOf(14)) {
    const at = wallToInstant('America/New_York', 2027, 3, 14, hour, minute)
    if (hour === 2) {
      assert.equal(at, null, `${hour}:${minute} exists?`)
      missing += 1
    } else {
      assert.ok(Number.isFinite(at), `${hour}:${minute} is missing`)
      // Midnight to 01:59 is standard time (UTC-5), 03:00 onward daylight time (UTC-4).
      assert.equal(at, Date.UTC(2027, 2, 14, hour, minute) + (hour < 2 ? 5 : 4) * 3600_000)
    }
  }
  assert.equal(missing, 60)
})

test('New York, fall back 2026-11-01: 01:00 to 01:59 happens twice and the earlier is taken', () => {
  for (const { hour, minute } of minutesOf(1)) {
    const at = wallToInstant('America/New_York', 2026, 11, 1, hour, minute)
    assert.ok(Number.isFinite(at), `${hour}:${minute} is missing`)
    // Up to and including 01:59 the first time round is daylight time (UTC-4); from 02:00 on, standard (UTC-5).
    assert.equal(at, Date.UTC(2026, 10, 1, hour, minute) + (hour < 2 ? 4 : 5) * 3600_000, `${hour}:${minute}`)
  }
})

test('an ordinary day, a zone with no daylight saving and a half-hour zone', () => {
  assert.equal(wallToInstant('America/New_York', 2026, 10, 9, 6, 15), Date.UTC(2026, 9, 9, 10, 15))
  assert.equal(wallToInstant('UTC', 2026, 10, 9, 6, 15), Date.UTC(2026, 9, 9, 6, 15))
  assert.equal(wallToInstant('Asia/Kolkata', 2026, 10, 9, 6, 0), Date.UTC(2026, 9, 9, 0, 30))
  // Lord Howe moves its clocks by half an hour.
  assert.equal(wallToInstant('Australia/Lord_Howe', 2026, 10, 3, 12, 0), Date.UTC(2026, 9, 3, 1, 30))
  assert.equal(wallToInstant('Australia/Lord_Howe', 2026, 10, 4, 2, 15), null)
  assert.equal(wallToInstant('Australia/Lord_Howe', 2026, 10, 4, 3, 0), Date.UTC(2026, 9, 3, 16, 0))
})

// --- zone names --------------------------------------------------------------------------------------------

test('a zone is the same zone when its canonical name is the same, and a made-up one is no zone', () => {
  assert.equal(canonicalZone('America/New_York'), 'America/New_York')
  assert.equal(canonicalZone('US/Eastern'), canonicalZone('America/New_York'))
  assert.equal(canonicalZone('Asia/Kolkata'), canonicalZone('Asia/Calcutta'))
  assert.equal(canonicalZone('UTC'), 'UTC')
  assert.equal(canonicalZone('Etc/UTC'), 'UTC')
  for (const value of ['Mars/Olympus', '', 'Users/fakeperson', undefined, null, 5]) assert.equal(canonicalZone(value), null, String(value))
})

// --- due times ---------------------------------------------------------------------------------------------

test('due times: every example in the contract, daylight saving and the edges of the look-back included', () => {
  assert.ok(fixture.dueExamples.length >= 20)
  for (const example of fixture.dueExamples) {
    const expected = {}
    if (example.dueAt) expected.dueAt = example.dueAt
    if (example.dueBeforeAt) expected.dueBeforeAt = example.dueBeforeAt
    assert.deepEqual(dueTimes(example.cadence, example.zone, Date.parse(example.takenAt)), expected, example.why)
  }
  const words = fixture.dueExamples.map((example) => example.why).join(' | ')
  for (const need of ['spring forward', 'fall back', 'look-back']) assert.ok(words.includes(need), `no example for ${need}`)
  const zones = new Set(fixture.dueExamples.map((example) => example.zone))
  for (const zone of ['America/New_York', 'Europe/London', 'Australia/Sydney', 'Asia/Kolkata', 'UTC']) assert.ok(zones.has(zone), `no example in ${zone}`)
})

test('due times: the sample file\'s own due times are what the code works out for its cadences', () => {
  const sample = fixture.sample
  let checked = 0
  for (const item of [...sample.launchd.items, ...sample.hermes.items]) {
    if (item.disabled || item.enabled === false) continue
    const expected = {}
    if (item.dueAt) expected.dueAt = item.dueAt
    if (item.dueBeforeAt) expected.dueBeforeAt = item.dueBeforeAt
    assert.deepEqual(dueTimes(item.cadence, sample.timezone, Date.parse(sample.takenAt)), expected, item.label ?? item.name)
    checked += 1
  }
  assert.equal(checked, 7)
})

test('due times: the grace is 30 minutes, to the second', () => {
  const daily = { kind: 'slots', slots: [{ minute: 0, hour: 12 }] }
  const noon = Date.UTC(2026, 9, 9, 12, 0)
  assert.equal(dueTimes(daily, 'UTC', noon + 30 * 60_000).dueAt, '2026-10-09T12:00:00Z')
  assert.equal(dueTimes(daily, 'UTC', noon + 30 * 60_000 - 1000).dueAt, '2026-10-08T12:00:00Z')
  // The check time is whole seconds in the file, so a clock with milliseconds gives the same answer.
  assert.deepEqual(dueTimes(daily, 'UTC', noon + 30 * 60_000 + 999), dueTimes(daily, 'UTC', noon + 30 * 60_000))
  assert.deepEqual(dueTimes(daily, 'UTC', noon + 30 * 60_000 - 1), dueTimes(daily, 'UTC', noon + 30 * 60_000 - 1000))
})

test('due times: the look-back is the contract\'s 32 days', () => {
  assert.equal(LOOKBACK_DAYS, fixture.lookbackDays)
  // A job that last had a slot 33 days ago has no due time; 32 days and no more is found.
  const monthly = { kind: 'slots', slots: [{ minute: 0, hour: 0, day: 1 }] }
  assert.equal(dueTimes(monthly, 'UTC', Date.UTC(2026, 9, 3, 0, 30)).dueBeforeAt, '2026-09-01T00:00:00Z')
  assert.equal(dueTimes(monthly, 'UTC', Date.UTC(2026, 9, 3, 0, 30, 1)).dueBeforeAt, undefined)
  assert.deepEqual(dueTimes({ kind: 'slots', slots: [{ minute: 0, hour: 0, day: 31 }] }, 'UTC', Date.UTC(2026, 11, 5)), {})
})

test('due times: always, unknown, a zone this runtime does not know, and rubbish give none, and never throw', () => {
  const taken = Date.parse('2026-10-09T15:00:00Z')
  assert.deepEqual(dueTimes({ kind: 'always' }, 'UTC', taken), {})
  assert.deepEqual(dueTimes(UNKNOWN, 'UTC', taken), {})
  assert.deepEqual(dueTimes({ kind: 'slots', slots: [{ minute: 0 }] }, 'Mars/Olympus', taken), {})
  assert.deepEqual(dueTimes({ kind: 'slots', slots: [{ minute: 0 }] }, undefined, taken), {})
  assert.deepEqual(dueTimes({ kind: 'slots', slots: [{ minute: 0 }] }, 'UTC', NaN), {})
  for (const cadence of [null, undefined, 5, 'slots', [], {}, { kind: 'slots' }, { kind: 'slots', slots: 'x' }, { kind: 'every', minutes: 'x' }, { kind: 'every', minutes: 0 }, { kind: 'every', minutes: -3 }]) {
    assert.deepEqual(dueTimes(cadence, 'UTC', taken), {}, JSON.stringify(cadence))
  }
})

test('due times: always older than the check time, never more than two, newest first', () => {
  const taken = Date.parse('2026-10-09T15:00:00Z')
  for (const { cadence } of [...fixture.cronExamples, ...fixture.calendarExamples]) {
    for (const zone of ['America/New_York', 'UTC', 'Australia/Sydney']) {
      const due = dueTimes(cadence, zone, taken)
      assert.deepEqual(Object.keys(due).filter((key) => !['dueAt', 'dueBeforeAt'].includes(key)), [])
      if (due.dueAt) assert.ok(Date.parse(due.dueAt) <= taken - 30 * 60_000, `${zone} ${JSON.stringify(cadence)}`)
      if (due.dueBeforeAt) assert.ok(Date.parse(due.dueBeforeAt) < Date.parse(due.dueAt))
      if (due.dueBeforeAt) assert.ok(due.dueAt, 'a second time without a first')
    }
  }
})

test('due times: the days either side of both clock changes agree with a minute-by-minute walk', () => {
  // The slow, obvious way: walk back minute by minute from the limit and take the first two minutes
  // whose wall clock reads the slot's time. Slow enough that only a few days are checked, but every
  // day around each change, for a time of day that falls in, before and after the change.
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: 'numeric', minute: 'numeric' })
  const wallOf = (ms) => {
    const parts = Object.fromEntries(formatter.formatToParts(ms).map((part) => [part.type, Number(part.value)]))
    return [parts.hour === 24 ? 0 : parts.hour, parts.minute]
  }
  const slow = (hour, minute, limit) => {
    const found = []
    let probe = Math.floor(limit / 60_000) * 60_000
    for (let steps = 0; steps < 4 * 24 * 60 && found.length < 2; steps += 1, probe -= 60_000) {
      const [h, m] = wallOf(probe)
      // The earlier of two matching instants in an overlap: skip a match that has an earlier twin an hour before.
      if (h === hour && m === minute) {
        const [hBefore, mBefore] = wallOf(probe - 3600_000)
        const hasEarlierTwin = hBefore === hour && mBefore === minute && probe - 3600_000 >= 0
        if (!hasEarlierTwin) found.push(probe)
      }
    }
    return found
  }
  const changes = [Date.UTC(2027, 2, 14, 7), Date.UTC(2026, 10, 1, 6)]
  let compared = 0
  for (const change of changes) {
    for (let dayOffset = -2; dayOffset <= 2; dayOffset += 1) {
      for (const [hour, minute] of [[1, 30], [2, 30], [3, 30], [0, 5], [12, 0]]) {
        const taken = change + dayOffset * 86_400_000 + 5 * 3600_000
        const limit = taken - 30 * 60_000
        const expected = slow(hour, minute, limit).map((ms) => new Date(ms).toISOString().replace('.000Z', 'Z'))
        const got = dueTimes({ kind: 'slots', slots: [{ minute, hour }] }, 'America/New_York', taken)
        assert.deepEqual([got.dueAt, got.dueBeforeAt].filter(Boolean), expected, `${new Date(taken).toISOString()} ${hour}:${minute}`)
        compared += 1
      }
    }
  }
  assert.equal(compared, 50)
})
