/** Shared document overflow: one action list and keyboard model for every width. */
export function createDocumentMenuPresenter({ element, actionButton, interfaceIcon }) {
  const openMenus = new Set()
  const closeMenus = () => { for (const close of [...openMenus]) close() }
  function renderMenu(label, groups) {
    const actions = groups.filter(group => group.length)
    if (!actions.length) return null
    let events
    const details = element('details', { class: 'notes-document-more' })
    const summary = element('summary', {
      class: 'button ghost small', title: '更多操作', 'aria-label': `${label}的更多操作`,
      'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onClick: event => { event.preventDefault(); setOpen(!details.open) },
    }, interfaceIcon('more', 'notes-document-more-icon'))
    const close = (restoreFocus = false) => {
      details.open = false
      summary.setAttribute('aria-expanded', 'false')
      events?.abort()
      events = undefined
      openMenus.delete(close)
      if (restoreFocus && summary.isConnected) summary.focus()
    }
    const menu = element('div', { class: 'notes-document-more-menu', role: 'menu', 'aria-label': `${label}的更多操作` },
      actions.flatMap((group, index) => [
        index ? element('div', { class: 'notes-document-menu-divider', role: 'separator' }) : null,
        ...group.map(action => actionButton([
          interfaceIcon(action.icon, 'notes-document-menu-icon'),
          element('span', { class: 'notes-document-menu-label' }, action.label),
        ], event => { close(true); action.run(event) }, `ghost small notes-document-menu-item${action.danger ? ' is-danger' : ''}`, {
          role: 'menuitem', tabindex: '-1', ...action.attributes,
        })),
      ]),
    )
    const items = () => [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')]
    const setOpen = (open, last = false) => {
      if (!open) return close(true)
      closeMenus()
      details.open = true
      summary.setAttribute('aria-expanded', 'true')
      openMenus.add(close)
      const bounds = summary.getBoundingClientRect()
      menu.style.maxHeight = `${Math.max(100, window.innerHeight - bounds.bottom - 16)}px`
      events = new AbortController()
      const { signal } = events
      document.addEventListener('pointerdown', event => { if (!details.contains(event.target)) close() }, { signal })
      window.addEventListener('resize', () => close(), { signal, once: true })
      const choices = items()
      choices[last ? choices.length - 1 : 0]?.focus()
    }
    details.addEventListener('keydown', event => {
      if (event.key === 'Escape' && details.open) { event.preventDefault(); event.stopPropagation(); close(true); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      if (!details.open) return setOpen(true, event.key === 'ArrowUp' || event.key === 'End')
      const choices = items()
      const index = choices.indexOf(document.activeElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length
      choices[next]?.focus()
    })
    details.addEventListener('focusout', event => {
      if (event.relatedTarget && !details.contains(event.relatedTarget)) close()
    })
    details.append(summary, menu)
    return details
  }
  return { renderMenu, closeMenus }
}
