import { generate } from './generator.js'
import { fail } from './domain.js'

export class Worker {
  constructor(store, llm, render = generate, onError = () => {}) { this.store = store; this.llm = llm; this.render = render; this.closed = false; this.onError = onError }
  start() { this.timer = setInterval(() => this.tick(), 1500); this.timer.unref?.(); this.tick() }
  async tick() {
    if (this.running || this.closed) return
    this.running = this.run().catch(() => this.onError()).finally(() => { this.running = null })
    return this.running
  }
  async run() {
    const job = this.store.next()
    if (!job) return
    const payload = JSON.parse(job.body), attempts = job.attempts + 1
    this.active = job.id; this.controller = new AbortController()
    const timeout = setTimeout(() => this.controller?.abort(new Error('整理超时')), 180000)
    this.store.status(job.id, 'running', payload, attempts)
    try {
      const result = await this.render(this.llm, payload, this.controller.signal)
      if (this.closed || this.store.job(job.id).status === 'cancelled') return
      const current = new Set(this.store.records(job.day).map(r => r.id))
      if (payload.records.some(r => !current.has(r.id))) throw fail('整理期间有来源被排除，请重新整理', 409)
      this.store.save(job.day, result, payload.revision, payload.records.map(r => r.id), false)
      this.store.status(job.id, 'done', { ...payload, error: '' }, attempts)
    } catch (e) {
      if (this.closed) this.store.status(job.id, 'queued', payload, job.attempts)
      else if (this.store.job(job.id).status !== 'cancelled') {
        const retry = attempts < 3 && e.status !== 409
        this.store.status(job.id, retry ? 'queued' : 'failed', { ...payload, error: e.status === 409 ? e.message : '模型整理失败或超时，请检查会话模型连接后重试。' }, attempts, Date.now() + attempts * 10000)
      }
    } finally { clearTimeout(timeout); this.active = null; this.controller = null }
  }
  cancel(id) {
    const job = this.store.job(id)
    if (!job || !['queued', 'running'].includes(job.status)) throw fail('任务已结束')
    this.store.status(id, 'cancelled', JSON.parse(job.body), job.attempts)
    if (this.active === id) this.controller.abort(new Error('已取消'))
  }
  async close() { this.closed = true; clearInterval(this.timer); this.controller?.abort(new Error('服务停止')); await this.running }
}

