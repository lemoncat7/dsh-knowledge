import { dirname } from 'node:path'
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
  nowIso,
  type CandidateProposal,
  type ApiTokenRecord,
  type ExtractionJobRecord,
  type KnowledgeCandidate,
  type KnowledgeBase,
  type KnowledgeBaseDraft,
  type KnowledgeDraft,
  type KnowledgeEntry,
  type KnowledgeStatus,
  type KnowledgeStats,
  type KnowledgeVersion,
  type KnowledgeMount,
  type KnowledgeMountDraft,
  type KnowledgeMountTargetKind,
  type ResolvedKnowledgeMount,
  type ListRequest,
  type ListResult,
  type ReviewDecision,
  type SearchHit,
  type SearchRequest,
  type TokenPermission,
} from './domain.js'
import type { KnowledgeProvider } from './provider.js'

type SqlRow = Record<string, unknown>

const ENTRY_COLUMNS = `
  id, knowledge_base_id, title, body, type, tags_json, scope_kind, scope_id, confidence,
  status, version, source_json, created_at, updated_at
`

const JOINED_ENTRY_COLUMNS = `
  e.id AS id, e.knowledge_base_id AS knowledge_base_id, e.title AS title, e.body AS body, e.type AS type,
  e.tags_json AS tags_json, e.scope_kind AS scope_kind, e.scope_id AS scope_id,
  e.confidence AS confidence, e.status AS status, e.version AS version,
  e.source_json AS source_json, e.created_at AS created_at, e.updated_at AS updated_at
`

export class LocalKnowledgeProvider implements KnowledgeProvider {
  readonly mode = 'local' as const
  private readonly db: DatabaseSync
  private closed = false

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.migrate()
  }

  private migrate(): void {
    let version = Number((this.db.prepare('PRAGMA user_version').get() as SqlRow).user_version ?? 0)
    if (version > 2) throw new Error(`knowledge database schema ${version} is newer than this plugin supports`)
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
        'default','默认知识库','由 0.2 版本迁移的知识。','[]','仅收录可跨会话复用、且与当前挂载范围相关的知识。','active',datetime('now'),datetime('now')
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
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('knowledge provider is closed')
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
    const draft = normalizeKnowledgeBaseDraft(input)
    const timestamp = nowIso()
    const base: KnowledgeBase = { ...draft, id: newId(), status: 'active', createdAt: timestamp, updatedAt: timestamp }
    this.db.prepare(`
      INSERT INTO knowledge_bases(id,name,description,default_tags_json,extraction_instructions,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'active',?,?)
    `).run(base.id, base.name, base.description, JSON.stringify(base.defaultTags), base.extractionInstructions, timestamp, timestamp)
    return base
  }

  async updateKnowledgeBase(id: string, input: KnowledgeBaseDraft): Promise<KnowledgeBase> {
    this.assertOpen()
    const current = await this.getKnowledgeBase(id)
    if (current === undefined) throw notFound('knowledge base', id)
    const draft = normalizeKnowledgeBaseDraft(input)
    const updated: KnowledgeBase = { ...current, ...draft, status: 'active', updatedAt: nowIso() }
    this.db.prepare(`
      UPDATE knowledge_bases SET name=?,description=?,default_tags_json=?,extraction_instructions=?,status='active',updated_at=? WHERE id=?
    `).run(updated.name, updated.description, JSON.stringify(updated.defaultTags), updated.extractionInstructions, updated.updatedAt, id)
    return updated
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
    const draft = normalizeKnowledgeMountDraft(input)
    const base = await this.getKnowledgeBase(draft.knowledgeBaseId)
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
    return rows.map(row => ({ entry: rowToEntry(row), score: rankToScore(Number(row.rank ?? 0)) }))
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
    return this.transaction(() => this.insertEntry(draft))
  }

  private insertEntry(input: KnowledgeDraft): KnowledgeEntry {
    const draft = normalizeDraft(input)
    if (this.db.prepare("SELECT id FROM knowledge_bases WHERE id=? AND status='active'").get(draft.knowledgeBaseId) === undefined) {
      throw notFound('active knowledge base', draft.knowledgeBaseId)
    }
    const id = newId()
    const timestamp = nowIso()
    const entry: KnowledgeEntry = { ...draft, id, status: 'active', version: 1, createdAt: timestamp, updatedAt: timestamp }
    this.db.prepare(`
      INSERT INTO knowledge_entries (
        id,knowledge_base_id,title,body,type,tags_json,scope_kind,scope_id,confidence,status,version,content_hash,source_json,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
    return this.transaction(() => this.updateEntry(id, draft, 'update'))
  }

  private updateEntry(id: string, input: KnowledgeDraft, changeKind: 'update' | 'restore'): KnowledgeEntry {
    const currentRow = this.db.prepare(`SELECT ${ENTRY_COLUMNS} FROM knowledge_entries WHERE id = ?`).get(id) as SqlRow | undefined
    if (currentRow === undefined) throw notFound('knowledge entry', id)
    const current = rowToEntry(currentRow)
    const draft = normalizeDraft(input)
    if (this.db.prepare("SELECT id FROM knowledge_bases WHERE id=? AND status='active'").get(draft.knowledgeBaseId) === undefined) {
      throw notFound('active knowledge base', draft.knowledgeBaseId)
    }
    const timestamp = nowIso()
    const entry: KnowledgeEntry = {
      ...draft,
      id,
      status: 'active',
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
    return this.transaction(() => {
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
  }

  async delete(id: string): Promise<void> {
    this.assertOpen()
    this.transaction(() => {
      this.db.prepare('DELETE FROM knowledge_fts WHERE knowledge_id = ?').run(id)
      const result = this.db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(id)
      if (result.changes === 0) throw notFound('knowledge entry', id)
    })
  }

  async propose(input: CandidateProposal, sourceKey?: string): Promise<KnowledgeCandidate> {
    this.assertOpen()
    const proposal: CandidateProposal = {
      action: input.action,
      ...input.targetId === undefined ? {} : { targetId: input.targetId },
      draft: normalizeDraft(input.draft),
      reason: input.reason.trim().slice(0, 2000),
    }
    if (proposal.action !== 'create' && proposal.targetId === undefined) {
      throw new Error(`${proposal.action} candidate requires targetId`)
    }
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

  async listCandidates(status: 'pending' | 'approved' | 'rejected', limit: number): Promise<KnowledgeCandidate[]> {
    this.assertOpen()
    return (this.db.prepare('SELECT * FROM knowledge_candidates WHERE status = ? ORDER BY created_at DESC LIMIT ?')
      .all(status, Math.max(1, Math.min(limit, 100))) as SqlRow[]).map(rowToCandidate)
  }

  async review(id: string, decision: ReviewDecision): Promise<KnowledgeCandidate> {
    this.assertOpen()
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM knowledge_candidates WHERE id = ?').get(id) as SqlRow | undefined
      if (row === undefined) throw notFound('knowledge candidate', id)
      const candidate = rowToCandidate(row)
      if (candidate.status !== 'pending') throw conflict(`candidate ${id} was already ${candidate.status}`)
      let draft = decision.draft === undefined ? candidate.draft : normalizeDraft(decision.draft)
      if (decision.decision === 'approve') {
        if (candidate.action === 'create') {
          this.insertEntry(draft)
        } else {
          if (candidate.targetId === undefined) throw new Error('candidate target is missing')
          const target = this.db.prepare(`SELECT ${ENTRY_COLUMNS} FROM knowledge_entries WHERE id = ?`).get(candidate.targetId) as SqlRow | undefined
          if (target === undefined) throw notFound('candidate target', candidate.targetId)
          if (decision.draft === undefined) draft = candidate.draft
          this.updateEntry(candidate.targetId, draft, 'update')
        }
      }
      const status = decision.decision === 'approve' ? 'approved' : 'rejected'
      const reviewedAt = nowIso()
      const note = decision.note?.trim().slice(0, 2000)
      this.db.prepare('UPDATE knowledge_candidates SET status=?, reviewed_at=?, review_note=? WHERE id=?')
        .run(status, reviewedAt, note ?? null, id)
      return { ...candidate, status, reviewedAt, ...note === undefined ? {} : { reviewNote: note } }
    })
  }

  async claimExtraction(sourceKey: string): Promise<boolean> {
    this.assertOpen()
    const result = this.db.prepare(`
      INSERT INTO extraction_jobs(source_key,status,attempts,candidate_count,updated_at)
      VALUES(?,'running',1,0,?) ON CONFLICT(source_key) DO NOTHING
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

  async close(): Promise<void> {
    if (this.closed) return
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
    version: Number(row.version),
    ...source === undefined ? {} : { source },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function rowToVersion(row: SqlRow): KnowledgeVersion {
  const snapshot = JSON.parse(String(row.snapshot_json)) as KnowledgeVersion['snapshot']
  if (snapshot.knowledgeBaseId === undefined) snapshot.knowledgeBaseId = DEFAULT_KNOWLEDGE_BASE_ID
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

function rowToKnowledgeBase(row: SqlRow): KnowledgeBase {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    defaultTags: JSON.parse(String(row.default_tags_json)) as string[],
    extractionInstructions: String(row.extraction_instructions),
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

function rankToScore(rank: number): number {
  return 1 / (1 + Math.max(0, rank))
}

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
