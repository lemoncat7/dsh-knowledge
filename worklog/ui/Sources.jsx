import { useEffect, useState } from 'react'
import { api } from './api.js'
import { Dialog } from './Dialog.jsx'

export function SourceViewer({ id, close, time, localSource, visit, openSession }) {
  const [record, setRecord] = useState(null), [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    api(`/source?id=${encodeURIComponent(id)}`, undefined, controller.signal).then(setRecord).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [id])
  return <Dialog title="工作记录 · 查看依据" close={close}>
    {error ? <p role="alert">{error}</p> : !record ? <p role="status">正在读取依据…</p> : <>
      <p className="wl-muted">{time(record.time)} · {record.project || '手工补记'}</p>
      <h3>用户需求</h3><pre className="wl-source-text">{record.user}</pre><h3>会话结论</h3><pre className="wl-source-text">{record.answer}</pre>
      {record.truncated && <p>此来源为节选，请打开原会话查看完整内容。</p>}
      {record.sessionId && localSource(record) && openSession && <button onClick={() => visit(record.sessionId)}>打开来源会话 · 第 {record.turn} 轮</button>}
    </>}
  </Dialog>
}

export function Sources({ day, version, summary, busy, act, time, onEvidence }) {
  const [search, setSearch] = useState(''), [project, setProject] = useState(''), [state, setState] = useState('all'), [sort, setSort] = useState('time')
  const [page, setPage] = useState(0)
  const [result, setResult] = useState(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [selected, setSelected] = useState([])
  const key = JSON.stringify({ day, search, project, state, sort })
  useEffect(() => { setPage(0); setSelected([]) }, [key])
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('')
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ day, search, project, state, sort, page: String(page) })
      api(`/sources?${query}`, undefined, controller.signal).then(value => {
        if (!controller.signal.aborted) { setResult(value); setLoading(false); setSelected([]) }
      }).catch(e => { if (!controller.signal.aborted) { setError(e.message); setLoading(false) } })
    }, 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [key, page, version])
  const rows = result?.records || []
  return <section className="wl-evidence" aria-busy={loading}>
    <header><h3>来源记录 <small>{summary.total}</small></h3><span className="wl-muted">当天纳入 {summary.included} 条 · 约 {summary.chars.toLocaleString()} 字符</span></header>
    {summary.chars > 180000 && <p className="wl-muted">内容较多，将分批整理并保存进度，最后合并；会增加模型调用次数。</p>}
    <div className="wl-source-filters">
      <label>搜索内容<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索请求或结论" /></label>
      <label>项目<select value={project} onChange={e => setProject(e.target.value)}><option value="">全部项目</option>{summary.projects.map(p => <option key={p}>{p}</option>)}</select></label>
      <label>状态<select value={state} onChange={e => setState(e.target.value)}><option value="all">全部来源</option><option value="included">已纳入</option><option value="excluded">已排除</option><option value="unknown">旧版来源待核对</option></select></label>
      <label>排序<select value={sort} onChange={e => setSort(e.target.value)}><option value="time">最新记录</option><option value="size">内容最长</option></select></label>
    </div>
    <div className="wl-actions wl-source-bulk">
      <label className="wl-check"><input type="checkbox" aria-label="选择本页来源" disabled={loading || busy || !rows.length} checked={!!rows.length && rows.every(r => selected.includes(r.id))} onChange={e => setSelected(e.target.checked ? rows.map(r => r.id) : [])} />选择本页</label>
      <span className="wl-muted">已选 {selected.length} 条</span>
      <button disabled={loading || busy || !selected.length} onClick={() => act('/exclude-batch', { ids: selected, excluded: true }, false)}>批量排除</button>
      <button disabled={loading || busy || !selected.length} onClick={() => act('/exclude-batch', { ids: selected, excluded: false }, false)}>重新纳入</button>
    </div>
    <p className="wl-muted">排除不删除原始依据，可重新纳入；不会改写已有日报。旧版来源缺少分类信息，请核对后处理。</p>
    {error && <p role="alert">{error}</p>}
    <div className="wl-source-list" inert={loading ? '' : undefined}>
      {rows.map(r => <div className="wl-source-row" key={r.id}>
        <input type="checkbox" aria-label={`选择来源 ${r.preview}`} checked={selected.includes(r.id)} disabled={busy || loading} onChange={e => setSelected(e.target.checked ? [...selected, r.id] : selected.filter(id => id !== r.id))} />
        <button className="wl-source-open" onClick={() => onEvidence(r.id)}><strong>{r.preview}</strong><small>{time(r.time)} · {r.project || '手工记录'} · {r.chars.toLocaleString()} 字符{r.excluded ? ' · 已排除' : ''}</small></button>
        <button disabled={busy || loading} onClick={() => act('/exclude', { id: r.id, excluded: !r.excluded }, false)}>{r.excluded ? '纳入' : '排除'}</button>
      </div>)}
    </div>
    <div className="wl-actions wl-source-pages"><span role="status">{loading ? '正在读取来源…' : `共 ${result?.total || 0} 条 · 第 ${page + 1} 页`}</span><button disabled={loading || page === 0} onClick={() => { setPage(page - 1); setSelected([]) }}>上一页</button><button disabled={loading || !result || (page + 1) * result.limit >= result.total} onClick={() => { setPage(page + 1); setSelected([]) }}>下一页</button></div>
    {!loading && !error && !rows.length && <p className="wl-muted">没有匹配的来源记录。</p>}
  </section>
}
