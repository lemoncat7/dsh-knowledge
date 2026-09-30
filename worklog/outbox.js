import { createHash } from 'node:crypto'
import { destination, requestCentral } from './remote.js'
import { fail } from './domain.js'

/** Local durable transport only. It never generates or edits a daily report. */
export class Outbox {
  constructor(store, current, request = requestCentral) {
    this.store = store; this.db = store.db; this.current = current; this.request = request
    this.closed = false
    this.db.exec(`CREATE TABLE IF NOT EXISTS journal_outbox (
      destination TEXT NOT NULL, id TEXT NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      due INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', PRIMARY KEY(destination,id));
      CREATE TABLE IF NOT EXISTS journal_targets (destination TEXT PRIMARY KEY, central_id TEXT NOT NULL);`)
  }
  add(target, path, value) {
    const body = JSON.stringify({ sourceId: this.store.originId(), ...value })
    const id = createHash('sha256').update(path === '/ingest' ? `record:${value.record.id}` : `${path}:${body}`).digest('hex')
    this.db.prepare('INSERT OR IGNORE INTO journal_outbox(destination,id,path,body) VALUES (?,?,?,?)').run(target, id, path, body)
  }
  capture(record, connection) { this.add(destination(connection), '/ingest', { record }) }
  status(target) {
    const counts = this.db.prepare("SELECT count(*) AS pending FROM journal_outbox WHERE destination=? AND status='pending'").get(target)
    const error = this.db.prepare("SELECT error FROM journal_outbox WHERE destination=? AND status='pending' AND error<>'' ORDER BY rowid DESC LIMIT 1").get(target)?.error || ''
    const other = this.db.prepare("SELECT count(*) AS count FROM journal_outbox WHERE destination<>? AND status='pending'").get(target).count
    return { pending: counts.pending, error, otherDestinations: other }
  }
  retry(target) { this.db.prepare("UPDATE journal_outbox SET due=0,attempts=0,error='' WHERE destination=? AND status='pending'").run(target); void this.tick() }
  migrate(target) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of this.db.prepare('SELECT body,excluded FROM records').iterate()) {
        const record = JSON.parse(row.body)
        // Imported central sources are not local history; never relay them back.
        if (!record.sourceId || record.sourceId === this.store.originId()) this.add(target, '/ingest', { record: { ...record, excluded: !!row.excluded } })
      }
      for (const row of this.db.prepare('SELECT day,body FROM history').iterate()) {
        const report = JSON.parse(row.body)
        if (!report.sourceId) this.add(target, '/archive', { report: { ...report, day: row.day } })
      }
      for (const row of this.db.prepare('SELECT day,revision,body FROM reports').iterate()) this.add(target, '/archive', { report: { ...JSON.parse(row.body), day: row.day, revision: row.revision } })
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
    void this.tick()
    return this.status(target)
  }
  start() { this.timer = setInterval(() => { void this.tick() }, 5000); this.timer.unref?.(); void this.tick() }
  async tick() {
    if (this.closed || this.running) return
    this.running = this.flush().catch(() => {}).finally(() => { this.running = null })
    return this.running
  }
  async flush() {
    const connection = { ...this.current() }, target = destination(connection)
    if (!target || connection.paused) return
    this.controller = new AbortController()
    // Bounded batches keep the event loop responsive; target is fixed per upload.
    for (let i = 0; i < 20 && !this.closed && destination(this.current()) === target; i++) {
      const item = this.db.prepare("SELECT * FROM journal_outbox WHERE destination=? AND status='pending' AND due<=? ORDER BY rowid LIMIT 1").get(target, Date.now())
      if (!item) break
      try {
        if (i === 0) {
          const identity = await this.request(connection, 'GET', '/identity', undefined, undefined, this.controller.signal)
          if (identity.protocol !== 1 || typeof identity.id !== 'string' || !identity.id) throw fail('中央日报协议不兼容，请升级中央插件', 409)
          const bound = this.db.prepare('SELECT central_id FROM journal_targets WHERE destination=?').get(target)
          if (bound && bound.central_id !== identity.id) throw fail('该地址的中央实例已变更，已暂停上传；请恢复原实例或使用新地址', 409)
          this.db.prepare('INSERT OR IGNORE INTO journal_targets VALUES (?,?)').run(target, identity.id)
        }
        await this.request(connection, 'POST', item.path, JSON.parse(item.body), undefined, this.controller.signal)
        // Keep only a small receipt; raw queued text is discarded after central ACK.
        this.db.prepare("UPDATE journal_outbox SET status='done',body='',error='' WHERE destination=? AND id=?").run(target, item.id)
      } catch (e) {
        if (this.closed) break
        const delay = Math.min(300000, 5000 * 2 ** Math.min(item.attempts, 6))
        this.db.prepare('UPDATE journal_outbox SET attempts=attempts+1,due=?,error=? WHERE destination=? AND id=?').run(Date.now() + delay, e.status ? e.message : '本地上传队列异常，请检查磁盘后重试', target, item.id)
        break
      }
    }
    this.controller = null
  }
  async close() { this.closed = true; clearInterval(this.timer); this.controller?.abort(); await this.running }
}
