// The connections part: which tools, servers and plugins this computer has - by name only.
//
// Claude Code's and Codex's files hold far more than names: addresses with keys in them, commands
// with tokens in their arguments, environment settings, headers, project folders. From each
// server entry this keeps the NAME, where it came from (scope), and whether it runs as a local
// program or a web service - and that last answer comes from which keys the entry has, never
// from what is in them. Every name is held to the connection-name rule before it is kept; a name
// that fails is dropped and counted in `hidden`. Nothing else read here leaves this module.
//
// Claude Code (CLAUDE_CONFIG_DIR honoured):
//   ~/.claude.json            mcpServers (your servers), projects[*].mcpServers (counted only),
//                             claudeAiMcpEverConnected (claude.ai connectors seen on this computer)
//   ~/.claude/settings.json   enabledPlugins -> plugins/installed_plugins.json (where each is)
//                             -> the plugin's .mcp.json or plugin.json mcpServers
//   ~/.claude/mcp-needs-auth-cache.json   which servers last asked to be signed in
// Codex (CODEX_HOME honoured):
//   ~/.codex/config.toml      [mcp_servers.<name>] and [plugins."<name>@<from>"] table headers,
//                             and the `enabled` line under each. No other line is looked at.

import { readFile } from 'node:fs/promises'
import { join, isAbsolute, resolve } from 'node:path'
import { CONNECTIONS_SCHEMA, CAPS, SERVER_SCOPES } from './connections-schema.mjs'
import { isConnectionName } from './safe.mjs'
import { isoSeconds, isPlainObject, readJson } from './util.mjs'
import { claudeConfigDir, claudeStatePath } from './claude-limits.mjs'
import { codexHomeDir } from './codex-limits.mjs'
import { isInsideFolder } from './commit.mjs'
import { liveCheck } from './claude-live.mjs'
import { collectTools } from './tools.mjs'

const UNREADABLE = { status: 'unavailable', why: 'could not be read' }
const SCOPE_ORDER = Object.keys(SERVER_SCOPES)

// --- names: the rule, the cap, the order -------------------------------------------------------------

// Keeps the entries whose names pass the rule, each name once, sorted, up to the cap. Returns the
// kept entries and how many were dropped (hidden) or cut (more).
function keepNames(entries, identity, cap, keyOf = (entry) => entry.name, order = () => 0) {
  let hidden = 0
  const seen = new Set()
  const kept = []
  for (const entry of entries) {
    const names = entry.from === undefined ? [entry.name] : [entry.name, entry.from]
    if (!names.every((name) => typeof name === 'string' && isConnectionName(name, identity))) {
      hidden += 1
      continue
    }
    const key = keyOf(entry)
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(entry)
  }
  // Plain code-point order, so the same computer always writes the same file and an unchanged
  // reading commits nothing.
  kept.sort((a, b) => order(a) - order(b) || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))
  return { kept: kept.slice(0, cap), hidden, more: Math.max(0, kept.length - cap) }
}

// --- Claude Code ------------------------------------------------------------------------------------

const WEB_TYPES = new Set(['http', 'sse', 'ws', 'streamable-http', 'streamable_http'])

// Local program or web service, from the entry's type, or else from which keys it has. The values
// are never looked at: a url or command is exactly what must not be read.
export function transportOf(entry) {
  if (!isPlainObject(entry)) return 'unknown'
  if (typeof entry.type === 'string') {
    if (entry.type === 'stdio') return 'local'
    if (WEB_TYPES.has(entry.type)) return 'web'
    return 'unknown'
  }
  if (Object.hasOwn(entry, 'command')) return 'local'
  if (Object.hasOwn(entry, 'url')) return 'web'
  return 'unknown'
}

const serversIn = (map) => (isPlainObject(map) ? Object.entries(map) : [])

// A plugin's servers are either in <plugin>/.mcp.json (wrapped in mcpServers, or bare), or in
// <plugin>/.claude-plugin/plugin.json under mcpServers - inline, or as a path to a file inside the
// plugin's own folder. A path that leaves the folder is not followed.
async function pluginServers(installPath) {
  if (typeof installPath !== 'string' || !isAbsolute(installPath)) return []
  const unwrap = (doc) => (isPlainObject(doc?.mcpServers) ? doc.mcpServers : doc)
  const found = []
  const mcp = await readJson(join(installPath, '.mcp.json'))
  if (mcp.state === 'ok') found.push(...serversIn(unwrap(mcp.value)))
  const manifest = await readJson(join(installPath, '.claude-plugin', 'plugin.json'))
  const declared = manifest.state === 'ok' && isPlainObject(manifest.value) ? manifest.value.mcpServers : undefined
  if (isPlainObject(declared)) found.push(...serversIn(declared))
  if (typeof declared === 'string' && !isAbsolute(declared)) {
    const target = resolve(installPath, declared)
    if (await isInsideFolder(target, installPath)) {
      const pointed = await readJson(target)
      if (pointed.state === 'ok') found.push(...serversIn(unwrap(pointed.value)))
    }
  }
  return found
}

// enabledPlugins says which are on; installed_plugins.json says where each is. Only plugins
// installed for the whole user are named - a plugin installed for one project belongs to it.
async function pluginServerEntries(deps) {
  const dir = claudeConfigDir(deps)
  const settings = await readJson(join(dir, 'settings.json'))
  const installed = await readJson(join(dir, 'plugins', 'installed_plugins.json'))
  const enabled = settings.state === 'ok' && isPlainObject(settings.value?.enabledPlugins) ? settings.value.enabledPlugins : {}
  const plugins = installed.state === 'ok' && isPlainObject(installed.value?.plugins) ? installed.value.plugins : {}
  const entries = []
  for (const [key, on] of Object.entries(enabled)) {
    if (on !== true || !Array.isArray(plugins[key])) continue
    const install = plugins[key].find((item) => isPlainObject(item) && item.scope === 'user' && item.projectPath === undefined)
    if (!install) continue
    const plugin = key.split('@')[0]
    for (const [server, entry] of await pluginServers(install.installPath)) {
      entries.push({ name: `plugin:${plugin}:${server}`, scope: 'plugin', transport: transportOf(entry) })
    }
  }
  return entries
}

async function needsSignIn(deps) {
  const cache = await readJson(join(claudeConfigDir(deps), 'mcp-needs-auth-cache.json'))
  return new Set(cache.state === 'ok' && isPlainObject(cache.value) ? Object.keys(cache.value) : [])
}

// Every server the files name, before the name rule: { status: 'found', entries, projectServers },
// or a not found / unavailable block.
async function claudeEntriesFromFiles(deps) {
  const state = await readJson(claudeStatePath(deps))
  if (state.state === 'broken') return { ...UNREADABLE }
  const settings = await readJson(join(claudeConfigDir(deps), 'settings.json'))
  if (state.state === 'missing' && settings.state === 'missing') return { status: 'not found' }
  const doc = state.state === 'ok' && isPlainObject(state.value) ? state.value : {}

  const signIn = await needsSignIn(deps)
  const fileState = (name, otherwise) => (signIn.has(name) ? 'needs sign-in' : otherwise)
  const entries = [
    ...serversIn(doc.mcpServers).map(([name, entry]) => ({ name, scope: 'user', transport: transportOf(entry) })),
    ...(await pluginServerEntries(deps)),
    ...(Array.isArray(doc.claudeAiMcpEverConnected) ? doc.claudeAiMcpEverConnected : [])
      .filter((name) => typeof name === 'string')
      .map((name) => ({ name, scope: 'claude.ai', transport: 'web' }))
  ].map((entry) => ({ ...entry, state: fileState(entry.name, entry.scope === 'claude.ai' ? 'seen before' : 'not checked') }))

  let projectServers = 0
  for (const project of isPlainObject(doc.projects) ? Object.values(doc.projects) : []) {
    if (isPlainObject(project?.mcpServers)) projectServers += Object.keys(project.mcpServers).length
  }

  return { status: 'found', entries, projectServers }
}

// The live list's state wins for every server the files named. A server only the live list has
// is added when its name says where it comes from - "plugin:" or "claude.ai " - and otherwise
// counted, not named: from the empty folder it could still be a project's own server, and those
// are counted, never named (decision D2).
export function mergeLive(entries, rows) {
  const merged = entries.map((entry) => ({ ...entry }))
  const byName = new Map()
  for (const entry of merged) if (!byName.has(entry.name)) byName.set(entry.name, entry)
  let unnamed = 0
  for (const row of rows) {
    const known = byName.get(row.name)
    if (known) {
      known.state = row.state
      continue
    }
    let added = null
    if (row.name.startsWith('plugin:')) added = { name: row.name, scope: 'plugin', transport: 'unknown', state: row.state }
    else if (row.name.startsWith('claude.ai ')) added = { name: row.name, scope: 'claude.ai', transport: 'web', state: row.state }
    if (!added) {
      unnamed += 1
      continue
    }
    merged.push(added)
    byName.set(added.name, added)
  }
  return { entries: merged, unnamed }
}

function claudeBlock(entries, projectServers, identity, extraHidden = 0) {
  const { kept, hidden, more } = keepNames(entries, identity, CAPS.claudeServers, (entry) => entry.name, (entry) => SCOPE_ORDER.indexOf(entry.scope))
  return {
    servers: kept.map(({ name, scope, transport, state }) => ({ name, scope, transport, state })),
    projectServers,
    hidden: hidden + extraHidden,
    more
  }
}

// The file list alone, as a found block without `live`, or a not found / unavailable block.
export async function claudeServersFromFiles(deps) {
  const files = await claudeEntriesFromFiles(deps)
  if (files.status !== 'found') return files
  return { status: 'found', ...claudeBlock(files.entries, files.projectServers, deps.identity) }
}

// The file list, then the live check merged in. Nothing is started when the files are not there.
async function claudeServers(deps) {
  const files = await claudeEntriesFromFiles(deps)
  if (files.status !== 'found') return files
  const live = await (deps.sources?.claudeLive ?? liveCheck)(deps)
  if (live.live !== 'checked') return { status: 'found', live: live.live, ...claudeBlock(files.entries, files.projectServers, deps.identity) }
  const { entries, unnamed } = mergeLive(files.entries, live.rows)
  return { status: 'found', live: 'checked', ...claudeBlock(entries, files.projectServers, deps.identity, unnamed) }
}

// --- Codex ----------------------------------------------------------------------------------------------

// One key segment of a TOML table header: bare, "basic" (no escapes - an escaped name is skipped)
// or 'literal'. Returns [segment, rest] or null.
function keySegment(text) {
  const bare = /^[A-Za-z0-9_-]+/.exec(text)
  if (bare) return [bare[0], text.slice(bare[0].length)]
  const quote = text[0]
  if (quote !== '"' && quote !== "'") return null
  const end = text.indexOf(quote, 1)
  if (end < 0) return null
  const inside = text.slice(1, end)
  if (quote === '"' && inside.includes('\\')) return null
  return [inside, text.slice(end + 1)]
}

// A table header line "[a.b."c"]" as its key segments, or null for anything else - an array of
// tables ([[x]]), a key line, or a header that does not parse.
function headerSegments(line) {
  let rest = line.trim()
  if (!rest.startsWith('[') || rest.startsWith('[[')) return null
  rest = rest.slice(1).trimStart()
  const segments = []
  for (;;) {
    const parsed = keySegment(rest)
    if (!parsed) return null
    segments.push(parsed[0])
    rest = parsed[1].trimStart()
    if (rest.startsWith('.')) {
      rest = rest.slice(1).trimStart()
      continue
    }
    if (!rest.startsWith(']')) return null
    rest = rest.slice(1).trim()
    return rest === '' || rest.startsWith('#') ? segments : null
  }
}

const ENABLED_LINE = /^\s*enabled\s*=\s*(true|false)\s*(#.*)?$/

// Reads config.toml as lines and keeps only the [mcp_servers.<name>] and [plugins.<key>] headers
// and the `enabled` line inside each. Lines inside a multi-line string are skipped, so text in a
// hook's command can never pass for a header. Every other line is never looked at.
export function codexTables(text) {
  const servers = []
  const plugins = []
  let current = null
  let openString = null
  for (const line of String(text).split(/\r?\n/)) {
    if (openString) {
      if (line.includes(openString)) openString = null
      continue
    }
    for (const delimiter of ['"""', "'''"]) {
      if (line.split(delimiter).length % 2 === 0) openString = delimiter
    }
    if (openString) {
      current = null
      continue
    }
    const segments = headerSegments(line)
    if (segments) {
      current = null
      if (segments.length === 2 && segments[0] === 'mcp_servers') servers.push((current = { name: segments[1] }))
      if (segments.length === 2 && segments[0] === 'plugins') plugins.push((current = { key: segments[1] }))
      continue
    }
    if (current && current.enabled === undefined) {
      const enabled = ENABLED_LINE.exec(line)
      if (enabled) current.enabled = enabled[1] === 'true'
    }
  }
  return { servers, plugins }
}

export async function codexFromConfig(deps) {
  let text
  try {
    text = await readFile(join(codexHomeDir(deps), 'config.toml'), 'utf8')
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? { status: 'not found' } : { ...UNREADABLE }
  }
  const tables = codexTables(text)
  const withEnabled = (entry, enabled) => (enabled === undefined ? entry : { ...entry, enabled })
  const servers = keepNames(tables.servers.map(({ name, enabled }) => withEnabled({ name }, enabled)), deps.identity, CAPS.codexServers)
  // A plugin key is "<name>@<from>"; anything else cannot be split into the two, and is hidden.
  let malformed = 0
  const pluginEntries = []
  for (const { key, enabled } of tables.plugins) {
    const parts = key.split('@')
    if (parts.length !== 2) malformed += 1
    else pluginEntries.push(withEnabled({ name: parts[0], from: parts[1] }, enabled))
  }
  const plugins = keepNames(pluginEntries, deps.identity, CAPS.codexPlugins, (entry) => `${entry.name}@${entry.from}`)
  return {
    status: 'found',
    servers: servers.kept,
    plugins: plugins.kept,
    hidden: servers.hidden + plugins.hidden + malformed,
    more: servers.more + plugins.more
  }
}

// --- the part ---------------------------------------------------------------------------------------------

async function safely(read, deps) {
  try {
    return await read(deps)
  } catch {
    return { ...UNREADABLE }
  }
}

export async function collectConnections(deps, computer) {
  const [claude, codex] = await Promise.all([safely(claudeServers, deps), safely(codexFromConfig, deps)])
  // After the live check, never beside it: every program run empties the folder the next one
  // runs in, so programs run one at a time.
  const tools = await collectTools(deps)
  return {
    schema: CONNECTIONS_SCHEMA,
    takenAt: isoSeconds(deps.now),
    computer,
    tools,
    claude,
    codex
  }
}
