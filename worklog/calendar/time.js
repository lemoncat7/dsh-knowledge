const timeError = message => Object.assign(new Error(message), { status: 400 })
/** Shared calendar math. Dates are civil days; timed intervals are absolute instants. */
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2200-12-31' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw timeError('请输入有效日期（1900—2200 年）')
  return value
}
export function addDays(day, count) { return new Date(Date.parse(day + 'T12:00:00Z') + count * 86400000).toISOString().slice(0, 10) }
export function zoneName(zone) {
  if (typeof zone !== 'string' || zone.length > 100) throw timeError('时区无效')
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(0) } catch { throw timeError('请输入有效 IANA 时区，例如 Asia/Shanghai') }
  return zone
}
export function localParts(at, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, second: p.second }
}
export function wallTime(day, time, zone, ambiguity = 'reject') {
  validDate(day); zoneName(zone)
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw timeError('时间应为 00:00—23:59')
  const naive = Date.parse(`${day}T${time}:00Z`), offsets = new Set()
  for (let n = -48; n <= 48; n += 6) {
    const at = naive + n * 3600000, p = localParts(at, zone)
    offsets.add(Date.parse(`${p.day}T${p.time}:${p.second}Z`) - at)
  }
  const found = [...offsets].map(offset => naive - offset).filter(at => { const p = localParts(at, zone); return p.day === day && p.time === time }).sort((a, b) => a - b)
  if (!found.length) throw timeError('该时刻因时区或夏令时调整不存在，请选择其他时间')
  if (found.length > 1 && ambiguity === 'reject') throw timeError('该时刻在夏令时切换中出现两次，请选择其他时间，或通过 API 指定 UTC 偏移')
  return found[0]
}
const dayCache = new Map()
export function startOfDay(day, zone) {
  const key = `${day}:${zone}`
  if (dayCache.has(key)) return dayCache.get(key)
  // Some zones move forward at midnight. A civil day starts at its first real minute.
  for (let hour = 0; hour < 4; hour++) { try { const at = wallTime(day, `${String(hour).padStart(2, '0')}:00`, zone, 'earlier'); if (dayCache.size > 512) dayCache.clear(); dayCache.set(key, at); return at } catch {} }
  throw timeError('该日期在所选时区不存在')
}
export function monthDays(day) {
  const first = day.slice(0, 7) + '-01', weekday = new Date(first + 'T12:00:00Z').getUTCDay()
  const start = addDays(first, -((weekday + 6) % 7))
  return Array.from({ length: 42 }, (_, i) => addDays(start, i))
}
export function weekDays(day) {
  const weekday = new Date(day + 'T12:00:00Z').getUTCDay(), start = addDays(day, -((weekday + 6) % 7))
  return Array.from({ length: 7 }, (_, i) => addDays(start, i))
}
export function eventOnDay(event, day, zone) {
  if (event.allDay) return event.day <= day && event.endDay > day
  return event.startAt < startOfDay(addDays(day, 1), zone) && event.endAt > startOfDay(day, zone)
}
