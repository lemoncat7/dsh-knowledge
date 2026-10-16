import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { defaults, fail, settings, text, validDay } from './domain.js'
import { scheduledDay } from './scheduler.js'
import { prepareBatches, batchProgress } from './batches.js'
import { recoverDay } from './recovery.js'

// SQLite transactions are short and never span a model/network request.
export class Store {
  constructor(path) {
    this.instance = randomUUID()
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    const schema = this.db.prepare('PRAGMA user_version').get().user_version
    if (schema > 1) { this.db.close(); throw new Error('工作记录数据库版本较新，请升级插件') }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, day TEXT NOT NULL, project TEXT NOT NULL, excluded INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS records_day ON records(day);
      CREATE TABLE IF NOT EXISTS reports (day TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, day TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, day TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS active_day ON jobs(day) WHERE status IN ('queued','running');`)
    this.db.exec('PRAGMA user_version=1')
    this.db.exec('CREATE TABLE IF NOT EXISTS journal_imports (id TEXT PRIMARY KEY)')
    this.db.exec('CREATE TABLE IF NOT EXISTS local_projects (id TEXT PRIMARY KEY)')
    this.db.exec('CREATE INDEX IF NOT EXISTS jobs_day ON jobs(day); CREATE INDEX IF NOT EXISTS records_day_excluded ON records(day,excluded)')
    this.migrateLocalProjects()
    this.db.prepare("UPDATE jobs SET status='queued' WHERE status='running'").run()
    // Older releases stored preflight failures only in one global status field.
    const last = this.scheduleState().last
    if (last?.status === 'failed' && !this.db.prepare('SELECT 1 FROM jobs WHERE day=?').get(last.day)) {
      this.db.prepare("INSERT INTO jobs VALUES (?,?,'failed',0,?,?)").run(randomUUID(), last.day, last.time || Date.now(), JSON.stringify({ error: last.message, preflight: true, fingerprint: '', legacy: true }))
    }
  }
  config() { return { ...defaults, ...JSON.parse(this.db.prepare("SELECT value FROM meta WHERE key='settings'").get()?.value || '{}') } }
  version() { return `${this.instance}:${this.db.prepare('SELECT total_changes() AS count').get().count}` }
  configure(value, now = Date.now()) {
    const config = settings(value), previous = this.config(), state = this.scheduleState()
    if (config.scheduleEnabled && !previous.scheduleEnabled) state.catchupSince = now
    else if (config.scheduleEnabled && !Number.isFinite(state.catchupSince)) state.catchupSince = state.since ?? now
    if (config.scheduleEnabled && (!previous.scheduleEnabled || config.scheduleTime !== previous.scheduleTime || config.timezone !== previous.timezone)) state.since = now
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.setMeta('settings', config); this.setMeta('schedule', state)
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
    return config
  }
  setMeta(key, value) { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)) }
  originId() {
    let value = this.db.prepare("SELECT value FROM meta WHERE key='originId'").get()?.value
    if (!value) { this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('originId',?)").run(JSON.stringify(randomUUID())); value = this.db.prepare("SELECT value FROM meta WHERE key='originId'").get().value }
    return JSON.parse(value)
  }
  importRecord(record) {
    // First receipt wins. Retrying an upload must not undo subsequent exclusions.
    this.db.prepare('INSERT OR IGNORE INTO records(id,day,project,excluded,body) VALUES (?,?,?,?,?)').run(record.id, record.day, record.project, +record.excluded, JSON.stringify(record))
  }
  importArchive(id, report) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (this.db.prepare('INSERT OR IGNORE INTO journal_imports VALUES (?)').run(id).changes) this.db.prepare('INSERT INTO history(day,body) VALUES (?,?)').run(report.day, JSON.stringify(report))
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  scheduleState() { return JSON.parse(this.db.prepare("SELECT value FROM meta WHERE key='schedule'").get()?.value || '{}') }
  schedule(now = Date.now()) {
    // Persist the once-per-day decision and its queued job in one transaction.
    // A crash can neither lose the job after claiming a day nor enqueue it twice.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const state = this.scheduleState(), day = scheduledDay(this.config(), state, now)
      const active = day && this.db.prepare("SELECT id FROM jobs WHERE day=? AND status IN ('queued','running')").get(day)
      let enqueued = false
      if (day && !active) {
        const report = this.report(day), records = this.records(day)
        const last = { day, time: now, status: 'skipped', message: '' }
        if (report.edited) last.message = '日报有手工修改，未自动覆盖；可在对应日期手动整理。'
        else if (!records.some(r => !report.covered.includes(r.id))) last.message = '没有待整理的新素材，已跳过。'
        else {
          try { last.jobId = this.enqueue(day); enqueued = true; last.status = 'queued'; last.message = '已加入整理队列，可在对应日期查看进度或重试。' }
          catch (e) {
            if (!e.status) throw e
            last.status = 'failed'; last.message = e.message
          }
        }
        this.setMeta('schedule', { ...state, last })
      }
      if (!enqueued && !active) recoverDay(this, state, now)
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  migrateLocalProjects() {
    if (this.db.prepare("SELECT 1 FROM meta WHERE key='localProjectsV1'").get()) return
    const origin = this.originId(), local = new Set(), uncertain = new Set()
    // The legacy catalog mixed local observations, imported records and notes.
    // Preserve observation-only paths, but require local session evidence for
    // paths also mentioned by remote sources or manual notes. Never infer a
    // machine from its path spelling or change saved capture authorization.
    for (const row of this.db.prepare(`SELECT project,
      json_extract(body,'$.sessionId') AS sessionId,
      json_extract(body,'$.sourceId') AS sourceId,
      json_extract(body,'$.originalId') AS originalId FROM records`).iterate()) {
      if (row.sessionId && !row.originalId && (!row.sourceId || row.sourceId === origin)) local.add(row.project)
      else uncertain.add(row.project)
    }
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='journal_outbox'").get()) {
      for (const row of this.db.prepare("SELECT body FROM journal_outbox WHERE path='/ingest' AND body<>''").iterate()) {
        const item = JSON.parse(row.body), record = item.record
        if (item.sourceId === origin && record?.sessionId && !record.originalId && (!record.sourceId || record.sourceId === origin)) local.add(record.project)
      }
    }
    for (const { id } of this.db.prepare('SELECT id FROM projects').iterate()) if (!uncertain.has(id)) local.add(id)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const project of local) this.observe(project)
      this.setMeta('localProjectsV1', true)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  observe(project) { if (project) this.db.prepare('INSERT OR IGNORE INTO local_projects VALUES (?)').run(project) }
  insert(record) { this.db.prepare('INSERT OR IGNORE INTO records(id,day,project,body) VALUES (?,?,?,?)').run(record.id, record.day, record.project, JSON.stringify(record)) }
  records(day, includeExcluded = false) { return this.db.prepare(`SELECT body,excluded FROM records WHERE day=? ${includeExcluded ? '' : 'AND excluded=0'} ORDER BY rowid`).all(day).map(r => ({ ...JSON.parse(r.body), excluded: !!r.excluded })) }
  report(day) { const row = this.db.prepare('SELECT * FROM reports WHERE day=?').get(day); return row ? { ...JSON.parse(row.body), revision: row.revision } : { revision: 0, markdown: '', covered: [], edited: false } }
  overview() {
    return { config: this.config(), scheduleLast: this.scheduleState().last || null, today: null, projects: this.db.prepare('SELECT id FROM local_projects ORDER BY id').all().map(p => p.id),
      days: this.db.prepare('SELECT day FROM records UNION SELECT day FROM reports UNION SELECT day FROM history UNION SELECT day FROM jobs ORDER BY day DESC').all().map(d => d.day),
      failedDays: this.db.prepare("SELECT j.day FROM jobs j WHERE j.status='failed' AND j.rowid=(SELECT max(rowid) FROM jobs WHERE day=j.day) ORDER BY j.day DESC").all().map(r => r.day) }
  }
  detail(day) {
    const records = this.records(day, true), report = this.report(day)
    const job = this.db.prepare('SELECT * FROM jobs WHERE day=? ORDER BY rowid DESC LIMIT 1').get(day)
    return { day, records, report, pending: records.filter(r => !r.excluded && !report.covered.includes(r.id)).length,
      job: job ? { ...job, body: JSON.stringify({ error: JSON.parse(job.body).error, progress: this.progress(job) }) } : null,
      history: this.db.prepare('SELECT id,body FROM history WHERE day=? ORDER BY id DESC LIMIT 30').all(day).map(r => ({ id: r.id, ...JSON.parse(r.body) })) }
  }
  save(day, markdown, expected, covered, edited = true) {
    validDay(day); text(markdown)
    const old = this.report(day)
    if (old.revision !== expected) throw fail('日报已被修改，请重新打开后再保存；你的草稿仍保留。', 409)
    const next = { markdown, covered: covered || old.covered, edited, updated: Date.now() }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (old.revision) this.db.prepare('INSERT INTO history(day,body) VALUES (?,?)').run(day, JSON.stringify(old))
      this.db.prepare('INSERT INTO reports VALUES (?,?,?) ON CONFLICT(day) DO UPDATE SET revision=excluded.revision, body=excluded.body').run(day, expected + 1, JSON.stringify(next))
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  note(day, body, project = '') { validDay(day); this.insert({ id: randomUUID(), day, project, time: Date.now(), user: '手工补记', answer: text(body, 16000), sessionId: null, route: null, truncated: false }) }
  exclude(id, excluded) {
    if (typeof excluded !== 'boolean') throw fail('排除状态无效')
    if (!this.db.prepare('UPDATE records SET excluded=? WHERE id=?').run(+excluded, id).changes) throw fail('记录不存在', 404)
  }
  progress(job) { try { return batchProgress(JSON.parse(job.body)) } catch { return null } }
  fingerprint(day, records = this.records(day), route) {
    const config = this.config()
    route ||= config.provider && config.model ? { provider: config.provider, model: config.model } : records.findLast(r => r.route)?.route
    return createHash('sha256').update(JSON.stringify({ records, route, revision: this.report(day).revision })).digest('hex')
  }
  enqueue(day, allowReplace = false) {
    validDay(day)
    const active = this.db.prepare("SELECT id FROM jobs WHERE day=? AND status IN ('queued','running')").get(day)
    if (active) return active.id
    const records = this.records(day), report = this.report(day)
    if (!records.length) throw fail('当天没有可整理的记录')
    if (report.edited && !allowReplace) throw fail('日报有手工修改，请明确确认后再重新整理。', 409)
    const config = this.config()
    const route = config.provider && config.model ? { provider: config.provider, model: config.model } : records.findLast(r => r.route)?.route
    const id = randomUUID(), fingerprint = this.fingerprint(day, records, route)
    const body = { revision: report.revision, records, route, error: '', fingerprint }
    try {
      if (!route) throw fail('尚无可用的会话模型。请在采集设置中指定日报模型后重新整理。')
      prepareBatches(body)
    } catch (e) {
      if (!e.status) throw e
      this.db.prepare("INSERT INTO jobs VALUES (?,?,'failed',0,?,?)").run(id, day, Date.now(), JSON.stringify({ revision: report.revision, fingerprint, preflight: true, error: e.message, failedAt: Date.now() }))
      throw e
    }
    const previous = this.db.prepare("SELECT body FROM jobs WHERE day=? AND status='failed' ORDER BY rowid DESC LIMIT 1").get(day)
    if (previous) {
      const old = JSON.parse(previous.body)
      if (old.fingerprint === fingerprint && old.batch && !old.preflight) body.batch = old.batch
    }
    this.db.prepare("INSERT INTO jobs VALUES (?,?,'queued',0,?,?)").run(id, day, Date.now(), JSON.stringify(body))
    return id
  }
  next() { return this.db.prepare("SELECT * FROM jobs WHERE status='queued' AND due<=? ORDER BY rowid LIMIT 1").get(Date.now()) }
  job(id) { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) }
  status(id, status, body, attempts = 0, due = Date.now()) { this.db.prepare('UPDATE jobs SET status=?,body=?,attempts=?,due=? WHERE id=?').run(status, JSON.stringify(body), attempts, due, id) }
  retry(id) {
    const job = this.job(id)
    if (!job || !['failed', 'cancelled'].includes(job.status)) throw fail('只有失败或取消的任务可以重试')
    return this.enqueue(job.day)
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true } }
}
