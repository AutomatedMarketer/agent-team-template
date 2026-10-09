import test from 'node:test'
import assert from 'node:assert/strict'
import { read } from './helpers/repo.mjs'
import { parseSimpleYaml } from '../scripts/lib/yaml-lite.mjs'
import { JOBS_CAPS, GRACE_MINUTES, LOOKBACK_DAYS, JOBS_STALE_AFTER_HOURS, JOBS_FOLDER, JOBS_SCHEMA } from '../scripts/lib/status/jobs-schema.mjs'
import { MAX_PLISTS_READ, HERMES_RESULT_WORDS } from '../scripts/lib/status/jobs.mjs'

/* The jobs part's paperwork: the status README (the file, what is read, what is never kept, the Mac
   schedule note, what is not verified yet), the jobs.yml starter the board reads names and hiding
   from, and the one paragraph in the main README. Each is held to the code: the words are the
   contract's, the numbers are the code's, and every kind of thing a plist or a Hermes job carries
   beside its schedule is named as never kept. */

const flat = (text) => text.replace(/\s+/g, ' ')
const section = (text, heading) => {
  const start = text.indexOf(heading)
  assert.ok(start >= 0, `no section ${heading}`)
  const next = text.indexOf('\n## ', start + heading.length)
  return text.slice(start, next < 0 ? undefined : next)
}

test('the status README says there are four parts and lists the jobs file with its schema and contract', async () => {
  const doc = await read('.agent-team/status/README.md')
  assert.match(doc, /It writes four kinds, called \*\*parts\*\*/)
  for (const phrase of [
    '**jobs**',
    '.agent-team/status/jobs/<computer>.json',
    JOBS_SCHEMA,
    JOBS_FOLDER,
    '--only usage,connections,hermes,jobs',
    'tests/fixtures/jobs-parity.json',
    'scripts/lib/status/jobs-schema.mjs'
  ]) {
    assert.ok(doc.includes(phrase), `the status README does not mention ${phrase}`)
  }
})

test('the status README says what the jobs part reads, and with which programs', async () => {
  const doc = flat(section(await read('.agent-team/status/README.md'), '## The jobs file'))
  for (const phrase of ['~/Library/LaunchAgents', '/usr/bin/plutil', '/bin/launchctl list', 'cron/jobs.json', 'XPC_SERVICE_NAME', 'StartCalendarInterval', 'StartInterval', 'KeepAlive', 'RunAtLoad', 'Disabled', 'last_run_at', 'last_status']) {
    assert.ok(doc.includes(phrase), `the jobs section does not mention ${phrase}`)
  }
  assert.match(doc, /never `?\/Library`?/)
  assert.match(doc, /never runs? `?hermes`?/i)
  assert.match(doc, /modified time/i)
  assert.match(doc, /never opened/i)
  assert.match(doc, /empty folder/)
})

test('the status README gives the numbers the code uses', async () => {
  const doc = flat(section(await read('.agent-team/status/README.md'), '## The jobs file'))
  assert.match(doc, new RegExp(`${JOBS_CAPS.launchd} (LaunchAgents|launchd)`))
  assert.match(doc, new RegExp(`${JOBS_CAPS.hermes} Hermes`))
  assert.match(doc, new RegExp(`${JOBS_CAPS.slots} slots`))
  assert.match(doc, new RegExp(`${MAX_PLISTS_READ} plists`))
  assert.match(doc, new RegExp(`${GRACE_MINUTES} minutes`))
  assert.match(doc, new RegExp(`${LOOKBACK_DAYS} days`))
  assert.match(doc, new RegExp(`${JOBS_STALE_AFTER_HOURS} hours`))
  assert.match(doc, /1 MB/)
})

test('the status README explains the four cadences, the due times, daylight saving and the words that mean "not known"', async () => {
  const doc = flat(section(await read('.agent-team/status/README.md'), '## The jobs file'))
  for (const kind of ['always', 'every', 'slots', 'unknown']) assert.ok(doc.includes(`\`${kind}\``), `the jobs section does not explain the cadence ${kind}`)
  assert.match(doc, /dueAt/)
  assert.match(doc, /dueBeforeAt/)
  assert.match(doc, /clocks (jump|go forward)/i)
  assert.match(doc, /earlier one/i)
  assert.match(doc, /never says whether a job is (on time|late)/i)
  assert.match(doc, /a month/i)
  assert.match(doc, /day of the month together with a weekday|day and a weekday/i)
  assert.match(doc, /disabled/i)
  assert.match(doc, /self/)
  for (const words of Object.values(HERMES_RESULT_WORDS)) for (const word of words) assert.ok(doc.includes(word), `the jobs section leaves out the status word ${word}`)
})

test('the never-written list covers what a plist and a Hermes job carry beside their schedule', async () => {
  const doc = flat(section(await read('.agent-team/status/README.md'), '## What is never written'))
  for (const word of ['ProgramArguments', 'EnvironmentVariables', 'WorkingDirectory', 'prompt', 'last_error', 'error text', 'logs', 'where a job delivers']) {
    assert.match(doc, new RegExp(word, 'i'), `the never-written list leaves out ${word}`)
  }
  const jobs = flat(section(await read('.agent-team/status/README.md'), '## The jobs file'))
  assert.match(jobs, /never (read|kept)/i)
})

test('the receipts paragraph names the jobs sources, as statuses and a count', async () => {
  const doc = flat(section(await read('.agent-team/status/README.md'), '## Receipts'))
  assert.match(doc, /jobs: launchd and Hermes statuses and how many jobs/)
})

test('the Mac schedule note says what moving the pin to this version starts, and how to keep jobs out', async () => {
  const doc = await read('.agent-team/status/README.md')
  const start = doc.indexOf('### What changes when you move the pin to this version')
  assert.ok(start > 0)
  const note = flat(doc.slice(start, doc.indexOf('\n### ', start + 1)))
  assert.match(note, /adds three parts/)
  assert.match(note, /\*\*jobs\*\*/)
  assert.match(note, /\/usr\/bin\/plutil/)
  assert.match(note, /launchctl list/)
  assert.match(note, /nothing for Hermes/i)
  assert.match(note, /usage,connections,hermes/)
  assert.match(note, /<string>--only<\/string> <string>usage,hermes<\/string>/, 'the earlier opt-out is still shown')
  assert.match(note, /leaves out the connections part and the jobs part/)
})

test('what is not verified yet is said, not assumed', async () => {
  const doc = await read('.agent-team/status/README.md')
  const unverified = flat(doc.slice(doc.lastIndexOf('### Not verified yet')))
  for (const phrase of [
    'XPC_SERVICE_NAME',
    'launchctl list',
    'log file',
    'last_status',
    'schedule.kind',
    'Hermes job ids',
    'last_run_at',
    'KeepAlive'
  ]) {
    assert.ok(unverified.includes(phrase), `the not-verified list leaves out ${phrase}`)
  }
})

test('the main README tells a reader the jobs wall exists, and where to read how it works', async () => {
  const readme = await read('README.md')
  const wall = section(readme, '## The Readiness wall')
  assert.match(wall, /every scheduled job/i)
  assert.match(wall, /jobs\.yml/)
  assert.match(wall, /\.agent-team\/status\/README\.md#the-jobs-file/)
  assert.match(wall, /never/i)
})

// --- jobs.yml --------------------------------------------------------------------------------------------------------------

test('jobs.yml ships an empty list, so nothing is renamed or hidden until someone asks', async () => {
  const text = await read('jobs.yml')
  assert.match(text, /^jobs: \[\]$/m)
  assert.deepEqual(parseSimpleYaml(text).jobs, [])
})

test('jobs.yml says who reads it, who writes it, and what each id looks like', async () => {
  const text = flat(await read('jobs.yml'))
  assert.match(text, /Readiness/)
  assert.match(text, /never writes (this file|it)/i)
  assert.match(text, /ask/i)
  for (const id of ['launchd:<label>', 'hermes:<profile>/<id>', 'workflow:<slug>', 'routine:<name>']) assert.ok(text.includes(id), `jobs.yml does not show the id form ${id}`)
  assert.match(text, /name:/)
  assert.match(text, /hide: true/)
})

test('the commented examples in jobs.yml are real entries: uncommented, they parse into what they say', async () => {
  const lines = (await read('jobs.yml')).split(String.fromCharCode(10))
  const start = lines.indexOf('# jobs:')
  assert.ok(start >= 0, 'jobs.yml shows no example list')
  const block = [lines[start]]
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('#   ')) break
    block.push(line)
  }
  assert.ok(block.length >= 5, 'jobs.yml shows too few example lines')
  const parsed = parseSimpleYaml(block.map((line) => line.slice(2)).join(String.fromCharCode(10))).jobs
  assert.ok(parsed.length >= 2)
  assert.ok(parsed.every((entry) => typeof entry.id === 'string' && /^(launchd|hermes|workflow|routine):/.test(entry.id)))
  assert.ok(parsed.some((entry) => typeof entry.name === 'string' && entry.name.length > 0), 'no example renames a job')
  assert.ok(parsed.some((entry) => entry.hide === true), 'no example hides a job')
  const forms = new Set(parsed.map((entry) => entry.id.split(':')[0]))
  assert.ok(forms.size >= 3, 'the examples show too few kinds of id')
})
