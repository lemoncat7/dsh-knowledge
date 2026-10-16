import { useEffect, useId, useRef, useState } from 'react'
import { api } from './api.js'
import { Dialog, DialogActions } from './Dialog.jsx'
import { Settings } from './Settings.jsx'
import { Markdown } from './Markdown.jsx'
import { copyText } from './clipboard.js'
import { SyncStatus } from './SyncStatus.jsx'
import { ActionMenu } from './ActionMenu.jsx'
import { defaults } from '../domain.js'
import { Sources, SourceViewer } from './Sources.jsx'
import { History } from './History.jsx'

const statuses = { queued: '等待整理', running: '正在整理', failed: '整理失败', cancelled: '已取消', done: '整理完成' }
export function Workspace({ close, openSession, embedded = false, currentProject = '' }) {
  const editFormId = useId()
  const [state, setState] = useState(null), [day, setDay] = useState(''), [detail, setDetail] = useState(null)
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const [modal, setModal] = useState(''), [draft, setDraft] = useState(''), [revision, setRevision] = useState(0)
  const [settingsDirty, setSettingsDirty] = useState(false)
  const [evidence, setEvidence] = useState(null)
  const [dates, setDates] = useState(false)
  const [dataVersion, setDataVersion] = useState('')
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
          const report = await api(`/day-summary?day=${day}`, undefined, controller.signal)
          if (!controller.signal.aborted) setDetail(report)
        }
        lastVersion = update.version
        setDataVersion(update.version)
      } catch (e) {
        lastVersion = undefined
        if (!controller.signal.aborted) {
          setError(e.message)
          try {
            const collector = await api('/collector-state', undefined, controller.signal)
            if (!controller.signal.aborted && collector.remote) setState(previous => ({ ...(previous || {}), days: previous?.days || [], today: previous?.today || '', config: { ...defaults, ...previous?.config, ...collector.capture }, projects: collector.projects, defaultProject: collector.defaultProject, remote: true, centralUnavailable: true, canManage: false }))
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
  const dayList = <nav className="wl-days" aria-label="日报日期"><input type="date" aria-label="选择日报日期" value={day} onChange={e => { if (e.target.value) select(e.target.value) }} />{state && [...new Set([state.today, ...state.days])].filter(Boolean).sort().reverse().map(d => <button key={d} aria-current={d === day ? 'date' : undefined} onClick={() => select(d)}><span>{d}</span><small>{state.failedDays?.includes(d) ? '整理失败' : d === state.today ? '今天' : ''}</small></button>)}</nav>
  return <section className="dsh-worklog wl-workspace">
    <header className="wl-toolbar">{!embedded && <><h1>工作记录</h1><span className="wl-muted wl-desktop">每天的进展，留有依据</span></>}<div className="wl-spacer" />
      <button className="wl-mobile" onClick={() => setDates(true)}>日期</button><button onClick={() => setModal('settings')} disabled={!state}>采集设置</button>{!embedded && <button onClick={close}>返回对话</button>}
    </header>
    <SyncStatus />
    {error && <div className="wl-error" role="alert">{error}<button onClick={() => { setError(''); setVersion(v => v + 1) }}>重新加载</button></div>}
    <div className="wl-body"><aside>{dayList}</aside><main ref={scroll} onScroll={e => { positions.current[day] = e.currentTarget.scrollTop }}>
      {!state || !detail ? <p className="wl-empty">{state?.centralUnavailable ? '中央日报暂不可用，本机待上传素材仍保留。' : '正在读取工作记录…'}</p> : <>
        {!state.config.enabled && <div className="wl-notice">采集尚未开启。可先补记，或在采集设置中选择工作目录后启用。</div>}
        <div className="wl-heading"><div><span className="wl-eyebrow">工作日报</span><h2>{day}</h2><p className="wl-muted">{detail.report.updated ? `整理于 ${time(detail.report.updated)}` : '尚未整理日报'}{detail.pending > 0 && ` · ${detail.pending} 条待整理`}</p></div>
          <div className="wl-actions"><button className="wl-primary" disabled={busy || active || !detail.included} onClick={generate}>{active ? '整理中…' : detail.report.markdown ? '更新日报' : '整理日报'}</button>
            <button onClick={() => { setDraft(''); setModal('note') }}>补记一条</button>
            <ActionMenu label="更多日报操作"><button disabled={!detail.report.markdown} onClick={edit}>编辑日报</button><button disabled={!detail.report.markdown} onClick={copyReport}>复制 Markdown</button><button disabled={!detail.report.markdown} onClick={exportReport}>导出 Markdown</button><button disabled={!detail.historyCount} onClick={() => setModal('history')}>历史版本</button></ActionMenu>
          </div>
        </div>
        {detail.job && <div className="wl-job" role="status"><span>{statuses[detail.job.status]}{detail.job.error && ` · ${detail.job.error}`}{active && detail.job.progress && ` · ${detail.job.progress.phase} ${detail.job.progress.current}/${detail.job.progress.total}，已保存 ${detail.job.progress.completed} 批`}</span>
          {active && <button disabled={busy} onClick={() => act('/cancel', { id: detail.job.id })}>取消</button>}
          {['failed', 'cancelled'].includes(detail.job.status) && <button disabled={busy} onClick={generate}>重新整理</button>}
        </div>}
        {detail.report.markdown ? <article className="wl-document"><Markdown text={detail.report.markdown} onEvidence={setEvidence} /></article> : <div className="wl-empty"><h3>把今天做的事，整理成一份日报</h3><p>只采集用户会话，不采集内部委派子会话；整理时才调用模型。</p></div>}
        <Sources key={day} day={day} summary={detail} version={`${version}:${dataVersion}`} busy={busy} act={act} time={time} onEvidence={setEvidence} />
      </>}
    </main></div>
    {message && <div className="wl-feedback" role="status">{message}</div>}
    {dates && <Dialog title="选择日期" close={() => setDates(false)}>{dayList}</Dialog>}
    {evidence && <SourceViewer key={evidence} id={evidence} close={() => setEvidence(null)} time={time} localSource={localSource} visit={visit} openSession={openSession} />}
    {modal && <Dialog key={modal} title={{ settings: '工作记录 · 采集设置', note: '补记一条', edit: '编辑日报', history: '历史版本', replace: '重新整理日报' }[modal]} busy={busy} protectChanges={['settings', 'note', 'edit'].includes(modal)} dirty={modal === 'settings' ? settingsDirty : modal === 'edit' ? draft !== detail.report.markdown : modal === 'note' ? !!draft.trim() : undefined} close={() => !busy && setModal('')}>
      {error && <p className="wl-error" role="alert">{error}</p>}
      {modal === 'settings' && <Settings state={state} currentProject={currentProject} busy={busy} onDirtyChange={setSettingsDirty} saveCapture={config => act('/capture-settings', config)} save={config => act('/settings', config)} />}
      {['note', 'edit'].includes(modal) && <form id={editFormId} onSubmit={e => { e.preventDefault(); act(modal === 'note' ? '/note' : '/save', modal === 'note' ? { day, text: draft } : { day, markdown: draft, revision }) }}><label>{modal === 'note' ? '记录实际完成的工作、决定或待办' : 'Markdown 正文'}<textarea autoFocus rows={14} value={draft} onChange={e => setDraft(e.target.value)} required /></label><DialogActions><button type="submit" form={editFormId} disabled={busy || !draft.trim()} className="wl-primary">{busy ? '保存中…' : '保存'}</button></DialogActions></form>}
      {modal === 'replace' && <><p>日报包含手工修改。重新整理会替换正文，原版本保留在历史版本中。新整理期间的任何编辑都会阻止覆盖。</p><DialogActions><button disabled={busy} onClick={() => setModal('')}>保留正文</button><button className="wl-primary" disabled={busy} onClick={() => act('/generate', { day, allowReplace: true })}>确认重新整理</button></DialogActions></>}
      {modal === 'history' && <History day={day} time={time} edit={markdown => { setDraft(markdown); setRevision(detail.report.revision); setModal('edit') }} />}
    </Dialog>}
  </section>
}
