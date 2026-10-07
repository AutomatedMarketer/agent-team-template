// usage-probe.mjs - the real subscription limits, as percentages and reset times.
//
// A thin wrapper: the reading itself lives in scripts/lib/status/claude-limits.mjs, which the
// usage collector uses too. That module asks the Mac Keychain first and the credentials file
// second, never prints or refreshes the sign-in token, and falls back to the reading Claude Code
// saved itself. This file prints the parsed windows only - never the raw answer - and only after
// the same safety check the collector uses has passed them.
//
// Run it: node .claude/skills/surplus-burn/usage-probe.mjs

import { pathToFileURL } from 'node:url'
import { collectClaudeLimits } from '../../../scripts/lib/status/claude-limits.mjs'
import { machineDeps } from '../../../scripts/lib/status/machine.mjs'
import { assertSafe, assertSafeLine } from '../../../scripts/lib/status/safe.mjs'
import { USAGE_SHAPE } from '../../../scripts/lib/status/schema.mjs'

const LIMITS_SHAPE = USAGE_SHAPE.keys.claude.keys.limits

export async function probe(deps) {
  const { limits } = await collectClaudeLimits(deps)
  let out
  try {
    assertSafe(limits, LIMITS_SHAPE, deps.identity)
    out = { ok: limits.status === 'found', ...limits }
    const line = JSON.stringify(out, null, 2)
    assertSafeLine(line, deps.identity)
    console.log(line)
  } catch {
    out = { ok: false, status: 'unavailable', why: 'refused by the safety check' }
    console.log(JSON.stringify(out, null, 2))
  }
  return out
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await probe(machineDeps())
}
