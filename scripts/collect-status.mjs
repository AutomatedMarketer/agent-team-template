// Writes this computer's usage snapshot - plan limits, plan names and an activity estimate for
// Claude and Codex - into .agent-team/status/usage/<computer>.json, for the dashboard to read.
//
// Run it: npm run collect:status -- --computer "Mac Mini"
//         npm run collect:status -- --dry-run          (prints the file, writes nothing)
//
// Every value passes the safety check in scripts/lib/status/safe.mjs before anything is written
// or printed. If it refuses, nothing is written and the exit code is not zero. The format, the
// sources and the Mac schedule are documented in .agent-team/status/README.md.

import { main } from './lib/status/cli.mjs'

process.exitCode = await main()
