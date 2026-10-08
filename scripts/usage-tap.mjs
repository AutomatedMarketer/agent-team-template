// The status line tap. Claude Code runs this after every reply and shows what it prints.
//
// It keeps the official 5-hour and 7-day plan readings from the status line JSON in a small
// file in your state folder (never in a repo), for the usage collector to pick up. Nothing else
// from that JSON is kept. Then it prints either a short line - "5h 18% · wk 49%" - or, with
// --then, whatever your earlier status line printed, so installing it changes nothing you see.
//
// Install it with: node scripts/install-usage-tap.mjs   (and undo with --remove)
// Try it by hand:  echo '{"rate_limits":{"five_hour":{"used_percentage":18,"resets_at":1791460800}}}' | node scripts/usage-tap.mjs
//
// It never exits with an error and never prints one: a status line that fails goes blank.
// How it works, and what it never writes: docs/guides/usage-meters-how-it-works.md

import os from 'node:os'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { runTap, shellFor } from './lib/status/tap.mjs'

const STDIN_CAP = 2_000_000
// Claude Code cancels a status line that is still running when the next update arrives, so this
// only matters for an earlier command that hangs on its own.
const EARLIER_TIMEOUT_MS = 10_000

async function readStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > STDIN_CAP) break
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// The earlier status line runs through the shell the installer recorded for it (--then-shell),
// the way Claude Code would have run it. Its stderr goes to ours (Claude Code shows that only with
// --debug); its stdout is what we print.
function runEarlier(command, input, dialect) {
  return new Promise((resolve) => {
    const chosen = shellFor(process.platform, process.env, existsSync, dialect)
    if (!chosen) {
      resolve('')
      return
    }
    const [shell, flags] = chosen
    let child
    try {
      child = spawn(shell, [...flags, command], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, timeout: EARLIER_TIMEOUT_MS })
    } catch {
      resolve('')
      return
    }
    const out = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(Buffer.concat(out).toString('utf8')))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

try {
  const { stdout } = await runTap({
    input: await readStdin(),
    argv: process.argv.slice(2),
    home: os.homedir(),
    env: process.env,
    platform: process.platform,
    now: Date.now(),
    runThen: runEarlier
  })
  if (stdout) process.stdout.write(stdout)
} catch {
  // Nothing printed on purpose: anything here would land in the status bar.
}
