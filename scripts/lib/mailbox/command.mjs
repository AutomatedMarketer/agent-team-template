// The command a LaunchAgent runs every five minutes, and the few switches a person uses by hand.
//
//   node scripts/mailbox-runner.mjs               one tick, at the board's pace (what the schedule runs)
//   node scripts/mailbox-runner.mjs --once        one tick now, whatever the pace (a supervised first order)
//   node scripts/mailbox-runner.mjs --preflight   say in plain words what is ready and what is not; changes nothing
//   node scripts/mailbox-runner.mjs --selftest    run the real Claude against planted traps and files it must not touch; no run is done until it passes
//   --state-dir D  --work-dir D  --env-file F     use these places instead of the usual ones
//
// Output is plain lines for a person to read: never a key, a path with a user name in it, or a word anyone typed.
// Exit 0 when the tick did its job (or had nothing to do, or is paused); 1 when something needs the owner; 2 for a
// switch that is not one.

import { fileURLToPath } from 'node:url'
import { access, mkdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { readAllowedOrders } from './allow.mjs'
import { readMailboxEnv } from './keys.mjs'
import { checkPlaces, defaultPlaces } from './places.mjs'
import { MINIMUM_VERSION, claudeFolders, followToFile, killTree, preflight, originMatches } from './claude.mjs'
import { pointsElsewhere, readOrigin } from './workcopy.mjs'
import { workCopyStuck } from './gitguard.mjs'
import { runTick } from './tick.mjs'
import { selftest } from './selftest.mjs'
import { proofHolds } from './proof.mjs'
import { createLive, listenForSignals, signalHandler } from './signals.mjs'
import { releaseLock } from '../status/commit.mjs'

export const USAGE = [
  'Usage: node scripts/mailbox-runner.mjs [switch]',
  '  (no switch)   one tick, at the board\'s pace - what the schedule runs',
  '  --once        one tick now, whatever the pace',
  '  --preflight   say what is ready and what is not; changes nothing',
  '  --selftest    run the real Claude against planted traps and files it must not touch (runs wait for it to pass)',
  '  --help        this text',
  '  --state-dir D, --work-dir D, --env-file F   use these places instead of the usual ones'
].join('\n')

const MODES = { '--once': 'tick', '--preflight': 'preflight', '--selftest': 'selftest' }
const PATHS = { '--state-dir': 'stateDir', '--work-dir': 'workDir', '--env-file': 'envFile' }

// { ok: true, mode, force, paths } or { ok: false, help? }
export function parseArgs(argv) {
  let mode = null
  let force = false
  const paths = {}
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]
    if (arg === '--help') return { ok: false, help: true }
    if (Object.hasOwn(MODES, arg)) {
      if (mode !== null) return { ok: false }
      mode = MODES[arg]
      force = arg === '--once'
    } else if (Object.hasOwn(PATHS, arg)) {
      const value = argv[at + 1]
      if (typeof value !== 'string' || value.startsWith('-') || Object.hasOwn(paths, PATHS[arg])) return { ok: false }
      paths[PATHS[arg]] = value
      at += 1
    } else {
      return { ok: false }
    }
  }
  return { ok: true, mode: mode ?? 'tick', force, paths }
}

const GOOD_STATES = ['done', 'waiting', 'paused', 'busy']

const PLACE_WORDS = {
  path: 'one of the folders is not a full path',
  'state-inside-code': 'the state folder is inside the code folder',
  'state-inside-work': 'the state folder is inside the work copy',
  'code-inside-state': 'the code folder is inside the state folder',
  'work-inside-state': 'the work copy is inside the state folder',
  'work-inside-code': 'the work copy is inside the code folder',
  'code-inside-work': 'the code folder is inside the work copy',
  'env-inside-code': 'the secrets file is inside the code folder',
  'env-inside-work': 'the secrets file is inside the work copy'
}

// Windows only: the one case of "not found" that is really "found, but not as a program the runner may start".
async function npmShimExists(env) {
  const key = Object.keys(env ?? {}).find((name) => name.toUpperCase() === 'APPDATA')
  if (key === undefined || typeof env[key] !== 'string' || !isAbsolute(env[key])) return false
  try {
    await access(join(env[key], 'npm', 'claude.cmd'))
    return true
  } catch {
    return false
  }
}

const WINDOWS_SHIM = 'Claude: Claude Code was found only as a .cmd file (an npm install) or inside the work copy. The runner starts only a real claude.exe, by its full path. Install the native version (https://code.claude.com/docs/en/setup) and run this again.'

// Windows only (windows.mjs, privatePlaces): why the state folder could not be made private to the current account.
const PRIVATE_WORDS = {
  'secrets-outside-state': 'the secrets file is not inside the state folder, so the folder lock would not cover it',
  'no-system-root': 'the Windows system folder (SystemRoot) is not known',
  'no-user': 'the Windows account name is not known or is not a plain name',
  'lock-failed': 'icacls could not set the folder to your account only',
  'others-have-access': 'after the lock another account still has access to the folder',
  'link-in-state': 'there is a shortcut or link inside the state folder, so it was not touched; take the link out and run this again',
  'not-you': 'after the lock the one account with access is not yours',
  unavailable: 'this run has no way to lock the folder'
}

const PROBLEM_WORDS = {
  'claude-missing': 'Claude Code was not found.',
  'version-unknown': 'Claude Code did not say which version it is.',
  'version-too-old': `Claude Code is too old: the protections need ${MINIMUM_VERSION.join('.')} or later (claude update).`,
  'not-logged-in': 'Claude Code is not logged in.',
  'wrong-login': 'Claude Code is not logged in with your own Claude account (a subscription login).',
  'key-in-environment': 'An API key or address for Claude is set in the environment (ANTHROPIC_API_KEY and the like); take it out.',
  'origin-mismatch': 'The work copy\'s origin is not the team repo the allowlist names.',
  'origin-has-login': 'The team repo\'s address holds a user name, password or token. git puts the whole address on a command line while it runs, where any program on this computer can read it. Clone it with a plain https://github.com/... address and let Git\'s sign-in helper hold the login (Git Credential Manager on Windows, the keychain on a Mac).',
  'selftest-needed': 'not passed for this Claude Code version and these settings. Run `node scripts/mailbox-runner.mjs --selftest` (a few minutes, with the real Claude); no job runs until it passes.'
}

async function report(ctx, places, out) {
  const lines = []
  let ready = true
  const say = (good, text) => {
    ready &&= good
    lines.push(`${good ? 'ok     ' : 'PROBLEM'} ${text}`)
  }

  const where = await checkPlaces(places)
  say(where.ok, where.ok ? 'folders: none overlaps another' : `folders: ${PLACE_WORDS[where.why] ?? where.why}`)

  if (ctx.platform === 'win32') {
    const priv = typeof ctx.privatePlaces === 'function' ? await ctx.privatePlaces(places) : { ok: false, why: 'unavailable' }
    say(priv.ok, priv.ok ? 'private folder: only your Windows account can open the state folder and the secrets in it' : `private folder: ${PRIVATE_WORDS[priv.why] ?? priv.why}`)
  }

  const allowed = await readAllowedOrders(places.stateDir, ctx.identity)
  if (allowed.state === 'ok') say(true, `allowlist: ${allowed.allow.actions.length} actions, ${allowed.allow.jobs.size} jobs, ${allowed.allow.perDay.orders} orders a day`)
  else say(false, allowed.state === 'missing' ? 'allowlist: missing - there is no allowed-orders.yml in the state folder, so nothing will run' : `allowlist: not usable (${allowed.why}) - nothing will run`)

  const secrets = await readMailboxEnv(places.envFile, { platform: ctx.platform })
  if (secrets.state === 'ok') say(true, `secrets: ok (${secrets.secrets.size} signing ${secrets.secrets.size === 1 ? 'key' : 'keys'} and the board key)`)
  else say(false, secrets.state === 'missing' ? 'secrets: missing - there is no secrets file, so the runner cannot ask the board' : `secrets: not usable (${secrets.why}) - the runner will not ask the board`)

  const empty = join(places.stateDir, 'empty-cwd')
  await rm(empty, { recursive: true, force: true })
  await mkdir(empty, { recursive: true })
  const accepted = ctx.originAccepted ?? (allowed.state === 'ok' ? (url) => originMatches(url, allowed.allow.repo) : () => false)
  const checks = await preflight({ find: ctx.find, exec: ctx.exec, origin: () => readOrigin(places.workDir), originAccepted: accepted, emptyDir: empty, env: ctx.env, platform: ctx.platform })
  const has = (problem) => checks.problems.includes(problem)
  // npm leaves claude.cmd in the npm folder under APPDATA. It is looked for only to give this message: it is never run.
  const shim = has('claude-missing') && ctx.platform === 'win32' && ((await ctx.find('claude')).state === 'refused' || (await npmShimExists(ctx.env)))
  say(!has('claude-missing'), has('claude-missing') ? (shim ? WINDOWS_SHIM : 'Claude: Claude Code was not found.') : `Claude: found${checks.version ? `, version ${checks.version.join('.')}` : ''}`)
  if (!has('claude-missing') && ctx.findAll) {
    // Every copy on the list, and the one the runner uses. Paths are shown from the home folder, never with the user name.
    const every = (await ctx.findAll('claude')).paths
    const used = (await ctx.find('claude')).path
    const shown = (path) => (typeof ctx.home === 'string' && path.startsWith(ctx.home) ? `~${path.slice(ctx.home.length).split(String.fromCharCode(92)).join('/')}` : path)
    say(true, `Claude: ${every.length === 1 ? 'one copy' : `${every.length} copies`} on the fixed list - ${every.map((path) => `${shown(path)}${path === used ? ' (the runner uses this one)' : ' (not used)'}`).join('; ')}`)
  }
  for (const problem of ['version-unknown', 'version-too-old']) if (has(problem)) say(false, `Claude: ${PROBLEM_WORDS[problem]}`)
  if (!has('claude-missing')) {
    const login = ['not-logged-in', 'wrong-login'].find(has)
    say(login === undefined, login === undefined ? 'login: your own Claude account' : `login: ${PROBLEM_WORDS[login]}`)
  }
  if (checks.version) {
    // The proof must be for the very file the link leads to now, so the link is followed here as a run would follow it.
    const file = await followToFile((await ctx.find('claude')).path, ctx.realpath ?? realpath)
    const proof = await proofHolds({ stateDir: places.stateDir, codeDir: places.codeDir, version: checks.version, file })
    say(proof.holds, proof.holds ? `self-test: passed on ${proof.at.slice(0, 10)} for this Claude and these settings` : `self-test: ${PROBLEM_WORDS['selftest-needed']}`)
  }
  say(!has('key-in-environment'), has('key-in-environment') ? `API key: ${PROBLEM_WORDS['key-in-environment']}` : 'API key: none set')
  // The work copy's own state, as every tick sees it before the origin check (tick.mjs). Either one means no tick does anything, so
  // --preflight must not say "Everything is ready".
  const stuck = await workCopyStuck(places.stateDir)
  const elsewhere = !stuck && (await pointsElsewhere(places.workDir))
  if (stuck) say(false, 'work copy: a run changed its git settings and it could not be moved aside to be made again. Close whatever is open in the work copy folder (a terminal, an editor, a file window); the next tick makes it again by itself. Do not run git in it.')
  else if (elsewhere) say(false, 'work copy: its .git holds a file that sends git to other settings or objects (commondir, config.worktree or objects/info/alternates). Delete the work copy folder and clone it again (step 3); do not run git in it.')
  const originProblem = ['origin-has-login', 'origin-mismatch'].find(has)
  say(originProblem === undefined, originProblem !== undefined ? `team repo: ${PROBLEM_WORDS[originProblem]}` : 'team repo: the work copy\'s origin is the team repo')

  for (const line of lines) out(line)
  out(ready ? 'Everything is ready.' : 'Not everything is ready. Fix the lines marked PROBLEM and run this again.')
  return ready ? 0 : 1
}

export async function main({ argv = [], home, tick = runTick, out = console.log, err = console.error, codeDir, ...rest }) {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    const sink = parsed.help ? out : err
    sink(USAGE)
    return parsed.help ? 0 : 2
  }
  const scriptRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
  const places = { ...(rest.places ?? { ...defaultPlaces(home, { platform: rest.platform, env: rest.env }), codeDir: codeDir ?? scriptRoot }), ...parsed.paths }
  // A program inside the work copy is never run: that is the folder other people push to.
  // Claude Code is found by one fixed list of folders (claude.mjs, claudeFolders), the same in a terminal and under launchd. Any other program
  // is found as before. `claudeFolders` in the arguments is for the tests, which cannot have a real /opt/homebrew/bin.
  const folders = Array.isArray(rest.claudeFolders) ? rest.claudeFolders : claudeFolders(home, rest.platform)
  const where = (name) => ({ clone: places.workDir, ...(name === 'claude' ? { folders } : {}) })
  const find = typeof rest.find === 'function' ? (name) => rest.find(name, where(name)) : undefined
  const findAll = typeof rest.findAll === 'function' ? (name) => rest.findAll(name, where(name)) : undefined
  // What is alive, so that a signal (launchctl bootout, Ctrl-C) kills Claude, releases the lock, and exits (signals.mjs). `proc` is the real process.
  const live = createLive()
  const ctx = { ...rest, home, places, find, findAll, log: rest.log ?? out, force: parsed.force, live }
  if (rest.proc) {
    const kill = rest.kill ?? ((pid, signal) => killTree(pid, signal, { platform: rest.platform, spawn: rest.spawn }))
    // `keepLockOnSignal`: the runner runs inside a process that does not end on a signal (the board on a student's computer). There the
    // handler only kills Claude: the tick goes on until it unwinds, and its own `finally` releases the lock then. Released here, another taker
    // could get the lock while the tick still works, and the tick would then delete THAT lock. Left out (the Mac), nothing changes.
    const release = rest.keepLockOnSignal === true ? async () => {} : releaseLock
    listenForSignals(rest.proc, signalHandler(live, { kill, release, exit: (code) => rest.proc.exit(code), log: out }))
  }

  try {
    if (parsed.mode === 'preflight') return await report(ctx, places, out)
    if (parsed.mode === 'selftest') {
      const result = await selftest(ctx)
      out(result.ok ? 'Self-test passed: the traps did not fire, nothing outside the work copy could be read or written, and jobs may run.' : 'Self-test FAILED:')
      for (const problem of result.problems) out(`  - ${problem}`)
      if (!result.ok) out('No job runs until a self-test passes.')
      return result.ok ? 0 : 1
    }
    const result = await tick(ctx)
    return GOOD_STATES.includes(result.state) ? 0 : 1
  } catch {
    // What went wrong is not printed: a message from the file system or from git can carry a path, and a path carries a
    // user name. The order, if there was one, is settled by the next tick, which reads the claims.
    out(`mailbox ${parsed.mode}: stopped (unexpected-error)`)
    return 1
  }
}
