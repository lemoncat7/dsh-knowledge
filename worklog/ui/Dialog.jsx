import { useEffect, useId, useRef, useState } from 'react'

export function Dialog({ title, close, children, busy = false, protectChanges = false, dirty }) {
  const ref = useRef(null)
  const pointer = useRef(null), changed = useRef(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const titleId = useId()
  function requestClose() {
    if (busy) return
    if (protectChanges && (dirty ?? changed.current)) setConfirmDiscard(true)
    else close()
  }
  function outside(event) {
    if (event.target !== event.currentTarget) return false
    const box = event.currentTarget.getBoundingClientRect()
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom
  }
  useEffect(() => {
    const previous = document.activeElement
    const dialog = ref.current
    dialog.showModal()
    return () => { dialog.close(); if (previous?.isConnected) previous.focus?.() }
  }, [])
  return <dialog className="dsh-worklog wl-dialog" ref={ref} aria-labelledby={titleId}
    onCancel={e => { e.preventDefault(); if (confirmDiscard) setConfirmDiscard(false); else requestClose() }}
    onPointerDown={e => { pointer.current = e.button === 0 && outside(e) ? e.pointerId : null }}
    onPointerUp={e => { const dismiss = pointer.current === e.pointerId && outside(e); pointer.current = null; if (dismiss) requestClose() }}
    onPointerCancel={() => { pointer.current = null }}>
    <header><h2 id={titleId}>{title}</h2><button type="button" disabled={busy} onClick={requestClose} aria-label="关闭弹窗">关闭</button></header>
    {confirmDiscard && <section className="wl-discard" aria-label="未保存修改" role="alert">
      <p>有未保存的修改，确定放弃并关闭吗？</p>
      <div className="wl-actions"><button type="button" autoFocus onClick={() => setConfirmDiscard(false)}>继续编辑</button><button type="button" disabled={busy} onClick={() => { if (!busy) close() }}>放弃修改并关闭</button></div>
    </section>}
    <div className="wl-dialog-content" onInputCapture={() => { changed.current = true }} onChangeCapture={() => { changed.current = true }}>{children}</div>
  </dialog>
}
