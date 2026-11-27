import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { addDays } from '../calendar/time.js'

/** Reuses the calendar-info refresh; no extra idle polling or model requests. */
export function ReportProgressReview({ selected, today, review, onChange, settings }) {
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const locked = useRef(false), request = useRef(null)
  useEffect(() => () => request.current?.abort(), [])
  if (selected > today) return null
  const last = review.last, active = ['queued', 'running'].includes(last?.status)
  const retryDay = selected < today ? selected : last?.status === 'failed' ? last.day : addDays(today, -1)
  const retryLabel = last?.status === 'failed' && last.day === retryDay ? `重试 ${retryDay} 进度`
    : selected === today ? '重新核对昨日进度' : '重新核对当日进度'
  async function retry() {
    if (locked.current || active || !review.enabled) return
    locked.current = true; setPending(true); setError(''); setMessage('')
    const controller = new AbortController(); request.current = controller
    try {
      const result = await api('/calendar-report-recheck', { from: retryDay, to: retryDay }, controller.signal)
      if (controller.signal.aborted) return
      onChange(result.report)
      setMessage(result.recheck.queued ? `已提交 ${retryDay} 的进度核对。` : '没有新增核对任务，请确认当天已有日报，或等待当前核对完成。')
    } catch (e) { if (!controller.signal.aborted) setError(e.message) }
    finally { if (!controller.signal.aborted) { locked.current = false; setPending(false) } }
  }
  return <section className="wc-report-review" aria-label="日报进度核对" data-state={last?.status || 'idle'}>
    <strong>日报进度</strong>
    <p className={last?.status === 'failed' ? 'wl-error' : 'wl-muted'} role="status">
      {!review.enabled ? '日报联动已关闭' : last ? `最近核对 ${last.day} · ${last.message || (active ? '正在核对…' : '等待核对')}` : '尚无核对记录'}
    </p>
    {error && <p className="wl-error" role="alert">{error}</p>}
    {message && <p className="wl-muted" role="status">{message}</p>}
    <small>只补缺失进度，已有记录和人工修改保留。</small>
    {review.enabled ? <button type="button" disabled={pending || active} onClick={retry}>
      {pending ? '正在提交…' : active ? '核对中…' : error ? '重试提交' : retryLabel}
    </button> : <button type="button" onClick={settings}>前往日历设置</button>}
  </section>
}
