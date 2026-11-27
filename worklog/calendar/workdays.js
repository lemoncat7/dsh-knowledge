import { fail } from '../domain.js'
import { addDays, validDate } from './time.js'

export const defaultWorkdays = () => ({ revision: 0, weekdays: [1, 2, 3, 4, 5], overrides: [] })

export function normalizeWorkdays(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['revision', 'weekdays', 'overrides'].includes(key))) throw fail('工作日设置无效')
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw fail('工作日设置版本无效')
  if (!Array.isArray(value.weekdays) || !value.weekdays.length || value.weekdays.length > 7 || value.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) throw fail('请至少选择每周一个工作日')
  if (!Array.isArray(value.overrides) || value.overrides.length > 366) throw fail('自定义日期最多 366 项')
  const dates = new Set()
  const overrides = value.overrides.map(item => {
    if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['day', 'workday'].includes(key)) || typeof item.workday !== 'boolean') throw fail('自定义日期设置无效')
    const day = validDate(item.day)
    if (dates.has(day)) throw fail('自定义日期不能重复')
    dates.add(day)
    return { day, workday: item.workday }
  }).sort((a, b) => a.day.localeCompare(b.day))
  return { revision: value.revision, weekdays: [...new Set(value.weekdays)].sort((a, b) => a - b), overrides }
}

export function isWorkday(day, settings) {
  const override = settings.overrides.find(item => item.day === day)
  return override ? override.workday : settings.weekdays.includes(new Date(day + 'T12:00:00Z').getUTCDay() || 7)
}

export function nextWorkday(after, settings) {
  let day = after
  // At least one weekly workday and at most 366 date overrides bound this search.
  for (let i = 0; i < 2600; i++) {
    day = validDate(addDays(day, 1))
    if (isWorkday(day, settings)) return day
  }
  throw fail('未找到下一个工作日，请检查设置')
}
