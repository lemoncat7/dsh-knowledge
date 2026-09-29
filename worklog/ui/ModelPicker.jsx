import { useEffect, useState } from 'react'
import { api } from './api.js'

export function ModelPicker({ provider = '', model = '', onChange }) {
  const [providers, setProviders] = useState([]), [error, setError] = useState('')
  const [loading, setLoading] = useState(true), [revision, setRevision] = useState(0)
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
  return <section>
    <label>日报整理模型<select aria-label="日报整理模型" value={value} disabled={loading} onChange={e => onChange(...(e.target.value ? JSON.parse(e.target.value) : ['', '']))}>
      <option value="">沿用已采集会话的模型</option>
      {value && !available && <option value={value} disabled>{provider} / {model}（{loading ? '加载中' : '当前不可用'}）</option>}
      {providers.map(p => <optgroup key={p.id} label={p.name || p.id}>{p.models.map(m => <option key={m.id} value={JSON.stringify([p.id, m.id])}>{m.name || m.id}</option>)}</optgroup>)}
    </select></label>
    <p className="wl-muted">从 DSH 已配置的模型中选择；默认沿用当天最后一条采集对话的模型。仅补记时，请选择一个模型。</p>
    {loading && <p role="status">正在获取模型…</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && <button type="button" onClick={() => setRevision(v => v + 1)}>刷新模型列表</button>}
  </section>
}

