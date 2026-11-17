import { randomUUID, createHash } from 'node:crypto'
import { fail } from '../domain.js'
import { normalizeEvent, object, string, integer, statuses } from './domain.js'
import { validDate, zoneName, startOfDay, localParts } from './time.js'
const canonical = value => JSON.stringify(value, (_, v) => v && !Array.isArray(v) && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v)
export class CalendarStore {
  constructor(db, timezone) {
    this.db = db; this.timezone = timezone
    db.exec(`CREATE TABLE IF NOT EXISTS calendar_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY, uid TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL,
      all_day INTEGER NOT NULL, day TEXT NOT NULL, end_day TEXT NOT NULL, start_at INTEGER, end_at INTEGER,
      status TEXT NOT NULL, deleted_at INTEGER, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS calendar_days ON calendar_events(deleted_at,day,end_day);
      CREATE INDEX IF NOT EXISTS calendar_instants ON calendar_events(deleted_at,start_at,end_at);
      CREATE TABLE IF NOT EXISTS calendar_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calendar_requests (id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);`)
    this.calendarId = db.prepare('SELECT id FROM calendar_identity LIMIT 1').get()?.id
    if (!this.calendarId) { this.calendarId = randomUUID(); db.prepare('INSERT OR IGNORE INTO calendar_identity VALUES (1,?)').run(this.calendarId); this.calendarId = db.prepare('SELECT id FROM calendar_identity WHERE singleton=1').get().id }
  }
  info() { return { calendarId: this.calendarId, protocol: 1, timeZone: this.timezone(), today: localParts(Date.now(), this.timezone()).day, cursor: this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM calendar_changes').get().n, externalSync: { connected: false, export: 'icalendar', adapters: ['google-calendar', 'caldav'], note: '本版提供日历文件导出与增量接口，尚未连接外部账号' } } }
  get(id) {
    const row = this.db.prepare('SELECT body FROM calendar_events WHERE id=?').get(string(id, 100, true))
    if (!row) throw fail('目标不存在或已被移除', 404)
    return JSON.parse(row.body)
  }
  list(query) {
    const timeZone = zoneName(query.get('timeZone') || this.timezone()), from = validDate(query.get('from')), to = validDate(query.get('to'))
    if (to <= from || Date.parse(to) - Date.parse(from) > 370 * 86400000) throw fail('查询范围须为 1—370 天，to 不含当天')
    const limit = integer(query.get('limit'), 1, 500, 200), offset = integer(query.get('offset'), 0, 100000, 0)
    const deleted = query.get('deleted') || 'exclude', status = query.get('status') || '', text = string(query.get('query') || '', 200), tag = string(query.get('tag') || '', 32)
    if (!['exclude', 'only', 'include'].includes(deleted) || status && !statuses.includes(status)) throw fail('筛选条件无效')
    const where = [`((all_day=1 AND day < ? AND end_day > ?) OR (all_day=0 AND start_at < ? AND end_at > ?))`], args = [to, from, startOfDay(to, timeZone), startOfDay(from, timeZone)]
    if (deleted !== 'include') where.push(deleted === 'only' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL')
    if (status) { where.push('status=?'); args.push(status) }
    if (text) { where.push("instr(lower(json_extract(body,'$.title') || ' ' || json_extract(body,'$.description') || ' ' || json_extract(body,'$.project')),lower(?))>0"); args.push(text) }
    if (tag) { where.push("EXISTS(SELECT 1 FROM json_each(calendar_events.body,'$.tags') WHERE value=?)"); args.push(tag) }
    const filter = where.join(' AND '), total = this.db.prepare(`SELECT count(*) AS n FROM calendar_events WHERE ${filter}`).get(...args).n
    const items = this.db.prepare(`SELECT body FROM calendar_events WHERE ${filter} ORDER BY day,all_day DESC,start_at,id LIMIT ? OFFSET ?`).all(...args, limit, offset).map(r => JSON.parse(r.body))
    return { items, total, nextOffset: offset + items.length < total ? offset + items.length : null, timeZone, from, to, cursor: this.info().cursor, calendarId: this.calendarId }
  }
  changes(query) {
    const after = integer(query.get('after'), 0, Number.MAX_SAFE_INTEGER, 0), limit = integer(query.get('limit'), 1, 500, 100), latest = this.info().cursor
    if (after > 0 && query.get('calendarId') !== this.calendarId) throw fail('同步游标缺少匹配的 calendarId，请重新读取日历信息', 409)
    if (after > latest) throw fail('同步游标不属于当前数据库，请重新全量读取', 409)
    const rows = this.db.prepare('SELECT seq,body FROM calendar_changes WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit)
    return { calendarId: this.calendarId, protocol: 1, changes: rows.map(r => ({ cursor: r.seq, event: JSON.parse(r.body) })), nextCursor: rows.at(-1)?.seq ?? after, hasMore: (rows.at(-1)?.seq ?? after) < latest }
  }
  mutate(action, data, now = Date.now()) {
    object(data, action === 'create' ? ['requestId', 'calendarId', 'event'] : action === 'update' ? ['requestId', 'calendarId', 'id', 'revision', 'patch'] : ['requestId', 'calendarId', 'id', 'revision'])
    if (data.calendarId !== undefined && data.calendarId !== this.calendarId) throw fail('日历连接已改变，请重新加载后操作', 409)
    const requestId = string(data.requestId, 128, true), fingerprint = createHash('sha256').update(canonical({ action, data })).digest('hex')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const prior = this.db.prepare('SELECT fingerprint,result FROM calendar_requests WHERE id=?').get(requestId)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw fail('同一 requestId 不能用于不同操作；原操作未被覆盖', 409)
        this.db.exec('COMMIT'); return { ...JSON.parse(prior.result), replayed: true }
      }
      let event
      if (action === 'create') {
        if (this.db.prepare('SELECT count(*) AS n FROM calendar_events').get().n >= 100000) throw fail('日历条目已达上限，请先导出整理', 409)
        event = { ...normalizeEvent(data.event, this.timezone()), id: randomUUID(), uid: randomUUID() + '@dsh-knowledge', revision: 1, createdAt: now, updatedAt: now, deletedAt: null, completedAt: null }
      } else {
        const previous = this.get(data.id), revision = integer(data.revision, 1, Number.MAX_SAFE_INTEGER)
        if (previous.revision !== revision) throw fail('目标已被其他操作更新，请重新读取后再修改', 409)
        if (action !== 'restore' && previous.deletedAt !== null) throw fail('目标已删除，请先恢复', 409)
        if (action === 'restore' && previous.deletedAt === null) throw fail('目标尚未删除，无需恢复', 409)
        if (!['update', 'delete', 'restore'].includes(action)) throw fail('不支持的日历操作')
        event = { ...previous, ...(action === 'update' ? normalizeEvent(data.patch, this.timezone(), previous) : {}), revision: revision + 1, updatedAt: Math.max(now, previous.updatedAt + 1), deletedAt: action === 'delete' ? now : null }
      }
      event.completedAt = event.status === 'done' ? event.completedAt ?? now : null
      this.db.prepare(`INSERT INTO calendar_events VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,all_day=excluded.all_day,day=excluded.day,end_day=excluded.end_day,start_at=excluded.start_at,end_at=excluded.end_at,status=excluded.status,deleted_at=excluded.deleted_at,body=excluded.body`).run(event.id, event.uid, event.revision, +event.allDay, event.day, event.endDay, event.startAt, event.endAt, event.status, event.deletedAt, JSON.stringify(event))
      const change = this.db.prepare('INSERT INTO calendar_changes(event_id,revision,body) VALUES (?,?,?)').run(event.id, event.revision, JSON.stringify(event))
      const result = { event, calendarId: this.calendarId, cursor: Number(change.lastInsertRowid), replayed: false }
      this.db.prepare('INSERT INTO calendar_requests VALUES (?,?,?)').run(requestId, fingerprint, JSON.stringify(result))
      this.db.exec('COMMIT'); return result
    } catch (e) { try { this.db.exec('ROLLBACK') } catch {} throw e }
  }
}
