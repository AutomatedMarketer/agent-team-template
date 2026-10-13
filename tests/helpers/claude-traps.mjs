// What a Claude that did not have the runner's protections would do with the traps the self-test plants. A trap is a command in a file
// of a booby-trapped team repo; it writes a file with its own name if it ever runs. This runs the planted commands for real - not a
// stand-in - under the rules Claude Code documents, so a test can see that a trap really does fire when its protection is missing, and
// that none fires with all of them in place.
//
//   hooks and the key helper in the repo's .claude/settings.json   run unless --setting-sources leaves the repo's settings out (hooks also
//                                                                  stop with disableAllHooks in the settings file that is passed)
//   a skill's hook, and the shell in its text (!`cmd`)             run unless --disable-slash-commands (the shell also stops with
//                                                                  disableSkillShellExecution, the hook with disableAllHooks)
//   a server in .mcp.json                                          starts unless --strict-mcp-config limits servers to the list passed
//                                                                  (a project server also needs enableAllProjectMcpServers)
//   a shell command                                                runs only if the Bash tool is among the tools
//
// https://code.claude.com/docs/en/cli-reference, /settings-reference, /hooks, /skills, /mcp
import { readFileSync } from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import { join } from 'node:path'
import { configFromArgs, lenientRead } from './claude-permissions.mjs'

// The arguments with some flags taken away, each with its value if it has one (a value is what follows and does not start with --).
export function withoutFlags(args, names) {
  const kept = []
  for (let at = 0; at < args.length; at += 1) {
    if (names.includes(args[at])) {
      while (at + 1 < args.length && !args[at + 1].startsWith('--')) at += 1
    } else {
      kept.push(args[at])
    }
  }
  return kept
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

// `weaken`: { dropFlags: [flags the run was started without], settings: { overrides of the settings file passed }, addTools: [tools it also has] }.
export function fireTraps(cwd, args, weaken = {}) {
  const started = withoutFlags(args, weaken.dropFlags ?? [])
  const valueOf = (flag) => started[started.indexOf(flag) + 1]
  const settings = { ...(started.includes('--settings') ? configFromArgs(started, { read: lenientRead }).settings : {}), ...(weaken.settings ?? {}) }
  const sources = started.includes('--setting-sources') ? valueOf('--setting-sources').split(',') : ['user', 'project', 'local']
  const repoSettingsLoaded = sources.includes('project') || sources.includes('local')
  const hooksOn = repoSettingsLoaded && settings.disableAllHooks !== true
  const skillsOn = !started.includes('--disable-slash-commands')
  const strict = started.includes('--strict-mcp-config')
  const listed = started.includes('--mcp-config') ? readJson(valueOf('--mcp-config'))?.mcpServers ?? {} : {}
  const tools = [...(started.includes('--tools') ? valueOf('--tools').split(',') : []), ...(weaken.addTools ?? [])]

  const commands = []
  const project = readJson(join(cwd, '.claude', 'settings.json'))
  if (project !== null && hooksOn) {
    for (const groups of Object.values(project.hooks ?? {})) for (const group of groups) for (const hook of group.hooks ?? []) commands.push(hook.command)
  }
  if (project !== null && repoSettingsLoaded && typeof project.apiKeyHelper === 'string') commands.push(project.apiKeyHelper)
  let skill = null
  try {
    skill = readFileSync(join(cwd, '.claude', 'skills', 'evil', 'SKILL.md'), 'utf8')
  } catch {
    skill = null
  }
  if (skill !== null && skillsOn) {
    if (settings.disableAllHooks !== true) for (const found of skill.matchAll(/^\s+command: (.+)$/gm)) commands.push(found[1])
    if (settings.disableSkillShellExecution !== true) for (const found of skill.matchAll(/^!`(.+)`$/gm)) commands.push(found[1])
  }
  for (const command of commands) execSync(command, { cwd, stdio: 'ignore' })

  const servers = readJson(join(cwd, '.mcp.json'))?.mcpServers ?? {}
  const startable = strict ? listed : { ...servers, ...listed }
  const projectServersOn = !strict && settings.enableAllProjectMcpServers === true
  for (const [name, server] of Object.entries(startable)) {
    if (name in servers && !(name in listed) && !projectServersOn) continue
    execFileSync(server.command, server.args ?? [], { cwd, stdio: 'ignore' })
  }
  if (tools.includes('Bash')) execSync('node -e "require(\'fs\').writeFileSync(\'SHELL-RAN\',\'ran\')"', { cwd, stdio: 'ignore' })
}
