import type { DatabaseSync } from 'node:sqlite'
import type { NoteStore } from '../notes/store.js'
import { DEFAULT_KNOWLEDGE_BASE_ID, nowIso } from '../domain.js'
type SqlRow = Record<string, unknown>

/** Versioned upgrades preserve the provider's database and transaction boundaries. */
export function migrateKnowledgeDatabase(db: DatabaseSync, notes: NoteStore): void {
  let version = Number((db.prepare('PRAGMA user_version').get() as SqlRow).user_version ?? 0)
  if (version > 13) throw new Error(`knowledge database schema ${version} is newer than this plugin supports`)
  if (version === 0) db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE knowledge_entries (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('preference','fact','decision','procedure','lesson')),
      tags_json TEXT NOT NULL,
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global','project')),
      scope_id TEXT,
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      status TEXT NOT NULL CHECK(status IN ('active','archived')),
      version INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      source_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK((scope_kind = 'global' AND scope_id IS NULL) OR (scope_kind = 'project' AND length(scope_id) > 0))
    );
    CREATE INDEX knowledge_entries_scope_status ON knowledge_entries(status, scope_kind, scope_id, updated_at DESC);
    CREATE INDEX knowledge_entries_type ON knowledge_entries(type, status);
    CREATE UNIQUE INDEX knowledge_entries_active_hash ON knowledge_entries(content_hash) WHERE status = 'active';

    CREATE TABLE knowledge_versions (
      id TEXT PRIMARY KEY,
      knowledge_id TEXT NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      change_kind TEXT NOT NULL CHECK(change_kind IN ('create','update','archive','restore')),
      created_at TEXT NOT NULL,
      UNIQUE(knowledge_id, version)
    );

    CREATE TABLE knowledge_candidates (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL CHECK(action IN ('create','update','conflict')),
      target_id TEXT,
      draft_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
      source_key TEXT,
      proposal_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      review_note TEXT
    );
    CREATE UNIQUE INDEX knowledge_candidates_dedupe ON knowledge_candidates(source_key, proposal_hash) WHERE source_key IS NOT NULL;
    CREATE INDEX knowledge_candidates_status ON knowledge_candidates(status, created_at DESC);

    CREATE TABLE extraction_jobs (
      source_key TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
      attempts INTEGER NOT NULL,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE api_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      permissions_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    );

    CREATE VIRTUAL TABLE knowledge_fts USING fts5(
      knowledge_id UNINDEXED,
      title,
      body,
      tags,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    PRAGMA user_version = 1;
    COMMIT;
  `)
  if (version === 0) version = 1
  if (version === 1) db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE knowledge_bases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      default_tags_json TEXT NOT NULL,
      extraction_instructions TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','archived')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO knowledge_bases(
      id,name,description,default_tags_json,extraction_instructions,status,created_at,updated_at
    ) VALUES(
      'default','默认知识库','','[]','仅收录可跨会话复用、且与当前挂载范围相关的知识。','active',datetime('now'),datetime('now')
    );
    ALTER TABLE knowledge_entries ADD COLUMN knowledge_base_id TEXT NOT NULL DEFAULT 'default';
    CREATE INDEX knowledge_entries_base_status ON knowledge_entries(knowledge_base_id, status, updated_at DESC);
    CREATE TABLE knowledge_mounts (
      id TEXT PRIMARY KEY,
      target_kind TEXT NOT NULL CHECK(target_kind IN ('project','session')),
      target_id TEXT NOT NULL,
      knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      recall_enabled INTEGER NOT NULL CHECK(recall_enabled IN (0,1)),
      write_mode TEXT NOT NULL CHECK(write_mode IN ('none','audit','direct')),
      include_tags_json TEXT NOT NULL,
      exclude_tags_json TEXT NOT NULL,
      extraction_instructions TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(target_kind, target_id, knowledge_base_id)
    );
    CREATE INDEX knowledge_mounts_target ON knowledge_mounts(target_kind, target_id, enabled);
    PRAGMA user_version = 2;
    COMMIT;
  `)
  if (version <= 1) version = 2
  if (version === 2) db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE knowledge_bases ADD COLUMN writeback_provider TEXT;
    ALTER TABLE knowledge_bases ADD COLUMN writeback_model TEXT;
    PRAGMA user_version = 3;
    COMMIT;
  `)
  if (version <= 2) version = 3
  if (version === 3) db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE knowledge_documents (
      id TEXT PRIMARY KEY,
      knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      rel_path TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      entry_count INTEGER NOT NULL CHECK(entry_count >= 0),
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(knowledge_base_id, rel_path)
    );
    CREATE INDEX knowledge_documents_base_updated ON knowledge_documents(knowledge_base_id, updated_at DESC);
    PRAGMA user_version = 4;
    COMMIT;
  `)
  if (version <= 3) version = 4
  if (version === 4) db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE knowledge_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      writeback_policy TEXT NOT NULL CHECK(writeback_policy IN ('conservative','proactive')),
      updated_at TEXT NOT NULL
    );
    INSERT INTO knowledge_settings(id,writeback_policy,updated_at)
    VALUES(1,'conservative',datetime('now'));
    PRAGMA user_version = 5;
    COMMIT;
  `)
  if (version <= 4) version = 5
  if (version === 5) db.exec('PRAGMA user_version = 6;')
  if (version <= 5) version = 6
  if (version === 6) db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE knowledge_entries ADD COLUMN document_state TEXT NOT NULL DEFAULT 'open'
      CHECK(document_state IN ('open','resolved','complete'));
    ALTER TABLE knowledge_entries ADD COLUMN finalized_at TEXT;
    ALTER TABLE knowledge_entries ADD COLUMN finalization_note TEXT;
    ALTER TABLE knowledge_documents ADD COLUMN document_state TEXT NOT NULL DEFAULT 'open'
      CHECK(document_state IN ('open','resolved','complete'));
    ALTER TABLE knowledge_documents ADD COLUMN finalized_at TEXT;
    ALTER TABLE knowledge_documents ADD COLUMN finalization_note TEXT;
    PRAGMA user_version = 7;
    COMMIT;
  `)
  if (version <= 6) version = 7
  if (version === 7) db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE knowledge_bases ADD COLUMN writeback_policy TEXT NOT NULL DEFAULT 'conservative'
      CHECK(writeback_policy IN ('conservative','proactive'));
    UPDATE knowledge_bases SET writeback_policy=(SELECT writeback_policy FROM knowledge_settings WHERE id=1);
    PRAGMA user_version = 8;
    COMMIT;
  `)
  if (version <= 7) version = 8
  if (version === 8) db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE knowledge_settings ADD COLUMN writeback_provider TEXT;
    ALTER TABLE knowledge_settings ADD COLUMN writeback_model TEXT;
    PRAGMA user_version = 9;
    COMMIT;
  `)
  if (version <= 8) version = 9
  if (version === 9) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(`
        CREATE TABLE knowledge_note_references (
          knowledge_id TEXT NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
          note_id TEXT NOT NULL,
          source TEXT NOT NULL CHECK(source IN ('user','agent','legacy')),
          source_session_id TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY(knowledge_id, note_id)
        );
        CREATE INDEX knowledge_note_references_note ON knowledge_note_references(note_id, created_at DESC);
      `)
      backfillLegacyNoteReferences(db, notes)
      db.exec('PRAGMA user_version = 10; COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (version <= 9) version = 10
  if (version === 10) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const candidateTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_candidates'").get()
      const candidateColumns = candidateTable === undefined
        ? []
        : db.prepare('PRAGMA table_info(knowledge_candidates)').all() as SqlRow[]
      if (candidateTable !== undefined && !candidateColumns.some(column => String(column.name) === 'change_json')) {
        db.exec('ALTER TABLE knowledge_candidates ADD COLUMN change_json TEXT')
      }
      db.exec('PRAGMA user_version = 11; COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  if (version <= 10) version = 11
  if (version === 11) db.exec(`
    BEGIN IMMEDIATE;
    CREATE INDEX IF NOT EXISTS knowledge_documents_index_order ON knowledge_documents(
      knowledge_base_id,
      (CASE WHEN rel_path='README.md' THEN 0 ELSE 1 END),
      rel_path,
      id
    );
    PRAGMA user_version = 12;
    COMMIT;
  `)
  if (version <= 11) version = 12
  if (version === 12) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const extractionTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='extraction_jobs'").get()
      if (extractionTable === undefined) {
        db.exec(`
          CREATE TABLE extraction_jobs (
            source_key TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
            attempts INTEGER NOT NULL,
            candidate_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            completion_json TEXT,
            updated_at TEXT NOT NULL
          )
        `)
      } else {
        const extractionColumns = db.prepare('PRAGMA table_info(extraction_jobs)').all() as SqlRow[]
        if (!extractionColumns.some(column => String(column.name) === 'completion_json')) {
          db.exec('ALTER TABLE extraction_jobs ADD COLUMN completion_json TEXT')
        }
      }
      db.exec('PRAGMA user_version = 13; COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  // Alpha v2 used a migration note as the default base's routing description.
  // Clear only that exact placeholder so existing user-authored descriptions stay untouched.
  db.prepare("UPDATE knowledge_bases SET description='' WHERE id=? AND description=?")
    .run(DEFAULT_KNOWLEDGE_BASE_ID, '由 0.2 版本迁移的知识。')
}

function backfillLegacyNoteReferences(db: DatabaseSync, notes: NoteStore): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO knowledge_note_references(knowledge_id,note_id,source,source_session_id,created_at)
    VALUES(?,?,'legacy',NULL,?)
  `)
  const timestamp = nowIso()
  const rows = db.prepare("SELECT id,body FROM knowledge_entries WHERE body LIKE '%note://note_%'").all() as SqlRow[]
  for (const row of rows) {
    const noteIds = String(row.body).match(/note:\/\/(note_[a-f0-9]{32})/giu) ?? []
    for (const reference of new Set(noteIds)) {
      const noteId = reference.slice('note://'.length).toLocaleLowerCase()
      const note = notes.get(noteId)
      if (note !== undefined && note.kind !== 'folder') insert.run(String(row.id), note.id, timestamp)
    }
  }
}
