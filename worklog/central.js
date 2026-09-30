import { createHash } from 'node:crypto'
import { dayOf, fail, text, validDay } from './domain.js'

export const sharedKeys = ['timezone', 'provider', 'model', 'scheduleEnabled', 'scheduleTime']
export const captureKeys = ['enabled', 'scope', 'projects', 'excludedSessions']
export const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]))
export const sharedRevision = config => createHash('sha256').update(JSON.stringify(pick(config, sharedKeys))).digest('hex')
export function sourceKey(sourceId, id) { return `source-${createHash('sha256').update(JSON.stringify([sourceId, id])).digest('hex')}` }
function source(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(value)) throw fail('来源实例标识无效')
  return value
}
function string(value, max, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw fail('来源内容无效或过长')
  return value
}
export function incomingRecord(value, sourceId, timezone) {
  source(sourceId)
  if (!value || typeof value !== 'object' || !Number.isFinite(value.time) || value.time < 0 || value.time > Date.now() + 86400000) throw fail('来源时间无效')
  const originalId = string(value.id, 4096)
  const sessionId = value.sessionId === null ? null : string(value.sessionId, 256)
  if (sessionId !== null && (!Number.isSafeInteger(value.turn) || value.turn < 0)) throw fail('来源轮次无效')
  return { id: sourceKey(sourceId, originalId), originalId, sourceId, day: dayOf(value.time, timezone), time: value.time,
    project: string(value.project, 4096, true), user: string(value.user, 16000), answer: string(value.answer, 32000, true),
    sessionId, turn: sessionId === null ? null : value.turn, truncated: value.truncated === true, route: null, excluded: value.excluded === true }
}

/** Only called after Host or Knowledge bearer authorization. Never trusts client model routes. */
export function createCentral(store, worker, models) {
  return async (method, path, data = {}, query = new URLSearchParams()) => {
    if (method === 'GET') {
      if (path === '/identity') return { id: store.originId(), protocol: 1 }
      if (path === '/version') return { version: `${store.version()}:${dayOf(Date.now(), store.config().timezone)}` }
      if (path === '/models') return { providers: await models() }
      if (path === '/state') return { ...store.overview(), today: dayOf(Date.now(), store.config().timezone), centralId: store.originId(), sharedRevision: sharedRevision(store.config()) }
      if (path === '/day') return store.detail(validDay(query.get('day')))
    }
    if (method !== 'POST') throw fail('日报接口不存在', 404)
    if (path === '/settings') {
      if (data.sharedRevision !== sharedRevision(store.config())) throw fail('中央配置已更新，请重新打开采集设置后重试；本次未覆盖其他端的配置', 409)
      return store.configure({ ...store.config(), ...pick(data, sharedKeys) })
    }
    if (path === '/ingest') {
      const record = incomingRecord(data.record, data.sourceId, store.config().timezone)
      store.importRecord(record)
      return { id: record.id }
    }
    if (path === '/archive') {
      const sourceId = source(data.sourceId), value = data.report
      if (!value || typeof value !== 'object') throw fail('历史日报无效')
      validDay(value.day); string(value.markdown, 100000)
      if (!Number.isFinite(value.updated) || !Number.isSafeInteger(value.revision) || value.revision < 0) throw fail('历史日报版本无效')
      const markdown = value.markdown.replace(/\[依据:([^\]]+)\]/g, (_, id) => `[依据:${sourceKey(sourceId, id)}]`)
      const archive = { day: value.day, markdown, updated: value.updated, revision: value.revision, sourceId, edited: true, covered: [] }
      store.importArchive(sourceKey(sourceId, JSON.stringify(archive)), archive)
      return { imported: true }
    }
    if (path === '/note') { store.note(data.day, data.text, data.project ? text(data.project, 4096) : ''); return {} }
    if (path === '/exclude') { store.exclude(text(data.id, 4096), data.excluded); return {} }
    if (path === '/save') { store.save(validDay(data.day), text(data.markdown), data.revision); return {} }
    if (path === '/generate') { const id = store.enqueue(data.day, data.allowReplace === true); void worker.tick(); return { id } }
    if (path === '/retry') { const id = store.retry(data.id); void worker.tick(); return { id } }
    if (path === '/cancel') { worker.cancel(data.id); return {} }
    throw fail('日报接口不存在', 404)
  }
}
