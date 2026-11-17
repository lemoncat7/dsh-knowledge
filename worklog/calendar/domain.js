import { fail } from '../domain.js'
import { addDays, validDate, localParts, zoneName } from './time.js'
export const statuses = ['planned', 'in_progress', 'done', 'cancelled']
export const eventKeys = ['title', 'description', 'kind', 'status', 'priority', 'day', 'endDay', 'allDay', 'startAt', 'endAt', 'timeZone', 'tags', 'project']
export function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw fail('日历参数无效或包含未知字段')
  return value
}
export function string(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max || /\u0000/.test(value) || required && !value.trim()) throw fail(`内容无效，最多 ${max} 字符`)
  return value.trim()
}
export function integer(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') { if (fallback !== undefined) return fallback; throw fail('缺少版本或分页参数') }
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(n) || n < min || n > max) throw fail('版本或分页参数超出范围')
  return n
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw fail('时间必须是带时区偏移的 ISO 日期，例如 2026-11-17T09:00:00+08:00')
  validDate(value.slice(0, 10))
  return Date.parse(value)
}
export function normalizeEvent(input, defaultZone, previous) {
  object(input, eventKeys)
  if (previous && !Object.keys(input).length) throw fail('修改目标至少需要一个字段')
  const base = previous ? { ...previous, startAt: previous.startAt === null ? null : new Date(previous.startAt).toISOString(), endAt: previous.endAt === null ? null : new Date(previous.endAt).toISOString() } : { description: '', kind: 'goal', status: 'planned', priority: 'normal', allDay: true, timeZone: defaultZone, tags: [], project: '' }
  const v = { ...base, ...input }
  try {
    const title = string(v.title, 160, true), description = string(v.description, 8000), project = string(v.project, 500)
    const timeZone = zoneName(v.timeZone)
    if (!['goal', 'work'].includes(v.kind) || !statuses.includes(v.status) || !['low', 'normal', 'high'].includes(v.priority) || typeof v.allDay !== 'boolean') throw fail('目标类型、状态或优先级无效')
    if (!Array.isArray(v.tags) || v.tags.length > 12) throw fail('标签最多 12 个')
    const tags = [...new Set(v.tags.map(t => string(t, 32, true)))]
    let day, endDay, startAt = null, endAt = null
    if (v.allDay) {
      day = validDate(v.day)
      endDay = validDate(input.endDay ?? (input.day !== undefined || !previous?.allDay ? addDays(day, 1) : v.endDay) ?? addDays(day, 1))
      if (endDay <= day || Date.parse(endDay) - Date.parse(day) > 366 * 86400000) throw fail('结束日期须晚于开始日期，单项不超过 366 天')
      if (input.startAt != null || input.endAt != null) throw fail('全天目标不填写开始/结束时刻')
    } else {
      if (input.day !== undefined || input.endDay !== undefined) throw fail('定时目标请用 startAt/endAt 改期，day/endDay 仅用于全天目标')
      startAt = instant(v.startAt); endAt = instant(v.endAt)
      if (endAt <= startAt || endAt - startAt > 366 * 86400000) throw fail('结束时间须晚于开始时间，单项不超过 366 天')
      day = validDate(localParts(startAt, timeZone).day); endDay = validDate(addDays(localParts(endAt - 1, timeZone).day, 1))
    }
    return { title, description, kind: v.kind, status: v.status, priority: v.priority, allDay: v.allDay, timeZone, day, endDay, startAt, endAt, tags, project }
  } catch (e) { if (e.status) throw e; throw fail(e.message) }
}
