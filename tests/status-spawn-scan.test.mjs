import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { repoRoot } from './helpers/repo.mjs'

/* SPAWN SAFETY. A collector run started from `npm test` is a real process on the real machine,
   and on a Mac it would read the real Keychain whatever HOME says. Tests reach the collector in
   exactly two ways: the harness (tests/helpers/collector-cli.mjs, which shuts the Keychain and
   the network), or the real script with --help, which answers before anything is read.

   This scan reads every code file under tests/, helpers and subfolders included, and refuses:
     - any line naming the real script (collect-status) or the npm script (collect:status), unless
       it is a comment, the --help run, or is marked "spawn-scan: not a run" because it only reads
       or quotes the name;
     - any import of main() from cli.mjs outside the harness, and any call of main() in the
       harness without replacements.
   It is a guard against drift, not proof against someone hiding the name on purpose. */

const SELF = join('tests', 'status-spawn-scan.test.mjs')
const HARNESS = join('tests', 'helpers', 'collector-cli.mjs')
const MARK = 'spawn-scan: not a run'

export function spawnScanProblems(path, text) {
  const problems = []
  text.split('\n').forEach((line, index) => {
    const where = `${path}:${index + 1}`
    const trimmed = line.trim()
    const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
    if (/collect-status|collect:status/.test(line) && !isComment && !line.includes(MARK) && !/['"`]--help['"`]/.test(line)) {
      problems.push(`${where} names the real collector`)
    }
    // The real machine's dependencies, in process, are the real Keychain and the real network.
    // No exceptions and no marker: a test that needs dependencies builds fake ones.
    if (/\bmachineDeps\b|machine\.mjs/.test(line) && !isComment) {
      problems.push(`${where} uses the real machine's dependencies`)
    }
  })
  const importsMain = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*cli\.mjs['"]/g)].some((match) =>
    match[1].split(',').map((name) => name.trim().split(/\s+as\s+/)[0]).includes('main')
  )
  const dynamicCli = /import\(\s*['"`][^'"`]*cli\.mjs['"`]\s*\)/.test(text)
  if ((importsMain || dynamicCli) && path !== HARNESS) problems.push(`${path} imports main() from cli.mjs - only the harness may`)
  if (path === HARNESS) {
    const code = text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
    for (const call of code.matchAll(/\bmain\(([^)]*)\)/g)) {
      if (!/replace\s*:/.test(call[1])) problems.push(`${path} calls main() without replacing the Keychain and the network`)
    }
  }
  return problems
}

async function codeFilesUnder(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const next = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await codeFilesUnder(next)))
    else if (/\.(mjs|js|cjs)$/.test(entry.name)) found.push(next)
  }
  return found
}

test('SPAWN SAFETY: nothing under tests/ runs the real collector except the harness and --help', async () => {
  const problems = []
  for (const file of await codeFilesUnder(join(repoRoot, 'tests'))) {
    const path = relative(repoRoot, file)
    if (path === SELF) continue
    problems.push(...spawnScanProblems(path, await readFile(file, 'utf8')))
  }
  assert.deepEqual(problems, [], 'spawn tests/helpers/collector-cli.mjs instead, or mark a line that only quotes the name')
})

test('SPAWN SAFETY: the scan catches the ways a test could run the real collector', () => {
  const caught = (text, path = join('tests', 'helpers', 'sub', 'x.mjs')) => spawnScanProblems(path, text).length > 0
  assert.ok(caught("await run(process.execPath, [join('scripts', 'collect-status.mjs'), '--dry-run'])"))
  assert.ok(caught("await run(process.execPath, ['scripts/collect-status.mjs', '--dry-run'])"))
  assert.ok(caught("execSync('npm run collect:status -- --dry-run')"))
  assert.ok(caught("await import('../../scripts/collect-status.mjs')"))
  assert.ok(caught("import { main } from '../scripts/lib/status/cli.mjs'"))
  assert.ok(caught("import { seamsFrom, main as run } from '../scripts/lib/status/cli.mjs'"))
  assert.ok(caught("const cli = await import('../scripts/lib/status/cli.mjs')"))
  // The real machine's dependencies, used in process, reach the real Keychain just the same.
  assert.ok(caught("import { machineDeps } from '../scripts/lib/status/machine.mjs'"))
  assert.ok(caught("import { machineDeps as real } from '../../scripts/lib/status/machine.mjs'"))
  assert.ok(caught("const { machineDeps } = await import('../scripts/lib/status/machine.mjs')"))
  assert.ok(caught("import * as machine from '../scripts/lib/status/machine.mjs'"))
  assert.ok(caught("await runCollector({ argv, deps: machineDeps(), repoRoot })"))
  assert.ok(caught('process.exitCode = await main()', HARNESS))
  // And lets through what is not a run.
  assert.ok(!caught("await run(process.execPath, ['scripts/collect-status.mjs', '--help'])"))
  assert.ok(!caught('// the harness stands in for scripts/collect-status.mjs'))
  assert.ok(!caught(`assert.equal(pkg.scripts['collect:status'], 'x') // ${MARK}`))
  assert.ok(!caught("import { seamsFrom } from '../scripts/lib/status/cli.mjs'"))
  assert.ok(!caught('process.exitCode = await main({ replace: { exec, fetch, platform } })', HARNESS))
})
