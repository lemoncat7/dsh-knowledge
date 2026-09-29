import { useEffect, useRef } from 'react'

export function Dialog({ title, close, children }) {
  const ref = useRef(null)
  useEffect(() => {
    const previous = document.activeElement
    ref.current.showModal()
    return () => { ref.current?.close(); previous?.focus?.() }
  }, [])
  return <dialog className="dsh-worklog wl-dialog" ref={ref} onCancel={e => { e.preventDefault(); close() }}>
    <header><h2>{title}</h2><button onClick={close} aria-label="关闭弹窗">关闭</button></header>
    <div className="wl-dialog-content">{children}</div>
  </dialog>
}

