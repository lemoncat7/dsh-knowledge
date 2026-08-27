import { dirname, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  contentHash,
  DEFAULT_KNOWLEDGE_BASE_ID,
  newId,
  normalizeDraft,
  normalizeKnowledgeBaseDraft,
  normalizeKnowledgeMountDraft,
  normalizeKnowledgeSettings,
  nowIso,
  type CandidateProposal,
  type ApiTokenRecord,
  type ExtractionJobRecord,
  type KnowledgeCandidate,
  type KnowledgeBase,
  type KnowledgeBaseDraft,
  type KnowledgeBasePatch,
  type KnowledgeDraft,
  type KnowledgeEntry,
  type KnowledgeDocument,
  type KnowledgeStatus,
  type KnowledgeStats,
  type KnowledgeVersion,
  type KnowledgeMount,
  type KnowledgeMountBatch,
  type KnowledgeMountBatchResult,
  type KnowledgeMountDraft,
  type KnowledgeMountTargetKind,
  type KnowledgeSettings,
  type KnowledgeSettingsPatch,
  type ResolvedKnowledgeMount,
  type DirectWriteResult,
  type ListRequest,
  type ListResult,
  type ReviewDecision,
  type SearchHit,
  type SearchRequest,
  type TokenPermission,
} from './domain.js'
import type { KnowledgeProvider } from './provider.js'
import { renderKnowledgeMarkdown } from './documents/markdown.js'
import { knowledgeDocumentPath } from './documents/path.js'
import { KnowledgeDocumentStore } from './documents/store.js'
import { mergeKnowledgeBodies } from './knowledge-merge.js'

type SqlRow = Record<string, unknown>

const ENTRY_COLUMNS = `
  id, knowledge_base_id, title, body, type, tags_json, scope_kind, scope_id, confidence,
  status, document_state, finalized_at, finalization_note, version, source_json, created_at, updated_at
`

const JOINED_ENTRY_COLUMNS = `
  e.id AS id, e.knowledge_base_id AS knowledge_base_id, e.title AS title, e.body AS body, e.type AS type,
  e.tags_json AS tags_json, e.scope_kind AS scope_kind, e.scope_id AS scope_id,
  e.confidence AS confidence, e.status AS status, e.document_state AS document_state,
  e.finalized_at AS finalized_at, e.finalization_note AS finalization_note, e.version AS version,
  e.source_json AS source_json, e.created_at AS created_at, e.updated_at AS updated_at
`

export class LocalKnowledgeProvider implements KnowledgeProvider {
  readonly mode = 'local' as const
  private readonly db: DatabaseSync
  private readonly documentStore: KnowledgeDocumentStore
  private readonly documentsReady: Promise<void>
  private closed = false

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.documentStore = new KnowledgeDocumentStore(join(dirname(path), 'documents'))
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.migrate()
    this.documentsReady = this.syncAllDocuments()
  }

  private migrate(): void {
    let version = Number((this.db.prepare('PRAGMA user_version').get() as SqlRow).user_version ?? 0)
    if (version > 9) throw new Error(`knowledge database schema ${version} is newer than this plugin supports`)
    if (version === 0) this.db.exec(`
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
    if (version === 1) this.db.exec(`
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
    if (version === 2) this.db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE knowledge_bases ADD COLUMN writeback_provider TEXT;
      ALTER TABLE knowledge_bases ADD COLUMN writeback_model TEXT;
      PRAGMA user_version = 3;
      COMMIT;
    `)
    if (version <= 2) version = 3
    if (version === 3) this.db.exec(`
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
    if (version === 4) this.db.exec(`
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
    if (version === 5) this.db.exec('PRAGMA user_version = 6;')
    if (version <= 5) version = 6
    if (version === 6) this.db.exec(`
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
    if (version === 7) this.db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE knowledge_bases ADD COLUMN writeback_policy TEXT NOT NULL DEFAULT 'conservative'
        CHECK(writeback_policy IN ('conservative','proactive'));
      UPDATE knowledge_bases SET writeback_policy=(SELECT writeback_policy FROM knowledge_settings WHERE id=1);
      PRAGMA user_version = 8;
      COMMIT;
    `)
    if (version <= 7) version = 8
    if (version === 8) this.db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE knowledge_settings ADD COLUMN writeback_provider TEXT;
      ALTER TABLE knowledge_settings ADD COLUMN writeback_model TEXT;
      PRAGMA user_version = 9;
      COMMIT;
    `)
    // Alpha v2 used a migration note as the default base's routing description.
    // Clear only that exact placeholder so existing user-authored descriptions stay untouched.
    this.db.prepare("UPDATE knowledge_bases SET description='' WHERE id=? AND description=?")
      .run(DEFAULT_KNOWLEDGE_BASE_ID, '由 0.2 版本迁移的知识。')
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('knowledge provider is closed')
  }

  async getSettings(): Promise<KnowledgeSettings> {
    this.assertOpen()
    const row = this.db.prepare('SELECT writeback_policy,writeback_provider,writeback_model,updated_at FROM knowledge_settings WHERE id=1').get() as SqlRow
    const provider = row.writeback_provider == null ? undefined : String(row.writeback_provider)
    const model = row.writeback_model == null ? undefined : String(row.writeback_model)
    return {
      writebackPolicy: String(row.writeback_policy) as KnowledgeSettings['writebackPolicy'],
      ...provider === undefined || model === undefined ? {} : { writebackProvider: provider, writebackModel: model },
      updatedAt: String(row.updated_at),
    }
  }

  async updateSettings(input: KnowledgeSettingsPatch): Promise<KnowledgeSettings> {
    this.assertOpen()
    const patch = normalizeKnowledgeSettings(input)
    const updatedAt = nowIso()
    const current = await this.getSettings()
    const clearRoute = patch.writebackProvider === null || patch.writebackModel === null
    const next = {
      writebackPolicy: patch.writebackPolicy ?? current.writebackPolicy,
      ...clearRoute ? {} : patch.writebackProvider && patch.writebackModel
        ? { writebackProvider: patch.writebackProvider, writebackModel: patch.writebackModel }
        : current.writebackProvider && current.writebackModel ? { writebackProvider: current.writebackProvider, writebackModel: current.writebackModel } : {},
      updatedAt,
    }
    this.db.prepare('UPDATE knowledge_settings SET writeback_policy=?,writeback_provider=?,writeback_model=?,updated_at=? WHERE id=1')
      .run(next.writebackPolicy, next.writebackProvider ?? null, next.writebackModel ?? null, updatedAt)
    return next
  }

  async listKnowledgeBases(): Promise<KnowledgeBase[]> {
    this.assertOpen()
    return (this.db.prepare('SELECT * FROM knowledge_bases ORDER BY status, updated_at DESC, id').all() as SqlRow[])
      .map(rowToKnowledgeBase)
  }

  async getKnowledgeBase(id: string): Promise<KnowledgeBase | undefined> {
    this.assertOpen()
    const row = this.db.prepare('SELECT * FROM knowledge_bases WHERE id = ?').get(id) as SqlRow | undefined
    return row === undefined ? undefined : rowToKnowledgeBase(row)
  }

  async createKnowledgeBase(input: KnowledgeBaseDraft): Promise<KnowledgeBase> {
    this.assertOpen()
    await this.documentsReady
    const draft = normalizeKnowledgeBaseDraft(input)
    const timestamp = nowIso()
    const base: KnowledgeBase = { ...draft, id: newId(), status: 'active', createdAt: timestamp, updatedAt: timestamp }
    this.db.prepare(`
      INSERT INTO knowledge_bases(
        id,name,description,default_tags_json,extraction_instructions,writeback_policy,writeback_provider,writeback_model,status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,'active',?,?)
    `).run(
      base.id, base.name, base.description, JSON.stringify(base.defaultTags), base.extractionInstructions,
      base.writebackPolicy, base.writebackProvider ?? null, base.writebackModel ?? null, timestamp, timestamp,
    )
    await this.syncKnowledgeDocuments(base.id)
    return base
  }

  async updateKnowledgeBase(id: string, input: KnowledgeBaseDraft): Promise<KnowledgeBase> {
    this.assertOpen()
    await this.documentsReady
    const current = await this.getKnowledgeBase(id)
    if (current === undefined) throw notFound('knowledge base', id)
    const draft = normalizeKnowledgeBaseDraft(input)
    const updated: KnowledgeBase = { ...current, ...draft, updatedAt: nowIso() }
    this.db.prepare(`
      UPDATE knowledge_bases SET
        name=?,description=?,default_tags_json=?,extraction_instructions=?,writeback_policy=?,writeback_provider=?,writeback_model=?,updated_at=?
      WHERE id=?
    `).run(
      updated.name, updated.description, JSON.stringify(updated.defaultTags), updated.extractionInstructions,
      updated.writebackPolicy, updated.writebackProvider ?? null, updated.writebackModel ?? null, updated.updatedAt, id,
    )
    await this.syncKnowledgeDocuments(id)
    return updated
  }

  async patchKnowledgeBase(id: string, patch: KnowledgeBasePatch): Promise<KnowledgeBase> {
    this.assertOpen()
    const current = await this.getKnowledgeBase(id)
    if (current === undefined) throw notFound('knowledge base', id)
    const clearRoute = patch.writebackProvider === null || patch.writebackModel === null
    const provider = typeof patch.writebackProvider === 'string' ? patch.writebackProvider : current.writebackProvider
    const model = typeof patch.writebackModel === 'string' ? patch.writebackModel : current.writebackModel
    return this.updateKnowledgeBase(id, {
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      defaultTags: patch.defaultTags ?? current.defaultTags,
      extractionInstructions: patch.extractionInstructions ?? current.extractionInstructions,
      writebackPolicy: patch.writebackPolicy ?? current.writebackPolicy,
      ...clearRoute || provider === undefined || model === undefined ? {} : { writebackProvider: provider, writebackModel: model },
    })
  }

  async archiveKnowledgeBase(id: string): Promise<KnowledgeBase> {
    this.assertOpen()
    if (id === DEFAULT_KNOWLEDGE_BASE_ID) throw conflict('the default knowledge base cannot be archived')
    const current = await this.getKnowledgeBase(id)
    if (current === undefined) throw notFound('knowledge base', id)
    if (current.status === 'archived') return current
    const updated: KnowledgeBase = { ...current, status: 'archived', updatedAt: nowIso() }
    this.db.prepare("UPDATE knowledge_bases SET status='archived',updated_at=? WHERE id=?").run(updated.updatedAt, id)
    this.db.prepare('UPDATE knowledge_mounts SET enabled=0,updated_at=? WHERE knowledge_base_id=?').run(updated.updatedAt, id)
    return updated
  }

  async restoreKnowledgeBase(id: string): Promise<KnowledgeBase> {
    this.assertOpen()
    const current = await this.getKnowledgeBase(id)
    if (current === undefined) throw notFound('knowledge base', id)
    if (current.status === 'active') return current
    const updated: KnowledgeBase = { ...current, status: 'active', updatedAt: nowIso() }
    this.db.prepare("UPDATE knowledge_bases SET status='active',updated_at=? WHERE id=?").run(updated.updatedAt, id)
    return updated
  }

  async deleteKnowledgeBase(id: string): Promise<void> {
    this.assertOpen()
    await this.documentsReady
    const base = await this.getKnowledgeBase(id)
    if (id === DEFAULT_KNOWLEDGE_BASE_ID) throw conflict('the default knowledge base cannot be deleted')
    this.transaction(() => {
      const row = this.db.prepare('SELECT status FROM knowledge_bases WHERE id=?').get(id) as SqlRow | undefined
      if (row === undefined) throw notFound('knowledge base', id)
      if (row.status !== 'archived') throw conflict('knowledge base must be archived before deletion')
      this.db.prepare(`
        DELETE FROM knowledge_candidates
        WHERE json_extract(draft_json, '$.knowledgeBaseId')=?
           OR target_id IN (SELECT id FROM knowledge_entries WHERE knowledge_base_id=?)
      `).run(id, id)
      this.db.prepare(`
        DELETE FROM knowledge_fts
        WHERE knowledge_id IN (SELECT id FROM knowledge_entries WHERE knowledge_base_id=?)
      `).run(id)
      this.db.prepare('DELETE FROM knowledge_entries WHERE knowledge_base_id=?').run(id)
      this.db.prepare('DELETE FROM knowledge_mounts WHERE knowledge_base_id=?').run(id)
      this.db.prepare('DELETE FROM knowledge_documents WHERE knowledge_base_id=?').run(id)
      this.db.prepare('DELETE FROM knowledge_bases WHERE id=?').run(id)
    })
    if (base !== undefined) await this.documentStore.deleteBase(this.documentStore.baseDirectory(base))
  }

  async listDocuments(knowledgeBaseId?: string, query?: string): Promise<KnowledgeDocument[]> {
    this.assertOpen()
    await this.documentsReady
    const where: string[] = []
    const args: string[] = []
    if (knowledgeBaseId !== undefined) { where.push('knowledge_base_id=?'); args.push(knowledgeBaseId) }
    const text = query?.trim()
    if (text) {
      where.push('(title LIKE ? ESCAPE \'\\\' OR rel_path LIKE ? ESCAPE \'\\\' OR content LIKE ? ESCAPE \'\\\')')
      const like = `%${text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
      args.push(like, like, like)
    }
    const sql = `SELECT * FROM knowledge_documents${where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`} ORDER BY knowledge_base_id, CASE WHEN rel_path='README.md' THEN 0 ELSE 1 END, rel_path`
    return (this.db.prepare(sql).all(...args) as SqlRow[]).map(rowToDocument)
  }

  async getDocument(id: string): Promise<KnowledgeDocument | undefined> {
    this.assertOpen()
    await this.documentsReady
    const row = this.db.prepare('SELECT * FROM knowledge_documents WHERE id=?').get(id) as SqlRow | undefined
    return row === undefined ? undefined : rowToDocument(row)
  }

  async listMounts(targetKind?: KnowledgeMountTargetKind, targetId?: string): Promise<KnowledgeMount[]> {
    this.assertOpen()
    const where: string[] = []
    const args: string[] = []
    if (targetKind !== undefined) { where.push('target_kind=?'); args.push(targetKind) }
    if (targetId !== undefined) { where.push('target_id=?'); args.push(targetId) }
    return (this.db.prepare(`SELECT * FROM knowledge_mounts${where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`} ORDER BY updated_at DESC`)
      .all(...args) as SqlRow[]).map(rowToMount)
  }

  async upsertMount(input: KnowledgeMountDraft): Promise<KnowledgeMount> {
    this.assertOpen()
    return this.upsertMountRow(input)
  }

  async applyMountBatch(batch: KnowledgeMountBatch): Promise<KnowledgeMountBatchResult> {
    this.assertOpen()
    if (batch.upserts.length + batch.deleteIds.length > 500) throw new Error('mount batch must contain at most 500 operations')
    const deleteIds = [...new Set(batch.deleteIds.map(id => id.trim()).filter(Boolean))]
    return this.transaction(() => {
      const mounts = batch.upserts.map(input => this.upsertMountRow(input))
      for (const id of deleteIds) {
        const result = this.db.prepare('DELETE FROM knowledge_mounts WHERE id=?').run(id)
        if (result.changes === 0) throw notFound('knowledge mount', id)
      }
      return { mounts, deletedIds: deleteIds }
    })
  }

  private upsertMountRow(input: KnowledgeMountDraft): KnowledgeMount {
    const draft = normalizeKnowledgeMountDraft(input)
    const base = this.db.prepare('SELECT status FROM knowledge_bases WHERE id=?').get(draft.knowledgeBaseId) as SqlRow | undefined
    if (base === undefined) throw notFound('knowledge base', draft.knowledgeBaseId)
    if (base.status !== 'active') throw conflict(`knowledge base "${draft.knowledgeBaseId}" is archived`)
    const previous = this.db.prepare(`
      SELECT * FROM knowledge_mounts WHERE target_kind=? AND target_id=? AND knowledge_base_id=?
    `).get(draft.targetKind, draft.targetId, draft.knowledgeBaseId) as SqlRow | undefined
    const timestamp = nowIso()
    const mount: KnowledgeMount = {
      ...draft,
      id: previous === undefined ? newId() : String(previous.id),
      createdAt: previous === undefined ? timestamp : String(previous.created_at),
      updatedAt: timestamp,
    }
    this.db.prepare(`
      INSERT INTO knowledge_mounts(
        id,target_kind,target_id,knowledge_base_id,enabled,recall_enabled,write_mode,
        include_tags_json,exclude_tags_json,extraction_instructions,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(target_kind,target_id,knowledge_base_id) DO UPDATE SET
        enabled=excluded.enabled,recall_enabled=excluded.recall_enabled,write_mode=excluded.write_mode,
        include_tags_json=excluded.include_tags_json,exclude_tags_json=excluded.exclude_tags_json,
        extraction_instructions=excluded.extraction_instructions,updated_at=excluded.updated_at
    `).run(
      mount.id, mount.targetKind, mount.targetId, mount.knowledgeBaseId,
      mount.enabled ? 1 : 0, mount.recallEnabled ? 1 : 0, mount.writeMode,
      JSON.stringify(mount.includeTags), JSON.stringify(mount.excludeTags), mount.extractionInstructions,
      mount.createdAt, mount.updatedAt,
    )
    return mount
  }

  async deleteMount(id: string): Promise<void> {
    this.assertOpen()
    const result = this.db.prepare('DELETE FROM knowledge_mounts WHERE id=?').run(id)
    if (result.changes === 0) throw notFound('knowledge mount', id)
  }

  async resolveMounts(sessionId: string, projectId?: string): Promise<ResolvedKnowledgeMount[]> {
    this.assertOpen()
    const project = projectId === undefined ? [] : await this.listMounts('project', projectId)
    const session = await this.listMounts('session', sessionId)
    const resolved = new Map<string, { mount: KnowledgeMount; inheritedFrom?: 'project' }>()
    for (const mount of project) resolved.set(mount.knowledgeBaseId, { mount, inheritedFrom: 'project' })
    for (const mount of session) resolved.set(mount.knowledgeBaseId, { mount })
    const output: ResolvedKnowledgeMount[] = []
    for (const { mount, inheritedFrom } of resolved.values()) {
      if (!mount.enabled) continue
      const base = await this.getKnowledgeBase(mount.knowledgeBaseId)
      if (base === undefined || base.status !== 'active') continue
      output.push({ ...mount, base, ...inheritedFrom === undefined ? {} : { inheritedFrom } })
    }
    return output.sort((left, right) => left.base.name.localeCompare(right.base.name, 'zh-CN'))
  }

  async stats(): Promise<KnowledgeStats> {
    this.assertOpen()
    const entryRows = this.db.prepare('SELECT status, type, COUNT(*) AS count FROM knowledge_entries GROUP BY status, type').all() as SqlRow[]
    const candidateRows = this.db.prepare('SELECT status, COUNT(*) AS count FROM knowledge_candidates GROUP BY status').all() as SqlRow[]
    const jobRows = this.db.prepare('SELECT status, COUNT(*) AS count FROM extraction_jobs GROUP BY status').all() as SqlRow[]
    const baseRows = this.db.prepare('SELECT status, COUNT(*) AS count FROM knowledge_bases GROUP BY status').all() as SqlRow[]
    const byType: KnowledgeStats['entries']['byType'] = {
      preference: 0,
      fact: 0,
      decision: 0,
      procedure: 0,
      lesson: 0,
    }
    let active = 0
    let archived = 0
    for (const row of entryRows) {
      const count = Number(row.count)
      byType[String(row.type) as keyof typeof byType] += count
      if (row.status === 'active') active += count
      if (row.status === 'archived') archived += count
    }
    const candidates = { pending: 0, approved: 0, rejected: 0 }
    for (const row of candidateRows) candidates[String(row.status) as keyof typeof candidates] = Number(row.count)
    const extractionJobs = { running: 0, completed: 0, failed: 0 }
    for (const row of jobRows) extractionJobs[String(row.status) as keyof typeof extractionJobs] = Number(row.count)
    const knowledgeBases = { active: 0, archived: 0 }
    for (const row of baseRows) knowledgeBases[String(row.status) as keyof typeof knowledgeBases] = Number(row.count)
    return {
      knowledgeBases: { total: knowledgeBases.active + knowledgeBases.archived, ...knowledgeBases },
      entries: { total: active + archived, active, archived, byType },
      candidates: { total: candidates.pending + candidates.approved + candidates.rejected, ...candidates },
      extractionJobs: { total: extractionJobs.running + extractionJobs.completed + extractionJobs.failed, ...extractionJobs },
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  async search(request: SearchRequest): Promise<SearchHit[]> {
    this.assertOpen()
    const limit = Math.max(0, Math.min(request.limit, 100))
    if (limit === 0) return []
    const scopeSql = request.projectId === undefined
      ? `e.scope_kind = 'global'`
      : `(e.scope_kind = 'global' OR (e.scope_kind = 'project' AND e.scope_id = ?))`
    const scopeArgs = request.projectId === undefined ? [] : [request.projectId]
    const typeSql = request.types === undefined || request.types.length === 0
      ? ''
      : ` AND e.type IN (${request.types.map(() => '?').join(',')})`
    const typeArgs = request.types ?? []
    const baseIds = [...new Set(request.knowledgeBaseIds ?? [])].filter(Boolean)
    const baseSql = baseIds.length === 0 ? '' : ` AND e.knowledge_base_id IN (${baseIds.map(() => '?').join(',')})`
    const includeTags = [...new Set(request.includeTags ?? [])].filter(Boolean)
    const includeSql = includeTags.length === 0 ? '' : ` AND EXISTS (
      SELECT 1 FROM json_each(e.tags_json) tags WHERE tags.value IN (${includeTags.map(() => '?').join(',')})
    )`
    const excludeTags = [...new Set(request.excludeTags ?? [])].filter(Boolean)
    const excludeSql = excludeTags.length === 0 ? '' : ` AND NOT EXISTS (
      SELECT 1 FROM json_each(e.tags_json) tags WHERE tags.value IN (${excludeTags.map(() => '?').join(',')})
    )`
    const filterSql = `${typeSql}${baseSql}${includeSql}${excludeSql}`
    const filterArgs = [...typeArgs, ...baseIds, ...includeTags, ...excludeTags]
    const text = request.text.trim()
    let rows: SqlRow[]
    if (text.length === 0) {
      rows = this.db.prepare(`
        SELECT ${ENTRY_COLUMNS}, 0.0 AS rank
        FROM knowledge_entries e
        WHERE e.status = 'active' AND ${scopeSql}${filterSql}
        ORDER BY CASE WHEN e.scope_kind = 'project' THEN 0 ELSE 1 END, e.updated_at DESC
        LIMIT ?
      `).all(...scopeArgs, ...filterArgs, limit) as SqlRow[]
    } else {
      const ftsQuery = toFtsQuery(text)
      try {
        rows = this.db.prepare(`
          SELECT ${JOINED_ENTRY_COLUMNS}, bm25(knowledge_fts, 0.0, 4.0, 1.0, 0.5) AS rank
          FROM knowledge_fts
          JOIN knowledge_entries e ON e.id = knowledge_fts.knowledge_id
          WHERE knowledge_fts MATCH ? AND e.status = 'active' AND ${scopeSql}${filterSql}
          ORDER BY CASE WHEN e.scope_kind = 'project' THEN 0 ELSE 1 END, rank, e.updated_at DESC
          LIMIT ?
        `).all(ftsQuery, ...scopeArgs, ...filterArgs, limit) as SqlRow[]
      } catch {
        rows = []
      }
      if (rows.length < limit) {
        const supplements = this.searchByTerms(text, scopeSql, scopeArgs, filterSql, filterArgs, limit)
        const seen = new Set(rows.map(row => String(row.id)))
        rows.push(...supplements.filter(row => !seen.has(String(row.id))).slice(0, limit - rows.length))
      }
    }
    return rows.map(row => {
      const entry = rowToEntry(row)
      return { entry, score: relevanceScore(entry, text) }
    })
  }

  private searchByTerms(
    text: string,
    scopeSql: string,
    scopeArgs: string[],
    filterSql: string,
    filterArgs: string[],
    limit: number,
  ): SqlRow[] {
    const terms = fallbackTerms(text)
    if (terms.length === 0) return []
    const clauses = terms.map(() => `(e.title LIKE ? ESCAPE '\\' OR e.body LIKE ? ESCAPE '\\' OR e.tags_json LIKE ? ESCAPE '\\')`)
    const args = terms.flatMap((term) => {
      const like = `%${term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
      return [like, like, like]
    })
    return this.db.prepare(`
      SELECT ${ENTRY_COLUMNS}, 3.0 AS rank
      FROM knowledge_entries e
      WHERE e.status = 'active' AND ${scopeSql}${filterSql} AND (${clauses.join(' OR ')})
      ORDER BY CASE WHEN e.scope_kind = 'project' THEN 0 ELSE 1 END, e.updated_at DESC
      LIMIT ?
    `).all(...scopeArgs, ...filterArgs, ...args, limit) as SqlRow[]
  }

  async list(request: ListRequest): Promise<ListResult<KnowledgeEntry>> {
    this.assertOpen()
    const limit = Math.max(1, Math.min(request.limit, 100))
    const where: string[] = []
    const args: Array<string | number> = []
    if (request.status !== undefined) { where.push('status = ?'); args.push(request.status) }
    if (request.type !== undefined) { where.push('type = ?'); args.push(request.type) }
    if (request.knowledgeBaseId !== undefined) { where.push('knowledge_base_id = ?'); args.push(request.knowledgeBaseId) }
    if (request.projectId !== undefined) {
      where.push(`(scope_kind = 'global' OR (scope_kind = 'project' AND scope_id = ?))`)
      args.push(request.projectId)
    }
    if (request.cursor !== undefined) {
      const cursor = decodeCursor(request.cursor)
      where.push('(updated_at < ? OR (updated_at = ? AND id < ?))')
      args.push(cursor.updatedAt, cursor.updatedAt, cursor.id)
    }
    const sql = `SELECT ${ENTRY_COLUMNS} FROM knowledge_entries${where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`} ORDER BY updated_at DESC, id DESC LIMIT ?`
    const rows = this.db.prepare(sql).all(...args, limit + 1) as SqlRow[]
    const page = rows.slice(0, limit).map(rowToEntry)
    const last = page.at(-1)
    return {
      items: page,
      ...rows.length <= limit || last === undefined ? {} : { nextCursor: encodeCursor(last.updatedAt, last.id) },
    }
  }

  async get(id: string): Promise<KnowledgeEntry | undefined> {
    this.assertOpen()
    const row = this.db.prepare(`SELECT ${ENTRY_COLUMNS} FROM knowledge_entries WHERE id = ?`).get(id) as SqlRow | undefined
    return row === undefined ? undefined : rowToEntry(row)
  }

  async versions(id: string): Promise<KnowledgeVersion[]> {
    this.assertOpen()
    const rows = this.db.prepare('SELECT * FROM knowledge_versions WHERE knowledge_id = ? ORDER BY version DESC').all(id) as SqlRow[]
    return rows.map(rowToVersion)
  }

  async create(draft: KnowledgeDraft): Promise<KnowledgeEntry> {
    this.assertOpen()
    await this.documentsReady
    const entry = this.transaction(() => this.insertEntry(draft))
    await this.syncKnowledgeDocuments(entry.knowledgeBaseId)
    return entry
  }

  private insertEntry(input: KnowledgeDraft): KnowledgeEntry {
    const draft = normalizeDraft(input)
    if (this.db.prepare("SELECT id FROM knowledge_bases WHERE id=? AND status='active'").get(draft.knowledgeBaseId) === undefined) {
      throw notFound('active knowledge base', draft.knowledgeBaseId)
    }
    const id = newId()
    const timestamp = nowIso()
    const entry: KnowledgeEntry = {
      ...draft, id, status: 'active', documentState: 'open', version: 1,
      createdAt: timestamp, updatedAt: timestamp,
    }
    this.db.prepare(`
      INSERT INTO knowledge_entries (
        id,knowledge_base_id,title,body,type,tags_json,scope_kind,scope_id,confidence,status,
        document_state,finalized_at,finalization_note,version,content_hash,source_json,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,'open',NULL,NULL,?,?,?,?,?)
    `).run(
      id, draft.knowledgeBaseId, draft.title, draft.body, draft.type, JSON.stringify(draft.tags), draft.scope.kind,
      draft.scope.kind === 'project' ? draft.scope.id : null, draft.confidence, 'active', 1,
      contentHash(draft), draft.source === undefined ? null : JSON.stringify(draft.source), timestamp, timestamp,
    )
    this.writeVersion(entry, 'create')
    this.upsertFts(entry)
    return entry
  }

  async update(id: string, draft: KnowledgeDraft): Promise<KnowledgeEntry> {
    this.assertOpen()
    await this.documentsReady
    const current = await this.get(id)
    const entry = this.transaction(() => this.updateEntry(id, draft, 'update'))
    if (current !== undefined && current.knowledgeBaseId !== entry.knowledgeBaseId) await this.syncKnowledgeDocuments(current.knowledgeBaseId)
    await this.syncKnowledgeDocuments(entry.knowledgeBaseId)
    return entry
  }

  async finalize(id: string, state: 'resolved' | 'complete', note?: string): Promise<KnowledgeEntry> {
    this.assertOpen()
    await this.documentsReady
    const entry = this.transaction(() => {
      const row = this.db.prepare(`SELECT ${ENTRY_COLUMNS} FROM knowledge_entries WHERE id=?`).get(id) as SqlRow | undefined
      if (row === undefined) throw notFound('knowledge entry', id)
      const current = rowToEntry(row)
      if (current.status !== 'active') throw conflict('only active knowledge documents can be finalized')
      const finalizationNote = normalizeFinalizationNote(note)
      if (current.documentState === state && current.finalizationNote === finalizationNote) return current
      if (current.documentState !== 'open') throw finalizedConflict(current)
      const timestamp = nowIso()
      const updated: KnowledgeEntry = {
        ...current,
        documentState: state,
        finalizedAt: timestamp,
        ...finalizationNote === undefined ? {} : { finalizationNote },
        version: current.version + 1,
        updatedAt: timestamp,
      }
      this.db.prepare(`
        UPDATE knowledge_entries
        SET document_state=?,finalized_at=?,finalization_note=?,version=?,updated_at=?
        WHERE id=?
      `).run(state, timestamp, finalizationNote ?? null, updated.version, timestamp, id)
      this.writeVersion(updated, 'update')
      this.upsertFts(updated)
      return updated
    })
    await this.syncKnowledgeDocuments(entry.knowledgeBaseId)
    return entry
  }

  async reopen(id: string): Promise<KnowledgeEntry> {
    this.assertOpen()
    await this.documentsReady
    const entry = this.transaction(() => {
      const row = this.db.prepare(`SELECT ${ENTRY_COLUMNS} FROM knowledge_entries WHERE id=?`).get(id) as SqlRow | undefined
      if (row === undefined) throw notFound('knowledge entry', id)
      const current = rowToEntry(row)
      if (current.status !== 'active') throw conflict('only active knowledge documents can be reopened')
      if (current.documentState === 'open') return current
      const timestamp = nowIso()
      const { finalizedAt: _finalizedAt, finalizationNote: _finalizationNote, ...reopened } = current
      const updated: KnowledgeEntry = {
        ...reopened,
        documentState: 'open',
        version: current.version + 1,
        updatedAt: timestamp,
      }
      this.db.prepare(`
        UPDATE knowledge_entries
        SET document_state='open',finalized_at=NULL,finalization_note=NULL,version=?,updated_at=?
        WHERE id=?
      `).run(updated.version, timestamp, id)
      this.writeVersion(updated, 'update')
      this.upsertFts(updated)
      return updated
    })
    await this.syncKnowledgeDocuments(entry.knowledgeBaseId)
    return entry
  }

  private updateEntry(id: string, input: KnowledgeDraft, changeKind: 'update' | 'restore'): KnowledgeEntry {
    const currentRow = this.db.prepare(`SELECT ${ENTRY_COLUMNS} FROM knowledge_entries WHERE id = ?`).get(id) as SqlRow | undefined
    if (currentRow === undefined) throw notFound('knowledge entry', id)
    const current = rowToEntry(currentRow)
    if (current.documentState !== 'open') throw finalizedConflict(current)
    const draft = normalizeDraft(input)
    if (this.db.prepare("SELECT id FROM knowledge_bases WHERE id=? AND status='active'").get(draft.knowledgeBaseId) === undefined) {
      throw notFound('active knowledge base', draft.knowledgeBaseId)
    }
    const timestamp = nowIso()
    const entry: KnowledgeEntry = {
      ...draft,
      id,
      status: 'active',
      documentState: current.documentState,
      version: current.version + 1,
      createdAt: current.createdAt,
      updatedAt: timestamp,
    }
    this.db.prepare(`
      UPDATE knowledge_entries SET
        knowledge_base_id=?,title=?,body=?,type=?,tags_json=?,scope_kind=?,scope_id=?,confidence=?,status='active',
        version=?,content_hash=?,source_json=?,updated_at=?
      WHERE id=?
    `).run(
      draft.knowledgeBaseId, draft.title, draft.body, draft.type, JSON.stringify(draft.tags), draft.scope.kind,
      draft.scope.kind === 'project' ? draft.scope.id : null, draft.confidence, entry.version,
      contentHash(draft), draft.source === undefined ? null : JSON.stringify(draft.source), timestamp, id,
    )
    this.writeVersion(entry, changeKind)
    this.upsertFts(entry)
    return entry
  }

  async archive(id: string): Promise<KnowledgeEntry> {
    this.assertOpen()
    await this.documentsReady
    const entry = this.transaction(() => {
      const row = this.db.prepare(`SELECT ${ENTRY_COLUMNS} FROM knowledge_entries WHERE id = ?`).get(id) as SqlRow | undefined
      if (row === undefined) throw notFound('knowledge entry', id)
      const current = rowToEntry(row)
      if (current.status === 'archived') return current
      const updated: KnowledgeEntry = { ...current, status: 'archived', version: current.version + 1, updatedAt: nowIso() }
      this.db.prepare(`UPDATE knowledge_entries SET status='archived', version=?, updated_at=? WHERE id=?`).run(updated.version, updated.updatedAt, id)
      this.writeVersion(updated, 'archive')
      this.db.prepare('DELETE FROM knowledge_fts WHERE knowledge_id = ?').run(id)
      return updated
    })
    await this.syncKnowledgeDocuments(entry.knowledgeBaseId)
    return entry
  }

  async delete(id: string): Promise<void> {
    this.assertOpen()
    await this.documentsReady
    const current = await this.get(id)
    this.transaction(() => {
      this.db.prepare('DELETE FROM knowledge_fts WHERE knowledge_id = ?').run(id)
      const result = this.db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(id)
      if (result.changes === 0) throw notFound('knowledge entry', id)
    })
    if (current !== undefined) await this.syncKnowledgeDocuments(current.knowledgeBaseId)
  }

  async propose(input: CandidateProposal, sourceKey?: string): Promise<KnowledgeCandidate> {
    this.assertOpen()
    const proposal = normalizeProposal(input)
    const finalized = this.finalizedMatch(proposal)
    if (finalized !== undefined) throw finalizedConflict(finalized)
    return this.insertCandidate(proposal, sourceKey)
  }

  async writeDirect(input: CandidateProposal, sourceKey?: string): Promise<DirectWriteResult> {
    this.assertOpen()
    await this.documentsReady
    let touchedBaseId: string | undefined
    const result = this.transaction((): DirectWriteResult => {
      const resolution = this.resolveDirectProposal(normalizeProposal(input))
      if (resolution.outcome === 'duplicate') return { outcome: 'duplicate', ...resolution.entry === undefined ? {} : { entry: resolution.entry } }
      if (resolution.outcome === 'finalized') return { outcome: 'finalized', entry: resolution.entry }
      const candidate = this.insertCandidate(resolution.proposal, sourceKey)
      if (candidate.status !== 'pending') return { outcome: 'duplicate', candidate }
      if (resolution.outcome === 'conflict') return { outcome: 'conflict', candidate }
      const entry = resolution.proposal.action === 'create'
        ? this.insertEntry(resolution.proposal.draft)
        : this.updateEntry(resolution.proposal.targetId as string, resolution.proposal.draft, 'update')
      const reviewedAt = nowIso()
      this.db.prepare('UPDATE knowledge_candidates SET status=?, reviewed_at=?, review_note=? WHERE id=?')
        .run('approved', reviewedAt, resolution.outcome === 'merged'
          ? 'Automatically merged by direct-write reconciliation.'
          : 'Automatically approved by direct-write policy.', candidate.id)
      touchedBaseId = entry.knowledgeBaseId
      return {
        outcome: resolution.outcome,
        candidate: {
          ...candidate,
          status: 'approved',
          reviewedAt,
          reviewNote: resolution.outcome === 'merged'
            ? 'Automatically merged by direct-write reconciliation.'
            : 'Automatically approved by direct-write policy.',
        },
        entry,
      }
    })
    if (touchedBaseId !== undefined) await this.syncKnowledgeDocuments(touchedBaseId)
    return result
  }

  private insertCandidate(proposal: CandidateProposal, sourceKey?: string): KnowledgeCandidate {
    const hash = contentHash(proposal.draft) + `:${proposal.action}:${proposal.targetId ?? ''}`
    if (sourceKey !== undefined) {
      const existing = this.db.prepare('SELECT * FROM knowledge_candidates WHERE source_key = ? AND proposal_hash = ?').get(sourceKey, hash) as SqlRow | undefined
      if (existing !== undefined) return rowToCandidate(existing)
    }
    const candidate: KnowledgeCandidate = {
      ...proposal,
      id: newId(),
      status: 'pending',
      ...sourceKey === undefined ? {} : { sourceKey },
      createdAt: nowIso(),
    }
    this.db.prepare(`
      INSERT INTO knowledge_candidates(id,action,target_id,draft_json,reason,status,source_key,proposal_hash,created_at)
      VALUES(?,?,?,?,?,'pending',?,?,?)
    `).run(candidate.id, candidate.action, candidate.targetId ?? null, JSON.stringify(candidate.draft), candidate.reason, sourceKey ?? null, hash, candidate.createdAt)
    return candidate
  }

  private resolveDirectProposal(proposal: CandidateProposal): DirectProposalResolution {
    if (proposal.action === 'conflict') return { outcome: 'conflict', proposal }
    if (proposal.action === 'update') {
      const target = this.activeEntry(proposal.targetId as string)
      if (target.documentState !== 'open') return { outcome: 'finalized', entry: target }
      if (target.knowledgeBaseId !== proposal.draft.knowledgeBaseId) {
        throw conflict('direct-write update cannot move knowledge between knowledge bases')
      }
      if (!sameScope(target.scope, proposal.draft.scope)) {
        return { outcome: 'conflict', proposal: { ...proposal, action: 'conflict' } }
      }
      if (potentiallyConflicts(target, proposal.draft)) {
        return { outcome: 'conflict', proposal: { ...proposal, action: 'conflict' } }
      }
      const draft = mergeKnowledgeDraft(target, proposal.draft, true)
      if (contentHash(draft) === contentHash(target)) return { outcome: 'duplicate', entry: target }
      return { outcome: 'merged', proposal: { ...proposal, action: 'update', draft } }
    }

    const entries = this.activeEntriesForDraft(proposal.draft)
    const bodyMatch = entries.find(entry => normalizedBody(entry.body) === normalizedBody(proposal.draft.body))
    const titleMatch = entries.find(entry => normalizedTitle(entry.title) === normalizedTitle(proposal.draft.title))
    const referenceMatch = entries.find(entry => sharesCanonicalTopicReference(entry, proposal.draft))
    const target = bodyMatch ?? titleMatch ?? referenceMatch
    if (target === undefined) return { outcome: 'created', proposal }
    if (target.documentState !== 'open') return { outcome: 'finalized', entry: target }
    if (potentiallyConflicts(target, proposal.draft)) {
      return {
        outcome: 'conflict',
        proposal: { ...proposal, action: 'conflict', targetId: target.id },
      }
    }
    const draft = mergeKnowledgeDraft(target, proposal.draft, false)
    if (contentHash(draft) === contentHash(target)) return { outcome: 'duplicate', entry: target }
    return {
      outcome: 'merged',
      proposal: { ...proposal, action: 'update', targetId: target.id, draft },
    }
  }

  private finalizedMatch(proposal: CandidateProposal): KnowledgeEntry | undefined {
    if (proposal.action !== 'create') {
      const target = this.activeEntry(proposal.targetId as string)
      return target.documentState === 'open' ? undefined : target
    }
    const entries = this.activeEntriesForDraft(proposal.draft)
    return entries.find(entry => entry.documentState !== 'open' && (
      normalizedBody(entry.body) === normalizedBody(proposal.draft.body)
      || normalizedTitle(entry.title) === normalizedTitle(proposal.draft.title)
      || sharesCanonicalTopicReference(entry, proposal.draft)
    ))
  }

  private activeEntry(id: string): KnowledgeEntry {
    const row = this.db.prepare(`SELECT ${ENTRY_COLUMNS} FROM knowledge_entries WHERE id=? AND status='active'`).get(id) as SqlRow | undefined
    if (row === undefined) throw notFound('active knowledge entry', id)
    return rowToEntry(row)
  }

  private activeEntriesForDraft(draft: KnowledgeDraft): KnowledgeEntry[] {
    const scopeId = draft.scope.kind === 'project' ? draft.scope.id : null
    return (this.db.prepare(`
      SELECT ${ENTRY_COLUMNS} FROM knowledge_entries
      WHERE status='active' AND knowledge_base_id=? AND scope_kind=?
        AND ((scope_id IS NULL AND ? IS NULL) OR scope_id=?)
      ORDER BY updated_at DESC
    `).all(draft.knowledgeBaseId, draft.scope.kind, scopeId, scopeId) as SqlRow[]).map(rowToEntry)
  }

  async listCandidates(status: 'pending' | 'approved' | 'rejected', limit: number): Promise<KnowledgeCandidate[]> {
    this.assertOpen()
    return (this.db.prepare('SELECT * FROM knowledge_candidates WHERE status = ? ORDER BY created_at DESC LIMIT ?')
      .all(status, Math.max(1, Math.min(limit, 100))) as SqlRow[]).map(rowToCandidate)
  }

  async review(id: string, decision: ReviewDecision): Promise<KnowledgeCandidate> {
    this.assertOpen()
    await this.documentsReady
    const reviewed: KnowledgeCandidate = this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM knowledge_candidates WHERE id = ?').get(id) as SqlRow | undefined
      if (row === undefined) throw notFound('knowledge candidate', id)
      const candidate = rowToCandidate(row)
      if (candidate.status !== 'pending') throw conflict(`candidate ${id} was already ${candidate.status}`)
      let draft = decision.draft === undefined ? candidate.draft : normalizeDraft(decision.draft)
      if (decision.decision === 'approve') {
        if (candidate.action === 'conflict') {
          if (decision.resolution !== 'merge') {
            throw conflict('conflict candidate requires an explicit merge resolution')
          }
          if (candidate.targetId === undefined) throw new Error('candidate target is missing')
          const targetRow = this.db.prepare(`SELECT ${ENTRY_COLUMNS} FROM knowledge_entries WHERE id = ?`).get(candidate.targetId) as SqlRow | undefined
          if (targetRow === undefined) throw notFound('candidate target', candidate.targetId)
          const target = rowToEntry(targetRow)
          if (draft.knowledgeBaseId !== target.knowledgeBaseId) {
            throw conflict('candidate approval cannot move a document between knowledge bases')
          }
          this.updateEntry(candidate.targetId, mergeKnowledgeDraft(target, draft, true), 'update')
        } else {
          const resolution = this.resolveDirectProposal({
            action: candidate.action,
            ...candidate.targetId === undefined ? {} : { targetId: candidate.targetId },
            draft,
            reason: candidate.reason,
          })
          if (resolution.outcome === 'conflict') {
            const proposal = resolution.proposal
            this.db.prepare(`
              UPDATE knowledge_candidates
              SET action='conflict', target_id=?, draft_json=?, reason=?
              WHERE id=? AND status='pending'
            `).run(proposal.targetId ?? null, JSON.stringify(proposal.draft), proposal.reason, id)
            return {
              ...candidate,
              action: 'conflict',
              ...proposal.targetId === undefined ? {} : { targetId: proposal.targetId },
              draft: proposal.draft,
              reason: proposal.reason,
            }
          }
          if (resolution.outcome === 'finalized') throw finalizedConflict(resolution.entry)
          if (resolution.outcome !== 'duplicate') {
            if (resolution.proposal.action === 'create') this.insertEntry(resolution.proposal.draft)
            else this.updateEntry(resolution.proposal.targetId as string, resolution.proposal.draft, 'update')
          }
        }
      }
      const status = decision.decision === 'approve' ? 'approved' : 'rejected'
      const reviewedAt = nowIso()
      const note = decision.note?.trim().slice(0, 2000)
      this.db.prepare('UPDATE knowledge_candidates SET status=?, reviewed_at=?, review_note=? WHERE id=?')
        .run(status, reviewedAt, note ?? null, id)
      return { ...candidate, status, reviewedAt, ...note === undefined ? {} : { reviewNote: note } }
    })
    if (decision.decision === 'approve') await this.syncKnowledgeDocuments(reviewed.draft.knowledgeBaseId)
    return reviewed
  }

  async claimExtraction(sourceKey: string): Promise<boolean> {
    this.assertOpen()
    const result = this.db.prepare(`
      INSERT INTO extraction_jobs(source_key,status,attempts,candidate_count,updated_at)
      VALUES(?,'running',1,0,?)
      ON CONFLICT(source_key) DO UPDATE SET
        status='running', attempts=extraction_jobs.attempts+1, candidate_count=0,
        last_error=NULL, updated_at=excluded.updated_at
      WHERE extraction_jobs.status='failed' AND extraction_jobs.attempts < 3
    `).run(sourceKey, nowIso())
    return result.changes === 1
  }

  async completeExtraction(sourceKey: string, candidateCount: number): Promise<void> {
    this.assertOpen()
    this.db.prepare(`UPDATE extraction_jobs SET status='completed', candidate_count=?, last_error=NULL, updated_at=? WHERE source_key=?`)
      .run(candidateCount, nowIso(), sourceKey)
  }

  async failExtraction(sourceKey: string, error: string): Promise<void> {
    this.assertOpen()
    this.db.prepare(`UPDATE extraction_jobs SET status='failed', last_error=?, updated_at=? WHERE source_key=?`)
      .run(error.slice(0, 4000), nowIso(), sourceKey)
  }

  async resetExtraction(sourceKey: string): Promise<void> {
    this.assertOpen()
    this.db.prepare(`UPDATE extraction_jobs SET status='failed', attempts=0, candidate_count=0, last_error=NULL, updated_at=? WHERE source_key=?`)
      .run(nowIso(), sourceKey)
  }

  async extractionJob(sourceKey: string): Promise<ExtractionJobRecord | undefined> {
    this.assertOpen()
    const row = this.db.prepare('SELECT * FROM extraction_jobs WHERE source_key = ?').get(sourceKey) as SqlRow | undefined
    return row === undefined ? undefined : rowToExtractionJob(row)
  }

  ensureBootstrapToken(token: string): void {
    this.assertOpen()
    const value = token.trim()
    if (value.length < 24) throw new Error('knowledge API token must contain at least 24 characters')
    const hash = tokenHash(value)
    const existing = this.db.prepare('SELECT id FROM api_tokens WHERE token_hash = ?').get(hash)
    if (existing !== undefined) return
    this.db.prepare(`INSERT INTO api_tokens(id,name,token_hash,permissions_json,created_at) VALUES(?,?,?,?,?)`)
      .run(newId(), 'bootstrap-admin', hash, JSON.stringify(['read', 'propose', 'write', 'admin']), nowIso())
  }

  authenticate(token: string): ApiTokenRecord | undefined {
    this.assertOpen()
    const row = this.db.prepare('SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL')
      .get(tokenHash(token)) as SqlRow | undefined
    if (row === undefined) return undefined
    const usedAt = nowIso()
    this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(usedAt, String(row.id))
    return rowToToken({ ...row, last_used_at: usedAt })
  }

  createApiToken(name: string, permissions: TokenPermission[]): { record: ApiTokenRecord; token: string } {
    this.assertOpen()
    const cleanName = name.trim()
    if (cleanName.length === 0 || cleanName.length > 100) throw new Error('token name must contain 1-100 characters')
    const allowed = new Set<TokenPermission>(['read', 'propose', 'write', 'admin'])
    const normalized = [...new Set(permissions)]
    if (normalized.length === 0 || normalized.some(permission => !allowed.has(permission))) {
      throw new Error('token permissions must contain read, propose, write, or admin')
    }
    const token = `dshk_${randomBytes(32).toString('base64url')}`
    const record: ApiTokenRecord = { id: newId(), name: cleanName, permissions: normalized, createdAt: nowIso() }
    this.db.prepare(`INSERT INTO api_tokens(id,name,token_hash,permissions_json,created_at) VALUES(?,?,?,?,?)`)
      .run(record.id, record.name, tokenHash(token), JSON.stringify(record.permissions), record.createdAt)
    return { record, token }
  }

  listApiTokens(): ApiTokenRecord[] {
    this.assertOpen()
    return (this.db.prepare('SELECT * FROM api_tokens ORDER BY created_at DESC').all() as SqlRow[]).map(rowToToken)
  }

  revokeApiToken(id: string): void {
    this.assertOpen()
    const result = this.db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), id)
    if (result.changes === 0) throw notFound('API token', id)
  }

  deleteApiToken(id: string): void {
    this.assertOpen()
    const row = this.db.prepare('SELECT revoked_at FROM api_tokens WHERE id = ?').get(id) as SqlRow | undefined
    if (row === undefined) throw notFound('API token', id)
    if (row.revoked_at === null) throw conflict('only revoked API tokens can be deleted')
    this.db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id)
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.documentsReady
    this.closed = true
    this.db.close()
  }

  private writeVersion(entry: KnowledgeEntry, changeKind: KnowledgeVersion['changeKind']): void {
    const snapshot: KnowledgeVersion['snapshot'] = {
      knowledgeBaseId: entry.knowledgeBaseId,
      title: entry.title,
      body: entry.body,
      type: entry.type,
      tags: entry.tags,
      scope: entry.scope,
      confidence: entry.confidence,
      ...entry.source === undefined ? {} : { source: entry.source },
      status: entry.status,
      documentState: entry.documentState,
      ...entry.finalizedAt === undefined ? {} : { finalizedAt: entry.finalizedAt },
      ...entry.finalizationNote === undefined ? {} : { finalizationNote: entry.finalizationNote },
    }
    this.db.prepare(`INSERT INTO knowledge_versions(id,knowledge_id,version,snapshot_json,change_kind,created_at) VALUES(?,?,?,?,?,?)`)
      .run(newId(), entry.id, entry.version, JSON.stringify(snapshot), changeKind, nowIso())
  }

  private upsertFts(entry: KnowledgeEntry): void {
    this.db.prepare('DELETE FROM knowledge_fts WHERE knowledge_id = ?').run(entry.id)
    if (entry.status === 'active') {
      this.db.prepare('INSERT INTO knowledge_fts(knowledge_id,title,body,tags) VALUES(?,?,?,?)')
        .run(entry.id, entry.title, entry.body, entry.tags.join(' '))
    }
  }

  private async syncAllDocuments(): Promise<void> {
    await this.documentStore.initialize()
    const bases = this.db.prepare('SELECT id FROM knowledge_bases').all() as SqlRow[]
    for (const base of bases) await this.syncKnowledgeDocuments(String(base.id))
  }

  private async syncKnowledgeDocuments(knowledgeBaseId: string): Promise<void> {
    const baseRow = this.db.prepare('SELECT * FROM knowledge_bases WHERE id=?').get(knowledgeBaseId) as SqlRow | undefined
    if (baseRow === undefined) return
    const base = rowToKnowledgeBase(baseRow)
    const directory = await this.documentStore.ensureBase(base)
    const entries = (this.db.prepare(`
      SELECT ${ENTRY_COLUMNS} FROM knowledge_entries
      WHERE knowledge_base_id=? AND status='active'
      ORDER BY updated_at DESC, id
    `).all(knowledgeBaseId) as SqlRow[]).map(rowToEntry)
    const desired = new Map<string, { entry: KnowledgeEntry; relPath: string; content: string; contentHash: string }>()
    for (const entry of entries) {
      const relPath = knowledgeDocumentPath(entry)
      const markdown = renderKnowledgeMarkdown({
        metadata: {
          id: entry.id,
          type: entry.type,
          tags: entry.tags,
          scope: entry.scope,
          confidence: entry.confidence,
          status: entry.status,
          documentState: entry.documentState,
          ...entry.finalizedAt === undefined ? {} : { finalizedAt: entry.finalizedAt },
          ...entry.finalizationNote === undefined ? {} : { finalizationNote: entry.finalizationNote },
        },
        title: entry.title,
        body: entry.body,
      })
      const stored = await this.documentStore.writeDocument(directory, relPath, markdown)
      desired.set(entry.id, {
        entry,
        relPath,
        content: `# ${markdownHeading(entry.title)}\n\n${entry.body.trim()}\n`,
        contentHash: stored.contentHash,
      })
    }
    const storedDocuments = await this.documentStore.listDocuments(directory)
    for (const document of storedDocuments) {
      const expected = desired.get(document.metadata.id)
      if (expected === undefined || expected.relPath !== document.relPath) {
        await this.documentStore.deleteDocument(directory, document.relPath, document.contentHash)
      }
    }
    const existing = this.db.prepare('SELECT id,rel_path,created_at FROM knowledge_documents WHERE knowledge_base_id=?')
      .all(knowledgeBaseId) as SqlRow[]
    for (const document of desired.values()) {
      this.db.prepare(`
        INSERT INTO knowledge_documents(
          id,knowledge_base_id,rel_path,title,content,entry_count,content_hash,
          document_state,finalized_at,finalization_note,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          knowledge_base_id=excluded.knowledge_base_id,rel_path=excluded.rel_path,
          title=excluded.title,content=excluded.content,entry_count=excluded.entry_count,
          content_hash=excluded.content_hash,document_state=excluded.document_state,
          finalized_at=excluded.finalized_at,finalization_note=excluded.finalization_note,
          updated_at=excluded.updated_at
        WHERE knowledge_documents.content_hash<>excluded.content_hash
           OR knowledge_documents.rel_path<>excluded.rel_path
           OR knowledge_documents.title<>excluded.title
           OR knowledge_documents.entry_count<>excluded.entry_count
           OR knowledge_documents.document_state<>excluded.document_state
           OR knowledge_documents.finalized_at IS NOT excluded.finalized_at
           OR knowledge_documents.finalization_note IS NOT excluded.finalization_note
      `).run(
        document.entry.id, knowledgeBaseId, document.relPath,
        document.entry.title, document.content, 1, document.contentHash,
        document.entry.documentState, document.entry.finalizedAt ?? null, document.entry.finalizationNote ?? null,
        document.entry.createdAt, document.entry.updatedAt,
      )
    }
    for (const row of existing) {
      if (!desired.has(String(row.id))) this.db.prepare('DELETE FROM knowledge_documents WHERE id=?').run(String(row.id))
    }
  }
}

function markdownHeading(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/^#+\s*/, '').trim()
}

function rowToEntry(row: SqlRow): KnowledgeEntry {
  const source = row.source_json == null ? undefined : JSON.parse(String(row.source_json)) as KnowledgeDraft['source']
  return {
    id: String(row.id),
    knowledgeBaseId: row.knowledge_base_id == null ? DEFAULT_KNOWLEDGE_BASE_ID : String(row.knowledge_base_id),
    title: String(row.title),
    body: String(row.body),
    type: String(row.type) as KnowledgeEntry['type'],
    tags: JSON.parse(String(row.tags_json)) as string[],
    scope: String(row.scope_kind) === 'global'
      ? { kind: 'global' }
      : { kind: 'project', id: String(row.scope_id) },
    confidence: Number(row.confidence),
    status: String(row.status) as KnowledgeStatus,
    documentState: row.document_state == null ? 'open' : String(row.document_state) as KnowledgeEntry['documentState'],
    ...row.finalized_at == null ? {} : { finalizedAt: String(row.finalized_at) },
    ...row.finalization_note == null ? {} : { finalizationNote: String(row.finalization_note) },
    version: Number(row.version),
    ...source === undefined ? {} : { source },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function rowToDocument(row: SqlRow): KnowledgeDocument {
  return {
    id: String(row.id),
    knowledgeBaseId: String(row.knowledge_base_id),
    relPath: String(row.rel_path),
    title: String(row.title),
    content: String(row.content),
    entryCount: Number(row.entry_count),
    contentHash: String(row.content_hash),
    documentState: row.document_state == null ? 'open' : String(row.document_state) as KnowledgeDocument['documentState'],
    ...row.finalized_at == null ? {} : { finalizedAt: String(row.finalized_at) },
    ...row.finalization_note == null ? {} : { finalizationNote: String(row.finalization_note) },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function rowToVersion(row: SqlRow): KnowledgeVersion {
  const snapshot = JSON.parse(String(row.snapshot_json)) as KnowledgeVersion['snapshot']
  if (snapshot.knowledgeBaseId === undefined) snapshot.knowledgeBaseId = DEFAULT_KNOWLEDGE_BASE_ID
  if (snapshot.documentState === undefined) snapshot.documentState = 'open'
  return {
    id: String(row.id),
    knowledgeId: String(row.knowledge_id),
    version: Number(row.version),
    snapshot,
    changeKind: String(row.change_kind) as KnowledgeVersion['changeKind'],
    createdAt: String(row.created_at),
  }
}

function rowToCandidate(row: SqlRow): KnowledgeCandidate {
  const targetId = row.target_id == null ? undefined : String(row.target_id)
  const sourceKey = row.source_key == null ? undefined : String(row.source_key)
  const reviewedAt = row.reviewed_at == null ? undefined : String(row.reviewed_at)
  const reviewNote = row.review_note == null ? undefined : String(row.review_note)
  const draft = JSON.parse(String(row.draft_json)) as KnowledgeDraft
  if (draft.knowledgeBaseId === undefined) draft.knowledgeBaseId = DEFAULT_KNOWLEDGE_BASE_ID
  return {
    id: String(row.id),
    action: String(row.action) as KnowledgeCandidate['action'],
    ...targetId === undefined ? {} : { targetId },
    draft,
    reason: String(row.reason),
    status: String(row.status) as KnowledgeCandidate['status'],
    ...sourceKey === undefined ? {} : { sourceKey },
    createdAt: String(row.created_at),
    ...reviewedAt === undefined ? {} : { reviewedAt },
    ...reviewNote === undefined ? {} : { reviewNote },
  }
}

type DirectProposalResolution =
  | { outcome: 'duplicate'; entry?: KnowledgeEntry }
  | { outcome: 'finalized'; entry: KnowledgeEntry }
  | { outcome: 'created' | 'merged' | 'conflict'; proposal: CandidateProposal }

function normalizeProposal(input: CandidateProposal): CandidateProposal {
  const proposal: CandidateProposal = {
    action: input.action,
    ...input.targetId === undefined ? {} : { targetId: input.targetId },
    draft: normalizeDraft(input.draft),
    reason: input.reason.trim().slice(0, 2000),
  }
  if (proposal.action !== 'create' && proposal.targetId === undefined) {
    throw new Error(`${proposal.action} candidate requires targetId`)
  }
  return proposal
}

function mergeKnowledgeDraft(current: KnowledgeEntry, incoming: KnowledgeDraft, preferIncomingTitle: boolean): KnowledgeDraft {
  return normalizeDraft({
    knowledgeBaseId: current.knowledgeBaseId,
    title: preferIncomingTitle ? incoming.title : current.title,
    body: mergeKnowledgeBodies(current.body, incoming.body),
    type: current.type,
    tags: [...current.tags, ...incoming.tags],
    scope: current.scope,
    confidence: Math.max(current.confidence, incoming.confidence),
    ...incoming.source === undefined
      ? current.source === undefined ? {} : { source: current.source }
      : { source: incoming.source },
  })
}

function potentiallyConflicts(current: KnowledgeEntry, incoming: KnowledgeDraft): boolean {
  if (current.type !== incoming.type) return true
  const currentBody = normalizedBody(current.body)
  const incomingBody = normalizedBody(incoming.body)
  if (currentBody === incomingBody || currentBody.includes(incomingBody) || incomingBody.includes(currentBody)) return false
  if (addsDistinctMarkdownSections(current.body, incoming.body)) return false
  const overlap = termOverlap(currentBody, incomingBody)
  if (overlap < 0.35) return false
  const currentPolarity = polarity(currentBody)
  const incomingPolarity = polarity(incomingBody)
  if (currentPolarity !== 0 && incomingPolarity !== 0 && currentPolarity !== incomingPolarity) return true
  const currentValues = factualValues(currentBody)
  const incomingValues = factualValues(incomingBody)
  return currentValues.length > 0 && incomingValues.length > 0
    && !currentValues.some(value => incomingValues.includes(value))
}

function addsDistinctMarkdownSections(current: string, incoming: string): boolean {
  const currentHeadings = markdownHeadings(current)
  const incomingHeadings = markdownHeadings(incoming)
  if (currentHeadings.size === 0 || incomingHeadings.size === 0) return false
  return [...incomingHeadings].every(heading => !currentHeadings.has(heading))
}

function markdownHeadings(value: string): Set<string> {
  return new Set([...value.matchAll(/^#{1,6}\s+(.+)$/gmu)]
    .map(match => normalizedTitle(match[1] ?? ''))
    .filter(Boolean))
}

function normalizedTitle(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
}

function normalizedBody(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim()
}

function sharesCanonicalTopicReference(current: KnowledgeEntry, incoming: KnowledgeDraft): boolean {
  const currentReferences = canonicalTopicReferences(`${current.title}\n${current.body}`)
  if (currentReferences.size === 0) return false
  return [...canonicalTopicReferences(`${incoming.title}\n${incoming.body}`)]
    .some(reference => currentReferences.has(reference))
}

function canonicalTopicReferences(value: string): Set<string> {
  const references = new Set<string>()
  for (const match of value.matchAll(/https?:\/\/(?:www\.)?github\.com\/([^\s/?#]+)\/([^\s/?#]+)/giu)) {
    const owner = match[1]?.toLocaleLowerCase()
    const repository = match[2]?.replace(/\.git$/iu, '').replace(/[.,，。;；:：!?！？]+$/u, '').toLocaleLowerCase()
    if (owner && repository) references.add(`github:${owner}/${repository}`)
  }
  return references
}

function sameScope(left: KnowledgeDraft['scope'], right: KnowledgeDraft['scope']): boolean {
  return left.kind === right.kind && (left.kind === 'global' || left.id === (right as { kind: 'project'; id: string }).id)
}

function semanticTerms(value: string): Set<string> {
  const terms = new Set(value.match(/[a-z0-9][a-z0-9_.:/-]*/giu)?.map(term => term.toLocaleLowerCase()) ?? [])
  for (const sequence of value.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...sequence]
    for (let index = 0; index < chars.length - 1; index += 1) terms.add(`${chars[index]}${chars[index + 1]}`)
  }
  return terms
}

function termOverlap(left: string, right: string): number {
  const leftTerms = semanticTerms(left)
  const rightTerms = semanticTerms(right)
  const denominator = Math.min(leftTerms.size, rightTerms.size)
  if (denominator === 0) return 0
  let common = 0
  for (const term of leftTerms) if (rightTerms.has(term)) common += 1
  return common / denominator
}

function polarity(value: string): -1 | 0 | 1 {
  const positive = /(?:\b(?:enable|enabled|allow|allowed|true|yes|must|should|use)\b|启用|允许|必须|应该|可以|使用)/iu.test(value)
  const negative = /(?:\b(?:disable|disabled|deny|denied|false|no|never|must not|should not|do not|don't)\b|禁用|禁止|不得|不应|不可以|不要|不能|关闭|无需)/iu.test(value)
  return positive === negative ? 0 : positive ? 1 : -1
}

function factualValues(value: string): string[] {
  return [...new Set(value.match(/\b(?:v?\d+(?:\.\d+){0,3}|true|false|enabled|disabled)\b/giu)?.map(item => item.toLocaleLowerCase()) ?? [])]
}

function rowToKnowledgeBase(row: SqlRow): KnowledgeBase {
  const writebackProvider = row.writeback_provider == null ? undefined : String(row.writeback_provider)
  const writebackModel = row.writeback_model == null ? undefined : String(row.writeback_model)
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    defaultTags: JSON.parse(String(row.default_tags_json)) as string[],
    extractionInstructions: String(row.extraction_instructions),
    writebackPolicy: String(row.writeback_policy) as KnowledgeBase['writebackPolicy'],
    ...writebackProvider === undefined || writebackModel === undefined ? {} : { writebackProvider, writebackModel },
    status: String(row.status) as KnowledgeBase['status'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function rowToMount(row: SqlRow): KnowledgeMount {
  return {
    id: String(row.id),
    targetKind: String(row.target_kind) as KnowledgeMount['targetKind'],
    targetId: String(row.target_id),
    knowledgeBaseId: String(row.knowledge_base_id),
    enabled: Number(row.enabled) === 1,
    recallEnabled: Number(row.recall_enabled) === 1,
    writeMode: String(row.write_mode) as KnowledgeMount['writeMode'],
    includeTags: JSON.parse(String(row.include_tags_json)) as string[],
    excludeTags: JSON.parse(String(row.exclude_tags_json)) as string[],
    extractionInstructions: String(row.extraction_instructions),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function rowToExtractionJob(row: SqlRow): ExtractionJobRecord {
  const lastError = row.last_error == null ? undefined : String(row.last_error)
  return {
    sourceKey: String(row.source_key),
    status: String(row.status) as ExtractionJobRecord['status'],
    attempts: Number(row.attempts),
    candidateCount: Number(row.candidate_count),
    ...lastError === undefined ? {} : { lastError },
    updatedAt: String(row.updated_at),
  }
}

function rowToToken(row: SqlRow): ApiTokenRecord {
  const lastUsedAt = row.last_used_at == null ? undefined : String(row.last_used_at)
  const revokedAt = row.revoked_at == null ? undefined : String(row.revoked_at)
  return {
    id: String(row.id),
    name: String(row.name),
    permissions: JSON.parse(String(row.permissions_json)) as TokenPermission[],
    createdAt: String(row.created_at),
    ...lastUsedAt === undefined ? {} : { lastUsedAt },
    ...revokedAt === undefined ? {} : { revokedAt },
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function toFtsQuery(text: string): string {
  const terms = text.split(/\s+/u).map(term => term.trim()).filter(Boolean).slice(0, 20)
  return terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ')
}

function fallbackTerms(text: string): string[] {
  const terms = new Set<string>()
  for (const word of text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]{1,}/g) ?? []) terms.add(word)
  for (const sequence of text.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...sequence]
    if (chars.length === 1) terms.add(chars[0] as string)
    for (let index = 0; index < chars.length - 1; index += 1) {
      terms.add(`${chars[index]}${chars[index + 1]}`)
    }
  }
  return [...terms].slice(0, 20)
}

function relevanceScore(entry: KnowledgeEntry, query: string): number {
  const normalizedQuery = normalizedBody(query)
  if (normalizedQuery.length === 0) return 1
  const title = normalizedBody(entry.title)
  const body = normalizedBody(entry.body)
  const tags = normalizedBody(entry.tags.join(' '))
  const combined = `${title}\n${body}\n${tags}`
  if (combined.includes(normalizedQuery)) return .98
  const terms = fallbackTerms(query).filter(term => !SEARCH_STOP_TERMS.has(term))
  if (terms.length === 0) return .25
  const coverage = terms.filter(term => combined.includes(term)).length / terms.length
  const titleCoverage = terms.filter(term => title.includes(term)).length / terms.length
  const tagCoverage = terms.filter(term => tags.includes(term)).length / terms.length
  return Math.min(.97, .05 + coverage * .72 + titleCoverage * .13 + tagCoverage * .1)
}

const SEARCH_STOP_TERMS = new Set([
  'a', 'an', 'and', 'are', 'for', 'how', 'is', 'of', 'or', 'the', 'to', 'what', 'when', 'where', 'which', 'who', 'why',
  '什么', '么是', '如何', '怎么', '是否', '介绍',
])

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt, id })).toString('base64url')
}

function decodeCursor(cursor: string): { updatedAt: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>
    if (typeof value.updatedAt !== 'string' || typeof value.id !== 'string') throw new Error()
    return { updatedAt: value.updatedAt, id: value.id }
  } catch {
    throw Object.assign(new Error('invalid pagination cursor'), { code: 'BAD_REQUEST' })
  }
}

function notFound(kind: string, id: string): Error {
  return Object.assign(new Error(`${kind} "${id}" was not found`), { code: 'NOT_FOUND' })
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { code: 'CONFLICT' })
}

function finalizedConflict(entry: Pick<KnowledgeEntry, 'id' | 'title' | 'documentState'>): Error {
  const label = entry.documentState === 'resolved' ? 'resolved' : 'collection complete'
  return conflict(`knowledge document "${entry.title}" (${entry.id}) is finalized as ${label}; reopen it before making changes`)
}

function normalizeFinalizationNote(value?: string): string | undefined {
  const note = value?.trim()
  if (!note) return undefined
  if (note.length > 1000) throw new Error('finalization note must contain at most 1000 characters')
  return note
}
