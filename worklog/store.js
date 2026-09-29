import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defaults, fail, settings, text, validDay } from './domain.js'

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
    this.db.prepare("UPDATE jobs SET status='queued' WHERE status='running'").run()
  }
  config() { return JSON.parse(this.db.prepare("SELECT value FROM meta WHERE key='settings'").get()?.value || JSON.stringify(defaults)) }
  version() { return `${this.instance}:${this.db.prepare('SELECT total_changes() AS count').get().count}` }
  configure(value) { const config = settings(value); this.db.prepare("INSERT INTO meta VALUES ('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(config)); return config }
  observe(project) { if (project) this.db.prepare('INSERT OR IGNORE INTO projects VALUES (?)').run(project) }
  insert(record) { this.db.prepare('INSERT OR IGNORE INTO records(id,day,project,body) VALUES (?,?,?,?)').run(record.id, record.day, record.project, JSON.stringify(record)) }
  records(day, includeExcluded = false) { return this.db.prepare(`SELECT body,excluded FROM records WHERE day=? ${includeExcluded ? '' : 'AND excluded=0'} ORDER BY rowid`).all(day).map(r => ({ ...JSON.parse(r.body), excluded: !!r.excluded })) }
  report(day) { const row = this.db.prepare('SELECT * FROM reports WHERE day=?').get(day); return row ? { ...JSON.parse(row.body), revision: row.revision } : { revision: 0, markdown: '', covered: [], edited: false } }
  overview() {
    return { config: this.config(), today: null, projects: this.db.prepare('SELECT id FROM projects ORDER BY id').all().map(p => p.id),
      days: this.db.prepare('SELECT day FROM records UNION SELECT day FROM reports ORDER BY day DESC').all().map(d => d.day) }
  }
  detail(day) {
    const records = this.records(day, true), report = this.report(day)
    const job = this.db.prepare('SELECT * FROM jobs WHERE day=? ORDER BY rowid DESC LIMIT 1').get(day)
    return { day, records, report, pending: records.filter(r => !r.excluded && !report.covered.includes(r.id)).length,
      job: job ? { ...job, body: JSON.stringify({ error: JSON.parse(job.body).error }) } : null,
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
  note(day, body, project = '') { validDay(day); this.observe(project); this.insert({ id: randomUUID(), day, project, time: Date.now(), user: '手工补记', answer: text(body, 16000), sessionId: null, route: null, truncated: false }) }
  exclude(id, excluded) {
    if (typeof excluded !== 'boolean') throw fail('排除状态无效')
    if (!this.db.prepare('UPDATE records SET excluded=? WHERE id=?').run(+excluded, id).changes) throw fail('记录不存在', 404)
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
    if (!route) throw fail('尚无可用的会话模型。请在采集项目完成一轮对话，或在采集设置中指定日报模型。')
    const id = randomUUID(), body = { revision: report.revision, records, route, error: '' }
    if (JSON.stringify(body).length > 180000) throw fail('当天素材过多，请先排除无关记录后重试；尚未截断或覆盖日报。', 413)
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
