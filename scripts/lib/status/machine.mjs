// The real machine, gathered in one place. Every source takes these as arguments instead of
// reaching for them itself, which is what lets the tests hand over a fake home, a fake network
// and a fake Keychain - and prove nothing real was touched.

import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

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
    platform: process.platform,
    now: Date.now(),
    fetch: globalThis.fetch,
    exec: promisify(execFile),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    // Only ever used to REFUSE output that contains them. Never written anywhere.
    identity: { username, home, hostname: os.hostname() },
    ...overrides
  }
}
