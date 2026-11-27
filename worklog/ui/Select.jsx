import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

/** React owns the chrome; the native select keeps form, validation and change semantics. */
export function Select({ children, className = '', onInvalid, ...props }) {
  const native = useRef(null), trigger = useRef(null), menu = useRef(null), wrapper = useRef(null)
  const [open, setOpen] = useState(false), [options, setOptions] = useState([]), [label, setLabel] = useState(''), [name, setName] = useState('选择选项')
  const id = useId(), search = useRef({ text: '', at: 0 })
  useLayoutEffect(() => {
    const select = native.current
    if (select.validity.valid) trigger.current?.removeAttribute('aria-invalid')
    setLabel(select.selectedOptions[0]?.label || '请选择')
    const text = [...(select.labels?.[0]?.childNodes ?? [])].filter(node => node.nodeType === 3).map(node => node.textContent).join('').trim()
    setName(props['aria-label'] || text || '选择选项')
    if (select.matches(':disabled')) setOpen(false)
  })
  function close(restore = false) { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }) }
  function show() {
    if (trigger.current?.matches(':disabled')) return
    setOptions([...native.current.options].filter(option => !option.hidden).map(option => ({ value: option.value, label: option.label,
      disabled: option.disabled || option.parentElement?.disabled === true, group: option.parentElement?.tagName === 'OPTGROUP' ? option.parentElement.label : '' })))
    setOpen(value => !value)
  }
  useLayoutEffect(() => {
    if (!open || !menu.current) return
    const element = menu.current
    function place() {
      const bounds = trigger.current.getBoundingClientRect(), width = Math.min(Math.max(bounds.width, 180), 360, innerWidth - 20)
      const below = innerHeight - bounds.bottom - 12, above = bounds.top - 12, up = below < 160 && above > below
      Object.assign(element.style, { width: width+'px', left: Math.max(10, Math.min(bounds.left, innerWidth-width-10))+'px',
        top: up ? 'auto' : bounds.bottom+5+'px', bottom: up ? innerHeight-bounds.top+5+'px' : 'auto', maxHeight: Math.max(60, Math.min(280, up ? above : below))+'px' })
    }
    element.setAttribute('popover', 'manual')
    element.showPopover?.(); place()
    const focus = element.querySelector('[aria-selected=true]:not(:disabled)') || element.querySelector('[role=option]:not(:disabled)')
    focus?.focus({ preventScroll: true }); focus?.scrollIntoView({ block: 'nearest' })
    const outside = event => { if (!wrapper.current?.contains(event.target)) close() }
    const reposition = event => { if (!element.contains(event.target)) place() }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', place); window.addEventListener('scroll', reposition, true)
    return () => { if (element.isConnected) element.hidePopover?.(); document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', place); window.removeEventListener('scroll', reposition, true) }
  }, [open, options])
  useEffect(() => { if (props.disabled) setOpen(false) }, [props.disabled])
  function choose(value) {
    native.current.value = value
    native.current.dispatchEvent(new Event('change', { bubbles: true }))
    close(true)
  }
  function keys(event) {
    const items = [...menu.current.querySelectorAll('[role=option]:not(:disabled)')], index = items.indexOf(document.activeElement)
    let next
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
    if (event.key === 'Tab') { close(true); return }
    if (event.key === 'ArrowDown') next = items[(index+1)%items.length]
    if (event.key === 'ArrowUp') next = items[(index-1+items.length)%items.length]
    if (event.key === 'Home') next = items[0]
    if (event.key === 'End') next = items.at(-1)
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.key !== ' ') {
      search.current = { text: Date.now()-search.current.at > 600 ? event.key : search.current.text+event.key, at: Date.now() }
      next = items.find(item => item.textContent.toLocaleLowerCase().startsWith(search.current.text.toLocaleLowerCase()))
    }
    if (next) { event.preventDefault(); next.focus(); next.scrollIntoView({ block: 'nearest' }) }
  }
  return <span ref={wrapper} className={`wl-select ${className}`} data-ui-owned="react-select">
    <select {...props} ref={native} className="wl-select-native" tabIndex={-1} aria-hidden="true" onInvalid={event => { event.preventDefault(); trigger.current?.setAttribute('aria-invalid', 'true'); trigger.current?.focus(); onInvalid?.(event) }}>{children}</select>
    <button type="button" ref={trigger} className="wl-select-trigger" disabled={props.disabled} role="combobox" aria-haspopup="listbox" aria-controls={id}
      aria-expanded={open} aria-label={`${name}：${label}`} aria-describedby={props['aria-describedby']} aria-required={props.required || undefined} title={label}
      onClick={show} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!open) show() } }}>
      <span>{label}</span><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {open && <div id={id} ref={menu} className="wl-select-menu" role="listbox" aria-label={name} onKeyDown={keys}>
      {options.map((option, index) => <div key={option.value+':'+index}>
        {option.group && option.group !== options[index-1]?.group && <div className="wl-select-group">{option.group}</div>}
        <button type="button" role="option" tabIndex={-1} aria-selected={String(props.value ?? native.current?.value) === option.value} disabled={option.disabled} onClick={() => choose(option.value)}><span>{option.label}</span>{String(props.value ?? native.current?.value) === option.value && <span aria-hidden="true">✓</span>}</button>
      </div>)}
      {!options.length && <p>暂无可选项</p>}
    </div>}
  </span>
}
