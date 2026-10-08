import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { posix, join } from 'node:path'
import { read, exists, repoRoot } from './helpers/repo.mjs'
import { TOOL_NAMES, SERVER_STATES, TOOL_STATES, CODEX_STATES, LIVE_STATES } from '../scripts/lib/status/connections-schema.mjs'
import { LIVE_LIST_TIMEOUT_MS } from '../scripts/lib/status/claude-live.mjs'
import { PROGRAM_OUTPUT_CAP } from '../scripts/lib/status/programs.mjs'
import { makeFakeHome } from './helpers/fake-home.mjs'
import { runIn } from './helpers/hostile-home.mjs'

/* The Connections wall's paperwork: the status README (what runs, what it writes, what it never
   writes, the Mac schedule), a beginner guide in plain words, and an explainer of what is read
   and never kept. These hold each one to the code: the words the board shows are the contract's,
   the numbers are the code's, the files and tests named exist, and every link resolves. */

const statusReadme = () => read('.agent-team/status/README.md')
const guide = () => read('docs/guides/connections-wall.md')
const explainer = () => read('docs/guides/connections-wall-how-it-works.md')
const flat = (text) => text.replace(/\s+/g, ' ')

test('the status README names the connections file, its format, the parts and the new subject', async () => {
  const doc = await statusReadme()
  for (const phrase of [
    '.agent-team/status/connections/<computer>.json',
    'agent-status/connections/v1',
    '--only usage,connections',
    'claude mcp list',
    'Status snapshot from',
    'agent-status/receipt/v2',
    'tests/fixtures/connections-parity.json'
  ]) {
    assert.ok(doc.includes(phrase), `the status README does not mention ${phrase}`)
  }
  for (const tool of TOOL_NAMES) assert.ok(doc.includes(tool), `the status README does not list ${tool}`)
})

test('the status README says what the connections file never holds', async () => {
  const doc = flat(await statusReadme())
  const section = doc.slice(doc.indexOf('What is never written'))
  for (const word of ['address', 'command', 'argument', 'environment', 'header', 'project server', 'install folder']) {
    assert.match(section, new RegExp(word, 'i'), `the never-written list leaves out ${word}`)
  }
})

test('the status README says how the live check runs, with the code\'s own numbers', async () => {
  const doc = flat(await statusReadme())
  assert.equal(LIVE_LIST_TIMEOUT_MS, 120_000)
  assert.match(doc, /starts every (local )?server/i)
  assert.match(doc, /2 minutes/)
  assert.match(doc, new RegExp(`${PROGRAM_OUTPUT_CAP / 1024} KB`))
  assert.match(doc, /empty-cwd/)
  assert.match(doc, /never runs? `?hermes`?/i)
  assert.match(doc, /exit code is ignored/i)
})

test('the Mac plist puts ~/.local/bin on PATH, where Claude Code installs itself', async () => {
  const doc = await statusReadme()
  const plist = /```xml\n([\s\S]*?)```/.exec(doc)?.[1] ?? ''
  const path = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? ''
  const entries = path.split(':')
  assert.ok(entries.includes('/Users/YOUR-MAC-USER/.local/bin'), `the plist PATH is ${path}`)
  for (const entry of entries) assert.ok(entry.startsWith('/'), `the plist PATH has a relative entry: ${entry}`)
})

test('--help names both parts and what each one holds', async () => {
  const fake = await makeFakeHome()
  try {
    const result = await runIn(fake, ['--help'])
    assert.equal(result.code, 0)
    assert.match(result.stdout, /--only usage,connections/)
    assert.match(result.stdout, /usage: .*plan limits/i)
    assert.match(result.stdout, /connections: .*names only/i)
    assert.match(result.stdout, /claude mcp list/)
  } finally {
    await fake.cleanup()
  }
})

// --- the two guides -----------------------------------------------------------------------------------

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

test('the README links both connections guides, and every link in them resolves', async () => {
  const readme = await read('README.md')
  assert.ok(readme.includes('](docs/guides/connections-wall.md)'), 'the README does not link the beginner guide')
  assert.ok(readme.includes('](docs/guides/connections-wall-how-it-works.md)'), 'the README does not link the explainer')
  for (const path of ['docs/guides/connections-wall.md', 'docs/guides/connections-wall-how-it-works.md', '.agent-team/status/README.md']) {
    assert.deepEqual(await brokenLinks(path), [], `${path} has a link that goes nowhere`)
  }
})

test('the beginner guide explains its words before it uses them', async () => {
  const doc = await guide()
  const glossary = doc.slice(doc.indexOf('## Words used in this guide'), doc.indexOf('## Before you start'))
  for (const word of ['Connection', 'Server', 'Plugin', 'claude.ai connector', 'Snapshot', 'Team repo']) {
    assert.ok(glossary.includes(`**${word}**`), `the glossary does not explain ${word}`)
  }
  assert.ok(doc.indexOf('## Words used in this guide') < doc.indexOf('## Fill the wall'), 'the words come after they are used')
})

test('the beginner guide explains every word the wall shows, in the board\'s own words', async () => {
  const doc = await guide()
  const labels = doc.slice(doc.indexOf('## What you will see'), doc.indexOf('## What it never saves'))
  for (const label of [...Object.values(SERVER_STATES), ...Object.values(TOOL_STATES), ...Object.values(CODEX_STATES), ...Object.values(LIVE_STATES)]) {
    assert.ok(labels.includes(`**${label}**`), `the guide does not explain "${label}"`)
  }
  assert.ok(labels.includes('**Proved**'), 'the guide does not say what Proved means')
  // Signed out on purpose is normal, not an alarm (decision D9).
  const signIn = labels.split('\n').find((line) => line.startsWith('| **Needs sign-in**')) ?? ''
  assert.match(signIn, /grey/i)
  assert.match(signIn, /not (a problem|an alarm|broken)/i)
})

test('the beginner guide gives both ways to fill the wall, with the real commands', async () => {
  const doc = await guide()
  const fill = doc.slice(doc.indexOf('## Fill the wall'), doc.indexOf('## What you will see'))
  assert.match(fill, /^1\. /m)
  assert.match(fill, /\/snapshot/)
  assert.match(fill, /--only connections --dry-run/)
  assert.match(fill, /3 hours/)
  assert.match(fill, /README\.md#the-mac-schedule-phase-4-task-t14/)
})

test('the beginner guide says what is never saved, and how to switch the wall off', async () => {
  const doc = flat(await guide())
  const never = doc.slice(doc.indexOf('## What it never saves'), doc.indexOf('## How to switch it off'))
  for (const thing of ['address', 'password', 'key', 'project', 'name of your computer']) assert.match(never, new RegExp(thing, 'i'), `the guide leaves out ${thing}`)
  const off = doc.slice(doc.indexOf('## How to switch it off'))
  assert.ok(off.includes('--only usage'))
  assert.ok(off.includes('.agent-team/status/connections/'))
})

// The same rule as the usage guide: students may not code, and the owner reads best in short
// sentences. Code, tables and headings are left out.
test('the beginner guide is written in short sentences', async () => {
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
  assert.ok(longest <= 25, `a sentence has ${longest} words: "${sentences[words.indexOf(longest)]}"`)
  assert.ok(average <= 12, `sentences average ${average.toFixed(1)} words`)
})

test('the explainer names every file it reads, and what it keeps from each', async () => {
  const doc = await explainer()
  const table = doc.slice(doc.indexOf('## Every file it reads'), doc.indexOf('## The live check'))
  for (const file of ['~/.claude.json', 'mcp-needs-auth-cache.json', 'settings.json', 'installed_plugins.json', '.mcp.json', 'plugin.json', 'config.toml', 'pyproject.toml', '__init__.py', 'Info.plist']) {
    assert.ok(table.includes(file), `the explainer does not name ${file}`)
  }
  assert.match(flat(table), /count(ed)?, never named/i)
})

test('the explainer gives the live check\'s rules with the code\'s numbers', async () => {
  const doc = flat(await explainer())
  const live = doc.slice(doc.indexOf('## The live check'), doc.indexOf('## Programs, and how they are found'))
  assert.match(live, /first `": "`/)
  assert.match(live, /last `" - "`/)
  assert.match(live, /2 minutes/)
  assert.match(live, new RegExp(`${PROGRAM_OUTPUT_CAP / 1024} KB`))
  assert.match(live, /process group/)
  assert.match(live, /exit code/i)
  assert.match(live, /empty-cwd/)
  assert.match(live, /plugin:/)
})

test('the explainer says how programs are found and why Hermes is never run', async () => {
  const doc = flat(await explainer())
  const programs = doc.slice(doc.indexOf('## Programs, and how they are found'), doc.indexOf('## What is never kept'))
  for (const thing of ['absolute', '~/.local/bin', '~/.claude/local', 'Homebrew', '--clone', '.exe', '.cmd']) assert.ok(programs.includes(thing), `the explainer does not say ${thing}`)
  assert.match(programs, /`hermes --version` is not read-only/)
  assert.match(programs, /never run/i)
})

test('the explainer names the checks that enforce it, and they exist', async () => {
  const doc = await explainer()
  const section = doc.slice(doc.indexOf('## What is never kept'), doc.indexOf('## Not verified yet'))
  assert.match(section, /fails\s+closed/)
  assert.ok(section.includes('tests/fixtures/connections-parity.json'))
  const named = [...section.matchAll(/`(tests\/[a-z-]+\.test\.mjs)`/g)].map((match) => match[1])
  for (const file of ['tests/status-connections-files.test.mjs', 'tests/status-claude-live.test.mjs', 'tests/status-tools.test.mjs', 'tests/status-programs.test.mjs', 'tests/status-connections-contract.test.mjs', 'tests/status-parts.test.mjs']) {
    assert.ok(named.includes(file), `the explainer does not name ${file}`)
  }
  for (const file of named) assert.ok(await exists(file), `the explainer names ${file}, which does not exist`)
})

test('the explainer says Found never becomes Proved', async () => {
  const doc = flat(await explainer())
  assert.match(doc, /found never (becomes|turns into) proved/i)
  assert.match(doc, /register/i)
})

test('the guides quote the fixture\'s words, not invented ones', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, 'tests', 'fixtures', 'connections-parity.json'), 'utf8'))
  assert.deepEqual(Object.values(fixture.serverStates), Object.values(SERVER_STATES))
})
