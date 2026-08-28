// Says whether this clone is behind what is on GitHub. FETCHES ONLY - it never merges, never
// changes a file, never touches your working tree.
//
// Run it: npm run check:drift  (it also runs by itself when a Claude Code session starts)
//
// This exists because of a real failure: the local clone sat one commit behind while the cloud had
// already committed work into the same repo. Nothing was broken and nothing said anything, so the
// next local edit was made against a stale copy.
//
// Fetch-only is the whole design. An auto-merge on session start would occasionally rewrite the
// file somebody was mid-thought about, and a tool that surprises you once stops being trusted.
// This says a number and gets out of the way; the `sync` skill does the actual pulling, when asked.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const repoRoot = fileURLToPath(new URL('../', import.meta.url))

// Failing silent is only a virtue if it fails PROMPTLY. Pointed at an unroutable address,
// `git fetch` was measured sitting for 21.3 seconds before giving up - 21 seconds of silence at
// the start of every session behind a captive portal or a dropped VPN. And a private repo with no
// cached credential can wait forever on a password prompt nobody is looking at. So: a hard
// deadline, and git is told up front that there is no human here to ask.
const FETCH_DEADLINE_MS = 8000

async function git(...args) {
  const { stdout } = await run('git', args, {
    cwd: repoRoot,
    timeout: FETCH_DEADLINE_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GCM_INTERACTIVE: 'never' }
  })
  return stdout.trim()
}

try {
  // No remote, no drift to report. A fresh `git init` is a normal state, not a problem.
  const remotes = await git('remote')
  if (!remotes) process.exit(0)

  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch === 'HEAD') process.exit(0) // detached: nothing to compare against

  // The only network call, and the only thing this script does at all.
  await git('fetch', '--quiet')

  let upstream
  try {
    upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
  } catch {
    process.exit(0) // no upstream set yet
  }

  const counts = await git('rev-list', '--left-right', '--count', `${upstream}...HEAD`)
  const [behind, ahead] = counts.split(/\s+/).map(Number)

  const parts = []
  if (behind > 0) parts.push(`${behind} commit${behind === 1 ? '' : 's'} behind`)
  if (ahead > 0) parts.push(`${ahead} commit${ahead === 1 ? '' : 's'} ahead`)

  if (parts.length) {
    console.log(`This clone is ${parts.join(' and ')} of ${upstream}.`)
    // Named rather than done. Whoever is here decides when to pull.
    console.log('Nothing has been changed. Ask for /sync when you want to catch up.')
  }
} catch {
  // A drift check that breaks a session start is worse than no drift check. Anything unexpected -
  // no git, no network, a repo in a strange state - and this says nothing and exits clean.
  process.exit(0)
}
