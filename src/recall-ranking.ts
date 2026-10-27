import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { SearchHit } from './domain.js'
import { recallScoreColumns, recallScoreSql, recallScoreTotal, type RecallScoreBreakdown } from './recall-score.js'

export interface RecallUsage {
  sessionId: string
  turn: string
  projectId?: string
  kind: 'auto' | 'search' | 'read'
  ids: string[]
}
export interface RecallRankQuery { days?: number; base?: string; query?: string; sort?: string; cursor?: string; limit?: number }
export interface RecallPreference { priority: number; frictionOverride: number | null; revision: number }
export interface RecallRankRow extends RecallPreference {
  id: string; title: string; knowledgeBaseId: string; baseName: string; documentState: string
  recalls: number; reads: number; sessions: number; auto: number; searches: number; lastRecall: number | null
  friction: number; automaticFriction: number; incidents: number
  score: number; scoreBreakdown: RecallScoreBreakdown
}
export interface RecallRankPage { items: RecallRankRow[]; total: number; startedAt: number; nextCursor?: string; asOf: number; incidentDocuments: number }
export interface RecallPreferencePatch { priority?: number; frictionOverride?: number | null; revision: number; reason?: string }
export interface FrictionInput { requestId: string; reason: string; severity: number }
type Row = Record<string, unknown>
const DAY = 86400000
const bad = (message: string, status = 400) => Object.assign(new Error(message), { status })
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export function validateUsage(value: RecallUsage): void {
  if (!value || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 256
    || typeof value.turn !== 'string' || !value.turn || value.turn.length > 128
    || !['auto', 'search', 'read'].includes(value.kind) || !Array.isArray(value.ids) || !value.ids.length || value.ids.length > 20
    || value.ids.some(id => typeof id !== 'string' || !id || id.length > 256)
    || (value.projectId !== undefined && (typeof value.projectId !== 'string' || value.projectId.length > 4096))) throw bad('召回统计参数无效')
}

// Relevance bands are primary. Preferences can only reorder similarly relevant
// documents; the original score remains untouched for the admission threshold.
export function compareRecallHits(a: SearchHit, b: SearchHit): number {
  return Math.floor(b.score * 20) - Math.floor(a.score * 20)
    || (b.rankScore ?? b.score) - (a.rankScore ?? a.score)
    || b.score - a.score || b.entry.updatedAt.localeCompare(a.entry.updatedAt) || a.entry.id.localeCompare(b.entry.id)
}

export class RecallRankingStore {
  constructor(private readonly db: DatabaseSync) {
    // Additive side tables, like writeback receipts: old code can safely ignore them.
    db.exec(`
      CREATE TABLE IF NOT EXISTS recall_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recall_preferences(entry_id TEXT PRIMARY KEY REFERENCES knowledge_entries(id) ON DELETE CASCADE,priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN -2 AND 2),friction_override REAL CHECK(friction_override BETWEEN 0 AND 100),revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS recall_events(entry_id TEXT NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,session_key TEXT NOT NULL,turn_key TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('recall','read')),automatic INTEGER NOT NULL,searched INTEGER NOT NULL,at INTEGER NOT NULL,UNIQUE(entry_id,turn_key,kind));
      CREATE INDEX IF NOT EXISTS recall_events_entry_time ON recall_events(entry_id,at,kind);
      CREATE TABLE IF NOT EXISTS recall_friction(id TEXT PRIMARY KEY,entry_id TEXT NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,request_id TEXT NOT NULL,reason TEXT NOT NULL,severity INTEGER NOT NULL,at INTEGER NOT NULL,retracted_at INTEGER,retract_reason TEXT,UNIQUE(entry_id,request_id));
      CREATE INDEX IF NOT EXISTS recall_friction_entry ON recall_friction(entry_id,retracted_at);
      CREATE TABLE IF NOT EXISTS recall_audit(entry_id TEXT NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,kind TEXT NOT NULL,reason TEXT NOT NULL,value_json TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS recall_audit_entry ON recall_audit(entry_id);
    `)
    db.prepare("INSERT OR IGNORE INTO recall_meta(key,value) VALUES('started_at',?)").run(String(Date.now()))
  }

  record(value: RecallUsage, namespace = 'local', at = Date.now()): void {
    validateUsage(value)
    const session = hash(JSON.stringify([namespace, value.sessionId]))
    const event = hash(JSON.stringify([session, value.turn]))
    const insert = this.db.prepare(`INSERT INTO recall_events(entry_id,session_key,turn_key,kind,automatic,searched,at)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM knowledge_entries WHERE id=? AND status='active')
      ON CONFLICT(entry_id,turn_key,kind) DO UPDATE SET automatic=max(automatic,excluded.automatic),searched=max(searched,excluded.searched)`)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const id of new Set(value.ids)) insert.run(id, session, event, value.kind === 'read' ? 'read' : 'recall', +(value.kind === 'auto'), +(value.kind === 'search'), at, id)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private entry(id: string): Row {
    const row = this.db.prepare(`SELECT e.id,e.title,e.knowledge_base_id,e.document_state FROM knowledge_entries e
      JOIN knowledge_bases b ON b.id=e.knowledge_base_id WHERE e.id=? AND e.status='active' AND b.status='active'`).get(id) as Row | undefined
    if (!row) throw bad('知识文档不存在或已归档', 404)
    return row
  }

  private preference(id: string): RecallPreference {
    const row = this.db.prepare('SELECT * FROM recall_preferences WHERE entry_id=?').get(id) as Row | undefined
    return { priority: Number(row?.priority || 0), frictionOverride: row?.friction_override == null ? null : Number(row.friction_override), revision: Number(row?.revision || 0) }
  }

  patch(id: string, patch: RecallPreferencePatch): RecallPreference {
    if (!patch || !Number.isSafeInteger(patch.revision) || patch.revision < 0
      || (patch.priority !== undefined && (!Number.isInteger(patch.priority) || Math.abs(patch.priority) > 2))
      || (patch.frictionOverride !== undefined && patch.frictionOverride !== null && (!Number.isFinite(patch.frictionOverride) || patch.frictionOverride < 0 || patch.frictionOverride > 100))
      || (patch.reason !== undefined && (typeof patch.reason !== 'string' || patch.reason.length > 500))) throw bad('优先级或摩擦系数无效')
    if (patch.priority === undefined && patch.frictionOverride === undefined) throw bad('没有需要修改的召回设置')
    this.db.exec('SAVEPOINT recall_patch')
    try {
      this.entry(id)
      const current = this.preference(id)
      if (current.revision !== patch.revision) throw bad('召回设置已被修改，请刷新后重试', 409)
      if (patch.frictionOverride !== undefined && patch.frictionOverride !== current.frictionOverride && !patch.reason?.trim()) throw bad('调整摩擦系数需要填写原因')
      const next = { priority: patch.priority ?? current.priority, frictionOverride: patch.frictionOverride === undefined ? current.frictionOverride : patch.frictionOverride, revision: current.revision + 1 }
      this.db.prepare(`INSERT INTO recall_preferences(entry_id,priority,friction_override,revision) VALUES(?,?,?,?)
        ON CONFLICT(entry_id) DO UPDATE SET priority=excluded.priority,friction_override=excluded.friction_override,revision=excluded.revision`).run(id, next.priority, next.frictionOverride, next.revision)
      this.audit(id, 'preference', patch.reason?.trim() || '调整召回优先级', { before: current, after: next })
      this.db.exec('RELEASE recall_patch'); return next
    } catch (error) { this.db.exec('ROLLBACK TO recall_patch; RELEASE recall_patch'); throw error }
  }

  patchMany(items: { id: string; revision: number }[], priority: number): RecallPreference[] {
    if (!Array.isArray(items) || !items.length || items.length > 100 || items.some(item => !item || typeof item.id !== 'string') || new Set(items.map(item => item.id)).size !== items.length) throw bad('请选择 1–100 篇不同的知识文档')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const values = items.map(item => this.patch(item.id, { priority, revision: item.revision }))
      this.db.exec('COMMIT'); return values
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  incident(id: string, value: FrictionInput): { id: string } {
    if (!value || typeof value.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(value.requestId)
      || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 1000
      || ![1, 3, 6].includes(value.severity)) throw bad('请填写踩坑原因及严重程度')
    this.entry(id)
    const old = this.db.prepare('SELECT id,reason,severity FROM recall_friction WHERE entry_id=? AND request_id=?').get(id, value.requestId) as Row | undefined
    if (old) {
      if (old.reason !== value.reason.trim() || old.severity !== value.severity) throw bad('这次记录的内容已改变，请重新打开记录窗口', 409)
      return { id: String(old.id) }
    }
    const eventId = randomUUID()
    this.db.prepare('INSERT INTO recall_friction(id,entry_id,request_id,reason,severity,at) VALUES(?,?,?,?,?,?)').run(eventId, id, value.requestId, value.reason.trim(), value.severity, Date.now())
    return { id: eventId }
  }

  retract(id: string, eventId: string, reason: string): void {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw bad('请填写撤销原因')
    this.entry(id)
    const changed = this.db.prepare('UPDATE recall_friction SET retracted_at=?,retract_reason=? WHERE entry_id=? AND id=? AND retracted_at IS NULL').run(Date.now(), reason.trim(), id, eventId)
    if (!changed.changes && !this.db.prepare('SELECT 1 FROM recall_friction WHERE id=? AND entry_id=?').get(eventId, id)) throw bad('踩坑记录不存在', 404)
  }

  private audit(id: string, kind: string, reason: string, value: unknown): void {
    this.db.prepare('INSERT INTO recall_audit(entry_id,kind,reason,value_json,at) VALUES(?,?,?,?,?)').run(id, kind, reason, JSON.stringify(value), Date.now())
  }

  private friction(ids: string[], now: number): Map<string, { score: number; incidents: number }> {
    if (!ids.length) return new Map()
    // Recurrence retains a 25% prevention floor even after long periods without incidents.
    const rows = this.db.prepare(`SELECT entry_id,severity,at FROM recall_friction WHERE retracted_at IS NULL AND entry_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Row[]
    const result = new Map<string, { score: number; incidents: number }>()
    for (const row of rows) {
      const id = String(row.entry_id), current = result.get(id) || { score: 0, incidents: 0 }
      current.score += Number(row.severity) * 10 * (.25 + .75 * Math.pow(.5, Math.max(0, now - Number(row.at)) / (90 * DAY)))
      current.incidents++; result.set(id, current)
    }
    for (const value of result.values()) value.score = Math.min(100, value.score)
    return result
  }

  boost(hits: SearchHit[]): SearchHit[] {
    if (!hits.length) return hits
    const ids = hits.map(hit => hit.entry.id), marks = ids.map(() => '?').join(','), now = Date.now()
    const preferences = new Map((this.db.prepare(`SELECT * FROM recall_preferences WHERE entry_id IN (${marks})`).all(...ids) as Row[]).map(row => [String(row.entry_id), row]))
    const friction = this.friction(ids, now)
    const heat = new Map((this.db.prepare(`SELECT entry_id,count(DISTINCT session_key) AS n FROM recall_events WHERE entry_id IN (${marks}) AND at>=? GROUP BY entry_id`).all(...ids, now - 30 * DAY) as Row[]).map(row => [String(row.entry_id), Math.min(1, Math.log1p(Number(row.n)) / Math.log(21))]))
    return hits.map(hit => {
      const p = preferences.get(hit.entry.id), f = p?.friction_override == null ? friction.get(hit.entry.id)?.score || 0 : Number(p.friction_override)
      return { ...hit, rankScore: hit.score + Number(p?.priority || 0) * .008 + f / 100 * .018 + (heat.get(hit.entry.id) || 0) * .004 }
    }).sort(compareRecallHits)
  }

  list(query: RecallRankQuery = {}): RecallRankPage {
    const days = query.days ?? 30, limit = query.limit ?? 30, sort = query.sort || 'score', base = query.base || '', search = query.query?.trim() || ''
    if (![0, 7, 30].includes(days) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !['score', 'recalls', 'reads', 'friction', 'priority', 'recent'].includes(sort)
      || typeof base !== 'string' || base.length > 256 || search.length > 256) throw bad('排行筛选条件无效')
    let offset = 0, asOf = Date.now()
    if (query.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString())
        if (cursor.key !== JSON.stringify([days, sort, base, search]) || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > 1000000 || !Number.isSafeInteger(cursor.asOf) || cursor.asOf > Date.now() || cursor.asOf < Date.now() - DAY) throw 0
        offset = cursor.offset; asOf = cursor.asOf
      } catch { throw bad('排行游标已过期，请刷新') }
    }
    const since = days ? asOf - days * DAY : 0
    const where = `e.status='active' AND b.status='active'${base ? ' AND e.knowledge_base_id=?' : ''}${search ? ' AND instr(lower(e.title),lower(?))>0' : ''}`
    const args = [...(base ? [base] : []), ...(search ? [search] : [])]
    const total = Number(this.db.prepare(`SELECT count(*) AS n FROM knowledge_entries e JOIN knowledge_bases b ON b.id=e.knowledge_base_id WHERE ${where}`).get(...args)?.n || 0)
    // Scope-wide count, independent of pagination and the usage-period filter.
    // Incidents retain their prevention floor beyond the selected usage period.
    const incidentDocuments = Number(this.db.prepare(`SELECT count(*) AS n
      FROM knowledge_entries e JOIN knowledge_bases b ON b.id=e.knowledge_base_id
      WHERE ${where} AND EXISTS (SELECT 1 FROM recall_friction f WHERE f.entry_id=e.id AND f.retracted_at IS NULL AND f.at<=?)
    `).get(...args, asOf)?.n || 0)
    // SQLite computes the decayed incident sum for sorting without loading documents or event histories.
    const sql = `WITH measured AS (SELECT e.id,e.title,e.knowledge_base_id,e.document_state,b.name AS base_name,
      coalesce(p.priority,0) AS priority,p.friction_override,coalesce(p.revision,0) AS revision,
      (SELECT count(*) FROM recall_events r WHERE r.entry_id=e.id AND r.kind='recall' AND r.at BETWEEN ? AND ?) AS recalls,
      (SELECT count(*) FROM recall_events r WHERE r.entry_id=e.id AND r.kind='read' AND r.at BETWEEN ? AND ?) AS reads,
      (SELECT count(DISTINCT session_key) FROM recall_events r WHERE r.entry_id=e.id AND r.at BETWEEN ? AND ?) AS sessions,
      (SELECT coalesce(sum(automatic),0) FROM recall_events r WHERE r.entry_id=e.id AND r.at BETWEEN ? AND ?) AS automatic,
      (SELECT coalesce(sum(searched),0) FROM recall_events r WHERE r.entry_id=e.id AND r.at BETWEEN ? AND ?) AS searches,
      (SELECT max(at) FROM recall_events r WHERE r.entry_id=e.id AND r.kind='recall' AND r.at<=?) AS recent,
      (SELECT count(*) FROM recall_friction f WHERE f.entry_id=e.id AND f.retracted_at IS NULL) AS incidents,
      coalesce((SELECT min(100,sum(severity*10*(.25+.75*pow(.5,max(0,?-at)/7776000000.0)))) FROM recall_friction f WHERE f.entry_id=e.id AND f.retracted_at IS NULL),0) AS automatic_friction,
      coalesce(p.friction_override,(SELECT min(100,sum(severity*10*(.25+.75*pow(.5,max(0,?-at)/7776000000.0)))) FROM recall_friction f WHERE f.entry_id=e.id AND f.retracted_at IS NULL),0) AS friction
      FROM knowledge_entries e JOIN knowledge_bases b ON b.id=e.knowledge_base_id LEFT JOIN recall_preferences p ON p.entry_id=e.id
      WHERE ${where}), components AS (SELECT *, ${recallScoreColumns} FROM measured)
      SELECT *, ${recallScoreTotal} AS score FROM components
      ORDER BY ${sort} DESC,id ASC LIMIT ? OFFSET ?`
    const rows = this.db.prepare(sql).all(since, asOf, since, asOf, since, asOf, since, asOf, since, asOf, asOf, asOf, asOf, ...args, limit, offset) as Row[]
const items = rows.map(row => ({ id: String(row.id), title: String(row.title), knowledgeBaseId: String(row.knowledge_base_id), baseName: String(row.base_name), documentState: String(row.document_state), priority: Number(row.priority), frictionOverride: row.friction_override == null ? null : Number(row.friction_override), revision: Number(row.revision), recalls: Number(row.recalls), reads: Number(row.reads), sessions: Number(row.sessions), auto: Number(row.automatic), searches: Number(row.searches), lastRecall: row.recent == null ? null : Number(row.recent), friction: Math.round(Number(row.friction) * 10) / 10, automaticFriction: Math.round(Number(row.automatic_friction) * 10) / 10, incidents: Number(row.incidents) }))
    const scoredItems = items.map((item, index) => ({ ...item, score: Number(rows[index]!.score), scoreBreakdown: Object.fromEntries(Object.keys(recallScoreSql).map(key => [key, Number(rows[index]![key])])) as RecallScoreBreakdown }))
    const startedAt = Number(this.db.prepare("SELECT value FROM recall_meta WHERE key='started_at'").get()?.value)
    return { items: scoredItems, total, startedAt, asOf, incidentDocuments, ...(offset + items.length < total ? { nextCursor: Buffer.from(JSON.stringify({ key: JSON.stringify([days, sort, base, search]), offset: offset + items.length, asOf })).toString('base64url') } : {}) }
  }

  detail(id: string, kind = 'incidents', before = Number.MAX_SAFE_INTEGER): Record<string, unknown> {
    this.entry(id)
    if (!['incidents', 'usage', 'changes'].includes(kind) || !Number.isSafeInteger(before) || before < 1) throw bad('记录筛选条件无效')
    const table = kind === 'incidents' ? 'recall_friction' : kind === 'usage' ? 'recall_events' : 'recall_audit'
    const fields = kind === 'incidents' ? 'rowid AS cursor,id,reason,severity,at,retracted_at,retract_reason' : kind === 'usage' ? 'rowid AS cursor,kind,automatic,searched,at,substr(session_key,1,12) AS session' : 'rowid AS cursor,kind,reason,value_json,at'
    const rows = this.db.prepare(`SELECT ${fields} FROM ${table} WHERE entry_id=? AND rowid<? ORDER BY rowid DESC LIMIT 31`).all(id, before) as Row[]
    return { preference: this.preference(id), items: rows.slice(0, 30), nextCursor: rows.length > 30 ? rows[29]?.cursor : null }
  }
}
