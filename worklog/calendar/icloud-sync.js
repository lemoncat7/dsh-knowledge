import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fail } from '../domain.js'
import { object, normalizeEvent, string } from './domain.js'
import { localParts } from './time.js'
import { AppleCalendarClient, appleURL, calendarPatch, decodeEvent, encodeEvent, projection } from './caldav.js'

const interval = 5 * 60_000
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right)

function credentials(data) {
  const account = string(data.account, 254, true).toLowerCase(), password = string(data.password, 128, true)
  if (!/^[^\s:@]+@[^\s:@]+$/.test(account) || !/^[\w-]{12,128}$/.test(password)) throw fail('请输入 Apple 账户邮箱和应用专用密码')
  return { account, password }
}

export class ICloudSync {
  constructor(store, keyPath, client = (account, password) => new AppleCalendarClient(account, password), active = () => true) {
    this.store = store; this.db = store.db; this.keyPath = keyPath; this.client = client; this.active = active
    this.db.exec(`CREATE TABLE IF NOT EXISTS calendar_icloud (
      connection TEXT NOT NULL, uid TEXT NOT NULL, local_id TEXT, body TEXT NOT NULL, PRIMARY KEY(connection,uid));
      CREATE UNIQUE INDEX IF NOT EXISTS calendar_icloud_local ON calendar_icloud(connection,local_id);`)
  }
  config() { return this.meta('calendarICloud') ?? { enabled: false } }
  meta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)
    return row ? JSON.parse(row.value) : null
  }
  key(create = false) {
    if (this.privateKey) return this.privateKey
    if (!this.keyPath) return (this.privateKey = randomBytes(32))
    try { this.privateKey = readFileSync(this.keyPath) }
    catch (e) {
      if (e.code !== 'ENOENT' || !create) throw fail('iCloud 凭据无法解锁，请重新连接', 409)
      try { writeFileSync(this.keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
      this.privateKey = readFileSync(this.keyPath)
    }
    if (this.privateKey.length !== 32) { this.privateKey = undefined; throw fail('iCloud 凭据密钥无效，请检查数据目录', 409) }
    return this.privateKey
  }
  encrypt(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key(true), iv)
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: bytes.toString('base64') }
  }
  decrypt(value) {
    try {
      const cipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(value.iv, 'base64'))
      cipher.setAuthTag(Buffer.from(value.tag, 'base64'))
      return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]))
    } catch { throw fail('iCloud 凭据无法解锁，请重新连接', 409) }
  }
  status() {
    const config = this.config()
    const issues = config.connection ? this.db.prepare(`SELECT uid,body FROM calendar_icloud WHERE connection=?
      AND json_extract(body,'$.issue') IS NOT NULL ORDER BY uid LIMIT 100`).all(config.connection)
      .map(row => ({ uid: row.uid, ...JSON.parse(row.body).issue })) : []
    return { enabled: config.enabled, connected: !!config.secret, name: config.name ?? null, since: config.since ?? null,
      running: !!this.running, last: config.connection ? this.meta('calendarICloudLast') : null, issues }
  }
  async discover(data, signal) {
    object(data, ['account','password'])
    const { account, password } = credentials(data)
    return { calendars: await this.client(account,password).discover(signal) }
  }
  async connect(data, signal) {
    object(data, ['account','password','calendar'])
    const { account, password } = credentials(data), url = appleURL(string(data.calendar, 1500, true)).href
    const calendars = await this.client(account,password).discover(signal)
    const selected = calendars.find(calendar => calendar.id === url)
    if (!selected) throw fail('请从账号可写日历列表里选择日历')
    signal?.throwIfAborted()
    this.controller?.abort()
    const previous = this.config(), connection = digest([account,url])
    const since = this.meta('calendarICloudSince:' + connection)
    const secret = this.encrypt({ account, password })
    this.transaction(() => {
      this.store.setMeta('calendarICloud', { enabled: false, connection, url, name: selected.name, since,
        secret, generation: randomUUID() })
      if (previous.connection !== connection) this.store.setMeta('calendarICloudLast', null)
    })
    return this.status()
  }
  toggle(enabled) {
    if (typeof enabled !== 'boolean') throw fail('iCloud 同步开关无效')
    const config = this.config()
    if (enabled && !config.secret) throw fail('请先连接 iCloud 并选择日历', 409)
    if (config.enabled !== enabled) {
      this.controller?.abort()
      this.transaction(() => {
        const since = config.since ?? (enabled ? localParts(Date.now(), this.store.config().timezone).day : null)
        if (since && !config.since) this.store.setMeta('calendarICloudSince:' + config.connection, since)
        this.store.setMeta('calendarICloud', { ...config, enabled, since, generation: randomUUID() })
      })
      this.next = 0
    }
    return this.status()
  }
  disconnect() {
    this.controller?.abort()
    this.store.setMeta('calendarICloud', { enabled: false, generation: randomUUID() })
    return this.status()
  }
  bindings(connection) {
    return new Map(this.db.prepare('SELECT uid,local_id,body FROM calendar_icloud WHERE connection=?').all(connection)
      .map(row => [row.uid, { uid: row.uid, localId: row.local_id, ...JSON.parse(row.body) }]))
  }
  saveBinding(connection, { uid, localId, ...body }) {
    this.db.prepare(`INSERT INTO calendar_icloud VALUES (?,?,?,?)
      ON CONFLICT(connection,uid) DO UPDATE SET local_id=excluded.local_id,body=excluded.body`).run(connection,uid,localId ?? null,JSON.stringify(body))
  }
  resolve(data) {
    object(data, ['uid','key','choice'])
    const config = this.config()
    if (!config.enabled) throw fail('请先开启 iCloud 同步', 409)
    const binding = this.bindings(config.connection).get(string(data.uid, 512, true))
    if (!binding || binding.issue?.type !== 'conflict' || binding.issue.key !== data.key ||
        !['knowledge','icloud'].includes(data.choice)) throw fail('冲突已变化，请刷新后重新选择', 409)
    this.saveBinding(config.connection, { ...binding, resolution: { key: data.key, choice: data.choice } })
    this.next = 0
    return this.status()
  }
  begin(force = false) {
    if (this.running) return this.running
    const config = this.config()
    if (!config.enabled || !this.active() || !force && Date.now() < (this.next ?? 0)) return Promise.resolve()
    this.next = Date.now() + interval
    this.controller = new AbortController()
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(90_000)])
    const assertActive = () => {
      signal.throwIfAborted()
      if (!this.active() || this.config().generation !== config.generation) throw Error('Calendar settings changed')
    }
    this.running = (async () => {
      try {
        const { account, password } = this.decrypt(config.secret)
        const result = await this.sync(config, this.client(account,password), signal, assertActive)
        assertActive()
        this.store.setMeta('calendarICloudLast', { time: Date.now(), state: 'ok', ...result })
      } catch (e) {
        if ((!signal.aborted || signal.reason?.name === 'TimeoutError') && this.active() && this.config().generation === config.generation) {
          this.store.setMeta('calendarICloudLast', { time: Date.now(), state: 'error', message: e.status ? e.message : 'iCloud 同步未完成，下次会重试' })
        }
      }
    })().finally(() => { this.running = undefined; this.controller = undefined })
    return this.running
  }
  async close() { this.controller?.abort(); await this.running }
  transaction(run) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = run(); this.db.exec('COMMIT'); return result }
    catch (e) { this.db.exec('ROLLBACK'); throw e }
  }
  localEvent(id) {
    const row = this.db.prepare('SELECT body FROM calendar_events WHERE id=?').get(id)
    return row ? JSON.parse(row.body) : null
  }
  async sync(config, client, signal, assertActive) {
    const timezone = this.store.config().timezone, calendar = this.store.calendar, now = Date.now()
    const { calendar: remoteCalendar, entries } = await client.list(config.url, signal)
    assertActive()
    const remote = new Map(), duplicate = new Set()
    for (const entry of entries) {
      const event = decodeEvent(entry, timezone)
      if (event.uid) {
        if (remote.has(event.uid)) duplicate.add(event.uid)
        remote.set(event.uid, event)
      }
    }
    const bindings = this.bindings(config.connection)
    const write = binding => this.saveBinding(config.connection, binding)
    const clean = (binding, event, fields) => write({ uid: binding.uid, localId: binding.localId, href: event.href, etag: event.etag, base: fields })
    function issue(binding, type, local, external) {
      const key = digest([type, local, external?.etag])
      write({ ...binding, issue: { type, key, title: local?.title ?? external?.fields?.title ?? '日历目标',
        local: local ?? null, icloud: external?.fields ?? null },
        resolution: binding.resolution?.key === key ? binding.resolution : undefined })
      return key
    }
    const fieldsInRange = fields => (fields.allDay ? fields.endDay > config.since : localParts(fields.endAt - 1, timezone).day >= config.since)
    let pulled = 0, pushed = 0
    for (const [uid, ext] of remote) {
      assertActive()
      const mapped = bindings.get(uid)
      if (duplicate.has(uid) || !ext.fields) {
        if (mapped) issue(mapped, 'unsupported', mapped.localId && this.localEvent(mapped.localId) ? projection(this.localEvent(mapped.localId)) : null, ext)
        continue
      }
      if (!mapped) {
        // Recover a PUT which succeeded before the local binding was saved.
        const row = this.db.prepare('SELECT body FROM calendar_events WHERE uid=?').get(uid)
        const local = row && JSON.parse(row.body)
        if (local) {
          if (this.db.prepare('SELECT 1 FROM calendar_icloud WHERE connection=? AND local_id=?').get(config.connection, local.id)) continue
          const binding = { uid, localId: local.id, href: ext.href, etag: ext.etag }
          if (local.deletedAt === null && local.kind === 'goal' && equal(projection(local), ext.fields)) clean(binding, ext, ext.fields)
          else issue(binding, 'conflict', projection(local), ext)
        } else if (fieldsInRange(ext.fields)) {
          this.transaction(() => {
            if (this.db.prepare('SELECT 1 FROM calendar_icloud WHERE connection=? AND uid=?').get(config.connection, uid)) return
            const event = { ...normalizeEvent(calendarPatch(ext.fields, timezone), timezone), id: randomUUID(), uid: randomUUID()+'@dsh-knowledge',
              revision: 1, createdAt: now, updatedAt: now, deletedAt: null, completedAt: null }
            if (this.db.prepare('SELECT count(*) AS n FROM calendar_events').get().n >= 100000) throw fail('本地日历条目已达上限', 409)
            calendar.saveEvent(event); clean({ uid, localId: event.id }, ext, ext.fields); pulled++
          })
        }
        continue
      }
      const local = this.localEvent(mapped.localId)
      if (!local || local.deletedAt !== null || local.kind !== 'goal') { issue(mapped, 'local-missing', null, ext); continue }
      const fields = projection(local)
      // Older bindings never shared a description. Empty is the common starting point
      // so independent non-empty notes on both sides surface as a conflict.
      const legacy = mapped.base && !Object.hasOwn(mapped.base, 'description')
      const base = legacy ? projection(mapped.base) : mapped.base
      const localChanged = !equal(fields, base), remoteChanged = !equal(ext.fields, base)
      let direction = localChanged ? 'knowledge' : remoteChanged ? 'icloud' : null
      if (equal(fields, ext.fields)) { if (mapped.etag !== ext.etag || mapped.issue || localChanged || legacy) clean(mapped, ext, fields); continue }
      if (localChanged && remoteChanged) {
        const conflictKey = digest(['conflict', fields, ext.etag])
        if (mapped.resolution?.key !== conflictKey) { issue(mapped, 'conflict', fields, ext); continue }
        direction = mapped.resolution.choice
      }
      if (direction === 'icloud') {
        this.transaction(() => {
          const current = this.localEvent(local.id)
          if (!current || current.revision !== local.revision) return
          const updated = { ...current, ...normalizeEvent(calendarPatch(ext.fields, timezone), timezone, current),
            revision: current.revision + 1, updatedAt: Math.max(now, current.updatedAt + 1) }
          calendar.saveEvent(updated); clean(mapped, ext, ext.fields); pulled++
        })
      } else if (direction === 'knowledge') {
        try { await client.put(ext.href, encodeEvent(uid, fields, now, ext.data), ext.etag, signal) }
        catch (e) { if (e.status === 409) { issue(mapped, 'stale', fields, ext); continue } throw e }
        assertActive(); clean(mapped, ext, fields); pushed++
      }
    }
    for (const [uid, binding] of bindings) {
      if (remote.has(uid)) continue
      const local = this.localEvent(binding.localId)
      if (local?.deletedAt === null) issue(binding, 'remote-missing', projection(local), null)
    }
    const pending = this.db.prepare(`SELECT body FROM calendar_events e WHERE deleted_at IS NULL AND end_day>?
      AND json_extract(body,'$.kind')='goal' AND NOT EXISTS
      (SELECT 1 FROM calendar_icloud WHERE connection=? AND local_id=e.id) ORDER BY day LIMIT 60`).all(config.since, config.connection)
    for (const row of pending) {
      assertActive()
      const saved = JSON.parse(row.body), local = this.localEvent(saved.id)
      if (!local || local.deletedAt !== null || local.kind !== 'goal' ||
          this.db.prepare('SELECT 1 FROM calendar_icloud WHERE connection=? AND local_id=?').get(config.connection, local.id)) continue
      const fields = projection(local), uid = local.uid
      const href = appleURL(encodeURIComponent(uid) + '.ics', remoteCalendar).href
      try { await client.put(href, encodeEvent(uid, fields, now), null, signal) }
      catch (e) {
        if (e.status === 409) {
          write({ uid, localId: local.id, href, issue: { type: 'stale', key: digest(['stale', uid]), title: fields.title, local: fields, icloud: null } })
          continue
        }
        throw e
      }
      assertActive()
      write({ uid, localId: local.id, href, base: fields, etag: null })
      pushed++
    }
    return { pulled, pushed }
  }
}
