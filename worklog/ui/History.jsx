import { useEffect, useState } from 'react'
import { api } from './api.js'
import { Markdown } from './Markdown.jsx'

export function History({ day, time, edit }) {
  const [rows, setRows] = useState(null), [selected, setSelected] = useState(null), [body, setBody] = useState(null), [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    api(`/history?day=${day}`, undefined, controller.signal).then(setRows).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [day])
  useEffect(() => {
    if (selected === null) return
    const controller = new AbortController(); setBody(null); setError('')
    api(`/history?day=${day}&id=${selected}`, undefined, controller.signal).then(setBody).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [day, selected])
  return <>{error && <p role="alert">{error}</p>}{!rows && <p role="status">正在读取历史版本…</p>}<div className="wl-actions">{rows?.map(r => <button key={r.id} aria-pressed={selected === r.id} onClick={() => setSelected(r.id)}>{time(r.updated)} · 版本 {r.revision}</button>)}</div>{selected !== null && !body && !error && <p role="status">正在读取正文…</p>}{body && <><Markdown text={body.markdown} /><button onClick={() => edit(body.markdown)}>作为编辑草稿</button></>}</>
}
