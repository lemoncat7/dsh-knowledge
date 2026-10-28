import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { KnowledgeEntry } from './domain.js'
import { buildPassageStructure, selectKnowledgePassage, type PassageStructure } from './retrieval-passages.js'

/** Derived data only. Older plugin versions can ignore these additive tables. */
export const PASSAGE_INDEX_VERSION = 1
type Row = Record<string, unknown>
export interface RetrievalIndexScope { baseIds?: string[]; projectId?: string; scoped?: boolean; mounts?: { knowledgeBaseId: string; includeTags: string[]; excludeTags: string[] }[] }
function scopeFilter(scope: RetrievalIndexScope) {
  const clauses = ["e.status='active'", "EXISTS(SELECT 1 FROM knowledge_bases b WHERE b.id=e.knowledge_base_id AND b.status='active')"]
  const args: string[] = []
  if (scope.baseIds) {
    clauses.push(scope.baseIds.length ? `e.knowledge_base_id IN (${scope.baseIds.map(() => '?').join(',')})` : '0')
    args.push(...scope.baseIds)
  }
  if (scope.scoped) {
    clauses.push(scope.projectId ? "(e.scope_kind='global' OR (e.scope_kind='project' AND e.scope_id=?))" : "e.scope_kind='global'")
    if (scope.projectId) args.push(scope.projectId)
  }
  if (scope.mounts) {
    const policies = scope.mounts.map(mount => {
      const parts = ['e.knowledge_base_id=?']
      args.push(mount.knowledgeBaseId)
      if (mount.includeTags.length) {
        parts.push(`EXISTS(SELECT 1 FROM json_each(e.tags_json) t WHERE t.value IN (${mount.includeTags.map(() => '?').join(',')}))`)
        args.push(...mount.includeTags)
      }
      if (mount.excludeTags.length) {
        parts.push(`NOT EXISTS(SELECT 1 FROM json_each(e.tags_json) t WHERE t.value IN (${mount.excludeTags.map(() => '?').join(',')}))`)
        args.push(...mount.excludeTags)
      }
      return `(${parts.join(' AND ')})`
    })
    clauses.push(policies.length ? `(${policies.join(' OR ')})` : '0')
  }
  return { sql: clauses.join(' AND '), args }
}
export class RetrievalIndex {
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  constructor(private readonly db: DatabaseSync, private readonly build = buildPassageStructure) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_passage_index (
        entry_id TEXT PRIMARY KEY REFERENCES knowledge_entries(id) ON DELETE CASCADE,
        entry_version INTEGER NOT NULL DEFAULT 0,
        index_version INTEGER NOT NULL DEFAULT 0,
        body_hash TEXT NOT NULL DEFAULT '',
        structure_json TEXT,
        state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        indexed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS knowledge_passage_pending ON knowledge_passage_index(state,retry_at);
      CREATE TRIGGER IF NOT EXISTS knowledge_passage_insert AFTER INSERT ON knowledge_entries BEGIN
        INSERT INTO knowledge_passage_index(entry_id) VALUES(new.id);
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_passage_change AFTER UPDATE OF body,version,status ON knowledge_entries
      WHEN old.body IS NOT new.body OR old.version != new.version OR old.status != new.status BEGIN
        INSERT INTO knowledge_passage_index(entry_id) VALUES(new.id)
        ON CONFLICT(entry_id) DO UPDATE SET state='pending',attempts=0,retry_at=0,error_code=NULL;
      END;
    `)
    // Only IDs are scanned at startup. Parsing happens later in bounded batches.
    db.exec(`INSERT OR IGNORE INTO knowledge_passage_index(entry_id) SELECT id FROM knowledge_entries;`)
    db.prepare(`UPDATE knowledge_passage_index SET state='pending',attempts=0,retry_at=0
      WHERE index_version != ? AND state='ready'`).run(PASSAGE_INDEX_VERSION)
    this.schedule(100)
  }

  private schedule(delay: number): void {
    if (this.closed || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      try { this.processBatch() } catch { /* Storage may be temporarily locked. Retry outside user requests. */ }
      if (!this.closed) this.schedule(5000)
    }, delay)
    this.timer.unref()
  }

  /** No model/network calls, and no whole-library rebuild in the search path. */
  processBatch(limit = 4, now = Date.now()): number {
    if (this.closed) return 0
    const count = Number.isFinite(limit) ? Math.max(1, Math.min(20, Math.trunc(limit))) : 4
    const rows = this.db.prepare(`SELECT i.entry_id,i.attempts,e.version,e.body FROM knowledge_passage_index i
      JOIN knowledge_entries e ON e.id=i.entry_id
      WHERE e.status='active' AND i.state IN ('pending','failed') AND i.retry_at<=?
      ORDER BY i.retry_at,i.entry_id LIMIT ?`).all(now, count) as Row[]
    const started = performance.now()
    let processed = 0
    for (const row of rows) {
      if (processed && performance.now() - started > 12) break
      const id = String(row.entry_id), body = String(row.body), version = Number(row.version)
      try {
        const hash = createHash('sha256').update(body).digest('hex')
        const previous = this.db.prepare('SELECT body_hash,index_version,structure_json FROM knowledge_passage_index WHERE entry_id=?').get(id) as Row
        const json = previous.body_hash === hash && previous.index_version === PASSAGE_INDEX_VERSION && previous.structure_json
          ? String(previous.structure_json) : JSON.stringify(this.build(body))
        this.db.prepare(`UPDATE knowledge_passage_index SET entry_version=?,index_version=?,body_hash=?,structure_json=?,
          state='ready',attempts=0,retry_at=0,error_code=NULL,indexed_at=? WHERE entry_id=?
          AND EXISTS(SELECT 1 FROM knowledge_entries WHERE id=? AND version=? AND body=?)`)
          .run(version, PASSAGE_INDEX_VERSION, hash, json, now, id, id, version, body)
      } catch {
        const attempts = Number(row.attempts) + 1
        this.db.prepare(`UPDATE knowledge_passage_index SET state='failed',attempts=?,retry_at=?,error_code='INDEX_BUILD_FAILED' WHERE entry_id=?`)
          .run(attempts, now + Math.min(3_600_000, 5000 * 2 ** Math.min(attempts - 1, 10)), id)
      }
      processed++
    }
    if (processed < rows.length || rows.length === count) this.schedule(25)
    return processed
  }

  passage(entry: KnowledgeEntry, query: string) {
    try {
      const row = this.db.prepare(`SELECT structure_json FROM knowledge_passage_index
        WHERE entry_id=? AND entry_version=? AND index_version=? AND state='ready'`)
        .get(entry.id, entry.version, PASSAGE_INDEX_VERSION) as Row | undefined
      if (row?.structure_json) {
        const structure: unknown = JSON.parse(String(row.structure_json))
        if (!validStructure(structure, entry.body.length)) throw new Error('invalid derived index')
        return { passage: selectKnowledgePassage(entry.body, query, 420, structure),
          retrieval: { source: 'index' as const, indexVersion: PASSAGE_INDEX_VERSION, documentVersion: entry.version } }
      }
    } catch {
      // Corrupt derived data must not become corrupt evidence. Discard and retry.
      try { this.db.prepare(`UPDATE knowledge_passage_index SET state='pending',structure_json=NULL,retry_at=0 WHERE entry_id=?`).run(entry.id) } catch {}
    }
    return { passage: selectKnowledgePassage(entry.body, query),
      retrieval: { source: 'fallback' as const, indexVersion: PASSAGE_INDEX_VERSION, documentVersion: entry.version } }
  }

  /** Scoped metadata only. Details are paged separately from the cheap summary. */
  status(scope: RetrievalIndexScope = {}, options: { details?: boolean; state?: 'pending' | 'failed'; offset?: number } = {}) {
    const { sql, args } = scopeFilter(scope)
    const rows = this.db.prepare(`SELECT i.state,count(*) AS count FROM knowledge_passage_index i
      JOIN knowledge_entries e ON e.id=i.entry_id WHERE ${sql} GROUP BY i.state`).all(...args) as Row[]
    const counts = { ready: 0, pending: 0, failed: 0 }
    for (const row of rows) counts[row.state as keyof typeof counts] = Number(row.count)
    const failed = options.details === false ? [] : this.db.prepare(`SELECT i.entry_id AS documentId,i.entry_version AS indexedDocumentVersion,
      e.version AS currentDocumentVersion,i.attempts,i.retry_at AS retryAt,i.error_code AS errorCode
      FROM knowledge_passage_index i JOIN knowledge_entries e ON e.id=i.entry_id
      WHERE i.state='failed' AND ${sql} ORDER BY i.retry_at,i.entry_id LIMIT 20`).all(...args)
    const state = options.state ?? 'failed'
    const offset = Math.max(0, Math.trunc(options.offset ?? 0))
    const items = options.details === true ? this.db.prepare(`SELECT e.id AS documentId,e.title,e.knowledge_base_id AS knowledgeBaseId,
      e.document_group AS documentGroup,e.version AS documentVersion,i.state,i.attempts,i.retry_at AS retryAt,i.error_code AS errorCode
      FROM knowledge_passage_index i JOIN knowledge_entries e ON e.id=i.entry_id
      WHERE i.state=? AND ${sql} ORDER BY i.retry_at,i.entry_id LIMIT 30 OFFSET ?`).all(state, ...args, offset) : []
    return { indexVersion: PASSAGE_INDEX_VERSION, ...counts, total: counts.ready + counts.pending + counts.failed,
      failures: failed, items, state, offset, hasMore: offset + items.length < counts[state] }
  }

  retryFailed(scope: RetrievalIndexScope = {}, documentId?: string): number {
    const { sql, args } = scopeFilter(scope)
    const result = this.db.prepare(`UPDATE knowledge_passage_index SET state='pending',attempts=0,retry_at=0,error_code=NULL,structure_json=NULL
      WHERE state='failed' AND entry_id IN (SELECT e.id FROM knowledge_entries e WHERE ${sql}${documentId ? ' AND e.id=?' : ''})`)
      .run(...args, ...(documentId ? [documentId] : []))
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.schedule(25)
    return Number(result.changes)
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }
}

function validStructure(value: unknown, length: number): value is PassageStructure {
  if (!value || typeof value !== 'object') return false
  const structure = value as PassageStructure
  if (!Array.isArray(structure.blocks) || !Array.isArray(structure.sections)
    || !Number.isSafeInteger(structure.totalChars) || structure.totalChars < 0 || structure.totalChars > length
    || (length > 0 && structure.blocks.length === 0)) return false
  let previous = 0
  for (const block of structure.blocks) {
    if (!block || !Number.isSafeInteger(block.start) || !Number.isSafeInteger(block.end)
      || block.start < previous || block.end < block.start || block.end > length || typeof block.heading !== 'string'
      || !Number.isSafeInteger(block.offset) || block.offset < 0 || block.offset > structure.totalChars
      || !Number.isSafeInteger(block.startLine) || block.startLine < 1
      || (block.sectionId !== null && (!Number.isSafeInteger(block.sectionId) || block.sectionId < 0 || block.sectionId >= structure.sections.length))) return false
    previous = block.end
  }
  return structure.sections.every((section, id) => section && section.id === id && typeof section.heading === 'string'
    && Number.isInteger(section.level) && section.level >= 1 && section.level <= 6
    && (section.parentId === null || (Number.isInteger(section.parentId) && section.parentId >= 0 && section.parentId < id)))
}
