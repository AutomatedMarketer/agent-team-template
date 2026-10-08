import test from 'node:test'
import assert from 'node:assert/strict'
import { read } from './helpers/repo.mjs'
import { ALIVE, HEARTBEAT, HERMES_CAPS, SESSION_DAYS, UPDATE_CHECK_MAX_AGE_DAYS, GATEWAY_STATES } from '../scripts/lib/status/hermes-schema.mjs'
import { makeFakeHome } from './helpers/fake-home.mjs'
import { runIn } from './helpers/hostile-home.mjs'

/* The Hermes card's paperwork: the status README (the file, its sources, what is never read, the
   heartbeat), runtimes.yml and the heartbeat folder's README (stale_after_minutes, with Hermes's 200),
   a beginner section and a how-it-works section in the Connections guides. These hold each one to
   the code: the words are the contract's, the numbers are the code's, and every file Hermes keeps
   private is named as never read. */

const flat = (text) => text.replace(/\s+/g, ' ')
const section = (text, heading) => {
  const start = text.indexOf(heading)
  assert.ok(start >= 0, `no section ${heading}`)
  const next = text.indexOf('\n## ', start + heading.length)
  return text.slice(start, next < 0 ? undefined : next)
}

// Every Hermes file that is never opened, in the words the docs use for it.
const NEVER_OPENED = ['.env', 'auth.json', 'SOUL.md', 'USER.md', 'memories', 'logs']

test('the status README names the Hermes file, its format, the part, the heartbeat and the contract', async () => {
  const doc = await read('.agent-team/status/README.md')
  for (const phrase of [
    '.agent-team/status/hermes/<computer>.json',
    'agent-status/hermes/v1',
    '--only usage,connections,hermes',
    HEARTBEAT.path,
    'tests/fixtures/hermes-parity.json',
    'gateway_state.json',
    'cron/ticker_heartbeat',
    'config.yaml',
    'state.db',
    '.update_check',
    'node:sqlite'
  ]) {
    assert.ok(doc.includes(phrase), `the status README does not mention ${phrase}`)
  }
  assert.ok(!doc.includes('`--only hermes` is refused'), 'the README still says Hermes is refused')
})

test('the status README says what the Hermes part reads, the alive rule, and the numbers the code uses', async () => {
  const doc = flat(section(await read('.agent-team/status/README.md'), '## The Hermes file'))
  assert.match(doc, /model\.default/)
  assert.match(doc, /model\.provider/)
  assert.match(doc, /never `?base_url`?/i)
  assert.match(doc, new RegExp(`${ALIVE.withinSeconds / 60} minutes`))
  assert.match(doc, new RegExp(`${HERMES_CAPS.profiles} profiles`))
  assert.match(doc, new RegExp(`${SESSION_DAYS} days`))
  assert.match(doc, new RegExp(`${UPDATE_CHECK_MAX_AGE_DAYS} days`))
  assert.match(doc, /needs a newer Node/)
  // The session count is taken from a private copy, and the docs say exactly that.
  assert.match(doc, /never opens Hermes's own file/i)
  assert.match(doc, /private copy/i)
  assert.match(doc, /never `state\.db-shm`/)
  assert.match(doc, /200 MB/)
  assert.doesNotMatch(doc, /opened \*\*read-only\*\*/, "the README still says Hermes's own state.db is opened read-only")
  assert.match(doc, /never runs? `?hermes`?/i)
  for (const state of Object.keys(GATEWAY_STATES)) assert.ok(doc.includes(`\`${state}\``), `the README does not list the gateway state ${state}`)
  for (const file of NEVER_OPENED) assert.ok(doc.includes(file), `the README does not say ${file} is never opened`)
})

test('the never-written list covers what Hermes keeps', async () => {
  const doc = flat(section(await read('.agent-team/status/README.md'), '## What is never written'))
  for (const word of ['memories', 'SOUL.md', 'USER.md', 'session titles', 'base_url', 'command line', 'chat']) {
    assert.match(doc, new RegExp(word.replace('.', '\\.'), 'i'), `the never-written list leaves out ${word}`)
  }
})

test('runtimes.yml and the heartbeat README show stale_after_minutes, with 200 for Hermes', async () => {
  const runtimes = await read('runtimes.yml')
  assert.match(runtimes, /stale_after_minutes: 200/)
  assert.match(runtimes, new RegExp(`heartbeat: ${HEARTBEAT.path.replaceAll('/', '\\/').replaceAll('.', '\\.')}`))
  assert.match(flat(runtimes), new RegExp(`${HEARTBEAT.staleAfterMinutes.min} to ${HEARTBEAT.staleAfterMinutes.max}`))
  assert.match(flat(runtimes), new RegExp(`default ${HEARTBEAT.staleAfterMinutes.default}`))
  assert.match(runtimes, /^runtimes: \[\]$/m, 'the shipped list must stay empty; the example stays a comment')
  const beat = flat(await read('runs/heartbeat/README.md'))
  assert.match(beat, /stale_after_minutes/)
  assert.match(beat, /200/)
  assert.match(beat, /only when/i)
  assert.match(beat, /status collector/i)
})

test('the beginner guide has a Hermes card section in plain words, after the words it uses', async () => {
  const doc = await read('docs/guides/connections-wall.md')
  const glossary = section(doc, '## Words used in this guide')
  for (const word of ['Hermes', 'Profile', 'Heartbeat']) assert.ok(glossary.includes(`**${word}**`), `the glossary does not explain ${word}`)
  const card = section(doc, '## The Hermes card')
  for (const words of [ALIVE.words.running, ALIVE.words.down, 'Not checked for', 'update available']) {
    assert.ok(card.includes(words), `the Hermes section does not explain "${words}"`)
  }
  for (const file of ['memories', 'SOUL.md', '.env']) assert.ok(card.includes(file), `the Hermes section does not say ${file} is never read`)
  assert.ok(doc.indexOf('## Words used in this guide') < doc.indexOf('## The Hermes card'))
})

test('the how-it-works guide lists every Hermes file read, what is kept, and the tests that hold it', async () => {
  const doc = await read('docs/guides/connections-wall-how-it-works.md')
  const card = flat(section(doc, '## The Hermes card'))
  for (const file of ['pyproject.toml', '.update_check', 'gateway_state.json', 'config.yaml', 'SKILL.md', 'state.db', 'cron/ticker_heartbeat']) {
    assert.ok(card.includes(file), `the explainer does not list ${file}`)
  }
  for (const file of NEVER_OPENED) assert.ok(card.includes(file), `the explainer does not say ${file} is never opened`)
  assert.match(card, /PRAGMA table_info/)
  assert.match(card, /never opened: `state\.db`, and `state\.db-wal`/)
  assert.match(card, /never `state\.db-shm`/)
  assert.match(card, /deleted in every case/)
  assert.match(card, /read-only/i)
  for (const test of ['tests/status-hermes.test.mjs', 'tests/status-hermes-run.test.mjs', 'tests/status-hermes-contract.test.mjs']) {
    assert.ok(card.includes(test), `the explainer does not name ${test}`)
  }
})

test('--help names the hermes part and that it never runs hermes', async () => {
  const fake = await makeFakeHome()
  try {
    const result = await runIn(fake, ['--help'])
    assert.equal(result.code, 0)
    assert.match(result.stdout, /--only usage,connections,hermes/)
    assert.match(result.stdout, /hermes: .*names only/i)
    assert.match(result.stdout, /never runs hermes/i)
    assert.match(result.stdout, /runs\/heartbeat\/hermes\.json/)
  } finally {
    await fake.cleanup()
  }
})

test('the README mentions the Hermes card beside the Connections wall', async () => {
  const readme = await read('README.md')
  assert.match(section(readme, '## The Connections wall'), /Hermes/)
})

test('the Mac section says what moving the pin to this version starts doing, and how to keep a part out', async () => {
  const doc = await read('.agent-team/status/README.md')
  const start = doc.indexOf('### What changes when you move the pin to this version')
  assert.ok(start > 0, 'no note on what a pin move to this version changes')
  const note = flat(doc.slice(start, doc.indexOf('\n### ', start + 1)))
  assert.match(note, /no `--only`/)
  assert.match(note, /runs `claude mcp list`/)
  assert.match(note, /starts every local server/)
  assert.match(note, /every 3 hours/)
  assert.match(note, /state\.db/)
  assert.match(note, /<string>--only<\/string> <string>usage,hermes<\/string>/)
  assert.match(note, /launchctl bootstrap/)
  assert.match(note, /not verified yet/i)
  // The schedule's own plist keeps running every part: the opt-out is the person's choice.
  const plist = /```xml\n([\s\S]*?)```/.exec(doc)?.[1] ?? ''
  assert.doesNotMatch(plist, /--only/)
  const unverified = flat(doc.slice(doc.lastIndexOf('### Not verified yet')))
  assert.match(unverified, /records the empty folder .* as a project/)
})

test('the status README says how leftover copies, a state folder in the clone and a part-way write are handled', async () => {
  const doc = flat(await read('.agent-team/status/README.md'))
  assert.match(doc, /Refused \(exit 2\) when it is inside the `--clone` folder/)
  assert.match(doc, /any `hermes-db-\.\.\.` folder in the state folder older than an hour is deleted/)
  assert.match(doc, /never a link/)
  assert.match(doc, /Some snapshot files may have been written; check \.agent-team\/status and runs\/heartbeat/)
  assert.match(doc, /Nothing was written/)
})
