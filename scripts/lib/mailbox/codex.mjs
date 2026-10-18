// Running Codex for one job - only a job the computer's own allowlist gives to Codex (worker: codex) - on a login of its own, inside
// Codex's own sandbox, with what it can do fixed here and in .agent-team/mailbox/codex-config.toml.
//
// Checked on 2026-10-18 against Codex CLI 0.160.0 on Windows 11 (`codex exec --help`, `codex sandbox --help`, `codex login --help`,
// `codex features list`, and the sandbox itself, probed with `codex sandbox`), and these documents:
//   https://learn.chatgpt.com/docs/non-interactive-mode     codex exec, --json, --ephemeral, --ignore-rules, CODEX_API_KEY
//   https://learn.chatgpt.com/docs/permissions              permission profiles: :root, :minimal, :workspace, deny, network
//   https://learn.chatgpt.com/docs/config-file/config-reference   every key in the settings file
//   https://learn.chatgpt.com/docs/windows/windows-sandbox  mxc, elevated and unelevated on Windows
//   https://github.com/openai/codex  codex-rs/exec/src/exec_events.rs (the JSON events), codex-rs/cli/src/login.rs (login status)
//
//   exec                       one run, no conversation
//   --json                     every event as a line on stdout: the transcript, and what is audited here
//   --strict-config            a settings key this Codex does not know stops it, instead of being quietly ignored. So a Codex that does
//                              not understand the sandbox profile refuses to start rather than running without it
//   --ephemeral                no session files kept
//   --ignore-rules             no .rules files (the user's or the repo's) can allow a command
//   --skip-git-repo-check      the work copy is a git repo; the self-test's folder need not be
//   -C <work copy>             the folder it works in: the only folder its commands may write
//   -- <prompt>                after --, so a prompt is never read as a flag or a subcommand (checked: `exec -- help` starts a turn)
//
// NOT passed, on purpose: --sandbox (workspace-write lets commands READ the whole disk, and any sandbox_mode or --sandbox switches the
// permission profile off), -m (the account's own default model is used), --dangerously-*, --add-dir, --search, -c, --enable, --profile.
// Everything else is in the settings file, which the runner writes into a Codex home of its own before every start (writeCodexHome):
// CODEX_HOME points there, so the owner's ~/.codex - its MCP servers, hooks, AGENTS.md, skills, plugins, memories, login - is never read.
//
// Codex's main tool is a shell. It runs inside the sandbox: on a Mac, Seatbelt; on Windows only Microsoft's container sandbox (mxc), named
// in the settings so it fails closed where it is missing. The default Windows sandbox refuses this profile ("Restricted read-only access
// requires the elevated Windows sandbox backend"), and with a looser one it read files outside the work copy - so no Codex job runs on
// Windows until the probe (codex sandbox) and the self-test pass there.
//
// Like claude.mjs, everything that touches another program goes through `spawn`, `exec` and `kill` arguments, so the tests run a fake
// Codex. This file never imports child_process.

import { createWriteStream } from 'node:fs'
import * as realFs from 'node:fs/promises'
import { dirname, isAbsolute, join, win32 } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { KILL_AFTER_MS, LINE_MAX_CHARS, atLeast, killTree, parseVersion } from './claude.mjs'

export const CODEX_CONFIG_FILE = '.agent-team/mailbox/codex-config.toml'
export const CODEX_PROFILE = 'mailbox-work'
export const WORKERS = Object.freeze(['claude', 'codex'])

// WHY a floor: each wall below is something an older Codex may not have, and a key it does not know is an error (--strict-config) or,
// without that, nothing at all. 0.160.0 is the version every one of these was checked on; nothing older was available to check, so
// nothing older is run.
export const CODEX_VERSION_NEEDS = Object.freeze({
  'permission profiles (default_permissions, :root deny, :minimal, network off)': Object.freeze([0, 160, 0]),
  '--strict-config refuses an unknown key or feature': Object.freeze([0, 160, 0]),
  'codex sandbox -P (the probe and the self-test)': Object.freeze([0, 160, 0]),
  'windows.sandbox = "mxc"': Object.freeze([0, 160, 0]),
  'skills.max_context_tokens leaves out every skill': Object.freeze([0, 160, 0])
})
export const CODEX_MINIMUM_VERSION = Object.freeze(Object.values(CODEX_VERSION_NEEDS).reduce((highest, needed) => (atLeast(needed, highest) ? needed : highest), [0, 0, 0]))

const CLOSE_WAIT_MS = 5_000
const TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024
const STDERR_MAX_BYTES = 64 * 1024
const ASK_TIMEOUT_MS = 15_000
const PROBE_TIMEOUT_MS = 60_000
export const PROBE_WORD = 'SANDBOX_OK'

/* ---------- where it is ----------------------------------------------------------------------------------------------- */

// Where the runner looks for Codex: this list, in this order, and nowhere else - never PATH (the same reasons as claudeFolders).
// The standalone installer puts a link at ~/.local/bin/codex (https://chatgpt.com/codex/install.sh, BIN_DIR); Homebrew and an older
// npm install put theirs in the two folders after it. On Windows the installer's folder is %LOCALAPPDATA%\Programs\OpenAI\Codex\bin
// (install.ps1, defaultVisibleBinDir); an npm install leaves a codex.cmd shim, which needs a shell, so its native codex.exe is found
// where npm keeps it instead. Both are folders under the user's own profile.
export function codexFolders(home, platform = process.platform) {
  const given = typeof home === 'string' && home !== ''
  if (platform === 'win32') {
    if (!given) return []
    const npm = win32.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai')
    return [
      win32.join(home, 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin'),
      win32.join(npm, 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin'),
      win32.join(npm, 'codex-win32-arm64', 'vendor', 'aarch64-pc-windows-msvc', 'bin')
    ]
  }
  return [...(given ? [join(home, '.local', 'bin')] : []), '/opt/homebrew/bin', '/usr/local/bin']
}

// The runner's own Codex home: a folder next to the state folder. Not ~/.codex (the owner's), and not inside the state folder: on Windows
// that folder is locked to one access entry per file (windows.mjs), and Codex's sandbox adds its own entries to folders it uses.
export const codexHomeOf = (stateDir) => join(dirname(stateDir), 'agent-mailbox-codex')

/* ---------- the argument list and the environment ----------------------------------------------------------------- */

export function buildCodexArgv({ prompt, workDir }) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.startsWith('-')) throw new TypeError('codex: the prompt is text that does not start like a flag')
  if (typeof workDir !== 'string' || !isAbsolute(workDir)) throw new TypeError('codex: the work copy is a full path')
  return ['exec', '--json', '--strict-config', '--ephemeral', '--ignore-rules', '--skip-git-repo-check', '-C', workDir, '--', prompt]
}

const ENV_BASE = ['HOME', 'PATH', 'USER', 'LANG', 'TMPDIR']
const ENV_WINDOWS = ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP', 'Path']

// These variables and CODEX_HOME, and no others: no key, no token, nothing that changes where Codex connects or which account pays.
export function codexEnv(env, platform = process.platform, codexHome) {
  if (typeof codexHome !== 'string' || !isAbsolute(codexHome)) throw new TypeError('codex: the Codex home is a full path')
  const wanted = platform === 'win32' ? [...ENV_BASE, ...ENV_WINDOWS] : ENV_BASE
  return {
    ...Object.fromEntries(wanted.filter((name) => typeof env?.[name] === 'string').map((name) => [name, env[name]])),
    CODEX_HOME: codexHome,
    ...(platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {})
  }
}

// Keys and addresses that would send a run to another account, another server or a per-token bill (exec reads CODEX_API_KEY; the
// others are OpenAI's). Codex never gets one (codexEnv), and with one set no Codex job runs at all: the names are returned, never values.
const UNSAFE_NAMES = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN']

export function unsafeCodexEnv(env) {
  return UNSAFE_NAMES.filter((name) => typeof env?.[name] === 'string' && env[name] !== '')
}

// The Codex home made (0700) and its config.toml written from the pinned file (0600), every time: an edit there never survives to the next
// start. A home that is a link, or anything but a folder, is never written through. -> { ok, home }
export async function writeCodexHome({ stateDir, codeDir, fs = realFs }) {
  const home = codexHomeOf(stateDir)
  try {
    let info = null
    try {
      info = await fs.lstat(home)
    } catch (error) {
      if (error?.code !== 'ENOENT') return { ok: false, home }
    }
    if (info !== null && !info.isDirectory()) return { ok: false, home }
    if (info === null) await fs.mkdir(home, { recursive: true, mode: 0o700 })
    const text = await fs.readFile(join(codeDir, ...CODEX_CONFIG_FILE.split('/')), 'utf8')
    const target = join(home, 'config.toml')
    const existing = await fs.lstat(target).catch(() => null)
    if (existing !== null && !existing.isFile()) return { ok: false, home }
    const temporary = `${target}.${process.pid}.tmp`
    await fs.writeFile(temporary, text, { mode: 0o600 })
    await fs.rename(temporary, target)
    return { ok: true, home }
  } catch {
    return { ok: false, home }
  }
}

/* ---------- running it ------------------------------------------------------------------------------------------------ */

// The items a run may have, and the tool name progress is told for each one that is a call (null: not a call). Anything else - an MCP
// tool, a web search, a sub-agent, or an item no checked version had - stops the run at once.
export const CODEX_ITEMS = Object.freeze({
  agent_message: null,
  reasoning: null,
  command_execution: 'Shell',
  file_change: 'Edit',
  todo_list: 'Plan',
  error: null
})
const EVENTS = new Set(['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'item.started', 'item.updated', 'item.completed', 'error'])
const ITEM_TYPE = /^[a-z_]{1,64}$/

// Codex's output is one JSON event per line (exec_events.rs). Every one is read for the items it names, which must be the allowed ones,
// and for how the turn ended.
//   { ok: true, calls, exitCode, transcriptBytes }
//   { ok: false, why: 'codex-failed' | 'timed-out' | 'tool-refused', calls, exitCode, transcriptBytes, tool? }
// The transcript - every byte it said - is written to `transcriptPath` for the owner alone.
export function runCodex({
  file, argv, cwd, env, timeoutMs, killAfterMs = KILL_AFTER_MS, closeWaitMs = CLOSE_WAIT_MS,
  transcriptPath, stderrPath, maxTranscriptBytes = TRANSCRIPT_MAX_BYTES,
  spawn, kill, platform = process.platform, openStream = createWriteStream, live = null,
  // Told { type: 'started' }, { type: 'tool', name } for each call (Shell, Edit, Plan), { type: 'finishing' } - NEVER a command, a path or a
  // word Codex wrote or read. It can throw; that never reaches the run.
  onEvent = null
}) {
  const stop = kill ?? ((pid, signal) => killTree(pid, signal, { platform, spawn }))
  return new Promise((resolve) => {
    if (live?.stopping) {
      resolve({ ok: false, why: 'codex-failed', calls: {}, exitCode: null, transcriptBytes: 0 })
      return
    }
    const calls = new Map()
    const seen = new Set()
    let transcriptBytes = 0
    let reason = null
    let tool = null
    let completed = false
    let failed = false
    let exitCode = null
    let settled = false
    let child = null
    let pending = ''
    let stderrBytes = 0
    let stderrFile = null
    let killTimer = null
    let closeTimer = null
    let timer = null
    const decoder = new StringDecoder('utf8')
    const transcript = openStream(transcriptPath, { flags: 'w', mode: 0o600 })
    transcript.on('error', () => hardStop('codex-failed'))

    let exited = false
    const stopTree = (signal) => {
      if (!child?.pid || (platform === 'win32' && exited)) return
      stop(child.pid, signal)
    }

    const answer = () => {
      const base = { calls: Object.fromEntries(calls), exitCode, transcriptBytes }
      if (reason === null && exitCode === 0 && completed && !failed) return { ok: true, ...base }
      return { ok: false, why: reason ?? 'codex-failed', ...base, ...(tool !== null ? { tool } : {}) }
    }

    const finalize = (code) => {
      if (settled) return
      settled = true
      if (child?.pid) live?.children.delete(child.pid)
      clearTimeout(timer)
      clearTimeout(killTimer)
      clearTimeout(closeTimer)
      exitCode = typeof code === 'number' ? code : null
      read(pending)
      stderrFile?.end()
      transcript.end(() => resolve(answer()))
    }

    function hardStop(why) {
      reason ??= why
      stopTree('SIGKILL')
      closeTimer ??= setTimeout(() => finalize(null), closeWaitMs)
    }

    const refuse = (name) => {
      tool = typeof name === 'string' && ITEM_TYPE.test(name) ? name : 'unknown'
      hardStop('tool-refused')
    }

    const report = (event) => {
      if (typeof onEvent !== 'function') return
      try {
        onEvent(event)
      } catch {
        // Progress is best effort: it can never fail a run.
      }
    }

    function read(text) {
      let event
      try {
        event = JSON.parse(text)
      } catch {
        return
      }
      if (reason === 'tool-refused' || event === null || typeof event !== 'object') return
      if (!EVENTS.has(event.type)) return refuse('unknown')
      if (event.type === 'thread.started') report({ type: 'started' })
      else if (event.type === 'turn.completed') {
        completed = true
        report({ type: 'finishing' })
      } else if (event.type === 'turn.failed') failed = true
      else if (event.type.startsWith('item.')) {
        const type = event.item?.type
        if (typeof type !== 'string' || !Object.hasOwn(CODEX_ITEMS, type)) return refuse(type)
        const name = CODEX_ITEMS[type]
        const id = typeof event.item.id === 'string' ? event.item.id : null
        // One call per item, however many times it is seen (started, updated, completed).
        if (name !== null && (id === null || !seen.has(id))) {
          if (id !== null) seen.add(id)
          calls.set(name, (calls.get(name) ?? 0) + 1)
          report({ type: 'tool', name })
        }
      }
      return undefined
    }

    try {
      child = spawn(file, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: platform !== 'win32', windowsHide: true, shell: false })
    } catch {
      finalize(null)
      return
    }
    if (child.pid) live?.children.add(child.pid)
    if (live?.stopping) hardStop('codex-failed')
    timer = setTimeout(() => {
      reason ??= 'timed-out'
      stopTree('SIGTERM')
      killTimer = setTimeout(() => {
        stopTree('SIGKILL')
        closeTimer ??= setTimeout(() => finalize(null), closeWaitMs)
      }, killAfterMs)
    }, timeoutMs)

    child.stdout?.on('data', (chunk) => {
      transcriptBytes += chunk.length
      transcript.write(chunk)
      if (transcriptBytes > maxTranscriptBytes) hardStop('codex-failed')
      pending += decoder.write(chunk)
      const lines = pending.split('\n')
      pending = lines.pop()
      for (const text of lines) read(text)
      if (pending.length > LINE_MAX_CHARS) {
        pending = ''
        hardStop('codex-failed')
      }
    })
    child.stderr?.on('data', (chunk) => {
      if (!stderrPath || stderrBytes >= STDERR_MAX_BYTES) return
      stderrFile ??= openStream(stderrPath, { flags: 'w', mode: 0o600 })
      const part = chunk.subarray(0, STDERR_MAX_BYTES - stderrBytes)
      stderrBytes += part.length
      stderrFile.write(part)
    })
    child.on('exit', () => {
      exited = true
    })
    child.on('error', () => finalize(null))
    child.on('close', (code) => finalize(code))
  })
}

/* ---------- the check before any Codex job ---------------------------------------------------------------------------- */

// `codex login status` prints one line to its error stream (login.rs, run_login_status): "Logged in using ChatGPT" (exit 0) is the only
// good answer. An API key (it prints a masked one, never read here), another kind of login, or "Not logged in" is not.
export function loginWord(answer) {
  if (!answer || answer.code !== 0) return 'codex-not-logged-in'
  const lines = String(answer.stderr ?? '').split(/\r?\n/).map((text) => text.trim())
  return lines.includes('Logged in using ChatGPT') ? null : 'codex-wrong-login'
}

// The plainest command, started through Codex's own sandbox with the runner's profile. It costs nothing (no model), and it fails where the
// sandbox cannot hold the profile - on Windows without the container sandbox, Codex refuses to start it at all.
export function sandboxProbeArgv({ dir, platform = process.platform, systemRoot = 'C:\\Windows' }) {
  const command = platform === 'win32' ? [win32.join(systemRoot, 'System32', 'cmd.exe'), '/d', '/c', `echo ${PROBE_WORD}`] : ['/bin/echo', PROBE_WORD]
  return ['sandbox', '-P', CODEX_PROFILE, '-C', dir, '--', ...command]
}

const systemRootOf = (env) => {
  const key = Object.keys(env ?? {}).find((name) => name.toUpperCase() === 'SYSTEMROOT')
  return key !== undefined && typeof env[key] === 'string' && win32.isAbsolute(env[key]) ? env[key] : 'C:\\Windows'
}

// The probe's folder: inside the Codex home (never the state folder, see codexHomeOf), made empty each time.
export const probeDirOf = (stateDir) => join(codexHomeOf(stateDir), 'probe')

// The checks before any Codex job, every problem named in a word and all of them returned:
//   codex-key-in-environment  codex-missing  codex-version-unknown  codex-too-old  codex-home-failed  codex-not-logged-in  codex-wrong-login
//   codex-no-sandbox
// Every question is asked of the file found, from an empty folder, in the runner's Codex home, with the small environment.
export async function codexPreflight({ find, exec, stateDir, codeDir, emptyDir, env, platform, fs = realFs }) {
  const problems = unsafeCodexEnv(env).length ? ['codex-key-in-environment'] : []
  let version = null
  const found = await find('codex')
  if (found.state !== 'found') return { ok: false, version, problems: [...problems, 'codex-missing'] }
  const home = await writeCodexHome({ stateDir, codeDir, fs })
  const options = (extra = {}) => ({ cwd: emptyDir, env: codexEnv(env, platform, home.home), timeout: ASK_TIMEOUT_MS, ...extra })
  try {
    version = parseVersion((await exec(found.path, ['--version'], options())).stdout)
  } catch {
    version = null
  }
  if (version === null) problems.push('codex-version-unknown')
  else if (!atLeast(version, CODEX_MINIMUM_VERSION)) problems.push('codex-too-old')
  if (!home.ok) return { ok: false, version, problems: [...problems, 'codex-home-failed'] }
  let login = null
  try {
    login = await exec(found.path, ['login', 'status'], options({ acceptAnyExit: true, stderr: true }))
  } catch {
    login = null
  }
  const word = loginWord(login)
  if (word !== null) problems.push(word)
  const probeDir = probeDirOf(stateDir)
  let probed = false
  try {
    await fs.rm(probeDir, { recursive: true, force: true })
    await fs.mkdir(probeDir, { recursive: true })
    const answer = await exec(found.path, sandboxProbeArgv({ dir: probeDir, platform, systemRoot: systemRootOf(env) }), options({ timeout: PROBE_TIMEOUT_MS }))
    probed = String(answer.stdout).split(/\r?\n/).some((text) => text.trim() === PROBE_WORD)
  } catch {
    probed = false
  }
  if (!probed) problems.push('codex-no-sandbox')
  return { ok: problems.length === 0, version, problems }
}
