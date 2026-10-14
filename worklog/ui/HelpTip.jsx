import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

/** Hover/focus help with a tap toggle; native popover escapes dialog clipping. */
export function HelpTip({ label, children }) {
  const id = useId(), button = useRef(null), tip = useRef(null), timer = useRef(null)
  const pinned = useRef(false), [open, setOpen] = useState(false)
  function cancelTimer() { clearTimeout(timer.current) }
  function show() { cancelTimer(); setOpen(true) }
  function hide() { cancelTimer(); pinned.current = false; setOpen(false) }
  function leave() {
    cancelTimer()
    timer.current = setTimeout(() => { if (!pinned.current && document.activeElement !== button.current) setOpen(false) }, 120)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  useLayoutEffect(() => {
    if (!open) return
    const element = tip.current
    element.showPopover?.()
    function position() {
      const anchor = button.current.getBoundingClientRect(), box = element.getBoundingClientRect()
      element.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - box.width - 12))}px`
      const top = anchor.bottom + 6 + box.height <= innerHeight - 12 ? anchor.bottom + 6 : anchor.top - box.height - 6
      element.style.top = `${Math.max(12, top)}px`
    }
    position()
    function dismiss(event) {
      if (event.type === 'keydown') {
        if (event.key !== 'Escape') return
        event.preventDefault(); event.stopImmediatePropagation()
        hide()
      } else if (!button.current.contains(event.target) && !element.contains(event.target)) hide()
    }
    document.addEventListener('keydown', dismiss, true)
    document.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('resize', position)
    document.addEventListener('scroll', position, true)
    return () => {
      element.hidePopover?.()
      document.removeEventListener('keydown', dismiss, true)
      document.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('resize', position)
      document.removeEventListener('scroll', position, true)
    }
  }, [open])
  return <span className="wl-help">
    <button ref={button} type="button" className="wl-help-button" aria-label={`${label}说明`} aria-describedby={open ? id : undefined} aria-expanded={open}
      onPointerEnter={e => { if (e.pointerType !== 'touch') show() }} onPointerLeave={leave}
      onFocus={show} onBlur={hide}
      onClick={() => { if (pinned.current) hide(); else { pinned.current = true; show() } }}>
      <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.4"/><path d="M7.8 7.4a2.2 2.2 0 0 1 4.4 0c0 1.7-2.2 1.7-2.2 3.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><circle cx="10" cy="13.7" r=".8" fill="currentColor"/></svg>
    </button>
    <span ref={tip} id={id} role="tooltip" popover="manual" className="wl-help-tip" data-open={open || undefined} onPointerEnter={show} onPointerLeave={leave}>{children}</span>
  </span>
}
