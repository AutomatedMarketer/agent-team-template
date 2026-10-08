import test from 'node:test'
import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { read, exists } from './helpers/repo.mjs'
import { parseSimpleYaml } from '../scripts/lib/yaml-lite.mjs'

/* The collector's paperwork: the subscriptions list the board totals, the promise that the
   collector added no dependencies, and the page that tells a person (and the Mac schedule)
   exactly what runs, what it writes and what it never writes. */

test('stack.yml ships an empty subscriptions list for /onboard to fill', async () => {
  const stack = parseSimpleYaml(await read('stack.yml'))
  assert.deepEqual(stack.subscriptions, [])
  assert.ok(Array.isArray(stack.stack) && stack.stack.length === 5, 'the starter stack still parses beside it')
})

test('stack.yml says what a subscription entry looks like and who writes it', async () => {
  const text = await read('stack.yml')
  assert.match(text, /^subscriptions: \[\]$/m)
  for (const field of ['name', 'service', 'price', 'currency', 'per']) {
    assert.match(text, new RegExp(`^#\\s+-?\\s*${field}:`, 'm'), `the example does not show ${field}`)
  }
  assert.match(text, /\/onboard/)
})

test('the collector added no dependencies', async () => {
  const pkg = JSON.parse(await read('package.json'))
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.ok(!pkg[field] || Object.keys(pkg[field]).length === 0, `package.json has ${field}`)
  }
})

const statusReadme = () => read('.agent-team/status/README.md')

test('the status README names the file, the format and the command', async () => {
  const doc = await statusReadme()
  for (const phrase of [
    '.agent-team/status/usage/<computer>.json',
    'agent-status/usage/v1',
    'npm run collect:status', // spawn-scan: not a run
    '--dry-run',
    '--commit',
    '--clone',
    'unofficial-live',
    'claude-code-statusline',
    'claude-code-saved',
    'codex-session-log'
  ]) {
    assert.ok(doc.includes(phrase), `the status README does not mention ${phrase}`)
  }
})

test('the status README says what is never written', async () => {
  const doc = await statusReadme()
  assert.match(doc, /never written/i)
  for (const word of ['token', 'email', 'username', 'home folder', 'project', 'computer name']) {
    assert.match(doc, new RegExp(word, 'i'), `the never-written list leaves out ${word}`)
  }
})

test('the status README carries a LaunchAgent template ready for the Mac, every three hours', async () => {
  const doc = await statusReadme()
  const plist = /```xml\n([\s\S]*?)```/.exec(doc)?.[1]
  assert.ok(plist, 'no plist template in the README')
  assert.match(plist, /<key>Label<\/key>\s*<string>local\.donna\.agent-status-collector<\/string>/)
  assert.match(plist, /<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/, 'a GUI session is what can read the login Keychain')
  assert.match(plist, /<string>--commit<\/string>/)
  assert.match(plist, /<string>--clone<\/string>/)
  assert.match(plist, /<string>Mac Mini<\/string>/)
  const hours = [...plist.matchAll(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/g)].map((match) => Number(match[1]))
  assert.deepEqual(hours, [0, 3, 6, 9, 12, 15, 18, 21])
  assert.match(doc, /launchctl bootstrap gui\//)
  assert.match(doc, /launchctl bootout gui\/.*local\.donna\.agent-status-collector/)
})

test('the status README says the unofficial reading is labelled, and what to do when it stops', async () => {
  const doc = await statusReadme()
  assert.match(doc, /undocumented/i)
  assert.match(doc, /unavailable/)
  assert.match(doc, /never refresh/i)
})

// The data clone is reset to the remote every run, so the code the Mac runs must not live in it -
// otherwise whoever can push to the team repo chooses that code. The README's plist is what
// people copy, so it is held to the split here.
test('the status README runs the collector from a pinned code checkout, apart from the data clone', async () => {
  const doc = await statusReadme()
  const plist = /```xml\n([\s\S]*?)```/.exec(doc)?.[1] ?? ''
  const args = [...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1])
  const script = args.find((arg) => arg.endsWith('/scripts/collect-status.mjs')) // spawn-scan: not a run
  const clone = args[args.indexOf('--clone') + 1]
  assert.ok(script, 'the plist does not run scripts/collect-status.mjs') // spawn-scan: not a run
  assert.ok(clone && args.includes('--clone'), 'the plist does not name a data clone')
  assert.match(script, /\/\.local\/share\/agent-status\/collector-code\/scripts\/collect-status\.mjs$/) // spawn-scan: not a run
  assert.match(clone, /\/\.local\/share\/agent-status\/data$/)
  assert.ok(!script.startsWith(`${clone}/`), 'the script the plist runs lives inside the data clone')
  const workingDirectory = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? ''
  assert.ok(!workingDirectory.startsWith(clone), 'the plist works from inside the data clone')
  // Pinned to a reviewed commit, and how to move the pin on purpose.
  assert.match(doc, /-c advice\.detachedHead=false checkout "\$id"/)
  // The update steps: fetch, take the id of what was fetched, read the WHOLE diff - not only
  // scripts/, since package.json or any file the scripts import changes what runs - then move.
  const update = doc.slice(doc.indexOf('### Updating the collector'), doc.indexOf('### Rollback'))
  const code = '~/.local/share/agent-status/collector-code'
  assert.ok(update.includes(`git -C ${code} fetch --quiet origin`), 'no fetch step')
  assert.ok(update.includes(`id=$(git -C ${code} rev-parse origin/main)`), 'no step that takes the id')
  assert.ok(update.includes(`git -C ${code} diff HEAD "$id"`), 'no whole-tree diff of the new id')
  assert.ok(update.includes(`git -C ${code} -c advice.detachedHead=false checkout "$id"`), 'no checkout of that same id')
  assert.doesNotMatch(update, /diff HEAD[^\n]*-- scripts\//, 'the diff is limited to scripts/')
  assert.match(update, /package\.json/)
  assert.match(doc, /never updates? itself/i)
})

test('the status README says when --commit in your own copy does not push', async () => {
  const doc = await statusReadme()
  assert.match(doc, /another branch/i)
  assert.match(doc, /commits that origin's .main. does not have yet/i)
  assert.match(doc, /even if your branch follows\s+somewhere else/i)
  assert.match(doc, /no remote called .origin./i)
  assert.match(doc, /git push --force-with-lease=refs\/heads\/main:<last fetched id> origin <snapshot commit id>:refs\/heads\/main/)
  assert.match(doc, /fetch or pull, then take the snapshot again/)
  assert.match(doc, /pushInsteadOf/)
  assert.match(doc, /behind origin's .main./)
  assert.doesNotMatch(doc, /git push origin HEAD:/)
})

test('the status README lists every setting that keeps the token at home', async () => {
  const doc = await statusReadme()
  for (const setting of ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS', '--use-system-ca', '--use-openssl-ca', '--require', '-r', '--import', '--loader', '--experimental-loader', 'NODE_USE_SYSTEM_CA', '--inspect', '--inspect-brk', '--inspect-port', '--inspect-wait']) {
    assert.ok(doc.includes(`\`${setting}`), `the README does not name ${setting}`)
  }
})

test('the status README says a window with no number is left out, and resetsAt may be missing', async () => {
  const doc = await statusReadme()
  assert.match(doc, /window with no number, that window is left out/i)
  assert.match(doc, /no `resetsAt`/)
})

test('the status README says percentages over 100 are written as they are', async () => {
  const doc = await statusReadme()
  assert.match(doc, /from 0 to 1000/)
  assert.match(doc, /never clipped/i)
})

test('the status README states exactly the label rule the collector enforces', async () => {
  const doc = await statusReadme()
  const row = doc.split('\n').find((line) => line.startsWith('| `--computer'))
  assert.ok(row, 'no --computer row')
  assert.ok(row.includes("`. , ' ’ ( ) + & : _ -`"), 'the row does not list the allowed punctuation')
  assert.match(row, /letters, numbers, spaces/)
  assert.match(row, /up to 60 characters/i)
  assert.match(row, /24 or more without a space/)
  // Every punctuation mark the row lists is one the rule allows, and vice versa.
  const { LABEL_CHARACTERS } = await import('../scripts/lib/status/safe.mjs')
  const listed = /`([^`]*)`/.exec(row.slice(row.indexOf('spaces and')))[1].split(' ').filter(Boolean)
  for (const mark of listed) assert.ok(LABEL_CHARACTERS.test(`a${mark}b`), `the README allows ${mark} but the collector does not`)
  const allowedPunctuation = LABEL_CHARACTERS.source.replace(/^\^\[\\p\{L\}\\p\{N\} /, '').replace(/\]\+\$$/, '')
  assert.deepEqual([...allowedPunctuation].sort(), [...listed.join('')].sort())
})

// --- the status line tap, the installer and the student guides ----------------------------------------
//
// The owner asked for the student repo to hold "all these instructions and also the tech behind".
// These tests hold the two guides to the code: the commands they give exist, the paths they name
// are the paths the code uses, every relative link resolves, and the beginner guide stays readable.

const guide = () => read('docs/guides/usage-meters.md')
const explainer = () => read('docs/guides/usage-meters-how-it-works.md')

// GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens.
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

test('the README links both usage guides, and every link in them resolves', async () => {
  const readme = await read('README.md')
  assert.ok(readme.includes('](docs/guides/usage-meters.md)'), 'the README does not link the beginner guide')
  assert.ok(readme.includes('](docs/guides/usage-meters-how-it-works.md)'), 'the README does not link the explainer')
  for (const path of ['docs/guides/usage-meters.md', 'docs/guides/usage-meters-how-it-works.md', 'README.md']) {
    assert.deepEqual(await brokenLinks(path), [], `${path} has a link that goes nowhere`)
  }
})

test('the beginner guide gives both paths as numbered steps, with the real commands', async () => {
  const doc = await guide()
  const pathA = doc.slice(doc.indexOf('## Path A'), doc.indexOf('## Path B'))
  const pathB = doc.slice(doc.indexOf('## Path B'), doc.indexOf('## What you will see'))
  assert.match(pathA, /^1\. /m)
  assert.match(pathA, /\/onboard/)
  assert.match(pathA, /set up my usage meters/)
  assert.match(pathA, /node scripts\/install-usage-tap\.mjs/)
  assert.match(pathA, /3 hours/)
  assert.match(pathB, /^1\. /m)
  assert.match(pathB, /node scripts\/install-usage-tap\.mjs --dry-run/)
  assert.match(pathB, /\/snapshot/)
  for (const script of ['scripts/install-usage-tap.mjs', 'scripts/usage-tap.mjs']) {
    assert.ok(await exists(script), `${script} is missing`)
  }
})

test('the beginner guide explains its words before it uses them, and every label on the board', async () => {
  const doc = await guide()
  const glossary = doc.slice(doc.indexOf('## Words used in this guide'), doc.indexOf('## Before you start'))
  for (const word of ['Status line', 'The tap', 'Snapshot', 'Team repo', 'Always-on computer']) {
    assert.ok(glossary.includes(`**${word}**`), `the glossary does not explain ${word}`)
  }
  assert.ok(doc.indexOf('## Words used in this guide') < doc.indexOf('## Path A'), 'the words are explained after they are used')
  const labels = doc.slice(doc.indexOf('## What you will see'), doc.indexOf('## The Mac "Always Allow" box'))
  for (const label of ['from Claude Code’s status line', 'saved copy', 'unofficial', 'estimate', 'not found', 'unavailable', 'reset since this reading', 'older than 8 hours']) {
    assert.ok(labels.includes(`**${label}**`), `the guide does not explain "${label}"`)
  }
  assert.match(labels, /tap's numbers come straight from Claude Code/)
  // The tap's reading has its own name now, and the board shows it as official.
  const rows = labels.split('\n')
  const officialRow = rows.find((line) => line.startsWith('| **from Claude Code’s status line**')) ?? ''
  assert.match(officialRow, /official/i)
  assert.match(officialRow, /tap/)
  const savedRow = rows.find((line) => line.startsWith('| **saved copy**')) ?? ''
  assert.doesNotMatch(savedRow, /tap/, 'the guide still says the tap reading is a saved copy')
  assert.match(doc, /Claude Pro or Max/)
})

test('the beginner guide says the Keychain box is only for the backup method, and what each answer does', async () => {
  const doc = await guide()
  const mac = doc.slice(doc.indexOf('## The Mac "Always Allow" box'), doc.indexOf('## How to undo everything'))
  assert.match(mac, /only for the \*\*backup method\*\*/)
  assert.match(mac, /\*\*Always Allow\*\*/)
  assert.match(mac, /\*\*Deny\*\*/)
  assert.match(mac, /tap's reading still works/)
  assert.match(mac, /not yet\s+seen this box/, 'the exact wording of the prompt is unverified, and the guide must say so')
})

test('the beginner guide says how to undo every piece', async () => {
  const doc = await guide()
  const undo = doc.slice(doc.indexOf('## How to undo everything'), doc.indexOf('## If something looks wrong'))
  assert.ok(undo.includes('node scripts/install-usage-tap.mjs --remove'))
  assert.ok(undo.includes('rm -rf ~/.local/state/agent-status'))
  assert.ok(undo.includes('Remove-Item -Recurse -Force "$env:LOCALAPPDATA\\agent-status"'))
  assert.ok(undo.includes('settings.json.before-usage-tap-'))
  assert.ok(undo.includes('.agent-team/status/usage/'))
  assert.match(undo, /README\.md#rollback/)
})

// Students may not code, and the owner reads best in short sentences. Code, tables and headings are
// left out, and the quoted text of the macOS box counts as two words; every other sentence counts.
test('the beginner guide is written in short sentences', async () => {
  const doc = (await guide()).replace(/```[\s\S]*?```/g, '').replace(/\*\*"[^"]*"\*\*/g, 'the box')
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

test('the explainer names every source in the order the collector tries them', async () => {
  const doc = await explainer()
  const table = doc.slice(doc.indexOf('### Claude limits'), doc.indexOf('### Why the tap has its own name'))
  // The decided order: tap under 30 minutes, live, tap up to 6 hours, ~/.claude.json, unavailable.
  const rows = table.split('\n').filter((line) => /^\| \d \|/.test(line))
  assert.equal(rows.length, 5, 'the order table should have five rows')
  assert.match(rows[0], /\*\*The status line tap\.\*\*.*under 30 minutes old/)
  assert.match(rows[1], /\*\*The live call\.\*\*/)
  assert.match(rows[2], /\*\*The status line tap, again\*\*.*up to 6 hours old/)
  assert.match(rows[3], /\*\*Claude Code's saved reading\*\*/)
  assert.match(rows[4], /\*\*unavailable\*\*/)
  for (const source of ['claude-code-statusline', 'claude-code-saved', 'unofficial-live', 'codex-session-log', 'estimate']) {
    assert.ok(doc.includes(`\`${source}\``), `the explainer never names ${source}`)
  }
  assert.match(doc, /step 2 never runs, so \*\*your sign-in never leaves the computer\*\*/)
  assert.match(doc, /interactive sessions/)
})

// The tap carries only what Claude Code gives the status line: the 5-hour and weekly windows. The
// live call can also show a per-model weekly meter. All three docs must say so, and when each wins.
test('all three docs say the tap has only the 5-hour and weekly meters, and when each source wins', async () => {
  for (const [name, text] of [['the guide', await guide()], ['the explainer', await explainer()], ['the status README', await statusReadme()]]) {
    const doc = text.replace(/\s+/g, ' ')
    assert.match(doc, /only the 5-hour and weekly/i, `${name} does not say what the tap carries`)
    assert.match(doc, /per-model weekly/i, `${name} does not say the per-model weekly meter needs another source`)
    assert.match(doc, /30 minutes/, `${name} does not say when the tap wins outright`)
    assert.match(doc, /6 hours/, `${name} does not say how long the tap is used at all`)
  }
  const status = await statusReadme()
  const sources = status.slice(status.indexOf('## Where each number comes from'), status.indexOf('### The status line tap'))
  const choices = ['first choice', 'second choice', 'third choice', 'fourth choice'].map((label) => sources.split('\n').find((line) => line.includes(label)) ?? '')
  assert.match(choices[0], /under 30 minutes old.*`claude-code-statusline` \|$/)
  assert.match(choices[1], /`unofficial-live` \|$/)
  assert.match(choices[2], /up to 6 hours old.*`claude-code-statusline` \|$/)
  assert.match(choices[3], /`~\/\.claude\.json`.*`claude-code-saved` \|$/)
})

test('the guides give the tap file paths the code actually uses', async () => {
  const { tapFilePath } = await import('../scripts/lib/status/tap.mjs')
  const mac = tapFilePath({ home: '~', env: {}, platform: 'darwin' }).replaceAll('\\', '/')
  const windows = tapFilePath({ home: 'H', env: { LOCALAPPDATA: '%LOCALAPPDATA%' }, platform: 'win32' }).replaceAll('/', '\\')
  for (const [name, doc] of [['the explainer', await explainer()], ['the status README', await statusReadme()]]) {
    assert.ok(doc.includes(mac), `${name} does not give ${mac}`)
    assert.ok(doc.includes(windows), `${name} does not give ${windows}`)
  }
  const undo = await guide()
  assert.ok(undo.includes(posix.dirname(mac)), 'the undo step deletes another folder than the tap uses')
})

test('the explainer says the tap has its own source name, and the board shows it as official', async () => {
  const doc = await explainer()
  const start = doc.indexOf('### Why the tap has its own name')
  assert.ok(start > 0, 'no section on the tap\'s source name')
  const why = doc.slice(start, doc.indexOf('### The other numbers'))
  assert.match(why, /tests\/fixtures\/usage-parity\.json/)
  assert.match(why, /`claude-code-statusline`/)
  assert.match(why, /from Claude Code’s status line/)
  assert.match(why, /official/)
  const table = doc.slice(doc.indexOf('### Claude limits'), start)
  const tapRow = table.split('\n').find((line) => line.startsWith('| 1 |')) ?? ''
  assert.match(tapRow, /`claude-code-statusline` \|$/)
})

// Every source name the contract allows is one the explainer and the status README explain, and the
// tap's reading is never again described as an unofficial saved copy.
test('the guides name every contract source, and none calls the tap reading unofficial', async () => {
  const { SOURCES } = await import('../scripts/lib/status/schema.mjs')
  const docs = [['the explainer', await explainer()], ['the status README', await statusReadme()], ['the guide', await guide()]]
  for (const [name, doc] of docs.slice(0, 2)) {
    for (const source of SOURCES) assert.ok(doc.includes(`\`${source}\``), `${name} never names ${source}`)
  }
  for (const [name, doc] of docs) {
    assert.doesNotMatch(doc, /tap[^.|]*unofficial · saved copy|unofficial · saved copy[^.|]*tap/i, `${name} still labels the tap reading unofficial`)
    assert.doesNotMatch(doc, /tap's reading is\s+written as `claude-code-saved`/, `${name} still files the tap as claude-code-saved`)
  }
})

test('the explainer covers chaining, and the trade-off of running the earlier command through a shell', async () => {
  const doc = await explainer()
  assert.match(doc, /`--then <command>`/)
  assert.match(doc, /`--then64 <code>`/)
  assert.match(doc, /\*\*The trade-off of running the earlier command through a shell\.\*\*/)
  for (const cost of ['**Time.**', '**One guess, written down.**', '**No new trust.**']) assert.ok(doc.includes(cost), `the trade-off leaves out ${cost}`)
  // The tap never trusts SHELL on Windows any more: the installer records the shell.
  const flat = doc.replace(/\s+/g, ' ')
  assert.match(flat, /`--then-shell sh` or `--then-shell powershell`/)
  assert.doesNotMatch(flat, /names in `SHELL`/, 'the explainer still says the tap trusts SHELL')
  assert.match(flat, /not run at all/)
})

test('the explainer says what is never written and names the checks that enforce it, which exist', async () => {
  const doc = await explainer()
  const section = doc.slice(doc.indexOf('## What is never written'), doc.indexOf('### Reasons, and the log'))
  assert.match(section, /fails\s+closed/)
  assert.ok(section.includes('scripts/lib/status/safe.mjs'))
  const named = [...section.matchAll(/`(tests\/[a-z-]+\.test\.mjs)`/g)].map((match) => match[1])
  for (const file of ['tests/status-run.test.mjs', 'tests/status-usage-tap.test.mjs', 'tests/status-tap-source.test.mjs', 'tests/status-spawn-scan.test.mjs', 'tests/secrets.test.mjs']) {
    assert.ok(named.includes(file), `the explainer does not name ${file}`)
  }
  for (const file of named) assert.ok(await exists(file), `the explainer names ${file}, which does not exist`)
  for (const thing of ['token', 'email', 'username', 'session ids', 'transcript paths', "computer's own name"]) {
    assert.ok(section.includes(thing), `the never-written list leaves out ${thing}`)
  }
})

test('the explainer covers the two Mac folders, the leased push, and the local app, ideas only', async () => {
  const doc = await explainer()
  assert.match(doc, /\*\*Two folders\.\*\*/)
  assert.match(doc, /\*\*pinned by hand\*\*/)
  assert.ok(doc.includes('--force-with-lease=refs/heads/main:<last fetched id>'))
  assert.match(doc, /Jack Roberts/)
  assert.match(doc, /ideas only - none of its code or art is\s+in here/)
  assert.match(doc, /\*\*runs on your own computer\*\*/)
  assert.match(doc, /\*\*pushes numbers out\*\*/)
  assert.match(doc, /install it from the \*\*pinned code checkout\*\*/)
})

test('the status README documents the tap, the installer and the new reasons', async () => {
  const doc = await statusReadme()
  for (const phrase of [
    'scripts/usage-tap.mjs',
    'node scripts/install-usage-tap.mjs --dry-run',
    'node scripts/install-usage-tap.mjs --remove',
    'rate_limits.five_hour',
    'https://code.claude.com/docs/en/statusline',
    'docs/guides/usage-meters.md',
    'docs/guides/usage-meters-how-it-works.md',
    'holds no\nkey (Keychain)',
    'file, no Keychain answer',
    'file, Keychain unreadable'
  ]) {
    assert.ok(doc.includes(phrase), `the status README does not mention ${phrase.replace('\n', ' ')}`)
  }
  const sources = doc.slice(doc.indexOf('## Where each number comes from'), doc.indexOf('### The status line tap'))
  assert.ok(sources.indexOf('first choice | **Official.**') > 0, 'the tap is not listed as the first choice')
  const firstRow = sources.split('\n').find((line) => line.includes('first choice')) ?? ''
  assert.match(firstRow, /`claude-code-statusline` \|$/)
  assert.ok(sources.indexOf('second choice') > sources.indexOf('first choice'))
  assert.ok(sources.indexOf('third choice') > sources.indexOf('second choice'))
})

// The status line runs a COPY of the tap, never the team repo's working copy: a push to the team
// repo must not choose code that runs after every reply. All three docs have to say so, with the
// folders the code really uses, and say that re-running the installer is the update.
test('all three docs say the status line runs a pinned copy of the tap, where it lives, and why', async () => {
  const { tapCopyRoot } = await import('../scripts/lib/status/tap-copy.mjs')
  const mac = tapCopyRoot({ home: '~', env: {}, platform: 'darwin' }).replaceAll('\\', '/')
  const windows = tapCopyRoot({ home: 'H', env: { LOCALAPPDATA: '%LOCALAPPDATA%' }, platform: 'win32' }).replaceAll('/', '\\')
  for (const [name, text] of [['the explainer', await explainer()], ['the status README', await statusReadme()]]) {
    const doc = text.replace(/\s+/g, ' ')
    assert.ok(doc.includes(mac), `${name} does not give ${mac}`)
    assert.ok(doc.includes(windows), `${name} does not give ${windows}`)
    assert.match(doc, /anyone who can push to the team repo/i, `${name} does not say why`)
    assert.match(doc, /same reason/i, `${name} does not tie it to the Mac pin`)
    assert.match(doc, /run(ning)? the installer again/i, `${name} does not say how to update`)
    assert.match(doc, /--remove`?[^.]*deletes? the cop(y|ies)/i, `${name} does not say --remove deletes the copy`)
  }
  const doc = (await guide()).replace(/\s+/g, ' ')
  assert.match(doc, /copy of the tap/i)
  assert.match(doc, /does not change (it|the copy) by itself|never changes by itself/i)
  assert.match(doc, /run the installer again/i)
  assert.doesNotMatch(doc, /You moved your team repo/, 'the guide still says moving the repo matters')
})
