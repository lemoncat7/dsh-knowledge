import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fail } from '../domain.js'
import { object, normalizeEvent, string } from './domain.js'
import { localParts } from './time.js'
import { AppleCalendarClient, appleURL, calendarPatch, decodeEvent, encodeEvent, projection } from './caldav.js'
import { normalizeGroups } from './groups.js'

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
  mappings(config = this.config()) {
    return config.mappings ?? (config.connection ? [{ groupId: 'default', connection: config.connection, url: config.url, name: config.name, since: config.since, direction: 'both' }] : [])
  }
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
    const mappings = this.mappings(config), groups = this.store.calendar.groups()
    const issues = mappings.flatMap(mapping => this.db.prepare(`SELECT uid,body FROM calendar_icloud WHERE connection=?
      AND json_extract(body,'$.issue') IS NOT NULL ORDER BY uid LIMIT 100`).all(mapping.connection)
      .map(row => ({ uid: row.uid, groupId: mapping.groupId, groupName: groups.items.find(group => group.id === mapping.groupId)?.name,
        ...JSON.parse(row.body).issue }))).slice(0, 100)
    return { enabled: config.enabled, connected: !!config.secret, name: config.name ?? null, since: config.since ?? null,
      account: config.account ?? null, revision: config.revision ?? 0,
      mappings: mappings.map(({ groupId, url, name, direction, since }) => ({ groupId, calendar: url, name, direction, since })),
      running: !!this.running, last: config.secret ? this.meta('calendarICloudLast') : null, issues }
  }
  async calendars(signal, refresh = false) {
    const config = this.config()
    if (!config.secret) throw fail('请先登录 iCloud', 409)
    if (!refresh && this.discovery?.generation === config.generation && this.discovery.expires > Date.now()) return { calendars: this.discovery.calendars }
    const { account, password } = this.decrypt(config.secret)
    const calendars = await this.client(account, password).discover(signal)
    if (this.config().generation !== config.generation) throw fail('账号连接已变化，请重新读取', 409)
    this.discovery = { generation: config.generation, expires: Date.now() + interval, calendars }
    return { calendars }
  }
  async configureMappings(data, signal) {
    object(data, ['revision', 'mappings', 'groupsRevision', 'createGroups'])
    const config = this.config()
    if (!config.secret) throw fail('请先登录 iCloud', 409)
    if (data.revision !== (config.revision ?? 0)) throw fail('账号同步设置已变化，请重新读取', 409)
    if (!Array.isArray(data.mappings) || data.mappings.length > 100) throw fail('同步关联最多 100 组')
    const previousGroups = this.store.calendar.groups()
    if (data.createGroups !== undefined && (!Array.isArray(data.createGroups) || data.createGroups.length > 100)) throw fail('待创建分组无效')
    const additions = data.createGroups ?? []
    if (additions.length && data.groupsRevision !== previousGroups.revision) throw fail('本地分组已变化，请重新读取后再保存', 409)
    const groups = additions.length ? normalizeGroups({ revision: previousGroups.revision, items: [...previousGroups.items, ...additions] }) : previousGroups
    if (additions.some(group => !data.mappings.some(mapping => mapping.groupId === group.id))) throw fail('新分组必须有关联的账号日历')
    const { calendars } = await this.calendars(signal)
    const { account } = this.decrypt(config.secret)
    const old = this.mappings(config)
    const mappings = data.mappings.map(item => {
      object(item, ['groupId', 'calendar', 'direction'])
      const selected = calendars.find(calendar => calendar.id === item.calendar)
      if (!groups.items.some(group => group.id === item.groupId) || !selected || !['both', 'push', 'pull', 'off'].includes(item.direction)) throw fail('请从当前分组和账号日历中选择同步关联')
      if (selected.writable === false && ['both', 'push'].includes(item.direction)) throw fail('只读账号日历只能选择下载或暂停')
      const connection = digest([account, selected.id]), previous = old.find(mapping => mapping.connection === connection)
      // Existing bindings are scoped to one group; remapping a populated remote calendar
      // would otherwise import duplicates or delete events in a different group.
      if (previous && previous.groupId !== item.groupId && this.db.prepare('SELECT 1 FROM calendar_icloud WHERE connection=? LIMIT 1').get(connection)) throw fail('此账号日历已有分组关联，请保留原分组并修改分组名称，或选择其他日历', 409)
      if (this.db.prepare(`SELECT 1 FROM calendar_icloud b LEFT JOIN calendar_events e ON e.id=b.local_id
        WHERE b.connection=? AND (e.id IS NULL OR COALESCE(json_extract(e.body,'$.groupId'),'default')<>?) LIMIT 1`).get(connection, item.groupId)) throw fail('此账号日历仍有其他分组的同步记录，不能交叉关联', 409)
      return { groupId: item.groupId, connection, url: selected.id, name: selected.name, direction: item.direction,
        since: previous?.since ?? localParts(Date.now(), this.store.config().timezone).day }
    })
    if (new Set(mappings.map(mapping => mapping.groupId)).size !== mappings.length || new Set(mappings.map(mapping => mapping.url)).size !== mappings.length) throw fail('每个分组和账号日历只能关联一次')
    signal?.throwIfAborted()
    if (this.config().generation !== config.generation || this.store.calendar.groups().revision !== groups.revision) throw fail('分组或账号设置已变化，请重新读取', 409)
    if (equal(mappings, old) && !additions.length) return this.status()
    this.controller?.abort()
    this.transaction(() => {
      if (this.store.calendar.groups().revision !== previousGroups.revision || this.config().generation !== config.generation) throw fail('分组或账号设置已变化，请重新读取', 409)
      if (additions.length) this.store.setMeta('calendarGroups', { ...groups, revision: groups.revision + 1 })
      this.store.setMeta('calendarICloud', { ...config, mappings, revision: (config.revision ?? 0) + 1, generation: randomUUID() })
    })
    this.next = 0
    return this.status()
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
    if (!selected || selected.writable === false) throw fail('请从账号可写日历列表里选择日历')
    signal?.throwIfAborted()
    this.controller?.abort()
    const previous = this.config(), connection = digest([account,url])
    const since = this.meta('calendarICloudSince:' + connection)
    const secret = this.encrypt({ account, password })
    this.transaction(() => {
      this.store.setMeta('calendarICloud', { enabled: false, connection, url, name: selected.name, since, account,
        revision: (previous.revision ?? 0) + 1, secret, generation: randomUUID() })
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
        const mappings = this.mappings(config).map(mapping => ({ ...mapping, since: mapping.since ?? since }))
        this.store.setMeta('calendarICloud', { ...config, enabled, since, mappings, revision: (config.revision ?? 0) + 1, generation: randomUUID() })
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
      ON CONFLICT(connection,uid) DO UPDATE SET local_id=excluded.local_id,body=excluded.body
      WHERE calendar_icloud.local_id IS NOT excluded.local_id OR calendar_icloud.body<>excluded.body`).run(connection,uid,localId ?? null,JSON.stringify(body))
  }
  resolve(data) {
    object(data, ['uid','key','choice','groupId'])
    const config = this.config()
    if (!config.enabled) throw fail('请先开启 iCloud 同步', 409)
    const uid = string(data.uid, 512, true)
    const candidates = this.mappings(config).filter(mapping => !data.groupId || mapping.groupId === data.groupId)
      .map(mapping => ({ mapping, binding: this.bindings(mapping.connection).get(uid) })).filter(item => item.binding?.issue?.key === data.key)
    if (candidates.length !== 1) throw fail('待处理事项已变化，请刷新后重新选择', 409)
    const { mapping, binding } = candidates[0]
    const allowed = binding?.issue?.type === 'local-missing' ? ['keep-icloud', 'remove-icloud'] :
      binding?.issue?.type === 'remote-missing' ? ['keep-knowledge', 'remove-knowledge', 'restore-icloud'] :
      binding?.issue?.type === 'conflict' ? ['knowledge', 'icloud'] : []
    if (!allowed.includes(data.choice) || binding.issue.key !== data.key) throw fail('待处理事项已变化，请刷新后重新选择', 409)
    if (data.choice === 'keep-icloud' || data.choice === 'keep-knowledge') {
      this.saveBinding(mapping.connection, { ...binding, detached: data.choice, issue: undefined, resolution: undefined })
    } else {
      this.saveBinding(mapping.connection, { ...binding, resolution: { key: data.key, choice: data.choice } })
    }
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
        const client = this.client(account,password), result = { pulled: 0, pushed: 0, removed: 0 }, errors = []
        const mappings = this.mappings(config)
        for (const mapping of mappings) {
          if (mapping.direction === 'off') continue
          try {
            const counts = await this.sync({ ...config, ...mapping }, client, signal, assertActive)
            for (const key of Object.keys(result)) result[key] += counts[key]
          } catch (e) {
            assertActive()
            errors.push({ groupId: mapping.groupId, message: e.status ? e.message : '此分组同步未完成，下次会重试' })
          }
        }
        assertActive()
        this.store.setMeta('calendarICloudLast', { time: Date.now(), state: errors.length ? 'error' : 'ok', ...result,
          ...(errors.length ? { errors, message: `${errors.length} 个分组同步未完成，其他分组已继续处理；可重试同步` } : {}) })
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
    let pulled = 0, pushed = 0, removed = 0
    for (const [uid, ext] of remote) {
      assertActive()
      let mapped = bindings.get(uid)
      if (mapped?.writing && ext.fields && equal(mapped.writing.fields, ext.fields)) {
        mapped = { ...mapped, base: mapped.writing.fields, writing: undefined }
        write(mapped)
      }
      const local = mapped && this.localEvent(mapped.localId)
      const localMissing = !local || local.deletedAt !== null
      if (local && (local.groupId ?? 'default') !== (config.groupId ?? 'default')) continue
      if (localMissing && mapped?.detached === 'keep-icloud') continue
      if (duplicate.has(uid) || !ext.fields) {
        if (mapped) issue(mapped, 'unsupported', local ? projection(local) : null, ext)
        continue
      }
      if (!mapped) {
        // Recover a PUT which succeeded before the local binding was saved.
        const row = this.db.prepare('SELECT body FROM calendar_events WHERE uid=?').get(uid)
        const local = row && JSON.parse(row.body)
        if (local) {
          if ((local.groupId ?? 'default') !== (config.groupId ?? 'default')) continue
          if (this.db.prepare('SELECT 1 FROM calendar_icloud WHERE connection=? AND local_id=?').get(config.connection, local.id)) continue
          const binding = { uid, localId: local.id, href: ext.href, etag: ext.etag }
          if (local.deletedAt === null && (local.groupId ?? 'default') === (config.groupId ?? 'default') && equal(projection(local), ext.fields)) clean(binding, ext, ext.fields)
          else issue(binding, 'conflict', projection(local), ext)
        } else if (config.direction !== 'push' && fieldsInRange(ext.fields)) {
          this.transaction(() => {
            if (this.db.prepare('SELECT 1 FROM calendar_icloud WHERE connection=? AND uid=?').get(config.connection, uid)) return
            const event = { ...normalizeEvent({ ...calendarPatch(ext.fields, timezone), kind: ext.kind ?? 'event', groupId: config.groupId ?? 'default' }, timezone), id: randomUUID(), uid: randomUUID()+'@dsh-knowledge',
              revision: 1, createdAt: now, updatedAt: now, deletedAt: null, completedAt: null }
            if (this.db.prepare('SELECT count(*) AS n FROM calendar_events').get().n >= 100000) throw fail('本地日历条目已达上限', 409)
            calendar.saveEvent(event); clean({ uid, localId: event.id }, ext, ext.fields); pulled++
          })
        }
        continue
      }
      if (localMissing) {
        if (mapped.deleted && local?.deletedAt != null && local.revision === mapped.localRevision && config.direction !== 'push') {
          this.transaction(() => {
            const current = this.localEvent(local.id)
            if (current?.revision !== local.revision) return
            const restored = { ...current, ...normalizeEvent(calendarPatch(ext.fields, timezone), timezone, current), deletedAt: null,
              revision: current.revision + 1, updatedAt: Math.max(now, current.updatedAt + 1) }
            calendar.saveEvent(restored); clean(mapped, ext, ext.fields); pulled++
          })
          continue
        }
        const key = digest(['local-missing', null, ext.etag])
        const unchanged = mapped.base && equal(projection(mapped.base), ext.fields)
        const explicit = mapped.resolution?.choice === 'remove-icloud' && mapped.resolution.key === key
        if (config.direction !== 'pull' && (explicit || local?.deletedAt != null && unchanged)) {
          try {
            write({ ...mapped, deleting: { localRevision: local?.revision, etag: ext.etag } })
            await client.remove(ext.href, ext.etag, signal)
            assertActive()
            write({ ...mapped, deleted: 'local', localRevision: local?.revision, issue: undefined, resolution: undefined })
            removed++
          } catch (e) {
            if (e.status !== 409) throw e
            issue({ ...mapped, resolution: undefined }, 'local-missing', null, ext)
          }
        } else issue(mapped, 'local-missing', null, ext)
        continue
      }
      const fields = projection(local)
      // Older bindings never shared a description. Empty is the common starting point
      // so independent non-empty notes on both sides surface as a conflict.
      const legacy = mapped.base && !Object.hasOwn(mapped.base, 'description')
      const base = mapped.base ? projection(mapped.base) : undefined
      const localChanged = !equal(fields, base), remoteChanged = !equal(ext.fields, base)
      let direction = localChanged ? 'knowledge' : remoteChanged ? 'icloud' : null
      if (equal(fields, ext.fields)) { if (mapped.etag !== ext.etag || mapped.issue || mapped.detached || localChanged || legacy) clean(mapped, ext, fields); continue }
      if (localChanged && remoteChanged) {
        const conflictKey = digest(['conflict', fields, ext.etag])
        if (mapped.resolution?.key !== conflictKey) { issue(mapped, 'conflict', fields, ext); continue }
        direction = mapped.resolution.choice
      }
      if (direction === 'icloud' && config.direction === 'push' || direction === 'knowledge' && config.direction === 'pull') { issue(mapped, 'direction', fields, ext); continue }
      if (direction === 'icloud') {
        this.transaction(() => {
          const current = this.localEvent(local.id)
          if (!current || current.revision !== local.revision) return
          const updated = { ...current, ...normalizeEvent(calendarPatch(ext.fields, timezone), timezone, current),
            revision: current.revision + 1, updatedAt: Math.max(now, current.updatedAt + 1) }
          calendar.saveEvent(updated); clean(mapped, ext, ext.fields); pulled++
        })
      } else if (direction === 'knowledge') {
        try {
          write({ ...mapped, writing: { fields, localRevision: local.revision } })
          await client.put(ext.href, encodeEvent(uid, fields, now, ext.data, local.kind), ext.etag, signal)
        }
        catch (e) { if (e.status === 409) { issue(mapped, 'stale', fields, ext); continue } throw e }
        assertActive(); clean(mapped, ext, fields); pushed++
      }
    }
    for (const [uid, binding] of bindings) {
      assertActive()
      if (remote.has(uid)) continue
      const local = this.localEvent(binding.localId)
      if (local?.deletedAt === null && (local.groupId ?? 'default') === (config.groupId ?? 'default')) {
        if (binding.detached === 'keep-knowledge') continue
        const fields = projection(local), key = digest(['remote-missing', fields, undefined])
        const restore = binding.deleted || binding.creating || binding.deleting && local.revision > binding.deleting.localRevision || binding.resolution?.key === key && binding.resolution.choice === 'restore-icloud'
        if (restore && config.direction !== 'pull') {
          const href = appleURL(encodeURIComponent(uid) + '.ics', remoteCalendar).href
          try { await client.put(href, encodeEvent(uid, fields, now, undefined, local.kind), null, signal) }
          catch (e) { if (e.status === 409) { issue(binding, 'stale', fields, null); continue } throw e }
          assertActive(); clean(binding, { href, etag: null }, fields); pushed++
        } else if (!restore && config.direction !== 'push' && (binding.base && equal(fields, projection(binding.base)) ||
            binding.resolution?.key === key && binding.resolution.choice === 'remove-knowledge')) {
          this.transaction(() => {
            const current = this.localEvent(local.id)
            if (!current || current.revision !== local.revision) return
            calendar.saveEvent({ ...current, revision: current.revision + 1, updatedAt: Math.max(now, current.updatedAt + 1), deletedAt: now })
            write({ ...binding, deleted: 'remote', localRevision: current.revision + 1, issue: undefined, resolution: undefined }); removed++
          })
        } else issue(binding, 'remote-missing', fields, null)
      } else if (binding.issue || binding.resolution || binding.deleting || binding.creating) {
        write({ ...binding, deleted: binding.deleted ?? 'local', localRevision: binding.deleting?.localRevision ?? local?.revision,
          deleting: undefined, creating: undefined, issue: undefined, resolution: undefined })
      }
    }
    if (config.direction === 'pull') return { pulled, pushed, removed }
    const pending = this.db.prepare(`SELECT body FROM calendar_events e WHERE deleted_at IS NULL AND end_day>?
      AND COALESCE(json_extract(body,'$.groupId'),'default')=? AND NOT EXISTS
      (SELECT 1 FROM calendar_icloud WHERE connection=? AND local_id=e.id) ORDER BY day LIMIT 60`).all(config.since, config.groupId ?? 'default', config.connection)
    for (const row of pending) {
      assertActive()
      const saved = JSON.parse(row.body), local = this.localEvent(saved.id)
      if (!local || local.deletedAt !== null || (local.groupId ?? 'default') !== (config.groupId ?? 'default') ||
          this.db.prepare('SELECT 1 FROM calendar_icloud WHERE connection=? AND local_id=?').get(config.connection, local.id)) continue
      const fields = projection(local), uid = local.uid
      const href = appleURL(encodeURIComponent(uid) + '.ics', remoteCalendar).href
      try {
        write({ uid, localId: local.id, href, base: fields, creating: true })
        await client.put(href, encodeEvent(uid, fields, now, undefined, local.kind), null, signal)
      }
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
    return { pulled, pushed, removed }
  }
}
