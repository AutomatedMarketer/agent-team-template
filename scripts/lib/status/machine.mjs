// The real machine, gathered in one place. Every source takes these as arguments instead of
// reaching for them itself, which is what lets the tests hand over a fake home, a fake network
// and a fake Keychain - and prove nothing real was touched.

import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createRunner } from './programs.mjs'
import { openReadOnly } from './sqlite.mjs'

const execFileP = promisify(execFile)

// git never asks for a password here: an unattended run waiting on a prompt never finishes.
const runGit = (args, cwd) =>
  execFileP('git', args, { cwd, encoding: 'utf8', timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

export function machineDeps(overrides = {}) {
  const home = os.homedir()
  let username = null
  try {
    username = os.userInfo().username
  } catch {
    // Some containers have no passwd entry. The gate still checks the home folder and hostname.
  }
  return {
    home,
    env: process.env,
    // Node's own command-line options: the token guard refuses a debugger or loaded code here too.
    execArgv: process.execArgv,
    platform: process.platform,
    now: Date.now(),
    fetch: globalThis.fetch,
    // Every other program - the Keychain, claude, codex, the version checks - runs through this:
    // absolute path only, a time limit, an output cap, and a timeout stops everything it started.
    exec: createRunner({ spawn, platform: process.platform, env: process.env }),
    git: runGit,
    // A private copy of Hermes's state.db, opened read-only for one fixed question (hermes.mjs,
    // readSessions). Hermes's own file is never opened.
    openSqlite: openReadOnly,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    // Only ever used to REFUSE output that contains them. Never written anywhere.
    identity: { username, home, hostname: os.hostname() },
    ...overrides
  }
}
