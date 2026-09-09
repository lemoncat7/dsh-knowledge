import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ExtractionWriteDestination } from '../domain.js'
import type { ExtractionCheckpoint, PlannedWrite, TurnSnapshot } from '../extraction.js'

export interface WritebackStatus {
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  summary: string
  error?: string
  retryable: boolean
  destinations?: ExtractionWriteDestination[]
  nextAttemptAt?: number
  blockedBy?: string
  cancelRequested?: boolean
}
export interface WritebackWork {
  snapshot: TurnSnapshot
  destination: string
}
interface Row { id: number; source_key: string; session_id: string; payload: string | null; plan: string | null; status: WritebackStatus['status']; attempts: number; next_at: number; view: string }
const LEASE_MS = 60_000
const retryDelay = (attempt: number): number => [5_000, 15_000, 60_000, 180_000][Math.min(3, Math.max(0, attempt - 1))]!
export class WritebackDeferred extends Error {}

/** Local durable outbox. No network/LLM work runs on enqueue or manual retry. */
export class WritebackQueue {
  private readonly db: DatabaseSync
  private readonly owner = randomUUID()
  private timer: NodeJS.Timeout | undefined
  private active: Promise<void> | undefined
  private controller: AbortController | undefined
  private activeKey: string | undefined
  private closed = false
  private closing: Promise<void> | undefined
  private readonly listeners = new Set<() => void>()

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  get revision(): string {
    if (this.closed) return `${this.owner}:closed`
    const external = this.db.prepare('PRAGMA data_version').get() as { data_version: number }
    const local = this.db.prepare('SELECT total_changes() AS changes').get() as { changes: number }
    return `${this.owner}:${external.data_version}:${local.changes}`
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener() } catch (error) { this.warn(`writeback status notification: ${String(error)}`) }
    }
  }
  constructor(path: string, private readonly execute: (work: WritebackWork, checkpoint: ExtractionCheckpoint, signal: AbortSignal) => Promise<WritebackStatus>, private readonly warn: (message: string) => void = () => {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS queue_jobs(id INTEGER PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
        payload TEXT, plan TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, view TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS queue_ready ON queue_jobs(status,next_at,id);
      CREATE INDEX IF NOT EXISTS queue_session_pending ON queue_jobs(session_id,id) WHERE status!='completed';
      CREATE INDEX IF NOT EXISTS queue_capacity ON queue_jobs(id) WHERE status!='completed';
      CREATE TABLE IF NOT EXISTS queue_lease(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires INTEGER NOT NULL);
      INSERT OR IGNORE INTO queue_lease VALUES(1,'',0);`)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const columns = this.db.prepare('PRAGMA table_info(queue_jobs)').all() as { name: string }[]
      if (!columns.some(column => column.name === 'cancel_requested')) this.db.exec('ALTER TABLE queue_jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0')
      if (!columns.some(column => column.name === 'created_at')) this.db.exec('ALTER TABLE queue_jobs ADD COLUMN created_at INTEGER')
      this.db.exec('DROP INDEX IF EXISTS queue_management_order')
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error }
  }

  enqueue(work: WritebackWork): WritebackStatus {
    if (this.closed) throw new Error('知识库回写队列已关闭')
    const existing = this.status(work.snapshot.sourceKey)
    if (existing) return existing
    const count = this.db.prepare("SELECT count(*) AS count FROM queue_jobs WHERE status NOT IN ('completed','cancelled')").get() as { count: number }
    if (count.count >= 1000) throw new Error('回写队列已满，请先处理失败任务；未删除任何未完成记录')
    const view: WritebackStatus = { status: 'queued', summary: '知识库回写 · 等待回写', retryable: false }
    this.db.prepare('INSERT OR IGNORE INTO queue_jobs(source_key,session_id,payload,status,view,created_at) VALUES(?,?,?,?,?,?)')
      .run(work.snapshot.sourceKey, work.snapshot.sessionId, JSON.stringify(work), 'queued', JSON.stringify(view), Date.now())
    this.kick()
    return this.status(work.snapshot.sourceKey)!
  }

  completeEmpty(sourceKey: string, sessionId: string): WritebackStatus {
    const view: WritebackStatus = { status: 'completed', summary: '知识库回写 · 当前回答无可提取内容', retryable: false }
    this.db.prepare('INSERT OR IGNORE INTO queue_jobs(source_key,session_id,status,view,created_at) VALUES(?,?,?,?,?)').run(sourceKey, sessionId, view.status, JSON.stringify(view), Date.now())
    this.notify()
    return this.status(sourceKey)!
  }

  status(key: string): WritebackStatus | undefined {
    const row = this.db.prepare('SELECT id,session_id,status,view FROM queue_jobs WHERE source_key=?').get(key) as Pick<Row, 'id' | 'session_id' | 'status' | 'view'> | undefined
    if (!row) return undefined
    const view = JSON.parse(row.view) as WritebackStatus
    const blocker = row.status === 'queued' ? this.db.prepare("SELECT source_key FROM queue_jobs WHERE session_id=? AND id<? AND status NOT IN ('completed','cancelled') ORDER BY id LIMIT 1").get(row.session_id, row.id) as { source_key: string } | undefined : undefined
    if (blocker) {
      return { ...view, blockedBy: blocker.source_key, summary: '知识库回写 · 等待本会话前一轮回写完成；可在回写任务中重试或取消阻塞项' }
    }
    return view
  }

  retry(key: string): WritebackStatus {
    if (this.closed) throw new Error('知识库回写队列已关闭')
    const row = this.db.prepare('SELECT * FROM queue_jobs WHERE source_key=?').get(key) as unknown as Row | undefined
    if (!row) throw Object.assign(new Error('旧记录没有持久化内容快照，不能安全重试'), { status: 409 })
    if (row.status !== 'failed') return this.status(key)!
    if (!row.payload) throw Object.assign(new Error('回写内容快照不可用'), { status: 409 })
    const view: WritebackStatus = { status: 'queued', summary: '知识库回写 · 已排队重试', retryable: false }
    this.db.prepare("UPDATE queue_jobs SET status='queued',attempts=0,next_at=0,view=? WHERE source_key=? AND status='failed'").run(JSON.stringify(view), key)
    this.kick()
    return this.status(key)!
  }

  list(sessionId = '', offset = 0, limit = 50) {
    const where = sessionId ? 'WHERE session_id=?' : ''
    const args = sessionId ? [sessionId] : []
    const total = (this.db.prepare(`SELECT count(*) AS count FROM queue_jobs ${where}`).get(...args) as { count: number }).count
    const rows = this.db.prepare(`SELECT source_key,session_id,attempts,created_at FROM queue_jobs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as { source_key: string; session_id: string; attempts: number; created_at: number | null }[]
    return { total, items: rows.map(row => ({ sourceKey: row.source_key, sessionId: row.session_id, attempts: row.attempts, createdAt: row.created_at, ...this.status(row.source_key)! })) }
  }

  cancel(key: string): WritebackStatus {
    if (this.closed) throw new Error('知识库回写队列已关闭')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.status(key)
      if (!current) throw Object.assign(new Error('回写任务不存在'), { status: 404 })
      if (current.status === 'running') {
        this.db.prepare('UPDATE queue_jobs SET cancel_requested=1,view=? WHERE source_key=?').run(JSON.stringify({ ...current, cancelRequested: true, summary: '知识库回写 · 正在取消，等待当前写入结束' }), key)
      } else if (current.status !== 'completed' && current.status !== 'cancelled') {
        this.finishCancellation(key)
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    if (this.activeKey === key) this.controller?.abort(new Error('用户取消回写'))
    this.kick()
    return this.status(key)!
  }

  private finishCancellation(key: string): void {
    const view: WritebackStatus = { status: 'cancelled', summary: '知识库回写 · 已取消；已写入的内容不会撤销', retryable: false }
    this.db.prepare("UPDATE queue_jobs SET status='cancelled',payload=NULL,plan=NULL,view=? WHERE source_key=?").run(JSON.stringify(view), key)
  }

  start(): void {
    if (this.timer || this.closed) return
    this.timer = setInterval(() => this.kick(), 2_000)
    this.timer.unref?.()
    this.kick()
  }

  get isRunning(): boolean { return this.controller !== undefined }

  private kick(): void {
    if (!this.closed) this.notify()
    if (this.closed || this.active) return
    // A macrotask boundary lets the host finish its turn/channel reply first.
    this.active = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.drain())
      .catch(error => this.warn(`knowledge writeback worker: ${String(error)}`)).finally(() => { this.active = undefined })
  }

  private claim(): Row | undefined {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const now = Date.now()
      const lease = this.db.prepare('SELECT owner,expires FROM queue_lease WHERE id=1').get() as { owner: string; expires: number }
      if (lease.owner !== this.owner && lease.expires > now) { this.db.exec('COMMIT'); return undefined }
      // Only the current lease owner may recover work abandoned by a dead process.
      for (const cancelled of this.db.prepare("SELECT source_key FROM queue_jobs WHERE status='running' AND cancel_requested=1").all() as { source_key: string }[]) this.finishCancellation(cancelled.source_key)
      this.db.prepare("UPDATE queue_jobs SET status='queued',next_at=0,view=? WHERE status='running'")
        .run(JSON.stringify({ status: 'queued', summary: '知识库回写 · 中断后等待恢复', retryable: false }))
      const row = this.db.prepare(`SELECT j.* FROM queue_jobs j WHERE j.status='queued' AND j.next_at<=?
        AND NOT EXISTS(SELECT 1 FROM queue_jobs p WHERE p.session_id=j.session_id AND p.id<j.id AND p.status NOT IN ('completed','cancelled'))
        ORDER BY j.id LIMIT 1`).get(now) as unknown as Row | undefined
      if (!row) { this.db.exec('COMMIT'); return undefined }
      this.db.prepare('UPDATE queue_lease SET owner=?,expires=? WHERE id=1').run(this.owner, now + LEASE_MS)
      this.db.prepare("UPDATE queue_jobs SET status='running',attempts=attempts+1,view=? WHERE id=?")
        .run(JSON.stringify({ status: 'running', summary: '知识库回写 · 回写中', retryable: false }), row.id)
      this.db.exec('COMMIT')
      return { ...row, attempts: row.attempts + 1 }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private async drain(): Promise<void> {
    while (!this.closed) {
      const row = this.claim()
      if (!row) break
      const controller = new AbortController()
      this.controller = controller
      this.activeKey = row.source_key
      this.notify()
      const assertLease = (): void => {
        controller.signal.throwIfAborted()
        const lease = this.db.prepare('SELECT owner,expires FROM queue_lease WHERE id=1').get() as { owner: string; expires: number }
        if (lease.owner !== this.owner || lease.expires < Date.now()) throw new Error('回写工作租约已失效')
        if (this.db.prepare('SELECT 1 FROM queue_jobs WHERE id=? AND cancel_requested=1').get(row.id)) throw new Error('用户取消回写')
      }
      const renewal = setInterval(() => {
        try {
          assertLease()
          this.db.prepare('UPDATE queue_lease SET expires=? WHERE id=1 AND owner=?').run(Date.now() + LEASE_MS, this.owner)
        } catch (error) { controller.abort(error) }
      }, 15_000)
      renewal.unref?.()
      try {
        let plan = row.plan ? JSON.parse(row.plan) as PlannedWrite[] : undefined
        const view = await this.execute(JSON.parse(row.payload!) as WritebackWork, {
          load: () => plan,
          save: value => { assertLease(); this.db.prepare('UPDATE queue_jobs SET plan=? WHERE id=?').run(JSON.stringify(value), row.id); plan = structuredClone(value) },
        }, controller.signal)
        assertLease()
        if (view.status !== 'completed') throw new Error(view.error ?? '回写尚未确认完成')
        this.db.prepare("UPDATE queue_jobs SET status='completed',payload=NULL,plan=NULL,view=? WHERE id=?").run(JSON.stringify(view), row.id)
      } catch (error) {
        const lease = this.db.prepare('SELECT owner FROM queue_lease WHERE id=1').get() as { owner: string }
        if (lease.owner !== this.owner) return
        if (this.db.prepare('SELECT 1 FROM queue_jobs WHERE id=? AND cancel_requested=1').get(row.id)) {
          this.finishCancellation(row.source_key)
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        const waiting = error instanceof WritebackDeferred
        const transient = /network|fetch failed|EOF|ECONN|ETIMEDOUT|EAI_AGAIN|SQLITE_BUSY|timeout|timed out|\b(?:429|500|502|503|504)\b|invalid JSON|网络|超时|租约已失效/i.test(message)
        const retry = this.closed || waiting || (transient && row.attempts < 5)
        const next = this.closed ? 0 : Date.now() + (waiting ? 30_000 : retryDelay(row.attempts))
        const view: WritebackStatus = retry
          ? { status: 'queued', summary: this.closed ? '知识库回写 · 中断后等待恢复' : '知识库回写 · 等待自动重试', error: message, retryable: false, nextAttemptAt: next }
          : { status: 'failed', summary: '知识库回写 · 回写失败', error: message, retryable: true }
        this.db.prepare('UPDATE queue_jobs SET status=?,next_at=?,view=?,attempts=? WHERE id=?').run(view.status, next, JSON.stringify(view), waiting || this.closed ? row.attempts - 1 : row.attempts, row.id)
      } finally {
        clearInterval(renewal)
        this.controller = undefined
        this.activeKey = undefined
        this.db.prepare('UPDATE queue_lease SET owner=\'\',expires=0 WHERE owner=?').run(this.owner)
        this.notify()
      }
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.controller?.abort(new Error('知识库服务停止，回写任务已保留'))
    this.closing = Promise.resolve(this.active).then(() => { this.db.close() })
    return this.closing
  }
}
