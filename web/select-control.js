/** Plugin-owned select chrome. The hidden select retains form/value/event semantics. */
export function installSelectControls(root = document.body) {
  const controls = new Map()
  let active
  let sequence = 0
  const make = (tag, className, text) => {
    const node = document.createElement(tag)
    node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }
  const close = (restore = false) => {
    if (!active) return
    const { button, menu } = active
    active = undefined
    menu.remove()
    button.setAttribute('aria-expanded', 'false')
    if (restore && button.isConnected) button.focus()
  }
  const enhance = select => {
    if (controls.has(select) || select.multiple || select.size > 1) return
    const wrapper = make('span', 'knowledge-select')
    const originalTabIndex = select.getAttribute('tabindex')
    const originalAriaHidden = select.getAttribute('aria-hidden')
    const button = make('button', `${select.className} knowledge-select-trigger`)
    button.type = 'button'
    button.setAttribute('role', 'combobox')
    button.setAttribute('aria-haspopup', 'listbox')
    button.setAttribute('aria-expanded', 'false')
    const menuId = `knowledge-select-${++sequence}`
    button.setAttribute('aria-controls', menuId)
    select.before(wrapper)
    wrapper.append(select, button)
    select.classList.add('knowledge-select-source')
    select.tabIndex = -1
    select.setAttribute('aria-hidden', 'true')
    const sync = () => {
      button.textContent = select.selectedOptions[0]?.label || '请选择'
      button.disabled = select.disabled
      button.setAttribute('aria-required', String(select.required))
      if (select.validity.valid) button.removeAttribute('aria-invalid')
      const label = select.getAttribute('aria-label') || select.labels?.[0]?.textContent || select.closest('.field, label')?.querySelector('label, span')?.textContent || '选择选项'
      button.setAttribute('aria-label', `${label}：${button.textContent}`)
      if (select.getAttribute('aria-labelledby')) button.setAttribute('aria-labelledby', select.getAttribute('aria-labelledby'))
      button.title = button.textContent
      if (active?.select === select) close()
    }
    const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
    Object.defineProperty(select, 'value', {
      configurable: true,
      get() { return valueDescriptor.get.call(this) },
      set(value) { valueDescriptor.set.call(this, value); sync() },
    })
    const place = () => {
      if (active?.select !== select) return
      const rect = button.getBoundingClientRect()
      if (!button.isConnected || !rect.width) return close()
      const menu = active.menu
      const width = Math.min(Math.max(rect.width, 180), window.innerWidth - 16)
      const below = window.innerHeight - rect.bottom - 12
      const above = rect.top - 12
      const useAbove = below < 180 && above > below
      menu.style.width = `${width}px`
      menu.style.maxHeight = `${Math.max(60, Math.min(300, useAbove ? above : below))}px`
      menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`
      menu.style.top = useAbove ? 'auto' : `${rect.bottom + 5}px`
      menu.style.bottom = useAbove ? `${window.innerHeight - rect.top + 5}px` : 'auto'
    }
    const open = () => {
      if (select.disabled) return
      if (active?.select === select) return close(true)
      close()
      const menu = make('div', 'knowledge-select-menu')
      menu.id = menuId
      menu.setAttribute('role', 'listbox')
      menu.setAttribute('aria-label', button.getAttribute('aria-label'))
      const items = []
      for (const option of select.options) {
        if (option.hidden) continue
        const item = make('button', 'knowledge-select-option', option.label)
        item.type = 'button'
        item.setAttribute('role', 'option')
        item.setAttribute('aria-selected', String(option.selected))
        item.disabled = option.disabled || option.parentElement?.disabled === true
        item.tabIndex = -1
        item.addEventListener('click', () => {
          select.value = option.value
          select.dispatchEvent(new Event('input', { bubbles: true }))
          select.dispatchEvent(new Event('change', { bubbles: true }))
          close()
          if (button.isConnected) button.focus()
        })
        menu.append(item)
        if (!item.disabled) items.push(item)
      }
      if (!menu.childElementCount) menu.append(make('p', 'knowledge-select-empty', '暂无可选项'))
      active = { select, button, menu, place }
      root.append(menu)
      button.setAttribute('aria-expanded', 'true')
      place()
      const selected = items.find(item => item.getAttribute('aria-selected') === 'true') || items[0]
      selected?.focus({ preventScroll: true })
      if (selected) menu.scrollTop = Math.max(0, selected.offsetTop - menu.clientHeight / 2)
      let search = ''
      let searchTime = 0
      menu.addEventListener('keydown', event => {
        const index = items.indexOf(document.activeElement)
        let next
        if (event.key === 'ArrowDown') next = items[(index + 1) % items.length]
        else if (event.key === 'ArrowUp') next = items[(index - 1 + items.length) % items.length]
        else if (event.key === 'Home') next = items[0]
        else if (event.key === 'End') next = items.at(-1)
        else if (event.key === 'Tab') { close(true); return }
        else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && event.key !== ' ') {
          search = Date.now() - searchTime > 600 ? event.key : search + event.key
          searchTime = Date.now()
          next = items.find(item => item.textContent.toLocaleLowerCase().startsWith(search.toLocaleLowerCase()))
        }
        if (next) { event.preventDefault(); next.focus() }
      })
    }
    button.addEventListener('click', open)
    button.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open() }
    })
    select.addEventListener('change', sync)
    const invalid = event => {
      event.preventDefault()
      button.setAttribute('aria-invalid', 'true')
      button.title = select.validationMessage
      button.focus()
    }
    select.addEventListener('invalid', invalid)
    const observer = new MutationObserver(sync)
    observer.observe(select, { attributes: true, childList: true, subtree: true, characterData: true })
    const dispose = () => {
      observer.disconnect()
      select.removeEventListener('change', sync)
      select.removeEventListener('invalid', invalid)
      delete select.value
      select.classList.remove('knowledge-select-source')
      for (const [name, value] of [['tabindex', originalTabIndex], ['aria-hidden', originalAriaHidden]]) {
        if (value === null) select.removeAttribute(name)
        else select.setAttribute(name, value)
      }
      if (select.parentElement === wrapper) wrapper.replaceWith(select)
    }
    controls.set(select, { dispose, sync })
    sync()
  }
  const scan = node => {
    if (!(node instanceof Element)) return
    if (node.matches('select')) enhance(node)
    node.querySelectorAll('select').forEach(enhance)
  }
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) scan(node)
    for (const [select, control] of controls) {
      if (select.isConnected) continue
      control.dispose()
      controls.delete(select)
      if (active?.select === select) close()
    }
  })
  observer.observe(root, { childList: true, subtree: true })
  scan(root)
  const outside = event => {
    if (active && !active.menu.contains(event.target) && !active.button.contains(event.target)) close()
  }
  const escape = event => {
    if (active && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(true) }
  }
  const reposition = event => { if (active && !active.menu.contains(event.target)) active.place() }
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('keydown', escape, true)
  window.addEventListener('resize', reposition)
  window.addEventListener('scroll', reposition, true)
  const reset = () => queueMicrotask(() => { for (const value of controls.values()) value.sync() })
  root.addEventListener('reset', reset)
  return () => {
    close()
    observer.disconnect()
    for (const [select, control] of controls) {
      control.dispose()
    }
    controls.clear()
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('keydown', escape, true)
    window.removeEventListener('resize', reposition)
    window.removeEventListener('scroll', reposition, true)
    root.removeEventListener('reset', reset)
  }
}
