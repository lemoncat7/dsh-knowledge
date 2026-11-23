import type {DatabaseSync} from 'node:sqlite'

/** Detect local writes and commits from other connections without modifying SQLite. */
export function sqliteRevision(db: DatabaseSync): string {
  const external = db.prepare('PRAGMA data_version').get()!.data_version
  const local = db.prepare('SELECT total_changes() AS changes').get()!.changes
  return `${external}:${local}`
}
