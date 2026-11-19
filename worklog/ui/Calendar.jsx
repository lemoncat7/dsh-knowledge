import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from './api.js'
import { Dialog, DialogActions } from './Dialog.jsx'
import { ActionMenu } from './ActionMenu.jsx'
import { applyGoalOrder, moveGoal } from '../calendar/goal-order.js'
import { addDays, eventOnDay, localParts, monthDays, weekDays, wallTime } from '../calendar/time.js'

const labels = { planned: '待完成', in_progress: '进行中', done: '已完成', cancelled: '已取消' }
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
  const [info, setInfo] = useState(null), [day, setDay] = useState(''), [mode, setMode] = useState('month')
  const [goalOrders, setGoalOrders] = useState({})
  const [events, setEvents] = useState([]), [loading, setLoading] = useState(true), [version, setVersion] = useState(0)
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState(null), [trash, setTrash] = useState(false), [undo, setUndo] = useState(null), [quick, setQuick] = useState('')
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
        const key = `${next.calendarId}:${next.cursor}:${next.orderCursor}:${next.timeZone}:${next.today}`
        if (key === lastKey) return
        const query = new URLSearchParams({ from, to, timeZone: next.timeZone, deleted: trash ? 'only' : 'exclude', limit: '500' })
        let all = [], page
        do { page = await api('/calendar?' + query, undefined, controller.signal); if (page.calendarId !== next.calendarId || page.cursor !== next.cursor || page.orderCursor !== next.orderCursor) throw new Error('日历已更新，正在重新读取，请稍后刷新'); all.push(...page.items); if (page.nextOffset !== null) query.set('offset', page.nextOffset) } while (page.nextOffset !== null && all.length < 5000)
        if (controller.signal.aborted) return
        if (page.nextOffset !== null) throw new Error('当前范围超过 5000 项，请切换周视图查看')
        setInfo(next); setEvents(all); setGoalOrders(page.goalOrders || {}); setLoading(false); setError(''); lastKey = key
        if (!day) setDay(next.today)
      } catch (e) { if (!controller.signal.aborted) { setError(e.message); setLoading(false) } }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 15000) }
    }
    setLoading(true); load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [from, to, trash, version])
  useEffect(() => { if (gridFocus.current) { dayRefs.current.get(selected)?.focus(); gridFocus.current = false } }, [selected])
  const visibleEvents = useMemo(() => events.filter(e => (e.deletedAt !== null) === trash), [events, trash])
  const byDay = useMemo(() => new Map(days.map(d => {
    const items = visibleEvents.filter(e => eventOnDay(e, d, zone))
    return [d, trash ? items : applyGoalOrder(items, goalOrders[d]?.ids)]
  })), [days, visibleEvents, zone, goalOrders, trash])
  const selectedItems = byDay.get(selected) || [], goals = selectedItems.filter(e => e.status !== 'cancelled'), done = goals.filter(e => e.status === 'done').length
  const sortableIds = selectedItems.filter(event => event.kind === 'goal').map(event => event.id)
  const hasSort = !trash && Number.isInteger(info?.orderCursor) && sortableIds.length > 1
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
      } else {
        setEvents(previous => {
          const index = previous.findIndex(e => e.id === result.event.id)
          if ((result.event.deletedAt !== null) !== trash) return previous.filter(e => e.id !== result.event.id)
          return index < 0 ? [...previous, result.event] : previous.map((e, i) => i === index ? result.event : e)
        })
      }
      setVersion(v => v + 1); setMessage(action === 'delete' ? '已移入回收站' : action === 'restore' ? '已恢复' : action === 'reorder' ? '顺序已保存' : '已保存')
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
    if (!canSort || e.button !== 0 || !e.isPrimary || e.pointerType === 'touch' || e.target.closest('input')) return
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
      if (e.target.closest('input')) return
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
  const editorIndex = hasSort ? sortableIds.indexOf(editor?.id) : -1
  const editorSort = editorIndex < 0 ? null : {
    up: sortableIds[editorIndex - 1], down: sortableIds[editorIndex + 1],
  }
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
    <header className="wc-toolbar"><div className="wc-title"><h2>{selected.slice(0, 4)} 年 {Number(selected.slice(5, 7))} 月</h2><span className="wl-muted">{trash ? '回收站 · 当前日期范围' : '每天一点进展，让目标有处安放'}</span></div>
      <div className="wc-navigation"><button aria-label="上一页日历" onClick={() => navigate(-1)}>‹</button><button onClick={() => selectDay(today)}>今天</button><button aria-label="下一页日历" onClick={() => navigate(1)}>›</button></div>
      <div className="wc-switch" aria-label="日历视图"><button aria-pressed={mode === 'month'} onClick={() => setMode('month')}>月</button><button aria-pressed={mode === 'week'} onClick={() => setMode('week')}>周</button></div>
      <button className="wl-primary" disabled={!info || loading || busy} onClick={() => trash ? leaveTrash() : setEditor({ day: selected })}>{trash ? '返回日历' : '＋ 新目标'}</button>
      <ActionMenu label="日历更多操作"><button onClick={() => { setLoading(true); setTrash(!trash); setUndo(null) }}>{trash ? '返回日历' : '回收站'}</button><button disabled={!info} onClick={exportRange}>导出当前范围 .ics</button><button onClick={() => setVersion(v => v + 1)}>刷新日历</button></ActionMenu>
    </header>
    {error && <div className="wl-error" role="alert">{error}<button onClick={() => setVersion(v => v + 1)}>刷新</button></div>}
    <div className="wc-layout" aria-busy={loading}>
      <div className="wc-board">
        {mode === 'month' ? <><div className="wc-weekdays">{weekdays.map(d => <span key={d}>周{d}</span>)}</div><div className="wc-month" role="group" aria-label="按方向键选择日期">{days.map(d => <button key={d} ref={el => el ? dayRefs.current.set(d, el) : dayRefs.current.delete(d)} tabIndex={d === selected ? 0 : -1} onKeyDown={e => keyboard(e, d)} className={`wc-day ${d.slice(0, 7) !== selected.slice(0, 7) ? 'wc-outside' : ''}`} aria-pressed={d === selected} aria-label={`${d}，${byDay.get(d)?.length || 0} 项`} onClick={() => selectDay(d)}>
          <span className={`wc-date ${d === today ? 'wc-today' : ''}`}>{Number(d.slice(8))}</span><span className="wc-cell-items">{byDay.get(d)?.slice(0, 3).map(e => <span className={`wc-chip wc-${e.status} wc-priority-${e.priority}`} key={e.id}>{!e.allDay && <small>{localParts(e.startAt, zone).day === d ? localParts(e.startAt, zone).time : '跨天'}</small>}{e.title}</span>)}</span>{byDay.get(d)?.length > 3 && <small className="wc-overflow">另 {byDay.get(d).length - 3} 项</small>}<span className="wc-mobile-count">{byDay.get(d)?.length || ''}</span>
        </button>)}</div></> : <Week key={from} days={days} byDay={byDay} selected={selected} today={today} zone={zone} select={selectDay} open={setEditor} />}
        <footer className="wc-board-footer"><span>{loading ? '正在读取日历…' : `${visibleEvents.length} 项 · ${info?.source === 'remote' ? '远程日历' : '本地日历'}`} · {zone}</span><span>可导出至其他日历 · 暂未连接外部账号</span></footer>
      </div>
      <aside className="wc-agenda" aria-label="当日目标"><div className="wc-agenda-heading"><span className="wl-eyebrow">{selected === today ? '今天' : '选中日期'}</span><h3>{dateLabel(selected)}</h3><input type="date" aria-label="跳转日期" min="1901-01-01" max="2199-12-31" value={selected} onChange={e => e.target.value && selectDay(e.target.value)} /></div>
        {!trash && <><div className="wc-progress-label"><span>完成进度</span><strong>{done} / {goals.length}</strong></div><progress aria-label="当日完成进度" max={goals.length || 1} value={done} /><form className="wc-quick" onSubmit={async e => { e.preventDefault(); if (!quick.trim()) return; try { await mutate('create', { event: { title: quick.trim(), day: selected, timeZone: zone } }); setQuick('') } catch {} }}><input aria-label="快速添加目标" placeholder="今天想完成什么？" value={quick} onChange={e => setQuick(e.target.value)} maxLength={160} disabled={busy || loading || !info} /><button aria-label="添加目标" disabled={busy || loading || !quick.trim()}>＋</button></form></>}
        <div className="wc-agenda-list" ref={agenda} onPointerDown={pointerStart} onPointerMove={pointerMove}
          onPointerUp={pointerEnd} onPointerCancel={e => pointerEnd(e, true)} onLostPointerCapture={e => pointerEnd(e, true)}
          onPointerLeave={e => { if (!gesture.current?.moved) pointerEnd(e, true) }}>{!loading && !selectedItems.length && <div className="wc-empty"><strong>{trash ? '这一天没有已删除的目标' : '留一点空间给今天'}</strong><p>{trash ? '先选择目标所在的日期，再打开回收站查看。' : '先记下一个小目标，时间可以稍后再安排。也可以直接让 AI 帮你记录。'}</p></div>}{selectedItems.map(event => <article key={event.id} data-goal-sort-id={canSort && event.kind === 'goal' ? event.id : undefined}
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
            <GoalSummary event={event} zone={zone} />
          </button>
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
    {editor && <EventEditor key={editor.id || editor.day} event={editor} zone={zone} busy={busy} close={() => setEditor(null)} save={mutate} sort={editorSort} move={target => reorder(editor.id, target)} />}
  </section>
}

function GoalSummary({ event, zone }) {
  const tags = event.tags.map(tag => '#' + tag)
  const meta = [
    event.status !== 'planned' && labels[event.status],
    event.carriedFrom && `续自 ${event.carriedFrom.day.slice(5)}`,
    ...tags,
  ].filter(Boolean).join('  ')
  return <><strong>{event.title}</strong><small>{timeLabel(event, zone)}</small><span className="wc-entry-meta">{meta}</span></>
}

function Week({ days, byDay, selected, today, zone, select, open }) {
  const scroll = useRef(null)
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = 8 * 48 }, [])
  return <div className="wc-week"><div className="wc-week-head"><span>时间</span>{days.map((d, i) => <button key={d} aria-pressed={d === selected} onClick={() => select(d)}><span>周{weekdays[i]}</span><strong className={d === today ? 'wc-today' : ''}>{Number(d.slice(8))}</strong></button>)}</div>
    <div className="wc-all-day"><span>全天</span>{days.map(d => <div key={d}>{byDay.get(d)?.filter(e => e.allDay).map(e => <button key={e.id} className={`wc-chip wc-${e.status} wc-priority-${e.priority}`} onClick={() => open(e)} title={e.title}>{e.title}</button>)}</div>)}</div>
    <div className="wc-week-scroll" ref={scroll}><div className="wc-week-hours"><div className="wc-hour-labels">{Array.from({ length: 24 }, (_, h) => <span key={h}>{String(h).padStart(2, '0')}:00</span>)}</div>{days.map(d => <div className="wc-hour-column" key={d}>{weekLayout(byDay.get(d) || [], d, zone).map(({ event, start, end, lane, lanes }) => <button key={event.id} className={`wc-time-event wc-${event.status} wc-priority-${event.priority}`} style={{ top: `${start / 1440 * 100}%`, height: `${(end - start) / 1440 * 100}%`, left: `${lane / lanes * 100}%`, width: `${100 / lanes}%` }} title={`${event.title} · ${timeLabel(event, zone)}`} onClick={() => open(event)}><small>{localParts(event.startAt, zone).time}</small><span>{event.title}</span></button>)}</div>)}</div></div>
  </div>
}

function EventEditor({ event, zone, busy, close, save, sort, move }) {
  const formId = useId(), existing = !!event.id, eventZone = event.timeZone || zone
  const initial = useMemo(() => {
    const start = existing && !event.allDay ? localParts(event.startAt, eventZone) : { day: event.day, time: '09:00' }
    const end = existing && !event.allDay ? localParts(event.endAt, eventZone) : { day: existing ? addDays(event.endDay, -1) : event.day, time: '10:00' }
    return { title: event.title || '', description: event.description || '', kind: event.kind || 'goal', status: event.status || 'planned', priority: event.priority || 'normal', allDay: event.allDay ?? true, day: start.day, endDay: end.day, startTime: start.time, endTime: end.time, tags: (event.tags || []).join('，'), project: event.project || '' }
  }, [event])
  const [draft, setDraft] = useState(initial), [error, setError] = useState('')
  const change = (key, value) => setDraft(d => ({ ...d, [key]: value, ...(key === 'day' && d.endDay < value ? { endDay: value } : {}) }))
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  async function submit(e) {
    e.preventDefault(); setError('')
    try {
      const value = { title: draft.title, description: draft.description, kind: draft.kind, status: draft.status, priority: draft.priority, allDay: draft.allDay, timeZone: eventZone, tags: draft.tags.split(/[,，]/).map(t => t.trim()).filter(Boolean), project: draft.project }
      if (draft.allDay) { value.day = draft.day; value.endDay = addDays(draft.endDay, 1) }
      else {
        // Keep the original absolute instant when editing text during a repeated DST hour.
        const at = (date, time, original, initialDay, initialTime) => original != null && date === initialDay && time === initialTime ? original : wallTime(date, time, eventZone)
        value.startAt = new Date(at(draft.day, draft.startTime, event.startAt, initial.day, initial.startTime)).toISOString()
        value.endAt = new Date(at(draft.endDay, draft.endTime, event.endAt, initial.endDay, initial.endTime)).toISOString()
      }
      await save(existing ? 'update' : 'create', existing ? { id: event.id, revision: event.revision, patch: value } : { event: value }); close()
    } catch (e) { setError(e.message) }
  }
  async function remove() { setError(''); try { await save('delete', { id: event.id, revision: event.revision }); close() } catch (e) { setError(e.message) } }
  return <Dialog title={event.deletedAt ? '已删除的目标' : existing ? '编辑目标' : '记下一个目标'} close={close} busy={busy} protectChanges dirty={dirty}>
    {error && <p className="wl-error" role="alert">{error}</p>}
    <form id={formId} className="wc-editor" onSubmit={submit}><fieldset disabled={busy || !!event.deletedAt}>
      <label>目标<input autoFocus required maxLength={160} placeholder="例如：完成文章初稿" value={draft.title} onChange={e => change('title', e.target.value)} /></label>
      <label className="wl-check"><input type="checkbox" checked={!draft.allDay} onChange={e => change('allDay', !e.target.checked)} />安排具体时段</label>
      <div className="wc-form-row"><label>开始日期<input type="date" required min="1900-01-01" max="2200-12-30" value={draft.day} onChange={e => change('day', e.target.value)} /></label><label>{draft.allDay ? '结束日期（含当天）' : '结束日期'}<input type="date" required min={draft.day} max="2200-12-30" value={draft.endDay} onChange={e => change('endDay', e.target.value)} /></label></div>
      {!draft.allDay && <div className="wc-form-row"><label>开始时间<input type="time" required value={draft.startTime} onChange={e => change('startTime', e.target.value)} /></label><label>结束时间<input type="time" required value={draft.endTime} onChange={e => change('endTime', e.target.value)} /></label></div>}
      <p className="wl-muted wc-small">{draft.allDay ? '没有具体时间也没关系，先记录想做的事。' : `按 ${eventZone} 安排，允许跨天。`}</p>
      <div className="wc-form-row"><label>进度<select value={draft.status} onChange={e => change('status', e.target.value)}>{Object.entries(labels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label><label>优先级<select value={draft.priority} onChange={e => change('priority', e.target.value)}><option value="low">不急</option><option value="normal">普通</option><option value="high">优先</option></select></label></div>
      <label>备注<textarea rows={3} maxLength={8000} placeholder="需要记住的细节（选填）" value={draft.description} onChange={e => change('description', e.target.value)} /></label>
      <details open={!!draft.tags || !!draft.project || draft.kind === 'work'}><summary>标签与关联</summary><label>标签（用逗号分隔）<input maxLength={395} value={draft.tags} onChange={e => change('tags', e.target.value)} /></label><label>关联项目<input maxLength={500} value={draft.project} onChange={e => change('project', e.target.value)} /></label><label>记录类型<select value={draft.kind} onChange={e => change('kind', e.target.value)}><option value="goal">计划目标</option><option value="work">实际工作</option></select></label></details>
    </fieldset>
    {sort && <div className="wc-editor-order" role="group" aria-label="目标排序">
      <button type="button" disabled={busy || !sort.up} onClick={() => move(sort.up)}>上移</button>
      <button type="button" disabled={busy || !sort.down} onClick={() => move(sort.down)}>下移</button>
    </div>}
    <DialogActions>{existing && !event.deletedAt && <button type="button" className="wc-delete" disabled={busy} onClick={remove}>移入回收站</button>}<button type="button" disabled={busy} onClick={close}>{event.deletedAt ? '关闭' : '取消'}</button>{!event.deletedAt && <button type="submit" form={formId} className="wl-primary" disabled={busy || !draft.title.trim()}>{busy ? '保存中…' : '保存目标'}</button>}</DialogActions></form>
  </Dialog>
}
