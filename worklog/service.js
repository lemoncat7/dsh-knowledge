import { capture, settings, fail } from './domain.js'
import { createCentral, pick, captureKeys, sharedKeys, sharedRevision } from './central.js'
import { Outbox } from './outbox.js'
import { destination, requestCentral } from './remote.js'

export class JournalService {
  constructor(store, worker, models, current = () => ({ backend: 'local' }), request = requestCentral) {
    this.store = store; this.worker = worker; this.current = current; this.request = request
    this.central = createCentral(store, worker, models)
    this.outbox = new Outbox(store, current, request)
    worker.isEnabled = () => this.current().backend === 'local' && !this.current().paused
    store.originId()
  }
  collect(session, turn) {
    this.store.observe(session.header.cwd)
    const connection = { ...this.current() }, record = capture(session, turn, this.store.config())
    if (!record) return
    if (connection.backend === 'remote') this.outbox.capture(record, connection)
    else this.store.insert({ ...record, sourceId: this.store.originId() })
  }
  async serveCentral(method, path, data, query) {
    if (this.current().paused) throw fail('知识库连接正在切换，请稍后重试', 409)
    if (this.current().backend !== 'local') throw fail('当前节点不是中央日报服务，请连接本地模式的中央知识库', 409)
    const value = await this.central(method, path, data, query)
    if (method === 'GET' && path === '/state') return { ...value, config: pick(value.config, sharedKeys), projects: [] }
    return value
  }
  collectorState() {
    const target = destination(this.current())
    return { remote: !!target, sourceId: this.store.originId(), capture: pick(this.store.config(), captureKeys),
      projects: this.store.overview().projects,
      sync: target ? this.outbox.status(target) : null,
      localHistory: this.store.db.prepare('SELECT count(*) AS n FROM records').get().n,
      localReports: this.store.db.prepare('SELECT count(*) AS n FROM reports').get().n }
  }
  async browser(method, path, data = {}, query = new URLSearchParams()) {
    if (this.current().paused) throw fail('知识库连接正在切换，请稍后重试', 409)
    const connection = { ...this.current() }, target = destination(connection)
    if (method === 'GET' && path === '/collector-state') return this.collectorState()
    if (method === 'POST' && path === '/capture-settings') {
      this.store.configure({ ...this.store.config(), ...pick(data, captureKeys) })
      return this.collectorState()
    }
    if (method === 'POST' && path === '/retry-sync') { if (target) this.outbox.retry(target); return this.collectorState() }
    if (method === 'POST' && path === '/migrate') {
      if (!target || data.confirm !== true) throw fail('请确认迁移到当前中央知识库', 409)
      // Confirm capability before creating a potentially large migration queue.
      const permission = await this.request(connection, 'GET', '/state')
      if (!permission.canManage) throw fail('迁移历史日报需要中央管理员令牌；普通来源上传需要写入权限', 403)
      this.outbox.migrate(target)
      return this.collectorState()
    }
    // Browser cannot bypass migration confirmation via central ingestion routes.
    if (['/ingest', '/archive', '/identity'].includes(path)) throw fail('日报接口不存在', 404)
    if (!target) {
      if (method === 'POST' && path === '/settings') {
        if (data.sharedRevision !== undefined && data.sharedRevision !== sharedRevision(this.store.config())) throw fail('中央配置已更新，请重新打开采集设置后重试', 409)
        return this.store.configure(data)
      }
      const value = await this.central(method, path, data, query)
      if (path === '/state') return { ...value, remote: false, canManage: true, sourceId: this.store.originId() }
      return value
    }
    if (method === 'POST' && path === '/settings') {
      const next = settings(data), snapshot = await this.request(connection, 'GET', '/state')
      if (sharedKeys.some(key => next[key] !== snapshot.config[key])) await this.request(connection, 'POST', '/settings', { ...pick(next, sharedKeys), sharedRevision: data.sharedRevision })
      // Only local collection authorization is persisted here. Remote schedule never runs locally.
      this.store.configure({ ...this.store.config(), ...pick(next, captureKeys) })
      return next
    }
    const value = await this.request(connection, method, path, data, query)
    if (path === '/version') return { version: `${value.version}:local:${this.store.version()}` }
    if (path === '/state') return { ...value, remote: true, sourceId: this.store.originId(), config: { ...value.config, ...pick(this.store.config(), captureKeys) }, projects: this.store.overview().projects }
    return value
  }
  start() { this.worker.start(); this.outbox.start() }
  async close() { await this.outbox.close(); await this.worker.close() }
}
