// Spawned by tests in place of scripts/collect-status.mjs. It runs the same main() - the real
// argument parsing, machine dependencies, gate and exit code - with the two doors to the outside
// shut: the Keychain command and the network. A spawned collector on a Mac would otherwise ask
// the real login Keychain for the real sign-in (`security` ignores HOME) and send it out.
//
// COLLECTOR_TEST_PLATFORM lets a test on any computer walk the Mac path up to the shut door.
// This file lives under tests/ and nothing outside tests/ imports it.

import { main } from '../../scripts/lib/status/cli.mjs'

const exec = async (file) => {
  console.error(`TEST HARNESS: refused to run ${file}`)
  throw new Error('shut in tests')
}

const fetch = async () => {
  console.error('TEST HARNESS: refused a network call')
  throw new Error('shut in tests')
}

const platform = process.env.COLLECTOR_TEST_PLATFORM || undefined

process.exitCode = await main({ replace: { exec, fetch, platform } })
