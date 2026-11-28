import { useEffect, useRef, useState } from 'react'
import { nextAckRequestId } from './calendar-ack-id.js'

interface Reminder { id:string; title:string; day:string; remindAt:number; groupId:string; kind:string }
interface Reminders { calendarId:string; timeZone:string; items:Reminder[]; total:number; nextAt:number|null }
const endpoint = '/worklog-control/v1/calendar-'
export function CalendarReminders({ openCalendar }: { openCalendar(day:string):void }) {
  const [value, setValue] = useState<Reminders>(), [open, setOpen] = useState(false), [error, setError] = useState('')
  const [pending, setPending] = useState<string>(), [refresh, setRefresh] = useState(0)
  const popover = useRef<HTMLDivElement>(null), locked = useRef(false), ids = useRef(new Map<string,string>())
  const seenMemory = useRef(new Set<string>())
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined, reading = false
    async function load():Promise<void> {
      if (document.hidden || reading || controller.signal.aborted) return
      clearTimeout(timer); reading = true
      let delay = 60_000
      try {
        const response = await fetch(endpoint+'reminders', { credentials:'same-origin', signal:controller.signal, headers:{'x-dsh-worklog-client':'workspace'} })
        if (!response.ok) throw Error('到期提醒暂时无法读取')
        const next = await response.json() as Reminders
        if (controller.signal.aborted) return
        setValue(next); setError('')
        const key = '@lemoncat7/calendar-reminders/seen/'+next.calendarId
        let seen:string[] = []
        try { seen = JSON.parse(localStorage.getItem(key) ?? '[]') as string[]; if (!Array.isArray(seen)) seen=[] } catch { /* Storage is optional. */ }
        const incoming = next.items.map(item => item.id+':'+item.remindAt)
        if (incoming.some(id => !seen.includes(id) && !seenMemory.current.has(key+':'+id))) {
          setOpen(true)
          for (const id of incoming) seenMemory.current.add(key+':'+id)
          try { localStorage.setItem(key,JSON.stringify([...new Set([...seen,...incoming])].slice(-500))) } catch { /* Badge remains available without persistence. */ }
        }
        if (next.nextAt) delay = Math.max(1000,Math.min(delay,next.nextAt-Date.now()))
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : '到期提醒暂时无法读取')
      } finally {
        reading = false
        if (!controller.signal.aborted) timer=setTimeout(()=>{ void load() },delay)
      }
    }
    const visible = ():void => { clearTimeout(timer); if (!document.hidden) void load() }
    document.addEventListener('visibilitychange',visible); void load()
    return ()=>{controller.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',visible)}
  },[refresh])
  useEffect(()=>{
    const element=popover.current
    if (!element || !open) return
    if (typeof element.showPopover==='function') { element.setAttribute('popover','manual'); element.showPopover() }
  },[open])
  async function acknowledge(item:Reminder):Promise<void> {
    if (locked.current || !value) return
    locked.current=true;setPending(item.id);setError('')
    const signature=value.calendarId+':'+item.id+':'+item.remindAt
    try {
      // Minted inside the try so a throwing id source can never skip `finally` and
      // leave locked/pending set (that disabled every "知道了" button for good).
      if (!ids.current.has(signature)) ids.current.set(signature,nextAckRequestId())
      const response=await fetch(endpoint+'reminder-ack',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-dsh-worklog-client':'workspace'},
        body:JSON.stringify({calendarId:value.calendarId,id:item.id,remindAt:item.remindAt,requestId:ids.current.get(signature)})})
      if (!response.ok) { const result=await response.json() as {error?:string}; throw Error(result.error ?? '提醒确认失败，请重试') }
      ids.current.delete(signature)
      setValue(current=>current && ({...current,items:current.items.filter(row=>row.id!==item.id || row.remindAt!==item.remindAt),total:Math.max(0,current.total-1)}))
      setRefresh(n=>n+1)
    } catch(e) { setError(e instanceof Error?e.message:'提醒确认失败，请重试') }
    finally {locked.current=false;setPending(undefined)}
  }
  const count=value?.total ?? 0
  return <>
    <button type="button" className="dsh-knowledge-trigger dsh-calendar-reminder-trigger" aria-label={`到期提醒${count?'，'+count+' 项':''}`} aria-expanded={open} title={error||'到期提醒'} onClick={()=>setOpen(current=>!current)}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3.5 6a4.5 4.5 0 0 1 9 0v3l1 2v.5h-11V11l1-2V6Z" />
        <path d="M6.5 13a1.5 1.5 0 0 0 3 0" />
      </svg>{count>0 && <small>{count>99?'99+':count}</small>}
    </button>
    {open && <div ref={popover} className="dsh-calendar-reminders" role="region" aria-label="到期提醒">
      <header><strong>到期提醒{count>0?' · '+count:''}</strong><button type="button" aria-label="收起到期提醒" onClick={()=>setOpen(false)}>收起</button></header>
      {error && <p role="alert">{error}<button type="button" onClick={()=>setRefresh(n=>n+1)}>重试</button></p>}
      {!count && <p>没有待处理的到期提醒。</p>}
      <div className="dsh-calendar-reminder-list">{value?.items.map(item=><article key={item.id+':'+item.remindAt}>
        <button type="button" className="dsh-calendar-reminder-open" onClick={()=>{openCalendar(item.day);setOpen(false)}}><strong>{item.title}</strong><time>{new Intl.DateTimeFormat('zh-CN',{timeZone:value.timeZone,dateStyle:'short',timeStyle:'short'}).format(item.remindAt)}</time></button>
        <button type="button" disabled={pending!==undefined} onClick={()=>{void acknowledge(item)}}>{pending===item.id?'保存中…':'知道了'}</button>
      </article>)}</div>
      <p className="dsh-calendar-reminder-help">知晓后从这里移除，日历条目和 iCloud 提醒保持不变。</p>
    </div>}
  </>
}
