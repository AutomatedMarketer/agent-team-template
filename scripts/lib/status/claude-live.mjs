// The live check: `claude mcp list`, which asks every server Claude Code knows whether it connects.
//
// It is the loudest thing the collector does. It starts every local server, and it prints each
// server's command or address - with whatever keys and tokens are in them. So (decision D1):
//   - it runs the claude programs.mjs found, by absolute path, never one inside --clone;
//   - from <state-dir>/empty-cwd, emptied first, so no project's own servers or settings load;
//   - for at most two minutes, with a 256 KB output cap; on either, everything it started is
//     stopped and the file list is used instead;
//   - its exit code is ignored (it exits 0 with failed servers, and that is not the answer);
//   - from each line only two things are kept: the name, up to the first ": ", and the state,
//     after the last " - ". Everything between - the command, the address - is dropped here and
//     never leaves this module. The answer itself lives in memory only.

import { findProgram, emptyFolder, PROGRAM_OUTPUT_CAP } from './programs.mjs'

export const LIVE_LIST_TIMEOUT_MS = 120_000

// Colour codes, terminal links and other escape sequences, then any control character left.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

// The state words Claude Code prints, matched loosely (they are not documented and have changed
// between versions). Order matters: "Disconnected" and "Not connected" contain "connected".
function stateOf(words) {
  const text = words.toLowerCase()
  if (/needs? (auth|log ?in|sign)|authenticat|sign.?in required/.test(text)) return 'needs sign-in'
  if (/pending|approv/.test(text)) return 'waiting for approval'
  if (/fail|error|disconnect|not connected|unreachable|timed? ?out/.test(text)) return 'failed'
  if (/connected/.test(text)) return 'connected'
  return 'unknown'
}

// Returns [{ name, state }] - names as printed, still to pass the name rule - or [] when it says
// there are no servers, or null when the answer cannot be read at all.
export function parseMcpList(text) {
  if (typeof text !== 'string') return null
  const clean = text.replace(ESCAPES, '').replace(CONTROLS, '')
  const rows = []
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.trim()
    const nameEnd = line.indexOf(': ')
    const stateStart = line.lastIndexOf(' - ')
    if (nameEnd <= 0 || stateStart < nameEnd) continue
    rows.push({ name: line.slice(0, nameEnd).trim(), state: stateOf(line.slice(stateStart + 3)) })
  }
  if (rows.length) return rows
  if (/no mcp servers configured/i.test(clean)) return []
  return null
}

// Returns { live, rows? }. `live` is one of the contract's LIVE_STATES.
export async function liveCheck(deps) {
  let program
  try {
    program = await findProgram('claude', deps)
  } catch {
    return { live: 'could not run' }
  }
  if (program.state === 'not found') return { live: 'program not found' }
  if (program.state !== 'found' || typeof deps.exec !== 'function' || !deps.stateDir) return { live: 'could not run' }
  let cwd
  try {
    cwd = await emptyFolder(deps.stateDir)
  } catch {
    return { live: 'could not run' }
  }
  let answer
  try {
    answer = await deps.exec(program.path, ['mcp', 'list'], {
      cwd,
      timeout: LIVE_LIST_TIMEOUT_MS,
      maxOutput: PROGRAM_OUTPUT_CAP,
      acceptAnyExit: true
    })
  } catch (error) {
    if (error?.code === 'ETIMEDOUT') return { live: 'timed out' }
    if (error?.code === 'ECAP') return { live: 'could not read' }
    return { live: 'could not run' }
  }
  const rows = parseMcpList(String(answer?.stdout ?? ''))
  return rows ? { live: 'checked', rows } : { live: 'could not read' }
}
