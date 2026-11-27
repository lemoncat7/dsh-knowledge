import { createHash } from 'node:crypto'
import { constants as fileConstants, copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { isEditableNoteNode, type NoteNodeKind } from './domain.js'
import { isNodeError, objectPath, versionDirectory, versionPath, type SqlRow } from './note-store-internal.js'

export interface NoteStoreSchemaPaths { readonly objectsPath: string; readonly versionsPath: string }

/** Creates or upgrades the notes schema; SQL, ordering and PRAGMAs are unchanged from the original store. */
export function migrateNotes(db: DatabaseSync, paths: NoteStoreSchemaPaths): void {
  let version = Number((db.prepare('PRAGMA user_version').get() as SqlRow).user_version ?? 0)
  if (version > 4) throw new Error(`note database schema ${version} is newer than this plugin supports`)
  if (version === 0) db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE note_nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        parent_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('folder','document','file')),
        name TEXT NOT NULL,
        media_type TEXT,
        size INTEGER NOT NULL CHECK(size >= 0),
        sha256 TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE note_versions (
        note_id TEXT NOT NULL REFERENCES note_nodes(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK(version >= 1),
        name TEXT NOT NULL,
        media_type TEXT,
        size INTEGER NOT NULL CHECK(size >= 0),
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(note_id, version)
      );
      CREATE TABLE note_shares (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL UNIQUE REFERENCES note_nodes(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX note_sibling_name ON note_nodes(parent_key, name COLLATE NOCASE);
      CREATE INDEX note_parent_order ON note_nodes(parent_key, kind, name COLLATE NOCASE);
      CREATE INDEX note_name ON note_nodes(name COLLATE NOCASE);
      CREATE INDEX note_versions_recent ON note_versions(note_id, version DESC);
      CREATE INDEX note_shares_recent ON note_shares(updated_at DESC);
      PRAGMA user_version = 3;
      COMMIT;
    `)
  if (version === 0) return
  if (version === 1) {
    migrateVersionOne(db, paths)
    version = 2
  }
  if (version === 2) migrateVersionTwo(db)
}

function migrateVersionOne(db: DatabaseSync, paths: NoteStoreSchemaPaths): void {
  const files = db.prepare(`
      SELECT id,kind,name,media_type,size,sha256,created_at
      FROM note_nodes
      WHERE kind<>'folder'
    `).all() as SqlRow[]
  const versionedFiles = files
    .filter(row => isEditableNoteNode({
      kind: String(row.kind) as NoteNodeKind,
      name: String(row.name),
      mediaType: row.media_type === null ? null : String(row.media_type),
    }))
    .map(row => {
      const id = String(row.id)
      const content = readFileSync(objectPath(paths.objectsPath, id))
      return {
        id,
        name: String(row.name),
        mediaType: row.media_type === null ? null : String(row.media_type),
        size: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
        createdAt: String(row.created_at),
      }
    })
  const createdSnapshots: string[] = []
  try {
    for (const row of versionedFiles) {
      const directory = versionDirectory(paths.versionsPath, row.id)
      const snapshotPath = versionPath(paths.versionsPath, row.id, 1)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      try {
        copyFileSync(objectPath(paths.objectsPath, row.id), snapshotPath, fileConstants.COPYFILE_EXCL)
        createdSnapshots.push(snapshotPath)
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error
      }
    }
    db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE note_nodes ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1);
        CREATE TABLE note_versions (
          note_id TEXT NOT NULL REFERENCES note_nodes(id) ON DELETE CASCADE,
          version INTEGER NOT NULL CHECK(version >= 1),
          name TEXT NOT NULL,
          media_type TEXT,
          size INTEGER NOT NULL CHECK(size >= 0),
          sha256 TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(note_id, version)
        );
      `)
    const insert = db.prepare(`
        INSERT INTO note_versions(note_id,version,name,media_type,size,sha256,created_at)
        VALUES(?,1,?,?,?,?,?)
      `)
    for (const row of versionedFiles) {
      db.prepare('UPDATE note_nodes SET size=?, sha256=? WHERE id=?').run(row.size, row.sha256, row.id)
      insert.run(row.id, row.name, row.mediaType, row.size, row.sha256, row.createdAt)
    }
    db.exec(`
        CREATE INDEX note_versions_recent ON note_versions(note_id, version DESC);
        PRAGMA user_version = 2;
        COMMIT;
      `)
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    for (const snapshotPath of createdSnapshots) rmSync(snapshotPath, { force: true })
    throw error
  }
}

function migrateVersionTwo(db: DatabaseSync): void {
  db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE note_shares (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL UNIQUE REFERENCES note_nodes(id) ON DELETE CASCADE,
        token TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX note_shares_recent ON note_shares(updated_at DESC);
      PRAGMA user_version = 3;
      COMMIT;
    `)
}
