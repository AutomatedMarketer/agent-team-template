// Opening a SQLite file to read it, and only to read it. The Hermes part asks each profile's
// state.db one fixed question through this (hermes.mjs, readSessions); the tests hand in their own
// opener through deps.openSqlite and get the same kind of object back.
//
// node:sqlite is loaded only when there is a database to open, and only here. Node 20 has no
// node:sqlite, and Node 22 before 22.13 hides it behind a flag; either way the load fails, and that
// is SqliteMissing - which the card shows as "needs a newer Node", never as zero sessions.

export class SqliteMissing extends Error {
  constructor() {
    super('node:sqlite is not available in this Node')
    this.name = 'SqliteMissing'
  }
}

// How long to wait for Hermes to finish a write before giving up on this reading.
export const SQLITE_BUSY_TIMEOUT_MS = 2000

export async function openReadOnly(path) {
  let sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch {
    throw new SqliteMissing()
  }
  // readOnly: SQLite itself refuses every write, and a missing file is an error, never created.
  return new sqlite.DatabaseSync(path, { readOnly: true, timeout: SQLITE_BUSY_TIMEOUT_MS })
}
