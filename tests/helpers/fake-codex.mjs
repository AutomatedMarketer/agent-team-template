// A fake Codex for the tests: a sandbox that behaves as the runner's profile says (read and write inside the folder it is started in,
// .git read-only, nothing outside, no network), a login, a version, what it would be told, and a run that tries what the self-test asks.
// Options make it misbehave on purpose, so a test sees the self-test catch it:
//   version, login ('chatgpt' | 'apiKey' | 'none'), noSandbox (the probe fails)
//   leak        walls (CODEX_WALLS keys, or 'network') the SANDBOX lets through in part 1
//   tells       'agents' | 'skill': what Codex would be told includes the repo's AGENTS.md or skill (part 2)
//   run         { leak: [...walls], skip: [...walls or 'network'], item: 'mcp_tool_call', trap: 'AGENTS-RAN', fail: true, trust: true }: the real run
//               (trust: Codex writes a trusted entry into its home during the run)
//   leak may also hold 'links' (a link made inside reads as the secret) and 'noNetControl' (the network program does not start)
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, relative, isAbsolute, join, resolve } from 'node:path'

const inside = (root, path) => {
  const rel = relative(resolve(root), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
const inGit = (root, path) => relative(resolve(root), resolve(path)).split(/[\\/]/)[0] === '.git'

// What the sandbox does with one plain command (probeCommands' shapes, either system). -> { stdout, code }
// Which wall a planted file is, by the name the self-test gives it (plantCodexWalls).
const WALL_NAMES = [
  [/^\.mailbox-codex-selftest-[0-9a-f]+\.txt$/, 'homeRead'],
  [/^mailbox-codex-selftest-[0-9a-f]+-read\.txt$/, 'tmpRead'],
  [/^secret-[0-9a-f]+\.txt$/, 'outsideRead'],
  [/^selftest-canary-[0-9a-f]+\.txt$/, 'codexHomeRead'],
  [/^mailbox-codex-selftest-[0-9a-f]+-write\.txt$/, 'tmpWrite'],
  [/^written-[0-9a-f]+\.txt$/, 'outsideWrite'],
  [/^git-canary-[0-9a-f]+$/, 'gitWrite']
]
export const wallOf = (path) => WALL_NAMES.find(([shape]) => shape.test(String(path).split(/[\\/]/).at(-1)))?.[1]

async function sandboxed(command, cwd, { leak = [] } = {}) {
  const program = command[0].split(/[\\/]/).at(-1).toLowerCase()
  if (program === 'echo' || (program === 'cmd.exe' && command[3] === 'echo SANDBOX_OK')) return { stdout: 'SANDBOX_OK\n', code: 0 }
  // The program the network is tried with must first be shown to start (probeCommands' control); then the attempt.
  if ((program === 'sh' && String(command[2]).includes('--version')) || (program === 'powershell.exe' && String(command.at(-1)).startsWith('Write-Output'))) {
    return leak.includes('noNetControl') ? { stdout: '', code: 1 } : { stdout: 'NET_CONTROL_OK\n', code: 0 }
  }
  if (program === 'powershell.exe') {
    const url = /'(http[^']+)'/.exec(command.at(-1))?.[1]
    if (leak.includes('network') && url) {
      await fetch(url).catch(() => {})
      return { stdout: 'REACHED', code: 0 }
    }
    return { stdout: 'BLOCKED\n', code: 0 }
  }
  // A link to a file outside: refused, as the sandbox does - unless the test lets it through (then the link reads as the secret).
  if (program === 'ln' || (program === 'cmd.exe' && command[3] === 'mklink')) {
    const [target, path] = program === 'ln' ? command.slice(-2) : [command.at(-1), command.at(-2)]
    if (!leak.includes('links')) return { stdout: 'Access is denied.\n', code: 1 }
    await writeFile(path, await readFile(target, 'utf8'))
    return { stdout: '', code: 0 }
  }
  if (program === 'curl' || program === 'curl.exe') {
    if (leak.includes('network')) {
      await fetch(command.at(-1)).catch(() => {})
      return { stdout: 'REACHED', code: 0 }
    }
    return { stdout: '', code: 7 }
  }
  const reading = program === 'cat' || (program === 'cmd.exe' && command[3] === 'type')
  const path = command.at(-1)
  // A link is followed to where it leads, as the sandbox checks it: a link inside that leads outside is outside.
  const real = await realpath(path).catch(() => path)
  const allowed = leak.includes(wallOf(path)) || (inside(cwd, path) && inside(cwd, real) && !(inGit(cwd, path) && !reading))
  if (!allowed) return { stdout: 'Access is denied.\n', code: 1 }
  if (reading) {
    try {
      return { stdout: await readFile(path, 'utf8'), code: 0 }
    } catch {
      return { stdout: '', code: 1 }
    }
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, 'done\n')
  return { stdout: '', code: 0 }
}

const LOGINS = { chatgpt: { code: 0, stderr: 'Logged in using ChatGPT\n' }, apiKey: { code: 0, stderr: 'Logged in using an API key - sk-***\n' }, none: { code: 1, stderr: 'Not logged in\n' } }

export function fakeCodex({ version = 'codex-cli 0.160.0', login = 'chatgpt', noSandbox = false, leak = [], tells = null, run = {} } = {}) {
  const state = { calls: [], runs: [] }
  const exec = async (file, args, options = {}) => {
    state.calls.push({ file, args, options })
    if (args[0] === '--version') return { stdout: `${version}\n`, code: 0 }
    if (args[0] === 'login') return { stdout: '', ...LOGINS[login] }
    if (args[0] === 'sandbox') {
      const command = args.slice(args.indexOf('--') + 1)
      if (noSandbox) return { stdout: 'windows sandbox failed: Restricted read-only access requires the elevated Windows sandbox backend\n', code: 1 }
      return sandboxed(command, args[args.indexOf('-C') + 1], { leak })
    }
    if (args[0] === 'debug' && args[1] === 'prompt-input') {
      const parts = [`{"role":"user","text":"${args[2]}"}`]
      if (tells === 'agents') parts.push(await readFile(join(options.cwd, 'AGENTS.md'), 'utf8'))
      if (tells === 'skill') parts.push(await readFile(join(options.cwd, '.agents', 'skills', 'evil', 'SKILL.md'), 'utf8'))
      return { stdout: JSON.stringify(parts), code: 0 }
    }
    throw new Error('an unexpected program')
  }

  // The run: it reads the numbered steps from the prompt and tries each with a command naming the path, through the same sandbox.
  const spawn = (file, args, options) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 6161
    state.runs.push({ file, args, options })
    const prompt = args.at(-1)
    setImmediate(async () => {
      const out = (event) => child.stdout.write(`${JSON.stringify(event)}\n`)
      out({ type: 'thread.started', thread_id: 't' })
      out({ type: 'turn.started' })
      const step = (n) => new RegExp(`^${n}\\. [^\`\\n]*\`([^\`]+)\``, 'm').exec(prompt)?.[1]
      const keyOf = { 2: 'homeRead', 3: 'tmpRead', 4: 'outsideRead', 5: 'codexHomeRead', 6: 'tmpWrite', 7: 'outsideWrite', 8: 'gitWrite', 9: 'insideRead', 10: 'insideWrite' }
      let at = 0
      const command = async (text, answer) => {
        at += 1
        out({ type: 'item.started', item: { id: `item_${at}`, type: 'command_execution', command: text, aggregated_output: '', exit_code: null, status: 'in_progress' } })
        out({ type: 'item.completed', item: { id: `item_${at}`, type: 'command_execution', command: text, aggregated_output: answer.stdout, exit_code: answer.code, status: answer.code === 0 ? 'completed' : 'failed' } })
      }
      const url = /`curl -s -m 5 (\S+)`/.exec(prompt)?.[1]
      if (url && !(run.skip ?? []).includes('network')) await command(`curl -s -m 5 ${url}`, await sandboxed(['curl', '-s', '-m', '5', url], options.cwd, { leak: run.leak ?? [] }))
      for (let n = 2; n <= 10; n += 1) {
        const path = step(n)
        const key = keyOf[n]
        if (!path || (run.skip ?? []).includes(key)) continue
        const reading = key.endsWith('Read')
        const runLeak = (run.leak ?? []).includes(key) ? [key] : []
        const answer = await sandboxed(reading ? ['cat', path] : ['sh', '-c', 'echo done > "$1"', 'sh', path], options.cwd, { leak: runLeak })
        await command(reading ? `cat ${path}` : `sh -c 'echo done > ${path}'`, answer)
      }
      if (run.trap) await writeFile(join(options.cwd, run.trap), 'ran')
      if (run.trust) await writeFile(join(options.env.CODEX_HOME, 'config.toml'), `${await readFile(join(options.env.CODEX_HOME, 'config.toml'), 'utf8')}
[projects.'x']
trust_level = "trusted"
`)
      if (run.item) out({ type: 'item.started', item: { id: 'item_x', type: run.item, server: 'evil', tool: 'evil' } })
      out({ type: 'item.completed', item: { id: 'item_end', type: 'agent_message', text: 'Done.' } })
      if (!run.item) out(run.fail ? { type: 'turn.failed', error: { message: 'boom' } } : { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } })
      if (run.item) return
      child.stdout.end()
      child.stderr.end()
      child.emit('exit', 0)
      child.emit('close', 0)
    })
    child.kill = () => true
    spawn.last = child
    return child
  }
  // Like a real kill: the program ends a moment later, never inside the call.
  const kill = () => {
    const child = spawn.last
    if (!child || child.killed) return
    child.killed = true
    setImmediate(() => {
      child.stdout.end()
      child.stderr.end()
      child.emit('exit', null)
      child.emit('close', null)
    })
  }
  return { exec, spawn, kill, state }
}
