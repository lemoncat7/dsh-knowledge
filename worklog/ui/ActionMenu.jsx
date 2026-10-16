import { useEffect, useRef, useState } from 'react'

export function ActionMenu({ label, children }) {
  const ref = useRef(null)
  const [open, setOpen] = useState(false)
  function close(restore = false) {
    if (ref.current) ref.current.open = false
    if (restore) ref.current?.querySelector('summary')?.focus({ preventScroll: true })
  }
  useEffect(() => {
    if (!open) return
    const outside = event => { if (!ref.current?.contains(event.target)) close() }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  return <details className="wl-more" ref={ref} onToggle={event => setOpen(event.currentTarget.open)}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close() }}
    onKeyDown={event => {
      if (!ref.current.open) return
      const items = [...ref.current.querySelectorAll('button:not(:disabled)')]
      const index = items.indexOf(document.activeElement)
      let next
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
      if (event.key === 'ArrowDown') next = items[(index + 1) % items.length]
      if (event.key === 'ArrowUp') next = items[(index - 1 + items.length) % items.length]
      if (event.key === 'Home') next = items[0]
      if (event.key === 'End') next = items.at(-1)
      if (next) { event.preventDefault(); next.focus() }
    }}>
    <summary aria-label={label} aria-expanded={open}>更多</summary>
    <div onClick={event => { if (event.target.closest('button:not(:disabled)')) close() }}>{children}</div>
  </details>
}
