import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './helpers/repo.mjs'
import {
  JOBS_SCHEMA,
  JOBS_FOLDER,
  JOBS_STALE_AFTER_HOURS,
  JOBS_MAX_FILES_READ,
  JOBS_MAX_FILE_BYTES,
  JOBS_CAPS,
  GRACE_MINUTES,
  LOOKBACK_DAYS,
  LAUNCHD_STATES,
  HERMES_RESULTS,
  UNNAMED_JOB,
  EXIT_CODE,
  CADENCE,
  LABEL,
  jobsPath
} from '../scripts/lib/status/jobs-schema.mjs'
import { MAX_COMPUTERS_SHOWN } from '../scripts/lib/status/connections-schema.mjs'
import { COMPUTER_SLUG, STATUSES } from '../scripts/lib/status/schema.mjs'
import { checkJobs, checkLabel, checkConnectionName } from '../scripts/lib/status/safe.mjs'
import { fakeClaudeToken, FAKE_EMAIL } from './helpers/fake-home.mjs'

/* tests/fixtures/jobs-parity.json is the shared contract for the Readiness wall - the same bytes in
   agent-team-template and agent-cockpit. The collector writes the file and the board reads it, with
   no import path between them, so each side mirrors the contract by hand and checks its own copy
   against the fixture. These hold the collector's side: every constant, the label rule with the
   examples both sides must agree on, and the gate on the whole file, which must accept the sample
   and refuse each way a file can be wrong - above all, any key that could carry a job's arguments,
   settings, folders, prompts or error text. */

const fixturePath = join(repoRoot, 'tests', 'fixtures', 'jobs-parity.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const identity = { username: 'fakeperson', home: '/Users/fakeperson', hostname: 'fake-host-77' }
const clone = (value) => structuredClone(value)

test('jobs parity: schema, folder, file name and the board\'s reading limits match', () => {
  assert.equal(JOBS_SCHEMA, fixture.schema)
  assert.equal(JOBS_FOLDER, fixture.folder)
  assert.equal(COMPUTER_SLUG.source, fixture.computerSlug)
  assert.equal(JOBS_STALE_AFTER_HOURS, fixture.staleAfterHours)
  assert.equal(JOBS_MAX_FILES_READ, fixture.maxFilesRead)
  assert.equal(JOBS_MAX_FILE_BYTES, fixture.maxFileBytes)
  assert.equal(MAX_COMPUTERS_SHOWN, fixture.maxComputersShown)
  assert.deepEqual(STATUSES, fixture.statuses)
  assert.equal(jobsPath('Mac Mini'), `${fixture.folder}/mac-mini.json`)
  assert.equal(jobsPath('???'), null)
})

test('jobs parity: caps, grace, look-back, states, results and the exit-code range match', () => {
  assert.deepEqual(JOBS_CAPS, fixture.caps)
  assert.equal(JOBS_CAPS.launchd, 60)
  assert.equal(JOBS_CAPS.hermes, 40)
  assert.equal(JOBS_CAPS.slots, 48)
  assert.equal(GRACE_MINUTES, fixture.graceMinutes)
  assert.equal(GRACE_MINUTES, 30, 'the same running grace the board uses for workflows')
  assert.equal(LOOKBACK_DAYS, fixture.lookbackDays)
  assert.deepEqual(LAUNCHD_STATES, fixture.launchdStates)
  assert.deepEqual(HERMES_RESULTS, fixture.hermesResults)
  assert.deepEqual(EXIT_CODE, fixture.exitCode)
})

test('jobs parity: the name a nameless job is shown under matches', () => {
  assert.equal(UNNAMED_JOB, fixture.unnamedJob)
  assert.equal(UNNAMED_JOB, 'Unnamed job')
  // It passes the name rule it stands in for.
  assert.deepEqual(checkConnectionName(UNNAMED_JOB, 'name', identity), [])
})

test('jobs parity: the four cadence kinds and every bound on them match', () => {
  assert.deepEqual(CADENCE.kinds, fixture.cadence.kinds)
  assert.deepEqual(CADENCE.kinds, ['always', 'every', 'slots', 'unknown'])
  assert.deepEqual(CADENCE.everyMinutes, fixture.cadence.everyMinutes)
  assert.deepEqual(CADENCE.slot, fixture.cadence.slot)
  assert.equal(CADENCE.slotRule, fixture.cadence.slotRule)
})

test('jobs parity: the label rule is written the same way on this side', () => {
  assert.equal(LABEL.pattern.source, fixture.names.label)
})

// --- the label rule -------------------------------------------------------------------------------------

test('labels: every accept example passes and every refuse example is refused', () => {
  for (const name of fixture.names.labelAccept) {
    assert.deepEqual(checkLabel(name, 'label', identity), [], `refused ${JSON.stringify(name)}`)
  }
  for (const { name, why } of fixture.names.labelRefuse) {
    assert.ok(checkLabel(name, 'label', identity).length > 0, `accepted ${JSON.stringify(name)} (${why})`)
  }
  assert.ok(checkLabel(123, 'label', identity).length > 0, 'a number is not a label')
})

test('labels: this computer\'s username, name and home folder are refused too', () => {
  for (const name of ['local.fakeperson.job', 'com.fake-host-77.sync', 'FAKEPERSON.job']) {
    assert.ok(checkLabel(name, 'label', identity).length > 0, `accepted ${name}`)
  }
})

test('a refused label is described, never repeated', () => {
  for (const { name } of fixture.names.labelRefuse.filter(({ name }) => name.length > 3)) {
    for (const problem of checkLabel(name, 'launchd.items[0].label', identity)) {
      assert.ok(!problem.includes(name.trim()), `the problem repeated the label: ${problem}`)
    }
  }
})

// --- the gate on the whole file ------------------------------------------------------------------------

const accepted = (doc) => assert.deepEqual(checkJobs(doc, identity), [])
function refused(change, pattern) {
  const doc = clone(fixture.sample)
  change(doc)
  const problems = checkJobs(doc, identity)
  assert.ok(problems.some((problem) => pattern.test(problem)), `not refused for ${pattern}: ${problems.join(' | ') || 'no problems'}`)
}

test('the gate accepts the sample, and every accept example as a launchd label and a Hermes job id', () => {
  accepted(fixture.sample)
  for (const name of fixture.names.labelAccept) {
    const doc = clone(fixture.sample)
    doc.launchd.items = [{ label: name, cadence: { kind: 'always' }, state: 'running' }]
    doc.hermes.items = [{ profile: 'default', id: name, name: 'A job', enabled: true, cadence: { kind: 'always' }, lastResult: 'unknown' }]
    accepted(doc)
  }
})

test('the sample uses every state, result and cadence kind at least once', () => {
  const words = JSON.stringify(fixture.sample)
  for (const state of fixture.launchdStates) assert.ok(words.includes(`"state":"${state}"`), state)
  for (const result of fixture.hermesResults) assert.ok(words.includes(`"lastResult":"${result}"`), result)
  for (const kind of fixture.cadence.kinds) assert.ok(words.includes(`"kind":"${kind}"`), kind)
  assert.ok(words.includes('"self":true'))
  assert.ok(words.includes('"disabled":true'))
  assert.ok(words.includes('"enabled":false'))
})

test('the gate refuses every refuse example wherever a label goes', () => {
  for (const { name } of fixture.names.labelRefuse) {
    refused((doc) => { doc.launchd.items[0].label = name }, /launchd\.items\[0\]\.label/)
    refused((doc) => { doc.hermes.items[0].id = name }, /hermes\.items\[0\]\.id/)
  }
})

test('the gate refuses every key a job\'s arguments, settings, folders, prompts or error text could travel under', () => {
  const planted = fakeClaudeToken()
  for (const key of ['ProgramArguments', 'EnvironmentVariables', 'WorkingDirectory', 'StandardOutPath', 'StandardErrorPath', 'args', 'env', 'path', 'program', 'pid']) {
    refused((doc) => { doc.launchd.items[0][key] = planted }, new RegExp(`launchd\\.items\\[0\\]\\.${key}: is not an allowed key`))
  }
  for (const key of ['prompt', 'last_error', 'lastError', 'error', 'deliver', 'origin', 'script', 'schedule', 'expr', 'next_run_at']) {
    refused((doc) => { doc.hermes.items[0][key] = planted }, new RegExp(`hermes\\.items\\[0\\]\\.${key}: is not an allowed key`))
  }
  refused((doc) => { doc.launchd.items[0].cadence.expr = '0 6 * * *' }, /launchd\.items\[0\]\.cadence\.expr: is not an allowed key/)
  refused((doc) => { doc.launchd.items[0].cadence.slots[0].command = 'x' }, /cadence\.slots\[0\]\.command: is not an allowed key/)
  refused((doc) => { doc.launchd.items[1].cadence.slots[0].month = 10 }, /cadence\.slots\[0\]\.month: is not an allowed key/)
  refused((doc) => { doc.launchd.logPath = 'x' }, /launchd\.logPath: is not an allowed key/)
  refused((doc) => { doc.hermes.root = 'x' }, /hermes\.root: is not an allowed key/)
  refused((doc) => { doc.extra = 1 }, /^extra: is not an allowed key/)
  refused((doc) => { doc.schema = 'agent-status/jobs/v2' }, /schema: is not agent-status\/jobs\/v1/)
  refused((doc) => { delete doc.timezone }, /timezone: is missing/)
  refused((doc) => { delete doc.hermes }, /hermes: is missing/)
})

test('a job name, label or profile that is a token, an email or a path never gets through, and is not repeated', () => {
  const planted = fakeClaudeToken()
  const cases = [
    [(doc) => { doc.hermes.items[0].name = `brief ${planted}` }, /hermes\.items\[0\]\.name/],
    [(doc) => { doc.hermes.items[0].name = FAKE_EMAIL }, /hermes\.items\[0\]\.name/],
    [(doc) => { doc.hermes.items[0].name = 'run /Users/fakeperson/brief.sh' }, /hermes\.items\[0\]\.name/],
    [(doc) => { doc.hermes.items[0].profile = 'Donna' }, /hermes\.items\[0\]\.profile/],
    [(doc) => { doc.launchd.items[0].label = `local.${planted}` }, /launchd\.items\[0\]\.label/]
  ]
  for (const [change, pattern] of cases) {
    const doc = clone(fixture.sample)
    change(doc)
    const problems = checkJobs(doc, identity)
    assert.ok(problems.some((problem) => pattern.test(problem)), `not refused: ${pattern}`)
    for (const problem of problems) {
      assert.ok(!problem.includes(planted) && !problem.includes(FAKE_EMAIL), `the problem repeated the value: ${problem}`)
    }
  }
})

test('gate types: states, results, times and numbers are held to their exact form', () => {
  refused((doc) => { doc.launchd.items[0].state = 'Loaded' }, /launchd\.items\[0\]\.state: is not one of the allowed values/)
  refused((doc) => { doc.launchd.items[0].state = 'crashed' }, /launchd\.items\[0\]\.state: is not one of the allowed values/)
  refused((doc) => { doc.hermes.items[0].lastResult = 'success' }, /hermes\.items\[0\]\.lastResult: is not one of the allowed values/)
  refused((doc) => { doc.launchd.items[0].lastReportAt = '2026-10-09T13:00:41+00:00' }, /launchd\.items\[0\]\.lastReportAt: is not an ISO time/)
  refused((doc) => { doc.launchd.items[0].dueAt = 'soon' }, /launchd\.items\[0\]\.dueAt: is not an ISO time/)
  refused((doc) => { doc.hermes.items[0].lastRunAt = '2026-02-31T10:00:00Z' }, /hermes\.items\[0\]\.lastRunAt: is not an ISO time/)
  refused((doc) => { doc.takenAt = '2026-10-09 15:00:00' }, /takenAt: is not an ISO time/)
  refused((doc) => { doc.timezone = 'Users/fakeperson' }, /timezone/)
  refused((doc) => { doc.timezone = 'Mars/Olympus' }, /timezone: is not a known timezone/)
  refused((doc) => { doc.hermes.items[0].enabled = 'yes' }, /hermes\.items\[0\]\.enabled: is not true or false/)
  refused((doc) => { doc.launchd.items[0].self = false }, /launchd\.items\[0\]\.self: must be true/)
  refused((doc) => { doc.launchd.items[5].disabled = false }, /launchd\.items\[5\]\.disabled: must be true/)
  for (const code of [256, -256, 1.5, '0', null]) {
    refused((doc) => { doc.launchd.items[0].lastExit = code }, /launchd\.items\[0\]\.lastExit: is not a whole number from -255 to 255/)
  }
  for (const key of ['hidden', 'more']) {
    refused((doc) => { doc.launchd[key] = -1 }, new RegExp(`launchd\\.${key}: is not a whole number`))
    refused((doc) => { doc.hermes[key] = 1.5 }, new RegExp(`hermes\\.${key}: is not a whole number`))
  }
  const edge = clone(fixture.sample)
  edge.launchd.items[0].lastExit = -255
  edge.launchd.items[1].lastExit = 255
  accepted(edge)
})

test('cadence: each kind carries exactly its own keys, inside its own bounds', () => {
  const cadenceOf = (change) => (doc) => change(doc.launchd.items[0])
  refused(cadenceOf((item) => { item.cadence = { kind: 'weekly' } }), /cadence\.kind: is not one of the allowed values/)
  refused(cadenceOf((item) => { item.cadence = {} }), /cadence\.kind: is not one of the allowed values/)
  refused(cadenceOf((item) => { item.cadence = 'every day' }), /cadence: is not an object/)
  refused(cadenceOf((item) => { item.cadence = { kind: 'always', minutes: 5 } }), /cadence\.minutes: is not an allowed key/)
  refused(cadenceOf((item) => { item.cadence = { kind: 'unknown', slots: [] } }), /cadence\.slots: is not an allowed key/)
  refused(cadenceOf((item) => { item.cadence = { kind: 'every' } }), /cadence\.minutes: is missing/)
  refused(cadenceOf((item) => { item.cadence = { kind: 'every', minutes: 0 } }), /cadence\.minutes: is not a whole number from 1 to 44640/)
  refused(cadenceOf((item) => { item.cadence = { kind: 'every', minutes: 44641 } }), /cadence\.minutes: is not a whole number from 1 to 44640/)
  refused(cadenceOf((item) => { item.cadence = { kind: 'every', minutes: 2.5 } }), /cadence\.minutes: is not a whole number/)
  refused(cadenceOf((item) => { item.cadence = { kind: 'slots' } }), /cadence\.slots: is missing/)
  refused(cadenceOf((item) => { item.cadence = { kind: 'slots', slots: [] } }), /cadence\.slots: has too few entries/)
  for (const [key, value] of [['minute', 60], ['minute', -1], ['hour', 24], ['weekday', 7], ['weekday', -1], ['day', 0], ['day', 32], ['hour', '6']]) {
    refused(cadenceOf((item) => { item.cadence = { kind: 'slots', slots: [{ minute: 0, [key]: value }] } }), new RegExp(`cadence\\.slots\\[0\\]\\.${key}: is not a whole number`))
  }
  refused(cadenceOf((item) => { item.cadence = { kind: 'slots', slots: [{ hour: 6 }] } }), /cadence\.slots\[0\]\.minute: is missing/)
  refused(cadenceOf((item) => { item.cadence = { kind: 'slots', slots: [{ minute: 0, weekday: 1, day: 1 }] } }), /cadence\.slots\[0\]\.day: is not allowed together with a weekday/)
  refused(cadenceOf((item) => { item.cadence = { kind: 'slots', slots: [{ minute: 0, hour: 6 }, { minute: 0, hour: 6 }] } }), /cadence\.slots: names the same entry twice/)
  for (const cadence of [{ kind: 'always' }, { kind: 'unknown' }, { kind: 'every', minutes: 1 }, { kind: 'every', minutes: 44640 }, { kind: 'slots', slots: [{ minute: 59, hour: 23, weekday: 6 }] }, { kind: 'slots', slots: [{ minute: 0, day: 31 }] }]) {
    const doc = clone(fixture.sample)
    doc.launchd.items[0].cadence = cadence
    delete doc.launchd.items[0].dueAt
    delete doc.launchd.items[0].dueBeforeAt
    if (cadence.kind === 'slots' || cadence.kind === 'every') {
      doc.launchd.items[0].dueAt = '2026-10-09T13:00:00Z'
      doc.launchd.items[0].dueBeforeAt = '2026-10-09T10:00:00Z'
    }
    accepted(doc)
  }
})

test('slots: at most 48 per job', () => {
  const slots = (count) => Array.from({ length: count }, (_, index) => ({ minute: index % 60, hour: Math.floor(index / 60) }))
  const ok = clone(fixture.sample)
  ok.launchd.items[0].cadence = { kind: 'slots', slots: slots(fixture.caps.slots) }
  accepted(ok)
  refused((doc) => { doc.launchd.items[0].cadence = { kind: 'slots', slots: slots(fixture.caps.slots + 1) } }, /cadence\.slots: has more than 48/)
})

test('due times: only with a schedule that has set times, never on a switched-off job, never after the grace', () => {
  refused((doc) => { delete doc.launchd.items[0].dueAt }, /launchd\.items\[0\]\.dueBeforeAt: is only allowed with dueAt/)
  refused((doc) => { doc.launchd.items[0].dueBeforeAt = doc.launchd.items[0].dueAt }, /launchd\.items\[0\]\.dueBeforeAt: is not before dueAt/)
  refused((doc) => { doc.launchd.items[0].dueBeforeAt = '2026-10-09T14:00:00Z' }, /launchd\.items\[0\]\.dueBeforeAt: is not before dueAt/)
  refused((doc) => { doc.launchd.items[4].dueAt = '2026-10-09T10:00:00Z' }, /launchd\.items\[4\]\.dueAt: is only allowed for a schedule with set times/)
  refused((doc) => { doc.hermes.items[2].cadence = { kind: 'unknown' }; doc.hermes.items[2].enabled = true; doc.hermes.items[2].dueAt = '2026-10-09T10:00:00Z' }, /hermes\.items\[2\]\.dueAt: is only allowed for a schedule with set times/)
  refused((doc) => { doc.launchd.items[5].dueAt = '2026-10-06T13:00:00Z' }, /launchd\.items\[5\]\.dueAt: is not allowed on a switched-off job/)
  refused((doc) => { doc.hermes.items[2].cadence = { kind: 'slots', slots: [{ minute: 0, hour: 9 }] }; doc.hermes.items[2].dueAt = '2026-10-09T13:00:00Z' }, /hermes\.items\[2\]\.dueAt: is not allowed on a switched-off job/)
  // takenAt is 15:00:00Z and the grace is 30 minutes, so 14:30:00Z is the last time that can be due.
  refused((doc) => { doc.launchd.items[0].dueAt = '2026-10-09T14:30:01Z' }, /launchd\.items\[0\]\.dueAt: is later than the check time minus the grace/)
  refused((doc) => { doc.hermes.items[0].dueAt = '2026-10-09T14:45:00Z' }, /hermes\.items\[0\]\.dueAt: is later than the check time minus the grace/)
  const exactly = clone(fixture.sample)
  exactly.launchd.items[0].dueAt = '2026-10-09T14:30:00Z'
  accepted(exactly)
})

test('a launchd job reports an exit status only when launchctl lists it', () => {
  refused((doc) => { doc.launchd.items[3].lastExit = 0 }, /launchd\.items\[3\]\.lastExit: is only allowed on a job that is listed/)
  const running = clone(fixture.sample)
  running.launchd.items[4].lastExit = 0
  accepted(running)
})

test('each label once per computer, each Hermes job once per profile', () => {
  refused((doc) => { doc.launchd.items.push(clone(doc.launchd.items[1])) }, /launchd\.items: names the same entry twice/)
  refused((doc) => { doc.hermes.items.push({ ...clone(doc.hermes.items[0]), name: 'Another name, same id' }) }, /hermes\.items: names the same entry twice/)
  const otherProfile = clone(fixture.sample)
  otherProfile.hermes.items.push({ ...clone(otherProfile.hermes.items[0]), profile: 'coder' })
  accepted(otherProfile)
})

test('the caps are the gate\'s, not one more', () => {
  const launchd = (count) => Array.from({ length: count }, (_, index) => ({ label: `local.job-${index}`, cadence: { kind: 'always' }, state: 'running' }))
  const hermes = (count) => Array.from({ length: count }, (_, index) => ({ profile: 'default', id: `job-${index}`, name: `Job ${index}`, enabled: true, cadence: { kind: 'always' }, lastResult: 'unknown' }))
  const ok = clone(fixture.sample)
  ok.launchd.items = launchd(fixture.caps.launchd)
  ok.hermes.items = hermes(fixture.caps.hermes)
  accepted(ok)
  refused((doc) => { doc.launchd.items = launchd(fixture.caps.launchd + 1) }, /launchd\.items: has more than 60/)
  refused((doc) => { doc.hermes.items = hermes(fixture.caps.hermes + 1) }, /hermes\.items: has more than 40/)
})

test('a block that found nothing carries only its status and a reason', () => {
  refused((doc) => { doc.launchd = { status: 'not found', items: [] } }, /launchd\.items: is not an allowed key/)
  refused((doc) => { doc.hermes = { status: 'unavailable', why: 'could not be read', hidden: 0 } }, /hermes\.hidden: is not an allowed key/)
  refused((doc) => { doc.launchd = { status: 'running' } }, /launchd\.status: is not one of the allowed values/)
  refused((doc) => { delete doc.launchd.hidden }, /launchd\.hidden: is missing/)
  refused((doc) => { delete doc.hermes.items }, /hermes\.items: is missing/)
  const empty = clone(fixture.sample)
  empty.launchd = { status: 'not found' }
  empty.hermes = { status: 'unavailable', why: 'could not be read' }
  accepted(empty)
  const none = clone(fixture.sample)
  none.launchd = { status: 'found', items: [], hidden: 2, more: 0 }
  accepted(none)
})

test('the sample is far smaller than the most the board will read', () => {
  assert.ok(JSON.stringify(fixture.sample, null, 2).length < fixture.maxFileBytes / 4)
})

test('the two repos hold the same jobs contract, byte for byte', (t) => {
  const sibling = join(repoRoot, '..', 'agent-cockpit', 'tests', 'fixtures', 'jobs-parity.json')
  if (!existsSync(sibling)) {
    t.skip('NOT CHECKED: agent-cockpit has no tests/fixtures/jobs-parity.json beside this repo, so the two copies of the jobs contract could not be compared. The tests above still check this copy against the collector.')
    return
  }
  assert.equal(readFileSync(sibling, 'utf8'), readFileSync(fixturePath, 'utf8'), 'the shared jobs contract has been edited on one side only')
})
