// The Mac mailbox runner: one tick of "ask the board, check the orders, do them, push the result".
// The guide is .agent-team/mailbox/README.md. This file only wires the real machine into scripts/lib/mailbox/command.mjs.
//
//   node scripts/mailbox-runner.mjs [--once | --preflight | --selftest | --help]

import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createRunner, findProgram } from './lib/status/programs.mjs'
import { main } from './lib/mailbox/command.mjs'

const execFileP = promisify(execFile)

// git never asks for a password here: an unattended run waiting on a prompt never finishes.
const git = (args, cwd) => execFileP('git', args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

const home = os.homedir()
let username = null
try {
  username = os.userInfo().username
} catch {
  // Some containers have no passwd entry.
}

process.exitCode = await main({
  argv: process.argv.slice(2),
  home,
  now: () => Date.now(),
  platform: process.platform,
  env: process.env,
  identity: { username, home, hostname: os.hostname() },
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  fetch: globalThis.fetch,
  git,
  exec: createRunner({ spawn, platform: process.platform, env: process.env }),
  // The runner names the work copy as `clone`, so a program that lives inside the team repo is never the one found.
  find: (name, extra = {}) => findProgram(name, { env: process.env, home, platform: process.platform, ...extra }),
  spawn,
  proc: process
})
