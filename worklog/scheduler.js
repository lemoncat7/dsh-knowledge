import { dayOf } from './domain.js'

function localTime(now, timezone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(now))
}

// Use civil dates rather than 24-hour offsets: DST days need not be 24 hours.
export function scheduledDay(config, state, now) {
  if (!config.scheduleEnabled || !Number.isFinite(state?.since) || now < state.since) return null
  const today = dayOf(now, config.timezone)
  const day = localTime(now, config.timezone) >= config.scheduleTime ? today
    : new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)
  const startDay = dayOf(state.since, config.timezone)
  if (day < startDay || (day === startDay && localTime(state.since, config.timezone) >= config.scheduleTime)) return null
  if (state.last && day <= state.last.day) return null
  return day
}

export class Scheduler {
  constructor(store) { this.store = store; this.lastCheck = null }
  tick(now = Date.now()) {
    if (this.lastCheck !== null && now >= this.lastCheck && now - this.lastCheck < 30000) return
    this.lastCheck = now
    this.store.schedule(now)
  }
}
