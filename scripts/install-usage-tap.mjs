// Installs the status line tap (scripts/usage-tap.mjs) as your Claude Code status line, so the
// official 5-hour and weekly readings reach your dashboard. Your own status line, if you have
// one, keeps showing: the tap runs it after saving the reading.
//
//   node scripts/install-usage-tap.mjs            install, or update to the code in this repo now
//   node scripts/install-usage-tap.mjs --dry-run  show the change, write nothing
//   node scripts/install-usage-tap.mjs --remove   put back exactly the status line you had
//
// It changes only the `statusLine` key of ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR's), and
// makes a backup copy beside it first. The status line never runs the tap from this repo: the tap
// and the files it imports are copied to a per-user folder named after their hash, and the status
// line runs that copy, so a push to the team repo cannot change what runs after every reply.
// Running this again is how you take a newer tap on purpose. The guide: docs/guides/usage-meters.md

import os from 'node:os'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { installTap } from './lib/status/install-tap.mjs'

const HELP = [
  'Usage: node scripts/install-usage-tap.mjs [--dry-run] [--remove]',
  '  Installs the usage tap as your Claude Code status line, keeping the one you had.',
  '  --dry-run  show the change, write nothing',
  '  --remove   put back exactly the status line you had before'
]

const describe = (statusLine) => (statusLine && typeof statusLine.command === 'string' ? statusLine.command : '(none)')

async function main() {
  let values
  try {
    ({ values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, remove: { type: 'boolean' }, help: { type: 'boolean' } }, strict: true }))
  } catch {
    HELP.forEach((line) => console.error(line))
    return 2
  }
  if (values.help) {
    HELP.forEach((line) => console.log(line))
    return 0
  }

  const result = await installTap({
    home: os.homedir(),
    env: process.env,
    platform: process.platform,
    nodePath: process.execPath,
    sourceTap: fileURLToPath(new URL('./usage-tap.mjs', import.meta.url)),
    now: Date.now(),
    exists: existsSync,
    remove: Boolean(values.remove),
    dryRun: Boolean(values['dry-run'])
  })

  console.log(`Settings file: ${result.path}`)
  if (result.action === 'refuse') {
    console.error(`Nothing changed: ${result.why}.`)
    return 1
  }
  if (result.action === 'unchanged') {
    if (result.repairedCopy) console.log(`The tap's copy had been changed since it was made, so it was put back: ${result.copy}`)
    console.log(`Nothing changed: ${result.why}.`)
    return 0
  }
  if (values['dry-run']) {
    console.log('Dry run - nothing written. The status line would change:')
    console.log(`  from: ${describe(result.before)}`)
    console.log(`  to:   ${describe(result.next.statusLine)}`)
    if (result.copy) console.log(`The tap would be copied to ${result.copy} and run from there.`)
    return 0
  }
  if (result.backup) console.log(`Backup of your settings, made first: ${result.backup}`)
  if (result.action === 'remove') {
    console.log(result.earlier ? 'Removed the usage tap. Your earlier status line is back as it was.' : 'Removed the usage tap. You had no status line before, so there is none now.')
    if (result.removedCopy) console.log(`Deleted the tap's copy: ${result.removedCopy}`)
    return 0
  }
  console.log(result.action === 'update' ? 'Updated the usage tap to the code in this repo now. Your earlier status line is still chained.' : 'Installed the usage tap as your Claude Code status line.')
  console.log(`The status line runs a copy of the tap, not this repo: ${result.copy}`)
  console.log('A pull does not change that copy. Run this installer again to take a newer tap, after reading the change.')
  if (result.earlier) console.log('Your earlier status line still shows - the tap runs it after saving the reading.')
  console.log('Readings start after Claude\'s first reply in a session (Pro and Max plans only).')
  console.log('To undo: node scripts/install-usage-tap.mjs --remove')
  return 0
}

try {
  process.exitCode = await main()
} catch {
  // No error text: a file-system error names folders, and the message would add nothing useful.
  console.error('The installer stopped on an unexpected error. If it got as far as a backup, the backup is beside settings.json.')
  process.exitCode = 1
}
