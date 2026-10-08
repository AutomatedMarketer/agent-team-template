// The connections part: which tools, servers and plugins this computer has, by name only.
// Filled in by the later tasks of Phase 5; until then each block says it was not collected.

import { CONNECTIONS_SCHEMA } from './connections-schema.mjs'
import { isoSeconds } from './util.mjs'

const NOT_YET = { status: 'unavailable', why: 'not collected yet' }

export async function collectConnections(deps, computer) {
  return {
    schema: CONNECTIONS_SCHEMA,
    takenAt: isoSeconds(deps.now),
    computer,
    tools: [],
    claude: { ...NOT_YET },
    codex: { ...NOT_YET }
  }
}
