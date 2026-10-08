// Builds pretend Hermes homes for the collector tests: the folders and files Hermes keeps, with
// invented content. state.db is a real SQLite file made with node:sqlite, so the session counts are
// read the way the collector reads them on a real machine. Nothing here runs Hermes.

import { mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

let sqlite
try {
  sqlite = await import('node:sqlite')
} catch {
  sqlite = null
}

// Tests that need a real state.db skip loudly when this Node has no node:sqlite.
export const HAVE_SQLITE = sqlite !== null
export const NO_SQLITE_SKIP = 'NOT CHECKED: this Node has no node:sqlite, so no real state.db could be made. The collector itself says "needs a newer Node" in that case, which is checked separately.'

// Hermes's own sessions table (hermes_state_common.py), trimmed to what matters here plus the
// private columns the collector must never read: title, cwd, user, chat, the billing address.
export const SESSION_COLUMNS = [
  'id TEXT PRIMARY KEY',
  'source TEXT NOT NULL',
  'user_id TEXT',
  'chat_id TEXT',
  'model TEXT',
  'parent_session_id TEXT',
  'started_at REAL NOT NULL',
  'ended_at REAL',
  'cwd TEXT',
  'git_repo_root TEXT',
  'billing_base_url TEXT',
  'title TEXT',
  'last_activity_at REAL'
]

// rows: [{ id, source, started_at, ... }]. columns: the column definitions to create, so a test can
// leave out the optional ones. Returns the path.
export async function makeStateDb(path, rows, { columns = SESSION_COLUMNS, table = 'sessions' } = {}) {
  if (!sqlite) throw new Error('node:sqlite is not available')
  await mkdir(dirname(path), { recursive: true })
  const db = new sqlite.DatabaseSync(path)
  try {
    db.exec(`CREATE TABLE ${table} (${columns.join(', ')})`)
    const names = columns.map((column) => column.split(' ')[0])
    for (const row of rows) {
      const keys = names.filter((name) => Object.hasOwn(row, name))
      db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((key) => row[key]))
    }
  } finally {
    db.close()
  }
  return path
}

// The test-side opener: the same read-only opening the collector does, with a record of every
// statement it is asked to prepare.
export function recordingOpener() {
  const statements = []
  const open = async (path) => {
    const db = new sqlite.DatabaseSync(path, { readOnly: true })
    return {
      prepare: (sql) => {
        statements.push(sql)
        return db.prepare(sql)
      },
      close: () => db.close()
    }
  }
  open.statements = statements
  return open
}

// Where a spawned collector on this computer looks for Hermes when HOME is the fake home and
// nothing else is set: %LOCALAPPDATA%\hermes falls back to <home>\AppData\Local\hermes on Windows.
export const hermesFolderFor = (platform) => (platform === 'win32' ? 'AppData/Local/hermes' : '.hermes')

const secondsAgo = (now, seconds) => (now - seconds * 1000) / 1000

// A whole Hermes home in `fake` (tests/helpers/fake-home.mjs), at `folder`, with the default profile
// and the named ones given. Returns the root.
export async function writeHermes(fake, { now, folder = '.hermes', version = '0.21.3', gateway = 'running', gatewaySecondsAgo = 30, profiles = {} } = {}) {
  const at = (relative, content) => fake.write(`${folder}/${relative}`, content)
  await at('hermes-agent/pyproject.toml', ['[project]', 'name = "hermes-agent"', `version = "${version}"`].join('\n'))
  if (gateway !== null) {
    await at('gateway_state.json', { pid: 4242, gateway_state: gateway, updated_at: new Date(now - gatewaySecondsAgo * 1000).toISOString().replace('Z', '+00:00') })
  }
  await at('config.yaml', 'model:\n  default: anthropic/claude-opus-5-5\n  provider: anthropic\n')
  await at('skills/research/deep/SKILL.md', '# deep research\n')
  await at('skills/writing/SKILL.md', '# writing\n')
  await at('cron/ticker_heartbeat', String(secondsAgo(now, 20)))
  for (const [name, files] of Object.entries(profiles)) {
    for (const [relative, content] of Object.entries(files)) await at(`profiles/${name}/${relative}`, content)
  }
  return join(fake.home, ...folder.split('/'))
}
