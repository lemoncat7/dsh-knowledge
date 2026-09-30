import { useEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { Dialog } from './Dialog.jsx'
import { Settings } from './Settings.jsx'
import { Markdown } from './Markdown.jsx'
import { copyText } from './clipboard.js'
import { SyncStatus } from './SyncStatus.jsx'
import { defaults } from '../domain.js'

const statuses = { queued: '等待整理', running: '正在整理', failed: '整理失败', cancelled: '已取消', done: '整理完成' }
export function Workspace({ close, openSession, embedded = false, currentProject = '' }) {
  const [state, setState] = useState(null), [day, setDay] = useState(''), [detail, setDetail] = useState(null)
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const [modal, setModal] = useState(''), [draft, setDraft] = useState(''), [revision, setRevision] = useState(0)
  const [evidence, setEvidence] = useState(null)
  const [search, setSearch] = useState(''), [project, setProject] = useState(''), [dates, setDates] = useState(false)
  const [version, setVersion] = useState(0), scroll = useRef(null), positions = useRef({})
  const time = n => n ? new Intl.DateTimeFormat('zh-CN', { timeZone: state?.config.timezone || 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(n)) : '尚未整理'
  useEffect(() => {
    const controller = new AbortController(); let timer, lastVersion
    async function load() {
      try {
        if (document.hidden) return
        const update = await api('/version', undefined, controller.signal)
        if (update.version === lastVersion) return
        const next = await api('/state', undefined, controller.signal)
        if (controller.signal.aborted) return
        setState(next)
        setError('')
        if (!day) setDay(next.today)
        else {
          const report = await api(`/day?day=${day}`, undefined, controller.signal)
          if (!controller.signal.aborted) setDetail(report)
        }
        lastVersion = update.version
      } catch (e) {
        lastVersion = undefined
        if (!controller.signal.aborted) {
          setError(e.message)
          try {
            const collector = await api('/collector-state', undefined, controller.signal)
            if (!controller.signal.aborted && collector.remote) setState(previous => ({ ...(previous || {}), days: previous?.days || [], today: previous?.today || '', config: { ...defaults, ...previous?.config, ...collector.capture }, projects: collector.projects, remote: true, centralUnavailable: true, canManage: false }))
          } catch { /* Original central error remains visible; never substitute local reports. */ }
        }
      }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 6000) }
    }
    load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [day, version])
  useEffect(() => { if (detail?.day === day && scroll.current) scroll.current.scrollTop = positions.current[day] || 0 }, [detail?.day])
  async function act(path, data, done = true) {
    setBusy(true); setError(''); setMessage('')
    try { await api(path, data); setVersion(v => v + 1); if (done) setModal(''); setMessage('已保存') }
    catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  function select(next) { positions.current[day] = scroll.current?.scrollTop || 0; setDay(next); setDetail(null); setDates(false) }
  function edit() { setDraft(detail.report.markdown); setRevision(detail.report.revision); setModal('edit') }
  function generate() { if (detail.report.edited) setModal('replace'); else act('/generate', { day }) }
  function exportReport() {
    const url = URL.createObjectURL(new Blob([detail.report.markdown], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a'); link.href = url; link.download = `工作日报-${day}.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  async function copyReport() { try { await copyText(detail.report.markdown); setMessage('Markdown 已复制') } catch (e) { setError(e.message) } }
  function visit(sessionId) { try { openSession(sessionId) } catch { setError('无法打开来源会话，它可能已被删除或归档。') } }
  const localSource = record => !record.sourceId ? !state?.remote : record.sourceId === state?.sourceId
  const active = ['queued', 'running'].includes(detail?.job?.status)
  const records = detail?.records.filter(r => (!project || r.project === project) && (!search || `${r.user}\n${r.answer}`.toLowerCase().includes(search.toLowerCase()))) || []
  const dayList = <nav className="wl-days" aria-label="日报日期"><input type="date" aria-label="选择日报日期" value={day} onChange={e => { if (e.target.value) select(e.target.value) }} />{state && [...new Set([state.today, ...state.days])].filter(Boolean).sort().reverse().map(d => <button key={d} aria-current={d === day ? 'date' : undefined} onClick={() => select(d)}><span>{d}</span>{d === state.today && <small>今天</small>}</button>)}</nav>
  return <section className="dsh-worklog wl-workspace">
    <header className="wl-toolbar">{!embedded && <><h1>工作记录</h1><span className="wl-muted wl-desktop">每天的进展，留有依据</span></>}<div className="wl-spacer" />
      <button className="wl-mobile" onClick={() => setDates(true)}>日期</button><button onClick={() => setModal('settings')} disabled={!state}>采集设置</button>{!embedded && <button onClick={close}>返回对话</button>}
    </header>
    <SyncStatus />
    {error && <div className="wl-error" role="alert">{error}<button onClick={() => { setError(''); setVersion(v => v + 1) }}>重新加载</button></div>}
    <div className="wl-body"><aside>{dayList}</aside><main ref={scroll} onScroll={e => { positions.current[day] = e.currentTarget.scrollTop }}>
      {!state || !detail ? <p className="wl-empty">{state?.centralUnavailable ? '中央日报暂不可用，本机待上传素材仍保留。' : '正在读取工作记录…'}</p> : <>
        {!state.config.enabled && <div className="wl-notice">采集尚未开启。可先补记，或在采集设置中选择项目后启用。</div>}
        <div className="wl-heading"><div><span className="wl-eyebrow">工作日报</span><h2>{day}</h2><p className="wl-muted">{detail.report.updated ? `整理于 ${time(detail.report.updated)}` : '尚未整理日报'}{detail.pending > 0 && ` · ${detail.pending} 条待整理`}</p></div>
          <div className="wl-actions"><button className="wl-primary" disabled={busy || active || !detail.records.some(r => !r.excluded)} onClick={generate}>{active ? '整理中…' : detail.report.markdown ? '更新日报' : '整理日报'}</button>
            <button onClick={() => { setDraft(''); setModal('note') }}>补记一条</button>
            <details className="wl-more"><summary aria-label="更多日报操作">更多</summary><div><button disabled={!detail.report.markdown} onClick={edit}>编辑日报</button><button disabled={!detail.report.markdown} onClick={copyReport}>复制 Markdown</button><button disabled={!detail.report.markdown} onClick={exportReport}>导出 Markdown</button><button disabled={!detail.history.length} onClick={() => setModal('history')}>历史版本</button></div></details>
          </div>
        </div>
        {detail.job && <div className="wl-job" role="status"><span>{statuses[detail.job.status]}{JSON.parse(detail.job.body).error && ` · ${JSON.parse(detail.job.body).error}`}</span>
          {active && <button disabled={busy} onClick={() => act('/cancel', { id: detail.job.id })}>取消</button>}
          {['failed', 'cancelled'].includes(detail.job.status) && <button disabled={busy} onClick={generate}>重新整理</button>}
        </div>}
        {detail.report.markdown ? <article className="wl-document"><Markdown text={detail.report.markdown} onEvidence={id => { const source = detail.records.find(r => r.id === id); if (source) setEvidence(source); else setError('这条来源不存在，请在历史记录中核对。') }} /></article> : <div className="wl-empty"><h3>把今天做的事，整理成一份日报</h3><p>会话素材只在所选项目中采集；整理时才调用模型，不阻塞聊天。</p><p>还没有记录？可以先补记一条。</p></div>}
        <section className="wl-evidence"><header><h3>来源记录 <small>{detail.records.length}</small></h3><span className="wl-muted">用于核对，不代表已经完成</span></header>
          <div className="wl-filters"><input aria-label="搜索来源记录" placeholder="搜索来源记录…" value={search} onChange={e => setSearch(e.target.value)} /><select aria-label="筛选项目来源" value={project} onChange={e => setProject(e.target.value)}><option value="">全部项目来源</option>{[...new Set(detail.records.map(r => r.project))].filter(Boolean).map(p => <option key={p}>{p}</option>)}</select></div>
          {records.map(r => <details className="wl-source" key={r.id}><summary><span><strong>{r.user.slice(0, 100)}</strong><small>{time(r.time)} · {r.project || '手工记录'}{r.excluded ? ' · 已排除' : ''}{r.truncated ? ' · 内容节选' : ''}</small></span></summary><div><p className="wl-muted">依据 ID：{r.id}{r.sessionId && ` · 第 ${r.turn} 轮`}</p><pre>{r.user}</pre><pre>{r.answer}</pre><div className="wl-actions">{r.sessionId && localSource(r) && openSession && <button onClick={() => visit(r.sessionId)}>打开来源会话</button>}<button disabled={busy} onClick={() => act('/exclude', { id: r.id, excluded: !r.excluded }, false)}>{r.excluded ? '重新纳入' : '从下次整理中排除'}</button></div></div></details>)}
          {!records.length && <p className="wl-muted">没有匹配的来源记录。</p>}
        </section>
      </>}
    </main></div>
    {message && <div className="wl-feedback" role="status">{message}</div>}
    {dates && <Dialog title="选择日期" close={() => setDates(false)}>{dayList}</Dialog>}
    {evidence && <Dialog title="工作记录 · 查看依据" close={() => setEvidence(null)}><p className="wl-muted">{time(evidence.time)} · {evidence.project || '手工补记'}</p><h3>用户需求</h3><pre className="wl-source-text">{evidence.user}</pre><h3>会话结论</h3><pre className="wl-source-text">{evidence.answer}</pre>{evidence.truncated && <p>此来源为节选，请打开会话查看完整内容。</p>}{evidence.sessionId && localSource(evidence) && openSession && <button onClick={() => visit(evidence.sessionId)}>打开来源会话 · 第 {evidence.turn} 轮</button>}</Dialog>}
    {modal && <Dialog title={{ settings: '工作记录 · 采集设置', note: '补记一条', edit: '编辑日报', history: '历史版本', replace: '重新整理日报' }[modal]} close={() => !busy && setModal('')}>
      {error && <p className="wl-error" role="alert">{error}</p>}
      {modal === 'settings' && <Settings state={state} currentProject={currentProject} busy={busy} saveCapture={config => act('/capture-settings', config)} save={config => act('/settings', config)} />}
      {['note', 'edit'].includes(modal) && <form onSubmit={e => { e.preventDefault(); act(modal === 'note' ? '/note' : '/save', modal === 'note' ? { day, text: draft } : { day, markdown: draft, revision }) }}><label>{modal === 'note' ? '记录实际完成的工作、决定或待办' : 'Markdown 正文'}<textarea autoFocus rows={14} value={draft} onChange={e => setDraft(e.target.value)} required /></label><footer><button disabled={busy || !draft.trim()} className="wl-primary">{busy ? '保存中…' : '保存'}</button></footer></form>}
      {modal === 'replace' && <><p>日报包含手工修改。重新整理会替换正文，原版本保留在历史版本中。新整理期间的任何编辑都会阻止覆盖。</p><footer><button disabled={busy} onClick={() => setModal('')}>保留正文</button><button disabled={busy} onClick={() => act('/generate', { day, allowReplace: true })}>确认重新整理</button></footer></>}
      {modal === 'history' && detail.history.map(h => <details key={h.id}><summary>{time(h.updated)} · {h.sourceId ? '迁入历史' : '版本'} {h.revision}</summary><Markdown text={h.markdown} /><button onClick={() => { setDraft(h.markdown); setRevision(detail.report.revision); setModal('edit') }}>作为编辑草稿</button></details>)}
    </Dialog>}
  </section>
}
