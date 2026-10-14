import { useEffect, useId, useState } from 'react'
import { api } from './api.js'

export function ModelPicker({ provider = '', model = '', onChange, central = false }) {
  const [providers, setProviders] = useState([]), [error, setError] = useState('')
  const [loading, setLoading] = useState(true), [revision, setRevision] = useState(0)
  const id = useId()
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    api('/models', undefined, controller.signal).then(data => {
      if (!controller.signal.aborted) setProviders(data.providers)
    }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision])
  const value = provider && model ? JSON.stringify([provider, model]) : ''
  const available = providers.some(p => p.id === provider && p.models.some(m => m.id === model))
  return <section className="wl-model-picker">
    <div className="wl-setting-heading"><label htmlFor={id}>日报整理模型</label></div>
    <div className="wl-model-control" aria-busy={loading}>
    <select id={id} aria-label="日报整理模型" aria-describedby={error ? `${id}-error` : undefined} value={value} disabled={loading} onChange={e => onChange(...(e.target.value ? JSON.parse(e.target.value) : ['', '']))}>
      <option value="">{loading ? '正在获取模型…' : central ? '选择中央模型' : '沿用中央本机会话的模型'}</option>
      {value && !available && <option value={value} disabled>{provider} / {model}（{loading ? '加载中' : '当前不可用'}）</option>}
      {providers.map(p => <optgroup key={p.id} label={p.name || p.id}>{p.models.map(m => <option key={m.id} value={JSON.stringify([p.id, m.id])}>{m.name || m.id}</option>)}</optgroup>)}
    </select>
    <button type="button" className="wl-model-refresh" aria-label="刷新模型列表" title={loading ? '正在刷新模型…' : '刷新模型列表'} disabled={loading} onClick={() => setRevision(v => v + 1)}><svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M16.5 8a6.7 6.7 0 1 0-.8 6.1M16.5 3.5V8H12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
    </div>
    {loading && <span className="wl-sr" role="status">正在获取模型…</span>}
    {error && <p id={`${id}-error`} className="wl-model-error" role="alert">{error}</p>}
  </section>
}
