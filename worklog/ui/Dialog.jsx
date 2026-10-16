import { createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createDiscardConfirmation } from '../../web/discard-confirmation.js'

const ActionsTarget = createContext(undefined)

/** Actions stay outside the scrolling body; submit buttons must specify their form. */
export function DialogActions({ children }) {
  const target = useContext(ActionsTarget)
  if (target === undefined) return <footer>{children}</footer>
  return target ? createPortal(children, target) : null
}

export function Dialog({ title, close, children, busy = false, protectChanges = false, dirty }) {
  const ref = useRef(null)
  const pointer = useRef(null), changed = useRef(false)
  const confirmation = useRef(null)
  const [actions, setActions] = useState(null)
  const latest = useRef({ busy, close })
  latest.current = { busy, close }
  const titleId = useId()
  function requestClose() {
    if (busy) return
    if (protectChanges && (dirty ?? changed.current)) confirmation.current?.request()
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
    confirmation.current = createDiscardConfirmation({ owner: dialog, canDiscard: () => !latest.current.busy, onDiscard: () => latest.current.close() })
    return () => { confirmation.current?.dispose(); dialog.close(); if (previous?.isConnected) previous.focus?.({ preventScroll: true }) }
  }, [])
  return <dialog className="dsh-worklog wl-dialog" ref={ref} aria-labelledby={titleId}
    onCancel={e => { e.preventDefault(); requestClose() }}
    onPointerDown={e => { pointer.current = e.button === 0 && outside(e) ? e.pointerId : null }}
    onPointerUp={e => { const dismiss = pointer.current === e.pointerId && outside(e); pointer.current = null; if (dismiss) requestClose() }}
    onPointerCancel={() => { pointer.current = null }}>
    <header><h2 id={titleId}>{title}</h2><button type="button" disabled={busy} onClick={requestClose} aria-label="关闭弹窗" title="关闭">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
    </button></header>
    <ActionsTarget.Provider value={actions}>
      <div className="wl-dialog-content" onInputCapture={() => { changed.current = true }} onChangeCapture={() => { changed.current = true }}>{children}</div>
    </ActionsTarget.Provider>
    <footer className="wl-dialog-actions" ref={setActions} />
  </dialog>
}
