import { dayOf } from './domain.js'

// At most one historical job per scheduler tick, within 30 civil days. Preserve
// the original enable boundary when the user moves the daily trigger time.
export function recoverDay(store, state, now) {
  const config = store.config()
  if (!config.scheduleEnabled || !config.scheduleCatchup || !Number.isFinite(state.catchupSince ?? state.since)) return
  const today = dayOf(now, config.timezone)
  const oldest = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10)
  const since = dayOf(state.catchupSince ?? state.since, config.timezone)
  const from = oldest > since ? oldest : since
  const days = store.db.prepare(`SELECT day FROM records WHERE excluded=0 AND day>=? AND day<?
    UNION SELECT day FROM jobs WHERE day>=? AND day<? ORDER BY day DESC`).all(from, today, from, today)
  for (const { day } of days) {
    const report = store.report(day)
    if (report.revision || report.edited) continue
    const previous = store.db.prepare('SELECT * FROM jobs WHERE day=? ORDER BY rowid DESC LIMIT 1').get(day)
    if (previous && ['cancelled', 'running', 'queued', 'done'].includes(previous.status)) continue
    let retries = 0, changed = false
    if (previous) {
      const body = JSON.parse(previous.body)
      changed = body.fingerprint !== store.fingerprint(day)
      retries = changed ? 0 : (body.autoRetries || 0)
      if (!changed && (body.preflight || body.diagnostic?.retryable === false || retries >= 2 || now < (body.failedAt || previous.due) + 300000 * (retries + 1))) continue
    }
    if (!store.records(day).length) continue
    try {
      const id = store.enqueue(day)
      const job = store.job(id), body = JSON.parse(job.body)
      store.status(id, 'queued', { ...body, autoRetries: previous && !changed ? retries + 1 : 0, recovered: true }, 0, now)
    } catch (e) { if (!e.status) throw e }
    return day
  }
}
