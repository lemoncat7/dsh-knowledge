import { fail } from '../domain.js'
import { object } from './domain.js'
import { calendarIcs } from './ical.js'
export const calendarPaths = new Set(['/calendar-info', '/calendar', '/calendar-event', '/calendar-changes', '/calendar-export', '/calendar-create', '/calendar-update', '/calendar-delete', '/calendar-restore', '/calendar-reorder', '/calendar-progress', '/calendar-progress-write', '/calendar-progress-history', '/calendar-settings', '/calendar-report-settings', '/calendar-report-recheck', '/calendar-workdays-settings', '/calendar-icloud-discover', '/calendar-icloud-connect', '/calendar-icloud-toggle', '/calendar-icloud-disconnect', '/calendar-icloud-sync', '/calendar-icloud-resolve'])
export function calendarRoutes(store, method, path, data, query, signal) {
  if (!calendarPaths.has(path)) return undefined
  const calendar = store.calendar
  const config = () => ({ report: store.reportProgress.status(), workdays: calendar.workdaySettings(), icloud: store.icloud.status() })
  if (method === 'GET' && path === '/calendar-settings') return config()
  if (method === 'POST') {
    if (path === '/calendar-workdays-settings') { calendar.configureWorkdays(data); return config() }
    if (path === '/calendar-report-recheck') { const recheck = store.reportProgress.recheck(object(data, ['from', 'to'])); return { ...config(), recheck } }
    if (path === '/calendar-report-settings') {
      store.reportProgress.configure(object(data, ['enabled']).enabled)
      return config()
    }
    if (path === '/calendar-icloud-discover') return store.icloud.discover(data, signal)
    if (path === '/calendar-icloud-connect') return store.icloud.connect(data, signal)
    if (path === '/calendar-icloud-toggle') {
      store.icloud.toggle(object(data, ['enabled']).enabled)
      if (data.enabled) void store.icloud.begin(true)
      return config()
    }
    if (path === '/calendar-icloud-disconnect') { object(data, []); store.icloud.disconnect(); return config() }
    if (path === '/calendar-icloud-sync') {
      object(data, [])
      if (!store.icloud.config().enabled) throw fail('请先开启 iCloud 同步', 409)
      void store.icloud.begin(true)
      return config()
    }
    if (path === '/calendar-icloud-resolve') {
      store.icloud.resolve(data)
      void store.icloud.begin(true)
      return config()
    }
  }
  if (method === 'GET') {
    if (path === '/calendar-info') {
      const info = calendar.info(), sync = store.icloud.config()
      return { ...info, reportReview: store.reportProgress.status(), externalSync: { ...info.externalSync, connected: !!sync.secret, enabled: sync.enabled,
        name: sync.name ?? null, note: sync.secret ? '支持所选 iCloud 日历的双向同步' : '可在日历设置连接 iCloud' } }
    }
    if (path === '/calendar') return calendar.list(query)
    if (path === '/calendar-event') return { event: calendar.get(query.get('id')) }
    if (path === '/calendar-progress-history') return calendar.progressHistory(query.get('id'), query.get('before'), query.get('limit'))
    if (path === '/calendar-progress') {
      const { progress, createdAt } = calendar.goalProgress(query.get('id'), query.get('day'))
      return { progress, createdAt, calendarId: calendar.calendarId }
    }
    if (path === '/calendar-changes') return calendar.changes(query)
    if (path === '/calendar-export') {
      const q = new URLSearchParams(query); q.set('limit', '500'); q.set('offset', '0'); q.set('deleted', 'exclude')
      const first = calendar.list(q)
      if (first.total > 5000) throw fail('导出范围内超过 5000 条，请缩小日期范围', 413)
      const events = [...first.items]; let next = first.nextOffset
      while (next !== null) { q.set('offset', String(next)); const page = calendar.list(q); events.push(...page.items); next = page.nextOffset }
      return { filename: `工作日历-${first.from}-${first.to}.ics`, contentType: 'text/calendar;charset=utf-8', content: calendarIcs(events), count: events.length }
    }
  }
  if (method === 'POST' && ['/calendar-create', '/calendar-update', '/calendar-delete', '/calendar-restore', '/calendar-reorder', '/calendar-progress-write'].includes(path)) return calendar.mutate(path.slice('/calendar-'.length), data)
  throw fail('日历操作不支持此请求方法', 405)
}
