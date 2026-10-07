import test from 'node:test'
import assert from 'node:assert/strict'
import { read } from './helpers/repo.mjs'
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
    'npm run collect:status',
    '--dry-run',
    '--commit',
    '--clone',
    'unofficial-live',
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
  const script = args.find((arg) => arg.endsWith('/scripts/collect-status.mjs'))
  const clone = args[args.indexOf('--clone') + 1]
  assert.ok(script, 'the plist does not run scripts/collect-status.mjs')
  assert.ok(clone && args.includes('--clone'), 'the plist does not name a data clone')
  assert.match(script, /\/\.local\/share\/agent-status\/collector-code\/scripts\/collect-status\.mjs$/)
  assert.match(clone, /\/\.local\/share\/agent-status\/data$/)
  assert.ok(!script.startsWith(`${clone}/`), 'the script the plist runs lives inside the data clone')
  const workingDirectory = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? ''
  assert.ok(!workingDirectory.startsWith(clone), 'the plist works from inside the data clone')
  // Pinned to a reviewed commit, and how to move the pin on purpose.
  assert.match(doc, /git -c advice\.detachedHead=false checkout /)
  assert.match(doc, /git diff [^\n]*-- scripts\//)
  assert.match(doc, /never updates? itself/i)
})

test('the status README says when --commit in your own copy does not push', async () => {
  const doc = await statusReadme()
  assert.match(doc, /another branch/i)
  assert.match(doc, /other commits that are not pushed yet/i)
  assert.match(doc, /git push origin HEAD:refs\/heads\/main/)
})

test('the status README lists every setting that keeps the token at home', async () => {
  const doc = await statusReadme()
  for (const setting of ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS', '--use-system-ca', '--use-openssl-ca', '--require', '-r', '--import', '--loader', '--experimental-loader']) {
    assert.ok(doc.includes(`\`${setting}`), `the README does not name ${setting}`)
  }
})
