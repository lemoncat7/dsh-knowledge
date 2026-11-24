import { useEffect, useId, useState } from 'react'
import { api } from './api.js'
import { Dialog, DialogActions } from './Dialog.jsx'

export function ProgressHistory({ event, calendarId, historyAvailable, progressCursor, busy, save, close }) {
  const formId = useId()
  const [items, setItems] = useState([]), [before, setBefore] = useState(null)
  const [loading, setLoading] = useState(true), [refresh, setRefresh] = useState(0)
  const [error, setError] = useState(''), [editor, setEditor] = useState(null)
  const [pending, setPending] = useState(false), [removing, setRemoving] = useState(null)
  const locked = busy || pending || loading
  const readOnly = event.deletedAt !== null
  const [selectedDay, setSelectedDay] = useState(event.day)
  const dirty = editor !== null && editor.text !== editor.original
  async function read(path, params, signal) {
    const result = await api(path + '?' + new URLSearchParams({ id: event.id, ...params }), undefined, signal)
    if (result.calendarId !== calendarId) throw new Error('日历连接已变化，请重新打开目标')
    return result
  }
  useEffect(() => {
    if (editor) return
    const controller = new AbortController()
    setLoading(true); setError('')
    const request = historyAvailable
      ? read('/calendar-progress-history', {}, controller.signal)
      : read('/calendar-progress', { day: selectedDay }, controller.signal).then(({ progress }) => ({
        items: progress.text ? [progress] : [], before: null,
      }))
    request.then(result => {
      if (controller.signal.aborted) return
      setItems(result.items); setBefore(result.before)
    }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [event.id, calendarId, historyAvailable, selectedDay, refresh, progressCursor, editor !== null])
  async function loadMore() {
    setLoading(true); setError('')
    try {
      const next = await read('/calendar-progress-history', { before })
      setItems(current => [...current, ...next.items.filter(entry => !current.some(item => item.day === entry.day))])
      setBefore(next.before)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }
  function begin(item) {
    setError(''); setRemoving(null)
    setEditor({ day: item?.day ?? selectedDay, text: item?.text ?? '', original: item?.text ?? '', revision: item?.revision ?? null })
  }
  async function store(day, revision, text) {
    const { progress } = await save('progress-write', { id: event.id, day, revision, text })
    if (!historyAvailable) setSelectedDay(day)
    setItems(current => [...current.filter(item => item.day !== progress.day), ...(progress.text ? [progress] : [])]
      .sort((a, b) => b.day.localeCompare(a.day)))
  }
  async function submit(e) {
    e.preventDefault(); setPending(true); setError('')
    try {
      let revision = editor.revision
      if (revision === null) {
        const { progress } = await read('/calendar-progress', { day: editor.day })
        if (progress.text) throw new Error('这一天已有进度，请编辑已有记录')
        revision = progress.revision
      }
      await store(editor.day, revision, editor.text)
      setEditor(null)
    } catch (e) { setError(e.message) }
    finally { setPending(false) }
  }
  async function remove(item) {
    setPending(true); setError('')
    try { await store(item.day, item.revision, ''); setRemoving(null) }
    catch (e) { setError(e.message) }
    finally { setPending(false) }
  }
  return <Dialog title="每日进度" close={close} busy={busy || pending} protectChanges dirty={dirty}>
    <p className="wc-progress-goal-title">{event.title}</p>
    {error && <p className="wl-error" role="alert">{error}
      <button type="button" disabled={locked} onClick={() => setRefresh(n => n + 1)}>刷新列表</button>
    </p>}
    {editor && <form id={formId} className="wc-progress-form" onSubmit={submit}>
      {editor.revision === null
        ? <label>进度日期<input type="date" required min="1900-01-01" max="2200-12-31" disabled={locked} value={editor.day} onChange={e => setEditor({ ...editor, day: e.target.value })} /></label>
        : <time dateTime={editor.day}>{editor.day}</time>}
      <label>进度内容<textarea autoFocus required rows={3} maxLength={4000} disabled={locked} value={editor.text} onChange={e => setEditor({ ...editor, text: e.target.value })} /></label>
    </form>}
    {!historyAvailable && !editor && <label className="wc-progress-form">进度日期
      <input type="date" required min="1900-01-01" max="2200-12-31" disabled={locked} value={selectedDay}
        onChange={e => { if (e.target.value) setSelectedDay(e.target.value) }} />
    </label>}
    <div aria-label="进度记录" className="wc-progress-history" aria-busy={loading}>
      {loading && <p className="wl-muted" role="status">正在读取进度…</p>}
      {!loading && !items.length && !error && <p className="wl-muted">还没有进度记录</p>}
      {items.map(item => <div key={item.day} className="wc-progress-item">
        <time dateTime={item.day}>{item.day}</time>
        <details><summary title={item.text}>{item.text}</summary><p>{item.text}</p></details>
        {!readOnly && <div className="wc-progress-actions">
          <button type="button" disabled={locked || !!editor} onClick={() => begin(item)} aria-label={`编辑 ${item.day} 进度`}>编辑</button>
          {removing === item.day
            ? <button type="button" disabled={locked} onClick={() => remove(item)}>确认删除</button>
            : <button type="button" disabled={locked || !!editor} onClick={() => setRemoving(item.day)} aria-label={`删除 ${item.day} 进度`}>删除</button>}
        </div>}
      </div>)}
      {before && <button type="button" disabled={locked} onClick={loadMore}>加载更早的进度</button>}
    </div>
    <DialogActions>
      {editor ? <>
        <button type="button" disabled={locked} onClick={() => { setEditor(null); setError('') }}>取消编辑</button>
        <button type="submit" form={formId} className="wl-primary" disabled={locked || !editor.text.trim() || !dirty}>保存进度</button>
      </> : <>
        <button type="button" disabled={busy || pending} onClick={close}>关闭</button>
        {!readOnly && <button type="button" disabled={locked} className="wl-primary" onClick={() => begin()}>添加进度</button>}
      </>}
    </DialogActions>
  </Dialog>
}
