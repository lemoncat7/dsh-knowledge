import { fail } from '../domain.js'
import { calendarIcs } from './ical.js'
export const calendarPaths = new Set(['/calendar-info', '/calendar', '/calendar-event', '/calendar-changes', '/calendar-export', '/calendar-create', '/calendar-update', '/calendar-delete', '/calendar-restore', '/calendar-reorder', '/calendar-progress', '/calendar-progress-write', '/calendar-progress-history'])
export function calendarRoutes(store, method, path, data, query) {
  if (!calendarPaths.has(path)) return undefined
  const calendar = store.calendar
  if (method === 'GET') {
    if (path === '/calendar-info') return calendar.info()
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
