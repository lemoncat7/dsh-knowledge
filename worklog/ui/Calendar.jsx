import { Select } from './Select.jsx'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api.js'
import { Dialog, DialogActions } from './Dialog.jsx'
import { ActionMenu } from './ActionMenu.jsx'
import { CalendarAccounts, CalendarSettings } from './CalendarSettings.jsx'
import { ProgressHistory } from './ProgressHistory.jsx'
import { CalendarGroups } from './CalendarGroups.jsx'
import { ReportProgressReview } from './ReportProgressReview.jsx'
import { applyGoalOrder, moveGoal } from '../calendar/goal-order.js'
import { addDays, eventOnDay, localParts, monthDays, weekDays, wallTime, validDate } from '../calendar/time.js'

const labels = { planned: '待完成', in_progress: '进行中', done: '已完成', cancelled: '已取消' }
const kindLabels = { goal: '目标', event: '日程', reminder: '提醒', work: '工作记录' }
const groupInk = { slate: 'var(--wl-muted)', blue: '#477baf', teal: '#43818a', green: '#4c8764', purple: '#8972ad', rose: '#b67591', amber: '#a58545' }
const fallbackGroups = { revision: 0, items: [{ id: 'default', name: '工作', color: 'teal' }] }
const priorities = { low: '不急', normal: '普通', high: '优先' }
const weekdays = ['一', '二', '三', '四', '五', '六', '日']
const dateLabel = day => new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long', timeZone: 'UTC' }).format(new Date(day + 'T12:00:00Z'))
const timeLabel = (event, zone) => event.allDay ? (event.endDay > addDays(event.day, 1) ? `${event.day.slice(5)} 至 ${addDays(event.endDay, -1).slice(5)} · 全天` : '不限定时段') : `${localParts(event.startAt, zone).day === localParts(event.endAt, zone).day ? '' : localParts(event.startAt, zone).day.slice(5) + ' '}${localParts(event.startAt, zone).time} — ${localParts(event.startAt, zone).day === localParts(event.endAt, zone).day ? '' : localParts(event.endAt, zone).day.slice(5) + ' '}${localParts(event.endAt, zone).time}`
function download(value) { const url = URL.createObjectURL(new Blob([value.content], { type: value.contentType })); const a = document.createElement('a'); a.href = url; a.download = value.filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }

// Each overlapping group shares the same lane width. Cross-day entries are clipped per day.
export function weekLayout(events, day, zone) {
  const minute = n => { const p = localParts(n, zone); return p.day < day ? 0 : p.day > day ? 1440 : Number(p.time.slice(0, 2)) * 60 + Number(p.time.slice(3)) }
  const items = events.filter(e => !e.allDay && eventOnDay(e, day, zone)).map(event => ({ event, start: minute(event.startAt), end: minute(event.endAt) })).sort((a, b) => a.start - b.start || b.end - a.end)
  let group = [], ends = [], groupEnd = -1
  const finish = () => { for (const item of group) item.lanes = ends.length }
  for (const item of items) {
    item.end = Math.max(item.end, item.start + 15)
    if (item.start >= groupEnd) { finish(); group = []; ends = []; groupEnd = -1 }
    let lane = ends.findIndex(end => end <= item.start)
    if (lane < 0) lane = ends.length
    item.lane = lane; ends[lane] = item.end; group.push(item); groupEnd = Math.max(groupEnd, item.end)
  }
  finish(); return items
}

export function Calendar() {
  const [settingsPanel, setSettingsPanel] = useState(null)
  const [info, setInfo] = useState(null), [day, setDay] = useState(() => { try { return validDate(new URLSearchParams(location.search).get('calendarDay')) } catch { return '' } }), [mode, setMode] = useState('month')
  const publishInfo = useCallback(next => setInfo(current => current?.calendarId === next.calendarId && (current.groups?.revision ?? 0) > (next.groups?.revision ?? 0) ? { ...next, groups: current.groups } : next), [])
  const [goalOrders, setGoalOrders] = useState({})
  const [events, setEvents] = useState([]), [loading, setLoading] = useState(true), [version, setVersion] = useState(0)
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState(null), [trash, setTrash] = useState(false), [undo, setUndo] = useState(null), [quick, setQuick] = useState('')
  const [filterGroup, setFilterGroup] = useState(''), [filterKind, setFilterKind] = useState(''), [filterText, setFilterText] = useState('')
  const groups = info?.groups ?? fallbackGroups
  const groupMap = useMemo(() => new Map(groups.items.map(group => [group.id, group])), [groups])
  const [progressEvent, setProgressEvent] = useState(null)
  const requests = useRef(new Map()), locked = useRef(false), dayRefs = useRef(new Map()), gridFocus = useRef(false)
  const [lifted, setLifted] = useState(null), [dropGoal, setDropGoal] = useState(null)
  const pickedGoal = lifted?.id
  const dragLayer = useRef(null)
  const agenda = useRef(null), gesture = useRef(null), suppressClick = useRef(null)
  const reorderRef = useRef(null)
  const today = info?.today || new Date().toISOString().slice(0, 10), selected = day || today, zone = info?.timeZone || 'Asia/Shanghai'
  const days = useMemo(() => mode === 'month' ? monthDays(selected) : weekDays(selected), [selected, mode])
  const from = days[0], to = addDays(days.at(-1), 1)
  useEffect(() => {
    const controller = new AbortController(); let timer, lastKey = ''
    async function load() {
      try {
        if (document.hidden) return
        const next = await api('/calendar-info', undefined, controller.signal)
        if (controller.signal.aborted) return
        const key = `${next.calendarId}:${next.cursor}:${next.orderCursor}:${next.progressCursor}:${next.workdaysRevision}:${next.timeZone}:${next.today}:${next.externalSync?.connected}:${next.externalSync?.enabled}`
        if (key === lastKey) { publishInfo(next); return }
        const query = new URLSearchParams({ from, to, timeZone: next.timeZone, deleted: trash ? 'only' : 'exclude', limit: '500' })
        let all = [], page
        do { page = await api('/calendar?' + query, undefined, controller.signal); if (page.calendarId !== next.calendarId || page.cursor !== next.cursor || page.orderCursor !== next.orderCursor) throw new Error('日历已更新，正在重新读取，请稍后刷新'); all.push(...page.items); if (page.nextOffset !== null) query.set('offset', page.nextOffset) } while (page.nextOffset !== null && all.length < 5000)
        if (controller.signal.aborted) return
        if (page.nextOffset !== null) throw new Error('当前范围超过 5000 项，请切换周视图查看')
        publishInfo(next); setEvents(all); setGoalOrders(page.goalOrders || {}); setLoading(false); setError(''); lastKey = key
        if (!day) setDay(next.today)
      } catch (e) { if (!controller.signal.aborted) { setError(e.message); setLoading(false) } }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 15000) }
    }
    setLoading(true); load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [from, to, trash, version, publishInfo])
  useEffect(() => { if (gridFocus.current) { dayRefs.current.get(selected)?.focus(); gridFocus.current = false } }, [selected])
  const visibleEvents = useMemo(() => events.filter(e => (e.deletedAt !== null) === trash && (!filterGroup || (e.groupId ?? 'default') === filterGroup) && (!filterKind || e.kind === filterKind) && (!filterText.trim() || [e.title, e.description, e.project, ...(e.tags ?? [])].join(' ').toLocaleLowerCase().includes(filterText.trim().toLocaleLowerCase()))), [events, trash, filterGroup, filterKind, filterText])
  const byDay = useMemo(() => new Map(days.map(d => {
    const items = visibleEvents.filter(e => eventOnDay(e, d, zone))
    return [d, trash ? items : applyGoalOrder(items, goalOrders[d]?.ids)]
  })), [days, visibleEvents, zone, goalOrders, trash])
  const selectedItems = byDay.get(selected) || [], goals = selectedItems.filter(e => e.kind === 'goal' && e.status !== 'cancelled'), done = goals.filter(e => e.status === 'done').length
  const sortableIds = selectedItems.filter(event => event.kind === 'goal').map(event => event.id)
  const hasSort = !trash && !filterGroup && !filterKind && !filterText.trim() && Number.isInteger(info?.orderCursor) && sortableIds.length > 1
  const canSort = hasSort && !loading && !busy
  useEffect(() => {
    clearTimeout(gesture.current?.timer)
    setLifted(null); setDropGoal(null); gesture.current = null
  }, [selected, trash, info?.calendarId, info?.cursor, info?.orderCursor])
  async function mutate(action, data) {
    if (locked.current) throw new Error('请等待当前操作完成')
    locked.current = true; setBusy(true); setError(''); setMessage('')
    const payload = { ...data, calendarId: info.calendarId }, signature = JSON.stringify({ action, payload })
    if (!requests.current.has(signature)) requests.current.set(signature, crypto.randomUUID())
    try {
      const result = await api('/calendar-' + action, { ...payload, requestId: requests.current.get(signature) })
      requests.current.delete(signature)
      if (result.order) {
        setGoalOrders(previous => ({ ...previous, [result.order.day]: result.order }))
      } else if (result.event) {
        setEvents(previous => {
          const index = previous.findIndex(e => e.id === result.event.id)
          if ((result.event.deletedAt !== null) !== trash) return previous.filter(e => e.id !== result.event.id)
          return index < 0 ? [...previous, result.event] : previous.map((e, i) => i === index ? result.event : e)
        })
      }
      setVersion(v => v + 1)
      setMessage(action === 'delete' ? '已移入回收站' : action === 'restore' ? '已恢复' : action === 'reorder' ? '顺序已保存' : '已保存')
      if (action === 'delete') setUndo(result.event)
      return result
    } catch (e) { setError(e.message); throw e }
    finally { locked.current = false; setBusy(false) }
  }
  async function rowAction(event, action, patch) { try { await mutate(action, { id: event.id, revision: event.revision, ...(patch ? { patch } : {}) }); if (action === 'restore') setUndo(null) } catch {} }
  function reorder(source, target) {
    if (!canSort) return
    const ids = moveGoal(sortableIds, source, target)
    if (ids === sortableIds) return
    void mutate('reorder', { day: selected, revision: goalOrders[selected]?.revision ?? 0, ids }).catch(() => {})
  }
  reorderRef.current = reorder
  function goalUnderPointer({ clientX, clientY }) {
    return document.elementFromPoint(clientX, clientY)?.closest('[data-goal-sort-id]')?.dataset.goalSortId
  }
  function updateDrag(active, point) {
    if (!active.preview) {
      const bounds = active.row.getBoundingClientRect()
      const style = getComputedStyle(active.row)
      const palette = Object.fromEntries(['--wl-solid', '--wl-text', '--wl-muted', '--wl-line', '--wl-control', '--wl-hover']
        .map(name => [name, style.getPropertyValue(name)]))
      active.preview = {
        id: active.id, width: bounds.width, height: bounds.height, palette,
        offsetX: active.x - bounds.left, offsetY: active.y - bounds.top + 6,
        transform: '',
      }
      setLifted(active.preview)
    }
    const preview = active.preview
    preview.transform = `translate3d(${point.clientX - preview.offsetX}px, ${point.clientY - preview.offsetY}px, 0)`
    if (dragLayer.current) dragLayer.current.style.transform = preview.transform
    setDropGoal(goalUnderPointer(point) ?? null)
  }
  function finishDrag(active, point) {
    clearTimeout(active.timer)
    gesture.current = null
    setLifted(null)
    setDropGoal(null)
    if (!active.moved) return
    suppressClick.current = active.id
    const target = point && goalUnderPointer(point)
    if (target) reorderRef.current(active.id, target)
  }
  function pointerStart(e) {
    if (!canSort || e.button !== 0 || !e.isPrimary || e.pointerType === 'touch' || e.target.closest('input, button:not(.wc-entry-main)')) return
    const row = e.target.closest('[data-goal-sort-id]')
    if (!row) return
    suppressClick.current = null
    gesture.current = { row, id: row.dataset.goalSortId, pointerId: e.pointerId, x: e.clientX, y: e.clientY, moved: false }
  }
  function pointerMove(e) {
    const active = gesture.current
    if (active?.pointerId !== e.pointerId) return
    if (!active.moved) {
      if (Math.hypot(e.clientX - active.x, e.clientY - active.y) < 6) return
      active.row.setPointerCapture(e.pointerId)
      active.moved = true
    }
    updateDrag(active, e)
  }
  function pointerEnd(e, cancelled = false) {
    const active = gesture.current
    if (active?.pointerId === e.pointerId) finishDrag(active, cancelled ? null : e)
  }
  useEffect(() => {
    if (!canSort) return
    const list = agenda.current
    // A short hold enters sorting on touch. A swipe before that scrolls the page.
    function start(e) {
      if (e.touches.length !== 1) {
        if (gesture.current?.touchId !== undefined) finishDrag(gesture.current, null)
        return
      }
      if (e.target.closest('input, button:not(.wc-entry-main)')) return
      const row = e.target.closest('[data-goal-sort-id]')
      if (!row) return
      const point = e.changedTouches[0]
      suppressClick.current = null
      const active = { row, id: row.dataset.goalSortId, touchId: point.identifier, x: point.clientX, y: point.clientY, moved: false }
      active.timer = setTimeout(() => {
        if (gesture.current !== active) return
        active.moved = true
        updateDrag(active, point)
      }, 320)
      gesture.current = active
    }
    function move(e) {
      const active = gesture.current
      if (active?.touchId === undefined) return
      const point = Array.from(e.changedTouches).find(t => t.identifier === active.touchId)
      if (!point) return
      if (!active.moved) {
        if (Math.hypot(point.clientX - active.x, point.clientY - active.y) >= 8) finishDrag(active, null)
        return
      }
      if (!e.cancelable) { finishDrag(active, null); return }
      e.preventDefault()
      updateDrag(active, point)
    }
    function end(e) {
      const active = gesture.current
      const point = Array.from(e.changedTouches).find(t => t.identifier === active?.touchId)
      if (!point) return
      if (active.moved && e.cancelable) e.preventDefault()
      finishDrag(active, e.type === 'touchend' ? point : null)
    }
    function contextMenu(e) { if (gesture.current?.touchId !== undefined) e.preventDefault() }
    list.addEventListener('touchstart', start, { passive: true })
    list.addEventListener('touchmove', move, { passive: false })
    list.addEventListener('touchend', end, { passive: false })
    list.addEventListener('touchcancel', end)
    list.addEventListener('contextmenu', contextMenu)
    return () => {
      if (gesture.current?.touchId !== undefined) finishDrag(gesture.current, null)
      list.removeEventListener('touchstart', start)
      list.removeEventListener('touchmove', move)
      list.removeEventListener('touchend', end)
      list.removeEventListener('touchcancel', end)
      list.removeEventListener('contextmenu', contextMenu)
    }
  }, [canSort, selected])
  const liftedEvent = lifted && selectedItems.find(event => event.id === lifted.id)
  function sortByKey(e, id) {
    if (!canSort) return
    if (e.key === 'Escape' && gesture.current) { finishDrag(gesture.current, null); return }
    const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
    if (!step) return
    e.preventDefault()
    const target = sortableIds[sortableIds.indexOf(id) + step]
    if (target) reorder(id, target)
  }
  function leaveTrash() { setLoading(true); setTrash(false); setMessage(''); setUndo(null) }
  function selectDay(next) {
    setDay(next)
    if (trash) leaveTrash()
  }
  function navigate(amount) {
    if (mode === 'week') selectDay(addDays(selected, amount * 7))
    else { const date = new Date(selected.slice(0, 7) + '-01T12:00:00Z'); date.setUTCMonth(date.getUTCMonth() + amount); selectDay(date.toISOString().slice(0, 10)) }
  }
  function keyboard(e, d) {
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -((new Date(d + 'T12:00:00Z').getUTCDay() + 6) % 7), End: 6 - ((new Date(d + 'T12:00:00Z').getUTCDay() + 6) % 7) }[e.key]
    if (delta === undefined) return
    e.preventDefault(); gridFocus.current = true; selectDay(addDays(d, delta))
  }
  async function exportRange() { setError(''); try { download(await api('/calendar-export?' + new URLSearchParams({ from, to, timeZone: zone }))) } catch (e) { setError(e.message) } }
  return <section className="dsh-worklog wl-calendar" aria-label="工作日历">
    <header className="wc-toolbar">
      <div className="wc-title"><h2>{selected.slice(0, 4)} 年 {Number(selected.slice(5, 7))} 月</h2>{trash && <span className="wl-muted">回收站</span>}</div>
      <div className="wc-navigation" role="group" aria-label="日期导航">
        <button type="button" className="wc-page-arrow wc-page-prev" aria-label="上一页日历" onClick={() => navigate(-1)} />
        <button type="button" onClick={() => selectDay(today)}>今天</button>
        <button type="button" className="wc-page-arrow wc-page-next" aria-label="下一页日历" onClick={() => navigate(1)} />
      </div>
      <div className="wc-switch" role="group" aria-label="日历视图"><button type="button" aria-pressed={mode === 'month'} onClick={() => setMode('month')}>月</button><button type="button" aria-pressed={mode === 'week'} onClick={() => setMode('week')}>周</button><button type="button" aria-pressed={mode === 'list'} onClick={() => setMode('list')}>列表</button></div>
      <button type="button" className="wl-primary wc-add-goal" disabled={!info || loading || busy} onClick={() => trash ? leaveTrash() : setEditor({ day: selected, groupId: filterGroup || 'default', kind: filterKind || 'goal' })}>{trash ? '返回日历' : '＋ 新建'}</button>
      <div className="wc-toolbar-end">
        <button type="button" className="wc-account-trigger" aria-label="日历账号" disabled={!info} onClick={() => setSettingsPanel('account')}>{info?.externalSync?.connected ? '账号' : '登录'}</button>
        <ActionMenu label="日历更多操作"><button type="button" disabled={!info} onClick={() => setSettingsPanel('report')}>日历设置</button><button type="button" disabled={!info?.groups} onClick={() => setSettingsPanel('groups')}>管理分组</button><button type="button" onClick={() => { setLoading(true); setTrash(!trash); setUndo(null) }}>{trash ? '返回日历' : '回收站'}</button><button type="button" disabled={!info} onClick={exportRange}>导出当前范围 .ics</button><button type="button" onClick={() => setVersion(v => v + 1)}>刷新日历</button></ActionMenu>
      </div>
    </header>
    <div className="wc-filters" role="search" aria-label="筛选日历"><label>分组<Select aria-label="分组筛选" value={filterGroup} onChange={e => setFilterGroup(e.target.value)}><option value="">全部分组</option>{groups.items.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</Select></label><label>类型<Select aria-label="类型筛选" value={filterKind} onChange={e => setFilterKind(e.target.value)}><option value="">全部类型</option>{Object.entries(kindLabels).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</Select></label><label className="wc-filter-search">搜索<input type="search" placeholder="标题、标签或项目" value={filterText} onChange={e => setFilterText(e.target.value)} /></label>{(filterGroup || filterKind || filterText) && <button type="button" onClick={() => { setFilterGroup(''); setFilterKind(''); setFilterText('') }}>清除筛选</button>}</div>
    {error && <div className="wl-error" role="alert">{error}<button onClick={() => setVersion(v => v + 1)}>刷新</button></div>}
    <div className="wc-layout" aria-busy={loading}>
      <div className="wc-board">
        {mode === 'list' ? <CalendarList days={days} byDay={byDay} groupMap={groupMap} zone={zone} select={selectDay} open={setEditor} /> : mode === 'month' ? <><div className="wc-weekdays">{weekdays.map(d => <span key={d}>周{d}</span>)}</div><div className="wc-month" role="group" aria-label="按方向键选择日期">{days.map(d => <button key={d} ref={el => el ? dayRefs.current.set(d, el) : dayRefs.current.delete(d)} tabIndex={d === selected ? 0 : -1} onKeyDown={e => keyboard(e, d)} className={`wc-day ${d.slice(0, 7) !== selected.slice(0, 7) ? 'wc-outside' : ''}`} aria-pressed={d === selected} aria-label={`${d}，${byDay.get(d)?.length || 0} 项`} onClick={() => selectDay(d)}>
          <span className={`wc-date ${d === today ? 'wc-today' : ''}`}>{Number(d.slice(8))}</span><span className="wc-cell-items">{byDay.get(d)?.slice(0, 3).map(e => <span className={`wc-chip wc-${e.status} wc-priority-${e.priority}`} key={e.id} title={`${kindLabels[e.kind]} · ${groupMap.get(e.groupId ?? 'default')?.name ?? '工作'} · ${e.title}`} style={{ borderInlineStart: `3px solid ${groupInk[groupMap.get(e.groupId ?? 'default')?.color] || groupInk.teal}` }}>{!e.allDay && <small>{localParts(e.startAt, zone).day === d ? localParts(e.startAt, zone).time : '跨天'}</small>}{e.title}</span>)}</span>{byDay.get(d)?.length > 3 && <small className="wc-overflow">另 {byDay.get(d).length - 3} 项</small>}<span className="wc-mobile-count">{byDay.get(d)?.length || ''}</span>
        </button>)}</div></> : <Week key={from} days={days} byDay={byDay} selected={selected} today={today} zone={zone} select={selectDay} open={setEditor} />}
        <footer className="wc-board-footer"><span>{loading ? '正在读取日历…' : `${visibleEvents.length} 项 · ${info?.source === 'remote' ? '远程日历' : '本地日历'}`} · {zone}</span><span>{info?.externalSync?.connected ? info.externalSync.enabled ? 'iCloud 同步已启用' : 'iCloud 同步已关闭' : '可导出至其他日历'}</span></footer>
      </div>
      <aside className="wc-agenda" aria-label="当日安排"><div className="wc-agenda-heading"><span className="wl-eyebrow">{selected === today ? '今天' : '选中日期'}</span><h3>{dateLabel(selected)}</h3><input type="date" aria-label="跳转日期" min="1901-01-01" max="2199-12-31" value={selected} onChange={e => e.target.value && selectDay(e.target.value)} /></div>
        {!trash && <><div className="wc-progress-label"><span>完成进度</span><strong>{done} / {goals.length}</strong></div><progress aria-label="当日完成进度" max={goals.length || 1} value={done} /><form className="wc-quick" onSubmit={async e => { e.preventDefault(); if (!quick.trim()) return; try { await mutate('create', { event: { title: quick.trim(), day: selected, timeZone: zone, groupId: filterGroup || 'default' } }); setQuick('') } catch {} }}><input aria-label="快速添加目标" placeholder="今天想完成什么？" value={quick} onChange={e => setQuick(e.target.value)} maxLength={160} disabled={busy || loading || !info} /><button aria-label="添加目标" disabled={busy || loading || !quick.trim()}>＋</button></form></>}
        {!trash && info?.reportReview && <ReportProgressReview key={`${info.calendarId}:${selected}`} selected={selected} today={today}
          review={info.reportReview} onChange={reportReview => setInfo(current => current && ({ ...current, reportReview }))}
          settings={() => setSettingsPanel('report')} />}
        <div className="wc-agenda-list" ref={agenda} onPointerDown={pointerStart} onPointerMove={pointerMove}
          onPointerUp={pointerEnd} onPointerCancel={e => pointerEnd(e, true)} onLostPointerCapture={e => pointerEnd(e, true)}
          onPointerLeave={e => { if (!gesture.current?.moved) pointerEnd(e, true) }}>{!loading && !selectedItems.length && <div className="wc-empty"><strong>{trash ? '这一天没有已删除的条目' : '这一天没有匹配的安排'}</strong><p>{trash ? '先选择目标所在的日期，再打开回收站查看。' : '先记下一个小目标，时间可以稍后再安排。也可以直接让 AI 帮你记录。'}</p></div>}{selectedItems.map(event => <article key={event.id} data-goal-sort-id={canSort && event.kind === 'goal' ? event.id : undefined}
          className={`wc-entry wc-${event.status} wc-priority-${event.priority}${pickedGoal === event.id ? ' wc-dragging' : ''}${dropGoal === event.id && pickedGoal !== event.id ? (sortableIds.indexOf(pickedGoal) > sortableIds.indexOf(event.id) ? ' wc-drop-before' : ' wc-drop-after') : ''}`}>
          {!trash && <input type="checkbox" checked={event.status === 'done'} aria-label={`完成目标：${event.title}`} disabled={busy || loading || event.status === 'cancelled'} onChange={() => rowAction(event, 'update', { status: event.status === 'done' ? 'planned' : 'done' })} />}
          <button className="wc-entry-main" type="button"
            aria-label={`${event.title}，优先级 ${priorities[event.priority]}`}
            aria-keyshortcuts={hasSort && event.kind === 'goal' ? 'ArrowUp ArrowDown' : undefined}
            onKeyDown={hasSort && event.kind === 'goal' ? e => sortByKey(e, event.id) : undefined}
            onClick={e => {
              if (e.detail && suppressClick.current === event.id) { suppressClick.current = null; return }
              setEditor(event)
            }}>
            <GoalSummary event={event} zone={zone} group={groupMap.get(event.groupId ?? 'default')} />
            {event.progressSummary?.text && <span className="wc-progress-preview"><time>{event.progressSummary.day}</time> {event.progressSummary.text}</span>}
          </button>
          {event.kind === 'goal' && info?.dailyProgress && <button type="button" className="wc-entry-progress" disabled={busy || loading}
            aria-label={`查看 ${event.title} 的每日进度`} onClick={() => setProgressEvent(event)}>
            <span>每日进度</span>{event.progressSummary?.count > 0 && <small>{event.progressSummary.count}</small>}
          </button>}
          {trash && <button disabled={busy} onClick={() => rowAction(event, 'restore')}>恢复</button>}
        </article>)}</div>
      </aside>
    </div>
    {(message || undo) && <div className="wl-feedback" role="status">{message}{undo && <button disabled={busy} onClick={() => rowAction(undo, 'restore')}>撤销删除</button>}</div>}
    {liftedEvent && createPortal(
      <div ref={dragLayer} aria-hidden="true"
        className={`dsh-worklog wc-drag-preview wc-entry wc-${liftedEvent.status} wc-priority-${liftedEvent.priority}`}
        style={{ ...lifted.palette, width: lifted.width, height: lifted.height, transform: lifted.transform }}>
        <span className={`wc-preview-check${liftedEvent.status === 'done' ? ' wc-preview-checked' : ''}`} />
        <div className="wc-entry-main"><GoalSummary event={liftedEvent} zone={zone} /></div>
      </div>, document.body,
    )}
    {settingsPanel === 'groups' && <CalendarGroups value={groups} close={() => setSettingsPanel(null)} saved={value => setInfo(current => ({ ...current, groups: value }))} />}
    {settingsPanel === 'report' && <CalendarSettings close={() => { setSettingsPanel(null); setVersion(n => n + 1) }} supported={info?.calendarSettings === true} today={today} recheckSupported={info?.reportRecheck === true} />}
    {settingsPanel === 'account' && <CalendarAccounts close={() => { setSettingsPanel(null); setVersion(n => n + 1) }} onCalendarChanged={() => setVersion(n => n + 1)} zone={zone} supported={info?.calendarSettings === true} />}
    {editor && <EventEditor key={editor.id || editor.day} event={editor} groups={groups.items} zone={zone} today={today} calendarId={info?.calendarId} progressEnabled={info?.dailyProgress === true} progressHistory={info?.progressHistory === true} progressCursor={info?.progressCursor} workdayScheduling={info?.workdayScheduling === true} busy={busy} close={() => setEditor(null)} save={mutate} />}
    {progressEvent && <ProgressHistory event={progressEvent} calendarId={info?.calendarId} historyAvailable={info?.progressHistory === true} progressCursor={info?.progressCursor} busy={busy} save={mutate} close={() => setProgressEvent(null)} />}
  </section>
}

function GoalSummary({ event, zone, group }) {
  const tags = event.tags.map(tag => '#' + tag)
  const meta = [
    kindLabels[event.kind], group?.name,
    event.remindAt != null && `提醒 ${localParts(event.remindAt, zone).time}`,
    event.status !== 'planned' && labels[event.status],
    event.carriedFrom && `续自 ${event.carriedFrom.day.slice(5)}`,
    ...tags,
  ].filter(Boolean).join('  ')
  return <><strong>{event.title}</strong><small>{timeLabel(event, zone)}</small><span className="wc-entry-meta">{meta}</span></>
}

function CalendarList({ days, byDay, groupMap, zone, select, open }) {
  const occupied = days.filter(day => byDay.get(day)?.length)
  return <div className="wc-list-view" aria-label="日历安排列表">
    {!occupied.length && <p className="wc-empty">这个日期范围没有匹配的安排，可以切换分组或搜索条件。</p>}
    {occupied.map(day => <section className="wc-list-day" key={day}>
      <button className="wc-list-date" type="button" onClick={() => select(day)}>{dateLabel(day)}</button>
      <div>{byDay.get(day).map(event => <button type="button" key={event.id} className={`wc-list-item wc-${event.status}`} onClick={() => open(event)}>
        <span className="wc-group-dot" aria-hidden="true" style={{ background: groupInk[groupMap.get(event.groupId ?? 'default')?.color] || groupInk.teal }} />
        <span><strong>{event.title}</strong><small>{kindLabels[event.kind]} · {groupMap.get(event.groupId ?? 'default')?.name ?? '工作'} · {timeLabel(event, zone)}</small>{event.tags?.length > 0 && <small>{event.tags.map(tag => '#'+tag).join(' ')}</small>}</span>
        <span className="wc-list-state">{labels[event.status]}</span>
      </button>)}</div>
    </section>)}
  </div>
}

function Week({ days, byDay, selected, today, zone, select, open }) {
  const scroll = useRef(null)
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = 8 * 48 }, [])
  return <div className="wc-week"><div className="wc-week-head"><span>时间</span>{days.map((d, i) => <button key={d} aria-pressed={d === selected} onClick={() => select(d)}><span>周{weekdays[i]}</span><strong className={d === today ? 'wc-today' : ''}>{Number(d.slice(8))}</strong></button>)}</div>
    <div className="wc-all-day"><span>全天</span>{days.map(d => <div key={d}>{byDay.get(d)?.filter(e => e.allDay).map(e => <button key={e.id} className={`wc-chip wc-${e.status} wc-priority-${e.priority}`} onClick={() => open(e)} title={e.title}>{e.title}</button>)}</div>)}</div>
    <div className="wc-week-scroll" ref={scroll}><div className="wc-week-hours"><div className="wc-hour-labels">{Array.from({ length: 24 }, (_, h) => <span key={h}>{String(h).padStart(2, '0')}:00</span>)}</div>{days.map(d => <div className="wc-hour-column" key={d}>{weekLayout(byDay.get(d) || [], d, zone).map(({ event, start, end, lane, lanes }) => <button key={event.id} className={`wc-time-event wc-${event.status} wc-priority-${event.priority}`} style={{ top: `${start / 1440 * 100}%`, height: `${(end - start) / 1440 * 100}%`, left: `${lane / lanes * 100}%`, width: `${100 / lanes}%` }} title={`${event.title} · ${timeLabel(event, zone)}`} onClick={() => open(event)}><small>{localParts(event.startAt, zone).time}</small><span>{event.title}</span></button>)}</div>)}</div></div>
  </div>
}

function EventEditor({ event, groups, zone, today, calendarId, progressEnabled, progressHistory, progressCursor, workdayScheduling, busy, close, save }) {
  const formId = useId(), existing = !!event.id, eventZone = event.timeZone || zone
  const initial = useMemo(() => {
    const start = existing && !event.allDay ? localParts(event.startAt, eventZone) : { day: event.day, time: '09:00' }
    const end = existing && !event.allDay ? localParts(event.endAt, eventZone) : { day: existing ? addDays(event.endDay, -1) : event.day, time: '10:00' }
    return { title: event.title || '', description: event.description || '', kind: event.kind || 'goal', status: event.status || 'planned', priority: event.priority || 'normal', groupId: event.groupId || 'default', reminderEnabled: event.remindAt != null || !existing && event.kind === 'reminder', remindTime: event.remindAt != null ? localParts(event.remindAt, eventZone).day + 'T' + localParts(event.remindAt, eventZone).time : (event.day || today) + 'T09:00', carryMode: event.carryMode || 'daily', allDay: event.allDay ?? true, day: start.day, endDay: end.day, startTime: start.time, endTime: end.time, tags: (event.tags || []).join('，'), project: event.project || '' }
  }, [event])
  const [draft, setDraft] = useState(initial), [error, setError] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [originalCreatedAt, setOriginalCreatedAt] = useState(null)
  const showProgress = progressEnabled && existing && event.kind === 'goal'
  const id = event.id, progressDay = event.carriedFrom?.day ?? event.day
  useEffect(() => {
    if (!showProgress || !event.carriedFrom) return
    const controller = new AbortController()
    const query = new URLSearchParams({ id, day: progressDay })
    api('/calendar-progress?' + query, undefined, controller.signal).then(result => {
      if (!controller.signal.aborted && result.calendarId === calendarId) setOriginalCreatedAt(result.createdAt)
    }).catch(() => {})
    return () => controller.abort()
  }, [showProgress, id, event.carriedFrom, progressDay, calendarId])
  const change = (key, value) => setDraft(d => ({ ...d, [key]: value }))
  function changeTime(which, value) {
    const [day = '', time = ''] = value.split('T')
    if (which === 'start') setDraft(d => ({ ...d, day, startTime: time, endDay: d.endDay < day ? day : d.endDay }))
    else setDraft(d => ({ ...d, endDay: day, endTime: time }))
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  const creationDay = existing ? localParts(originalCreatedAt ?? event.createdAt, zone).day : today
  async function submit(e) {
    e.preventDefault(); setError('')
    try {
      const value = { title: draft.title, description: draft.description, kind: draft.kind, status: draft.status, priority: draft.priority, allDay: draft.allDay, timeZone: eventZone, tags: draft.tags.split(/[,，]/).map(t => t.trim()).filter(Boolean), project: draft.project, groupId: draft.groupId, remindAt: draft.reminderEnabled ? new Date(event.remindAt != null && draft.remindTime === initial.remindTime ? event.remindAt : wallTime(draft.remindTime.slice(0, 10), draft.remindTime.slice(11), eventZone)).toISOString() : null }
      if (workdayScheduling) value.carryMode = draft.carryMode
      if (draft.allDay) {
        value.day = draft.day
        value.endDay = addDays(draft.endDay, 1)
      }
      else {
        // Keep the original absolute instant when editing text during a repeated DST hour.
        const at = (date, time, original, initialDay, initialTime) => original != null && date === initialDay && time === initialTime ? original : wallTime(date, time, eventZone)
        value.startAt = new Date(at(draft.day, draft.startTime, event.startAt, initial.day, initial.startTime)).toISOString()
        value.endAt = new Date(at(draft.endDay, draft.endTime, event.endAt, initial.endDay, initial.endTime)).toISOString()
      }
      if (!existing || dirty) await save(existing ? 'update' : 'create', existing ? { id, revision: event.revision, patch: value } : { event: value })
      close()
    } catch (e) { setError(e.message) }
  }
  async function remove() { setError(''); try { await save('delete', { id: event.id, revision: event.revision }); close() } catch (e) { setError(e.message) } }
  return <><Dialog title={event.deletedAt ? '已删除的条目' : existing ? '编辑安排' : '新建安排'} className="wc-event-dialog" close={close} busy={busy} protectChanges dirty={dirty}>
    {error && <p className="wl-error" role="alert">{error}</p>}
    <form id={formId} className="wc-editor" onSubmit={submit}><fieldset disabled={busy || !!event.deletedAt}>
      <div className="wc-form-row"><label>类型<Select aria-label="类型" value={draft.kind} onChange={e => setDraft(d => ({ ...d, kind: e.target.value, reminderEnabled: e.target.value === 'reminder' ? true : d.reminderEnabled }))}>{Object.entries(kindLabels).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</Select></label><label>分组<Select aria-label="分组" value={draft.groupId} onChange={e => change('groupId', e.target.value)}>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</Select></label></div>
      <label>标题<input autoFocus required maxLength={160} placeholder="例如：完成文章初稿" value={draft.title} onChange={e => change('title', e.target.value)} /></label>
      <label className="wl-check"><input type="checkbox" checked={!draft.allDay} onChange={e => change('allDay', !e.target.checked)} />安排具体时段</label>
      <div className="wc-created-date"><span>创建日期</span><time dateTime={creationDay}>{creationDay}</time></div>
      {draft.allDay && <div className="wc-form-row"><label>开始日期<input type="date" required value={draft.day} onChange={e => setDraft(d => ({ ...d, day: e.target.value, endDay: d.endDay < e.target.value ? e.target.value : d.endDay }))} /></label><label>结束日期<input type="date" required min={draft.day} value={draft.endDay} onChange={e => change('endDay', e.target.value)} /></label></div>}
      {!draft.allDay && <>
        <div className="wc-form-row wc-timed-fields">
          <label>开始<input type="datetime-local" required min="1900-01-01T00:00" max="2200-12-30T23:59" value={draft.day && draft.startTime ? draft.day + 'T' + draft.startTime : ''} onChange={e => changeTime('start', e.target.value)} /></label>
          <label>结束<input type="datetime-local" required min={draft.day ? draft.day + 'T00:00' : '1900-01-01T00:00'} max="2200-12-30T23:59" value={draft.endDay && draft.endTime ? draft.endDay + 'T' + draft.endTime : ''} onChange={e => changeTime('end', e.target.value)} /></label>
        </div>
        <p className="wl-muted wc-small">按 {eventZone} 安排，允许跨天。</p>
      </>}
      <div className="wc-form-row"><label>状态<Select value={draft.status} onChange={e => change('status', e.target.value)}>{Object.entries(labels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></label><label>优先级<Select value={draft.priority} onChange={e => change('priority', e.target.value)}><option value="low">不急</option><option value="normal">普通</option><option value="high">优先</option></Select></label></div>
      {draft.kind === 'goal' && workdayScheduling && <label>未完成时结转到<Select value={draft.carryMode} onChange={e => change('carryMode', e.target.value)}><option value="daily">下一天</option><option value="workdays">下一个工作日</option></Select><small className="wl-muted">工作日及休息日例外可在「日历设置」中调整。</small></label>}
      <label className="wl-check"><input type="checkbox" checked={draft.reminderEnabled} onChange={e => change('reminderEnabled', e.target.checked)} />到时间提醒</label>
      {draft.reminderEnabled && <label>提醒时间<input type="datetime-local" aria-label="提醒时间" required value={draft.remindTime} onChange={e => change('remindTime', e.target.value)} /><small className="wl-muted">按 {eventZone} 提醒，支持 DSH 提示与已关联的 iCloud 通知。</small></label>}
      <label>备注<textarea rows={3} maxLength={8000} placeholder="需要记住的细节（选填）" value={draft.description} onChange={e => change('description', e.target.value)} /></label>
      <details open={!!draft.tags || !!draft.project || draft.kind === 'work'}><summary>标签与关联</summary><label>标签（用逗号分隔）<input maxLength={395} value={draft.tags} onChange={e => change('tags', e.target.value)} /></label><label>关联项目<input maxLength={500} value={draft.project} onChange={e => change('project', e.target.value)} /></label></details>
    </fieldset>
    {showProgress && <button className="wc-progress-open" type="button" disabled={busy} onClick={() => setHistoryOpen(true)}>每日进度</button>}
    <DialogActions>{existing && !event.deletedAt && <button type="button" className="wc-delete" disabled={busy} onClick={remove}>移入回收站</button>}<button type="button" disabled={busy} onClick={close}>{event.deletedAt ? '关闭' : '取消'}</button>{!event.deletedAt && <button type="submit" form={formId} className="wl-primary" disabled={busy || !draft.title.trim()}>{busy ? '保存中…' : '保存安排'}</button>}</DialogActions></form>
  </Dialog>
    {historyOpen && <ProgressHistory event={event} calendarId={calendarId} historyAvailable={progressHistory} progressCursor={progressCursor} busy={busy} save={save} close={() => setHistoryOpen(false)} />}
  </>
}
