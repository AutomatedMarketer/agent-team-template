// The two programs a Mac's scheduled jobs are read through, pretended: /usr/bin/plutil prints a plist
// as JSON, /bin/launchctl lists what is loaded. Each answer is whatever the test hands over, and every
// call is recorded, so a test can say which programs ran, with what, and from where. Nothing here
// starts a real program.

import { basename } from 'node:path'
import { FAKE_USERNAME } from './fake-home.mjs'

// plists: { 'name.plist': object (printed as JSON) | string (printed as it is) | Error (plutil fails) }
// launchctl: the table text launchctl prints. launchctlFails: launchctl itself fails.
export function fakePrograms({ plists = {}, launchctl = null, launchctlFails = false } = {}) {
  const calls = []
  const exec = async (file, args, options) => {
    calls.push({ file, args: [...args], options })
    if (file === '/bin/launchctl' && args.length === 1 && args[0] === 'list') {
      if (launchctlFails) throw new Error(`launchctl failed at /Users/${FAKE_USERNAME}`)
      return { stdout: launchctl ?? '', code: 0 }
    }
    if (file === '/usr/bin/plutil' && args[0] === '-convert' && args[1] === 'json' && args[2] === '-o' && args[3] === '-' && args.length === 5) {
      const entry = plists[basename(args[4])]
      if (entry === undefined) throw new Error('no such plist')
      if (entry instanceof Error) throw entry
      return { stdout: typeof entry === 'string' ? entry : JSON.stringify(entry), code: 0 }
    }
    throw new Error(`a program nobody expected: ${file}`)
  }
  exec.calls = calls
  return exec
}

export const launchctlTable = (rows) => ['PID\tStatus\tLabel', ...rows.map(([pid, status, label]) => `${pid}\t${status}\t${label}`)].join('\n')
