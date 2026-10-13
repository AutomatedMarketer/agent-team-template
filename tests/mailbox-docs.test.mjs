import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { read, exists } from './helpers/repo.mjs'
import { ALLOWED_ORDERS, CEILINGS, readAllowedOrders } from '../scripts/lib/mailbox/allow.mjs'
import { ACTIONS, KEY_SHAPE, SECRET_SHAPE } from '../scripts/lib/mailbox/contract.mjs'
import { defaultPlaces } from '../scripts/lib/mailbox/places.mjs'
import { readMailboxEnv } from '../scripts/lib/mailbox/keys.mjs'
import { TOOLS, buildArgv } from '../scripts/lib/mailbox/claude.mjs'
import { knownJobs } from '../scripts/lib/mailbox/jobs.mjs'
import { mailboxPath } from '../scripts/lib/status/mailbox-schema.mjs'

/* The Mac guide is the only thing standing between Nuno and a mistyped command on an always-on computer. These hold
   each claim in it to the code: the places are the code's own, the example allowlist is one the runner accepts, the
   words in the troubleshooting table are words the code prints, the flags named are the flags it uses, the numbers
   are its numbers, and every file and link it names exists. */

const GUIDE = '.agent-team/mailbox/README.md'
const guide = () => read(GUIDE)
const flat = (text) => text.replace(/\s+/g, ' ')
const section = (text, from, to) => text.slice(text.indexOf(from), to ? text.indexOf(to, text.indexOf(from) + from.length) : undefined)

// The code builds its paths with the system's separator; the guide is for a Mac.
const unix = (path) => path.replaceAll('\\', '/')

const blocks = (text) => [...text.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map((match) => ({ language: match[1], body: match[2] }))

test('the guide has the eight steps, in order, and every paste block says it is for the Mac Mini', async () => {
  const doc = await guide()
  const steps = [...doc.matchAll(/^### (\d+)\. (.+)$/gm)].map((match) => Number(match[1]))
  assert.deepEqual(steps, [1, 2, 3, 4, 5, 6, 7, 8])
  for (const block of blocks(doc).filter((one) => one.language === 'bash')) {
    assert.match(block.body, /^# on the Mac Mini/, `a paste block does not say where it is for: ${block.body.split('\n')[0]}`)
  }
})

test('the guide explains its words before it uses them', async () => {
  const doc = await guide()
  const words = section(doc, '## Words used in this guide', '## What it does')
  for (const word of ['Board', 'Order', 'Runner', 'Allowlist', 'Claim', 'Work copy', 'Team repo']) {
    assert.ok(words.includes(`**${word}**`), `the glossary does not explain ${word}`)
  }
  assert.ok(doc.indexOf('## Words used in this guide') < doc.indexOf('## Set it up'))
  assert.ok(doc.indexOf('## Words used in this guide') < doc.indexOf('## Where things live'))
})

test('the folders in the guide are the places the code uses', async () => {
  const doc = await guide()
  const places = defaultPlaces('/HOME')
  for (const [name, path] of Object.entries(places)) {
    const shown = unix(path).replace('/HOME', '~')
    assert.ok(doc.includes(shown), `the guide does not name ${name} as ${shown}`)
  }
})

test('every file the guide tells you to copy or run exists in the repo', async () => {
  const doc = await guide()
  const named = new Set([...doc.matchAll(/runner-code\/([A-Za-z0-9._\/-]+)/g)].map((match) => match[1]))
  assert.ok(named.size >= 3, 'the guide names almost no files')
  for (const file of named) assert.ok(await exists(file), `the guide names ${file}, which is not in the repo`)
})

// --- the example allowlist ---------------------------------------------------------------------------------------

const EXAMPLE = '.agent-team/mailbox/allowed-orders.example.yml'

async function readExample() {
  const dir = await mkdtemp(join(tmpdir(), 'mailbox-docs-'))
  try {
    await writeFile(join(dir, ALLOWED_ORDERS.file), await read(EXAMPLE))
    return await readAllowedOrders(dir, { hostname: 'nunos-mac', username: 'nunotavares' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('the example allowlist is one the runner accepts as it stands, and allows what was decided', async () => {
  const result = await readExample()
  assert.equal(result.state, 'ok', `the example does not read: ${result.why}`)
  assert.deepEqual([...result.allow.jobs.keys()].sort(), ['morning-intel', 'task-sweep'])
  assert.deepEqual([...result.allow.actions].sort(), [...ACTIONS].sort())
  assert.deepEqual(result.allow.perDay, { orders: CEILINGS.orders, runs: CEILINGS.runs })
  for (const [job, minutes] of result.allow.jobs) {
    assert.ok(knownJobs().includes(job), `${job} is not a job the runner has rules for`)
    assert.ok(minutes <= CEILINGS.minutes)
  }
})

test('the example allowlist names placeholders to change, and its comments give the code\'s own ceilings', async () => {
  const text = await read(EXAMPLE)
  assert.match(text, /^board: https:\/\/YOUR-BOARD\./m)
  assert.match(text, /^repo: YOUR-GITHUB-NAME\/YOUR-TEAM-REPO$/m)
  assert.ok(text.includes(`${CEILINGS.orders} orders and ${CEILINGS.runs} runs`), 'the example does not say the daily ceilings')
  assert.ok(text.includes(`(${CEILINGS.minutes} at most)`), 'the example does not say the longest a job may run')
})

// --- the secrets -----------------------------------------------------------------------------------------------

test('the commands that make the secrets make values the runner accepts, in lines it reads', async () => {
  const doc = await guide()
  assert.ok(doc.includes('openssl rand -hex 32'))
  assert.ok(doc.includes('openssl rand -base64 32'))
  assert.ok(doc.includes('MAILBOX_KEY=$(openssl rand -hex 32)'))
  assert.ok(doc.includes('MAILBOX_SECRET_k1=$(openssl rand -base64 32)'))
  const key = randomBytes(32).toString('hex')
  const secret = randomBytes(32).toString('base64')
  assert.match(key, KEY_SHAPE)
  assert.match(secret, SECRET_SHAPE)

  const dir = await mkdtemp(join(tmpdir(), 'mailbox-docs-env-'))
  try {
    const file = join(dir, 'env')
    await writeFile(file, `MAILBOX_KEY=${key}\nMAILBOX_SECRET_k1=${secret}\n`)
    const read = await readMailboxEnv(file, { platform: 'win32' })
    assert.equal(read.state, 'ok')
    assert.equal(read.key, key)
    assert.equal(read.secrets.get('k1'), secret)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the guide never asks you to print a secret', async () => {
  const doc = await guide()
  for (const block of blocks(doc).filter((one) => one.language === 'bash')) {
    // A secret goes to the clipboard or into a file, never to the screen.
    assert.doesNotMatch(block.body, /\bcat\b[^\n]*(env|secret)/i, `a block prints the secrets file: ${block.body.split('\n')[0]}`)
    assert.doesNotMatch(block.body, /\becho\b[^\n]*\$MAILBOX/, 'a block echoes a secret')
  }
  assert.ok(doc.includes('pbcopy'), 'the guide does not copy the secrets to the clipboard')
})

test('the Vercel names in the guide agree with the allowlist example and with each other', async () => {
  const doc = flat(await guide())
  const example = await read(EXAMPLE)
  for (const setting of ['FIRE_MODE=mailbox', 'MAILBOX_KEY', 'MAILBOX_SECRET', 'MAILBOX_SECRET_ID=k1', 'MAILBOX_RUNNER=mac-mini', 'MAILBOX_POLL_SECONDS=300', 'FIRE_KEY']) {
    assert.ok(doc.includes(setting), `the guide does not name ${setting}`)
  }
  assert.match(example, /^runner: mac-mini$/m)
  assert.match(doc, /24 or more characters/)
})

// --- the schedule ----------------------------------------------------------------------------------------------

const PLIST = '.agent-team/mailbox/local.donna.cockpit-mailbox.plist'

const plistValue = (plist, key) => new RegExp(`<key>${key}</key>\\s*<(?:string|integer)>([^<]*)</(?:string|integer)>`).exec(plist)?.[1]

test('the schedule file runs the runner every five minutes, from the pinned code, as the logged-in user', async () => {
  const plist = await read(PLIST)
  assert.equal(plistValue(plist, 'Label'), 'local.donna.cockpit-mailbox')
  assert.equal(plistValue(plist, 'StartInterval'), '300')
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/)
  assert.equal(plistValue(plist, 'LimitLoadToSessionType'), 'Aqua')

  const places = defaultPlaces('/Users/YOUR-MAC-USER')
  const program = posix.join(unix(places.codeDir), 'scripts', 'mailbox-runner.mjs')
  assert.ok(plist.includes(`<string>${program}</string>`), `the schedule does not run ${program}`)
  assert.ok(await exists('scripts/mailbox-runner.mjs'))
  assert.match(plist, /<string>\/usr\/bin\/env<\/string>\s*<string>node<\/string>/)

  for (const key of ['StandardOutPath', 'StandardErrorPath']) {
    assert.equal(plistValue(plist, key), posix.join(unix(places.stateDir), 'runner.log'))
  }
  const path = plistValue(plist, 'PATH') ?? ''
  for (const entry of path.split(':')) assert.ok(entry.startsWith('/'), `PATH has a relative entry: ${entry}`)
})

test('the schedule file holds nothing secret and one placeholder', async () => {
  const plist = await read(PLIST)
  assert.doesNotMatch(plist, /ANTHROPIC|MAILBOX_(KEY|SECRET)|FIRE_KEY|TOKEN|PASSWORD/i)
  assert.deepEqual([...new Set(plist.match(/YOUR-[A-Z-]+/g))], ['YOUR-MAC-USER'])
  const doc = await guide()
  assert.ok(doc.includes('s#YOUR-MAC-USER#$(whoami)#g'), 'the guide does not fill in the user name')
  assert.ok(doc.includes('StartInterval 300'))
  assert.ok(doc.includes('local.donna.cockpit-mailbox'))
})

test('the guide has the runner run once with nothing waiting before the first order, because an order made before it first ran is refused', async () => {
  const doc = await guide()
  const step = section(doc, '### 7. One order, watched', '### 8.')
  const runs = [...step.matchAll(/mailbox-runner\.mjs --once/g)]
  assert.equal(runs.length, 2, 'step 7 should run the check twice: once empty, once with the order')
  assert.ok(step.indexOf('mailbox-runner.mjs --once') < step.indexOf('Add task'), 'the empty check comes before the order')
  assert.match(flat(step), /refuses any order made before it first ran/)
  // That is the code's rule, not the guide's wish: the claims folder remembers the day it began and the check uses it.
  const tick = await read('scripts/lib/mailbox/tick.mjs')
  assert.ok(tick.includes('claimsSince: store.since'))
})

test('the pause switch and the rollback are in the guide, and the pause file is the one the code reads', async () => {
  const doc = await guide()
  const tick = await read('scripts/lib/mailbox/tick.mjs')
  assert.ok(tick.includes("join(places.stateDir, 'PAUSE')"))
  assert.ok(doc.includes('touch ~/.local/state/agent-mailbox/PAUSE'))
  assert.ok(doc.includes('launchctl bootout'))
  assert.ok(doc.includes('FIRE_MODE=cloud'))
})

// --- the words the guide uses for what goes wrong --------------------------------------------------------------

test('every word in the troubleshooting table is a word the code prints', async () => {
  const doc = await guide()
  const sources = {
    tick: await read('scripts/lib/mailbox/tick.mjs'),
    board: await read('scripts/lib/mailbox/board.mjs'),
    keys: await read('scripts/lib/mailbox/keys.mjs'),
    places: await read('scripts/lib/mailbox/places.mjs'),
    cli: await read('scripts/lib/mailbox/command.mjs')
  }
  // [the words in the guide (null: a reason the guide shows inside another), the file that makes them, what to find there]
  const words = [
    ['unavailable (no-allowlist)', 'tick', "'no-allowlist'"],
    ['unavailable (allowlist-board)', 'tick', 'allowlist-${'],
    ['unavailable (keys-mode)', 'tick', 'keys-${'],
    [null, 'keys', "return 'mode'"],
    ['not-ready (places-...)', 'tick', 'places-${'],
    ['not-ready (key-in-environment)', 'tick', "'key-in-environment'"],
    ['not-ready (origin-mismatch)', 'tick', "'origin-mismatch'"],
    ['not-ready (work-...)', 'tick', 'work-${'],
    ['board-failed (board-refused)', 'board', "'board-refused'"],
    ['board-failed (board-unreachable)', 'board', "'board-unreachable'"],
    ['board-failed (board-bad-answer)', 'board', "'board-bad-answer'"],
    ['stopped (store)', 'tick', "end('stopped', 'store')"],
    ['stopped (claim-failed)', 'tick', "'claim-failed'"],
    ['stopped (counts-damaged)', 'tick', "'counts-damaged'"]
  ]
  for (const [wording, file, needle] of words) {
    if (wording !== null) assert.ok(doc.includes(`\`${wording}\``), `the guide does not show \`${wording}\``)
    assert.ok(sources[file].includes(needle), `${file} does not make ${wording} (looked for ${needle})`)
  }
  // The log line the guide quotes is the one the tick writes.
  assert.ok(doc.includes('mailbox tick: done - 1 claimed, 1 done, 0 refused, 0 failed'))
  assert.ok(sources.tick.includes('`mailbox tick: ${state}${why ? ` (${why})` : \'\'} - ${'))
})

test('the files the guide says to look at are the files the code writes', async () => {
  const doc = await guide()
  const tick = await read('scripts/lib/mailbox/tick.mjs')
  const allow = await read('scripts/lib/mailbox/allow.mjs')
  const claims = await read('scripts/lib/mailbox/claims.mjs')
  assert.ok(doc.includes('last-tick.json') && tick.includes("'last-tick.json'"))
  assert.ok(doc.includes('claims/<id>.claim/') && claims.includes("folder: 'claims'") && tick.includes('`${id}.claim`'))
  assert.ok(doc.includes('counts/') && allow.includes("'counts'"))
  assert.ok(doc.includes('.agent-team/status/mailbox/<computer>.json'))
  assert.equal(mailboxPath('mac-mini'), '.agent-team/status/mailbox/mac-mini.json')
})

// --- the safety table ------------------------------------------------------------------------------------------

test('the safety table names the flags the runner really passes, and the tools it really allows', async () => {
  const doc = await guide()
  const argv = buildArgv({ prompt: 'p', model: 'sonnet', codeDir: '/code', permissionPrompts: true })
  for (const flag of ['--setting-sources', '--permission-mode', '--disallowedTools', '--strict-mcp-config', '--disable-slash-commands', '--tools']) {
    assert.ok(doc.includes(flag), `the guide does not name ${flag}`)
    assert.ok(argv.includes(flag), `the runner does not pass ${flag}`)
  }
  assert.ok(doc.includes('--setting-sources user') && argv.join(' ').includes('--setting-sources user'))
  assert.ok(doc.includes('--permission-mode dontAsk') && argv.join(' ').includes('--permission-mode dontAsk'))
  assert.ok(doc.includes('--disallowedTools "mcp__*"') && argv.join(' ').includes('--disallowedTools mcp__*'))
  assert.equal(TOOLS.length, 7)
  assert.ok(!TOOLS.includes('Bash'))
  assert.match(flat(doc), /names seven built-in tools and Bash is not one/)
  assert.ok(!argv.includes('--bare'), 'a run on the subscription login cannot use --bare')
})

test('the settings file the runner passes switches hooks off and denies the folders the guide lists', async () => {
  const settings = JSON.parse(await read('.agent-team/mailbox/claude-settings.json'))
  assert.equal(settings.disableAllHooks, true)
  assert.equal(settings.permissions.defaultMode, 'dontAsk')
  const doc = await guide()
  const denied = settings.permissions.deny.join(' ')
  for (const folder of ['.ssh', '.config', 'Library', '.claude', '.local/state', 'runner-code']) {
    assert.ok(denied.includes(folder), `the settings do not deny ${folder}`)
  }
  assert.ok(doc.includes('disableAllHooks'))
  assert.deepEqual(JSON.parse(await read('.agent-team/mailbox/empty-mcp.json')), { mcpServers: {} })
})

test('the guide links the Claude Code documents that the flags come from', async () => {
  const doc = await guide()
  for (const page of ['cli-reference', 'headless', 'permissions']) {
    assert.ok(doc.includes(`https://code.claude.com/docs/en/${page}`), `the guide does not link ${page}`)
  }
})

// --- what it admits --------------------------------------------------------------------------------------------

test('the guide marks Windows as not tested and lists what a real Mac still has to prove', async () => {
  const doc = flat(await guide())
  const windows = section(doc, '## On a Windows computer', '## Not yet verified')
  assert.match(windows, /Not tested/)
  assert.match(windows, /Task Scheduler/)
  const open = doc.slice(doc.indexOf('## Not yet verified on a real Mac'))
  for (const word of ['--permission-prompts none', '2.1.259', 'disableAllHooks', '--strict-mcp-config', 'connectors', 'Deployment Protection']) {
    assert.ok(open.includes(word), `the not-yet-verified list leaves out ${word}`)
  }
})

test('the guide says what the runner never does', async () => {
  const doc = flat(await guide())
  const never = section(doc, '## What it does and what it never does', '## Where things live')
  for (const thing of ['Open a port', 'Run an order twice', 'Let a card\'s words talk it into anything', 'Let Claude push', 'Make a schedule, a skill or an agent on its own']) {
    assert.ok(never.includes(thing), `the guide does not say it never: ${thing}`)
  }
})

// --- the README and the links ----------------------------------------------------------------------------------

const anchorsIn = (markdown) =>
  new Set([...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) =>
    match[1].trim().toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').replace(/ /g, '-')))

async function brokenLinks(path) {
  const text = await read(path)
  const broken = []
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z]+:/i.test(target)) continue
    const [file, anchor] = target.split('#')
    const relative = file ? posix.normalize(posix.join(posix.dirname(path), file)) : path
    let body
    try {
      body = await read(relative)
    } catch {
      broken.push(target)
      continue
    }
    if (anchor && relative.endsWith('.md') && !anchorsIn(body).has(anchor)) broken.push(target)
  }
  return broken
}

test('the README has a mailbox section before "never do", linking the guide, and no link in either goes nowhere', async () => {
  const readme = await read('README.md')
  const at = readme.indexOf('## Orders on your own computer (the Mac mailbox)')
  assert.ok(at > 0, 'the README has no mailbox section')
  assert.ok(at < readme.indexOf('## What this repo will never do'))
  assert.ok(readme.slice(at).includes('](.agent-team/mailbox/README.md)'))
  assert.deepEqual(await brokenLinks('README.md'), [])
  assert.deepEqual(await brokenLinks(GUIDE), [])
})

// The same rule as the other guides: students may not code, and the owner reads best in short sentences. Code, tables
// and headings are left out.
test('the guide is written in short sentences', async () => {
  const doc = (await guide()).replace(/```[\s\S]*?```/g, '')
  const sentences = doc
    .split(/\n\s*\n|\n\s*(?=(?:-|\d+\.)\s)/)
    .filter((block) => !/^\s*(\||#)/.test(block))
    .flatMap((block) => block.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => /[a-z]/i.test(sentence))
  const words = sentences.map((sentence) => sentence.split(' ').length)
  const longest = Math.max(...words)
  const average = words.reduce((sum, count) => sum + count, 0) / words.length
  assert.ok(longest <= 30, `a sentence has ${longest} words: "${sentences[words.indexOf(longest)]}"`)
  assert.ok(average <= 14, `sentences average ${average.toFixed(1)} words`)
})

test('the guide uses none of the words the owner said mean nothing to him', async () => {
  const doc = await guide()
  for (const word of ['HMAC', 'nonce', 'idempotent', 'OUTCOME_UNKNOWN', 'durably', 'lease', 'process group']) {
    assert.doesNotMatch(doc, new RegExp(`\\b${word}\\b`, 'i'), `the guide uses "${word}"`)
  }
})

test('the guide says how long a lock left by a cut-off check lasts, and that is the code\'s own number', async () => {
  const { LOCK_STALE_MS } = await import('../scripts/lib/status/commit.mjs')
  assert.equal(LOCK_STALE_MS, 3600_000)
  assert.match(flat(await guide()), /lock it left clears itself after an hour/)
})
