import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

/* The README is the first file a stranger reads and the last one anybody checks. It told them to
   run `npm test` and expect "332 passing, 0 failing". The suite had said 339 for two commits, and
   says something in a different shape entirely - `pass 339`, `fail 0`. So the one sentence whose
   whole job is to let a beginner decide whether the install worked named a number that was wrong
   and a format that has never existed.

   Correcting the number would have been the third time somebody corrected a number in this repo
   by hand. These tests make the claims checkable instead: the counts come from the repo, and the
   test total comes from actually running the suite. */

const root = new URL('../', import.meta.url)
const readme = await readFile(new URL('README.md', root), 'utf8')

const countDirs = async (path) => {
  const entries = await readdir(new URL(path, root), { withFileTypes: true })
  return entries.filter((entry) => entry.isDirectory()).length
}
const countFiles = async (path, extension) => {
  const entries = await readdir(new URL(path, root), { withFileTypes: true })
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(extension)).length
}

test('the README names the real number of agents, jobs and skills', async () => {
  const counts = {
    agents: await countFiles('.claude/agents/', '.md'),
    jobs: await countFiles('workflows/', '.yml'),
    skills: await countDirs('.claude/skills/')
  }
  const words = { 8: 'Eight', 9: 'Nine', 25: 'Twenty-five' }
  assert.ok(readme.includes(`**${words[counts.agents]} agents.**`),
    `the README does not say there are ${counts.agents} agents`)
  assert.ok(readme.includes(`**${words[counts.jobs]} jobs.**`),
    `the README does not say there are ${counts.jobs} jobs`)
  assert.ok(readme.includes(`**${words[counts.skills]} skills.**`),
    `the README does not say there are ${counts.skills} skills`)
})

test('the README quotes the number of tests the suite actually reports', () => {
  // The child runs the same suite with this flag set, which makes this test a no-op inside it -
  // otherwise asking the suite how many tests it has would spawn suites forever.
  if (process.env.AGENT_TEAM_README_SELF_CHECK === '1') return

  // NODE_TEST_CONTEXT is set for us by the runner, and passing it down makes the child report
  // in v8-serialized frames to a parent that is not listening - no readable summary at all.
  const env = { ...process.env, AGENT_TEAM_README_SELF_CHECK: '1' }
  delete env.NODE_TEST_CONTEXT
  const run = spawnSync(process.execPath, ['--test'], {
    cwd: fileURLToPath(root),
    encoding: 'utf8',
    env
  })
  const reported = /^\s*(?:ℹ|#)\s*pass\s+(\d+)\s*$/m.exec(run.stdout ?? '')
  assert.ok(reported, `could not read a pass count out of the suite's own output`)

  const claimed = /pass (\d+)/.exec(readme)
  assert.ok(claimed, 'the README no longer quotes a pass count for `npm test`')
  assert.equal(claimed[1], reported[1],
    `the README tells a beginner to expect ${claimed[1]} passing tests and the suite reports ${reported[1]}`)
})

/* Every command in the install block is typed by somebody who has never used a terminal, on
   whichever machine they own. `rm -rf` is not a PowerShell command: on Windows it errors, and
   then the next three commands all appear to succeed while the clone quietly keeps our history
   and our remote. */

test('the install block is possible to follow on Windows', () => {
  const install = readme.split('## Install')[1].split('\n## ')[0]
  if (install.includes('rm -rf')) {
    assert.ok(install.includes('Remove-Item'),
      'the install tells a Windows reader to run `rm -rf`, which PowerShell cannot do, and offers no alternative')
    assert.ok(/powershell/i.test(install),
      'the Windows alternative is there but nothing says which shell it belongs to')
  }
})

test('the install does not tell anybody to run a command before installing the plugin that provides it', () => {
  const install = readme.split('## Install')[1].split('\n## ')[0]
  // The command as TYPED - alone on its own line inside a fence - not every mention of its name.
  const plugin = install.indexOf('/plugin install')
  const onboard = /^\/onboard\s*$/m.exec(install)
  assert.notEqual(plugin, -1, 'the install never mentions installing the agent-team-os plugin')
  assert.ok(onboard, 'the install never actually tells anybody to run /onboard')
  assert.ok(plugin < onboard.index, '`/onboard` is offered before the plugin that provides it is installed')
})

test('the install ends on main, which is the branch everything downstream looks for', () => {
  const install = readme.split('## Install')[1].split('\n## ')[0]
  // EVERY `git init`, not just one of them. The first version of this test was satisfied by a
  // single `-b main` anywhere in the section, so the Mac block could quietly go back to `master`
  // while the Windows block kept the guard green.
  const bare = /^git init\s*$/m.exec(install)
  assert.ok(!bare,
    'a bare `git init` still produces `master` on many installs, and the dashboard reads `main`')
})

test('the reader is told which shell to type any of this into, and that they need git', () => {
  const before = readme.split('## Before you start')[1].split('\n## ')[0]
  // Not /Git/ - "A GitHub account" satisfied that, so the row could be deleted and nothing noticed.
  assert.match(before, /git --version/,
    'git is never listed as something you need, and step one is `git clone`')
  assert.match(before, /Terminal|PowerShell/, 'nothing tells the reader where these commands get typed')
})
