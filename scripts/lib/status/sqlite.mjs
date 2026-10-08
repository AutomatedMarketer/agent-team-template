// Opening a SQLite file to read it, and only to read it. The Hermes part asks each profile's
// state.db - its private copy, never Hermes's own file - one fixed question through this (hermes.mjs, readSessions); the tests hand in their own
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
  // readOnly: SQLite refuses every write to the database, and a missing file is an error, never
  // created. It does NOT stop SQLite making -wal and -shm files beside a WAL-mode database, which is
  // why this is only ever handed a private copy in a folder the collector deletes.
  return new sqlite.DatabaseSync(path, { readOnly: true, timeout: SQLITE_BUSY_TIMEOUT_MS })
}
