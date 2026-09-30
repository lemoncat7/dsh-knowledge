import { useEffect, useState } from 'react'
import { api } from './api.js'

export function ModelPicker({ provider = '', model = '', onChange, central = false }) {
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
      <option value="">{central ? '请由管理员选择中央模型' : '沿用中央本机会话的模型'}</option>
      {value && !available && <option value={value} disabled>{provider} / {model}（{loading ? '加载中' : '当前不可用'}）</option>}
      {providers.map(p => <optgroup key={p.id} label={p.name || p.id}>{p.models.map(m => <option key={m.id} value={JSON.stringify([p.id, m.id])}>{m.name || m.id}</option>)}</optgroup>)}
    </select></label>
    <p className="wl-muted">从中央 DSH 已配置的模型中选择。上传端的模型 ID 不会被中央直接使用；仅有远端素材或补记时，需要先选择中央模型。</p>
    {loading && <p role="status">正在获取模型…</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && <button type="button" onClick={() => setRevision(v => v + 1)}>刷新模型列表</button>}
  </section>
}
