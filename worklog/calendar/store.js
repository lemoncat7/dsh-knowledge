import { randomUUID, createHash } from 'node:crypto'
import { fail } from '../domain.js'
import { normalizeEvent, object, string, integer, statuses } from './domain.js'
import { addDays, validDate, zoneName, startOfDay, localParts } from './time.js'
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
      CREATE TABLE IF NOT EXISTS calendar_requests (id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calendar_goal_orders (day TEXT PRIMARY KEY, revision INTEGER NOT NULL, ids TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calendar_goal_carry (day TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(day,source_id));
      CREATE TABLE IF NOT EXISTS calendar_report_notes (
        goal_id TEXT NOT NULL, day TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(goal_id,day));
      CREATE TABLE IF NOT EXISTS calendar_goal_progress (
        goal_id TEXT NOT NULL, day TEXT NOT NULL, text TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(goal_id,day));`)
    this.calendarId = db.prepare('SELECT id FROM calendar_identity LIMIT 1').get()?.id
    if (!this.calendarId) { this.calendarId = randomUUID(); db.prepare('INSERT OR IGNORE INTO calendar_identity VALUES (1,?)').run(this.calendarId); this.calendarId = db.prepare('SELECT id FROM calendar_identity WHERE singleton=1').get().id }
  }
  info() { return { calendarId: this.calendarId, protocol: 1, dailyProgress: true, progressHistory: true, calendarSettings: true, timeZone: this.timezone(), today: localParts(Date.now(), this.timezone()).day, orderCursor: this.orderCursor(), cursor: this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM calendar_changes').get().n, externalSync: { connected: false, export: 'icalendar', adapters: ['google-calendar', 'caldav'], note: '本版提供日历文件导出与增量接口，尚未连接外部账号' } } }
  orderCursor() {
    return this.db.prepare('SELECT COALESCE(MAX(revision),0) AS n FROM calendar_goal_orders').get().n
  }
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
    const items = this.db.prepare(`SELECT body FROM calendar_events WHERE ${filter} ORDER BY day,all_day DESC,start_at,rowid LIMIT ? OFFSET ?`).all(...args, limit, offset).map(r => JSON.parse(r.body))
    const goalOrders = Object.fromEntries(this.db.prepare('SELECT day,revision,ids FROM calendar_goal_orders WHERE day >= ? AND day < ?').all(from, to)
      .map(row => [row.day, { revision: row.revision, ids: JSON.parse(row.ids) }]))
    const { cursor, orderCursor } = this.info()
    return { items, goalOrders, orderCursor, total, nextOffset: offset + items.length < total ? offset + items.length : null, timeZone, from, to, cursor, calendarId: this.calendarId }
  }
  changes(query) {
    const after = integer(query.get('after'), 0, Number.MAX_SAFE_INTEGER, 0), limit = integer(query.get('limit'), 1, 500, 100), latest = this.info().cursor
    if (after > 0 && query.get('calendarId') !== this.calendarId) throw fail('同步游标缺少匹配的 calendarId，请重新读取日历信息', 409)
    if (after > latest) throw fail('同步游标不属于当前数据库，请重新全量读取', 409)
    const rows = this.db.prepare('SELECT seq,body FROM calendar_changes WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit)
    return { calendarId: this.calendarId, protocol: 1, changes: rows.map(r => ({ cursor: r.seq, event: JSON.parse(r.body) })), nextCursor: rows.at(-1)?.seq ?? after, hasMore: (rows.at(-1)?.seq ?? after) < latest }
  }
  dayGoals(day, zone) {
    const next = addDays(day, 1)
    return this.db.prepare(`SELECT body FROM calendar_events WHERE deleted_at IS NULL
      AND json_extract(body,'$.kind')='goal'
      AND ((all_day=1 AND day < ? AND end_day > ?) OR (all_day=0 AND start_at < ? AND end_at > ?))
      ORDER BY day,all_day DESC,start_at,rowid`)
      .all(next, day, startOfDay(next, zone), startOfDay(day, zone)).map(row => JSON.parse(row.body))
  }
  carryGoals(now = Date.now()) {
    const zone = this.timezone(), today = localParts(now, zone).day, yesterday = addDays(today, -1)
    if (yesterday < '1900-01-01' || today >= '2200-12-31') return 0
    const pending = this.db.prepare(`SELECT body FROM calendar_events e
      WHERE deleted_at IS NULL AND status IN ('planned','in_progress') AND json_extract(body,'$.kind')='goal'
        AND ((all_day=1 AND end_day=?) OR (all_day=0 AND end_at>? AND end_at<=?))
        AND NOT EXISTS (SELECT 1 FROM calendar_goal_carry WHERE day=? AND source_id=e.id)
      ORDER BY day,all_day DESC,start_at,rowid`)
    const args = [today, startOfDay(yesterday, zone), startOfDay(today, zone), today]
    if (!pending.get(...args)) return 0

    this.db.exec('BEGIN IMMEDIATE')
    try {
      // Re-read progress and dates inside the write transaction.
      const eligible = pending.all(...args).map(row => JSON.parse(row.body))
      const priorOrder = this.db.prepare('SELECT ids FROM calendar_goal_orders WHERE day=?').get(yesterday)
      if (priorOrder) {
        const positions = new Map(JSON.parse(priorOrder.ids).map((id, i) => [id, i]))
        eligible.sort((a, b) => (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity))
      }
      const claim = this.db.prepare('INSERT OR IGNORE INTO calendar_goal_carry(day,source_id) VALUES (?,?)')
      let remaining = 100000 - this.db.prepare('SELECT count(*) AS n FROM calendar_events').get().n
      let copied = 0
      for (const source of eligible) {
        if (remaining <= 0) break
        if (!claim.run(today, source.id).changes) continue
        this.saveEvent({
          ...source, id: randomUUID(), uid: randomUUID() + '@dsh-knowledge', revision: 1,
          day: today, endDay: addDays(today, 1), allDay: true, startAt: null, endAt: null, timeZone: zone,
          createdAt: now, updatedAt: now, completedAt: null, deletedAt: null,
          carriedFrom: { id: source.id, day: yesterday },
        })
        copied++; remaining--
      }
      this.db.exec('COMMIT')
      return copied
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  saveEvent(event) {
    const body = JSON.stringify(event)
    this.db.prepare(`INSERT INTO calendar_events VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,all_day=excluded.all_day,day=excluded.day,end_day=excluded.end_day,start_at=excluded.start_at,end_at=excluded.end_at,status=excluded.status,deleted_at=excluded.deleted_at,body=excluded.body`).run(event.id, event.uid, event.revision, +event.allDay, event.day, event.endDay, event.startAt, event.endAt, event.status, event.deletedAt, body)
    return Number(this.db.prepare('INSERT INTO calendar_changes(event_id,revision,body) VALUES (?,?,?)').run(event.id, event.revision, body).lastInsertRowid)
  }
  reorder(data) {
    const day = validDate(data.day), zone = this.timezone()
    const revision = integer(data.revision, 0, Number.MAX_SAFE_INTEGER)
    if (!Array.isArray(data.ids) || data.ids.length < 2 || data.ids.length > 5000) throw fail('目标排序至少 2 项，最多 5000 项')
    const ids = data.ids.map(id => string(id, 100, true)), unique = new Set(ids)
    const current = this.db.prepare('SELECT revision FROM calendar_goal_orders WHERE day=?').get(day)
    const goals = this.dayGoals(day, zone)
    if ((current?.revision ?? 0) !== revision || unique.size !== ids.length || goals.length !== ids.length || goals.some(goal => !unique.has(goal.id))) {
      throw fail('当天目标或顺序已更新，请刷新后再排序', 409)
    }
    const orderRevision = this.orderCursor() + 1
    this.db.prepare('INSERT INTO calendar_goal_orders(day,revision,ids) VALUES (?,?,?) ON CONFLICT(day) DO UPDATE SET revision=excluded.revision,ids=excluded.ids')
      .run(day, orderRevision, JSON.stringify(ids))
    return { order: { day, revision: orderRevision, ids }, calendarId: this.calendarId, orderCursor: orderRevision, replayed: false }
  }
  progressGoal(id) {
    const event = this.get(id)
    if (event.kind !== 'goal') throw fail('每日进度仅适用于目标', 400)
    const root = event.carriedFrom
      ? this.db.prepare(`WITH RECURSIVE lineage(id, parent, created_at) AS (
          SELECT id, json_extract(body,'$.carriedFrom.id'), json_extract(body,'$.createdAt') FROM calendar_events WHERE id=?
          UNION
          SELECT e.id, json_extract(e.body,'$.carriedFrom.id'), json_extract(e.body,'$.createdAt')
          FROM lineage l JOIN calendar_events e ON e.id=l.parent
        ) SELECT id, created_at AS createdAt FROM lineage WHERE parent IS NULL`).get(event.id)
      : event
    if (!root) throw fail('无法确认结转目标的原始记录', 409)
    return { event, root }
  }
  progressHistory(id, beforeValue, limitValue) {
    const { root } = this.progressGoal(id)
    const before = beforeValue ? validDate(beforeValue) : '9999-12-31'
    const limit = integer(limitValue, 1, 100, 50)
    const rows = this.db.prepare(`SELECT goal_id AS goalId, day, text, revision, updated_at AS updatedAt
      FROM calendar_goal_progress WHERE goal_id=? AND day<? AND text<>'' ORDER BY day DESC LIMIT ?`)
      .all(root.id, before, limit + 1)
    const items = rows.slice(0, limit)
    return { items, before: rows.length > limit ? items.at(-1).day : null, calendarId: this.calendarId }
  }
  goalProgress(id, date) {
    const day = validDate(date), { event, root } = this.progressGoal(id)
    const row = this.db.prepare('SELECT text, revision, updated_at AS updatedAt FROM calendar_goal_progress WHERE goal_id=? AND day=?').get(root.id, day)
    return { event, progress: { goalId: root.id, day, text: '', revision: 0, updatedAt: null, ...row }, createdAt: root.createdAt }
  }
  writeProgress(data, now) {
    const { event, progress, createdAt } = this.goalProgress(data.id, data.day)
    if (event.deletedAt !== null) throw fail('目标已删除，请先恢复', 409)
    if (progress.revision !== integer(data.revision, 0, Number.MAX_SAFE_INTEGER)) throw fail('该日期进度已更新，请重新读取后再保存', 409)
    const text = string(data.text, 4000)
    if (text === progress.text) return { progress, createdAt }
    const revision = progress.revision + 1, updatedAt = Math.max(now, (progress.updatedAt ?? 0) + 1)
    this.db.prepare(`INSERT INTO calendar_goal_progress VALUES (?,?,?,?,?)
      ON CONFLICT(goal_id,day) DO UPDATE SET text=excluded.text,revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(progress.goalId, progress.day, text, revision, updatedAt)
    return { progress: { ...progress, text, revision, updatedAt }, createdAt }
  }
  mutate(action, data, now = Date.now()) {
    object(data, action === 'progress-write' ? ['requestId', 'calendarId', 'id', 'day', 'revision', 'text'] : action === 'reorder' ? ['requestId', 'calendarId', 'day', 'revision', 'ids'] : action === 'create' ? ['requestId', 'calendarId', 'event'] : action === 'update' ? ['requestId', 'calendarId', 'id', 'revision', 'patch'] : ['requestId', 'calendarId', 'id', 'revision'])
    if (data.calendarId !== undefined && data.calendarId !== this.calendarId) throw fail('日历连接已改变，请重新加载后操作', 409)
    const requestId = string(data.requestId, 128, true), fingerprint = createHash('sha256').update(canonical({ action, data })).digest('hex')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const prior = this.db.prepare('SELECT fingerprint,result FROM calendar_requests WHERE id=?').get(requestId)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw fail('同一 requestId 不能用于不同操作；原操作未被覆盖', 409)
        this.db.exec('COMMIT'); return { ...JSON.parse(prior.result), replayed: true }
      }
      if (action === 'reorder' || action === 'progress-write') {
        const result = action === 'reorder' ? this.reorder(data) : {
          ...this.writeProgress(data, now), calendarId: this.calendarId, replayed: false,
        }
        if (action === 'progress-write') this.db.prepare('DELETE FROM calendar_report_notes WHERE goal_id=? AND day=?').run(result.progress.goalId, result.progress.day)
        this.db.prepare('INSERT INTO calendar_requests VALUES (?,?,?)').run(requestId, fingerprint, JSON.stringify(result))
        this.db.exec('COMMIT'); return result
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
      const result = { event, calendarId: this.calendarId, cursor: this.saveEvent(event), replayed: false }
      this.db.prepare('INSERT INTO calendar_requests VALUES (?,?,?)').run(requestId, fingerprint, JSON.stringify(result))
      this.db.exec('COMMIT'); return result
    } catch (e) { try { this.db.exec('ROLLBACK') } catch {} throw e }
  }
}
