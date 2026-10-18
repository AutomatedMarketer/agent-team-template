// Running Claude Code for one job, on the owner's own login, with what it can do fixed here.
//
// The flags below are the ones the Claude Code docs describe (checked 2026-10-12):
//   https://code.claude.com/docs/en/cli-reference   every flag
//   https://code.claude.com/docs/en/headless        -p, stream-json, --permission-prompts, --bare (not used: it ignores the login)
//   https://code.claude.com/docs/en/permissions     what a -p run reads from a folder it was never asked to trust
//
//   -p "<prompt>"                    one run, no conversation. The prompt is first so no list flag can swallow it
//   --model <opus|sonnet>            the owner agent's own model
//   --restricted                     (v2.1.248) the built-in tools that run commands or code are removed, and so is WebFetch unless
//                                    --tools names it; the built-in file tools are confined to the working directories; only managed
//                                    settings and --settings are loaded; bypassPermissions is refused (cli-reference, the --restricted row)
//   --permission-mode dontAsk        anything not allowed is denied, never asked: a reach outside the work copy fails
//   --permission-prompts none        nobody can answer a prompt, so Claude is told not to retry
//   --tools <list>                   the built-in tools that exist at all. Bash is not one: there is no shell. The web tools only when the
//                                    job needs them (the morning intel); the task sweep never has them
//   --allowedTools <rules>           what is pre-approved. A tool name with no path in it is allowed EVERYWHERE and dontAsk runs anything
//                                    allowed, so the file tools are pre-approved only as Read(/**) and Edit(/**) - on the command line a
//                                    leading / is the folder Claude is started in, and Edit covers Write (permissions, "Read and Edit").
//                                    Anything outside that folder is denied by dontAsk, and also refused by blockReadsOutsideWorkingDirectories
//                                    in the settings file (v2.1.257)
//   --disallowedTools "mcp__*"       removes every connector tool
//   --settings <file>                our own settings: hooks off, inline shell in skills off, deny rules (claude-settings.json)
//   --setting-sources user           the team repo's settings are NOT read - not its hooks, its env block or its helpers.
//                                    A -p run otherwise uses all three, in a folder it was never asked to trust
//   --strict-mcp-config --mcp-config an empty server list: .mcp.json and every other source are ignored
//   --disable-slash-commands         no skills and no commands: their hooks and allowed-tools never load. The job's
//                                    steps are read as files, by the Read tool, because the prompt says to
//   --no-session-persistence         nothing saved for a later --resume
//   --max-turns 80                   a stop on a run that will not end
//   --output-format stream-json --verbose   every message as a line: the transcript, and what is audited here
//
// Claude Code has no flag for a time limit ("The CLI has no run-timeout flag"), so the limit is kept here: ask it to
// end, then kill the whole process group ten seconds later.
//
// Everything that touches another program goes through `spawn` and `kill` arguments, so the tests run a fake Claude and
// the real one is never started on a development computer. This file never imports child_process.

import { createWriteStream } from 'node:fs'
import { isAbsolute, join, win32 } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { REPO_SHAPE } from './contract.mjs'
import { addressHasLogin } from './workcopy.mjs'

export const FILE_TOOLS = Object.freeze(['Read', 'Edit', 'Write', 'Glob', 'Grep'])
export const WEB_TOOLS = Object.freeze(['WebSearch', 'WebFetch'])
export const TOOLS = Object.freeze([...FILE_TOOLS, ...WEB_TOOLS])
// The tools a run has: the file tools, and the web only for a job that needs the news. (A web tool is a way out: a tricked run can
// put what it has read into a URL. That is accepted for the morning intel and never offered to the sweep.)
export const toolsFor = (web) => (web ? [...FILE_TOOLS, ...WEB_TOOLS] : [...FILE_TOOLS])
// What is pre-approved: the file tools only inside the work copy, the web tools only where the job has them.
export const allowedFor = (web) => ['Read(/**)', 'Edit(/**)', ...(web ? WEB_TOOLS : [])]
// The CLI reference says --tools cannot remove this one; calling it only ends the conversation.
const TOLERATED = Object.freeze(['EndConversation'])
// Where the runner looks for Claude Code: this list, in this order, and nowhere else - never PATH. A LaunchAgent's PATH and a Terminal's PATH
// differ, and an older npm or Homebrew copy can sit ahead of the native one on either, so by PATH the self-test could prove one file and the runner
// start another, and every run would be refused with no way to fix it by running the self-test again. The native installer puts a link at
// ~/.local/bin/claude (https://code.claude.com/docs/en/setup#auto-updates, read 2026-10-13), so that comes first; the Homebrew cask and an
// older npm install put theirs in the two folders after it.
// On Windows the native installer puts claude.exe at %USERPROFILE%\.local\bin\claude.exe (https://code.claude.com/docs/en/setup, read 2026-10-17) and that is the only folder: an npm install leaves a claude.cmd
// shim, which needs a shell to start, and the runner never uses one (programs.mjs refuses a .cmd). The two Mac folders are not Windows folders.
export const claudeFolders = (home, platform = process.platform) => {
  const given = typeof home === 'string' && home !== ''
  if (platform === 'win32') return given ? [win32.join(home, '.local', 'bin')] : []
  return [...(given ? [join(home, '.local', 'bin')] : []), '/opt/homebrew/bin', '/usr/local/bin']
}
export const SETTINGS_FILE = '.agent-team/mailbox/claude-settings.json'
export const MCP_FILE = '.agent-team/mailbox/empty-mcp.json'
export const MAX_TURNS = 80
export const KILL_AFTER_MS = 10_000
const CLOSE_WAIT_MS = 5_000
const TRANSCRIPT_MAX_BYTES = 32 * 1024 * 1024
export const LINE_MAX_CHARS = 4 * 1024 * 1024
const STDERR_MAX_BYTES = 64 * 1024

// WHY a floor: every protection below is something an older Claude Code does not have, and a flag it does not know is an
// error - or, worse for a rule it does not know, nothing at all. So the runner refuses to run Claude below the highest of
// these, each as the Claude Code docs state it (read 2026-10-13):
//   --restricted                                      v2.1.248  https://code.claude.com/docs/en/cli-reference (the --restricted row)
//   permissions.blockReadsOutsideWorkingDirectories   v2.1.257  https://code.claude.com/docs/en/settings-reference
//   --permission-prompts none                         v2.1.259  https://code.claude.com/docs/en/cli-reference (the --permission-prompts row)
//   a Read deny rule also blocks Edit                 v2.1.208  https://code.claude.com/docs/en/permissions#read-and-edit
//   a Read deny rule also blocks Write                v2.1.228  (the same section)
export const VERSION_NEEDS = Object.freeze({
  '--restricted': Object.freeze([2, 1, 248]),
  'permissions.blockReadsOutsideWorkingDirectories': Object.freeze([2, 1, 257]),
  '--permission-prompts none': Object.freeze([2, 1, 259]),
  'a Read deny rule blocks Edit': Object.freeze([2, 1, 208]),
  'a Read deny rule blocks Write': Object.freeze([2, 1, 228])
})
export const MINIMUM_VERSION = Object.freeze(Object.values(VERSION_NEEDS).reduce((highest, needed) => (atLeast(needed, highest) ? needed : highest), [0, 0, 0]))
const RUN_MODELS = ['opus', 'sonnet']

/* ---------- the version ---------------------------------------------------------------------------------------------- */

export function parseVersion(text) {
  const found = typeof text === 'string' ? /(\d+)\.(\d+)\.(\d+)/.exec(text) : null
  return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : null
}

export function atLeast(version, minimum) {
  for (let at = 0; at < 3; at += 1) {
    if (version[at] !== minimum[at]) return version[at] > minimum[at]
  }
  return true
}

// The real file a program name leads to, followed ONCE: the name Claude Code is found by (~/.local/bin/claude) is a link into a folder of versions,
// and an update moves the link. Whatever is checked or proven has to be this file, and this same file has to be what starts, so the name is never
// looked up a second time. `follow` is realpath (a test hands in another). null when the answer is an error, empty, or not text.
export async function followToFile(path, follow) {
  try {
    const file = await follow(path)
    return typeof file === 'string' && file !== '' ? file : null
  } catch {
    return null
  }
}

// The version a program says it is, asked of THAT file, from an empty folder and with the small environment (so it reads no team repo and does not
// update itself). null when it does not answer or does not say. Used by the self-test and by the check before every run, so the two ask the same way.
export async function versionOfFile(file, { exec, emptyDir, env, platform }) {
  try {
    const answer = await exec(file, ['--version'], { cwd: emptyDir, env: claudeEnv(env, platform), timeout: 15_000 })
    return parseVersion(answer.stdout)
  } catch {
    return null
  }
}

/* ---------- the argument list and the environment ------------------------------------------------------------------ */

export function buildArgv({ prompt, model, codeDir, web }) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.startsWith('-')) throw new TypeError('claude: the prompt is text that does not start like a flag')
  if (!RUN_MODELS.includes(model)) throw new TypeError('claude: the model is opus or sonnet')
  if (typeof codeDir !== 'string' || !isAbsolute(codeDir)) throw new TypeError('claude: the code folder is a full path')
  if (typeof web !== 'boolean') throw new TypeError('claude: whether the web is wanted is true or false')
  return [
    '-p', prompt,
    '--model', model,
    '--restricted',
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--tools', toolsFor(web).join(','),
    '--allowedTools', ...allowedFor(web),
    '--disallowedTools', 'mcp__*',
    '--settings', join(codeDir, ...SETTINGS_FILE.split('/')),
    '--setting-sources', 'user',
    '--strict-mcp-config', '--mcp-config', join(codeDir, ...MCP_FILE.split('/')),
    '--disable-slash-commands',
    '--no-session-persistence',
    '--max-turns', String(MAX_TURNS),
    '--output-format', 'stream-json', '--verbose'
  ]
}

const ENV_BASE = ['HOME', 'PATH', 'USER', 'LANG', 'TMPDIR']
// What a program on Windows cannot start without. (Run once on a real Windows 11 computer on 2026-10-17: claude.exe answered --version and auth status with exactly these.)
const ENV_WINDOWS = ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP', 'Path']

// WHY: Claude Code "checks for updates on startup and periodically while running. Updates download and install in the background, then
// take effect the next time you start Claude Code" (https://code.claude.com/docs/en/setup#auto-updates). A version the self-test never
// saw would then start running between two runs. DISABLE_AUTOUPDATER=1 stops the background check and DISABLE_UPDATES=1 stops every
// update, a manual one included (https://code.claude.com/docs/en/env-vars). Both are set for every program the runner starts. They
// cannot stop an update made by a Claude Code the owner uses by hand, so the version is also asked just before each run (tick.mjs).
export const UPDATE_SWITCHES = Object.freeze({ DISABLE_AUTOUPDATER: '1', DISABLE_UPDATES: '1' })

// Windows only: a program asked for by a bare name is looked for in the current folder first. Claude is started from the work copy, which other
// people push to, so any program Claude Code (or git, or a tool it starts) names without a path must not be taken from there. This variable
// (NoDefaultCurrentDirectoryInExePath, the switch behind the Win32 call NeedCurrentDirectoryForExePath) stops that search at the current folder. Our own starts are all by absolute path; this covers what the program we start then starts.
export const WINDOWS_SWITCHES = Object.freeze({ NoDefaultCurrentDirectoryInExePath: '1' })

// The environment Claude is started with: these variables and the two switches above, and no others - no key, no token, none of this
// Mac's secrets, and nothing that changes where a program is loaded from or where it connects.
export function claudeEnv(env, platform = process.platform) {
  const wanted = platform === 'win32' ? [...ENV_BASE, ...ENV_WINDOWS] : ENV_BASE
  return { ...Object.fromEntries(wanted.filter((name) => typeof env?.[name] === 'string').map((name) => [name, env[name]])), ...UPDATE_SWITCHES, ...(platform === 'win32' ? WINDOWS_SWITCHES : {}) }
}

// Keys and addresses that would send a run to a different account, a different server or a per-token bill. The runner
// is not started with one of these set; the names are returned, never the values.
const UNSAFE_NAMES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']

export function unsafeEnv(env) {
  return UNSAFE_NAMES.filter((name) => typeof env?.[name] === 'string' && env[name] !== '')
}

/* ---------- stopping a program and everything it started ----------------------------------------------------------- */

// On a Mac or Linux the program is its own process group, so a signal to the group reaches everything it started; on
// Windows the whole tree is ended by the system's own taskkill.
export function killTree(pid, signal, { platform = process.platform, spawn, systemRoot = process.env.SystemRoot || 'C:\\Windows' } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (platform === 'win32') {
    try {
      // SystemRoot alone: with no env of its own taskkill would inherit the runner's whole environment, and the keys a computer may keep there.
      spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, env: { SystemRoot: systemRoot, NoDefaultCurrentDirectoryInExePath: '1' } }).on('error', () => {})
    } catch {
      // Nothing more can be done from here.
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone.
    }
  }
}

/* ---------- running it --------------------------------------------------------------------------------------------- */

const TOOL_NAME = /^[A-Za-z0-9_*-]{1,64}$/

// What Claude Code answers, itself, to a call of a tool it never offered: an error, and nothing runs. The model can write any tool name it
// likes - it is told to try a shell in the self-test, and a job's steps can make it reach for one - and this is the whole of the answer.
// Seen on real runs with the flags above (Windows 11, Claude Code 2.1.300, 2026-10-18; tests/fixtures/claude-unoffered-tool.jsonl and
// claude-refusals-2.1.300.json), in exactly two forms:
//   a tool Claude Code has and this run turned off (Bash, PowerShell, Agent, ToolSearch, WebFetch in a sweep, ...):
//     <tool_use_error>Error: No such tool available: Bash. Bash is disabled for this session, in subagents as well as here.</tool_use_error>
//   a name it does not know at all:
//     <tool_use_error>Error: No such tool available: FooBarTool</tool_use_error>
// The answer must be one of these, as the whole text, word for word, for the very name that was called. A tool that was there and ran, then
// failed, answers with an error too; so could a look-alike. Any other wording - an older or newer Claude Code's included - is not recognised,
// and the run fails safe. A connector tool (mcp__) is never forgiven, whatever the answer: its answer is written by a program the runner does
// not control, so a refusal from it proves nothing.
const refusalsFor = (name) => [
  `<tool_use_error>Error: No such tool available: ${name}. ${name} is disabled for this session, in subagents as well as here.</tool_use_error>`,
  `<tool_use_error>Error: No such tool available: ${name}</tool_use_error>`
]
const CONNECTOR_PREFIX = 'mcp__'

// Claude's output is one JSON message per line. Every one is read for two things: the tools it lists or calls, which
// must be the allowed ones, and the final result.
//   { ok: true, calls, denials, exitCode, transcriptBytes, attempted? }
//   { ok: false, why: 'claude-failed' | 'timed-out' | 'tool-refused', calls, denials, exitCode, transcriptBytes, tool?, how?, attempted? }
// The transcript - every byte it said - is written to `transcriptPath` for the owner alone.
//
// A tool outside the list is one of two things, and only the first is a wall that is not there:
//   OFFERED (how: 'offered')   the init - the tools Claude Code says, at start-up, that this run has - names it, or a connector, or cannot be
//                              read. The run is stopped at once, the whole process group, with no time to finish. Nothing later changes that.
//   ASKED FOR, never offered   Claude wrote a call to a tool the init did not name. Claude Code answers such a call itself (refusalsFor) and runs
//                              nothing. Answered so, it is counted in `attempted` and the run goes on: the wall held, and failing the job would
//                              be an alarm about a wall that held - an alarm the owner then learns to ignore. It stops the run as tool-refused when
//                              it is answered without an error (how: 'used'), with an error that is not one of the two refusals (how: 'unrecognised'),
//                              or not by the result or the end of the run (how: 'unanswered'). So does a call whose refusal cannot be read for it:
//                              before the init, with no id, in a subagent, or outside an assistant message (how: 'used'); and a connector tool, at
//                              the call (how: 'connector'). A real tool that ran would be seen at its answer, one message later than at the call;
//                              stopping at the call never stopped that first call either, since Claude Code starts it as it prints it.
export function runClaude({
  file, argv, cwd, env, timeoutMs, killAfterMs = KILL_AFTER_MS, closeWaitMs = CLOSE_WAIT_MS,
  transcriptPath, stderrPath, maxTranscriptBytes = TRANSCRIPT_MAX_BYTES,
  // The tools this run was started with (toolsFor): any other tool listed or called stops it.
  tools = TOOLS,
  // `live` (signals.mjs) is told which process is alive, so a signal that stops the runner can kill it.
  spawn, kill, platform = process.platform, openStream = createWriteStream, live = null,
  // Optional: told how far the run has got - { type: 'started' }, { type: 'tool', name } for each allowed tool call, { type: 'finishing' } - and NEVER given a word
  // Claude wrote or read (progress.mjs). It can throw or be slow; neither reaches the run.
  onEvent = null
}) {
  const allowedNames = new Set([...tools, ...TOLERATED])
  const stop = kill ?? ((pid, signal) => killTree(pid, signal, { platform, spawn }))
  return new Promise((resolve) => {
    // The runner was told to stop (a signal) between its last look and here: Claude is not started at all. Anything started in that gap would be
    // missed by the handler's kill loop and run on with no time limit (signals.mjs).
    if (live?.stopping) {
      resolve({ ok: false, why: 'claude-failed', calls: {}, denials: 0, exitCode: null, transcriptBytes: 0 })
      return
    }
    const calls = new Map()
    let transcriptBytes = 0
    let reason = null
    let tool = null
    let how = null
    let initSeen = false
    // Calls of tools the init did not name, waiting for Claude Code's answer: { id, name }, in the order they were made.
    const asked = []
    const attempted = new Map()
    let resultMessage = null
    let exitCode = null
    let settled = false
    let child = null
    let pending = ''
    let stderrBytes = 0
    let stderrFile = null
    let killTimer = null
    let closeTimer = null
    const decoder = new StringDecoder('utf8')
    const transcript = openStream(transcriptPath, { flags: 'w', mode: 0o600 })
    transcript.on('error', () => hardStop('claude-failed'))

    // On Windows a process number is given to the next program that starts once the first has ended, and taskkill takes a number: after the program has
    // exited (its 'exit' event) nothing more is sent to it. (A process group, on a Mac, has no such trouble.)
    let exited = false
    const stopTree = (signal) => {
      if (!child?.pid || (platform === 'win32' && exited)) return
      stop(child.pid, signal)
    }

    const answer = () => {
      const base = { calls: Object.fromEntries(calls), denials: Array.isArray(resultMessage?.permission_denials) ? resultMessage.permission_denials.length : 0, exitCode, transcriptBytes, ...(attempted.size ? { attempted: Object.fromEntries(attempted) } : {}) }
      if (reason === null && exitCode === 0 && resultMessage?.type === 'result' && resultMessage.is_error === false && resultMessage.subtype === 'success') return { ok: true, ...base }
      return { ok: false, why: reason ?? 'claude-failed', ...base, ...(tool !== null ? { tool, how } : {}) }
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
      // The run ended with a call to a tool it was never offered still unanswered: nobody saw it refused.
      if (reason === null && asked.length) {
        reason = 'tool-refused'
        tool = asked[0].name
        how = 'unanswered'
      }
      stderrFile?.end()
      transcript.end(() => resolve(answer()))
    }

    // Stop the program now, whole group, and give it a short time to close; whatever it says meanwhile is only kept.
    function hardStop(why) {
      reason ??= why
      stopTree('SIGKILL')
      closeTimer ??= setTimeout(() => finalize(null), closeWaitMs)
    }

    const refuseTool = (name, kind) => {
      tool = typeof name === 'string' && TOOL_NAME.test(name) ? name : 'unknown'
      how = kind
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

    const audit = (event, block) => {
      const { name } = block
      if (allowedNames.has(name)) {
        calls.set(name, (calls.get(name) ?? 0) + 1)
        report({ type: 'tool', name })
        return undefined
      }
      if (typeof name === 'string' && name.startsWith(CONNECTOR_PREFIX)) return refuseTool(name, 'connector')
      const answerable = initSeen && event.type === 'assistant' && (event.parent_tool_use_id ?? null) === null &&
        typeof block.id === 'string' && block.id !== '' && typeof name === 'string' && TOOL_NAME.test(name)
      if (!answerable) return refuseTool(name, 'used')
      asked.push({ id: block.id, name })
      return undefined
    }

    const answered = (block) => {
      const at = asked.findIndex((call) => call.id === block.tool_use_id)
      if (at === -1) return undefined
      const [{ name }] = asked.splice(at, 1)
      if (block.is_error !== true) return refuseTool(name, 'used')
      if (typeof block.content === 'string' && refusalsFor(name).includes(block.content)) {
        attempted.set(name, (attempted.get(name) ?? 0) + 1)
        return undefined
      }
      return refuseTool(name, 'unrecognised')
    }

    function read(text) {
      let event
      try {
        event = JSON.parse(text)
      } catch {
        return
      }
      if (reason === 'tool-refused') return
      if (event?.type === 'system' && event.subtype === 'init') {
        if (!Array.isArray(event.tools)) return refuseTool('unknown', 'offered')
        for (const name of event.tools) {
          if (!allowedNames.has(name)) return refuseTool(name, 'offered')
        }
        if (Array.isArray(event.mcp_servers) && event.mcp_servers.length) return refuseTool('mcp', 'offered')
        initSeen = true
        report({ type: 'started' })
      } else if (Array.isArray(event?.message?.content)) {
        for (const block of event.message.content) {
          if (block?.type === 'tool_use') audit(event, block)
          else if (block?.type === 'tool_result') answered(block)
          if (reason === 'tool-refused') return
        }
      } else if (event?.type === 'result') {
        resultMessage = event
        if (asked.length) return refuseTool(asked[0].name, 'unanswered')
        report({ type: 'finishing' })
      }
    }

    let timer = null
    try {
      child = spawn(file, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: platform !== 'win32', windowsHide: true, shell: false })
    } catch {
      finalize(null)
      return
    }
    if (child.pid) live?.children.add(child.pid)
    // A signal that came while it was being started: the kill loop has already run, so this one is killed here and now.
    if (live?.stopping) hardStop('claude-failed')
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
      if (transcriptBytes > maxTranscriptBytes) hardStop('claude-failed')
      pending += decoder.write(chunk)
      const lines = pending.split('\n')
      pending = lines.pop()
      for (const text of lines) read(text)
      if (pending.length > LINE_MAX_CHARS) {
        pending = ''
        hardStop('claude-failed')
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

/* ---------- the daily check ---------------------------------------------------------------------------------------- */

const escapeText = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Whether a git address is the team repo on GitHub, written any of the usual ways. Anything else - another host, a
// look-alike host, another repo, a repo with something after its name, a path on this computer - is not. Nor is an https
// address with a user name, a password or a token in it (addressHasLogin): git would put it on a command line.
export function originMatches(url, repo) {
  if (typeof url !== 'string' || typeof repo !== 'string' || !REPO_SHAPE.test(repo)) return false
  const [owner, name] = repo.split('/')
  const address = new RegExp(`^(?:https://github\\.com/|git@github\\.com:|ssh://git@github\\.com/)${escapeText(owner)}/${escapeText(name)}(?:\\.git)?/?$`, 'i')
  return address.test(url)
}

// The checks made once a day before any order is done. Every problem is named in a word and all of them are returned.
//   find(name)        { state: 'found', path } | { state: 'not found' | 'refused' }
//   exec(file, args, options)   a program run by absolute path: { stdout } or a rejection
//   origin()          the work copy's origin as its config file says it: { fetch, push } (workcopy.mjs, readOrigin) or null.
//                     Read as text, never by running git in a folder whose settings are not yet trusted
//   originAccepted(url)   whether an address is the team repo
//   emptyDir, env, platform
// Claude is asked its version and its login from an empty folder, with the small environment, so it reads no team repo.
// The two checks that cost nothing and can change from one tick to the next, so they are made on every tick and never
// remembered: a key in the environment, and where the work copy's origin points (pushes can go somewhere else than
// fetches do, so both addresses must be the team repo).
const keyProblems = (env) => (unsafeEnv(env).length ? ['key-in-environment'] : [])

async function originProblems({ origin, originAccepted }) {
  let addresses = null
  try {
    addresses = await origin()
  } catch {
    addresses = null
  }
  // A login in either address is named on its own, whatever else accepts the address: it has a fix of its own (a plain address and git's sign-in helper).
  if (addresses && (addressHasLogin(addresses.fetch) || addressHasLogin(addresses.push))) return ['origin-has-login']
  return !addresses || !originAccepted(addresses.fetch) || !originAccepted(addresses.push) ? ['origin-mismatch'] : []
}

export async function localProblems({ env, origin, originAccepted }) {
  return [...keyProblems(env), ...(await originProblems({ origin, originAccepted }))]
}

export async function preflight({ find, exec, origin, originAccepted, emptyDir, env, platform }) {
  const problems = [...keyProblems(env)]
  let version = null
  const found = await find('claude')
  if (found.state !== 'found') {
    problems.push('claude-missing')
  } else {
    const run = (args) => exec(found.path, args, { cwd: emptyDir, env: claudeEnv(env, platform), timeout: 15_000 })
    try {
      version = parseVersion((await run(['--version'])).stdout)
    } catch {
      version = null
    }
    if (version === null) problems.push('version-unknown')
    else if (!atLeast(version, MINIMUM_VERSION)) problems.push('version-too-old')
    try {
      const status = JSON.parse((await run(['auth', 'status'])).stdout)
      if (status?.authMethod !== 'claude.ai') problems.push('wrong-login')
    } catch {
      problems.push('not-logged-in')
    }
  }
  problems.push(...(await originProblems({ origin, originAccepted })))
  return { ok: problems.length === 0, version, problems }
}
