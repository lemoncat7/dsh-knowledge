import { Select } from './Select.jsx'
import { useEffect, useId, useRef, useState } from 'react'
import { Dialog, DialogActions } from './Dialog.jsx'
import { api } from './api.js'
import { groupColors } from '../calendar/groups.js'

const colors = { slate: '灰', blue: '蓝', teal: '青', green: '绿', purple: '紫', rose: '玫红', amber: '琥珀' }
export function CalendarGroups({ value, close, saved }) {
  const [draft, setDraft] = useState(() => structuredClone(value)), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const locked = useRef(false)
  const formId = useId()
  const [baseline, setBaseline] = useState(value), [loaded, setLoaded] = useState(false), [reload, setReload] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    api('/calendar-info', undefined, controller.signal).then(result => {
      if (!controller.signal.aborted) { setDraft(result.groups); setBaseline(result.groups); setLoaded(true); setError('') }
    }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [reload])
  const unavailable = busy || !loaded
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline)
  const change = (id, patch) => setDraft(current => ({ ...current, items: current.items.map(item => item.id === id ? { ...item, ...patch } : item) }))
  async function submit(event) {
    event.preventDefault()
    if (locked.current || !loaded) return
    locked.current = true; setBusy(true); setError('')
    try { const result = await api('/calendar-groups-settings', draft); saved(result.groups); close() }
    catch (e) { setError(e.message) }
    finally { locked.current = false; setBusy(false) }
  }
  return <Dialog title="日历分组" className="wc-group-dialog" close={close} busy={busy} protectChanges dirty={dirty}>
    <p className="wl-muted">用分组区分工作、个人或项目；在「账号」中分别选择要同步的日历和方向。标签用于进一步检索。</p>
    {error && <p className="wl-error" role="alert">{error}</p>}
    {!loaded && <p role="status">正在读取全部分组…{error && <button type="button" onClick={() => setReload(n => n+1)}>重试读取</button>}</p>}
    <form id={formId} onSubmit={submit}>
      <div className="wc-group-editor">{draft.items.map(item => <div key={item.id}>
        <label>分组名称<input aria-label={`分组名称：${item.name}`} maxLength={60} required value={item.name} disabled={unavailable} onChange={e => change(item.id, { name: e.target.value })} /></label>
        <label>颜色<Select aria-label={`${item.name} 的颜色`} value={item.color} disabled={unavailable} onChange={e => change(item.id, { color: e.target.value })}>{groupColors.map(color => <option key={color} value={color}>{colors[color]}</option>)}</Select></label>
        <button type="button" disabled={unavailable || item.id === 'default'} aria-label={`删除分组：${item.name}`} onClick={() => setDraft(current => ({ ...current, items: current.items.filter(group => group.id !== item.id) }))}>移除</button>
      </div>)}</div>
      <button type="button" disabled={unavailable || draft.items.length >= 100} onClick={() => setDraft(current => ({ ...current, items: [...current.items, { id: crypto.randomUUID(), name: '', color: 'blue' }] }))}>＋ 添加分组</button>
      <p className="wl-muted">有条目或账号关联的分组不能直接移除，原有目标和进度会保留。</p>
      <DialogActions><button type="button" disabled={busy} onClick={close}>取消</button><button className="wl-primary" type="submit" form={formId} disabled={unavailable || !dirty}>{busy ? '保存中…' : '保存分组'}</button></DialogActions>
    </form>
  </Dialog>
}
